import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import { exec } from './local.js';

/*
 * Remote hosts are driven through the system ssh client rather than a native
 * SSH library. That keeps the image dependency-free on arm64 and lets the user's
 * existing ~/.ssh/config, agent and keys work unchanged.
 *
 * Connections are multiplexed with ControlMaster so the 1-2s poll loop reuses a
 * single TCP/auth session per host instead of re-handshaking every tick.
 */
/*
 * A unix socket path cannot exceed ~104 bytes, and macOS hands out $TMPDIR
 * paths long enough to blow that on their own. Pick the shortest usable base
 * directory, and name sockets by a short hash rather than the node's UUID.
 */
function pickControlDir() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const candidates = [path.join(os.tmpdir(), 'spark-cp-ssh'), `/tmp/spark-cp-ssh-${uid}`];

  for (const dir of candidates) {
    /* 8-char hash + ".sock" + separator, with room to spare under the limit. */
    if (dir.length + 15 > 100) continue;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    } catch {
      /* Try the next candidate. */
    }
  }
  return null;
}

const controlDir = pickControlDir();

const socketFor = (nodeId) =>
  path.join(controlDir, `${crypto.createHash('sha256').update(nodeId).digest('hex').slice(0, 8)}.sock`);

const BASE_OPTIONS = [
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'LogLevel=ERROR',
];

/* Multiplexing is a performance optimisation, not a requirement: if no short
 * enough socket directory exists, fall back to a fresh connection per poll. */
const MULTIPLEX_OPTIONS = controlDir
  ? ['-o', 'ControlMaster=auto', '-o', 'ControlPersist=60s']
  : [];

export function createSshRunner(node, password) {
  const user = node.sshUser || 'nvidia';
  const host = node.host;
  const port = node.sshPort || 22;
  const options = [
    ...BASE_OPTIONS,
    ...MULTIPLEX_OPTIONS,
    '-o', `ConnectTimeout=${config.sshConnectTimeoutSec}`,
    '-p', String(port),
  ];

  if (controlDir) options.push('-o', `ControlPath=${socketFor(node.id)}`);

  if (node.sshKeyPath) {
    options.push('-o', 'IdentitiesOnly=yes', '-i', node.sshKeyPath);
  }

  /*
   * BatchMode blocks password prompts, so password auth is delegated to sshpass.
   * The password is passed through the environment (SSHPASS) rather than argv so
   * it does not show up in the host's process list.
   */
  const usePassword = Boolean(password) && !node.sshKeyPath;
  if (usePassword) {
    const idx = options.indexOf('BatchMode=yes');
    if (idx >= 0) options[idx] = 'BatchMode=no';
    options.push('-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password');
  }

  return {
    kind: 'ssh',
    describe: () => `${user}@${host}:${port}`,
    run: (command, timeoutMs = config.commandTimeoutMs) => {
      const args = [...options, `${user}@${host}`, command];
      if (usePassword) {
        return exec('sshpass', ['-e', 'ssh', ...args], timeoutMs, { SSHPASS: password });
      }
      return exec('ssh', args, timeoutMs);
    },
    close: async () => {
      if (!controlDir) return;
      await exec('ssh', [...options, '-O', 'exit', `${user}@${host}`], 2000);
    },
  };
}
