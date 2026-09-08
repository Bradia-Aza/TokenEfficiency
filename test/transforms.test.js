// Phase 6.2 — transforms/ and the substitution transform. No transport
// involved: canonical objects built by hand and by the anthropic adapter from
// fixtures.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { requestToCanonical } from '../adapters/anthropic.js';
import {
  message as makeMessage,
  request as makeRequest,
  textBlock,
  thinkingBlock,
  toolCallBlock,
  toolDefinition,
  toolResultBlock,
  ROLE,
} from '../canonical/index.js';
import { apply, validate } from '../transforms/index.js';
import { createSubstituteTransform, substitute, substituteText, validateDictionary } from '../transforms/substitute.js';
import { loadFixtures } from './fixture-harness.js';

const { requests } = loadFixtures();
const fixture = (name) => requests.find((r) => r.name === name).body;

describe('substituteText — matching rules', () => {
  it('matches on word boundaries only', () => {
    const dict = { iran: 'canada' };
    assert.equal(substituteText('iran', dict).text, 'canada');
    assert.equal(substituteText('Iran.', dict).text, 'Canada.');
    assert.equal(substituteText('Iranian', dict).text, 'Iranian');
    assert.equal(substituteText('sniran', dict).text, 'sniran');
    assert.equal(substituteText('sn_iran', dict).text, 'sn_iran');
  });

  it('is case-insensitive on match, case-preserving on replacement', () => {
    const dict = { iran: 'canada' };
    assert.equal(substituteText('iran', dict).text, 'canada');
    assert.equal(substituteText('Iran', dict).text, 'Canada');
    assert.equal(substituteText('IRAN', dict).text, 'CANADA');
    // Mixed case beyond those three patterns uses the value verbatim.
    assert.equal(substituteText('iRAN', dict).text, 'canada');
  });

  it('is a single left-to-right pass: replaced spans are never rescanned', () => {
    // A dictionary crafted so the replacement value itself contains a key would
    // cascade if rescanned. substituteText must not do that (disjointness is a
    // separate, startup-time concern enforced by validateDictionary).
    const dict = { a: 'ab', b: 'ba' };
    const { text, edits } = substituteText('a b', dict);
    // "a" -> "ab" (not rescanned into "a"+"b"), "b" -> "ba" (not rescanned).
    assert.equal(text, 'ab ba');
    assert.equal(edits, 2);
  });

  it('prefers the longest key when two keys overlap at the same position', () => {
    const dict = { iran: 'canada', 'iran nuclear': 'canada program' };
    assert.equal(substituteText('iran nuclear talks', dict).text, 'canada program talks');
  });

  it('is deterministic: same input and dictionary always produce the same output', () => {
    const dict = { iran: 'canada' };
    const a = substituteText('What is the capital of Iran?', dict);
    const b = substituteText('What is the capital of Iran?', dict);
    assert.deepEqual(a, b);
  });

  it('counts edits and reports zero for no match', () => {
    const dict = { iran: 'canada' };
    assert.equal(substituteText('no match here', dict).edits, 0);
    assert.equal(substituteText('iran and Iran and IRAN', dict).edits, 3);
  });
});

describe('validateDictionary — key/value disjointness', () => {
  it('rejects a value that contains a dictionary key', () => {
    assert.throws(() => validateDictionary({ iran: 'canada', canada: 'mexico' }), /contains dictionary key/);
  });

  it('rejects a key that equals its own value', () => {
    assert.throws(() => validateDictionary({ iran: 'iran' }), /maps to itself/);
  });

  it('accepts a disjoint dictionary', () => {
    assert.deepEqual(validateDictionary({ iran: 'canada' }), { iran: 'canada' });
  });
});

