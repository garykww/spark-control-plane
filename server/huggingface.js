import crypto from 'node:crypto';
import { createRunner } from './exec/index.js';
import {
  HF_RESOLVE,
  HF_HUB,
  HF_JOBS_DIR,
  HF_DRY_RUN_TOTAL,
  REPO_ID_RE,
  REPO_TYPES,
  cacheFolderName,
  parseHumanSize,
} from './collectors/huggingface.js';

/*
 * Write paths for the HuggingFace cache: start a download, cancel one, delete a
 * repo, reclaim wasted space.
 *
 * Same discipline as containers.js - a fixed verb allowlist, strict regexes, and
 * no user-supplied text reaching a shell. Repo ids are awkward here because they
 * legitimately contain "/", "." and "-", so the regex has to admit those while
 * still rejecting a leading "-" (which argv would read as a flag) and anything
 * that could escape the single quotes the commands wrap them in.
 *
 * Downloads are the reason this module exists in its current shape. A 70 GB pull
 * takes hours, and exec() kills every command at 8 seconds, so the download is
 * launched detached on the node and its state is left there to be polled. The
 * node is the source of truth: a dashboard restart loses nothing, and there is
 * no in-memory job store to reconcile.
 */

export const REVISION_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
export const JOB_ID_RE = /^job-[0-9]{13}-[0-9a-f]{8}$/;

const RECLAIM_TARGETS = ['incomplete', 'prune'];

const TIMEOUTS = {
  launch: 8000,
  preview: 25000,
  delete: 90000,
  reclaim: 90000,
  cancel: 10000,
};

const bad = (message) => Object.assign(new Error(message), { status: 400 });

export function assertRepo(repoId, repoType) {
  if (!REPO_TYPES.includes(repoType)) {
    throw bad(`unknown repo type: ${repoType} (expected ${REPO_TYPES.join(', ')})`);
  }
  const id = String(repoId ?? '');
  /* Checked before the regex so traversal gets a clearer message than "invalid". */
  if (id.includes('..')) throw bad(`invalid repo id: ${id}`);
  if (!REPO_ID_RE.test(id)) throw bad(`invalid repo id: ${id}`);
  return { repoId: id, repoType };
}

export function assertRevision(revision) {
  if (revision === null || revision === undefined || revision === '') return null;
  const value = String(revision);
  if (value.includes('..') || !REVISION_RE.test(value)) throw bad(`invalid revision: ${value}`);
  return value;
}

export function assertJobId(jobId) {
  const id = String(jobId ?? '');
  if (!JOB_ID_RE.test(id)) throw bad(`invalid job id: ${id}`);
  return id;
}

function explain(output) {
  const text = String(output ?? '');
  if (/401|403|unauthor|gated|must be authenticated/i.test(text)) {
    return 'not authorised - run `hf auth login` on this node, or request access to the repo';
  }
  if (/no space left/i.test(text)) return 'no space left on the cache filesystem';
  if (/repository not found|404|does not exist/i.test(text)) return 'repository not found on the Hub';
  if (/permission denied/i.test(text)) return 'permission denied writing to the HuggingFace cache';
  if (/could not resolve|name resolution|network|timed out/i.test(text)) {
    return 'the node could not reach huggingface.co';
  }
  return text.split('\n').find((l) => l.trim())?.slice(0, 200) ?? '';
}

async function withRunner(node, fn) {
  const runner = createRunner(node);
  try {
    return await fn(runner);
  } finally {
    await runner.close?.();
  }
}

/*
 * The script the node actually runs. It is shipped base64-encoded so the only
 * characters crossing the shell are [A-Za-z0-9+/=], which removes every quoting
 * concern in one move.
 *
 * It computes its own download total rather than having the server do it: a
 * --dry-run against a large repo can take longer than the 8s launch budget.
 */
function buildJobScript({ jobId, repoId, repoType, revision, folder }) {
  const revisionArg = revision ? ` --revision '${revision}'` : '';
  const target = `'${repoId}' --type '${repoType}'${revisionArg}`;

  return `#!/bin/sh
D="$HOME/.cache/spark-control-plane/hf-jobs/${jobId}"
HUB="\${HF_HOME:-$HOME/.cache/huggingface}/hub"
printf '%s' "$HUB/${folder}/blobs" > "$D/dir"
echo $$ > "$D/pid"
date +%s > "$D/started"

# One download per repo. A second launch exits 75 rather than racing the first.
exec 9>"$D/../.lock-${folder}"
if ! flock -n 9; then
  echo "another download for this repo is already running" >> "$D/log"
  echo 75 > "$D/exit"
  exit 75
fi

${HF_RESOLVE}
if [ -z "$HF" ]; then
  echo "hf CLI not found on this node" >> "$D/log"
  echo 127 > "$D/exit"
  exit 127
fi

# Total size first, so the UI can show a real percentage. Best effort: if this
# fails the file holds 0 and the UI shows an indeterminate bar instead.
"$HF" download ${target} --dry-run --format json 2>/dev/null \
  | ${HF_DRY_RUN_TOTAL} > "$D/total" 2>/dev/null || echo 0 > "$D/total"

"$HF" download ${target} --max-workers 8 >> "$D/log" 2>&1
c=$?

# Written via a temp file so a poll can never read a half-written exit code.
printf '%s\\n' "$c" > "$D/exit.part" && mv "$D/exit.part" "$D/exit"
date +%s > "$D/finished"
`;
}

