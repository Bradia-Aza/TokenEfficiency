# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A token efficiency platform. It intercepts LLM input and output with a proxy: a
provider-agnostic LLM gateway with provider-specific adapters, built as layered
modules.

Current state: **the walking skeleton, a second adapter, the first transform,
and the interception study are all done.**

- **Walking skeleton (5 phases).** Transparent transport core; canonical model
  and the Anthropic adapter, both directions; read-only observer pipeline
  writing transcripts and a token ledger; routing and a provider registry; and
  the neutrality validation that hardened the canonical model against the OpenAI
  and Gemini wire formats. (Phase 5 was built before Phase 4, at the user's
  request.) Plan: `GATEWAY_SKELETON_PLAN.md`.
- **OpenAI adapter.** `adapters/openai.js` implements the same both-directions
  surface as Anthropic's, streaming included, and runs beside it in one process
  on its own port. `NEUTRALITY.md`'s OpenAI column is now assertions through the
  real adapter rather than a hand-derived table. The Gemini column remains
  unvalidated — no Gemini adapter exists. Plan: `OPENAI_ADAPTER_PLAN.md`.
- **Phase 6 — the first live transform.** `GATEWAY_MODE=transform` converts a
  modeled request to canonical, runs it through `transforms/`, converts back,
  and sends *that* upstream. The shipped transform is a word-substitution
  dictionary: it saves no tokens and is not meant to. It exists to prove the
  seam and the round trip. Plan: `TRANSFORM_PLAN.md`.
- **Phase 0 — the interception study.** Research, not a build: it measures
  whether the platform should intercept at the proxy, at client hooks, or both.
  Its instruments live in `research/` and its finding is
  `INTERCEPTION_FINDINGS.md`. Plan: `INTERCEPTION_RESEARCH_PLAN.md`.

Read the relevant plan before starting work; this file is the operating rules
that sit on top of all of them.

**The observer pipeline still changes nothing.** Transform mode is the one path
that mutates bytes, and it is deliberately narrow: request side only, modeled
requests only, deterministic, with the original bytes forwarded on any failure
or any zero-edit result. Token minification does not exist yet.

The next plan is tool-output minification at the proxy — the recommendation
`INTERCEPTION_FINDINGS.md` arrives at, built against the seam Phase 6 proved.

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
`GATEWAY_<NAME>_UPSTREAM`, `GATEWAY_<NAME>_PORT`, `GATEWAY_CONNECT_TIMEOUT_MS`,
`GATEWAY_IDLE_TIMEOUT_MS`, `GATEWAY_MAX_CAPTURE_BYTES`, `GATEWAY_TRANSFORM_DICT`,
`GATEWAY_ACCESS_LOG`, `GATEWAY_SESSIONS_DIR`, `GATEWAY_PLUGINS`.

Observation lands in `sessions/<session-id>/` as `transcript.md`, `tokens.md`
and `tokens.json`. A session is one **conversation**, not one connection:
`sessionIdFor` hashes the opening message plus the opaque `userId`, so every
turn of a thread groups into one transcript.

To put a Claude Code session through the gateway:

