import crypto from 'node:crypto';
import { createRunner } from './exec/index.js';
import { HF_RESOLVE, HF_DRY_RUN_TOTAL, cacheFolderName } from './collectors/huggingface.js';
import { RUNS_DIR, RUN_ID_RE } from './collectors/planner.js';
import { ARG_RE, recipeById, resolveArgs } from './recipes.js';

/*
 * Write path for the run planner: start a recipe, cancel one, stop the server
 * it left running, tidy a finished run away.
 *
 * Starting a recipe is a sequence that can take hours - fetch the weights, get
 * the image, start the container, wait for the weights to load - so it follows
 * the same shape as a HuggingFace download: one detached script on the node,
 * its progress written to files, nothing held in server memory. exec() kills
 * every command at 8 seconds, which is far shorter than any phase here.
 *
 * WHAT "BUILD THE IMAGE" MEANS. Every bundled recipe names a published image
 * and the run pulls it; none of them build. That is not an omission - building
 * vLLM for aarch64 on the node would take hours and produce something less
 * tested than the image the reference script pins. The build path exists for a
 * recipe that genuinely needs a derived image (a patched kernel, an extra
 * wheel): declare `image.build` and the phase writes a Dockerfile on the node
 * and builds it instead of pulling. Either way the phase is called `image` and
 * ends with the tag present locally.
 */

const TIMEOUTS = {
  launch: 8000,
  cancel: 15000,
  stop: 30000,
};

/* A run's weights can take hours; the load after that is minutes. Half an hour
 * of silence from a container that is up means something is wrong, not slow. */
const READY_TIMEOUT_SEC = 1800;

const bad = (message) => Object.assign(new Error(message), { status: 400 });

export function assertRunId(runId) {
  const id = String(runId ?? '');
  if (!RUN_ID_RE.test(id)) throw bad(`invalid run id: ${id}`);
  return id;
}

/*
 * Single-quotes a value for the node's shell. ARG_RE forbids the single quote
 * itself, so there is no escape to get wrong - a value either passes and is
 * safely quotable, or it never reaches a command line.
 */
function sq(value) {
  const text = String(value);
  if (!ARG_RE.test(text)) throw bad(`value cannot be passed to the node safely: ${text}`);
  return `'${text}'`;
}

