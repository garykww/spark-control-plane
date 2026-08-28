import express from 'express';
import { config } from '../config.js';
import { registry, normaliseNode, ValidationError } from '../registry.js';
import { monitor } from '../monitor.js';
import { createSshRunner } from '../exec/ssh.js';
import { createLocalRunner } from '../exec/local.js';
import { getPassword } from '../secrets.js';
import { probeLlmEndpoint } from '../collectors/llm.js';
import { powerAction, wakeOnLan } from '../power.js';
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
