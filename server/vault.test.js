import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * The store is a file, so these run against a config directory of their own.
 * CONFIG_DIR is read when config.js is first imported, which is why the modules
 * under test are pulled in dynamically after it is set.
 */
const CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
process.env.CONFIG_DIR = CONFIG_DIR;
process.env.SECRET_KEY = 'test-key-for-the-vault';

const VAULT_FILE = path.join(CONFIG_DIR, 'vault.json');

const { listVault, setSecret, clearSecret, getSecret } = await import('./vault.js');
const { apiKeyFor } = await import('./planner.js');
const { ARG_RE, recipeById } = await import('./recipes.js');

const KEY = 'sk-0123456789abcdef0123456789abcdef';
const reset = () => fs.rmSync(VAULT_FILE, { force: true });

test('a key round-trips through the store', () => {
  reset();
  setSecret('VLLM_API_KEY', KEY);
  assert.equal(getSecret('VLLM_API_KEY'), KEY);
});

test('the store holds no plaintext and is readable only by its owner', () => {
  reset();
  setSecret('VLLM_API_KEY', KEY);

  const raw = fs.readFileSync(VAULT_FILE, 'utf8');
  assert.equal(raw.includes(KEY), false);
  assert.equal(fs.statSync(VAULT_FILE).mode & 0o777, 0o600);
});

/* What a browser is given: enough to recognise which key is stored, never the
 * key itself. */
test('the public shape reports a key without disclosing it', () => {
  reset();
  assert.deepEqual(
    listVault().map((entry) => [entry.name, entry.set, entry.preview]),
    [['VLLM_API_KEY', false, null]],
  );

  setSecret('VLLM_API_KEY', KEY);
  const [entry] = listVault();

  assert.equal(entry.set, true);
  assert.equal(entry.preview, `…${KEY.slice(-4)}`);
  assert.ok(entry.updatedAt);
  assert.equal(JSON.stringify(entry).includes(KEY), false);
});

/*
 * The whole point of validating here: the key is single-quoted onto a command
 * line on the node, so anything that could break out of that has to be refused
 * at the boundary rather than at launch.
 */
test('a key that could not be quoted onto a node is refused', () => {
  reset();
  const rejected = [
    "sk-abc'def",
    'sk-$(whoami)',
    'sk-`id`',
    'sk with spaces',
    'sk-abc;rm -rf /',
    'sk-ab',
    `sk-${'a'.repeat(300)}`,
    '',
    null,
  ];

  for (const value of rejected) {
    assert.throws(() => setSecret('VLLM_API_KEY', value), /VLLM_API_KEY/, `expected ${value} to be rejected`);
  }
  assert.equal(getSecret('VLLM_API_KEY'), null);
});

test('every accepted key is one the launcher can quote', () => {
  reset();
  for (const value of [KEY, 'A_b.9:x@y+z=w/q-1', 'sk-' + 'Z'.repeat(197)]) {
    assert.equal(setSecret('VLLM_API_KEY', value).set, true);
    assert.ok(ARG_RE.test(value), `${value} would be refused by the launcher`);
  }
});

test('an entry the vault does not declare is a 404, not a new secret', () => {
  reset();
  assert.throws(() => setSecret('HF_TOKEN', KEY), (err) => err.status === 404);
  assert.throws(() => clearSecret('nonsense'), (err) => err.status === 404);
  assert.equal(getSecret('HF_TOKEN'), null);
  assert.equal(fs.existsSync(VAULT_FILE), false);
});

test('clearing a key removes it from the store', () => {
  reset();
  setSecret('VLLM_API_KEY', KEY);
  assert.equal(clearSecret('VLLM_API_KEY').set, false);
  assert.equal(getSecret('VLLM_API_KEY'), null);
  assert.equal(JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8')).VLLM_API_KEY, undefined);
});

/* A value written under a different SECRET_KEY, or edited by hand into
 * something unquotable, reads as absent - a run falls back to a minted key
 * rather than failing on the node hours into a weight download. */
test('a stored value that cannot be read back is treated as absent', () => {
  reset();
  setSecret('VLLM_API_KEY', KEY);
  const store = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));

  for (const value of [`${store.VLLM_API_KEY.value.slice(0, -2)}ff`, 'not-encrypted-at-all']) {
    fs.writeFileSync(VAULT_FILE, JSON.stringify({ VLLM_API_KEY: { value } }));
    assert.equal(getSecret('VLLM_API_KEY'), null);
    assert.equal(listVault()[0].set, false);
  }
});

/*
 * The reason the vault exists: one key, every run. Without it each run mints
 * its own, which works but has to be read back off the run before anything can
 * call the endpoint.
 */
test('a vLLM run serves behind the vault key when one is set', () => {
  reset();
  const recipe = recipeById('qwen38-27b-nvfp4-dflash2');

  const minted = apiKeyFor(recipe);
  assert.match(minted, /^sk-[0-9a-f]{48}$/);
  assert.notEqual(apiKeyFor(recipe), minted, 'an unset vault should mint a fresh key each time');

  setSecret('VLLM_API_KEY', KEY);
  assert.equal(apiKeyFor(recipe), KEY);
  assert.equal(apiKeyFor(recipe), KEY, 'the same key on every run, which is the point');
});

test('a runtime that does not authenticate is given no key, vault or not', () => {
  reset();
  setSecret('VLLM_API_KEY', KEY);
  assert.equal(apiKeyFor(recipeById('comfyui-minimax-h3')), null);
});

test.after(() => fs.rmSync(CONFIG_DIR, { recursive: true, force: true }));
