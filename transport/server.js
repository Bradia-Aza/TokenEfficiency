import http from 'node:http';
import { createProxyHandler } from './proxy.js';

/**
 * @returns {{ server: import('node:http').Server, listen: () => Promise<import('node:http').Server> }}
 */
export function createServer({ config, onExchange, resolveUpstream, transformRequest, log = console }) {
  const server = http.createServer(createProxyHandler({ config, onExchange, resolveUpstream, transformRequest, log }));

  // The gateway must not impose a shorter life on a request than the upstream
  // does; upstream timeouts are handled explicitly per request.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;

  server.on('clientError', (err, socket) => {
    if (socket.writable && !socket.destroyed) {
      socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
    }
    socket.destroy(err);
  });

  const listen = () =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => {
        server.removeListener('error', reject);
        resolve(server);
      });
    });

  return { server, listen };
}
