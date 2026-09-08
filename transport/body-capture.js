// Capturing must never slow the forward down or break it. The capture attaches
// as an extra reader on a stream that is already being piped upstream, and every
// failure path resolves rather than rejects.

/**
 * Tee a readable into memory without backpressuring it.
 *
 * @param {import('node:stream').Readable} stream
 * @param {{ maxBytes: number }} options
 * @returns {Promise<{ bytes: Buffer|null, size: number, truncated: boolean, error: Error|null }>}
 *   Never rejects. `bytes` is null when the capture was abandoned.
 */
export function captureBody(stream, { maxBytes }) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let truncated = false;
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.removeListener('aborted', onAborted);
      resolve({
        bytes: truncated || error ? null : Buffer.concat(chunks, size),
        size,
        truncated,
        error: error ?? null,
      });
    };

    const onData = (chunk) => {
      if (truncated) return;
      size += chunk.length;
      if (size > maxBytes) {
        // Drop what we have; the forward is unaffected either way.
        truncated = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(null);
    const onError = (err) => finish(err);
    const onAborted = () => finish(new Error('client aborted before body completed'));

    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.once('aborted', onAborted);
  });
}

/**
 * Buffer a readable to completion before anything is forwarded — what transform
 * mode needs, since a body cannot be rewritten while it is already streaming
 * (TRANSFORM_PLAN.md, invariant 4 narrowed to the response path).
 *
 * Unlike `captureBody`, the bytes are never dropped: only one upstream request
 * is ever made per client request in transform mode, so whatever is read here
 * is what has to be forwarded — there is no separate live pipe to fall back
 * to. `overCap` reports whether `maxBytes` was exceeded so the caller can skip
 * the transform (which does need a bound on what it holds in memory to
 * inspect) while still forwarding the complete, untruncated body — the "degrade
 * to observe behavior, never truncate a request" rule the plan states for the
 * cap.
 *
 * @param {import('node:stream').Readable} stream
 * @param {{ maxBytes: number }} options
 * @returns {Promise<{ bytes: Buffer, size: number, overCap: boolean, error: Error|null }>}
 *   Never rejects. `bytes` is null only when the stream itself errored.
 */
export function bufferBody(stream, { maxBytes }) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let overCap = false;
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.removeListener('aborted', onAborted);
      resolve({ bytes: error ? null : Buffer.concat(chunks, size), size, overCap, error: error ?? null });
    };

    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) overCap = true;
      chunks.push(chunk);
    };
    const onEnd = () => finish(null);
    const onError = (err) => finish(err);
    const onAborted = () => finish(new Error('client aborted before body completed'));

    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.once('aborted', onAborted);
  });
}
