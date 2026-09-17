import fs from 'node:fs';
import YAML from 'yaml';
import { config } from './config.js';
import { REPO_ID_RE } from './collectors/huggingface.js';
import { ACTIVE_RUN_STATUSES } from './collectors/planner.js';

/*
 * Serving recipes: complete, named configurations for running a model on a
 * node, plus the arithmetic that decides whether one will actually fit.
 *
 * The catalogue itself is data - recipes.yaml at the repo root, or wherever
 * RECIPES_FILE points. This module loads it once at startup, validates it hard,
 * and turns each entry into the shape the planner and the launcher expect.
 *
 * A recipe is the whole thing - weights, image, vLLM flags and docker flags -
 * not a template with blanks. That is deliberate: the tuning in these
 * configurations is interdependent (the KV dtype, the speculative method and
 * the lm_head quantisation all constrain each other), so exposing them as
 * independent dropdowns would mostly produce combinations that do not load.
 * Picking a whole known configuration is the operation that makes sense.
 *
 * VALIDATION IS NOT OPTIONAL HERE. Every string in the file is interpolated
 * into a shell command on the node, and the launcher wraps each one in single
 * quotes, so a stray quote or backtick would break out of that. The file is
 * hand-edited, which makes this the boundary where a typo has to be caught -
 * and it is caught for the whole catalogue at once, so a bad recipe can never
 * be half-applied.
 *
 * RUNTIME BYTES is a floor, not a reservation: enough KV pool to serve the
 * declared concurrency, plus CUDA graph capture and activations. vLLM does not
 * take that figure - it takes gpuMemoryUtilization x total memory - so it is
 * used to answer "is there room to work here", while the separate gmu check
 * further down answers "will vLLM agree to start at all".
 */

const GB = 1e9;

/*
 * Shapes that must hold before any of this reaches a command line. ARG_RE is
 * wide enough for repo ids, flag values and the inline speculative-config JSON,
 * and closed against quoting, substitution and word splitting.
 */
