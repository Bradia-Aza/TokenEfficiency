// Phase 5 — neutrality validation, without a second adapter.
//
// NEUTRALITY.md maps three fixtures field by field to and from the OpenAI and
// Gemini wire formats. A table rots. These are the claims that table makes,
// written so they fail if the model drifts back toward one provider's shape.
//
// Two kinds of assertion, matching the two ways the table can be wrong:
//
//   1. *Readable* — every fact an OpenAI or Gemini adapter would need to emit
//      is on the canonical object with `raw` stripped away. The exit criterion
//      is "no cell resolves to put it in `raw` for anything a plugin would
//      plausibly need to read", and `withoutRaw` is that sentence as code.
//   2. *Expressible* — the canonical factories can build the shapes those two
//      providers produce, using no adapter at all. That is the half a corpus of
//      Anthropic fixtures can never exercise, and it is where an
//      Anthropic-shaped model would show.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  requestToCanonical,
  responseToCanonical,
  streamBytesToCanonical,
} from '../adapters/anthropic.js';
import * as openai from '../adapters/openai.js';
import {
  BLOCK,
  MEDIA_SOURCE,
  REASONING_EFFORT,
  RESPONSE_FORMAT,
  ROLE,
  STOP_REASON,
  TOOL_CHOICE,
  TOOL_KIND,
  generationParams,
  jsonBlock,
  mediaBlock,
  message,
  reasoningConfig,
  request,
  textBlock,
  toolCallBlock,
  toolChoice,
  toolDefinition,
  toolResultBlock,
  usage,
} from '../canonical/index.js';
import { assertCanonicalShape, loadFixtures } from './fixture-harness.js';

const { requests, responses, streams } = loadFixtures();
const find = (list, name) => {
  const found = list.find((f) => f.name === name);
  assert.ok(found, `fixture ${name} is missing`);
  return found;
};

const openaiFixtures = loadFixtures('openai');

/**
 * The canonical object as a plugin is supposed to read it: `raw` belongs to the
 * adapter that produced it, so anything only reachable through `raw` is, for
 * this file's purposes, not modeled at all.
 */
function withoutRaw(value) {
  if (Array.isArray(value)) return value.map(withoutRaw);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'raw')
      .map(([key, inner]) => [key, withoutRaw(inner)]),
  );
}

// The three fixtures the table maps, plus the streamed twin of the third.
const systemBlocks = withoutRaw(requestToCanonical(find(requests, 'request-system-blocks').body));
const toolsMultiCall = withoutRaw(requestToCanonical(find(requests, 'request-tools-multi-call').body));
const toolCallsResponse = withoutRaw(responseToCanonical(find(responses, 'response-tool-calls').body));

// ---------------------------------------------------------------------------
// 1. Readable without `raw`
// ---------------------------------------------------------------------------

test('system-prompt placement survives without raw', () => {
  // Anthropic: top-level `system`. OpenAI: a leading `system`/`developer`
  // message. Gemini: `systemInstruction`. Three placements, one field — and it
  // is not a message, so no adapter has to decide whether turn 1 is a turn.
  assert.deepEqual(
    systemBlocks.system.map((block) => block.text),
    ["You are Claude Code, Anthropic's official CLI.", '<project-context>a long, cached preamble</project-context>'],
  );
  assert.deepEqual(
    systemBlocks.messages.map((m) => m.role),
    [ROLE.USER, ROLE.ASSISTANT],
    'the system prompt is not smuggled into the message list',
  );
  // OpenAI `user`; Gemini has no equivalent and drops it.
  assert.equal(systemBlocks.userId, 'user_abc123');
  assert.equal(systemBlocks.stream, true);
  assert.equal(systemBlocks.params.maxOutputTokens, 4096, 'OpenAI max_completion_tokens / Gemini maxOutputTokens');
  assert.equal(systemBlocks.params.temperature, 0, 'zero is a value, not an absence');
});

