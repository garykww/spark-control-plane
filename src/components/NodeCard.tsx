import type { History, NodeSnapshot } from '../lib/types';
import {
  bytes,
  bytesPerSecond,
  capacityBand,
  celsius,
  duration,
  percent,
  temperatureBand,
  tokensPerSecond,
  watts,
} from '../lib/format';
import { Badge, Card, StatusDot } from './ui';
import { Dial } from './viz/Dial';
import { Meter } from './viz/Meter';
import { Sparkline } from './viz/Sparkline';

interface Props {
  node: NodeSnapshot;
  history?: History;
  onOpen: () => void;
}

/* One node, summarised. Everything here is a headline; the detail view carries
 * the breakdowns. */
export function NodeCard({ node, history, onOpen }: Props) {
  const gpu = node.gpus[0];
  const activeLlm = node.llm.filter((l) => l.online);
  const decodeRate = activeLlm.reduce((sum, l) => sum + l.decodeRate, 0);
  const netRx = node.network.reduce((sum, i) => sum + i.rxRate, 0);
  const netTx = node.network.reduce((sum, i) => sum + i.txRate, 0);

  if (!node.online) {
    return (
      <Card className="transition-colors hover:border-hairline-strong">
        <button onClick={onOpen} className="w-full cursor-pointer text-left">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <StatusDot status="critical" />
                <span className="truncate text-[15px] font-semibold text-ink">{node.name}</span>
              </div>
              <p className="mt-2 text-[12px] text-ink-secondary">Offline</p>
              {node.error && (
                <p className="mt-1 line-clamp-2 text-[11px] break-words text-ink-muted">{node.error}</p>
              )}
            </div>
            <Badge tone="critical">down</Badge>
          </div>
        </button>
      </Card>
    );
  }

  return (
    <Card className="transition-colors hover:border-hairline-strong">
      <button onClick={onOpen} className="w-full cursor-pointer text-left">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <StatusDot status={node.stale ? 'warning' : 'good'} />
              <span className="truncate text-[15px] font-semibold text-ink">{node.name}</span>
              {node.stale && <Badge tone="warning">stale</Badge>}
            </div>
            <p className="mt-0.5 truncate text-[11px] text-ink-muted">
              {gpu?.name ?? node.host?.model ?? 'unknown'} · up {duration(node.uptimeSeconds)}
            </p>
          </div>
          {node.type === 'dgx-spark' && <Badge tone="accent">GB10</Badge>}
        </header>

        <div className="mt-4 flex items-center gap-4">
          <Dial
            value={gpu?.utilization ?? 0}
            color="var(--series-gpu)"
            readout={percent(gpu?.utilization)}
            caption="GPU"
            size={118}
          />

          <div className="min-w-0 flex-1 space-y-3">
            <Meter
              label={gpu?.isUnified ? 'Unified memory' : 'VRAM'}
              value={gpu?.memoryPercent ?? node.memory?.percent ?? 0}
              status={capacityBand(gpu?.memoryPercent ?? node.memory?.percent)}
              readout={percent(gpu?.memoryPercent ?? node.memory?.percent)}
              sublabel={`${bytes(gpu?.memoryUsed ?? node.memory?.used)} / ${bytes(gpu?.memoryTotal ?? node.memory?.total)}`}
            />
            <Meter
              label="CPU"
              value={node.cpu?.percent ?? 0}
              color="var(--series-cpu)"
              readout={percent(node.cpu?.percent)}
              sublabel={`${node.cpu?.cores ?? 0} cores · load ${node.load?.load1.toFixed(2) ?? '—'}`}
            />
          </div>
        </div>

        {history && history.gpuUtilization.length > 1 && (
          <div className="mt-4">
            <Sparkline
              values={history.gpuUtilization}
              timestamps={history.timestamps}
              color="var(--series-gpu)"
              max={100}
              height={40}
              label="GPU utilisation"
              format={(v) => percent(v)}
            />
          </div>
        )}

        <footer className="mt-3 grid grid-cols-4 gap-2 border-t border-hairline pt-3 text-[11px]">
          <Figure label="Temp" value={celsius(gpu?.temperature)} status={temperatureBand(gpu?.temperature)} />
          <Figure label="Power" value={watts(gpu?.powerDraw)} />
          <Figure label="Net" value={bytesPerSecond(netRx + netTx)} />
          <Figure
            label="Tokens"
            value={activeLlm.length ? `${tokensPerSecond(decodeRate)}/s` : '—'}
          />
        </footer>
      </button>
    </Card>
  );
}

function Figure({
  label,
  value,
  status,
}: {
  label: string;
  value: string;
  status?: ReturnType<typeof temperatureBand>;
}) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[10px] tracking-wide text-ink-muted uppercase">{label}</div>
      <div
        className="mt-0.5 truncate font-medium tabular"
        style={status && status !== 'good' ? { color: `var(--status-${status})` } : undefined}
      >
        {value}
      </div>
    </div>
  );
}
