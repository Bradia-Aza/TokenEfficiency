#!/usr/bin/env node
// RQ4 — does trimming at one level invalidate the prompt-cache prefix in a way
// that costs more than the trim saves? (INTERCEPTION_RESEARCH_PLAN.md Phase 0.5.)
//
// This is the phase that can change the architecture rather than refine it.
//
// The mechanism: prompt caching keys on an exact prefix, and every turn resends
// the full history. Trim a tool output at turn three and the prefix changes for
// every turn after it.
//
//   - A HOOK-level trim happens before the content enters the transcript, so
//     the history is internally consistent from the start and the prefix is
//     stable by construction.
//   - A PROXY-level trim happens on the way out, so the same trim must be
//     reproduced identically on every subsequent turn. If it is not, the cache
//     is invalidated and full input price is paid on a long history — plausibly
//     more than the trim ever saved.
//
// The gateway's transform is deterministic and is applied to the whole replayed
// history every turn, so the transformed prefix should be stable and the cache
// should re-warm once and then behave normally. THAT IS A CLAIM, and this
// analysis is what tests it: it compares cache-read against cache-write tokens
// per turn across three runs (untrimmed, proxy-trimmed, hook-trimmed) and
// computes the net token cost of each.
//
// The net cost, per run, is what the provider actually billed:
//
//     billed = inputTokens + cacheWriteTokens + cacheReadTokens
//
// summed over turns. inputTokens excludes cache reads by canonical definition
// (see CLAUDE.md), so the three add without double counting. Cache writes
// typically carry a premium and reads a discount; the raw token counts are
// reported as billed rather than weighted, because the multipliers are provider
// pricing policy and the ledger's job is to stay comparable with itself.
//
// Usage:
//   node research/analyze/cache.js --run untrimmed=research/captures/run-a.jsonl \
//                                  --run proxy=research/captures/run-b.jsonl \
//                                  --run hook=research/captures/run-c.jsonl

import { readFileSync } from 'node:fs';

/** Per-turn cache figures for one run's capture. */
export function turnsOf(proxyRows) {
  return proxyRows
    .filter((row) => row.side === 'proxy' && row.usage)
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    .map((row, index) => {
      const usage = row.usage ?? {};
      const input = usage.inputTokens ?? 0;
      const read = usage.cacheReadTokens ?? 0;
      const write = usage.cacheWriteTokens ?? 0;
      return {
        turn: index + 1,
        at: row.at,
        sessionId: row.sessionId ?? null,
        inputTokens: input,
        cacheReadTokens: read,
        cacheWriteTokens: write,
        // What the provider billed for input on this turn.
        billed: input + read + write,
        requestBytes: row.requestSize ?? 0,
        // Present only in transform mode: how much the trim actually removed.
        transform: row.transform ?? null,
      };
    });
}

export function summarize(turns) {
  const sum = (key) => turns.reduce((total, turn) => total + turn[key], 0);
  const billed = sum('billed');
  const read = sum('cacheReadTokens');
  const write = sum('cacheWriteTokens');
  return {
    turns: turns.length,
    inputTokens: sum('inputTokens'),
    cacheReadTokens: read,
    cacheWriteTokens: write,
    billedTokens: billed,
    requestBytes: sum('requestBytes'),
    // The diagnostic that answers the question. A trim that keeps the prefix
    // stable shows one write early and reads thereafter. A trim that varies
    // shows a write on EVERY turn — the cache being invalidated and rebuilt,
    // which is the failure mode this phase exists to detect.
    turnsWithCacheWrite: turns.filter((turn) => turn.cacheWriteTokens > 0).length,
    cacheHitRatio: read + write === 0 ? null : read / (read + write),
  };
}

/**
 * Whether a run's cache behaves like a stable prefix. Writes on nearly every
 * turn mean the prefix is churning; that is the signal that a proxy-level trim
 * is not reproducing itself identically.
 */
export function prefixVerdict(summary) {
  if (summary.turns < 3) return { stable: null, reason: 'too few turns to judge (need 3+)' };
  const writeRate = summary.turnsWithCacheWrite / summary.turns;
  if (summary.cacheReadTokens === 0) {
    return { stable: false, reason: 'no cache reads at all — nothing was ever reused' };
  }
  if (writeRate > 0.6) {
    return {
      stable: false,
      reason: `cache writes on ${summary.turnsWithCacheWrite} of ${summary.turns} turns — the prefix is being rebuilt, not reused`,
    };
  }
  return {
    stable: true,
    reason: `cache writes on ${summary.turnsWithCacheWrite} of ${summary.turns} turns, then reads — the prefix re-warms once and holds`,
  };
}

