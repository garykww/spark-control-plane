import test from 'node:test';
import assert from 'node:assert/strict';
import { containerAction } from './containers.js';

const NODE = { id: 'n1', name: 'spark-01', connection: 'ssh', host: '10.0.0.11', sshUser: 'nvidia' };
const ID = 'a'.repeat(64);

/*
 * containerAction builds its own runner, so these cover the checks that happen
 * before anything is executed - which is exactly where the shell-injection and
 * bad-verb guards live.
 */

test('containerAction rejects verbs outside the fixed set', async () => {
  for (const action of ['rm', 'exec', 'kill', 'run', '', 'START']) {
    await assert.rejects(
      () => containerAction(NODE, ID, action),
      /unknown container action/,
      `expected "${action}" to be rejected`,
    );
  }
});

test('containerAction rejects ids that could carry shell syntax', async () => {
  const injections = [
    `${'a'.repeat(64)}; rm -rf /`,
    '$(whoami)',
    '`id`',
    'container name',
    'short',
    '',
    '../../etc/passwd',
    'ABCDEF123456',
  ];

  for (const id of injections) {
    await assert.rejects(
      () => containerAction(NODE, id, 'stop'),
      /invalid container id/,
      `expected "${id}" to be rejected`,
    );
  }
});

test('containerAction validates the verb before the id', async () => {
  /* Both are invalid; the action check runs first, which keeps the error the
   * more useful of the two. */
  await assert.rejects(() => containerAction(NODE, 'bogus', 'nope'), /unknown container action/);
});

test('rejections are client errors, not server errors', async () => {
  const err = await containerAction(NODE, 'bogus', 'stop').catch((e) => e);
  assert.equal(err.status, 400);
});