test('the cache breakpoint is readable, not buried in raw', () => {
  // The one request-side control that decides whether the prompt bills as a
  // cache write or a cache read. A meter that cannot see it cannot attribute
  // the number it does see.
  const [plain, cached] = systemBlocks.system;
  assert.equal(plain.cache, null);
  assert.deepEqual(cached.cache, { ttlSeconds: null });

  const withTtl = withoutRaw(requestToCanonical(find(requests, 'request-cached-tools').body));
  assert.deepEqual(withTtl.system[0].cache, { ttlSeconds: 3600 }, 'a requested lifetime is seconds, not "1h"');
  assert.deepEqual(withTtl.tools[0].cache, { ttlSeconds: 300 }, 'tools take breakpoints too');
});

test('tool definitions and the choice over them survive without raw', () => {
  const [readFile, runTests, webSearch] = toolsMultiCall.tools;

  // OpenAI `tools[].function.{name,description,parameters}`; Gemini
  // `tools[].functionDeclarations[]` — same three fields, one JSON Schema.
  assert.equal(readFile.name, 'read_file');
  assert.equal(readFile.description, 'Read a file from disk.');
  assert.equal(readFile.parameters.required[0], 'path');
  assert.equal(runTests.kind, TOOL_KIND.FUNCTION);
  // Gemini's built-ins are a bare `{ googleSearch: {} }`: no description, no
  // schema, and nothing but `kind` to say that is intended.
  assert.equal(webSearch.kind, TOOL_KIND.PROVIDER);
  assert.equal(webSearch.parameters, null);

  assert.equal(toolsMultiCall.toolChoice.mode, TOOL_CHOICE.AUTO);
  // OpenAI carries this at request level as `parallel_tool_calls`; canonical
  // states the permission rather than Anthropic's prohibition.
  assert.equal(toolsMultiCall.toolChoice.allowParallel, true);
  assert.deepEqual(toolsMultiCall.params.stopSequences, ['</done>'], 'OpenAI `stop` / Gemini `stopSequences`');
  assert.equal(toolsMultiCall.params.topK, 40, 'Gemini topK; OpenAI has no equivalent and drops it');
});

test('a tool result names its tool, so correlation works by id or by name', () => {
  const [call1, call2] = toolsMultiCall.messages[1].content.filter((b) => b.type === BLOCK.TOOL_CALL);
  const [result1, result2] = toolsMultiCall.messages[2].content;

  // Anthropic and OpenAI correlate by id. Gemini has no id at all — a
  // `functionResponse` carries only `name` — so an adapter emitting Gemini from
  // this object needs the name here, not five messages back.
  assert.equal(result1.callId, call1.id);
  assert.equal(result1.name, 'read_file');
  assert.equal(result2.callId, call2.id);
  assert.equal(result2.name, 'run_tests');
  assert.equal(result2.isError, true, 'Anthropic surplus, modeled; OpenAI and Gemini fold it into the payload');

  // OpenAI's `tool` message content is a string and Anthropic's may be; both
  // arrive as one block list, so a plugin reads a single shape.
  assert.deepEqual(result2.content.map((b) => b.type), [BLOCK.TEXT]);
});

test('a structured tool result stays structured', () => {
  // Gemini's `functionResponse.response` is required to be an object, so this
  // is not an edge case there — it is every tool result. Handing a plugin a
  // stringified blob to re-parse would be the model going text-only by
  // accident.
  const cached = withoutRaw(requestToCanonical(find(requests, 'request-cached-tools').body));
  const [, result] = cached.messages[1].content;
  assert.equal(result.kind, TOOL_KIND.PROVIDER, 'a provider-executed result is not a transform’s to rewrite');
  const [payload] = result.content;
  assert.equal(payload.type, BLOCK.JSON);
  assert.equal(payload.data.stdout, '2\n', 'read as a field, not re-parsed from text');
});

test('attachments are keyed by media type, not by being images', () => {
  const image = withoutRaw(requestToCanonical(find(requests, 'request-image').body));
  const [base64, url] = image.messages[0].content;
  assert.equal(base64.source.mediaType, 'image/png', 'Gemini inlineData.mimeType / OpenAI image_url');
  assert.equal(url.source.kind, MEDIA_SOURCE.URL, 'Gemini fileData.fileUri / OpenAI a URL image_url');

  const cached = withoutRaw(requestToCanonical(find(requests, 'request-cached-tools').body));
  const [spec] = cached.messages[0].content;
  assert.equal(spec.type, BLOCK.MEDIA, 'a PDF is the same block as an image, at a different mime type');
  assert.equal(spec.source.kind, MEDIA_SOURCE.ID, 'Anthropic file_id / OpenAI file_id / Gemini fileData');
});

