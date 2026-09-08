import { MODE_PASSTHROUGH, MODE_TRANSFORM } from '../config/index.js';
import { captureBody, bufferBody } from './body-capture.js';
import { clientResponseHeaders, upstreamRequestHeaders } from './headers.js';
import { openUpstreamRequest } from './upstream.js';

let nextRequestId = 1;

function resolveTarget(upstream, requestUrl) {
  const base = upstream.pathname.endsWith('/') ? upstream.pathname.slice(0, -1) : upstream.pathname;
  return new URL(base + requestUrl, upstream.origin);
}

/**
 * Send a gateway-generated error. Only possible before the upstream response
 * has started; once bytes are in flight the honest signal is a killed socket.
 */
function failClosed(res, status, reason) {
  if (res.headersSent || res.writableEnded || res.destroyed) {
    res.destroy();
    return;
  }
  const body = Buffer.from(`${reason}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(body.length),
  });
  res.end(body);
}

/**
 * Transform mode's forward.
 *
 * The request body must be fully buffered before it is sent upstream — you
 * cannot rewrite a body you are already streaming (TRANSFORM_PLAN.md,
 * invariant 4 narrowed to the response path), and only one upstream request is
 * ever made per client request. `bufferBody` never drops bytes past the cap
 * (unlike `captureBody`'s tee, which can afford to because a separate live
 * pipe is still carrying the request there); it only reports `overCap`, so the
 * complete body always reaches upstream and the transform is simply skipped
 * when there was too much of it to hold for inspection — "degrade to observe
 * behavior, never truncate a request", per the plan.
 */
function handleTransforming({ req, res, id, port, target, upstream, config, onExchange, transformRequest, log, finish }) {
  const startedAt = Date.now();

  bufferBody(req, { maxBytes: config.maxCaptureBytes }).then(async (capture) => {
    if (res.destroyed || res.writableEnded) return;
    if (capture.bytes === null) {
      // The stream itself errored (client vanished mid-upload); nothing to forward.
      finish(499, 'client disconnected during buffering');
      failClosed(res, 499, 'Client disconnected');
      return;
    }

    const original = capture.bytes;
    const overCap = capture.overCap;
    if (overCap) {
      log.error(
        `[gateway] #${id} request body exceeded the capture cap at ${original.length} bytes; ` +
          'transform skipped for this request, forwarding the original body unchanged',
      );
    }

    let outBody = original;
    let transformed = false;
    if (!overCap) {
      try {
        const replaced = await transformRequest({ port, path: req.url, headers: req.rawHeaders, body: original });
        if (Buffer.isBuffer(replaced)) {
          outBody = replaced;
          transformed = true;
        }
      } catch (err) {
        log.error(`[gateway] #${id} transform failed, forwarding original bytes: ${err?.stack || err}`);
      }
    }

    const headers = upstreamRequestHeaders(req.rawHeaders, upstream);
    // The body is fully known now, so length framing is exact; a substituted
    // body changes byte length and must never be sent chunked.
    delete headers['transfer-encoding'];
    delete headers['Transfer-Encoding'];
    headers['content-length'] = String(outBody.length);

    const { request: upstreamReq, dispose } = openUpstreamRequest({
      url: target,
      method: req.method,
      headers,
      timeouts: config.timeouts,
      onTimeout: (kind) => {
        dispose();
        upstreamReq.destroy(new Error(`upstream ${kind} timeout`));
        finish(504, `${kind} timeout`);
        failClosed(res, 504, `Gateway timeout (${kind})`);
      },
    });

    upstreamReq.on('error', (err) => {
      dispose();
      finish(502, err.code || err.message);
      failClosed(res, 502, `Bad gateway (${err.code || 'upstream error'})`);
    });

    upstreamReq.on('response', (upstreamRes) => {
      dispose();

      if (res.destroyed || res.writableEnded) {
        upstreamRes.destroy();
        return;
      }
      res.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage, clientResponseHeaders(upstreamRes.rawHeaders));

      upstreamRes.pipe(res);
      const responseCapture = captureBody(upstreamRes, { maxBytes: config.maxCaptureBytes });

      upstreamRes.on('error', () => {
        finish(upstreamRes.statusCode, 'upstream stream error');
        res.destroy();
      });

      res.on('finish', () => {
        finish(upstreamRes.statusCode);
        responseCapture
          .then((response) => {
            try {
              onExchange?.({
                id,
                startedAt,
                finishedAt: Date.now(),
                method: req.method,
                url: req.url,
                port,
                target: target.href,
                statusCode: upstreamRes.statusCode,
                requestHeaders: req.rawHeaders,
                responseHeaders: upstreamRes.rawHeaders,
                request: { bytes: outBody, size: outBody.length, truncated: false, error: null },
                originalRequest: { bytes: original, size: original.length, truncated: false, error: null },
                response,
                transformed,
                overCap,
              });
            } catch (err) {
              log.error(`[gateway] #${id} observation failed: ${err?.stack || err}`);
            }
          })
          .catch((err) => log.error(`[gateway] #${id} capture failed: ${err?.stack || err}`));
      });
    });

    res.on('close', () => {
      if (!res.writableEnded) {
        finish(res.statusCode || 499, 'client disconnected');
        upstreamReq.destroy();
      }
      dispose();
    });

    upstreamReq.end(outBody);
  });
}

