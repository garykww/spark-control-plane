import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { assertRunId, buildRunScript, startRun, cancelRun, stopRun, clearRun } from './planner.js';
import { RECIPES, recipeById, parseRecipes } from './recipes.js';

const NODE = { id: 'n1', name: 'spark-01', type: 'dgx-spark', connection: 'ssh', host: '10.0.0.11', sshUser: 'nvidia' };

/* The one recipe the catalogue ships. */
const KEPT = 'qwen38-27b-nvfp4-dflash2';

/*
 * Every shipped recipe is drafted, so the undrafted path needs a recipe built
 * here. Parsed rather than hand-written, so it goes through the same validation
 * the real catalogue does.
 */
const UNDRAFTED = parseRecipes(`
- id: undrafted
  name: Undrafted
  summary: A recipe with no speculative drafter.
  model:
    repo: Qwen/Qwen3-8B
    sizeGB: 16
    measured: true
  image:
    ref: vllm/vllm-openai:v0.28.0-aarch64
  container: spark-run-undrafted
  port: 8000
  overheadGB: 8
  kvBytesPerToken: 44827
  kvMeasured: true
  args:
    --max-model-len: 32768
    --max-num-seqs: 4
`)[0];
const RUN_ID = 'run-1788000000000-abcd1234';
const API_KEY = `sk-${'a'.repeat(48)}`;

/* What a plan resolves to; the launcher never sees raw request input. */
const TUNING = { contextLength: 262144, maxRequests: 1, gpuMemoryUtilization: 0.37 };

const scriptFor = (recipeId, overrides = {}) =>
  buildRunScript({
    runId: RUN_ID,
    recipe: recipeById(recipeId),
    port: 8000,
    apiKey: API_KEY,
    cpuset: '5-9,15-19',
    tuning: TUNING,
    ...overrides,
  });

/* Everything below rejects before a runner is built, so nothing needs mocking. */

test('assertRunId accepts only ids this module generates', () => {
  assert.equal(assertRunId(RUN_ID), RUN_ID);

  for (const hostile of ['', 'run-x', '../../etc/passwd', 'run-1788000000000-abcd1234; rm -rf /', 'job-1788000000000-abcd1234']) {
    assert.throws(() => assertRunId(hostile), /invalid run id/, `expected "${hostile}" to be rejected`);
  }
});

test('the write actions all validate the run id before touching a runner', async () => {
  for (const action of [cancelRun, stopRun, clearRun]) {
    await assert.rejects(() => action(NODE, 'not-a-run-id'), /invalid run id/);
  }
});

test('startRun refuses an unknown recipe', async () => {
  await assert.rejects(() => startRun(NODE, { recipeId: 'no-such-recipe' }), /unknown recipe/);
});

test('startRun refuses a port outside the valid range', async () => {
  for (const port of [0, -1, 70000, 'eight thousand', 8000.5]) {
    await assert.rejects(
      () => startRun(NODE, { recipeId: KEPT, port, tuning: TUNING }),
      /port must be between/,
      `expected port ${port} to be rejected`,
    );
  }
});

/* The memory fraction is computed against a live reading, so a caller must not
 * be able to assert one - the launcher only ever takes a resolved plan's. */
test('startRun refuses to launch without a resolved plan', async () => {
  for (const tuning of [undefined, {}, { contextLength: 4096 }, { contextLength: 4096, maxRequests: 1 }]) {
    await assert.rejects(
      () => startRun(NODE, { recipeId: KEPT, tuning }),
      /a resolved plan is required/,
    );
  }
});

/*
 * The script is assembled from catalogue strings and run by /bin/sh on the
 * node, where a quoting mistake would surface as a broken command hours into a
 * download. Parsing each one here is the cheapest way to catch that.
 */
test('every recipe produces a script /bin/sh can parse', () => {
  for (const recipe of RECIPES) {
    const script = scriptFor(recipe.id);
    assert.doesNotThrow(
      () => execFileSync('sh', ['-n'], { input: script }),
      `sh could not parse the script for ${recipe.id}`,
    );
  }
});

test('a script with no CPU pinning is still valid shell', () => {
  const script = scriptFor(KEPT, { cpuset: null });
  assert.doesNotThrow(() => execFileSync('sh', ['-n'], { input: script }));
  assert.equal(script.includes('--cpuset-cpus'), false);
});

test('the script walks the phases in order and only ever exits 0 from ready', () => {
  const script = scriptFor(KEPT);
  const phases = [...script.matchAll(/^set_phase (\w+)$/gm)].map((m) => m[1]);

  assert.deepEqual(phases, ['download', 'image', 'launch', 'wait', 'ready']);
  /* Exactly one success path, and it is after the readiness loop. */
  assert.equal(script.match(/finish 0/g).length, 1);
  assert.ok(script.indexOf('set_phase ready') < script.indexOf('finish 0'));
});

/*
 * The two images disagree about their entrypoint: the spark-arena builds set
 * none, while vllm/vllm-openai already runs `vllm serve`. Pinning --entrypoint
 * and passing `serve` is what makes one argv correct for both.
 */
