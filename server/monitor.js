import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { registry } from './registry.js';
import { createRunner, runBatch } from './exec/index.js';
import { SYSTEM_COMMANDS, parseSystem } from './collectors/system.js';
import {
  GPU_COMMANDS,
  SM_COUNT_COMMAND,
  parseGpus,
  parseGpuProcesses,
  parsePmon,
  parseSmCount,
} from './collectors/gpu.js';
import { DOCKER_COMMANDS, parseContainers, parseImages } from './collectors/docker.js';
import {
  HF_PROBE_COMMAND,
  HF_CACHE_COMMANDS,
  HF_JOB_COMMANDS,
  ACTIVE_STATUSES,
  EMPTY_HF,
  parseHfProbe,
  parseCacheList,
  parseIncomplete,
  parsePrune,
  parseJobs,
  summariseHf,
} from './collectors/huggingface.js';
import { PLANNER_COMMANDS, EMPTY_PLANNER, parseRuns } from './collectors/planner.js';
import { buildPlanner } from './recipes.js';
import { probeLlmEndpoints } from './collectors/llm.js';
import { demoSnapshot } from './collectors/demo.js';
import { specForNode } from './collectors/specs.js';
import { NodeHistory } from './history.js';

/*
 * Polls every enabled node on a fixed interval and keeps the latest snapshot in
 * memory. Browsers never trigger collection: they subscribe to what the loop has
 * already gathered, so ten open tabs cost exactly as much as one.
 *
 * Each node runs on its own timer chain (poll, then schedule the next poll)
 * rather than a shared setInterval, so a slow host falls behind on its own
 * instead of delaying every other node.
 */

const rate = (current, previous, seconds) => {
  if (previous === null || previous === undefined || current === null) return null;
  if (!(seconds > 0)) return null;
  /* Counters reset when a host or service restarts; report 0 rather than a spike. */
  if (current < previous) return 0;
  return (current - previous) / seconds;
};

/*
 * How far back the token totals reach - the same span the sparklines cover at
 * the default poll interval, so the totals describe the stretch of time the
 * charts are drawing rather than some longer window behind them.
 *
 * Kept as cumulative counter samples rather than integrated rates: a counter
 * difference is exact, while summing per-poll rates would inherit every
 * rounding error and every missed poll. At one sample per poll this is a few
 * hundred numbers per endpoint, which is nothing.
 */
const TOKEN_WINDOW_MS = 10 * 60 * 1000;

/*
 * Energy accounting in fixed intervals.
 *
 * Power is not a constant: the node idles at one draw and loads at another, and
 * a single figure over a long window smears the two together. So each interval
 * integrates the power actually sampled inside it - a Riemann sum over the poll
 * cadence, not a mean times a span - and carries the token delta from the same
 * interval. Cost per token is then a division of two figures that describe the
 * same minutes, and a run of intervals shows how it moved.
 */
const ENERGY_BUCKET_MS = 5 * 60 * 1000;
/* Twelve of them is an hour of history, which is enough to see a workload
 * change without keeping a database. */
const ENERGY_BUCKETS_KEPT = 12;

const delta = (now, before) => {
  /* A restarted model server rewinds its counters; count nothing rather than a
   * negative, and the next interval resumes normally. */
  const value = (now ?? 0) - (before ?? 0);
  return value > 0 ? value : 0;
};

/*
 * Folds one poll into the current interval, closing it when it is full.
 *
 * `state` is opaque to the caller: the open interval plus the previous sample's
 * cumulative counters. Energy accrues as watts x the time since the last poll,
 * so an irregular cadence or a skipped poll costs accuracy rather than
 * correctness - the joules that were measured are the joules that are counted.
 */
