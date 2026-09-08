# INTERCEPTION_RESEARCH_PLAN.md

Phase 0 of the platform — deciding where the platform intercepts.

This is **research, not a build.** Its deliverable is a written finding backed
by reproducible measurements. Every line of code it produces is an instrument,
and instruments are thrown away when the measurement is done.

Read `CLAUDE.md` and `TRANSFORM_PLAN.md` first. This plan sits beside them
rather than on top of them: it does not extend the gateway, it *uses* the
gateway as one of two measurement subjects.

## The question

The platform sits between LLM providers and users and performs token efficiency
work — trimming bash output, shortening tool results, compacting history.
Before more of it is built, one architectural decision needs evidence:

> Should the platform intercept at the **proxy** level, the **hook** level, or
> both?

The proxy is built. Hooks are not. The purpose of this phase is to find out what
each interception point can observe, what it can *change*, and what each costs —
and to answer the question with data rather than intuition.

## What this is not

The obvious version of this study asks *what can each side see?* and produces a
list of fields. That study is easy to run, produces a real answer, and answers
the wrong question. **The platform mutates content in flight.** Visibility is a
prerequisite for mutation, not a measure of it, and a comparison scored by field
count says nothing about whether the fields in question are where the tokens
are.

This plan measures capability, cost, and reachable tokens. Visibility falls out
of it as a by-product.

## Research questions

Each phase below answers one. They are ordered so that a failure in an early one
changes what the later ones need to ask.

- **RQ1 — Correlation.** Can a hook event be reliably matched to the proxy
  request that carries it? *If no, a hybrid architecture is not buildable and
  the decision collapses to one side or the other.*
- **RQ2 — Reach.** What fraction of input tokens sits in content each side can
  address? *Ranks the two by savings opportunity rather than by field count.*
- **RQ3 — Mutation.** What can each side change, does the change reach the
  model, and what happens when it fails?
- **RQ4 — Cache.** Does trimming at one level invalidate the prompt-cache prefix
  in a way that costs more than the trim saves? *This is the question most
  likely to reverse the answer.*
- **RQ5 — Cost.** What wall-clock latency does each interception point add?
- **RQ6 — Coupling.** What does each bind the platform to? *Argued, not
  measured.*

## Invariants for the research rig

These are not the gateway's invariants. They govern the measurement code, and
they exist because the failure mode of a research phase is that its scaffolding
quietly becomes production.

1. **The rig lives outside the layered source tree.** Everything this plan
   builds goes in `research/`, which no gateway layer may import. `research/`
   may import from the gateway; the reverse is a defect. Deleting `research/`
   must leave `npm test` green.
2. **The rig does not modify the gateway's layers.** The one permitted change is
   *adding* a plugin under `plugins/`, since that is what the plugin seam is
   for. Any finding that seems to require editing `transport/`, `adapters/`,
   `canonical/`, or `pipeline/` is a finding to write down, not a change to
   make. Act on it in a later build plan.
3. **Captures are raw and lossless.** Both sides are recorded verbatim, as
   newline-delimited JSON. No normalization at capture time. The existing
   markdown sinks are for human reading and are lossy; they are not the research
   record.
4. **No shared schema.** The two sides are aligned, never merged. See "Why there
   is no unified parser" below.
5. **The measured session is a real one.** Scenarios are scripted, but they run
   against a real Claude Code session through the real gateway. A synthetic
   replay would measure the rig, not the subject.
6. **Nothing leaves the machine.** Captures contain full prompts, file contents,
   and source code. No third-party ingestion, no cloud observability service, no
   uploads. If a viewing tool is wanted later it is self-hosted, added after the
   analysis works, and fed from the capture rather than replacing it.

## Why there is no unified parser

The instinct is to normalize both sides into one schema and diff them. That
schema is the trap.

Any schema rich enough to hold both sides is a schema whose design decisions
determine the result. If a hook holds a tool input as structured data and the
proxy holds it serialized inside a message body, a well-built normalizer makes
those look identical — and *"the proxy sees this after serialization, the hook
sees it before"* is precisely the kind of asymmetry the study exists to find.
Normalizing is deleting the finding.

So: keep both raw, build a **correlator** rather than a parser, and emit a
coverage matrix rather than a diff. The correlator aligns; it does not merge.

## Layering

```
research/                    NEW. Imports from the gateway; nothing imports it.
research/hook-logger.js      the universal hook: every event, verbatim, to JSONL
research/correlate.js        content-hash alignment of the two captures
research/analyze/reach.js    RQ2 — token-weighted reachability
research/analyze/cache.js    RQ4 — cache-prefix impact
research/scenarios/          the adversarial scenario scripts
research/captures/           run output, gitignored
plugins/raw-capture.js       NEW. Raw JSONL beside the markdown sinks.
```

`plugins/raw-capture.js` is the only file added outside `research/`. It is an
ordinary read-only observer under invariant 1 of `CLAUDE.md`: frozen input, no
return value, its throws already isolated by the pipeline.

---

## Phase 0.1 — Capture both sides

No analysis. Get lossless, timestamped records out of each interception point.

