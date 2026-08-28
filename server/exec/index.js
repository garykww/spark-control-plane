import { createLocalRunner } from './local.js';
import { createSshRunner } from './ssh.js';
import { getPassword } from '../secrets.js';

export function createRunner(node) {
  if (node.connection === 'local') return createLocalRunner();
  return createSshRunner(node, getPassword(node.id));
}

const MARKER = '@@SPARK-SECTION@@';

/*
 * Collecting a snapshot needs a dozen small reads. Issuing them one at a time
 * would mean a dozen SSH round trips per poll, so they are concatenated into a
 * single shell script whose output is split back apart on a marker line.
 *
 * Every section is wrapped so a missing file or absent binary yields an empty
 * section instead of aborting the batch.
 */
export async function runBatch(runner, commands, timeoutMs) {
  const keys = Object.keys(commands);
  if (keys.length === 0) return {};

  const script = keys
    .map((key) => `printf '\\n${MARKER}%s\\n' '${key}'; { ${commands[key]} ; } 2>/dev/null || true`)
    .join('; ');

  const { stdout, code, stderr, timedOut } = await runner.run(script, timeoutMs);
  if (timedOut) throw new Error(`command batch timed out (${runner.describe()})`);
  if (code !== 0 && !stdout) {
    throw new Error(stderr.trim().split('\n')[0] || `command batch failed with code ${code}`);
  }

  const out = {};
  for (const key of keys) out[key] = '';

  for (const chunk of stdout.split(MARKER).slice(1)) {
    const newline = chunk.indexOf('\n');
    if (newline === -1) continue;
    const key = chunk.slice(0, newline).trim();
    if (key in out) out[key] = chunk.slice(newline + 1).replace(/\n$/, '');
  }
  return out;
}
