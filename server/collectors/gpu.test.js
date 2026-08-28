import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGpus, parseGpuProcesses } from './gpu.js';

const MIB = 1024 * 1024;

test('parseGpus reads a full nvidia-smi row', () => {
  const [gpu] = parseGpus(
    '0, NVIDIA GB10, 580.95.05, 62, 40, 122880, 81920, 57, 118.42, 240.00, 1530, 3200, P0, [N/A]',
    { isUnified: true },
  );

  assert.equal(gpu.name, 'NVIDIA GB10');
  assert.equal(gpu.driver, '580.95.05');
  assert.equal(gpu.utilization, 62);
  assert.equal(gpu.memoryTotal, 122880 * MIB);
  assert.equal(gpu.memoryUsed, 81920 * MIB);
  assert.equal(Math.round(gpu.memoryPercent), 67);
  assert.equal(gpu.powerDraw, 118.42);
  assert.equal(gpu.pstate, 'P0');
  assert.equal(gpu.isUnified, true);
  /* fan.speed came back [N/A] - that must stay null rather than becoming 0. */
  assert.equal(gpu.fanSpeed, null);
});

test('parseGpus keeps unsupported fields null instead of zero', () => {
  const [gpu] = parseGpus(
    '0, NVIDIA GB10, 580.95.05, [N/A], [N/A], 122880, 4096, 45, [Not Supported], [N/A], [N/A], [N/A], [N/A], [N/A]',
  );

  assert.equal(gpu.utilization, null);
  assert.equal(gpu.powerDraw, null);
  assert.equal(gpu.clockSm, null);
  assert.equal(gpu.temperature, 45);
  assert.equal(gpu.isUnified, false);
});

test('parseGpus handles several GPUs and ignores blank lines', () => {
  const gpus = parseGpus(
    [
      '0, NVIDIA RTX 6000, 570.1, 10, 5, 49140, 1024, 40, 50, 300, 1000, 2000, P2, 30',
      '',
      '1, NVIDIA RTX 6000, 570.1, 90, 80, 49140, 40960, 71, 280, 300, 1900, 2000, P0, 70',
    ].join('\n'),
  );

  assert.equal(gpus.length, 2);
  assert.equal(gpus[1].index, 1);
  assert.equal(gpus[1].utilization, 90);
});

test('parseGpuProcesses sorts by memory and shortens the process path', () => {
  const processes = parseGpuProcesses(
    ['3241, /usr/bin/python3, 4096', '1877, /usr/local/bin/ollama, 65536', 'bad line'].join('\n'),
  );

  assert.equal(processes.length, 2);
  assert.equal(processes[0].name, 'ollama');
  assert.equal(processes[0].memory, 65536 * MIB);
  assert.equal(processes[0].command, '/usr/local/bin/ollama');
  assert.equal(processes[1].name, 'python3');
});
