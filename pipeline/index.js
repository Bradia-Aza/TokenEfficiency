// Ordered observer dispatch with per-call error isolation.
//
// Two invariants live here and nowhere else:
//
//   1. The pipeline is read-only. Observers are handed frozen objects and their
//      return value is discarded. Nothing an observer produces can reach the
//      client, because nothing here is wired to the forward at all — the seam
//      this hangs off is called after the client response has finished.
//   3. Observation failure is never client-visible. Every observer call is
//      individually try/caught, sync throws and async rejections alike, so one
//      broken plugin costs the rest of the list nothing and the caller gets a
//      promise that never rejects.
//
// This layer knows no providers. It sees canonical objects and a ctx; which
// adapter produced them is a string in `ctx.provider`.

import { deepFreeze } from '../canonical/freeze.js';

const HOOKS = ['onRequest', 'onResponse'];

/**
 * @param {object} deps
 * @param {Array<{ name: string, onRequest?: Function, onResponse?: Function, close?: Function }>} deps.plugins
 *   Observers, dispatched in list order.
 */
export function createPipeline({ plugins = [], log = console } = {}) {
  const observers = plugins.map((plugin, index) => {
    if (plugin === null || typeof plugin !== 'object') {
      throw new TypeError(`pipeline: plugin at index ${index} is not an object`);
    }
    if (typeof plugin.name !== 'string' || plugin.name === '') {
      throw new TypeError(`pipeline: plugin at index ${index} has no name`);
    }
    for (const hook of HOOKS) {
      if (plugin[hook] !== undefined && typeof plugin[hook] !== 'function') {
        throw new TypeError(`pipeline: ${plugin.name}.${hook} is not a function`);
      }
    }
    return plugin;
  });

  async function dispatch(hook, payload, ctx) {
    // Belt and braces: the canonical factories already freeze their output, and
    // freezing twice is a cheap identity check.
    deepFreeze(payload);
    deepFreeze(ctx);

    for (const plugin of observers) {
      const observe = plugin[hook];
      if (typeof observe !== 'function') continue;
      try {
        const returned = await observe.call(plugin, payload, ctx);
        if (returned !== undefined) {
          // Not an error, but worth saying out loud: a plugin that thinks it is
          // transforming something is a plugin built against the wrong contract.
          log.error(
            `[gateway] plugin ${plugin.name}.${hook} returned a value; the pipeline is read-only and it was discarded`,
          );
        }
      } catch (err) {
        log.error(`[gateway] plugin ${plugin.name}.${hook} failed: ${err?.stack || err}`);
      }
    }
  }

  return {
    /** Plugin names in dispatch order. */
    names: observers.map((plugin) => plugin.name),
    onRequest: (canonicalRequest, ctx) => dispatch('onRequest', canonicalRequest, ctx),
    onResponse: (canonicalResponse, ctx) => dispatch('onResponse', canonicalResponse, ctx),

    /** Let observers flush on shutdown. Failures are logged, never thrown. */
    async close() {
      for (const plugin of observers) {
        if (typeof plugin.close !== 'function') continue;
        try {
          await plugin.close();
        } catch (err) {
          log.error(`[gateway] plugin ${plugin.name}.close failed: ${err?.stack || err}`);
        }
      }
    },
  };
}
