// The provider-neutral domain model.
//
// This is deliberately *not* a rename of the first adapter's schema. Every
// field here has a defensible home in all three major wire formats; where they
// disagree on spelling, canonical picks a neutral name, and where one provider
// has surplus the others lack, the surplus goes in `raw`. This layer names no
// provider, and it must stay that way.
//
// Phase 5 hand-mapped three fixtures to and from two other providers' wire
// formats, field by field, in both directions; every cell that could only be
// filled with "put it in `raw`" became a field here. The comments below say what
// each field is for so a later reader can tell a considered field from an
// accident, and NEUTRALITY.md holds the provider-by-provider table behind them.
// The names of those providers stay in that document: this layer names none.
//
// `raw` rules:
//   - It holds the provider keys the model does not express, and it belongs to
//     the adapter that produced it. Plugins ignore it.
//   - Needing `raw` for something a plugin would plausibly read is a defect in
//     this model. Fix the model, not the caller.
//
// `null` vs `[]` on optional collections (`system`, `tools`, `stopSequences`):
// null means the provider omitted the field, an empty array means it was sent
// empty. Consumers that don't care write `req.tools ?? []`.

import { deepFreeze } from './freeze.js';

export const ROLE = Object.freeze({
  USER: 'user',
  ASSISTANT: 'assistant',
  /**
   * An in-band system turn. Some providers carry the system prompt as a message
   * in the message list and allow one at any position; only a *leading* one
   * means the same thing as `request.system`. Without this role, an instruction
   * sent mid-conversation is observed as something the user said.
   */
  SYSTEM: 'system',
});

export const BLOCK = Object.freeze({
  TEXT: 'text',
  THINKING: 'thinking',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
  /**
   * A non-text attachment: image, document, audio, video. Deliberately not
   * `image` — at least one provider carries every attachment through a single
   * part shape keyed by mime type, and a model with only an image block is one
   * vendor's schema with a hole where PDFs and audio belong.
   */
  MEDIA: 'media',
  /**
   * A structured JSON payload. At least one provider requires *every* tool
   * result to be an object; flattening those into text would make this model
   * text-only by accident, and would hand an output-shaping plugin a string to
   * re-parse instead of fields to read.
   */
  JSON: 'json',
  /** A block this model cannot express. Carried whole, in `raw`, for fidelity. */
  UNKNOWN: 'unknown',
});

export const STOP_REASON = Object.freeze({
  END_TURN: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  STOP_SEQUENCE: 'stop_sequence',
  TOOL_CALL: 'tool_call',
  CONTENT_FILTER: 'content_filter',
  /** A provider reason with no canonical equivalent; the adapter keeps the original. */
  OTHER: 'other',
});

export const TOOL_CHOICE = Object.freeze({
  AUTO: 'auto',
  NONE: 'none',
  REQUIRED: 'required',
  /** Force a call to one of `names`. */
  TOOL: 'tool',
});

/**
 * Who runs the tool. Some tools are executed by the provider itself: the client
 * never sees a call it has to answer, and a transform must never rewrite the
 * result. Such a tool also need not publish a schema — one provider's built-ins
 * are a bare name and nothing else — so this is what keeps `parameters: null`
 * meaningful rather than lossy.
 */
export const TOOL_KIND = Object.freeze({
  FUNCTION: 'function',
  PROVIDER: 'provider',
});

/**
 * How a media payload is carried. `TEXT` covers a document inlined as plain
 * text rather than base64; `ID` covers a handle to a file uploaded beforehand.
 */
export const MEDIA_SOURCE = Object.freeze({
  BASE64: 'base64',
  URL: 'url',
  TEXT: 'text',
  ID: 'id',
});

/**
 * Reasoning budget as an ordinal rather than a token count. Some providers
 * spend reasoning by an effort level, others by a token budget, and neither
 * converts into the other — so both are modeled and either may be null.
 */
export const REASONING_EFFORT = Object.freeze({
  MINIMAL: 'minimal',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
});

/** Constrained-output modes. Every provider surveyed supports all three. */
export const RESPONSE_FORMAT = Object.freeze({
  TEXT: 'text',
  JSON: 'json',
  JSON_SCHEMA: 'json_schema',
});

