import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceTokenWindow } from './monitor.js';

const WINDOW = 10 * 60 * 1000;
const T0 = 1_700_000_000_000;

const sample = (offsetMs, generated, prompt, cached = 0) => ({
  at: T0 + offsetMs,
  generated,
  prompt,
  cached,
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