test('the container is launched with a pinned entrypoint and an explicit serve', () => {
  const script = scriptFor(KEPT);
  assert.match(script, /--entrypoint vllm \\\n {2}'vllm\/vllm-openai:v0\.28\.0-aarch64' serve/);
});

test('a drafted recipe fetches both the target and its drafter', () => {
  const script = scriptFor(KEPT);

  assert.match(script, /"\$HF" download 'RadixArk\/Qwen3\.8-27B-NVFP4-BF16-LMHead' --type 'model' --max-workers 8/);
  assert.match(script, /"\$HF" download 'incoai\/Qwen3\.8-27B-DFlash2' --type 'model' --max-workers 8/);
  /* Both blob directories go in `dirs`, which is what the poll sums for the bar. */
  assert.equal(script.match(/>> "\$D\/dirs"/g).length, 2);
});

test('an undrafted recipe fetches only its target', () => {
  const script = buildRunScript({
    runId: RUN_ID,
    recipe: UNDRAFTED,
    port: 8000,
    apiKey: API_KEY,
    cpuset: null,
    tuning: TUNING,
  });

  assert.equal(script.match(/>> "\$D\/dirs"/g).length, 1);
  assert.equal(script.includes('DFlash2'), false);
  assert.doesNotThrow(() => execFileSync('sh', ['-n'], { input: script }));
});

test('every recipe flag reaches the script individually quoted', () => {
  const recipe = recipeById(KEPT);
  const script = scriptFor(recipe.id);

  /* The tuned flags are replaced by design; everything else passes through. */
  const tuned = new Set(['--max-model-len', '--max-num-seqs']);
  for (let i = 0; i < recipe.args.length; i += 1) {
    if (tuned.has(recipe.args[i])) {
      i += 1;
      continue;
    }
    assert.ok(script.includes(`'${recipe.args[i]}'`), `expected ${recipe.args[i]} to be quoted`);
  }
  /* Including the inline JSON, which must survive quoting intact. */
  assert.ok(
    script.includes(
      `'{"method":"dflash","model":"incoai/Qwen3.8-27B-DFlash2","num_speculative_tokens":7}'`,
    ),
  );
});

test('the generated API key is passed to the server and used to probe it', () => {
  const script = scriptFor(KEPT);
  assert.ok(script.includes(`'--api-key' '${API_KEY}'`));
  assert.ok(script.includes(`Authorization: Bearer ${API_KEY}`));
});

/* Removing a container is the one destructive thing the script does, so it must
 * only ever name the container this recipe owns. */
test('the script only ever removes its own container', () => {
  for (const recipe of RECIPES) {
    const removals = [...scriptFor(recipe.id).matchAll(/docker rm -f '([^']+)'/g)].map((m) => m[1]);
    for (const name of removals) {
      assert.equal(name, recipe.containerName, `${recipe.id} would remove ${name}`);
    }
  }
});

test('the readiness wait gives up rather than hanging forever', () => {
  const script = scriptFor(KEPT);
  assert.match(script, /deadline=\$\(\( \$\(date \+%s\) \+ 1800 \)\)/);
  assert.match(script, /did not answer within 30 minutes/);
});

test('a container that exits during startup fails the run with its own logs', () => {
  const script = scriptFor(KEPT);
  assert.match(script, /the container exited during startup/);
  assert.match(script, /docker logs --tail 40/);
});

/*
 * The tuned values have to land in the container's argv, because that is the
 * whole contract of the picker: what the panel priced is what gets served.
 */
test('the tuned context, concurrency and fraction replace the recipe defaults', () => {
  const script = scriptFor(KEPT, {
    tuning: { contextLength: 32768, maxRequests: 2, gpuMemoryUtilization: 0.31 },
  });

  assert.ok(script.includes("'--max-model-len' '32768'"));
  assert.ok(script.includes("'--max-num-seqs' '2'"));
  assert.ok(script.includes("'--gpu-memory-utilization' '0.31'"));

  /* And the recipe's own defaults are gone, not merely appended after. */
  assert.equal(script.includes("'--max-model-len' '262144'"), false);
  assert.equal(script.includes("'--max-num-seqs' '10'"), false);
});

test('each tuned flag appears exactly once', () => {
  const script = scriptFor(KEPT, {
    tuning: { contextLength: 65536, maxRequests: 4, gpuMemoryUtilization: 0.5 },
  });

  for (const flag of ['--max-model-len', '--max-num-seqs', '--gpu-memory-utilization']) {
    assert.equal(script.match(new RegExp(`'${flag}'`, 'g')).length, 1, `${flag} appears more than once`);
  }
});

test('a tuned script is still valid shell for every recipe', () => {
  for (const recipe of RECIPES) {
    const script = scriptFor(recipe.id, {
      tuning: { contextLength: 16384, maxRequests: 8, gpuMemoryUtilization: 0.6 },
    });
    assert.doesNotThrow(() => execFileSync('sh', ['-n'], { input: script }), recipe.id);
  }
});
