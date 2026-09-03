import { useEffect, useMemo, useState } from 'react';
import type { EnergyBucket, NodeEnergy } from '../lib/types';
import { tokenCount } from '../lib/format';
import { Badge, Card } from './ui';

interface Props {
  energy: NodeEnergy;
}

const PRICE_KEY = 'spark-control-plane:price-per-kwh';
const BASELINE_KEY = 'spark-control-plane:baseline-watts';

/* A typical UK unit rate, and the figure the panel opens with. */
const DEFAULT_PENCE_PER_KWH = 21;

const read = (key: string, fallback: number) => {
  const stored = Number(localStorage.getItem(key));
  return Number.isFinite(stored) && stored >= 0 ? stored : fallback;
};

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/*
 * What a million tokens costs in electricity.
 *
 * ENERGY IS INTEGRATED PER INTERVAL, NOT ASSUMED. Draw is not a constant - the
 * node idles at one figure and loads at another - so each five-minute slice
 * accrues the watts actually sampled inside it and carries the tokens served in
 * the same minutes. A cost is then the division of two measurements of one
 * stretch of time, and the run of slices shows how it moved.
 *
 * ENERGY IS SPLIT BY MEASURED ENGINE TIME, not by token count. Splitting by
 * count would be fiction: prefill runs a whole prompt through in parallel while
 * decode emits one token at a time, so decode holds the GPU far longer per
 * token - and cached tokens, which vLLM skips entirely, would swallow most of
 * the cost having consumed none of it.
 *
 * It is beta because one input cannot be measured on this hardware: GB10
 * exposes no module-level sensor, so the reading is the GPU rail and everything
 * else is missing. That remainder is roughly load-independent, so it is entered
 * as a baseline read off a plug meter once, and added to every interval.
 */