export function advanceEnergyBuckets(state, sample, bucketMs = ENERGY_BUCKET_MS, keep = ENERGY_BUCKETS_KEPT) {
  const previous = state?.previous ?? null;
  const closed = state?.closed ?? [];

  let open = state?.open ?? {
    startedAt: sample.at,
    endedAt: sample.at,
    joules: 0,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    prefillSeconds: 0,
    decodeSeconds: 0,
  };

  if (previous) {
    const elapsed = (sample.at - previous.at) / 1000;
    if (elapsed > 0 && Number.isFinite(sample.watts)) open.joules += sample.watts * elapsed;

    open.endedAt = sample.at;
    open.inputTokens += delta(sample.input, previous.input);
    open.cachedTokens += delta(sample.cached, previous.cached);
    open.outputTokens += delta(sample.output, previous.output);
    open.prefillSeconds += delta(sample.prefillSeconds, previous.prefillSeconds);
    open.decodeSeconds += delta(sample.decodeSeconds, previous.decodeSeconds);
  }

  let nextClosed = closed;
  if (sample.at - open.startedAt >= bucketMs) {
    nextClosed = [...closed, open].slice(-keep);
    open = {
      startedAt: sample.at,
      endedAt: sample.at,
      joules: 0,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      prefillSeconds: 0,
      decodeSeconds: 0,
    };
  }

  return { state: { open, closed: nextClosed, previous: sample }, closed: nextClosed, open };
}

/*
 * Adds one sample of an endpoint's cumulative counters and answers what was
 * served across the retained span.
 *
 * Every backend here publishes cumulative totals, so the answer is simply "now
 * minus the oldest sample still inside the window" - exact, and immune to a
 * poll that was skipped or a rate that was rounded.
 *
 * A counter that goes backwards means the model server restarted; its history
 * before that point describes a process that no longer exists, so the window
 * starts again from the restart rather than reporting a negative total or a
 * spike. `complete` says whether the span has filled yet, which is what lets
 * the panel label a partial window honestly instead of implying ten minutes of
 * data it does not have.
 */
export function advanceTokenWindow(previous, sample, windowMs) {
  let samples = previous ?? [];

  const last = samples.at(-1);
  if (last && (sample.generated < last.generated || sample.prompt < last.prompt)) samples = [];

  samples = [...samples, sample];

  /* One sample older than the cutoff is kept, so the delta spans the window
   * fully rather than starting just inside it. */
  const cutoff = sample.at - windowMs;
  let first = 0;
  while (first + 1 < samples.length && samples[first + 1].at <= cutoff) first += 1;
  samples = samples.slice(first);

  const oldest = samples[0];

  return {
    samples,
    window: {
      seconds: (sample.at - oldest.at) / 1000,
      complete: sample.at - oldest.at >= windowMs,
      decode: sample.generated - oldest.generated,
      prefill: sample.prompt - oldest.prompt,
      cached: sample.cached - oldest.cached,
      /* Engine time in each phase across the same span, for the energy split. */
      prefillSeconds: sample.prefillSeconds - oldest.prefillSeconds,
      decodeSeconds: sample.decodeSeconds - oldest.decodeSeconds,
    },
  };
}

class NodeMonitor {
  constructor(node) {
    this.nodeId = node.id;
    this.history = new NodeHistory();
    this.snapshot = this.#offlineSnapshot(node, 'waiting for first poll');
    this.consecutiveFailures = 0;
    this.previous = null;
    /* Cumulative token counters over TOKEN_WINDOW_MS, keyed by endpoint id. */
    this.tokenWindows = new Map();
    /* Five-minute energy intervals, each pairing measured joules with the
     * tokens served inside it. */
    this.energyState = null;
    this.runner = null;
    this.timer = null;
    this.stopped = false;
    this.polling = false;
    /* Fixed hardware facts, probed once per connection rather than every poll. */
    this.smCount = null;
    this.smCountProbed = false;

    /* HuggingFace state. The cache listing runs on its own slow cadence; job
     * state is polled every tick, but only while a download is actually live. */
    this.hf = EMPTY_HF;
    this.hfProbe = null;
    this.hfProbed = false;
    this.hfNextAt = 0;
    this.hfCache = null;
    this.hfIncomplete = null;
    this.hfPrune = null;
  }

