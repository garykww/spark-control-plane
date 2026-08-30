import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const config = {
  port: int(process.env.PORT, 5555),
  /* Loopback by default. Set BIND_HOST=0.0.0.0 (or a LAN IP) to expose on the network. */
  bindHost: process.env.BIND_HOST || '127.0.0.1',

  rootDir: path.resolve(here, '..'),
  configDir: process.env.CONFIG_DIR || path.resolve(here, '..', 'config'),

  /* How often each node is polled, and how often snapshots are pushed to browsers. */
  pollIntervalMs: int(process.env.POLL_INTERVAL_MS, 2000),
  pushIntervalMs: int(process.env.PUSH_INTERVAL_MS, 1000),

  /* Samples kept per metric for sparklines (300 x 2s poll = 10 minutes). */
  historyLength: int(process.env.HISTORY_LENGTH, 300),

  /* Timeouts, kept short so one hung host cannot stall the poll loop. */
  sshConnectTimeoutSec: int(process.env.SSH_CONNECT_TIMEOUT, 5),
  commandTimeoutMs: int(process.env.COMMAND_TIMEOUT_MS, 8000),
  httpProbeTimeoutMs: int(process.env.HTTP_PROBE_TIMEOUT_MS, 3000),

  /* Consecutive poll failures before a node is marked offline. */
  offlineThreshold: int(process.env.OFFLINE_THRESHOLD, 3),

  /* The HuggingFace cache listing is ~0.4s and rarely changes, so it runs on its
   * own slow cadence rather than with the 2s metrics batch. */
  hfCacheIntervalMs: int(process.env.HF_CACHE_INTERVAL_MS, 30000),
  hfCommandTimeoutMs: int(process.env.HF_COMMAND_TIMEOUT_MS, 25000),

  /* Key used to encrypt stored SSH passwords. Generated on first run if unset. */
  secretKey: process.env.SECRET_KEY || null,

  /* Serves synthetic metrics so the UI can be developed away from real hardware. */
  demoMode: process.env.DEMO_MODE === '1' || process.env.DEMO_MODE === 'true',

  isProduction: process.env.NODE_ENV === 'production',
};

export const paths = {
  nodes: path.join(config.configDir, 'nodes.json'),
  secrets: path.join(config.configDir, 'nodes-secrets.json'),
  key: path.join(config.configDir, '.secret-key'),
};
