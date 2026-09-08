// RQ3's table. Its value is entirely in being honest about which cells are
// measured and which are only documented, so that is what is asserted: a cell
// that quietly loses its evidence, or a claim that hooks can rewrite tool
// output, would change the study's recommendation.
//
// This tests the rig, not the gateway. Deleting research/ deletes this too.

import assert from 'node:assert/strict';
import test from 'node:test';
import { MUTATION, renderMutation } from '../research/analyze/mutation.js';

test('every cell on both sides is filled from evidence', () => {
  for (const row of MUTATION) {
    for (const side of ['proxy', 'hook']) {
      const cell = row[side];
      assert.ok(cell, `${row.id} has no ${side} cell`);
      for (const field of ['canModify', 'reachesModel', 'userSees', 'onFailure', 'evidence']) {
        assert.ok(
          cell[field] !== undefined && cell[field] !== null && cell[field] !== '',
          `${row.id}.${side}.${field} is empty — the plan requires a cell to say it could not be tested rather than be blank`,
        );
      }
      assert.match(
        cell.evidence,
        /^(measured|documented|untestable)/,
        `${row.id}.${side}.evidence must say whether it was measured, documented, or untestable`,
      );
    }
  }
});

test('records that no hook can rewrite a tool result', () => {
  // The single most consequential cell: tool output is the primary trimming
  // target, and the hook side cannot address it after execution.
  const row = MUTATION.find((r) => r.id === 'tool-result');
  assert.equal(row.hook.canModify, false);
  assert.equal(row.proxy.canModify, true);
});

test('records that replayed history is outside every hook event', () => {
  // Where the token mass accumulates on a long thread.
  const row = MUTATION.find((r) => r.id === 'replayed-history');
  assert.equal(row.hook.canModify, false);
  assert.equal(row.proxy.canModify, true);
});

test('records the one thing the hook side does that the proxy cannot do as well', () => {
  // A hook rewrites tool input before execution, so the client runs the
  // modified call. A proxy-side rewrite of the same call reaches the model but
  // the client has already run the original.
  const row = MUTATION.find((r) => r.id === 'tool-call-input');
  assert.equal(row.hook.canModify, true);
  assert.match(row.hook.userSees, /REWRITTEN/);
  assert.match(row.proxy.userSees, /original/);
});

test('keeps the proxy failure semantics tied to invariant 3', () => {
  for (const row of MUTATION) {
    if (row.proxy.canModify !== true) continue;
    assert.match(
      row.proxy.onFailure,
      /original bytes forwarded/,
      `${row.id} must fall back to the original bytes on failure`,
    );
  }
});

test('the table is frozen so a later phase cannot quietly reword a finding', () => {
  assert.throws(() => MUTATION.push({ id: 'x' }), TypeError);
});

test('renders both tables and states the asymmetry', () => {
  const report = renderMutation();
  assert.match(report, /## Proxy/);
  assert.match(report, /## Hook/);
  assert.match(report, /asymmetry/);
  assert.match(report, /pending/);
});
