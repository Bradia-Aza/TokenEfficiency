#!/usr/bin/env node
// RQ5 — what wall-clock latency does each interception point add?
// (INTERCEPTION_RESEARCH_PLAN.md Phase 0.6.)
//
// Both points sit in the user's critical path, and they cost time in different
// shapes:
//
//   - A hook spawns a SUBPROCESS PER EVENT. The cost is per tool call, paid
//     before the call runs, and it scales with how many events fire.
//   - The proxy adds a network hop, and in transform mode must buffer the whole
//     request body before forwarding (invariant 4 was narrowed to the response
//     path for exactly this reason). The cost is per request.
//
// This needs no new scenarios: it reads the timestamps already in both captures
// from the Phase 0.3 runs.
//
// The honest limit, stated because it bounds every number below: the proxy
// capture records the exchange duration, which INCLUDES the upstream's own
// think time. That is not "added" latency. So the gateway's overhead is
// reported as the gap between a passthrough-mode run and an observe- or
// transform-mode run of comparable work — which is what GATEWAY_MODE exists to
// make measurable — and a single run reports only the total, labeled as such.

import { readFileSync } from 'node:fs';

const percentile = (sorted, p) => {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
};

export function distribution(values) {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return { n: 0, min: null, p50: null, p95: null, max: null, mean: null, total: 0 };
  const total = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
    mean: Number((total / sorted.length).toFixed(2)),
    total,
  };
}

/** Per-exchange duration as the proxy measured it, by mode. */
export function proxyLatency(proxyRows) {
  const rows = proxyRows.filter((row) => row.side === 'proxy' && Number.isFinite(row.durationMs));
  return {
    all: distribution(rows.map((row) => row.durationMs)),
    streamed: distribution(rows.filter((row) => row.streamed).map((row) => row.durationMs)),
    nonStreamed: distribution(rows.filter((row) => !row.streamed).map((row) => row.durationMs)),
    // Transform mode only: how much body was re-serialized, which is the part
    // of the cost that is genuinely the gateway's rather than the upstream's.
    transformed: distribution(
      rows.filter((row) => row.transform?.transformed).map((row) => row.durationMs),
    ),
  };
}

/**
 * Hook cost, inferred from firing timestamps. Each firing is a process spawn;
 * the capture records when the hook RAN, so consecutive firings within one turn
 * bound how long the client spent in hooks. This is a lower bound on the true
 * cost — it cannot see the spawn latency before the process started writing.
 */
export function hookLatency(hookRows) {
  const rows = hookRows
    .filter((row) => row.side === 'hook' && Number.isFinite(Date.parse(row.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const byEvent = {};
  for (const row of rows) {
    byEvent[row.event ?? 'unknown'] = (byEvent[row.event ?? 'unknown'] ?? 0) + 1;
  }

  // Gaps between consecutive firings, which is what a turn actually waits on
  // when several hooks fire back to back.
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const gap = Date.parse(rows[i].at) - Date.parse(rows[i - 1].at);
    if (gap >= 0 && gap < 5000) gaps.push(gap);
  }

  return { firings: rows.length, byEvent, gapMs: distribution(gaps) };
}

export function analyze({ proxyRows, hookRows }) {
  return {
    proxy: proxyLatency(proxyRows),
    hook: hookLatency(hookRows),
  };
}

export function renderLatency(result, { mode = null } = {}) {
  const n = (v) => (v === null ? '—' : `${Math.round(v)}`);
  const lines = ['# Latency (RQ5)', ''];
  lines.push('Both interception points sit in the user\'s critical path, and they');
  lines.push('cost time in different shapes: a hook spawns a subprocess per event,');
  lines.push('while the proxy adds a network hop and, in transform mode, buffers the');
  lines.push('request body before forwarding.', '');

  lines.push('## Proxy: exchange duration', '');
  if (mode) lines.push(`Mode: \`${mode}\``, '');
  lines.push('| slice | n | min | p50 | p95 | max | mean |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const [name, dist] of Object.entries(result.proxy)) {
    if (dist.n === 0) continue;
    lines.push(`| ${name} | ${dist.n} | ${n(dist.min)} | ${n(dist.p50)} | ${n(dist.p95)} | ${n(dist.max)} | ${n(dist.mean)} |`);
  }
  lines.push('');
  lines.push('**These are totals, not overhead.** An exchange duration includes the');
  lines.push('upstream\'s own think time, which dwarfs anything the gateway does. The');
  lines.push('gateway\'s share is the difference between a `passthrough` run and an');
  lines.push('`observe` or `transform` run of comparable work — which is what');
  lines.push('`GATEWAY_MODE` exists to make measurable.', '');

  lines.push('## Hook: firings and spacing', '');
  lines.push(`Total firings: ${result.hook.firings}`);
  lines.push('');
  if (result.hook.gapMs.n > 0) {
    const g = result.hook.gapMs;
    lines.push('| | n | min | p50 | p95 | max | mean |');
    lines.push('|---|---|---|---|---|---|---|');
    lines.push(`| gap between firings (ms) | ${g.n} | ${n(g.min)} | ${n(g.p50)} | ${n(g.p95)} | ${n(g.max)} | ${n(g.mean)} |`);
    lines.push('');
  }
  if (Object.keys(result.hook.byEvent).length > 0) {
    lines.push('| event | firings |');
    lines.push('|---|---|');
    for (const [event, count] of Object.entries(result.hook.byEvent).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${event} | ${count} |`);
    }
    lines.push('');
  }
  lines.push('Each firing is a process spawn. The gap distribution is a LOWER bound');
  lines.push('on hook cost: the capture records when a hook ran, not when the client');
  lines.push('began waiting for it.', '');

  lines.push('## The constraint this implies', '');
  lines.push('Hook cost scales with the number of tool calls; proxy cost scales with');
  lines.push('the number of requests. A session with many small tool calls pays the');
  lines.push('hook cost repeatedly. If a per-tool-call hook costs more wall-clock');
  lines.push('time than its trim saves in tokens, that is a hard design constraint');
  lines.push('rather than a footnote.');
  return `${lines.join('\n')}\n`;
}

// -- cli --------------------------------------------------------------------

function readJsonl(path) {
  try {
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
  } catch {
    return [];
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const get = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i === -1 ? fallback : args[i + 1];
  };
  const result = analyze({
    proxyRows: readJsonl(get('--proxy', 'research/captures/proxy.jsonl')),
    hookRows: readJsonl(get('--hooks', 'research/captures/hooks.jsonl')),
  });
  process.stdout.write(
    args.includes('--json')
      ? `${JSON.stringify(result, null, 2)}\n`
      : renderLatency(result, { mode: get('--mode', null) }),
  );
}
