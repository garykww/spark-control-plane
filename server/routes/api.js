import express from 'express';
import { config } from '../config.js';
import { registry, normaliseNode, ValidationError } from '../registry.js';
import { monitor } from '../monitor.js';
import { createSshRunner } from '../exec/ssh.js';
import { createLocalRunner } from '../exec/local.js';
import { getPassword } from '../secrets.js';
import { listVault, setSecret, clearSecret } from '../vault.js';
import { probeLlmEndpoint } from '../collectors/llm.js';
import { powerAction, wakeOnLan } from '../power.js';
import { containerAction } from '../containers.js';
import {
  startDownload,
  cancelDownload,
  clearJob,
  previewDelete,
  deleteRepo,
  reclaim,
} from '../huggingface.js';
import { ACTIVE_STATUSES } from '../collectors/huggingface.js';
import { startRun, cancelRun, stopRun, clearRun } from '../planner.js';
import { publicRecipes, recipeById, planRecipe, RECIPES_ERROR } from '../recipes.js';
import { DGX_SPARK_SPEC } from '../collectors/specs.js';

export const api = express.Router();

/* Wraps an async handler so a rejected promise reaches the error middleware. */
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

const requireNode = (req) => {
  const node = registry.get(req.params.id);
  if (!node) throw Object.assign(new Error('node not found'), { status: 404 });
  return node;
};

api.get('/health', (req, res) => {
  res.json({ ok: true, demoMode: config.demoMode, uptime: process.uptime() });
});

api.get('/config', (req, res) => {
  res.json({
    demoMode: config.demoMode,
    pollIntervalMs: config.pollIntervalMs,
    pushIntervalMs: config.pushIntervalMs,
    historyLength: config.historyLength,
    sparkSpec: DGX_SPARK_SPEC,
  });
});

/*
 * The vault: control-plane secrets that are not tied to one node. Values are
 * write-only - what comes back says whether a secret is set and shows its last
 * four characters, never the secret itself.
 *
 * A change here applies to the next run started. A container already serving
 * keeps the key it was launched with, which is the key the run panel shows
 * against it, so nothing already running is invalidated by editing this.
 */
api.get('/vault', (req, res) => {
  res.json({ entries: listVault() });
});

api.put('/vault/:name', route(async (req, res) => {
  setSecret(req.params.name, req.body?.value);
  res.json({ entries: listVault() });
}));

api.delete('/vault/:name', route(async (req, res) => {
  clearSecret(req.params.name);
  res.json({ entries: listVault() });
}));

api.get('/nodes', (req, res) => {
  res.json({ nodes: registry.listPublic() });
});

api.post('/nodes', route(async (req, res) => {
  const node = registry.add(req.body ?? {});
  monitor.sync();
  res.status(201).json({ node: { ...node, hasPassword: Boolean(req.body?.password) } });
}));

api.patch('/nodes/:id', route(async (req, res) => {
  requireNode(req);
  const node = registry.update(req.params.id, req.body ?? {});
  monitor.refresh(req.params.id);
  monitor.sync();
  res.json({ node });
}));

api.delete('/nodes/:id', route(async (req, res) => {
  requireNode(req);
  registry.remove(req.params.id);
  monitor.sync();
  res.status(204).end();
}));

api.post('/nodes/reorder', route(async (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids)) throw new ValidationError('ids must be an array of node ids');
  res.json({ nodes: registry.reorder(ids.map(String)) });
}));

/*
 * Validates a node's connection details before they are saved, so the add/edit
 * dialog can report a bad key or an unreachable port instead of silently
 * producing a node that never comes online.
 */
