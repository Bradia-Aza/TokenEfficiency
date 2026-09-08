// OpenAI Chat Completions API <-> canonical.
//
// Mirrors adapters/anthropic.js's surface exactly. Both directions are
// implemented for the same reason: fromCanonical is what proves the model is
// lossless, and this is the first time that claim is tested against a format
// the model was not derived from. NEUTRALITY.md's OpenAI column, and
// OPENAI_ADAPTER_PLAN.md's Phase 0 decisions, are the specification this file
// follows; where the two disagree with the code, one of them is wrong.
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
  generationParams,
  jsonBlock,
  mediaBlock,
  message as makeMessage,
  reasoningConfig,
  request as makeRequest,
  response as makeResponse,
  responseFormat as makeResponseFormat,
  textBlock,
  toolCallBlock,
  toolChoice as makeToolChoice,
  toolDefinition,
  toolResultBlock,
  unknownBlock,
  usage as makeUsage,
} from '../canonical/index.js';
import { createSseDecoder, sseData } from './sse.js';

export const PROVIDER = 'openai';

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

const MESSAGE_KEYS = new Set(['role', 'content', 'tool_calls', 'tool_call_id', 'name', 'refusal']);
const TEXT_PART_KEYS = new Set(['type', 'text']);
const IMAGE_PART_KEYS = new Set(['type', 'image_url']);
const IMAGE_URL_KEYS = new Set(['url', 'detail']);
const FILE_PART_KEYS = new Set(['type', 'file']);
const FILE_KEYS = new Set(['file_data', 'file_id', 'filename']);
const AUDIO_PART_KEYS = new Set(['type', 'input_audio']);
const AUDIO_KEYS = new Set(['data', 'format']);
const TOOL_CALL_KEYS = new Set(['id', 'type', 'function']);
const FUNCTION_CALL_KEYS = new Set(['name', 'arguments']);
const FUNCTION_TOOL_KEYS = new Set(['type', 'function']);
const FUNCTION_DEF_KEYS = new Set(['name', 'description', 'parameters', 'strict']);
const TOOL_CHOICE_FUNCTION_KEYS = new Set(['type', 'function']);
const FORMAT_KEYS = new Set(['type', 'json_schema']);
const JSON_SCHEMA_KEYS = new Set(['schema', 'name', 'strict', 'description']);
const USAGE_KEYS = new Set(['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details', 'completion_tokens_details']);
const PROMPT_DETAILS_KEYS = new Set(['cached_tokens']);
const COMPLETION_DETAILS_KEYS = new Set(['reasoning_tokens']);
const ERROR_KEYS = new Set(['type', 'message']);
const REQUEST_KEYS = new Set([
  'model',
  'messages',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'stop',
  'stream',
  'stream_options',
  'user',
  'reasoning_effort',
  'response_format',
]);
const CHOICE_KEYS = new Set(['index', 'message', 'finish_reason', 'logprobs']);
const RESPONSE_KEYS = new Set(['id', 'object', 'model', 'choices', 'usage', 'created', 'system_fingerprint', 'service_tier']);

/** In-thread system/developer instructions that are not the leading message. */
const SYSTEM_ROLES = new Set(['system', 'developer']);
const isImageMediaType = (mediaType) => typeof mediaType === 'string' && mediaType.startsWith('image/');

// -- content blocks -----------------------------------------------------------

function dataUrlOf(url) {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(String(url ?? ''));
  if (match === null) return null;
  const [, mediaType, base64, payload] = match;
  return { mediaType: mediaType || null, base64: base64 !== undefined, data: payload };
}

function imagePartToCanonical(part) {
  const imageUrl = isObject(part.image_url) ? part.image_url : {};
  const raw = rest(part, IMAGE_PART_KEYS);
  const urlExtra = rest(imageUrl, IMAGE_URL_KEYS);
  if (Object.keys(urlExtra).length > 0) raw.image_url = urlExtra;

  const asData = dataUrlOf(imageUrl.url);
  if (asData !== null && asData.base64) {
    return mediaBlock({ source: { kind: MEDIA_SOURCE.BASE64, mediaType: asData.mediaType, data: asData.data }, raw });
  }
  return mediaBlock({ source: { kind: MEDIA_SOURCE.URL, mediaType: null, url: imageUrl.url ?? null }, raw });
}

