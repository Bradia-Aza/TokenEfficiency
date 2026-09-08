// The provider registry: entrypoint -> provider.
//
// This file is data. It is one of the two places allowed to name a provider —
// the other is `routing/`, which only matches against what is here — and it
// exists so no other layer has to. `transport/`, `pipeline/`, `plugins/` and
// `sinks/` reach a provider through a lookup or through `ctx.provider`, never
// through an import.
//
// Adding a provider is an entry here plus an adapter in `adapters/`. Nothing
// else changes, and that claim is the point of the registry.

import { adapter as anthropicAdapter } from '../adapters/anthropic.js';
import { adapter as openaiAdapter } from '../adapters/openai.js';

/**
 * @typedef {object} ProviderEntry
 * @property {string} name          what `ctx.provider` reports
 * @property {object} adapter       the wire-format pair, both directions
 * @property {string} upstream      where this entrypoint's traffic goes
 * @property {number|null} port     local port that selects this entry; null matches any
 * @property {string} pathPrefix    request path prefix that selects this entry
 * @property {string[]} modeledPaths exact paths whose bodies the adapter models
 */

/**
 * Entries are matched in order, first match wins.
 *
 * `modeledPaths` is deliberately exact rather than a prefix: an endpoint the
 * adapter has not been written against must take the Phase 1 transparent path,
 * and defaulting to "modeled" would make a new upstream endpoint a parse error
 * in the observer instead of bytes moved unchanged.
 *
 * The OpenAI entry is listed before Anthropic's, even though it is the newer
 * one: Anthropic's `port: null` matches *any* port, so if it came first it
 * would shadow every other entry regardless of which port a request actually
 * reached — a port-agnostic catch-all has to be last, not first. A registry
 * with more than one port-specific entry has no such ordering constraint
 * between them; only a `port: null` entry needs to sort after everything else.
 *
 * @type {readonly ProviderEntry[]}
 */
export const PROVIDERS = Object.freeze([
  Object.freeze({
    name: openaiAdapter.name,
    adapter: openaiAdapter,
    upstream: 'https://api.openai.com',
    // A second port is cleaner than a path prefix, since both providers use
    // /v1/ and Chat Completions shares its path with nothing Anthropic serves.
    port: 8788,
    pathPrefix: '/',
    modeledPaths: Object.freeze(['/v1/chat/completions']),
  }),
  Object.freeze({
    name: anthropicAdapter.name,
    adapter: anthropicAdapter,
    upstream: 'https://api.anthropic.com',
    port: null,
    pathPrefix: '/',
    modeledPaths: Object.freeze(['/v1/messages']),
  }),
]);
