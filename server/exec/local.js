import { spawn } from 'node:child_process';
import { config } from '../config.js';

/*
 * Runs a shell command on the machine hosting this server.
 *
 * In Docker the interesting parts of the host (sysfs, nvidia-smi, the real
 * network namespace) are not visible from inside the container, so commands are
 * optionally re-entered into the host namespace with nsenter. Set
 * HOST_NSENTER=1 and run the container with --pid=host --privileged.
 */
const useNsenter = process.env.HOST_NSENTER === '1' || process.env.HOST_NSENTER === 'true';

export function createLocalRunner() {
  return {
    kind: 'local',
    describe: () => 'local',
    run: (command, timeoutMs = config.commandTimeoutMs) => {
      const wrapped = useNsenter
        ? ['nsenter', ['-t', '1', '-m', '-u', '-n', '-i', 'sh', '-c', command]]
        : ['sh', ['-c', command]];
      return exec(wrapped[0], wrapped[1], timeoutMs);
    },
    close: () => {},
  };
}

export function exec(file, args, timeoutMs, extraEnv) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
      });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err?.message || err) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: -1, stdout, stderr: stderr || `timed out after ${timeoutMs}ms`, timedOut: true });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish({ code: -1, stdout, stderr: String(err?.message || err) }));
    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr }));
  });
}
