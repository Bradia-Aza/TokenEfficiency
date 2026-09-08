// Phase 6.4 exit criterion: two turns of one conversation through the live
// proxy in transform mode, with a throwing transform wired ahead of the
// working one. Asserts the client's response bytes are untouched, the
// substitution reached upstream, the transcript shows the sent form, the
// ledger's before/after byte counts are right, and the failure was logged to
// stderr and nowhere else.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../config/index.js';
import { createPipeline } from '../pipeline/index.js';
import { createExchangeObserver } from '../pipeline/exchange.js';
import { createPlugins } from '../plugins/index.js';
import { createRouter } from '../routing/index.js';
import { createSessionStore } from '../sinks/sessions.js';
import { apply as applyTransforms } from '../transforms/index.js';
import { createSubstituteTransform } from '../transforms/substitute.js';
import { raw, startGateway, startUpstream, tempSessionsDir } from './helpers.js';

const TURN_1_RESPONSE = JSON.stringify({
  id: 'msg_turn1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text: 'The capital of Iran is Tehran.' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 20, output_tokens: 10 },
});

const TURN_2_RESPONSE = JSON.stringify({
  id: 'msg_turn2',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text: 'It has a population of about 9 million.' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 45, output_tokens: 12 },
});

const turnOneBody = JSON.stringify({
  model: 'claude-opus-5',
  max_tokens: 100,
  metadata: { user_id: 'user_transform_session' },
  messages: [{ role: 'user', content: 'What is the capital of Iran?' }],
});

const turnTwoBody = JSON.stringify({
  model: 'claude-opus-5',
  max_tokens: 100,
  metadata: { user_id: 'user_transform_session' },
  messages: [
    { role: 'user', content: 'What is the capital of Iran?' },
    { role: 'assistant', content: [{ type: 'text', text: 'The capital of Iran is Tehran.' }] },
    { role: 'user', content: 'How big is Tehran?' },
  ],
});

