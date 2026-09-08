# research/

The measurement rig for `INTERCEPTION_RESEARCH_PLAN.md` — Phase 0, deciding
where the platform intercepts.

**This is an instrument, not a product.** It imports from the gateway; no
gateway layer may import from it. Deleting this directory (and
`plugins/raw-capture.js`) must leave `npm test` green. The rig is allowed to be
ugly and is expected to be thrown away; what has to be rigorous is the finding.

## Running a measured session

Two captures, taken simultaneously from one real Claude Code session.

**1. Install the hooks.** The registration in `hooks.settings.json` puts
`hook-logger.js` on all 33 events. Merge it into `.claude/settings.json` (it is
a `"hooks"` key; if you already have one, merge rather than overwrite):

```sh
# inspect first, then merge by hand or with jq
cat research/hooks.settings.json
```

**2. Start the gateway with the raw capture plugin enabled.** It is off by
default — it writes full prompt text and file contents to disk, so it is opt-in:

```sh
GATEWAY_PLUGINS=dump-session,meter-tokens,raw-capture npm start &
```

**3. Run the session through the gateway.**

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

Output lands in `research/captures/` (gitignored):

- `proxy.jsonl` — one line per HTTP exchange, bodies verbatim
- `hooks.jsonl` — one line per hook firing, payload verbatim

Override either path with `GATEWAY_RAW_CAPTURE` / `GATEWAY_HOOK_CAPTURE`.

## Rig invariants

From the plan, restated because they are what keeps scaffolding from becoming
production:

1. Everything lives in `research/`. The one permitted file outside it is
   `plugins/raw-capture.js`, because adding a plugin is what the plugin seam is
   for.
2. The rig does not modify the gateway's layers. A finding that seems to require
   editing `transport/`, `adapters/`, `canonical/` or `pipeline/` is written
   down, not acted on.
3. Captures are raw and lossless. No normalization at capture time. The markdown
   sinks are lossy and are not the research record.
4. No shared schema. The two sides are aligned by the correlator, never merged —
   normalizing away the asymmetries would delete the finding.
5. The measured session is a real one.
6. Nothing leaves the machine. Captures hold full prompts, file contents and
   source code; `research/captures/` is gitignored and must stay that way.

## Layout

```
hook-logger.js        the universal hook: every event, verbatim, to JSONL
hooks.settings.json   registration for all 33 events
correlate.js          RQ1 — content-hash alignment of the two captures
analyze/reach.js      RQ2 — token-weighted reachability
analyze/cache.js      RQ4 — cache-prefix impact
scenarios/            the adversarial scenario scripts
captures/             run output, gitignored
```
