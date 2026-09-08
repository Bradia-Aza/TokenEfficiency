import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createStreamAccumulator,
  requestFromCanonical,
  requestToCanonical,
  responseFromCanonical,
  responseToCanonical,
  streamBytesToCanonical,
} from '../adapters/openai.js';
import { createSseDecoder } from '../adapters/sse.js';
import { BLOCK, MEDIA_SOURCE, REASONING_EFFORT, ROLE, STOP_REASON, TOOL_CHOICE, TOOL_KIND } from '../canonical/index.js';
import { assertCanonicalShape, assertRoundTrip, loadFixtures, makeNormalizer } from './fixture-harness.js';

const { requests, responses, streams } = loadFixtures('openai');
const find = (list, name) => {
  const found = list.find((f) => f.name === name);
  assert.ok(found, `fixture ${name} is missing`);
  return found;
};

// ---------------------------------------------------------------------------
// OpenAI's own semantic-equivalence list (invariant 8) — separate from
// Anthropic's. `content: "text"` is sugar for the parts-array form on both
// message content and the split-out leading system/developer message; nothing
// else on this adapter's surface has an OpenAI spelling equivalence.
// ---------------------------------------------------------------------------

const { assertSemanticEqual } = makeNormalizer({ stringSugarFields: ['content'] });

// ---------------------------------------------------------------------------
// The Phase 2 exit criterion, asserted over the whole OpenAI corpus.
// ---------------------------------------------------------------------------

for (const fixture of requests) {
  test(`round trip: openai/${fixture.name}`, () => {
    assertRoundTrip({
      ...fixture,
      kind: 'request',
      toCanonical: requestToCanonical,
      fromCanonical: requestFromCanonical,
      assertEqual: assertSemanticEqual,
    });
  });
}

for (const fixture of responses) {
  test(`round trip: openai/${fixture.name}`, () => {
    assertRoundTrip({
      ...fixture,
      kind: 'response',
      toCanonical: responseToCanonical,
      fromCanonical: responseFromCanonical,
      assertEqual: assertSemanticEqual,
    });
  });
}

// ---------------------------------------------------------------------------
// Canonical shape: the mapping is what it claims to be, not just reversible.
// ---------------------------------------------------------------------------

test('a leading system message becomes request.system; a mid-thread one stays ROLE.SYSTEM', () => {
  const canonical = requestToCanonical(find(requests, 'request-system-blocks').body);

  assert.deepEqual(
    canonical.system.map((b) => b.text),
    ['Answer in the style of a terse assistant.'],
  );
  assert.equal(canonical.messages[0].role, ROLE.USER);
  assert.equal(canonical.messages[1].role, ROLE.ASSISTANT);
  // The second developer message, mid-thread, is not folded into request.system.
  assert.equal(canonical.messages[2].role, ROLE.SYSTEM);
  assert.equal(canonical.messages[2].content[0].text, 'Remember: no more than two sentences.');
  assert.equal(canonical.messages[3].role, ROLE.USER);

  assert.equal(canonical.userId, 'user_xyz');
  assert.deepEqual(canonical.params.reasoning, { enabled: true, effort: 'medium', budgetTokens: null, raw: null });
});

test('tool calls and their results correlate through canonical ids, and a tool message becomes a user turn', () => {
  const canonical = requestToCanonical(find(requests, 'request-tools-multi-call').body);
  const [call1, call2] = canonical.messages[1].content;
  const [resultMsg1, resultMsg2] = [canonical.messages[2], canonical.messages[3]];

  assert.equal(call1.type, BLOCK.TOOL_CALL);
  assert.equal(call1.name, 'read_file');
  assert.deepEqual(call1.input, { path: 'index.js' });

  // A `{role:"tool"}` message is not a role in canonical — it becomes a
  // ROLE.USER message wrapping one toolResultBlock, per Phase 0 decisions.
  assert.equal(resultMsg1.role, ROLE.USER);
  const [result1] = resultMsg1.content;
  assert.equal(result1.type, BLOCK.TOOL_RESULT);
  assert.equal(result1.callId, call1.id);
  assert.equal(result1.name, 'read_file', 'the tool name is resolved from the call list, not left null');
  assert.deepEqual(
    result1.content.map((b) => b.text),
    ['export const x = 1;'],
  );

  const [result2] = resultMsg2.content;
  assert.equal(result2.callId, call2.id);
  assert.equal(result2.name, 'run_tests');
});

