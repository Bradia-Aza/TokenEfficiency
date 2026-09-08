import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { adapter as anthropicAdapter } from '../adapters/anthropic.js';
import { loadConfig } from '../config/index.js';
import { createRouter } from '../routing/index.js';
import { buildTransformRequest, deferred, raw, startBlackhole, startGateway, startUpstream } from './helpers.js';

const EMPTY_DICT = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures/dict/empty.json');

const MODES = ['observe', 'passthrough', 'transform'];

/**
 * transform mode needs `GATEWAY_TRANSFORM_DICT` at load time and a wired
 * `transformRequest`; the other two modes need neither. An empty dictionary
 * makes transform mode's forward byte-identical to observe mode's per
 * invariant 6, so the same byte-fidelity assertions below hold for all three
 * modes in this loop.
 */
function startGatewayInMode(mode, env) {
  if (mode !== 'transform') return startGateway({ ...env, GATEWAY_MODE: mode });
  const fullEnv = { ...env, GATEWAY_MODE: mode, GATEWAY_TRANSFORM_DICT: EMPTY_DICT };
  const { providers } = loadConfig({ GATEWAY_PORT: '0', GATEWAY_HOST: '127.0.0.1', ...fullEnv });
  const transformRequest = buildTransformRequest({ providers, dictionary: {} });
  return startGateway(fullEnv, { transformRequest });
}

// Invariant 2: if it can't be modeled, it's moved unchanged. Phase 1 models
// nothing, so everything must survive the trip byte-for-byte - in both modes.
for (const mode of MODES) {
  test(`[${mode}] forwards method, path, query, headers and body upstream`, async (t) => {
    let seen;
    const upstream = await startUpstream((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    const gateway = await startGatewayInMode(mode, { GATEWAY_UPSTREAM: upstream.origin });
    t.after(async () => {
      await gateway.close();
      await upstream.close();
    });

    const body = JSON.stringify({ model: 'claude-opus-5', messages: [] });
    const res = await raw(gateway.origin, {
      method: 'POST',
      path: '/v1/messages?beta=true',
      headers: { 'content-type': 'application/json', 'x-api-key': 'secret', 'anthropic-version': '2023-06-01' },
      body,
    });

    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/v1/messages?beta=true');
    assert.equal(seen.headers['x-api-key'], 'secret');
    assert.equal(seen.headers['anthropic-version'], '2023-06-01');
    assert.equal(seen.body.toString(), body);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.toString(), '{"ok":true}');
  });

  test(`[${mode}] passes non-2xx status, message and body through untouched`, async (t) => {
    const upstream = await startUpstream((req, res) => {
      res.writeHead(429, 'Too Many Requests', {
        'content-type': 'application/json',
        'retry-after': '42',
      });
      res.end('{"type":"error","error":{"type":"rate_limit_error"}}');
    });
    const gateway = await startGatewayInMode(mode, { GATEWAY_UPSTREAM: upstream.origin });
    t.after(async () => {
      await gateway.close();
      await upstream.close();
    });

    const res = await raw(gateway.origin, { path: '/v1/messages' });
    assert.equal(res.statusCode, 429);
    assert.equal(res.statusMessage, 'Too Many Requests');
    assert.equal(res.headers['retry-after'], '42');
    assert.equal(res.body.toString(), '{"type":"error","error":{"type":"rate_limit_error"}}');
  });

  test(`[${mode}] passes malformed, non-UTF8 bodies through byte-for-byte`, async (t) => {
    const garbage = Buffer.concat([
      Buffer.from('{"unterminated": [1,2, '),
      Buffer.from([0xff, 0xfe, 0x00, 0x1b]),
      Buffer.from(' not json'),
    ]);
    const upstream = await startUpstream((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(garbage);
    });
    const gateway = await startGatewayInMode(mode, { GATEWAY_UPSTREAM: upstream.origin });
    t.after(async () => {
      await gateway.close();
      await upstream.close();
    });

    const res = await raw(gateway.origin, { path: '/v1/messages' });
    assert.deepEqual(res.body, garbage);
  });

  test(`[${mode}] streams SSE incrementally and forwards mid-stream error events`, async (t) => {
    // The upstream refuses to send its second chunk until the client has the
    // first. A proxy that buffers deadlocks here instead of failing subtly.
    const firstChunkSeen = deferred();
    const upstream = await startUpstream(async (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      await firstChunkSeen.promise;
      res.write('event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n');
      res.end();
    });
    const gateway = await startGatewayInMode(mode, { GATEWAY_UPSTREAM: upstream.origin });
    t.after(async () => {
      await gateway.close();
      await upstream.close();
    });

    const res = await raw(gateway.origin, {
      path: '/v1/messages',
      headers: { accept: 'text/event-stream' },
      onChunk: () => firstChunkSeen.resolve(),
    });

    assert.equal(res.headers['content-type'], 'text/event-stream');
    assert.match(res.body.toString(), /event: message_start/);
    assert.match(res.body.toString(), /event: error/);
    assert.match(res.body.toString(), /overloaded_error/);
  });
}

test('strips hop-by-hop headers in both directions', async (t) => {
  let seen;
  const upstream = await startUpstream((req, res) => {
    seen = req.headers;
    res.writeHead(200, {
      connection: 'keep-alive, x-upstream-hop',
      'keep-alive': 'timeout=99, max=1234',
      'x-upstream-hop': 'should-not-survive',
      'x-end-to-end': 'kept',
    });
    res.end('ok');
  });
  const gateway = await startGateway({ GATEWAY_UPSTREAM: upstream.origin });
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  const res = await raw(gateway.origin, {
    path: '/v1/messages',
    headers: {
      connection: 'keep-alive, x-client-hop',
      'x-client-hop': 'should-not-survive',
      'proxy-authorization': 'Basic nope',
      te: 'trailers',
      'x-kept': 'yes',
    },
  });

  // Request side: hop-by-hop and Connection-named headers gone, rest intact.
  assert.equal(seen['x-client-hop'], undefined);
  assert.equal(seen['proxy-authorization'], undefined);
  assert.equal(seen.te, undefined);
  assert.equal(seen['x-kept'], 'yes');

  // Response side: same rules. Node adds a Keep-Alive header for its own hop,
  // so the check is that the upstream's distinctive value did not survive.
  assert.equal(res.headers['x-upstream-hop'], undefined);
  assert.doesNotMatch(res.headers['keep-alive'] ?? '', /timeout=99/);
  assert.equal(res.headers['x-end-to-end'], 'kept');
});

test('strips accept-encoding and rewrites host so bodies stay readable', async (t) => {
  let seen;
  const upstream = await startUpstream((req, res) => {
    seen = req.headers;
    res.end('ok');
  });
  const gateway = await startGateway({ GATEWAY_UPSTREAM: upstream.origin });
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  await raw(gateway.origin, {
    path: '/v1/messages',
    headers: { 'accept-encoding': 'gzip, br', host: 'api.anthropic.com' },
  });

  assert.equal(seen['accept-encoding'], undefined);
  assert.equal(seen.host, new URL(upstream.origin).host);
});

test('preserves duplicate response headers', async (t) => {
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, ['set-cookie', 'a=1', 'set-cookie', 'b=2', 'x-trace', 'one', 'X-Trace', 'two']);
    res.end('ok');
  });
  const gateway = await startGateway({ GATEWAY_UPSTREAM: upstream.origin });
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  const res = await raw(gateway.origin, { path: '/' });
  assert.deepEqual(res.headers['set-cookie'], ['a=1', 'b=2']);
  assert.equal(res.rawHeaders.filter((h) => h.toLowerCase() === 'x-trace').length, 2);
});

