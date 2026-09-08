// RQ4's instrument — the phase that can change the architecture rather than
// refine it. Its whole job is to tell a stable prompt-cache prefix from a
// churning one, so that is what is tested, with runs whose behavior is known by
// construction.
//
// This tests the rig, not the gateway. Deleting research/ deletes this too.

import assert from 'node:assert/strict';
import test from 'node:test';
import { compare, prefixVerdict, renderCache, summarize, turnsOf } from '../research/analyze/cache.js';

/** A run where the prefix re-warms once and is then reused. */
function stableRun({ turns = 6, write = 2000, read = 12000, input = 300 } = {}) {
  return Array.from({ length: turns }, (_, i) => ({
    side: 'proxy',
    seq: i,
    at: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 1000).toISOString(),
    requestSize: 5000 + i * 500,
    usage: {
      inputTokens: input,
      // The first turn writes the cache; every later turn reads it.
      cacheWriteTokens: i === 0 ? write : 0,
      cacheReadTokens: i === 0 ? 0 : read,
    },
  }));
}

/** A run where every turn rebuilds the cache — the failure mode. */
function churningRun({ turns = 6, write = 2000, input = 300 } = {}) {
  return Array.from({ length: turns }, (_, i) => ({
    side: 'proxy',
    seq: i,
    at: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 1000).toISOString(),
    requestSize: 5000 + i * 500,
    usage: { inputTokens: input, cacheWriteTokens: write, cacheReadTokens: 0 },
  }));
}

test('bills input, cache read and cache write without double counting', () => {
  // canonical inputTokens excludes cache reads, so the three add cleanly.
  const turns = turnsOf([
    { side: 'proxy', seq: 0, usage: { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50 } },
  ]);
  assert.equal(turns[0].billed, 1050);
});

test('treats a missing usage figure as zero rather than dropping the turn', () => {
  const turns = turnsOf([{ side: 'proxy', seq: 0, usage: { inputTokens: 100 } }]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].cacheReadTokens, 0);
  assert.equal(turns[0].billed, 100);
});

test('calls a re-warm-once-then-read run stable', () => {
  const verdict = prefixVerdict(summarize(turnsOf(stableRun())));
  assert.equal(verdict.stable, true);
  assert.match(verdict.reason, /re-warms once/);
});

test('calls a rebuild-every-turn run unstable — the result that would reverse the architecture', () => {
  // Some reads happen (the constant system-prompt prefix still hits), but a
  // write on every turn means the trimmed region is being rebuilt each time.
  const rows = churningRun().map((row, i) => ({
    ...row,
    usage: { ...row.usage, cacheReadTokens: i === 0 ? 0 : 500 },
  }));
  const verdict = prefixVerdict(summarize(turnsOf(rows)));
  assert.equal(verdict.stable, false);
  assert.match(verdict.reason, /rebuilt, not reused/);
});

test('refuses to judge a run too short to judge', () => {
  const verdict = prefixVerdict(summarize(turnsOf(stableRun({ turns: 2 }))));
  assert.equal(verdict.stable, null, 'an unknown answer is reported as unknown, not guessed');
});

test('flags a run that never reused the cache at all', () => {
  const rows = Array.from({ length: 4 }, (_, i) => ({
    side: 'proxy',
    seq: i,
    usage: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  }));
  const verdict = prefixVerdict(summarize(turnsOf(rows)));
  assert.equal(verdict.stable, false);
  assert.match(verdict.reason, /nothing was ever reused/);
});

test('reports a trim that pays for itself as a saving', () => {
  // Trimmed run: same cache shape, less content per turn.
  const analyzed = compare({
    untrimmed: stableRun({ input: 1000 }),
    proxy: stableRun({ input: 400 }),
  });
  assert.ok(analyzed.proxy.net.savedVsBaseline > 0);
  assert.equal(analyzed.proxy.verdict.stable, true);
});

test('reports a trim that destroys the cache as a net COST, not a saving', () => {
  // The scenario the phase exists to catch: the trim removes content but the
  // prefix is rebuilt every turn, so the run bills more than the baseline.
  const analyzed = compare({
    untrimmed: stableRun({ input: 1000, read: 12000, write: 2000 }),
    proxy: churningRun({ input: 400, write: 13000 }),
  });
  assert.ok(
    analyzed.proxy.net.savedVsBaseline < 0,
    'a cache-destroying trim must show as a cost, however much content it removed',
  );
  assert.equal(analyzed.proxy.verdict.stable, false);

  const report = renderCache(analyzed);
  assert.match(report, /COST/);
  assert.match(report, /Prefix stable: \*\*no\*\*/);
});

test('renders a per-turn table for all three runs', () => {
  const report = renderCache(
    compare({ untrimmed: stableRun(), proxy: stableRun({ input: 500 }), hook: stableRun({ input: 500 }) }),
  );
  for (const name of ['untrimmed', 'proxy', 'hook']) {
    assert.match(report, new RegExp(`## ${name}`));
  }
  assert.match(report, /cache read/);
  assert.match(report, /What this constrains/);
});
