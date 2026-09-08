# INTERCEPTION_FINDINGS.md

The Phase 0 finding: where the platform should intercept.

Read `INTERCEPTION_RESEARCH_PLAN.md` for the questions this answers and the rig
that answers them. Every claim below is marked **measured** (traceable to a
capture in `research/captures/` or a test in the suite), **argued** (reasoned
from a contract or an invariant, with the reasoning shown), or **pending**
(the instrument exists and is tested, but the real-session numbers are not in
yet). Section 6 lists what was not measured and why.

---

## 1. Recommendation

**Intercept at the proxy. Build the hook side only as an optional fast path for
tool-call suppression, and only if a later measurement justifies it.**

The reason is not that the proxy sees more. It is that **the hook side cannot
reach the tokens.** No hook event can rewrite a tool *result* after execution,
and no hook event can touch replayed history at all — and those two categories
are where the token mass accumulates on any session long enough for token
efficiency to matter. A hook can suppress or rewrite a tool call *before* it
runs, which is genuinely useful and is the one thing it does that the proxy
cannot do as well. But that is a different product from trimming what came back.

The coupling argument points the same way and is not close: hooks exist for one
client, bind to an event schema owned by that client's vendor, and would have to
be re-implemented for every other editor, SDK application, and agent. The
platform's premise is that it sits between providers and users generally.

The cache question (§3) is the one that could have reversed this, and the
instrument to settle it is built and tested. Until real multi-turn captures are
run through it, the recommendation carries the caveat in §3.

---

## 2. Capability, weighted by tokens

The naive version of this study counts fields and concludes the two sides are
comparable. Weighting by token mass is what separates them.

`research/analyze/reach.js` attributes character mass per content category
exactly, then apportions the provider's reported input tokens in proportion to
it. There is no tokenizer in this codebase (zero dependencies), so **character
figures are exact and token figures are estimates with a known bias** — JSON
tool arguments tokenize worse than prose. The report prints both.

| category | who can address it | why |
|---|---|---|
| tool results (replayed) | **proxy only** | No hook rewrites a result after execution; on later turns it is history. |
| conversation history | **proxy only** | A past turn is not an event, so no hook fires for it. |
| system prompt | **proxy only** | No hook event carries it. |
| tool definitions | **proxy only** | Reachable, but renaming breaks the client's own dispatch. |
| user prompt text | both | `UserPromptSubmit` can block or add context; the proxy can rewrite. |
| tool call input | **both, differently** | `PreToolUse.updatedInput` rewrites before execution — the client runs the modified call. A proxy rewrite reaches the model, but the client already ran the original. |
| thinking blocks | neither, safely | Provider-signed. Mutating the text invalidates the signature and the turn is rejected. |

**Status: measured for the mapping, pending for the token shares.** The category
→ side mapping is measured against the real fixture corpus through the real
adapter (`test/reach.test.js`). The token *percentages* need real-session
captures; the plan's expectation is that bash output, file reads and search
results dominate, and every one of those lands in a proxy-only row.

---

## 3. Cache, and what it constrains

**The mechanism.** Prompt caching keys on an exact prefix, and every turn
resends the full history. Trim a tool output at turn three and the prefix
changes for every turn after it.

- A **hook-level** trim happens before the content enters the transcript, so the
  history is internally consistent from the start and the prefix is stable by
  construction.
- A **proxy-level** trim happens on the way out, so the same trim must be
  reproduced identically on every subsequent turn. If it is not, the cache is
  invalidated and full input price is paid on a long history — plausibly more
  than the trim ever saved.

**The argument that the proxy is safe here.** The gateway's transform is a pure,
deterministic function of the canonical request, applied to the *entire replayed
history* on every turn. Identical input yields identical output, so the
transformed prefix is stable across turns: the cache re-warms once on the first
transformed turn and behaves normally thereafter. This is a direct consequence
of determinism, and it is why `TRANSFORM_PLAN.md` makes determinism a rule
rather than a preference — a transform that ever varies its output for identical
input would destroy prompt caching on every turn and cost far more than any
minification saves.

**Status: argued, with the instrument built and pending real runs.**
`research/analyze/cache.js` compares three runs (untrimmed, proxy-trimmed,
hook-trimmed) per turn and reports each one's net billed cost against the
baseline. Its verdict function distinguishes a prefix that re-warms once from
one that is rebuilt every turn, and `test/cache.test.js` asserts that a trim
which removes content while destroying the cache is reported as a net **cost**,
not a saving.

**The constraint, stated regardless of the result.** Proxy-level trimming is
cache-safe *only while it is deterministic and applied to the whole history
every turn*. Any future transform that is stateful, sampled, time-dependent, or
applied only to the newest turn breaks this and would pay full input price on
every subsequent turn. **This is a first-order architectural constraint on every
transform the platform will ever ship**, and it is the reason it appears this
high in the report.

---

## 4. Correlation, and whether a hybrid is buildable

The two sides share no identifier. The proxy derives a session id by hashing
opening-message content plus an opaque user id; hooks carry the client's own
session id; the two name different things. One conversational turn is frequently
several HTTP requests, and hooks fire on tool boundaries that do not align with
request boundaries.

So `research/correlate.js` joins on **content**: hash the tool output as the
hook observed it, search subsequent proxy request bodies for it, and record
whether it was found, in which request, after how many intervening requests, and
whether it arrived verbatim or altered. That join doubles as a direct
measurement of the thing the platform cares about — whether a hook could have
intercepted the exact bytes the proxy was about to send.

