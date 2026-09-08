// routing/ is a lookup, so this tests a lookup: entries in, a route out.
//
// Most cases below use opaque sentinel objects where an adapter goes, because
// the router never calls one — it only hands one back. The shipped registry
// (config/providers.js), with its real Anthropic and OpenAI entries, gets its
// own exercise at the bottom of this file.

import assert from 'node:assert/strict';
import test from 'node:test';
import { forwardTarget, loadConfig } from '../config/index.js';
import { PROVIDERS } from '../config/providers.js';
import { createRouter, pathOf } from '../routing/index.js';

/** Stand-ins for an adapter. Identity is all the router does with them. */
const alpha = { name: 'alpha-adapter' };
const beta = { name: 'beta-adapter' };

const entry = (over = {}) => ({
  name: 'alpha',
  adapter: alpha,
  upstream: 'https://alpha.test',
  port: null,
  pathPrefix: '/',
  modeledPaths: ['/v1/messages'],
  ...over,
});

test('a modeled path resolves to its provider, adapter and upstream', () => {
  const resolve = createRouter({ providers: [entry()] });
  const route = resolve({ url: '/v1/messages' });

  assert.equal(route.provider, 'alpha');
  assert.equal(route.adapter, alpha);
  assert.equal(route.upstream, 'https://alpha.test');
  assert.equal(route.modeled, true);
  assert.equal(route.path, '/v1/messages');
});

test('an endpoint the adapter does not model still resolves, but is not modeled', () => {
  // The distinction the whole phase turns on: the provider is known, and the
  // request still takes the Phase 1 transparent path because nothing here can
  // read its body.
  const resolve = createRouter({ providers: [entry()] });
  const route = resolve({ url: '/v1/messages/count_tokens' });

  assert.equal(route.provider, 'alpha');
  assert.equal(route.modeled, false);
});

test('the query string is not part of the path', () => {
  const resolve = createRouter({ providers: [entry()] });
  assert.equal(resolve({ url: '/v1/messages?beta=true' }).modeled, true);
  assert.equal(pathOf('/v1/messages?a=1&b=2'), '/v1/messages');
  assert.equal(pathOf('/v1/messages'), '/v1/messages');
});

test('a path prefix matches whole segments, not string prefixes', () => {
  const resolve = createRouter({
    providers: [entry({ name: 'v1', pathPrefix: '/v1', modeledPaths: ['/v1/messages'] })],
  });

  assert.equal(resolve({ url: '/v1' }).provider, 'v1', 'the prefix itself matches');
  assert.equal(resolve({ url: '/v1/messages' }).provider, 'v1');
  assert.equal(resolve({ url: '/v1beta/messages' }).provider, null, '/v1 must not swallow /v1beta');
});

test('entries are matched in order, and the first match wins', () => {
  const resolve = createRouter({
    providers: [
      entry({ name: 'specific', adapter: beta, pathPrefix: '/v1/messages' }),
      entry({ name: 'catch-all', adapter: alpha, pathPrefix: '/' }),
    ],
  });

  assert.equal(resolve({ url: '/v1/messages' }).adapter, beta);
  assert.equal(resolve({ url: '/v1/models' }).adapter, alpha);
});

test('an entry can be keyed on the port the client reached', () => {
  const resolve = createRouter({
    providers: [
      entry({ name: 'on-9001', adapter: beta, port: 9001 }),
      entry({ name: 'anywhere', adapter: alpha, port: null }),
    ],
  });

  assert.equal(resolve({ url: '/v1/messages', port: 9001 }).provider, 'on-9001');
  assert.equal(resolve({ url: '/v1/messages', port: 8787 }).provider, 'anywhere');
  // Transport did not say which port; only port-agnostic entries can match.
  assert.equal(resolve({ url: '/v1/messages' }).provider, 'anywhere');
});

test('an entrypoint no provider claims resolves to nothing, and is never modeled', () => {
  const resolve = createRouter({ providers: [entry({ pathPrefix: '/v1' })] });
  const route = resolve({ url: '/healthz' });

  assert.deepEqual(route, { provider: null, adapter: null, upstream: null, modeled: false, path: '/healthz' });
});