export function compare(runs) {
  const analyzed = {};
  for (const [name, rows] of Object.entries(runs)) {
    const turns = turnsOf(rows);
    const summary = summarize(turns);
    analyzed[name] = { turns, summary, verdict: prefixVerdict(summary) };
  }

  // Net cost against the untrimmed baseline, when there is one. A trim that
  // saves content tokens but pays for a cache rebuild can come out NEGATIVE,
  // and that is the result that would reverse the architecture.
  const baseline = analyzed.untrimmed?.summary ?? null;
  if (baseline !== null) {
    for (const [name, run] of Object.entries(analyzed)) {
      if (name === 'untrimmed') continue;
      run.net = {
        billedDelta: run.summary.billedTokens - baseline.billedTokens,
        savedVsBaseline: baseline.billedTokens - run.summary.billedTokens,
        cacheWriteDelta: run.summary.cacheWriteTokens - baseline.cacheWriteTokens,
        cacheReadDelta: run.summary.cacheReadTokens - baseline.cacheReadTokens,
      };
    }
  }
  return analyzed;
}

// -- report -----------------------------------------------------------------

export function renderCache(analyzed) {
  const n = (v) => (v === null || v === undefined ? '—' : Math.round(v).toLocaleString('en-US'));
  const lines = ['# Cache impact (RQ4)', ''];
  lines.push('Prompt caching keys on an exact prefix and every turn resends the full');
  lines.push('history, so a trim at turn three changes the prefix for every turn');
  lines.push('after it. The question is whether a trim pays for itself once the');
  lines.push('cache is accounted for.', '');

  for (const [name, run] of Object.entries(analyzed)) {
    lines.push(`## ${name}`, '');
    lines.push('| turn | input | cache read | cache write | billed | req bytes |');
    lines.push('|---|---|---|---|---|---|');
    for (const turn of run.turns) {
      lines.push(
        `| ${turn.turn} | ${n(turn.inputTokens)} | ${n(turn.cacheReadTokens)} | ${n(turn.cacheWriteTokens)} | ${n(turn.billed)} | ${n(turn.requestBytes)} |`,
      );
    }
    const s = run.summary;
    lines.push(`| **total** | **${n(s.inputTokens)}** | **${n(s.cacheReadTokens)}** | **${n(s.cacheWriteTokens)}** | **${n(s.billedTokens)}** | **${n(s.requestBytes)}** |`);
    lines.push('');
    lines.push(`Cache hit ratio: ${s.cacheHitRatio === null ? '—' : `${(s.cacheHitRatio * 100).toFixed(1)}%`}`);
    lines.push(`Prefix stable: **${run.verdict.stable === null ? 'unknown' : run.verdict.stable ? 'yes' : 'no'}** — ${run.verdict.reason}`);
    if (run.net) {
      const saved = run.net.savedVsBaseline;
      lines.push('');
      lines.push(
        `Net against untrimmed: **${saved >= 0 ? `saved ${n(saved)}` : `COST ${n(-saved)}`} billed input tokens** ` +
          `(cache write ${run.net.cacheWriteDelta >= 0 ? '+' : ''}${n(run.net.cacheWriteDelta)}, cache read ${run.net.cacheReadDelta >= 0 ? '+' : ''}${n(run.net.cacheReadDelta)})`,
      );
    }
    lines.push('');
  }

  lines.push('## What this constrains', '');
  lines.push('If a trimmed run shows cache writes on nearly every turn while the');
  lines.push('untrimmed run does not, proxy-level trimming is invalidating the');
  lines.push('prefix and the trim must be reproduced identically on every');
  lines.push('subsequent turn to be cache-safe. That is a first-order');
  lines.push('architectural constraint — deterministic replayed state — and it');
  lines.push('belongs at the top of the final report, not in a footnote.', '');
  lines.push('If instead the trimmed run re-warms once and then reads, determinism');
  lines.push('is doing its job and proxy-level trimming is cache-safe as built.');
  return `${lines.join('\n')}\n`;
}

// -- cli --------------------------------------------------------------------

function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const runs = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '--run') continue;
    const spec = args[i + 1] ?? '';
    const eq = spec.indexOf('=');
    if (eq === -1) {
      process.stderr.write(`--run expects name=path, got ${JSON.stringify(spec)}\n`);
      process.exit(1);
    }
    runs[spec.slice(0, eq)] = readJsonl(spec.slice(eq + 1));
  }
  if (Object.keys(runs).length === 0) {
    process.stderr.write('usage: cache.js --run untrimmed=a.jsonl --run proxy=b.jsonl --run hook=c.jsonl\n');
    process.exit(1);
  }
  process.stdout.write(renderCache(compare(runs)));
}
