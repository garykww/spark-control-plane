/*
 * Container inventory via `docker ps`. Kept to a single cheap call: the poll
 * loop runs every couple of seconds, and `docker stats` blocks for about a
 * second per invocation, so per-container CPU and memory are deliberately not
 * collected here.
 *
 * stderr is folded into the section rather than discarded, because the most
 * common failure has a specific fix the user needs to see: the SSH user is not
 * in the `docker` group, and the daemon answers "permission denied".
 */

export const DOCKER_COMMANDS = {
  docker: "docker ps --all --no-trunc --format '{{json .}}' 2>&1",
  /* Local image tags, which is how the run planner knows whether a recipe still
   * has an image to pull. Reads local metadata only - no registry round trip -
   * so it costs about as little as `docker ps`. */
  dockerImages: "docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null",
};

/* Docker IDs are hex. Anything else never reaches a command line. */
export const CONTAINER_ID_RE = /^[a-f0-9]{12,64}$/;

const RUNNING = /^(running|up)/i;

/*
 * `docker ps` reports state as a machine-readable word (State) and a human
 * sentence (Status, e.g. "Up 3 hours" or "Exited (0) 2 days ago"). Older
 * daemons omit State, so fall back to reading Status.
 */
function readState(entry) {
  const state = String(entry.State ?? '').toLowerCase();
  if (state) return state;
  return RUNNING.test(String(entry.Status ?? '')) ? 'running' : 'exited';
}

/* "0.0.0.0:8000->8000/tcp, :::8000->8000/tcp" -> ["8000->8000/tcp"] */
function readPorts(raw) {
  const seen = new Set();
  for (const chunk of String(raw ?? '').split(',')) {
    const mapping = chunk.trim();
    if (!mapping) continue;
    /* Collapse the IPv4 and IPv6 publications of the same port into one entry. */
    seen.add(mapping.replace(/^[^:]*:(?=\d)/, '').replace(/^:::/, ''));
  }
  return [...seen].slice(0, 8);
}

export function parseContainers(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { containers: [], error: null, available: false };

  const containers = [];
  const problems = [];

  for (const line of trimmed.split('\n')) {
    const candidate = line.trim();
    if (!candidate) continue;

    if (!candidate.startsWith('{')) {
      problems.push(candidate);
      continue;
    }

    let entry;
    try {
      entry = JSON.parse(candidate);
    } catch {
      problems.push(candidate);
      continue;
    }

    const id = String(entry.ID ?? entry.Id ?? '');
    if (!CONTAINER_ID_RE.test(id)) continue;

    containers.push({
      id,
      /* A container in a compose project can carry several comma-joined names. */
      name: String(entry.Names ?? '').split(',')[0].trim() || id.slice(0, 12),
      image: String(entry.Image ?? 'unknown'),
      state: readState(entry),
      status: String(entry.Status ?? ''),
      ports: readPorts(entry.Ports),
      createdAt: String(entry.CreatedAt ?? ''),
    });
  }

  if (containers.length === 0 && problems.length > 0) {
    return { containers: [], error: describeProblem(problems.join(' ')), available: false };
  }

  /* Running first, then alphabetical, so the interesting rows are at the top. */
  containers.sort((a, b) => {
    const running = Number(b.state === 'running') - Number(a.state === 'running');
    return running || a.name.localeCompare(b.name);
  });

  return { containers, error: null, available: true };
}

/*
 * Image tags as `repository:tag`. Untagged layers report "<none>" for either
 * half and are dropped: nothing can be run by that name, so listing them would
 * only make the planner's "already pulled" answer wrong.
 */
export function parseImages(text) {
  const refs = new Set();
  for (const line of String(text ?? '').split('\n')) {
    const ref = line.trim();
    if (!ref || ref.includes('<none>')) continue;
    refs.add(ref);
  }
  return [...refs];
}

function describeProblem(message) {
  if (/permission denied/i.test(message)) {
    return 'permission denied - add the SSH user to the "docker" group on this node';
  }
  if (/command not found|not found/i.test(message)) return null; /* Docker simply is not installed. */
  if (/cannot connect to the docker daemon/i.test(message)) return 'the Docker daemon is not running';
  return message.slice(0, 200);
}