test('stop reasons and usage survive without raw', () => {
  // Anthropic `tool_use`, OpenAI `tool_calls`, Gemini `STOP` plus the presence
  // of functionCall parts — three spellings, one canonical reason.
  assert.equal(toolCallsResponse.stopReason, STOP_REASON.TOOL_CALL);
  assert.equal(toolCallsResponse.stopSequence, null);

  // The definitions are the point. `inputTokens` excludes cache reads, so an
  // OpenAI or Gemini adapter subtracts rather than copying its own inclusive
  // prompt counter; `outputTokens` includes reasoning, so a Gemini adapter adds
  // `thoughtsTokenCount` back in.
  assert.deepEqual(toolCallsResponse.usage, {
    inputTokens: 1204,
    outputTokens: 96,
    cacheReadTokens: 20480,
    cacheWriteTokens: 812,
    // Anthropic reports neither, and null is not zero.
    reasoningTokens: null,
    totalTokens: null,
  });
});

test('streaming granularity never reaches the model', () => {
  // Anthropic frames a stream as indexed block deltas, OpenAI as choice deltas
  // with an implied index, Gemini as whole parts per chunk. None of that is a
  // difference a plugin should have to know, so the accumulator rebuilds the
  // turn and converts once.
  const streamed = streams.find((f) => f.name === 'stream-tool-call');
  const canonical = streamBytesToCanonical(streamed.sse);
  assertCanonicalShape(canonical, 'response', 'stream-tool-call');
  assert.deepEqual(
    withoutRaw(canonical),
    withoutRaw(responseToCanonical(streamed.expected)),
    'streamed and unstreamed are the same object',
  );
  // And the same accounting: usage arrives spread across message_start and
  // message_delta on one path and in a single object on the other.
  assert.deepEqual(withoutRaw(canonical).usage, toolCallsResponse.usage);
});

// ---------------------------------------------------------------------------
// 2. Expressible with no adapter in sight
// ---------------------------------------------------------------------------

test('an OpenAI thread with a mid-conversation system message is expressible', () => {
  // Only OpenAI permits this, and it is the case that would otherwise be
  // observed as something the user said.
  const req = request({
    model: 'a-model',
    system: [textBlock({ text: 'leading instructions, normalized out of the message list' })],
    messages: [
      message({ role: ROLE.USER, content: [textBlock({ text: 'hello' })] }),
      message({ role: ROLE.SYSTEM, content: [textBlock({ text: 'switch to terse mode' })] }),
      message({ role: ROLE.ASSISTANT, content: [textBlock({ text: 'ok' })] }),
    ],
    params: generationParams({ reasoning: reasoningConfig({ enabled: true, effort: REASONING_EFFORT.HIGH }) }),
  });

  assertCanonicalShape(req, 'request', 'openai-midthread-system');
  assert.equal(req.messages[1].role, ROLE.SYSTEM);
  // OpenAI spends reasoning by effort, not by a token budget; inventing a
  // budget for it would be a number nobody sent.
  assert.equal(req.params.reasoning.effort, REASONING_EFFORT.HIGH);
  assert.equal(req.params.reasoning.budgetTokens, null);
});

test('a Gemini turn is expressible: no call ids, structured results, built-in tools', () => {
  const req = request({
    model: 'a-model',
    messages: [
      message({
        role: ROLE.ASSISTANT,
        content: [
          // Gemini's functionCall has no id; an adapter synthesizes one, and
          // `name` is what actually correlates the pair.
          toolCallBlock({ id: 'synthetic-1', name: 'get_weather', input: { city: 'Paris' } }),
        ],
      }),
      message({
        role: ROLE.USER,
        content: [
          toolResultBlock({
            callId: 'synthetic-1',
            name: 'get_weather',
            content: [jsonBlock({ data: { tempC: 17, sky: 'clear' } })],
          }),
        ],
      }),
      message({
        role: ROLE.USER,
        content: [mediaBlock({ source: { kind: MEDIA_SOURCE.ID, mediaType: 'application/pdf', id: 'files/abc' } })],
      }),
    ],
    tools: [
      toolDefinition({ name: 'get_weather', parameters: { type: 'object' } }),
      // `{ googleSearch: {} }`: a name derived from the key, and nothing else.
      toolDefinition({ name: 'googleSearch', kind: TOOL_KIND.PROVIDER }),
    ],
    // `functionCallingConfig.mode: ANY` with `allowedFunctionNames` naming more
    // than one tool is why the field is a list.
    toolChoice: toolChoice({ mode: TOOL_CHOICE.REQUIRED, names: ['get_weather', 'googleSearch'] }),
  });

  assertCanonicalShape(req, 'request', 'gemini-turn');
  assert.equal(req.messages[1].content[0].name, 'get_weather');
  assert.deepEqual(req.toolChoice.names, ['get_weather', 'googleSearch']);
  assert.equal(req.tools[1].parameters, null);
});