  #offlineSnapshot(node, error) {
    return {
      nodeId: node.id,
      name: node.name,
      type: node.type,
      online: false,
      error,
      collectedAt: Date.now(),
      spec: specForNode(node),
      gpus: [],
      gpuProcesses: [],
      hf: EMPTY_HF,
      planner: EMPTY_PLANNER,
      containers: [],
      dockerImages: [],
      dockerAvailable: false,
      dockerError: null,
      storage: [],
      network: [],
      thermal: [],
      llm: [],
      energy: null,
    };
  }

  start() {
    this.#scheduleNext(0);
  }

  /* Docker needs a moment to settle after start/stop before `docker ps` is accurate. */
  pollSoon() {
    this.#scheduleNext(400);
  }

  /* Forces the next poll to re-read the HuggingFace cache, after a write. */
  markHfStale() {
    this.hfNextAt = 0;
    this.pollSoon();
  }

  #scheduleNext(delay = config.pollIntervalMs) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.#poll(), delay);
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.runner?.close?.();
    this.runner = null;
  }

  /* Called when the node's config changes so the next poll picks up new credentials. */
  invalidateRunner() {
    const old = this.runner;
    this.runner = null;
    /* Credentials or the host itself may have changed; re-probe the hardware. */
    this.smCountProbed = false;
    this.hfProbed = false;
    this.hfNextAt = 0;
    old?.close?.();
  }

  async #poll() {
    if (this.stopped || this.polling) return;
    this.polling = true;

    const node = registry.get(this.nodeId);
    if (!node) {
      this.polling = false;
      return;
    }

    const startedAt = Date.now();
    try {
      const snapshot = config.demoMode
        ? this.#finishDemo(node)
        : await this.#collect(node);

      this.snapshot = snapshot;
      this.consecutiveFailures = 0;
      this.history.record(snapshot);
    } catch (err) {
      this.consecutiveFailures += 1;
      const message = String(err?.message || err);

      /*
       * A single failed poll is usually a transient SSH hiccup. The last good
       * snapshot is kept (flagged stale) until the failures pass the threshold,
       * which stops the UI flickering offline on every blip.
       */
      if (this.consecutiveFailures >= config.offlineThreshold) {
        this.snapshot = this.#offlineSnapshot(node, message);
        this.previous = null;
        this.invalidateRunner();
      } else {
        this.snapshot = { ...this.snapshot, stale: true, error: message };
      }
    } finally {
      this.polling = false;
      /* Keep a steady cadence: subtract the time collection actually took. */
      this.#scheduleNext(Math.max(250, config.pollIntervalMs - (Date.now() - startedAt)));
    }
  }

  #finishDemo(node) {
    const index = registry.list().findIndex((n) => n.id === node.id);
    const snapshot = {
      nodeId: node.id,
      name: node.name,
      type: node.type,
      spec: specForNode(node),
      ...demoSnapshot(node, Math.max(0, index)),
    };
    /* Planned against the synthetic figures, so demo mode shows real fit
     * arithmetic rather than a panel full of placeholders. */
    snapshot.planner = buildPlanner(snapshot, []);
    return snapshot;
  }

  async #collect(node) {
    this.runner ??= createRunner(node);
    await this.#probeSmCount();

    /* The HuggingFace collection runs alongside the metrics batch rather than
     * after it, so its latency overlaps instead of adding to the poll. */
    const [sections, llmProbes] = await Promise.all([
      runBatch(this.runner, {
        ...SYSTEM_COMMANDS,
        ...GPU_COMMANDS,
        ...DOCKER_COMMANDS,
        ...PLANNER_COMMANDS,
      }),
      probeLlmEndpoints(
        (node.llmPorts ?? []).map((p) => ({ host: node.host, port: p.port, label: p.label })),
      ),
      this.#collectHf(),
    ]);

    const system = parseSystem(sections);
    const isUnified = node.type === 'dgx-spark';
    const gpus = parseGpus(sections.gpu || '', { isUnified });
    for (const gpu of gpus) gpu.smCount = this.smCount;
    const docker = parseContainers(sections.docker || '');
    const runs = parseRuns(sections.runs || '');

    const now = Date.now();
    const elapsedSeconds = this.previous ? (now - this.previous.at) / 1000 : 0;

    const snapshot = {
      nodeId: node.id,
      name: node.name,
      type: node.type,
      spec: specForNode(node),
      online: true,
      stale: false,
      error: null,
      collectedAt: now,
      host: system.host,
      uptimeSeconds: system.uptimeSeconds,
      load: system.load,
      cpu: this.#deriveCpu(system, elapsedSeconds),
      memory: {
        ...system.memory,
        percent: system.memory.total ? (system.memory.used / system.memory.total) * 100 : 0,
      },
      gpus,
      gpuProcesses: this.#mergeProcesses(sections),
      hf: this.hf,
      containers: docker.containers,
      dockerImages: parseImages(sections.dockerImages || ''),
      dockerAvailable: docker.available,
      dockerError: docker.error,
      thermal: system.thermal,
      storage: system.storage,
      network: this.#deriveNetwork(system, elapsedSeconds),
      llm: this.#deriveLlm(llmProbes, elapsedSeconds),
    };

    /*
     * Whether each recipe fits is read off the snapshot that was just built -
     * memory, cache contents, free disk and published ports all come from it -
     * so the plan a browser sees is always consistent with the numbers beside
     * it, rather than being recomputed against a later reading in the UI.
     */
    /* Energy and tokens over the same trailing window, which the panel prices. */
    snapshot.energy = this.#energy(snapshot.llm, gpus[0]?.powerDraw, now);

    snapshot.planner = buildPlanner(snapshot, runs);

    /* Baseline for the next poll's rate calculations. */
    this.previous = {
      at: now,
      cpu: system.cpuRaw,
      interfaces: system.interfacesRaw,
      llm: llmProbes.map((p) => ({ id: p.id, counters: p.counters })),
    };

    return snapshot;
  }

  /*
   * The SM count comes from the CUDA driver API, which needs a python3 that can
   * load libcuda. It is optional: without it the UI simply omits the SM grid.
   */
  async #probeSmCount() {
    if (this.smCountProbed) return;
    this.smCountProbed = true;
    try {
      const { stdout } = await this.runner.run(SM_COUNT_COMMAND, 6000);
      this.smCount = parseSmCount(stdout);
    } catch {
      this.smCount = null;
    }
  }

  /*
   * Locates the hf CLI and reads its identity once per connection. It is not on
   * the non-interactive SSH PATH on a DGX Spark, and `auth whoami` costs a
   * network round trip, so this stays out of the per-poll path.
   */
  async #probeHf() {
    if (this.hfProbed) return;
    this.hfProbed = true;
    try {
      const { stdout } = await this.runner.run(HF_PROBE_COMMAND, 12000);
      this.hfProbe = parseHfProbe(stdout);
    } catch {
      this.hfProbe = null;
    }
  }

  /*
   * Collects HuggingFace state on a cadence of its own: the cache listing every
   * hfCacheIntervalMs, and job state on every poll but only while a download is
   * live. Never throws - a failure here must not take a node offline.
   */
  async #collectHf() {
    try {
      await this.#probeHf();
      if (!this.hfProbe?.bin) return;

      const active = this.hf.jobs.some((job) => ACTIVE_STATUSES.has(job.status));
      const cacheDue = Date.now() >= this.hfNextAt;
      if (!active && !cacheDue) return;

      const sections = await runBatch(
        this.runner,
        { ...HF_JOB_COMMANDS, ...(cacheDue ? HF_CACHE_COMMANDS : {}) },
        config.hfCommandTimeoutMs,
      );

      const jobs = parseJobs(sections.hfJobs || '');

      if (cacheDue) {
        this.hfCache = parseCacheList(sections.hfCache || '');
        this.hfIncomplete = parseIncomplete(sections.hfIncomplete || '');
        this.hfPrune = parsePrune(sections.hfPrune || '');
        this.hfNextAt = Date.now() + config.hfCacheIntervalMs;
      }

      /* A download that just finished changed the cache - re-read it next tick
       * rather than leaving a stale listing for up to half a minute. */
      if (active && !jobs.some((job) => ACTIVE_STATUSES.has(job.status))) this.hfNextAt = 0;

      this.hf = summariseHf({
        probe: this.hfProbe,
        cache: this.hfCache,
        incomplete: this.hfIncomplete,
        prune: this.hfPrune,
        jobs,
      });
    } catch {
      /* Leave the last good HuggingFace state in place. */
    }
  }

  /*
   * `--query-compute-apps` knows each process's full path and GPU memory;
   * `pmon` knows its share of SM time. Join them on pid so one row carries both.
   */
  #mergeProcesses(sections) {
    const processes = parseGpuProcesses(sections.gpuProcesses || '');
    const smByPid = new Map(
      parsePmon(sections.gpuPmon || '')
        .filter((p) => p.sm !== null)
        .map((p) => [p.pid, p.sm]),
    );

    return processes.map((process) => ({ ...process, sm: smByPid.get(process.pid) ?? null }));
  }

  /*
   * CPU time is cumulative, so utilisation is the busy delta over the total
   * delta. The first poll after a connect has nothing to diff against, so it
   * reports null - "not measured yet" - rather than 0, which would read as a
   * genuinely idle machine.
   */
  #deriveCpu(system, elapsedSeconds) {
    const prev = this.previous?.cpu;
    const current = system.cpuRaw.aggregate;

    const percentOf = (now, before) => {
      if (!before) return null;
      const totalDelta = now.total - before.total;
      if (totalDelta <= 0) return null;
      return Math.min(100, Math.max(0, ((now.busy - before.busy) / totalDelta) * 100));
    };

    const cores = prev?.cores
      ? system.cpuRaw.cores.map((core, i) => percentOf(core, prev.cores[i]) ?? 0)
      : [];

    return {
      model: system.cpu.model,
      cores: system.cpu.cores || system.cpuRaw.cores.length,
      percent: percentOf(current, prev?.aggregate),
      cores_percent: cores,
      runnable: system.cpuRaw.runnable,
      elapsedSeconds,
    };
  }

  #deriveNetwork(system, elapsedSeconds) {
    const prev = new Map((this.previous?.interfaces ?? []).map((i) => [i.name, i]));
    return system.interfacesRaw.map((iface) => {
      const before = prev.get(iface.name);
      return {
        ...iface,
        rxRate: rate(iface.rxBytes, before?.rxBytes, elapsedSeconds) ?? 0,
        txRate: rate(iface.txBytes, before?.txBytes, elapsedSeconds) ?? 0,
      };
    });
  }

  /*
   * Token throughput: prefer a rate the backend publishes directly, otherwise
   * diff its cumulative token counters across the interval.
   */
  /*
   * What the node spent and served, in five-minute intervals.
   *
   * This reports joules and tokens; the panel applies a price. Keeping the
   * tariff out of here means changing it is a re-render rather than a re-poll,
   * and it keeps this function to things that were actually measured.
   *
   * ONLY THE GPU RAIL IS MEASURED. On GB10 nvidia-smi reports no power limit
   * and the platform exposes no module-level sensor - no hwmon rails, no
   * powercap - so CPU, memory, storage and PSU losses are absent. The rail
   * still varies with load, which is what makes per-interval integration worth
   * doing; the missing baseline is roughly constant, so the panel adds it as a
   * figure the operator reads off a plug meter once.
   */
  #energy(llm, watts, now) {
    const cumulative = (pick) => llm.reduce((acc, entry) => acc + (pick(entry) ?? 0), 0);
    const reporting = llm.some((entry) => entry.promptTokens !== null);

    const { state, closed, open } = advanceEnergyBuckets(this.energyState, {
      at: now,
      watts,
      /* Cached tokens are excluded from the input count deliberately: vLLM
       * skips those blocks, so they consume none of the prefill time the cost
       * is attributed by. */
      input: cumulative((e) => e.promptTokens) - cumulative((e) => e.cachedTokens),
      cached: cumulative((e) => e.cachedTokens),
      output: cumulative((e) => e.generatedTokens),
      prefillSeconds: cumulative((e) => e.prefillSeconds),
      decodeSeconds: cumulative((e) => e.decodeSeconds),
    });
    this.energyState = state;

    if (!reporting || !Number.isFinite(watts)) return null;

    const bucket = (b) => ({
      startedAt: b.startedAt,
      endedAt: b.endedAt,
      wattHours: b.joules / 3600,
      /* The average draw across the interval, which is what varied. */
      meanWatts: b.endedAt > b.startedAt ? b.joules / ((b.endedAt - b.startedAt) / 1000) : 0,
      inputTokens: b.inputTokens,
      cachedTokens: b.cachedTokens,
      outputTokens: b.outputTokens,
      prefillSeconds: b.prefillSeconds,
      decodeSeconds: b.decodeSeconds,
    });

    return {
      bucketSeconds: ENERGY_BUCKET_MS / 1000,
      measuredWatts: watts,
      /* Newest last. The open interval is reported separately so the panel can
       * show it as still filling rather than mixing a partial into the totals. */
      buckets: closed.map(bucket),
      current: bucket(open),
    };
  }

  /* Tokens over the trailing window for one endpoint. The arithmetic is
   * advanceTokenWindow's; this only keeps the samples per endpoint. */
  #tokenWindow(id, counters, now) {
    if (!counters) {
      this.tokenWindows.delete(id);
      return null;
    }

    const { samples, window } = advanceTokenWindow(this.tokenWindows.get(id), {
      at: now,
      generated: counters.generatedTokens ?? 0,
      prompt: counters.promptTokens ?? 0,
      cached: counters.cachedTokens ?? 0,
      prefillSeconds: counters.prefillSeconds ?? 0,
      decodeSeconds: counters.decodeSeconds ?? 0,
    }, TOKEN_WINDOW_MS);

    this.tokenWindows.set(id, samples);
    return window;
  }

  #deriveLlm(probes, elapsedSeconds) {
    const prev = new Map((this.previous?.llm ?? []).map((p) => [p.id, p]));

    /* An endpoint removed from the node's config stops being polled, so drop
     * its window rather than holding an hour of samples nothing will read. */
    const live = new Set(probes.map((p) => p.id));
    for (const id of this.tokenWindows.keys()) {
      if (!live.has(id)) this.tokenWindows.delete(id);
    }

    return probes.map((probe) => {
      const counters = probe.counters;
      const before = prev.get(probe.id)?.counters;

      const decodeRate = counters?.reportedDecodeRate
        ?? rate(counters?.generatedTokens, before?.generatedTokens, elapsedSeconds)
        ?? 0;
      const prefillRate = counters?.reportedPrefillRate
        ?? rate(counters?.promptTokens, before?.promptTokens, elapsedSeconds)
        ?? 0;
      const cachedRate = rate(counters?.cachedTokens, before?.cachedTokens, elapsedSeconds) ?? 0;

      /*
       * The share of prompt tokens that came from the prefix cache, taken from
       * the cumulative counters rather than the two rates above: a ratio of
       * per-poll rates is undefined whenever the server is idle, while this one
       * holds still and stays readable between requests.
       */
      const cachedShare =
        counters?.cachedTokens != null && counters?.promptTokens > 0
          ? counters.cachedTokens / counters.promptTokens
          : null;

      const window = this.#tokenWindow(probe.id, counters, Date.now());

      return {
        id: probe.id,
        label: probe.label,
        port: probe.port,
        online: probe.online,
        backend: probe.backend,
        models: probe.models,
        error: probe.error,
        latencyMs: probe.latencyMs,
        decodeRate,
        prefillRate,
        cachedRate,
        cachedShare,
        /*
         * The cumulative prompt-side counters, carried through as well as their
         * rates. Prefill arrives in bursts - thousands of tokens in a fraction
         * of a second, then nothing for minutes - so a rate sampled every poll
         * reads zero almost always and dilutes the burst it does catch across
         * the whole interval. The totals are what stay meaningful between
         * requests, and are what the panel shows for the cached figure.
         */
        promptTokens: counters?.promptTokens ?? null,
        cachedTokens: counters?.cachedTokens ?? null,
        generatedTokens: counters?.generatedTokens ?? null,
        /* Cumulative engine time per phase, which the energy intervals diff. */
        prefillSeconds: counters?.prefillSeconds ?? null,
        decodeSeconds: counters?.decodeSeconds ?? null,
        /* Tokens over the trailing window, or over however much of it has
         * been observed so far - `complete` distinguishes the two. */
        window,
        running: counters?.running ?? null,
        queued: counters?.queued ?? null,
        kvCacheUsage: counters?.kvCacheUsage ?? null,
      };
    });
  }

}

