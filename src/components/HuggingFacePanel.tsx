import { useMemo, useState } from 'react';
import type { HfDeletePreview, HfRepo, HfRepoType, NodeSnapshot } from '../lib/types';
import { api } from '../lib/api';
import { bytes, duration, percent } from '../lib/format';
import { Badge, Button, Card, StatusDot } from './ui';
import { Meter } from './viz/Meter';

interface Props {
  node: NodeSnapshot;
  onResult: (message: string) => void;
}

type Filter = 'all' | 'model' | 'dataset';

/*
 * HuggingFace cache management: what is stored on the node, what is downloading,
 * and what can be reclaimed.
 *
 * Downloads are detached jobs on the node, so this panel never waits on one - it
 * reflects whatever the poll last saw. Nothing is optimistic: a row disappears
 * when `hf cache ls` stops reporting it, not when the request returns.
 */
export function HuggingFacePanel({ node, onResult }: Props) {
  const hf = node.hf;
  const [filter, setFilter] = useState<Filter>('all');
  const [repoInput, setRepoInput] = useState('');
  const [typeInput, setTypeInput] = useState<HfRepoType>('model');
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<{ repo: HfRepo; preview: HfDeletePreview | null } | null>(null);

  const repos = useMemo(
    () => (filter === 'all' ? hf.repos : hf.repos.filter((r) => r.repoType === filter)),
    [hf.repos, filter],
  );

  const counts = useMemo(() => {
    const models = hf.repos.filter((r) => r.repoType === 'model').length;
    return { models, datasets: hf.repos.length - models };
  }, [hf.repos]);

  const reclaimable = hf.reclaimable.incompleteBytes + (hf.reclaimable.pruneBytes ?? 0);
  const activeJob = hf.jobs.find((j) => j.status === 'running' || j.status === 'starting');

  /* Docker's precedent: a node without the tool installed says nothing at all. */
  if (!hf.available && !hf.error) return null;

  const run = async (key: string, action: () => Promise<string>) => {
    setBusy(key);
    try {
      onResult(await action());
    } catch (err) {
      onResult((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const startDelete = async (repo: HfRepo) => {
    setPending({ repo, preview: null });
    try {
      const preview = await api.hfPreviewDelete(node.nodeId, {
        repoId: repo.repoId,
        repoType: repo.repoType,
      });
      setPending({ repo, preview });
    } catch (err) {
      setPending(null);
      onResult((err as Error).message);
    }
  };

  const confirmDelete = async () => {
    if (!pending) return;
    const { repo } = pending;
    setPending(null);
    await run(`delete:${repo.id}`, async () => {
      const result = await api.hfDelete(node.nodeId, {
        repoId: repo.repoId,
        repoType: repo.repoType,
        confirm: repo.repoId,
      });
      return `Deleted ${repo.repoId}, freeing ${bytes(result.freedBytes)}.`;
    });
  };

  return (
    <Card
      title="HuggingFace cache"
      accent="var(--series-llm)"
      actions={
        hf.available ? (
          <span className="text-[11px] text-ink-muted tabular">
            {counts.models} models · {counts.datasets} datasets · {bytes(hf.totalBytes)}
          </span>
        ) : undefined
      }
    >
      {hf.error ? (
        <p className="text-[12px]" style={{ color: 'var(--status-serious)' }}>
          {hf.error}
        </p>
      ) : (
        <>
          {/* Signed-out is worth saying: it is the usual cause of a gated model failing. */}
          {!hf.user && (
            <p className="mb-4 rounded-lg bg-surface-2 px-3 py-2 text-[11px] text-ink-secondary">
              Not signed in to the Hub on this node. Gated and private repos will fail until you run{' '}
              <code className="text-ink">hf auth login</code> there.
            </p>
          )}

          {hf.jobs.length > 0 && (
            <div className="mb-5 space-y-3">
              {hf.jobs.map((job) => {
                const live = job.status === 'running' || job.status === 'starting';
                const done = job.status === 'done';
                const elapsed = job.startedAt ? duration(Date.now() / 1000 - job.startedAt) : null;
                return (
                  <div key={job.id} className="rounded-lg border border-hairline p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <StatusDot
                            status={
                              job.status === 'done'
                                ? 'good'
                                : live
                                  ? 'warning'
                                  : job.status === 'cancelled'
                                    ? 'neutral'
                                    : 'critical'
                            }
                          />
                          <span className="truncate text-[13px] font-medium text-ink">{job.repoId}</span>
                          <Badge>{job.status}</Badge>
                        </div>
                        {job.message && (
                          <p className="mt-1 truncate text-[11px] text-ink-muted">{job.message}</p>
                        )}
                      </div>
                      <div className="flex shrink-0 gap-1.5">
                        {live ? (
                          <Button
                            variant="danger"
                            disabled={busy !== null}
                            onClick={() =>
                              run(`cancel:${job.id}`, async () => {
                                await api.hfCancel(node.nodeId, job.id);
                                return `Cancelled the download of ${job.repoId}.`;
                              })
                            }
                          >
                            Cancel
                          </Button>
                        ) : (
                          <Button
                            disabled={busy !== null}
                            onClick={() =>
                              run(`clear:${job.id}`, async () => {
                                await api.hfClearJob(node.nodeId, job.id);
                                return `Dismissed ${job.repoId}.`;
                              })
                            }
                          >
                            Dismiss
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="mt-3">
                      <Meter
                        label={done ? 'Downloaded' : job.percent === null ? 'Downloaded' : 'Progress'}
                        value={job.percent}
                        color="var(--series-llm)"
                        /*
                         * A finished job reports the size it fetched, not a live
                         * byte count: `du` reads 0 once the repo is deleted
                         * again, which would otherwise render as "0 B / 12 MB"
                         * beside a full bar.
                         */
                        readout={
                          done
                            ? bytes(job.totalBytes ?? job.downloadedBytes)
                            : job.totalBytes
                              ? `${bytes(job.downloadedBytes)} / ${bytes(job.totalBytes)}`
                              : bytes(job.downloadedBytes)
                        }
                        sublabel={
                          done
                            ? elapsed
                              ? `completed in ${elapsed}`
                              : 'completed'
                            : job.percent === null
                              ? 'total size unknown — showing bytes downloaded'
                              : `${percent(job.percent)}${elapsed ? ` · running ${elapsed}` : ''}`
                        }
                        height={6}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Add a repo */}
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <input
              className="min-w-0 flex-1 rounded-lg border border-hairline bg-surface-0 px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-muted focus:border-[color:var(--series-llm)]"
              placeholder="org/repo — e.g. Qwen/Qwen3-8B"
              value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)}
            />
            <select
              className="rounded-lg border border-hairline bg-surface-0 px-2.5 py-1.5 text-[13px] text-ink outline-none"
              value={typeInput}
              onChange={(e) => setTypeInput(e.target.value as HfRepoType)}
            >
              <option value="model">Model</option>
              <option value="dataset">Dataset</option>
            </select>
            <Button
              variant="primary"
              disabled={!repoInput.trim() || busy !== null || Boolean(activeJob)}
              title={activeJob ? 'A download is already running on this node' : undefined}
              onClick={() =>
                run('download', async () => {
                  const repoId = repoInput.trim();
                  await api.hfDownload(node.nodeId, { repoId, repoType: typeInput });
                  setRepoInput('');
                  return `Started downloading ${repoId}. It continues on the node if you close this page.`;
                })
              }
            >
              {busy === 'download' ? 'Starting…' : 'Download'}
            </Button>
          </div>

          {/* Filter */}
          <div className="mb-3 flex items-center gap-1">
            {(['all', 'model', 'dataset'] as Filter[]).map((option) => (
              <button
                key={option}
                onClick={() => setFilter(option)}
                className={`cursor-pointer rounded-md px-2 py-1 text-[11px] capitalize transition-colors ${
                  filter === option ? 'bg-surface-2 text-ink' : 'text-ink-muted hover:text-ink-secondary'
                }`}
              >
                {option === 'all' ? 'All' : `${option}s`}
              </button>
            ))}
          </div>

          {repos.length === 0 ? (
            <p className="text-[12px] text-ink-muted">Nothing cached on this node.</p>
          ) : (
            <ul className="max-h-96 divide-y divide-[color:var(--border)] overflow-y-auto">
              {repos.map((repo) => (
                <li key={repo.id} className="flex items-center gap-3 py-2 first:pt-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] text-ink">{repo.repoId}</span>
                      {repo.repoType !== 'model' && <Badge>{repo.repoType}</Badge>}
                    </div>
                    <p className="mt-0.5 text-[11px] text-ink-muted">used {repo.lastAccessed}</p>
                  </div>
                  <span className="shrink-0 text-[12px] font-medium text-ink tabular">
                    {bytes(repo.sizeBytes)}
                  </span>
                  <Button
                    variant="danger"
                    disabled={busy !== null}
                    onClick={() => startDelete(repo)}
                  >
                    {busy === `delete:${repo.id}` ? 'Deleting…' : 'Delete'}
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {reclaimable > 0 && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-3">
              <span className="text-[11px] text-ink-secondary">
                {bytes(reclaimable)} reclaimable
                <span className="text-ink-muted">
                  {' — '}
                  {hf.reclaimable.incompleteFiles > 0 &&
                    `${hf.reclaimable.incompleteFiles} unfinished download${hf.reclaimable.incompleteFiles === 1 ? '' : 's'}`}
                  {hf.reclaimable.incompleteFiles > 0 && hf.reclaimable.pruneRevisions > 0 && ', '}
                  {hf.reclaimable.pruneRevisions > 0 &&
                    `${hf.reclaimable.pruneRevisions} detached revision${hf.reclaimable.pruneRevisions === 1 ? '' : 's'}`}
                </span>
              </span>
              <div className="flex gap-2">
                {hf.reclaimable.incompleteBytes > 0 && (
                  <Button
                    disabled={busy !== null || Boolean(activeJob)}
                    title={activeJob ? 'Wait for the running download to finish' : undefined}
                    onClick={() =>
                      run('reclaim:incomplete', async () => {
                        const r = await api.hfReclaim(node.nodeId, 'incomplete');
                        return `Removed ${r.files ?? 0} unfinished files, freeing ${bytes(r.freedBytes)}.`;
                      })
                    }
                  >
                    Clear partials
                  </Button>
                )}
                {(hf.reclaimable.pruneBytes ?? 0) > 0 && (
                  <Button
                    disabled={busy !== null}
                    onClick={() =>
                      run('reclaim:prune', async () => {
                        const r = await api.hfReclaim(node.nodeId, 'prune');
                        return `Pruned ${r.revisions ?? 0} detached revisions, freeing ${bytes(r.freedBytes)}.`;
                      })
                    }
                  >
                    Prune
                  </Button>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {pending && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
          onClick={(e) => e.target === e.currentTarget && setPending(null)}
        >
          <div className="w-full max-w-md rounded-xl border border-hairline bg-surface-1 p-5 shadow-2xl">
            <h3 className="text-[15px] font-semibold text-ink">Delete {pending.repo.repoId}?</h3>

            {pending.preview === null ? (
              <p className="mt-3 text-[12px] text-ink-muted">Checking what this would free…</p>
            ) : (
              <p className="mt-3 text-[12px] text-ink-secondary">
                Frees <span className="font-medium text-ink">{bytes(pending.preview.sizeBytes)}</span> across{' '}
                {pending.preview.revisions} revision{pending.preview.revisions === 1 ? '' : 's'} on{' '}
                {node.name}.
              </p>
            )}

            <p className="mt-2 text-[11px] text-ink-muted">
              The weights are removed from this node's cache. Downloading them again may take hours.
            </p>

            <div className="mt-4 flex justify-end gap-2">
              <Button onClick={() => setPending(null)}>Cancel</Button>
              <Button variant="danger" disabled={pending.preview === null} onClick={confirmDelete}>
                Delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