export function EnergyPanel({ energy }: Props) {
  const [pence, setPence] = useState(() => read(PRICE_KEY, DEFAULT_PENCE_PER_KWH));
  const [baseline, setBaseline] = useState(() => read(BASELINE_KEY, 0));

  useEffect(() => {
    localStorage.setItem(PRICE_KEY, String(pence));
  }, [pence]);

  useEffect(() => {
    if (baseline > 0) localStorage.setItem(BASELINE_KEY, String(baseline));
    else localStorage.removeItem(BASELINE_KEY);
  }, [baseline]);

  /* The baseline is a draw, so it costs its watts for the interval's duration
   * however busy that interval was. */
  const wattHours = (bucket: EnergyBucket) =>
    bucket.wattHours + (baseline * (bucket.endedAt - bucket.startedAt)) / 3.6e6;

  const pencePerKwh = (wh: number) => (wh / 1000) * pence;

  const totals = useMemo(() => {
    const sum = (pick: (b: EnergyBucket) => number) =>
      energy.buckets.reduce((acc, b) => acc + pick(b), 0);

    return {
      wattHours: sum(wattHours),
      inputTokens: sum((b) => b.inputTokens),
      cachedTokens: sum((b) => b.cachedTokens),
      outputTokens: sum((b) => b.outputTokens),
      prefillSeconds: sum((b) => b.prefillSeconds),
      decodeSeconds: sum((b) => b.decodeSeconds),
    };
    /* eslint-disable-next-line react-hooks/exhaustive-deps -- baseline feeds wattHours */
  }, [energy.buckets, baseline]);

  /* Energy is attributed to a phase by the share of engine time it held, then
   * divided by the tokens that phase produced. */
  const engineSeconds = totals.prefillSeconds + totals.decodeSeconds;
  const perMillion = (phaseSeconds: number, tokens: number) => {
    if (!(tokens > 0) || !(engineSeconds > 0)) return null;
    const share = phaseSeconds / engineSeconds;
    return (pencePerKwh(totals.wattHours * share) / tokens) * 1e6;
  };

  const rows = [
    { label: 'Input', hint: 'uncached', tokens: totals.inputTokens, seconds: totals.prefillSeconds, cost: perMillion(totals.prefillSeconds, totals.inputTokens) },
    { label: 'Cached', hint: 'never computed', tokens: totals.cachedTokens, seconds: null, cost: 0 },
    { label: 'Output', hint: 'decode', tokens: totals.outputTokens, seconds: totals.decodeSeconds, cost: perMillion(totals.decodeSeconds, totals.outputTokens) },
  ];

  const minutes = Math.round((energy.bucketSeconds * energy.buckets.length) / 60);

  /*
   * Adaptive precision, because these figures span five orders of magnitude: a
   * five-minute slice at idle is worth a few hundredths of a penny, while a
   * month of running is pounds. A fixed one decimal place renders every
   * interval as "0.0p", which is not a small number - it is no number at all.
   */
  const money = (p: number) => {
    if (p >= 100) return `£${(p / 100).toFixed(2)}`;
    if (p >= 1) return `${p.toFixed(1)}p`;
    if (p >= 0.01) return `${p.toFixed(2)}p`;
    return `${p.toFixed(3)}p`;
  };

  const cost = (p: number | null) =>
    p === null ? '—' : p >= 1 ? `${p.toFixed(1)}p` : `${p.toFixed(3)}p`;

  /* The interval table names its unit in the header, so its cells carry the
   * number alone. */
  const bare = (p: number | null) =>
    p === null ? '—' : p >= 1 ? p.toFixed(1) : p.toFixed(3);

  /* Scales the bar in the rate column against the busiest interval on show. */
  const peakOutRate = Math.max(
    0,
    ...energy.buckets.map((b) => {
      const engine = b.prefillSeconds + b.decodeSeconds;
      if (!(engine > 0) || !(b.outputTokens > 0)) return 0;
      return (pencePerKwh((wattHours(b) * b.decodeSeconds) / engine) / b.outputTokens) * 1e6;
    }),
  );

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          Energy cost <Badge tone="warning">beta</Badge>
        </span>
      }
      accent="var(--series-cpu)"
    >
      <div className="flex flex-wrap items-end gap-4">
        <Input label="Unit rate" unit="p/kWh" value={pence} step={0.1} onChange={setPence} />
        <Input
          label="Baseline draw"
          unit="W"
          value={baseline}
          step={1}
          placeholder="0"
          onChange={setBaseline}
        />
        <p className="min-w-[15rem] flex-1 text-[11px] text-ink-muted">
          The GPU rail is measured every poll and integrated per interval, so a changing load is
          already accounted for. This board exposes no whole-unit sensor, so CPU, memory and PSU
          losses are not in it — read the plug while the node idles and enter that as the baseline.
        </p>
      </div>

      {energy.buckets.length === 0 ? (
        <p className="mt-4 text-[12px] text-ink-muted">
          Collecting. The first {Math.round(energy.bucketSeconds / 60)}-minute interval closes at{' '}
          {clock(energy.current.startedAt + energy.bucketSeconds * 1000)} — until then there is
          nothing measured over a whole interval to price.
        </p>
      ) : (
        <>
          <table className="mt-4 w-full text-[12px]">
            <thead>
              <tr className="border-b border-hairline-strong text-[10px] tracking-wide text-ink-muted uppercase">
                <th className="pb-1.5 text-left font-medium">Token class</th>
                <th className="pb-1.5 text-right font-medium">Tokens</th>
                <th className="pb-1.5 text-right font-medium">Engine time</th>
                <th className="pb-1.5 pl-4 text-right font-medium">Cost / M</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {rows.map((row) => (
                <tr key={row.label} className="border-t border-hairline first:border-t-0">
                  <td className="py-2">
                    <span className="text-ink">{row.label}</span>{' '}
                    <span className="text-[11px] text-ink-muted">{row.hint}</span>
                  </td>
                  <td className="py-2 text-right text-ink-secondary">
                    {row.tokens.toLocaleString()}
                  </td>
                  <td className="py-2 text-right text-ink-muted">
                    {row.seconds === null ? '—' : `${row.seconds.toFixed(0)}s`}
                  </td>
                  <td className="py-2 pl-4 text-right text-[13px] font-semibold text-ink">
                    {cost(row.cost)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* The intervals themselves, so a figure that moved can be seen to
              have moved rather than being averaged into stillness. Each one is
              priced the same way as the table above - by the engine time inside
              that interval - so a row and the total are the same arithmetic at
              two scales. */}
          <div className="mt-4">
            <div className="mb-1.5 text-[11px] tracking-wide text-ink-muted uppercase">
              {Math.round(energy.bucketSeconds / 60)}-minute intervals
            </div>
            <div className="overflow-x-auto rounded-lg border border-hairline">
              <table className="w-full min-w-[36rem] text-[11px]">
                <thead>
                  {/* Units live in the header so the cells hold nothing but
                      numbers, which is what makes a column scannable. */}
                  <tr className="border-b border-hairline bg-surface-2 text-[10px] tracking-wide text-ink-muted uppercase">
                    <th className="py-1.5 pl-3 text-left font-medium">Interval</th>
                    <th className="py-1.5 pr-3 pl-4 text-right font-medium">Draw W</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Energy Wh</th>
                    <th className="py-1.5 pr-3 pl-4 text-right font-medium">In</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Cached</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Out</th>
                    <th className="py-1.5 pr-3 pl-4 text-right font-medium">In p/M</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Out p/M</th>
                  </tr>
                </thead>
                <tbody className="tabular">
                  {[...energy.buckets].reverse().map((bucket) => {
                    const wh = wattHours(bucket);
                    const engine = bucket.prefillSeconds + bucket.decodeSeconds;

                    /* Per interval the useful figure is the rate, not the bill:
                       the pennies are unreadably small, while cost per million
                       is comparable across rows. */
                    const rate = (phaseSeconds: number, tokens: number) =>
                      engine > 0 && tokens > 0
                        ? (pencePerKwh((wh * phaseSeconds) / engine) / tokens) * 1e6
                        : null;

                    const outRate = rate(bucket.decodeSeconds, bucket.outputTokens);
                    const served = bucket.inputTokens + bucket.outputTokens > 0;

                    return (
                      <tr
                        key={bucket.startedAt}
                        className={`border-t border-hairline transition-colors hover:bg-surface-2 ${
                          served ? '' : 'text-ink-muted'
                        }`}
                      >
                        <td className="py-1.5 pl-3 whitespace-nowrap">
                          <span className={served ? 'text-ink-secondary' : ''}>
                            {clock(bucket.startedAt)}–{clock(bucket.endedAt)}
                          </span>
                          {/* An interval that served nothing still burned power,
                              and naming it is the point - the energy column
                              still carries what it cost. */}
                          {!served && (
                            <span className="ml-1.5 rounded bg-surface-2 px-1 py-px text-[9px] tracking-wide uppercase">
                              idle
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 pr-3 pl-4 text-right text-ink-secondary">
                          {(bucket.meanWatts + baseline).toFixed(0)}
                        </td>
                        <td className="py-1.5 pr-3 text-right text-ink-secondary">
                          {wh.toFixed(2)}
                        </td>
                        <td className="py-1.5 pr-3 pl-4 text-right text-ink-secondary">
                          {tokenCount(bucket.inputTokens)}
                        </td>
                        <td className="py-1.5 pr-3 text-right text-ink-muted">
                          {tokenCount(bucket.cachedTokens)}
                        </td>
                        <td className="py-1.5 pr-3 text-right text-ink-secondary">
                          {tokenCount(bucket.outputTokens)}
                        </td>
                        <td className="py-1.5 pr-3 pl-4 text-right text-ink-secondary">
                          {bare(rate(bucket.prefillSeconds, bucket.inputTokens))}
                        </td>
                        {/* The headline rate carries a bar as well as a number:
                            the point of a run of intervals is the shape, and a
                            column of figures hides it. */}
                        <td className="py-1.5 pr-3 text-right font-medium text-ink">
                          <span className="flex items-center justify-end gap-1.5">
                            {outRate !== null && peakOutRate > 0 && (
                              <span
                                aria-hidden
                                className="h-1 rounded-full"
                                style={{
                                  width: `${Math.max(6, (outRate / peakOutRate) * 40)}px`,
                                  background: 'var(--series-cpu)',
                                  opacity: 0.55,
                                }}
                              />
                            )}
                            {bare(outRate)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {/* Cached has no cost column because it has no cost: vLLM skips
                those blocks, so they hold the engine for no time at all. */}
            <p className="mt-1.5 text-[10px] leading-relaxed text-ink-muted">
              Cached tokens carry no cost column — they are never computed, so they hold the engine
              for no time to attribute energy by. An interval can show tokens with no rate beside
              them: vLLM records phase timings when a request finishes, so a generation still in
              flight contributes tokens to one interval and its engine time to a later one. The
              totals above are unaffected.
            </p>
          </div>

          <p className="mt-3 border-t border-hairline pt-2.5 text-[11px] text-ink-muted">
            {money(pencePerKwh(totals.wattHours))} of electricity over the last {minutes} min,
            producing {totals.outputTokens.toLocaleString()} output tokens. At this draw the node
            costs{' '}
            <span className="text-ink-secondary">
              {money(pencePerKwh(((totals.wattHours / minutes) * 60 * 24) || 0))}/day
            </span>{' '}
            — which it spends whether or not anything is being served.
          </p>
        </>
      )}
    </Card>
  );
}

function Input({
  label,
  unit,
  value,
  step,
  placeholder,
  onChange,
}: {
  label: string;
  unit: string;
  value: number;
  step: number;
  placeholder?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] tracking-wide text-ink-secondary uppercase">
        {label}
      </span>
      <span className="flex items-center gap-1.5">
        <input
          className="w-20 rounded-lg border border-hairline bg-surface-0 px-2 py-1 text-[13px] text-ink outline-none placeholder:text-ink-muted focus:border-[color:var(--series-gpu)]"
          type="number"
          min={0}
          step={step}
          placeholder={placeholder}
          value={value || ''}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <span className="text-[12px] text-ink-muted">{unit}</span>
      </span>
    </label>
  );
}
