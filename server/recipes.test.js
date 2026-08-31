import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RECIPES,
  RECIPES_ERROR,
  ARG_RE,
  parseRecipes,
  loadRecipes,
  resolveArgs,
  recipeById,
  planRecipe,
  buildPlanner,
  memoryPool,
  cacheMount,
} from './recipes.js';

const GB = 1e9;
const SPARK_MEMORY = 128 * 1024 ** 3;

/* A node with room for anything, which each test then takes something away from. */
const roomyNode = (overrides = {}) => ({
  online: true,
  type: 'dgx-spark',
  gpus: [{ isUnified: true }],
  memory: { total: SPARK_MEMORY, used: 4 * GB, available: SPARK_MEMORY - 4 * GB },
  dockerAvailable: true,
  dockerError: null,
  dockerImages: ['vllm/vllm-openai:v0.28.0-aarch64'],
  containers: [],
  storage: [{ mount: '/', available: 2000 * GB }],
  hf: { available: true, user: 'someone', repos: [], cacheDir: '/home/nvidia/.cache/huggingface' },
  ...overrides,
});

const plan = (recipeId, node, runs = [], tuning = {}) =>
  planRecipe(recipeById(recipeId), node, runs, tuning);

/*
 * The catalogue ships one recipe, so anything that needs a different SHAPE - a
 * model too big for the box, an unmeasured figure, a shorter native context -
 * builds one here rather than depending on what happens to be bundled. That
 * also keeps these tests honest if the catalogue changes again.
 */
const MINIMAL = `
- id: tiny
  name: Tiny
  summary: A small recipe.
  model:
    repo: Qwen/Qwen3-8B
    sizeGB: 16
    measured: true
  image:
    ref: vllm/vllm-openai:v0.28.0-aarch64
  container: spark-run-tiny
  port: 8000
  overheadGB: 8
  kvBytesPerToken: 44827
  kvMeasured: true
  args:
    --max-model-len: 32768
    --max-num-seqs: 4
    --trust-remote-code: true
`;

const withArgs = (yaml) => parseRecipes(MINIMAL.replace(/  args:\n(    .*\n)+/, yaml));

/* Builds a one-off recipe from the fixture, with fields replaced. */
const fixture = (replacements = {}) => {
  let yaml = MINIMAL;
  for (const [from, to] of Object.entries(replacements)) {
    if (!yaml.includes(from)) throw new Error(`fixture has no "${from}" to replace`);
    yaml = yaml.replace(from, to);
  }
  return parseRecipes(yaml)[0];
};

const planOf = (recipe, node, runs = [], tuning = {}) => planRecipe(recipe, node, runs, tuning);

/* The one recipe the catalogue ships. */
const KEPT = 'qwen38-27b-nvfp4-dflash2';
const codes = (issues) => issues.map((issue) => issue.code);

/*
 * The catalogue is hand-edited YAML, so these are the guard that a typo in it
 * cannot smuggle something unquotable onto a command line, name an image the
 * launcher would mangle, or silently drop half the file.
 */
test('the bundled recipes.yaml loads cleanly', () => {
  assert.equal(RECIPES_ERROR, null, `recipes.yaml failed to load: ${RECIPES_ERROR}`);
  assert.ok(RECIPES.length > 0);
});

