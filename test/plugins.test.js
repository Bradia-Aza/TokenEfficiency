import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { adapter } from '../adapters/anthropic.js';
import { createDumpSession } from '../plugins/dump-session.js';
import { createPlugins } from '../plugins/index.js';
import { createMeterTokens } from '../plugins/meter-tokens.js';
import { renderTranscript } from '../sinks/markdown.js';
import { createSessionStore } from '../sinks/sessions.js';
import { tempSessionsDir } from './helpers.js';

const ctxFor = (overrides = {}) => ({
  exchangeId: 1,
  sessionId: 'abc123def456',
  provider: 'test-provider',
  modeled: true,
  method: 'POST',
  path: '/v1/messages',
  url: '/v1/messages',
  status: 200,
  startedAt: 1_700_000_000_000,
  finishedAt: 1_700_000_000_120,
  durationMs: 120,
  streamed: false,
  raw: { requestSize: 900, responseSize: 400, requestHeaders: [], responseHeaders: [] },
  ...overrides,
});

// ---------------------------------------------------------------------------
// sinks/sessions.js
// ---------------------------------------------------------------------------

test('writes land under sessions/<id>/ and replace the previous version', async (t) => {
  const store = createSessionStore({ dir: tempSessionsDir(t) });
  await store.write('abc123', 'transcript.md', 'first');
  await store.write('abc123', 'transcript.md', 'second');

  assert.equal(readFileSync(store.pathFor('abc123', 'transcript.md'), 'utf8'), 'second');
  // The temporary file used for the atomic replace does not survive.
  assert.deepEqual(readdirSync(join(store.root, 'abc123')), ['transcript.md']);
});

test('concurrent writes to one session serialize instead of interleaving', async (t) => {
  const store = createSessionStore({ dir: tempSessionsDir(t) });
  const bodies = Array.from({ length: 12 }, (_, i) => `contents-${i}`.repeat(500));
  await Promise.all(bodies.map((body) => store.write('abc123', 'transcript.md', body)));

  const written = readFileSync(store.pathFor('abc123', 'transcript.md'), 'utf8');
  assert.ok(bodies.includes(written), 'the file is exactly one of the writes, never a blend of several');
});

test('a failed write does not poison the queue behind it', async (t) => {
  const store = createSessionStore({ dir: tempSessionsDir(t) });
  await assert.rejects(store.write('../escape', 'transcript.md', 'x'), /unsafe session id/);
  await assert.rejects(store.write('abc123', '../../etc/passwd', 'x'), /unsafe filename/);
  await store.write('abc123', 'transcript.md', 'still works');
  assert.equal(readFileSync(store.pathFor('abc123', 'transcript.md'), 'utf8'), 'still works');
});

// ---------------------------------------------------------------------------
// sinks/markdown.js
// ---------------------------------------------------------------------------

test('a transcript renders every block type from canonical objects alone', () => {
  const request = adapter.requestToCanonical(
    JSON.parse(readFileSync(new URL('./fixtures/request-tools-multi-call.json', import.meta.url), 'utf8')),
  );
  const response = adapter.responseToCanonical(
    JSON.parse(readFileSync(new URL('./fixtures/response-thinking.json', import.meta.url), 'utf8')),
  );
  const markdown = renderTranscript({ request, response, ctx: ctxFor() });

  assert.match(markdown, /^# Session abc123def456/);
  assert.match(markdown, /\*\*provider\*\* `test-provider`/);
  assert.match(markdown, /## Tools offered\n\n- `read_file` — Read a file from disk\./);
  assert.match(markdown, /### 1 · user/);
  assert.match(markdown, /\*\*tool call\*\* `read_file` _\(toolu_01A\)_/);
  assert.match(markdown, /\*\*tool result\*\* `run_tests` _\(toolu_01B\)_ — \*\*error\*\*/);
  assert.match(markdown, /\*\*thinking\*\*\n\n> Two directions/);
  assert.match(markdown, /\*\*thinking\*\* _\(redacted by the provider\)_/);
  assert.match(markdown, /\*\*stop reason\*\* `end_turn`/);
  assert.match(markdown, /input 512 · output 320 · reasoning — · cache read 4,096 · cache write 0 · total —/);
});

test('code fences grow to survive the code inside them', () => {
  const request = adapter.requestToCanonical({
    model: 'm',
    max_tokens: 8,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            // A tool result holding a markdown file holding a fenced block:
            // exactly the case a three-backtick fence gets wrong.
            content: 'see:\n```js\nconst x = 1;\n```\ndone',
          },
        ],
      },
    ],
  });
  const markdown = renderTranscript({ request, response: null, ctx: ctxFor() });

  assert.match(markdown, /````\nsee:\n```js\nconst x = 1;\n```\ndone\n````/);
  assert.match(markdown, /could not be modeled; it was forwarded unchanged/);
});

test('media payloads are described, never inlined', () => {
  const request = adapter.requestToCanonical(
    JSON.parse(readFileSync(new URL('./fixtures/request-image.json', import.meta.url), 'utf8')),
  );
  const markdown = renderTranscript({ request, response: null, ctx: ctxFor() });

  assert.match(markdown, /\*\*attachment\*\* — image\/png \(18 bytes, base64\)/);
  assert.match(markdown, /\*\*attachment\*\* — unknown type \(https:\/\/example\.test\/diagram\.png\)/);
  // The breakpoint that decides cache-read vs cache-write shows up beside the
  // content it applies to, not only as a number in the ledger.
  assert.match(markdown, /_cache breakpoint_/);
  assert.doesNotMatch(markdown, /iVBORw0KGgo/, 'base64 data would dwarf the turn it belongs to');
});

