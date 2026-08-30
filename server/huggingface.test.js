import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertRepo,
  assertRevision,
  assertJobId,
  startDownload,
  deleteRepo,
  cancelDownload,
  reclaim,
} from './huggingface.js';

const NODE = { id: 'n1', name: 'spark-01', connection: 'ssh', host: '10.0.0.11', sshUser: 'nvidia' };

/*
 * Everything here rejects before a runner is built, so no mocking is needed.
 * Repo ids are the interesting case: unlike container ids they legitimately
 * contain "/", "." and "-", so the regex has to stay permissive without ever
 * admitting something that could break out of the single quotes the commands
 * wrap it in, or be read as an argv flag.
 */

test('assertRepo accepts the shapes real repo ids take', () => {
  const valid = [
    'gpt2',
    'openwebtext',
    'Qwen/Qwen3.6-35B-A3B',
    'meta-llama/Llama-3.3-70B-Instruct',
    'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4',
    'TheBloke/Llama-2-7B-GGUF',
    'FunAudioLLM/CosyVoice2-0.5B',
    'a_b/c.d-e',
  ];

  for (const repoId of valid) {
    assert.equal(assertRepo(repoId, 'model').repoId, repoId, `expected "${repoId}" to be accepted`);
  }
});

test('assertRepo rejects anything that could reach a shell or argv', () => {
  const hostile = [
    '',
    'Qwen/X; rm -rf /',
    '$(whoami)',
    '`id`',
    'a|b',
    'a&&b',
    'a b',
    "a'b",
    'a"b',
    'a\nb',
    'a$b',
    '../../etc/passwd',
    'a/../b',
    'a/b/c',
    '/leading',
    'trailing/',
    '-rf',
    '--local-dir=/etc',
    '.hidden',
    'x'.repeat(200),
  ];

  for (const repoId of hostile) {
    assert.throws(
      () => assertRepo(repoId, 'model'),
      /invalid repo id/,
      `expected "${repoId}" to be rejected`,
    );
  }
});

test('assertRepo enforces the repo type allowlist', () => {
  for (const repoType of ['model', 'dataset', 'space']) {
    assert.equal(assertRepo('gpt2', repoType).repoType, repoType);
  }
  for (const repoType of ['models', 'Model', '', 'spaces', '../', undefined]) {
    assert.throws(() => assertRepo('gpt2', repoType), /unknown repo type/);
  }
});

test('assertRevision accepts branches, tags and hashes but not flags', () => {
  for (const revision of ['main', 'refs/pr/1', 'v1.0', 'a'.repeat(40)]) {
    assert.equal(assertRevision(revision), revision);
  }
  /* Absent revision is legitimate and means "default branch". */
  assert.equal(assertRevision(null), null);
  assert.equal(assertRevision(''), null);

  for (const revision of ['-x', 'a;b', '$(x)', '../etc', 'a b']) {
    assert.throws(() => assertRevision(revision), /invalid revision/);
  }
});

test('assertJobId only accepts ids this server generates', () => {
  assert.equal(assertJobId('job-1756500000000-abcdef12'), 'job-1756500000000-abcdef12');

  for (const jobId of ['', '..', 'a/b', 'job-1;rm -rf /', 'job-abc-def', 'job-1756500000000-XYZ']) {
    assert.throws(() => assertJobId(jobId), /invalid job id/, `expected "${jobId}" to be rejected`);
  }
});

test('startDownload validates before touching the network', async () => {
  await assert.rejects(() => startDownload(NODE, { repoId: 'a; rm -rf /' }), /invalid repo id/);
  await assert.rejects(() => startDownload(NODE, { repoId: 'gpt2', repoType: 'nope' }), /unknown repo type/);
  await assert.rejects(
    () => startDownload(NODE, { repoId: 'gpt2', revision: '$(id)' }),
    /invalid revision/,
  );
});

test('deleteRepo refuses unless the caller echoes the repo id back', async () => {
  await assert.rejects(
    () => deleteRepo(NODE, { repoId: 'Qwen/Qwen3.6-35B-A3B', repoType: 'model', confirm: 'wrong' }),
    /confirm must match/,
  );
  await assert.rejects(
    () => deleteRepo(NODE, { repoId: 'Qwen/Qwen3.6-35B-A3B', repoType: 'model' }),
    /confirm must match/,
  );
});

test('cancelDownload and reclaim validate their inputs', async () => {
  await assert.rejects(() => cancelDownload(NODE, '../../etc'), /invalid job id/);
  await assert.rejects(() => reclaim(NODE, 'everything'), /unknown reclaim target/);
  await assert.rejects(() => reclaim(NODE, 'rm -rf /'), /unknown reclaim target/);
});

test('rejections are client errors, not server errors', async () => {
  const cases = [
    () => startDownload(NODE, { repoId: '$(whoami)' }),
    () => deleteRepo(NODE, { repoId: 'gpt2', repoType: 'model', confirm: 'no' }),
    () => cancelDownload(NODE, 'bogus'),
    () => reclaim(NODE, 'bogus'),
  ];

  for (const run of cases) {
    const err = await run().catch((e) => e);
    assert.equal(err.status, 400);
  }
});
