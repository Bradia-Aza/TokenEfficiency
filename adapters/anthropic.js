// Anthropic Messages API <-> canonical.
//
// Both directions are implemented even though the skeleton only ever calls
// `toCanonical`. The `fromCanonical` half is the test instrument: a one-way
// adapter can quietly drop a field forever, and the round-trip is what makes
// that a failing assertion instead of a silent gap.
//
// Nothing here is allowed to know about plugins, sinks, or transport.

import {
  BLOCK,
  MEDIA_SOURCE,
  RESPONSE_FORMAT,
  ROLE,
  STOP_REASON,
  TOOL_CHOICE,
  TOOL_KIND,
  apiError,
  cacheBreakpoint,
  generationParams,
  jsonBlock,
  mediaBlock,
  message as makeMessage,
  reasoningConfig,
  request as makeRequest,
  response as makeResponse,
  responseFormat as makeResponseFormat,
  textBlock,
  thinkingBlock,
  toolCallBlock,
  toolChoice as makeToolChoice,
  toolDefinition,
  toolResultBlock,
  unknownBlock,
  usage as makeUsage,
} from '../canonical/index.js';
import { createSseDecoder, sseData } from './sse.js';

export const PROVIDER = 'anthropic';

// -- small helpers ----------------------------------------------------------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The keys of `obj` this adapter does not model, as a fresh object. */
function rest(obj, known) {
  const out = {};
  if (!isObject(obj)) return out;
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) out[key] = obj[key];
  }
  return out;
}

/** Copy a canonical `raw` bag, lifting out keys the caller rebuilds itself. */
function spreadRaw(raw, lift = []) {
  const extra = { ...(raw ?? {}) };
  const taken = {};
  for (const key of lift) {
    if (key in extra) {
      taken[key] = extra[key];
      delete extra[key];
    }
  }
  return [extra, taken];
}

const MESSAGE_KEYS = new Set(['role', 'content']);
const CACHEABLE = 'cache_control';
const TEXT_KEYS = new Set(['type', 'text', CACHEABLE]);
const THINKING_KEYS = new Set(['type', 'thinking', 'signature', CACHEABLE]);
const REDACTED_KEYS = new Set(['type', CACHEABLE]);
const TOOL_USE_KEYS = new Set(['type', 'id', 'name', 'input', CACHEABLE]);
const TOOL_RESULT_KEYS = new Set(['type', 'tool_use_id', 'content', 'is_error', CACHEABLE]);
const MEDIA_KEYS = new Set(['type', 'source', CACHEABLE]);
const SOURCE_KEYS = new Set(['type', 'media_type', 'data', 'url', 'file_id']);
const CACHE_KEYS = new Set(['type', 'ttl']);
const TOOL_KEYS = new Set(['name', 'description', 'input_schema', CACHEABLE]);
const TOOL_CHOICE_KEYS = new Set(['type', 'name', 'disable_parallel_tool_use']);
const THINKING_CONFIG_KEYS = new Set(['type', 'budget_tokens']);
const FORMAT_KEYS = new Set(['type', 'schema']);
const METADATA_KEYS = new Set(['user_id']);
const USAGE_KEYS = new Set([
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
]);
const ERROR_KEYS = new Set(['type', 'message']);
const REQUEST_KEYS = new Set([
  'model',
  'messages',
  'system',
  'tools',
  'tool_choice',
  'max_tokens',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
  'stream',
  'metadata',
  'thinking',
  'output_format',
]);
const MESSAGE_RESPONSE_KEYS = new Set([
  'id',
  'type',
  'role',
  'model',
  'content',
  'stop_reason',
  'stop_sequence',
  'usage',
]);

/** Roles Anthropic can spell. Anything else degrades and keeps its original. */
const WIRE_ROLES = new Set([ROLE.USER, ROLE.ASSISTANT, ROLE.SYSTEM]);
/** Every attachment block type; canonical carries them all as `media`. */
const MEDIA_TYPES = new Set(['image', 'document']);
/** A call the provider executes itself, not one the client has to answer. */
const PROVIDER_CALL_TYPES = new Set(['server_tool_use', 'mcp_tool_use']);
const isProviderResultType = (type) => typeof type === 'string' && type !== 'tool_result' && type.endsWith('_tool_result');

// -- prompt caching ---------------------------------------------------------

