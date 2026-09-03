import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertRunId,
  buildRunScript,
  buildRunMeta,
  startRun,
  cancelRun,
  stopRun,
  clearRun,
  SWEEP_FINISHED_RUNS,
} from './planner.js';
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

/*
 * The service launch path. A service brings its own entrypoint, so the script
 * must NOT do any of the things a vLLM launch does - and the two runtimes share
 * one script builder, which is exactly why this is worth pinning down.
 */
const SERVICE = recipeById('comfyui-minimax-h3');

const serviceScript = () =>
  buildRunScript({
    runId: RUN_ID,
    recipe: SERVICE,
    port: SERVICE.port,
    apiKey: null,
    cpuset: null,
    tuning: null,
  });

test('a service script is valid shell', () => {
  assert.doesNotThrow(() => execFileSync('sh', ['-n'], { input: serviceScript() }));
});

test('a service is launched with the image\'s own entrypoint and no serving flags', () => {
  const script = serviceScript();

  assert.equal(script.includes('--entrypoint'), false);
  assert.equal(script.includes(' serve '), false);
  assert.equal(script.includes('--api-key'), false);
  assert.equal(script.includes('--gpu-memory-utilization'), false);
  /* The image is followed only by the recipe's own command, which replaces the
   * image's CMD - never by a vLLM invocation. */
  const declared = SERVICE.command.map((arg) => `'${arg}'`).join(' ');
  assert.match(
    script,
    new RegExp(`'comfyui-minimax-h3:local' ${declared.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')} >> "\\$D/log" 2>&1`),
  );
});

test('a service publishes its own container port and shares the IPC namespace', () => {
  const script = serviceScript();

  assert.ok(script.includes("-p '0.0.0.0:8188:8188'"));
  assert.ok(script.includes('--ipc=host'));
  assert.equal(script.includes('--shm-size'), false);
});

test('declared volumes are created before they are bound', () => {
  const script = serviceScript();

  for (const mount of SERVICE.volumes) {
    const host = mount.host.replace('~', '$HOME');
    assert.ok(script.includes(`mkdir -p "${host}"`), `expected ${mount.host} to be created`);
    assert.ok(script.includes(`-v "${host}":'${mount.container}'`), `expected ${mount.host} bound`);
  }
  /* Created before the bind, or docker makes them root-owned. */
  assert.ok(script.indexOf('mkdir -p') < script.indexOf('docker run'));
});

/*
 * Weights go to the HuggingFace cache like any other repo, so the cache panel
 * can manage them - and are then bound into the container one file at a time,
 * because the cache's blob-and-symlink layout is not one ComfyUI can read.
 */
test('a service fetches its weights into the HuggingFace cache', () => {
  const script = serviceScript();

  assert.equal(script.includes('--local-dir'), false);
  assert.equal(script.match(/--include /g).length, SERVICE.weights[0].files.length);
  /* Its total is the declared figure - a dry run would price the whole repo,
   * which holds every quantisation tier. */
  assert.equal(script.includes('--dry-run'), false);
});

test('the snapshot path is resolved on the node, not hardcoded', () => {
  const script = serviceScript();

  /* The commit sha changes when the repo is updated, so it is read from the
   * repo's own refs/main rather than baked in here. */
  assert.match(script, /REV_0="\$\(cat "\$REPO_0\/refs\/main" 2>\/dev\/null\)"/);
  assert.match(script, /SNAP_0="\$REPO_0\/snapshots\/\$REV_0"/);
  assert.match(script, /is not in the HuggingFace cache on this node/);
  /* Resolved before the run that uses it. */
  assert.ok(script.indexOf('SNAP_0=') < script.indexOf('docker run'));
});

test('every weight file is mounted read-only onto the path the service expects', () => {
  const script = serviceScript();
  const entry = SERVICE.weights[0];

  for (const file of entry.files) {
    assert.ok(
      script.includes(`-v "$SNAP_0/${file}":'${entry.mountBase}/${file}':ro`),
      `expected ${file} to be mounted`,
    );
  }
  assert.equal(script.match(/:ro/g).length, entry.files.length);
});

test('a service is probed without an Authorization header', () => {
  const script = serviceScript();

  assert.ok(script.includes('"http://127.0.0.1:8188/system_stats"'));
  assert.equal(script.includes('Authorization: Bearer'), false);
});

test('startRun mints no API key for a runtime that does not authenticate', async () => {
  /* It still refuses before reaching a runner, so the port check stands in as
   * proof that the tuning guard did not fire for a service. */
  await assert.rejects(
    () => startRun(NODE, { recipeId: 'comfyui-minimax-h3', port: 0 }),
    /port must be between/,
  );
});

/*
 * The state a launch leaves on the node. This is where the two runtimes diverge
 * most quietly - a service has no `model` at all - and reaching through it was
 * a real crash: "Cannot read properties of null (reading 'repoId')", raised
 * only once a launch got past validation, which no test had done.
 */