test('inclusive provider counters normalize onto one definition', () => {
  // What an OpenAI adapter computes: prompt_tokens 5000 with cached_tokens 4000
  // is 1000 billed at full rate, and completion_tokens already includes the
  // 300 reasoning tokens.
  const openaiUsage = usage({
    inputTokens: 5000 - 4000,
    outputTokens: 800,
    cacheReadTokens: 4000,
    cacheWriteTokens: null,
    reasoningTokens: 300,
    totalTokens: 5800,
  });
  // What a Gemini adapter computes for the identical turn: promptTokenCount is
  // inclusive the same way, but candidatesTokenCount *excludes* thoughts, so
  // the 300 is added back rather than reported twice.
  const gemini = usage({
    inputTokens: 5000 - 4000,
    outputTokens: 500 + 300,
    cacheReadTokens: 4000,
    cacheWriteTokens: null,
    reasoningTokens: 300,
    totalTokens: 5800,
  });

  assert.deepEqual(openaiUsage, gemini, 'the same turn costs the same number on both providers');
  assert.equal(openaiUsage.cacheWriteTokens, null, 'implicit caching reports no write; that is not a zero');
});

test('constrained output is one field, not three spellings', () => {
  const cached = requestToCanonical(find(requests, 'request-cached-tools').body);
  assert.equal(cached.params.format.kind, RESPONSE_FORMAT.JSON_SCHEMA);
  // OpenAI `response_format.json_schema.schema`; Gemini `responseSchema`
  // alongside `responseMimeType: application/json`.
  assert.equal(cached.params.format.schema.properties.summary.type, 'string');
});

// ---------------------------------------------------------------------------
// 3. The OpenAI column, now with evidence.
//
// Everything above was written against the OpenAI *column of the table* —
// hand-derived, or exercised only through the Anthropic adapter. adapters/
// openai.js now exists, so every claim the table makes about OpenAI is
// re-asserted here driven through the real adapter over the real OpenAI
// fixture corpus, with `raw` stripped the same way. Where building the
// adapter found the table wrong, the correction is recorded in
// NEUTRALITY.md's "corrections found building the adapter" section, not
// silently fixed here.
// ---------------------------------------------------------------------------

const openaiSystemBlocks = withoutRaw(openai.requestToCanonical(find(openaiFixtures.requests, 'request-system-blocks').body));
const openaiToolsMultiCall = withoutRaw(openai.requestToCanonical(find(openaiFixtures.requests, 'request-tools-multi-call').body));
const openaiToolCallsResponse = withoutRaw(openai.responseToCanonical(find(openaiFixtures.responses, 'response-tool-calls').body));

test('[openai] system-prompt placement survives without raw', () => {
  // A leading system/developer message becomes request.system, exactly like
  // Anthropic's top-level field — the same row in Table A, driven through the
  // real adapter instead of asserted by hand.
  assert.deepEqual(
    openaiSystemBlocks.system.map((block) => block.text),
    ['Answer in the style of a terse assistant.'],
  );
  assert.equal(openaiSystemBlocks.userId, 'user_xyz', '`user` is the OpenAI spelling of request.userId');
  assert.equal(openaiSystemBlocks.params.maxOutputTokens, 4096, '`max_completion_tokens`');
  assert.equal(openaiSystemBlocks.params.temperature, 0.7);
  // The mid-thread developer message in this fixture is the row ROLE.SYSTEM
  // exists for: it must not be folded into request.system or read as a user
  // turn.
  const systemRoles = openaiSystemBlocks.messages.filter((m) => m.role === ROLE.SYSTEM);
  assert.equal(systemRoles.length, 1);
  assert.equal(systemRoles[0].content[0].text, 'Remember: no more than two sentences.');
});

