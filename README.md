# Token Efficiency Gateway

A provider-agnostic LLM gateway proxy. It sits between a client (e.g. Claude
Code, or any OpenAI Chat Completions client) and an LLM provider's API,
transparently forwarding every request and response while observing them on
the side.

**Current state:** the walking skeleton is complete; a second provider adapter
(OpenAI Chat Completions) runs beside the first (Anthropic Messages) in one
process; `GATEWAY_MODE=transform` rewrites a modeled request before it goes
upstream; and a research phase has measured *where* the platform should
intercept.

In observe mode (the default) and passthrough mode the proxy is a transparent
pass-through — byte-for-byte identical to no proxy — with a read-only
observation layer writing conversation transcripts and a token ledger per
provider. The one transform that exists is deliberately trivial (a
word-substitution dictionary): it proves the seam is real and the round trip is
safe, and saves no tokens. Token minification is the next plan.

The interception study ([`INTERCEPTION_FINDINGS.md`](INTERCEPTION_FINDINGS.md))
recommends **intercepting at the proxy** — not because the proxy observes more,
but because client hooks cannot reach the tokens: no hook event can rewrite a
tool result after execution, and none can touch replayed conversation history,
which is where token mass accumulates. Its instruments live in
[`research/`](research/) and its real-session numbers are still pending.

### Plans

| Document | What it covers |
|---|---|
| [`GATEWAY_SKELETON_PLAN.md`](GATEWAY_SKELETON_PLAN.md) | the walking skeleton, phase by phase |
| [`OPENAI_ADAPTER_PLAN.md`](OPENAI_ADAPTER_PLAN.md) | the second adapter |
| [`TRANSFORM_PLAN.md`](TRANSFORM_PLAN.md) | the transform seam and the substitution transform |
| [`INTERCEPTION_RESEARCH_PLAN.md`](INTERCEPTION_RESEARCH_PLAN.md) | the interception study (research, not a build) |
| [`INTERCEPTION_FINDINGS.md`](INTERCEPTION_FINDINGS.md) | what that study concluded |
| [`NEUTRALITY.md`](NEUTRALITY.md) | how canonical maps to OpenAI and Gemini, field by field |
| [`CLAUDE.md`](CLAUDE.md) | operating rules and architectural invariants |

## How it works

```
config/       ports, upstreams, provider registry, enabled plugin list,
              transform dictionary loading
transport/    http listener, body capture, hop-by-hop headers,
              upstream client, timeouts, error paths, transform seam
routing/      request -> { provider, endpoint, modeled: bool }
adapters/     provider wire format <-> canonical    (anthropic.js, openai.js)
canonical/    provider-neutral domain model + freeze helpers
pipeline/     ordered observer dispatch, error isolation
plugins/      dump-session.js, meter-tokens.js, raw-capture.js
transforms/   canonical -> { canonical, edits }; ordered application,
              the substitution transform
sinks/        markdown renderer, sessions/ writer

research/     measurement rig for the interception study; imports from the
              gateway, nothing imports it, deleting it leaves the suite green
```

Requests flow `transport -> routing -> adapter.toCanonical -> pipeline`, with
the original bytes forwarded upstream in parallel and unchanged. The canonical
object is a side channel for observation, never the thing actually in flight.
Anything that can't be modeled — unknown endpoints, malformed JSON, non-2xx
responses — is forwarded byte-for-byte rather than dropped or altered.

In transform mode, request bodies are additionally routed through
`transforms/` between `adapter.requestToCanonical` and the pipeline; the
result — re-serialized through `adapter.requestFromCanonical` — is what
actually goes upstream, and the pre-transform canonical request is kept
alongside it purely for observation. A transform is never a plugin: it can
change what is sent, a plugin never can, and the two live in separate
directories with no shared registry. A request with zero edits still forwards
the original captured bytes rather than a re-serialized copy of them, so
enabling transform mode with an empty dictionary is provably identical to
observe mode. The response path is untouched in every mode — no transform
rewrites what the model said back.

