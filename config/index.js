// Configuration is the only layer besides routing/ that may name a provider,
// and it does not: the names live in the registry data `./providers.js` holds.
// This file reads the environment, applies it over that registry, and hands the
// result to whoever asked.

import { PROVIDERS } from './providers.js';

const DEFAULT_PLUGINS = 'dump-session,meter-tokens';

/** Observation runs. This is the default. */
export const MODE_OBSERVE = 'observe';
/** Every layer above transport is bypassed. The bisect tool. */
export const MODE_PASSTHROUGH = 'passthrough';

function intFromEnv(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${key} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function parseUpstream(raw, source) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${source} is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${source} must be http or https, got ${url.protocol}`);
  }
  return url;
}

/**
 * The registry with the environment applied. `GATEWAY_UPSTREAM` overrides every
 * entry's upstream, which is what makes the whole gateway point at a loopback
 * server in a test without the registry knowing anything about tests.
 */
function loadProviders(env) {
  const override = env.GATEWAY_UPSTREAM || null;
  return PROVIDERS.map((entry) => ({
    ...entry,
    modeledPaths: [...entry.modeledPaths],
    upstream: parseUpstream(override ?? entry.upstream, override ? 'GATEWAY_UPSTREAM' : `provider ${entry.name} upstream`),
  }));
}

/**
 * The single target `transport/` forwards to.
 *
 * The forward is provider-agnostic and stays that way: it resolves one upstream
 * at startup rather than consulting the router per request. That holds while
 * every entrypoint shares an upstream, and the guard below turns the day it
 * stops holding into a startup error naming the work — a `resolveUpstream`
 * seam on `createProxyHandler`, alongside `onExchange` — instead of a silent
 * misroute. It is not built now because there is nothing to route to.
 */
export function forwardTarget(providers) {
  if (providers.length === 0) throw new Error('config: the provider registry is empty');
  const distinct = new Set(providers.map((entry) => entry.upstream.href));
  if (distinct.size > 1) {
    throw new Error(
      `config: the registry names ${distinct.size} upstreams (${[...distinct].join(', ')}), ` +
        'and transport forwards to one. Give createProxyHandler a per-request upstream before adding the second.',
    );
  }
  return providers[0].upstream;
}

function listFromEnv(env, key, fallback) {
  const raw = env[key] ?? fallback;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

export function loadConfig(env = process.env) {
  const mode = env.GATEWAY_MODE === MODE_PASSTHROUGH ? MODE_PASSTHROUGH : MODE_OBSERVE;

  const providers = loadProviders(env);

  return {
    mode,
    host: env.GATEWAY_HOST || '127.0.0.1',
    port: intFromEnv(env, 'GATEWAY_PORT', 8787),
    // Entrypoint -> provider, in match order. `routing/` turns this into a
    // resolver; nothing else should read it.
    providers,
    upstream: forwardTarget(providers),
    timeouts: {
      // Time to establish the upstream TCP/TLS connection.
      connectMs: intFromEnv(env, 'GATEWAY_CONNECT_TIMEOUT_MS', 10_000),
      // Socket inactivity once connected. Re-arms on every byte, so a long
      // stream only trips it when the upstream has genuinely gone quiet.
      idleMs: intFromEnv(env, 'GATEWAY_IDLE_TIMEOUT_MS', 300_000),
    },
    // Cap on captured request bytes. Exceeding it abandons the capture; it
    // never affects what is forwarded.
    maxCaptureBytes: intFromEnv(env, 'GATEWAY_MAX_CAPTURE_BYTES', 32 * 1024 * 1024),
    accessLog: env.GATEWAY_ACCESS_LOG !== '0',

    // Where observation lands. Nothing is written in passthrough mode.
    sessionsDir: env.GATEWAY_SESSIONS_DIR || 'sessions',
    // Enabled observers, in dispatch order. Empty disables observation while
    // leaving the forward exactly as it is.
    plugins: listFromEnv(env, 'GATEWAY_PLUGINS', DEFAULT_PLUGINS),
  };
}
