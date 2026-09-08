// The Phase 0.6 exit criterion, as assertions: INTERCEPTION_FINDINGS.md exists,
// every claim traces to a capture or is explicitly marked as argued rather than
// measured, and it ends with a recommendation specific enough to start the next
// build plan from.
//
// This guards against the failure mode of a research deliverable: a confident
// report whose confidence is not sourced. A section that quietly loses its
// evidence label fails the build.
//
// This tests the rig, not the gateway. Deleting research/ deletes this too.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const REPORT = readFileSync('INTERCEPTION_FINDINGS.md', 'utf8');

test('has the six sections the plan specifies, in order', () => {
  const headings = [
    '## 1. Recommendation',
    '## 2. Capability, weighted by tokens',
    '## 3. Cache, and what it constrains',
    '## 4. Correlation, and whether a hybrid is buildable',
    '## 5. Latency and coupling',
    '## 6. What was not measured, and why',
  ];
  let cursor = -1;
  for (const heading of headings) {
    const index = REPORT.indexOf(heading);
    assert.notEqual(index, -1, `missing section: ${heading}`);
    assert.ok(index > cursor, `${heading} is out of order`);
    cursor = index;
  }
});

test('leads with the recommendation, not with the method', () => {
  // The plan is explicit: the recommendation goes in the first paragraph.
  const recommendation = REPORT.indexOf('## 1. Recommendation');
  const body = REPORT.slice(recommendation, REPORT.indexOf('## 2.'));
  assert.match(body, /\*\*Intercept at the proxy/);
});

test('labels every finding section as measured, argued, or pending', () => {
  // The exit criterion: every claim traces to a capture, or says it does not.
  for (const section of ['## 2.', '## 3.', '## 4.']) {
    const start = REPORT.indexOf(section);
    const end = REPORT.indexOf('## ', start + 3);
    const body = REPORT.slice(start, end === -1 ? undefined : end);
    assert.match(
      body,
      /\*\*Status: (measured|argued|instrument measured)/,
      `${section} has no status label`,
    );
  }
});

test('states the cache constraint regardless of the pending result', () => {
  // The plan: if proxy-level trimming requires deterministic replayed state to
  // be cache-safe, that is a first-order architectural constraint and belongs
  // at the top of the report.
  const cache = REPORT.slice(REPORT.indexOf('## 3.'), REPORT.indexOf('## 4.'));
  assert.match(cache, /first-order architectural constraint/);
  assert.match(cache, /[Dd]eterministic/);
});

test('says what was not measured', () => {
  const gaps = REPORT.slice(REPORT.indexOf('## 6.'));
  // The largest gap must be named, not buried.
  assert.match(gaps, /real/i);
  assert.match(gaps, /Only one client and one provider/);
  assert.match(gaps, /gap in data, not in method/);
});

test('ends with a recommendation specific enough to start the next plan from', () => {
  const drives = REPORT.slice(REPORT.indexOf('## What this drives'));
  assert.ok(drives.length > 0, 'the report says what it drives');
  // Named seam, named blocks, named properties — a plan can be written from it.
  assert.match(drives, /BLOCK\.TOOL_RESULT/);
  assert.match(drives, /transformRequest/);
  assert.match(drives, /[Dd]eterministic/);
});

test('does not claim a measured result the rig has not produced', () => {
  // The honesty guard. Real-session numbers are pending; a percentage presented
  // as a measured token share would be a fabricated finding.
  const forbidden = [
    /\b\d{1,3}(\.\d+)?% of (input )?tokens (are|were) reachable/i,
    /the match rate (was|is) \d/i,
    /measured match rate/i,
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(REPORT, pattern, `report states a result the rig has not measured: ${pattern}`);
  }
});
