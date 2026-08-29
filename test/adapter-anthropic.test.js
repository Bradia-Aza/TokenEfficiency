import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createStreamAccumulator,
  requestFromCanonical,
  requestToCanonical,
  responseFromCanonical,
  responseToCanonical,
  streamBytesToCanonical,
} from '../adapters/anthropic.js';
import { createSseDecoder } from '../adapters/sse.js';
import { BLOCK, MEDIA_SOURCE, RESPONSE_FORMAT, ROLE, STOP_REASON, TOOL_CHOICE, TOOL_KIND } from '../canonical/index.js';
import { assertCanonicalShape, assertRoundTrip, assertSemanticEqual, loadFixtures } from './fixture-harness.js';

const { requests, responses, streams } = loadFixtures();
const find = (list, name) => {
  const found = list.find((f) => f.name === name);
  assert.ok(found, `fixture ${name} is missing`);
  return found;
};

// ---------------------------------------------------------------------------
// The Phase 2 exit criterion, asserted over the whole corpus.
// ---------------------------------------------------------------------------

for (const fixture of requests) {
  test(`round trip: ${fixture.name}`, () => {
    assertRoundTrip({
      ...fixture,
      kind: 'request',
      toCanonical: requestToCanonical,
      fromCanonical: requestFromCanonical,
    });
  });
}

for (const fixture of responses) {
  test(`round trip: ${fixture.name}`, () => {
    assertRoundTrip({
      ...fixture,
      kind: 'response',
      toCanonical: responseToCanonical,
      fromCanonical: responseFromCanonical,
    });
  });
}

for (const fixture of streams.filter((f) => f.expected !== null)) {
  test(`round trip: ${fixture.name}`, () => {
    const canonical = streamBytesToCanonical(fixture.sse);
    assertCanonicalShape(canonical, 'response', fixture.name);
    assertSemanticEqual(
      responseFromCanonical(canonical),
      fixture.expected,
      `${fixture.name}: accumulated stream does not rebuild the message it described`,
    );
    // The stronger claim: streamed and unstreamed produce the *same* canonical
    // object, so a plugin cannot tell which one it is looking at.
    assert.deepEqual(canonical, responseToCanonical(fixture.expected));
  });
}

// ---------------------------------------------------------------------------
// Canonical shape: the mapping is what it claims to be, not just reversible.
// ---------------------------------------------------------------------------

test('tool calls and their results correlate through canonical ids', () => {
  const canonical = requestToCanonical(find(requests, 'request-tools-multi-call').body);
  const [call1, call2] = canonical.messages[1].content.filter((b) => b.type === BLOCK.TOOL_CALL);
  const [result1, result2] = canonical.messages[2].content;

  assert.equal(call1.name, 'read_file');
  assert.deepEqual(call1.input, { path: 'index.js' });
  assert.equal(result1.type, BLOCK.TOOL_RESULT);
  assert.equal(result1.callId, call1.id);
  assert.equal(result2.callId, call2.id);
  assert.equal(result1.isError, false);
  assert.equal(result2.isError, true);
  // The string shorthand becomes a real block list, so plugins read one shape.
  assert.deepEqual(
    result2.content.map((b) => b.text),
    ['1 test failed'],
  );
});

test('tool definitions expose their schema without a trip through raw', () => {
  const canonical = requestToCanonical(find(requests, 'request-tools-multi-call').body);
  const [readFile, , webSearch] = canonical.tools;

  assert.equal(readFile.description, 'Read a file from disk.');
  assert.equal(readFile.parameters.properties.path.type, 'string');
  assert.equal(readFile.raw, null);
  assert.equal(readFile.kind, TOOL_KIND.FUNCTION);
  // A provider-executed tool has no client schema. `kind` is what says the
  // missing schema is expected rather than lost — and what tells a later
  // transform that the result of such a call is not its business.
  assert.equal(webSearch.kind, TOOL_KIND.PROVIDER);
  assert.equal(webSearch.parameters, null);
  assert.equal(webSearch.raw.type, 'web_search_20250305');

  assert.deepEqual(canonical.toolChoice, {
    mode: TOOL_CHOICE.AUTO,
    // A list, because Gemini restricts the choice to a set of names rather than
    // to one.
    names: null,
    // Canonical states the permission; `disable_parallel_tool_use` is Anthropic's
    // double negative, not a capability of its own.
    allowParallel: true,
    raw: null,
  });
});

test('thinking blocks keep their signature; redacted reasoning keeps only its blob', () => {
  const canonical = requestToCanonical(find(requests, 'request-thinking').body);
  const [thinking, redacted, text] = canonical.messages[1].content;

  assert.equal(thinking.type, BLOCK.THINKING);
  assert.equal(thinking.redacted, false);
  assert.equal(thinking.signature, 'ErUBCkYIBBgCIkDdT1n8');
  assert.equal(redacted.type, BLOCK.THINKING);
  assert.equal(redacted.redacted, true);
  assert.equal(redacted.thinking, '', 'redacted reasoning has no readable text');
  assert.equal(redacted.raw.data, 'EroBCkYIBBgCIkAdQm9ndXM=');
  assert.equal(text.type, BLOCK.TEXT);

  // `effort` is null, not absent: Anthropic spends reasoning by budget, OpenAI
  // by an effort ordinal, and neither converts into the other.
  assert.deepEqual(canonical.params.reasoning, { enabled: true, effort: null, budgetTokens: 10000, raw: null });
  assert.equal(canonical.toolChoice.mode, TOOL_CHOICE.TOOL);
  assert.deepEqual(canonical.toolChoice.names, ['read_file']);
  assert.equal(canonical.toolChoice.allowParallel, false);
});

