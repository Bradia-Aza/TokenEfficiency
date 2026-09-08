#!/usr/bin/env node
// RQ1 — can a hook event be reliably matched to the proxy request that carries
// it? (INTERCEPTION_RESEARCH_PLAN.md Phase 0.2.)
//
// This decides whether the rest of the plan can ask "both". If tool output a
// hook observed cannot be found in the bytes the proxy later sent, then a hook
// and the proxy cannot be talking about the same content, and a hybrid
// architecture is not buildable.
//
// It is a CORRELATOR, not a parser. The two sides keep their own shapes and are
// aligned, never merged (rig invariant 4): a schema rich enough to hold both
// would make "the proxy sees this after serialization, the hook sees it before"
// disappear, and that asymmetry is exactly what the study exists to find.
//
// The join is on content:
//
//   1. Take the tool output as the hook observed it (PostToolUse.tool_response).
//   2. Search every subsequent proxy request body for that content.
//   3. Record whether it was found, in which request, after how many
//      intervening requests, and whether it arrived verbatim or altered.
//
// That join doubles as the measurement the platform actually cares about:
// whether a hook could have intercepted the exact bytes the proxy was about to
// send.
//
// Usage:
//   node research/correlate.js [--hooks f.jsonl] [--proxy f.jsonl] [--json]

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// -- capture loading --------------------------------------------------------

function readJsonl(path) {
  const text = readFileSync(path, 'utf8');
  const rows = [];
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    try {
      rows.push(JSON.parse(line));
    } catch (err) {
      // A truncated last line is normal if a capture was cut short; anything
      // else is worth saying out loud rather than silently dropping.
      process.stderr.write(`[correlate] ${path}:${index + 1} is not JSON: ${err.message}\n`);
    }
  });
  return rows;
}

/** Proxy request bodies as text, in the order the proxy sent them. */
function proxyRequests(rows) {
  return rows
    .filter((row) => row.side === 'proxy')
    .map((row, index) => ({
      index,
      seq: row.seq,
      at: row.at,
      atMs: Date.parse(row.at),
      exchangeId: row.exchangeId,
      sessionId: row.sessionId,
      path: row.path,
      status: row.status,
      body:
        row.requestEncoding === 'base64'
          ? Buffer.from(row.requestBody ?? '', 'base64').toString('utf8')
          : (row.requestBody ?? ''),
      requestSize: row.requestSize,
      usage: row.usage ?? null,
    }))
    .sort((a, b) => a.seq - b.seq);
}

// -- what a hook event holds ------------------------------------------------

const TOOL_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure']);

/**
 * The text of a tool result as the hook saw it. `tool_response` is not a fixed
 * shape across tools — Bash carries stdout/stderr, Read carries file content,
 * others carry arbitrary objects — so this pulls the plausible text carriers
 * and leaves the rest to the JSON serialization.
 */
function toolOutputText(response) {
  if (response === null || response === undefined) return null;
  if (typeof response === 'string') return response;
  if (typeof response !== 'object') return String(response);

  const parts = [];
  for (const key of ['stdout', 'stderr', 'content', 'text', 'output', 'result', 'file', 'data']) {
    const value = response[key];
    if (typeof value === 'string' && value !== '') parts.push(value);
    else if (value !== null && typeof value === 'object') {
      // Read returns { file: { content } }, and similar nestings appear
      // elsewhere; one level down is enough to catch them without inventing a
      // general walker.
      for (const inner of ['content', 'text', 'stdout']) {
        if (typeof value[inner] === 'string' && value[inner] !== '') parts.push(value[inner]);
      }
    }
  }
  if (parts.length > 0) return parts.join('\n');
  try {
    return JSON.stringify(response);
  } catch {
    return null;
  }
}

function hookToolEvents(rows) {
  return rows
    .filter((row) => row.side === 'hook' && TOOL_EVENTS.has(row.event))
    .map((row, index) => {
      const payload = row.payload ?? {};
      const output = toolOutputText(payload.tool_response);
      return {
        index,
        at: row.at,
        atMs: Date.parse(row.at),
        event: row.event,
        sessionId: row.sessionId,
        toolName: payload.tool_name ?? null,
        toolInput: payload.tool_input ?? null,
        output,
        outputLength: output === null ? 0 : output.length,
        outputHash: output === null ? null : createHash('sha256').update(output).digest('hex').slice(0, 16),
      };
    })
    .sort((a, b) => a.atMs - b.atMs);
}

