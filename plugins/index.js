// The plugin registry. config/ decides which names are enabled; this decides
// what a name builds. Neither knows what a plugin does with what it sees.

import { createDumpSession } from './dump-session.js';
import { createMeterTokens } from './meter-tokens.js';
import { createRawCapture } from './raw-capture.js';

const FACTORIES = {
  'dump-session': createDumpSession,
  'meter-tokens': createMeterTokens,
  // A research instrument (INTERCEPTION_RESEARCH_PLAN.md Phase 0.1), off by
  // default: enable it with GATEWAY_PLUGINS for a measured session.
  'raw-capture': createRawCapture,
};

export const PLUGIN_NAMES = Object.freeze(Object.keys(FACTORIES));

/**
 * @param {string[]} names enabled plugin names, in dispatch order
 * @param {object} deps shared dependencies (the session store)
 */
export function createPlugins(names, deps) {
  return names.map((name) => {
    const factory = FACTORIES[name];
    if (factory === undefined) {
      throw new Error(`unknown plugin ${JSON.stringify(name)}; known plugins: ${PLUGIN_NAMES.join(', ')}`);
    }
    return factory(deps);
  });
}
