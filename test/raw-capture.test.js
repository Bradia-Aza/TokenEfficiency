// The Phase 0.1 exit criterion for the proxy side: every observed exchange
// lands in the JSONL capture, and the recorded bodies are byte-faithful to what
// the client and upstream actually sent (INTERCEPTION_RESEARCH_PLAN.md).
//
// The capture plugin is a research instrument, but it is wired through the real
// pipeline, so it is held to the same rule as any other plugin: a failing sink
// must cost the session nothing.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createExchangeObserver } from '../pipeline/exchange.js';
import { createPipeline } from '../pipeline/index.js';
import { createRouter } from '../routing/index.js';
import { createRawCapture } from '../plugins/raw-capture.js';
import { raw, startGateway, startUpstream } from './helpers.js';

const STREAM_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_cap","type":"message","role":"assistant","model":"claude-opus-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":11,"cache_creation_input_tokens":3,"cache_read_input_tokens":7,"output_tokens":1}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

const JSON_RESPONSE = JSON.stringify({
  id: 'msg_cap2',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text: 'done' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 9, output_tokens: 4 },
});

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'raw-capture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readCapture(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

async function waitFor(predicate, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the capture to land');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The real stack, with the capture plugin (and optionally a broken one) wired in. */
function observerWith(plugins) {
  return ({ config, log }) =>
    createExchangeObserver({
      resolve: createRouter({ providers: config.providers }),
      pipeline: createPipeline({ plugins, log }),
      log,
    });
}

test('captures a streamed and a non-streamed exchange byte-faithfully', async (t) => {
  const dir = tempDir(t);
  const capturePath = join(dir, 'proxy.jsonl');
  const capture = createRawCapture({ path: capturePath });

  const upstream = await startUpstream((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(STREAM_SSE);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON_RESPONSE);
    });
  });
  t.after(() => upstream.close());

  const gateway = await startGateway(
    { GATEWAY_UPSTREAM: upstream.origin },
    { buildObserver: observerWith([capture]) },
  );
  t.after(() => gateway.close());

  const streamedBody = JSON.stringify({
    model: 'claude-opus-5',
    max_tokens: 100,
    stream: true,
    messages: [{ role: 'user', content: 'say hello' }],
  });
  const plainBody = JSON.stringify({
    model: 'claude-opus-5',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'say hello' }],
  });

  const streamed = await raw(gateway.origin, {
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: streamedBody,
  });
  const plain = await raw(gateway.origin, {
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: plainBody,
  });

  // The client got exactly what the upstream sent, capture or no capture.
  assert.equal(streamed.body.toString('utf8'), STREAM_SSE);
  assert.equal(plain.body.toString('utf8'), JSON_RESPONSE);

  const lines = await waitFor(() => {
    try {
      const parsed = readCapture(capturePath);
      return parsed.length === 2 ? parsed : null;
    } catch {
      return null;
    }
  });

  const [first, second] = lines;

  // Byte fidelity, both directions, both turns. This is the property the whole
  // study rests on: an analysis can only measure what the capture preserved.
  assert.equal(first.requestBody, streamedBody);
  assert.equal(first.responseBody, STREAM_SSE);
  assert.equal(first.requestEncoding, 'utf8');
  assert.equal(second.requestBody, plainBody);
  assert.equal(second.responseBody, JSON_RESPONSE);

  // The routing and identity fields an analysis joins on.
  assert.equal(first.side, 'proxy');
  assert.equal(first.seq, 0);
  assert.equal(second.seq, 1);
  assert.equal(first.provider, 'anthropic');
  assert.equal(first.path, '/v1/messages');
  assert.equal(first.method, 'POST');
  assert.equal(first.status, 200);
  assert.equal(first.streamed, true);
  assert.equal(second.streamed, false);
  assert.equal(first.sessionId, second.sessionId, 'one conversation is one session id');
  assert.match(first.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof first.durationMs, 'number');

  // Usage survives, since it is the denominator for the reach analysis.
  assert.equal(first.usage.inputTokens, 11);
  assert.equal(first.usage.cacheReadTokens, 7);
  assert.equal(second.usage.inputTokens, 20);

  // Headers keep their duplicates and case, as rawHeaders delivers them.
  assert.ok(
    first.requestHeaders.some(([name]) => name.toLowerCase() === 'content-type'),
    'request headers are recorded as name/value pairs',
  );
  assert.ok(first.responseHeaders.some(([name]) => name.toLowerCase() === 'content-type'));

  // Outside transform mode there is nothing to say about a transform.
  assert.equal(first.transform, null);

  await capture.close();
});

