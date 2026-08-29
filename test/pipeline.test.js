import assert from 'node:assert/strict';
import test from 'node:test';
import { message, request, response, ROLE, textBlock } from '../canonical/index.js';
import { createPipeline } from '../pipeline/index.js';

const capture = () => {
  const logs = [];
  return { logs, log: { error: (line) => logs.push(line) } };
};

const sampleRequest = () =>
  request({ model: 'test-model', messages: [message({ role: ROLE.USER, content: [textBlock({ text: 'hi' })] })] });
const sampleCtx = () => ({ exchangeId: 1, sessionId: 'abc123', provider: 'test' });

test('observers run in list order, on both hooks', async () => {
  const seen = [];
  const record = (name) => ({
    name,
    onRequest: () => void seen.push(`${name}:request`),
    onResponse: () => void seen.push(`${name}:response`),
  });
  const pipeline = createPipeline({ plugins: [record('first'), record('second')] });

  await pipeline.onRequest(sampleRequest(), sampleCtx());
  await pipeline.onResponse(response({}), sampleCtx());

  assert.deepEqual(seen, ['first:request', 'second:request', 'first:response', 'second:response']);
  assert.deepEqual(pipeline.names, ['first', 'second']);
});

// Invariant 3, at the layer that owns it.
test('a throwing observer is isolated from the ones after it', async () => {
  const { logs, log } = capture();
  const reached = [];
  const pipeline = createPipeline({
    log,
    plugins: [
      {
        name: 'sync-thrower',
        onRequest() {
          throw new Error('deliberate sync failure');
        },
      },
      {
        name: 'async-rejecter',
        async onRequest() {
          throw new Error('deliberate async failure');
        },
      },
      { name: 'survivor', onRequest: () => void reached.push('survivor') },
    ],
  });

  // Resolves, never rejects: the caller has already sent the client its bytes.
  await pipeline.onRequest(sampleRequest(), sampleCtx());

  assert.deepEqual(reached, ['survivor']);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /sync-thrower\.onRequest failed: .*deliberate sync failure/s);
  assert.match(logs[1], /async-rejecter\.onRequest failed: .*deliberate async failure/s);
});

// Invariant 1, structurally: an observer cannot change what it was given, and
// cannot hand anything back either.
test('observers receive frozen objects and cannot return a replacement', async () => {
  const { logs, log } = capture();
  let mutationError = null;
  const pipeline = createPipeline({
    log,
    plugins: [
      {
        name: 'would-mutate',
        onRequest(canonical) {
          try {
            canonical.messages.push('extra turn');
          } catch (err) {
            mutationError = err;
          }
        },
      },
      { name: 'would-transform', onRequest: () => ({ model: 'swapped-out' }) },
    ],
  });

  const canonical = sampleRequest();
  await pipeline.onRequest(canonical, sampleCtx());

  assert.ok(mutationError instanceof TypeError, 'mutating a canonical object throws');
  assert.equal(canonical.messages.length, 1, 'the object is unchanged');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /would-transform\.onRequest returned a value; the pipeline is read-only/);
});

test('the ctx is frozen before any observer sees it', async () => {
  let frozen = null;
  const pipeline = createPipeline({
    plugins: [{ name: 'inspect', onRequest: (_req, ctx) => void (frozen = Object.isFrozen(ctx)) }],
  });
  await pipeline.onRequest(sampleRequest(), { exchangeId: 1, raw: { request: Buffer.from('body') } });
  assert.equal(frozen, true);
});

test('a hook an observer does not implement is skipped', async () => {
  const pipeline = createPipeline({ plugins: [{ name: 'request-only', onRequest: () => {} }] });
  await pipeline.onResponse(response({}), sampleCtx());
});

test('malformed plugins are rejected at construction, not at dispatch', () => {
  assert.throws(() => createPipeline({ plugins: [null] }), /not an object/);
  assert.throws(() => createPipeline({ plugins: [{}] }), /has no name/);
  assert.throws(() => createPipeline({ plugins: [{ name: 'bad', onResponse: 'nope' }] }), /is not a function/);
});

test('close lets observers flush and isolates their failures', async () => {
  const { logs, log } = capture();
  const closed = [];
  const pipeline = createPipeline({
    log,
    plugins: [
      {
        name: 'noisy',
        close() {
          throw new Error('deliberate close failure');
        },
      },
      { name: 'tidy', close: () => void closed.push('tidy') },
    ],
  });

  await pipeline.close();

  assert.deepEqual(closed, ['tidy']);
  assert.match(logs[0], /noisy\.close failed/);
});