export const RECIPE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
export const IMAGE_REF_RE = /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?(@sha256:[a-f0-9]{64})?$/;
export const ARG_RE = /^[A-Za-z0-9 _.,:/@+={}"[\]-]{1,512}$/;
export const FLAG_RE = /^--[a-z0-9][a-z0-9-]{0,63}$/;
/* A Hub revision: a commit sha, or a branch or tag name. */
export const REVISION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/*
 * A recipe is either an inference-engine serving configuration - weights,
 * flags, a KV cache whose size is the whole planning question - or a plain
 * containerised service that happens to want a GPU. ComfyUI is the second kind:
 * no serving flags, no KV cache, its own entrypoint, and weights that are files
 * in a directory rather than a repo in the HuggingFace cache.
 */
export const RUNTIMES = ['vllm', 'sglang', 'service'];

/*
 * WHERE THE TWO ENGINES DIFFER, in one table.
 *
 * vLLM and SGLang serve the same models from the same HuggingFace cache and are
 * planned with the same arithmetic, but they spell every knob differently and
 * they do not mean the same thing by their memory fraction. Everything that
 * follows reads the engine out of here rather than testing the runtime name, so
 * adding a third engine is a row rather than a branch.
 *
 * TWO of these rows change the arithmetic rather than the spelling, and both
 * were measured on nv-spark-01 rather than read off documentation:
 *
 * memoryCoversOverhead. vLLM claims `fraction x total` as ONE block and loads
 * everything into it - weights, activation, graph capture and KV - so the
 * fraction has to cover the lot. SGLang's mem-fraction-static covers the
 * weights and the pools only; activation and CUDA graph capture are taken from
 * what is left afterwards, so asking it for the overhead too would silently
 * inflate the pool.
 *
 * memoryFractionOf. vLLM's fraction is of TOTAL memory, and it refuses to start
 * when `fraction x total` exceeds what is free. SGLang's is of what is FREE
 * when it starts, which is a different number on a shared box and the reason
 * the same 0.65 that fills an idle Spark leaves a 16,633-token pool next to a
 * resident vLLM server. Three boots on this node, weights 22.58 GiB, 60.05 GiB
 * free at start, one request, 262,144 context:
 *
 *   fraction   pool after weights   max_total_num_tokens
 *   0.45       4.35 GiB             16,633
 *   0.55       10.94 GiB            81,558
 *   0.65       17.28 GiB            142,477
 *
 * `fraction x free - weights` predicts those three pools to within 5%, and
 * `fraction x total - weights` is not even the right sign at 0.45.
 */
export const ENGINES = {
  vllm: {
    /*
     * Pinned deliberately, and the one thing that works against both image
     * families: the spark-arena builds set no entrypoint, while
     * vllm/vllm-openai already runs `vllm serve`, so passing `vllm serve ...`
     * to the latter yields `vllm serve vllm serve ...` and argparse rejects it.
     */
    entrypoint: 'vllm',
    command: ['serve'],
    /* vLLM takes the model positionally: `vllm serve <repo id>`. */
    modelFlag: null,
    contextFlag: '--max-model-len',
    requestsFlag: '--max-num-seqs',
    memoryFlag: '--gpu-memory-utilization',
    revisionFlag: '--revision',
    /* vLLM carries the drafter's revision inside --speculative-config, so there
     * is no separate flag to pass it as. */
    draftRevisionFlag: null,
    memoryCoversOverhead: true,
    memoryFractionOf: 'total',
    /* vLLM sizes its mamba cache from max-num-seqs alone. */
    statePaddingSlots: 0,
    /* The image serves 0.0.0.0:8000 without being told to. */
    bindFlags: false,
    containerPort: 8000,
    /* An authenticated /v1/models answers only once the weights are loaded. */
    readiness: { path: '/v1/models', auth: 'bearer' },
    /* vLLM caches compiled kernels here and a warm cache is minutes off a boot. */
    cacheVolume: { host: '$HOME/.cache/vllm', container: '/root/.cache/vllm' },
  },
  sglang: {
    /*
     * Not pinned, unlike vLLM: the image's entrypoint is NVIDIA's
     * nvidia_entrypoint.sh, which prepares the container's GPU environment and
     * then execs whatever it was given. Replacing it would skip that setup, so
     * the command goes through it - which is also how the reference recipe this
     * was ported from launches the same image.
     */
    entrypoint: null,
    command: ['sglang', 'serve'],
    modelFlag: '--model-path',
    contextFlag: '--context-length',
    requestsFlag: '--max-running-requests',
    memoryFlag: '--mem-fraction-static',
    revisionFlag: '--revision',
    draftRevisionFlag: '--speculative-draft-model-revision',
    memoryCoversOverhead: false,
    memoryFractionOf: 'free',
    /*
     * SGLang allocates one slot more than the requests it was asked for - "the
     * pool's padding slot is allocated alongside the request slots", in its own
     * kv_cache_configurator - and the per-request state here is large enough
     * that the spare one is worth 1.3 GB rather than a rounding error.
     */
    statePaddingSlots: 1,
    /* SGLang binds 127.0.0.1 inside the container unless told otherwise, which
     * publishes a port that answers nothing. */
    bindFlags: true,
    /* It listens on whatever --port says, so the launcher uses the recipe's. */
    containerPort: null,
    /*
     * /v1/models answers before the scheduler is live - a green probe on a
     * server that cannot yet serve is the failure this project keeps
     * rediscovering. /health_generate runs a real generation, and SGLang's own
     * api-key middleware exempts it, so the probe needs no key.
     */
    readiness: { path: '/health_generate', auth: 'none' },
    /* FlashInfer's autotune draws. Mounted by the recipe rather than here,
     * because keeping a good draw is a decision a recipe makes. */
    cacheVolume: null,
  },
};

export const isEngine = (runtime) => runtime in ENGINES;

/* Host paths may use ~ for the node's home; the launcher expands it there. No
 * spaces, quotes or substitutions - these are interpolated into shell commands. */
export const HOST_PATH_RE = /^~?\/[A-Za-z0-9_.][A-Za-z0-9_./-]{0,255}$/;
export const CONTAINER_PATH_RE = /^\/[A-Za-z0-9_][A-Za-z0-9_./-]{0,255}$/;
export const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
/* A path inside a repo, for `hf download --include`; globs are allowed. */
export const REPO_PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9_./*-]{0,255}$/;
export const READINESS_PATH_RE = /^\/[A-Za-z0-9_./-]{0,127}$/;

/*
 * Bounds on the computed fraction. vLLM rejects 1.0, and anything under a tenth
 * of the box cannot hold this class of model however the knobs are set.
 */
const MAX_UTILIZATION = 0.97;
const MIN_UTILIZATION = 0.05;

/* Context lengths the picker offers, capped at whatever the recipe declares -
 * going beyond a model's native window needs rope scaling, which is a different
 * conversation from "how much memory does this take". */
const CONTEXT_STEPS = [8192, 16384, 32768, 65536, 131072, 262144, 524288, 1000000];
const REQUEST_STEPS = [1, 2, 4, 8, 16, 32, 64];

const bad = (message) => Object.assign(new Error(message), { status: 400 });

class RecipeError extends Error {}

/* Reads one flag back out of a recipe's own args, so figures the planner needs
 * are never declared twice and cannot drift from the flags actually served. */
const numericArg = (args, flag) => {
  const value = Number(args[flag]);
  return Number.isFinite(value) ? value : null;
};

function assertRepo(value, where) {
  const repo = String(value ?? '');
  if (repo.includes('..') || !REPO_ID_RE.test(repo)) {
    throw new RecipeError(`${where}: "${repo}" is not a valid Hub repo id`);
  }
  return repo;
}

/*
 * A model or drafter entry: which weights, how big, and whether that size was
 * measured or derived. The UI labels an estimate as one.
 *
 * `revision` pins the snapshot. It is optional and usually left out - a recipe
 * that names no revision follows the repo's main branch, which is what the
 * bundled vLLM recipes do - but a recipe whose figures were measured on one
 * particular export can say so, and then the run fetches and serves exactly
 * that snapshot rather than whatever main has moved to since.
 */
function normaliseWeights(entry, where) {
  if (!entry || typeof entry !== 'object') throw new RecipeError(`${where} is required`);

  const sizeGB = Number(entry.sizeGB);
  if (!Number.isFinite(sizeGB) || sizeGB <= 0) {
    throw new RecipeError(`${where}.sizeGB must be a positive number of GB (got ${entry.sizeGB})`);
  }

  const revision = entry.revision === undefined || entry.revision === null ? null : String(entry.revision);
  if (revision !== null && !REVISION_RE.test(revision)) {
    throw new RecipeError(`${where}.revision: "${revision}" is not a valid Hub revision`);
  }

  return {
    repoId: assertRepo(entry.repo, `${where}.repo`),
    repoType: 'model',
    revision,
    sizeBytes: sizeGB * GB,
    measured: entry.measured === true,
  };
}

/*
 * The flag map becomes argv. A bare flag is `true`; `false` and null omit it,
 * which lets a recipe turn one off without deleting the line. Everything else
 * contributes a flag and its value as two separate argv entries, so a value
 * containing a space stays one argument.
 */
function normaliseArgs(raw, leading, servedName, where) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RecipeError(`${where} must be a map of flag to value`);
  }

  const args = [...leading];
  if (!('--served-model-name' in raw)) args.push('--served-model-name', servedName);

  for (const [flag, value] of Object.entries(raw)) {
    if (!FLAG_RE.test(flag)) throw new RecipeError(`${where}: "${flag}" is not a valid engine flag`);
    if (value === false || value === null || value === undefined) continue;
    if (value === true) {
      args.push(flag);
      continue;
    }
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new RecipeError(`${where}.${flag} must be a string, number or boolean`);
    }
    args.push(flag, String(value));
  }

  for (const arg of args) {
    if (!ARG_RE.test(arg)) {
      throw new RecipeError(`${where}: "${arg}" has characters that cannot be quoted safely`);
    }
  }
  return args;
}

