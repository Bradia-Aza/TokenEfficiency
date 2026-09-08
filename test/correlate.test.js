// The correlator is the Phase 0.2 gate: its match rate decides whether the
// interception study can ask "both". So it is tested against captures with
// known ground truth — an instrument that silently overcounts matches would
// answer the architectural question wrongly and nothing downstream would catch
// it.
//
// This tests the rig, not the gateway. Deleting research/ deletes this too.

import assert from 'node:assert/strict';
import test from 'node:test';
import { correlate, renderReport } from '../research/correlate.js';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const at = (offsetMs) => new Date(T0 + offsetMs).toISOString();

const hookEvent = ({ ms, tool = 'Bash', response, event = 'PostToolUse' }) => ({
  side: 'hook',
  at: at(ms),
  event,
  sessionId: 'hook-session',
  payload: { hook_event_name: event, session_id: 'hook-session', tool_name: tool, tool_response: response },
});

const proxyRequest = ({ ms, seq, body, path = '/v1/messages' }) => ({
  side: 'proxy',
  seq,
  at: at(ms),
  exchangeId: seq + 1,
  sessionId: 'proxy-session',
  path,
  status: 200,
  requestEncoding: 'utf8',
  requestBody: typeof body === 'string' ? body : JSON.stringify(body),
  requestSize: JSON.stringify(body).length,
});

/** A tool output long enough to fingerprint. */
const LONG_OUTPUT = 'total 48\ndrwxr-xr-x  12 user staff  384 Jan  1 00:00 .\n-rw-r--r--   1 user staff 1024 config.js\n';

test('matches tool output carried into a later request, json-escaped', () => {
  const hookRows = [hookEvent({ ms: 100, response: { stdout: LONG_OUTPUT } })];
  // The proxy carries it inside a JSON string, so it arrives escaped. That is
  // the ordinary case and must count as a clean match.
  const proxyRows = [
    proxyRequest({ ms: 50, seq: 0, body: { messages: [{ role: 'user', content: 'ls' }] } }),
    proxyRequest({
      ms: 200,
      seq: 1,
      body: { messages: [{ role: 'user', content: [{ type: 'tool_result', content: LONG_OUTPUT }] }] },
    }),
  ];

  const result = correlate({ hookRows, proxyRows });
  assert.equal(result.totals.considered, 1);
  assert.equal(result.totals.matched, 1);
  assert.equal(result.totals.matchRate, 1);
  assert.equal(result.matches[0].form, 'json-escaped');
  // The request before the hook fired is not a candidate; the one after is,
  // and it is the first of them.
  assert.equal(result.matches[0].lag, 0);
  assert.equal(result.matches[0].requestSeq, 1);
  assert.equal(result.matches[0].lagMs, 100);
});

test('counts intervening requests as lag', () => {
  const hookRows = [hookEvent({ ms: 100, response: { stdout: LONG_OUTPUT } })];
  const proxyRows = [
    // Background traffic between the tool call and the turn that carries it —
    // title generation, compaction — is exactly what lag is measuring.
    proxyRequest({ ms: 120, seq: 0, body: { messages: [{ role: 'user', content: 'unrelated' }] } }),
    proxyRequest({ ms: 140, seq: 1, body: { messages: [{ role: 'user', content: 'also unrelated' }] } }),
    proxyRequest({ ms: 300, seq: 2, body: { messages: [{ role: 'user', content: LONG_OUTPUT }] } }),
  ];

  const result = correlate({ hookRows, proxyRows });
  assert.equal(result.matches[0].lag, 2);
  assert.equal(result.matches[0].requestSeq, 2);
});

test('records content that never reached the wire as unmatched, with a reason', () => {
  // The permission-denied case: the hook saw the tool call, the wire never did.
  const hookRows = [hookEvent({ ms: 100, response: { stdout: LONG_OUTPUT } })];
  const proxyRows = [proxyRequest({ ms: 200, seq: 0, body: { messages: [{ role: 'user', content: 'something else' }] } })];

  const result = correlate({ hookRows, proxyRows });
  assert.equal(result.totals.matched, 0);
  assert.equal(result.totals.unmatched, 1);
  assert.equal(result.totals.matchRate, 0);
  assert.match(result.unmatched[0].reason, /not found in any proxy request/);
});

