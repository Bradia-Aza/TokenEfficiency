# Token Efficiency Gateway

A provider-agnostic LLM gateway proxy. It sits between a client (e.g. Claude
Code, or any OpenAI Chat Completions client) and an LLM provider's API,
transparently forwarding every request and response while observing them on
the side.

**Current state:** the walking skeleton is complete, a second provider adapter
(OpenAI Chat Completions) runs beside the first (Anthropic Messages) in one
gateway process, and a third mode, `GATEWAY_MODE=transform`, now rewrites a
modeled request before it goes upstream. In observe mode (the default) and
passthrough mode the proxy remains a transparent pass-through — byte-for-byte
identical to no proxy at all — with a read-only observation layer on top that
writes conversation transcripts and a token ledger, per provider. The
transform shipped so far is deliberately trivial (a word-substitution
dictionary): it exists to prove the transform seam is real and the round trip
is safe, not to save tokens. Token minification and every other real transform
are future work, built against a seam this phase already proved.

See [`GATEWAY_SKELETON_PLAN.md`](GATEWAY_SKELETON_PLAN.md) for the walking
skeleton's phase-by-phase build plan, [`OPENAI_ADAPTER_PLAN.md`](OPENAI_ADAPTER_PLAN.md)
for the second-adapter plan, [`TRANSFORM_PLAN.md`](TRANSFORM_PLAN.md) for the
transform seam's build plan, and [`CLAUDE.md`](CLAUDE.md) for the operating
rules and architectural invariants. [`NEUTRALITY.md`](NEUTRALITY.md) documents
how the canonical model maps to OpenAI and Gemini wire formats, validating that
it isn't just a rename of Anthropic's schema — the OpenAI half of that mapping
is now backed by the real adapter, not just a table on paper.

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
plugins/      dump-session.js, meter-tokens.js
transforms/   canonical -> { canonical, edits }; ordered application,
              the substitution transform
sinks/        markdown renderer, sessions/ writer
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
| `GATEWAY_PLUGINS` | which observer plugins are enabled |

The provider registry itself — which providers exist, which port and upstream
each defaults to, which endpoints are modeled — lives in `config/providers.js`,
not in environment variables; the env vars above only override it.

## Testing

```sh
npm test
node --test "test/**/*.test.js" --test-name-pattern 'passthrough'   # one slice
```

Tests use `node:test` against real loopback HTTP servers rather than mocks, to
exercise actual socket behavior (mid-stream disconnects, timeouts, malformed
bodies). `test/fixtures/` holds the Anthropic request/response/stream corpus;
`test/fixtures/openai/` holds OpenAI's own corpus, kept separate so one
provider's fixtures never run through another provider's adapter. Each
adapter's round-trip tests live in `test/adapter-<name>.test.js` and assert
against that provider's own fixtures and its own semantic-equivalence list
(each adapter owns that list rather than sharing one — see `CLAUDE.md`).

## Status

All five phases of the walking skeleton are done: transparent transport,
canonical model + Anthropic adapter (both directions), the read-only observer
pipeline, routing + provider registry, and neutrality validation against
OpenAI/Gemini wire formats. See `GATEWAY_SKELETON_PLAN.md` for details on each
phase's exit criterion.

The OpenAI adapter plan is also done: `adapters/openai.js` implements the same
both-directions surface as Anthropic's adapter, including streaming; it is
wired into the registry on its own port and runs alongside Anthropic in one
process; and `NEUTRALITY.md`'s OpenAI column is now assertions driven through
the real adapter rather than a hand-derived table, with the corrections that
exercise found recorded there. The Gemini column remains unvalidated — no
Gemini adapter exists yet. See `OPENAI_ADAPTER_PLAN.md` for each phase's exit
criterion.

`TRANSFORM_PLAN.md`'s four phases are done: an offline round-trip safety pass
that reviewed every byte-level diff `requestFromCanonical` can produce for the
wire and argued each one inert; `transforms/`, the substitution transform, and
its matching/skip rules; the live `transformRequest` seam on
`createProxyHandler`, buffering the request body ahead of the forward and
adjusting `content-length` for a substituted body; and baseline-vs-transformed
observation, so the transcript shows what was actually sent (noting the
pre-transform text where it differs) and the ledger records before/after byte
counts and edit counts per turn. No second transform exists yet — tool-output
minification and the rest come next, against a seam this phase proved.