/** Serves turn 1 and turn 2 by request body content, and records what it saw. */
function conversationUpstream(seenBodies) {
  return (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      seenBodies.push(bodyText);
      const body = JSON.parse(bodyText);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body.messages.length === 1 ? TURN_1_RESPONSE : TURN_2_RESPONSE);
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
 * The real transform + observation stack: a throwing transform wired ahead of
 * the real substitute transform, and the real plugin list behind a router
 * built from the same config the gateway loads.
 */
async function startTransformingGateway(t, { upstreamOrigin, sessionsDir, dictPath }) {
  const failures = [];
  const fullEnv = {
    GATEWAY_UPSTREAM: upstreamOrigin,
    GATEWAY_SESSIONS_DIR: sessionsDir,
    GATEWAY_MODE: 'transform',
    GATEWAY_TRANSFORM_DICT: dictPath,
  };
  const { providers, transformDictionary } = loadConfig({
    GATEWAY_PORT: '0',
    GATEWAY_HOST: '127.0.0.1',
    ...fullEnv,
  });
  const resolve = createRouter({ providers });

  const throwing = { name: 'broken-transform', apply: () => { throw new Error('deliberate transform failure'); } };
  const substitute = createSubstituteTransform(transformDictionary);
  const transforms = [throwing, substitute];

  const transformRequest = async ({ port, path, body }) => {
    const route = resolve({ port, url: path });
    if (!route.modeled) return null;
    const canonicalRequest = route.adapter.requestToCanonical(JSON.parse(body.toString('utf8')));
    const { request, edits } = applyTransforms(canonicalRequest, transforms, { log });
    if (edits === 0) return null;
    return Buffer.from(JSON.stringify(route.adapter.requestFromCanonical(request)), 'utf8');
  };

  const log = { error: (line) => failures.push(line) };

  const gateway = await startGateway(fullEnv, {
    transformRequest,
    buildObserver: ({ config, log: gatewayLog }) => {
      const store = createSessionStore({ dir: config.sessionsDir });
      const pipeline = createPipeline({ log: gatewayLog, plugins: createPlugins(config.plugins, { store }) });
      return createExchangeObserver({ resolve, pipeline, log: gatewayLog });
    },
  });
  t.after(() => gateway.close());
  return { gateway, failures };
}

test('transform mode: a throwing transform ahead of the working one still forwards the substitution, client bytes untouched, transcript and ledger reflect what was sent', async (t) => {
  const sessionsDir = tempSessionsDir(t);
  const dictPath = join(sessionsDir, '..', `dict-${Date.now()}.json`);
  writeFileSync(dictPath, JSON.stringify({ iran: 'canada' }));
  t.after(() => {
    try {
      unlinkSync(dictPath);
    } catch {
      /* best effort cleanup */
    }
  });

  const seenBodies = [];
  const upstream = await startUpstream(conversationUpstream(seenBodies));
  t.after(() => upstream.close());
  const { gateway, failures } = await startTransformingGateway(t, {
    upstreamOrigin: upstream.origin,
    sessionsDir,
    dictPath,
  });

  // --- turn 1 -----------------------------------------------------------
  const first = await raw(gateway.origin, { method: 'POST', path: '/v1/messages', body: turnOneBody });
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.toString(), TURN_1_RESPONSE, "the client's bytes are untouched: the model's reply, verbatim");

  // --- turn 2 -----------------------------------------------------------
  const second = await raw(gateway.origin, { method: 'POST', path: '/v1/messages', body: turnTwoBody });
  assert.equal(second.body.toString(), TURN_2_RESPONSE);

  // The substitution reached upstream on both turns.
  assert.equal(seenBodies.length, 2);
  assert.match(seenBodies[0], /What is the capital of Canada\?/);
  assert.doesNotMatch(seenBodies[0], /\bIran\b/);
  // Turn 2 replays turn 1's history; the deterministic, disjoint dictionary
  // keeps the transformed prefix stable rather than compounding.
  assert.match(seenBodies[1], /The capital of Canada is Tehran\./);
  assert.doesNotMatch(seenBodies[1], /\bIran\b/);

  const sessionId = await waitFor(() => {
    const found = readdirSync(sessionsDir).filter((f) => !f.startsWith('dict-'));
    return found.length === 1 ? found[0] : null;
  });
  const read = (file) => readFileSync(`${sessionsDir}/${sessionId}/${file}`, 'utf8');
  const ledger = await waitFor(() => {
    if (!existsSync(`${sessionsDir}/${sessionId}/tokens.json`)) return null;
    const parsed = JSON.parse(read('tokens.json'));
    return parsed.turns.length === 2 ? parsed : null;
  });

  // --- the transcript shows what was actually sent -----------------------
  const transcript = await waitFor(() => {
    const text = read('transcript.md');
    return text.includes('population of about 9 million') ? text : null;
  });
  assert.match(transcript, /What is the capital of Canada\?/, 'transcript shows the sent form');
  assert.match(transcript, /before transform/, 'the pre-transform text is noted where it differs');
  assert.match(transcript, /What is the capital of Iran\?/, 'the pre-transform text itself is shown');

  // --- the ledger's before/after byte counts and edit counts -------------
  // Turn 1's history has one occurrence of "Iran"; turn 2 replays it plus the
  // model's own reply, which also said "Iran" (there is no response
  // transform), so turn 2 has two occurrences to substitute.
  const expectedEdits = [1, 2];
  ledger.turns.forEach((turn, i) => {
    assert.ok(turn.transform, 'transform mode records a transform report per turn');
    assert.equal(turn.transform.transformed, true);
    assert.equal(turn.transform.edits, expectedEdits[i], `turn ${i + 1} substituted ${expectedEdits[i]} occurrence(s)`);
    assert.ok(turn.transform.requestBytesBefore > 0);
    assert.ok(turn.transform.requestBytesAfter > 0);
    // "Canada" is longer than "Iran", so the transformed body grew.
    assert.ok(
      turn.transform.requestBytesAfter > turn.transform.requestBytesBefore,
      'the substituted body is byte-counted correctly before and after',
    );
  });
  assert.match(read('tokens.md'), /bytes before/);
  assert.match(read('tokens.md'), /bytes after/);

  // --- the throwing transform failed every time, and only it did ---------
  assert.equal(failures.length, 2, 'the throwing transform logged once per turn');
  assert.ok(failures.every((line) => line.includes('broken-transform')));
  assert.ok(failures.every((line) => line.includes('deliberate transform failure')));
  assert.equal(
    gateway.logs.filter((line) => !line.includes('broken-transform')).length,
    0,
    'nothing else went wrong on the gateway side',
  );
});
