import { MODE_PASSTHROUGH } from '../config/index.js';
import { captureBody } from './body-capture.js';
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
 * The transparent forward. Knows nothing about providers, endpoints, or the
 * shape of what it is carrying — it moves bytes and captures a copy.
 *
 * @param {object} deps
 * @param {ReturnType<import('../config/index.js').loadConfig>} deps.config
 * @param {(record: object) => void} [deps.onExchange] observation seam; never
 *   called in passthrough mode, and its throws never reach the client.
 */
export function createProxyHandler({ config, onExchange, log = console }) {
  const observing = config.mode !== MODE_PASSTHROUGH;

  return function handle(req, res) {
    const id = nextRequestId++;
    const startedAt = Date.now();
    const target = resolveTarget(config.upstream, req.url);
    // Which entrypoint the client reached. Transport reporting what it saw —
    // the registry can key a provider on a port, and only transport knows it.
    const port = req.socket?.localPort ?? null;

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

    const { request: upstreamReq, dispose } = openUpstreamRequest({
      url: target,
      method: req.method,
      headers: upstreamRequestHeaders(req.rawHeaders, config.upstream),
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