test('attachments normalize every carrier into one media shape', () => {
  const canonical = requestToCanonical(find(requests, 'request-image').body);
  const [base64, url] = canonical.messages[0].content;

  assert.equal(base64.type, BLOCK.MEDIA);
  assert.deepEqual(base64.source, {
    kind: MEDIA_SOURCE.BASE64,
    mediaType: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUg==',
    url: null,
    id: null,
  });
  assert.deepEqual(url.source, {
    kind: MEDIA_SOURCE.URL,
    mediaType: null,
    data: null,
    url: 'https://example.test/diagram.png',
    id: null,
  });
  // The cache breakpoint is modeled; only the wire spelling of the block stays
  // in raw, and `source.mediaType` is what a plugin reads instead.
  assert.deepEqual(url.cache, { ttlSeconds: null, raw: null });
  assert.deepEqual(url.raw, { type: 'image' });

  // A document is the same block: Anthropic has two spellings, Gemini carries
  // every attachment through one part keyed by mime type.
  const cached = requestToCanonical(find(requests, 'request-cached-tools').body);
  const [spec] = cached.messages[0].content;
  assert.equal(spec.type, BLOCK.MEDIA);
  assert.equal(spec.source.kind, MEDIA_SOURCE.ID);
  assert.equal(spec.source.id, 'file_011CQx');
});

test('unmodeled blocks and fields are carried whole rather than guessed at', () => {
  const fixture = find(requests, 'request-unmodeled').body;
  const canonical = requestToCanonical(fixture);

  // The provider-executed search and its result are modeled; the search hits
  // inside the result are a shape this model has no opinion about, so they are
  // carried whole.
  const [call, result] = canonical.messages[1].content;
  assert.equal(call.kind, TOOL_KIND.PROVIDER);
  assert.equal(result.kind, TOOL_KIND.PROVIDER);
  const [hit] = result.content;
  assert.equal(hit.type, BLOCK.UNKNOWN);
  assert.deepEqual(hit.raw, fixture.messages[1].content[1].content[0]);

  assert.equal(canonical.raw.service_tier, 'standard_only');
  assert.deepEqual(canonical.raw.mcp_servers, fixture.mcp_servers);
  // user_id is modeled; the rest of metadata is surplus.
  assert.equal(canonical.userId, 'user_xyz');
  assert.deepEqual(canonical.raw.metadata, { trace_id: 'trace_9' });
});

test('the simple cases need no raw at all', () => {
  const request = requestToCanonical(find(requests, 'request-simple-text').body);
  assert.equal(request.raw, null);
  assert.equal(request.messages[0].raw, null);
  assert.equal(request.messages[0].content[0].raw, null);
  assert.equal(request.stream, false);
  assert.equal(request.params.maxOutputTokens, 1024);
  // A bare string system prompt becomes a block list, kept off the message list.
  assert.deepEqual(
    request.system.map((b) => b.text),
    ['You are a terse assistant.'],
  );

  const response = responseToCanonical(find(responses, 'response-simple-text').body);
  assert.equal(response.raw, null);
  assert.equal(response.usage.raw, null);
});

test('usage is metered from canonical, cache reads and writes included', () => {
  const canonical = responseToCanonical(find(responses, 'response-tool-calls').body);
  assert.equal(canonical.stopReason, STOP_REASON.TOOL_CALL);
  assert.equal(canonical.role, ROLE.ASSISTANT);
  assert.equal(canonical.usage.inputTokens, 1204);
  assert.equal(canonical.usage.outputTokens, 96);
  assert.equal(canonical.usage.cacheReadTokens, 20480);
  assert.equal(canonical.usage.cacheWriteTokens, 812);
  // The per-TTL breakdown is provider surplus; the four numbers a meter needs
  // are all modeled.
  assert.equal(canonical.usage.raw.service_tier, 'standard');
});

test('a stop reason with no canonical equivalent degrades without vanishing', () => {
  const fixture = find(responses, 'response-pause-turn').body;
  const canonical = responseToCanonical(fixture);
  assert.equal(canonical.stopReason, STOP_REASON.OTHER, 'a plugin still learns the turn ended');
  assert.equal(canonical.raw.stop_reason, 'pause_turn', 'the adapter can still put it back');
  assert.equal(responseFromCanonical(canonical).stop_reason, 'pause_turn');
});

