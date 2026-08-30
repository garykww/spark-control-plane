import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHumanSize,
  parseHfProbe,
  parseCacheList,
  parseIncomplete,
  parsePrune,
  parseJobs,
  deriveJobStatus,
  cacheFolderName,
  summariseHf,
} from './huggingface.js';

/* Captured verbatim from `hf cache ls --format json` on a GB10 running hf 1.17.0. */
const CACHE_JSON = JSON.stringify([
  {
    id: 'dataset/Skylion007/openwebtext',
    repo_id: 'Skylion007/openwebtext',
    repo_type: 'dataset',
    size: '24.2G',
    last_accessed: '1 day ago',
    last_modified: '1 day ago',
    refs: ['main'],
  },
  {
    id: 'dataset/openwebtext',
    repo_id: 'openwebtext',
    repo_type: 'dataset',
    size: '7.5K',
    last_accessed: '1 day ago',
    last_modified: '1 day ago',
    refs: ['main'],
  },
  {
    id: 'model/Qwen/Qwen2.5-0.5B-Instruct',
    repo_id: 'Qwen/Qwen2.5-0.5B-Instruct',
    repo_type: 'model',
    size: '999.6M',
    last_accessed: '2 days ago',
    last_modified: '2 days ago',
    refs: ['main'],
  },
  {
    id: 'model/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4',
    repo_id: 'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4',
    repo_type: 'model',
    size: '80.4G',
    last_accessed: '5 days ago',
    last_modified: '5 days ago',
    refs: ['main'],
  },
]);

test('parseHumanSize uses decimal units, matching huggingface_hub', () => {
  /* Verified on hardware: a repo du -sb measures at 999,588,026 bytes is
   * reported by hf as "999.6M". That is 1e6, not 1024^2. */
  assert.equal(parseHumanSize('999.6M'), 999600000);
  assert.equal(parseHumanSize('71.9G'), 71900000000);
  assert.equal(parseHumanSize('7.5K'), 7500);
  assert.equal(parseHumanSize('445.0'), 445);
  assert.equal(parseHumanSize('12'), 12);
});

test('parseHumanSize honours an explicit binary suffix', () => {
  assert.equal(parseHumanSize('1.5Gi'), Math.round(1.5 * 1024 ** 3));
});

test('parseHumanSize returns null for unknown sizes rather than zero', () => {
  for (const value of ['-', '', 'n/a', 'garbage', null, undefined]) {
    assert.equal(parseHumanSize(value), null, `expected ${JSON.stringify(value)} to be null`);
  }
});

test('parseHfProbe pulls the version out of decorated CLI output', () => {
  const probe = parseHfProbe(
    ['bin=/home/u/.local/bin/hf', 'cacheDir=/home/u/.cache/huggingface', 'version=  version: 1.17.0', 'user=someone'].join('\n'),
  );

  assert.equal(probe.bin, '/home/u/.local/bin/hf');
  assert.equal(probe.version, '1.17.0');
  assert.equal(probe.user, 'someone');
});

test('parseHfProbe reports a logged-out node as user null, not available false', () => {
  const probe = parseHfProbe(['bin=/home/u/.local/bin/hf', 'cacheDir=/c', 'version=1.17.0', 'user='].join('\n'));
  assert.equal(probe.user, null);
  assert.equal(probe.bin, '/home/u/.local/bin/hf');
});

test('parseHfProbe returns null when hf is not installed', () => {
  assert.equal(parseHfProbe(''), null);
  assert.equal(parseHfProbe('cacheDir=/x'), null);
});

test('parseCacheList splits type from id and sorts by size descending', () => {
  const { repos, error, available } = parseCacheList(CACHE_JSON);

  assert.equal(available, true);
  assert.equal(error, null);
  assert.deepEqual(repos.map((r) => r.repoId), [
    'nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4',
    'Skylion007/openwebtext',
    'Qwen/Qwen2.5-0.5B-Instruct',
    'openwebtext',
  ]);
  assert.equal(repos[0].repoType, 'model');
  assert.equal(repos[1].repoType, 'dataset');
});

test('parseCacheList keeps single-segment repo ids', () => {
  const { repos } = parseCacheList(CACHE_JSON);
  const single = repos.find((r) => r.repoId === 'openwebtext');
  assert.equal(single.id, 'dataset/openwebtext');
  assert.equal(single.sizeBytes, 7500);
});