/** `"5m"`/`"1h"` -> seconds. An unrecognized spelling stays in `raw`. */
function ttlSecondsOf(ttl) {
  const match = /^(\d+)([smh])$/.exec(String(ttl ?? ''));
  if (match === null) return null;
  const scale = { s: 1, m: 60, h: 3600 }[match[2]];
  return Number.parseInt(match[1], 10) * scale;
}

function ttlStringOf(seconds) {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function cacheToCanonical(control) {
  if (!isObject(control)) return null;
  const raw = rest(control, CACHE_KEYS);
  // The scope is Anthropic's word for "this is a breakpoint"; canonical says
  // that by the field being present at all. An unfamiliar scope is surplus.
  if (control.type !== 'ephemeral') raw.type = control.type;
  const seconds = ttlSecondsOf(control.ttl);
  if (control.ttl !== undefined && seconds === null) raw.ttl = control.ttl;
  return cacheBreakpoint({ ttlSeconds: seconds, raw });
}

function cacheFromCanonical(cache) {
  const [extra, taken] = spreadRaw(cache.raw, ['type', 'ttl']);
  return {
    ...extra,
    type: 'type' in taken ? taken.type : 'ephemeral',
    ...(cache.ttlSeconds !== null ? { ttl: ttlStringOf(cache.ttlSeconds) } : {}),
    ...('ttl' in taken ? { ttl: taken.ttl } : {}),
  };
}

/** Spread a canonical block's cache breakpoint back onto a wire block. */
const withCache = (block) => (block.cache === null ? {} : { [CACHEABLE]: cacheFromCanonical(block.cache) });

// -- content blocks ---------------------------------------------------------

const NO_NAMES = new Map();

function blockToCanonical(block, toolNames = NO_NAMES) {
  // A bare string is Anthropic's shorthand for a single text block.
  if (typeof block === 'string') return textBlock({ text: block });
  if (!isObject(block)) return unknownBlock(block);

  const cache = cacheToCanonical(block[CACHEABLE]);

  if (MEDIA_TYPES.has(block.type)) return mediaToCanonical(block, cache);
  if (PROVIDER_CALL_TYPES.has(block.type)) return callToCanonical(block, cache, TOOL_KIND.PROVIDER);
  if (isProviderResultType(block.type)) return resultToCanonical(block, cache, TOOL_KIND.PROVIDER, toolNames);

  switch (block.type) {
    case 'text':
      return textBlock({ text: block.text ?? '', cache, raw: rest(block, TEXT_KEYS) });

    case 'thinking':
      return thinkingBlock({
        thinking: block.thinking ?? '',
        signature: block.signature ?? null,
        cache,
        raw: rest(block, THINKING_KEYS),
      });

    // Opaque reasoning: no readable text, just a blob only the provider can
    // interpret. Canonical says "there was reasoning here"; the blob is raw.
    case 'redacted_thinking':
      return thinkingBlock({ thinking: '', redacted: true, cache, raw: rest(block, REDACTED_KEYS) });

    case 'tool_use':
      return callToCanonical(block, cache, TOOL_KIND.FUNCTION);

    case 'tool_result':
      return resultToCanonical(block, cache, TOOL_KIND.FUNCTION, toolNames);

    default:
      // Invariant 2: what cannot be modeled is carried whole and costs the
      // client nothing.
      return unknownBlock(block);
  }
}

/**
 * The wire block type, kept in `raw` whenever it is not the one this adapter
 * would pick by default. Canonical collapses several Anthropic spellings onto
 * one block, so the original is adapter bookkeeping — not a fact a plugin needs,
 * which reads `kind` and `source.mediaType` instead.
 */
function withWireType(raw, wireType, canonicalDefault) {
  if (wireType !== canonicalDefault) raw.type = wireType;
  return raw;
}

function callToCanonical(block, cache, kind) {
  return toolCallBlock({
    id: block.id,
    name: block.name,
    input: isObject(block.input) ? block.input : {},
    kind,
    cache,
    raw: withWireType(rest(block, TOOL_USE_KEYS), block.type, 'tool_use'),
  });
}

function resultToCanonical(block, cache, kind, toolNames) {
  const raw = withWireType(rest(block, TOOL_RESULT_KEYS), block.type, 'tool_result');
  // Canonical always holds a result as a block list. Anthropic's provider-tool
  // results carry a single structured payload instead of a list, which is the
  // same shape Gemini uses for every `functionResponse`; it becomes one `json`
  // block, and whether the wire wrapped it in a list is adapter bookkeeping.
  let content;
  if (isObject(block.content)) {
    content = [jsonBlock({ data: block.content })];
    raw.content_shape = 'object';
  } else {
    content = contentToCanonical(block.content, toolNames);
  }
  return toolResultBlock({
    callId: block.tool_use_id,
    // Anthropic addresses a result by id only. The tool's name is knowable —
    // the call is in the same request — so the adapter resolves it here rather
    // than making every plugin walk the history to answer "which tool wrote
    // this?". Gemini has only the name, so canonical carries both.
    name: toolNames.get(block.tool_use_id) ?? null,
    content,
    isError: block.is_error === true,
    kind,
    cache,
    raw,
  });
}

function mediaToCanonical(block, cache) {
  if (!isObject(block.source)) return unknownBlock(block);
  const source = mediaSourceToCanonical(block.source);
  if (source === null) return unknownBlock(block);
  const raw = withWireType(rest(block, MEDIA_KEYS), block.type, null);
  const sourceExtra = rest(block.source, SOURCE_KEYS);
  if (Object.keys(sourceExtra).length > 0) raw.source = sourceExtra;
  return mediaBlock({ source, cache, raw });
}

function mediaSourceToCanonical(source) {
  switch (source.type) {
    case 'base64':
      return { kind: MEDIA_SOURCE.BASE64, mediaType: source.media_type ?? null, data: source.data ?? null };
    case 'url':
      return { kind: MEDIA_SOURCE.URL, mediaType: source.media_type ?? null, url: source.url ?? null };
    case 'text':
      return { kind: MEDIA_SOURCE.TEXT, mediaType: source.media_type ?? null, data: source.data ?? null };
    case 'file':
      return { kind: MEDIA_SOURCE.ID, mediaType: source.media_type ?? null, id: source.file_id ?? null };
    default:
      return null;
  }
}

function blockFromCanonical(block) {
  switch (block.type) {
    case BLOCK.TEXT:
      return { ...(block.raw ?? {}), type: 'text', text: block.text, ...withCache(block) };

    case BLOCK.THINKING:
      if (block.redacted) return { ...(block.raw ?? {}), type: 'redacted_thinking', ...withCache(block) };
      return {
        ...(block.raw ?? {}),
        type: 'thinking',
        thinking: block.thinking,
        ...(block.signature !== null ? { signature: block.signature } : {}),
        ...withCache(block),
      };

    case BLOCK.TOOL_CALL: {
      const [extra, taken] = spreadRaw(block.raw, ['type']);
      return {
        ...extra,
        type: 'type' in taken ? taken.type : 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
        ...withCache(block),
      };
    }

    case BLOCK.TOOL_RESULT: {
      const [extra, taken] = spreadRaw(block.raw, ['type', 'content_shape']);
      const unwrap = taken.content_shape === 'object' && block.content[0]?.type === BLOCK.JSON;
      return {
        ...extra,
        type: 'type' in taken ? taken.type : 'tool_result',
        tool_use_id: block.callId,
        // `name` is deliberately not written back: Anthropic addresses results
        // by id alone, and canonical resolved the name for readers, not for the
        // wire.
        content: unwrap ? block.content[0].data : block.content.map(blockFromCanonical),
        ...(block.isError ? { is_error: true } : {}),
        ...withCache(block),
      };
    }

    case BLOCK.JSON:
      // No Anthropic block carries structured JSON directly; one reaching here
      // came from another provider's canonical, and text is the honest landing.
      return { ...(block.raw ?? {}), type: 'text', text: JSON.stringify(block.data), ...withCache(block) };

    case BLOCK.MEDIA: {
      const [extra, taken] = spreadRaw(block.raw, ['type', 'source']);
      return {
        ...extra,
        type: 'type' in taken ? taken.type : mediaWireType(block.source),
        source: mediaSourceFromCanonical(block.source, taken.source),
        ...withCache(block),
      };
    }

    case BLOCK.UNKNOWN:
      return block.raw;

    default:
      throw new TypeError(`anthropic: cannot serialize canonical block type ${JSON.stringify(block.type)}`);
  }
}

/** Only reached for canonical media this adapter did not produce. */
const mediaWireType = (source) => (String(source.mediaType ?? '').startsWith('image/') ? 'image' : 'document');

function mediaSourceFromCanonical(source, extra) {
  const base = { ...(extra ?? {}) };
  const mediaType = source.mediaType !== null ? { media_type: source.mediaType } : {};
  switch (source.kind) {
    case MEDIA_SOURCE.URL:
      return { ...base, type: 'url', ...mediaType, url: source.url };
    case MEDIA_SOURCE.TEXT:
      return { ...base, type: 'text', ...mediaType, data: source.data };
    case MEDIA_SOURCE.ID:
      return { ...base, type: 'file', ...mediaType, file_id: source.id };
    default:
      return { ...base, type: 'base64', media_type: source.mediaType, data: source.data };
  }
}

function contentToCanonical(content, toolNames = NO_NAMES) {
  if (content === undefined || content === null) return [];
  if (typeof content === 'string') return [textBlock({ text: content })];
  if (Array.isArray(content)) return content.map((block) => blockToCanonical(block, toolNames));
  return [unknownBlock(content)];
}

// -- messages ---------------------------------------------------------------

function messageToCanonical(msg, toolNames = NO_NAMES) {
  if (!isObject(msg)) return makeMessage({ role: ROLE.USER, content: [unknownBlock(msg)] });
  const raw = rest(msg, MESSAGE_KEYS);
  // Anything outside the three canonical roles is unmodelable, so the original
  // is kept and the canonical role degrades to the safest of them.
  const known = WIRE_ROLES.has(msg.role);
  if (!known) raw.role = msg.role;
  return makeMessage({
    role: known ? msg.role : ROLE.USER,
    content: contentToCanonical(msg.content, toolNames),
    raw,
  });
}

function messageFromCanonical(msg) {
  const [extra, taken] = spreadRaw(msg.raw, ['role']);
  return {
    ...extra,
    role: 'role' in taken ? taken.role : msg.role,
    content: msg.content.map(blockFromCanonical),
  };
}

/**
 * Every tool call in a request, by id. Built once up front so a tool result can
 * name the tool that produced it without a second pass per block.
 */
function toolNamesIn(messages) {
  const names = new Map();
  if (!Array.isArray(messages)) return names;
  for (const msg of messages) {
    const content = isObject(msg) ? msg.content : null;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isObject(block)) continue;
      const isCall = block.type === 'tool_use' || PROVIDER_CALL_TYPES.has(block.type);
      if (isCall && block.id != null && block.name != null) names.set(block.id, block.name);
    }
  }
  return names;
}