// -- the join ---------------------------------------------------------------

/**
 * Content long enough to be a fingerprint. Very short outputs ("", "ok") match
 * by coincidence and would inflate the match rate into meaninglessness, so they
 * are reported separately rather than counted as either hits or misses.
 */
const MIN_FINGERPRINT = 24;

/**
 * How the content of a tool output appears in a request body. JSON-encoding is
 * the expected transformation — the proxy carries the output inside a JSON
 * string, so newlines and quotes arrive escaped — and finding it only in that
 * form is a match, not a miss. Finding neither form, while a long substring of
 * it is present, means the content was altered in transit, which is the finding
 * the plan asks to be recorded rather than smoothed over.
 */
function findContent(body, output) {
  if (body.includes(output)) return { found: true, form: 'verbatim' };

  // The way a JSON body actually carries it: escaped, minus the quotes.
  const encoded = JSON.stringify(output).slice(1, -1);
  if (body.includes(encoded)) return { found: true, form: 'json-escaped' };

  // Truncation and wrapping: does a long prefix survive even though the whole
  // does not? Halve until something matches, so the report can say how much.
  for (const fraction of [0.75, 0.5, 0.25, 0.1]) {
    const size = Math.floor(output.length * fraction);
    if (size < MIN_FINGERPRINT) break;
    const prefix = output.slice(0, size);
    if (body.includes(prefix) || body.includes(JSON.stringify(prefix).slice(1, -1))) {
      return { found: true, form: 'partial', survivingFraction: fraction };
    }
  }
  return { found: false, form: null };
}

export function correlate({ hookRows, proxyRows }) {
  const requests = proxyRequests(proxyRows);
  const events = hookToolEvents(hookRows);

  const matches = [];
  const unmatched = [];
  const skipped = [];

  for (const event of events) {
    if (event.output === null || event.outputLength < MIN_FINGERPRINT) {
      skipped.push({
        ...eventSummary(event),
        reason:
          event.output === null
            ? 'the hook payload carried no readable tool output'
            : `output is ${event.outputLength} chars, below the ${MIN_FINGERPRINT}-char fingerprint floor`,
      });
      continue;
    }

    // Only requests the proxy sent AFTER the hook fired can carry the output.
    // This ordering is the whole point: a hook that fires after the bytes are
    // already gone could not have intercepted them.
    const candidates = requests.filter((request) => request.atMs >= event.atMs);
    let hit = null;
    for (let i = 0; i < candidates.length; i += 1) {
      const result = findContent(candidates[i].body, event.output);
      if (result.found) {
        hit = { request: candidates[i], result, lag: i };
        break;
      }
    }

    if (hit === null) {
      // Was it in an EARLIER request? That would mean the clocks disagree or
      // the content predates the tool call, and it is a different failure from
      // "never appeared at all".
      const earlier = requests
        .filter((request) => request.atMs < event.atMs)
        .some((request) => findContent(request.body, event.output).found);
      unmatched.push({
        ...eventSummary(event),
        reason: earlier
          ? 'found only in a request that predates the hook firing (clock skew, or replayed history)'
          : 'not found in any proxy request body',
      });
      continue;
    }

    matches.push({
      ...eventSummary(event),
      form: hit.result.form,
      survivingFraction: hit.result.survivingFraction ?? 1,
      // How many proxy requests went out between the hook firing and the one
      // that carried the content. 0 means the very next request carried it.
      lag: hit.lag,
      lagMs: hit.request.atMs - event.atMs,
      requestSeq: hit.request.seq,
      requestPath: hit.request.path,
      requestSessionId: hit.request.sessionId,
      requestSize: hit.request.requestSize,
    });
  }

  const considered = matches.length + unmatched.length;
  return {
    totals: {
      hookEvents: events.length,
      proxyRequests: requests.length,
      considered,
      matched: matches.length,
      unmatched: unmatched.length,
      skipped: skipped.length,
      matchRate: considered === 0 ? null : matches.length / considered,
    },
    lag: distribution(matches.map((m) => m.lag)),
    lagMs: distribution(matches.map((m) => m.lagMs)),
    byForm: countBy(matches, (m) => m.form),
    byTool: countBy(matches, (m) => m.toolName ?? 'unknown'),
    matches,
    unmatched,
    skipped,
  };
}