test('tool definitions expose their schema without a trip through raw', () => {
  const canonical = requestToCanonical(find(requests, 'request-tools-multi-call').body);
  const [readFile, runTests] = canonical.tools;

  assert.equal(readFile.description, 'Read a file from disk.');
  assert.equal(readFile.parameters.properties.path.type, 'string');
  assert.equal(readFile.raw, null);
  assert.equal(readFile.kind, TOOL_KIND.FUNCTION);
  assert.equal(runTests.name, 'run_tests');

  // parallel_tool_calls is request-level on the wire; canonical's home for it
  // is toolChoice.allowParallel, the same field Anthropic's
  // disable_parallel_tool_use populates.
  assert.deepEqual(canonical.toolChoice, { mode: TOOL_CHOICE.AUTO, names: null, allowParallel: true, raw: null });
});

test('a forced tool choice round-trips through the function-name shape', () => {
  const canonical = requestToCanonical(find(requests, 'request-tool-choice-forced').body);
  assert.equal(canonical.toolChoice.mode, TOOL_CHOICE.TOOL);
  assert.deepEqual(canonical.toolChoice.names, ['read_file']);
  assert.deepEqual(canonical.params.reasoning, { enabled: true, effort: 'high', budgetTokens: null, raw: null });
});

test('tool call arguments are a JSON string on the wire and an object in canonical', () => {
  const canonical = responseToCanonical(find(responses, 'response-tool-calls').body);
  const [, call1, call2] = canonical.content;
  assert.equal(call1.type, BLOCK.TOOL_CALL);
  assert.deepEqual(call1.input, { path: 'index.js' });
  assert.deepEqual(call2.input, { path: 'config/index.js' });

  // The exact wire string is preserved, so fromCanonical is byte-identical
  // rather than a re-serialization of JSON.parse(arguments).
  const rebuilt = responseFromCanonical(canonical);
  assert.equal(rebuilt.choices[0].message.tool_calls[0].function.arguments, '{"path": "index.js"}');
});

test('an image_url data: URL and an http(s) URL are two different media sources', () => {
  const canonical = requestToCanonical(find(requests, 'request-image').body);
  const [base64, url] = canonical.messages[0].content;

  assert.equal(base64.type, BLOCK.MEDIA);
  assert.equal(base64.source.kind, MEDIA_SOURCE.BASE64);
  assert.equal(base64.source.mediaType, 'image/png');
  assert.equal(base64.source.data, 'iVBORw0KGgoAAAANSUhEUg==');

  assert.equal(url.source.kind, MEDIA_SOURCE.URL);
  assert.equal(url.source.url, 'https://example.test/diagram.png');
});

test('a provider-executed tool call has no schema and is not TOOL_KIND.FUNCTION', () => {
  const canonical = requestToCanonical(find(requests, 'request-unmodeled').body);
  const [, assistantMsg] = canonical.messages;
  const [call] = assistantMsg.content;
  assert.equal(call.type, BLOCK.TOOL_CALL);
  assert.equal(call.kind, TOOL_KIND.PROVIDER, 'a web_search tool_call type is provider-executed, not a function call');

  assert.equal(canonical.raw.seed, 42);
  assert.equal(canonical.raw.logprobs, true);
  assert.equal(canonical.userId, 'user_xyz');
});

test('the simple case needs no raw at all beyond bookkeeping the leading role', () => {
  const request = requestToCanonical(find(requests, 'request-simple-text').body);
  assert.deepEqual(request.raw, { leadingSystemRole: 'system' });
  assert.equal(request.messages[0].raw, null);
  assert.equal(request.stream, false);
  assert.equal(request.params.maxOutputTokens, 1024);

  const response = responseToCanonical(find(responses, 'response-simple-text').body);
  assert.equal(response.raw, null);
});

test('usage is derived per NEUTRALITY.md: prompt tokens exclude cache reads, completion tokens include reasoning', () => {
  const canonical = responseToCanonical(find(responses, 'response-tool-calls').body);
  assert.equal(canonical.stopReason, STOP_REASON.TOOL_CALL);
  // prompt_tokens (1204) - cached_tokens (1024) = 180
  assert.equal(canonical.usage.inputTokens, 180);
  assert.equal(canonical.usage.cacheReadTokens, 1024);
  assert.equal(canonical.usage.cacheWriteTokens, null, 'implicit caching writes nothing billable, and null is not zero');
  assert.equal(canonical.usage.outputTokens, 96);
  assert.equal(canonical.usage.totalTokens, 1300);

  const reasoning = responseToCanonical(find(responses, 'response-reasoning').body);
  assert.equal(reasoning.usage.reasoningTokens, 256);
  assert.equal(reasoning.usage.outputTokens, 320, 'outputTokens already includes the reasoning share');
});

