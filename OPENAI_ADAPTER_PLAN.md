# OpenAI Adapter — Build Instructions

Instructions for an **existing repository** whose walking skeleton is complete.
The deliverable is a second provider adapter — OpenAI Chat Completions — running
beside the Anthropic adapter in one gateway process, with the registry doing the
work the registry was built to do.

**This plan still changes nothing on the wire.** No transform, no mutation, no
minification. This is the plan that tests whether the seams from the skeleton
were in the right places, by putting a genuinely different wire format through
them. If a phase here needs a transform to prove its point, the criterion is
wrong.

`NEUTRALITY.md` already maps three fixtures to and from OpenAI, field by field.
That table is the specification for this build. Where the code and the table
disagree, one of them is a defect — decide which, and fix that one.

---

## Non-negotiable invariants

The five from `CLAUDE.md` hold unchanged. Three consequences of this build are
worth stating separately, because they are the ones a second provider makes
tempting to break.

6. **A missing provider field is `null`, never a computed guess and never zero.**
   OpenAI does not report a cache-write counter and does not report usage at all
   on a stream the client didn't opt into. Both are `null`. A zero in the ledger
   means the provider said zero.
7. **The gateway does not add request fields to improve its own observability.**
   Specifically: never inject `stream_options: {include_usage: true}`. That is a
   mutation, it is client-visible, and wanting better telemetry is exactly the
   rationalization invariant 2 exists to refuse.
8. **Each adapter owns its own semantic-equivalence list.** The three Anthropic
   spellings in `test/fixture-harness.js` are Anthropic's. OpenAI's list is
   separate and each entry needs its own argument. A shared list is how one
   provider's sloppiness becomes the other's.

---

## Phase 0 — Decide the surface, then extend the corpus

Two decisions before any code.

**Which OpenAI API.** Build against **Chat Completions** (`/v1/chat/completions`).
`NEUTRALITY.md` is written against it, it is what most OpenAI-compatible clients
and third-party gateways speak, and it is the smaller target. The Responses API
is a later plan; note the decision and its reason in `NEUTRALITY.md` so the next
person doesn't relitigate it.

**Three model questions the Anthropic adapter never had to answer.** Settle each
in `canonical/` before writing the adapter, not during:

- `n > 1`. Anthropic returns one message; OpenAI returns a `choices` array.
  Decide whether canonical grows a list of candidates or models the first choice
  and treats the rest as unmodeled. Either is defensible; picking silently is
  not, because the ledger's `outputTokens` covers all choices either way.
- **Role vocabulary.** OpenAI has `system`, `developer`, `tool` and a deprecated
  `function`. Map them onto the canonical roles explicitly, including which
  direction a `developer` message comes back out as.
- **Content as string vs. parts.** OpenAI accepts both spellings for message
  content, as Anthropic does for `system`. Decide the canonical normalization
  and which spelling `fromCanonical` emits.

Then extend `test/fixtures/` with the OpenAI counterparts of the existing corpus:
simple text, system/developer message, tools and a multi-tool-call turn, tool
results, media (image URL *and* base64 data URL — they are different shapes), an
error envelope, a refusal, and three streams (text, tool call, and one where the
client did not request usage).

**Exit:** the three model questions are answered in writing; the OpenAI fixture
corpus is committed and loads through `test/fixture-harness.js` unchanged. No
adapter exists yet and `npm test` is green.

---

## Phase 1 — The `resolveUpstream` seam

`forwardTarget` in `config/index.js` throws when the registry names more than one
upstream, with a message pointing at this work. Cash it in.

- Add `resolveUpstream` to `createProxyHandler({ config, onExchange })`, beside
  `onExchange` and with the same discipline: injected, not imported, and
  provider-ignorant. It receives what transport already knows about the request —
  local port, path, headers — and returns an upstream.
- The composition root in `index.js` builds it from the registry, the same way it
  builds `resolve` from `createRouter`. `routing/` owns `pathOf`; transport must
  not learn to parse a path to do this.