```sh
npm start &                                    # or GATEWAY_MODE=passthrough npm start
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

An OpenAI Chat Completions client goes to the registry's OpenAI entry, port 8788
by default — a second port rather than a path prefix, since both providers use
`/v1/`:

```sh
OPENAI_BASE_URL=http://127.0.0.1:8788 <client>
```

To rewrite modeled requests on the way out:

```sh
echo '{"iran": "canada"}' > dict.json
GATEWAY_MODE=transform GATEWAY_TRANSFORM_DICT=./dict.json npm start
```

To take a research capture (both interception points at once), see
`research/README.md` — it needs the hook registration installed as well as the
capture plugin enabled.

## Non-negotiable invariants

These hold at every phase and in every change. If a change would violate one,
the change is wrong — say so rather than working around it. `TRANSFORM_PLAN.md`
narrowed invariant 4 and added 6 when the first transform landed, and 7 comes
from the Phase 0 cache finding; the wording here is current.

1. **The observer pipeline is read-only.** Plugins receive frozen canonical
   objects and return nothing. Enforce structurally (`Object.freeze`, no return
   value), not by convention. **A transform is not a plugin** — it lives in
   `transforms/`, not `plugins/`, and the two have no shared registry. If a
   transform is ever registered as a plugin, this distinction has collapsed and
   the change is wrong.
2. **If it can't be modeled, it's moved unchanged.** Unknown endpoints, unknown
   content-block types, malformed JSON, non-2xx responses, mid-stream SSE errors
   — all forwarded byte-for-byte. An unmapped field must never cost the client
   anything, and an unmodeled request is never transformable: there is no
   canonical object to transform.
3. **Failure is never client-visible, and the fallback is the original bytes.**
   Any throw inside routing, adapters, transforms, pipeline, plugins, or sinks is
   caught, logged to stderr, and the proxy keeps streaming. A broken transform
   degrades the gateway to observe mode for that request; it never fails the
   request. A broken logger must not break the user's coding session.
4. **The response path is observed, not buffered.** Chunks are written to the
   client first, then fed to the accumulator. No held blocks, no added latency.
   *Narrowed from "streaming" to "the response path":* transform mode must
   buffer the request body before forwarding, because you cannot rewrite a body
   you are already streaming.
5. **Layer dependencies point one way.** `transport` knows no providers.
   `adapters` know no plugins. `plugins` know no providers. `transforms` know no
   providers, no plugins, and no transport — they are pure functions over
   canonical objects. Only `routing` and `config` may name a provider.
6. **A no-op transform forwards the original bytes.** If the transform list
   reports zero edits, the captured bytes go upstream rather than a
   re-serialization of them. This makes every latent gap in
   `requestFromCanonical` cost nothing on requests no transform touches, and it
   means transform mode with an empty dictionary is provably identical to
   observe mode.
7. **A transform is a deterministic function of the canonical request.** Same
   input, same dictionary, same output, always. This is load-bearing for prompt
   caching, not a style preference: the prefix is only stable across turns
   because the transform reproduces itself exactly on the whole replayed history
   every turn. A transform that varies its output for identical input destroys
   the cache on every turn and costs far more than any minification saves. See
   `INTERCEPTION_FINDINGS.md` §3.

### The research rig's own invariants

`research/` is measurement scaffolding and is governed separately, because the
failure mode of a research phase is that its scaffolding quietly becomes
production. In full in `INTERCEPTION_RESEARCH_PLAN.md`; the two that constrain
*this* codebase:

- **The rig is one-way.** `research/` may import from the gateway; no gateway
  layer may import from `research/`. Deleting `research/` and
  `plugins/raw-capture.js` must leave `npm test` green.
- **The rig does not modify the gateway's layers.** Adding a plugin is allowed —
  that is what the plugin seam is for. A finding that seems to require editing
  `transport/`, `adapters/`, `canonical/` or `pipeline/` is written down, not
  acted on. `INTERCEPTION_FINDINGS.md` §7 is where those go.

## Layering

```
config/       ports, upstreams, provider registry, enabled plugins,
              transform dictionary loading
transport/    http listener, body capture, hop-by-hop headers,
              upstream client, timeouts, error paths, the transform seam
routing/      request -> { provider, endpoint, modeled: bool }
adapters/     provider wire format <-> canonical  (anthropic.js, openai.js)
canonical/    provider-neutral domain model + freeze helpers
pipeline/     ordered observer dispatch, error isolation
plugins/      dump-session.js, meter-tokens.js, raw-capture.js
transforms/   canonical -> { canonical, edits }; pure, provider-free
sinks/        markdown renderer, sessions/ writer

research/     measurement rig for the interception study. Imports from the
              gateway; nothing imports it. Deletable.
```

Observe path: `transport -> routing -> adapter.toCanonical -> pipeline(observe)`,
with the original bytes forwarded upstream in parallel. Response path mirrors it.
**The canonical object is a side channel, not the thing in flight.**

Transform path, which is the exception to that:

```
transport (buffer body)
  -> routing.resolve
  -> if !modeled: forward original bytes
  -> adapter.requestToCanonical
  -> transforms.apply -> { request, edits }
  -> if edits === 0: forward original bytes          (invariant 6)
  -> adapter.requestFromCanonical -> serialize -> forward
  -> pipeline sees both canonical objects
