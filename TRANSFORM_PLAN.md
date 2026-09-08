# TRANSFORM_PLAN.md

Phase 6 — the first live request transform.

Read `GATEWAY_SKELETON_PLAN.md` and `CLAUDE.md` first. This plan sits on top of
the completed walking skeleton and is the first thing in the project that
*changes bytes*. Everything the skeleton built was arranged so that this plan
has one obvious place to live; the job here is to occupy that place and no more.

## What this adds

A third gateway mode, `GATEWAY_MODE=transform`, in which a modeled request is
converted to canonical, passed through an ordered list of transforms, converted
back, and the **result** is what goes upstream. The response path is untouched.

The transform shipped with it is deliberately trivial: a substitution
dictionary. Given `{"iran": "canada"}`, a user asking *"what is the capital of
iran?"* sends *"what is the capital of canada?"* upstream, and the reply is
about Ottawa. It saves no tokens. It exists because it is the smallest thing
that proves the seam is real and the round trip is safe, and because its
failures are visible in one line of output rather than buried in a diff of two
40KB request bodies.

The real transforms — tool-output minification and the rest — come after this,
against a seam that has already been proven.

## What it does not add

- No response transform. The model's reply reaches the client verbatim.
- No downstream SSE buffering. Invariant 4 holds unchanged.
- No second provider adapter.
- No token *counting*. See "Measuring the saving" below — this phase measures
  bytes and substitution counts, not tokens.

## Invariants, amended

Invariants 1–5 in `CLAUDE.md` were written for a read-only skeleton. Three of
them need a precise statement of what changes and what does not.

- **Invariant 1 stands as written.** The *observer pipeline* remains read-only.
  Plugins still receive frozen canonical objects and still return nothing. A
  transform is **not a plugin** and does not live in `plugins/`. Two separate
  mechanisms, two separate directories, no shared registry. If a transform ever
  gets registered as a plugin, this distinction has collapsed and the change is
  wrong.
- **Invariant 2 stands, and gets teeth.** Unmodeled requests are not
  transformable — there is no canonical object to transform. Unknown endpoints,
  unknown block types, malformed JSON: forwarded byte-for-byte exactly as
  before. A transform never sees them.
- **Invariant 3 stands and is the fallback rule.** Any throw in routing, the
  adapter, or a transform is caught, logged to stderr, and the **original
  captured bytes** are forwarded. A broken transform degrades the gateway to
  observe mode for that request; it never fails the request.
- **Invariant 4 is narrowed to the response path,** which is where it always
  mattered. The request body must now be fully buffered before the forward
  begins, because you cannot rewrite a body you are already streaming. Response
  chunks are still written to the client first and observed after.
- **Invariant 5 stands.** `transforms/` knows no providers. It operates on
  canonical objects only. `grep -ril anthropic` must still match exactly
  `adapters/anthropic.js` and `config/providers.js`.

### One new invariant

6. **A no-op transform forwards the original bytes.** If the transform list
   produces a canonical object that is unchanged, or reports zero edits, the
   proxy forwards the captured bytes rather than the re-serialized ones. This
   makes the entire re-serialization path — and every latent gap in
   `requestFromCanonical` — cost nothing on requests the transform doesn't
   touch, which is most of them. It also means enabling transform mode with an
   empty dictionary is provably identical to observe mode.

## Layering

```
config/       + GATEWAY_MODE=transform, transform config, dictionary loading
transport/    + buffered request body, transformRequest seam, content-length
transforms/   NEW. canonical -> { canonical, edits }. Knows no providers,
              no plugins, no transport. Pure functions.
```

Request path in transform mode:

```
transport (buffer body)
  -> routing.resolve
  -> if !modeled: forward original bytes
  -> adapter.requestToCanonical
  -> transforms.apply  -> { request, edits }
  -> if edits === 0: forward original bytes        (invariant 6)
  -> adapter.requestFromCanonical -> serialize -> forward
  -> observer pipeline sees both canonical objects
```

`transforms/` sits beside `adapters/` in the dependency graph, not below it. It
depends on `canonical/` and nothing else.

## Phases

Work in order. Do not start a phase until the previous exit criterion is
demonstrated.

### Phase 6.1 — Offline round-trip safety. No live path.

Before transport changes at all, prove that `requestFromCanonical` is safe to
serialize *for the wire* rather than merely semantically equal in a test.

Build `test/transform-roundtrip.test.js`. For every `request-*.json` fixture in
the corpus, assert:

- With an empty dictionary, `serialize(requestFromCanonical(requestToCanonical(x)))`
  is semantically equal to `x` under the existing three-spelling equivalence in
  `test/fixture-harness.js`, **and** the byte-level diff is recorded and
  reviewed. Not asserted byte-identical — the sugar equivalences make that
  false — but each surviving difference must be listed with an argument that
  upstream cannot observe it. Any difference that cannot get that argument is a
  defect in the adapter, and is fixed here rather than tolerated.
- With a dictionary, only the intended spans differ.

*Exit:* the diff list exists, every entry has its argument, and the fixture
corpus round-trips through actual serialization. This is the phase that decides
whether the rest of the plan is safe; if the diff list has an entry nobody can
defend, stop and fix the adapter before touching `transport/`.

### Phase 6.2 — `transforms/` and the substitution transform.

Pure, live-path-free. See the transform spec below.

```
transforms/index.js        ordered application, edit counting, error isolation
transforms/substitute.js   the dictionary transform
```

`apply(canonicalRequest, transforms)` returns
`{ request, edits, byTransform }`. Each transform is individually try/caught: a
throwing transform is skipped and logged, the others still run. The returned
request is re-frozen.

*Exit:* `test/transforms.test.js` covers the spec's matching rules, the skip
list, idempotence, and the disjointness validation, over canonical objects
built by hand and by the adapter from fixtures. No transport involved.

