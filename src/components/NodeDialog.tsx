import { useEffect, useState } from 'react';
import { api, type NodeInput } from '../lib/api';
import type { NodeConfig, TestResult } from '../lib/types';
import { Button, StatusDot } from './ui';

interface Props {
  node: NodeConfig | null;
  onClose: () => void;
  onSaved: () => void;
}

const BLANK: NodeInput = {
  name: '',
  type: 'dgx-spark',
  connection: 'ssh',
  host: '',
  sshUser: 'nvidia',
  sshPort: 22,
  sshKeyPath: null,
  llmPorts: [],
  macAddress: null,
  enabled: true,
};

/*
 * Add/edit form. Connection details can be tested before saving, so a wrong key
 * path or an unreachable inference port is reported here rather than showing up
 * as a node that silently never comes online.
 */
export function NodeDialog({ node, onClose, onSaved }: Props) {
  const [form, setForm] = useState<NodeInput>(BLANK);
  const [password, setPassword] = useState('');
  const [ports, setPorts] = useState('');
  const [busy, setBusy] = useState<'test' | 'save' | 'delete' | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (node) {
      setForm({
        name: node.name,
        type: node.type,
        connection: node.connection,
        host: node.host,
        sshUser: node.sshUser,
        sshPort: node.sshPort,
        sshKeyPath: node.sshKeyPath,
        llmPorts: node.llmPorts,
        macAddress: node.macAddress,
        enabled: node.enabled,
      });
      setPorts(node.llmPorts.map((p) => (p.label ? `${p.port}:${p.label}` : String(p.port))).join(', '));
    } else {
      setForm(BLANK);
      setPorts('');
    }
    setPassword('');
    setTest(null);
    setError(null);
  }, [node]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* "8000:vLLM, 11434" -> [{port:8000,label:'vLLM'},{port:11434,label:''}] */
  const parsePorts = (): NodeInput['llmPorts'] =>
    ports
      .split(',')
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk) => {
        const [portText, ...rest] = chunk.split(':');
        return { port: Number(portText), label: rest.join(':').trim() };
      })
      .filter((entry) => Number.isInteger(entry.port) && entry.port > 0);

  const payload = (): NodeInput & { id?: string } => ({
    ...form,
    llmPorts: parsePorts(),
    macAddress: form.macAddress?.trim() || null,
    sshKeyPath: form.sshKeyPath?.trim() || null,
    ...(password ? { password } : {}),
    ...(node ? { id: node.id } : {}),
  });

  const run = async (kind: 'test' | 'save' | 'delete', action: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(null);
    }
  };

  const handleSave = () =>
    run('save', async () => {
      if (node) await api.updateNode(node.id, payload());
      else await api.createNode(payload());
      onSaved();
      onClose();
    });

  const handleDelete = () =>
    run('delete', async () => {
      if (!node) return;
      if (!confirm(`Remove "${node.name}" from the dashboard? This does not touch the machine itself.`)) return;
      await api.deleteNode(node.id);
      onSaved();
      onClose();
    });

  const isSsh = form.connection === 'ssh';

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/55 p-4 backdrop-blur-sm sm:items-center"
      onClick={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="w-full max-w-lg rounded-xl border border-hairline bg-surface-1 shadow-2xl">
        <header className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
          <h2 className="text-[15px] font-semibold text-ink">{node ? `Edit ${node.name}` : 'Add a node'}</h2>
          <button onClick={onClose} className="cursor-pointer text-ink-muted hover:text-ink" aria-label="Close">
            ✕
          </button>
        </header>

        <div className="space-y-4 px-5 py-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <input
                className={INPUT}
                value={form.name}
                autoFocus
                placeholder="spark-01"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label="Hardware">
              <select
                className={INPUT}
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as NodeInput['type'] })}
              >
                <option value="dgx-spark">DGX Spark (GB10)</option>
                <option value="gpu-host">Other GPU host</option>
              </select>
            </Field>
          </div>

          <Field label="Connection">
            <select
              className={INPUT}
              value={form.connection}
              onChange={(e) => setForm({ ...form, connection: e.target.value as NodeInput['connection'] })}
            >
              <option value="ssh">Remote over SSH</option>
              <option value="local">This machine</option>
            </select>
          </Field>

          {isSsh && (
            <>
              <div className="grid grid-cols-[1fr_auto] gap-3">
                <Field label="Host or IP">
                  <input
                    className={INPUT}
                    value={form.host}
                    placeholder="10.0.0.11"
                    onChange={(e) => setForm({ ...form, host: e.target.value })}
                  />
                </Field>
                <Field label="Port">
                  <input
                    className={`${INPUT} w-20`}
                    type="number"
                    value={form.sshPort}
                    onChange={(e) => setForm({ ...form, sshPort: Number(e.target.value) })}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="SSH user">
                  <input
                    className={INPUT}
                    value={form.sshUser}
                    onChange={(e) => setForm({ ...form, sshUser: e.target.value })}
                  />
                </Field>
                <Field label="Private key path" hint="optional">
                  <input
                    className={INPUT}
                    value={form.sshKeyPath ?? ''}
                    placeholder="~/.ssh/id_ed25519"
                    onChange={(e) => setForm({ ...form, sshKeyPath: e.target.value })}
                  />
                </Field>
              </div>

              <Field
                label="Password"
                hint={node?.hasPassword ? 'stored — leave blank to keep' : 'optional, used only without a key'}
              >
                <input
                  className={INPUT}
                  type="password"
                  value={password}
                  placeholder={node?.hasPassword ? '••••••••' : ''}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
            </>
          )}

          <Field label="Inference ports" hint="comma separated, optionally port:label">
            <input
              className={INPUT}
              value={ports}
              placeholder="8000:vLLM, 11434:Ollama"
              onChange={(e) => setPorts(e.target.value)}
            />
          </Field>

          <Field label="MAC address" hint="optional, enables Wake-on-LAN">
            <input
              className={INPUT}
              value={form.macAddress ?? ''}
              placeholder="aa:bb:cc:dd:ee:ff"
              onChange={(e) => setForm({ ...form, macAddress: e.target.value })}
            />
          </Field>

          {test && (
            <div className="space-y-1.5 rounded-lg border border-hairline bg-surface-2 px-3 py-2.5">
              <TestRow ok={test.connection.ok} label="Connection" detail={test.connection.detail} />
              <TestRow ok={test.gpu.ok} label="GPU" detail={test.gpu.detail} />
              {test.llm.map((probe) => (
                <TestRow key={probe.port} ok={probe.ok} label={`Port ${probe.port}`} detail={probe.detail} />
              ))}
            </div>
          )}

          {error && (
            <p className="rounded-lg px-3 py-2 text-[12px]" style={{ background: 'var(--surface-2)', color: 'var(--status-critical)' }}>
              {error}
            </p>
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-hairline px-5 py-3.5">
          <div>
            {node && (
              <Button variant="danger" onClick={handleDelete} disabled={busy !== null}>
                {busy === 'delete' ? 'Removing…' : 'Remove'}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={() => run('test', async () => setTest(await api.testNode(payload())))}
              disabled={busy !== null || (isSsh && !form.host)}
            >
              {busy === 'test' ? 'Testing…' : 'Test'}
            </Button>
            <Button variant="primary" onClick={handleSave} disabled={busy !== null || !form.name || (isSsh && !form.host)}>
              {busy === 'save' ? 'Saving…' : node ? 'Save changes' : 'Add node'}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}

const INPUT =
  'w-full rounded-lg border border-hairline bg-surface-0 px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-muted focus:border-[color:var(--series-gpu)]';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline gap-2">
        <span className="text-[11px] font-medium tracking-wide text-ink-secondary uppercase">{label}</span>
        {hint && <span className="text-[10px] text-ink-muted">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function TestRow({ ok, label, detail }: { ok: boolean; label: string; detail: string | null }) {
  return (
    <div className="flex items-start gap-2 text-[11px]">
      <span className="mt-0.5 shrink-0">
        <StatusDot status={ok ? 'good' : 'critical'} />
      </span>
      <span className="shrink-0 font-medium text-ink-secondary">{label}</span>
      <span className="min-w-0 flex-1 break-words text-ink-muted">{detail ?? (ok ? 'ok' : 'failed')}</span>
    </div>
  );
}