const eventSummary = (event) => ({
  at: event.at,
  event: event.event,
  toolName: event.toolName,
  hookSessionId: event.sessionId,
  outputLength: event.outputLength,
  outputHash: event.outputHash,
});

function countBy(rows, key) {
  const out = {};
  for (const row of rows) {
    const k = key(row);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function distribution(values) {
  if (values.length === 0) return { n: 0, min: null, median: null, max: null, mean: null };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1],
    mean: Number((sum / sorted.length).toFixed(2)),
  };
}

// -- report -----------------------------------------------------------------

export function renderReport(result) {
  const { totals } = result;
  const lines = [];
  const pct = (n) => (n === null ? 'n/a' : `${(n * 100).toFixed(1)}%`);

  lines.push('# Correlation report (RQ1)', '');
  lines.push(`- hook tool events: ${totals.hookEvents}`);
  lines.push(`- proxy requests: ${totals.proxyRequests}`);
  lines.push(`- considered (output long enough to fingerprint): ${totals.considered}`);
  lines.push(`- matched: ${totals.matched}`);
  lines.push(`- unmatched: ${totals.unmatched}`);
  lines.push(`- skipped (output too short or absent): ${totals.skipped}`);
  lines.push(`- **match rate: ${pct(totals.matchRate)}**`);
  lines.push('');

  if (totals.matched > 0) {
    lines.push('## Lag: proxy requests between the hook firing and the carrying request', '');
    lines.push('| | requests | ms |');
    lines.push('|---|---|---|');
    lines.push(`| min | ${result.lag.min} | ${result.lagMs.min} |`);
    lines.push(`| median | ${result.lag.median} | ${result.lagMs.median} |`);
    lines.push(`| mean | ${result.lag.mean} | ${result.lagMs.mean} |`);
    lines.push(`| max | ${result.lag.max} | ${result.lagMs.max} |`);
    lines.push('');

    lines.push('## How the content appeared on the wire', '');
    lines.push('| form | n |');
    lines.push('|---|---|');
    for (const [form, n] of Object.entries(result.byForm)) lines.push(`| ${form} | ${n} |`);
    lines.push('');
    lines.push('`verbatim` and `json-escaped` are both clean matches — the second');
    lines.push('is simply how a JSON body carries the bytes. `partial` means the');
    lines.push('content was altered, wrapped or truncated in transit, and is a');
    lines.push('limit on what a hook-level transform can guarantee.');
    lines.push('');

    lines.push('## Matches by tool', '');
    lines.push('| tool | n |');
    lines.push('|---|---|');
    for (const [tool, n] of Object.entries(result.byTool)) lines.push(`| ${tool} | ${n} |`);
    lines.push('');
  }

  if (result.unmatched.length > 0) {
    lines.push('## Unmatched, itemized', '');
    lines.push('| at | tool | chars | reason |');
    lines.push('|---|---|---|---|');
    for (const row of result.unmatched) {
      lines.push(`| ${row.at} | ${row.toolName ?? '—'} | ${row.outputLength} | ${row.reason} |`);
    }
    lines.push('');
  }

  if (result.skipped.length > 0) {
    lines.push('## Skipped, itemized', '');
    lines.push('| at | tool | chars | reason |');
    lines.push('|---|---|---|---|');
    for (const row of result.skipped) {
      lines.push(`| ${row.at} | ${row.toolName ?? '—'} | ${row.outputLength} | ${row.reason} |`);
    }
    lines.push('');
  }

  lines.push('## Reading this', '');
  lines.push('A high match rate means a hook could have intercepted the exact bytes');
  lines.push('the proxy was about to send, so the two sides can be talked about');
  lines.push('together and a hybrid is buildable. A low one means they are not');
  lines.push('addressing the same content, and the decision collapses to one side');
  lines.push('or the other — see Phase 0.2 of INTERCEPTION_RESEARCH_PLAN.md.');
  return `${lines.join('\n')}\n`;
}

// -- cli --------------------------------------------------------------------

function parseArgs(argv) {
  const args = { hooks: 'research/captures/hooks.jsonl', proxy: 'research/captures/proxy.jsonl', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--hooks') args.hooks = argv[++i];
    else if (argv[i] === '--proxy') args.proxy = argv[++i];
    else if (argv[i] === '--json') args.json = true;
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const result = correlate({ hookRows: readJsonl(args.hooks), proxyRows: readJsonl(args.proxy) });
  process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : renderReport(result));
}