### Phase 6.3 — The live seam.

`createProxyHandler({ config, onExchange, transformRequest })`. The new
parameter mirrors `onExchange`: optional, injected not imported, called only in
transform mode. `transport/` learns nothing about canonical objects — it hands
over bytes plus the exchange record and receives bytes or `null` back, where
`null` means "forward the original".

Transport changes:

- Request body is buffered to completion before the upstream request opens,
  bounded by `GATEWAY_MAX_CAPTURE_BYTES`. **Over the cap, the transform is
  skipped and the body streams as before** — the cap must degrade to observe
  behavior, never truncate a request.
- On a substituted body: set `content-length` to the new byte length, drop
  `transfer-encoding` if present. Every other header passes through `rawHeaders`
  untouched, as now.
- On any throw, or `null`, or over-cap: original bytes, unchanged path.

*Exit:* a full Claude Code session under `GATEWAY_MODE=transform` with a
one-entry dictionary, where the substitution demonstrably reaches the model
(ask it the capital question and read the answer), the session is otherwise
indistinguishable from observe mode, and the Phase 1 transport suite passes in
all three modes. `GATEWAY_MODE=passthrough` still bypasses everything.

### Phase 6.4 — Baseline vs. transformed observation.

The observer pipeline currently sees one canonical request. In transform mode
there are two, and the ledger's whole purpose is comparing them.

Extend the exchange record with the pre-transform canonical request and the edit
report. `plugins/meter-tokens.js` records, per turn: request bytes before and
after, edit count by transform, and the upstream-reported usage. The transcript
records what was **actually sent**, since that is what the model saw — with the
pre-transform text noted where it differs.

*Exit:* `test/transform-session.test.js` drives two turns of one conversation
through the live proxy in transform mode with a throwing transform wired ahead
of the working one, and asserts the client's response bytes are untouched, the
substitution reached the upstream, the transcript shows the sent form, the
ledger's before/after byte counts are right, and the failure was logged to
stderr and nowhere else.

## The substitution transform

Config, environment-only per house rules:

```
GATEWAY_TRANSFORM_DICT=/path/to/dict.json    # {"iran": "canada"}
```

Loaded and validated once at startup. A malformed or missing file with
transform mode enabled is a **startup** failure, not a per-request one — fail
loudly before any traffic, rather than silently degrading.

### Matching rules

State these explicitly; each is a decision, not a default.

- **Word boundaries only.** `iran` matches `iran` and `Iran.` but not `Iranian`
  or `sniran`. Boundary is non-alphanumeric-or-underscore on both sides.
- **Case-insensitive match, case-preserving replacement.** `iran` → `canada`,
  `Iran` → `Canada`, `IRAN` → `CANADA`. Mixed case beyond those three patterns
  uses the value verbatim.
- **Single left-to-right pass.** Replaced spans are never re-scanned, so
  replacements cannot cascade within one pass.
- **Longest key first** where two keys overlap at the same position.
- **Deterministic.** Same input, same dictionary, same output, always. This is
  load-bearing for prompt caching (below).

### Where it applies

Applies to: `BLOCK.TEXT` in messages, and text in `system`.

Skips, each for a reason:

- **`BLOCK.THINKING` and redacted thinking** — these carry a provider signature
  over their content. Mutating the text invalidates the signature and upstream
  rejects the turn. This is the sharpest edge in the whole plan.
- **Tool definitions** (names, descriptions, schemas) — the name is a contract
  with the client's own tool dispatch; rewriting it breaks correlation.
- **`BLOCK.TOOL_CALL` input** — structured arguments the client will match
  against its own state.
- **`BLOCK.TOOL_RESULT` and `BLOCK.JSON`** — deliberately out of scope here.
  This is where minification will live, and it deserves its own plan rather
  than riding in on the demo's coattails.
- **`BLOCK.MEDIA`, unknown blocks, `stopSequences`.**

### Two hazards worth naming

**Key/value disjointness.** The client stores the model's replies and sends them
back next turn. If the model says "Canada" and `canada` is also a dictionary
key, turn two re-substitutes it and the conversation drifts. Validate at
startup: no value may contain any key as a match, and no key may be a value.
Reject the dictionary otherwise.

**Prompt cache.** Mutating a prompt invalidates the cache from the first mutated
byte onward. Because the transform is deterministic and applied to the entire
replayed history every turn, the transformed prefix is *stable* across turns, so
the cache re-warms once and then behaves normally. This property is a direct
consequence of determinism — a transform that ever varies its output for
identical input destroys prompt caching on every turn, and would cost far more
than any minification saves. The `cache` field on content blocks exists to make
this visible in the ledger; watch `cacheWriteTokens` on the first transformed
turn and `cacheReadTokens` after.

## Measuring the saving

The gateway has no tokenizer and zero dependencies, so it cannot count the
tokens of a request it did not send. The upstream reports usage only for the
transformed request. Therefore:

- This phase reports **bytes** before and after, plus edit counts. Byte delta is
  a proxy for token delta, not a measurement of it.
- True before/after token numbers come from **A/B running the same
  conversation** in observe mode and transform mode and comparing ledgers. That
  is the measurement protocol for every future transform, and it is the reason
  `GATEWAY_MODE` must keep working for the life of the project.
- A local token-counting seam is a later plan. Do not add one here, and do not
  add a second upstream call to count.

## Out of scope for Phase 6

Unchanged from `CLAUDE.md`, plus:

- Response-side transforms, including substituting the model's reply back.
- Tool-output minification.
- Per-provider or per-model transform lists.
- Any transform that is not a pure function of the canonical request.

If a phase here appears to need one of these, the exit criterion is wrong — flag
it instead of building the feature.
