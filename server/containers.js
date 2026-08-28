import { createRunner } from './exec/index.js';
import { CONTAINER_ID_RE } from './collectors/docker.js';

/*
 * Start / stop / restart a container on a node.
 *
 * Like the power actions, this is a write path, so it is kept narrow: three
 * fixed verbs and an id that must match a hex container id before it is allowed
 * anywhere near a command line. Container names are never accepted - they can
 * contain characters that would need quoting, and the UI always has the id.
 *
 * Note that being able to control the Docker daemon is effectively root on the
 * node. That is the same trust level the existing shutdown/reboot actions
 * assume, and the API is unauthenticated by design (see README).
 */

const ACTIONS = {
  start: 'start',
  stop: 'stop',
  restart: 'restart',
};

/* `docker stop` waits for the container to exit; give it room past the default. */
const TIMEOUT_MS = 25000;

export async function containerAction(node, containerId, action) {
  const verb = ACTIONS[action];
  if (!verb) {
    throw Object.assign(new Error(`unknown container action: ${action}`), { status: 400 });
  }

  const id = String(containerId ?? '');
  if (!CONTAINER_ID_RE.test(id)) {
    throw Object.assign(new Error(`invalid container id: ${containerId}`), { status: 400 });
  }

  const runner = createRunner(node);
  try {
    const { code, stdout, stderr } = await runner.run(`docker ${verb} ${id} 2>&1`, TIMEOUT_MS);
    const output = `${stdout}${stderr}`.trim();

    if (code !== 0) {
      throw Object.assign(new Error(explain(output, id) || `docker ${verb} failed`), { status: 400 });
    }

    return { ok: true, action, containerId: id, node: node.name };
  } finally {
    await runner.close?.();
  }
}

function explain(output, id) {
  if (/permission denied/i.test(output)) {
    return `permission denied - add the SSH user to the "docker" group on this node`;
  }
  if (/no such container/i.test(output)) return `no container ${id.slice(0, 12)} on this node`;
  if (/cannot connect to the docker daemon/i.test(output)) return 'the Docker daemon is not running';
  return output.split('\n')[0]?.slice(0, 200) ?? '';
}
