import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMagicPacket } from './power.js';

test('buildMagicPacket is 6 sync bytes plus the MAC repeated 16 times', () => {
  const packet = buildMagicPacket('aa:bb:cc:dd:ee:ff');

  assert.equal(packet.length, 102);
  assert.deepEqual([...packet.subarray(0, 6)], [0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

  const mac = [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff];
  for (let i = 0; i < 16; i += 1) {
    assert.deepEqual([...packet.subarray(6 + i * 6, 12 + i * 6)], mac, `repetition ${i}`);
  }
});

test('buildMagicPacket accepts hyphen separated addresses', () => {
  assert.deepEqual(buildMagicPacket('AA-BB-CC-DD-EE-FF'), buildMagicPacket('aa:bb:cc:dd:ee:ff'));
});

test('buildMagicPacket rejects malformed addresses', () => {
  for (const bad of ['aa:bb:cc:dd:ee', 'zz:bb:cc:dd:ee:ff', '', 'not-a-mac']) {
    assert.throws(() => buildMagicPacket(bad), /invalid MAC address/, `expected "${bad}" to be rejected`);
  }
});