Routing supports more than one upstream: `transport/` resolves a per-request
upstream from the provider registry (`config/providers.js`), keyed on the
local port the client connected to and the request path. Adding a provider is
an entry in that registry plus an adapter in `adapters/` — nothing else in the
gateway needs to change, and that claim is what `OPENAI_ADAPTER_PLAN.md`'s
Phase 4 set out to test.

Each conversation is observed into `sessions/<session-id>/` as a rewritten
`transcript.md` (what the model actually saw, each turn) and an accumulating
`tokens.md` / `tokens.json` ledger — one session directory per conversation,
regardless of which provider served it.

## Requirements

- Node.js >= 20
- No dependencies (zero-dependency by design; see `CLAUDE.md` before adding one)

## Usage

```sh
npm start                 # run the gateway (see config/index.js for env vars)
npm test                  # run the full test suite (node:test, no mocks)
```

Point a Claude Code session at the gateway (the Anthropic entry, port 8787 by
default):

```sh
npm start &
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

Point an OpenAI Chat Completions client at the gateway's OpenAI entry (port
8788 by default — a second port, since both providers use `/v1/` and the
registry keys entries on port rather than path):

```sh
npm start &
OPENAI_BASE_URL=http://127.0.0.1:8788 <your openai client>
```

Both run through the same gateway process at once; each produces its own
session directory under `sessions/`.

To bypass every layer above raw transport (useful for isolating "is it the
gateway?" issues) — passthrough ignores the provider registry entirely and
forwards everything to one configured upstream:

```sh
GATEWAY_MODE=passthrough GATEWAY_UPSTREAM=https://api.anthropic.com npm start
```

To rewrite a modeled request before it goes upstream — the first live
transform, a trivial word-substitution dictionary that proves the seam is real
(see `TRANSFORM_PLAN.md`):

```sh
echo '{"iran": "canada"}' > dict.json
GATEWAY_MODE=transform GATEWAY_TRANSFORM_DICT=./dict.json npm start
```

Only the request is rewritten; the model's reply reaches the client verbatim.
An empty dictionary makes transform mode provably identical to observe mode —
zero edits means the original bytes are forwarded, not a re-serialization of
them. `GATEWAY_TRANSFORM_DICT` is validated once at startup (word-boundary
keys, no key mapping to itself, no value containing another key) and a bad
dictionary fails the process before any traffic, not per request.

### Taking a research capture

The interception study's rig records both interception points at once — every
HTTP exchange on the proxy side, every hook firing on the client side — as
lossless JSONL. Both writers are non-blocking and neither can fail a session.

```sh
# merge research/hooks.settings.json into .claude/settings.json first
GATEWAY_PLUGINS=dump-session,meter-tokens,raw-capture npm start &
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

Then run the analyses:

```sh
node research/correlate.js          # RQ1 — can a hook event be matched to a request?
node research/analyze/reach.js      # RQ2 — where the input tokens actually are
node research/analyze/mutation.js   # RQ3 — what each side can change
node research/analyze/cache.js      # RQ4 — does a trim survive the prompt cache?
node research/analyze/latency.js    # RQ5 — added wall-clock per side
```

`raw-capture` is **off by default**: it writes full prompt text and file
contents to disk. Captures land in `research/captures/`, which is gitignored and
stays local — nothing in the rig sends anything anywhere. See
[`research/README.md`](research/README.md) for the scenario runbook.

### Configuration

All configuration is via environment variables, read in `config/index.js`:

