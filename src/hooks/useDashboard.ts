import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryMap, NodeConfig, Recipe, Snapshot } from '../lib/types';
import { api } from '../lib/api';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'offline';

interface DashboardState {
  connection: ConnectionState;
  snapshot: Snapshot | null;
  nodes: NodeConfig[];
  history: HistoryMap;
  /* The recipe catalogue is fixed for the life of the server, so it ships with
   * the init frame rather than riding every snapshot push. */
  recipes: Recipe[];
  /* Set when the recipe file could not be read or is invalid. */
  recipesError: string | null;
  demoMode: boolean;
}

const SERIES_KEYS = [
  'gpuUtilization',
  'gpuMemoryPercent',
  'gpuTemperature',
  'gpuPower',
  'cpuPercent',
  'memoryPercent',
  'networkRx',
  'networkTx',
  'llmDecodeRate',
  'llmPrefillRate',
] as const;

const EMPTY_HISTORY = () => ({
  timestamps: [],
  gpuUtilization: [],
  gpuMemoryPercent: [],
  gpuTemperature: [],
  gpuPower: [],
  cpuPercent: [],
  memoryPercent: [],
  networkRx: [],
  networkTx: [],
  llmDecodeRate: [],
  llmPrefillRate: [],
});

const sum = <T,>(items: T[], pick: (item: T) => number) =>
  items.reduce((acc, item) => acc + (pick(item) || 0), 0);

/*
 * Owns the WebSocket to the server and the derived chart history.
 *
 * The server sends its recorded history once on connect, then a snapshot per
 * push interval; those snapshots are appended here so the sparklines keep
 * extending without refetching the whole buffer each tick.
 */
export function useDashboard(historyLength = 300) {
  const [state, setState] = useState<DashboardState>({
    connection: 'connecting',
    snapshot: null,
    nodes: [],
    history: {},
    recipes: [],
    recipesError: null,
    demoMode: false,
  });

  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const closedRef = useRef(false);

  const refreshNodes = useCallback(async () => {
    const nodes = await api.listNodes();
    setState((s) => ({ ...s, nodes }));
    return nodes;
  }, []);

  useEffect(() => {
    closedRef.current = false;
    let reconnectTimer: number | undefined;

    const connect = () => {
      if (closedRef.current) return;

      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${protocol}://${location.host}/ws`);
      socketRef.current = socket;

      socket.onopen = () => {
        retryRef.current = 0;
        setState((s) => ({ ...s, connection: 'live' }));
      };

      socket.onmessage = (event) => {
        const { type, payload } = JSON.parse(event.data);

        if (type === 'init') {
          setState((s) => ({
            ...s,
            connection: 'live',
            snapshot: payload.snapshot,
            nodes: payload.nodes,
            history: payload.history,
            recipes: payload.recipes ?? [],
            recipesError: payload.recipesError ?? null,
            demoMode: payload.config.demoMode,
          }));
          return;
        }

        if (type === 'snapshot') {
          setState((s) => ({ ...s, snapshot: payload, history: appendHistory(s.history, payload, historyLength) }));
        }
      };

      socket.onclose = () => {
        if (closedRef.current) return;
        /* Exponential backoff, capped so a long outage still retries every 10s. */
        retryRef.current += 1;
        const delay = Math.min(10000, 500 * 2 ** Math.min(retryRef.current, 5));
        setState((s) => ({ ...s, connection: retryRef.current > 3 ? 'offline' : 'reconnecting' }));
        reconnectTimer = window.setTimeout(connect, delay);
      };

      socket.onerror = () => socket.close();
    };

    connect();

    return () => {
      closedRef.current = true;
      window.clearTimeout(reconnectTimer);
      socketRef.current?.close();
    };
  }, [historyLength]);

  return { ...state, refreshNodes };
}

function appendHistory(history: HistoryMap, snapshot: Snapshot, limit: number): HistoryMap {
  const next: HistoryMap = {};

  for (const node of snapshot.nodes) {
    const previous = history[node.nodeId] ?? EMPTY_HISTORY();
    const gpu = node.gpus[0];

    const values: Record<(typeof SERIES_KEYS)[number], number> = {
      gpuUtilization: gpu?.utilization ?? 0,
      gpuMemoryPercent: gpu?.memoryPercent ?? 0,
      gpuTemperature: gpu?.temperature ?? 0,
      gpuPower: gpu?.powerDraw ?? 0,
      cpuPercent: node.cpu?.percent ?? 0,
      memoryPercent: node.memory?.percent ?? 0,
      networkRx: sum(node.network, (i) => i.rxRate),
      networkTx: sum(node.network, (i) => i.txRate),
      llmDecodeRate: sum(node.llm, (l) => l.decodeRate),
      llmPrefillRate: sum(node.llm, (l) => l.prefillRate),
    };

    /*
     * The push interval can outpace the poll interval, which would otherwise
     * flat-line the chart with repeats of the same reading. Only genuinely new
     * collections extend the series.
     */
    const lastAt = previous.timestamps.at(-1);
    if (lastAt === node.collectedAt) {
      next[node.nodeId] = previous;
      continue;
    }

    const entry = { ...previous, timestamps: cap([...previous.timestamps, node.collectedAt], limit) };
    for (const key of SERIES_KEYS) entry[key] = cap([...previous[key], values[key]], limit);
    next[node.nodeId] = entry;
  }

  return next;
}

const cap = (values: number[], limit: number) =>
  values.length > limit ? values.slice(values.length - limit) : values;