api.post('/nodes/test', route(async (req, res) => {
  const input = req.body ?? {};
  /* A node can be tested before it has been named, so stand in a placeholder
   * rather than failing validation on the empty name field. */
  const candidate = normaliseNode({ ...input, name: input.name?.trim() || 'connection test' });

  /* Prefer a password typed into the dialog; fall back to the stored one. */
  const password = input.password || (input.id ? getPassword(input.id) : null);
  const runner = candidate.connection === 'local'
    ? createLocalRunner()
    : createSshRunner(candidate, password);

  const result = { connection: { ok: false, detail: null }, gpu: { ok: false, detail: null }, llm: [] };

  try {
    const shell = await runner.run('echo spark-ok; nvidia-smi -L 2>/dev/null | head -4', 10000);
    if (shell.stdout.includes('spark-ok')) {
      result.connection = { ok: true, detail: `connected to ${runner.describe()}` };
      const gpuLines = shell.stdout.split('\n').filter((l) => l.startsWith('GPU '));
      result.gpu = gpuLines.length
        ? { ok: true, detail: gpuLines.join('; ') }
        : { ok: false, detail: 'nvidia-smi found no GPU (or is not installed)' };
    } else {
      const reason = shell.stderr.trim().split('\n')[0] || `exit code ${shell.code}`;
      result.connection = { ok: false, detail: reason };
    }
  } catch (err) {
    result.connection = { ok: false, detail: String(err?.message || err) };
  } finally {
    await runner.close?.();
  }

  for (const entry of candidate.llmPorts ?? []) {
    const probe = await probeLlmEndpoint({ host: candidate.host, port: entry.port, label: entry.label });
    result.llm.push({
      port: entry.port,
      ok: probe.online,
      detail: probe.online
        ? `${probe.backend}${probe.models.length ? ` - ${probe.models[0]}` : ''}`
        : probe.error,
    });
  }

  res.json(result);
}));

api.post('/nodes/:id/power', route(async (req, res) => {
  const node = requireNode(req);
  const action = String(req.body?.action ?? '');

  if (action === 'wake') {
    if (!node.macAddress) throw new ValidationError(`${node.name} has no MAC address configured`);
    res.json(await wakeOnLan(node.macAddress, req.body?.broadcast));
    return;
  }

  res.json(await powerAction(node, action));
}));

/*
 * Start, stop or restart a container. The id is validated as hex before it
 * reaches a command line, and only three fixed verbs are accepted.
 */
api.post('/nodes/:id/containers/:containerId/:action', route(async (req, res) => {
  const node = requireNode(req);
  const result = await containerAction(node, req.params.containerId, req.params.action);
  /* Re-poll promptly so the UI reflects the new state without waiting a full tick. */
  monitor.refreshSoon(req.params.id);
  res.json(result);
}));

/*
 * HuggingFace cache management. Downloads are launched detached on the node and
 * their state is polled, so this route returns as soon as the job is running,
 * not when it finishes - a 70 GB pull takes hours.
 */
api.post('/nodes/:id/hf/downloads', route(async (req, res) => {
  const node = requireNode(req);
  const result = await startDownload(node, req.body ?? {});
  monitor.refreshHf(req.params.id);
  res.status(201).json(result);
}));

api.post('/nodes/:id/hf/downloads/:jobId/cancel', route(async (req, res) => {
  const node = requireNode(req);
  const result = await cancelDownload(node, req.params.jobId);
  monitor.refreshHf(req.params.id);
  res.json(result);
}));

api.delete('/nodes/:id/hf/jobs/:jobId', route(async (req, res) => {
  const node = requireNode(req);
  await clearJob(node, req.params.jobId);
  monitor.refreshHf(req.params.id);
  res.status(204).end();
}));

/* Preview first, so the confirm dialog can state the real cost of the delete. */
api.post('/nodes/:id/hf/preview-delete', route(async (req, res) => {
  const node = requireNode(req);
  res.json(await previewDelete(node, req.body ?? {}));
}));

api.post('/nodes/:id/hf/delete', route(async (req, res) => {
  const node = requireNode(req);
  const result = await deleteRepo(node, req.body ?? {});
  monitor.refreshHf(req.params.id);
  res.json(result);
}));

api.post('/nodes/:id/hf/reclaim', route(async (req, res) => {
  const node = requireNode(req);
  const target = String(req.body?.target ?? '');

  /*
   * Partial blobs belonging to a live download must not be swept. The job script
   * also guards this with a 60-minute age filter; this is the earlier, clearer
   * refusal.
   */
  if (target === 'incomplete') {
    const hf = monitor.hfFor(req.params.id);
    if (hf?.jobs.some((job) => ACTIVE_STATUSES.has(job.status))) {
      throw new ValidationError('a download is in progress - wait for it to finish before reclaiming');
    }
  }

  const result = await reclaim(node, target);
  monitor.refreshHf(req.params.id);
  res.json(result);
}));