```

`transforms/` sits beside `adapters/` in the dependency graph, not below it: it
depends on `canonical/` and nothing else. When adding code, place it in the layer
that owns the concern and let it depend only downward.

## Build phases

Everything below is **done**, with its exit criterion demonstrated rather than
assumed. Work any future phase the same way: do not start the next until the
current one's exit criterion is actually shown.

**Walking skeleton** (`GATEWAY_SKELETON_PLAN.md`)

1. **Transparent transport core.** A dumb pipe, hardened: body captured without
   blocking the forward, `accept-encoding` stripped, hop-by-hop headers handled,
   non-2xx and malformed bodies and SSE `error` events passed through,
   connect/read timeouts and mid-stream client disconnect handled without
   leaking sockets, and `GATEWAY_MODE=passthrough` bypassing every later layer.
   *Shown by* `test/transport.test.js` (byte-fidelity cases run in all modes).
2. **Canonical model + Anthropic adapter.** Conversation, message, role, content
   blocks, tool definitions, tool choice, stop reason, usage, error; both
   directions plus streaming. *Shown by* `fromCanonical(toCanonical(x))` over the
   fixture corpus in `test/adapter-anthropic.test.js`.
3. **Read-only observer pipeline + plugins.** Ordered observers, each call
   individually try/caught. *Shown by* `test/session.test.js`: two turns, one
   streamed, with a plugin that throws on every hook wired ahead of the working
   ones.
4. **Routing and provider registry.** `config/providers.js` is data;
   `routing/index.js` is a pure, total `resolve(exchange)`. *Shown by*
   `grep -ril anthropic` over the source layers matching only the adapter and
   the registry.
5. **Neutrality validation.** `NEUTRALITY.md` maps the model to OpenAI and Gemini
   field by field, both directions. Nine cells that could only be filled with
   "put it in `raw`" were fixed in the model. *Shown by* `test/neutrality.test.js`,
   which strips `raw` and asserts every fact another adapter would need is still
   readable — so a fact sliding back into `raw` fails the build.

**OpenAI adapter** (`OPENAI_ADAPTER_PLAN.md`). The second adapter, on its own
port in the same process, and the conversion of `NEUTRALITY.md`'s OpenAI column
from a hand-derived table into assertions through real code.

**Phase 6 — the first live transform** (`TRANSFORM_PLAN.md`). Offline round-trip
safety over the corpus; `transforms/` and the substitution transform; the live
`transformRequest` seam with a buffered request body and adjusted
`content-length`; and baseline-vs-transformed observation, so the transcript
shows what was actually sent and the ledger records before/after bytes and edit
counts. *Shown by* `test/transform-session.test.js`.

**Phase 0 — the interception study** (`INTERCEPTION_RESEARCH_PLAN.md`). Research,
not a build. Six phases: capture both sides losslessly; a content-hash correlator
(RQ1); eight adversarial scenarios; reach and mutation (RQ2, RQ3); the cache
experiment (RQ4); latency, coupling and the report (RQ5, RQ6). The instruments
are built and tested; the real-session numbers are **pending** and marked as such
throughout `INTERCEPTION_FINDINGS.md`. Its recommendation — intercept at the
proxy, because hooks cannot reach the tokens — is what the next plan starts from.

## Where things live

```
NEUTRALITY.md            the OpenAI/Gemini mapping table and its argument
INTERCEPTION_FINDINGS.md the Phase 0 finding: where to intercept, and why
index.js                 entrypoint: load config, listen, handle signals
config/index.js          mode, ports, upstreams, timeouts, capture cap, dictionary
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
adapters/openai.js       Chat Completions <-> canonical, same surface
adapters/sse.js          text/event-stream framing, provider-neutral
pipeline/index.js        ordered observer dispatch, per-call error isolation
pipeline/exchange.js     the onExchange subscriber: bytes -> canonical -> dispatch
plugins/index.js         name -> factory registry
plugins/dump-session.js  markdown transcript per session
plugins/meter-tokens.js  per-turn and per-session token ledger
plugins/raw-capture.js   lossless JSONL per exchange; research instrument, opt-in
transforms/index.js      ordered application, edit counting, error isolation
transforms/substitute.js the dictionary transform and its validation
sinks/markdown.js        canonical -> markdown (transcript and ledger)
sinks/sessions.js        sessions/<id>/ writer, serialized and atomic

research/README.md       how to take a capture and run each analysis
research/hook-logger.js  the universal hook: every event, verbatim, to JSONL
research/hooks.settings.json  registration for all 33 hook events
research/correlate.js    RQ1: content-hash alignment of the two captures
research/analyze/        RQ2 reach, RQ3 mutation, RQ4 cache, RQ5 latency
research/scenarios/      the adversarial set, the runbook, the run recorder

test/helpers.js          loopback upstream, blackhole socket, raw HTTP client
test/fixture-harness.js  corpus loader, semantic equality, canonical shape,
                         round-trip assertion
