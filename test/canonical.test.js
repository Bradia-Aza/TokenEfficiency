import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BLOCK,
  MEDIA_SOURCE,
  ROLE,
  STOP_REASON,
  TOOL_CHOICE,
  deepFreeze,
  mediaBlock,
  message,
  request,
  response,
  textBlock,
  thinkingBlock,
  toolCallBlock,
  toolChoice,
  toolResultBlock,
  unknownBlock,
  usage,
} from '../canonical/index.js';
import { assertDeeplyFrozen } from './fixture-harness.js';

// Invariant 1 is structural. These tests are the structure.
test('canonical objects are frozen all the way down', () => {
  const canonical = request({
    model: 'claude-opus-5',
    system: [textBlock({ text: 'be terse' })],
    messages: [
      message({
        role: ROLE.ASSISTANT,
        content: [toolCallBlock({ id: 'toolu_1', name: 'read_file', input: { path: 'a.js' } })],
      }),
    ],
  });

  assertDeeplyFrozen(canonical);
  assert.throws(() => canonical.messages.push(message({ role: ROLE.USER })), TypeError);
  assert.throws(() => {
    canonical.messages[0].content[0].input.path = 'b.js';
  }, TypeError);
  assert.throws(() => {
    canonical.model = 'something-else';
  }, TypeError);
});

test('deepFreeze terminates on cycles', () => {
  const a = { name: 'a' };
  a.self = a;
  assert.equal(deepFreeze(a), a);
  assert.ok(Object.isFrozen(a.self));
});

test('an empty raw bag is the same as no raw bag', () => {
  assert.equal(textBlock({ text: 'hi', raw: {} }).raw, null);
  assert.deepEqual(textBlock({ text: 'hi', raw: { cache_control: 1 } }).raw, { cache_control: 1 });
});

test('null and empty array mean different things on optional collections', () => {
  assert.equal(request({}).tools, null, 'absent tools is null');
  assert.deepEqual(request({ tools: [] }).tools, [], 'an explicitly empty tool list stays empty');
  assert.equal(request({}).system, null);
});

test('usage distinguishes "not reported" from zero', () => {
  assert.equal(usage({}).cacheReadTokens, null);
  assert.equal(usage({ cacheReadTokens: 0 }).cacheReadTokens, 0);
  // The counters the three providers disagree about are modeled separately
  // rather than folded into input/output, so a ledger can be compared with
  // itself across providers.
  assert.equal(usage({}).reasoningTokens, null);
  assert.equal(usage({}).totalTokens, null);
});

test('factories reject values the model cannot represent', () => {
  assert.throws(() => message({ role: 'tool' }), /message role/);
  // `system` is a role, not a rejection: OpenAI puts the system prompt in the
  // message list and allows one part-way through a thread, and observing that
  // as something the user said would be a lie.
  assert.equal(message({ role: ROLE.SYSTEM }).role, 'system');
  assert.throws(() => response({ role: ROLE.SYSTEM }), /response role/);
  assert.throws(() => response({ stopReason: 'made_up' }), /stopReason/);
  assert.throws(() => toolCallBlock({ name: 'read_file' }), /tool call id/);
  assert.throws(() => toolResultBlock({}), /callId/);
  assert.throws(() => toolChoice({ mode: TOOL_CHOICE.TOOL }), /tool choice names/);
  assert.throws(() => mediaBlock({ source: { kind: 'ftp' } }), /media source kind/);
});

test('block discriminants are stable', () => {
  assert.equal(textBlock({ text: '' }).type, BLOCK.TEXT);
  assert.equal(thinkingBlock({ thinking: '' }).type, BLOCK.THINKING);
  assert.equal(unknownBlock({ type: 'document' }).type, BLOCK.UNKNOWN);
  assert.equal(mediaBlock({ source: { kind: MEDIA_SOURCE.URL, url: 'x' } }).source.kind, MEDIA_SOURCE.URL);
  assert.equal(response({ stopReason: STOP_REASON.TOOL_CALL }).stopReason, 'tool_call');
});
