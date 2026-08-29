import assert from 'node:assert/strict';
import test from 'node:test';
import { createSseDecoder, decodeSse, sseData } from '../adapters/sse.js';

test('events are dispatched on blank lines, comments ignored', () => {
  const events = decodeSse(
    ': keep-alive\n\nevent: message_start\ndata: {"type":"message_start"}\n\nevent: ping\ndata: {"type":"ping"}\n\n',
  );
  assert.deepEqual(
    events.map((e) => e.event),
    ['message_start', 'ping'],
  );
  assert.equal(sseData(events[0]).type, 'message_start');
});

test('an event split across chunk boundaries survives reassembly', () => {
  const decoder = createSseDecoder();
  const whole = 'event: content_block_delta\ndata: {"index":0,"text":"hi"}\n\n';
  const emitted = [];
  // One byte at a time: the worst case a socket can hand us.
  for (const char of whole) emitted.push(...decoder.push(char));
  assert.equal(emitted.length, 1);
  assert.deepEqual(sseData(emitted[0]), { index: 0, text: 'hi' });
});

test('CRLF line endings and multi-line data fields', () => {
  const events = decodeSse('event: x\r\ndata: line one\r\ndata: line two\r\n\r\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].data, 'line one\nline two');
});

test('a truncated stream yields what arrived instead of throwing', () => {
  const decoder = createSseDecoder();
  assert.deepEqual(decoder.push('event: message_start\ndata: {"type":"mess'), []);
  const flushed = decoder.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].event, 'message_start');
  // Unparseable payloads degrade to null; they never reject.
  assert.equal(sseData(flushed[0]), null);
});

test('a data-only event still dispatches', () => {
  const [event] = decodeSse('data: {"type":"ping"}\n\n');
  assert.equal(event.event, null);
  assert.deepEqual(sseData(event), { type: 'ping' });
});