test('[openai] reasoning_effort is an ordinal, never a token budget', () => {
  // Table A states this cell; the fixture actually carries reasoning_effort,
  // and the real adapter is what proves budgetTokens stays null rather than
  // being invented.
  assert.deepEqual(openaiSystemBlocks.params.reasoning, {
    enabled: true,
    effort: REASONING_EFFORT.MEDIUM,
    budgetTokens: null,
  });
});

test('[openai] tool definitions and the choice over them survive without raw', () => {
  const [readFile, runTests] = openaiToolsMultiCall.tools;
  assert.equal(readFile.name, 'read_file');
  assert.equal(readFile.description, 'Read a file from disk.');
  assert.equal(readFile.parameters.required[0], 'path');
  assert.equal(runTests.kind, TOOL_KIND.FUNCTION);

  assert.equal(openaiToolsMultiCall.toolChoice.mode, TOOL_CHOICE.AUTO);
  // parallel_tool_calls is request-level on the wire; canonical's home for it
  // is toolChoice.allowParallel; see "corrections found building the
  // adapter" in NEUTRALITY.md — the table's tool-choice row did not spell out
  // that this requires synthesizing a toolChoice object when tool_choice
  // itself is absent.
  assert.equal(openaiToolsMultiCall.toolChoice.allowParallel, true);
});

test('[openai] tool calls and results correlate, and a `tool` role message is not a canonical role', () => {
  const [call1, call2] = openaiToolsMultiCall.messages[1].content;
  const [resultMsg1, resultMsg2] = [openaiToolsMultiCall.messages[2], openaiToolsMultiCall.messages[3]];

  // The row the table states plainly ("{role:"tool", tool_call_id}" ->
  // ToolResultBlock.callId) undersells what actually has to happen: a `tool`
  // message is not a message-shaped fact in canonical at all. It becomes a
  // ROLE.USER message wrapping one toolResultBlock — the correction recorded
  // in NEUTRALITY.md.
  assert.equal(resultMsg1.role, ROLE.USER);
  const [result1] = resultMsg1.content;
  assert.equal(result1.type, BLOCK.TOOL_RESULT);
  assert.equal(result1.callId, call1.id);
  assert.equal(result1.name, 'read_file', 'resolved from the call list, the same derivation Anthropic needs');

  const [result2] = resultMsg2.content;
  assert.equal(result2.callId, call2.id);
  assert.equal(result2.name, 'run_tests');
});

test('[openai] tool call arguments are a JSON string on the wire, an object in canonical', () => {
  const [, call1] = openaiToolCallsResponse.content;
  assert.equal(call1.type, BLOCK.TOOL_CALL);
  assert.deepEqual(call1.input, { path: 'index.js' }, 'parsed once, not re-parsed by every plugin');
});

test('[openai] a provider-executed tool call has no schema', () => {
  const unmodeled = withoutRaw(openai.requestToCanonical(find(openaiFixtures.requests, 'request-unmodeled').body));
  const [, assistantMsg] = unmodeled.messages;
  const [call] = assistantMsg.content;
  assert.equal(call.kind, TOOL_KIND.PROVIDER, 'a tool_calls[].type other than "function" is provider-executed');
});

test('[openai] an image_url data: URL and an http(s) URL are two different media sources', () => {
  const image = withoutRaw(openai.requestToCanonical(find(openaiFixtures.requests, 'request-image').body));
  const [base64, url] = image.messages[0].content;
  assert.equal(base64.source.kind, MEDIA_SOURCE.BASE64);
  assert.equal(base64.source.mediaType, 'image/png');
  assert.equal(url.source.kind, MEDIA_SOURCE.URL);
});

