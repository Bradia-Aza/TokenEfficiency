import http from 'node:http';
import https from 'node:https';

/**
 * Open a request to the upstream with explicit connect and idle timeouts.
 *
 * Connect timeout covers TCP/TLS establishment. Idle timeout is socket
 * inactivity and re-arms on every byte, so a long-lived stream survives as long
 * as the upstream keeps talking.
 *
 * @returns {{ request: import('node:http').ClientRequest, dispose: () => void }}
 */
export function openUpstreamRequest({ url, method, headers, timeouts, onTimeout }) {
  const transport = url.protocol === 'https:' ? https : http;

  const request = transport.request({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    method,
    path: url.pathname + url.search,
    headers,
  });

  let connectTimer = setTimeout(() => {
    connectTimer = null;
    onTimeout('connect');
  }, timeouts.connectMs);

  const clearConnectTimer = () => {
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
  };

  request.once('socket', (socket) => {
    const onConnected = () => {
      clearConnectTimer();
      // Hand the rest of the request's life to the inactivity timer.
      request.setTimeout(timeouts.idleMs);
    };
    if (socket.connecting) socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', onConnected);
    else onConnected();
  });

  request.on('timeout', () => onTimeout('idle'));

  return {
    request,
    dispose: clearConnectTimer,
  };
}
