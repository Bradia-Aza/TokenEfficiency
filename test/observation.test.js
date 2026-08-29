import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig, MODE_OBSERVE, MODE_PASSTHROUGH } from '../config/index.js';
import { raw, startGateway, startUpstream } from './helpers.js';

const echo = (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ echoed: Buffer.concat(chunks).toString() }));
  });
};

test('observe mode captures request and response bytes without altering them', async (t) => {
  const upstream = await startUpstream(echo);
  const gateway = await startGateway({ GATEWAY_UPSTREAM: upstream.origin });
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  const body = '{"model":"claude-opus-5"}';
  const res = await raw(gateway.origin, { method: 'POST', path: '/v1/messages', body });
  assert.equal(res.body.toString(), JSON.stringify({ echoed: body }));

  await new Promise((r) => setTimeout(r, 50)); // observation lands after 'finish'
  assert.equal(gateway.exchanges.length, 1);
  const [exchange] = gateway.exchanges;
  assert.equal(exchange.method, 'POST');
  assert.equal(exchange.url, '/v1/messages');
  assert.equal(exchange.statusCode, 200);
  assert.equal(exchange.request.bytes.toString(), body);
  assert.equal(exchange.request.truncated, false);
  assert.equal(exchange.response.bytes.toString(), JSON.stringify({ echoed: body }));
});

// Invariant 5 / the bisect tool: passthrough bypasses every later layer, so the
// observation seam is not merely ignored - it is never reached.
test('passthrough mode never reaches the observation seam', async (t) => {
  const upstream = await startUpstream(echo);
  const gateway = await startGateway({
    GATEWAY_UPSTREAM: upstream.origin,
    GATEWAY_MODE: 'passthrough',
    __throwInObserver: true, // would throw loudly if it were ever called
  });
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  const res = await raw(gateway.origin, { method: 'POST', path: '/v1/messages', body: 'hello' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.toString(), JSON.stringify({ echoed: 'hello' }));

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(gateway.exchanges.length, 0);
  assert.equal(gateway.logs.length, 0);
});

// Invariant 3: observation failure is never client-visible.
test('a throwing observer leaves the client response untouched', async (t) => {
  const upstream = await startUpstream(echo);
  const gateway = await startGateway({ GATEWAY_UPSTREAM: upstream.origin, __throwInObserver: true });
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  for (let i = 0; i < 3; i++) {
    const res = await raw(gateway.origin, { method: 'POST', path: '/v1/messages', body: `turn-${i}` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.toString(), JSON.stringify({ echoed: `turn-${i}` }));
  }

  await new Promise((r) => setTimeout(r, 50));
  // Every failure was caught and logged to stderr, and the session kept working.
  assert.equal(gateway.logs.filter((l) => l.includes('observation failed')).length, 3);
});

test('an oversized body is abandoned by the capture but forwarded intact', async (t) => {
  const upstream = await startUpstream(echo);
  const gateway = await startGateway({
    GATEWAY_UPSTREAM: upstream.origin,
    GATEWAY_MAX_CAPTURE_BYTES: '64',
  });
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  const body = 'x'.repeat(4096);
  const res = await raw(gateway.origin, { method: 'POST', path: '/v1/messages', body });
  assert.equal(JSON.parse(res.body.toString()).echoed, body);

  await new Promise((r) => setTimeout(r, 50));
  const [exchange] = gateway.exchanges;
  assert.equal(exchange.request.truncated, true);
  assert.equal(exchange.request.bytes, null);
  assert.equal(exchange.request.size, 4096);
});

test('config defaults and overrides', () => {
  const defaults = loadConfig({});
  assert.equal(defaults.mode, MODE_OBSERVE);
  assert.equal(defaults.port, 8787);
  assert.equal(defaults.upstream.origin, 'https://api.anthropic.com');

  assert.equal(loadConfig({ GATEWAY_MODE: 'passthrough' }).mode, MODE_PASSTHROUGH);
  // Anything that is not exactly 'passthrough' observes; no silent third mode.
  assert.equal(loadConfig({ GATEWAY_MODE: 'nonsense' }).mode, MODE_OBSERVE);

  assert.throws(() => loadConfig({ GATEWAY_UPSTREAM: 'not a url' }), /not a valid URL/);
  assert.throws(() => loadConfig({ GATEWAY_UPSTREAM: 'ftp://x.test' }), /must be http or https/);
  assert.throws(() => loadConfig({ GATEWAY_PORT: 'abc' }), /non-negative integer/);
});
