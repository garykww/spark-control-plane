import test from 'node:test';
import assert from 'node:assert/strict';
import { parseContainers, CONTAINER_ID_RE } from './docker.js';

const ID_A = 'a'.repeat(64);
const ID_B = 'b'.repeat(64);

const row = (fields) => JSON.stringify(fields);

test('parseContainers reads docker ps json output', () => {
  const { containers, error, available } = parseContainers(
    row({
      ID: ID_A,
      Names: 'vllm-llama70b',
      Image: 'vllm/vllm-openai:latest',
      State: 'running',
      Status: 'Up 4 hours',
      Ports: '0.0.0.0:8000->8000/tcp, :::8000->8000/tcp',
      CreatedAt: '2026-08-27 09:14:22 +0000 UTC',
    }),
  );

  assert.equal(error, null);
  assert.equal(available, true);
  assert.equal(containers.length, 1);
  assert.equal(containers[0].name, 'vllm-llama70b');
  assert.equal(containers[0].state, 'running');
  /* The IPv4 and IPv6 publications of one port collapse into a single entry. */
  assert.deepEqual(containers[0].ports, ['8000->8000/tcp']);
});

test('parseContainers sorts running containers first, then by name', () => {
  const { containers } = parseContainers(
    [
      row({ ID: ID_A, Names: 'zebra', State: 'running', Status: 'Up 1 hour' }),
      row({ ID: ID_B, Names: 'alpha', State: 'exited', Status: 'Exited (0) 2 days ago' }),
      row({ ID: 'c'.repeat(64), Names: 'beta', State: 'running', Status: 'Up 3 days' }),
    ].join('\n'),
  );

  assert.deepEqual(containers.map((c) => c.name), ['beta', 'zebra', 'alpha']);
});

test('parseContainers falls back to Status when State is absent', () => {
  const { containers } = parseContainers(
    [
      row({ ID: ID_A, Names: 'old-daemon', Status: 'Up 3 hours' }),
      row({ ID: ID_B, Names: 'stopped', Status: 'Exited (137) 3 hours ago' }),
    ].join('\n'),
  );

  assert.equal(containers[0].state, 'running');
  assert.equal(containers[1].state, 'exited');
});

test('parseContainers keeps only the first name of a multi-named container', () => {
  const { containers } = parseContainers(row({ ID: ID_A, Names: 'web,web_1', State: 'running' }));
  assert.equal(containers[0].name, 'web');
});

test('parseContainers reports a permission problem with the fix', () => {
  const result = parseContainers(
    "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
  );

  assert.equal(result.available, false);
  assert.match(result.error, /docker.*group/i);
});

test('parseContainers reports a stopped daemon', () => {
  const result = parseContainers('Cannot connect to the Docker daemon at unix:///var/run/docker.sock.');
  assert.equal(result.available, false);
  assert.match(result.error, /daemon is not running/);
});

test('parseContainers stays silent when docker is simply not installed', () => {
  const result = parseContainers('sh: 1: docker: not found');
  assert.equal(result.available, false);
  /* No error means the UI hides the panel entirely rather than nagging. */
  assert.equal(result.error, null);
});

test('parseContainers treats no output as no containers', () => {
  assert.deepEqual(parseContainers(''), { containers: [], error: null, available: false });
});

test('parseContainers ignores rows without a valid container id', () => {
  const { containers } = parseContainers(
    [row({ ID: 'nope', Names: 'bad' }), row({ ID: ID_A, Names: 'good', State: 'running' })].join('\n'),
  );

  assert.deepEqual(containers.map((c) => c.name), ['good']);
});

test('CONTAINER_ID_RE accepts docker ids and rejects anything shell-unsafe', () => {
  assert.ok(CONTAINER_ID_RE.test(ID_A));
  assert.ok(CONTAINER_ID_RE.test('a1b2c3d4e5f6'));

  for (const bad of ['', 'short', 'ABCDEF123456', 'a1b2c3d4e5f6; rm -rf /', '$(whoami)', '../etc']) {
    assert.equal(CONTAINER_ID_RE.test(bad), false, `expected "${bad}" to be rejected`);
  }
});
