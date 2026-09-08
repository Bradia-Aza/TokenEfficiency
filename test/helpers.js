import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config/index.js';
import { createRouter } from '../routing/index.js';
import { createServer } from '../transport/server.js';
import { apply as applyTransforms } from '../transforms/index.js';
import { createSubstituteTransform } from '../transforms/substitute.js';

/**
 * The same `transformRequest` composition `index.js` builds, wired up for a
 * test's router and dictionary rather than being stubbed — so transport tests
 * exercise the real seam, not a hand-rolled substitute of it.
 */
export function buildTransformRequest({ providers, dictionary }) {
  const resolve = createRouter({ providers });
  const transforms = [createSubstituteTransform(dictionary)];
  return async ({ port, path, body }) => {
    const route = resolve({ port, url: path });
    if (!route.modeled) return null;
    const canonicalRequest = route.adapter.requestToCanonical(JSON.parse(body.toString('utf8')));
    const { request, edits } = applyTransforms(canonicalRequest, transforms);
    if (edits === 0) return null;
    return Buffer.from(JSON.stringify(route.adapter.requestFromCanonical(request)), 'utf8');
  };
}

/** An upstream under the test's control. */
export async function startUpstream(handler) {
  const server = http.createServer(handler);
  server.keepAliveTimeout = 0;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** A TCP socket that accepts connections and then says nothing, ever. */
export async function startBlackhole() {
  const sockets = new Set();
  const server = net.createServer((socket) => sockets.add(socket));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `https://127.0.0.1:${port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * @param {object} env environment overrides for loadConfig
 * @param {{ buildObserver?: (deps: { config: object, log: object }) => Function,
 *           resolveUpstream?: (request: object) => URL|null,
 *           transformRequest?: (request: object) => Promise<Buffer|null> }} [options]
 *   Supply the real observation stack instead of the recording stub, and/or a
 *   per-request upstream resolver (the Phase 1 seam); omitted, transport falls
 *   back to the single `config.upstream`, as it did before that seam existed.
 *   `transformRequest` is the Phase 6 seam, only ever called in transform mode.
 */
export async function startGateway(env = {}, { buildObserver, resolveUpstream, transformRequest } = {}) {
  const exchanges = [];
  const logs = [];
  const log = { error: (line) => logs.push(line) };
  const config = loadConfig({ GATEWAY_PORT: '0', GATEWAY_HOST: '127.0.0.1', GATEWAY_ACCESS_LOG: '0', ...env });
  const { server, listen } = createServer({
    config,
    onExchange:
      buildObserver === undefined
        ? (record) => {
            if (env.__throwInObserver) throw new Error('deliberate plugin failure');
            exchanges.push(record);
          }
        : buildObserver({ config, log }),
    resolveUpstream,
    transformRequest,
    log,
  });
  await listen();
  const { port } = server.address();
  return {
    config,
    exchanges,
    logs,
    origin: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * A raw HTTP client. fetch() forbids the hop-by-hop headers this proxy has to
 * be tested against, so the tests speak HTTP directly.
 */
export function raw(origin, { method = 'GET', path = '/', headers = {}, body, onChunk, signal } = {}) {
  const url = new URL(path, origin);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => {
          chunks.push(chunk);
          onChunk?.(chunk, req, res);
        });
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode,
            statusMessage: res.statusMessage,
            headers: res.headers,
            rawHeaders: res.rawHeaders,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    signal?.addEventListener('abort', () => req.destroy(), { once: true });
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

/**
 * A throwaway sessions/ root, removed when the test ends.
 * @param {import('node:test').TestContext} t
 */
export function tempSessionsDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-sessions-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
