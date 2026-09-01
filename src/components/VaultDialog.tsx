import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { VaultEntry } from '../lib/types';
import { Badge, Button } from './ui';

interface Props {
  entries: VaultEntry[];
  onClose: () => void;
  onSaved: (entries: VaultEntry[]) => void;
}

/*
 * The vault: secrets the control plane holds for itself rather than for one
 * node. Today that is the vLLM API key every new run serves behind.
 *
 * Values are write-only, so a stored secret is shown as its last four
 * characters and nothing more - there is no field to reveal, because the server
 * never sends one back. What a stored key does become visible in is the run
 * that used it: the panel shows each run's own key beside its URL.
 */
export function VaultDialog({ entries, onClose, onSaved }: Props) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = async (key: string, action: () => Promise<VaultEntry[]>, message: string) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      onSaved(await action());
      setNotice(message);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(null);
    }
  };

  const save = (entry: VaultEntry) =>
    run(`save:${entry.name}`, async () => {
      const saved = await api.setVaultSecret(entry.name, drafts[entry.name] ?? '');
      setDrafts((d) => ({ ...d, [entry.name]: '' }));
      return saved;
    }, `${entry.name} stored. New runs will serve behind it.`);

  const clear = (entry: VaultEntry) => {
    if (!confirm(`Remove the stored ${entry.name}? New runs will go back to a key generated per run.`)) return;
    return run(`clear:${entry.name}`, () => api.clearVaultSecret(entry.name), `${entry.name} removed.`);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/55 p-4 backdrop-blur-sm sm:items-center"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="w-full max-w-lg rounded-xl border border-hairline bg-surface-1 shadow-2xl">
        <header className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
          <h2 className="text-[15px] font-semibold text-ink">Vault</h2>
          <button onClick={onClose} className="cursor-pointer text-ink-muted hover:text-ink" aria-label="Close">
            ✕
          </button>
        </header>

        <div className="space-y-4 px-5 py-4">
          <p className="text-[12px] text-ink-secondary">
            Secrets held by the control plane, encrypted at rest with AES-256-GCM. They are never sent back
            to this page once stored, and a change applies to the next run started — anything already serving
            keeps the key it was launched with.
          </p>

          {entries.map((entry) => {
            const draft = drafts[entry.name] ?? '';
            return (
              <div key={entry.name} className="rounded-lg border border-hairline bg-surface-0 px-3.5 py-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[12px] font-medium text-ink">{entry.label}</span>
                  {entry.set ? (
                    <Badge tone="good">stored {entry.preview}</Badge>
                  ) : (
                    <Badge>not set</Badge>
                  )}
                </div>

                <p className="mt-1 text-[11px] text-ink-secondary">{entry.summary}</p>

                <div className="mt-2.5 flex items-center gap-2">
                  <input
                    className={INPUT}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={draft}
                    placeholder={entry.set ? '••••••••  — type a new value to replace' : entry.placeholder}
                    onChange={(event) => setDrafts({ ...drafts, [entry.name]: event.target.value })}
                  />
                  <Button
                    onClick={() => setDrafts({ ...drafts, [entry.name]: generateKey() })}
                    title="Fill the field with a fresh random key"
                  >
                    Generate
                  </Button>
                </div>

                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="text-[10px] text-ink-muted">
                    {entry.name} · {entry.hint}
                  </span>
                  <div className="flex items-center gap-2">
                    {entry.set && (
                      <Button variant="danger" onClick={() => clear(entry)} disabled={busy !== null}>
                        {busy === `clear:${entry.name}` ? 'Removing…' : 'Remove'}
                      </Button>
                    )}
                    <Button
                      variant="primary"
                      onClick={() => save(entry)}
                      disabled={busy !== null || !draft.trim()}
                    >
                      {busy === `save:${entry.name}` ? 'Saving…' : entry.set ? 'Replace' : 'Save'}
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}

          {notice && <p className="text-[12px] text-ink-secondary">{notice}</p>}

          {error && (
            <p
              className="rounded-lg px-3 py-2 text-[12px]"
              style={{ background: 'var(--surface-2)', color: 'var(--status-critical)' }}
            >
              {error}
            </p>
          )}
        </div>

        <footer className="flex justify-end border-t border-hairline px-5 py-3.5">
          <Button onClick={onClose}>Done</Button>
        </footer>
      </div>
    </div>
  );
}

/* The same shape the launcher mints when the vault is empty, so a key typed
 * here and a key generated by a run are indistinguishable to a client. */
function generateKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `sk-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const INPUT =
  'w-full rounded-lg border border-hairline bg-surface-0 px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-muted focus:border-[color:var(--series-gpu)]';
