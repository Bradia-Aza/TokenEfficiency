#!/usr/bin/env node
// Segment the two rolling captures into per-scenario slices and produce a
// correlation report for each (INTERCEPTION_RESEARCH_PLAN.md Phase 0.3 exit
// criterion: every scenario run at least once with both captures active, each
// producing a Phase 0.2 correlation report).
//
// Both captures are append-only across a whole measurement sitting, so a
// scenario is a TIME WINDOW over them. Marking the window explicitly beats
// trying to infer boundaries after the fact: session ids do not align across
// the two sides, which is the very problem Phase 0.2 exists to work around.
//
// Usage:
//   node research/scenarios/record-run.js start <scenario-id>
//   node research/scenarios/record-run.js stop  <scenario-id> [--manual] [--note "..."]
//   node research/scenarios/record-run.js report
//   node research/scenarios/record-run.js status

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { correlate, renderReport } from '../correlate.js';
import { SCENARIOS } from './index.js';

const CAPTURES = resolve(process.env.GATEWAY_CAPTURE_DIR || 'research/captures');
const RUNS = join(CAPTURES, 'runs.json');
const HOOKS = resolve(process.env.GATEWAY_HOOK_CAPTURE || join(CAPTURES, 'hooks.jsonl'));
const PROXY = resolve(process.env.GATEWAY_RAW_CAPTURE || join(CAPTURES, 'proxy.jsonl'));

const readRuns = () => (existsSync(RUNS) ? JSON.parse(readFileSync(RUNS, 'utf8')) : { runs: [] });

function writeRuns(state) {
  mkdirSync(dirname(RUNS), { recursive: true });
  writeFileSync(RUNS, `${JSON.stringify(state, null, 2)}\n`);
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

const knownScenario = (id) => SCENARIOS.find((s) => s.id === id) ?? null;

function start(id) {
  if (knownScenario(id) === null) {
    process.stderr.write(`unknown scenario ${JSON.stringify(id)}; known: ${SCENARIOS.map((s) => s.id).join(', ')}\n`);
    process.exit(1);
  }
  const state = readRuns();
  state.runs.push({ id, startedAt: new Date().toISOString(), finishedAt: null, manual: false, note: null });
  writeRuns(state);
  process.stderr.write(`[record-run] started ${id} — run the scenario now, then: record-run.js stop ${id}\n`);
}

function stop(id, { manual, note }) {
  const state = readRuns();
  // The most recent open run for this id.
  const run = [...state.runs].reverse().find((r) => r.id === id && r.finishedAt === null);
  if (run === undefined) {
    process.stderr.write(`[record-run] no open run for ${JSON.stringify(id)}\n`);
    process.exit(1);
  }
  run.finishedAt = new Date().toISOString();
  run.manual = manual;
  run.note = note;
  writeRuns(state);
  process.stderr.write(`[record-run] stopped ${id}\n`);
}

/** Rows whose timestamp falls inside a run's window. */
const within = (rows, run) => {
  const from = Date.parse(run.startedAt);
  const to = run.finishedAt === null ? Infinity : Date.parse(run.finishedAt);
  return rows.filter((row) => {
    const at = Date.parse(row.at);
    return Number.isFinite(at) && at >= from && at <= to;
  });
};

function report() {
  const state = readRuns();
  const hookRows = readJsonl(HOOKS);
  const proxyRows = readJsonl(PROXY);
  const lines = ['# Phase 0.3 — scenario runs', ''];

  const completed = state.runs.filter((run) => run.finishedAt !== null);
  const byId = new Map();
  for (const run of completed) byId.set(run.id, [...(byId.get(run.id) ?? []), run]);

  lines.push('| scenario | runs | driven | hook events | proxy requests | match rate |');
  lines.push('|---|---|---|---|---|---|');
  for (const scenario of SCENARIOS) {
    const runs = byId.get(scenario.id) ?? [];
    if (runs.length === 0) {
      lines.push(`| ${scenario.title} | 0 | ${scenario.automatable ? 'scripted' : 'manual'} | — | — | **not run** |`);
      continue;
    }
    const latest = runs[runs.length - 1];
    const result = correlate({ hookRows: within(hookRows, latest), proxyRows: within(proxyRows, latest) });
    const rate = result.totals.matchRate === null ? 'n/a' : `${(result.totals.matchRate * 100).toFixed(1)}%`;
    lines.push(
      `| ${scenario.title} | ${runs.length} | ${latest.manual ? 'manual' : 'scripted'} | ${result.totals.hookEvents} | ${result.totals.proxyRequests} | ${rate} |`,
    );
  }
  lines.push('');

  const notRun = SCENARIOS.filter((s) => !byId.has(s.id));
  if (notRun.length > 0) {
    lines.push('## Not yet run', '');
    for (const scenario of notRun) {
      const why = scenario.automatable ? '' : ` (manual: ${scenario.manualReason})`;
      lines.push(`- \`${scenario.id}\` — ${scenario.title}${why}`);
    }
    lines.push('');
  }

  // The per-scenario correlation reports the exit criterion asks for.
  for (const scenario of SCENARIOS) {
    const runs = byId.get(scenario.id) ?? [];
    if (runs.length === 0) continue;
    const latest = runs[runs.length - 1];
    lines.push(`---`, '', `## ${scenario.title} (\`${scenario.id}\`)`, '');
    lines.push(`Ran ${latest.startedAt} → ${latest.finishedAt}${latest.manual ? ', driven manually' : ''}.`);
    if (latest.note) lines.push('', `Note: ${latest.note}`);
    lines.push('');
    const result = correlate({ hookRows: within(hookRows, latest), proxyRows: within(proxyRows, latest) });
    lines.push(renderReport(result).replace(/^# Correlation report \(RQ1\)\n\n/, ''));
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

function status() {
  const state = readRuns();
  const open = state.runs.filter((r) => r.finishedAt === null);
  process.stdout.write(`runs recorded: ${state.runs.length}, open: ${open.length}\n`);
  for (const run of state.runs) {
    process.stdout.write(`  ${run.id}  ${run.startedAt} -> ${run.finishedAt ?? '(open)'}${run.manual ? ' [manual]' : ''}\n`);
  }
}

const [command, id, ...rest] = process.argv.slice(2);
const manual = rest.includes('--manual');
const noteIndex = rest.indexOf('--note');
const note = noteIndex === -1 ? null : (rest[noteIndex + 1] ?? null);

if (command === 'start') start(id);
else if (command === 'stop') stop(id, { manual, note });
else if (command === 'report') report();
else if (command === 'status') status();
else {
  process.stderr.write('usage: record-run.js start|stop|report|status [scenario-id] [--manual] [--note "..."]\n');
  process.exit(1);
}