function filePartToCanonical(part) {
  const file = isObject(part.file) ? part.file : {};
  const raw = rest(part, FILE_PART_KEYS);
  const fileExtra = rest(file, FILE_KEYS);
  if (Object.keys(fileExtra).length > 0) raw.file = fileExtra;

  if (typeof file.file_data === 'string') {
    const asData = dataUrlOf(file.file_data);
    const data = asData !== null ? asData.data : file.file_data;
    const mediaType = asData !== null ? asData.mediaType : null;
    return mediaBlock({ source: { kind: MEDIA_SOURCE.TEXT, mediaType, data }, raw });
  }
  return mediaBlock({ source: { kind: MEDIA_SOURCE.ID, mediaType: null, id: file.file_id ?? null }, raw });
}

function audioPartToCanonical(part) {
  const audio = isObject(part.input_audio) ? part.input_audio : {};
  const raw = rest(part, AUDIO_PART_KEYS);
  const audioExtra = rest(audio, AUDIO_KEYS);
  if (Object.keys(audioExtra).length > 0) raw.input_audio = audioExtra;
  const mediaType = typeof audio.format === 'string' ? `audio/${audio.format}` : null;
  return mediaBlock({ source: { kind: MEDIA_SOURCE.BASE64, mediaType, data: audio.data ?? null }, raw });
}

function partToCanonical(part) {
  if (typeof part === 'string') return textBlock({ text: part });
  if (!isObject(part)) return unknownBlock(part);
  switch (part.type) {
    case 'text':
      return textBlock({ text: part.text ?? '', raw: rest(part, TEXT_PART_KEYS) });
    case 'image_url':
      return imagePartToCanonical(part);
    case 'file':
      return filePartToCanonical(part);
    case 'input_audio':
      return audioPartToCanonical(part);
    default:
      return unknownBlock(part);
  }
}

function contentToCanonical(content) {
  if (content === undefined || content === null) return [];
  if (typeof content === 'string') return [textBlock({ text: content })];
  if (Array.isArray(content)) return content.map(partToCanonical);
  return [unknownBlock(content)];
}

/** Always the parts-array spelling on the way out — see Phase 0 decisions. */
function blockToPart(block) {
  switch (block.type) {
    case BLOCK.TEXT:
      return { ...(block.raw ?? {}), type: 'text', text: block.text };

    case BLOCK.MEDIA:
      return partFromMedia(block);

    case BLOCK.JSON:
      // No OpenAI content part carries structured JSON directly; text is the
      // honest landing for a JSON block that arrived from another provider.
      return { type: 'text', text: JSON.stringify(block.data) };

    case BLOCK.UNKNOWN:
      return block.raw;

    default:
      throw new TypeError(`openai: cannot serialize canonical block type ${JSON.stringify(block.type)} as a content part`);
  }
}

function partFromMedia(block) {
  const { source } = block;
  switch (source.kind) {
    case MEDIA_SOURCE.URL: {
      const [extra, taken] = spreadRaw(block.raw, ['image_url']);
      return { ...extra, type: 'image_url', image_url: { ...(taken.image_url ?? {}), url: source.url } };
    }
    case MEDIA_SOURCE.BASE64: {
      if (isImageMediaType(source.mediaType) || source.mediaType === null) {
        const [extra, taken] = spreadRaw(block.raw, ['image_url']);
        const url = `data:${source.mediaType ?? ''};base64,${source.data ?? ''}`;
        return { ...extra, type: 'image_url', image_url: { ...(taken.image_url ?? {}), url } };
      }
      const [extra, taken] = spreadRaw(block.raw, ['input_audio']);
      const format = String(source.mediaType ?? '').split('/')[1] ?? null;
      return {
        ...extra,
        type: 'input_audio',
        input_audio: { ...(taken.input_audio ?? {}), data: source.data, ...(format !== null ? { format } : {}) },
      };
    }
    case MEDIA_SOURCE.TEXT: {
      const [extra, taken] = spreadRaw(block.raw, ['file']);
      const fileData = source.mediaType !== null ? `data:${source.mediaType};base64,${source.data ?? ''}` : source.data;
      return { ...extra, type: 'file', file: { ...(taken.file ?? {}), file_data: fileData } };
    }
    case MEDIA_SOURCE.ID:
    default: {
      const [extra, taken] = spreadRaw(block.raw, ['file']);
      return { ...extra, type: 'file', file: { ...(taken.file ?? {}), file_id: source.id } };
    }
  }
}

// -- tool calls and results --------------------------------------------------

