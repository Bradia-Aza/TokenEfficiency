// The fixture harness: fixture in -> assert canonical shape -> assert round-trip
// out. Every future adapter is held to this, so it stays adapter-agnostic — it
// is handed `toCanonical`/`fromCanonical` and imports only `canonical/`.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BLOCK,
  MEDIA_SOURCE,
  REASONING_EFFORT,
  RESPONSE_FORMAT,
  ROLE,
  STOP_REASON,
  TOOL_CHOICE,
  TOOL_KIND,
} from '../canonical/index.js';

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// --- semantic equality ------------------------------------------------------
//
// The exit criterion is that the round trip is *semantically* equal, not
// byte-equal. Anthropic's wire format has a few spellings that mean exactly the
// same thing, and an adapter that normalizes them has lost nothing. Each
// equivalence below is listed explicitly; anything not on this list has to come
// back deep-equal, so a real dropped field is still a failing assertion.

/** Fields where a bare string is shorthand for a single text block. */
const STRING_SUGAR_FIELDS = new Set(['system', 'content']);
/** Fields whose absence means exactly `false`. */
const FALSE_IS_ABSENT_FIELDS = new Set(['is_error', 'stream']);

/**
 * Rewrite a wire body into its canonical spelling:
 *   1. `"text"` where a block list is allowed  ==  `[{type:"text",text:"text"}]`
 *   2. an explicit `null`                      ==  the key being absent
 *   3. `is_error: false` / `stream: false`     ==  the key being absent
 */
export function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!isObject(value)) return value;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null || raw === undefined) continue;
    if (raw === false && FALSE_IS_ABSENT_FIELDS.has(key)) continue;
    if (typeof raw === 'string' && STRING_SUGAR_FIELDS.has(key)) {
      out[key] = [{ type: 'text', text: raw }];
      continue;
    }
    out[key] = normalize(raw);
  }
  return out;
}

export function assertSemanticEqual(actual, expected, message) {
  assert.deepEqual(normalize(actual), normalize(expected), message);
}

/**
 * Build an adapter's own semantic-equality checker. Invariant 8 (see
 * OPENAI_ADAPTER_PLAN.md): each adapter owns its own equivalence list, because
 * a shared one is how one provider's sloppy spellings become every provider's
 * allowed sloppiness. `stringSugarFields` are fields where a bare string is
 * shorthand for a single text part; `falseIsAbsentFields` are fields whose
 * absence means exactly `false`.
 */
export function makeNormalizer({ stringSugarFields = [], falseIsAbsentFields = [] } = {}) {
  const sugar = new Set(stringSugarFields);
  const absentFalse = new Set(falseIsAbsentFields);

  function normalizeWith(value) {
    if (Array.isArray(value)) return value.map(normalizeWith);
    if (!isObject(value)) return value;
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
      if (raw === null || raw === undefined) continue;
      if (raw === false && absentFalse.has(key)) continue;
      if (typeof raw === 'string' && sugar.has(key)) {
        out[key] = [{ type: 'text', text: raw }];
        continue;
      }
      out[key] = normalizeWith(raw);
    }
    return out;
  }

  return {
    normalize: normalizeWith,
    assertSemanticEqual(actual, expected, message) {
      assert.deepEqual(normalizeWith(actual), normalizeWith(expected), message);
    },
  };
}

// --- loading ----------------------------------------------------------------