// -- tools ------------------------------------------------------------------

/**
 * Anthropic marks its own hosted tools with a versioned `type`; a client tool
 * has no `type` at all, or the literal `custom`. That distinction is what tells
 * a later transform whether the result of a call is even its business.
 */
const toolKindOf = (tool) =>
  tool.type === undefined || tool.type === null || tool.type === 'custom' ? TOOL_KIND.FUNCTION : TOOL_KIND.PROVIDER;

function toolToCanonical(tool) {
  if (!isObject(tool)) return toolDefinition({ name: String(tool), raw: { unmodeled: tool } });
  return toolDefinition({
    name: tool.name,
    description: tool.description ?? null,
    parameters: tool.input_schema ?? null,
    kind: toolKindOf(tool),
    cache: cacheToCanonical(tool[CACHEABLE]),
    raw: rest(tool, TOOL_KEYS),
  });
}

function toolFromCanonical(tool) {
  return {
    ...(tool.raw ?? {}),
    name: tool.name,
    ...(tool.description !== null ? { description: tool.description } : {}),
    ...(tool.parameters !== null ? { input_schema: tool.parameters } : {}),
    ...withCache(tool),
  };
}

const TOOL_CHOICE_TO_CANONICAL = {
  auto: TOOL_CHOICE.AUTO,
  any: TOOL_CHOICE.REQUIRED,
  none: TOOL_CHOICE.NONE,
  tool: TOOL_CHOICE.TOOL,
};
const TOOL_CHOICE_FROM_CANONICAL = {
  [TOOL_CHOICE.AUTO]: 'auto',
  [TOOL_CHOICE.REQUIRED]: 'any',
  [TOOL_CHOICE.NONE]: 'none',
  [TOOL_CHOICE.TOOL]: 'tool',
};

