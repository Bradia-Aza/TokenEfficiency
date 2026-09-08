// The Phase 4 exit criterion: two real sessions — one Claude Code through the
// Anthropic port, one OpenAI client through the OpenAI port — run through ONE
// gateway process and produce complete transcripts and ledgers in sessions/.
// The registry is the shipped one from config/providers.js; nothing here is a
// stand-in, because the claim under test is that a second provider is just an
// entry in the registry plus an adapter, with transport/pipeline/plugins/sinks
// untouched.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { createExchangeObserver } from '../pipeline/exchange.js';
import { createPipeline } from '../pipeline/index.js';
import { createPlugins } from '../plugins/index.js';
import { createRouter } from '../routing/index.js';
import { createSessionStore } from '../sinks/sessions.js';
import { loadConfig } from '../config/index.js';
import { createServer } from '../transport/server.js';
import { raw, startUpstream, tempSessionsDir } from './helpers.js';

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
 * The real composition (config -> router -> pipeline -> both seams), the same
 * wiring index.js does, pointed at two loopback upstreams instead of the real
 * providers. One process, two listeners on two ephemeral ports — exactly the
 * shipped registry's shape, where a second port is what tells the two entries
 * apart. Both listeners share one router, one pipeline and one onExchange,
 * the way a real deployment's single process would.
 */
async function startTwoProviderGateway(t, { anthropicOrigin, openaiOrigin, sessionsDir }) {
  const base = loadConfig({
    GATEWAY_PORT: '0',
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_ACCESS_LOG: '0',
    GATEWAY_ANTHROPIC_UPSTREAM: anthropicOrigin,
    GATEWAY_OPENAI_UPSTREAM: openaiOrigin,
    GATEWAY_SESSIONS_DIR: sessionsDir,
  });

  const logs = [];
  const log = { error: (line) => logs.push(line) };
  const store = createSessionStore({ dir: base.sessionsDir });
  const pipeline = createPipeline({ log, plugins: createPlugins(base.plugins, { store }) });

  // The router and resolveUpstream close over `providers`, which is filled in
  // below once both listeners' real ports are known — a request can only
  // arrive after both listen() calls resolve, so this is safe.
  let providers = base.providers;
  const resolve = (exchange) => createRouter({ providers })(exchange);
  const onExchange = createExchangeObserver({ resolve, pipeline, log });
  const resolveUpstream = ({ port, path }) => resolve({ port, url: path }).upstream;

  const anthropicListener = createServer({ config: { ...base, port: 0 }, onExchange, resolveUpstream, log });
  const openaiListener = createServer({ config: { ...base, port: 0 }, onExchange, resolveUpstream, log });
  await Promise.all([anthropicListener.listen(), openaiListener.listen()]);
  const anthropicPort = anthropicListener.server.address().port;
  const openaiPort = openaiListener.server.address().port;

  // Now that both real ports are known, key the registry on them — exactly
  // the shipped registry's shape, just with ephemeral ports instead of 8787
  // and 8788.
  providers = base.providers.map((entry) =>
    entry.name === 'openai' ? { ...entry, port: openaiPort } : { ...entry, port: anthropicPort },
  );

  t.after(() =>
    Promise.all([
      new Promise((res) => anthropicListener.server.close(res)),
      new Promise((res) => openaiListener.server.close(res)),
    ]),
  );

  return {
    anthropicOrigin: `http://127.0.0.1:${anthropicPort}`,
    openaiOrigin: `http://127.0.0.1:${openaiPort}`,
    logs,
  };
}

