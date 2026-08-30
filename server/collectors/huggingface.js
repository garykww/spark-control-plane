/*
 * HuggingFace cache inventory: which model and dataset repos are on a node, how
 * much space they hold, and the state of any download in flight.
 *
 * Two things about the `hf` CLI shape this collector:
 *
 * 1. It is usually NOT on the non-interactive SSH PATH. On a DGX Spark it lives
 *    in ~/.local/bin, which a login shell adds and `ssh host command` does not.
 *    Every command therefore carries a resolve prelude rather than saying `hf`.
 *
 * 2. It reports sizes as pre-rounded human strings in DECIMAL units. Verified on
 *    a GB10: a repo `du -sb` measures at 999,588,026 bytes is reported "999.6M",
 *    which is 1e6, not 1024^2.
 */

/*
 * Locates the binary once per command. Written as concatenated plain strings so
 * $HOME and ${HF_HOME:-...} reach the remote shell unexpanded. The login-shell
 * fallback is last because it is by far the slowest branch.
 */
export const HF_RESOLVE =
  'HF=""; for c in "$HOME/.local/bin/hf" "$HOME/.hf-cli/venv/bin/hf" ' +
  '/usr/local/bin/hf /usr/bin/hf; do [ -x "$c" ] && { HF="$c"; break; }; done; ' +
  '[ -n "$HF" ] || HF="$(command -v hf 2>/dev/null)"; ' +
  '[ -n "$HF" ] || HF="$(bash -lc \'command -v hf\' 2>/dev/null)"';

/* The hub directory, honouring HF_HOME when the node sets it. */
export const HF_HUB = '"${HF_HOME:-$HOME/.cache/huggingface}/hub"';

/* Job state lives on the node, not in server memory, so a dashboard restart
 * loses nothing and a detached download needs no adopting. */
export const HF_JOBS_DIR = '"$HOME/.cache/spark-control-plane/hf-jobs"';

/*
 * Identity probe, run once per connection like the SM-count probe. Includes a
 * network round trip for `auth whoami`, so it gets its own generous timeout
 * rather than riding the metrics batch.
 */
export const HF_PROBE_COMMAND =
  `${HF_RESOLVE}; [ -n "$HF" ] || exit 0; ` +
  'printf "bin=%s\\n" "$HF"; ' +
  'printf "cacheDir=%s\\n" "${HF_HOME:-$HOME/.cache/huggingface}"; ' +
  'printf "version=%s\\n" "$("$HF" version 2>/dev/null | tr -d "\\r" | tail -1)"; ' +
  'printf "user=%s\\n" "$("$HF" auth whoami 2>/dev/null | sed -n "s/.*user: *//p" | head -1)"';

/*
 * Cache inventory. `2>&1` is deliberate: runBatch wraps sections in 2>/dev/null,
 * which would otherwise swallow the 401 or permission text that the UI needs to
 * turn into an actionable message.
 */
export const HF_CACHE_COMMANDS = {
  hfCache: `${HF_RESOLVE}; "$HF" cache ls --format json 2>&1`,
  /* Orphaned partial blobs. hf's own sizes exclude these, so they are counted
   * separately and reported as reclaimable. */
  hfIncomplete:
    `HUB=${HF_HUB}; find "$HUB" -maxdepth 4 -name "*.incomplete" -type f -printf "%s\\n" 2>/dev/null ` +
    `| awk '{n++; s+=$1} END{printf "%d %d\\n", n+0, s+0}'`,
  hfPrune: `${HF_RESOLVE}; "$HF" cache prune --dry-run --format json 2>/dev/null || true`,
};

/*
 * Job state. Runs every tick while a download is live, so it stays small: a
 * fixed number of short lines per job and one `du`, never a cache rescan.
 * `$j/dir` holds the blobs path written by the job script itself, which keeps
 * that path off this command line entirely.
 */
export const HF_JOB_COMMANDS = {
  hfJobs:
    `D=${HF_JOBS_DIR}; for j in "$D"/*/; do [ -d "$j" ] || continue; ` +
    'p="$(cat "$j/pid" 2>/dev/null)"; ' +
    'printf "@@JOB@@%s\\n" "$(basename "$j")"; ' +
    'printf "meta=%s\\n" "$(tr -d "\\n" < "$j/meta.json" 2>/dev/null)"; ' +
    'printf "pid=%s\\n" "$p"; ' +
    'printf "started=%s\\n" "$(cat "$j/started" 2>/dev/null)"; ' +
    'printf "exit=%s\\n" "$(cat "$j/exit" 2>/dev/null)"; ' +
    'printf "total=%s\\n" "$(cat "$j/total" 2>/dev/null)"; ' +
    'printf "cancelled=%s\\n" "$([ -f "$j/cancelled" ] && echo 1 || echo 0)"; ' +
    'printf "alive=%s\\n" "$({ [ -n "$p" ] && kill -0 "$p" 2>/dev/null && echo 1; } || echo 0)"; ' +
    'printf "done=%s\\n" "$(du -sb "$(cat "$j/dir" 2>/dev/null)" 2>/dev/null | cut -f1)"; ' +
    'printf "tail=%s\\n" "$(tail -c 2000 "$j/log" 2>/dev/null | tr "\\r" "\\n" | grep . | tail -1)"; ' +
    'done',
};