function toolChoiceToCanonical(choice) {
  if (!isObject(choice)) return null;
  const mode = TOOL_CHOICE_TO_CANONICAL[choice.type];
  if (mode === undefined) return null;
  return makeToolChoice({
    mode,
    // Anthropic forces at most one tool; canonical holds a list because Gemini
    // restricts the choice to a set.
    names: choice.name == null ? null : [choice.name],
    // Canonical states the permission, not the prohibition; the double negative
    // is Anthropic's spelling, not a capability of its own.
    allowParallel: typeof choice.disable_parallel_tool_use === 'boolean' ? !choice.disable_parallel_tool_use : null,
    raw: rest(choice, TOOL_CHOICE_KEYS),
  });
}

function toolChoiceFromCanonical(choice) {
  // A restriction to several tools is not expressible here; Anthropic takes the
  // forced tool and nothing else.
  const forced = choice.mode === TOOL_CHOICE.TOOL && choice.names !== null ? choice.names[0] : null;
  return {
    ...(choice.raw ?? {}),
    type: TOOL_CHOICE_FROM_CANONICAL[choice.mode],
    ...(forced !== null ? { name: forced } : {}),
    ...(choice.allowParallel !== null ? { disable_parallel_tool_use: !choice.allowParallel } : {}),
  };
}