- Delete the `forwardTarget` throw and replace it with the real lookup. Keep the
  single-upstream case a plain path — one entry resolves at startup as before.
- An unroutable request is a transport-layer decision, not a crash. Decide the
  response (a 404 with an inert body is the honest answer) and test it.
- `GATEWAY_MODE=passthrough` still forwards to one configured upstream from the
  environment and ignores the registry entirely. It is the bisect tool; do not
  make it depend on routing.

**Exit:** a registry with two entries naming two different upstreams boots, and
`test/transport.test.js` drives both from one gateway process against two
loopback servers, asserting byte fidelity on each. This phase ships with the
Anthropic entry duplicated under a second port — no OpenAI adapter is involved,
because this is a transport concern and should be provable without one.

---

## Phase 2 — `adapters/openai.js`, non-streaming, both directions

Now write the adapter, mirroring the Anthropic one's surface exactly:
`requestToCanonical`, `requestFromCanonical`, `responseToCanonical`,
`responseFromCanonical`.

Both directions now, for the reason the skeleton gave: `fromCanonical` is what
proves the model is lossless, and this is the first time that claim gets tested
against a format the model wasn't derived from.

The cells to get right, all of them already in `NEUTRALITY.md`:

- **System prompt placement** — a message in the array, not a top-level field.
- **Tool-call correlation** — `tool_calls[].id` on the assistant message pairs
  with `tool_call_id` on a subsequent `tool` role message. Anthropic nests the
  result in a user turn; OpenAI gives it its own message. The canonical
  correlation must survive both.
- **Tool call arguments are a JSON string**, not an object. Parse on the way in,
  serialize on the way out, and preserve the exact string in `raw` — a
  re-serialized object is not byte-identical and `fromCanonical` has to be.
- **Stop reasons** — `stop`, `length`, `tool_calls`, `content_filter`, and
  `function_call`. Map onto the canonical enum; a refusal is not a stop.
- **Usage.** `prompt_tokens` is inclusive of cached tokens, so `inputTokens` is
  `prompt_tokens - prompt_tokens_details.cached_tokens` — computed, per the
  derivations already recorded in `NEUTRALITY.md`. `cacheReadTokens` is
  `cached_tokens`. `cacheWriteTokens` is `null`: OpenAI's caching is automatic
  and unreported, and that is not zero. `outputTokens` includes
  `completion_tokens_details.reasoning_tokens`, which is already the canonical
  definition. `totalTokens` is reported, not derived.
- **Media** — `image_url` with an `http(s)` URL and `image_url` with a
  `data:` URL are two different `BLOCK.MEDIA` sources. A URL the gateway never
  fetches still has to round-trip.
- **Provider tools** — OpenAI's built-in tools are `TOOL_KIND.PROVIDER` and have
  no schema, same as Anthropic's.
- **Strict mode and `parallel_tool_calls`** — decide modeled vs. `raw` against
  the test in `CLAUDE.md`: would a plugin plausibly read it?

**Exit:** `test/adapter-openai.test.js` asserts
`fromCanonical(toCanonical(x))` is semantically equal to `x` over the whole
Phase 0 corpus, with OpenAI's own equivalence list. `assertCanonicalShape` passes
on every canonical object produced. The adapter is not wired into the registry
yet and client-visible behavior is unchanged.

---

## Phase 3 — Streaming

OpenAI's stream differs from Anthropic's in shape, not just in naming, and this
is where an Anthropic-shaped accumulator would show itself.

- Deltas arrive as `choices[].delta` with no explicit block lifecycle — no
  `content_block_start` / `_stop` equivalent. Block boundaries are inferred.
- Tool call arguments arrive as **string fragments** across many chunks, keyed by
  `tool_calls[].index`, and must be concatenated before parsing. A fragment is
  not valid JSON on its own.
- The stream terminates with a `[DONE]` sentinel that is not JSON. `adapters/sse.js`
  is provider-neutral framing and should already pass it through; confirm rather
  than assume, and if it needs a change, the change belongs in the adapter.