test('one gateway process serves an Anthropic session and an OpenAI session, each with its own transcript and ledger', async (t) => {
  const sessionsDir = tempSessionsDir(t);

  const anthropicUpstream = await startUpstream((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_anthropic_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5',
          content: [{ type: 'text', text: 'Paris.' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 3 },
        }),
      );
    });
  });
  t.after(() => anthropicUpstream.close());

  const openaiUpstream = await startUpstream((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl_openai_1',
          object: 'chat.completion',
          model: 'gpt-5',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Tokyo.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 18, completion_tokens: 2, total_tokens: 20 },
        }),
      );
    });
  });
  t.after(() => openaiUpstream.close());

  const { anthropicOrigin: gatewayAnthropicOrigin, openaiOrigin: gatewayOpenaiOrigin, logs } =
    await startTwoProviderGateway(t, {
      anthropicOrigin: anthropicUpstream.origin,
      openaiOrigin: openaiUpstream.origin,
      sessionsDir,
    });

  const anthropicBody = JSON.stringify({
    model: 'claude-opus-5',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'What is the capital of France?' }],
  });
  const anthropicRes = await raw(gatewayAnthropicOrigin, { method: 'POST', path: '/v1/messages', body: anthropicBody });
  assert.equal(anthropicRes.statusCode, 200);
  assert.match(anthropicRes.body.toString(), /Paris/);

  const openaiBody = JSON.stringify({
    model: 'gpt-5',
    max_completion_tokens: 100,
    messages: [{ role: 'user', content: 'What is the capital of Japan?' }],
  });
  const openaiRes = await raw(gatewayOpenaiOrigin, { method: 'POST', path: '/v1/chat/completions', body: openaiBody });
  assert.equal(openaiRes.statusCode, 200);
  assert.match(openaiRes.body.toString(), /Tokyo/);

  const sessionIds = await waitFor(() => {
    const found = readdirSync(sessionsDir);
    if (found.length !== 2) return null;
    return found.every((id) => existsSync(`${sessionsDir}/${id}/tokens.json`)) ? found : null;
  });

  const ledgers = sessionIds.map((id) => JSON.parse(readFileSync(`${sessionsDir}/${id}/tokens.json`, 'utf8')));
  const anthropicLedger = ledgers.find((l) => l.provider === 'anthropic');
  const openaiLedger = ledgers.find((l) => l.provider === 'openai');

  assert.ok(anthropicLedger, 'an anthropic ledger was written');
  assert.ok(openaiLedger, 'an openai ledger was written');
  assert.equal(anthropicLedger.totals.inputTokens, 20);
  assert.equal(anthropicLedger.totals.outputTokens, 3);
  assert.equal(openaiLedger.totals.inputTokens, 18);
  assert.equal(openaiLedger.totals.outputTokens, 2);

  const anthropicTranscript = readFileSync(
    `${sessionsDir}/${sessionIds.find((id, i) => ledgers[i].provider === 'anthropic')}/transcript.md`,
    'utf8',
  );
  const openaiTranscript = readFileSync(
    `${sessionsDir}/${sessionIds.find((id, i) => ledgers[i].provider === 'openai')}/transcript.md`,
    'utf8',
  );
  assert.match(anthropicTranscript, /\*\*provider\*\* `anthropic`/);
  assert.match(anthropicTranscript, /Paris/);
  assert.match(openaiTranscript, /\*\*provider\*\* `openai`/);
  assert.match(openaiTranscript, /Tokyo/);

  assert.deepEqual(logs, [], 'no observation failures on either provider');
});

test('everything on the OpenAI surface except /v1/chat/completions is unmodeled and takes the transparent path', async (t) => {
  const sessionsDir = tempSessionsDir(t);
  const openaiUpstream = await startUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"object":"list","data":[]}');
  });
  t.after(() => openaiUpstream.close());
  const anthropicUpstream = await startUpstream((req, res) => res.end('unused'));
  t.after(() => anthropicUpstream.close());

  const { openaiOrigin: gatewayOpenaiOrigin } = await startTwoProviderGateway(t, {
    anthropicOrigin: anthropicUpstream.origin,
    openaiOrigin: openaiUpstream.origin,
    sessionsDir,
  });

  const res = await raw(gatewayOpenaiOrigin, { path: '/v1/models' });
  assert.equal(res.body.toString(), '{"object":"list","data":[]}', 'the transparent path still forwards it');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(readdirSync(sessionsDir), [], 'an unmodeled OpenAI endpoint is never written down');
});
