// The bridge from a finished transport exchange to a pipeline dispatch.
//
// This is what hangs off `createProxyHandler`'s `onExchange` seam. It parses the
// captured bytes, asks the adapter for canonical objects, builds the ctx, and
// dispatches. It names no provider: the adapter, the provider name and the
// request path all arrive through `resolve`, which is `routing/`'s router,
// injected rather than imported so this layer never depends on that one.
//
// It can never throw or reject. Everything it does happens after the client
// response has already finished, and invariant 3 says a broken observer must
// cost the session nothing.

import { createHash } from 'node:crypto';
import { deepFreeze } from '../canonical/freeze.js';
import { countTextEdits } from '../transforms/index.js';

/** Last value wins, matching how a client would read a repeated header. */
function headerValue(rawHeaders, name) {
  let found = null;
  if (!Array.isArray(rawHeaders)) return null;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === name) found = rawHeaders[i + 1];
  }
  return found;
}

const isEventStream = (contentType) => /^text\/event-stream\b/i.test(contentType ?? '');

/**
 * Why a captured body cannot be read, or null when it can. Truncated and failed
 * captures are normal — the cap exists so a huge upload cannot be held in
 * memory — and they cost the client nothing, so they are a skip, not an error.
 */
function unreadable(capture) {
  if (!capture) return 'no body captured';
  if (capture.truncated) return `body exceeded the capture cap at ${capture.size} bytes`;
  if (capture.error) return `capture failed: ${capture.error.message}`;
  if (capture.bytes === null) return 'body was not captured';
  return null;
}

/**
 * A session is one conversation thread, not one TCP connection: providers are
 * stateless and the client resends the whole history every turn, so the stable
 * identity is the conversation's opening.
 *
 * `userId` is hashed as an opaque value — clients that carry a per-session
 * identifier there get exact separation for free. Without one, two conversations
 * that open with the same message share a transcript; that is the documented
 * limit of deriving identity from canonical objects alone.
 */
export function sessionIdFor(canonicalRequest) {
  const opening = canonicalRequest.messages[0] ?? { role: null, content: [] };
  const seed = JSON.stringify([canonicalRequest.userId, opening]);
  return createHash('sha256').update(seed).digest('hex').slice(0, 12);
}

/**
 * @param {object} deps
 * @param {(exchange: object) => { provider: string, adapter: object, modeled: boolean }} deps.resolve
 * @param {ReturnType<import('./index.js').createPipeline>} deps.pipeline
 * @returns {(exchange: object) => Promise<void>} never rejects
 */
export function createExchangeObserver({ resolve, pipeline, log = console }) {
  return async function observeExchange(exchange) {
    const label = `#${exchange?.id}`;
    try {
      const route = resolve(exchange);
      // Unmodeled endpoints — and entrypoints no provider claims — skip adapters
      // and the pipeline entirely; they took the transparent path and there is
      // nothing canonical to say about them.
      if (!route?.modeled) return;
      const { adapter, provider, path } = route;

      const requestProblem = unreadable(exchange.request);
      if (requestProblem !== null) {
        log.error(`[gateway] ${label} request not observable: ${requestProblem}`);
        return;
      }

      let canonicalRequest;
      try {
        canonicalRequest = adapter.requestToCanonical(JSON.parse(exchange.request.bytes.toString('utf8')));
      } catch (err) {
        // Invariant 2: an unmodelable request was still forwarded byte-for-byte.
        // All that is lost here is the observation of it.
        log.error(`[gateway] ${label} request could not be modeled: ${err?.message || err}`);
        return;
      }

      // Transform mode only: `exchange.request` is what was actually sent, and
      // `exchange.originalRequest` is what the client sent before the
      // transform ran. Both get turned into canonical for observation — the
      // transcript shows what the model saw, the ledger shows what changed.
      const transformInfo = buildTransformInfo({ exchange, adapter, canonicalRequest, label, log });

      const responseContentType = headerValue(exchange.responseHeaders, 'content-type');
      const ctx = buildContext({ exchange, provider, path, canonicalRequest, responseContentType, transformInfo });

      await pipeline.onRequest(canonicalRequest, ctx);

      const canonicalResponse = toCanonicalResponse({ exchange, adapter, responseContentType, label, log });
      if (canonicalResponse !== null) await pipeline.onResponse(canonicalResponse, ctx);
    } catch (err) {
      log.error(`[gateway] ${label} observation failed: ${err?.stack || err}`);
    }
  };
}

