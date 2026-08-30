import type { History, NodeConfig, NodeSnapshot } from '../lib/types';
import {
  bytes,
  bytesPerSecond,
  capacityBand,
  celsius,
  count,
  duration,
  megahertz,
  percent,
  relativeTime,
  temperatureBand,
  tokensPerSecond,
  watts,
} from '../lib/format';
import { Badge, Button, Card, CoreGrid, StatTile, StatusDot } from './ui';
import { ContainersPanel } from './ContainersPanel';
import { HuggingFacePanel } from './HuggingFacePanel';
import { SmStatus } from './SmStatus';
import { Dial } from './viz/Dial';
import { LineChart } from './viz/LineChart';
import { Meter } from './viz/Meter';
import { Sparkline } from './viz/Sparkline';

interface Props {
  node: NodeSnapshot;
  config?: NodeConfig;
  history?: History;
  onEdit: () => void;
  onPower: (action: 'shutdown' | 'reboot' | 'wake') => void;
  onNotice: (message: string) => void;
}

export function NodeDetail({ node, config, history, onEdit, onPower, onNotice }: Props) {
  const gpu = node.gpus[0];

  /*
   * nvidia-smi reports [N/A] for memory on GB10, because there is no discrete
   * VRAM to report - the GPU's memory *is* the system's unified pool. Fall back
   * to it so the panel shows the real figure instead of a dash.
   */
  const gpuMemoryUsed = gpu?.memoryUsed ?? (gpu?.isUnified ? node.memory?.used ?? null : null);
  const gpuMemoryTotal = gpu?.memoryTotal ?? (gpu?.isUnified ? node.memory?.total ?? null : null);
  const gpuMemoryPercent =
    gpu?.memoryPercent ?? (gpu?.isUnified ? node.memory?.percent ?? null : null);

  if (!node.online) {
    return (
      <div className="space-y-4">
        <DetailHeader node={node} config={config} onEdit={onEdit} onPower={onPower} />
        <Card>
          <div className="py-10 text-center">
            <StatusDot status="critical" label="Node is offline" />
            <p className="mt-3 text-[12px] text-ink-secondary">
              {node.error ?? 'No response from the last few polls.'}
            </p>
            {config?.macAddress && (
              <div className="mt-4 flex justify-center">
                <Button onClick={() => onPower('wake')}>Send Wake-on-LAN</Button>
              </div>
            )}
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <DetailHeader node={node} config={config} onEdit={onEdit} onPower={onPower} />

      {/* GPU: the headline panel. */}
      <Card title="GPU" accent="var(--series-gpu)" actions={<span className="text-[11px] text-ink-muted">{gpu?.name}</span>}>
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center">
          <Dial
            value={gpu?.utilization ?? 0}
            color="var(--series-gpu)"
            readout={percent(gpu?.utilization)}
            caption="Utilisation"
          />

          <div className="grid flex-1 grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
            <StatTile
              label={gpu?.isUnified ? 'Unified memory' : 'VRAM'}
              value={bytes(gpuMemoryUsed)}
              sub={`of ${bytes(gpuMemoryTotal)} · ${percent(gpuMemoryPercent)}`}
            />
            <StatTile label="Temperature" value={celsius(gpu?.temperature)} sub={gpu?.pstate ? `state ${gpu.pstate}` : undefined} />
            <StatTile
              label="Power"
              value={watts(gpu?.powerDraw)}
              sub={gpu?.powerLimit ? `limit ${watts(gpu.powerLimit)}` : undefined}
            />
            <StatTile label="SM clock" value={megahertz(gpu?.clockSm)} sub={gpu?.driver ? `driver ${gpu.driver}` : undefined} />
          </div>
        </div>

        {gpu && <SmStatus gpu={gpu} processes={node.gpuProcesses} />}

        {history && history.gpuUtilization.length > 1 && (
          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <TrendBlock
              title="Utilisation"
              values={history.gpuUtilization}
              timestamps={history.timestamps}
              color="var(--series-gpu)"
              max={100}
              format={(v) => percent(v)}
            />
            <TrendBlock
              title="Temperature"
              values={history.gpuTemperature}
              timestamps={history.timestamps}
              color="var(--series-temp)"
              format={(v) => celsius(v)}
            />
          </div>
        )}
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* CPU */}
        <Card title="CPU" accent="var(--series-cpu)" actions={<span className="text-[11px] text-ink-muted">{node.cpu?.cores} cores</span>}>
          <div className="grid grid-cols-3 gap-4">
            <StatTile label="Utilisation" value={percent(node.cpu?.percent, 1)} color="var(--series-cpu)" />
            <StatTile label="Load (1m)" value={node.load?.load1.toFixed(2) ?? '—'} sub={`5m ${node.load?.load5.toFixed(2) ?? '—'} · 15m ${node.load?.load15.toFixed(2) ?? '—'}`} />
            <StatTile label="Runnable" value={count(node.cpu?.runnable)} sub="processes" />
          </div>

          {node.cpu?.cores_percent && node.cpu.cores_percent.length > 0 && (
            <div className="mt-5">
              <div className="mb-2 text-[11px] tracking-wide text-ink-muted uppercase">Per core</div>
              <CoreGrid cores={node.cpu.cores_percent} />
            </div>
          )}

          {history && history.cpuPercent.length > 1 && (
            <div className="mt-5">
              <Sparkline
                values={history.cpuPercent}
                timestamps={history.timestamps}
                color="var(--series-cpu)"
                max={100}
                height={52}
                label="CPU utilisation"
                format={(v) => percent(v, 1)}
              />
            </div>
          )}

          <p className="mt-3 truncate text-[11px] text-ink-muted">{node.cpu?.model}</p>
        </Card>

        {/* Memory */}
        <Card title="Memory" accent="var(--series-memory)">
          <div className="grid grid-cols-3 gap-4">
            <StatTile label="Used" value={bytes(node.memory?.used)} color="var(--series-memory)" sub={percent(node.memory?.percent)} />
            <StatTile label="Available" value={bytes(node.memory?.available)} />
            <StatTile label="Cached" value={bytes(node.memory?.cached)} />
          </div>

          <div className="mt-5 space-y-3">
            <Meter
              label="System memory"
              value={node.memory?.percent ?? 0}
              status={capacityBand(node.memory?.percent)}
              readout={`${bytes(node.memory?.used)} / ${bytes(node.memory?.total)}`}
            />
            {(node.memory?.swapTotal ?? 0) > 0 && (
              <Meter
                label="Swap"
                value={((node.memory?.swapUsed ?? 0) / (node.memory?.swapTotal || 1)) * 100}
                readout={`${bytes(node.memory?.swapUsed)} / ${bytes(node.memory?.swapTotal)}`}
                color="var(--series-power)"
              />
            )}
          </div>

          {history && history.memoryPercent.length > 1 && (
            <div className="mt-5">
              <Sparkline
                values={history.memoryPercent}
                timestamps={history.timestamps}
                color="var(--series-memory)"
                max={100}
                height={52}
                label="Memory used"
                format={(v) => percent(v, 1)}
              />
            </div>
          )}

          {gpu?.isUnified && (
            <p className="mt-3 text-[11px] text-ink-muted">
              GB10 shares one LPDDR5X pool between CPU and GPU — this is the same memory the GPU panel reports.
            </p>
          )}
        </Card>

        {/* Network */}
        <Card title="Network" accent="var(--series-gpu)">
          {node.network.length === 0 ? (
            <p className="text-[12px] text-ink-muted">No active interfaces.</p>
          ) : (
            <>
              {history && history.networkRx.length > 1 && (
                <LineChart
                  timestamps={history.timestamps}
                  height={132}
                  base={1024}
                  format={(v) => bytesPerSecond(v)}
                  series={[
                    { key: 'rx', label: 'Received', color: 'var(--series-gpu)', values: history.networkRx },
                    { key: 'tx', label: 'Sent', color: 'var(--series-cpu)', values: history.networkTx },
                  ]}
                />
              )}
              <div className="mt-4 space-y-2">
                {node.network.map((iface) => (
                  <div key={iface.name} className="flex items-center justify-between gap-3 text-[12px]">
                    <span className="truncate font-medium text-ink-secondary">{iface.name}</span>
                    <span className="shrink-0 text-ink-muted tabular">
                      <span style={{ color: 'var(--series-gpu)' }}>↓ {bytesPerSecond(iface.rxRate)}</span>
                      <span className="mx-2">·</span>
                      <span style={{ color: 'var(--series-cpu)' }}>↑ {bytesPerSecond(iface.txRate)}</span>
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>

        {/* Storage */}
        <Card title="Storage" accent="var(--series-memory)">
          {node.storage.length === 0 ? (
            <p className="text-[12px] text-ink-muted">No mounted filesystems reported.</p>
          ) : (
            <div className="space-y-4">
              {node.storage.map((mount) => (
                <Meter
                  key={mount.mount}
                  label={mount.mount}
                  value={mount.percent}
                  status={capacityBand(mount.percent)}
                  readout={`${bytes(mount.used)} / ${bytes(mount.total)}`}
                  sublabel={`${mount.device} · ${bytes(mount.available)} free`}
                />
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Inference servers */}
      {node.llm.length > 0 && (
        <Card title="Inference" accent="var(--series-llm)">
          <div className={`grid gap-4 ${node.llm.length > 1 ? 'md:grid-cols-2' : ''}`}>
            {node.llm.map((llm) => (
              <div key={llm.id} className="rounded-lg border border-hairline p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <StatusDot status={llm.online ? 'good' : 'critical'} />
                      <span className="truncate text-[13px] font-medium text-ink">
                        {llm.backend ?? 'unreachable'}
                      </span>
                      <Badge>:{llm.port}</Badge>
                    </div>
                    {llm.models[0] && (
                      <p className="mt-1 truncate text-[11px] text-ink-muted">{llm.models[0]}</p>
                    )}
                  </div>
                  {llm.latencyMs !== null && (
                    <span className="shrink-0 text-[11px] text-ink-muted tabular">{llm.latencyMs} ms</span>
                  )}
                </div>

                {llm.online ? (
                  <>
                    <div className="mt-3 grid grid-cols-3 gap-3">
                      <StatTile label="Decode" value={tokensPerSecond(llm.decodeRate)} unit="tok/s" color="var(--series-llm)" />
                      <StatTile label="Prefill" value={tokensPerSecond(llm.prefillRate)} unit="tok/s" />
                      <StatTile label="Running" value={count(llm.running)} sub={llm.queued ? `${llm.queued} queued` : undefined} />
                    </div>
                    {llm.kvCacheUsage !== null && (
                      <div className="mt-3">
                        <Meter
                          label="KV cache"
                          value={llm.kvCacheUsage * 100}
                          status={capacityBand(llm.kvCacheUsage * 100)}
                          readout={percent(llm.kvCacheUsage * 100)}
                          height={6}
                        />
                      </div>
                    )}
                  </>
                ) : (
                  <p className="mt-2 text-[11px] text-ink-muted">{llm.error ?? 'no response'}</p>
                )}
              </div>
            ))}
          </div>

          {history && history.llmDecodeRate.some((v) => v > 0) && (
            <div className="mt-4">
              <div className="mb-2 text-[11px] tracking-wide text-ink-muted uppercase">Decode throughput</div>
              <Sparkline
                values={history.llmDecodeRate}
                timestamps={history.timestamps}
                color="var(--series-llm)"
                height={56}
                label="Decode throughput"
                format={(v) => `${tokensPerSecond(v)} tok/s`}
              />
            </div>
          )}
        </Card>
      )}

      <ContainersPanel node={node} onResult={onNotice} />

      <HuggingFacePanel node={node} onResult={onNotice} />

      <div className="grid gap-4 xl:grid-cols-2">
        {/* GPU processes */}
        <Card title="GPU processes" accent="var(--series-gpu)">
          {node.gpuProcesses.length === 0 ? (
            <p className="text-[12px] text-ink-muted">Nothing is using the GPU right now.</p>
          ) : (
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-[10px] tracking-wide text-ink-muted uppercase">
                  <th className="pb-2 font-medium">Process</th>
                  <th className="pb-2 font-medium">PID</th>
                  <th className="pb-2 text-right font-medium">Memory</th>
                </tr>
              </thead>
              <tbody>
                {node.gpuProcesses.map((process) => (
                  <tr key={process.pid} className="border-t border-hairline">
                    <td className="max-w-0 truncate py-2 pr-3 text-ink" title={process.command}>
                      {process.name}
                    </td>
                    <td className="py-2 pr-3 text-ink-muted tabular">{process.pid}</td>
                    <td className="py-2 text-right font-medium text-ink tabular">{bytes(process.memory)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {/* Thermals + platform */}
        <Card title="Thermals & platform" accent="var(--series-temp)">
          {node.thermal.length > 0 && (
            <div className="mb-5 space-y-3">
              {node.thermal.slice(0, 5).map((zone) => (
                <Meter
                  key={zone.label}
                  label={zone.label}
                  value={zone.celsius}
                  max={100}
                  status={temperatureBand(zone.celsius)}
                  readout={celsius(zone.celsius)}
                  height={6}
                />
              ))}
            </div>
          )}

          <dl className="space-y-1.5 border-t border-hairline pt-4 text-[12px]">
            <Row label="Hostname" value={node.host?.hostname} />
            <Row label="Platform" value={node.spec?.platform ?? node.host?.model} />
            {node.spec && <Row label="SoC" value={node.spec.soc} />}
            {node.spec && <Row label="Memory bandwidth" value={`${node.spec.memoryBandwidthGBs} GB/s ${node.spec.memoryType}`} />}
            {node.spec && <Row label="AI performance" value={node.spec.aiPerformance} />}
            <Row label="Kernel" value={`${node.host?.kernel} (${node.host?.arch})`} />
            <Row label="Uptime" value={duration(node.uptimeSeconds)} />
            <Row label="Last poll" value={relativeTime(node.collectedAt)} />
          </dl>
        </Card>
      </div>
    </div>
  );
}

function TrendBlock({
  title,
  values,
  timestamps,
  color,
  max,
  format,
}: {
  title: string;
  values: number[];
  timestamps: number[];
  color: string;
  max?: number;
  format: (value: number) => string;
}) {
  return (
    <div>
      <div className="mb-2 text-[11px] tracking-wide text-ink-muted uppercase">{title}</div>
      <Sparkline
        values={values}
        timestamps={timestamps}
        color={color}
        max={max}
        height={64}
        label={title}
        format={format}
      />
    </div>
  );
}

function Row({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-ink-muted">{label}</dt>
      <dd className="truncate text-right text-ink-secondary">{value ?? '—'}</dd>
    </div>
  );
}

function DetailHeader({
  node,
  config,
  onEdit,
  onPower,
}: {
  node: NodeSnapshot;
  config?: NodeConfig;
  onEdit: () => void;
  onPower: (action: 'shutdown' | 'reboot' | 'wake') => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <StatusDot status={node.online ? (node.stale ? 'warning' : 'good') : 'critical'} />
          <h2 className="truncate text-[19px] font-semibold text-ink">{node.name}</h2>
          {node.type === 'dgx-spark' && <Badge tone="accent">DGX Spark</Badge>}
          {node.stale && <Badge tone="warning">stale</Badge>}
        </div>
        <p className="mt-1 truncate text-[12px] text-ink-muted">
          {config?.connection === 'local' ? 'local host' : `${config?.sshUser}@${config?.host}`}
          {node.host?.hostname ? ` · ${node.host.hostname}` : ''}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={onEdit}>Edit</Button>
        {config?.macAddress && <Button onClick={() => onPower('wake')}>Wake</Button>}
        {config?.connection !== 'local' && (
          <>
            <Button onClick={() => onPower('reboot')}>Reboot</Button>
            <Button variant="danger" onClick={() => onPower('shutdown')}>
              Shut down
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