function toolCallToCanonical(call) {
  const fn = isObject(call.function) ? call.function : {};
  let input = {};
  const raw = rest(call, TOOL_CALL_KEYS);
  const fnExtra = rest(fn, FUNCTION_CALL_KEYS);
  if (Object.keys(fnExtra).length > 0) raw.function = fnExtra;

  // Arguments are a JSON string on the wire; canonical wants the parsed
  // object, and the exact string is kept in raw so fromCanonical can be
  // byte-identical rather than re-serializing (key order, whitespace) a
  // JSON.parse of it — a re-serialized object is not the same string.
  if (typeof fn.arguments === 'string') {
    raw.arguments = fn.arguments;
    try {
      input = fn.arguments === '' ? {} : JSON.parse(fn.arguments);
      if (!isObject(input)) input = {};
    } catch {
      input = {};
    }
  }

  // Chat Completions has no built-in provider tools of its own, but a
  // gateway sitting in front of an OpenAI-compatible surface can still see a
  // non-"function" tool_calls[].type. Such a call is provider-executed and
  // has no schema, the same treatment Anthropic's server_tool_use gets.
  const kind = call.type === undefined || call.type === 'function' ? TOOL_KIND.FUNCTION : TOOL_KIND.PROVIDER;
  if (kind === TOOL_KIND.PROVIDER) raw.type = call.type;

  return toolCallBlock({
    id: call.id,
    name: kind === TOOL_KIND.FUNCTION ? fn.name : call.type,
    input,
    kind,
    raw,
  });
}

function toolCallFromCanonical(block) {
  const [extra, taken] = spreadRaw(block.raw, ['type', 'function', 'arguments']);
  const argsFromRaw = typeof taken.arguments === 'string' ? taken.arguments : null;
  return {
    ...extra,
    id: block.id,
    type: 'type' in taken ? taken.type : 'function',
    function: {
      ...(taken.function ?? {}),
      name: block.name,
      arguments: argsFromRaw ?? JSON.stringify(block.input ?? {}),
    },
  };
}

/**
 * A `{role: "tool", tool_call_id, content}` message is a tool result, not a
 * turn of its own — see Phase 0 decisions. It becomes a ROLE.USER message
 * wrapping one toolResultBlock, the same nesting Anthropic uses.
 */
function toolMessageToCanonical(msg) {
  const raw = rest(msg, MESSAGE_KEYS);
  // Chat Completions never sends a `tool` message's content as a structured
  // object — it is always string | parts[] — so ordinary text is the honest
  // reading of it; a canonical BLOCK.JSON tool result never originates here.
  const result = toolResultBlock({
    callId: msg.tool_call_id,
    name: null, // resolved once per request by the caller, which has the call list
    content: contentToCanonical(msg.content),
    isError: false,
    kind: TOOL_KIND.FUNCTION,
    raw,
  });
  return makeMessage({ role: ROLE.USER, content: [result] });
}

function toolMessageFromCanonical(msg) {
  const [result] = msg.content;
  const [extra, taken] = spreadRaw(result.raw, ['role']);
  return {
    ...extra,
    role: 'role' in taken ? taken.role : 'tool',
    tool_call_id: result.callId,
    content: result.content.length === 1 && result.content[0].type === BLOCK.TEXT
      ? result.content[0].text
      : result.content.map(blockToPart).map((p) => (p.type === 'text' ? p.text : p)).join(''),
  };
}

/** True for a ROLE.USER message that is exactly the shape toolMessageToCanonical produces. */
const isToolResultMessage = (msg) =>
  msg.role === ROLE.USER && msg.content.length === 1 && msg.content[0].type === BLOCK.TOOL_RESULT;

/** Every tool call name in a request, by id — used to resolve a result's `name`. */
function toolNamesIn(messages) {
  const names = new Map();
  if (!Array.isArray(messages)) return names;
  for (const msg of messages) {
    if (!isObject(msg) || !Array.isArray(msg.tool_calls)) continue;
    for (const call of msg.tool_calls) {
      if (!isObject(call) || call.id == null) continue;
      const name = isObject(call.function) ? call.function.name : undefined;
      if (name != null) names.set(call.id, name);
    }
  }
  return names;
}

// -- messages -----------------------------------------------------------------

function assistantMessageToCanonical(msg) {
  const raw = rest(msg, MESSAGE_KEYS);
  const content = contentToCanonical(msg.content);
  if (Array.isArray(msg.tool_calls)) {
    for (const call of msg.tool_calls) content.push(toolCallToCanonical(call));
  }
  if (typeof msg.refusal === 'string') raw.refusal = msg.refusal;
  return makeMessage({ role: ROLE.ASSISTANT, content, raw });
}

