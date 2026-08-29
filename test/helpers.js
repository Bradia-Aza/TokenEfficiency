import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config/index.js';
import { createServer } from '../transport/server.js';

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
 * @param {{ buildObserver?: (deps: { config: object, log: object }) => Function }} [options]
 *   Supply the real observation stack instead of the recording stub.
 */
export async function startGateway(env = {}, { buildObserver } = {}) {
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
