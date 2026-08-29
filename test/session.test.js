// The Phase 3 exit criterion, end to end: a session through the live proxy
// yields a complete transcript plus a token ledger sourced entirely from
// canonical objects, and a plugin that throws on every turn leaves the session
// working and the client's bytes untouched.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { createExchangeObserver } from '../pipeline/exchange.js';
import { createRouter } from '../routing/index.js';
import { createPipeline } from '../pipeline/index.js';
import { createPlugins } from '../plugins/index.js';
import { createSessionStore } from '../sinks/sessions.js';
import { raw, startGateway, startUpstream, tempSessionsDir } from './helpers.js';

const TURN_1_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_turn1","type":"message","role":"assistant","model":"claude-opus-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1500,"cache_creation_input_tokens":800,"cache_read_input_tokens":12000,"output_tokens":1}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I\'ll read the server first."}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_health","name":"read_file","input":{}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"transport/server.js\\"}"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":1}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":64}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

const TURN_2_JSON = JSON.stringify({
  id: 'msg_turn2',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text: 'Added the health check to the listener.' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 1800,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 12800,
    output_tokens: 30,
  },
});

const CONVERSATION = {
  model: 'claude-opus-5',
  max_tokens: 4096,
  stream: true,
  metadata: { user_id: 'user_abc_session_42' },
  system: [{ type: 'text', text: 'You are Claude Code.' }],
  tools: [
    {
      name: 'read_file',
      description: 'Read a file from disk.',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ],
};

const turnOneBody = JSON.stringify({
  ...CONVERSATION,
  messages: [{ role: 'user', content: 'add a health check' }],
});

const turnTwoBody = JSON.stringify({
  ...CONVERSATION,
  stream: false,
  messages: [
    { role: 'user', content: 'add a health check' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: "I'll read the server first." },
        { type: 'tool_use', id: 'toolu_health', name: 'read_file', input: { path: 'transport/server.js' } },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_health',
          content: 'export function createServer({ config }) {\n  // ...\n}',
        },
      ],
    },
  ],
});

/** Serves turn 1 as a real SSE stream and turn 2 as a plain JSON message. */
function conversationUpstream() {
  return (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // Dribbled out, so the gateway is genuinely streaming rather than
        // handed one convenient chunk.
        let offset = 0;
        const tick = setInterval(() => {
          if (offset >= TURN_1_SSE.length) {
            clearInterval(tick);
            res.end();
            return;
          }
          res.write(TURN_1_SSE.slice(offset, offset + 64));
          offset += 64;
        }, 1);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(TURN_2_JSON);
    });
  };
}

