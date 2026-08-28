import { useState } from 'react';
import type { Container, ContainerAction, NodeSnapshot } from '../lib/types';
import { api } from '../lib/api';
import { Badge, Button, Card, StatusDot } from './ui';

interface Props {
  node: NodeSnapshot;
  onResult: (message: string) => void;
}

const isRunning = (container: Container) => container.state === 'running';

/*
 * Container inventory with start/stop/restart per row.
 *
 * The panel does not optimistically flip a row's state: the action returns, the
 * server re-polls within about half a second, and the row updates from real
 * `docker ps` output. A container that fails to start therefore never appears
 * to have started.
 */
export function ContainersPanel({ node, onResult }: Props) {
  /* Container id currently being acted on, so only that row shows a spinner. */
  const [busyId, setBusyId] = useState<string | null>(null);

  const run = async (container: Container, action: ContainerAction) => {
    if (action === 'stop' && !confirm(`Stop ${container.name} on ${node.name}?`)) return;

    setBusyId(container.id);
    try {
      await api.container(node.nodeId, container.id, action);
      onResult(`${action === 'stop' ? 'Stopped' : action === 'start' ? 'Started' : 'Restarted'} ${container.name}.`);
    } catch (err) {
      onResult(`Could not ${action} ${container.name}: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  };

  /* Docker missing entirely is the normal case on a plain host - stay quiet
   * unless there is something the user can act on. */
  if (!node.dockerAvailable && !node.dockerError) return null;

  const running = node.containers.filter(isRunning).length;

  return (
    <Card
      title="Containers"
      accent="var(--series-power)"
      actions={
        node.containers.length > 0 ? (
          <span className="text-[11px] text-ink-muted tabular">
            {running} running · {node.containers.length} total
          </span>
        ) : undefined
      }
    >
      {node.dockerError ? (
        <p className="text-[12px]" style={{ color: 'var(--status-serious)' }}>
          {node.dockerError}
        </p>
      ) : node.containers.length === 0 ? (
        <p className="text-[12px] text-ink-muted">No containers on this node.</p>
      ) : (
        <ul className="divide-y divide-[color:var(--border)]">
          {node.containers.map((container) => {
            const running = isRunning(container);
            const busy = busyId === container.id;

            return (
              <li key={container.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <span className="shrink-0">
                  <StatusDot status={running ? 'good' : 'neutral'} />
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-ink">{container.name}</span>
                    {container.ports.map((port) => (
                      <Badge key={port}>{port}</Badge>
                    ))}
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-ink-muted" title={container.image}>
                    {container.image} · {container.status}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {running ? (
                    <>
                      <Button onClick={() => run(container, 'restart')} disabled={busy}>
                        Restart
                      </Button>
                      <Button variant="danger" onClick={() => run(container, 'stop')} disabled={busy}>
                        {busy ? 'Working…' : 'Stop'}
                      </Button>
                    </>
                  ) : (
                    <Button variant="primary" onClick={() => run(container, 'start')} disabled={busy}>
                      {busy ? 'Working…' : 'Start'}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