test('finish_reason maps onto the canonical stop reasons', () => {
  assert.equal(responseToCanonical(find(responses, 'response-max-tokens').body).stopReason, STOP_REASON.MAX_TOKENS);
  assert.equal(
    responseToCanonical(find(responses, 'response-content-filter').body).stopReason,
    STOP_REASON.CONTENT_FILTER,
  );
});

test('an error envelope becomes a canonical response with no content', () => {
  const canonical = responseToCanonical(find(responses, 'response-error').body);
  assert.deepEqual(canonical.content, []);
  assert.equal(canonical.usage, null);
  assert.equal(canonical.error.type, 'rate_limit_error');
  assert.match(canonical.error.message, /per-minute rate limit/);
  assert.equal(canonical.error.raw.code, 'rate_limit_exceeded');
});

// ---------------------------------------------------------------------------
// Failure surfaces
// ---------------------------------------------------------------------------

test('malformed bodies throw for the caller to catch, never silently half-map', () => {
  assert.throws(() => requestToCanonical(null), TypeError);
  assert.throws(() => requestToCanonical({ model: 'gpt-5' }), TypeError, 'messages must be an array');
  assert.throws(() => responseToCanonical([]), TypeError);
});

test('a request missing everything optional still maps', () => {
  const canonical = requestToCanonical({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(requestFromCanonical(canonical), {
    model: 'gpt-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  });
});

// ---------------------------------------------------------------------------
// Streaming — the Phase 3 exit criterion: streamToCanonical over the OpenAI
// stream fixtures produces canonical objects deep-equal to the non-streamed
// equivalent of the same turn, and a no-usage stream yields null counters.
// ---------------------------------------------------------------------------

for (const fixture of streams.filter((f) => f.expected !== null)) {
  test(`round trip: openai/${fixture.name}`, () => {
    const canonical = streamBytesToCanonical(fixture.sse);
    assertCanonicalShape(canonical, 'response', fixture.name);
    // The stronger claim: streamed and unstreamed produce the *same* canonical
    // object, so a plugin cannot tell which one it is looking at — exactly the
    // discipline the Anthropic accumulator already holds itself to.
    assert.deepEqual(canonical, responseToCanonical(fixture.expected));
  });
}

test('OpenAI has no block lifecycle: text has no index, tool call fragments are keyed by tool_calls[].index', () => {
  const canonical = streamBytesToCanonical(find(streams, 'stream-tool-call').sse);
  const [text, call] = canonical.content;
  assert.equal(text.type, BLOCK.TEXT);
  assert.equal(text.text, 'Reading it.');
  assert.equal(call.type, BLOCK.TOOL_CALL);
  assert.deepEqual(call.input, { path: 'index.js' }, 'argument fragments are concatenated before being parsed');
});

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
});

test('a stream with no stream_options.include_usage yields null usage, and a plugin reading it does not throw', () => {
  const canonical = streamBytesToCanonical(find(streams, 'stream-no-usage').sse);
  assert.equal(canonical.usage, null, 'the gateway never injects the flag to fix this — invariant 7');

  // The same read meter-tokens.js performs on every turn's usage.
  const usage = canonical.usage;
  const turn = {
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    reasoningTokens: usage?.reasoningTokens ?? null,
    cacheReadTokens: usage?.cacheReadTokens ?? null,
    cacheWriteTokens: usage?.cacheWriteTokens ?? null,
    totalTokens: usage?.totalTokens ?? null,
  };
  assert.deepEqual(turn, {
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
  });
});

test('the [DONE] sentinel is not JSON and does not confuse the accumulator', () => {
  const sse = find(streams, 'stream-simple-text').sse;
  assert.match(sse, /data: \[DONE\]/, 'the fixture actually exercises the sentinel');
  const canonical = streamBytesToCanonical(sse);
  assert.equal(canonical.content[0].text, 'Hello, world.');
  assert.equal(canonical.stopReason, STOP_REASON.END_TURN);
});

test('a stream that never starts still yields a usable canonical object', () => {
  const accumulator = createStreamAccumulator();
  accumulator.push({ error: { type: 'server_error', message: 'boom' } });
  const canonical = accumulator.result();
  assert.equal(canonical.id, null);
  assert.deepEqual(canonical.content, []);
  assert.equal(canonical.error.type, 'server_error');
});

test('an unparseable chunk is recorded as a warning, not fatal', () => {
  const accumulator = createStreamAccumulator();
  accumulator.push({ event: 'message', data: 'not json' });
  accumulator.push({
    object: 'chat.completion.chunk',
    id: 'chatcmpl-x',
    model: 'gpt-5',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  });
  const canonical = accumulator.result();
  assert.equal(canonical.content[0].text, 'ok');
  assert.match(accumulator.state().warnings[0], /unparseable stream chunk/);
});
