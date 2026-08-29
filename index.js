// The composition root: the one place that knows every layer exists. It wires
// them together and names none of their internals.

import { loadConfig, MODE_PASSTHROUGH } from './config/index.js';
import { createExchangeObserver } from './pipeline/exchange.js';
import { createPipeline } from './pipeline/index.js';
import { createPlugins } from './plugins/index.js';
import { createRouter } from './routing/index.js';
import { createSessionStore } from './sinks/sessions.js';
import { createServer } from './transport/server.js';

const config = loadConfig();

const store = createSessionStore({ dir: config.sessionsDir });
const pipeline = createPipeline({ plugins: createPlugins(config.plugins, { store }) });
// The seam. In passthrough mode transport never calls it, so every layer above
// transport is bypassed rather than merely idle.
const onExchange = createExchangeObserver({
  resolve: createRouter({ providers: config.providers }),
  pipeline,
});

const { server, listen } = createServer({ config, onExchange });

await listen();

const { port, address } = server.address();
console.error(
  `[gateway] listening on http://${address}:${port} -> ${config.upstream.origin} (mode=${config.mode})`,
);
if (config.mode === MODE_PASSTHROUGH) {
  console.error('[gateway] passthrough: observation is bypassed entirely');
} else {
  const routes = config.providers
    .map((entry) => `${entry.name} ${entry.pathPrefix} [${entry.modeledPaths.join(', ') || 'nothing modeled'}]`)
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
    server.close(async () => {
      // Let observers finish writing what the last turn produced.
      await pipeline.close();
      await store.drain();
      process.exit(0);
    });
    // Don't wait on in-flight streams forever.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