**Proxy side.** `plugins/raw-capture.js` writes one JSONL line per exchange:
the full request and response bodies, the request and response headers, the
route, the resolved session id, and monotonic sequence and timestamp fields. Not
the rendered transcript — the markdown sinks drop exactly the detail this study
needs.

**Hook side.** One universal hook, registered on every available event, writing
one JSONL line per firing: the event name, the complete payload verbatim, the
client's session id, and the same monotonic sequence and timestamp fields.

Do **not** implement a bespoke handler per event type. The hook surface is
documented and fixed; enumerating it by hand answers a question already
answered, and the per-event detail is recoverable from the verbatim payload
whenever an analysis needs it.

Both writers must be non-blocking and must never fail the session — the hook
because a failing hook can interrupt the user's work, the plugin because
invariant 3 requires it.

*Exit:* one real Claude Code session, run through the gateway with hooks
installed, produces two JSONL files. Every hook event that fired is present in
one; every HTTP exchange is present in the other. Payloads are byte-faithful to
what each side received — spot-check three of each against the live values.
`npm test` is green and `research/` is not imported by any gateway layer.

---

## Phase 0.2 — The correlator (RQ1)

**This phase decides whether the rest of the plan can ask "both".** Run it
before the scenario work, because a negative result changes every later phase.

The two sides share no identifier. The proxy derives a session id by hashing
opening-message content plus an opaque user id; hooks carry the client's own
session id; the two name different things. Worse, one conversational turn is
frequently several HTTP requests — the assistant turn, the tool-result turn, and
background traffic for compaction and title generation — while hooks fire on
tool boundaries that do not align with request boundaries.

So correlate on **content**, not identity:

- Hash the tool output as the hook observes it.
- Search subsequent proxy request bodies for that content.
- Record whether it was found, in which request, after how many intervening
  requests, and whether it appears verbatim or altered in transit.

That join is real, and it doubles as a direct measurement of the thing the
platform cares about: whether a hook could have intercepted the exact bytes the
proxy was about to send.

Record the failures as carefully as the successes. Content that is truncated,
re-encoded, or wrapped before transmission is a finding about what a hook-level
transform can and cannot guarantee.

*Exit:* over one real session, a correlation report giving the match rate for
tool outputs, the distribution of hook-event-to-request lag, and an itemized
list of every unmatched event with a reason. **If the match rate is low, stop
and write that finding up before proceeding** — it means the hybrid is off the
table, and Phases 0.3 through 0.6 should then be scoped to comparing two
independent options rather than to designing an interface between them.

---

## Phase 0.3 — Adversarial scenarios

A normal coding session makes both sides look roughly equivalent, and measuring
one teaches nothing. The comparison earns its keep only where the two diverge,
so the scenario set is chosen to force divergence:

| Scenario | What it is expected to expose |
|---|---|
| Large file read | Hook holds the full output; the wire may carry something else |
| Bash with large output | The primary trimming target — where the tokens are |
| Tool call denied by permissions | Hook sees it; the wire never does |
| History compaction | Proxy sees the shrunk history; hooks see the compaction event |
| Subagent task | Proxy sees its requests; main-session hooks largely do not |
| Interrupted / aborted turn | Partial state on both sides, possibly inconsistent |
| Prompt with an image or pasted file | Non-text content through both paths |
| Multi-turn thread (8+ turns) | History growth; the substrate for the cache phase |

Each scenario is scripted so it is repeatable across reruns and across both
capture sides simultaneously. Scenarios that cannot be scripted deterministically
are run manually and marked as such in the record — an honest manual result
beats a synthetic automated one.

*Exit:* every scenario has been run at least once with both captures active, and
each produced a correlation report from Phase 0.2. Scenarios that could not be
driven reliably are listed with the reason.

---

## Phase 0.4 — Reach and mutation (RQ2, RQ3)

Two analyses over the Phase 0.3 captures.

**Reach (RQ2).** For each scenario, attribute every input token to the content
that carried it, and mark which side could address that content. Report the
fraction of total input tokens reachable by hooks, by the proxy, and by both.
The existing token ledger supplies the denominator — that the gateway was built
first is a genuine advantage here, and this is where it pays.

Expect the answer to be lopsided. Bash output, file reads, and search results
are likely the bulk of addressable waste; system prompt and tool definitions are
large but constant and cache-resident; conversation history is the cost that
compounds. A result showing the two sides reach similar *fields* but very
different *token mass* is the useful outcome, and it is the one a visibility
study cannot produce.

**Mutation (RQ3).** For each side, establish three things per scenario:

- Can it modify the content at all?
- Does the modification reach the model, and does the user see the modified or
  the original form? These can differ, and the difference is a product
  decision rather than a bug: a hook-level trim can leave the user's terminal
  showing full output while the model receives a summary. A proxy-level trim
  changes what the model sees with no user-visible trace.
- What happens when the modification fails? The gateway has a defined answer —
  invariant 3, fall back to the original bytes. The hook side's failure
  semantics must be established **by experiment**, not assumed.

Test mutation with a deliberate no-op rewrite and a deliberately throwing
rewrite. The no-op establishes that the path works; the throw establishes what
the user experiences when it doesn't.

