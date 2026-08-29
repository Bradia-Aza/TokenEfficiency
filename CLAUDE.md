# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A token efficiency platform. It intercepts LLM input and output with a proxy: a
provider-agnostic LLM gateway with provider-specific adapters, built as layered
modules.

Current state: **the walking skeleton is complete — all five phases done.**
Transparent transport core; canonical model and the Anthropic adapter, both
directions; read-only observer pipeline writing transcripts and a token ledger;
routing and a provider registry; and the neutrality validation that hardened the
canonical model against the OpenAI and Gemini wire formats. (Phase 5 was built
before Phase 4, at the user's request; both are now finished and their exit
criteria demonstrated.) `GATEWAY_SKELETON_PLAN.md` is the authoritative build
plan for the walking skeleton. Read it before starting work; this file is the
operating rules that sit on top of it.

The next plan is the one that introduces a *transform*. Nothing in this codebase
mutates a request or a response, and the seams exist so that the first thing
that does has an obvious place to live.

**The skeleton observes and logs. It changes nothing.** Token minification and
every other transform is out of scope until a later plan. The purpose of the
current build is to prove the seams — transport, adapters, canonical model,
pipeline, routing — are in the right places before any transform exists to
distort them.

## Commands

```sh
npm test                 # node:test suite, no dependencies
npm start                # run the gateway
node --test "test/**/*.test.js" --test-name-pattern 'passthrough'   # one slice
```

Runtime is Node >= 20, ESM (`"type": "module"`), **zero dependencies** — keep it
that way unless a dependency is genuinely unavoidable, and say why if you add
one. Tests use `node:test` and real loopback HTTP servers rather than mocks, so
they exercise actual socket behavior; follow that pattern.

Configuration is environment-only, read in `config/index.js`:
`GATEWAY_MODE`, `GATEWAY_PORT`, `GATEWAY_HOST`, `GATEWAY_UPSTREAM`,
`GATEWAY_CONNECT_TIMEOUT_MS`, `GATEWAY_IDLE_TIMEOUT_MS`,
`GATEWAY_MAX_CAPTURE_BYTES`, `GATEWAY_ACCESS_LOG`, `GATEWAY_SESSIONS_DIR`,
`GATEWAY_PLUGINS`.

Observation lands in `sessions/<session-id>/` as `transcript.md`, `tokens.md`
and `tokens.json`. A session is one **conversation**, not one connection:
`sessionIdFor` hashes the opening message plus the opaque `userId`, so every
turn of a thread groups into one transcript.

To put a Claude Code session through the gateway:

```sh
npm start &                                    # or GATEWAY_MODE=passthrough npm start
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

## Non-negotiable invariants

These hold at every phase and in every change. If a change would violate one,
the change is wrong — say so rather than working around it.

1. **The pipeline is read-only.** Plugins receive frozen canonical objects and
   return nothing. What goes upstream is derived from the original bytes, never
   from plugin output. Enforce structurally (`Object.freeze`, no return value),
   not by convention.
2. **If it can't be modeled, it's moved unchanged.** Unknown endpoints, unknown
   content-block types, malformed JSON, non-2xx responses, mid-stream SSE errors
   — all forwarded byte-for-byte. The canonical model is for observation only;
   an unmapped field must never cost the client anything.
3. **Observation failure is never client-visible.** Any throw inside adapters,
   pipeline, plugins, or sinks is caught, logged to stderr, and the proxy keeps
   streaming. A broken logger must not break the user's coding session.
4. **Streaming is observed, not buffered.** Chunks are written to the client
   first, then fed to the accumulator. No held blocks, no added latency.
   Downstream buffering machinery arrives with the mutation that justifies it.
5. **Layer dependencies point one way.** `transport` knows no providers.
   `adapters` know no plugins. `plugins` know no providers. Only `routing` and
   `config` may name a provider.

## Layering

```
config/       ports, upstreams, provider registry, enabled plugin list
transport/    http listener, body capture, hop-by-hop headers,
              upstream client, timeouts, error paths
