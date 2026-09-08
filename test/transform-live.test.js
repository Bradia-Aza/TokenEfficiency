// Phase 6.3 — the live seam. GATEWAY_MODE=transform end to end: a request goes
// in with one word, the fake "model" upstream sees the substituted word, and
// the reply comes back untouched (no response transform exists).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig, MODE_TRANSFORM } from '../config/index.js';
import { buildTransformRequest, raw, startGateway, startUpstream } from './helpers.js';

const DICT_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures/dict');
const IRAN_CANADA_DICT = join(DICT_DIR, 'iran-canada.json');
const EMPTY_DICT = join(DICT_DIR, 'empty.json');

async function startTransformGateway(env, dictPath) {
  const fullEnv = {
    GATEWAY_PORT: '0',
    GATEWAY_HOST: '127.0.0.1',
    GATEWAY_MODE: MODE_TRANSFORM,
    GATEWAY_TRANSFORM_DICT: dictPath,
    ...env,
  };
  const { providers } = loadConfig(fullEnv);
  const transformRequest = buildTransformRequest({
    providers,
    dictionary: JSON.parse(readFileSync(dictPath, 'utf8')),
  });
  return startGateway(fullEnv, { transformRequest });
}

test('a modeled request is substituted before it reaches upstream, and the reply comes back untouched', async (t) => {
  let seenBody;
  let seenHeaders;
  const upstream = await startUpstream((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seenBody = Buffer.concat(chunks).toString('utf8');
      seenHeaders = req.headers;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'The capital of Iran is Tehran.' }], stop_reason: 'end_turn' }));
    });
  });
  const gateway = await startTransformGateway({ GATEWAY_UPSTREAM: upstream.origin }, IRAN_CANADA_DICT);
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  const requestBody = JSON.stringify({
    model: 'claude-opus-5',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'What is the capital of Iran?' }],
  });

  const res = await raw(gateway.origin, {
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: requestBody,
  });

  // The substitution demonstrably reached the model: upstream saw "Canada",
  // not "Iran".
  assert.match(seenBody, /What is the capital of Canada\?/);
  assert.doesNotMatch(seenBody, /\bIran\b/);

  // content-length matches the actual (different) byte length of the
  // transformed body, and there is no transfer-encoding left over.
  assert.equal(seenHeaders['content-length'], String(Buffer.byteLength(seenBody)));
  assert.equal(seenHeaders['transfer-encoding'], undefined);

  // No response transform exists: the client sees the model's reply verbatim,
  // "Iran" included, even though the model never saw the word "Iran" itself.
  assert.equal(res.statusCode, 200);
  const responseBody = JSON.parse(res.body.toString());
  assert.equal(responseBody.content[0].text, 'The capital of Iran is Tehran.');
});

test('an empty dictionary in transform mode is provably identical to observe mode (invariant 6)', async (t) => {
  let seenBody;
  const upstream = await startUpstream((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seenBody = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const gateway = await startTransformGateway({ GATEWAY_UPSTREAM: upstream.origin }, EMPTY_DICT);
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  const requestBody = JSON.stringify({
    model: 'claude-opus-5',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'What is the capital of Iran?' }],
  });

  await raw(gateway.origin, {
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: requestBody,
  });

  assert.equal(seenBody, requestBody, 'zero edits must forward the original bytes byte-for-byte');
});

test('an unmodeled path in transform mode is forwarded unchanged, no transform attempted', async (t) => {
  let seenBody;
  const upstream = await startUpstream((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seenBody = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const gateway = await startTransformGateway({ GATEWAY_UPSTREAM: upstream.origin }, IRAN_CANADA_DICT);
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  const requestBody = JSON.stringify({ some: 'unmodeled body mentioning Iran' });
  await raw(gateway.origin, {
    method: 'POST',
    path: '/v1/unknown-endpoint',
    headers: { 'content-type': 'application/json' },
    body: requestBody,
  });

  assert.equal(seenBody, requestBody, 'invariant 2: an unmodeled request is never transformed');
});

test('a malformed request body is forwarded unchanged rather than crashing the transform', async (t) => {
  let seenBody;
  const upstream = await startUpstream((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seenBody = Buffer.concat(chunks);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const gateway = await startTransformGateway({ GATEWAY_UPSTREAM: upstream.origin }, IRAN_CANADA_DICT);
  t.after(async () => {
    await gateway.close();
    await upstream.close();
  });

  const garbage = Buffer.from('not { valid json at all, mentions Iran');
  await raw(gateway.origin, {
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: garbage,
  });

  assert.deepEqual(seenBody, garbage, 'invariant 3: a throwing transform degrades to forwarding the original bytes');
});
