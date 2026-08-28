import { DGX_SPARK_SPEC } from './specs.js';

/*
 * Synthetic metrics for DEMO_MODE=1, so the dashboard can be developed and
 * reviewed on a laptop with no Spark attached. Values wander with smooth noise
 * rather than jumping randomly, which makes the sparklines behave like the real
 * thing instead of looking like static.
 */

const started = Date.now();

/* Sum of a few incommensurable sine waves - smooth, never exactly repeating. */
function wander(seed, periodSec, t) {
  const a = Math.sin((t / periodSec + seed) * Math.PI * 2);
  const b = Math.sin((t / (periodSec * 0.37) + seed * 2.3) * Math.PI * 2) * 0.4;
  const c = Math.sin((t / (periodSec * 3.1) + seed * 5.1) * Math.PI * 2) * 0.3;
  return (a + b + c) / 1.7;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const scaled = (seed, period, t, mid, spread, lo, hi) =>
  clamp(mid + wander(seed, period, t) * spread, lo, hi);

export function demoSnapshot(node, index = 0) {
  const t = (Date.now() - started) / 1000;
  const seed = index * 1.7 + 0.3;

  const gpuUtil = scaled(seed, 47, t, 55, 42, 0, 100);
  /* Memory tracks utilisation loosely - a busy GPU is usually a loaded one. */
  const memPercent = scaled(seed + 0.5, 130, t, 62, 18, 8, 94);
  const cpuPercent = clamp(gpuUtil * 0.25 + scaled(seed + 1.1, 23, t, 14, 12, 0, 100), 1, 100);

  const totalMemory = DGX_SPARK_SPEC.memoryBytes;
  const usedMemory = totalMemory * (memPercent / 100);
  const temperature = 38 + (gpuUtil / 100) * 32 + wander(seed + 2, 90, t) * 2.5;
  const power = 28 + (gpuUtil / 100) * 185 + wander(seed + 3, 17, t) * 8;

  const decodeRate = gpuUtil > 12 ? scaled(seed + 4, 31, t, 48, 26, 0, 140) : 0;

  return {
    online: true,
    error: null,
    collectedAt: Date.now(),
    host: {
      hostname: node.name.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      kernel: '6.11.0-1010-nvidia',
      arch: 'aarch64',
      model: node.type === 'dgx-spark' ? 'NVIDIA DGX Spark' : 'Generic GPU Host',
    },
    uptimeSeconds: 60 * 60 * 41 + index * 3600 + t,
    load: {
      load1: Number((cpuPercent / 100 * 20 * 0.8).toFixed(2)),
      load5: Number((cpuPercent / 100 * 20 * 0.7).toFixed(2)),
      load15: Number((cpuPercent / 100 * 20 * 0.6).toFixed(2)),
    },
    cpu: {
      model: DGX_SPARK_SPEC.cpu,
      cores: 20,
      percent: cpuPercent,
      cores_percent: Array.from({ length: 20 }, (_, i) =>
        clamp(cpuPercent + wander(seed + i * 0.13, 11 + i, t) * 30, 0, 100),
      ),
      runnable: Math.round(clamp(cpuPercent / 12, 0, 24)),
    },
    memory: {
      total: totalMemory,
      used: usedMemory,
      available: totalMemory - usedMemory,
      free: (totalMemory - usedMemory) * 0.7,
      cached: totalMemory * 0.09,
      buffers: totalMemory * 0.01,
      shared: totalMemory * 0.004,
      swapTotal: 0,
      swapUsed: 0,
      percent: memPercent,
    },
    gpus: [
      {
        index: 0,
        name: node.type === 'dgx-spark' ? 'NVIDIA GB10' : 'NVIDIA RTX 6000 Ada',
        driver: '580.95.05',
        utilization: gpuUtil,
        memoryUtilization: memPercent * 0.85,
        memoryTotal: totalMemory,
        memoryUsed: usedMemory,
        memoryPercent: memPercent,
        temperature,
        powerDraw: power,
        powerLimit: DGX_SPARK_SPEC.powerWatts,
        temperatureHeadroom: Math.max(0, Math.round(88 - temperature)),
        clockSm: Math.round(scaled(seed + 5, 19, t, 1250, 400, 300, 3003)),
        clockSmMax: 3003,
        clockSmPercent: clamp((scaled(seed + 5, 19, t, 1250, 400, 300, 3003) / 3003) * 100, 0, 100),
        clockMemory: 3200,
        pstate: gpuUtil > 40 ? 'P0' : 'P8',
        fanSpeed: null,
        throttleReasons:
          gpuUtil < 12
            ? [{ key: 'idle', label: 'Idle', severity: 'info' }]
            : temperature > 66
              ? [{ key: 'swPowerCap', label: 'Power cap', severity: 'warning' }]
              : [],
        engines: { encoder: 0, decoder: 0, jpeg: 0, ofa: 0 },
        enginesActive: false,
        smCount: 48,
        isUnified: node.type === 'dgx-spark',
      },
    ],
    gpuProcesses: gpuUtil > 12
      ? [
          { pid: 3241, name: 'vllm', command: '/usr/bin/python3 -m vllm.entrypoints.openai.api_server', memory: usedMemory * 0.78, sm: Math.round(gpuUtil * 0.82) },
          { pid: 1877, name: 'ollama', command: '/usr/local/bin/ollama serve', memory: usedMemory * 0.14, sm: Math.round(gpuUtil * 0.18) },
        ]
      : [],
    thermal: [
      { label: 'cpu-thermal', celsius: temperature - 6 },
      { label: 'gpu-thermal', celsius: temperature },
      { label: 'soc-thermal', celsius: temperature - 9 },
    ],
    storage: [
      { device: '/dev/nvme0n1p2', mount: '/', total: 3.84e12, used: 1.42e12, available: 2.42e12, percent: 37 },
      { device: '/dev/nvme1n1', mount: '/mnt/models', total: 3.84e12, used: 2.9e12, available: 0.94e12, percent: 75.5 },
    ],
    network: [
      {
        name: 'enP2p1s0',
        rxBytes: 0,
        txBytes: 0,
        rxRate: Math.max(0, scaled(seed + 6, 13, t, 4.2e7, 4e7, 0, 2.4e10)),
        txRate: Math.max(0, scaled(seed + 7, 29, t, 1.1e7, 1.1e7, 0, 2.4e10)),
      },
    ],
    containers: [
      {
        id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
        name: 'vllm-llama70b',
        image: 'vllm/vllm-openai:latest',
        state: gpuUtil > 12 ? 'running' : 'exited',
        status: gpuUtil > 12 ? 'Up 4 hours' : 'Exited (0) 6 minutes ago',
        ports: ['8000->8000/tcp'],
        createdAt: '2026-08-27 09:14:22 +0000 UTC',
      },
      {
        id: 'b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1',
        name: 'open-webui',
        image: 'ghcr.io/open-webui/open-webui:main',
        state: 'running',
        status: 'Up 2 days',
        ports: ['3000->8080/tcp'],
        createdAt: '2026-08-25 18:02:10 +0000 UTC',
      },
      {
        id: 'c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2',
        name: 'jupyter',
        image: 'nvcr.io/nvidia/pytorch:25.06-py3',
        state: 'exited',
        status: 'Exited (137) 3 hours ago',
        ports: [],
        createdAt: '2026-08-24 11:41:55 +0000 UTC',
      },
    ],
    dockerAvailable: true,
    dockerError: null,
    llm: [
      {
        id: 'demo:8000',
        label: 'vLLM',
        port: 8000,
        online: true,
        backend: 'vLLM',
        models: ['meta-llama/Llama-3.3-70B-Instruct'],
        error: null,
        latencyMs: Math.round(scaled(seed + 8, 7, t, 6, 4, 1, 40)),
        decodeRate,
        prefillRate: decodeRate > 0 ? decodeRate * scaled(seed + 9, 11, t, 9, 5, 1, 30) : 0,
        running: decodeRate > 0 ? Math.round(clamp(decodeRate / 22, 1, 12)) : 0,
        queued: decodeRate > 90 ? Math.round(scaled(seed + 10, 9, t, 2, 3, 0, 9)) : 0,
        kvCacheUsage: decodeRate > 0 ? clamp(decodeRate / 190, 0, 0.95) : 0,
      },
    ],
  };
}
