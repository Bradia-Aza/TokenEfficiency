#!/usr/bin/env node
// RQ2 — what fraction of input tokens sits in content each side can address?
// (INTERCEPTION_RESEARCH_PLAN.md Phase 0.4.)
//
// This is the analysis a visibility study cannot produce. Counting FIELDS makes
// the two sides look similar; counting TOKEN MASS is what ranks them, because
// the platform's job is to remove tokens, not to see them.
//
// Method, and its one honest limitation:
//
//   The gateway has no tokenizer and zero dependencies, so it cannot count the
//   tokens of any individual content block. What it does have is the provider's
//   own reported input-token count for the whole request. So this attributes
//   CHARACTER mass per category exactly, then apportions the reported input
//   tokens across categories in proportion to it. Tokens-per-character is not
//   uniform across categories — JSON tool arguments tokenize worse than prose —
//   so a category's token figure is an estimate with a known bias, while its
//   character figure is exact. Both are reported, and the ratio is stated, so a
//   reader can see how much work the apportionment is doing.
//
// Categories are the units a transform would actually act on, and each is
// marked with which side can address it:
//
//   - tool-result   both      the primary trimming target
//   - system        proxy     large, constant, cache-resident
//   - tools         proxy     tool definitions; constant per session
//   - user-text     both      what the user typed (hooks see it at submit)
//   - assistant     proxy     the model's own replies, replayed each turn
//   - thinking      proxy     signed; mutating it invalidates the signature
//   - tool-call     proxy     structured args the client matches on
//   - media         proxy     attachments
//   - other         proxy     everything unmodeled
//
// "Addressable by a hook" is deliberately narrow and is the finding, not an
// assumption: per the hook contract, only PreToolUse can rewrite content, and
// what it rewrites is a tool's INPUT. No hook event can rewrite a tool RESULT
// after execution. So a hook can suppress or reshape a tool call before it
// runs, and it can add context at prompt submit — but the replayed history of
// past tool results, which is where the mass accumulates, is not something it
// can reach on a later turn. Phase 0.4's mutation table tests that by
// experiment rather than trusting the docs.

import { readFileSync } from 'node:fs';
import { adapter as anthropic } from '../../adapters/anthropic.js';
import { BLOCK, ROLE } from '../../canonical/index.js';

/** Which interception point can change this category's content in flight. */
export const REACH = Object.freeze({
  'tool-result': { hook: 'indirect', proxy: true, note: 'Hooks act before the call runs (PreToolUse input rewrite); the proxy can rewrite the replayed result on every later turn.' },
  system: { hook: false, proxy: true, note: 'Constant and cache-resident. The proxy can rewrite it; no hook event carries it.' },
  tools: { hook: false, proxy: true, note: 'Tool definitions. Rewriting names breaks the client\'s own dispatch, so this is reachable but not safely.' },
  'user-text': { hook: true, proxy: true, note: 'UserPromptSubmit can block or add context; the proxy can rewrite the text.' },
  assistant: { hook: false, proxy: true, note: 'The model\'s replies, replayed every turn. No hook event can alter them.' },
  thinking: { hook: false, proxy: 'unsafe', note: 'Signed by the provider. Mutating the text invalidates the signature and the turn is rejected.' },
  'tool-call': { hook: true, proxy: true, note: 'PreToolUse.updatedInput rewrites these before execution.' },
  media: { hook: false, proxy: true, note: 'Attachments. Reachable in principle; not text.' },
  other: { hook: false, proxy: false, note: 'Unmodeled content, forwarded byte-for-byte by invariant 2.' },
});

const textLength = (value) => (typeof value === 'string' ? value.length : 0);