test('parseCacheList stays quiet when hf is not installed', () => {
  const result = parseCacheList('sh: 1: hf: not found');
  assert.deepEqual(result, { repos: [], error: null, available: false });
});

test('parseCacheList turns an auth failure into an actionable message', () => {
  const result = parseCacheList('401 Client Error: Unauthorized for url: https://huggingface.co/api/whoami');
  assert.equal(result.available, false);
  assert.match(result.error, /hf auth login/);
});

test('parseCacheList drops rows whose repo id or type is unusable', () => {
  const hostile = JSON.stringify([
    { id: 'model/../../etc/passwd', repo_id: '../../etc/passwd', repo_type: 'model', size: '1G' },
    { id: 'weird/x', repo_id: 'x', repo_type: 'weird', size: '1G' },
    { id: 'model/ok/name', repo_id: 'ok/name', repo_type: 'model', size: '1G' },
  ]);

  const { repos } = parseCacheList(hostile);
  assert.deepEqual(repos.map((r) => r.repoId), ['ok/name']);
});

test('parseIncomplete reads the file count and byte total', () => {
  assert.deepEqual(parseIncomplete('6 7858435171'), { files: 6, bytes: 7858435171 });
  assert.deepEqual(parseIncomplete('0 0'), { files: 0, bytes: 0 });
  assert.deepEqual(parseIncomplete(''), { files: 0, bytes: 0 });
});

test('parsePrune reads reclaimable detached revisions', () => {
  assert.deepEqual(parsePrune('{"dry_run": true, "revisions": 4, "size": "999.1M"}'), {
    revisions: 4,
    bytes: 999100000,
  });
  /* An hf without the prune subcommand must not break the whole collection. */
  assert.equal(parsePrune(''), null);
  assert.equal(parsePrune('Usage: hf cache [OPTIONS]'), null);
});

test('cacheFolderName matches the on-disk layout', () => {
  assert.equal(cacheFolderName('model', 'Qwen/Qwen2.5-0.5B-Instruct'), 'models--Qwen--Qwen2.5-0.5B-Instruct');
  assert.equal(cacheFolderName('model', 'gpt2'), 'models--gpt2');
  assert.equal(cacheFolderName('dataset', 'openwebtext'), 'datasets--openwebtext');
});

const job = (over = {}) => ({
  cancelled: false,
  exitCode: null,
  alive: false,
  startedAt: Math.floor(Date.now() / 1000),
  ...over,
});

test('deriveJobStatus distinguishes every terminal and live state', () => {
  const now = Date.now();
  assert.equal(deriveJobStatus(job({ alive: true }), now), 'running');
  assert.equal(deriveJobStatus(job({ exitCode: 0 }), now), 'done');
  assert.equal(deriveJobStatus(job({ exitCode: 1 }), now), 'failed');
  assert.equal(deriveJobStatus(job({ cancelled: true, exitCode: 143 }), now), 'cancelled');
  /* 75 is the marker the job script writes when flock finds a peer running. */
  assert.equal(deriveJobStatus(job({ exitCode: 75 }), now), 'blocked');
});

test('deriveJobStatus gives a new job a grace period before calling it orphaned', () => {
  const now = Date.now();
  /* The pid file may not exist for a moment after launch. */
  assert.equal(deriveJobStatus(job({ startedAt: Math.floor(now / 1000) }), now), 'starting');
  /* A dead process with no exit code means the node died mid-download. */
  assert.equal(deriveJobStatus(job({ startedAt: Math.floor(now / 1000) - 600 }), now), 'orphaned');
});

test('parseJobs reads a job block and computes progress', () => {
  const meta = JSON.stringify({ repoId: 'Qwen/Qwen3.6-35B-A3B', repoType: 'model', revision: null });
  const text = [
    '@@JOB@@job-1756500000000-abcdef12',
    `meta=${meta}`,
    'pid=12345',
    `started=${Math.floor(Date.now() / 1000)}`,
    'exit=',
    'total=1000000000',
    'cancelled=0',
    'alive=1',
    'done=250000000',
    'tail=Downloading shards:  25%|##        |',
  ].join('\n');

  const [parsed] = parseJobs(text);
  assert.equal(parsed.id, 'job-1756500000000-abcdef12');
  assert.equal(parsed.repoId, 'Qwen/Qwen3.6-35B-A3B');
  assert.equal(parsed.status, 'running');
  assert.equal(parsed.totalBytes, 1000000000);
  assert.equal(parsed.downloadedBytes, 250000000);
  assert.equal(parsed.percent, 25);
  assert.match(parsed.message, /Downloading shards/);
});

