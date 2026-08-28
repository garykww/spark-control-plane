import { config } from './config.js';

/*
 * Fixed-capacity ring buffers backing the sparklines. History lives on the
 * server rather than in the browser so a page reload, a second viewer, or a
 * laptop waking from sleep all get the same continuous trace.
 */

/* One series per metric the UI draws over time. */
export const SERIES = [
  'gpuUtilization',
  'gpuMemoryPercent',
  'gpuTemperature',
  'gpuPower',
  'cpuPercent',
  'memoryPercent',
  'networkRx',
  'networkTx',
  'llmDecodeRate',
];

class Ring {
  #values;
  #next = 0;
  #size = 0;

  constructor(capacity) {
    this.#values = new Float64Array(capacity);
  }

  push(value) {
    this.#values[this.#next] = Number.isFinite(value) ? value : 0;
    this.#next = (this.#next + 1) % this.#values.length;
    this.#size = Math.min(this.#size + 1, this.#values.length);
  }

  /* Oldest to newest, which is the order a chart wants to draw. */
  toArray() {
    const out = new Array(this.#size);
    const start = (this.#next - this.#size + this.#values.length) % this.#values.length;
    for (let i = 0; i < this.#size; i += 1) {
      out[i] = this.#values[(start + i) % this.#values.length];
    }
    return out;
  }

  get size() {
    return this.#size;
  }
}

export class NodeHistory {
  #series = new Map();
  #timestamps;

  constructor(capacity = config.historyLength) {
    this.capacity = capacity;
    this.#timestamps = new Ring(capacity);
    for (const name of SERIES) this.#series.set(name, new Ring(capacity));
  }

  record(snapshot) {
    const gpu = snapshot.gpus?.[0] ?? {};
    const network = snapshot.network ?? [];
    const llm = snapshot.llm ?? [];

    const sum = (items, key) => items.reduce((acc, item) => acc + (item[key] ?? 0), 0);

    this.#timestamps.push(snapshot.collectedAt ?? Date.now());
    this.#series.get('gpuUtilization').push(gpu.utilization ?? 0);
    this.#series.get('gpuMemoryPercent').push(gpu.memoryPercent ?? 0);
    this.#series.get('gpuTemperature').push(gpu.temperature ?? 0);
    this.#series.get('gpuPower').push(gpu.powerDraw ?? 0);
    this.#series.get('cpuPercent').push(snapshot.cpu?.percent ?? 0);
    this.#series.get('memoryPercent').push(snapshot.memory?.percent ?? 0);
    this.#series.get('networkRx').push(sum(network, 'rxRate'));
    this.#series.get('networkTx').push(sum(network, 'txRate'));
    this.#series.get('llmDecodeRate').push(sum(llm, 'decodeRate'));
  }

  toJSON() {
    const out = { timestamps: this.#timestamps.toArray() };
    for (const [name, ring] of this.#series) out[name] = ring.toArray();
    return out;
  }
}
