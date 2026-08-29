import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { adapter } from '../adapters/anthropic.js';
import { BLOCK } from '../canonical/index.js';
import { createExchangeObserver, sessionIdFor } from '../pipeline/exchange.js';
import { createRouter } from '../routing/index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');

const capture = (text) =>
  text === null
    ? { bytes: null, size: 0, truncated: true, error: null }
    : { bytes: Buffer.from(text), size: Buffer.byteLength(text), truncated: false, error: null };

function exchangeRecord({
  id = 1,
  url = '/v1/messages',
  requestBody = '{"model":"m","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}',
  responseBody = fixture('response-simple-text.json'),
  responseContentType = 'application/json',
  statusCode = 200,
} = {}) {
  return {
    id,
    startedAt: 1_000,
    finishedAt: 1_120,
    method: 'POST',
    url,
    target: `https://upstream.test${url}`,
    statusCode,
    requestHeaders: ['Content-Type', 'application/json', 'X-Api-Key', 'secret'],
    responseHeaders: ['Content-Type', responseContentType],
    request: capture(requestBody),
    response: capture(responseBody),
  };
}

/** A recording pipeline plus the observer wired to the real adapter. */
function harness({ resolve } = {}) {
  const calls = [];
  const logs = [];
  const pipeline = {
    names: ['recorder'],
    onRequest: async (canonical, ctx) => void calls.push({ hook: 'onRequest', canonical, ctx }),
    onResponse: async (canonical, ctx) => void calls.push({ hook: 'onResponse', canonical, ctx }),
  };
  const observe = createExchangeObserver({
    resolve:
      resolve ??
      createRouter({
        providers: [
          {
            name: 'test-provider',
            adapter,
            upstream: 'https://upstream.test',
            port: null,
            pathPrefix: '/',
            modeledPaths: ['/v1/messages'],
          },
        ],
      }),
    pipeline,
    log: { error: (line) => logs.push(line) },
  });
  return { calls, logs, observe };
}

test('a modeled exchange dispatches both hooks with canonical objects', async () => {
  const { calls, observe } = harness();
  await observe(exchangeRecord());

  assert.deepEqual(
    calls.map((c) => c.hook),
    ['onRequest', 'onResponse'],
  );
  assert.equal(calls[0].canonical.model, 'm');
  assert.equal(calls[1].canonical.content[0].text, 'Paris.');
  assert.equal(calls[1].canonical.usage.inputTokens, 24);
  // Both hooks see the same ctx object for one exchange.
  assert.equal(calls[0].ctx, calls[1].ctx);
});

test('ctx carries the session, provider, timings and the raw bytes', async () => {
  const { calls, observe } = harness();
  const record = exchangeRecord();
  await observe(record);
  const { ctx } = calls[0];

  assert.equal(ctx.provider, 'test-provider');
  assert.equal(ctx.exchangeId, 1);
  assert.match(ctx.sessionId, /^[0-9a-f]{12}$/);
  assert.equal(ctx.method, 'POST');
  assert.equal(ctx.path, '/v1/messages');
  assert.equal(ctx.status, 200);
  assert.equal(ctx.durationMs, 120);
  assert.equal(ctx.streamed, false);
  assert.equal(ctx.modeled, true);

  assert.equal(ctx.raw.request.toString(), record.request.bytes.toString());
  assert.equal(ctx.raw.responseSize, record.response.size);
  // Header fidelity survives into ctx, and the arrays are copies of the live
  // Node ones rather than the originals.
  assert.deepEqual(ctx.raw.requestHeaders, record.requestHeaders);
  assert.notEqual(ctx.raw.requestHeaders, record.requestHeaders);
  assert.ok(Object.isFrozen(ctx));
});

test('a query string does not change the endpoint that is matched', async () => {
  const { calls, observe } = harness();
  await observe(exchangeRecord({ url: '/v1/messages?beta=true' }));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].ctx.path, '/v1/messages');
  assert.equal(calls[0].ctx.url, '/v1/messages?beta=true');
});