test('records non-UTF8 response bytes as base64 rather than mangling them', async (t) => {
  const dir = tempDir(t);
  const capturePath = join(dir, 'proxy.jsonl');
  const capture = createRawCapture({ path: capturePath });

  // Valid JSON with a lone surrogate escape would still be UTF-8; this is a
  // genuinely non-UTF8 byte sequence, which makes the response unmodelable —
  // so the capture must still record the bytes losslessly.
  const invalid = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]);

  const upstream = await startUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(invalid);
    });
  });
  t.after(() => upstream.close());

  const gateway = await startGateway(
    { GATEWAY_UPSTREAM: upstream.origin },
    { buildObserver: observerWith([capture]) },
  );
  t.after(() => gateway.close());

  const body = JSON.stringify({
    model: 'claude-opus-5',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
  });
  const response = await raw(gateway.origin, {
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(Buffer.compare(response.body, invalid), 0, 'the client got the exact bytes');

  // The bytes come back losslessly as base64. This is the property that
  // matters: `{"a":"\xff\xfe"}` is structurally valid JSON, so the response is
  // modeled and observed, but its bytes are not UTF-8 — decoding to a string
  // would silently substitute replacement characters and the capture would no
  // longer be a record of what crossed the wire.
  const lines = await waitFor(() => {
    try {
      const parsed = readCapture(capturePath);
      return parsed.length === 1 ? parsed : null;
    } catch {
      return null;
    }
  });
  assert.equal(lines[0].responseEncoding, 'base64');
  assert.equal(Buffer.compare(Buffer.from(lines[0].responseBody, 'base64'), invalid), 0);
  // The request was ordinary text, so it is recorded as text: the encoding is
  // chosen per body, not per line.
  assert.equal(lines[0].requestEncoding, 'utf8');
  assert.equal(lines[0].requestBody, body);

  await capture.close();
});

test('a failing capture costs the session nothing', async (t) => {
  const dir = tempDir(t);
  const capturePath = join(dir, 'proxy.jsonl');
  const working = createRawCapture({ path: capturePath });
  // Wired ahead of the working one, exactly as the Phase 3 session test does.
  const broken = {
    name: 'broken-capture',
    onRequest() {
      throw new Error('capture request boom');
    },
    onResponse() {
      throw new Error('capture response boom');
    },
  };

  const upstream = await startUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON_RESPONSE);
    });
  });
  t.after(() => upstream.close());

  const gateway = await startGateway(
    { GATEWAY_UPSTREAM: upstream.origin },
    { buildObserver: observerWith([broken, working]) },
  );
  t.after(() => gateway.close());

  const body = JSON.stringify({
    model: 'claude-opus-5',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
  });
  const response = await raw(gateway.origin, {
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.toString('utf8'), JSON_RESPONSE, "the client's bytes are untouched");

  // The working capture still ran, after the broken one threw.
  const lines = await waitFor(() => {
    try {
      const parsed = readCapture(capturePath);
      return parsed.length === 1 ? parsed : null;
    } catch {
      return null;
    }
  });
  assert.equal(lines[0].requestBody, body);

  // Both failures were logged, and nowhere but stderr.
  assert.ok(
    gateway.logs.some((line) => line.includes('broken-capture.onRequest failed')),
    'the request-hook failure was logged',
  );
  assert.ok(
    gateway.logs.some((line) => line.includes('broken-capture.onResponse failed')),
    'the response-hook failure was logged',
  );
  // Nothing else went wrong: the only errors are the two deliberate ones.
  assert.equal(gateway.logs.filter((line) => !line.includes('broken-capture')).length, 0);

  await working.close();
});