test('preserves a path prefix on the configured upstream', async (t) => {
  let seenUrl;
  const upstream = await startUpstream((req, res) => {
    seenUrl = req.url;
    res.end('ok');
  });
  const gateway = await startGateway({ GATEWAY_UPSTREAM: `${upstream.origin}/api/` });
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  await raw(gateway.origin, { path: '/v1/messages?x=1' });
  assert.equal(seenUrl, '/api/v1/messages?x=1');
});

test('aborts the upstream request when the client disconnects mid-stream', async (t) => {
  const upstreamAborted = deferred();
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {}\n\n');
    // Keep the stream open; only a real abort should end it.
    const timer = setInterval(() => res.write(': ping\n\n'), 10);
    res.on('close', () => {
      clearInterval(timer);
      if (!res.writableFinished) upstreamAborted.resolve();
    });
  });
  const gateway = await startGateway({ GATEWAY_UPSTREAM: upstream.origin });
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  const controller = new AbortController();
  await raw(gateway.origin, {
    path: '/v1/messages',
    signal: controller.signal,
    onChunk: () => controller.abort(),
  }).catch(() => {});

  await upstreamAborted.promise; // hangs the test if the socket leaked
});

test('returns 502 when the upstream connection fails', async (t) => {
  const upstream = await startUpstream((req, res) => res.end('ok'));
  const origin = upstream.origin;
  await upstream.close(); // nothing is listening there now
  const gateway = await startGateway({ GATEWAY_UPSTREAM: origin });
  t.after(() => gateway.close());

  const res = await raw(gateway.origin, { path: '/v1/messages' });
  assert.equal(res.statusCode, 502);
  assert.match(res.body.toString(), /Bad gateway/);
});

test('returns 504 when the upstream accepts but never responds', async (t) => {
  const upstream = await startUpstream(() => {
    /* accept the request and stall forever */
  });
  const gateway = await startGateway({
    GATEWAY_UPSTREAM: upstream.origin,
    GATEWAY_IDLE_TIMEOUT_MS: '150',
  });
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  const res = await raw(gateway.origin, { path: '/v1/messages' });
  assert.equal(res.statusCode, 504);
  assert.match(res.body.toString(), /idle/);
});

