import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { decrypt, encrypt } from './secrets.js';

/*
 * The vault: secrets that belong to the control plane rather than to one node.
 *
 * An SSH password is keyed by node id and dies with the node. These are keyed
 * by name and outlive every node - VLLM_API_KEY is the bearer token the whole
 * fleet serves behind, so a client configured once keeps working across runs,
 * nodes and restarts instead of being re-pointed at a fresh key each launch.
 *
 * The entries are DECLARED, not free-form. Every value here ends up on a
 * command line on a node, so each needs a pattern of its own - and a fixed set
 * lets the UI say what a secret is for rather than offering a bare key/value
 * editor whose contents nothing would ever read.
 *
 * Storage is the same AES-256-GCM at rest as the password store, under the same
 * key, in config/vault.json with 0600 permissions.
 */

const bad = (message) => Object.assign(new Error(message), { status: 400 });

/*
 * Deliberately tighter than recipes.js's ARG_RE - a subset of it with no spaces
 * - so a key that was accepted here can always be single-quoted onto the node's
 * command line, and the launcher's own guard can never be what rejects it.
 */
const API_KEY_RE = /^[A-Za-z0-9_.:@+=/-]{8,200}$/;

export const VAULT_ENTRIES = [
  {
    name: 'VLLM_API_KEY',
    label: 'vLLM API key',
    summary:
      'Served as --api-key by every new vLLM run. Leave it unset and each run mints a random key of its own.',
    hint: '8 to 200 characters from A-Z a-z 0-9 _ . : @ + = / -',
    placeholder: 'sk-…',
    pattern: API_KEY_RE,
  },
];

const BY_NAME = new Map(VAULT_ENTRIES.map((entry) => [entry.name, entry]));

function requireEntry(name) {
  const entry = BY_NAME.get(String(name ?? ''));
  if (!entry) throw Object.assign(new Error(`no vault entry named ${name}`), { status: 404 });
  return entry;
}

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.vault, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(paths.vault), { recursive: true });
  fs.writeFileSync(paths.vault, JSON.stringify(store, null, 2), { mode: 0o600 });
}

/*
 * The plaintext, or null. A stored value that no longer decrypts (SECRET_KEY
 * changed) or no longer matches its pattern (the file was hand-edited) is
 * treated as absent rather than passed on: the alternative is a launch that
 * fails on the node, hours in, over something knowable here.
 */
export function getSecret(name) {
  const entry = BY_NAME.get(String(name ?? ''));
  if (!entry) return null;

  const stored = readStore()[entry.name];
  const value = stored?.value ? decrypt(stored.value) : null;
  return value && entry.pattern.test(value) ? value : null;
}

/* What a browser is told: whether a secret is set and enough of it to recognise
 * which one, never the secret itself. */
function publicEntry(entry) {
  const value = getSecret(entry.name);
  const stored = readStore()[entry.name];

  return {
    name: entry.name,
    label: entry.label,
    summary: entry.summary,
    hint: entry.hint,
    placeholder: entry.placeholder,
    set: value !== null,
    preview: value ? `…${value.slice(-4)}` : null,
    updatedAt: value ? stored?.updatedAt ?? null : null,
  };
}

export function listVault() {
  return VAULT_ENTRIES.map(publicEntry);
}

export function setSecret(name, value) {
  const entry = requireEntry(name);
  const text = String(value ?? '').trim();

  if (!text) throw bad(`${entry.name} is required`);
  if (!entry.pattern.test(text)) throw bad(`${entry.name} must be ${entry.hint}`);

  const store = readStore();
  store[entry.name] = { value: encrypt(text), updatedAt: new Date().toISOString() };
  writeStore(store);
  return publicEntry(entry);
}

export function clearSecret(name) {
  const entry = requireEntry(name);
  const store = readStore();
  delete store[entry.name];
  writeStore(store);
  return publicEntry(entry);
}