function messageToCanonical(msg, toolNames) {
  if (!isObject(msg)) return makeMessage({ role: ROLE.USER, content: [unknownBlock(msg)] });
  if (msg.role === 'tool') return toolMessageToCanonical(msg, toolNames);
  if (msg.role === ROLE.ASSISTANT) return assistantMessageToCanonical(msg);

  const raw = rest(msg, MESSAGE_KEYS);
  // A mid-thread system/developer message is ROLE.SYSTEM; the leading one is
  // pulled out into request.system by requestToCanonical before this runs.
  // `developer` is this adapter's own default spelling for it (see
  // messageFromCanonical), so only a non-default spelling needs to be kept.
  const isSystem = SYSTEM_ROLES.has(msg.role);
  if (isSystem && msg.role !== 'developer') raw.role = msg.role;
  if (!isSystem && msg.role !== ROLE.USER) raw.role = msg.role;
  const role = isSystem ? ROLE.SYSTEM : ROLE.USER;
  return makeMessage({ role, content: contentToCanonical(msg.content), raw });
}

function messageFromCanonical(msg) {
  if (isToolResultMessage(msg)) return toolMessageFromCanonical(msg);

  if (msg.role === ROLE.ASSISTANT) {
    const [extra, taken] = spreadRaw(msg.raw, ['refusal']);
    const textParts = msg.content.filter((b) => b.type !== BLOCK.TOOL_CALL);
    const calls = msg.content.filter((b) => b.type === BLOCK.TOOL_CALL);
    const out = { ...extra, role: ROLE.ASSISTANT };
    out.content = textParts.length === 0 ? null : textParts.map(blockToPart);
    if (calls.length > 0) out.tool_calls = calls.map(toolCallFromCanonical);
    if ('refusal' in taken) out.refusal = taken.refusal;
    return out;
  }

  const [extra, taken] = spreadRaw(msg.raw, ['role']);
  const role = 'role' in taken ? taken.role : msg.role === ROLE.SYSTEM ? 'developer' : msg.role;
  return { ...extra, role, content: msg.content.map(blockToPart) };
}

// -- tools --------------------------------------------------------------------

function toolToCanonical(tool) {
  if (!isObject(tool)) return toolDefinition({ name: String(tool), raw: { unmodeled: tool } });
  const fn = isObject(tool.function) ? tool.function : {};
  const raw = rest(tool, FUNCTION_TOOL_KEYS);
  const fnExtra = rest(fn, FUNCTION_DEF_KEYS);
  if (Object.keys(fnExtra).length > 0) raw.function = fnExtra;
  if (tool.type !== undefined && tool.type !== 'function') raw.type = tool.type;
  if (typeof fn.strict === 'boolean') raw.strict = fn.strict;

  // OpenAI's built-in tools (web_search, code_interpreter, ...) are not
  // `{type:"function", function:{...}}`-shaped at all on Chat Completions; a
  // tool of an unrecognized type has no schema this adapter can read.
  const kind = tool.type === undefined || tool.type === 'function' ? TOOL_KIND.FUNCTION : TOOL_KIND.PROVIDER;

  return toolDefinition({
    name: kind === TOOL_KIND.FUNCTION ? fn.name : tool.type,
    description: fn.description ?? null,
    parameters: kind === TOOL_KIND.FUNCTION ? fn.parameters ?? null : null,
    kind,
    raw,
  });
}

function toolFromCanonical(tool) {
  if (tool.kind === TOOL_KIND.PROVIDER) {
    const [extra, taken] = spreadRaw(tool.raw, ['type']);
    return { ...extra, type: 'type' in taken ? taken.type : tool.name };
  }
  const [extra, { function: fnExtra, strict }] = spreadRaw(tool.raw, ['function', 'strict']);
  return {
    ...extra,
    type: 'function',
    function: {
      ...(fnExtra ?? {}),
      name: tool.name,
      ...(tool.description !== null ? { description: tool.description } : {}),
      ...(tool.parameters !== null ? { parameters: tool.parameters } : {}),
      ...(typeof strict === 'boolean' ? { strict } : {}),
    },
  };
}

/**
 * `parallel_tool_calls` is request-level on the wire, but canonical's home for
 * "may the model call more than one tool at once" is `toolChoice.allowParallel`
 * (Anthropic's `disable_parallel_tool_use` already lives there). A request with
 * no `tool_choice` still needs a canonical toolChoice object when
 * `parallel_tool_calls` is present, so the permission has somewhere to live.
 */
function toolChoiceToCanonical(choice, allowParallel) {
  if (choice === undefined || choice === null) {
    return allowParallel === null ? null : makeToolChoice({ mode: TOOL_CHOICE.AUTO, allowParallel });
  }
  if (choice === 'auto') return makeToolChoice({ mode: TOOL_CHOICE.AUTO, allowParallel });
  if (choice === 'required') return makeToolChoice({ mode: TOOL_CHOICE.REQUIRED, allowParallel });
  if (choice === 'none') return makeToolChoice({ mode: TOOL_CHOICE.NONE, allowParallel });
  if (isObject(choice) && choice.type === 'function' && isObject(choice.function)) {
    return makeToolChoice({
      mode: TOOL_CHOICE.TOOL,
      names: [choice.function.name],
      allowParallel,
      raw: rest(choice, TOOL_CHOICE_FUNCTION_KEYS),
    });
  }
  return null;
}