/*
 * Sums a `hf download --dry-run --format json` listing into bytes. Reads the
 * listing on stdin and prints one integer, or 0 if anything about it surprises
 * it - a wrong total costs a progress bar, and must never cost the download.
 *
 * Shared by the download job and the run planner: both need a total before they
 * can show a percentage, and a dry run against a large repo can take longer
 * than the launch budget, so both compute it on the node after detaching.
 */
export const HF_DRY_RUN_TOTAL = `python3 -c '
import json, re, sys
MULT = {"K": 1e3, "M": 1e6, "G": 1e9, "T": 1e12, "P": 1e15}
total = 0
try:
    for entry in json.load(sys.stdin):
        m = re.match(r"^([0-9.]+)\\s*([KMGTP])?$", str(entry.get("size", "")).strip())
        if m:
            total += float(m.group(1)) * (MULT[m.group(2)] if m.group(2) else 1)
except Exception:
    pass
print(int(total))
'`;

/* Repo ids are one or two segments of word characters, dots and dashes. */
export const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,95})?$/;
export const REPO_TYPES = ['model', 'dataset', 'space'];

/*
 * Decimal multipliers, matching huggingface_hub's own formatter. A trailing "i"
 * (1.5Gi) is accepted and treated as binary, defensively, in case a future
 * version switches.
 */
const DECIMAL = { K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15 };
const BINARY = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };

export function parseHumanSize(text) {
  const value = String(text ?? '').trim();
  if (!value || value === '-' || /^n\/?a$/i.test(value)) return null;

  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([KMGTP])?(i)?B?$/i.exec(value);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  if (!match[2]) return Math.round(amount);

  const table = match[3] ? BINARY : DECIMAL;
  return Math.round(amount * table[match[2].toUpperCase()]);
}

export function parseHfProbe(text) {
  const fields = {};
  for (const line of String(text ?? '').split('\n')) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  if (!fields.bin) return null;
  return {
    bin: fields.bin,
    cacheDir: fields.cacheDir || null,
    /* `hf version` prints decorated text; keep only something version-ish. */
    version: (/([0-9]+\.[0-9]+\.[0-9]+)/.exec(fields.version || '') ?? [])[1] ?? null,
    user: fields.user || null,
  };
}

/* Turns a repo into its on-disk cache folder: Qwen/Qwen3 -> models--Qwen--Qwen3 */
export function cacheFolderName(repoType, repoId) {
  const prefix = repoType === 'model' ? 'models' : `${repoType}s`;
  return `${prefix}--${String(repoId).replace(/\//g, '--')}`;
}

function describeProblem(message) {
  const text = String(message ?? '');
  if (/not found|no such file|command not found/i.test(text)) return null; /* hf simply absent */
  if (/401|403|unauthor|gated|must be authenticated/i.test(text)) {
    return 'not authorised - run `hf auth login` on this node';
  }
  if (/permission denied/i.test(text)) return 'permission denied reading the HuggingFace cache';
  if (/no space left/i.test(text)) return 'no space left on the cache filesystem';
  return text.split('\n').find((l) => l.trim())?.slice(0, 200) ?? null;
}

export function parseCacheList(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { repos: [], error: null, available: false };

  let entries;
  try {
    entries = JSON.parse(trimmed);
  } catch {
    return { repos: [], error: describeProblem(trimmed), available: false };
  }
  if (!Array.isArray(entries)) return { repos: [], error: null, available: false };

  const repos = [];
  for (const entry of entries) {
    /* id is "<type>/<repoId>"; repoId itself may contain a slash. */
    const id = String(entry?.id ?? '');
    const slash = id.indexOf('/');
    const repoType = slash === -1 ? String(entry?.repo_type ?? '') : id.slice(0, slash);
    const repoId = String(entry?.repo_id ?? (slash === -1 ? '' : id.slice(slash + 1)));

    if (!REPO_TYPES.includes(repoType) || !REPO_ID_RE.test(repoId)) continue;

    repos.push({
      id: `${repoType}/${repoId}`,
      repoId,
      repoType,
      sizeBytes: parseHumanSize(entry?.size),
      sizeText: String(entry?.size ?? ''),
      lastAccessed: String(entry?.last_accessed ?? ''),
      lastModified: String(entry?.last_modified ?? ''),
      refs: Array.isArray(entry?.refs) ? entry.refs.map(String).slice(0, 4) : [],
    });
  }

  repos.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
  return { repos, error: null, available: true };
}

