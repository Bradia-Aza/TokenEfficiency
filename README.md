# Token Efficiency Gateway

A provider-agnostic LLM gateway proxy. It sits between a client (e.g. Claude
Code) and an LLM provider's API, transparently forwarding every request and
response while observing them on the side.

**Current state:** the walking skeleton is complete. The proxy is a
transparent pass-through — byte-for-byte identical to no proxy at all — with a
read-only observation layer on top that writes conversation transcripts and a
token ledger. It does not modify requests or responses. Token minification and
every other transform are future work; this build exists to prove the seams
(transport, adapters, canonical model, pipeline, routing) are in the right
place before any transform is added.

See [`GATEWAY_SKELETON_PLAN.md`](GATEWAY_SKELETON_PLAN.md) for the phase-by-phase
build plan and exit criteria, and [`CLAUDE.md`](CLAUDE.md) for the operating
rules and architectural invariants. [`NEUTRALITY.md`](NEUTRALITY.md) documents
how the canonical model maps to OpenAI and Gemini wire formats, validating that
it isn't just a rename of Anthropic's schema.

## How it works

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

Requests flow `transport -> routing -> adapter.toCanonical -> pipeline`, with
the original bytes forwarded upstream in parallel and unchanged. The canonical
object is a side channel for observation, never the thing actually in flight.
Anything that can't be modeled — unknown endpoints, malformed JSON, non-2xx
responses — is forwarded byte-for-byte rather than dropped or altered.

Each conversation is observed into `sessions/<session-id>/` as a rewritten
`transcript.md` (what the model actually saw, each turn) and an accumulating
`tokens.md` / `tokens.json` ledger.

## Requirements

- Node.js >= 20
- No dependencies (zero-dependency by design; see `CLAUDE.md` before adding one)

## Usage

```sh
npm start                 # run the gateway (see config/index.js for env vars)
npm test                  # run the full test suite (node:test, no mocks)
```

Point a Claude Code session at the gateway:

```sh
npm start &
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

To bypass every layer above raw transport (useful for isolating "is it the
gateway?" issues):

```sh
GATEWAY_MODE=passthrough npm start
```

### Configuration

All configuration is via environment variables, read in `config/index.js`:

| Variable | Purpose |
|---|---|
| `GATEWAY_MODE` | `passthrough` to bypass routing/adapters/pipeline entirely |
| `GATEWAY_PORT` / `GATEWAY_HOST` | where the gateway listens |
| `GATEWAY_UPSTREAM` | the provider API to forward to |
| `GATEWAY_CONNECT_TIMEOUT_MS` / `GATEWAY_IDLE_TIMEOUT_MS` | upstream timeouts |
| `GATEWAY_MAX_CAPTURE_BYTES` | cap on captured body size for observation |
| `GATEWAY_ACCESS_LOG` | enable access logging |
| `GATEWAY_SESSIONS_DIR` | where transcripts/ledgers are written |
| `GATEWAY_PLUGINS` | which observer plugins are enabled |

## Testing

```sh
npm test
node --test "test/**/*.test.js" --test-name-pattern 'passthrough'   # one slice
```

Tests use `node:test` against real loopback HTTP servers rather than mocks, to
exercise actual socket behavior (mid-stream disconnects, timeouts, malformed
bodies). `test/fixtures/` holds the request/response/stream corpus used for
adapter round-trip and neutrality assertions.

## Status

All five phases of the walking skeleton are done: transparent transport,
canonical model + Anthropic adapter (both directions), the read-only observer
pipeline, routing + provider registry, and neutrality validation against
OpenAI/Gemini wire formats. See `GATEWAY_SKELETON_PLAN.md` for details on each
phase's exit criterion.