export async function startDownload(node, { repoId, repoType = 'model', revision = null } = {}) {
  const repo = assertRepo(repoId, repoType);
  const rev = assertRevision(revision);

  const jobId = `job-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const folder = cacheFolderName(repo.repoType, repo.repoId);

  const script = buildJobScript({ jobId, ...repo, revision: rev, folder });
  const meta = JSON.stringify({
    jobId,
    repoId: repo.repoId,
    repoType: repo.repoType,
    revision: rev,
    folder,
    createdAt: new Date().toISOString(),
  });

  const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

  /*
   * The redirections on the backgrounded process are load-bearing. Without
   * </dev/null >/dev/null 2>&1 the child inherits the SSH channel's stdout and
   * ssh will not return until the download finishes - which means exec()'s 8s
   * SIGKILL fires and every launch looks like a failure while the download is
   * actually running fine.
   */
  const command =
    `D=${HF_JOBS_DIR}/${jobId}; mkdir -p "$D" && ` +
    `printf %s '${b64(script)}' | base64 -d > "$D/run.sh" && ` +
    `printf %s '${b64(meta)}' | base64 -d > "$D/meta.json" && ` +
    `setsid nohup sh "$D/run.sh" </dev/null >/dev/null 2>&1 & ` +
    /* Sweep finished jobs older than a day; keeps the poll's job list short. */
    `find ${HF_JOBS_DIR} -maxdepth 1 -type d -name 'job-*' -mmin +1440 ` +
    `-exec sh -c '[ -f "$1/exit" ] && rm -rf "$1"' _ {} \\; 2>/dev/null; ` +
    `echo launched`;

  return withRunner(node, async (runner) => {
    const { code, stdout, stderr } = await runner.run(command, TIMEOUTS.launch);
    if (!stdout.includes('launched')) {
      throw bad(explain(`${stdout}${stderr}`) || `could not start the download (exit ${code})`);
    }
    return { ok: true, jobId, repoId: repo.repoId, repoType: repo.repoType };
  });
}

export async function cancelDownload(node, jobId) {
  const id = assertJobId(jobId);

  /* setsid made the script a process-group leader, so the whole tree dies with
   * one signal to the negated pid. */
  const command =
    `D=${HF_JOBS_DIR}/${id}; [ -d "$D" ] || { echo missing; exit 0; }; ` +
    `touch "$D/cancelled"; p="$(cat "$D/pid" 2>/dev/null)"; ` +
    `[ -n "$p" ] && kill -TERM -"$p" 2>/dev/null; ` +
    `[ -f "$D/exit" ] || echo 143 > "$D/exit"; echo cancelled`;

  return withRunner(node, async (runner) => {
    const { stdout } = await runner.run(command, TIMEOUTS.cancel);
    if (stdout.includes('missing')) throw Object.assign(new Error('job not found'), { status: 404 });
    return { ok: true, jobId: id };
  });
}

export async function clearJob(node, jobId) {
  const id = assertJobId(jobId);

  /* Refuses while the process is still alive so a running download cannot be
   * orphaned by tidying its state away. */
  const command =
    `D=${HF_JOBS_DIR}/${id}; p="$(cat "$D/pid" 2>/dev/null)"; ` +
    `if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo running; else rm -rf "$D"; echo cleared; fi`;

  return withRunner(node, async (runner) => {
    const { stdout } = await runner.run(command, TIMEOUTS.cancel);
    if (stdout.includes('running')) throw bad('cancel the download before clearing it');
    return { ok: true, jobId: id };
  });
}

function parsePruneJson(text) {
  try {
    const data = JSON.parse(text.trim());
    return { revisions: Number(data?.revisions ?? 0), bytes: parseHumanSize(data?.size) };
  } catch {
    return null;
  }
}

function parseRmResult(stdout) {
  try {
    const data = JSON.parse(stdout.trim());
    return {
      repos: Number(data?.repos ?? 0),
      revisions: Number(data?.revisions ?? 0),
      sizeText: String(data?.size ?? ''),
      sizeBytes: parseHumanSize(data?.size),
    };
  } catch {
    return null;
  }
}

export async function previewDelete(node, { repoId, repoType } = {}) {
  const repo = assertRepo(repoId, repoType);
  const command = `${HF_RESOLVE}; "$HF" cache rm '${repo.repoType}/${repo.repoId}' --dry-run -y --format json 2>&1`;

  return withRunner(node, async (runner) => {
    const { stdout, stderr } = await runner.run(command, TIMEOUTS.preview);
    const result = parseRmResult(stdout);
    if (!result) throw bad(explain(`${stdout}${stderr}`) || 'could not read what would be deleted');
    return { ...result, repoId: repo.repoId, repoType: repo.repoType };
  });
}

export async function deleteRepo(node, { repoId, repoType, confirm } = {}) {
  const repo = assertRepo(repoId, repoType);
  /* The client must echo the repo id back, so a mis-routed request cannot
   * delete 70 GB that takes hours to re-download. */
  if (confirm !== repo.repoId) throw bad('confirm must match the repo id being deleted');

  const target = `'${repo.repoType}/${repo.repoId}'`;
  /*
   * The size has to be read before the delete, because `hf cache rm` honours
   * --format json only on --dry-run: the real run prints human progress lines
   * ("Delete repo: /path"). Both are issued in one round trip.
   */
  const command =
    `${HF_RESOLVE}; ` +
    `"$HF" cache rm ${target} --dry-run -y --format json 2>/dev/null; ` +
    `echo '@@RM@@'; ` +
    `"$HF" cache rm ${target} -y 2>&1; ` +
    `echo "@@CODE@@$?"`;

  return withRunner(node, async (runner) => {
    const { stdout, stderr } = await runner.run(command, TIMEOUTS.delete);

    const [previewText = '', rest = ''] = stdout.split('@@RM@@');
    const code = Number.parseInt((/@@CODE@@(-?\d+)/.exec(rest) ?? [])[1] ?? '', 10);
    const output = rest.replace(/@@CODE@@-?\d+/, '').trim();

    if (code !== 0) throw bad(explain(`${output}${stderr}`) || `delete failed (exit ${code})`);
    /* Exit 0 with this warning means the repo was already gone - say so rather
     * than reporting a delete that did not happen. */
    if (/could not find in cache/i.test(output)) {
      throw bad(`${repo.repoId} is not in the cache on this node`);
    }

    const preview = parseRmResult(previewText);
    return {
      ok: true,
      repoId: repo.repoId,
      repoType: repo.repoType,
      revisions: preview?.revisions ?? null,
      sizeText: preview?.sizeText ?? null,
      freedBytes: preview?.sizeBytes ?? null,
    };
  });
}

export async function reclaim(node, target) {
  if (!RECLAIM_TARGETS.includes(target)) {
    throw bad(`unknown reclaim target: ${target} (expected ${RECLAIM_TARGETS.join(', ')})`);
  }

  const commands = {
    /*
     * -mmin +60 is the guard that keeps an in-flight download's own partial
     * blobs out of this. The route additionally refuses while a job is active.
     */
    incomplete:
      `HUB=${HF_HUB}; find "$HUB" -maxdepth 4 -name "*.incomplete" -type f -mmin +60 ` +
      `-printf "%s\\n" -delete 2>/dev/null | awk '{n++; s+=$1} END{printf "%d %d\\n", n+0, s+0}'`,
    prune:
      `${HF_RESOLVE}; "$HF" cache prune --dry-run --format json 2>/dev/null; ` +
      `echo '@@RM@@'; "$HF" cache prune -y 2>&1; echo "@@CODE@@$?"`,
  };

  return withRunner(node, async (runner) => {
    const { stdout, stderr } = await runner.run(commands[target], TIMEOUTS.reclaim);

    if (target === 'incomplete') {
      const [files, bytes] = stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);
      return { ok: true, target, files, freedBytes: bytes };
    }

    /* Like `cache rm`, prune only emits JSON for --dry-run, so the size comes
     * from the preview issued alongside it. */
    const [previewText = '', rest = ''] = stdout.split('@@RM@@');
    const code = Number.parseInt((/@@CODE@@(-?\d+)/.exec(rest) ?? [])[1] ?? '', 10);
    if (code !== 0) {
      throw bad(explain(`${rest}${stderr}`) || `prune failed (exit ${code})`);
    }

    const preview = parsePruneJson(previewText);
    return { ok: true, target, revisions: preview?.revisions ?? 0, freedBytes: preview?.bytes ?? null };
  });
}