const readJson = (dir, file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
const readText = (dir, file) => readFileSync(join(dir, file), 'utf8');

/**
 * The corpus, grouped by kind. A stream fixture's `.expected.json` is the
 * non-streamed message the stream describes; a stream with no expectation (one
 * that fails partway) is asserted directly by its own test.
 *
 * Each adapter owns its own corpus directory — `fixtures/` for Anthropic,
 * `fixtures/openai/` for OpenAI — so one provider's fixtures are never fed
 * through another provider's adapter. `subdir` is relative to `fixtures/`.
 */
export function loadFixtures(subdir = '.') {
  const dir = join(FIXTURE_ROOT, subdir);
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const requests = [];
  const responses = [];
  const streams = [];

  for (const file of files) {
    if (file.endsWith('.expected.json')) continue;
    if (file.startsWith('request-') && file.endsWith('.json')) {
      requests.push({ name: file.replace(/\.json$/, ''), body: readJson(dir, file) });
    } else if (file.startsWith('response-') && file.endsWith('.json')) {
      responses.push({ name: file.replace(/\.json$/, ''), body: readJson(dir, file) });
    } else if (file.endsWith('.sse')) {
      const name = file.replace(/\.sse$/, '');
      const expectedFile = `${name}.expected.json`;
      streams.push({
        name,
        sse: readText(dir, file),
        expected: files.includes(expectedFile) ? readJson(dir, expectedFile) : null,
      });
    }
  }

  assert.ok(requests.length > 0 && responses.length > 0 && streams.length > 0, 'fixture corpus is incomplete');
  return { requests, responses, streams };
}

// --- assertions the adapters share -----------------------------------------

/**
 * The core claim of Phase 2: `fromCanonical(toCanonical(x))` means the same
 * thing as `x`, and what a plugin sees along the way is frozen.
 *
 * `assertEqual` defaults to Anthropic's own semantic-equality list; a second
 * adapter passes its own (see `makeNormalizer`) rather than sharing it —
 * invariant 8.
 */
export function assertRoundTrip({ name, body, kind, toCanonical, fromCanonical, assertEqual = assertSemanticEqual }) {
  const canonical = toCanonical(body);
  assertDeeplyFrozen(canonical, name);
  if (kind !== undefined) assertCanonicalShape(canonical, kind, name);
  assertEqual(fromCanonical(canonical), body, `${name}: round trip lost or changed a field`);
  return canonical;
}

/** Walk a canonical object and assert nothing anywhere in it is writable. */
export function assertDeeplyFrozen(value, path = '$') {
  if (value === null || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value), `${path} is not frozen`);
  for (const key of Object.keys(value)) assertDeeplyFrozen(value[key], `${path}.${key}`);
}

// --- canonical shape --------------------------------------------------------
//
// The middle leg of the harness Phase 5 calls for: fixture in -> assert
// canonical shape -> assert round-trip out. It validates against `canonical/`
// alone and imports no adapter, so the adapter written next is held to the same
// structure this one is, and a field quietly added on one side of the model is
// a failure rather than a surprise for the next author.
//
// It is strict about keys in both directions. A missing field is a hole; an
// extra field is an adapter smuggling provider surplus into the shared model
// instead of into `raw`, which is the failure mode the neutrality work exists
// to catch.

const values = (enumObject) => new Set(Object.values(enumObject));

/** Field checkers. Each is `(value, path) => void`, throwing through `assert`. */
const check = {
  any: () => {},
  string: (v, p) => assert.equal(typeof v, 'string', `${p} must be a string`),
  boolean: (v, p) => assert.equal(typeof v, 'boolean', `${p} must be a boolean`),
  object: (v, p) => assert.ok(isObject(v), `${p} must be an object`),
  nullableString: (v, p) => assert.ok(v === null || typeof v === 'string', `${p} must be a string or null`),
  nullableNumber: (v, p) =>
    assert.ok(v === null || (typeof v === 'number' && Number.isFinite(v)), `${p} must be a finite number or null`),
  nullableBoolean: (v, p) => assert.ok(v === null || typeof v === 'boolean', `${p} must be a boolean or null`),
  /** `raw` is the adapter's own bag: any shape, or absent. */
  raw: (v, p) => assert.ok(v === null || typeof v === 'object', `${p} must be an object or null`),
};

const oneOfSet = (allowed) => (v, p) =>
  assert.ok(allowed.has(v), `${p} must be one of ${[...allowed].join('|')}, got ${JSON.stringify(v)}`);

const nullableOneOf = (allowed) => (v, p) => {
  if (v !== null) oneOfSet(allowed)(v, p);
};

const listOf = (item) => (v, p) => {
  assert.ok(Array.isArray(v), `${p} must be an array`);
  v.forEach((entry, i) => item(entry, `${p}[${i}]`));
};

const nullableListOf = (item) => (v, p) => {
  if (v !== null) listOf(item)(v, p);
};

const nullable = (inner) => (v, p) => {
  if (v !== null) inner(v, p);
};

/**
 * Assert an object has exactly `fields`' keys, each satisfying its checker.
 * @param {Record<string, (v: unknown, p: string) => void>} fields
 */
const shape = (name, fields) => (value, path) => {
  assert.ok(isObject(value), `${path} must be an object (${name})`);
  assert.ok(Object.isFrozen(value), `${path} must be frozen (${name})`);
  assert.deepEqual(
    Object.keys(value).sort(),
    Object.keys(fields).sort(),
    `${path} does not have the canonical ${name} fields`,
  );
  for (const [key, checker] of Object.entries(fields)) checker(value[key], `${path}.${key}`);
};

const cacheShape = nullable(shape('cache breakpoint', { ttlSeconds: check.nullableNumber, raw: check.raw }));

const mediaSourceShape = shape('media source', {
  kind: oneOfSet(values(MEDIA_SOURCE)),
  mediaType: check.nullableString,
  data: check.nullableString,
  url: check.nullableString,
  id: check.nullableString,
});