function reasoningToCanonical(thinking) {
  if (!isObject(thinking)) return null;
  return reasoningConfig({
    enabled: thinking.type !== 'disabled',
    // Anthropic spends reasoning by budget, never by an effort ordinal.
    effort: null,
    budgetTokens: numOrNull(thinking.budget_tokens),
    raw: rest(thinking, THINKING_CONFIG_KEYS),
  });
}

function reasoningFromCanonical(reasoning) {
  return {
    ...(reasoning.raw ?? {}),
    type: reasoning.enabled ? 'enabled' : 'disabled',
    ...(reasoning.budgetTokens !== null ? { budget_tokens: reasoning.budgetTokens } : {}),
  };
}

const FORMAT_TO_CANONICAL = {
  text: RESPONSE_FORMAT.TEXT,
  json: RESPONSE_FORMAT.JSON,
  json_object: RESPONSE_FORMAT.JSON,
  json_schema: RESPONSE_FORMAT.JSON_SCHEMA,
};
const FORMAT_FROM_CANONICAL = {
  [RESPONSE_FORMAT.TEXT]: 'text',
  [RESPONSE_FORMAT.JSON]: 'json',
  [RESPONSE_FORMAT.JSON_SCHEMA]: 'json_schema',
};

/** Returns null for a shape this adapter does not recognize, which keeps it in `raw`. */
function formatToCanonical(format) {
  if (!isObject(format)) return null;
  const kind = FORMAT_TO_CANONICAL[format.type];
  if (kind === undefined) return null;
  if (kind === RESPONSE_FORMAT.JSON_SCHEMA && format.schema == null) return null;
  const raw = rest(format, FORMAT_KEYS);
  if (format.type === 'json_object') raw.type = format.type;
  return makeResponseFormat({ kind, schema: format.schema ?? null, raw });
}

function formatFromCanonical(format) {
  const [extra, taken] = spreadRaw(format.raw, ['type']);
  return {
    ...extra,
    type: 'type' in taken ? taken.type : FORMAT_FROM_CANONICAL[format.kind],
    ...(format.schema !== null ? { schema: format.schema } : {}),
  };
}

// -- usage, stop reason, error ----------------------------------------------

/**
 * Anthropic's `input_tokens` already excludes cache reads, which is canonical's
 * definition, so nothing is adjusted here. It reports neither a reasoning
 * subtotal (thinking is folded into `output_tokens`) nor a total, and both stay
 * null rather than becoming a zero a later reader would take for a measurement.
 */
function usageToCanonical(u) {
  if (!isObject(u)) return null;
  return makeUsage({
    inputTokens: numOrNull(u.input_tokens),
    outputTokens: numOrNull(u.output_tokens),
    cacheReadTokens: numOrNull(u.cache_read_input_tokens),
    cacheWriteTokens: numOrNull(u.cache_creation_input_tokens),
    reasoningTokens: null,
    totalTokens: null,
    raw: rest(u, USAGE_KEYS),
  });
}

