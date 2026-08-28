import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from './config.js';
import { setPassword, deletePassword, hasPassword } from './secrets.js';

/*
 * The set of monitored nodes, persisted to config/nodes.json. Nodes can be
 * added, edited, reordered and removed while the server runs; monitor.js reads
 * the registry on every poll rather than caching it, so changes take effect on
 * the next tick with no restart.
 *
 * SSH passwords never live in this file - they go to the encrypted secret store
 * and are never returned by any API response.
 */

export const NODE_TYPES = ['dgx-spark', 'gpu-host'];
export const CONNECTIONS = ['local', 'ssh'];

const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const MAC_RE = /^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

/*
 * Blocks address ranges that should never be a monitoring target, so a typo (or
 * a hostile config POST on a trusted LAN) cannot turn the poll loop into a
 * scanner of broadcast/multicast space.
 */
function assertSafeTarget(host) {
  if (!host || typeof host !== 'string') throw new ValidationError('host is required');
  const value = host.trim();
  if (value.length > 255) throw new ValidationError('host is too long');

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) {
    const octets = v4.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) throw new ValidationError(`invalid IPv4 address: ${value}`);
    const [a, b] = octets;
    if (a === 0) throw new ValidationError('"this network" addresses (0.x.x.x) are not valid targets');
    if (a === 169 && b === 254) throw new ValidationError('link-local addresses (169.254.x.x) are not valid targets');
    if (a >= 224) throw new ValidationError('multicast and reserved addresses (224.0.0.0+) are not valid targets');
    if (octets.every((o) => o === 255)) throw new ValidationError('broadcast address is not a valid target');
    return value;
  }

  /* Bracketed IPv6 or a bare hostname. */
  if (value.includes(':')) return value;
  if (!HOSTNAME_RE.test(value)) throw new ValidationError(`invalid hostname: ${value}`);
  return value;
}

function assertPort(value, field) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ValidationError(`${field} must be a port between 1 and 65535`);
  }
  return port;
}

function normaliseLlmPorts(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 12).map((entry) => {
    const port = assertPort(typeof entry === 'object' ? entry.port : entry, 'llmPorts[]');
    const label = typeof entry === 'object' && entry.label ? String(entry.label).slice(0, 40) : '';
    return { port, label };
  });
}

export function normaliseNode(input, existing = null) {
  const name = String(input.name ?? existing?.name ?? '').trim();
  if (!name) throw new ValidationError('name is required');
  if (name.length > 60) throw new ValidationError('name must be 60 characters or fewer');

  const type = input.type ?? existing?.type ?? 'dgx-spark';
  if (!NODE_TYPES.includes(type)) throw new ValidationError(`type must be one of ${NODE_TYPES.join(', ')}`);

  const connection = input.connection ?? existing?.connection ?? 'ssh';
  if (!CONNECTIONS.includes(connection)) {
    throw new ValidationError(`connection must be one of ${CONNECTIONS.join(', ')}`);
  }

  const node = {
    id: existing?.id ?? crypto.randomUUID(),
    name,
    type,
    connection,
    host: connection === 'local' ? 'localhost' : assertSafeTarget(input.host ?? existing?.host),
    sshUser: String(input.sshUser ?? existing?.sshUser ?? 'nvidia').trim().slice(0, 60),
    sshPort: connection === 'local' ? 22 : assertPort(input.sshPort ?? existing?.sshPort ?? 22, 'sshPort'),
    sshKeyPath: (input.sshKeyPath ?? existing?.sshKeyPath ?? '').trim() || null,
    llmPorts: input.llmPorts === undefined ? existing?.llmPorts ?? [] : normaliseLlmPorts(input.llmPorts),
    macAddress: null,
    enabled: input.enabled === undefined ? existing?.enabled ?? true : Boolean(input.enabled),
    order: Number.isFinite(Number(input.order)) ? Number(input.order) : existing?.order ?? 0,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };

  const mac = (input.macAddress ?? existing?.macAddress ?? '').trim();
  if (mac) {
    if (!MAC_RE.test(mac)) throw new ValidationError(`invalid MAC address: ${mac}`);
    node.macAddress = mac.toLowerCase().replace(/-/g, ':');
  }

  return node;
}