/*
 * Run planner. A recipe is a whole serving configuration; starting one fetches
 * the weights, gets the image and launches the container, which takes hours the
 * first time. Like a HuggingFace download it runs detached on the node, so this
 * route returns once the sequence is under way, not when the model is serving.
 */
api.get('/recipes', (req, res) => {
  /* An unreadable or invalid recipe file is reported rather than looking like
   * an empty catalogue - the person who just edited it needs to see why. */
  res.json({ recipes: publicRecipes(), error: RECIPES_ERROR });
});

/* Reads the tuning knobs off a request body. Every one is optional; the plan
 * falls back to the recipe's own defaults for whatever is missing. */
const tuningFrom = (body) => ({
  contextLength: body?.contextLength,
  maxRequests: body?.maxRequests,
  gpuMemoryUtilization: body?.gpuMemoryUtilization,
});

/*
 * Prices one recipe at a given context length and concurrency.
 *
 * The panel calls this as the knobs move, rather than doing the arithmetic
 * itself, so there is exactly one implementation of it and the figure shown is
 * by construction the figure the launch route will enforce.
 */
api.post('/nodes/:id/plan', route(async (req, res) => {
  requireNode(req);
  const recipe = recipeById(req.body?.recipeId);

  const snapshot = monitor.snapshotFor(req.params.id);
  if (!snapshot) throw new ValidationError('this node has not been polled yet');

  res.json({
    plan: planRecipe(recipe, snapshot, snapshot.planner?.runs ?? [], tuningFrom(req.body)),
  });
}));

api.post('/nodes/:id/runs', route(async (req, res) => {
  const node = requireNode(req);
  const recipe = recipeById(req.body?.recipeId);

  /*
   * Planned again here rather than trusting the browser's answer. The check is
   * cheap and the alternative is expensive: a recipe that does not fit spends
   * an hour downloading weights before vLLM refuses to start. It runs against
   * the monitor's latest snapshot, which is the same one the UI was rendering.
   */
  const snapshot = monitor.snapshotFor(req.params.id);
  if (!snapshot) throw new ValidationError('this node has not been polled yet');

  const plan = planRecipe(recipe, snapshot, snapshot.planner?.runs ?? [], tuningFrom(req.body));
  if (!plan.fits) {
    throw new ValidationError(`${recipe.name} cannot run on ${node.name}: ${plan.blockers[0].message}`);
  }

  /* The plan's own resolved tuning, not the request body: the memory fraction
   * is computed against a live reading and is not a caller's to assert. */
  const result = await startRun(node, {
    recipeId: recipe.id,
    port: req.body?.port,
    tuning: plan.tuning,
  });
  monitor.refreshSoon(req.params.id);
  res.status(201).json(result);
}));

/* Stops the sequence wherever it has got to, and removes the container if one
 * was already started. */
api.post('/nodes/:id/runs/:runId/cancel', route(async (req, res) => {
  const node = requireNode(req);
  const result = await cancelRun(node, req.params.runId);
  monitor.refreshSoon(req.params.id);
  res.json(result);
}));

/* Stops the server a finished run left behind; the run itself is already over. */
api.post('/nodes/:id/runs/:runId/stop', route(async (req, res) => {
  const node = requireNode(req);
  const result = await stopRun(node, req.params.runId);
  monitor.refreshSoon(req.params.id);
  res.json(result);
}));

api.delete('/nodes/:id/runs/:runId', route(async (req, res) => {
  const node = requireNode(req);
  await clearRun(node, req.params.runId);
  monitor.refreshSoon(req.params.id);
  res.status(204).end();
}));

api.get('/snapshot', (req, res) => {
  res.json(monitor.snapshot());
});

api.get('/history', (req, res) => {
  res.json({ history: monitor.allHistory() });
});

api.get('/history/:id', route(async (req, res) => {
  requireNode(req);
  const history = monitor.historyFor(req.params.id);
  if (!history) throw Object.assign(new Error('no history for this node yet'), { status: 404 });
  res.json({ history });
}));

/* Final handler: turns thrown errors into a consistent JSON shape. */
api.use((err, req, res, next) => {
  const status = err?.status ?? 500;
  if (status >= 500) console.error('[api]', err);
  res.status(status).json({ error: String(err?.message || 'internal error') });
});