export class Monitor extends EventEmitter {
  #monitors = new Map();
  #pushTimer = null;

  start() {
    this.sync();
    this.#pushTimer = setInterval(() => this.emit('snapshot', this.snapshot()), config.pushIntervalMs);
  }

  async stop() {
    clearInterval(this.#pushTimer);
    await Promise.all([...this.#monitors.values()].map((m) => m.stop()));
    this.#monitors.clear();
  }

  /* Reconciles running pollers against the registry after any config change. */
  sync() {
    const wanted = new Map(registry.list().filter((n) => n.enabled).map((n) => [n.id, n]));

    for (const [id, monitor] of this.#monitors) {
      if (!wanted.has(id)) {
        monitor.stop();
        this.#monitors.delete(id);
      }
    }

    for (const [id, node] of wanted) {
      if (this.#monitors.has(id)) continue;
      const monitor = new NodeMonitor(node);
      this.#monitors.set(id, monitor);
      monitor.start();
    }
  }

  /* Called after editing a node so the next poll uses the new credentials. */
  refresh(nodeId) {
    this.#monitors.get(nodeId)?.invalidateRunner();
  }

  /* Called after a write action so its effect appears without a full poll wait. */
  refreshSoon(nodeId) {
    this.#monitors.get(nodeId)?.pollSoon();
  }

  /* Called after a HuggingFace write so the cache listing is re-read promptly. */
  refreshHf(nodeId) {
    this.#monitors.get(nodeId)?.markHfStale();
  }

  hfFor(nodeId) {
    return this.#monitors.get(nodeId)?.hf ?? null;
  }

  /* The latest snapshot for one node, which is what the run routes plan
   * against: refusing a recipe needs the same figures the UI was shown. */
  snapshotFor(nodeId) {
    return this.#monitors.get(nodeId)?.snapshot ?? null;
  }

  snapshot() {
    const nodes = registry.list().filter((n) => n.enabled);
    return {
      at: Date.now(),
      demoMode: config.demoMode,
      pollIntervalMs: config.pollIntervalMs,
      nodes: nodes.map((node) => {
        const monitor = this.#monitors.get(node.id);
        return monitor ? { ...monitor.snapshot, name: node.name, type: node.type } : null;
      }).filter(Boolean),
    };
  }

  historyFor(nodeId) {
    return this.#monitors.get(nodeId)?.history.toJSON() ?? null;
  }

  allHistory() {
    const out = {};
    for (const [id, monitor] of this.#monitors) out[id] = monitor.history.toJSON();
    return out;
  }
}

export const monitor = new Monitor();