const MESSAGE_ROLES = new Set(Object.values(ROLE));
/** A provider answers as the assistant. `system` is never a response role. */
const RESPONSE_ROLES = new Set([ROLE.USER, ROLE.ASSISTANT]);
const STOP_REASONS = new Set(Object.values(STOP_REASON));
const TOOL_CHOICES = new Set(Object.values(TOOL_CHOICE));
const TOOL_KINDS = new Set(Object.values(TOOL_KIND));
const MEDIA_SOURCES = new Set(Object.values(MEDIA_SOURCE));
const REASONING_EFFORTS = new Set(Object.values(REASONING_EFFORT));
const RESPONSE_FORMATS = new Set(Object.values(RESPONSE_FORMAT));

function required(value, field) {
  if (value === undefined || value === null || value === '') {
    throw new TypeError(`canonical: ${field} is required`);
  }
  return value;
}

function oneOf(value, allowed, field) {
  if (!allowed.has(value)) {
    throw new TypeError(`canonical: ${field} must be one of ${[...allowed].join('|')}, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** An enum field the provider may simply not have said anything about. */
function oneOfOrNull(value, allowed, field) {
  if (value === undefined || value === null) return null;
  return oneOf(value, allowed, field);
}

function blockList(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`canonical: ${field} must be an array`);
  return value;
}

function nameList(value, field) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((n) => typeof n !== 'string')) {
    throw new TypeError(`canonical: ${field} must be an array of strings or null`);
  }
  return [...value];
}

/** Normalize an adapter's leftovers: an empty bag is the same as none. */
function rawOrNull(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length === 0) return null;
  return raw;
}

// -- prompt caching ---------------------------------------------------------

/**
 * An explicit prompt-cache breakpoint: everything up to and including the block
 * that carries this is cacheable.
 *
 * This is modeled rather than left in `raw` because it is the one request-side
 * control that decides whether a turn's prompt bills as `cacheWriteTokens` or
 * `cacheReadTokens`. On a token efficiency platform that is the measurement,
 * not a detail — a meter that can see the cache hit but not the breakpoint that
 * caused it cannot attribute anything.
 *
 * Presence is the signal; `ttlSeconds` is the requested lifetime where the
 * provider lets a caller ask for one, and null where caching is implicit or the
 * lifetime is fixed.
 */
export function cacheBreakpoint({ ttlSeconds = null, raw = null } = {}) {
  return deepFreeze({ ttlSeconds: ttlSeconds ?? null, raw: rawOrNull(raw) });
}

const cacheOrNull = (cache) => cache ?? null;

// -- content blocks ---------------------------------------------------------

export function textBlock({ text = '', cache = null, raw = null } = {}) {
  if (typeof text !== 'string') throw new TypeError('canonical: text block text must be a string');
  return deepFreeze({ type: BLOCK.TEXT, text, cache: cacheOrNull(cache), raw: rawOrNull(raw) });
}

/**
 * Model reasoning. `redacted` covers reasoning a provider returns as an opaque
 * blob rather than readable text; the blob itself lives in `raw`, since nothing
 * but the issuing provider can interpret it. `signature` carries the token a
 * provider attaches to verify reasoning it later receives back.
 */
export function thinkingBlock({ thinking = '', signature = null, redacted = false, cache = null, raw = null } = {}) {
  if (typeof thinking !== 'string') throw new TypeError('canonical: thinking must be a string');
  return deepFreeze({
    type: BLOCK.THINKING,
    thinking,
    signature: signature ?? null,
    redacted: redacted === true,
    cache: cacheOrNull(cache),
    raw: rawOrNull(raw),
  });
}

/**
 * A model request to invoke a tool. `id` correlates with a tool result's
 * `callId`; an adapter for a provider that correlates by tool name instead
 * synthesizes one, which is why the result also carries `name`.
 */
export function toolCallBlock({ id, name, input = {}, kind = TOOL_KIND.FUNCTION, cache = null, raw = null } = {}) {
  required(id, 'tool call id');
  required(name, 'tool call name');
  oneOf(kind, TOOL_KINDS, 'tool call kind');
  return deepFreeze({
    type: BLOCK.TOOL_CALL,
    id,
    name,
    input: input ?? {},
    kind,
    cache: cacheOrNull(cache),
    raw: rawOrNull(raw),
  });
}

/**
 * The outcome of a tool call.
 *
 * `callId` addresses the result back to the call; `name` says which tool
 * produced it. Both are modeled because providers correlate differently — some
 * by id, at least one only by the tool's name — and because "which tool wrote
 * this output" is the first thing any output-shaping plugin asks. Deriving it
 * by scanning back through the message list is work a plugin should not redo.
 *
 * `content` is always a block list even where the provider allowed a bare
 * string; a provider that returns structured JSON contributes a `json` block.
 */
export function toolResultBlock({
  callId,
  name = null,
  content = [],
  isError = false,
  kind = TOOL_KIND.FUNCTION,
  cache = null,
  raw = null,
} = {}) {
  required(callId, 'tool result callId');
  oneOf(kind, TOOL_KINDS, 'tool result kind');
  return deepFreeze({
    type: BLOCK.TOOL_RESULT,
    callId,
    name: name ?? null,
    content: blockList(content, 'tool result content'),
    isError: isError === true,
    kind,
    cache: cacheOrNull(cache),
    raw: rawOrNull(raw),
  });
}

/**
 * Structured, non-text content. `data` is the parsed JSON value, not a string,
 * so a plugin reads fields instead of re-parsing what an adapter stringified.
 */
export function jsonBlock({ data = null, cache = null, raw = null } = {}) {
  return deepFreeze({ type: BLOCK.JSON, data: data ?? null, cache: cacheOrNull(cache), raw: rawOrNull(raw) });
}

/**
 * A non-text attachment of any media type.
 *
 * @param {{ kind: string, mediaType?: string|null, data?: string|null, url?: string|null, id?: string|null }} source
 */
export function mediaBlock({ source, cache = null, raw = null } = {}) {
  if (source === null || typeof source !== 'object') {
    throw new TypeError('canonical: media block needs a source');
  }
  oneOf(source.kind, MEDIA_SOURCES, 'media source kind');
  return deepFreeze({
    type: BLOCK.MEDIA,
    source: {
      kind: source.kind,
      mediaType: source.mediaType ?? null,
      data: source.data ?? null,
      url: source.url ?? null,
      id: source.id ?? null,
    },
    cache: cacheOrNull(cache),
    raw: rawOrNull(raw),
  });
}

/**
 * A block the model cannot express. `raw` is the entire original — not
 * leftovers — so the adapter can reproduce it byte-identically.
 */
export function unknownBlock(raw) {
  return deepFreeze({ type: BLOCK.UNKNOWN, raw });
}

// -- messages, tools, usage, errors -----------------------------------------

export function message({ role, content = [], raw = null } = {}) {
  oneOf(role, MESSAGE_ROLES, 'message role');
  return deepFreeze({ role, content: blockList(content, 'message content'), raw: rawOrNull(raw) });
}

/**
 * A tool the model may call. `parameters` is a JSON Schema object, the one
 * tool-definition shape all three providers accept; it is null for a `provider`
 * tool, which has no client-visible schema.
 */
export function toolDefinition({
  name,
  description = null,
  parameters = null,
  kind = TOOL_KIND.FUNCTION,
  cache = null,
  raw = null,
} = {}) {
  required(name, 'tool name');
  oneOf(kind, TOOL_KINDS, 'tool kind');
  return deepFreeze({
    name,
    description: description ?? null,
    parameters: parameters ?? null,
    kind,
    cache: cacheOrNull(cache),
    raw: rawOrNull(raw),
  });
}

/**
 * `names` is a list, not a single name: at least one provider restricts the
 * choice to a *set* of tools. For `TOOL` it is the set the model must choose
 * from; for the other modes it is an optional restriction on a free choice.
 */
export function toolChoice({ mode, names = null, allowParallel = null, raw = null } = {}) {
  oneOf(mode, TOOL_CHOICES, 'tool choice mode');
  const list = nameList(names, 'tool choice names');
  if (mode === TOOL_CHOICE.TOOL && (list === null || list.length === 0)) {
    throw new TypeError('canonical: tool choice names is required when mode is tool');
  }
  return deepFreeze({ mode, names: list, allowParallel: allowParallel ?? null, raw: rawOrNull(raw) });
}

/** Reasoning budget/toggle. Absent means the provider said nothing about it. */
export function reasoningConfig({ enabled = true, effort = null, budgetTokens = null, raw = null } = {}) {
  return deepFreeze({
    enabled: enabled === true,
    effort: oneOfOrNull(effort, REASONING_EFFORTS, 'reasoning effort'),
    budgetTokens: budgetTokens ?? null,
    raw: rawOrNull(raw),
  });
}

/** Constrained output: a mode, plus the schema when the mode needs one. */
export function responseFormat({ kind, schema = null, raw = null } = {}) {
  oneOf(kind, RESPONSE_FORMATS, 'response format kind');
  if (kind === RESPONSE_FORMAT.JSON_SCHEMA) required(schema, 'response format schema');
  return deepFreeze({ kind, schema: schema ?? null, raw: rawOrNull(raw) });
}

/**
 * Token accounting, normalized so the same turn costs the same number on every
 * provider. null means the provider did not report that number, which is
 * different from reporting zero — the meter has to be able to tell them apart
 * or the baseline is a lie.
 *
 * The definitions are the load-bearing part. Providers disagree about what
 * their own prompt and completion counters include, so an adapter that copies
 * them across verbatim produces a ledger that cannot be compared with itself,
 * let alone across providers. Every adapter normalizes onto these, computing
 * where its provider's spelling differs; NEUTRALITY.md holds the derivations.
 *
 * - `inputTokens` — prompt tokens billed at full rate, **excluding** cache
 *   reads. An adapter whose provider reports an inclusive prompt count
 *   subtracts the cached share rather than passing it through.
 * - `cacheReadTokens` / `cacheWriteTokens` — prompt tokens served from, and
 *   written to, the cache. A provider with implicit-only caching reports no
 *   write number; that is null, not zero.
 * - `outputTokens` — generated tokens **including** reasoning. An adapter whose
 *   provider reports reasoning separately from completion adds it back in.
 * - `reasoningTokens` — the reasoning share of `outputTokens`, when reported.
 *   Broken out because it is generated, invisible, and often the largest line.
 * - `totalTokens` — what the provider itself said the turn cost, when it said
 *   so. Kept as reported rather than derived, so a mismatch with the parts is
 *   visible instead of arithmetic'd away.
 */
export function usage({
  inputTokens = null,
  outputTokens = null,
  cacheReadTokens = null,
  cacheWriteTokens = null,
  reasoningTokens = null,
  totalTokens = null,
  raw = null,
} = {}) {
  return deepFreeze({
    inputTokens: inputTokens ?? null,
    outputTokens: outputTokens ?? null,
    cacheReadTokens: cacheReadTokens ?? null,
    cacheWriteTokens: cacheWriteTokens ?? null,
    reasoningTokens: reasoningTokens ?? null,
    totalTokens: totalTokens ?? null,
    raw: rawOrNull(raw),
  });
}

export function apiError({ type = null, message: text = null, raw = null } = {}) {
  return deepFreeze({ type: type ?? null, message: text ?? null, raw: rawOrNull(raw) });
}

export function generationParams({
  maxOutputTokens = null,
  temperature = null,
  topP = null,
  topK = null,
  stopSequences = null,
  reasoning = null,
  format = null,
} = {}) {
  return deepFreeze({
    maxOutputTokens: maxOutputTokens ?? null,
    temperature: temperature ?? null,
    topP: topP ?? null,
    topK: topK ?? null,
    stopSequences: stopSequences ?? null,
    reasoning: reasoning ?? null,
    format: format ?? null,
  });
}

// -- request and response ---------------------------------------------------

/**
 * A conversation plus the knobs it is sent with.
 *
 * `system` is its own field rather than a message, because providers place it
 * in three different spots — a top-level field, a leading message in the message
 * list, a dedicated instruction object — and none of them treats it as an
 * ordinary turn. An adapter normalizes a *leading* in-band system message into
 * this field; one that appears later in the thread, which not every provider
 * even permits, stays where it is as a `ROLE.SYSTEM` message.
 */
export function request({
  model = null,
  system = null,
  messages = [],
  tools = null,
  toolChoice: choice = null,
  params = generationParams(),
  stream = false,
  userId = null,
  raw = null,
} = {}) {
  if (!Array.isArray(messages)) throw new TypeError('canonical: request messages must be an array');
  if (system !== null && !Array.isArray(system)) throw new TypeError('canonical: request system must be an array or null');
  if (tools !== null && !Array.isArray(tools)) throw new TypeError('canonical: request tools must be an array or null');
  return deepFreeze({
    model,
    system,
    messages,
    tools,
    toolChoice: choice,
    params,
    stream: stream === true,
    userId: userId ?? null,
    raw: rawOrNull(raw),
  });
}

/**
 * One assistant turn. `error` is set instead of content when the provider
 * returned an error envelope, or alongside partial content when a stream failed
 * partway through.
 */
export function response({
  id = null,
  model = null,
  role = ROLE.ASSISTANT,
  content = [],
  stopReason = null,
  stopSequence = null,
  usage: tokens = null,
  error = null,
  raw = null,
} = {}) {
  oneOf(role, RESPONSE_ROLES, 'response role');
  if (stopReason !== null) oneOf(stopReason, STOP_REASONS, 'response stopReason');
  return deepFreeze({
    id,
    model,
    role,
    content: blockList(content, 'response content'),
    stopReason,
    stopSequence: stopSequence ?? null,
    usage: tokens,
    error,
    raw: rawOrNull(raw),
  });
}
