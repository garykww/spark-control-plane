import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDashboard } from './hooks/useDashboard';
import { api } from './lib/api';
import type { NodeConfig } from './lib/types';
import { bytesPerSecond, percent, relativeTime, tokensPerSecond } from './lib/format';
import { Badge, Button, EmptyState, StatTile, StatusDot } from './components/ui';
import { NodeCard } from './components/NodeCard';
import { NodeDetail } from './components/NodeDetail';
import { NodeDialog } from './components/NodeDialog';

type Theme = 'dark' | 'light' | 'oled';
const THEMES: Theme[] = ['dark', 'light', 'oled'];
const THEME_KEY = 'spark-control-plane:theme';

const CONNECTION_LABEL = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  offline: 'Disconnected',
} as const;

export default function App() {
  const { connection, snapshot, nodes, history, demoMode, refreshNodes } = useDashboard();
  const [selected, setSelected] = useState<string>('overview');
  const [dialog, setDialog] = useState<{ open: boolean; node: NodeConfig | null }>({ open: false, node: null });
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem(THEME_KEY) as Theme) ?? 'dark');
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const snapshots = snapshot?.nodes ?? [];
  const configById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const active = snapshots.find((n) => n.nodeId === selected);

  /* A removed node should not leave the view stranded on a missing tab. */
  useEffect(() => {
    if (selected !== 'overview' && snapshots.length > 0 && !snapshots.some((n) => n.nodeId === selected)) {
      setSelected('overview');
    }
  }, [selected, snapshots]);

  const handlePower = useCallback(
    async (id: string, action: 'shutdown' | 'reboot' | 'wake') => {
      const node = configById.get(id);
      const verb = { shutdown: 'Shut down', reboot: 'Reboot', wake: 'Wake' }[action];

      if (action !== 'wake' && !confirm(`${verb} ${node?.name ?? 'this node'}?`)) return;

      try {
        await api.power(id, action);
        setToast(`${verb} sent to ${node?.name ?? 'node'}.`);
      } catch (err) {
        setToast(`${verb} failed: ${(err as Error).message}`);
      }
    },
    [configById],
  );

  const fleet = useMemo(() => {
    const online = snapshots.filter((n) => n.online);
    return {
      total: snapshots.length,
      online: online.length,
      gpuAverage: online.length
        ? online.reduce((sum, n) => sum + (n.gpus[0]?.utilization ?? 0), 0) / online.length
        : 0,
      tokens: online.reduce((sum, n) => sum + n.llm.reduce((s, l) => s + l.decodeRate, 0), 0),
      network: online.reduce(
        (sum, n) => sum + n.network.reduce((s, i) => s + i.rxRate + i.txRate, 0),
        0,
      ),
    };
  }, [snapshots]);

  return (
    <div className="min-h-full bg-surface-0">
      <header className="sticky top-0 z-30 border-b border-hairline bg-surface-0/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
          <div className="flex items-center gap-2.5">
            <span className="h-6 w-1.5 rounded-full" style={{ background: 'var(--series-gpu)' }} />
            <h1 className="text-[15px] font-semibold tracking-tight text-ink">Spark Control Plane</h1>
          </div>

          {demoMode && <Badge tone="warning">demo data</Badge>}

          <div className="ml-auto flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-[11px] text-ink-secondary">
              <StatusDot
                status={connection === 'live' ? 'good' : connection === 'offline' ? 'critical' : 'warning'}
              />
              {CONNECTION_LABEL[connection]}
              {snapshot && connection === 'live' && (
                <span className="text-ink-muted tabular">· {relativeTime(snapshot.at)}</span>
              )}
            </span>

            <div className="flex rounded-lg border border-hairline p-0.5">
              {THEMES.map((option) => (
                <button
                  key={option}
                  onClick={() => setTheme(option)}
                  className={`cursor-pointer rounded-md px-2 py-1 text-[11px] capitalize transition-colors ${
                    theme === option ? 'bg-surface-2 text-ink' : 'text-ink-muted hover:text-ink-secondary'
                  }`}
                >
                  {option}
                </button>
              ))}
            </div>

            <Button variant="primary" onClick={() => setDialog({ open: true, node: null })}>
              Add node
            </Button>
          </div>
        </div>

        {/* Tabs: fleet overview plus one per node. */}
        <nav className="mx-auto flex max-w-[1600px] gap-1 overflow-x-auto px-5">
          <Tab label="Overview" active={selected === 'overview'} onClick={() => setSelected('overview')} />
          {snapshots.map((node) => (
            <Tab
              key={node.nodeId}
              label={node.name}
              status={node.online ? (node.stale ? 'warning' : 'good') : 'critical'}
              active={selected === node.nodeId}
              onClick={() => setSelected(node.nodeId)}
            />
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-[1600px] px-5 py-5">
        {!snapshot ? (
          <p className="py-20 text-center text-[13px] text-ink-muted">Connecting to the control plane…</p>
        ) : snapshots.length === 0 ? (
          <EmptyState
            title="No nodes yet"
            hint="Add a DGX Spark or any Linux host with an NVIDIA GPU. You'll need SSH access; the dashboard reads /proc, /sys and nvidia-smi over that connection."
            action={<Button variant="primary" onClick={() => setDialog({ open: true, node: null })}>Add your first node</Button>}
          />
        ) : selected === 'overview' ? (
          <div className="space-y-5">
            <section className="grid grid-cols-2 gap-5 rounded-xl border border-hairline bg-surface-1 px-5 py-4 sm:grid-cols-4">
              <StatTile
                label="Nodes online"
                value={`${fleet.online}/${fleet.total}`}
                sub={fleet.online < fleet.total ? `${fleet.total - fleet.online} unreachable` : 'all reachable'}
              />
              <StatTile label="Average GPU" value={percent(fleet.gpuAverage)} color="var(--series-gpu)" sub="across online nodes" />
              <StatTile
                label="Decode throughput"
                value={tokensPerSecond(fleet.tokens)}
                unit="tok/s"
                color="var(--series-llm)"
                sub="all inference servers"
              />
              <StatTile label="Network" value={bytesPerSecond(fleet.network)} sub="combined rx + tx" />
            </section>

            <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
              {snapshots.map((node) => (
                <NodeCard
                  key={node.nodeId}
                  node={node}
                  history={history[node.nodeId]}
                  onOpen={() => setSelected(node.nodeId)}
                />
              ))}
            </div>
          </div>
        ) : active ? (
          <NodeDetail
            node={active}
            config={configById.get(active.nodeId)}
            history={history[active.nodeId]}
            onEdit={() => setDialog({ open: true, node: configById.get(active.nodeId) ?? null })}
            onPower={(action) => handlePower(active.nodeId, action)}
            onNotice={setToast}
          />
        ) : null}
      </main>

      {dialog.open && (
        <NodeDialog
          node={dialog.node}
          onClose={() => setDialog({ open: false, node: null })}
          onSaved={refreshNodes}
        />
      )}

      {toast && (
        <div
          role="status"
          className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-hairline bg-surface-raised px-4 py-2.5 text-[12px] text-ink shadow-xl"
        >
          {toast}
        </div>
      )}
    </div>
  );
}

function Tab({
  label,
  active,
  status,
  onClick,
}: {
  label: string;
  active: boolean;
  status?: 'good' | 'warning' | 'critical';
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`-mb-px flex shrink-0 cursor-pointer items-center gap-1.5 border-b-2 px-3 py-2 text-[12px] font-medium whitespace-nowrap transition-colors ${
        active
          ? 'border-[color:var(--series-gpu)] text-ink'
          : 'border-transparent text-ink-muted hover:text-ink-secondary'
      }`}
    >
      {status && <StatusDot status={status} />}
      {label}
    </button>
  );
}