class Registry {
  #nodes = [];

  constructor() {
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(paths.nodes, 'utf8'));
      this.#nodes = (Array.isArray(raw) ? raw : raw.nodes ?? []).map((n) => normaliseNode(n, n));
    } catch {
      this.#nodes = [];
    }
    this.#sort();
  }

  #sort() {
    this.#nodes.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  }

  #persist() {
    fs.mkdirSync(path.dirname(paths.nodes), { recursive: true });
    fs.writeFileSync(paths.nodes, JSON.stringify(this.#nodes, null, 2));
  }

  list() {
    return this.#nodes.map((n) => ({ ...n }));
  }

  /* The shape sent to browsers: adds a password flag, never the password. */
  listPublic() {
    return this.#nodes.map((n) => ({ ...n, hasPassword: hasPassword(n.id) }));
  }

  get(id) {
    return this.#nodes.find((n) => n.id === id) ?? null;
  }

  add(input) {
    const order = input.order ?? (this.#nodes.at(-1)?.order ?? -1) + 1;
    const node = normaliseNode({ ...input, order });

    if (this.#nodes.some((n) => n.name.toLowerCase() === node.name.toLowerCase())) {
      throw new ValidationError(`a node named "${node.name}" already exists`);
    }
    if (node.connection === 'local' && this.#nodes.some((n) => n.connection === 'local')) {
      throw new ValidationError('a local node is already registered');
    }

    this.#nodes.push(node);
    if (input.password) setPassword(node.id, input.password);
    this.#sort();
    this.#persist();
    return node;
  }

  update(id, input) {
    const index = this.#nodes.findIndex((n) => n.id === id);
    if (index === -1) return null;

    const updated = normaliseNode(input, this.#nodes[index]);
    const clash = this.#nodes.some(
      (n) => n.id !== id && n.name.toLowerCase() === updated.name.toLowerCase(),
    );
    if (clash) throw new ValidationError(`a node named "${updated.name}" already exists`);

    this.#nodes[index] = updated;

    /* An empty string clears the stored password; undefined leaves it alone. */
    if (input.password) setPassword(id, input.password);
    else if (input.password === '') deletePassword(id);

    this.#sort();
    this.#persist();
    return updated;
  }

  remove(id) {
    const index = this.#nodes.findIndex((n) => n.id === id);
    if (index === -1) return false;
    this.#nodes.splice(index, 1);
    deletePassword(id);
    this.#persist();
    return true;
  }

  reorder(orderedIds) {
    const position = new Map(orderedIds.map((id, i) => [id, i]));
    for (const node of this.#nodes) {
      const next = position.get(node.id);
      if (next !== undefined) node.order = next;
    }
    this.#sort();
    this.#persist();
    return this.list();
  }
}

export const registry = new Registry();

/*
 * A fresh install with no nodes.json still has something useful to show: when
 * the server runs on Linux with an NVIDIA GPU present, register the host itself.
 */
export function seedLocalNodeIfEmpty() {
  if (registry.list().length > 0) return;
  if (config.demoMode) {
    registry.add({ name: 'spark-demo-01', type: 'dgx-spark', connection: 'ssh', host: '10.0.0.11' });
    registry.add({ name: 'spark-demo-02', type: 'dgx-spark', connection: 'ssh', host: '10.0.0.12' });
    registry.add({ name: 'workstation', type: 'gpu-host', connection: 'ssh', host: '10.0.0.20' });
    return;
  }
  if (process.platform !== 'linux') return;
  registry.add({ name: 'localhost', type: 'dgx-spark', connection: 'local' });
}