function normaliseImage(entry, where) {
  if (!entry || typeof entry !== 'object') throw new RecipeError(`${where} is required`);
  if (!IMAGE_REF_RE.test(entry.ref ?? '')) {
    throw new RecipeError(`${where}.ref: "${entry.ref}" is not a valid image reference`);
  }

  if (entry.build === undefined || entry.build === null) {
    return { ref: entry.ref, build: null };
  }

  /* A recipe that builds its own image rather than pulling one. */
  if (!IMAGE_REF_RE.test(entry.build.from ?? '')) {
    throw new RecipeError(`${where}.build.from: "${entry.build?.from}" is not a valid image reference`);
  }
  const steps = entry.build.run ?? [];
  if (!Array.isArray(steps)) throw new RecipeError(`${where}.build.run must be a list of shell steps`);
  for (const step of steps) {
    if (!ARG_RE.test(String(step))) {
      throw new RecipeError(`${where}.build.run: "${step}" has characters that cannot be quoted safely`);
    }
  }

  return { ref: entry.ref, build: { from: entry.build.from, run: steps.map(String) } };
}

const text = (value, where, max = 400) => {
  const string = String(value ?? '').trim();
  if (!string) throw new RecipeError(`${where} is required`);
  if (string.length > max) throw new RecipeError(`${where} must be ${max} characters or fewer`);
  return string;
};

/* Container environment. Gemma's diffusion runner and ComfyUI both need one;
 * vLLM recipes usually need none. */
function normaliseEnv(entry, where) {
  if (entry === undefined || entry === null) return [];
  if (typeof entry !== 'object' || Array.isArray(entry)) {
    throw new RecipeError(`${where} must be a map of NAME to value`);
  }

  return Object.entries(entry).map(([key, value]) => {
    if (!ENV_KEY_RE.test(key)) throw new RecipeError(`${where}: "${key}" is not a valid variable name`);
    const text = String(value);
    if (!ARG_RE.test(text)) throw new RecipeError(`${where}.${key} has characters that cannot be quoted safely`);
    return { key, value: text };
  });
}

/*
 * Host directories bound into the container. vLLM recipes get the HuggingFace
 * and vLLM caches implicitly - those paths are shell expressions honouring
 * HF_HOME, which is why they are not expressed here - so this is for services
 * that keep their state somewhere of their own choosing.
 */
function assertHostPath(value, where) {
  const path = String(value ?? '');
  /* Checked before the regex so traversal gets a clearer message than "invalid". */
  if (path.includes('..')) throw new RecipeError(`${where}: "${path}" may not traverse with ".."`);
  if (!HOST_PATH_RE.test(path)) throw new RecipeError(`${where}: "${path}" is not a usable host path`);
  return path;
}

function normaliseVolumes(entry, where) {
  if (entry === undefined || entry === null) return [];
  if (!Array.isArray(entry)) throw new RecipeError(`${where} must be a list`);

  return entry.map((mount, i) => {
    const at = `${where}[${i}]`;
    assertHostPath(mount?.host, `${at}.host`);
    if (!CONTAINER_PATH_RE.test(mount?.container ?? '')) {
      throw new RecipeError(`${at}.container: "${mount?.container}" must be an absolute path`);
    }
    return { host: mount.host, container: mount.container, readOnly: mount.readOnly === true };
  });
}

/*
 * Weights for a service, taken from the HuggingFace cache and bound into the
 * container one file at a time.
 *
 * The cache stores a repo as blobs under a content hash, reachable through a
 * revision snapshot of symlinks - a layout ComfyUI cannot read, because it
 * loads by folder and filename. Mounting each file individually bridges that:
 * the run resolves the snapshot path on the node and binds
 * <snapshot>/<file> onto <mountBase>/<file>, read-only.
 *
 * The payoff is that these weights are ordinary cache entries, so `hf cache ls`
 * lists them and the HuggingFace panel can measure and delete them like any
 * other repo. The cost is exactly that: deleting the repo there pulls the
 * weights out from under a running container.
 */
function normaliseWeightMounts(entry, where) {
  if (entry === undefined || entry === null) return [];
  if (!Array.isArray(entry)) throw new RecipeError(`${where} must be a list`);

  return entry.map((item, i) => {
    const at = `${where}[${i}]`;
    const sizeGB = Number(item?.sizeGB);
    if (!Number.isFinite(sizeGB) || sizeGB <= 0) {
      throw new RecipeError(`${at}.sizeGB must be a positive number of GB (got ${item?.sizeGB})`);
    }
    if (!CONTAINER_PATH_RE.test(item?.mountBase ?? '')) {
      throw new RecipeError(`${at}.mountBase: "${item?.mountBase}" must be an absolute path`);
    }

    const files = item?.files ?? [];
    if (!Array.isArray(files) || files.length === 0) {
      throw new RecipeError(`${at}.files must list at least one file to fetch and mount`);
    }
    for (const file of files) {
      const path = String(file);
      if (path.includes('..')) throw new RecipeError(`${at}.files: "${path}" may not traverse with ".."`);
      if (!REPO_PATH_RE.test(path)) {
        throw new RecipeError(`${at}.files: "${path}" is not a usable path inside the repo`);
      }
    }

    return {
      repoId: assertRepo(item.repo, `${at}.repo`),
      repoType: 'model',
      mountBase: item.mountBase,
      files: files.map(String),
      sizeBytes: sizeGB * GB,
      measured: item.measured === true,
    };
  });
}

/*
 * Arguments appended after the image's own entrypoint, replacing its CMD.
 *
 * A service normally starts itself, but its defaults are not always right for
 * the node: ComfyUI's memory manager assumes discrete VRAM, and on unified
 * memory the flag that governs it is the difference between holding each weight
 * once and holding it twice.
 */
