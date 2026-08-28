import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseNode } from './registry.js';

const base = { name: 'spark-01', host: '10.0.0.11' };

test('normaliseNode fills in the defaults a DGX Spark needs', () => {
  const node = normaliseNode(base);

  assert.equal(node.type, 'dgx-spark');
  assert.equal(node.connection, 'ssh');
  assert.equal(node.sshUser, 'nvidia');
  assert.equal(node.sshPort, 22);
  assert.equal(node.enabled, true);
  assert.match(node.id, /^[0-9a-f-]{36}$/);
});

test('normaliseNode rejects addresses that should never be polled', () => {
  const cases = [
    ['169.254.10.1', /link-local/],
    ['224.0.0.1', /multicast/],
    ['0.1.2.3', /this network/],
    ['255.255.255.255', /broadcast|multicast/],
    ['999.1.1.1', /invalid IPv4/],
    ['bad host!', /invalid hostname/],
  ];

  for (const [host, expected] of cases) {
    assert.throws(() => normaliseNode({ ...base, host }), expected, `expected "${host}" to be rejected`);
  }
});

test('normaliseNode accepts hostnames and ordinary LAN addresses', () => {
  for (const host of ['10.0.0.11', '192.168.1.50', 'spark-01', 'spark-01.local']) {
    assert.equal(normaliseNode({ ...base, host }).host, host);
  }
});

test('normaliseNode requires a name and a valid port', () => {
  assert.throws(() => normaliseNode({ host: '10.0.0.11' }), /name is required/);
  assert.throws(() => normaliseNode({ ...base, sshPort: 0 }), /port between 1 and 65535/);
  assert.throws(() => normaliseNode({ ...base, sshPort: 99999 }), /port between 1 and 65535/);
});

test('normaliseNode normalises MAC addresses and rejects bad ones', () => {
  assert.equal(normaliseNode({ ...base, macAddress: 'AA-BB-CC-DD-EE-FF' }).macAddress, 'aa:bb:cc:dd:ee:ff');
  assert.equal(normaliseNode(base).macAddress, null);
  assert.throws(() => normaliseNode({ ...base, macAddress: 'nope' }), /invalid MAC address/);
});

test('normaliseNode parses inference ports and drops invalid entries', () => {
  const node = normaliseNode({
    ...base,
    llmPorts: [{ port: 8000, label: 'vLLM' }, { port: '11434' }],
  });

  assert.deepEqual(node.llmPorts, [
    { port: 8000, label: 'vLLM' },
    { port: 11434, label: '' },
  ]);
  assert.throws(() => normaliseNode({ ...base, llmPorts: [{ port: 0 }] }), /port between 1 and 65535/);
});

test('a local node ignores the supplied host and targets this machine', () => {
  const node = normaliseNode({ name: 'localhost', connection: 'local', host: '224.0.0.1' });
  assert.equal(node.host, 'localhost');
});

test('normaliseNode keeps the id and creation time when editing', () => {
  const original = normaliseNode(base);
  const edited = normaliseNode({ name: 'spark-01-renamed' }, original);

  assert.equal(edited.id, original.id);
  assert.equal(edited.createdAt, original.createdAt);
  assert.equal(edited.name, 'spark-01-renamed');
  /* Fields the edit did not mention must survive untouched. */
  assert.equal(edited.host, original.host);
});