test('[openai] stop reasons and usage survive without raw', () => {
  assert.equal(openaiToolCallsResponse.stopReason, STOP_REASON.TOOL_CALL, '`finish_reason: "tool_calls"`');

  // The derivations Table C states: inputTokens excludes the cached share of
  // prompt_tokens, outputTokens already includes reasoning, cacheWriteTokens
  // is null because implicit caching writes nothing billable.
  assert.deepEqual(openaiToolCallsResponse.usage, {
    inputTokens: 1204 - 1024,
    outputTokens: 96,
    cacheReadTokens: 1024,
    cacheWriteTokens: null,
    reasoningTokens: 0,
    totalTokens: 1300,
  });
});

test('[openai] streaming granularity never reaches the model', () => {
  // OpenAI frames a stream as choice deltas with tool-call argument fragments
  // keyed by index and no block lifecycle at all — the least structured of
  // the three framings — and the accumulator still converges on the same
  // canonical object as the non-streamed response.
  const streamed = find(openaiFixtures.streams, 'stream-tool-call');
  const canonical = openai.streamBytesToCanonical(streamed.sse);
  assertCanonicalShape(canonical, 'response', 'openai/stream-tool-call');
  assert.deepEqual(
    withoutRaw(canonical),
    withoutRaw(openai.responseToCanonical(streamed.expected)),
    'streamed and unstreamed are the same object',
  );
});

test('[openai] a stream the client did not opt into usage for yields null counters, not zeros', () => {
  const streamed = find(openaiFixtures.streams, 'stream-no-usage');
  const canonical = openai.streamBytesToCanonical(streamed.sse);
  assert.equal(canonical.usage, null, 'invariant 6: a missing provider field is null, never a computed guess or zero');
});

test('[openai] a content_filter finish_reason is not a stop, per the stop-reason table', () => {
  const filtered = openai.responseToCanonical(find(openaiFixtures.responses, 'response-content-filter').body);
  assert.equal(filtered.stopReason, STOP_REASON.CONTENT_FILTER);
});

// ---------------------------------------------------------------------------
// 4. Ledger comparability across providers.
//
// The measurement every future transform is judged against only means
// anything if the same conversation costs comparable numbers regardless of
// which provider served it. The token counts differ — tokenizers differ — but
// the *definitions* must line up: inputTokens excludes cache reads on both
// sides, outputTokens includes reasoning on both sides, and a provider that
// does not report a number is null on both sides rather than one silently
// reporting zero.
// ---------------------------------------------------------------------------

test('the same conversation, run through both adapters, produces usage under the same definitions', () => {
  // Anthropic: input_tokens already excludes cache reads; no reasoning
  // subtotal is reported.
  const anthropicUsage = responseToCanonical(find(responses, 'response-tool-calls').body).usage;
  // OpenAI: prompt_tokens is inclusive of the cached share, so inputTokens is
  // derived by subtraction; completion_tokens is already inclusive of
  // reasoning, and the reasoning share is broken out separately.
  const openaiUsage = openai.responseToCanonical(find(openaiFixtures.responses, 'response-tool-calls').body).usage;

  for (const [field, side] of [
    ['inputTokens', anthropicUsage],
    ['outputTokens', anthropicUsage],
    ['inputTokens', openaiUsage],
    ['outputTokens', openaiUsage],
  ]) {
    assert.equal(typeof side[field], 'number', `${field} must be a reported number, not null, for this assertion to mean anything`);
  }

  // Both adapters agree cacheWriteTokens is either a real reported number or
  // null — never a zero standing in for "the provider didn't say."
  assert.equal(anthropicUsage.cacheWriteTokens, 812, 'Anthropic reported an explicit cache write');
  assert.equal(openaiUsage.cacheWriteTokens, null, 'OpenAI has no such concept; null, not 0');

  // The comparable claim: inputTokens on both sides is prompt cost with the
  // cached share removed, and outputTokens on both sides already has any
  // reasoning folded in. Neither adapter leaks its provider's raw inclusive
  // counter into inputTokens.
  assert.ok(anthropicUsage.inputTokens < 1204 + 20480, 'Anthropic input excludes its own cache read');
  assert.ok(openaiUsage.inputTokens < 1204, 'OpenAI input excludes its own cached_tokens share');
  assert.equal(openaiUsage.outputTokens, 96, 'reasoning_tokens: 0 in this fixture, but folded in by definition either way');
});
