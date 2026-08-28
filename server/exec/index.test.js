import test from 'node:test';
import assert from 'node:assert/strict';
import { runBatch } from './index.js';

/* Stands in for a local or SSH runner: records the script it was handed and
 * replays a canned stdout. */
const fakeRunner = (stdout, extra = {}) => {
  const calls = [];
  return {
    calls,
    describe: () => 'fake',
    run: async (command) => {
      calls.push(command);
      return { code: 0, stdout, stderr: '', ...extra };
    },
  };
};

const MARKER = '@@SPARK-SECTION@@';

test('runBatch issues one command and splits the output back apart', async () => {
  const runner = fakeRunner(
    `\n${MARKER}uptime\n12345.67 900.1\n${MARKER}meminfo\nMemTotal: 100 kB\nMemFree: 40 kB`,
  );

  const sections = await runBatch(runner, {
    uptime: 'cat /proc/uptime',
    meminfo: 'cat /proc/meminfo',
  });

  assert.equal(runner.calls.length, 1, 'both reads must travel in a single round trip');
  assert.equal(sections.uptime, '12345.67 900.1');
  assert.equal(sections.meminfo, 'MemTotal: 100 kB\nMemFree: 40 kB');
});

test('runBatch returns an empty string for a section the host produced nothing for', async () => {
  const runner = fakeRunner(`\n${MARKER}present\nvalue\n${MARKER}missing\n`);

  const sections = await runBatch(runner, { present: 'echo value', missing: 'nvidia-smi' });

  assert.equal(sections.present, 'value');
  assert.equal(sections.missing, '');
});

test('runBatch ignores sections it did not ask for', async () => {
  const runner = fakeRunner(`\n${MARKER}wanted\nok\n${MARKER}unexpected\nnoise`);

  const sections = await runBatch(runner, { wanted: 'echo ok' });

  assert.deepEqual(Object.keys(sections), ['wanted']);
  assert.equal(sections.wanted, 'ok');
});

test('runBatch surfaces a timeout rather than reporting empty metrics', async () => {
  const runner = fakeRunner('', { timedOut: true, code: -1 });
  await assert.rejects(() => runBatch(runner, { uptime: 'cat /proc/uptime' }), /timed out/);
});

test('runBatch fails loudly when the command errors with no output', async () => {
  const runner = fakeRunner('', { code: 255, stderr: 'Permission denied (publickey).' });
  await assert.rejects(() => runBatch(runner, { uptime: 'cat /proc/uptime' }), /Permission denied/);
});

test('runBatch short-circuits when there is nothing to collect', async () => {
  const runner = fakeRunner('');
  assert.deepEqual(await runBatch(runner, {}), {});
  assert.equal(runner.calls.length, 0);
});