function normaliseCommand(entry, where) {
  if (entry === undefined || entry === null) return [];
  if (!Array.isArray(entry)) throw new RecipeError(`${where} must be a list of arguments`);

  return entry.map((arg) => {
    const text = String(arg);
    if (!ARG_RE.test(text)) throw new RecipeError(`${where}: "${text}" has characters that cannot be quoted safely`);
    return text;
  });
}

/* How the run decides the server is actually up. Each engine brings a probe it
 * is known to answer only when it can serve; everything else says where to look
 * and whether to send the key. */
function normaliseReadiness(entry, runtime, where) {
  const fallback = ENGINES[runtime]?.readiness ?? { path: '/', auth: 'none' };
  if (entry === undefined || entry === null) return fallback;

  const path = entry.path ?? fallback.path;
  if (!READINESS_PATH_RE.test(path)) throw new RecipeError(`${where}.path: "${path}" is not a usable URL path`);

  const auth = entry.auth ?? fallback.auth;
  if (auth !== 'bearer' && auth !== 'none') throw new RecipeError(`${where}.auth must be "bearer" or "none"`);
  return { path, auth };
}

export function normaliseRecipe(entry, index) {
  if (!entry || typeof entry !== 'object') throw new RecipeError(`recipe ${index + 1} is not a mapping`);

  const id = String(entry.id ?? '');
  if (!RECIPE_ID_RE.test(id)) {
    throw new RecipeError(`recipe ${index + 1}: id "${id}" must be lowercase kebab-case`);
  }
  const at = `recipe "${id}"`;

  const runtime = entry.runtime ?? 'vllm';
  if (!RUNTIMES.includes(runtime)) {
    throw new RecipeError(`${at}: runtime must be one of ${RUNTIMES.join(', ')} (got ${runtime})`);
  }

  if (!CONTAINER_NAME_RE.test(entry.container ?? '')) {
    throw new RecipeError(`${at}: container "${entry.container}" is not a valid docker name`);
  }

  const port = Number(entry.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RecipeError(`${at}: port must be between 1 and 65535 (got ${entry.port})`);
  }

  /* What the process listens on inside the container, which is rarely what it
   * is published as. vLLM images serve 8000; ComfyUI serves 8188; SGLang serves
   * whatever --port says, so it is given the recipe's own. */
  const containerPort = Number(entry.containerPort ?? ENGINES[runtime]?.containerPort ?? port);
  if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
    throw new RecipeError(`${at}: containerPort must be between 1 and 65535 (got ${entry.containerPort})`);
  }

  const notes = entry.notes ?? [];
  if (!Array.isArray(notes)) throw new RecipeError(`${at}.notes must be a list`);

  const common = {
    id,
    runtime,
    name: text(entry.name, `${at}.name`, 80),
    summary: text(entry.summary, `${at}.summary`),
    image: normaliseImage(entry.image, `${at}.image`),
    port,
    containerPort,
    containerName: entry.container,
    env: normaliseEnv(entry.env, `${at}.env`),
    volumes: normaliseVolumes(entry.volumes, `${at}.volumes`),
    readiness: normaliseReadiness(entry.readiness, runtime, `${at}.readiness`),
    /* Larger shared memory than docker's 64MB default. vLLM asks for it as a
     * size; ComfyUI's launcher shares the host namespace instead. Same goal. */
    ipcHost: entry.ipcHost === true,
    notes: notes.map((note, i) => text(note, `${at}.notes[${i}]`)),
  };

  return isEngine(runtime)
    ? normaliseEngineRecipe(entry, common, at)
    : normaliseServiceRecipe(entry, common, at);
}

/*
 * An engine recipe: weights from the Hub, serving flags, and a KV cache whose
 * size is the thing the planner actually reasons about.
 */
function normaliseEngineRecipe(entry, common, at) {
  const engine = ENGINES[common.runtime];
  const overheadGB = Number(entry.overheadGB);
  if (!Number.isFinite(overheadGB) || overheadGB < 0) {
    throw new RecipeError(`${at}: overheadGB must be a number of GB (got ${entry.overheadGB})`);
  }

  const kvBytesPerToken = Number(entry.kvBytesPerToken);
  if (!Number.isFinite(kvBytesPerToken) || kvBytesPerToken <= 0) {
    throw new RecipeError(`${at}: kvBytesPerToken must be a positive number (got ${entry.kvBytesPerToken})`);
  }

  /*
   * What a sequence costs on top of its KV, whatever its length.
   *
   * Zero for a pure attention model, and zero for any recipe that does not
   * declare it. It exists for the hybrid models: a Gated DeltaNet layer keeps a
   * fixed-size recurrent state per SEQUENCE rather than per token, so the cost
   * of raising the concurrency is not only more KV pool. vLLM folds that into
   * its KV page under `--mamba-cache-mode align`, which is why the bundled vLLM
   * recipes leave it unset; SGLang allocates it as a pool of its own and the
   * figure is large enough that ignoring it would misprice the run by gigabytes.
   */
  const stateGBPerRequest = Number(entry.stateGBPerRequest ?? 0);
  if (!Number.isFinite(stateGBPerRequest) || stateGBPerRequest < 0) {
    throw new RecipeError(`${at}: stateGBPerRequest must be a number of GB (got ${entry.stateGBPerRequest})`);
  }

  /* The fraction is computed from the context and concurrency actually asked
   * for, so a recipe that pins it would silently defeat that. */
  if (engine.memoryFlag in (entry.args ?? {})) {
    throw new RecipeError(`${at}: do not set ${engine.memoryFlag}; the planner computes it`);
  }

  const model = normaliseWeights(entry.model, `${at}.model`);
  const draft = entry.draft ? normaliseWeights(entry.draft, `${at}.draft`) : null;
  const servedName = entry.servedName ? text(entry.servedName, `${at}.servedName`, 200) : model.repoId;

  /*
   * How the engine is told which weights to serve, and at which snapshot. vLLM
   * takes the model positionally; SGLang takes --model-path. The revisions go
   * in here rather than in the recipe's own args so that a pinned recipe cannot
   * name one snapshot in `model.revision` and another in a hand-written flag.
   */
  const leading = [
    ...(engine.modelFlag ? [engine.modelFlag, model.repoId] : [model.repoId]),
    ...(model.revision ? [engine.revisionFlag, model.revision] : []),
    ...(draft?.revision && engine.draftRevisionFlag ? [engine.draftRevisionFlag, draft.revision] : []),
  ];
  const args = normaliseArgs(entry.args, leading, servedName, `${at}.args`);

  return {
    ...common,
    model: { repoId: model.repoId, repoType: model.repoType, revision: model.revision },
    draft: draft ? { repoId: draft.repoId, repoType: draft.repoType, revision: draft.revision } : null,
    weights: [],
    command: [],
    /*
     * Read back out of the flags rather than declared again beside them. Null
     * means the recipe left it to the engine, which the UI says rather than
     * guessing.
     */
    contextLength: numericArg(entry.args, engine.contextFlag),
    concurrency: numericArg(entry.args, engine.requestsFlag),
    memory: {
      weightsBytes: model.sizeBytes,
      weightsMeasured: model.measured && (draft ? draft.measured : true),
      draftBytes: draft?.sizeBytes ?? 0,
      /* Neither weights nor KV: non-torch, peak activation, graph capture. */
      overheadBytes: overheadGB * GB,
      kvBytesPerToken,
      kvMeasured: entry.kvMeasured === true,
      statePerRequestBytes: stateGBPerRequest * GB,
      stateMeasured: entry.stateMeasured === true,
    },
    args,
  };
}

