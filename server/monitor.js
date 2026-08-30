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

class NodeMonitor {
  constructor(node) {
    this.nodeId = node.id;
    this.history = new NodeHistory();
    this.snapshot = this.#offlineSnapshot(node, 'waiting for first poll');
    this.consecutiveFailures = 0;
    this.previous = null;
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
  #deriveLlm(probes, elapsedSeconds) {
    const prev = new Map((this.previous?.llm ?? []).map((p) => [p.id, p]));

    return probes.map((probe) => {
      const counters = probe.counters;
      const before = prev.get(probe.id)?.counters;

      const decodeRate = counters?.reportedDecodeRate
        ?? rate(counters?.generatedTokens, before?.generatedTokens, elapsedSeconds)
        ?? 0;
      const prefillRate = counters?.reportedPrefillRate
        ?? rate(counters?.promptTokens, before?.promptTokens, elapsedSeconds)
        ?? 0;

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
