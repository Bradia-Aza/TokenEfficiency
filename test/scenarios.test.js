// The Phase 0.3 scenario set: it must stay honest about which scenarios can be
// driven from a script and which need a human, because the plan's exit
// criterion is "every scenario run at least once, and the ones that could not
// be driven listed with the reason".
//
// This tests the rig, not the gateway. Deleting research/ deletes this too.

import assert from 'node:assert/strict';
import test from 'node:test';
import { SCENARIOS, automatable, manual, renderRunbook } from '../research/scenarios/index.js';

test('covers the eight scenarios the plan names', () => {
  assert.equal(SCENARIOS.length, 8);
  const ids = SCENARIOS.map((s) => s.id);
  assert.deepEqual(new Set(ids).size, ids.length, 'ids are unique');
  for (const expected of [
    'large-file-read',
    'bash-large-output',
    'permission-denied',
    'history-compaction',
    'subagent-task',
    'interrupted-turn',
    'image-or-paste',
    'multi-turn-thread',
  ]) {
    assert.ok(ids.includes(expected), `missing scenario ${expected}`);
  }
});

test('every scenario says what it exposes, how to drive it, and what to expect', () => {
  for (const scenario of SCENARIOS) {
    assert.ok(scenario.title, `${scenario.id} has a title`);
    assert.ok(scenario.exposes, `${scenario.id} says what it exposes`);
    assert.ok(scenario.prompt, `${scenario.id} has a prompt`);
    assert.ok(scenario.expect, `${scenario.id} says what to expect`);
    assert.equal(typeof scenario.automatable, 'boolean');
  }
});

test('a scenario that cannot be scripted carries the reason it cannot', () => {
  // The plan is explicit that an honest manual result beats a synthetic
  // automated one — but only if the record says which it was and why.
  for (const scenario of manual()) {
    assert.ok(
      typeof scenario.manualReason === 'string' && scenario.manualReason.length > 0,
      `${scenario.id} is manual but gives no reason`,
    );
  }
  for (const scenario of automatable()) {
    assert.equal(scenario.manualReason, undefined, `${scenario.id} is scripted and needs no manual reason`);
  }
  assert.ok(manual().length > 0 && automatable().length > 0, 'the set has both kinds');
});

test('the runbook names every scenario and marks the manual ones', () => {
  const runbook = renderRunbook();
  for (const scenario of SCENARIOS) {
    assert.ok(runbook.includes(scenario.id), `runbook omits ${scenario.id}`);
    assert.ok(runbook.includes(scenario.prompt), `runbook omits the prompt for ${scenario.id}`);
  }
  for (const scenario of manual()) {
    assert.ok(runbook.includes(scenario.manualReason), `runbook omits why ${scenario.id} is manual`);
  }
});

test('the set is frozen, so a run cannot quietly redefine what it measured', () => {
  assert.throws(() => {
    SCENARIOS.push({ id: 'invented-after-the-fact' });
  }, TypeError);
});