function toolChoiceFromCanonical(choice) {
  if (choice.mode === TOOL_CHOICE.TOOL) {
    const forced = choice.names !== null ? choice.names[0] : null;
    return { ...(choice.raw ?? {}), type: 'function', function: { name: forced } };
  }
  return { [TOOL_CHOICE.AUTO]: 'auto', [TOOL_CHOICE.REQUIRED]: 'required', [TOOL_CHOICE.NONE]: 'none' }[choice.mode];
}

function reasoningToCanonical(effort) {
  if (typeof effort !== 'string') return null;
  return reasoningConfig({ enabled: true, effort, budgetTokens: null });
}

function reasoningFromCanonical(reasoning) {
  return reasoning.effort;
}

const FORMAT_TO_CANONICAL = { text: RESPONSE_FORMAT.TEXT, json_object: RESPONSE_FORMAT.JSON, json_schema: RESPONSE_FORMAT.JSON_SCHEMA };
const FORMAT_FROM_CANONICAL = {
  [RESPONSE_FORMAT.TEXT]: 'text',
  [RESPONSE_FORMAT.JSON]: 'json_object',
  [RESPONSE_FORMAT.JSON_SCHEMA]: 'json_schema',
};

function formatToCanonical(format) {
  if (!isObject(format)) return null;
  const kind = FORMAT_TO_CANONICAL[format.type];
  if (kind === undefined) return null;
  const raw = rest(format, FORMAT_KEYS);
  let schema = null;
  if (kind === RESPONSE_FORMAT.JSON_SCHEMA) {
    if (!isObject(format.json_schema) || format.json_schema.schema == null) return null;
    schema = format.json_schema.schema;
    const schemaExtra = rest(format.json_schema, JSON_SCHEMA_KEYS);
    if (Object.keys(schemaExtra).length > 0) raw.json_schema = schemaExtra;
    if (typeof format.json_schema.name === 'string') raw.name = format.json_schema.name;
    if (typeof format.json_schema.strict === 'boolean') raw.strict = format.json_schema.strict;
    if (typeof format.json_schema.description === 'string') raw.description = format.json_schema.description;
  }
  return makeResponseFormat({ kind, schema, raw });
}

function formatFromCanonical(format) {
  const [extra, { name, strict, description }] = spreadRaw(format.raw, ['name', 'strict', 'description']);
  if (format.kind !== RESPONSE_FORMAT.JSON_SCHEMA) {
    return { ...extra, type: FORMAT_FROM_CANONICAL[format.kind] };
  }
  return {
    ...extra,
    type: 'json_schema',
    json_schema: {
      name: name ?? 'response',
      ...(description !== undefined ? { description } : {}),
      schema: format.schema,
      ...(strict !== undefined ? { strict } : {}),
    },
  };
}

// -- usage, stop reason, error ------------------------------------------------

/**
 * `prompt_tokens` is inclusive of cached tokens; canonical's `inputTokens`
 * excludes them, so this subtracts. `outputTokens` is already inclusive of
 * reasoning. `cacheWriteTokens` is null: OpenAI's caching is automatic and
 * unreported, which is not the same as zero (invariant 6).
 */
function usageToCanonical(u) {
  if (!isObject(u)) return null;
  const promptTokens = numOrNull(u.prompt_tokens);
  const cacheReadTokens = isObject(u.prompt_tokens_details) ? numOrNull(u.prompt_tokens_details.cached_tokens) : null;
  const raw = rest(u, USAGE_KEYS);
  if (isObject(u.prompt_tokens_details)) {
    const extra = rest(u.prompt_tokens_details, PROMPT_DETAILS_KEYS);
    if (Object.keys(extra).length > 0) raw.prompt_tokens_details = extra;
  }
  if (isObject(u.completion_tokens_details)) {
    const extra = rest(u.completion_tokens_details, COMPLETION_DETAILS_KEYS);
    if (Object.keys(extra).length > 0) raw.completion_tokens_details = extra;
  }
  return makeUsage({
    inputTokens: promptTokens !== null && cacheReadTokens !== null ? promptTokens - cacheReadTokens : promptTokens,
    outputTokens: numOrNull(u.completion_tokens),
    cacheReadTokens,
    cacheWriteTokens: null,
    reasoningTokens: isObject(u.completion_tokens_details) ? numOrNull(u.completion_tokens_details.reasoning_tokens) : null,
    totalTokens: numOrNull(u.total_tokens),
    raw,
  });
}

