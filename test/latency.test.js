// RQ5's instrument. The trap it must avoid is reporting an exchange duration as
// if it were the gateway's overhead — it includes the upstream's think time,
// which dwarfs it. So what is asserted here is that the numbers are computed
// correctly AND that the report says what they are.
//
// This tests the rig, not the gateway. Deleting research/ deletes this too.

import assert from 'node:assert/strict';
import test from 'node:test';
import { analyze, distribution, hookLatency, proxyLatency, renderLatency } from '../research/analyze/latency.js';

test('summarizes a distribution without inventing values for an empty one', () => {
  assert.deepEqual(distribution([]), { n: 0, min: null, p50: null, p95: null, max: null, mean: null, total: 0 });
  const d = distribution([10, 20, 30, 40]);
  assert.equal(d.n, 4);
  assert.equal(d.min, 10);
  assert.equal(d.max, 40);
  assert.equal(d.mean, 25);
  assert.equal(d.total, 100);
});

test('ignores non-finite durations rather than poisoning the mean', () => {
  const d = distribution([10, null, undefined, NaN, 30]);
  assert.equal(d.n, 2);
  assert.equal(d.mean, 20);
});

test('splits proxy latency by streamed, non-streamed and transformed', () => {
  const rows = [
    { side: 'proxy', durationMs: 100, streamed: true },
    { side: 'proxy', durationMs: 200, streamed: false },
    { side: 'proxy', durationMs: 300, streamed: false, transform: { transformed: true } },
    // A row with no duration is not a zero-latency exchange; it is an absence.
    { side: 'proxy', streamed: false },
  ];
  const result = proxyLatency(rows);
  assert.equal(result.all.n, 3);
  assert.equal(result.streamed.n, 1);
  assert.equal(result.nonStreamed.n, 2);
  assert.equal(result.transformed.n, 1);
  assert.equal(result.transformed.p50, 300);
});

test('counts hook firings by event and measures the gaps between them', () => {
  const at = (ms) => new Date(Date.parse('2026-01-01T00:00:00Z') + ms).toISOString();
  const rows = [
    { side: 'hook', at: at(0), event: 'PreToolUse' },
    { side: 'hook', at: at(30), event: 'PostToolUse' },
    { side: 'hook', at: at(70), event: 'PreToolUse' },
  ];
  const result = hookLatency(rows);
  assert.equal(result.firings, 3);
  assert.equal(result.byEvent.PreToolUse, 2);
  assert.equal(result.byEvent.PostToolUse, 1);
  assert.equal(result.gapMs.n, 2);
  assert.deepEqual([result.gapMs.min, result.gapMs.max], [30, 40]);
});

test('drops implausibly long gaps, which are user think time not hook cost', () => {
  const at = (ms) => new Date(Date.parse('2026-01-01T00:00:00Z') + ms).toISOString();
  const result = hookLatency([
    { side: 'hook', at: at(0), event: 'Stop' },
    // A minute later: the user went for coffee, that is not hook latency.
    { side: 'hook', at: at(60_000), event: 'UserPromptSubmit' },
  ]);
  assert.equal(result.firings, 2);
  assert.equal(result.gapMs.n, 0);
});

test('the report states that durations are totals, not gateway overhead', () => {
  const report = renderLatency(
    analyze({
      proxyRows: [{ side: 'proxy', durationMs: 1500, streamed: true }],
      hookRows: [{ side: 'hook', at: '2026-01-01T00:00:00Z', event: 'PreToolUse' }],
    }),
    { mode: 'observe' },
  );
  // Without this caveat the table reads as "the gateway costs 1.5 seconds".
  assert.match(report, /totals, not overhead/);
  assert.match(report, /passthrough/);
  assert.match(report, /subprocess per event/);
  assert.match(report, /LOWER bound/);
});
