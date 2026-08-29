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
  const openai = usage({
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

  assert.deepEqual(openai, gemini, 'the same turn costs the same number on both providers');
  assert.equal(openai.cacheWriteTokens, null, 'implicit caching reports no write; that is not a zero');
});

test('constrained output is one field, not three spellings', () => {
  const cached = requestToCanonical(find(requests, 'request-cached-tools').body);
  assert.equal(cached.params.format.kind, RESPONSE_FORMAT.JSON_SCHEMA);
  // OpenAI `response_format.json_schema.schema`; Gemini `responseSchema`
  // alongside `responseMimeType: application/json`.
  assert.equal(cached.params.format.schema.properties.summary.type, 'string');
});
