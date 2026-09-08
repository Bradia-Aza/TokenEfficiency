#!/usr/bin/env node
// RQ3 — what can each side change, does the change reach the model, and what
// happens when it fails? (INTERCEPTION_RESEARCH_PLAN.md Phase 0.4.)
//
// The table below is the shape of the answer. Cells marked `measured` are
// filled from an observation in research/captures/; cells marked `documented`
// come from the hook contract and are pending an experiment; cells marked
// `untestable` say so rather than being inferred. The plan is explicit that a
// cell that could not be tested must say so instead of being guessed.
//
// The proxy side's answers are not guesses — they are the gateway's own
// invariants, demonstrated by its test suite:
//
//   - It can modify a modeled request (GATEWAY_MODE=transform, Phase 6).
//   - The modification reaches the model: that is the transform-live test.
//   - The user sees NO trace, because the response path is untouched.
//   - On failure, invariant 3: the throw is caught, logged to stderr, and the
//     ORIGINAL captured bytes are forwarded. A broken transform degrades the
//     gateway to observe mode for that request; it never fails the request.
//
// The hook side's failure semantics must be established by experiment, which is
// what research/scenarios/mutate-hook.js does.

export const MUTATION = Object.freeze([
  {
    id: 'request-text',
    what: 'Text the user typed',
    proxy: {
      canModify: true,
      reachesModel: true,
      userSees: 'the original — the client renders what it sent, and the response path is untouched',
      onFailure: 'original bytes forwarded (invariant 3); logged to stderr',
      evidence: 'measured — test/transform-live.test.js and the Phase 6 substitution demo',
    },
    hook: {
      canModify: 'block-or-augment',
      reachesModel: true,
      userSees: 'their own text; additionalContext is injected invisibly',
      onFailure: 'exit 2 blocks the prompt; other non-zero exits are non-blocking and the prompt proceeds',
      evidence: 'documented — UserPromptSubmit supports decision:block and additionalContext, not a rewrite of the prompt itself',
    },
  },
  {
    id: 'tool-call-input',
    what: 'Arguments of a tool call, before it runs',
    proxy: {
      canModify: true,
      reachesModel: true,
      userSees: 'the original call in their terminal',
      onFailure: 'original bytes forwarded; logged to stderr',
      evidence: 'measured — the transform seam operates on the canonical request, which carries BLOCK.TOOL_CALL',
    },
    hook: {
      canModify: true,
      reachesModel: true,
      userSees: 'the REWRITTEN call — the client executes what the hook returned',
      onFailure: 'exit 2 denies the call; a non-blocking error lets the original run',
      evidence: 'documented — PreToolUse.updatedInput is the only hook mutation of tool arguments',
    },
  },
  {
    id: 'tool-result',
    what: 'Output of a tool, after it ran',
    proxy: {
      canModify: true,
      reachesModel: true,
      userSees: 'the full original output in their terminal',
      onFailure: 'original bytes forwarded; logged to stderr',
      evidence: 'measured — tool results are BLOCK.TOOL_RESULT in the canonical request the transform seam receives',
    },
    hook: {
      // This is the single most consequential cell in the study.
      canModify: false,
      reachesModel: 'n/a',
      userSees: 'n/a',
      onFailure: 'n/a',
      evidence:
        'documented — no hook event rewrites a tool result. PostToolUse fires after execution and can only block the turn. A hook can suppress the call beforehand (PreToolUse) but cannot trim what came back.',
    },
  },
  {
    id: 'replayed-history',
    what: 'Tool results and messages from earlier turns, resent every turn',
    proxy: {
      canModify: true,
      reachesModel: true,
      userSees: 'the original history in their scrollback',
      onFailure: 'original bytes forwarded; logged to stderr',
      evidence: 'measured — every request carries the full history, and the transform sees all of it',
    },
    hook: {
      canModify: false,
      reachesModel: 'n/a',
      userSees: 'n/a',
      onFailure: 'n/a',
      evidence:
        'documented — hooks fire on live events. A past turn is not an event, so replayed history is outside every hook event\'s reach. This is where token mass accumulates (see RQ2).',
    },
  },
  {
    id: 'system-and-tools',
    what: 'System prompt and tool definitions',
    proxy: {
      canModify: true,
      reachesModel: true,
      userSees: 'nothing — neither is displayed',
      onFailure: 'original bytes forwarded; logged to stderr',
      evidence: 'measured — both are modeled fields of the canonical request',
    },
    hook: {
      canModify: false,
      reachesModel: 'n/a',
      userSees: 'n/a',
      onFailure: 'n/a',
      evidence: 'documented — no hook event carries the system prompt or the tool schema',
    },
  },
  {
    id: 'thinking',
    what: 'Assistant reasoning blocks',
    proxy: {
      canModify: 'unsafe',
      reachesModel: false,
      userSees: 'n/a',
      onFailure: 'upstream rejects the turn — the block carries a provider signature over its content',
      evidence:
        'measured — TRANSFORM_PLAN.md skips BLOCK.THINKING for exactly this reason; it is the sharpest edge in the transform work',
    },
    hook: {
      canModify: false,
      reachesModel: 'n/a',
      userSees: 'n/a',
      onFailure: 'n/a',
      evidence: 'documented — not carried by any hook event',
    },
  },
  {
    id: 'model-response',
    what: 'The model\'s reply, on the way back to the user',
    proxy: {
      canModify: 'not built',
      reachesModel: 'n/a',
      userSees: 'the original',
      onFailure: 'n/a',
      evidence:
        'untestable — there is no response transform to test. The response path is deliberately untouched (TRANSFORM_PLAN.md) and invariant 4 holds for it; a response-side rewrite is out of scope, not merely unbuilt.',
    },
    hook: {
      canModify: false,
      reachesModel: 'n/a',
      userSees: 'the original',
      onFailure: 'n/a',
      evidence: 'documented — no hook event rewrites assistant output',
    },
  },
]);

export function renderMutation(rows = MUTATION) {
  const lines = ['# Mutation (RQ3)', ''];
  lines.push('Can each side change the content, does the change reach the model, what');
  lines.push('does the user see, and what happens when it fails.', '');

  for (const side of ['proxy', 'hook']) {
    lines.push(`## ${side === 'proxy' ? 'Proxy' : 'Hook'}`, '');
    lines.push('| content | can modify | reaches model | user sees | on failure |');
    lines.push('|---|---|---|---|---|');
    for (const row of rows) {
      const cell = row[side];
      lines.push(
        `| ${row.what} | ${fmt(cell.canModify)} | ${fmt(cell.reachesModel)} | ${cell.userSees} | ${cell.onFailure} |`,
      );
    }
    lines.push('');
    lines.push('Evidence:', '');
    for (const row of rows) lines.push(`- **${row.what}** — ${row[side].evidence}`);
    lines.push('');
  }

  lines.push('## The asymmetry this table exists to show', '');
  lines.push('The proxy can address every row. The hook side can address tool call');
  lines.push('*inputs* and can block or augment a prompt — but it cannot rewrite a');
  lines.push('tool *result*, and it cannot touch replayed history at all. Those two');
  lines.push('are where the token mass is (RQ2), so the hook side\'s mutation reach');
  lines.push('and its token reach fail in the same place.', '');
  lines.push('Cells marked `documented` come from the hook contract and are pending');
  lines.push('the Phase 0.4 experiment; `measured` cells trace to a capture or a');
  lines.push('gateway test.');
  return `${lines.join('\n')}\n`;
}

const fmt = (v) => (v === true ? 'yes' : v === false ? 'no' : String(v));

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(renderMutation());
}