test('an error envelope becomes a canonical response with no content', () => {
  const canonical = responseToCanonical(find(responses, 'response-error').body);
  assert.deepEqual(canonical.content, []);
  assert.equal(canonical.stopReason, null);
  assert.equal(canonical.usage, null);
  assert.equal(canonical.error.type, 'rate_limit_error');
  assert.match(canonical.error.message, /per-minute rate limit/);
  assert.equal(canonical.raw.request_id, 'req_011CQx7fVn');
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

test('accumulation is independent of chunk boundaries', () => {
  const fixture = find(streams, 'stream-tool-call');
  const decoder = createSseDecoder();
  const accumulator = createStreamAccumulator();
  // Slice the stream at arbitrary offsets, mid-JSON and mid-line.
  for (let i = 0; i < fixture.sse.length; i += 7) {
    for (const record of decoder.push(fixture.sse.slice(i, i + 7))) accumulator.push(record);
  }
  for (const record of decoder.flush()) accumulator.push(record);

  assert.deepEqual(accumulator.result(), streamBytesToCanonical(fixture.sse));
  assert.deepEqual(accumulator.state(), { complete: true, stopped: true, failed: false, warnings: [] });
});

test('tool input arrives as JSON fragments and lands as an object', () => {
  const canonical = streamBytesToCanonical(find(streams, 'stream-tool-call').sse);
  const call = canonical.content.find((b) => b.type === BLOCK.TOOL_CALL);
  assert.deepEqual(call.input, { path: 'index.js' });
  assert.equal(canonical.usage.outputTokens, 96, 'message_delta usage replaces the message_start estimate');
  assert.equal(canonical.usage.cacheReadTokens, 20480, 'message_start usage is not lost');
});

test('a stream that fails mid-block keeps the partial turn and records the error', () => {
  const fixture = find(streams, 'stream-error-midstream');
  const accumulator = createStreamAccumulator();
  const decoder = createSseDecoder();
  for (const record of decoder.push(fixture.sse)) accumulator.push(record);
  for (const record of decoder.flush()) accumulator.push(record);
  const canonical = accumulator.result();

  assert.equal(canonical.id, 'msg_04StreamCut');
  assert.deepEqual(
    canonical.content.map((b) => b.text),
    ['Starting the ans'],
    'text that arrived before the failure is kept',
  );
  assert.equal(canonical.stopReason, null, 'the turn never reported a stop reason');
  assert.equal(canonical.error.type, 'overloaded_error');
  assert.deepEqual(accumulator.state(), {
    complete: false,
    stopped: false,
    failed: true,
    warnings: [],
  });
});

test('a stream that never starts still yields a usable canonical object', () => {
  const accumulator = createStreamAccumulator();
  accumulator.push({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
  const canonical = accumulator.result();
  assert.equal(canonical.id, null);
  assert.deepEqual(canonical.content, []);
  assert.equal(canonical.error.type, 'overloaded_error');
  assert.deepEqual(responseFromCanonical(canonical), {
    type: 'error',
    error: { type: 'overloaded_error', message: 'Overloaded' },
  });
});

test('unknown stream events are recorded, not fatal', () => {
  const accumulator = createStreamAccumulator();
  accumulator.push({ type: 'message_start', message: { id: 'msg_x', role: 'assistant', content: [] } });
  accumulator.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  accumulator.push({ type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: {} } });
  accumulator.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } });
  accumulator.push({ type: 'future_event_type', payload: 1 });
  accumulator.push({ type: 'content_block_stop', index: 0 });
  accumulator.push({ type: 'message_stop' });

  const canonical = accumulator.result();
  assert.deepEqual(
    canonical.content.map((b) => b.text),
    ['ok'],
  );
  assert.deepEqual(accumulator.state().warnings, [
    'unknown delta type "citations_delta"',
    'unknown stream event "future_event_type"',
  ]);
});

test('truncated tool arguments are kept as a fragment, never invented', () => {
  const accumulator = createStreamAccumulator();
  accumulator.push({ type: 'message_start', message: { id: 'msg_y', role: 'assistant', content: [] } });
  accumulator.push({
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} },
  });
  accumulator.push({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"path": "ind' },
  });
  // No content_block_stop, no message_stop: the socket died here.
  const canonical = accumulator.result();
  const [call] = canonical.content;

  assert.deepEqual(call.input, {}, 'no half-parsed arguments leak into canonical input');
  assert.equal(call.raw.partial_json, '{"path": "ind');
  assert.equal(accumulator.state().complete, false);
  assert.match(accumulator.state().warnings[0], /unparseable tool input/);
});

// ---------------------------------------------------------------------------
// Failure surfaces
// ---------------------------------------------------------------------------

test('malformed bodies throw for the caller to catch, never silently half-map', () => {
  // Invariant 3 lives in the caller: the adapter's job is to be loud, and the
  // pipeline's job is to swallow it before the client can notice.
  assert.throws(() => requestToCanonical(null), TypeError);
  assert.throws(() => requestToCanonical('{"model"'), TypeError);
  assert.throws(() => responseToCanonical([]), TypeError);
});

test('a request missing everything optional still maps', () => {
  const canonical = requestToCanonical({ model: 'claude-opus-5', messages: [] });
  assert.deepEqual(requestFromCanonical(canonical), { model: 'claude-opus-5', messages: [] });
});