test('recipe ids are unique, so one cannot shadow another', () => {
  const ids = RECIPES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('no recipe argument can escape the quotes the launcher wraps it in', () => {
  const hostile = ["a'b", 'a`b', 'a$b', 'a;b', 'a|b', 'a&b', 'a\nb', 'a>b', 'a(b)'];
  for (const value of hostile) {
    assert.equal(ARG_RE.test(value), false, `expected ARG_RE to reject ${JSON.stringify(value)}`);
  }
  /* And still admits the shapes real flags take, including inline JSON. */
  for (const value of [
    'RadixArk/Qwen3.8-27B-NVFP4-BF16-LMHead',
    '--gpu-memory-utilization',
    '0.92',
    '{"method":"mtp","num_speculative_tokens":3}',
  ]) {
    assert.equal(ARG_RE.test(value), true, `expected ARG_RE to accept ${value}`);
  }
});


test('recipeById refuses an unknown id rather than returning undefined', () => {
  assert.throws(() => recipeById('no-such-recipe'), /unknown recipe/);
  assert.equal(recipeById(KEPT).id, KEPT);
});

test('an idle Spark fits every recipe in the catalogue', () => {
  const { plans } = buildPlanner(roomyNode(), []);
  for (const entry of plans) {
    assert.equal(entry.fits, true, `${entry.recipeId} blocked by ${codes(entry.blockers).join(',')}`);
  }
});

/*
 * The core promise of the panel: a recipe whose weights plus working set exceed
 * free memory is refused, and the message says by how much.
 */
test('a recipe larger than free memory is blocked', () => {
  const node = roomyNode({
    memory: { total: SPARK_MEMORY, used: 100 * GB, available: 30 * GB },
  });
  const entry = planOf(fixture({ 'sizeGB: 16': 'sizeGB: 60' }), node);

  assert.equal(entry.fits, false);
  assert.ok(codes(entry.blockers).includes('memory'));
  assert.match(entry.blockers.find((b) => b.code === 'memory').message, /unified memory/);
});

/*
 * vLLM's own startup check, which is the one that actually refuses: it compares
 * its utilisation fraction of TOTAL memory against FREE memory. This is why the
 * reference script runs at 0.92 and not the SGLang recipe's 0.95.
 */
/*
 * The failure the whole feature exists to remove: a fixed fraction of TOTAL
 * memory checked against FREE memory. Computing the minimum makes it
 * unreachable automatically, so it can only be reached by overriding upward.
 */
test('an overridden fraction that exceeds free memory is refused', () => {
  const node = roomyNode({
    memory: { total: SPARK_MEMORY, used: SPARK_MEMORY - 70 * GB, available: 70 * GB },
  });

  /* Left alone, the recipe simply sizes itself to fit. */
  const automatic = plan(KEPT, node);
  assert.equal(automatic.fits, true);
  assert.equal(automatic.tuning.automatic, true);
  assert.ok(automatic.tuning.gpuMemoryUtilization < 0.6);

  /* Asking for the old hardcoded 0.92 reintroduces exactly the old failure. */
  const forced = plan(KEPT, node, [], { gpuMemoryUtilization: 0.92 });
  assert.equal(forced.fits, false);
  assert.ok(codes(forced.blockers).includes('gpu-memory-utilization'));
  assert.equal(forced.tuning.automatic, false);
});

test('a full cache filesystem blocks the download rather than failing hours in', () => {
  const node = roomyNode({ storage: [{ mount: '/', available: 5 * GB }] });
  const entry = plan(KEPT, node);

  assert.ok(codes(entry.blockers).includes('disk'));
  /* The target plus its drafter: 23.8 + 3.8 GB. */
  assert.match(entry.blockers.find((b) => b.code === 'disk').message, /needs 27\.6 GB/);
});

test('cached weights cost no disk and raise no download warning', () => {
  const node = roomyNode({
    hf: {
      available: true,
      user: 'someone',
      cacheDir: '/home/nvidia/.cache/huggingface',
      repos: [
        { repoId: 'RadixArk/Qwen3.8-27B-NVFP4-BF16-LMHead' },
        { repoId: 'incoai/Qwen3.8-27B-DFlash2' },
      ],
    },
  });
  const entry = plan(KEPT, node);

  assert.equal(entry.disk.downloadBytes, 0);
  assert.equal(entry.repos[0].cached, true);
  assert.equal(codes(entry.warnings).includes('download'), false);
});

test('a partly cached recipe only counts the half it still has to fetch', () => {
  const node = roomyNode({
    hf: {
      available: true,
      user: 'someone',
      cacheDir: '/home/nvidia/.cache/huggingface',
      /* The target is here; the drafter is not. */
      repos: [{ repoId: 'RadixArk/Qwen3.8-27B-NVFP4-BF16-LMHead' }],
    },
  });
  const entry = plan(KEPT, node);

  assert.equal(entry.repos.filter((r) => r.cached).length, 1);
  /* The drafter alone: 3.77 GiB, not the 20 GB the pair would cost. */
  assert.ok(entry.disk.downloadBytes < 5 * GB, `expected only the drafter, got ${entry.disk.downloadBytes}`);
  assert.match(entry.warnings.find((w) => w.code === 'download').message, /DFlash2 is not cached/);
});

test('a container already holding the port blocks the run', () => {
  const node = roomyNode({
    containers: [{ name: 'vllm-other', state: 'running', ports: ['8000->8000/tcp'] }],
  });
  const entry = plan(KEPT, node);

  assert.equal(entry.fits, false);
  assert.match(entry.blockers.find((b) => b.code === 'port').message, /already published by "vllm-other"/);
});

/* `docker ps` lists exposed ports as "8000/tcp" with no arrow. Nothing is bound
 * on the host, so nothing is in the way. */
test('a merely exposed port is not a conflict', () => {
  const node = roomyNode({
    containers: [{ name: 'vllm-other', state: 'running', ports: ['8000/tcp'] }],
  });
  assert.equal(plan(KEPT, node).fits, true);
});

test('a stopped container on the port is not in the way', () => {
  const node = roomyNode({
    containers: [{ name: 'vllm-other', state: 'exited', ports: ['8000->8000/tcp'] }],
  });
  assert.equal(plan(KEPT, node).fits, true);
});

/* Re-running the same recipe replaces its own container, so its own name is not
 * treated as a conflict. */
test('the recipe’s own container does not block re-running it', () => {
  const node = roomyNode({
    containers: [
      { name: 'spark-run-qwen38-nvfp4-dflash2', state: 'running', ports: ['8000->8000/tcp'] },
    ],
  });
  assert.equal(plan(KEPT, node).fits, true);
});

test('a run already in flight blocks every recipe', () => {
  const runs = [{ status: 'downloading', recipeName: 'Qwen3.8-27B · NVFP4 + MTP' }];
  const { plans } = buildPlanner(roomyNode(), runs);

  for (const entry of plans) {
    assert.ok(codes(entry.blockers).includes('run-active'), entry.recipeId);
  }
  /* A finished run does not. */
  assert.equal(plan(KEPT, roomyNode(), [{ status: 'ready' }]).fits, true);
});

test('missing tooling is reported as the specific thing that is missing', () => {
  const noDocker = plan(KEPT, roomyNode({ dockerAvailable: false, dockerError: 'the Docker daemon is not running' }));
  assert.equal(noDocker.blockers.find((b) => b.code === 'docker').message, 'the Docker daemon is not running');

  const noHf = plan(
    KEPT,
    roomyNode({ hf: { available: false, repos: [], cacheDir: null } }),
  );
  assert.ok(codes(noHf.blockers).includes('hf'));
});

/* hf is only needed to fetch something. A fully cached recipe runs without it. */
test('a cached recipe does not need the hf CLI', () => {
  const node = roomyNode({
    hf: {
      available: false,
      repos: [
        { repoId: 'RadixArk/Qwen3.8-27B-NVFP4-BF16-LMHead' },
        { repoId: 'incoai/Qwen3.8-27B-DFlash2' },
      ],
      cacheDir: null,
    },
  });
  assert.equal(codes(plan(KEPT, node).blockers).includes('hf'), false);
});

test('an anonymous Hub session is a warning, not a refusal', () => {
  const node = roomyNode({
    hf: { available: true, user: null, repos: [], cacheDir: '/home/nvidia/.cache/huggingface' },
  });
  const entry = plan(KEPT, node);

  assert.equal(entry.fits, true);
  assert.ok(codes(entry.warnings).includes('hf-anonymous'));
});

test('an offline node fits nothing', () => {
  const { plans } = buildPlanner(roomyNode({ online: false }), []);
  for (const entry of plans) assert.equal(entry.fits, false, entry.recipeId);
});

test('a measured weight figure carries no estimate warning', () => {
  /* Both of this recipe's exports were read off a real cache. */
  assert.equal(codes(plan(KEPT, roomyNode()).warnings).includes('estimate'), false);
  /* A size derived from a parameter count says so instead. */
  const guessed = fixture({ 'measured: true': 'measured: false' });
  assert.ok(codes(planOf(guessed, roomyNode()).warnings).includes('estimate'));
});

test('an image already on the node raises no pull warning', () => {
  assert.equal(plan(KEPT, roomyNode()).imagePresent, true);

  const missing = plan(KEPT, roomyNode({ dockerImages: [] }));
  assert.equal(missing.imagePresent, false);
  assert.ok(codes(missing.warnings).includes('image'));
});

/*
 * On GB10 there is no separate VRAM - nvidia-smi reports [N/A] - so the pool
 * that matters is the host's. On a discrete GPU it is the card's own memory and
 * host RAM is irrelevant.
 */
test('the memory pool follows the hardware, not the host', () => {
  const unified = memoryPool(roomyNode());
  assert.equal(unified.unified, true);
  assert.equal(unified.totalBytes, SPARK_MEMORY);

  const discrete = memoryPool({
    type: 'gpu-host',
    gpus: [{ isUnified: false, memoryTotal: 48 * GB, memoryUsed: 8 * GB }],
    memory: { total: SPARK_MEMORY, used: 4 * GB, available: 100 * GB },
  });
  assert.equal(discrete.unified, false);
  assert.equal(discrete.totalBytes, 48 * GB);
  assert.equal(discrete.availableBytes, 40 * GB);
});

test('memory that has not been read yet blocks rather than reading as zero', () => {
  const entry = plan(KEPT, roomyNode({ memory: undefined, gpus: [] }));
  assert.ok(codes(entry.blockers).includes('memory-unknown'));
});

test('the cache lands on the longest mount that covers it, not the first', () => {
  const node = {
    hf: { cacheDir: '/mnt/nvme/hf' },
    storage: [
      { mount: '/', available: 10 * GB },
      { mount: '/mnt', available: 20 * GB },
      { mount: '/mnt/nvme', available: 900 * GB },
    ],
  };
  assert.equal(cacheMount(node).mount, '/mnt/nvme');
});

test('the cache falls back to root when no mount covers it', () => {
  const node = { hf: { cacheDir: '/home/nvidia/.cache/huggingface' }, storage: [{ mount: '/', available: 900 * GB }] };
  assert.equal(cacheMount(node).mount, '/');
});

/*
 * The recipe file is hand-edited, which makes it the one place a typo can reach
 * a shell command on the node. These are the tests for that boundary: what the
 * loader accepts, what it refuses, and that it refuses the whole file rather
 * than quietly applying the half that parsed.
 */

test('a minimal recipe loads and derives its figures from its own flags', () => {
  const [recipe] = parseRecipes(MINIMAL);

  assert.equal(recipe.id, 'tiny');
  /* Declared nowhere but the flags themselves, so they cannot drift from them. */
  assert.equal(recipe.contextLength, 32768);
  assert.equal(recipe.concurrency, 4);
  assert.equal(recipe.memory.weightsBytes, 16e9);
  assert.equal(recipe.memory.overheadBytes, 8e9);
  assert.equal(recipe.memory.kvBytesPerToken, 44827);
});

/* The fraction is computed from what is actually asked for, so a recipe that
 * pinned it would quietly defeat the whole picker. */
test('a recipe that pins the memory fraction is refused', () => {
  assert.throws(
    () => withArgs('  args:\n    --gpu-memory-utilization: 0.9\n'),
    /do not set --gpu-memory-utilization/,
  );
});

test('the model id is passed positionally and served under its own name', () => {
  const [recipe] = parseRecipes(MINIMAL);

  assert.equal(recipe.args[0], 'Qwen/Qwen3-8B');
  assert.deepEqual(recipe.args.slice(1, 3), ['--served-model-name', 'Qwen/Qwen3-8B']);
});

test('servedName overrides the default without repeating the repo id', () => {
  const [recipe] = parseRecipes(MINIMAL.replace('  container:', '  servedName: qwen3\n  container:'));
  assert.deepEqual(recipe.args.slice(1, 3), ['--served-model-name', 'qwen3']);
});

test('an explicit --served-model-name is not overridden', () => {
  const [recipe] = withArgs('  args:\n    --served-model-name: mine\n');
  assert.equal(recipe.args.filter((a) => a === '--served-model-name').length, 1);
  assert.ok(recipe.args.includes('mine'));
});

/* A bare flag is `true`; `false` turns one off without deleting the line. */
test('flag values become argv, and false omits the flag entirely', () => {
  const [recipe] = withArgs('  args:\n    --trust-remote-code: true\n    --enable-prefix-caching: false\n    --kv-cache-dtype: fp8\n');

  assert.ok(recipe.args.includes('--trust-remote-code'));
  assert.equal(recipe.args.includes('--enable-prefix-caching'), false);
  assert.deepEqual(recipe.args.slice(-2), ['--kv-cache-dtype', 'fp8']);
});

test('inline JSON survives the round trip as one argument', () => {
  const [recipe] = withArgs('  args:\n    --speculative-config: \'{"method":"mtp","num_speculative_tokens":3}\'\n');
  assert.ok(recipe.args.includes('{"method":"mtp","num_speculative_tokens":3}'));
});

test('a flag a recipe never set reads as "left to vLLM", not as zero', () => {
  const [recipe] = withArgs('  args:\n    --max-model-len: 4096\n');
  assert.equal(recipe.concurrency, null);
});

test('an estimated drafter makes the whole recipe an estimate', () => {
  const yaml = MINIMAL.replace('  container:', '  draft:\n    repo: incoai/Drafter\n    sizeGB: 4\n    measured: false\n  container:');
  const [recipe] = parseRecipes(yaml);

  assert.equal(recipe.memory.draftBytes, 4e9);
  assert.equal(recipe.memory.weightsMeasured, false);
});

test('anything that could escape its quoting is refused by recipe id', () => {
  const hostile = [
    ["repo: Qwen/Qwen3-8B", "repo: \"Qwen/X'; rm -rf /\""],
    ["container: spark-run-tiny", "container: 'tiny; rm -rf /'"],
    ["ref: vllm/vllm-openai:v0.28.0-aarch64", "ref: 'vllm:$(whoami)'"],
    ["--max-model-len: 32768", "--max-model-len: \"$(id)\""],
  ];

  for (const [from, to] of hostile) {
    assert.throws(
      () => parseRecipes(MINIMAL.replace(from, to)),
      /recipe "tiny"/,
      `expected ${to} to be refused`,
    );
  }
});

test('a flag that is not a flag is refused', () => {
  assert.throws(() => withArgs('  args:\n    "; rm -rf /": true\n'), /is not a valid vLLM flag/);
  assert.throws(() => withArgs('  args:\n    max-model-len: 4096\n'), /is not a valid vLLM flag/);
});

test('missing and malformed fields are reported by name', () => {
  const cases = [
    ['- id: tiny', '- id: Tiny_Recipe', /must be lowercase kebab-case/],
    ['    sizeGB: 16', '    sizeGB: 0', /sizeGB must be a positive number/],
    ['    sizeGB: 16', '    sizeGB: huge', /sizeGB must be a positive number/],
    ['  port: 8000', '  port: 70000', /port must be between 1 and 65535/],
    ['  overheadGB: 8', '  overheadGB: -1', /overheadGB must be a number/],
    ['  kvBytesPerToken: 44827', '  kvBytesPerToken: 0', /kvBytesPerToken must be a positive/],
    ['  name: Tiny', '  name: ""', /name is required/],
  ];

  for (const [from, to, pattern] of cases) {
    assert.throws(() => parseRecipes(MINIMAL.replace(from, to)), pattern, `expected ${to} to be refused`);
  }
});

test('a recipe missing its model or image is refused rather than half-built', () => {
  assert.throws(() => parseRecipes(MINIMAL.replace(/  model:\n(    .*\n)+/, '')), /model is required/);
  assert.throws(() => parseRecipes(MINIMAL.replace(/  image:\n    ref: .*\n/, '')), /image is required/);
});

test('duplicate ids are refused, so one recipe cannot shadow another', () => {
  assert.throws(() => parseRecipes(MINIMAL + MINIMAL), /duplicate recipe id "tiny"/);
});

/* One bad entry must take the whole file down: silently dropping it would hide
 * the recipe somebody just edited. */
test('one invalid recipe refuses the entire catalogue', () => {
  const yaml = MINIMAL + MINIMAL.replace('id: tiny', 'id: broken').replace('  port: 8000', '  port: 0');
  assert.throws(() => parseRecipes(yaml), /port must be between/);
});

test('a build block is accepted, and its steps are validated too', () => {
  const yaml = MINIMAL.replace(
    '    ref: vllm/vllm-openai:v0.28.0-aarch64',
    '    ref: local/patched-vllm:1\n    build:\n      from: vllm/vllm-openai:v0.28.0-aarch64\n      run:\n        - pip install flashinfer',
  );
  const [recipe] = parseRecipes(yaml);
  assert.equal(recipe.image.ref, 'local/patched-vllm:1');
  assert.deepEqual(recipe.image.build.run, ['pip install flashinfer']);

  assert.throws(() => parseRecipes(yaml.replace('pip install flashinfer', 'pip install `id`')), /cannot be quoted/);
});

test('malformed YAML is reported as such, not as an empty catalogue', () => {
  assert.throws(() => parseRecipes('- id: tiny\n   bad indent: ['), /could not parse YAML/);
  assert.throws(() => parseRecipes('nope: not a list'), /must contain a list/);
});

test('an empty file is no recipes rather than an error', () => {
  assert.deepEqual(parseRecipes(''), []);
  assert.deepEqual(parseRecipes('# just a comment\n'), []);
});

/*
 * Loading never throws: a typo in the recipe file must not stop the dashboard
 * from monitoring, which is the primary job and unrelated to recipes.
 */
test('loadRecipes reports a missing file instead of throwing', () => {
  const result = loadRecipes('/nonexistent/recipes.yaml');
  assert.deepEqual(result.recipes, []);
  assert.match(result.error, /no recipe file at/);
});

test('loadRecipes reports an invalid file instead of throwing', () => {
  const result = loadRecipes(new URL('./recipes.test.js', import.meta.url).pathname);
  assert.deepEqual(result.recipes, []);
  assert.ok(result.error);
});

/*
 * The picker's arithmetic. vLLM's fraction is a policy, not a requirement, so
 * the planner works out the smallest one that covers what is being asked for.
 * These are the tests that the estimate actually tracks the knobs.
 */

test('the estimate scales with the context length', () => {
  const node = roomyNode();
  const at = (contextLength) => plan(KEPT, node, [], { contextLength, maxRequests: 1 });

  const short = at(32768);
  const long = at(262144);

  /* Eight times the context, eight times the KV cache. */
  assert.equal(long.memory.kvBytes / short.memory.kvBytes, 8);
  assert.ok(long.tuning.gpuMemoryUtilization > short.tuning.gpuMemoryUtilization);
  /* Weights and overhead do not move with it. */
  assert.equal(long.memory.weightsBytes, short.memory.weightsBytes);
  assert.equal(long.memory.overheadBytes, short.memory.overheadBytes);
});

test('the estimate scales with the request count', () => {
  const node = roomyNode();
  const at = (maxRequests) => plan(KEPT, node, [], { contextLength: 32768, maxRequests });

  assert.equal(at(4).memory.kvBytes / at(1).memory.kvBytes, 4);
  assert.equal(at(4).memory.kvTokens, 4 * 32768);
});

test('the computed fraction is the smallest one that covers the request', () => {
  const node = roomyNode();
  const entry = plan(KEPT, node, [], { contextLength: 32768, maxRequests: 1 });

  assert.equal(entry.tuning.automatic, true);
  assert.equal(entry.tuning.gpuMemoryUtilization, entry.tuning.minUtilization);

  /* It covers the requirement, and by less than a rounding step. */
  assert.ok(entry.memory.claimBytes >= entry.memory.requiredBytes);
  assert.ok(entry.memory.claimBytes - entry.memory.requiredBytes < 0.01 * entry.memory.totalBytes);
});

test('an override is honoured when it clears the minimum', () => {
  const node = roomyNode();
  const entry = plan(KEPT, node, [], {
    contextLength: 32768,
    maxRequests: 1,
    gpuMemoryUtilization: 0.8,
  });

  assert.equal(entry.fits, true);
  assert.equal(entry.tuning.automatic, false);
  assert.equal(entry.tuning.gpuMemoryUtilization, 0.8);
  /* The surplus over the minimum is prefix cache, not a requirement. */
  assert.ok(entry.memory.claimBytes > entry.memory.requiredBytes);
});

test('an override below the minimum is refused, and says what the minimum is', () => {
  const node = roomyNode();
  const entry = plan(KEPT, node, [], {
    contextLength: 262144,
    maxRequests: 1,
    gpuMemoryUtilization: 0.1,
  });

  assert.equal(entry.fits, false);
  const blocker = entry.blockers.find((b) => b.code === 'utilization-too-low');
  assert.ok(blocker, 'expected a utilization-too-low blocker');
  assert.match(blocker.message, new RegExp(`${entry.tuning.minUtilization} is the minimum`));
});

/* Asking for more than the box can hold has to fail, and shortening the context
 * has to be enough to fix it - that is the trade the picker exists to expose. */
test('an impossible context and concurrency is blocked, and shrinking it clears', () => {
  const node = roomyNode();

  const greedy = plan(KEPT, node, [], { contextLength: 262144, maxRequests: 32 });
  assert.equal(greedy.fits, false);
  assert.ok(codes(greedy.blockers).includes('memory'));

  const modest = plan(KEPT, node, [], { contextLength: 16384, maxRequests: 32 });
  assert.equal(modest.fits, true);
});

test('the context is capped at what the recipe declares', () => {
  const node = roomyNode();
  /* Beyond a model's native window needs rope scaling, which is a different
   * question from how much memory it takes. */
  const entry = plan(KEPT, node, [], { contextLength: 4_000_000 });
  assert.equal(entry.tuning.contextLength, 262144);
});

test('nonsense tuning falls back to the recipe defaults', () => {
  const node = roomyNode();
  const recipe = recipeById(KEPT);

  for (const tuning of [{}, { contextLength: 0 }, { contextLength: -5, maxRequests: 'lots' }]) {
    const entry = plan(KEPT, node, [], tuning);
    assert.equal(entry.tuning.contextLength, recipe.contextLength);
    assert.equal(entry.tuning.maxRequests, recipe.concurrency);
  }
});

test('the picker offers only context lengths the recipe supports', () => {
  const node = roomyNode();
  /* The fixture declares --max-model-len 32768, so nothing longer is offered. */
  const entry = planOf(fixture(), node);

  assert.ok(entry.tuning.contextOptions.every((value) => value <= 32768));
  assert.ok(entry.tuning.contextOptions.includes(32768));
  assert.ok(entry.tuning.requestOptions.includes(1));

  /* The shipped recipe runs to its own, longer ceiling. */
  assert.equal(Math.max(...plan(KEPT, node).tuning.contextOptions), 262144);
});

test('an estimated KV rate is labelled, because the estimate moves with it', () => {
  const node = roomyNode();
  /* An unmeasured per-token rate is worth saying, because every figure on the
   * bar scales with it. */
  const guessed = fixture({ 'kvMeasured: true': 'kvMeasured: false' });
  assert.ok(codes(planOf(guessed, node).warnings).includes('kv-estimate'));
  /* The shipped recipe's rate came off a real startup log. */
  assert.equal(codes(plan(KEPT, node).warnings).includes('kv-estimate'), false);
});

test('resolveArgs puts the tuned values into the argv exactly once', () => {
  const recipe = recipeById(KEPT);
  const args = resolveArgs(recipe, { contextLength: 8192, maxRequests: 3, gpuMemoryUtilization: 0.25 });

  const valueOf = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(valueOf('--max-model-len'), '8192');
  assert.equal(valueOf('--max-num-seqs'), '3');
  assert.equal(valueOf('--gpu-memory-utilization'), '0.25');

  for (const flag of ['--max-model-len', '--max-num-seqs', '--gpu-memory-utilization']) {
    assert.equal(args.filter((a) => a === flag).length, 1, `${flag} appears more than once`);
  }
  /* The model is still the positional first argument. */
  assert.equal(args[0], recipe.model.repoId);
});

/*
 * Service recipes: a container that wants a GPU rather than a vLLM server. The
 * interesting cases are the ones where the two runtimes must NOT share
 * behaviour - no serving flags, no memory fraction, weights in a directory of
 * their own rather than the HuggingFace cache.
 */

const SERVICE = `
- id: comfy
  runtime: service
  name: ComfyUI
  summary: A container that brings its own entrypoint.
  image:
    ref: comfyui:local
  container: comfy
  port: 8188
  containerPort: 8188
  ipcHost: true
  memoryGB: 40
  memoryMeasured: false
  readiness:
    path: /system_stats
    auth: none
  volumes:
    - host: ~/comfy-output
      container: /workspace/ComfyUI/output
  weights:
    - repo: Comfy-Org/MiniMax-H3
      sizeGB: 60
      measured: true
      mountBase: /workspace/ComfyUI/models
      files:
        - diffusion_models/a.safetensors
`;

const service = (replacements = {}) => {
  let yaml = SERVICE;
  for (const [from, to] of Object.entries(replacements)) {
    if (!yaml.includes(from)) throw new Error(`fixture has no "${from}" to replace`);
    yaml = yaml.replace(from, to);
  }
  return parseRecipes(yaml)[0];
};

test('a service recipe loads with its own entrypoint, port and readiness probe', () => {
  const recipe = service();

  assert.equal(recipe.runtime, 'service');
  assert.equal(recipe.containerPort, 8188);
  assert.deepEqual(recipe.readiness, { path: '/system_stats', auth: 'none' });
  assert.equal(recipe.ipcHost, true);
  /* No serving flags at all - the image knows how to start itself. */
  assert.deepEqual(recipe.args, []);
  assert.equal(recipe.model, null);
});

test('the two runtimes default their container port and readiness differently', () => {
  const vllm = recipeById(KEPT);
  assert.equal(vllm.containerPort, 8000);
  assert.deepEqual(vllm.readiness, { path: '/v1/models', auth: 'bearer' });
});

test('a service reserves the figure it declares, with nothing to tune', () => {
  const entry = planOf(service(), roomyNode());

  assert.equal(entry.memory.requiredBytes, 40e9);
  assert.equal(entry.memory.kvBytes, 0);
  /* No fraction: a service allocates as it works rather than reserving a block. */
  assert.equal(entry.memory.claimBytes, null);
  assert.equal(entry.tuning, null);
  assert.equal(entry.fits, true);
});

test('a service too large for the node is blocked like any other recipe', () => {
  const node = roomyNode({ memory: { total: SPARK_MEMORY, used: 100 * GB, available: 30 * GB } });
  const entry = planOf(service({ 'memoryGB: 40': 'memoryGB: 90' }), node);

  assert.equal(entry.fits, false);
  assert.ok(codes(entry.blockers).includes('memory'));
  /* And never for a reason that only applies to vLLM. */
  assert.equal(codes(entry.blockers).includes('gpu-memory-utilization'), false);
});

test('a declared memory figure is labelled as an estimate unless measured', () => {
  assert.ok(codes(planOf(service(), roomyNode()).warnings).includes('estimate'));
  assert.equal(
    codes(planOf(service({ 'memoryMeasured: false': 'memoryMeasured: true' }), roomyNode()).warnings)
      .includes('estimate'),
    false,
  );
});

/*
 * A service's weights are ordinary cache entries, so both runtimes answer "is
 * it here" the same way - out of `hf cache ls`. That is the whole point of
 * keeping them there rather than in a directory of their own.
 */
test('a service reads its weights from the HuggingFace cache like any recipe', () => {
  const cached = roomyNode({
    hf: {
      available: true,
      user: 'someone',
      cacheDir: '/home/nvidia/.cache/huggingface',
      repos: [{ repoId: 'Comfy-Org/MiniMax-H3' }],
    },
  });

  const here = planOf(service(), cached);
  assert.equal(here.repos[0].cached, true);
  assert.equal(here.disk.downloadBytes, 0);

  const missing = planOf(service(), roomyNode());
  assert.equal(missing.repos[0].cached, false);
  assert.equal(missing.disk.downloadBytes, 60e9);
});

test('a service declares where each weight file is mounted', () => {
  const [entry] = service().weights;

  assert.equal(entry.mountBase, '/workspace/ComfyUI/models');
  assert.deepEqual(entry.files, ['diffusion_models/a.safetensors']);
});

test('resolveArgs gives a service nothing, whatever it is handed', () => {
  assert.deepEqual(
    resolveArgs(service(), { contextLength: 4096, maxRequests: 2, gpuMemoryUtilization: 0.5 }),
    [],
  );
});

test('vllm-only fields are refused on a service rather than silently ignored', () => {
  for (const field of ['overheadGB: 8', 'kvBytesPerToken: 44827']) {
    assert.throws(() => service({ 'memoryGB: 40': `memoryGB: 40\n  ${field}` }), /belongs to a vllm recipe/);
  }
});

test('a service whose weights lack a mount point is refused', () => {
  assert.throws(
    () => service({ '      mountBase: /workspace/ComfyUI/models\n': '' }),
    /mountBase.*must be an absolute path/,
  );
});

test('a service without a memory figure is refused', () => {
  assert.throws(() => service({ '  memoryGB: 40\n': '' }), /memoryGB must be a positive number/);
});

test('an unknown runtime is refused', () => {
  assert.throws(() => service({ 'runtime: service': 'runtime: kubernetes' }), /runtime must be one of/);
});

/* Every path in a service recipe reaches a shell on the node. */
test('host and container paths that could escape their quoting are refused', () => {
  const hostile = [
    ['host: ~/comfy-output', "host: '~/x; rm -rf /'"],
    ['host: ~/comfy-output', 'host: ~/../../etc'],
    ['container: /workspace/ComfyUI/output', "container: '/x$(id)'"],
    ['container: /workspace/ComfyUI/output', 'container: relative/path'],
    ['mountBase: /workspace/ComfyUI/models', "mountBase: '/x$(id)'"],
    ['- diffusion_models/a.safetensors', "- '../../etc/passwd'"],
    ['path: /system_stats', "path: '/x; rm -rf /'"],
  ];

  for (const [from, to] of hostile) {
    assert.throws(() => service({ [from]: to }), /recipe "comfy"/, `expected ${to} to be refused`);
  }
});

test('environment variables are validated and reach the recipe', () => {
  const recipe = service({ '  memoryGB: 40': '  env:\n    VLLM_USE_V2_MODEL_RUNNER: 1\n  memoryGB: 40' });
  assert.deepEqual(recipe.env, [{ key: 'VLLM_USE_V2_MODEL_RUNNER', value: '1' }]);

  assert.throws(
    () => service({ '  memoryGB: 40': '  env:\n    lowercase: 1\n  memoryGB: 40' }),
    /is not a valid variable name/,
  );
});

test('the shipped service recipe keeps its weights in the cache', () => {
  const comfy = recipeById('comfyui-minimax-h3');

  assert.equal(comfy.runtime, 'service');
  assert.equal(comfy.weights.length, 1);
  assert.equal(comfy.weights[0].mountBase, '/workspace/ComfyUI/models');
  /* No directory of weights to bind - only the writable dirs are volumes. */
  assert.equal(comfy.volumes.some((v) => v.container.endsWith('/models')), false);
});
