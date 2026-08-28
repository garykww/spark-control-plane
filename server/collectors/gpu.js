/*
 * GPU metrics via nvidia-smi. Fields that a given driver or board does not
 * expose come back as "[N/A]" rather than being omitted, so every value is
 * parsed through nullableNum() and rendered as "unavailable" instead of zero.
 *
 * On GB10 the GPU shares LPDDR5X with the CPU, so memory.total from nvidia-smi
 * describes the unified pool rather than a discrete VRAM carve-out. isUnified
 * marks that so the UI can label the panel correctly.
 *
 * Fields are read by name rather than by position, so adding one to GPU_FIELDS
 * does not shift everything after it.
 */

const GPU_FIELDS = [
  'index',
  'name',
  'driver_version',
  'utilization.gpu',
  'utilization.memory',
  'memory.total',
  'memory.used',
  'temperature.gpu',
  'temperature.gpu.tlimit',
  'power.draw',
  'power.limit',
  'clocks.sm',
  'clocks.max.sm',
  'clocks.mem',
  'pstate',
  'fan.speed',
  'clocks_throttle_reasons.active',
  'utilization.encoder',
  'utilization.decoder',
  'utilization.jpeg',
  'utilization.ofa',
];

export const GPU_COMMANDS = {
  gpu: `nvidia-smi --query-gpu=${GPU_FIELDS.join(',')} --format=csv,noheader,nounits`,
  gpuProcesses:
    'nvidia-smi --query-compute-apps=pid,process_name,used_gpu_memory --format=csv,noheader,nounits',
};

/*
 * NVML clock-event ("throttle") reasons. The driver reports them as a bitmask;
 * these are the documented bit positions, confirmed against a GB10 by reading
 * the mask and the per-reason booleans in the same nvidia-smi call.
 *
 * Severity separates "this is how the GPU normally behaves" from "something is
 * actively holding your kernels back":
 *   info    - expected states, including plain idleness
 *   warning - a configured or negotiated ceiling
 *   serious - hardware is cutting clocks to protect itself
 */
export const THROTTLE_REASONS = [
  { bit: 0x001, key: 'idle', label: 'Idle', severity: 'info' },
  { bit: 0x002, key: 'applicationClocks', label: 'App clock limit', severity: 'warning' },
  { bit: 0x004, key: 'swPowerCap', label: 'Power cap', severity: 'warning' },
  { bit: 0x008, key: 'hwSlowdown', label: 'HW slowdown', severity: 'serious' },
  { bit: 0x010, key: 'syncBoost', label: 'Sync boost', severity: 'info' },
  { bit: 0x020, key: 'swThermal', label: 'Thermal throttle (SW)', severity: 'serious' },
  { bit: 0x040, key: 'hwThermal', label: 'Thermal throttle (HW)', severity: 'serious' },
  { bit: 0x080, key: 'powerBrake', label: 'Power brake', severity: 'serious' },
  { bit: 0x100, key: 'displayClock', label: 'Display clock limit', severity: 'info' },
];

const NOT_AVAILABLE = /^\[?n\/?a\]?$|^\[not supported\]$|^$/i;

function nullableNum(value) {
  const text = String(value ?? '').trim();
  if (NOT_AVAILABLE.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function nullableText(value) {
  const text = String(value ?? '').trim();
  return NOT_AVAILABLE.test(text) ? null : text;
}

export function parseThrottleReasons(value) {
  const text = String(value ?? '').trim();
  if (NOT_AVAILABLE.test(text)) return null;

  const mask = Number.parseInt(text, 16);
  if (!Number.isFinite(mask)) return null;

  return THROTTLE_REASONS.filter((reason) => (mask & reason.bit) !== 0).map(
    ({ key, label, severity }) => ({ key, label, severity }),
  );
}

const MIB = 1024 * 1024;

export function parseGpus(text, { isUnified = false } = {}) {
  const gpus = [];

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const cells = line.split(',').map((c) => c.trim());
    if (cells.length < GPU_FIELDS.length) continue;

    /* Field name -> cell, so the readers below do not depend on column order. */
    const field = Object.fromEntries(GPU_FIELDS.map((name, i) => [name, cells[i]]));
    const num = (name) => nullableNum(field[name]);

    const totalBytes = num('memory.total') === null ? null : num('memory.total') * MIB;
    const usedBytes = num('memory.used') === null ? null : num('memory.used') * MIB;

    const clockSm = num('clocks.sm');
    const clockSmMax = num('clocks.max.sm');

    /*
     * Fixed-function engines sit alongside the SMs. They are reported even on a
     * compute-only board, where they sit at zero; the UI hides them in that case.
     */
    const engines = {
      encoder: num('utilization.encoder'),
      decoder: num('utilization.decoder'),
      jpeg: num('utilization.jpeg'),
      ofa: num('utilization.ofa'),
    };

    gpus.push({
      index: num('index') ?? gpus.length,
      name: nullableText(field.name) ?? 'NVIDIA GPU',
      driver: nullableText(field.driver_version),
      utilization: num('utilization.gpu'),
      memoryUtilization: num('utilization.memory'),
      memoryTotal: totalBytes,
      memoryUsed: usedBytes,
      memoryPercent: totalBytes && usedBytes !== null ? (usedBytes / totalBytes) * 100 : null,
      temperature: num('temperature.gpu'),
      /* Degrees of headroom left before the driver starts cutting clocks. */
      temperatureHeadroom: num('temperature.gpu.tlimit'),
      powerDraw: num('power.draw'),
      powerLimit: num('power.limit'),
      clockSm,
      clockSmMax,
      /* How much of the SM clock ceiling is actually in use right now. */
      clockSmPercent: clockSm !== null && clockSmMax ? (clockSm / clockSmMax) * 100 : null,
      clockMemory: num('clocks.mem'),
      pstate: nullableText(field.pstate),
      fanSpeed: num('fan.speed'),
      throttleReasons: parseThrottleReasons(field['clocks_throttle_reasons.active']),
      engines,
      enginesActive: Object.values(engines).some((v) => (v ?? 0) > 0),
      isUnified,
    });
  }

  return gpus;
}

export function parseGpuProcesses(text) {
  const processes = [];

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const cells = line.split(',').map((c) => c.trim());
    if (cells.length < 3) continue;

    const pid = nullableNum(cells[0]);
    if (pid === null) continue;

    const memoryMib = nullableNum(cells[2]);
    processes.push({
      pid,
      /* nvidia-smi reports the full path; the basename is what a user scans for. */
      name: (cells[1] || 'unknown').split('/').pop(),
      command: cells[1] || 'unknown',
      memory: memoryMib === null ? null : memoryMib * MIB,
    });
  }

  return processes.sort((a, b) => (b.memory ?? 0) - (a.memory ?? 0)).slice(0, 12);
}
