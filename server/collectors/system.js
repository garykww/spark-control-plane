/*
 * Reads CPU, memory, storage, network, thermal and host identity straight out of
 * /proc and /sys. Every value is a raw counter or absolute reading; rates that
 * need two points in time (CPU %, network bytes/s) are derived in monitor.js by
 * diffing consecutive samples.
 */

export const SYSTEM_COMMANDS = {
  uptime: 'cat /proc/uptime',
  loadavg: 'cat /proc/loadavg',
  stat: 'grep -E "^(cpu|ctxt|procs_running)" /proc/stat',
  meminfo: 'cat /proc/meminfo',
  netdev: 'cat /proc/net/dev',
  disk: 'df -B1 -P -x tmpfs -x devtmpfs -x overlay -x squashfs 2>/dev/null | tail -n +2',
  thermal: 'for z in /sys/class/thermal/thermal_zone*; do [ -r "$z/temp" ] && echo "$(cat $z/type 2>/dev/null):$(cat $z/temp)"; done',
  host: 'hostname; uname -r; uname -m; cat /sys/devices/virtual/dmi/id/product_name 2>/dev/null || tr -d "\\000" < /proc/device-tree/model 2>/dev/null || echo unknown',
  /*
   * Arm SoCs (the GB10 included) have no "model name" in /proc/cpuinfo - only a
   * numeric CPU part id - so lscpu, which decodes those ids, is asked first.
   * A heterogeneous SoC reports one Model name per cluster.
   */
  cpuinfo: 'lscpu 2>/dev/null | grep -i "^model name"; grep -m1 -E "^(model name|Model)[[:space:]]*:" /proc/cpuinfo; nproc',
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/* /proc/uptime -> [seconds up, seconds idle across all cores] */
export function parseUptime(text) {
  return num(text.trim().split(/\s+/)[0]);
}

export function parseLoadavg(text) {
  const parts = text.trim().split(/\s+/);
  return { load1: num(parts[0]), load5: num(parts[1]), load15: num(parts[2]) };
}

/*
 * cpu  user nice system idle iowait irq softirq steal guest guest_nice
 * Busy time is everything except idle and iowait; the caller turns the pair of
 * (busy, total) counters into a percentage across the poll interval.
 */
export function parseStat(text) {
  const cores = [];
  let aggregate = null;
  let contextSwitches = 0;
  let runnable = 0;

  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'ctxt') { contextSwitches = num(parts[1]); continue; }
    if (parts[0] === 'procs_running') { runnable = num(parts[1]); continue; }
    if (!/^cpu\d*$/.test(parts[0] ?? '')) continue;

    const values = parts.slice(1).map(num);
    const idle = (values[3] ?? 0) + (values[4] ?? 0);
    const total = values.reduce((a, b) => a + b, 0);
    const entry = { busy: total - idle, total };

    if (parts[0] === 'cpu') aggregate = entry;
    else cores.push(entry);
  }

  return { aggregate: aggregate ?? { busy: 0, total: 0 }, cores, contextSwitches, runnable };
}

/* /proc/meminfo is in kB; everything downstream works in bytes. */
export function parseMeminfo(text) {
  const fields = {};
  for (const line of text.split('\n')) {
    const [key, value] = line.split(':');
    if (!key || value === undefined) continue;
    fields[key.trim()] = num(value.trim().split(/\s+/)[0]) * 1024;
  }

  const total = fields.MemTotal ?? 0;
  const available = fields.MemAvailable ?? fields.MemFree ?? 0;
  const swapTotal = fields.SwapTotal ?? 0;

  return {
    total,
    available,
    used: Math.max(0, total - available),
    free: fields.MemFree ?? 0,
    cached: (fields.Cached ?? 0) + (fields.SReclaimable ?? 0),
    buffers: fields.Buffers ?? 0,
    shared: fields.Shmem ?? 0,
    swapTotal,
    swapUsed: Math.max(0, swapTotal - (fields.SwapFree ?? 0)),
  };
}