test('parseJobs reports no percentage when the total could not be determined', () => {
  const text = [
    '@@JOB@@job-1756500000000-abcdef12',
    'meta={"repoId":"gpt2","repoType":"model"}',
    'pid=1',
    'started=1',
    'exit=',
    'total=0',
    'cancelled=0',
    'alive=1',
    'done=500',
    'tail=',
  ].join('\n');

  const [parsed] = parseJobs(text);
  /* A fabricated percentage would be worse than none. */
  assert.equal(parsed.totalBytes, null);
  assert.equal(parsed.percent, null);
  assert.equal(parsed.downloadedBytes, 500);
});

test('parseJobs survives a half-written meta.json', () => {
  const text = ['@@JOB@@job-1756500000000-abcdef12', 'meta={"repoId":', 'pid=1', 'alive=1', 'exit='].join('\n');
  const [parsed] = parseJobs(text);
  assert.equal(parsed.id, 'job-1756500000000-abcdef12');
  assert.equal(parsed.repoId, '');
});

test('parseJobs returns nothing when no jobs exist', () => {
  assert.deepEqual(parseJobs(''), []);
});

test('summariseHf totals repo sizes and carries reclaimable space', () => {
  const summary = summariseHf({
    probe: { bin: '/x/hf', version: '1.17.0', user: 'someone', cacheDir: '/c' },
    cache: parseCacheList(CACHE_JSON),
    incomplete: { files: 6, bytes: 7858435171 },
    prune: { revisions: 4, bytes: 999100000 },
    jobs: [],
  });

  assert.equal(summary.available, true);
  assert.equal(summary.repos.length, 4);
  assert.equal(summary.totalBytes, 24200000000 + 7500 + 999600000 + 80400000000);
  assert.equal(summary.reclaimable.incompleteBytes, 7858435171);
  assert.equal(summary.reclaimable.pruneBytes, 999100000);
});

test('summariseHf reports unavailable when hf was never found', () => {
  const summary = summariseHf({ probe: null, cache: null, incomplete: null, prune: null, jobs: [] });
  assert.equal(summary.available, false);
  assert.equal(summary.error, null);
  assert.equal(summary.totalBytes, 0);
});

test('a finished job reads 100%, not the rounding artefact of its total', () => {
  /* The total is summed from hf's pre-rounded human sizes, so bytes-on-disk
   * rarely matches it exactly; observed 12512611/12588624 on a real download. */
  const text = [
    '@@JOB@@job-1756500000000-abcdef12',
    'meta={"repoId":"hf-internal-testing/tiny-random-gpt2","repoType":"model"}',
    'pid=1',
    'started=1',
    'exit=0',
    'total=12588624',
    'cancelled=0',
    'alive=0',
    'done=12512611',
    'tail=done',
  ].join('\n');

  const [parsed] = parseJobs(text);
  assert.equal(parsed.status, 'done');
  assert.equal(parsed.percent, 100);
});

test('a job that ended badly shows no percentage rather than a full bar', () => {
  /* percent drives the progress bar; 100% on a cancelled job would read as
   * "finished". Only a successful job is complete. */
  for (const [exit, cancelled, status] of [
    ['1', '0', 'failed'],
    ['143', '1', 'cancelled'],
    ['75', '0', 'blocked'],
  ]) {
    const text = [
      '@@JOB@@job-1756500000000-abcdef12',
      'meta={"repoId":"gpt2","repoType":"model"}',
      'pid=1',
      'started=1',
      `exit=${exit}`,
      'total=1000',
      `cancelled=${cancelled}`,
      'alive=0',
      'done=400',
      'tail=',
    ].join('\n');

    const [parsed] = parseJobs(text);
    assert.equal(parsed.status, status);
    assert.equal(parsed.percent, null, `expected no percentage for ${status}`);
  }
});
