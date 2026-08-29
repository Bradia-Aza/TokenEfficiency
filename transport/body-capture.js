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