async function waitFor(predicate, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for observation to land');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * The real stack: config -> plugins -> pipeline -> observer, with one plugin
 * that fails on every hook wired in ahead of the working ones.
 */
async function startObservingGateway(t, { upstreamOrigin, sessionsDir }) {
  const failures = [];
  const gateway = await startGateway(
    { GATEWAY_UPSTREAM: upstreamOrigin, GATEWAY_SESSIONS_DIR: sessionsDir },
    {
      buildObserver: ({ config, log }) => {
        const store = createSessionStore({ dir: config.sessionsDir });
        const saboteur = {
          name: 'saboteur',
          onRequest() {
            failures.push('onRequest');
            throw new Error('deliberate plugin failure');
          },
          onResponse() {
            failures.push('onResponse');
            throw new Error('deliberate plugin failure');
          },
        };
        const pipeline = createPipeline({
          log,
          plugins: [saboteur, ...createPlugins(config.plugins, { store })],
        });
        return createExchangeObserver({
          resolve: createRouter({ providers: config.providers }),
          pipeline,
          log,
        });
      },
    },
  );
  t.after(() => gateway.close());
  return { gateway, failures };
}

test('a full session yields a transcript and a token ledger, with a broken plugin in the list', async (t) => {
  const sessionsDir = tempSessionsDir(t);
  const upstream = await startUpstream(conversationUpstream());
  t.after(() => upstream.close());
  const { gateway, failures } = await startObservingGateway(t, {
    upstreamOrigin: upstream.origin,
    sessionsDir,
  });

  // --- turn 1: streamed -----------------------------------------------------
  const first = await raw(gateway.origin, { method: 'POST', path: '/v1/messages', body: turnOneBody });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.toString(), TURN_1_SSE, 'the client got the stream byte-for-byte');

  // --- turn 2: not streamed -------------------------------------------------
  const second = await raw(gateway.origin, { method: 'POST', path: '/v1/messages', body: turnTwoBody });
  assert.equal(second.body.toString(), TURN_2_JSON);

  const sessionId = await waitFor(() => {
    const found = readdirSync(sessionsDir);
    return found.length === 1 ? found[0] : null;
  });
  const read = (file) => readFileSync(`${sessionsDir}/${sessionId}/${file}`, 'utf8');
  const ledger = await waitFor(() => {
    if (!existsSync(`${sessionsDir}/${sessionId}/tokens.json`)) return null;
    const parsed = JSON.parse(read('tokens.json'));
    return parsed.turns.length === 2 ? parsed : null;
  });

  // Both turns landed in one session, because both carry the same opening.
  assert.equal(readdirSync(sessionsDir).length, 1, 'two turns of one conversation are one session');
  assert.deepEqual(readdirSync(`${sessionsDir}/${sessionId}`).sort(), [
    'tokens.json',
    'tokens.md',
    'transcript.md',
  ]);

  // --- the transcript -------------------------------------------------------
  const transcript = await waitFor(() => {
    const text = read('transcript.md');
    return text.includes('Added the health check') ? text : null;
  });
  assert.match(transcript, /\*\*provider\*\* `anthropic`/);
  assert.match(transcript, /\*\*model\*\* `claude-opus-5`/);
  assert.match(transcript, /- \*\*turns\*\* 4/);
  assert.match(transcript, /## System\n\nYou are Claude Code\./);
  assert.match(transcript, /- `read_file` — Read a file from disk\./);
  assert.match(transcript, /### 1 · user\n\nadd a health check/);
  assert.match(transcript, /\*\*tool call\*\* `read_file` _\(toolu_health\)_/);
  assert.match(transcript, /"path": "transport\/server\.js"/);
  assert.match(transcript, /\*\*tool result\*\* `read_file` _\(toolu_health\)_/);
  assert.match(transcript, /### 4 · assistant\n\nAdded the health check to the listener\./);
  assert.match(transcript, /\*\*stop reason\*\* `end_turn`/);

  // --- the ledger -----------------------------------------------------------
  assert.equal(ledger.provider, 'anthropic');
  assert.equal(ledger.totals.turns, 2);
  assert.equal(ledger.totals.inputTokens, 1500 + 1800);
  assert.equal(ledger.totals.outputTokens, 64 + 30);
  assert.equal(ledger.totals.cacheReadTokens, 12000 + 12800);
  assert.equal(ledger.totals.cacheWriteTokens, 800);
  assert.equal(ledger.turns[0].streamed, true, 'the streamed turn was metered from accumulated events');
  assert.equal(ledger.turns[0].stopReason, 'tool_call');
  assert.equal(ledger.turns[1].streamed, false);
  assert.equal(ledger.turns[1].stopReason, 'end_turn');
  assert.ok(ledger.totals.requestBytes > 0 && ledger.totals.responseBytes > 0);
  assert.match(
    read('tokens.md'),
    /\*\*totals\*\* input 3,300 · output 94 · reasoning 0 · cache read 24,800 · cache write 800 · total 0/,
  );

  // --- the broken plugin ----------------------------------------------------
  assert.deepEqual(failures, ['onRequest', 'onResponse', 'onRequest', 'onResponse'], 'it ran and failed every time');
  assert.equal(
    gateway.logs.filter((line) => line.includes('saboteur')).length,
    4,
    'each failure was logged to stderr',
  );
  assert.equal(
    gateway.logs.filter((line) => !line.includes('saboteur')).length,
    0,
    'and nothing else went wrong',
  );
});

test('passthrough writes nothing at all', async (t) => {
  const sessionsDir = tempSessionsDir(t);
  const upstream = await startUpstream(conversationUpstream());
  t.after(() => upstream.close());
  const { gateway, failures } = await startObservingGateway(t, {
    upstreamOrigin: upstream.origin,
    sessionsDir,
  });
  await gateway.close();

  // Same stack, same request, passthrough mode: the seam is never reached.
  const passthrough = await startGateway(
    {
      GATEWAY_UPSTREAM: upstream.origin,
      GATEWAY_SESSIONS_DIR: sessionsDir,
      GATEWAY_MODE: 'passthrough',
    },
    {
      buildObserver: ({ config, log }) => {
        const store = createSessionStore({ dir: config.sessionsDir });
        const pipeline = createPipeline({ log, plugins: createPlugins(config.plugins, { store }) });
        return createExchangeObserver({ resolve: createRouter({ providers: config.providers }), pipeline, log });
      },
    },
  );
  t.after(() => passthrough.close());

  const res = await raw(passthrough.origin, { method: 'POST', path: '/v1/messages', body: turnTwoBody });
  assert.equal(res.body.toString(), TURN_2_JSON);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.deepEqual(readdirSync(sessionsDir), [], 'the bisect tool stays a dumb pipe');
  assert.deepEqual(failures, []);
  assert.deepEqual(passthrough.logs, []);
});

test('an unmodeled endpoint travels the transparent path and is never written down', async (t) => {
  const sessionsDir = tempSessionsDir(t);
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"input_tokens":42}');
  });
  t.after(() => upstream.close());
  const { gateway } = await startObservingGateway(t, { upstreamOrigin: upstream.origin, sessionsDir });

  const res = await raw(gateway.origin, {
    method: 'POST',
    path: '/v1/messages/count_tokens',
    body: turnOneBody,
  });
  assert.equal(res.body.toString(), '{"input_tokens":42}');
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.deepEqual(readdirSync(sessionsDir), []);
  assert.deepEqual(gateway.logs, []);
});
