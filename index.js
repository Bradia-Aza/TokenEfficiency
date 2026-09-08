// The composition root: the one place that knows every layer exists. It wires
// them together and names none of their internals.

import { loadConfig, MODE_PASSTHROUGH, MODE_TRANSFORM } from './config/index.js';
import { createExchangeObserver } from './pipeline/exchange.js';
import { createPipeline } from './pipeline/index.js';
import { createPlugins } from './plugins/index.js';
import { createRouter } from './routing/index.js';
import { createSessionStore } from './sinks/sessions.js';
import { createServer } from './transport/server.js';
import { apply as applyTransforms } from './transforms/index.js';
import { createSubstituteTransform } from './transforms/substitute.js';

const config = loadConfig();

const store = createSessionStore({ dir: config.sessionsDir });
const pipeline = createPipeline({ plugins: createPlugins(config.plugins, { store }) });
const resolve = createRouter({ providers: config.providers });
// The seam. In passthrough mode transport never calls it, so every layer above
// transport is bypassed rather than merely idle.
const onExchange = createExchangeObserver({ resolve, pipeline });
// The other seam, built from the same router: which upstream a request goes
// to. routing/ owns what a path is; transport must not learn to parse one.
const resolveUpstream = ({ port, path }) => resolve({ port, url: path }).upstream;

// The transform seam. Only wired in transform mode, and only over a modeled
// request — transforms/ never sees what routing could not resolve to an
// adapter, per invariant 2. Bytes in, bytes or null back; transport learns
// nothing about canonical objects.
const transforms =
  config.mode === MODE_TRANSFORM ? [createSubstituteTransform(config.transformDictionary)] : [];
const transformRequest =
  config.mode === MODE_TRANSFORM
    ? async ({ port, path, body }) => {
        const route = resolve({ port, url: path });
        if (!route.modeled) return null;
        const canonicalRequest = route.adapter.requestToCanonical(JSON.parse(body.toString('utf8')));
        const { request, edits } = applyTransforms(canonicalRequest, transforms);
        // Invariant 6: a no-op transform forwards the original bytes rather
        // than paying for a re-serialization round trip that changed nothing.
        if (edits === 0) return null;
        return Buffer.from(JSON.stringify(route.adapter.requestFromCanonical(request)), 'utf8');
      }
    : undefined;

// A registry entry keyed on a specific port needs its own listener — one
// process, one router, but a socket per distinct port the registry names.
// GATEWAY_PORT is always one of them, so a port-agnostic entry (port: null)
// still has a home. Passthrough mode ignores the registry entirely (it is the
// bisect tool and must not depend on routing), so it opens exactly the one
// port it was configured with.
const ports =
  config.mode === MODE_PASSTHROUGH
    ? [config.port]
    : [...new Set([config.port, ...config.providers.map((entry) => entry.port).filter((p) => p !== null)])];

const listeners = await Promise.all(
  ports.map(async (port) => {
    const { server, listen } = createServer({
      config: { ...config, port },
      onExchange,
      resolveUpstream,
      transformRequest,
    });
    await listen();
    return server;
  }),
);

for (const server of listeners) {
  const { port, address } = server.address();
  console.error(`[gateway] listening on http://${address}:${port} (mode=${config.mode})`);
}
if (config.mode === MODE_PASSTHROUGH) {
  console.error(`[gateway] passthrough: observation is bypassed entirely, forwarding to ${config.upstream.origin}`);
} else {
  const routes = config.providers
    .map(
      (entry) =>
        `${entry.name}${entry.port !== null ? `:${entry.port}` : ''} ${entry.pathPrefix} [${entry.modeledPaths.join(', ') || 'nothing modeled'}]`,
    )
    .join('; ');
  console.error(
    `[gateway] observing ${routes} -> ${store.root} (plugins: ${pipeline.names.join(', ') || 'none'})`,
  );
}

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    Promise.all(listeners.map((server) => new Promise((resolveClose) => server.close(resolveClose)))).then(
      async () => {
        // Let observers finish writing what the last turn produced.
        await pipeline.close();
        await store.drain();
        process.exit(0);
      },
    );
    // Don't wait on in-flight streams forever.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