*Exit:* a reachability table in tokens and percentages per scenario, and a
mutation table recording modify/reaches-model/user-visibility/failure-mode for
both sides. Every cell is filled from an observation, and cells that could not
be tested say so rather than being inferred.

---

## Phase 0.5 — The cache experiment (RQ4)

**The highest-value phase, and the one most likely to reverse the conclusion.**
It is separated from Phase 0.4 because it is the only experiment here that can
change the architecture rather than refine it.

Prompt caching keys on an exact prefix, and every turn resends the full history.
Trim a tool output at turn three and the prefix changes for every turn after it:

- A **hook-level** trim happens before the content enters the transcript, so
  history stays internally consistent and the cache prefix is stable.
- A **proxy-level** trim happens on the way out, so the same trim must be
  reproduced identically on every subsequent turn. If it is not, the cache is
  invalidated and full input price is paid on a long history — plausibly more
  than the trim ever saved.

Run the multi-turn scenario three ways: untrimmed, trimmed at the proxy, and
trimmed at the hook. Compare cache-read against cache-write tokens across turns,
and compute the net token cost of each. The canonical model already tracks cache
breakpoints and splits reads from writes, so this is directly measurable rather
than theoretical.

The substitution transform from `TRANSFORM_PLAN.md` is a serviceable stand-in
for a real trim here — it changes content deterministically without needing the
minification work to exist yet.

*Exit:* a per-turn table of cache-read, cache-write, and total input tokens for
all three runs, and a stated net cost for each. The finding is explicit about
whether proxy-level trimming requires deterministic replayed state to remain
cache-safe. **If it does, that is a first-order architectural constraint** and
belongs at the top of the final report.

---

## Phase 0.6 — Latency, coupling, and the report (RQ5, RQ6)

**Latency (RQ5).** Both interception points sit in the user's critical path. A
hook spawns a subprocess per event; the proxy adds a network hop and, in
transform mode, must buffer the whole request body before forwarding. Collect
timestamps at both boundaries across the existing scenario runs — this is cheap
and needs no new scenarios. Report added wall-clock per turn for each. If a
per-tool-call hook costs more time than its trim saves in tokens, that is a hard
design constraint, not a footnote.

**Coupling (RQ6).** No experiment; state it plainly:

- Hooks are specific to one client. They do not exist for other editors, for a
  raw SDK application, or for an agent someone writes themselves. Every
  additional client is another integration, and the platform's premise is that
  it sits between providers and users generally.
- The proxy is client-agnostic but provider-specific — already solved by the
  adapter layer, with `NEUTRALITY.md` as the evidence that it was solved
  properly.
- Hooks bind to an event schema owned by the client vendor, which the platform
  neither controls nor versions. The proxy binds to provider APIs, which are
  versioned and contractual.

This section needs no measurement, and it is frequently what settles the
decision once the measurements come back ambiguous. Write it down.

**The report.** `INTERCEPTION_FINDINGS.md`, structured as:

1. The recommendation, in the first paragraph.
2. The capability matrix, weighted by tokens rather than by field count.
3. The cache result and what it constrains.
4. The correlation result and whether a hybrid is buildable.
5. Latency and coupling.
6. What was not measured, and why.

The decision the report drives:

- If the cache result strongly favors hooks, the platform needs a hook-shaped
  fast path for whichever clients can provide one.
- If correlation is clean, the hybrid is real, and the interesting design
  question becomes the interface — what a hook hands the proxy so the proxy can
  do a better job than it could alone.
- If correlation fails, pick one side; the coupling argument probably picks the
  proxy.

*Exit:* `INTERCEPTION_FINDINGS.md` exists, every claim in it traces to a capture
in `research/captures/` or is explicitly marked as argued rather than measured,
and it ends with a recommendation specific enough to start the next build plan
from.

---

## Explicitly out of scope

Do not build these, even when a phase seems to want one:

- **Any change to the gateway's layers.** Rig invariant 2. Findings that imply a
  change are written down, not acted on.
- **Token minification.** This phase decides *where* it goes, not what it is.
- **A hook-level transform product.** Hook mutation is tested in Phase 0.4 as a
  measurement, with the smallest possible rewrite. It is not the beginning of a
  hook-based implementation.
- **Third-party observability ingestion.** Rig invariant 6. A self-hosted viewer
  is permissible after the analysis works, reading from the capture; it never
  becomes the capture.
- **A second provider adapter.** Unchanged from the skeleton's scope.
- **Generalizing the rig.** It measures one client and one provider. That is
  enough to make this decision, and a general instrument is a project of its
  own.

If a phase appears to require one of these to prove its point, the phase's exit
criterion is wrong — flag the criterion instead of building the feature.

---

## A note on the deliverable

The temptation in this phase is to build the rig to the standard of the gateway
— tested, layered, documented — and once that happens it stops being an
instrument and becomes a dependency nobody chose to take on.

The rig is allowed to be ugly. It is allowed to be thrown away. What must be
rigorous is the **finding**: reproducible from the captures, honest about what
was measured versus argued, and specific enough that the next plan can be
written from it.
