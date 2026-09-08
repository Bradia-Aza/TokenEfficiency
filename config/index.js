// Configuration is the only layer besides routing/ that may name a provider,
// and it does not: the names live in the registry data `./providers.js` holds.
// This file reads the environment, applies it over that registry, and hands the
// result to whoever asked.

import { readFileSync } from 'node:fs';
import { PROVIDERS } from './providers.js';
import { validateDictionary } from '../transforms/substitute.js';

const DEFAULT_PLUGINS = 'dump-session,meter-tokens';

/** Observation runs. This is the default. */
export const MODE_OBSERVE = 'observe';
/** Every layer above transport is bypassed. The bisect tool. */
export const MODE_PASSTHROUGH = 'passthrough';
/** Observation runs, and a modeled request is rewritten before it is forwarded. */
export const MODE_TRANSFORM = 'transform';

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
 * The registry with the environment applied.
 *
 * `GATEWAY_UPSTREAM` overrides every entry's upstream — the blunt knob that
 * makes the whole gateway point at one loopback server in a single-provider
 * test without the registry knowing anything about tests. A per-entry
 * override, `GATEWAY_<NAME>_UPSTREAM` (name upper-cased), wins over it for the
 * entry it names, so a two-provider deployment can point each provider at a
 * different place — and so can a test that needs two loopback servers.
 * `GATEWAY_<NAME>_PORT` does the same for the port an entry is keyed on.
 */
function loadProviders(env) {
  const blanket = env.GATEWAY_UPSTREAM || null;
  return PROVIDERS.map((entry) => {
    const NAME = entry.name.toUpperCase();
    const perEntryUpstream = env[`GATEWAY_${NAME}_UPSTREAM`] || null;
    const raw = perEntryUpstream ?? blanket ?? entry.upstream;
    const source = perEntryUpstream
      ? `GATEWAY_${NAME}_UPSTREAM`
      : blanket
        ? 'GATEWAY_UPSTREAM'
        : `provider ${entry.name} upstream`;
    return {
      ...entry,
      modeledPaths: [...entry.modeledPaths],
      upstream: parseUpstream(raw, source),
      port: intFromEnv(env, `GATEWAY_${NAME}_PORT`, entry.port),
    };
  });
}

/**
 * The default target for `GATEWAY_MODE=passthrough`, which forwards to one
 * configured upstream from the environment and ignores the registry entirely —
 * it is the bisect tool, and must not depend on routing.
 *
 * In observe mode this is no longer the only place a request can go: a
 * `resolveUpstream` seam on `createProxyHandler` looks up the real per-request
 * upstream from the registry (see `routing/`), and match order there is a
 * routing concern — a `port: null` catch-all has to sort *last* so a
 * port-specific entry isn't shadowed, which is the opposite of what
 * passthrough's single-upstream default wants. So this picks the first
 * port-agnostic entry, not simply the first entry: that is the one whose
 * upstream is "the gateway's upstream" independent of which port a request
 * reached, which is what a single unconfigured upstream has always meant.
 * Falls back to the first entry if the registry has no such entry.
 */
export function forwardTarget(providers) {
  if (providers.length === 0) throw new Error('config: the provider registry is empty');
  const portAgnostic = providers.find((entry) => entry.port === null);
  return (portAgnostic ?? providers[0]).upstream;
}

function listFromEnv(env, key, fallback) {
  const raw = env[key] ?? fallback;
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * `GATEWAY_TRANSFORM_DICT` names a JSON file of `{ "key": "value" }` string
 * pairs. Loaded and validated once at startup, per TRANSFORM_PLAN.md: a
 * malformed or missing file with transform mode enabled must fail before any
 * traffic is served, not per-request.
 */
function loadTransformDictionary(env, mode) {
  if (mode !== MODE_TRANSFORM) return null;
  const path = env.GATEWAY_TRANSFORM_DICT;
  if (!path) {
    throw new Error('GATEWAY_TRANSFORM_DICT is required when GATEWAY_MODE=transform');
  }
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`GATEWAY_TRANSFORM_DICT: could not read ${JSON.stringify(path)}: ${err.message}`);
  }
  let dict;
  try {
    dict = JSON.parse(raw);
  } catch (err) {
    throw new Error(`GATEWAY_TRANSFORM_DICT: ${JSON.stringify(path)} is not valid JSON: ${err.message}`);
  }
  if (dict === null || typeof dict !== 'object' || Array.isArray(dict)) {
    throw new Error(`GATEWAY_TRANSFORM_DICT: ${JSON.stringify(path)} must be a JSON object of string to string`);
  }
  return validateDictionary(dict);
}

function modeFromEnv(env) {
  if (env.GATEWAY_MODE === MODE_PASSTHROUGH) return MODE_PASSTHROUGH;
  if (env.GATEWAY_MODE === MODE_TRANSFORM) return MODE_TRANSFORM;
  return MODE_OBSERVE;
}

export function loadConfig(env = process.env) {
  const mode = modeFromEnv(env);

  const providers = loadProviders(env);
  const transformDictionary = loadTransformDictionary(env, mode);

  return {
    mode,
    // null outside transform mode; an already-validated { key: value } map
    // inside it. transforms/substitute.js turns this into a live transform.
    transformDictionary,
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
