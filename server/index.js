import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { api } from './routes/api.js';
import { registry, seedLocalNodeIfEmpty } from './registry.js';
import { monitor } from './monitor.js';
import { publicRecipes, RECIPES_ERROR } from './recipes.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use('/api', api);

/*
 * In production the built SPA is served from dist/. In development Vite serves
 * the frontend on its own port and proxies /api and /ws back here, so there is
 * nothing to serve.
 */
const distDir = path.join(config.rootDir, 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, { maxAge: '1h', index: false }));
  /* Client-side routing: any non-API path falls through to the SPA shell. */
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
} else if (config.isProduction) {
  console.warn('[server] dist/ not found - run `npm run build` to serve the UI');
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const send = (socket, type, payload) => {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type, payload }));
};

wss.on('connection', (socket) => {
  /*
   * A new tab gets the full picture immediately - config, node list, the latest
   * snapshot and the recorded history - so its charts are populated on the first
   * frame rather than filling in over the next few minutes.
   */
  send(socket, 'init', {
    config: {
      demoMode: config.demoMode,
      pollIntervalMs: config.pollIntervalMs,
      historyLength: config.historyLength,
    },
    nodes: registry.listPublic(),
    /* Static for the life of the process, so it ships once per connection
     * rather than riding every snapshot push. */
    recipes: publicRecipes(),
    recipesError: RECIPES_ERROR,
    snapshot: monitor.snapshot(),
    history: monitor.allHistory(),
  });

  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  socket.on('message', (raw) => {
    /* The only client message is a keepalive; everything else goes through REST. */
    try {
      const { type } = JSON.parse(raw.toString());
      if (type === 'ping') send(socket, 'pong', { at: Date.now() });
    } catch {
      /* Ignore malformed frames. */
    }
  });
});

const broadcast = (type, payload) => {
  const message = JSON.stringify({ type, payload });
  for (const socket of wss.clients) {
    if (socket.readyState === socket.OPEN) socket.send(message);
  }
};

monitor.on('snapshot', (snapshot) => broadcast('snapshot', snapshot));

/* Drops connections that stopped responding, e.g. a laptop that slept. */
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30000);

fs.mkdirSync(config.configDir, { recursive: true });
seedLocalNodeIfEmpty();
monitor.start();

server.listen(config.port, config.bindHost, () => {
  const nodeCount = registry.list().length;
  console.log(`[server] listening on http://${config.bindHost}:${config.port}`);
  console.log(`[server] monitoring ${nodeCount} node${nodeCount === 1 ? '' : 's'}${config.demoMode ? ' (demo mode)' : ''}`);
  if (RECIPES_ERROR) console.warn(`[server] run planner disabled - ${RECIPES_ERROR}`);
  if (config.bindHost === '127.0.0.1') {
    console.log('[server] bound to loopback - set BIND_HOST=0.0.0.0 to reach it from the LAN');
  }
});

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] ${signal} received, shutting down`);

  clearInterval(heartbeat);
  for (const socket of wss.clients) socket.close(1001, 'server shutting down');
  await monitor.stop();

  server.close(() => process.exit(0));
  /* Do not let a lingering keep-alive connection block the exit. */
  setTimeout(() => process.exit(0), 3000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
