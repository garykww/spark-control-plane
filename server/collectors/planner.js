/*
 * Run state: what a launched recipe is doing on the node right now.
 *
 * Starting a recipe is a long sequence - download tens of gigabytes, pull an
 * image, start a container, wait for the weights to load - so it runs detached
 * on the node exactly like a HuggingFace download, and its state is left there
 * to be polled. The node is the source of truth: restart the dashboard mid-run
 * and nothing is lost, because there was never an in-memory job to lose.
 *
 * The run script writes one small file per fact. That is more files than a
 * single JSON blob, but each write is a single short append that cannot be
 * caught half-finished by a poll landing between the open and the flush - the
 * two files a reader must never see partially written (`phase` and `exit`) are
 * additionally written to a .part and renamed.
 */

/* Kept beside the hf-jobs directory, under the same cache root. */
export const RUNS_DIR = '"$HOME/.cache/spark-control-plane/runs"';

export const RUN_ID_RE = /^run-[0-9]{13}-[0-9a-f]{8}$/;

/*
 * The phases a run moves through, in order. `download` and `pull` are skipped
 * when the weights and image are already on the node, which is the normal case
 * for every run after the first.
 */
export const RUN_PHASES = ['download', 'image', 'launch', 'wait', 'ready'];

const PHASE_STATUS = {
  download: 'downloading',
  image: 'pulling',
  launch: 'launching',
  wait: 'waiting',
  ready: 'ready',
};

/* Statuses in which a run still has work to do, so a second must not start. */
export const ACTIVE_RUN_STATUSES = new Set(['starting', 'downloading', 'pulling', 'launching', 'waiting']);

/*
 * Poll command. Cheap by construction: a handful of short file reads per run,
 * plus at most one `du` over the blob directories of an in-flight download. It
 * rides the normal metrics batch rather than a cadence of its own, because the
 * runs directory holds at most a few entries and a run's phase changing is
 * something the UI should show on the next tick, not thirty seconds later.
 */
export const PLANNER_COMMANDS = {
  runs:
    `D=${RUNS_DIR}; for r in "$D"/*/; do [ -d "$r" ] || continue; ` +
    'p="$(cat "$r/pid" 2>/dev/null)"; ' +
    'printf "@@RUN@@%s\\n" "$(basename "$r")"; ' +
    'printf "meta=%s\\n" "$(tr -d "\\n" < "$r/meta.json" 2>/dev/null)"; ' +
    'printf "pid=%s\\n" "$p"; ' +
    'printf "phase=%s\\n" "$(cat "$r/phase" 2>/dev/null)"; ' +
    'printf "started=%s\\n" "$(cat "$r/started" 2>/dev/null)"; ' +
    'printf "finished=%s\\n" "$(cat "$r/finished" 2>/dev/null)"; ' +
    'printf "exit=%s\\n" "$(cat "$r/exit" 2>/dev/null)"; ' +
    'printf "total=%s\\n" "$(cat "$r/total" 2>/dev/null)"; ' +
    'printf "cancelled=%s\\n" "$([ -f "$r/cancelled" ] && echo 1 || echo 0)"; ' +
    'printf "alive=%s\\n" "$({ [ -n "$p" ] && kill -0 "$p" 2>/dev/null && echo 1; } || echo 0)"; ' +
    /* Blob directories of this run's downloads, written by the script itself so
     * those paths never appear on this command line. */
    'printf "done=%s\\n" "$(du -sbc $(cat "$r/dirs" 2>/dev/null) 2>/dev/null | tail -1 | cut -f1)"; ' +
    'printf "tail=%s\\n" "$(tail -c 2000 "$r/log" 2>/dev/null | tr "\\r" "\\n" | grep . | tail -1)"; ' +
    'done',
};

const num = (value) => {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(n) ? n : null;
};

/* A 0-1 fraction. Separate from num() above, which is parseInt and would floor
 * every one of these to 0. Anything outside the range is null rather than
 * clamped: it did not come from a run this dashboard started. */
const fraction = (value) => {
  const n = Number.parseFloat(String(value ?? '').trim());
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : null;
};

/*
 * Status is derived on every poll rather than stored, because the node can
 * change it without the dashboard involved: the run can be killed, or the box
 * rebooted between the download and the launch.
 *
 * Exit 0 means the script reached `ready`, which it only does after the served
 * endpoint answered - so "ready" here means the model is genuinely serving,
 * not merely that a container started.
 */
export function deriveRunStatus(run, nowMs = Date.now()) {
  if (run.cancelled) return 'cancelled';
  if (run.exitCode !== null) {
    if (run.exitCode === 0) return 'ready';
    /* 75 is the marker the run script writes when flock finds a peer running. */
    return run.exitCode === 75 ? 'blocked' : 'failed';
  }
  if (run.alive) return PHASE_STATUS[run.phase] ?? 'starting';
  /* The pid file does not exist for a moment after launch. */
  const ageMs = run.startedAt ? nowMs - run.startedAt * 1000 : 0;
  return ageMs < 15000 ? 'starting' : 'orphaned';
}

export function parseRuns(text, nowMs = Date.now()) {
  const runs = [];

  for (const block of String(text ?? '').split('@@RUN@@').slice(1)) {
    const lines = block.split('\n');
    const id = (lines.shift() ?? '').trim();
    if (!RUN_ID_RE.test(id)) continue;

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
      /* A half-written meta.json should not drop the whole run. */
    }

    const totalBytes = num(fields.total);
    const phase = String(fields.phase ?? '').trim();

    const run = {
      id,
      recipeId: String(meta.recipeId ?? ''),
      recipeName: String(meta.recipeName ?? meta.recipeId ?? ''),
      modelRepoId: String(meta.modelRepoId ?? ''),
      containerName: String(meta.containerName ?? ''),
      port: num(meta.port),
      /* The fraction of TOTAL memory vLLM was told to claim. It reserves that
       * as one block at startup and never gives it back, so for a run that is
       * still serving it is the one honest figure for what that container is
       * holding - nvidia-smi reports no per-process memory on unified hardware.
       *
       * NOT num(): everything else read here is a count and num() is parseInt,
       * which turns 0.46 into 0 rather than into null - a value that reads as
       * "no memory reserved" instead of as "unparseable". */
      gpuMemoryUtilization: fraction(meta.gpuMemoryUtilization),
      /* The key is in the container's own argv anyway; surfacing it is what
       * makes the finished endpoint usable without reading `docker inspect`. */
      apiKey: String(meta.apiKey ?? '') || null,
      phase: RUN_PHASES.includes(phase) ? phase : null,
      pid: num(fields.pid),
      startedAt: num(fields.started),
      finishedAt: num(fields.finished),
      exitCode: num(fields.exit),
      alive: fields.alive?.trim() === '1',
      cancelled: fields.cancelled?.trim() === '1',
      /* 0 from the fallback means "could not determine", not "nothing to fetch". */
      totalBytes: totalBytes && totalBytes > 0 ? totalBytes : null,
      downloadedBytes: num(fields.done) ?? 0,
      message: (fields.tail ?? '').trim().slice(0, 200) || null,
    };

    run.status = deriveRunStatus(run, nowMs);
    /*
     * Only the download phase has a meaningful percentage. An image pull and a
     * weight load have no total to divide by, so they report null and the UI
     * shows a phase name instead of a bar that would have to be invented.
     */
    run.percent =
      run.status === 'downloading' && run.totalBytes
        ? Math.min(100, (run.downloadedBytes / run.totalBytes) * 100)
        : null;

    runs.push(run);
  }

  return runs.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

export const EMPTY_PLANNER = { runs: [], plans: [], serving: [] };