test('an SSE response is accumulated, not parsed as JSON', async () => {
  const { calls, observe } = harness();
  await observe(
    exchangeRecord({
      responseBody: fixture('stream-tool-call.sse'),
      responseContentType: 'text/event-stream; charset=utf-8',
    }),
  );

  const { canonical, ctx } = calls[1];
  assert.equal(ctx.streamed, true);
  assert.deepEqual(
    canonical.content.map((b) => b.type),
    [BLOCK.TEXT, BLOCK.TOOL_CALL],
  );
  assert.deepEqual(canonical.content[1].input, { path: 'index.js' });
  assert.equal(canonical.usage.outputTokens, 96);
});

// Invariant 2: an unmodeled endpoint took the transparent path and there is
// nothing canonical to say about it.
test('unmodeled endpoints reach no adapter and no plugin', async () => {
  const { calls, logs, observe } = harness();
  await observe(exchangeRecord({ url: '/v1/messages/count_tokens' }));
  await observe(exchangeRecord({ url: '/v1/models' }));
  assert.deepEqual(calls, []);
  assert.deepEqual(logs, []);
});

test('an unmodelable request is logged and dispatches nothing', async () => {
  const { calls, logs, observe } = harness();
  await observe(exchangeRecord({ requestBody: '{"model": "m", "messages": [' }));
  assert.deepEqual(calls, []);
  assert.match(logs[0], /#1 request could not be modeled/);
});

test('an unmodelable response still lets the request be observed', async () => {
  const { calls, logs, observe } = harness();
  await observe(exchangeRecord({ responseBody: '<html>502 from a load balancer</html>' }));

  assert.deepEqual(
    calls.map((c) => c.hook),
    ['onRequest'],
    'the request is still worth seeing when the response is garbage',
  );
  assert.match(logs[0], /#1 response could not be modeled/);
});

test('a body too large to capture is skipped rather than half-modeled', async () => {
  const { calls, logs, observe } = harness();
  await observe(exchangeRecord({ requestBody: null }));
  assert.deepEqual(calls, []);
  assert.match(logs[0], /request not observable: body exceeded the capture cap/);

  const second = harness();
  await second.observe(exchangeRecord({ responseBody: null }));
  assert.deepEqual(
    second.calls.map((c) => c.hook),
    ['onRequest'],
  );
  assert.match(second.logs[0], /response not observable/);
});

test('an error response becomes a canonical response, not a skipped turn', async () => {
  const { calls, observe } = harness();
  await observe(exchangeRecord({ responseBody: fixture('response-error.json'), statusCode: 429 }));

  const { canonical, ctx } = calls[1];
  assert.equal(ctx.status, 429);
  assert.equal(canonical.error.type, 'rate_limit_error');
  assert.deepEqual(canonical.content, []);
});

test('the observer never rejects, whatever fails inside it', async () => {
  const { logs, observe } = harness({
    resolve() {
      throw new Error('deliberate routing failure');
    },
  });
  await observe(exchangeRecord());
  assert.match(logs[0], /#1 observation failed: .*deliberate routing failure/s);

  // Including on a record that is not shaped like an exchange at all.
  const broken = harness();
  await broken.observe({});
  await broken.observe(undefined);
  assert.equal(broken.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Session identity
// ---------------------------------------------------------------------------

const turn = (userId, opening, extra = []) =>
  adapter.requestToCanonical({
    model: 'm',
    max_tokens: 8,
    metadata: { user_id: userId },
    messages: [{ role: 'user', content: opening }, ...extra],
  });

test('turns of one conversation share a session id', () => {
  const first = turn('user_1', 'refactor the parser');
  const later = turn('user_1', 'refactor the parser', [
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'now the tests' },
  ]);
  assert.equal(sessionIdFor(first), sessionIdFor(later), 'a growing history is still one session');
});

test('different conversations get different session ids', () => {
  assert.notEqual(sessionIdFor(turn('user_1', 'refactor the parser')), sessionIdFor(turn('user_1', 'write docs')));
  // Same opening line, different client session: the opaque user id separates them.
  assert.notEqual(sessionIdFor(turn('user_1', 'hi')), sessionIdFor(turn('user_2', 'hi')));
});

test('a request with no messages still yields a session id', () => {
  const empty = adapter.requestToCanonical({ model: 'm', messages: [] });
  assert.match(sessionIdFor(empty), /^[0-9a-f]{12}$/);
});
