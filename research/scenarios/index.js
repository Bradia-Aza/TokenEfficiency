// The adversarial scenario set (INTERCEPTION_RESEARCH_PLAN.md Phase 0.3).
//
// A normal coding session makes both interception points look roughly
// equivalent, and measuring that teaches nothing. These eight are chosen
// because each forces the two sides apart in a specific way.
//
// This module is data plus a driver, not a test: the plan requires the measured
// session to be a REAL Claude Code session (rig invariant 5), and a synthetic
// replay would measure the rig rather than the subject. Scenarios marked
// `automatable: false` cannot be driven deterministically from a script and are
// run by hand from `prompt`, then marked as manual in the record — an honest
// manual result beats a synthetic automated one.

export const SCENARIOS = Object.freeze([
  {
    id: 'large-file-read',
    title: 'Large file read',
    exposes: 'Hook holds the full output; the wire may carry something else.',
    // A file big enough that any client-side truncation shows up as a `partial`
    // match in the correlator rather than being invisible.
    prompt: 'Read NEUTRALITY.md in full and tell me how many table rows it contains.',
    automatable: true,
    expect:
      'PostToolUse carries the whole file. If the wire carries less, the correlator reports `partial` and that gap is the finding.',
  },
  {
    id: 'bash-large-output',
    title: 'Bash with large output',
    exposes: 'The primary trimming target — where the tokens are.',
    prompt: 'Run `find . -type f -not -path "./.git/*" | head -200` and summarize what kinds of files are in this repo.',
    automatable: true,
    expect: 'A large tool_response that should appear on the wire nearly verbatim. This is the content minification exists to shrink.',
  },
  {
    id: 'permission-denied',
    title: 'Tool call denied by permissions',
    exposes: 'Hook sees it; the wire never does.',
    prompt: 'Run `rm -rf /tmp/some-nonexistent-scenario-dir` (deny it when prompted).',
    automatable: false,
    manualReason: 'Requires a human to decline the permission prompt interactively.',
    expect:
      'PermissionRequest/PermissionDenied fire with no corresponding wire content. The correlator should report these as unmatched, which is the correct answer, not a failure.',
  },
  {
    id: 'history-compaction',
    title: 'History compaction',
    exposes: 'Proxy sees the shrunk history; hooks see the compaction event.',
    prompt: 'Run /compact after a long conversation.',
    automatable: false,
    manualReason: 'Compaction triggers on context pressure or an explicit /compact; neither is scriptable from outside the client.',
    expect:
      'PreCompact/PostCompact on the hook side, and a request whose history is abruptly smaller on the proxy side. The proxy sees what the model saw; the hook sees only that it happened.',
  },
  {
    id: 'subagent-task',
    title: 'Subagent task',
    exposes: 'Proxy sees its requests; main-session hooks largely do not.',
    prompt: 'Use the Explore agent to find every file that mentions cacheReadTokens.',
    automatable: true,
    expect:
      'SubagentStart/SubagentStop on the hook side, plus a run of proxy requests belonging to the subagent. Whether the subagent\'s own tool calls fire main-session hooks is the measurement.',
  },
  {
    id: 'interrupted-turn',
    title: 'Interrupted / aborted turn',
    exposes: 'Partial state on both sides, possibly inconsistent.',
    prompt: 'Ask for something long, then press Ctrl-C partway through the response.',
    automatable: false,
    manualReason: 'Requires an interactive interrupt at a moment no script can reliably choose.',
    expect: 'A truncated proxy response and possibly no Stop hook. The two sides disagreeing here is the finding.',
  },
  {
    id: 'image-or-paste',
    title: 'Prompt with an image or pasted file',
    exposes: 'Non-text content through both paths.',
    prompt: 'Paste an image into the prompt and ask what it shows.',
    automatable: false,
    manualReason: 'Pasting image data into the client is an interactive gesture.',
    expect:
      'BLOCK.MEDIA on the proxy side. Whether the hook side sees the attachment at all — and in what encoding — is the measurement.',
  },
  {
    id: 'multi-turn-thread',
    title: 'Multi-turn thread (8+ turns)',
    exposes: 'History growth; the substrate for the cache phase.',
    prompt:
      'Eight or more back-to-back exchanges in one thread, each with at least one tool call. This run is reused as the substrate for Phase 0.5.',
    automatable: true,
    expect:
      'Input tokens climbing per turn while cacheReadTokens absorbs the replayed prefix. Phase 0.5 re-runs this one three ways.',
  },
]);

export const automatable = () => SCENARIOS.filter((s) => s.automatable);
export const manual = () => SCENARIOS.filter((s) => !s.automatable);

/** The runbook, so a run can be reproduced without re-reading this file. */
export function renderRunbook() {
  const lines = ['# Scenario runbook (Phase 0.3)', ''];
  lines.push('Each scenario runs against a real Claude Code session through the');
  lines.push('gateway, with both captures active. Start each in a FRESH session so');
  lines.push('the proxy-side session id (a hash of the opening message) separates');
  lines.push('them, and record the run with `record-run.js` when it finishes.', '');
  lines.push('```sh');
  lines.push('GATEWAY_PLUGINS=dump-session,meter-tokens,raw-capture npm start &');
  lines.push('ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude');
  lines.push('```', '');
  for (const scenario of SCENARIOS) {
    lines.push(`## ${scenario.title} (\`${scenario.id}\`)`, '');
    lines.push(`**Exposes:** ${scenario.exposes}`, '');
    lines.push(`**Drive it:** ${scenario.automatable ? 'scripted' : `manual — ${scenario.manualReason}`}`, '');
    lines.push('```');
    lines.push(scenario.prompt);
    lines.push('```', '');
    lines.push(`**Expect:** ${scenario.expect}`, '');
  }
  return `${lines.join('\n')}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(renderRunbook());
}