/**
 * `null` outside transform mode. Inside it, the pre-transform canonical
 * request plus how many text blocks changed — a throw here (an unparseable
 * `originalRequest`, which should not happen since transport only ever puts
 * bytes there that came from the same body it read) degrades to `null` rather
 * than losing the request's own observation.
 */
function buildTransformInfo({ exchange, adapter, canonicalRequest, label, log }) {
  if (exchange.originalRequest === undefined) return null;
  const problem = unreadable(exchange.originalRequest);
  if (problem !== null) {
    log.error(`[gateway] ${label} pre-transform request not observable: ${problem}`);
    return null;
  }
  try {
    const originalCanonical = adapter.requestToCanonical(
      JSON.parse(exchange.originalRequest.bytes.toString('utf8')),
    );
    return {
      originalRequest: originalCanonical,
      transformed: exchange.transformed === true,
      overCap: exchange.overCap === true,
      edits: exchange.transformed === true ? countTextEdits(originalCanonical, canonicalRequest) : 0,
      requestBytesBefore: exchange.originalRequest.size,
      requestBytesAfter: exchange.request.size,
    };
  } catch (err) {
    log.error(`[gateway] ${label} pre-transform request could not be modeled: ${err?.message || err}`);
    return null;
  }
}

function toCanonicalResponse({ exchange, adapter, responseContentType, label, log }) {
  const problem = unreadable(exchange.response);
  if (problem !== null) {
    log.error(`[gateway] ${label} response not observable: ${problem}`);
    return null;
  }
  const text = exchange.response.bytes.toString('utf8');
  try {
    // A streamed turn and the same turn unstreamed converge on one canonical
    // shape, so nothing downstream has to care which arrived.
    return isEventStream(responseContentType)
      ? adapter.streamBytesToCanonical(text)
      : adapter.responseToCanonical(JSON.parse(text));
  } catch (err) {
    log.error(`[gateway] ${label} response could not be modeled: ${err?.message || err}`);
    return null;
  }
}

/**
 * Session id, provider name, timestamps, and the raw bytes — the fidelity the
 * canonical model deliberately does not offer.
 */
function buildContext({ exchange, provider, path, canonicalRequest, responseContentType, transformInfo }) {
  const startedAt = exchange.startedAt ?? null;
  const finishedAt = exchange.finishedAt ?? null;
  return deepFreeze({
    exchangeId: exchange.id,
    sessionId: sessionIdFor(canonicalRequest),
    provider,
    modeled: true,
    method: exchange.method,
    // Resolved by the router, not re-parsed here: one owner for what a path is.
    path,
    url: exchange.url,
    status: exchange.statusCode,
    startedAt,
    finishedAt,
    durationMs: startedAt !== null && finishedAt !== null ? finishedAt - startedAt : null,
    streamed: isEventStream(responseContentType),
    // null outside transform mode. Inside it: the pre-transform canonical
    // request, whether a transform actually ran, and byte counts before/after
    // — what meter-tokens.js needs to record the baseline-vs-transformed
    // comparison the ledger exists for.
    transform: transformInfo,
    raw: {
      request: exchange.request?.bytes ?? null,
      response: exchange.response?.bytes ?? null,
      requestSize: exchange.request?.size ?? 0,
      responseSize: exchange.response?.size ?? 0,
      requestTruncated: exchange.request?.truncated === true,
      responseTruncated: exchange.response?.truncated === true,
      // Copied, not referenced: these arrays belong to live Node message
      // objects and freezing them in place is not ours to do.
      requestHeaders: [...(exchange.requestHeaders ?? [])],
      responseHeaders: [...(exchange.responseHeaders ?? [])],
    },
  });
}
