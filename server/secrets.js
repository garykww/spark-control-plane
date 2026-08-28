import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from './config.js';

const ALGO = 'aes-256-gcm';

/*
 * SSH passwords are stored separately from nodes.json and encrypted at rest with
 * AES-256-GCM. The key comes from SECRET_KEY when set, otherwise a random key is
 * generated once and kept in config/.secret-key with 0600 permissions.
 */
function loadKey() {
  if (config.secretKey) {
    return crypto.createHash('sha256').update(config.secretKey).digest();
  }
  try {
    const stored = fs.readFileSync(paths.key, 'utf8').trim();
    if (stored.length === 64) return Buffer.from(stored, 'hex');
  } catch {
    /* falls through to generating a fresh key */
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(paths.key), { recursive: true });
  fs.writeFileSync(paths.key, key.toString('hex'), { mode: 0o600 });
  return key;
}

let key = null;
const getKey = () => (key ??= loadKey());

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), enc.toString('hex')].join(':');
}

export function decrypt(payload) {
  const [ivHex, tagHex, dataHex] = String(payload).split(':');
  if (!ivHex || !tagHex || !dataHex) return null;
  try {
    const decipher = crypto.createDecipheriv(ALGO, getKey(), Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
  } catch {
    /* Wrong key or tampered payload - treat as no stored password. */
    return null;
  }
}

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(paths.secrets, 'utf8'));
  } catch {
    return {};
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(paths.secrets), { recursive: true });
  fs.writeFileSync(paths.secrets, JSON.stringify(store, null, 2), { mode: 0o600 });
}

export function setPassword(nodeId, password) {
  const store = readStore();
  if (password) store[nodeId] = encrypt(password);
  else delete store[nodeId];
  writeStore(store);
}

export function getPassword(nodeId) {
  const stored = readStore()[nodeId];
  return stored ? decrypt(stored) : null;
}

export function hasPassword(nodeId) {
  return Boolean(readStore()[nodeId]);
}

export function deletePassword(nodeId) {
  setPassword(nodeId, null);
}
