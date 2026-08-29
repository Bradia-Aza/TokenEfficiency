// request -> { provider, adapter, upstream, modeled }.
//
// A lookup, and deliberately nothing more: no I/O, no state, no policy. The
// same exchange always resolves to the same route, so a route can be recomputed
// anywhere without coordination.
//
// This layer is permitted to name a provider and does not need to: the names
// live in the registry data `config/providers.js` holds, and this file only
// matches against it. That is what keeps every other layer's grep for a
// provider name empty.
//
// `modeled` is the whole point of the resolution. False means the request took
// the transparent path and there is nothing canonical to say about it —
// invariant 2, decided here rather than guessed at by the observer.

/**
 * Origin-form request URLs only; the gateway is a reverse proxy and never sees
 * an absolute-form URL or a CONNECT.
 */
export function pathOf(url) {
  const path = String(url ?? '');
  const query = path.indexOf('?');
  return query === -1 ? path : path.slice(0, query);
}

/**
 * Prefix match on whole path segments, so `/v1` selects `/v1/messages` but not
 * `/v1beta/messages`. A bare `/` matches everything.
 */
function underPrefix(path, prefix) {
  if (prefix === '/') return path.startsWith('/');
  if (path === prefix) return true;
  return path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

/** A route that matched nothing. Shaped like a real one so callers need no null check. */
const UNROUTED = Object.freeze({ provider: null, adapter: null, upstream: null, modeled: false });

function validate(entry, index) {
  const at = `config: provider entry ${index}`;
  if (entry === null || typeof entry !== 'object') throw new TypeError(`${at} is not an object`);
  if (typeof entry.name !== 'string' || entry.name === '') throw new TypeError(`${at} has no name`);
  if (entry.adapter === null || typeof entry.adapter !== 'object') throw new TypeError(`${at} has no adapter`);
  if (typeof entry.pathPrefix !== 'string' || !entry.pathPrefix.startsWith('/')) {
    throw new TypeError(`${at} pathPrefix must start with "/"`);
  }
  if (entry.port !== null && entry.port !== undefined && !Number.isInteger(entry.port)) {
    throw new TypeError(`${at} port must be an integer or null`);
  }
  if (!Array.isArray(entry.modeledPaths)) throw new TypeError(`${at} modeledPaths must be an array`);
  return {
    name: entry.name,
    adapter: entry.adapter,
    upstream: entry.upstream ?? null,
    port: entry.port ?? null,
    pathPrefix: entry.pathPrefix,
    // A set, because this is checked once per exchange and the list is static.
    modeled: new Set(entry.modeledPaths),
  };
}

/**
 * @param {object} deps
 * @param {Array<object>} deps.providers registry entries, matched in order
 * @returns {(exchange: object) => { provider: string|null, adapter: object|null,
 *   upstream: unknown, modeled: boolean, path: string }} never throws
 */
export function createRouter({ providers = [] } = {}) {
  if (!Array.isArray(providers)) throw new TypeError('config: providers must be an array');
  // Validated once, at construction. A malformed registry is a startup failure,
  // not a per-request surprise.
  const table = providers.map(validate);

  return function resolve(exchange) {
    const path = pathOf(exchange?.url);
    // Which entrypoint the client actually reached. Null when transport did not
    // report one, in which case only port-agnostic entries can match.
    const port = exchange?.port ?? null;

    for (const entry of table) {
      if (entry.port !== null && entry.port !== port) continue;
      if (!underPrefix(path, entry.pathPrefix)) continue;
      return {
        provider: entry.name,
        adapter: entry.adapter,
        upstream: entry.upstream,
        modeled: entry.modeled.has(path),
        path,
      };
    }
    return { ...UNROUTED, path };
  };
}