- Usage arrives in a final chunk **only if the client sent
  `stream_options.include_usage`**. When it didn't, usage is `null` — see
  invariant 7. The gateway does not add the flag to fix this.

Rebuild the **wire-form** response and convert once at the end, exactly as the
Anthropic accumulator does. That discipline is what makes a streamed turn and the
same turn unstreamed produce identical canonical objects by construction, and it
matters more here, where the delta format diverges further from the final one.

**Exit:** `streamToCanonical` over the three OpenAI stream fixtures produces
canonical objects deep-equal to the non-streamed equivalents of the same turns.
The no-usage stream yields `null` counters, and `test/session.test.js`-style
coverage asserts a plugin reading them handles `null` without throwing.

---

## Phase 4 — Registry wiring and a live session

The claim under test is the one in `CLAUDE.md`: *adding a provider is an entry in
`config/providers.js` plus an adapter in `adapters/`. If it is more than that,
the registry has stopped being a lookup.*

- Add the OpenAI entry: entrypoint (a second port is cleaner than a path prefix,
  since both providers use `/v1/`), `adapter`, `upstream`, and `modeledPaths`
  covering `/v1/chat/completions` only.
- Everything else on OpenAI's surface — `/v1/embeddings`, `/v1/models`,
  `/v1/responses` — is unmodeled and takes the Phase 1 transport path. Assert
  that, don't assume it.
- Confirm the diff. If this phase touched `transport/`, `pipeline/`, `plugins/`
  or `sinks/`, stop and find out why; that is the finding, and it is more
  valuable than the adapter.

Then drive it for real:

```sh
npm start &
OPENAI_BASE_URL=http://127.0.0.1:8788 <your openai client>
```

**Exit:** two real sessions — one Claude Code through the Anthropic port, one
OpenAI client through the OpenAI port — run through **one** gateway process and
produce complete transcripts and ledgers in `sessions/`. `grep -ril openai` over
the source layers matches exactly `adapters/openai.js` and `config/providers.js`,
the same result Phase 4 of the skeleton demanded for Anthropic.

---

## Phase 5 — Neutrality, now with evidence

`NEUTRALITY.md` was an argument on paper. Half of it is now executable, and the
half that isn't has become more suspect, not less.

- Replace every OpenAI cell in `test/neutrality.test.js` that the real adapter
  now covers with an assertion driven through the adapter. Keep the raw-stripped
  view: a fact sliding back into `raw` must still fail the build.
- Record every place the table was wrong. Those are the model's real defects and
  the honest measure of how Anthropic-shaped it was.
- **The Gemini column is now the only unvalidated one**, and it inherits all the
  suspicion the OpenAI column just shed. Re-read it against what this build
  taught you and mark the cells you now trust less.
- Assert **ledger comparability**: the same conversation, same prompt, run
  through both providers, produces `usage` numbers that mean the same thing under
  the definitions in `CLAUDE.md`. The counters will differ — tokenizers differ —
  but `inputTokens` must exclude cache reads on both sides, and `outputTokens`
  must include reasoning on both. This is the measurement every future transform
  is judged against; if it isn't comparable across providers, it isn't a
  baseline.

**Exit:** the OpenAI column of `NEUTRALITY.md` is assertions rather than prose,
its corrections are documented, and a cross-provider ledger comparison runs in
CI.

---

## Explicitly out of scope

Unchanged from the skeleton, and one addition:

- Tool-output minification, or any request/response mutation.
- Downstream SSE block buffering.
- Caching, retries, rate-limit handling, or a control-plane UI.
- **Cross-provider translation.** Both adapters going both directions makes it
  newly possible to accept an Anthropic request and serve it from OpenAI. Do not.
  It is a mutation with a routing decision attached, it breaks invariants 1 and 2
  together, and the fact that the pieces now fit is not an argument for
  assembling them.
- **The Responses API**, and a third adapter.

If a phase appears to require one of these, the phase's exit criterion is wrong —
flag the criterion instead of building the feature.
