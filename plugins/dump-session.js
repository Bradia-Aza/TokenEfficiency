// Renders each session to a markdown transcript under sessions/.
//
// Knows nothing about providers or wire formats: it reads canonical objects and
// hands strings to a sink.

import { renderTranscript } from '../sinks/markdown.js';

// onResponse is skipped whenever a response cannot be modeled, so a request can
// outlive its turn. The map is bounded rather than trusted to drain.
const MAX_PENDING = 128;

export function createDumpSession({ store }) {
  /** @type {Map<number, object>} exchange id -> canonical request awaiting its response */
  const pending = new Map();

  return {
    name: 'dump-session',

    onRequest(request, ctx) {
      pending.set(ctx.exchangeId, request);
      while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value);
    },

    async onResponse(response, ctx) {
      const request = pending.get(ctx.exchangeId);
      pending.delete(ctx.exchangeId);
      if (request === undefined) {
        // Not a data problem — the hooks are dispatched as a pair, so this can
        // only mean a wiring bug. Throwing puts it in the log; the pipeline
        // keeps the client out of it.
        throw new Error(`no observed request for exchange #${ctx.exchangeId}`);
      }
      await store.write(ctx.sessionId, 'transcript.md', renderTranscript({ request, response, ctx }));
    },
  };
}
