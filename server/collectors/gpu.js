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
  /* Per-process SM share. nvidia-smi has no per-SM view, but it does report
   * which processes are occupying SM time, which is what the grid divides up. */
  gpuPmon: 'nvidia-smi pmon -c 1',
};

/*
 * SM count is fixed hardware, so it is probed once per connection rather than
 * every poll. NVML does not expose it; the CUDA driver API does, via
 * CU_DEVICE_ATTRIBUTE_MULTIPROCESSOR_COUNT (16).
 */
export const SM_COUNT_COMMAND =
  'python3 -c \'import ctypes;l=ctypes.CDLL("libcuda.so.1");l.cuInit(0);d=ctypes.c_int();l.cuDeviceGet(ctypes.byref(d),0);v=ctypes.c_int();l.cuDeviceGetAttribute(ctypes.byref(v),16,d);print(v.value)\'';

export function parseSmCount(text) {
  const value = Number.parseInt(String(text ?? '').trim(), 10);
  /* Guard against a probe that printed a traceback or an implausible number. */
  return Number.isInteger(value) && value > 0 && value <= 1024 ? value : null;
}

/*
 * `nvidia-smi pmon -c 1` prints a fixed-width table with two leading comment
 * rows. Columns: gpu, pid, type, sm, mem, enc, dec, jpg, ofa, command.
 * Unsupported cells are "-" and must stay null rather than becoming 0.
 */
export function parsePmon(text) {
  const processes = [];

  for (const line of String(text ?? '').split('\n')) {
    const row = line.trim();
    if (!row || row.startsWith('#')) continue;

    const cells = row.split(/\s+/);
    if (cells.length < 4) continue;

    const pid = Number.parseInt(cells[1], 10);
    if (!Number.isInteger(pid)) continue;

    const cell = (v) => {
      const n = Number(v);
      return v === '-' || !Number.isFinite(n) ? null : n;
    };

    processes.push({
      pid,
      /* C = compute, G = graphics; only compute work occupies SMs meaningfully. */
      type: cells[2] === 'C' ? 'compute' : cells[2] === 'G' ? 'graphics' : cells[2],
      sm: cell(cells[3]),
      memory: cell(cells[4]),
      name: cells[cells.length - 1],
    });
  }

  return processes;
}

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