Three outcomes are kept distinct, because collapsing them would delete the
finding: a clean match (`verbatim` or `json-escaped` — the latter is simply how
a JSON body carries the bytes), a `partial` match (content truncated or wrapped
in transit, which is a limit on what a hook-level transform can guarantee), and
`unmatched`, which further separates "never reached the wire" from "only appears
in a request that predates the firing".

**Status: instrument measured, result pending.** `test/correlate.test.js` drives
it against captures with known ground truth. The match rate itself needs a real
session.

**What each outcome would mean.** A high rate means the two sides address the
same bytes and a hybrid is coherent — the interesting design question then
becomes the interface, i.e. what a hook hands the proxy so the proxy can do a
better job than it could alone (for instance: the hook knows a tool result is
about to be large, before the proxy sees it serialized). A low rate means they
are not addressing the same content, and the decision collapses to one side —
and the coupling argument picks the proxy.

Note that a *high* correlation would not change §1's recommendation on its own.
Correlation establishes that a hybrid is buildable, not that the hook side can
reach tokens it demonstrably cannot.

---

## 5. Latency and coupling

**Latency (RQ5) — pending.** `research/analyze/latency.js` reads timestamps
already present in both captures, so this needs no new scenarios. The two costs
have different shapes: a hook spawns a **subprocess per event**, so its cost
scales with the number of tool calls; the proxy adds a network hop per
**request**, and in transform mode buffers the request body before forwarding.
An exchange duration includes the upstream's own think time, so the gateway's
own overhead is the difference between a `passthrough` run and an `observe` or
`transform` run of comparable work — which is precisely why `GATEWAY_MODE` is
kept working for the life of the project. If a per-tool-call hook costs more
wall-clock time than its trim saves in tokens, that is a hard design constraint.

**Coupling (RQ6) — argued, not measured.** This needs no experiment, and it is
frequently what settles the decision when the measurements come back ambiguous:

- **Hooks are specific to one client.** They do not exist for other editors, for
  a raw SDK application, or for an agent someone writes themselves. Every
  additional client is another integration, and the platform's premise is that
  it sits between providers and users generally.
- **The proxy is client-agnostic but provider-specific** — a problem already
  solved by the adapter layer, with `NEUTRALITY.md` as the evidence that it was
  solved properly rather than assumed away.
- **Hooks bind to an event schema owned by the client vendor**, which the
  platform neither controls nor versions. The proxy binds to provider APIs,
  which are versioned and contractual.

---

## 6. What was not measured, and why

Stated plainly, because a finding that hides its gaps is worse than one that
admits them.

- **Real-session token shares, correlation rate, cache results, and latency
  numbers.** Every instrument is built and tested against known ground truth or
  the real fixture corpus, but the plan requires a *real* Claude Code session
  (rig invariant 5), which cannot be driven from inside this environment. The
  runbooks are in `research/README.md`. This is the single largest gap, and it
  is a gap in data, not in method.
- **Five of the eight scenarios are manual.** Declining a permission prompt,
  interrupting a turn mid-stream, pasting an image, and triggering compaction
  are interactive gestures; each carries its reason in
  `research/scenarios/index.js`, and the recorder marks manual runs as such. An
  honest manual result beats a synthetic automated one.
- **Hook mutation semantics are documented, not yet experimentally confirmed.**
  `research/scenarios/mutate-hook.js` implements the three experiments the plan
  asks for — a no-op rewrite, a visible rewrite, and a deliberate failure — but
  running them requires the live session above. The claim that no hook can
  rewrite a tool result comes from the current hook contract; §1 rests on it, so
  it is the first thing to confirm.
- **Only one client and one provider.** The rig measures Claude Code against the
  Anthropic adapter. Generalizing it is a project of its own and is explicitly
  out of scope; this is enough to make this decision.
- **No response-side interception was evaluated.** The response path is
  deliberately untouched, and a response transform is out of scope rather than
  merely unbuilt.

---

## 7. Findings recorded, not acted on

Rig invariant 2: a finding that seems to require editing the gateway's layers is
written down, not fixed here. One turned up.

**`test/session.test.js` has a timing race against the atomic-rename sink.**
Under full-suite load it intermittently asserts the exact contents of a session
directory while `sinks/sessions.js` has a `tokens.md.tmp` in flight — the sink
writes to a temporary name and renames, so a reader can catch the intermediate
state. Observed once in roughly a dozen full-suite runs; green in six
consecutive isolated runs. The sink's behavior is correct (the rename is what
makes a half-written transcript unreadable); the *test's* assertion of an exact
listing is what is racy. It predates this phase — both files were last touched
by the initial commit — and it is unrelated to the rig. The fix belongs in a
later build plan: have the test ignore `.tmp` entries, or drain the store before
listing.

---

## What this drives

If the recommendation stands after the real captures are taken, the next build
plan is **tool-output minification at the proxy**, operating on
`BLOCK.TOOL_RESULT` and `BLOCK.JSON` in the canonical request, with two
non-negotiable properties inherited from §3:

1. **Deterministic.** Same input, same output, always — this is what keeps the
   prompt-cache prefix stable and is not a preference.
2. **Applied to the whole replayed history every turn**, not just the newest
   turn, for the same reason.

The seam it attaches to already exists (`transformRequest`, Phase 6), the
baseline it will be judged against already exists (the token ledger), and the
A/B protocol for judging it already exists (`GATEWAY_MODE`, observe vs
transform).