test('run metadata is built for both runtimes without reaching through a null model', () => {
  for (const recipe of RECIPES) {
    const meta = buildRunMeta({
      runId: RUN_ID,
      recipe,
      port: recipe.port,
      apiKey: recipe.readiness.auth === 'bearer' ? API_KEY : null,
      tuning: recipe.runtime === 'vllm' ? TUNING : null,
    });

    assert.equal(meta.recipeId, recipe.id);
    assert.equal(meta.containerName, recipe.containerName);
    assert.equal(meta.imageRef, recipe.image.ref);
    /* Every recipe names the repo its weights come from, whichever field holds it. */
    assert.ok(meta.modelRepoId, `${recipe.id} reported no model repo`);
    assert.ok(JSON.parse(JSON.stringify(meta)), `${recipe.id} metadata is not serialisable`);
  }
});

test('a service carries no tuning or key in its metadata', () => {
  const meta = buildRunMeta({ runId: RUN_ID, recipe: SERVICE, port: 8188, apiKey: null, tuning: null });

  assert.equal(meta.modelRepoId, 'Comfy-Org/MiniMax-H3');
  assert.equal(meta.apiKey, null);
  assert.equal(meta.contextLength, null);
  assert.equal(meta.maxRequests, null);
  assert.equal(meta.gpuMemoryUtilization, null);
});

test('a vllm run records what it was priced at, so the panel can show it back', () => {
  const meta = buildRunMeta({
    runId: RUN_ID,
    recipe: recipeById(KEPT),
    port: 8000,
    apiKey: API_KEY,
    tuning: TUNING,
  });

  assert.equal(meta.contextLength, TUNING.contextLength);
  assert.equal(meta.maxRequests, TUNING.maxRequests);
  assert.equal(meta.gpuMemoryUtilization, TUNING.gpuMemoryUtilization);
  assert.equal(meta.apiKey, API_KEY);
});

test('a declared command replaces the image CMD, and a recipe without one adds nothing', () => {
  /* Asserted against whatever the recipe declares, not a particular flag - the
   * mechanism is the contract, and the flags are free to change. */
  const script = serviceScript();
  assert.ok(SERVICE.command.length > 0, 'fixture recipe should declare a command');
  for (const arg of SERVICE.command) {
    assert.ok(script.includes(`'${arg}'`), `expected ${arg} in the run`);
  }

  /* A vLLM recipe declares none, so nothing of the sort is appended to its argv. */
  const vllm = recipeById(KEPT);
  assert.deepEqual(vllm.command, []);
  assert.equal(scriptFor(KEPT).includes("' --listen '"), false);
});

/*
 * The sweep, run for real against a fake node.
 *
 * Reading the string would only prove it says what it says; the thing worth
 * knowing is what it DELETES, and that depends on `find -mmin`, a glob and a
 * `grep -qxF` all agreeing. So this builds a runs directory, puts a stub
 * `docker` on PATH, points HOME at it, and checks what survives.
 */
test('the sweep discards spent runs and spares one that is still serving', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-test-'));
  const runs = path.join(home, '.cache/spark-control-plane/runs');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(runs, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });

  /* Only this one is up. `docker ps --format` prints one name per line. */
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nprintf "%s\\n" still-serving other-thing\n');
  fs.chmodSync(path.join(bin, 'docker'), 0o755);

  const A_DAY_AGO = new Date(Date.now() - 48 * 3600 * 1000);
  const make = (name, container, { finished = true, old = true } = {}) => {
    const dir = path.join(runs, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'container'), container);
    if (finished) fs.writeFileSync(path.join(dir, 'exit'), '0\n');
    if (old) fs.utimesSync(dir, A_DAY_AGO, A_DAY_AGO);
  };

  make('run-1788000000001-aaaaaaaa', 'still-serving');
  make('run-1788000000002-bbbbbbbb', 'gone');
  make('run-1788000000003-cccccccc', 'gone-too', { old: false });
  make('run-1788000000004-dddddddd', 'in-flight', { finished: false });

  execFileSync('sh', ['-c', SWEEP_FINISHED_RUNS], {
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });

  const left = fs.readdirSync(runs).sort();
  assert.deepEqual(left, [
    /* Finished and a day old, but its container is still up: the only record of
     * where that model is serving and of the key it minted. */
    'run-1788000000001-aaaaaaaa',
    /* Spent, but not yet a day old. */
    'run-1788000000003-cccccccc',
    /* No exit file - still working. */
    'run-1788000000004-dddddddd',
  ]);

  fs.rmSync(home, { recursive: true, force: true });
});

test('the sweep is valid shell and is what a launch actually runs', () => {
  assert.doesNotThrow(() => execFileSync('sh', ['-n'], { input: SWEEP_FINISHED_RUNS }));
  /* Guards the join in startRun's command: a missing separator would swallow
   * the `echo launched` the launch route checks for. */
  assert.ok(SWEEP_FINISHED_RUNS.trimEnd().endsWith(';'), SWEEP_FINISHED_RUNS);
});