/** Characters in a JSON-serializable value, as it would ride on the wire. */
function jsonLength(value) {
  if (value === null || value === undefined) return 0;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/** Character mass per category for one canonical request. */
export function attributeRequest(request) {
  const chars = {};
  const add = (category, n) => {
    if (n > 0) chars[category] = (chars[category] ?? 0) + n;
  };

  for (const block of request.system ?? []) {
    add('system', block.type === BLOCK.TEXT ? textLength(block.text) : jsonLength(block.raw));
  }

  for (const tool of request.tools ?? []) {
    add('tools', textLength(tool.name) + textLength(tool.description) + jsonLength(tool.parameters));
  }

  for (const message of request.messages ?? []) {
    const fromUser = message.role === ROLE.USER;
    for (const block of message.content ?? []) {
      switch (block.type) {
        case BLOCK.TEXT:
          // The same block kind means different things by role: a user's text
          // is what they typed, an assistant's is replayed history.
          add(fromUser ? 'user-text' : 'assistant', textLength(block.text));
          break;
        case BLOCK.TOOL_RESULT:
          add('tool-result', toolResultLength(block));
          break;
        case BLOCK.JSON:
          // A structured tool-result payload is still a tool result.
          add('tool-result', jsonLength(block.data));
          break;
        case BLOCK.TOOL_CALL:
          add('tool-call', textLength(block.name) + jsonLength(block.input));
          break;
        case BLOCK.THINKING:
          // The text lives in `thinking`, and the signature rides with it — both
          // are input mass, and neither can be touched without invalidating it.
          add('thinking', textLength(block.thinking) + textLength(block.signature));
          break;
        case BLOCK.MEDIA:
          add('media', jsonLength(block.source));
          break;
        default:
          add('other', jsonLength(block.raw ?? block));
      }
    }
  }

  return chars;
}

function toolResultLength(block) {
  let total = 0;
  for (const inner of block.content ?? []) {
    if (inner.type === BLOCK.TEXT) total += textLength(inner.text);
    else if (inner.type === BLOCK.JSON) total += jsonLength(inner.data);
    else total += jsonLength(inner.raw ?? inner);
  }
  return total;
}

/**
 * Apportion a request's reported input tokens across categories in proportion
 * to character mass. `cacheReadTokens` is added back into the denominator:
 * canonical `inputTokens` excludes cache reads by definition, but the content
 * those tokens paid for is physically present in the request body and a
 * transform that shrinks it changes what gets cached. Leaving it out would
 * understate the reachable mass on exactly the long histories that matter.
 */
export function apportion(chars, usage) {
  const totalChars = Object.values(chars).reduce((a, b) => a + b, 0);
  const billed = (usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0);
  const out = {};
  for (const [category, n] of Object.entries(chars)) {
    out[category] = {
      chars: n,
      tokens: totalChars === 0 ? 0 : (n / totalChars) * billed,
    };
  }
  return { categories: out, totalChars, billedTokens: billed };
}

/** Roll a whole capture up into per-category reach. */
export function analyze(proxyRows) {
  const totals = {};
  let billedTokens = 0;
  let totalChars = 0;
  let requests = 0;
  let unmodeled = 0;

  for (const row of proxyRows) {
    if (row.side !== 'proxy' || !row.requestBody) continue;
    let request;
    try {
      const body = row.requestEncoding === 'base64'
        ? Buffer.from(row.requestBody, 'base64').toString('utf8')
        : row.requestBody;
      request = anthropic.requestToCanonical(JSON.parse(body));
    } catch {
      // Invariant 2 content: forwarded byte-for-byte, unmodelable, and so
      // unreachable by anything. Counted, not silently dropped.
      unmodeled += 1;
      continue;
    }
    requests += 1;
    const { categories, totalChars: rowChars, billedTokens: rowTokens } = apportion(
      attributeRequest(request),
      row.usage,
    );
    billedTokens += rowTokens;
    totalChars += rowChars;
    for (const [category, value] of Object.entries(categories)) {
      const bucket = (totals[category] ??= { chars: 0, tokens: 0 });
      bucket.chars += value.chars;
      bucket.tokens += value.tokens;
    }
  }

  const bySide = { hook: { chars: 0, tokens: 0 }, proxy: { chars: 0, tokens: 0 }, both: { chars: 0, tokens: 0 } };
  for (const [category, value] of Object.entries(totals)) {
    const reach = REACH[category] ?? REACH.other;
    // `indirect` and `unsafe` are NOT counted as reach. A hook that can only
    // act before a call runs cannot address the replayed history, and content
    // that cannot be mutated safely is not addressable mass.
    const hook = reach.hook === true;
    const proxy = reach.proxy === true;
    if (hook) { bySide.hook.chars += value.chars; bySide.hook.tokens += value.tokens; }
    if (proxy) { bySide.proxy.chars += value.chars; bySide.proxy.tokens += value.tokens; }
    if (hook && proxy) { bySide.both.chars += value.chars; bySide.both.tokens += value.tokens; }
  }

  return { requests, unmodeled, totals, totalChars, billedTokens, bySide };
}

// -- report -----------------------------------------------------------------

export function renderReach(result) {
  const lines = ['# Reachability (RQ2)', ''];
  const pct = (n, d) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`);
  const round = (n) => Math.round(n).toLocaleString('en-US');

  lines.push(`Requests analyzed: ${result.requests}${result.unmodeled > 0 ? ` (${result.unmodeled} unmodelable, excluded)` : ''}`);
  lines.push(`Billed input tokens (input + cache read + cache write): ${round(result.billedTokens)}`);
  lines.push(`Characters attributed: ${round(result.totalChars)}`);
  if (result.totalChars > 0) {
    lines.push(`Overall ratio: ${(result.billedTokens / result.totalChars).toFixed(3)} tokens/char`);
  }
  lines.push('');
  lines.push('Token figures are apportioned from character mass (there is no');
  lines.push('tokenizer here); character figures are exact.', '');

  lines.push('## Where the input tokens are', '');
  lines.push('| category | chars | est. tokens | share | hook | proxy |');
  lines.push('|---|---|---|---|---|---|');
  const sorted = Object.entries(result.totals).sort((a, b) => b[1].tokens - a[1].tokens);
  for (const [category, value] of sorted) {
    const reach = REACH[category] ?? REACH.other;
    lines.push(
      `| ${category} | ${round(value.chars)} | ${round(value.tokens)} | ${pct(value.tokens, result.billedTokens)} | ${mark(reach.hook)} | ${mark(reach.proxy)} |`,
    );
  }
  lines.push('');

  lines.push('## Reachable mass by side', '');
  lines.push('| side | est. tokens | share of billed input |');
  lines.push('|---|---|---|');
  for (const side of ['hook', 'proxy', 'both']) {
    lines.push(`| ${side} | ${round(result.bySide[side].tokens)} | ${pct(result.bySide[side].tokens, result.billedTokens)} |`);
  }
  lines.push('');
  lines.push('Only unqualified reach counts here. `~` (indirect) and `unsafe` are');
  lines.push('excluded: a hook that can only act before a tool call runs cannot');
  lines.push('address that result when it is replayed on every later turn, and');
  lines.push('signed thinking cannot be rewritten at all without the turn being');
  lines.push('rejected.', '');

  lines.push('## What each category means for a transform', '');
  for (const [category] of sorted) {
    const reach = REACH[category] ?? REACH.other;
    lines.push(`- **${category}** — ${reach.note}`);
  }
  return `${lines.join('\n')}\n`;
}

const mark = (value) => (value === true ? 'yes' : value === false ? 'no' : `~ (${value})`);

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
  const jsonIndex = args.indexOf('--json');
  const pathIndex = args.indexOf('--proxy');
  const path = pathIndex === -1 ? 'research/captures/proxy.jsonl' : args[pathIndex + 1];
  const result = analyze(readJsonl(path));
  process.stdout.write(jsonIndex === -1 ? renderReach(result) : `${JSON.stringify(result, null, 2)}\n`);
}