test('resolving is total: garbage in, an unrouted route out', () => {
  const resolve = createRouter({ providers: [entry()] });
  // The observer must never be handed a throw from a lookup; a request it
  // cannot describe is one it declines to observe.
  assert.equal(resolve({}).modeled, false);
  assert.equal(resolve(undefined).modeled, false);
  assert.equal(resolve({ url: null }).path, '');
  assert.equal(createRouter({}).resolve, undefined, 'createRouter returns the function itself');
});

test('a malformed registry fails at startup, not per request', () => {
  assert.throws(() => createRouter({ providers: {} }), /providers must be an array/);
  assert.throws(() => createRouter({ providers: [entry({ name: '' })] }), /entry 0 has no name/);
  assert.throws(() => createRouter({ providers: [entry({ adapter: null })] }), /entry 0 has no adapter/);
  assert.throws(() => createRouter({ providers: [entry({ pathPrefix: 'v1' })] }), /pathPrefix must start with/);
  assert.throws(() => createRouter({ providers: [entry({ port: 'x' })] }), /port must be an integer/);
  assert.throws(() => createRouter({ providers: [entry({ modeledPaths: null })] }), /modeledPaths must be an array/);
});

// ---------------------------------------------------------------------------
// config/providers.js — the registry itself, and what config does with it
// ---------------------------------------------------------------------------

test('the shipped registry is well formed and routes the endpoint each entry claims to', () => {
  assert.ok(PROVIDERS.length > 0, 'the gateway with an empty registry observes nothing');
  const anthropic = PROVIDERS.find((entry) => entry.name === 'anthropic');
  const openai = PROVIDERS.find((entry) => entry.name === 'openai');
  const resolve = createRouter({ providers: PROVIDERS });

  const anthropicRoute = resolve({ url: '/v1/messages' });
  assert.equal(anthropicRoute.modeled, true);
  assert.equal(anthropicRoute.adapter, anthropic.adapter);
  // Everything else under the same provider is forwarded and not described.
  assert.equal(resolve({ url: '/v1/models' }).modeled, false);

  // The OpenAI entry is keyed on its own port and must not be shadowed by
  // Anthropic's port-agnostic catch-all, even though that entry's pathPrefix
  // ('/') would otherwise match first.
  const openaiRoute = resolve({ url: '/v1/chat/completions', port: openai.port });
  assert.equal(openaiRoute.modeled, true);
  assert.equal(openaiRoute.adapter, openai.adapter);
});

test('config applies GATEWAY_UPSTREAM over every entry in the registry', () => {
  const { providers, upstream } = loadConfig({ GATEWAY_UPSTREAM: 'http://127.0.0.1:9/base' });
  assert.equal(upstream.href, 'http://127.0.0.1:9/base');
  for (const entry of providers) assert.equal(entry.upstream.href, upstream.href);

  // The default is the registry's port-agnostic entry (Anthropic), not simply
  // the first one in match order (which is OpenAI, for routing reasons — see
  // config/providers.js).
  const anthropic = PROVIDERS.find((entry) => entry.name === 'anthropic');
  assert.equal(loadConfig({}).upstream.origin, new URL(anthropic.upstream).origin);
});

test('forwardTarget is the passthrough default: the first entry, regardless of how many upstreams the registry names', () => {
  const one = { upstream: new URL('https://a.test') };
  assert.equal(forwardTarget([one, { upstream: new URL('https://a.test') }]).href, one.upstream.href);
  assert.throws(() => forwardTarget([]), /registry is empty/);
  // Two distinct upstreams no longer fails at startup: passthrough still picks
  // the first (it ignores the registry's routing entirely), and observe mode
  // resolves the real per-request upstream through resolveUpstream instead.
  assert.equal(forwardTarget([one, { upstream: new URL('https://b.test') }]).href, one.upstream.href);
});

test('forwardTarget prefers a port-agnostic entry over match order, so passthrough default and routing order can differ', () => {
  const portSpecific = { upstream: new URL('https://openai.test'), port: 8788 };
  const portAgnostic = { upstream: new URL('https://anthropic.test'), port: null };
  // Match order (routing) has the port-specific entry first so it isn't
  // shadowed; forwardTarget (passthrough's single default) still finds the
  // port-agnostic one rather than blindly taking index 0.
  assert.equal(forwardTarget([portSpecific, portAgnostic]).href, portAgnostic.upstream.href);
  // With no port-agnostic entry at all, the first one is the honest fallback.
  assert.equal(forwardTarget([portSpecific, { ...portSpecific, port: 8789 }]).href, portSpecific.upstream.href);
});