routing/      request -> { provider, endpoint, modeled: bool }
adapters/     provider wire format <-> canonical    (anthropic.js)
canonical/    provider-neutral domain model + freeze helpers
pipeline/     ordered observer dispatch, error isolation
plugins/      dump-session.js, meter-tokens.js
sinks/        markdown renderer, sessions/ writer
```

Request path: `transport -> routing -> adapter.toCanonical -> pipeline(observe)`,
with the original bytes forwarded upstream in parallel. Response path mirrors it.
**The canonical object is a side channel, not the thing in flight.** When adding
code, place it in the layer that owns the concern and let it depend only
downward.

## Build phases

Work the phases in order. Each has an exit criterion; do not start the next
phase until the current one's exit criterion is actually demonstrated, not
assumed.

- **Phase 1 — Transparent transport core. DONE.** A dumb pipe, hardened: configured
  port to configured upstream, body captured without blocking the forward,
  `accept-encoding` stripped, hop-by-hop headers handled, non-2xx and malformed
  bodies and SSE `error` events passed through, connect/read timeouts and
  mid-stream client disconnect handled without leaking sockets, and a
  `GATEWAY_MODE=passthrough` env flag bypassing every later layer.
  *Exit:* under `GATEWAY_MODE=passthrough` a full Claude Code session through
  the proxy is indistinguishable from no proxy — including an induced 429 and a
  connection killed mid-stream. Automated coverage lives in
  `test/transport.test.js` (every byte-fidelity case runs in both modes) and
  `test/observation.test.js`.
- **Phase 2 — Canonical model + first adapter. DONE.** `canonical/` covers
  conversation, message, role, content blocks (text, tool call, tool result,
  thinking, image, unknown), tool definitions, tool choice, stop reason,
  usage/token counts, and error. `adapters/anthropic.js` implements
  `requestToCanonical`, `requestFromCanonical`, `responseToCanonical`,
  `responseFromCanonical`, and `streamToCanonical` (plus `streamBytesToCanonical`
  and an incremental `createStreamAccumulator`).
  *Exit:* over the `test/fixtures/` corpus — simple text, system blocks, tools
  and multi-tool-call turns, tool results, thinking and redacted thinking,
  images, unmodeled blocks, error envelopes, and three streams —
  `fromCanonical(toCanonical(x))` is semantically equal to `x`, asserted in
  `test/adapter-anthropic.test.js`. Transport was not touched, and the Phase 1
  suite passes unchanged.
- **Phase 3 — Read-only observer pipeline + plugins. DONE.** Ordered observers
  over `onRequest(canonicalRequest, ctx)` and `onResponse(canonicalResponse,
  ctx)`, each call individually try/caught. `ctx` carries session id, provider
  name, timestamps, and raw bytes. `plugins/dump-session.js` writes a markdown
  transcript per session into `sessions/`; `plugins/meter-tokens.js` writes a
  per-turn and per-session ledger beside it.
  *Exit:* `test/session.test.js` drives two turns of one conversation — one
  streamed, one not — through the live proxy with a plugin that throws on every
  hook wired in ahead of the working ones, and asserts the client's bytes are
  untouched, the transcript is complete, the ledger totals are right, and all
  four failures were logged to stderr and nowhere else.
- **Phase 4 — Routing and provider registry. DONE.** `config/providers.js` is
  the registry: an ordered list of entries mapping an entrypoint (`port`, null
  for any, plus `pathPrefix`) to `{ name, adapter, upstream, modeledPaths }`.
  `routing/index.js` turns it into a pure `resolve(exchange)` returning
  `{ provider, adapter, upstream, modeled, path }`; it validates the registry at
  construction and is total, so a garbage exchange yields an unrouted route
  rather than a throw. `pipeline/exchange.js` takes that router as `resolve`
  (the Phase 3 `providerResolver` stand-in is deleted) and no longer parses
  paths itself. Transport now reports the local `port` on the exchange record so
  a port-keyed entry is real rather than aspirational.
  *Exit:* met. `grep -ril anthropic` over the source layers matches exactly
  `adapters/anthropic.js` and `config/providers.js`. Test files, fixtures, docs
  and captured `sessions/` output name the provider, as they must.
- **Phase 5 — Neutrality validation (no second adapter). DONE.**
  `NEUTRALITY.md` maps `request-system-blocks`, `request-tools-multi-call` and
  `response-tool-calls`/`stream-tool-call` to and from OpenAI Chat Completions
  and Gemini `generateContent`, field by field and both directions, covering
  system-prompt placement, tool-call/result correlation, stop reasons,
  streaming granularity and usage accounting. Nine cells could only be filled
  with "put it in `raw`" for facts a plugin would read; all nine were fixed in
  the model (see the change table in `NEUTRALITY.md`). The harness gained
  `assertCanonicalShape`, an adapter-agnostic structural validator, so
  `assertRoundTrip` now runs all three legs: shape in, shape asserted, round
  trip out.
  *Exit:* met. No empty cells; the seven entries that remain in `raw` are listed
  with the argument for each. `test/neutrality.test.js` is the table as
  assertions — it strips `raw` from canonical objects and asserts every fact an
  OpenAI or Gemini adapter would need is still readable, so a fact sliding back
  into `raw` fails the build.

## Where things live

```
NEUTRALITY.md            the Phase 5 OpenAI/Gemini mapping table and its argument
index.js                 entrypoint: load config, listen, handle signals
config/index.js          mode, port, upstream, timeouts, capture cap
config/providers.js      the provider registry: entrypoint -> provider (data)
routing/index.js         registry -> resolve(exchange) -> route; a pure lookup
transport/server.js      http listener and its lifecycle
transport/proxy.js       the forward: request in, upstream out, bytes back
transport/upstream.js    upstream client, connect and idle timeouts
transport/headers.js     hop-by-hop filtering, header fidelity
transport/body-capture.js  non-blocking tee into memory, never rejects
canonical/model.js       enums and factories; every factory freezes its result
canonical/freeze.js      deepFreeze, cycle-safe
adapters/anthropic.js    Messages API <-> canonical, both directions + streaming
adapters/sse.js          text/event-stream framing, provider-neutral
pipeline/index.js        ordered observer dispatch, per-call error isolation
pipeline/exchange.js     the onExchange subscriber: bytes -> canonical -> dispatch
plugins/index.js         name -> factory registry
plugins/dump-session.js  markdown transcript per session
plugins/meter-tokens.js  per-turn and per-session token ledger
sinks/markdown.js        canonical -> markdown (transcript and ledger)
sinks/sessions.js        sessions/<id>/ writer, serialized and atomic
test/helpers.js          loopback upstream, blackhole socket, raw HTTP client
test/fixture-harness.js  corpus loader, semantic equality, canonical shape,
                         round-trip assertion