function usageFromCanonical(u) {
  const [extra, taken] = spreadRaw(u.raw, ['prompt_tokens_details', 'completion_tokens_details']);
  const out = { ...extra };
  const promptTokens =
    u.inputTokens !== null ? u.inputTokens + (u.cacheReadTokens ?? 0) : u.cacheReadTokens !== null ? u.cacheReadTokens : null;
  if (promptTokens !== null) out.prompt_tokens = promptTokens;
  if (u.outputTokens !== null) out.completion_tokens = u.outputTokens;
  if (u.totalTokens !== null) out.total_tokens = u.totalTokens;
  if (u.cacheReadTokens !== null || taken.prompt_tokens_details !== undefined) {
    out.prompt_tokens_details = { ...(taken.prompt_tokens_details ?? {}), ...(u.cacheReadTokens !== null ? { cached_tokens: u.cacheReadTokens } : {}) };
  }
  if (u.reasoningTokens !== null || taken.completion_tokens_details !== undefined) {
    out.completion_tokens_details = {
      ...(taken.completion_tokens_details ?? {}),
      ...(u.reasoningTokens !== null ? { reasoning_tokens: u.reasoningTokens } : {}),
    };
  }
  return out;
}

const STOP_TO_CANONICAL = {
  stop: STOP_REASON.END_TURN,
  length: STOP_REASON.MAX_TOKENS,
  tool_calls: STOP_REASON.TOOL_CALL,
  function_call: STOP_REASON.TOOL_CALL,
  content_filter: STOP_REASON.CONTENT_FILTER,
};
const STOP_FROM_CANONICAL = {
  [STOP_REASON.END_TURN]: 'stop',
  [STOP_REASON.MAX_TOKENS]: 'length',
  [STOP_REASON.STOP_SEQUENCE]: 'stop',
  [STOP_REASON.TOOL_CALL]: 'tool_calls',
  [STOP_REASON.CONTENT_FILTER]: 'content_filter',
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

// -- request ------------------------------------------------------------------

export function requestToCanonical(body) {
  if (!isObject(body)) throw new TypeError('openai: request body must be a JSON object');
  if (!Array.isArray(body.messages)) throw new TypeError('openai: request messages must be an array');

  const raw = rest(body, REQUEST_KEYS);
  const toolNames = toolNamesIn(body.messages);

  // A leading system/developer message is the system prompt; canonical splits
  // it out the way Anthropic's own `system` field already works. Anything
  // system/developer-shaped after position 0 stays a ROLE.SYSTEM message.
  let messages = body.messages;
  let system = null;
  if (messages.length > 0 && isObject(messages[0]) && SYSTEM_ROLES.has(messages[0].role)) {
    system = contentToCanonical(messages[0].content);
    if (messages[0].role === 'system') raw.leadingSystemRole = 'system';
    messages = messages.slice(1);
  }

  const format = formatToCanonical(body.response_format);
  if (body.response_format !== undefined && format === null) raw.response_format = body.response_format;

  const streamOptions = isObject(body.stream_options) ? body.stream_options : null;
  if (streamOptions !== null) raw.stream_options = streamOptions;

  return makeRequest({
    model: body.model ?? null,
    system,
    messages: messages.map((msg) => messageToCanonicalWithNames(msg, toolNames)),
    tools: Array.isArray(body.tools) ? body.tools.map(toolToCanonical) : null,
    toolChoice: toolChoiceToCanonical(body.tool_choice, typeof body.parallel_tool_calls === 'boolean' ? body.parallel_tool_calls : null),
    params: generationParams({
      maxOutputTokens: numOrNull(body.max_completion_tokens),
      temperature: numOrNull(body.temperature),
      topP: numOrNull(body.top_p),
      stopSequences: Array.isArray(body.stop) ? [...body.stop] : typeof body.stop === 'string' ? [body.stop] : null,
      reasoning: reasoningToCanonical(body.reasoning_effort),
      format,
    }),
    stream: body.stream === true,
    userId: body.user ?? null,
    raw,
  });
}

/** A tool result's `name` is resolved once per request, from the call list. */
function messageToCanonicalWithNames(msg, toolNames) {
  if (isObject(msg) && msg.role === 'tool') {
    const message = toolMessageToCanonical(msg);
    const [result] = message.content;
    const name = toolNames.get(msg.tool_call_id) ?? null;
    if (name === result.name) return message;
    return makeMessage({ role: message.role, content: [toolResultBlock({ ...result, name })] });
  }
  return messageToCanonical(msg, toolNames);
}

export function requestFromCanonical(req) {
  const [out, { leadingSystemRole, stream_options: streamOptions }] = spreadRaw(req.raw, ['leadingSystemRole', 'stream_options']);
  const { params } = req;

  out.model = req.model;
  if (params.maxOutputTokens !== null) out.max_completion_tokens = params.maxOutputTokens;

  const leading =
    req.system !== null
      ? [{ role: leadingSystemRole ?? 'developer', content: req.system.map(blockToPart) }]
      : [];
  out.messages = [...leading, ...req.messages.map(messageFromCanonical)];

  if (req.tools !== null) out.tools = req.tools.map(toolFromCanonical);
  if (req.toolChoice !== null) {
    out.tool_choice = toolChoiceFromCanonical(req.toolChoice);
    if (req.toolChoice.allowParallel !== null) out.parallel_tool_calls = req.toolChoice.allowParallel;
  }
  if (params.temperature !== null) out.temperature = params.temperature;
  if (params.topP !== null) out.top_p = params.topP;
  if (params.stopSequences !== null) out.stop = [...params.stopSequences];
  if (params.reasoning !== null) out.reasoning_effort = reasoningFromCanonical(params.reasoning);
  if (params.format !== null) out.response_format = formatFromCanonical(params.format);
  if (req.stream) out.stream = true;
  if (streamOptions !== undefined) out.stream_options = streamOptions;
  if (req.userId !== null) out.user = req.userId;
  return out;
}

// -- response -----------------------------------------------------------------

export function responseToCanonical(body) {
  if (!isObject(body)) throw new TypeError('openai: response body must be a JSON object');
  if (isObject(body.error) || (body.error !== undefined && !Array.isArray(body.choices))) {
    return makeResponse({ error: errorToCanonical(body.error), raw: rest(body, new Set(['error'])) });
  }
  return choiceToCanonicalResponse(body);
}

function choiceToCanonicalResponse(body, { error = null } = {}) {
  const raw = rest(body, RESPONSE_KEYS);
  const choices = Array.isArray(body.choices) ? body.choices : [];
  if (choices.length > 1) raw.choices = choices.slice(1);
  const [choice] = choices;
  const message = isObject(choice) && isObject(choice.message) ? choice.message : {};
  const choiceExtra = isObject(choice) ? rest(choice, CHOICE_KEYS) : {};
  if (Object.keys(choiceExtra).length > 0) raw.choice = choiceExtra;

  let stopReason = null;
  const finishReason = isObject(choice) ? choice.finish_reason : null;
  if (finishReason != null) {
    stopReason = STOP_TO_CANONICAL[finishReason] ?? STOP_REASON.OTHER;
    if (stopReason === STOP_REASON.OTHER) raw.finish_reason = finishReason;
  }

  const content = contentToCanonical(message.content);
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) content.push(toolCallToCanonical(call));
  }
  if (typeof message.refusal === 'string') raw.refusal = message.refusal;
  const messageExtra = rest(message, MESSAGE_KEYS);
  if (Object.keys(messageExtra).length > 0) raw.message = messageExtra;

  return makeResponse({
    id: body.id ?? null,
    model: body.model ?? null,
    role: ROLE.ASSISTANT,
    content,
    stopReason,
    stopSequence: null,
    usage: usageToCanonical(body.usage),
    error,
    raw,
  });
}

