#!/usr/bin/env node
// The universal hook: every event, verbatim, one JSONL line per firing.
//
// Registered on every available hook event (see research/hooks.settings.json).
// It is deliberately NOT a handler per event type: the hook surface is
// documented and fixed, and the per-event detail is recoverable from the
// verbatim payload whenever an analysis needs it (INTERCEPTION_RESEARCH_PLAN.md
// Phase 0.1). Enumerating the surface by hand would answer a question the docs
// already answer, and would silently drop fields added after this was written.
//
// Two rules govern this file:
//
//   - It must never fail the session. A hook that exits non-zero can interrupt
//     the user's work, and exit 2 actively blocks the tool call. So every path
//     here — unreadable stdin, unwritable capture file, malformed payload —
//     ends in exit 0 with an empty stdout, which is the "no opinion" answer for
//     every event.
//   - It records; it does not decide. Mutation is tested separately in Phase
//     0.4 by research/scenarios/mutate-hook.js, so that the capture used for
//     every other phase is of an observer that changed nothing.
//
// stdout must stay empty: on several events a non-empty stdout is parsed as a
// decision. Diagnostics go to stderr, which is logged and never interpreted.

import { appendFileSync, mkdirSync, readSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DEFAULT_PATH = 'research/captures/hooks.jsonl';
const file = resolve(process.env.GATEWAY_HOOK_CAPTURE || DEFAULT_PATH);

// A monotonic per-process sequence is useless here — the client spawns a fresh
// process per firing — so ordering comes from the timestamp plus the append
// order in the file itself, and `pid` disambiguates concurrent firings.
function readStdin() {
  const chunks = [];
  const fd = 0;
  const buffer = Buffer.alloc(65536);
  // Synchronous, because the process may exit before an async read resolves.
  for (;;) {
    let read;
    try {
      read = readSync(fd, buffer, 0, buffer.length, null);
    } catch (err) {
      // EAGAIN on a non-blocking pipe: retry. EOF or a closed stdin: done.
      if (err.code === 'EAGAIN') continue;
      break;
    }
    if (read === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function main() {
  const receivedAt = new Date().toISOString();
  let raw = '';
  try {
    raw = readStdin();
  } catch (err) {
    process.stderr.write(`[hook-logger] could not read stdin: ${err.message}\n`);
  }

  let payload = null;
  let parseError = null;
  try {
    payload = raw === '' ? null : JSON.parse(raw);
  } catch (err) {
    parseError = err.message;
  }

  const record = {
    side: 'hook',
    at: receivedAt,
    pid: process.pid,
    // The event name as the client reported it. Taken from the payload rather
    // than from argv so the record reflects what actually fired, but argv
    // carries it too as a cross-check that the registration is complete.
    event: payload?.hook_event_name ?? process.argv[2] ?? null,
    argvEvent: process.argv[2] ?? null,
    sessionId: payload?.session_id ?? null,
    promptId: payload?.prompt_id ?? null,
    cwd: payload?.cwd ?? null,
    transcriptPath: payload?.transcript_path ?? null,
    // Verbatim, under rig invariant 3: no normalization at capture time. If the
    // payload could not be parsed the raw text is kept instead, because an
    // unparseable payload is itself a finding.
    payload,
    rawPayload: parseError === null ? null : raw,
    parseError,
  };

  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch (err) {
    process.stderr.write(`[hook-logger] could not write ${file}: ${err.message}\n`);
  }
}

try {
  main();
} catch (err) {
  // Belt and braces: nothing above may take the session down with it.
  try {
    process.stderr.write(`[hook-logger] failed: ${err?.stack || err}\n`);
  } catch {}
}
// Always. Silence on stdout is "no opinion" on every event; a non-zero exit is
// an opinion this instrument must never have.
process.exit(0);