| Variable | Purpose |
|---|---|
| `GATEWAY_MODE` | `passthrough` to bypass routing/adapters/pipeline entirely; `transform` to rewrite modeled requests before forwarding |
| `GATEWAY_PORT` / `GATEWAY_HOST` | where the gateway listens (the Anthropic entry's port, and passthrough's one port) |
| `GATEWAY_UPSTREAM` | overrides every registry entry's upstream at once — the blunt knob, mainly for passthrough and tests |
| `GATEWAY_<NAME>_UPSTREAM` | overrides one registry entry's upstream by name, e.g. `GATEWAY_OPENAI_UPSTREAM`, `GATEWAY_ANTHROPIC_UPSTREAM` |
| `GATEWAY_<NAME>_PORT` | overrides one registry entry's port by name, e.g. `GATEWAY_OPENAI_PORT` (default 8788) |
| `GATEWAY_CONNECT_TIMEOUT_MS` / `GATEWAY_IDLE_TIMEOUT_MS` | upstream timeouts |
| `GATEWAY_MAX_CAPTURE_BYTES` | cap on captured body size for observation; in transform mode, also the bound on what a request can be while still eligible for the transform (over it, the transform is skipped and the original body still forwards complete) |
| `GATEWAY_TRANSFORM_DICT` | path to a JSON `{"key": "value"}` substitution dictionary; required when `GATEWAY_MODE=transform` |
| `GATEWAY_ACCESS_LOG` | enable access logging |
| `GATEWAY_SESSIONS_DIR` | where transcripts/ledgers are written |
| `GATEWAY_PLUGINS` | which observer plugins are enabled (`raw-capture` is off by default) |
| `GATEWAY_RAW_CAPTURE` / `GATEWAY_HOOK_CAPTURE` | where the research rig writes its JSONL captures |

The provider registry itself — which providers exist, which port and upstream
each defaults to, which endpoints are modeled — lives in `config/providers.js`,
not in environment variables; the env vars above only override it.

## Testing

```sh
npm test
node --test "test/**/*.test.js" --test-name-pattern 'passthrough'   # one slice
```

278 tests, no mocks and no dependencies. They use `node:test` against real
loopback HTTP servers to exercise actual socket behavior (mid-stream
disconnects, timeouts, malformed bodies). `test/fixtures/` holds the Anthropic request/response/stream corpus;
`test/fixtures/openai/` holds OpenAI's own corpus, kept separate so one
provider's fixtures never run through another provider's adapter. Each
adapter's round-trip tests live in `test/adapter-<name>.test.js` and assert
against that provider's own fixtures and its own semantic-equivalence list
(each adapter owns that list rather than sharing one — see `CLAUDE.md`).

The research rig carries its own tests (`correlate`, `reach`, `mutation`,
`cache`, `latency`, `scenarios`, `findings`, `raw-capture`) — an instrument that
silently miscounts would answer the architectural question wrongly and nothing
downstream would catch it. They are deletable along with `research/`: removing
the rig leaves the remaining suite green, which is asserted by construction
rather than assumed.

## Status

**Walking skeleton — done.** All five phases: transparent transport, canonical
model + Anthropic adapter (both directions), the read-only observer pipeline,
routing + provider registry, and neutrality validation against OpenAI/Gemini
wire formats. Exit criteria per phase in `GATEWAY_SKELETON_PLAN.md`.

**OpenAI adapter — done.** `adapters/openai.js` implements the same
both-directions surface as Anthropic's, streaming included, wired into the
registry on its own port and running alongside Anthropic in one process.
`NEUTRALITY.md`'s OpenAI column is now assertions driven through the real
adapter rather than a hand-derived table, with the corrections that exercise
found recorded there. The Gemini column remains unvalidated — no Gemini adapter
exists yet.

**Phase 6, the first transform — done.** Offline round-trip safety over the
fixture corpus; `transforms/` and the substitution transform with its matching
and skip rules; the live `transformRequest` seam, buffering the request body
ahead of the forward and adjusting `content-length`; and
baseline-vs-transformed observation, so the transcript shows what was actually
sent and the ledger records before/after byte counts and edit counts per turn.

**Phase 0, the interception study — instruments done, data pending.** All six
phases of `INTERCEPTION_RESEARCH_PLAN.md` are built and tested: lossless capture
of both sides, a content-hash correlator, eight adversarial scenarios, reach and
mutation analyses, the three-way cache experiment, and latency. The finding is
`INTERCEPTION_FINDINGS.md`, and it is explicit about what is measured, what is
argued, and what is pending — the real-session numbers need a live Claude Code
session, which the rig cannot drive itself. Its recommendation is to intercept
at the proxy.

**Next:** tool-output minification at the proxy, operating on
`BLOCK.TOOL_RESULT` and `BLOCK.JSON`, against the seam Phase 6 proved. Two
properties are non-negotiable and both come from the cache finding: it must be
deterministic, and it must apply to the whole replayed history every turn.
Otherwise the prompt-cache prefix churns and the trim costs more than it saves.
