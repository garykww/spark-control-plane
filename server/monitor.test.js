import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceTokenWindow, advanceEnergyBuckets } from './monitor.js';

const WINDOW = 10 * 60 * 1000;
const T0 = 1_700_000_000_000;

const sample = (offsetMs, generated, prompt, cached = 0, prefillSeconds = 0, decodeSeconds = 0) => ({
  at: T0 + offsetMs,
  generated,
  prompt,
  cached,
  prefillSeconds,
  decodeSeconds,
});

/* Feeds a series of samples the way the poll loop would. */
const run = (samples, windowMs = WINDOW) =>
  samples.reduce(
    (state, s) => advanceTokenWindow(state.samples, s, windowMs),
    { samples: undefined, window: null },
  );

test('the first sample spans nothing and reports no tokens', () => {
  const { window } = run([sample(0, 500, 9000)]);

  assert.equal(window.seconds, 0);
  assert.equal(window.complete, false);
  assert.deepEqual([window.decode, window.prefill], [0, 0]);
});

/*
 * The reason this is counter deltas and not integrated rates: prefill lands in
 * one burst between two polls, and the difference catches all of it.
 */
test('totals are the counter difference across the retained span', () => {
  const { window } = run([
    sample(0, 1000, 20000, 15000),
    sample(2000, 1040, 20000, 15000),
    sample(4000, 1080, 51000, 44000),
  ]);

  assert.equal(window.decode, 80);
  assert.equal(window.prefill, 31000);
  assert.equal(window.cached, 29000);
  assert.equal(window.seconds, 4);
});

test('a partial window says so, and a filled one is complete', () => {
  const partial = run([sample(0, 0, 0), sample(WINDOW - 1000, 100, 200)]);
  assert.equal(partial.window.complete, false);

  const filled = run([sample(0, 0, 0), sample(WINDOW, 100, 200)]);
  assert.equal(filled.window.complete, true);
  assert.equal(filled.window.seconds, WINDOW / 1000);
});

/*
 * Samples older than the window are dropped, but the one immediately behind the
 * cutoff is kept: without it the total would start just inside the window and
 * lose whatever was served in the gap.
 */
test('samples older than the window fall out of the total', () => {
  const at = (minutes) => T0 + minutes * 60_000;
  const series = [0, 2, 4, 6, 8, 10, 12].map((m, i) => ({
    at: at(m),
    generated: i * 1000,
    prompt: i * 2000,
    cached: 0,
  }));

  const { samples, window } = run(series);

  /* Minute 0 is more than 10 minutes behind the last sample, so it goes; minute
   * 2 straddles the cutoff and stays. */
  assert.equal(samples[0].at, at(2));
  assert.equal(samples.length, 6);
  assert.equal(window.decode, 5000, 'counted from the retained sample, not from zero');
  assert.equal(window.complete, true);
});

/* At a normal poll cadence the retained span overshoots the window by at most
 * one interval, which is what makes "last 10 min" a fair label for it. */
test('a steadily polled window stays within one interval of its span', () => {
  const series = Array.from({ length: 400 }, (_, i) => sample(i * 2000, i * 40, i * 90));

  const { window } = run(series);

  assert.equal(window.complete, true);
  assert.ok(
    window.seconds >= WINDOW / 1000 && window.seconds <= WINDOW / 1000 + 2,
    `span ${window.seconds}s should sit just above ${WINDOW / 1000}s`,
  );
});

/*
 * A restarted model server resets its counters to zero. Reporting "now minus
 * then" across that point would be negative, and treating the reset as a jump
 * would invent an enormous spike.
 */
test('a counter reset restarts the window instead of going negative', () => {
  const { samples, window } = run([
    sample(0, 900_000, 4_000_000),
    sample(2000, 900_500, 4_000_000),
    sample(4000, 12, 40),
  ]);

  assert.equal(samples.length, 1, 'history before the restart is discarded');
  assert.equal(window.decode, 0);
  assert.equal(window.prefill, 0);
  assert.equal(window.complete, false);
});

test('a backend that reports no cached counter still totals the rest', () => {
  const { window } = run([sample(0, 100, 1000), sample(2000, 300, 5000)]);

  assert.equal(window.decode, 200);
  assert.equal(window.prefill, 4000);
  assert.equal(window.cached, 0);
});

/*
 * The engine's time in each phase rides the same window as the tokens, because
 * the energy split is only defensible if both halves describe the same span.
 */
test('phase time is carried through the window alongside the tokens', () => {
  const { window } = run([
    sample(0, 1000, 20000, 15000, 40, 500),
    sample(2000, 1080, 51000, 44000, 46, 512),
  ]);

  assert.equal(window.prefillSeconds, 6);
  assert.equal(window.decodeSeconds, 12);
  assert.equal(window.decode, 80);
  assert.equal(window.prefill, 31000);
});