/*
 * A service recipe: a container that wants a GPU and some disk. There is no KV
 * cache to size and no fraction to compute, so it declares what it needs as one
 * figure and the planner checks that figure against the machine.
 */
function normaliseServiceRecipe(entry, common, at) {
  const memoryGB = Number(entry.memoryGB);
  if (!Number.isFinite(memoryGB) || memoryGB <= 0) {
    throw new RecipeError(`${at}: memoryGB must be a positive number of GB (got ${entry.memoryGB})`);
  }

  for (const field of ['model', 'args', 'kvBytesPerToken', 'overheadGB', 'stateGBPerRequest']) {
    if (entry[field] !== undefined) {
      throw new RecipeError(`${at}: ${field} belongs to an engine recipe, not a service one`);
    }
  }

  return {
    ...common,
    model: null,
    draft: null,
    weights: normaliseWeightMounts(entry.weights, `${at}.weights`),
    command: normaliseCommand(entry.command, `${at}.command`),
    contextLength: null,
    concurrency: null,
    memory: {
      weightsBytes: 0,
      weightsMeasured: true,
      draftBytes: 0,
      /* The whole reservation, declared rather than derived. */
      overheadBytes: memoryGB * GB,
      memoryMeasured: entry.memoryMeasured === true,
      kvBytesPerToken: 0,
      kvMeasured: true,
      statePerRequestBytes: 0,
      stateMeasured: true,
    },
    args: [],
  };
}

/*
 * Parses a whole catalogue. Either every recipe is valid or none are applied -
 * a half-loaded catalogue would silently drop the one recipe the user just
 * edited, which is worse than saying so.
 */
export function parseRecipes(source) {
  let entries;
  try {
    entries = YAML.parse(source);
  } catch (err) {
    throw new RecipeError(`could not parse YAML: ${String(err?.message || err).split('\n')[0]}`);
  }

  if (entries === null || entries === undefined) return [];
  if (!Array.isArray(entries)) throw new RecipeError('the file must contain a list of recipes');

  const recipes = entries.map((entry, index) => normaliseRecipe(entry, index));

  const seen = new Set();
  for (const recipe of recipes) {
    if (seen.has(recipe.id)) throw new RecipeError(`duplicate recipe id "${recipe.id}"`);
    seen.add(recipe.id);
  }
  return recipes;
}

/*
 * Loading never throws. A recipe file with a typo in it must not stop the
 * dashboard from monitoring - that is the primary job and it has nothing to do
 * with recipes - so the failure is carried alongside an empty catalogue, logged
 * at startup and shown in the panel where whoever edited the file will see it.
 */
export function loadRecipes(file) {
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { recipes: [], error: `no recipe file at ${file}` };
    return { recipes: [], error: `could not read ${file}: ${String(err?.message || err)}` };
  }

  try {
    return { recipes: parseRecipes(source), error: null };
  } catch (err) {
    return { recipes: [], error: `${file}: ${String(err?.message || err)}` };
  }
}

const loaded = loadRecipes(config.recipesFile);

export const RECIPES = loaded.recipes;
export const RECIPES_ERROR = loaded.error;

const byId = new Map(RECIPES.map((recipe) => [recipe.id, recipe]));

export function recipeById(id) {
  const recipe = byId.get(String(id ?? ''));
  if (!recipe) throw bad(`unknown recipe: ${id}`);
  return recipe;
}

/*
 * The catalogue as the browser sees it: enough to describe a recipe on its own,
 * without the figures that only mean something against a node. The memory
 * arithmetic - what it needs, what vLLM will claim, what is already cached -
 * lives in the per-node plan, so it is not repeated here.
 */
export function publicRecipes() {
  return RECIPES.map((recipe) => ({
    id: recipe.id,
    runtime: recipe.runtime,
    name: recipe.name,
    summary: recipe.summary,
    modelRepoId: recipe.model?.repoId ?? recipe.weights[0]?.repoId ?? null,
    draftRepoId: recipe.draft?.repoId ?? null,
    imageRef: recipe.image.ref,
    buildsImage: Boolean(recipe.image.build),
    port: recipe.port,
    containerName: recipe.containerName,
    contextLength: recipe.contextLength,
    concurrency: recipe.concurrency,
    weightsBytes: recipe.memory.weightsBytes + recipe.memory.draftBytes,
    /* The flags the tuning is passed as. The panel previews the argv a run
     * would get, and it cannot spell them without knowing the engine. */
    flags: ENGINES[recipe.runtime]
      ? {
          context: ENGINES[recipe.runtime].contextFlag,
          requests: ENGINES[recipe.runtime].requestsFlag,
          memory: ENGINES[recipe.runtime].memoryFlag,
        }
      : null,
    args: recipe.args,
    notes: recipe.notes,
  }));
}