export function parseIncomplete(text) {
  const parts = String(text ?? '').trim().split(/\s+/);
  const files = Number.parseInt(parts[0] ?? '', 10);
  const bytes = Number.parseInt(parts[1] ?? '', 10);
  if (!Number.isFinite(files) || !Number.isFinite(bytes)) return { files: 0, bytes: 0 };
  return { files, bytes };
}

export function parsePrune(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  try {
    const data = JSON.parse(trimmed);
    return { revisions: Number(data?.revisions ?? 0), bytes: parseHumanSize(data?.size) };
  } catch {
    return null;
  }
}

const num = (value) => {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(n) ? n : null;
};

/*
 * A job's status is derived rather than stored, because the node is the source
 * of truth and it can change without the dashboard involved: the process can be
 * killed, or the whole node rebooted mid-download.
 */
export function deriveJobStatus(job, nowMs = Date.now()) {
  if (job.cancelled) return 'cancelled';
  if (job.exitCode !== null) {
    if (job.exitCode === 0) return 'done';
    /* 75 is the marker the job script writes when flock finds a peer running. */
    return job.exitCode === 75 ? 'blocked' : 'failed';
  }
  if (job.alive) return 'running';
  /* The pid file may not exist for a moment after launch. */
  const ageMs = job.startedAt ? nowMs - job.startedAt * 1000 : 0;
  return ageMs < 15000 ? 'starting' : 'orphaned';
}

export function parseJobs(text, nowMs = Date.now()) {
  const jobs = [];

  for (const block of String(text ?? '').split('@@JOB@@').slice(1)) {
    const lines = block.split('\n');
    const id = (lines.shift() ?? '').trim();
    if (!id) continue;

    const fields = {};
    for (const line of lines) {
      const idx = line.indexOf('=');
      if (idx === -1) continue;
      fields[line.slice(0, idx)] = line.slice(idx + 1);
    }

    let meta = {};
    try {
      meta = JSON.parse(fields.meta || '{}');
    } catch {
      /* A half-written meta.json should not drop the whole job. */
    }

    const totalBytes = num(fields.total);
    const downloadedBytes = num(fields.done);

    const job = {
      id,
      repoId: String(meta.repoId ?? ''),
      repoType: String(meta.repoType ?? 'model'),
      revision: meta.revision ?? null,
      pid: num(fields.pid),
      startedAt: num(fields.started),
      exitCode: num(fields.exit),
      alive: fields.alive?.trim() === '1',
      cancelled: fields.cancelled?.trim() === '1',
      /* 0 from the awk fallback means "could not determine", not "empty". */
      totalBytes: totalBytes && totalBytes > 0 ? totalBytes : null,
      downloadedBytes: downloadedBytes ?? 0,
      message: (fields.tail ?? '').trim().slice(0, 200) || null,
    };

    job.status = deriveJobStatus(job, nowMs);
    /*
     * The total is summed from hf's pre-rounded human sizes, so it rarely lands
     * exactly on the bytes written. A finished job is 100% by definition -
     * leaving it at 99% would read as though something were still outstanding.
     */
    job.percent =
      job.status === 'done'
        ? 100
        : job.status === 'cancelled' || job.status === 'failed' || job.status === 'blocked'
          ? null
        : job.totalBytes && job.downloadedBytes >= 0
          ? Math.min(100, (job.downloadedBytes / job.totalBytes) * 100)
          : null;

    jobs.push(job);
  }

  return jobs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

export const ACTIVE_STATUSES = new Set(['starting', 'running']);

export function summariseHf({ probe, cache, incomplete, prune, jobs }) {
  const repos = cache?.repos ?? [];
  return {
    available: Boolean(probe?.bin),
    error: cache?.error ?? null,
    bin: probe?.bin ?? null,
    version: probe?.version ?? null,
    user: probe?.user ?? null,
    cacheDir: probe?.cacheDir ?? null,
    repos,
    totalBytes: repos.reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0),
    jobs: jobs ?? [],
    reclaimable: {
      incompleteFiles: incomplete?.files ?? 0,
      incompleteBytes: incomplete?.bytes ?? 0,
      pruneBytes: prune?.bytes ?? null,
      pruneRevisions: prune?.revisions ?? 0,
    },
    scannedAt: cache?.available ? Date.now() : null,
  };
}

export const EMPTY_HF = {
  available: false,
  error: null,
  bin: null,
  version: null,
  user: null,
  cacheDir: null,
  repos: [],
  totalBytes: 0,
  jobs: [],
  reclaimable: { incompleteFiles: 0, incompleteBytes: 0, pruneBytes: null, pruneRevisions: 0 },
  scannedAt: null,
};
