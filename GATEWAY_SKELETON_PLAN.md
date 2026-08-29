# LLM Gateway — Walking Skeleton Build Instructions

Instructions for a **new, empty project**. The deliverable is a provider-agnostic
LLM gateway proxy with provider-specific adapters, built as layered modules.

**The skeleton observes and logs. It changes nothing.** Token minification and
every other transform is out of scope here and comes in a later plan. The point
of this build is to prove the seams — transport, adapters, canonical model,
pipeline, routing — are in the right places before any transform exists to
distort them.

---

## Non-negotiable invariants

These hold at every phase. If a phase would violate one, the phase is wrong.

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
   first, then fed to the accumulator. No held blocks, no added latency. The
   buffering machinery for downstream mutation belongs in the later plan, with
   the mutation that justifies it.
5. **Layer dependencies point one way.** `transport` knows no providers.
   `adapters` know no plugins. `plugins` know no providers. Only `routing` and
   `config` may name a provider.

---

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
The canonical object is a side channel, not the thing in flight.

---

## Phase 1 — Transparent transport core

A dumb pipe, hardened. No adapters, no canonical model, no logging beyond a
one-line access log.

- Listen on a configured port, forward to a configured upstream host.
- Capture the request body without blocking the forward.
- Strip `accept-encoding` so bodies stay readable; handle hop-by-hop headers.
- Pass through non-2xx bodies, malformed JSON, and SSE `error` events untouched.
- Handle upstream connect/read timeouts and client disconnect mid-stream (abort
  the upstream request, don't leak sockets).
- `GATEWAY_MODE=passthrough` env flag that bypasses every later layer.

**Exit:** with `GATEWAY_MODE=passthrough`, a full Claude Code session through the
proxy is indistinguishable from no proxy at all — including a deliberately
induced 429 and a connection killed mid-stream. This mode keeps working, and
stays tested, for the life of the project; it is the bisect tool for every future
"is it the gateway?" question.

---

## Phase 2 — Canonical model + first adapter

Define `canonical/` as the neutral domain model:

- conversation, message, role
- content blocks: text, tool call, tool result, thinking, image
- tool definitions, stop reason, usage/token counts, error

Design it as the intersection of provider capabilities, not as a rename of
Anthropic's schema. Anything a provider needs that the model can't express goes
in an opaque `raw` escape hatch that adapters own and plugins ignore.

`adapters/anthropic.js` implements four functions plus stream accumulation:

```
requestToCanonical    requestFromCanonical
responseToCanonical   responseFromCanonical
streamToCanonical     (SSE events -> accumulated canonical response)
```

Write **both directions now**, even though the skeleton only calls
`toCanonical`. The `fromCanonical` half is what proves the model is lossless; a
one-way adapter hides its own gaps.

**Exit:** for a corpus of saved fixtures — simple text turn, multi-tool-call
turn, tool results, thinking blocks, streamed and non-streamed —
`fromCanonical(toCanonical(x))` is semantically equal to `x`. Round-trip
assertions run in CI. The proxy's client-visible behavior is unchanged from
Phase 1.

---

## Phase 3 — Read-only observer pipeline + plugins

- `pipeline/` dispatches an ordered list of observers over two hooks:
  `onRequest(canonicalRequest, ctx)` and `onResponse(canonicalResponse, ctx)`.
  Each call is individually try/caught; one failing plugin doesn't stop the rest
  and never reaches the client.
- `ctx` carries session id, provider name, timestamps, and the raw bytes for
  plugins that need fidelity the canonical model doesn't offer.
- `plugins/dump-session.js` — renders canonical request + response to a markdown
  transcript per session, written to `sessions/`.
- `plugins/meter-tokens.js` — per-turn input, output, cache-read, and
  cache-write tokens, accumulated per session and written alongside the
  transcript.

Meter tokens **now**, in the skeleton. This is a token efficiency platform; the
baseline measurement is the thing every future transform gets judged against,
and it costs almost nothing to collect once the canonical `usage` shape exists.

**Exit:** a real Claude Code session produces a complete markdown transcript plus
a token ledger, sourced entirely from canonical objects. Deliberately throwing
inside a plugin leaves the session working and the client unaffected.

---

## Phase 4 — Routing and provider registry

- `config/providers.js` maps entrypoint (port and/or path prefix) to
  `{ providerName, upstream, adapter }`.
- `routing/` resolves each request to a provider plus a `modeled` flag; unmodeled
  endpoints skip adapters and the pipeline entirely and take the Phase 1 path.
- `transport` selects the adapter pair through the registry — no provider name
  appears anywhere in transport or pipeline code.

Keep this small. It's a lookup, and it exists to remove the last hardcoded
provider reference, not to prove anything about multi-provider behavior. Do not
stand up a fake second provider to "test" it; the registry gets its real test in
the next plan, when a second adapter arrives.

**Exit:** `grep -ri anthropic` matches only `adapters/` and `config/`.

---

## Phase 5 — Neutrality validation (no second adapter)

The highest risk in this architecture is a canonical model that is secretly
Anthropic-shaped and only reveals it when the second adapter is written. Retire
that risk on paper, cheaply, before declaring the skeleton done.

- Take three saved fixtures and hand-write the mapping to and from **OpenAI** and
  **Gemini** wire formats as a table: field by field, block by block, including
  system-prompt placement, tool-call/result correlation, stop reasons, streaming
  granularity, and usage accounting.
- Every cell that can't be filled is a defect in the canonical model. Fix the
  model, not the table.
- Build the fixture harness the future adapters will use: `fixture in -> assert
  canonical shape -> assert round-trip out`.

**Exit:** the mapping table has no empty cells, and no entry resolves to "put it
in `raw`" for anything a plugin would plausibly need to read.

---

## Explicitly out of scope

Do not build these in the skeleton, even if they seem easy:

- Tool-output minification, or any request/response mutation.
- Downstream SSE block buffering.
- A second provider adapter.
- Caching, retries, rate-limit handling, or a control-plane UI.

If a phase seems to need one of these to prove its point, the phase's exit
criterion is wrong. Fix the criterion.
