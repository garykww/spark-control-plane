import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGpus, parseGpuProcesses, parseThrottleReasons, parsePmon, parseSmCount } from './gpu.js';

const MIB = 1024 * 1024;

/*
 * Column order is an implementation detail of GPU_FIELDS, so rows are built
 * from a named map: adding a field to the collector does not rewrite these.
 */
const FIELD_ORDER = [
  'index', 'name', 'driver_version', 'utilization.gpu', 'utilization.memory',
  'memory.total', 'memory.used', 'temperature.gpu', 'temperature.gpu.tlimit',
  'power.draw', 'power.limit', 'clocks.sm', 'clocks.max.sm', 'clocks.mem',
  'pstate', 'fan.speed', 'clocks_throttle_reasons.active',
  'utilization.encoder', 'utilization.decoder', 'utilization.jpeg', 'utilization.ofa',
];

const BASE = {
  index: 0,
  name: 'NVIDIA GB10',
  driver_version: '580.159.03',
  'utilization.gpu': 62,
  'utilization.memory': 40,
  'memory.total': 122880,
  'memory.used': 81920,
  'temperature.gpu': 57,
  'temperature.gpu.tlimit': 33,
  'power.draw': 118.42,
  'power.limit': 240.0,
  'clocks.sm': 1530,
  'clocks.max.sm': 3003,
  'clocks.mem': 3200,
  pstate: 'P0',
  'fan.speed': '[N/A]',
  'clocks_throttle_reasons.active': '0x0000000000000000',
  'utilization.encoder': 0,
  'utilization.decoder': 0,
  'utilization.jpeg': 0,
  'utilization.ofa': 0,
};

const row = (overrides = {}) =>
  FIELD_ORDER.map((f) => ({ ...BASE, ...overrides })[f]).join(', ');

test('parseGpus reads a full nvidia-smi row', () => {
  const [gpu] = parseGpus(row(), { isUnified: true });

  assert.equal(gpu.name, 'NVIDIA GB10');
  assert.equal(gpu.utilization, 62);
  assert.equal(gpu.memoryTotal, 122880 * MIB);
  assert.equal(Math.round(gpu.memoryPercent), 67);
  assert.equal(gpu.powerDraw, 118.42);
  assert.equal(gpu.pstate, 'P0');
  assert.equal(gpu.isUnified, true);
  /* fan.speed came back [N/A] - that must stay null rather than becoming 0. */
  assert.equal(gpu.fanSpeed, null);
});

test('parseGpus derives SM clock headroom from the reported ceiling', () => {
  const [gpu] = parseGpus(row({ 'clocks.sm': 1530, 'clocks.max.sm': 3003 }));

  assert.equal(gpu.clockSm, 1530);
  assert.equal(gpu.clockSmMax, 3003);
  assert.equal(Math.round(gpu.clockSmPercent), 51);
});

test('parseGpus leaves SM headroom null when the ceiling is unavailable', () => {
  const [gpu] = parseGpus(row({ 'clocks.max.sm': '[N/A]' }));
  assert.equal(gpu.clockSmPercent, null);
});

test('parseGpus keeps thermal headroom and flags idle engines', () => {
  const [gpu] = parseGpus(row());
  assert.equal(gpu.temperatureHeadroom, 33);
  assert.deepEqual(gpu.engines, { encoder: 0, decoder: 0, jpeg: 0, ofa: 0 });
  assert.equal(gpu.enginesActive, false);
});

test('parseGpus reports engines as active when any is working', () => {
  const [gpu] = parseGpus(row({ 'utilization.decoder': 37 }));
  assert.equal(gpu.enginesActive, true);
  assert.equal(gpu.engines.decoder, 37);
});

test('parseGpus keeps unsupported fields null instead of zero', () => {
  const [gpu] = parseGpus(
    row({
      'utilization.gpu': '[N/A]',
      'memory.total': '[N/A]',
      'memory.used': '[N/A]',
      'power.limit': '[N/A]',
      'clocks.mem': '[N/A]',
    }),
  );

  assert.equal(gpu.utilization, null);
  assert.equal(gpu.memoryTotal, null);
  assert.equal(gpu.memoryPercent, null);
  assert.equal(gpu.powerLimit, null);
  assert.equal(gpu.clockMemory, null);
  /* Values that were reported must survive alongside the missing ones. */
  assert.equal(gpu.temperature, 57);
});

test('parseGpus handles several GPUs and ignores blank lines', () => {
  const gpus = parseGpus([row({ index: 0 }), '', row({ index: 1, 'utilization.gpu': 90 })].join('\n'));

  assert.equal(gpus.length, 2);
  assert.equal(gpus[1].index, 1);
  assert.equal(gpus[1].utilization, 90);
});

test('parseThrottleReasons decodes the NVML bitmask', () => {
  assert.deepEqual(parseThrottleReasons('0x0000000000000000'), []);

  /* 0x4 is SwPowerCap - verified against a GB10 reporting the mask and the
   * per-reason booleans in one call. */
  assert.deepEqual(parseThrottleReasons('0x0000000000000004').map((r) => r.key), ['swPowerCap']);

  /* 0x1 idle + 0x40 hardware thermal slowdown */
  assert.deepEqual(
    parseThrottleReasons('0x0000000000000041').map((r) => r.key),
    ['idle', 'hwThermal'],
  );
});

test('parseThrottleReasons separates protective throttling from normal states', () => {
  const [idle] = parseThrottleReasons('0x1');
  const [thermal] = parseThrottleReasons('0x40');

  assert.equal(idle.severity, 'info');
  assert.equal(thermal.severity, 'serious');
});

test('parseThrottleReasons returns null when the driver does not report it', () => {
  assert.equal(parseThrottleReasons('[N/A]'), null);
  assert.equal(parseThrottleReasons(''), null);
  assert.equal(parseThrottleReasons('garbage'), null);
});

test('parseGpuProcesses sorts by memory and shortens the process path', () => {
  const processes = parseGpuProcesses(
    ['3241, /usr/bin/python3, 4096', '1877, /usr/local/bin/ollama, 65536', 'bad line'].join('\n'),
  );

  assert.equal(processes.length, 2);
  assert.equal(processes[0].name, 'ollama');
  assert.equal(processes[0].memory, 65536 * MIB);
  assert.equal(processes[1].name, 'python3');
});

test('parsePmon reads per-process SM share and skips comment rows', () => {
  const rows = parsePmon(
    [
      '# gpu         pid   type     sm    mem    enc    dec    jpg    ofa    command',
      '# Idx           #    C/G      %      %      %      %      %      %    name',
      '    0       2374     G      -      -      -      -      -      -    Xorg',
      '    0    2386039     C     95      0      -      -      -      -    python3',
    ].join('\n'),
  );

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], {
    pid: 2386039,
    type: 'compute',
    sm: 95,
    memory: 0,
    name: 'python3',
  });
  /* A graphics process reporting "-" must stay null, not become 0. */
  assert.equal(rows[0].sm, null);
  assert.equal(rows[0].type, 'graphics');
});

test('parsePmon tolerates an empty or header-only table', () => {
  assert.deepEqual(parsePmon(''), []);
  assert.deepEqual(parsePmon('# gpu pid type sm'), []);
});

test('parseSmCount accepts a plausible count and rejects anything else', () => {
  assert.equal(parseSmCount('48\n'), 48);
  assert.equal(parseSmCount('132'), 132);

  for (const bad of ['', '0', '-4', 'Traceback (most recent call last):', '99999', 'abc']) {
    assert.equal(parseSmCount(bad), null, `expected "${bad}" to be rejected`);
  }
});