function explain(output) {
  const text = String(output ?? '');
  if (/permission denied.*docker|docker.*permission denied/i.test(text)) {
    return 'permission denied - add the SSH user to the "docker" group on this node';
  }
  if (/cannot connect to the docker daemon/i.test(text)) return 'the Docker daemon is not running';
  if (/no space left/i.test(text)) return 'no space left on the cache filesystem';
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

/* One `hf download` per repo, preceded by a dry run so the bar has a total.
 * The blob directory of each goes in `dirs`, which is what the poll sums. */
function downloadSection(recipe) {
  const repos = [recipe.model, recipe.draft].filter(Boolean);

  const measure = repos
    .map((repo) => `  "$HF" download ${sq(repo.repoId)} --type ${sq(repo.repoType)} --dry-run --format json 2>/dev/null | ${HF_DRY_RUN_TOTAL}`)
    .join('\n');

  const fetch = repos
    .map(
      (repo) =>
        `say "--- fetching ${repo.repoId}"\n` +
        `"$HF" download ${sq(repo.repoId)} --type ${sq(repo.repoType)} --max-workers 8 >> "$D/log" 2>&1 \\\n` +
        `  || { say "could not download ${repo.repoId}"; finish 1; }`,
    )
    .join('\n');

  const dirs = repos
    .map((repo) => `printf '%s\\n' "$HUB/${cacheFolderName(repo.repoType, repo.repoId)}/blobs" >> "$D/dirs"`)
    .join('\n');

  return { measure, fetch, dirs };
}

/* Pull, or build a derived image when the recipe asks for one. */
function imageSection(recipe) {
  const ref = sq(recipe.image.ref);

  if (!recipe.image.build) {
    return `if docker image inspect ${ref} >/dev/null 2>&1; then
  say "image ${recipe.image.ref} is already here"
else
  say "--- pulling ${recipe.image.ref}"
  docker pull ${ref} >> "$D/log" 2>&1 || { say "could not pull ${recipe.image.ref}"; finish 1; }
fi`;
  }

  const lines = [`FROM ${recipe.image.build.from}`, ...(recipe.image.build.run ?? []).map((step) => `RUN ${step}`)];
  return `say "--- building ${recipe.image.ref}"
mkdir -p "$D/build"
printf '%s\\n' ${lines.map(sq).join(' ')} > "$D/build/Dockerfile"
docker build -t ${ref} "$D/build" >> "$D/log" 2>&1 \\
  || { say "could not build ${recipe.image.ref}"; finish 1; }`;
}

/*
 * The `docker run` the script issues.
 *
 * --entrypoint vllm with `serve` passed as the first argument is deliberate and
 * is the one thing that works against both image families: the spark-arena
 * builds set no entrypoint, while vllm/vllm-openai already runs `vllm serve`,
 * so passing `vllm serve ...` to the latter yields `vllm serve vllm serve ...`
 * and argparse rejects it. Pinning the entrypoint makes the argv identical
 * whichever image a recipe names.
 */
function dockerRunSection(recipe, { port, apiKey, cpuset, tuning }) {
  const flags = [
    '-d',
    `--name ${sq(recipe.containerName)}`,
    '--restart unless-stopped',
    '--gpus all',
    '--shm-size=32g',
    ...(cpuset ? [`--cpuset-cpus ${sq(cpuset)}`] : []),
    `-p ${sq(`0.0.0.0:${port}:8000`)}`,
    '-e HF_TOKEN="${HF_TOKEN:-}"',
    '-v "$HF_CACHE:/root/.cache/huggingface"',
    '-v "$HOME/.cache/vllm:/root/.cache/vllm"',
    '--entrypoint vllm',
  ];

  /* The tuned context, concurrency and memory fraction replace the recipe's
   * defaults here, so the container is given exactly what the panel priced. */
  const args = [...resolveArgs(recipe, tuning), '--api-key', apiKey].map(sq);

  return `docker run ${flags.join(' ')} \\
  ${sq(recipe.image.ref)} serve \\
  ${args.join(' ')} >> "$D/log" 2>&1`;
}

/*
 * The script the node actually runs, shipped base64-encoded so the only
 * characters crossing the shell are [A-Za-z0-9+/=].
 *
 * Every phase writes its name before it starts work, so a poll landing anywhere
 * in the sequence can say what is happening. `exit` is written exactly once, at
 * the end of whichever path the run takes, and only ever holds 0 when the
 * served endpoint has actually answered.
 */
export function buildRunScript({ runId, recipe, port, apiKey, cpuset, tuning }) {
  const download = downloadSection(recipe);

  return `#!/bin/sh
D="$HOME/.cache/spark-control-plane/runs/${runId}"
HF_CACHE="\${HF_HOME:-$HOME/.cache/huggingface}"
HUB="$HF_CACHE/hub"
LOG_PID=""

echo $$ > "$D/pid"
date +%s > "$D/started"

say() { printf '%s\\n' "$*" >> "$D/log"; }

# phase and exit are the two files a poll must never catch half-written, so both
# go through a temp file and a rename, which is atomic within a filesystem.
set_phase() { printf '%s\\n' "$1" > "$D/phase.part" && mv "$D/phase.part" "$D/phase"; }
finish() {
  [ -n "$LOG_PID" ] && kill "$LOG_PID" 2>/dev/null
  printf '%s\\n' "$1" > "$D/exit.part" && mv "$D/exit.part" "$D/exit"
  date +%s > "$D/finished"
  exit "$1"
}

# One run at a time per node. Two recipes racing would fight over the same port,
# the same memory and possibly the same container name.
exec 9>"$D/../.lock"
if ! flock -n 9; then
  say "another recipe is already being started on this node"
  finish 75
fi

# ---------------------------------------------------------------- weights ----
set_phase download
${HF_RESOLVE}
if [ -z "$HF" ]; then
  say "the hf CLI is not on this node, so the weights cannot be fetched"
  finish 127
fi

: > "$D/dirs"
${download.dirs}

# Total first, so the bar has a denominator. Best effort: on failure the file
# holds 0 and the UI shows bytes fetched rather than inventing a percentage.
{
${download.measure}
} | awk '{s+=$1} END{printf "%d\\n", s+0}' > "$D/total" 2>/dev/null || echo 0 > "$D/total"

${download.fetch}

# ------------------------------------------------------------------ image ----
set_phase image
${imageSection(recipe)}

# ----------------------------------------------------------------- launch ----
set_phase launch
printf '%s' ${sq(recipe.containerName)} > "$D/container"

# Replace any container left by an earlier run of this same recipe. Only this
# recipe's own name is ever removed.
docker rm -f ${sq(recipe.containerName)} >/dev/null 2>&1

say "--- starting ${recipe.containerName} on port ${port}"
${dockerRunSection(recipe, { port, apiKey, cpuset, tuning })} \\
  || { say "docker run failed"; finish 1; }

# --------------------------------------------------------------- readiness ----
set_phase wait
say "--- waiting for the server (loading weights can take several minutes)"

# Follow the container's log into ours so the UI's message line shows real
# loading progress instead of sitting on "starting" for ten minutes.
docker logs -f ${sq(recipe.containerName)} >> "$D/log" 2>&1 &
LOG_PID=$!

CURL="$(command -v curl 2>/dev/null)"
[ -n "$CURL" ] || say "curl is not installed here - falling back to waiting for the container to settle"

deadline=$(( $(date +%s) + ${READY_TIMEOUT_SEC} ))
settled=$(( $(date +%s) + 90 ))

while :; do
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx ${sq(recipe.containerName)}; then
    say "the container exited during startup:"
    docker logs --tail 40 ${sq(recipe.containerName)} >> "$D/log" 2>&1
    finish 1
  fi

  if [ -n "$CURL" ]; then
    if "$CURL" -sf -m 5 -H "Authorization: Bearer ${apiKey}" \\
        "http://127.0.0.1:${port}/v1/models" >/dev/null 2>&1; then
      break
    fi
  elif [ "$(date +%s)" -ge "$settled" ]; then
    # No curl to ask, so the best available evidence is that the container has
    # stayed up well past the point where a bad configuration would have exited.
    break
  fi

  if [ "$(date +%s)" -ge "$deadline" ]; then
    say "the server did not answer within ${Math.round(READY_TIMEOUT_SEC / 60)} minutes"
    finish 1
  fi
  sleep 5
done

set_phase ready
say "--- ready on port ${port}"
finish 0
`;
}

export async function startRun(node, { recipeId, port, tuning } = {}) {
  const recipe = recipeById(recipeId);

  /* Always the plan's own resolved tuning, never the raw request body: the
   * memory fraction in particular is computed against a live memory reading
   * and must not be something a caller can assert. */
  if (!tuning?.contextLength || !tuning?.maxRequests || !tuning?.gpuMemoryUtilization) {
    throw bad('a resolved plan is required to start a run');
  }

  /* The only knob the client turns. Everything else comes from the catalogue. */
  const chosenPort = port === undefined || port === null || port === '' ? recipe.port : Number(port);
  if (!Number.isInteger(chosenPort) || chosenPort < 1 || chosenPort > 65535) {
    throw bad(`port must be between 1 and 65535 (got ${port})`);
  }

  const runId = `run-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const apiKey = `sk-${crypto.randomBytes(24).toString('hex')}`;

  /* The recipe's CPU pinning targets GB10's Cortex-X925 cores. A smaller host
   * has no core 19 and docker would refuse the run outright, so it is applied
   * only where those cores exist. */
  const cpuset = node.type === 'dgx-spark' ? '5-9,15-19' : null;

  const script = buildRunScript({ runId, recipe, port: chosenPort, apiKey, cpuset, tuning });
  const meta = JSON.stringify({
    runId,
    recipeId: recipe.id,
    recipeName: recipe.name,
    modelRepoId: recipe.model.repoId,
    draftRepoId: recipe.draft?.repoId ?? null,
    imageRef: recipe.image.ref,
    containerName: recipe.containerName,
    port: chosenPort,
    apiKey,
    contextLength: tuning.contextLength,
    maxRequests: tuning.maxRequests,
    gpuMemoryUtilization: tuning.gpuMemoryUtilization,
    createdAt: new Date().toISOString(),
  });

  const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

  /*
   * The redirections on the backgrounded process are load-bearing. Without
   * </dev/null >/dev/null 2>&1 the child inherits the SSH channel's stdout and
   * ssh will not return until the whole run finishes - so exec()'s 8s SIGKILL
   * fires and every launch looks like a failure while the run proceeds fine.
   */
  const command =
    `D=${RUNS_DIR}/${runId}; mkdir -p "$D" && ` +
    `printf %s '${b64(script)}' | base64 -d > "$D/run.sh" && ` +
    `printf %s '${b64(meta)}' | base64 -d > "$D/meta.json" && ` +
    `setsid nohup sh "$D/run.sh" </dev/null >/dev/null 2>&1 & ` +
    /* Sweep finished runs older than a day so the poll's list stays short. */
    `find ${RUNS_DIR} -maxdepth 1 -type d -name 'run-*' -mmin +1440 ` +
    `-exec sh -c '[ -f "$1/exit" ] && rm -rf "$1"' _ {} \\; 2>/dev/null; ` +
    `echo launched`;

  return withRunner(node, async (runner) => {
    const { code, stdout, stderr } = await runner.run(command, TIMEOUTS.launch);
    if (!stdout.includes('launched')) {
      throw bad(explain(`${stdout}${stderr}`) || `could not start the run (exit ${code})`);
    }
    return { ok: true, runId, recipeId: recipe.id, port: chosenPort, apiKey, tuning };
  });
}

/*
 * Cancel tears down whatever the run has built so far. setsid made the script a
 * process-group leader, so one signal to the negated pid takes the whole tree,
 * including an in-flight `hf download` or `docker pull`. The container it may
 * already have started is not part of that group, so it is removed by name -
 * read from the file the script wrote, which keeps that name off this command
 * line and means cancel needs to know nothing about which recipe was running.
 */
export async function cancelRun(node, runId) {
  const id = assertRunId(runId);

  const command =
    `D=${RUNS_DIR}/${id}; [ -d "$D" ] || { echo missing; exit 0; }; ` +
    `touch "$D/cancelled"; p="$(cat "$D/pid" 2>/dev/null)"; ` +
    `[ -n "$p" ] && kill -TERM -"$p" 2>/dev/null; ` +
    `c="$(cat "$D/container" 2>/dev/null)"; ` +
    `[ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1; ` +
    `[ -f "$D/exit" ] || echo 143 > "$D/exit"; echo cancelled`;

  return withRunner(node, async (runner) => {
    const { stdout } = await runner.run(command, TIMEOUTS.cancel);
    if (stdout.includes('missing')) throw Object.assign(new Error('run not found'), { status: 404 });
    return { ok: true, runId: id };
  });
}

/*
 * Stops the server a finished run left behind. Distinct from cancel: there is
 * no process left to signal, and the container is the whole of what remains.
 */
export async function stopRun(node, runId) {
  const id = assertRunId(runId);

  const command =
    `D=${RUNS_DIR}/${id}; c="$(cat "$D/container" 2>/dev/null)"; ` +
    `[ -n "$c" ] || { echo missing; exit 0; }; ` +
    `docker rm -f "$c" 2>&1; echo "@@CODE@@$?"`;

  return withRunner(node, async (runner) => {
    const { stdout, stderr } = await runner.run(command, TIMEOUTS.stop);
    if (stdout.includes('missing')) {
      throw Object.assign(new Error('this run has no container to stop'), { status: 404 });
    }
    const code = Number.parseInt((/@@CODE@@(-?\d+)/.exec(stdout) ?? [])[1] ?? '', 10);
    const output = stdout.replace(/@@CODE@@-?\d+/, '').trim();
    if (code !== 0) throw bad(explain(`${output}${stderr}`) || `could not stop the container (exit ${code})`);
    return { ok: true, runId: id };
  });
}

export async function clearRun(node, runId) {
  const id = assertRunId(runId);

  /* Refuses while the script is alive so a running sequence cannot be orphaned
   * by tidying its state away underneath it. */
  const command =
    `D=${RUNS_DIR}/${id}; p="$(cat "$D/pid" 2>/dev/null)"; ` +
    `if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo running; else rm -rf "$D"; echo cleared; fi`;

  return withRunner(node, async (runner) => {
    const { stdout } = await runner.run(command, TIMEOUTS.cancel);
    if (stdout.includes('running')) throw bad('cancel the run before clearing it');
    return { ok: true, runId: id };
  });
}