export function responseFromCanonical(res) {
  if (res.error !== null && res.content.length === 0 && res.id === null) {
    return { ...(res.raw ?? {}), error: errorFromCanonical(res.error) };
  }
  const [out, { choice: choiceExtra, message: messageExtra, refusal, finish_reason: rawFinish, choices: extraChoices }] =
    spreadRaw(res.raw, ['choice', 'message', 'refusal', 'finish_reason', 'choices']);

  out.id = res.id;
  out.object = 'chat.completion';
  out.model = res.model;

  const textParts = res.content.filter((b) => b.type !== BLOCK.TOOL_CALL);
  const calls = res.content.filter((b) => b.type === BLOCK.TOOL_CALL);
  const message = {
    ...(messageExtra ?? {}),
    role: ROLE.ASSISTANT,
    content: textParts.length === 0 ? null : textParts.map(blockToPart).map((p) => (p.type === 'text' ? p.text : p)).join(''),
  };
  if (calls.length > 0) message.tool_calls = calls.map(toolCallFromCanonical);
  if (refusal !== undefined) message.refusal = refusal;

  const finishReason = res.stopReason === STOP_REASON.OTHER ? rawFinish ?? null : STOP_FROM_CANONICAL[res.stopReason] ?? null;
  const choice = { ...(choiceExtra ?? {}), index: 0, message, finish_reason: finishReason };
  out.choices = extraChoices !== undefined ? [choice, ...extraChoices] : [choice];
  if (res.usage !== null) out.usage = usageFromCanonical(res.usage);
  return out;
}

