import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { registry } from './registry.js';
import { createRunner, runBatch } from './exec/index.js';
import { SYSTEM_COMMANDS, parseSystem } from './collectors/system.js';
import { GPU_COMMANDS, parseGpus, parseGpuProcesses } from './collectors/gpu.js';
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
      storage: [],
      network: [],
      thermal: [],
      llm: [],
    };
  }

  start() {
    this.#scheduleNext(0);
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
    return {
      nodeId: node.id,
      name: node.name,
      type: node.type,
      spec: specForNode(node),
      ...demoSnapshot(node, Math.max(0, index)),
    };
  }

  async #collect(node) {
    this.runner ??= createRunner(node);

    const [sections, llmProbes] = await Promise.all([
      runBatch(this.runner, { ...SYSTEM_COMMANDS, ...GPU_COMMANDS }),
      probeLlmEndpoints(
        (node.llmPorts ?? []).map((p) => ({ host: node.host, port: p.port, label: p.label })),
      ),
    ]);

    const system = parseSystem(sections);
    const isUnified = node.type === 'dgx-spark';
    const gpus = parseGpus(sections.gpu || '', { isUnified });

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
      gpuProcesses: parseGpuProcesses(sections.gpuProcesses || ''),
      thermal: system.thermal,
      storage: system.storage,
      network: this.#deriveNetwork(system, elapsedSeconds),
      llm: this.#deriveLlm(llmProbes, elapsedSeconds),
    };

    /* Baseline for the next poll's rate calculations. */
    this.previous = {
      at: now,
      cpu: system.cpuRaw,
      interfaces: system.interfacesRaw,
      llm: llmProbes.map((p) => ({ id: p.id, counters: p.counters })),
    };

    return snapshot;
  }

  /* CPU time is cumulative, so utilisation is the busy delta over the total delta. */
  #deriveCpu(system, elapsedSeconds) {
    const prev = this.previous?.cpu;
    const current = system.cpuRaw.aggregate;

    const percentOf = (now, before) => {
      if (!before) return 0;
      const totalDelta = now.total - before.total;
      if (totalDelta <= 0) return 0;
      return Math.min(100, Math.max(0, ((now.busy - before.busy) / totalDelta) * 100));
    };

    return {
      model: system.cpu.model,
      cores: system.cpu.cores || system.cpuRaw.cores.length,
      percent: percentOf(current, prev?.aggregate),
      cores_percent: system.cpuRaw.cores.map((core, i) => percentOf(core, prev?.cores?.[i])),
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