const BLOCK_SHAPES = {
  [BLOCK.TEXT]: { type: check.string, text: check.string, cache: cacheShape, raw: check.raw },
  [BLOCK.THINKING]: {
    type: check.string,
    thinking: check.string,
    signature: check.nullableString,
    redacted: check.boolean,
    cache: cacheShape,
    raw: check.raw,
  },
  [BLOCK.TOOL_CALL]: {
    type: check.string,
    id: check.string,
    name: check.string,
    input: check.object,
    kind: oneOfSet(values(TOOL_KIND)),
    cache: cacheShape,
    raw: check.raw,
  },
  [BLOCK.TOOL_RESULT]: {
    type: check.string,
    callId: check.string,
    name: check.nullableString,
    content: (v, p) => listOf(blockShape)(v, p),
    isError: check.boolean,
    kind: oneOfSet(values(TOOL_KIND)),
    cache: cacheShape,
    raw: check.raw,
  },
  [BLOCK.JSON]: { type: check.string, data: check.any, cache: cacheShape, raw: check.raw },
  [BLOCK.MEDIA]: { type: check.string, source: mediaSourceShape, cache: cacheShape, raw: check.raw },
  [BLOCK.UNKNOWN]: { type: check.string, raw: check.any },
};

function blockShape(value, path) {
  assert.ok(isObject(value), `${path} must be a content block`);
  const fields = BLOCK_SHAPES[value.type];
  assert.ok(fields !== undefined, `${path} has unknown block type ${JSON.stringify(value.type)}`);
  shape(`${value.type} block`, fields)(value, path);
}

const messageShape = shape('message', {
  role: oneOfSet(values(ROLE)),
  content: listOf(blockShape),
  raw: check.raw,
});

const toolShape = shape('tool definition', {
  name: check.string,
  description: check.nullableString,
  parameters: (v, p) => assert.ok(v === null || isObject(v), `${p} must be a JSON Schema object or null`),
  kind: oneOfSet(values(TOOL_KIND)),
  cache: cacheShape,
  raw: check.raw,
});

const toolChoiceShape = shape('tool choice', {
  mode: oneOfSet(values(TOOL_CHOICE)),
  names: nullableListOf(check.string),
  allowParallel: check.nullableBoolean,
  raw: check.raw,
});

const reasoningShape = shape('reasoning config', {
  enabled: check.boolean,
  effort: nullableOneOf(values(REASONING_EFFORT)),
  budgetTokens: check.nullableNumber,
  raw: check.raw,
});

const formatShape = shape('response format', {
  kind: oneOfSet(values(RESPONSE_FORMAT)),
  schema: check.any,
  raw: check.raw,
});

const paramsShape = shape('generation params', {
  maxOutputTokens: check.nullableNumber,
  temperature: check.nullableNumber,
  topP: check.nullableNumber,
  topK: check.nullableNumber,
  stopSequences: nullableListOf(check.string),
  reasoning: nullable(reasoningShape),
  format: nullable(formatShape),
});

const usageShape = shape('usage', {
  inputTokens: check.nullableNumber,
  outputTokens: check.nullableNumber,
  cacheReadTokens: check.nullableNumber,
  cacheWriteTokens: check.nullableNumber,
  reasoningTokens: check.nullableNumber,
  totalTokens: check.nullableNumber,
  raw: check.raw,
});

const errorShape = shape('error', {
  type: check.nullableString,
  message: check.nullableString,
  raw: check.raw,
});

const requestShape = shape('request', {
  model: check.nullableString,
  system: nullableListOf(blockShape),
  messages: listOf(messageShape),
  tools: nullableListOf(toolShape),
  toolChoice: nullable(toolChoiceShape),
  params: paramsShape,
  stream: check.boolean,
  userId: check.nullableString,
  raw: check.raw,
});

const responseShape = shape('response', {
  id: check.nullableString,
  model: check.nullableString,
  role: oneOfSet(new Set([ROLE.USER, ROLE.ASSISTANT])),
  content: listOf(blockShape),
  stopReason: nullableOneOf(values(STOP_REASON)),
  stopSequence: check.nullableString,
  usage: nullable(usageShape),
  error: nullable(errorShape),
  raw: check.raw,
});

const SHAPES = { request: requestShape, response: responseShape };

/**
 * Assert a canonical object is exactly the shape `canonical/model.js` defines.
 *
 * @param {object} value
 * @param {'request'|'response'} kind
 */
export function assertCanonicalShape(value, kind, path = 'canonical') {
  const validator = SHAPES[kind];
  assert.ok(validator !== undefined, `unknown canonical kind ${JSON.stringify(kind)}`);
  validator(value, `${path}<${kind}>`);
}