/*
 * Which memory pool a recipe competes for. On GB10 the CPU and GPU share one
 * LPDDR5X pool, so the figure that matters is the host's - nvidia-smi reports
 * [N/A] for memory there because there is no separate VRAM to report. On a
 * discrete GPU it is the card's own memory, and host RAM is irrelevant.
 */
export function memoryPool(snapshot) {
  const gpu = snapshot.gpus?.[0];
  const unified = Boolean(gpu?.isUnified) || snapshot.type === 'dgx-spark';

  if (!unified && gpu?.memoryTotal) {
    return {
      unified: false,
      totalBytes: gpu.memoryTotal,
      availableBytes: Math.max(0, gpu.memoryTotal - (gpu.memoryUsed ?? 0)),
    };
  }

  const memory = snapshot.memory;
  if (!memory?.total) return { unified, totalBytes: null, availableBytes: null };
  return {
    unified,
    totalBytes: memory.total,
    /* MemAvailable, not MemFree: reclaimable page cache is memory vLLM can have. */
    availableBytes: memory.available ?? Math.max(0, memory.total - memory.used),
  };
}

/* The mount the HuggingFace cache lands on: longest mount point that prefixes
 * the cache directory, which is how the kernel resolves it too. */
export function cacheMount(snapshot) {
  const dir = snapshot.hf?.cacheDir || '/root/.cache/huggingface';
  const mounts = snapshot.storage ?? [];

  let best = null;
  for (const mount of mounts) {
    const path = mount.mount;
    const covers = path === '/' || dir === path || dir.startsWith(path.endsWith('/') ? path : `${path}/`);
    if (!covers) continue;
    if (!best || path.length > best.mount.length) best = mount;
  }
  return best;
}

/*
 * The knobs a run can be tuned with, and the memory they imply.
 *
 * This is the whole point of the planner: vLLM's fraction is a policy, not a
 * requirement, so rather than pinning it the planner works out the SMALLEST
 * fraction that still fits what is being asked for. Raise the context length or
 * the concurrency and the required pool grows; the fraction follows it.
 */
export function contextOptions(recipe) {
  const ceiling = recipe.contextLength ?? CONTEXT_STEPS.at(-1);
  const steps = CONTEXT_STEPS.filter((value) => value <= ceiling);
  /* A recipe whose default is not a power of two still has to be offerable. */
  return steps.includes(ceiling) ? steps : [...steps, ceiling];
}

export const requestOptions = () => [...REQUEST_STEPS];

function resolveTuning(recipe, tuning = {}) {
  const ceiling = recipe.contextLength ?? CONTEXT_STEPS.at(-1);
  const wantedContext = Number(tuning.contextLength);
  const wantedRequests = Number(tuning.maxRequests);

  const contextLength = Number.isFinite(wantedContext) && wantedContext > 0
    ? Math.min(Math.round(wantedContext), ceiling)
    : ceiling;

  const maxRequests = Number.isFinite(wantedRequests) && wantedRequests > 0
    ? Math.min(Math.round(wantedRequests), REQUEST_STEPS.at(-1))
    : (recipe.concurrency ?? 1);

  const override = Number(tuning.gpuMemoryUtilization);
  return {
    contextLength,
    maxRequests,
    override: Number.isFinite(override) && override > 0 ? override : null,
  };
}

/* Rounded up, because a fraction that lands a megabyte short is a refusal. */
const ceil2 = (value) => Math.ceil(value * 100) / 100;

/*
 * How much memory a given context and concurrency actually need.
 *
 * The KV pool is the term that moves: vLLM will not start unless the pool holds
 * at least max-model-len tokens, and serving N requests at that length needs N
 * times as much. Everything else - weights, activation, graph capture - is
 * fixed for the recipe.
 */
export function sizeFor(recipe, tuning) {
  if (!isEngine(recipe.runtime)) {
    return {
      weightsBytes: 0,
      overheadBytes: recipe.memory.overheadBytes,
      kvTokens: 0,
      kvBytes: 0,
      stateBytes: 0,
      requiredBytes: recipe.memory.overheadBytes,
    };
  }

  const weightsBytes = recipe.memory.weightsBytes + recipe.memory.draftBytes;
  const kvTokens = tuning.contextLength * tuning.maxRequests;
  const kvBytes = kvTokens * recipe.memory.kvBytesPerToken;
  /* Per sequence, not per token: the recurrent state of a hybrid model's linear
   * layers, which is the same size whether the sequence is 1 token or 260k -
   * plus whatever spare slots the engine allocates beside the ones asked for. */
  const stateBytes =
    recipe.memory.statePerRequestBytes *
    (tuning.maxRequests + (ENGINES[recipe.runtime]?.statePaddingSlots ?? 0));

  return {
    weightsBytes,
    overheadBytes: recipe.memory.overheadBytes,
    kvTokens,
    kvBytes,
    stateBytes,
    requiredBytes: weightsBytes + recipe.memory.overheadBytes + kvBytes + stateBytes,
  };
}