function usageFromCanonical(u) {
  return {
    ...(u.raw ?? {}),
    ...(u.inputTokens !== null ? { input_tokens: u.inputTokens } : {}),
    ...(u.outputTokens !== null ? { output_tokens: u.outputTokens } : {}),
    ...(u.cacheReadTokens !== null ? { cache_read_input_tokens: u.cacheReadTokens } : {}),
    ...(u.cacheWriteTokens !== null ? { cache_creation_input_tokens: u.cacheWriteTokens } : {}),
  };
}

const STOP_TO_CANONICAL = {
  end_turn: STOP_REASON.END_TURN,
  max_tokens: STOP_REASON.MAX_TOKENS,
  stop_sequence: STOP_REASON.STOP_SEQUENCE,
  tool_use: STOP_REASON.TOOL_CALL,
  refusal: STOP_REASON.CONTENT_FILTER,
};
const STOP_FROM_CANONICAL = {
  [STOP_REASON.END_TURN]: 'end_turn',
  [STOP_REASON.MAX_TOKENS]: 'max_tokens',
  [STOP_REASON.STOP_SEQUENCE]: 'stop_sequence',
  [STOP_REASON.TOOL_CALL]: 'tool_use',
  [STOP_REASON.CONTENT_FILTER]: 'refusal',
};

function errorToCanonical(error) {
  if (!isObject(error)) return apiError({ message: typeof error === 'string' ? error : null });
  return apiError({ type: error.type ?? null, message: error.message ?? null, raw: rest(error, ERROR_KEYS) });
}

function errorFromCanonical(error) {
  return {
    ...(error.raw ?? {}),
    ...(error.type !== null ? { type: error.type } : {}),
    ...(error.message !== null ? { message: error.message } : {}),
  };
}

// -- request ----------------------------------------------------------------

export function requestToCanonical(body) {
  if (!isObject(body)) throw new TypeError('anthropic: request body must be a JSON object');

  const raw = rest(body, REQUEST_KEYS);
  // metadata splits in two: user_id is modeled, the rest is provider surplus.
  // An otherwise-empty metadata object leaves no trace, which is the one place
  // this adapter normalizes rather than preserves — `{}` and absent request the
  // same completion.
  if (isObject(body.metadata)) {
    const metadataExtra = rest(body.metadata, METADATA_KEYS);
    if (Object.keys(metadataExtra).length > 0) raw.metadata = metadataExtra;
  }

  const format = formatToCanonical(body.output_format);
  if (body.output_format !== undefined && format === null) raw.output_format = body.output_format;

  const toolNames = toolNamesIn(body.messages);

  return makeRequest({
    model: body.model ?? null,
    system: body.system == null ? null : contentToCanonical(body.system, toolNames),
    messages: Array.isArray(body.messages) ? body.messages.map((msg) => messageToCanonical(msg, toolNames)) : [],
    tools: Array.isArray(body.tools) ? body.tools.map(toolToCanonical) : null,
    toolChoice: toolChoiceToCanonical(body.tool_choice),
    params: generationParams({
      maxOutputTokens: numOrNull(body.max_tokens),
      temperature: numOrNull(body.temperature),
      topP: numOrNull(body.top_p),
      topK: numOrNull(body.top_k),
      stopSequences: Array.isArray(body.stop_sequences) ? [...body.stop_sequences] : null,
      reasoning: reasoningToCanonical(body.thinking),
      format,
    }),
    stream: body.stream === true,
    userId: isObject(body.metadata) ? body.metadata.user_id ?? null : null,
    raw,
  });
}

export function requestFromCanonical(req) {
  const [out, { metadata: metadataExtra }] = spreadRaw(req.raw, ['metadata']);
  const { params } = req;

  out.model = req.model;
  if (params.maxOutputTokens !== null) out.max_tokens = params.maxOutputTokens;
  out.messages = req.messages.map(messageFromCanonical);
  if (req.system !== null) out.system = req.system.map(blockFromCanonical);
  if (req.tools !== null) out.tools = req.tools.map(toolFromCanonical);
  if (req.toolChoice !== null) out.tool_choice = toolChoiceFromCanonical(req.toolChoice);
  if (params.temperature !== null) out.temperature = params.temperature;
  if (params.topP !== null) out.top_p = params.topP;
  if (params.topK !== null) out.top_k = params.topK;
  if (params.stopSequences !== null) out.stop_sequences = [...params.stopSequences];
  if (params.reasoning !== null) out.thinking = reasoningFromCanonical(params.reasoning);
  if (params.format !== null) out.output_format = formatFromCanonical(params.format);
  if (req.stream) out.stream = true;
  if (metadataExtra !== undefined || req.userId !== null) {
    out.metadata = { ...(metadataExtra ?? {}), ...(req.userId !== null ? { user_id: req.userId } : {}) };
  }
  return out;
}

