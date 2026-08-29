// Hop-by-hop headers are meaningful only on a single connection and must not be
// forwarded across a proxy (RFC 9110 7.6.1). Everything else is end-to-end and
// is passed through untouched, duplicates and casing included.

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Headers named by the Connection header are hop-by-hop for this message only.
 * @param {string[]} rawHeaders alternating name/value pairs
 */
function connectionNamedTokens(rawHeaders) {
  const named = new Set();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() !== 'connection') continue;
    for (const token of rawHeaders[i + 1].split(',')) {
      const name = token.trim().toLowerCase();
      if (name) named.add(name);
    }
  }
  return named;
}

/**
 * Filter a rawHeaders array, preserving order, casing and duplicates.
 * @param {string[]} rawHeaders alternating name/value pairs
 * @param {Iterable<string>} alsoDrop lowercase names to drop beyond hop-by-hop
 * @returns {string[]} a new alternating name/value array
 */
export function filterRawHeaders(rawHeaders, alsoDrop = []) {
  const drop = new Set(alsoDrop);
  const named = connectionNamedTokens(rawHeaders);
  const out = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || named.has(lower) || drop.has(lower)) continue;
    out.push(name, rawHeaders[i + 1]);
  }
  return out;
}

/**
 * http.request() takes an object, not a raw array. Repeated names become arrays
 * so duplicates survive the trip.
 * @param {string[]} rawHeaders alternating name/value pairs
 */
export function rawHeadersToObject(rawHeaders) {
  const out = Object.create(null);
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = rawHeaders[i + 1];
    const existing = out[name];
    if (existing === undefined) out[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[name] = [existing, value];
  }
  return out;
}

/**
 * Client request headers -> upstream request headers.
 *
 * accept-encoding is stripped so upstream bodies come back in identity encoding
 * and stay readable by later layers. Host is rewritten to the upstream origin.
 */
export function upstreamRequestHeaders(rawHeaders, upstreamUrl) {
  const filtered = filterRawHeaders(rawHeaders, ['accept-encoding', 'host']);
  const headers = rawHeadersToObject(filtered);
  headers.host = upstreamUrl.host;
  return headers;
}

/** Upstream response headers -> client response headers. */
export function clientResponseHeaders(rawHeaders) {
  return filterRawHeaders(rawHeaders);
}
