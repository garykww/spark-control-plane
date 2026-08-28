import type { Gpu, GpuProcess } from '../lib/types';
import { celsius, megahertz, percent, STATUS_VAR } from '../lib/format';
import { Meter } from './viz/Meter';
import { SmGrid } from './SmGrid';

/*
 * SM-level status.
 *
 * NVIDIA exposes no per-SM breakdown through NVML or DCGM - "utilisation" is
 * the fraction of time at least one kernel was resident, across the whole GPU,
 * so a grid of individual SMs like the per-core CPU one is not buildable.
 *
 * What is knowable, and what this shows, is why the SMs are running as fast as
 * they are: how much of the clock ceiling is in use, what is holding it back,
 * and how much thermal headroom is left.
 */

const SEVERITY_COLOR = {
  info: 'var(--ink-muted)',
  warning: STATUS_VAR.warning,
  serious: STATUS_VAR.serious,
} as const;

const ENGINE_LABELS: Record<string, string> = {
  encoder: 'Encoder',
  decoder: 'Decoder',
  jpeg: 'JPEG',
  ofa: 'Optical flow',
};

export function SmStatus({ gpu, processes }: { gpu: Gpu; processes: GpuProcess[] }) {
  const reasons = gpu.throttleReasons;
  const limiting = reasons?.filter((r) => r.severity !== 'info') ?? [];
  const serious = limiting.filter((r) => r.severity === 'serious');

  /*
   * An idle GPU parks its clocks and the driver briefly asserts a power-cap bit
   * while doing so. Reporting that as "expect lower throughput" would be alarming
   * and wrong - there is no throughput to lose. Protective throttling (thermal,
   * hardware slowdown) is still called out whatever the load, because that is a
   * fault rather than a resting state.
   */
  const busy = (gpu.utilization ?? 0) >= 5;

  return (
    <div className="mt-6 border-t border-hairline pt-5">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h4 className="text-[11px] font-semibold tracking-wide text-ink-muted uppercase">
          SM status
        </h4>
        {gpu.pstate && (
          <span className="text-[11px] text-ink-muted">
            performance state <span className="font-medium text-ink-secondary">{gpu.pstate}</span>
          </span>
        )}
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <div className="space-y-4">
          <Meter
            label="SM clock"
            value={gpu.clockSmPercent}
            color="var(--series-gpu)"
            readout={
              gpu.clockSmMax
                ? `${megahertz(gpu.clockSm)} / ${megahertz(gpu.clockSmMax)}`
                : megahertz(gpu.clockSm)
            }
            sublabel={
              gpu.clockSmPercent !== null ? `${percent(gpu.clockSmPercent)} of ceiling` : undefined
            }
          />

          <Meter
            label="SM activity"
            value={gpu.utilization}
            color="var(--series-gpu)"
            readout={percent(gpu.utilization)}
            sublabel="share of time kernels were resident"
          />
        </div>

        <div className="space-y-4">
          <div>
            <div className="mb-1.5 text-[12px] text-ink-secondary">Clock limiters</div>
            {reasons === null ? (
              <p className="text-[11px] text-ink-muted">Not reported by this driver.</p>
            ) : reasons.length === 0 ? (
              <p className="text-[11px] text-ink-muted">
                Nothing is capping the clock — the SMs are free to boost.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {reasons.map((reason) => (
                  <span
                    key={reason.key}
                    className="inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase"
                    style={{ color: SEVERITY_COLOR[reason.severity], borderColor: SEVERITY_COLOR[reason.severity] }}
                  >
                    {reason.severity !== 'info' && <span aria-hidden>▲</span>}
                    {reason.label}
                  </span>
                ))}
              </div>
            )}
            {serious.length > 0 ? (
              <p className="mt-1.5 text-[11px]" style={{ color: STATUS_VAR.serious }}>
                Hardware is cutting clocks to protect the GPU.
              </p>
            ) : limiting.length > 0 && busy ? (
              <p className="mt-1.5 text-[11px] text-ink-muted">
                Clocks are being held below the ceiling — expect lower throughput.
              </p>
            ) : !busy ? (
              <p className="mt-1.5 text-[11px] text-ink-muted">
                The SMs are idle, so low clocks are expected.
              </p>
            ) : null}
          </div>

          {gpu.temperatureHeadroom !== null && (
            <div>
              <div className="mb-1 text-[12px] text-ink-secondary">Thermal headroom</div>
              <div className="flex items-baseline gap-2">
                <span className="text-[20px] leading-none font-semibold text-ink tabular">
                  {celsius(gpu.temperatureHeadroom)}
                </span>
                <span className="text-[11px] text-ink-muted">below the throttle point</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <SmGrid gpu={gpu} processes={processes} />

      {/* Fixed-function engines sit beside the SMs; hidden while all are idle. */}
      {gpu.enginesActive && (
        <div className="mt-5">
          <div className="mb-2 text-[11px] tracking-wide text-ink-muted uppercase">Engines</div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
            {Object.entries(gpu.engines).map(([key, value]) =>
              value === null ? null : (
                <Meter
                  key={key}
                  label={ENGINE_LABELS[key] ?? key}
                  value={value}
                  color="var(--series-power)"
                  readout={percent(value)}
                  height={6}
                />
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}
