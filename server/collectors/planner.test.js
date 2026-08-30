import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRuns, deriveRunStatus, ACTIVE_RUN_STATUSES, RUN_ID_RE } from './planner.js';

const META = JSON.stringify({
  recipeId: 'qwen38-27b-nvfp4-dflash2',
  recipeName: 'Qwen3.8-27B · NVFP4 + DFlash2',
  modelRepoId: 'RadixArk/Qwen3.8-27B-NVFP4-BF16-LMHead',
  containerName: 'spark-run-qwen38-nvfp4-dflash2',
  port: 8000,
  apiKey: 'sk-abc',
});

const block = (id, fields) =>
  `@@RUN@@${id}\n` +
  Object.entries({ meta: META, ...fields })
    .map(([key, value]) => `${key}=${value}`)
    .join('\n') +
  '\n';

const ID = 'run-1788000000000-abcd1234';
const NOW = 1788000600000;

/*
 * The node is the source of truth, so these parse what a poll actually reads
 * off the run directory. The interesting cases are the ones where the files
 * disagree with each other, which is what a killed process or a reboot leaves
 * behind.
 */

test('a live run reports its phase as its status, with a percentage while downloading', () => {
  const [run] = parseRuns(
    block(ID, {
      pid: '4242',
      phase: 'download',
      started: '1788000000',
      exit: '',
      total: '20000000000',
      cancelled: '0',
      alive: '1',
      done: '5000000000',
      tail: 'Fetching 12 files',
    }),
    NOW,
  );

  assert.equal(run.status, 'downloading');
  assert.equal(run.percent, 25);
  assert.equal(run.recipeName, 'Qwen3.8-27B · NVFP4 + DFlash2');
  assert.equal(run.port, 8000);
  assert.equal(run.message, 'Fetching 12 files');
});

test('phases without a total report no percentage rather than inventing one', () => {
  for (const [phase, status] of [['image', 'pulling'], ['launch', 'launching'], ['wait', 'waiting']]) {
    const [run] = parseRuns(
      block(ID, { pid: '1', phase, started: '1788000000', exit: '', total: '0', cancelled: '0', alive: '1', done: '0' }),
      NOW,
    );
    assert.equal(run.status, status);
    assert.equal(run.percent, null, `${phase} should have no percentage`);
  }
});

/* Exit 0 is written only after the served endpoint answered, so "ready" means
 * the model is serving - not merely that a container started. */
test('exit 0 is ready, and any other code is a failure', () => {
  const done = parseRuns(
    block(ID, { pid: '1', phase: 'ready', started: '1788000000', finished: '1788000500', exit: '0', cancelled: '0', alive: '0' }),
    NOW,
  )[0];
  assert.equal(done.status, 'ready');
  assert.equal(done.finishedAt, 1788000500);

  const failed = parseRuns(
    block(ID, { pid: '1', phase: 'wait', started: '1788000000', exit: '1', cancelled: '0', alive: '0' }),
    NOW,
  )[0];
  assert.equal(failed.status, 'failed');
});

test('exit 75 is the lock marker, reported as blocked rather than failed', () => {
  const [run] = parseRuns(block(ID, { pid: '1', exit: '75', cancelled: '0', alive: '0', started: '1788000000' }), NOW);
  assert.equal(run.status, 'blocked');
});

test('a cancelled run says so even though it also carries an exit code', () => {
  const [run] = parseRuns(
    block(ID, { pid: '1', phase: 'download', started: '1788000000', exit: '143', cancelled: '1', alive: '0' }),
    NOW,
  );
  assert.equal(run.status, 'cancelled');
  assert.equal(run.percent, null);
});

/*
 * A dead process with no exit code means something killed the script - a reboot
 * mid-run, or an OOM. That must not read as "still working".
 */
test('a dead process with no exit code is orphaned, but only after a grace period', () => {
  const fields = { pid: '1', phase: 'download', started: '1788000000', exit: '', cancelled: '0', alive: '0' };

  /* Five seconds in, the pid file may simply not have been written yet. */
  assert.equal(parseRuns(block(ID, fields), 1788000005000)[0].status, 'starting');
  assert.equal(parseRuns(block(ID, fields), NOW)[0].status, 'orphaned');
});

test('a half-written meta.json loses the metadata, not the run', () => {
  const text = `@@RUN@@${ID}\nmeta={"recipeId":"qwen\npid=1\nphase=download\nstarted=1788000000\nalive=1\n`;
  const [run] = parseRuns(text, NOW);

  assert.equal(run.id, ID);
  assert.equal(run.status, 'downloading');
  assert.equal(run.recipeId, '');
});

test('an unrecognised phase is dropped rather than trusted', () => {
  const [run] = parseRuns(
    block(ID, { pid: '1', phase: 'rm -rf /', started: '1788000000', exit: '', cancelled: '0', alive: '1' }),
    NOW,
  );
  assert.equal(run.phase, null);
  assert.equal(run.status, 'starting');
});

test('a directory that is not a run id is ignored', () => {
  assert.equal(parseRuns(block('../../etc', { pid: '1', alive: '1' }), NOW).length, 0);
  assert.equal(RUN_ID_RE.test(ID), true);
  assert.equal(RUN_ID_RE.test('run-123-abcd1234'), false);
});

test('runs come back newest first', () => {
  const older = 'run-1788000000000-aaaaaaaa';
  const newer = 'run-1788000900000-bbbbbbbb';
  const text =
    block(older, { pid: '1', started: '1788000000', exit: '0', alive: '0', cancelled: '0' }) +
    block(newer, { pid: '2', started: '1788000900', exit: '0', alive: '0', cancelled: '0' });

  assert.deepEqual(parseRuns(text, NOW).map((r) => r.id), [newer, older]);
});

test('empty output is no runs, not a crash', () => {
  assert.deepEqual(parseRuns(''), []);
  assert.deepEqual(parseRuns(null), []);
});

test('every active status is one a phase can produce', () => {
  for (const status of ACTIVE_RUN_STATUSES) {
    assert.equal(typeof status, 'string');
  }
  assert.equal(ACTIVE_RUN_STATUSES.has('ready'), false);
  assert.equal(ACTIVE_RUN_STATUSES.has('failed'), false);
  assert.equal(deriveRunStatus({ cancelled: false, exitCode: null, alive: true, phase: 'wait' }), 'waiting');
});