const SKIP_INTERFACE = /^(lo|docker|br-|veth|virbr|cni|flannel)/;

export function parseNetdev(text) {
  const interfaces = [];
  for (const line of text.split('\n').slice(2)) {
    const [rawName, rest] = line.split(':');
    if (!rawName || !rest) continue;
    const name = rawName.trim();
    const values = rest.trim().split(/\s+/).map(num);
    if (SKIP_INTERFACE.test(name)) continue;
    /* Interfaces that have never carried a byte are almost always unplugged. */
    if (values[0] === 0 && values[8] === 0) continue;
    interfaces.push({ name, rxBytes: values[0], rxPackets: values[1], txBytes: values[8], txPackets: values[9] });
  }
  return interfaces;
}

export function parseDisk(text) {
  const mounts = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const device = parts[0];
    const total = num(parts[1]);
    const used = num(parts[2]);
    const available = num(parts[3]);
    const mount = parts.slice(5).join(' ');
    if (total === 0) continue;
    if (mount.startsWith('/snap') || mount.startsWith('/boot/efi')) continue;
    mounts.push({ device, mount, total, used, available, percent: total ? (used / total) * 100 : 0 });
  }
  return mounts.sort((a, b) => b.total - a.total).slice(0, 8);
}

/*
 * Thermal zone names vary a lot across platforms. The zones that matter on a
 * GB10 are the CPU, GPU and SoC ones; anything else is kept but ranked lower.
 */
const ZONE_PRIORITY = [/cpu/i, /gpu/i, /soc/i, /tj/i];

export function parseThermal(text) {
  const zones = [];
  for (const line of text.split('\n')) {
    const idx = line.lastIndexOf(':');
    if (idx === -1) continue;
    const label = line.slice(0, idx).trim();
    const raw = num(line.slice(idx + 1));
    if (!label || raw <= 0) continue;
    /* Kernel reports millidegrees; a few drivers report whole degrees. */
    const celsius = raw > 1000 ? raw / 1000 : raw;
    if (celsius < 1 || celsius > 150) continue;
    zones.push({ label, celsius });
  }

  const rank = (zone) => {
    const i = ZONE_PRIORITY.findIndex((re) => re.test(zone.label));
    return i === -1 ? ZONE_PRIORITY.length : i;
  };
  return zones.sort((a, b) => rank(a) - rank(b)).slice(0, 8);
}

export function parseHost(text) {
  const lines = text.split('\n').map((l) => l.replace(/\u0000/g, '').trim());
  const [hostname = '', kernel = '', arch = ''] = lines;
  return {
    hostname,
    kernel,
    arch,
    model: lines.slice(3).filter(Boolean).join(' ').trim() || 'unknown',
  };
}

export function parseCpuinfo(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  /* Every "<label>: <value>" line is a model candidate; the trailing bare
   * number is nproc. Distinct values are joined so a big.LITTLE SoC reads
   * "Cortex-X925 + Cortex-A725" rather than just its first cluster. */
  const models = [];
  for (const line of lines) {
    if (!line.includes(':')) continue;
    const value = line.split(':').slice(1).join(':').trim();
    if (value && !models.includes(value)) models.push(value);
  }

  return {
    model: models.join(' + ') || 'unknown',
    cores: num(lines[lines.length - 1]) || 0,
  };
}

export function parseSystem(sections) {
  return {
    uptimeSeconds: parseUptime(sections.uptime || ''),
    load: parseLoadavg(sections.loadavg || ''),
    cpuRaw: parseStat(sections.stat || ''),
    memory: parseMeminfo(sections.meminfo || ''),
    interfacesRaw: parseNetdev(sections.netdev || ''),
    storage: parseDisk(sections.disk || ''),
    thermal: parseThermal(sections.thermal || ''),
    host: parseHost(sections.host || ''),
    cpu: parseCpuinfo(sections.cpuinfo || ''),
  };
}