test('distinguishes content that only appears before the hook fired', () => {
  // A different failure from "never appeared": clock skew or replayed history.
  const hookRows = [hookEvent({ ms: 500, response: { stdout: LONG_OUTPUT } })];
  const proxyRows = [proxyRequest({ ms: 100, seq: 0, body: { messages: [{ role: 'user', content: LONG_OUTPUT }] } })];

  const result = correlate({ hookRows, proxyRows });
  assert.equal(result.totals.unmatched, 1);
  assert.match(result.unmatched[0].reason, /predates the hook firing/);
});

test('flags truncated content as a partial match rather than a clean one', () => {
  const big = `${'A'.repeat(400)}${'B'.repeat(400)}`;
  const hookRows = [hookEvent({ ms: 100, response: { stdout: big } })];
  // Only the first half survives to the wire — the client truncated it. A
  // hook-level transform cannot guarantee the bytes it saw are the bytes sent.
  const proxyRows = [proxyRequest({ ms: 200, seq: 0, body: { messages: [{ role: 'user', content: big.slice(0, 400) }] } })];

  const result = correlate({ hookRows, proxyRows });
  assert.equal(result.totals.matched, 1);
  assert.equal(result.matches[0].form, 'partial');
  assert.ok(result.matches[0].survivingFraction < 1);
});

test('skips outputs too short to fingerprint instead of counting them', () => {
  // "ok" would match half the corpus by coincidence. Counting it either way
  // would corrupt the rate the architectural decision rests on.
  const hookRows = [
    hookEvent({ ms: 100, response: { stdout: 'ok' } }),
    hookEvent({ ms: 110, response: null }),
  ];
  const proxyRows = [proxyRequest({ ms: 200, seq: 0, body: { messages: [{ role: 'user', content: 'ok' }] } })];

  const result = correlate({ hookRows, proxyRows });
  assert.equal(result.totals.considered, 0);
  assert.equal(result.totals.skipped, 2);
  assert.equal(result.totals.matchRate, null, 'no rate is reported when nothing could be considered');
  assert.match(result.skipped[0].reason, /fingerprint floor/);
  assert.match(result.skipped[1].reason, /no readable tool output/);
});

test('reads tool output from the several shapes tool_response takes', () => {
  const content = LONG_OUTPUT;
  const shapes = [
    { stdout: content },
    { content },
    { file: { content } },
    content,
  ];
  for (const response of shapes) {
    const result = correlate({
      hookRows: [hookEvent({ ms: 100, response })],
      proxyRows: [proxyRequest({ ms: 200, seq: 0, body: { messages: [{ role: 'user', content }] } })],
    });
    assert.equal(result.totals.matched, 1, `shape ${JSON.stringify(response).slice(0, 40)} should match`);
  }
});

test('ignores non-tool hook events', () => {
  const hookRows = [
    { side: 'hook', at: at(10), event: 'SessionStart', sessionId: 's', payload: { hook_event_name: 'SessionStart' } },
    { side: 'hook', at: at(20), event: 'UserPromptSubmit', sessionId: 's', payload: { hook_event_name: 'UserPromptSubmit', prompt: LONG_OUTPUT } },
  ];
  const result = correlate({ hookRows, proxyRows: [] });
  assert.equal(result.totals.hookEvents, 0);
});

test('renders a report that states the match rate and itemizes failures', () => {
  const hookRows = [
    hookEvent({ ms: 100, response: { stdout: LONG_OUTPUT } }),
    hookEvent({ ms: 300, tool: 'Read', response: { stdout: 'never sent, and long enough to fingerprint properly' } }),
  ];
  const proxyRows = [proxyRequest({ ms: 200, seq: 0, body: { messages: [{ role: 'user', content: LONG_OUTPUT }] } })];

  const report = renderReport(correlate({ hookRows, proxyRows }));
  assert.match(report, /match rate: 50\.0%/);
  assert.match(report, /Unmatched, itemized/);
  assert.match(report, /Read/);
});