// -- streaming ----------------------------------------------------------------

/**
 * Accumulate OpenAI stream chunks into the completion they describe.
 *
 * OpenAI's stream has no explicit block lifecycle: text arrives as
 * `delta.content` fragments with no index at all, and tool-call arguments
 * arrive as string fragments keyed by `tool_calls[].index`, concatenated here
 * before being parsed once at the end. The accumulator rebuilds the wire-form
 * completion and converts once via `choiceToCanonicalResponse`, exactly like
 * the Anthropic accumulator — so a streamed turn and the same turn unstreamed
 * produce identical canonical objects by construction.
 *
 * Usage arrives only in a final, choice-less chunk, and only if the client
 * sent `stream_options.include_usage` — the gateway never adds that flag
 * (invariant 7), so its absence here is the client's choice, not a gap.
 */
export function createStreamAccumulator() {
  let id = null;
  let model = null;
  let text = '';
  let sawText = false;
  let refusal = null;
  /** @type {Map<number, { id: string|null, name: string|null, arguments: string }>} */
  const calls = new Map();
  let finishReason = null;
  let usage = null;
  let error = null;
  let done = false;
  const warnings = [];

  const warn = (note) => {
    if (warnings.length < 32) warnings.push(note);
  };

  const applyDelta = (delta) => {
    if (!isObject(delta)) return;
    if (typeof delta.content === 'string') {
      text += delta.content;
      sawText = true;
    }
    if (typeof delta.refusal === 'string') refusal = (refusal ?? '') + delta.refusal;
    if (Array.isArray(delta.tool_calls)) {
      for (const fragment of delta.tool_calls) {
        if (!isObject(fragment) || typeof fragment.index !== 'number') {
          warn('tool call fragment missing an index');
          continue;
        }
        const entry = calls.get(fragment.index) ?? { id: null, name: null, arguments: '' };
        if (typeof fragment.id === 'string') entry.id = fragment.id;
        const fn = isObject(fragment.function) ? fragment.function : {};
        if (typeof fn.name === 'string') entry.name = fn.name;
        if (typeof fn.arguments === 'string') entry.arguments += fn.arguments;
        calls.set(fragment.index, entry);
      }
    }
  };

  const buildBody = () => {
    if (id === null) return null;
    const message = { role: ROLE.ASSISTANT };
    if (sawText || calls.size === 0) message.content = text;
    if (refusal !== null) message.refusal = refusal;
    if (calls.size > 0) {
      const indexes = [...calls.keys()].sort((a, b) => a - b);
      message.tool_calls = indexes.map((i) => {
        const call = calls.get(i);
        return { id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } };
      });
    }
    return {
      id,
      object: 'chat.completion',
      model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      ...(usage !== null ? { usage } : {}),
    };
  };

  return {
    /** Feed one event: a parsed chunk object, or an SSE record from the decoder. */
    push(input) {
      // Either a parsed chunk object (a test, or a caller that already decoded
      // JSON) or an SSE record from the decoder — the same duality
      // adapters/anthropic.js's accumulator accepts.
      const isParsedChunk =
        isObject(input) &&
        (input.object === 'chat.completion.chunk' || Array.isArray(input.choices) || isObject(input.error));
      if (isParsedChunk) {
        applyChunk(input);
        return;
      }
      if (input?.data === '[DONE]') {
        done = true;
        return;
      }
      const chunk = sseData(input);
      if (chunk === null) {
        if (!(isObject(input) && input.data === '')) warn(`unparseable stream chunk`);
        return;
      }
      applyChunk(chunk);
    },

    message: buildBody,

    result() {
      const wire = buildBody();
      if (wire === null) {
        return makeResponse({ error: error === null ? null : errorToCanonical(error) });
      }
      return choiceToCanonicalResponse(wire, { error: error === null ? null : errorToCanonical(error) });
    },

    state() {
      return { complete: done && finishReason !== null && error === null, stopped: done, failed: error !== null, warnings: [...warnings] };
    },
  };

  function applyChunk(chunk) {
    if (isObject(chunk.error)) {
      error = chunk.error;
      return;
    }
    if (id === null && typeof chunk.id === 'string') id = chunk.id;
    if (model === null && typeof chunk.model === 'string') model = chunk.model;
    if (isObject(chunk.usage)) usage = chunk.usage;

    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const [choice] = choices;
    if (!isObject(choice)) return;
    applyDelta(choice.delta);
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
  }
}

/** Convenience over `createStreamAccumulator`: events in, one canonical response out. */
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