/**
 * The transparent forward. Knows nothing about providers, endpoints, or the
 * shape of what it is carrying — it moves bytes and captures a copy.
 *
 * @param {object} deps
 * @param {ReturnType<import('../config/index.js').loadConfig>} deps.config
 * @param {(record: object) => void} [deps.onExchange] observation seam; never
 *   called in passthrough mode, and its throws never reach the client.
 * @param {(request: { port: number|null, path: string, headers: string[] }) => URL|null} [deps.resolveUpstream]
 *   Per-request upstream lookup for observe mode, injected the same way as
 *   `onExchange` and just as provider-ignorant: it receives what transport
 *   already knows (local port, path, headers) and returns an upstream, or null
 *   for a request nothing in the registry claims. Passthrough mode never calls
 *   it — `config.upstream` is its one configured target, from the environment,
 *   and it must not depend on routing.
 * @param {(exchange: { port: number|null, path: string, headers: string[], body: Buffer }) => Promise<Buffer|null>} [deps.transformRequest]
 *   The transform seam, mirroring `onExchange`: optional, injected, called only
 *   in transform mode, once the request body is fully buffered. Returns the
 *   bytes to forward in place of the original, or null to forward the original
 *   unchanged (invariant 6, and the fallback for any throw). Transport learns
 *   nothing about canonical objects here — bytes in, bytes or null back.
 */
export function createProxyHandler({ config, onExchange, resolveUpstream, transformRequest, log = console }) {
  const observing = config.mode !== MODE_PASSTHROUGH;
  const transforming = config.mode === MODE_TRANSFORM && typeof transformRequest === 'function';

  return function handle(req, res) {
    const id = nextRequestId++;
    const startedAt = Date.now();
    // Which entrypoint the client reached. Transport reporting what it saw —
    // the registry can key a provider on a port, and only transport knows it.
    const port = req.socket?.localPort ?? null;

    let upstream = config.upstream;
    if (observing && resolveUpstream) {
      const resolved = resolveUpstream({ port, path: req.url, headers: req.rawHeaders });
      if (resolved === null) {
        if (config.accessLog) log.error(`[gateway] #${id} ${req.method} ${req.url} -> 404 unrouted`);
        failClosed(res, 404, 'Not found');
        return;
      }
      upstream = resolved;
    }
    const target = resolveTarget(upstream, req.url);

    let settled = false;
    const finish = (status, note) => {
      if (settled) return;
      settled = true;
      if (config.accessLog) {
        const ms = Date.now() - startedAt;
        log.error(
          `[gateway] #${id} ${req.method} ${req.url} -> ${status} ${ms}ms ${config.mode}` +
            (note ? ` (${note})` : ''),
        );
      }
    };

    if (transforming) {
      handleTransforming({ req, res, id, port, target, upstream, config, onExchange, transformRequest, log, finish });
      return;
    }

    const { request: upstreamReq, dispose } = openUpstreamRequest({
      url: target,
      method: req.method,
      headers: upstreamRequestHeaders(req.rawHeaders, upstream),
      timeouts: config.timeouts,
      onTimeout: (kind) => {
        dispose();
        upstreamReq.destroy(new Error(`upstream ${kind} timeout`));
        finish(504, `${kind} timeout`);
        failClosed(res, 504, `Gateway timeout (${kind})`);
      },
    });

    // Forward first, observe second. The capture attaches as an extra reader on
    // a stream already being piped upstream; it never gates the forward.
    req.pipe(upstreamReq);
    const captured = observing ? captureBody(req, { maxBytes: config.maxCaptureBytes }) : null;

    req.on('error', () => {
      // Client vanished mid-upload. Don't leak the upstream socket.
      upstreamReq.destroy();
    });

    upstreamReq.on('error', (err) => {
      dispose();
      if (settled) return;
      finish(502, err.code || err.message);
      failClosed(res, 502, `Bad gateway (${err.code || 'upstream error'})`);
    });

    upstreamReq.on('response', (upstreamRes) => {
      dispose();

      // Byte-for-byte: original status code, status message, and every
      // end-to-end header, before anything is inspected.
      if (res.destroyed || res.writableEnded) {
        upstreamRes.destroy();
        return;
      }
      res.writeHead(
        upstreamRes.statusCode,
        upstreamRes.statusMessage,
        clientResponseHeaders(upstreamRes.rawHeaders),
      );

      // Client first, always. Chunks are never held, and the accumulator is
      // wired after the pipe so it can never sit in front of the client.
      upstreamRes.pipe(res);
      const responseCapture = observing
        ? captureBody(upstreamRes, { maxBytes: config.maxCaptureBytes })
        : null;

      upstreamRes.on('error', () => {
        finish(upstreamRes.statusCode, 'upstream stream error');
        res.destroy();
      });

      res.on('finish', () => {
        finish(upstreamRes.statusCode);
        if (!observing) return;
        Promise.all([captured, responseCapture])
          .then(([request, response]) => {
            // Phase 1 has no layers above transport. This is the seam they
            // will attach to; a throw here must never touch the client.
            try {
              onExchange?.({
                id,
                startedAt,
                finishedAt: Date.now(),
                method: req.method,
                url: req.url,
                port,
                target: target.href,
                statusCode: upstreamRes.statusCode,
                // rawHeaders, not the lowercased object: later layers need to
                // read a content type without losing header fidelity.
                requestHeaders: req.rawHeaders,
                responseHeaders: upstreamRes.rawHeaders,
                request,
                response,
              });
            } catch (err) {
              log.error(`[gateway] #${id} observation failed: ${err?.stack || err}`);
            }
          })
          .catch((err) => log.error(`[gateway] #${id} capture failed: ${err?.stack || err}`));
      });
    });

    // Client disconnected mid-stream: abort upstream rather than draining a
    // response nobody will read.
    res.on('close', () => {
      if (!res.writableEnded) {
        finish(res.statusCode || 499, 'client disconnected');
        upstreamReq.destroy();
      }
      dispose();
    });
  };
}
