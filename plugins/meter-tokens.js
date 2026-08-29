// Per-turn and per-session token accounting.
//
// This is the point of metering from the skeleton onward: every future
// transform gets judged against the numbers this collects today, so it records
// what the provider reported and nothing derived. A token the provider did not
// report stays null in the per-turn record rather than becoming a zero that
// later reads as fact.
//
// The ledger accumulates in memory, so a gateway restart begins a new ledger
// for a conversation that continues across it. The transcript does not have
// that problem — every request carries the full history — and durable ledgers
// are a control-plane concern, not a skeleton one.

import { renderLedger } from '../sinks/markdown.js';

const zeroTotals = () => ({
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  requestBytes: 0,
  responseBytes: 0,
});

export function createMeterTokens({ store, now = Date.now }) {
  /** @type {Map<string, object>} session id -> ledger */
  const ledgers = new Map();

  return {
    name: 'meter-tokens',

    async onResponse(response, ctx) {
      let ledger = ledgers.get(ctx.sessionId);
      if (ledger === undefined) {
        ledger = { sessionId: ctx.sessionId, provider: ctx.provider, turns: [], totals: zeroTotals() };
        ledgers.set(ctx.sessionId, ledger);
      }

      const usage = response.usage;
      const turn = {
        turn: ledger.turns.length + 1,
        at: new Date(ctx.finishedAt ?? now()).toISOString(),
        exchangeId: ctx.exchangeId,
        model: response.model,
        status: ctx.status,
        stopReason: response.stopReason,
        streamed: ctx.streamed,
        durationMs: ctx.durationMs,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        // Broken out of outputTokens rather than derived from it: reasoning is
        // generated, billed, and invisible in the transcript, so it is the one
        // line a later transform is most likely to move.
        reasoningTokens: usage?.reasoningTokens ?? null,
        cacheReadTokens: usage?.cacheReadTokens ?? null,
        cacheWriteTokens: usage?.cacheWriteTokens ?? null,
        // As the provider reported it, not as the parts add up.
        totalTokens: usage?.totalTokens ?? null,
        // The wire cost beside the token cost: a transform that trades bytes
        // for tokens has to be visible as both.
        requestBytes: ctx.raw.requestSize,
        responseBytes: ctx.raw.responseSize,
      };
      ledger.turns.push(turn);

      const totals = ledger.totals;
      totals.turns = ledger.turns.length;
      totals.inputTokens += turn.inputTokens ?? 0;
      totals.outputTokens += turn.outputTokens ?? 0;
      totals.reasoningTokens += turn.reasoningTokens ?? 0;
      totals.cacheReadTokens += turn.cacheReadTokens ?? 0;
      totals.cacheWriteTokens += turn.cacheWriteTokens ?? 0;
      totals.totalTokens += turn.totalTokens ?? 0;
      totals.requestBytes += turn.requestBytes;
      totals.responseBytes += turn.responseBytes;
      ledger.updatedAt = turn.at;

      // Two artifacts from one ledger: the table is for reading, the JSON is the
      // baseline a later phase diffs against.
      await store.write(ctx.sessionId, 'tokens.json', `${JSON.stringify(ledger, null, 2)}\n`);
      await store.write(ctx.sessionId, 'tokens.md', renderLedger(ledger));
    },

    /** A copy of a session's ledger. Read-only by construction. */
    ledgerFor(sessionId) {
      const ledger = ledgers.get(sessionId);
      return ledger === undefined ? null : structuredClone(ledger);
    },
  };
}