// -- response ---------------------------------------------------------------

export function responseToCanonical(body) {
  if (!isObject(body)) throw new TypeError('anthropic: response body must be a JSON object');
  if (body.type === 'error') {
    return makeResponse({
      error: errorToCanonical(body.error),
      raw: rest(body, new Set(['type', 'error'])),
    });
  }
  return messageToCanonicalResponse(body);
}

function messageToCanonicalResponse(body, { error = null } = {}) {
  const raw = rest(body, MESSAGE_RESPONSE_KEYS);
  let stopReason = null;
  if (body.stop_reason != null) {
    stopReason = STOP_TO_CANONICAL[body.stop_reason] ?? STOP_REASON.OTHER;
    // A reason with no canonical equivalent keeps its original spelling, so the
    // adapter can put it back and a plugin still sees "the turn ended somehow".
    if (stopReason === STOP_REASON.OTHER) raw.stop_reason = body.stop_reason;
  }
  const content = body.content;
  return makeResponse({
    id: body.id ?? null,
    model: body.model ?? null,
    role: body.role === ROLE.USER ? ROLE.USER : ROLE.ASSISTANT,
    content: contentToCanonical(content, toolNamesIn([{ content }])),
    stopReason,
    stopSequence: body.stop_sequence ?? null,
    usage: usageToCanonical(body.usage),
    error,
    raw,
  });
}

export function responseFromCanonical(res) {
  if (res.error !== null && res.content.length === 0 && res.id === null) {
    return { ...(res.raw ?? {}), type: 'error', error: errorFromCanonical(res.error) };
  }
  const [out, { stop_reason: rawStopReason }] = spreadRaw(res.raw, ['stop_reason']);
  out.id = res.id;
  out.type = 'message';
  out.role = res.role;
  out.model = res.model;
  out.content = res.content.map(blockFromCanonical);
  out.stop_reason =
    res.stopReason === STOP_REASON.OTHER ? rawStopReason ?? null : STOP_FROM_CANONICAL[res.stopReason] ?? null;
  out.stop_sequence = res.stopSequence;
  if (res.usage !== null) out.usage = usageFromCanonical(res.usage);
  return out;
}

// -- streaming --------------------------------------------------------------

/**
 * Accumulate Anthropic stream events into the message they describe.
 *
 * The accumulator rebuilds the *wire-form* message and converts once at the
 * end, so a streamed turn and the same turn unstreamed produce byte-identical
 * canonical objects by construction rather than by two parallel mappings that
 * can drift. It is also what keeps streaming granularity out of the canonical
 * model entirely: the three providers frame a stream three different ways —
 * indexed block deltas, choice deltas with an implied index, whole parts per
 * chunk — and none of that reaches a plugin, which sees only the finished turn.
 *
 * Nothing in here can block the forward: it is fed chunks that have already
 * been written to the client (invariant 4), and every malformed input degrades
 * to a recorded warning (invariant 3).
 */