test('an unmodeled block is surfaced rather than quietly dropped', () => {
  const request = adapter.requestToCanonical(
    JSON.parse(readFileSync(new URL('./fixtures/request-unmodeled.json', import.meta.url), 'utf8')),
  );
  const markdown = renderTranscript({ request, response: null, ctx: ctxFor() });
  // The provider-executed search itself is modeled; what it returned is not,
  // and the transcript says so rather than hiding it.
  assert.match(markdown, /\*\*tool call\*\* `web_search` _\(srvtoolu_01\)_ _\(provider-executed\)_/);
  assert.match(markdown, /\*\*tool result\*\* `web_search` _\(srvtoolu_01\)_ _\(provider-executed\)_/);
  assert.match(markdown, /\*\*unmodeled block\*\* `web_search_result`/);
});

// ---------------------------------------------------------------------------
// plugins
// ---------------------------------------------------------------------------

const simpleRequest = (opening) =>
  adapter.requestToCanonical({
    model: 'claude-opus-5',
    max_tokens: 64,
    messages: [{ role: 'user', content: opening }],
  });

const simpleResponse = (usage) =>
  adapter.responseToCanonical({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage,
  });

test('dump-session writes one transcript per session', async (t) => {
  const store = createSessionStore({ dir: tempSessionsDir(t) });
  const plugin = createDumpSession({ store });
  const ctx = ctxFor();

  plugin.onRequest(simpleRequest('hello'), ctx);
  await plugin.onResponse(simpleResponse({ input_tokens: 5, output_tokens: 2 }), ctx);

  const markdown = readFileSync(store.pathFor('abc123def456', 'transcript.md'), 'utf8');
  assert.match(markdown, /### 1 · user\n\nhello/);
  assert.match(markdown, /### 2 · assistant\n\nok/);
});

test('dump-session reports a missing request instead of writing a partial transcript', async (t) => {
  const store = createSessionStore({ dir: tempSessionsDir(t) });
  const plugin = createDumpSession({ store });
  await assert.rejects(plugin.onResponse(simpleResponse({}), ctxFor()), /no observed request for exchange #1/);
});

test('meter-tokens accumulates a ledger across the turns of a session', async (t) => {
  const store = createSessionStore({ dir: tempSessionsDir(t) });
  const plugin = createMeterTokens({ store });

  await plugin.onResponse(
    simpleResponse({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 4000,
      cache_creation_input_tokens: 300,
    }),
    ctxFor({ exchangeId: 1 }),
  );
  await plugin.onResponse(
    simpleResponse({
      input_tokens: 130,
      output_tokens: 45,
      cache_read_input_tokens: 4300,
      cache_creation_input_tokens: 0,
    }),
    ctxFor({ exchangeId: 2, streamed: true }),
  );

  const ledger = JSON.parse(readFileSync(store.pathFor('abc123def456', 'tokens.json'), 'utf8'));
  assert.equal(ledger.totals.turns, 2);
  assert.equal(ledger.totals.inputTokens, 230);
  assert.equal(ledger.totals.outputTokens, 65);
  assert.equal(ledger.totals.cacheReadTokens, 8300);
  assert.equal(ledger.totals.cacheWriteTokens, 300);
  assert.equal(ledger.totals.requestBytes, 1800, 'wire cost is metered beside token cost');
  assert.equal(ledger.turns[1].streamed, true);
  assert.deepEqual(ledger.turns.map((turn) => turn.turn), [1, 2]);
  assert.deepEqual(ledger, plugin.ledgerFor('abc123def456'));

  const markdown = readFileSync(store.pathFor('abc123def456', 'tokens.md'), 'utf8');
  assert.match(markdown, /\| 1 \| .* \| claude-opus-5 \| 100 \| 20 \| — \| 4,000 \| 300 \| — \| end_turn \| 120 \|/);
  assert.match(markdown, /\*\*totals\*\* input 230 · output 65 · reasoning 0 · cache read 8,300 · cache write 300 · total 0/);
});

test('a token the provider did not report stays null rather than becoming zero', async (t) => {
  const store = createSessionStore({ dir: tempSessionsDir(t) });
  const plugin = createMeterTokens({ store });
  await plugin.onResponse(simpleResponse({ input_tokens: 10, output_tokens: 3 }), ctxFor());

  const [turn] = plugin.ledgerFor('abc123def456').turns;
  assert.equal(turn.cacheReadTokens, null);
  assert.equal(turn.inputTokens, 10);
  assert.match(readFileSync(store.pathFor('abc123def456', 'tokens.md'), 'utf8'), /\| 10 \| 3 \| — \| — \| — \| — \|/);
});

test('the registry builds only known plugins', () => {
  const store = createSessionStore({ dir: '/unused' });
  assert.deepEqual(
    createPlugins(['meter-tokens', 'dump-session'], { store }).map((p) => p.name),
    ['meter-tokens', 'dump-session'],
  );
  assert.deepEqual(createPlugins([], { store }), []);
  assert.throws(() => createPlugins(['minify-tools'], { store }), /unknown plugin "minify-tools"/);
});
