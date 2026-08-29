// text/event-stream framing. This is a wire-format concern shared by every
// provider that streams, so it lives beside the adapters rather than inside
// one, and it names no provider.
//
// Decoding is observation only: a malformed field, an unparseable data payload
// or a truncated stream yields whatever was recoverable and never throws. What
// goes to the client is the original bytes, which this never touches.

const FIELD = /^([^:]*)(?:: ?(.*))?$/s;

/**
 * Incremental SSE decoder.
 *
 * @returns {{ push(chunk: string|Buffer): Array<{event: string|null, data: string, id: string|null, retry: number|null}>,
 *             flush(): Array<object> }}
 */
export function createSseDecoder() {
  let buffer = '';
  let event = null;
  let id = null;
  let retry = null;
  let dataLines = [];
  let sawField = false;

  const reset = () => {
    event = null;
    id = null;
    retry = null;
    dataLines = [];
    sawField = false;
  };

  const dispatch = (out) => {
    // A block with no fields at all is just blank-line noise between events.
    if (!sawField) return;
    out.push({ event, data: dataLines.join('\n'), id, retry });
    reset();
  };

  const consumeLine = (line, out) => {
    if (line === '') {
      dispatch(out);
      return;
    }
    if (line.startsWith(':')) return; // comment / keep-alive
    const match = FIELD.exec(line);
    if (!match) return;
    const [, name, value = ''] = match;
    sawField = true;
    switch (name) {
      case 'event':
        event = value;
        break;
      case 'data':
        dataLines.push(value);
        break;
      case 'id':
        id = value;
        break;
      case 'retry': {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n)) retry = n;
        break;
      }
      default:
        break; // unknown field names are ignored per the spec
    }
  };

  return {
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const out = [];
      let start = 0;
      for (;;) {
        const nl = buffer.indexOf('\n', start);
        if (nl === -1) break;
        let line = buffer.slice(start, nl);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        consumeLine(line, out);
        start = nl + 1;
      }
      buffer = buffer.slice(start);
      return out;
    },

    /** Emit whatever a truncated stream left behind. */
    flush() {
      const out = [];
      if (buffer !== '') {
        const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
        buffer = '';
        consumeLine(line, out);
      }
      dispatch(out);
      return out;
    },
  };
}

/** Decode a complete stream in one shot. */
export function decodeSse(text) {
  const decoder = createSseDecoder();
  return [...decoder.push(text), ...decoder.flush()];
}

/**
 * The JSON payload of an SSE record, or null when it isn't JSON.
 * `[DONE]`-style sentinels and truncated payloads land here as null.
 */
export function sseData(record) {
  if (record === null || typeof record !== 'object') return null;
  if (typeof record.data !== 'string' || record.data === '') return null;
  try {
    return JSON.parse(record.data);
  } catch {
    return null;
  }
}
