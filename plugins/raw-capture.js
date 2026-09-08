// Raw, lossless capture of every observed exchange, as newline-delimited JSON.
//
// This is a research instrument, not a product sink (INTERCEPTION_RESEARCH_PLAN.md,
// Phase 0.1). It exists because the markdown sinks beside it are for human
// reading and drop exactly the detail the interception study needs: the request
// and response bodies verbatim, the headers, the route, and the timing.
//
// It is an ordinary read-only observer under invariant 1 — frozen input, no
// return value — and its throws are already isolated by the pipeline. Under rig
// invariant 3 it normalizes nothing: bodies are recorded as they arrived, and a
// body that is not valid UTF-8 is recorded as base64 rather than mangled into
// replacement characters.
//
// Deleting this file and `research/` must leave `npm test` green.

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';

const DEFAULT_PATH = 'research/captures/proxy.jsonl';

/** rawHeaders is a flat [name, value, name, value] array; keep duplicates. */
function headerPairs(raw) {
  const pairs = [];
  if (!Array.isArray(raw)) return pairs;
  for (let i = 0; i < raw.length; i += 2) pairs.push([raw[i], raw[i + 1]]);
  return pairs;
}

/**
 * Bytes as text when they are valid UTF-8, as base64 when they are not.
 * Round-tripping matters more than readability here: this is the research
 * record, and a body the study cannot reconstruct is a body it cannot measure.
 */
function encodeBody(bytes) {
  if (bytes === null || bytes === undefined) return { encoding: null, body: null };
  const text = bytes.toString('utf8');
  if (Buffer.compare(Buffer.from(text, 'utf8'), bytes) === 0) {
    return { encoding: 'utf8', body: text };
  }
  return { encoding: 'base64', body: bytes.toString('base64') };
}

/**
 * @param {object} options
 * @param {string} [options.path] JSONL file to append to
 */
export function createRawCapture({ path = process.env.GATEWAY_RAW_CAPTURE || DEFAULT_PATH } = {}) {
  const file = resolvePath(path);
  let sequence = 0;
  // Appends are serialized so two concurrent turns cannot interleave a line.
  let chain = Promise.resolve();
  let directoryReady = null;

  const append = (record) => {
    const line = `${JSON.stringify(record)}\n`;
    chain = chain.then(
      async () => {
        directoryReady ??= mkdir(dirname(file), { recursive: true });
        await directoryReady;
        await appendFile(file, line);
      },
      async () => {},
    );
    return chain;
  };

  return {
    name: 'raw-capture',
    path: file,

    // The request is recorded on the response hook, not the request hook: one
    // line per exchange holds both directions, and only here are the status,
    // the response bytes and the duration known. onRequest firing without a
    // matching onResponse is itself observable — the line simply never appears,
    // and the proxy's own access log has the request.
    async onResponse(response, ctx) {
      const request = encodeBody(ctx.raw.request);
      const responseBody = encodeBody(ctx.raw.response);
      await append({
        side: 'proxy',
        seq: sequence++,
        at: new Date(ctx.finishedAt ?? Date.now()).toISOString(),
        exchangeId: ctx.exchangeId,
        sessionId: ctx.sessionId,
        provider: ctx.provider,
        method: ctx.method,
        path: ctx.path,
        url: ctx.url,
        status: ctx.status,
        streamed: ctx.streamed,
        startedAt: ctx.startedAt,
        finishedAt: ctx.finishedAt,
        durationMs: ctx.durationMs,
        requestEncoding: request.encoding,
        requestBody: request.body,
        requestSize: ctx.raw.requestSize,
        requestTruncated: ctx.raw.requestTruncated,
        responseEncoding: responseBody.encoding,
        responseBody: responseBody.body,
        responseSize: ctx.raw.responseSize,
        responseTruncated: ctx.raw.responseTruncated,
        requestHeaders: headerPairs(ctx.raw.requestHeaders),
        responseHeaders: headerPairs(ctx.raw.responseHeaders),
        // Present only in transform mode: what the client sent before the
        // rewrite, so the study can tell a transformed body from an original.
        transform:
          ctx.transform === null || ctx.transform === undefined
            ? null
            : {
                transformed: ctx.transform.transformed,
                overCap: ctx.transform.overCap,
                edits: ctx.transform.edits,
                requestBytesBefore: ctx.transform.requestBytesBefore,
                requestBytesAfter: ctx.transform.requestBytesAfter,
              },
        usage: response.usage ?? null,
        model: response.model ?? null,
        stopReason: response.stopReason ?? null,
      });
    },

    /** Let the last line land before the process exits. */
    async close() {
      await chain;
    },
  };
}
