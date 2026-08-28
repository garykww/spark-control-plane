import type { NodeConfig, TestResult } from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(data?.error ?? `request failed with status ${response.status}`);
  }
  return data as T;
}

/* The payload the add/edit dialog sends. `password` is write-only: it is never
 * returned by any endpoint, and an empty string clears the stored one. */
export interface NodeInput {
  name: string;
  type: NodeConfig['type'];
  connection: NodeConfig['connection'];
  host: string;
  sshUser: string;
  sshPort: number;
  sshKeyPath: string | null;
  llmPorts: { port: number; label: string }[];
  macAddress: string | null;
  enabled: boolean;
  password?: string;
}

export const api = {
  listNodes: () => request<{ nodes: NodeConfig[] }>('/nodes').then((r) => r.nodes),

  createNode: (input: NodeInput) =>
    request<{ node: NodeConfig }>('/nodes', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.node),

  updateNode: (id: string, input: Partial<NodeInput>) =>
    request<{ node: NodeConfig }>(`/nodes/${id}`, { method: 'PATCH', body: JSON.stringify(input) }).then((r) => r.node),

  deleteNode: (id: string) => request<void>(`/nodes/${id}`, { method: 'DELETE' }),

  reorderNodes: (ids: string[]) =>
    request<{ nodes: NodeConfig[] }>('/nodes/reorder', { method: 'POST', body: JSON.stringify({ ids }) }).then((r) => r.nodes),

  testNode: (input: Partial<NodeInput> & { id?: string }) =>
    request<TestResult>('/nodes/test', { method: 'POST', body: JSON.stringify(input) }),

  power: (id: string, action: 'shutdown' | 'reboot' | 'wake') =>
    request<{ ok: boolean }>(`/nodes/${id}/power`, { method: 'POST', body: JSON.stringify({ action }) }),
};