test/neutrality.test.js  NEUTRALITY.md as assertions, over a raw-stripped view
test/routing.test.js     the router's lookup, and what config does with a registry
test/fixtures/           request-*.json, response-*.json, stream-*.sse
```

`createProxyHandler({ config, onExchange })` takes an `onExchange` callback —
that is the **seam every later layer attaches to**. It is called only in observe
mode, only after the client response has finished, and its throws are caught and
logged. Routing, adapters, and the pipeline hang off that callback; do not
thread later-layer concerns into `transport/` itself.

Notes on the current implementation:

- Header fidelity uses `rawHeaders` throughout, so duplicate and mixed-case
  headers survive. Don't switch to the lowercased `headers` object.
- `accept-encoding` is stripped on the way out so upstream bodies come back in
  identity encoding and stay readable by later layers.
- Canonical uses `null` for "the provider omitted this" and `[]` for "sent
  empty" on `system`, `tools`, and `stopSequences`; `usage` numbers are null when
  unreported, which is not the same as zero. Consumers that don't care write
  `req.tools ?? []`.
- **`usage` has exact definitions, and they are not any one provider's.**
  `inputTokens` excludes cache reads; `outputTokens` includes reasoning;
  `totalTokens` is what the provider itself billed, reported rather than
  derived. OpenAI and Gemini both report inclusive prompt counters and Gemini
  reports an exclusive completion counter, so those adapters compute rather than
  copy. The derivations are in `NEUTRALITY.md`; changing one silently makes the
  ledger incomparable with itself.
- A content block or tool definition carries `cache` when the provider marked an
  explicit prompt-cache breakpoint there. It is modeled, not raw, because it is
  the request-side cause of the `cacheReadTokens`/`cacheWriteTokens` split.
- `TOOL_KIND.PROVIDER` marks a tool the provider executes itself. A later
  transform must never rewrite such a call or its result, and a provider tool
  legitimately has no schema.
- Attachments are `BLOCK.MEDIA` keyed by `source.mediaType`, not an image block:
  images, PDFs, audio and video are one shape. `BLOCK.JSON` holds a structured
  tool-result payload as parsed data rather than as text to re-parse.
- Every canonical factory deep-freezes what it returns, so invariant 1 holds
  before any pipeline exists to enforce it.
- The stream accumulator rebuilds the **wire-form** message and converts once at
  the end. That is deliberate: a streamed turn and the same turn unstreamed then
  produce identical canonical objects by construction, instead of via two
  mappings that can drift.
- Round-trip equality is *semantic*, and `test/fixture-harness.js` lists the
  three Anthropic spellings it treats as equivalent (string sugar for a single
  text block, explicit `null` vs. absent, `is_error`/`stream` false vs. absent).
  Everything else must come back deep-equal. Don't grow that list to make a
  failing round trip pass — a new equivalence needs the same kind of argument.
- The transcript is **rewritten** from the newest request each turn, not
  appended to. Every request carries the full history, so the file always shows
  the conversation as the model actually saw it — including what a compaction
  dropped. The ledger is the opposite: it accumulates in memory, so a gateway
  restart starts a new ledger for a conversation that spans it.
- `pipeline/exchange.js` takes `resolve` as a parameter, and the composition
  root passes `createRouter({ providers: config.providers })`. It is injected,
  not imported, so `pipeline/` does not depend on `routing/`. `routing/` owns
  what a path is (`pathOf`); nothing else should parse one.
- **Transport forwards to one upstream, resolved at startup.** The registry
  carries an `upstream` per entry, and `forwardTarget` in `config/index.js`
  throws if the entries ever name more than one, with a message pointing at the
  work: a `resolveUpstream` seam on `createProxyHandler` beside `onExchange`.
  That seam is deliberately not built — there is nothing to route to yet, and
  speculative machinery with no test is what this build is avoiding.
- Adding a provider is an entry in `config/providers.js` plus an adapter in
  `adapters/`. If a change makes it more than that, the registry has stopped
  being a lookup.
- Adding fields to the `onExchange` record is transport reporting what it saw
  (`requestHeaders`/`responseHeaders` are how the observer tells an SSE body
  from a JSON one). Threading a *later-layer concern* into `transport/` is the
  thing to avoid — not extending the record.
- The gateway is a **reverse** proxy (origin-form request URLs, one configured
  upstream). It is not an `HTTPS_PROXY`-style forward proxy and does not handle
  `CONNECT` or absolute-form request URLs.

## Design rules

- **Write both adapter directions now.** The skeleton only calls `toCanonical`,
  but `fromCanonical` is what proves the model is lossless; a one-way adapter
  hides its own gaps.
- **Design canonical as the intersection of provider capabilities**, not as a
  rename of Anthropic's schema. Provider-specific surplus goes in an opaque
  `raw` escape hatch that adapters own and plugins ignore. Reaching for `raw`
  for something a plugin needs is a defect in the model — fix the model.
- **Meter tokens from the skeleton onward.** This is a token efficiency
  platform; the baseline measurement is what every future transform is judged
  against.
- **Keep `GATEWAY_MODE=passthrough` working and tested for the life of the
  project.** It is the bisect tool for every future "is it the gateway?"
  question.

## Explicitly out of scope

Do not build these, even when they look easy or a phase seems to need them:

- Tool-output minification, or any request/response mutation.
- Downstream SSE block buffering.
- A second provider adapter.
- Caching, retries, rate-limit handling, or a control-plane UI.

If a phase appears to require one of these to prove its point, the phase's exit
criterion is wrong — flag the criterion instead of building the feature.