test('returns 504 when the upstream connection never completes', async (t) => {
  const blackhole = await startBlackhole(); // accepts TCP, never finishes TLS
  const gateway = await startGateway({
    GATEWAY_UPSTREAM: blackhole.origin,
    GATEWAY_CONNECT_TIMEOUT_MS: '150',
  });
  t.after(async () => {
    await gateway.close();
    await blackhole.close();
  });

  const res = await raw(gateway.origin, { path: '/v1/messages' });
  assert.equal(res.statusCode, 504);
  assert.match(res.body.toString(), /connect/);
});

// ---------------------------------------------------------------------------
// Phase 1 — the resolveUpstream seam: a per-request upstream, resolved from
// the registry rather than the single upstream `config.upstream` names. Proved
// here, at the transport layer, with two loopback servers and no adapter
// involved — this is a transport concern and should not need one.
// ---------------------------------------------------------------------------

test('resolveUpstream sends two entrypoints to two different upstreams from one gateway process', async (t) => {
  let seenA;
  const upstreamA = await startUpstream((req, res) => {
    seenA = { url: req.url, headers: req.headers };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"from":"a"}');
  });
  let seenB;
  const upstreamB = await startUpstream((req, res) => {
    seenB = { url: req.url, headers: req.headers };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"from":"b"}');
  });

  // A registry-shaped lookup: port 0 (the test binds an ephemeral port, so this
  // keys on path instead) selects an upstream by path prefix, mirroring what
  // config/providers.js -> routing/ would hand `index.js`.
  const resolveUpstream = ({ path }) =>
    path.startsWith('/a/') ? new URL(upstreamA.origin) : path.startsWith('/b/') ? new URL(upstreamB.origin) : null;

  const gateway = await startGateway({}, { resolveUpstream });
  t.after(async () => {
    await gateway.close();
    await upstreamA.close();
    await upstreamB.close();
  });

  const resA = await raw(gateway.origin, { path: '/a/v1/messages', headers: { 'x-marker': 'A' } });
  const resB = await raw(gateway.origin, { path: '/b/v1/messages', headers: { 'x-marker': 'B' } });

  assert.equal(resA.statusCode, 200);
  assert.equal(resA.body.toString(), '{"from":"a"}');
  assert.equal(seenA.url, '/a/v1/messages');
  assert.equal(seenA.headers['x-marker'], 'A');

  assert.equal(resB.statusCode, 200);
  assert.equal(resB.body.toString(), '{"from":"b"}');
  assert.equal(seenB.url, '/b/v1/messages');
  assert.equal(seenB.headers['x-marker'], 'B');
});

test('an unroutable request in observe mode gets a 404 with an inert body, not a crash', async (t) => {
  const resolveUpstream = () => null;
  const gateway = await startGateway({}, { resolveUpstream });
  t.after(() => gateway.close());

  const res = await raw(gateway.origin, { path: '/nothing/claims/this' });
  assert.equal(res.statusCode, 404);
  assert.match(res.body.toString(), /not found/i);
});

test('a registry with the Anthropic entry duplicated under a second port boots and routes both', async (t) => {
  // Exactly the Phase 1 exit criterion: two registry entries naming two
  // different upstreams, keyed by port, resolved through the real router — no
  // OpenAI adapter involved, because this is a transport concern.
  const upstreamA = await startUpstream((req, res) => res.end('a'));
  const upstreamB = await startUpstream((req, res) => res.end('b'));

  // Registry entries carry a parsed URL by the time routing/ sees them —
  // config/index.js's loadProviders does that parsing; this mirrors it rather
  // than going through loadConfig, since the point here is the router's output
  // feeding resolveUpstream, not config loading.
  const providers = [
    { name: 'anthropic', adapter: anthropicAdapter, upstream: new URL(upstreamA.origin), port: null, pathPrefix: '/', modeledPaths: ['/v1/messages'] },
    { name: 'anthropic-2', adapter: anthropicAdapter, upstream: new URL(upstreamB.origin), port: 9999, pathPrefix: '/', modeledPaths: ['/v1/messages'] },
  ];
  const resolve = createRouter({ providers });
  const resolveUpstream = ({ port, path }) => resolve({ port, url: path }).upstream;

  const gateway = await startGateway({}, { resolveUpstream });
  t.after(async () => {
    await gateway.close();
    await upstreamA.close();
    await upstreamB.close();
  });

  // The gateway's own ephemeral port never matches the entry keyed on 9999, so
  // this always resolves to the port-agnostic entry.
  const res = await raw(gateway.origin, { path: '/v1/messages' });
  assert.equal(res.body.toString(), 'a');
});

test('passthrough mode ignores resolveUpstream entirely and forwards to config.upstream', async (t) => {
  const upstream = await startUpstream((req, res) => res.end('passthrough-ok'));
  const neverCalled = () => {
    throw new Error('resolveUpstream must not be called in passthrough mode');
  };
  const gateway = await startGateway(
    { GATEWAY_UPSTREAM: upstream.origin, GATEWAY_MODE: 'passthrough' },
    { resolveUpstream: neverCalled },
  );
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  const res = await raw(gateway.origin, { path: '/v1/messages' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.toString(), 'passthrough-ok');
});
