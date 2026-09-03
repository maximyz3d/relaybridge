'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TOTAL_PROMPT_CHARS,
  buildPlanningPrompt,
  buildReviewPrompt,
  buildRevisionPrompt,
  parsePlanStatus,
  parseReviewVerdict,
  parseRevisionStatus,
} = require('../lib/workflow-prompts');

const brief = {
  runId: 'wf_example',
  cwd: '/workspace/project',
  taskTier: 'complex',
  objective: 'Implement the requested feature.',
  constraints: ['Preserve the public API.'],
  nonGoals: ['No dependency upgrade.'],
  fileScope: ['lib/adapter.js'],
  baseRevision: 'abc123',
  acceptanceCriteria: ['The regression test passes.'],
  research: 'Codex found the relevant adapter.',
  plan: '1. Add the adapter.\n2. Test it.',
  implementation: 'Changed adapter.js; npm test passed.',
  review: 'One missing boundary test.\nREVIEW_VERDICT: REVISE',
  revision: 'Added the test.\nREVISION_STATUS: APPLIED',
  finalReview: 'The final review found a stale-cache race.\nREVIEW_VERDICT: REVISE',
};

test('phase prompts keep roles and handoff contracts explicit', () => {
  const planning = buildPlanningPrompt(brief);
  assert.match(planning, /Claude planning specialist/);
  assert.match(planning, /do not edit files/i);
  assert.match(planning, /## File scope\n\n- lib\/adapter\.js/);
  assert.match(planning, /PLAN_STATUS: READY/);

  const review = buildReviewPrompt(brief);
  assert.match(review, /fresh Claude code reviewer/);
  assert.match(review, /REVIEW_VERDICT: APPROVE/);
  const repeatedFinalReview = buildReviewPrompt(brief, { final: true });
  assert.match(repeatedFinalReview,
    /## Prior final-review findings to re-check[\s\S]*stale-cache race/);

  const revision = buildRevisionPrompt(brief);
  assert.match(revision, /exclusive writer lease/);
  assert.match(revision, /## Initial review context[\s\S]*missing boundary test/);
  assert.match(revision, /## Latest final-review findings requiring revision[\s\S]*stale-cache race/);
  assert.match(revision, /REVISION_STATUS: APPLIED/);
});

test('phase prompts cap oversized handoffs deterministically', () => {
  const prompt = buildReviewPrompt({ ...brief, plan: 'p'.repeat(200000), implementation: 'i'.repeat(200000) });
  assert.ok(prompt.length <= TOTAL_PROMPT_CHARS);
  assert.match(prompt, /RelayBridge omitted/);
  assert.match(prompt, /# Required output contract/);
  assert.match(prompt, /REVIEW_VERDICT: APPROVE/);
});

test('marker parsers use the last valid standalone marker and fail closed', () => {
  assert.equal(parsePlanStatus('PLAN_STATUS: BLOCKED\nnotes\nPLAN_STATUS: READY'), 'READY');
  assert.equal(parseReviewVerdict('text REVIEW_VERDICT: APPROVE'), 'UNKNOWN');
  assert.equal(parseReviewVerdict('findings\nREVIEW_VERDICT: REVISE'), 'REVISE');
  assert.equal(parseRevisionStatus('done\nREVISION_STATUS: APPLIED\n'), 'APPLIED');
  assert.equal(parseRevisionStatus('done'), 'UNKNOWN');
});