/* Decode holds the engine far longer per token than prefill does. Attributing
 * energy by token count instead of by this time would invert the answer. */
test('the window shows decode holding the engine far longer per token', () => {
  const { window } = run([
    sample(0, 0, 0, 0, 0, 0),
    sample(600_000, 25_000, 1_300_000, 1_274_000, 56, 566),
  ]);

  const perDecodeToken = window.decodeSeconds / window.decode;
  const perInputToken = window.prefillSeconds / (window.prefill - window.cached);

  assert.ok(perDecodeToken > perInputToken * 10, 'decode should dominate per token');
});

/* ---- energy intervals ---------------------------------------------------- */

const BUCKET_MS = 5 * 60 * 1000;

/* Feeds samples the way the poll loop would, at a fixed cadence. */
const poll = (samples, bucketMs = BUCKET_MS, keep = 12) =>
  samples.reduce(
    (acc, s) => advanceEnergyBuckets(acc.state, s, bucketMs, keep),
    { state: null },
  );

const watt = (offsetMs, watts, output = 0, input = 0, cached = 0, prefillSeconds = 0, decodeSeconds = 0) => ({
  at: T0 + offsetMs,
  watts,
  input,
  cached,
  output,
  prefillSeconds,
  decodeSeconds,
});

/*
 * The reason intervals exist: draw is not constant. Ten minutes at a mean of
 * 105 W is not the same measurement as five idle and five loaded, and the
 * integration has to reflect what was actually sampled in each.
 */
test('energy is integrated from the samples inside each interval', () => {
  /* 60s idle at 40 W, then 60s loaded at 200 W, polled every 30s. */
  const samples = [
    watt(0, 40),
    watt(30_000, 40),
    watt(60_000, 40),
    watt(90_000, 200),
    watt(120_000, 200),
  ];

  const { open } = poll(samples);

  /* Four intervals of 30s: 40, 40, 200, 200 W -> 30*(40+40+200+200) J. */
  assert.equal(open.joules, 30 * (40 + 40 + 200 + 200));
});

test('an interval closes once it is full and the next starts empty', () => {
  const samples = [watt(0, 100), watt(BUCKET_MS - 1000, 100), watt(BUCKET_MS, 100)];

  const { closed, open } = poll(samples);

  assert.equal(closed.length, 1);
  assert.equal(closed[0].startedAt, T0);
  assert.equal(open.joules, 0, 'the fresh interval carries none of the last one');
  assert.equal(open.startedAt, T0 + BUCKET_MS);
});

/* Token deltas have to describe the same minutes as the joules, or the cost per
 * token is a ratio of two unrelated measurements. */
test('tokens are counted into the interval that measured their energy', () => {
  const { closed } = poll([
    watt(0, 100, 1000, 500, 9000, 10, 100),
    watt(BUCKET_MS / 2, 100, 1600, 700, 9400, 14, 190),
    watt(BUCKET_MS, 100, 2000, 900, 9800, 18, 260),
    watt(BUCKET_MS + 1000, 100, 2000, 900, 9800, 18, 260),
  ]);

  assert.equal(closed.length, 1);
  assert.equal(closed[0].outputTokens, 1000, 'only the tokens served inside the interval');
  assert.equal(closed[0].inputTokens, 400);
  assert.equal(closed[0].decodeSeconds, 160);
});

test('only the most recent intervals are kept', () => {
  const samples = Array.from({ length: 30 }, (_, i) => watt(i * BUCKET_MS, 100, i * 1000));

  const { closed } = poll(samples, BUCKET_MS, 12);

  assert.equal(closed.length, 12);
  assert.equal(closed.at(-1).endedAt, T0 + 29 * BUCKET_MS);
});

/* A restarted model server rewinds its counters. Counting the difference would
 * subtract a large number from a small one and produce a negative interval. */
test('a counter reset contributes nothing rather than a negative delta', () => {
  const { open } = poll([
    watt(0, 100, 900_000, 50_000, 400_000, 60, 900),
    watt(30_000, 100, 12, 40, 100, 1, 2),
  ]);

  assert.equal(open.outputTokens, 0);
  assert.equal(open.inputTokens, 0);
  assert.equal(open.decodeSeconds, 0);
  assert.ok(open.joules > 0, 'energy still accrues across the restart');
});

/* A poll that never arrived must not invent energy for the gap it left. */
test('energy accrues only across intervals that were actually sampled', () => {
  const steady = poll([watt(0, 100), watt(2000, 100), watt(4000, 100)]);
  assert.equal(steady.open.joules, 400);

  const gap = poll([watt(0, 100), watt(120_000, 100)]);
  assert.equal(gap.open.joules, 12_000, 'the gap is priced at the draw that bracketed it');
});