test/neutrality.test.js  NEUTRALITY.md as assertions, over a raw-stripped view
test/findings.test.js    INTERCEPTION_FINDINGS.md held to its exit criterion
test/fixtures/           request-*.json, response-*.json, stream-*.sse
test/fixtures/openai/    OpenAI's own corpus, kept separate on purpose
```

`createProxyHandler({ config, onExchange, resolveUpstream, transformRequest })`.
Three seams, all optional and all injected rather than imported:

- **`onExchange`** is the observation seam. Called only outside passthrough
  mode, only after the client response has finished, throws caught and logged.
  Routing, adapters and the pipeline hang off it.
- **`resolveUpstream`** answers which upstream a request goes to, from the
  registry. `routing/` owns what a path is; transport must not learn to parse one.
- **`transformRequest`** is the mutation seam. Bytes plus the exchange record in,
  bytes or `null` back, where `null` means "forward the original". Transport
  learns nothing about canonical objects.

Do not thread later-layer concerns into `transport/` itself. Extending the
exchange *record* is different — that is transport reporting what it saw, and is
fine.

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
- **Transport forwards per request, not per process.** The registry carries an
  `upstream` per entry and `resolveUpstream` looks it up from the route, so one
  process serves two providers on two ports at two upstreams. Passthrough mode is
  the exception and ignores the registry entirely — it is the bisect tool and
  must not depend on routing, so it forwards everything to the single
  `config.upstream` (`forwardTarget` picks the port-agnostic entry).
- Adding a provider is an entry in `config/providers.js` plus an adapter in
  `adapters/`. If a change makes it more than that, the registry has stopped
  being a lookup.
- Adding fields to the `onExchange` record is transport reporting what it saw
  (`requestHeaders`/`responseHeaders` are how the observer tells an SSE body
  from a JSON one). Threading a *later-layer concern* into `transport/` is the
  thing to avoid — not extending the record.
- The gateway is a **reverse** proxy (origin-form request URLs, upstreams from
  the registry). It is not an `HTTPS_PROXY`-style forward proxy and does not
  handle `CONNECT` or absolute-form request URLs.
- **A transform never touches signed content.** `BLOCK.THINKING` and redacted
  thinking carry a provider signature over their text; rewriting them invalidates
  it and upstream rejects the turn. Tool names, `BLOCK.TOOL_CALL` input, and tool
  definitions are contracts with the client's own dispatch. `transforms/substitute.js`
  skips all of these, each for a stated reason — read that list before writing a
  second transform.
- **`research/` is deletable and must stay that way.** It imports from the
  gateway; nothing imports it. `plugins/raw-capture.js` is the one file the rig
  added outside it, and it is an ordinary read-only observer, off by default.

## Design rules

- **Write both adapter directions now.** Only `toCanonical` is on the observe
  path, but `fromCanonical` is what proves the model is lossless — and since
  Phase 6 it is also load-bearing, because transform mode serializes through it
  onto the wire. A one-way adapter hides its own gaps.
- **Design canonical as the intersection of provider capabilities**, not as a
  rename of one vendor's schema. Provider-specific surplus goes in an opaque
  `raw` escape hatch that adapters own and plugins ignore. Reaching for `raw` for
  something a plugin needs is a defect in the model — fix the model.
- **Meter tokens from the skeleton onward.** This is a token efficiency platform;
  the baseline measurement is what every future transform is judged against.
- **Measure a transform by A/B, not by assertion.** There is no tokenizer here,
  so the gateway cannot count the tokens of a request it did not send. Real
  before/after numbers come from running the same conversation in observe mode
  and transform mode and comparing ledgers. Byte deltas are a proxy for token
  deltas, not a measurement of one.
- **Keep `GATEWAY_MODE=passthrough` working and tested for the life of the
  project.** It is the bisect tool for every future "is it the gateway?"
  question, and it is the baseline that makes gateway overhead measurable at all.

## Explicitly out of scope

Do not build these, even when they look easy or a phase seems to need them:

- **Response-side transforms.** The model's reply reaches the client verbatim in
  every mode. This includes substituting a transformed request's terms back on
  the way out.
- **Downstream SSE block buffering.** Invariant 4 still holds for the response
  path.
- **Tool-output minification, until its own plan exists.** It is the recommended
  next step (`INTERCEPTION_FINDINGS.md`), and it deserves a plan rather than
  riding in on the substitution transform's coattails.
- **A hook-level transform product.** Phase 0 tested hook mutation as a
  measurement, with the smallest possible rewrite. That is not the beginning of a
  hook-based implementation — see the finding for why.
- **A third provider adapter, or generalizing the research rig.** Two adapters
  proved the canonical model is not one vendor's schema; that job is done.
- **Caching, retries, rate-limit handling, or a control-plane UI.**
- **Third-party observability ingestion.** Captures hold full prompts, file
  contents and source code. `research/captures/` is gitignored and stays local.

If a phase appears to require one of these to prove its point, the phase's exit
criterion is wrong — flag the criterion instead of building the feature.