describe('substitute — where it applies and where it skips', () => {
  const dict = { france: 'canada' };

  it('applies to BLOCK.TEXT in messages', () => {
    const req = makeRequest({
      messages: [makeMessage({ role: ROLE.USER, content: [textBlock({ text: 'capital of France' })] })],
    });
    const { request: out, edits } = substitute(req, dict);
    assert.equal(edits, 1);
    assert.equal(out.messages[0].content[0].text, 'capital of Canada');
  });

  it('applies to text in system', () => {
    const req = makeRequest({
      system: [textBlock({ text: 'Discuss France.' })],
      messages: [makeMessage({ role: ROLE.USER, content: [textBlock({ text: 'hi' })] })],
    });
    const { request: out, edits } = substitute(req, dict);
    assert.equal(edits, 1);
    assert.equal(out.system[0].text, 'Discuss Canada.');
  });

  it('skips BLOCK.THINKING and redacted thinking — mutating invalidates the provider signature', () => {
    const req = makeRequest({
      messages: [
        makeMessage({
          role: ROLE.ASSISTANT,
          content: [
            thinkingBlock({ thinking: 'France is the target', signature: 'sig123' }),
            thinkingBlock({ redacted: true, raw: { data: 'France opaque blob' } }),
          ],
        }),
      ],
    });
    const { edits } = substitute(req, dict);
    assert.equal(edits, 0);
  });

  it('skips tool definitions (name, description, schema)', () => {
    const req = makeRequest({
      messages: [makeMessage({ role: ROLE.USER, content: [textBlock({ text: 'hi' })] })],
      tools: [toolDefinition({ name: 'france_tool', description: 'Does France things.' })],
    });
    const { request: out, edits } = substitute(req, dict);
    assert.equal(edits, 0);
    assert.equal(out.tools[0].name, 'france_tool');
    assert.equal(out.tools[0].description, 'Does France things.');
  });

  it('skips BLOCK.TOOL_CALL input — structured arguments the client matches against its own state', () => {
    const req = makeRequest({
      messages: [
        makeMessage({
          role: ROLE.ASSISTANT,
          content: [toolCallBlock({ id: 'call_1', name: 'search', input: { query: 'France' } })],
        }),
      ],
    });
    const { request: out, edits } = substitute(req, dict);
    assert.equal(edits, 0);
    assert.equal(out.messages[0].content[0].input.query, 'France');
  });

  it('skips BLOCK.TOOL_RESULT content — out of scope, reserved for a later minification plan', () => {
    const req = makeRequest({
      messages: [
        makeMessage({
          role: ROLE.USER,
          content: [toolResultBlock({ callId: 'call_1', content: [textBlock({ text: 'Result: France' })] })],
        }),
      ],
    });
    const { edits } = substitute(req, dict);
    assert.equal(edits, 0);
  });

  it('is idempotent: applying twice does not compound (single pass, disjoint dictionary)', () => {
    const req = makeRequest({
      messages: [makeMessage({ role: ROLE.USER, content: [textBlock({ text: 'capital of France' })] })],
    });
    const once = substitute(req, dict).request;
    const twice = substitute(once, dict).request;
    assert.equal(twice.messages[0].content[0].text, 'capital of Canada');
    assert.equal(substitute(once, dict).edits, 0);
  });

  it('an empty dictionary makes substitute a no-op, edits === 0, same object identity', () => {
    const req = makeRequest({
      messages: [makeMessage({ role: ROLE.USER, content: [textBlock({ text: 'capital of France' })] })],
    });
    const { request: out, edits } = substitute(req, {});
    assert.equal(edits, 0);
    assert.equal(out, req, 'a no-op transform must return the identical object, not a rebuilt copy');
  });
});