export function planRecipe(recipe, snapshot, runs = [], requested = {}) {
  const pool = memoryPool(snapshot);
  const engine = ENGINES[recipe.runtime] ?? null;
  const tuning = resolveTuning(recipe, requested);
  const size = sizeFor(recipe, tuning);
  const { weightsBytes, requiredBytes } = size;

  /*
   * What the fraction has to cover, which is not the same question for the two
   * engines: vLLM's block holds everything, SGLang's holds the weights and the
   * pools while activation and graph capture come out of the remainder. Asking
   * SGLang for the overhead as well would hand the surplus to the KV pool,
   * which is not wrong so much as a different setting than the one priced.
   */
  const fractionBytes = !engine
    ? null
    : engine.memoryCoversOverhead
      ? requiredBytes
      : requiredBytes - size.overheadBytes;

  /*
   * What the engine's fraction is a fraction OF - total memory for vLLM, free
   * memory for SGLang. On an idle box these are nearly the same number and the
   * distinction looks academic; beside a resident server they are not, and
   * getting it wrong is how a run boots successfully with a pool a tenth of the
   * size it was priced at.
   */
  const fractionBasisBytes = !engine
    ? null
    : engine.memoryFractionOf === 'free'
      ? pool.availableBytes
      : pool.totalBytes;

  /*
   * The smallest fraction that still covers what was asked for. vLLM compares
   * its fraction against free memory but computes it from total, so for vLLM
   * this is also the number that decides whether the server starts at all.
   *
   * A service reserves nothing up front - it allocates as it works - so there
   * is no fraction to compute and its declared figure is the whole story.
   */
  const minUtilization =
    engine && fractionBasisBytes
      ? Math.min(MAX_UTILIZATION, Math.max(MIN_UTILIZATION, ceil2(fractionBytes / fractionBasisBytes)))
      : null;

  /* An override buys a deeper prefix cache; below the minimum the KV pool can
   * no longer hold one full-length request and the engine refuses to start. */
  const utilization = engine ? (tuning.override ?? minUtilization) : null;
  /*
   * What the run will actually take out of the machine. For vLLM that is the
   * block and nothing else; for SGLang the overhead sits outside the fraction,
   * so it is added back here - otherwise a fraction that just fits would be
   * shown as fitting while the server went on to allocate gigabytes more.
   */
  const claimBytes =
    fractionBasisBytes && utilization
      ? utilization * fractionBasisBytes + (engine.memoryCoversOverhead ? 0 : size.overheadBytes)
      : null;

  const cached = new Set((snapshot.hf?.repos ?? []).map((repo) => repo.repoId));

  /*
   * Whether the weights are already here, which for the two runtimes is a
   * different question. An engine's repo either appears in `hf cache ls` or does
   * not; a service's files live in a directory of its own, so the poll measures
   * that directory and it counts as present once it is nearly the declared size
   * - `hf download` skips what it already has, so a part-filled directory means
   * part of the fetch remains.
   */
  const repos = engine
    ? [recipe.model, recipe.draft].filter(Boolean).map((repo) => ({
        repoId: repo.repoId,
        repoType: repo.repoType,
        cached: cached.has(repo.repoId),
      }))
    : recipe.weights.map((entry) => ({
        repoId: entry.repoId,
        repoType: entry.repoType,
        cached: cached.has(entry.repoId),
      }));

  const toDownload = repos.filter((repo) => !repo.cached);

  /* Only what is missing costs disk. The split follows the declared sizes, so a
   * partly-fetched recipe still reports a sensible remainder. */
  const downloadBytes = engine
    ? toDownload.reduce(
        (sum, repo) =>
          sum + (repo.repoId === recipe.draft?.repoId ? recipe.memory.draftBytes : recipe.memory.weightsBytes),
        0,
      )
    : recipe.weights
        .filter((entry) => !cached.has(entry.repoId))
        .reduce((sum, entry) => sum + entry.sizeBytes, 0);

  const mount = cacheMount(snapshot);
  const imagePresent = snapshot.dockerImages ? snapshot.dockerImages.includes(recipe.image.ref) : null;

  /*
   * Only a PUBLISHED port is in the way. `docker ps` lists exposed-but-unpublished
   * ports too ("8000/tcp" with no arrow), and those hold nothing on the host - the
   * collector has already stripped the host IP, so the text before "->" is the
   * host port and its absence means nothing was published.
   */
  const publishedPort = (mapping) =>
    mapping.includes('->') ? Number.parseInt(mapping, 10) : null;

  const portHolder = (snapshot.containers ?? []).find(
    (container) =>
      container.state === 'running' &&
      /* Re-running a recipe replaces its own container, so its own name is fine. */
      container.name !== recipe.containerName &&
      container.ports.some((mapping) => publishedPort(mapping) === recipe.port),
  );

  const activeRun = runs.find((run) => ACTIVE_RUN_STATUSES.has(run.status));

  const blockers = [];
  const warnings = [];

  if (!snapshot.online) {
    blockers.push({ code: 'offline', message: 'the node is not responding' });
  }
  if (!snapshot.dockerAvailable) {
    blockers.push({
      code: 'docker',
      message: snapshot.dockerError ?? 'Docker is not available on this node',
    });
  }
  if (toDownload.length > 0 && !snapshot.hf?.available) {
    blockers.push({
      code: 'hf',
      message: 'the hf CLI is not installed on this node, so the weights cannot be fetched',
    });
  }
  if (activeRun) {
    blockers.push({
      code: 'run-active',
      message: `${activeRun.recipeName ?? 'another recipe'} is already being started on this node`,
    });
  }
  if (portHolder) {
    blockers.push({
      code: 'port',
      message: `port ${recipe.port} is already published by "${portHolder.name}"`,
    });
  }

  if (pool.availableBytes === null) {
    blockers.push({ code: 'memory-unknown', message: 'memory has not been read from this node yet' });
  } else {
    if (requiredBytes > pool.availableBytes) {
      blockers.push({
        code: 'memory',
        message:
          `needs about ${round(requiredBytes)} GB of ${pool.unified ? 'unified memory' : 'VRAM'} ` +
          `and only ${round(pool.availableBytes)} GB is free`,
      });
    }
    /*
     * The engine's own startup check, and the one that actually refuses: it
     * compares its fraction x TOTAL memory against FREE memory. On an
     * otherwise-idle Spark 0.95 asks for 115.6 GiB against 114.97 GiB free and
     * the server exits rather than starting - short by 0.63 GiB. Catching it
     * here turns a five-minute weight load ending in an exit into a refusal.
     */
    if (claimBytes !== null && claimBytes > pool.availableBytes) {
      blockers.push({
        code: 'gpu-memory-utilization',
        message:
          `${recipe.runtime} will ask for ${round(claimBytes)} GB (${engine.memoryFlag} ` +
          `${utilization} of total) but only ${round(pool.availableBytes)} GB is free - shorten ` +
          `the context, lower the request count, or free some memory`,
      });
    }
  }

  if (tuning.override !== null && minUtilization !== null && tuning.override < minUtilization) {
    blockers.push({
      code: 'utilization-too-low',
      message:
        `${tuning.override} of total is not enough for ${formatTokens(size.kvTokens)} tokens of KV cache - ` +
        `${minUtilization} is the minimum for these settings`,
    });
  }

  if (mount && downloadBytes > (mount.available ?? 0)) {
    blockers.push({
      code: 'disk',
      message: `the download needs ${round(downloadBytes)} GB and ${mount.mount} has ${round(mount.available)} GB free`,
    });
  }

  if (downloadBytes > 0) {
    warnings.push({
      code: 'download',
      message:
        `${toDownload.map((r) => r.repoId).join(' and ')} ${toDownload.length > 1 ? 'are' : 'is'} not cached here - ` +
        `about ${round(downloadBytes)} GB will be downloaded first, which can take hours`,
    });
  }
  if (imagePresent === false) {
    warnings.push({
      code: 'image',
      message: `${recipe.image.ref} is not on this node yet and will be pulled first`,
    });
  }
  if (toDownload.length > 0 && snapshot.hf?.available && !snapshot.hf.user) {
    warnings.push({
      code: 'hf-anonymous',
      message: 'nobody is signed in to the Hub on this node, so gated repos will fail',
    });
  }
  if (!engine && recipe.memory.memoryMeasured === false) {
    warnings.push({
      code: 'estimate',
      message:
        `the ${round(recipe.memory.overheadBytes)} GB memory figure is declared by the recipe, ` +
        `not measured from a run`,
    });
  }
  if (engine && !recipe.memory.weightsMeasured) {
    warnings.push({
      code: 'estimate',
      message: `the ${round(weightsBytes)} GB weight figure is estimated from the parameter count, not measured`,
    });
  }
  if (engine && recipe.memory.statePerRequestBytes > 0 && !recipe.memory.stateMeasured) {
    warnings.push({
      code: 'state-estimate',
      message:
        `the ${round(recipe.memory.statePerRequestBytes)} GB of recurrent state per request is an ` +
        `estimate, so the cost of raising the request count moves with it`,
    });
  }
  if (engine && !recipe.memory.kvMeasured) {
    warnings.push({
      code: 'kv-estimate',
      message:
        `the KV cache cost of ${(recipe.memory.kvBytesPerToken / 1024).toFixed(1)} KB per token is an ` +
        `estimate, so the memory figure moves with it`,
    });
  }

  return {
    recipeId: recipe.id,
    fits: blockers.length === 0,
    memory: {
      unified: pool.unified,
      weightsBytes,
      overheadBytes: size.overheadBytes,
      kvBytes: size.kvBytes,
      kvTokens: size.kvTokens,
      /* Zero for everything but a hybrid model, where it is per request. */
      stateBytes: size.stateBytes,
      requiredBytes,
      claimBytes,
      availableBytes: pool.availableBytes,
      totalBytes: pool.totalBytes,
    },
    /* Null for a service: there is nothing to tune, and the panel hides the
     * sliders rather than showing controls that do nothing. */
    tuning: !engine ? null : {
      contextLength: tuning.contextLength,
      maxRequests: tuning.maxRequests,
      gpuMemoryUtilization: utilization,
      minUtilization,
      /* The flag this fraction is passed as, which differs per engine. */
      memoryFlag: engine.memoryFlag,
      /* False once the user has pinned a fraction of their own. */
      automatic: tuning.override === null,
      contextOptions: contextOptions(recipe),
      requestOptions: requestOptions(),
    },
    disk: {
      downloadBytes,
      availableBytes: mount?.available ?? null,
      mount: mount?.mount ?? null,
    },
    repos,
    imagePresent,
    blockers,
    warnings,
  };
}

