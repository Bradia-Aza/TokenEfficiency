// RQ2's instrument. It attributes input-token mass to the content that carried
// it and marks which interception point can address that content — the analysis
// that ranks the two sides by savings opportunity rather than by field count.
//
// It is tested against the real fixture corpus, through the real adapter, so a
// change to the canonical model that moves content between categories shows up
// here rather than silently skewing the finding.
//
// This tests the rig, not the gateway. Deleting research/ deletes this too.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { adapter } from '../adapters/anthropic.js';
import { REACH, analyze, apportion, attributeRequest, renderReach } from '../research/analyze/reach.js';

const fixture = (name) =>
  adapter.requestToCanonical(JSON.parse(readFileSync(`test/fixtures/${name}.json`, 'utf8')));

test('attributes each kind of content to its own category', () => {
  // The multi-tool fixture is the one that exercises most categories at once.
  const chars = attributeRequest(fixture('request-tools-multi-call'));
  for (const category of ['tools', 'user-text', 'assistant', 'tool-call', 'tool-result']) {
    assert.ok(chars[category] > 0, `expected mass in ${category}, got ${JSON.stringify(chars)}`);
  }
  // Nothing should land in `other` for a fully modeled request — that bucket is
  // for content the canonical model could not express, and treating modeled
  // content as unreachable would understate both sides.
  assert.equal(chars.other, undefined, 'a fully modeled request has no unattributed mass');
});

test('separates a user\'s text from replayed assistant text', () => {
  // Same block type, different meaning: one is what the user typed, the other
  // is history the model resends every turn. Only the split makes RQ2 useful.
  const chars = attributeRequest(fixture('request-system-blocks'));
  assert.ok(chars['user-text'] > 0);
  assert.ok(chars.assistant > 0);
  assert.notEqual(chars['user-text'], chars.assistant);
});

test('attributes thinking text and its signature, not the wrong field', () => {
  // The canonical block carries its text in `thinking`; reading `text` here
  // would silently report zero and hide the one category that cannot be touched.
  const chars = attributeRequest(fixture('request-thinking'));
  assert.ok(chars.thinking > 0, 'thinking mass is counted');
  assert.equal(REACH.thinking.proxy, 'unsafe');
  assert.equal(REACH.thinking.hook, false);
});

test('counts a system prompt whether it is a string or a block list', () => {
  // The adapter models both spellings; the analysis must not see only one.
  assert.ok(attributeRequest(fixture('request-simple-text')).system > 0, 'string form');
  assert.ok(attributeRequest(fixture('request-system-blocks')).system > 0, 'block form');
});

test('apportions billed tokens across categories in proportion to characters', () => {
  const chars = { 'tool-result': 900, system: 100 };
  const { categories, billedTokens } = apportion(chars, {
    inputTokens: 500,
    cacheReadTokens: 400,
    cacheWriteTokens: 100,
  });
  // Cache reads and writes are added back: canonical inputTokens excludes cache
  // reads, but that content is physically in the body and a transform that
  // shrinks it changes what gets cached.
  assert.equal(billedTokens, 1000);
  assert.equal(categories['tool-result'].tokens, 900);
  assert.equal(categories.system.tokens, 100);
});

test('reports zero rather than dividing by zero on an empty request', () => {
  const { categories, billedTokens } = apportion({}, null);
  assert.deepEqual(categories, {});
  assert.equal(billedTokens, 0);
});

test('rolls a capture up and splits reachable mass by side', () => {
  const body = JSON.parse(readFileSync('test/fixtures/request-tools-multi-call.json', 'utf8'));
  const rows = [
    {
      side: 'proxy',
      requestEncoding: 'utf8',
      requestBody: JSON.stringify(body),
      usage: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  ];
  const result = analyze(rows);
  assert.equal(result.requests, 1);
  assert.equal(result.billedTokens, 1000);

  // The proxy reaches strictly more than the hook side, and `both` is the
  // intersection — which is the ranking RQ2 exists to produce.
  assert.ok(result.bySide.proxy.tokens > result.bySide.hook.tokens);
  assert.ok(result.bySide.both.tokens <= result.bySide.hook.tokens);

  // tool-result mass is not counted as hook-reachable: `indirect` is excluded,
  // because a hook cannot address that content once it is replayed history.
  assert.equal(REACH['tool-result'].hook, 'indirect');
  assert.equal(REACH['tool-result'].proxy, true);
});

test('counts unmodelable requests instead of silently dropping them', () => {
  const rows = [
    { side: 'proxy', requestEncoding: 'utf8', requestBody: 'not json', usage: null },
    { side: 'proxy', requestEncoding: 'utf8', requestBody: JSON.stringify({ nonsense: true }), usage: null },
  ];
  const result = analyze(rows);
  // Invariant 2 content is forwarded byte-for-byte and is reachable by nobody;
  // it has to be visible in the denominator discussion rather than vanish.
  assert.ok(result.unmodeled >= 1);
});

test('renders a report stating the apportionment is an estimate', () => {
  const body = JSON.parse(readFileSync('test/fixtures/request-tools-multi-call.json', 'utf8'));
  const report = renderReach(
    analyze([
      {
        side: 'proxy',
        requestEncoding: 'utf8',
        requestBody: JSON.stringify(body),
        usage: { inputTokens: 1000 },
      },
    ]),
  );
  assert.match(report, /Reachability \(RQ2\)/);
  assert.match(report, /apportioned from character mass/);
  assert.match(report, /tool-result/);
  assert.match(report, /Reachable mass by side/);
});