export function createStreamAccumulator() {
  /** @type {object|null} the message shell from message_start */
  let message = null;
  /** @type {Map<number, { block: object, json: string }>} */
  const open = new Map();
  const content = new Map();
  let error = null;
  let stopped = false;
  const warnings = [];

  const warn = (note) => {
    if (warnings.length < 32) warnings.push(note);
  };

  const closeBlock = (index) => {
    const partial = open.get(index);
    if (partial === undefined) return;
    open.delete(index);
    const { block, json } = partial;
    if (block.type === 'tool_use' || PROVIDER_CALL_TYPES.has(block.type)) {
      if (json !== '') {
        try {
          block.input = JSON.parse(json);
        } catch {
          // A truncated stream can leave half a JSON document behind. Keep the
          // fragment rather than inventing arguments the model never sent.
          warn(`unparseable tool input at index ${index}`);
          block.input = block.input ?? {};
          block.partial_json = json;
        }
      } else if (block.input === undefined) {
        block.input = {};
      }
    }
    content.set(index, block);
  };

  const applyDelta = (index, delta) => {
    const partial = open.get(index);
    if (partial === undefined) {
      warn(`delta for unopened block at index ${index}`);
      return;
    }
    const { block } = partial;
    switch (delta?.type) {
      case 'text_delta':
        block.text = (block.text ?? '') + (delta.text ?? '');
        break;
      case 'thinking_delta':
        block.thinking = (block.thinking ?? '') + (delta.thinking ?? '');
        break;
      case 'signature_delta':
        block.signature = (block.signature ?? '') + (delta.signature ?? '');
        break;
      case 'input_json_delta':
        partial.json += delta.partial_json ?? '';
        break;
      default:
        warn(`unknown delta type ${JSON.stringify(delta?.type)}`);
    }
  };

  const buildMessage = () => {
    // A stream cut off mid-block still has whatever text arrived; keep it.
    for (const index of [...open.keys()]) closeBlock(index);
    if (message === null) return null;
    const indexes = [...content.keys()].sort((a, b) => a - b);
    return { ...message, content: indexes.map((i) => content.get(i)) };
  };

  return {
    /**
     * Feed one event: either a parsed Anthropic event object, or an SSE record
     * from the decoder.
     */
    push(input) {
      const event = isObject(input) && typeof input.type === 'string' ? input : sseData(input);
      if (!isObject(event)) return;

      switch (event.type) {
        case 'message_start':
          if (isObject(event.message)) {
            message = structuredClone(event.message);
            message.content = [];
          } else {
            warn('message_start without a message');
          }
          break;

        case 'content_block_start':
          if (isObject(event.content_block)) {
            open.set(event.index, { block: structuredClone(event.content_block), json: '' });
          }
          break;

        case 'content_block_delta':
          applyDelta(event.index, event.delta);
          break;

        case 'content_block_stop':
          closeBlock(event.index);
          break;

        case 'message_delta':
          if (message === null) message = {};
          if (isObject(event.delta)) Object.assign(message, event.delta);
          // Usage arrives cumulative, so later reports replace earlier ones.
          if (isObject(event.usage)) message.usage = { ...(message.usage ?? {}), ...event.usage };
          break;

        case 'message_stop':
          stopped = true;
          break;

        case 'error':
          // Mid-stream failure. The bytes already went to the client untouched;
          // canonical just records that the turn did not finish cleanly.
          error = event.error ?? { type: 'error', message: null };
          break;

        case 'ping':
          break;

        default:
          warn(`unknown stream event ${JSON.stringify(event.type)}`);
      }
    },

    /** The reassembled wire-form message, or null if the stream never started one. */
    message: buildMessage,

    result() {
      const wire = buildMessage();
      if (wire === null) {
        return makeResponse({ error: error === null ? null : errorToCanonical(error) });
      }
      return messageToCanonicalResponse(wire, {
        error: error === null ? null : errorToCanonical(error),
      });
    },

    /** Observation metadata for `ctx`; not part of the canonical model. */
    state() {
      return { complete: stopped && error === null, stopped, failed: error !== null, warnings: [...warnings] };
    },
  };
}

/**
 * Convenience over `createStreamAccumulator`: events (parsed objects or SSE
 * records) in, one canonical response out.
 */
export function streamToCanonical(events) {
  const accumulator = createStreamAccumulator();
  for (const event of events) accumulator.push(event);
  return accumulator.result();
}

/** Decode raw `text/event-stream` bytes and accumulate them in one call. */
export function streamBytesToCanonical(text) {
  const decoder = createSseDecoder();
  const accumulator = createStreamAccumulator();
  for (const record of decoder.push(text)) accumulator.push(record);
  for (const record of decoder.flush()) accumulator.push(record);
  return accumulator.result();
}

export const adapter = Object.freeze({
  name: PROVIDER,
  requestToCanonical,
  requestFromCanonical,
  responseToCanonical,
  responseFromCanonical,
  streamToCanonical,
  streamBytesToCanonical,
  createStreamAccumulator,
});