const round = (bytes) => (bytes === null || bytes === undefined ? '?' : (bytes / GB).toFixed(1));

const formatTokens = (tokens) =>
  tokens >= 1e6 ? `${(tokens / 1e6).toFixed(1)}M` : `${Math.round(tokens / 1000)}K`;


export function buildPlanner(snapshot, runs = []) {
  /* The baseline every browser first sees: each recipe at its own defaults. */
  return { runs, plans: RECIPES.map((recipe) => planRecipe(recipe, snapshot, runs)) };
}

/*
 * The argv a run actually gets. The tuned values replace the recipe's defaults
 * here and nowhere else, so what the panel priced and what the container is
 * given cannot come apart.
 */
export function resolveArgs(recipe, tuning) {
  /* A service takes no serving flags at all - its image's own entrypoint knows
   * how to start it - so there is nothing to resolve. */
  const engine = ENGINES[recipe.runtime];
  if (!engine) return [];

  const overrides = {
    [engine.contextFlag]: String(tuning.contextLength),
    [engine.requestsFlag]: String(tuning.maxRequests),
  };

  const args = [];
  for (let i = 0; i < recipe.args.length; i += 1) {
    const arg = recipe.args[i];
    if (arg in overrides) {
      args.push(arg, overrides[arg]);
      i += 1; /* skip the recipe's own value */
      delete overrides[arg];
      continue;
    }
    args.push(arg);
  }

  /* A recipe that never set them still gets them, so the container is explicit
   * about the shape it was priced for. */
  for (const [flag, value] of Object.entries(overrides)) args.push(flag, value);

  args.push(engine.memoryFlag, String(tuning.gpuMemoryUtilization));
  return args;
}