describe('substitute — over canonical objects built by the adapter from fixtures', () => {
  it('request-thinking: substitutes visible text, leaves thinking, redacted thinking, and tool_choice/tools untouched', () => {
    const canonical = requestToCanonical(fixture('request-thinking'));
    const dict = { prove: 'demonstrate' };
    const { request: out, edits } = substitute(canonical, dict);

    assert.equal(edits, 1);
    assert.equal(out.messages[0].content[0].text, 'Demonstrate the round-trip is lossless.');

    const assistantMsg = out.messages[1];
    assert.equal(assistantMsg.content[0].thinking, canonical.messages[1].content[0].thinking);
    assert.equal(assistantMsg.content[1].raw.data, canonical.messages[1].content[1].raw.data);
    // Tool definitions and tool_choice are untouched by a transform that never
    // sees them: substitute() only ever rewrites system/messages.
    assert.deepEqual(out.tools, canonical.tools);
    assert.deepEqual(out.toolChoice, canonical.toolChoice);
  });

  it('request-tools-multi-call: substitutes assistant text, leaves tool_call input and tool_result content untouched', () => {
    const canonical = requestToCanonical(fixture('request-tools-multi-call'));
    const dict = { both: 'everything' };
    const { request: out, edits } = substitute(canonical, dict);

    assert.equal(edits, 1);
    const assistantMsg = out.messages[1];
    assert.equal(assistantMsg.content[0].text, "I'll do everything.");
    assert.deepEqual(assistantMsg.content[1].input, canonical.messages[1].content[1].input);
    assert.deepEqual(assistantMsg.content[2].input, canonical.messages[1].content[2].input);

    const resultMsg = out.messages[2];
    assert.deepEqual(resultMsg.content, canonical.messages[2].content);
  });
});

describe('transforms/index.js — apply()', () => {
  const dict = { france: 'canada' };
  const substituteTransform = createSubstituteTransform(dict);

  it('applies an ordered transform list and reports edits and byTransform', () => {
    const req = makeRequest({
      messages: [makeMessage({ role: ROLE.USER, content: [textBlock({ text: 'capital of France' })] })],
    });
    const result = apply(req, [substituteTransform]);
    assert.equal(result.edits, 1);
    assert.equal(result.byTransform.substitute, 1);
    assert.equal(result.request.messages[0].content[0].text, 'capital of Canada');
  });

  it('a no-op transform list, or a dictionary with no matches, forwards the original canonical object (edits === 0)', () => {
    const req = makeRequest({
      messages: [makeMessage({ role: ROLE.USER, content: [textBlock({ text: 'nothing to replace' })] })],
    });
    const result = apply(req, [substituteTransform]);
    assert.equal(result.edits, 0);
    assert.equal(result.request, req, 'invariant 6: zero edits must forward the original object, not a rebuild');
  });

  it('the returned request is re-frozen', () => {
    const req = makeRequest({
      messages: [makeMessage({ role: ROLE.USER, content: [textBlock({ text: 'capital of France' })] })],
    });
    const result = apply(req, [substituteTransform]);
    assert.ok(Object.isFrozen(result.request));
    assert.ok(Object.isFrozen(result.request.messages));
    assert.ok(Object.isFrozen(result.request.messages[0]));
    assert.ok(Object.isFrozen(result.request.messages[0].content[0]));
  });

  it('a throwing transform is skipped and logged; the rest of the list still runs', () => {
    const errors = [];
    const log = { error: (msg) => errors.push(msg) };
    const throwing = { name: 'broken', apply: () => { throw new Error('boom'); } };
    const req = makeRequest({
      messages: [makeMessage({ role: ROLE.USER, content: [textBlock({ text: 'capital of France' })] })],
    });
    const result = apply(req, [throwing, substituteTransform], { log });
    assert.equal(result.edits, 1, 'the working transform after the broken one must still run');
    assert.equal(result.byTransform.broken, 0);
    assert.equal(result.byTransform.substitute, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /broken failed and was skipped/);
    assert.match(errors[0], /boom/);
  });

  it('a transform that throws on every call degrades the whole request to a no-op, never touching the client', () => {
    const errors = [];
    const log = { error: (msg) => errors.push(msg) };
    const throwing = { name: 'broken', apply: () => { throw new Error('boom'); } };
    const req = makeRequest({
      messages: [makeMessage({ role: ROLE.USER, content: [textBlock({ text: 'capital of France' })] })],
    });
    const result = apply(req, [throwing], { log });
    assert.equal(result.edits, 0);
    assert.equal(result.request, req);
  });

  it('validate() rejects a malformed transform list', () => {
    assert.throws(() => validate([{ name: 'x' }]), /apply is not a function/);
    assert.throws(() => validate([{ apply: () => {} }]), /has no name/);
    assert.throws(() => validate('not-an-array'), /must be an array/);
  });

  it('validate() accepts a well-formed transform list', () => {
    const list = validate([substituteTransform]);
    assert.equal(list[0].name, 'substitute');
  });
});
