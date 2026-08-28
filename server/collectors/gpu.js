/*
 * GPU metrics via nvidia-smi. Fields that a given driver or board does not
 * expose come back as "[N/A]" rather than being omitted, so every value is
 * parsed through nullableNum() and rendered as "unavailable" instead of zero.
 *
 * On GB10 the GPU shares LPDDR5X with the CPU, so memory.total from nvidia-smi
 * describes the unified pool rather than a discrete VRAM carve-out. isUnified
 * marks that so the UI can label the panel correctly.
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
  'power.draw',
  'power.limit',
  'clocks.sm',
  'clocks.mem',
  'pstate',
  'fan.speed',
];

export const GPU_COMMANDS = {
  gpu: `nvidia-smi --query-gpu=${GPU_FIELDS.join(',')} --format=csv,noheader,nounits`,
  gpuProcesses:
    'nvidia-smi --query-compute-apps=pid,process_name,used_gpu_memory --format=csv,noheader,nounits',
};

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

const MIB = 1024 * 1024;

export function parseGpus(text, { isUnified = false } = {}) {
  const gpus = [];

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const cells = line.split(',').map((c) => c.trim());
    if (cells.length < GPU_FIELDS.length) continue;

    const [
      index, name, driver, utilGpu, utilMem,
      memTotal, memUsed, temp, powerDraw, powerLimit,
      clockSm, clockMem, pstate, fan,
    ] = cells;

    const totalBytes = nullableNum(memTotal) === null ? null : nullableNum(memTotal) * MIB;
    const usedBytes = nullableNum(memUsed) === null ? null : nullableNum(memUsed) * MIB;

    gpus.push({
      index: nullableNum(index) ?? gpus.length,
      name: nullableText(name) ?? 'NVIDIA GPU',
      driver: nullableText(driver),
      utilization: nullableNum(utilGpu),
      memoryUtilization: nullableNum(utilMem),
      memoryTotal: totalBytes,
      memoryUsed: usedBytes,
      memoryPercent: totalBytes && usedBytes !== null ? (usedBytes / totalBytes) * 100 : null,
      temperature: nullableNum(temp),
      powerDraw: nullableNum(powerDraw),
      powerLimit: nullableNum(powerLimit),
      clockSm: nullableNum(clockSm),
      clockMemory: nullableNum(clockMem),
      pstate: nullableText(pstate),
      fanSpeed: nullableNum(fan),
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
