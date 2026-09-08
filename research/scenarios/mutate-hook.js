#!/usr/bin/env node
// The RQ3 hook-mutation experiment (INTERCEPTION_RESEARCH_PLAN.md Phase 0.4).
//
// The plan requires two deliberate rewrites, because they answer different
// questions:
//
//   MODE=noop   a rewrite that changes nothing but takes the mutation path.
//               Establishes that the path works at all, and that a hook's
//               updatedInput is honored.
//   MODE=mark   a rewrite that visibly changes the tool input, so the capture
//               shows whether the CHANGE reaches the model and whether the user
//               sees the original or the modified form. Those can differ, and
//               the difference is a product decision, not a bug.
//   MODE=throw  a hook that fails. The gateway's failure semantics are defined
//               (invariant 3: fall back to original bytes). The hook side's are
//               established HERE, by experiment, rather than assumed.
//
// This is a measurement, not the beginning of a hook-based implementation —
// which the plan puts explicitly out of scope. It is the smallest rewrite that
// answers the question.
//
// Register it on PreToolUse only (the one event that can mutate tool input):
//
//   "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command",
//      "command": "MUTATE_MODE=mark node $CLAUDE_PROJECT_DIR/research/scenarios/mutate-hook.js" }]}]
//
// Every run appends to the capture, so the experiment's own behavior is part of
// the record rather than something to reconstruct from memory afterwards.

import { appendFileSync, mkdirSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const MODE = process.env.MUTATE_MODE || 'noop';
const file = resolve(process.env.GATEWAY_MUTATE_CAPTURE || 'research/captures/mutation.jsonl');

function readStdin() {
  const chunks = [];
  const buffer = Buffer.alloc(65536);
  for (;;) {
    let read;
    try {
      read = readSync(0, buffer, 0, buffer.length, null);
    } catch (err) {
      if (err.code === 'EAGAIN') continue;
      break;
    }
    if (read === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function record(entry) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), mode: MODE, ...entry })}\n`);
  } catch {
    // The experiment must not become the thing that breaks the session.
  }
}

const raw = readStdin();
let payload = null;
try {
  payload = JSON.parse(raw);
} catch {
  payload = null;
}

const toolInput = payload?.tool_input ?? null;

if (MODE === 'throw') {
  // Exit 2 is the blocking path: per the contract, the tool call is denied and
  // stderr becomes feedback to the model. What the USER sees when this happens
  // is the observation this run exists to make.
  record({ toolName: payload?.tool_name ?? null, toolInput, action: 'exit-2-blocking-error' });
  process.stderr.write('[mutate-hook] deliberate failure, to establish hook failure semantics\n');
  process.exit(2);
}

let updatedInput = null;
if (MODE === 'mark' && toolInput !== null && typeof toolInput.command === 'string') {
  // A visible, harmless change: the command still runs and still produces
  // output, but the rewrite is unmistakable in both the capture and the wire.
  updatedInput = { ...toolInput, command: `${toolInput.command} # mutated-by-hook` };
} else if (MODE === 'noop' && toolInput !== null) {
  // Takes the mutation path and changes nothing. If the call still runs
  // normally, the path itself is sound.
  updatedInput = { ...toolInput };
}

record({
  toolName: payload?.tool_name ?? null,
  toolInput,
  updatedInput,
  action: updatedInput === null ? 'no-rewrite' : 'updatedInput',
});

if (updatedInput !== null) {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: `interception study: ${MODE} rewrite`,
        updatedInput,
      },
    })}\n`,
  );
}
process.exit(0);
