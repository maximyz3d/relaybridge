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

const phases = [
  ['planning', buildPlanningPrompt, 'PLAN_STATUS: BLOCKED', true],
  ['review', buildReviewPrompt, 'REVIEW_VERDICT: BLOCK', true],
  ['final review', (input) => buildReviewPrompt(input, { final: true }), 'REVIEW_VERDICT: BLOCK', true],
  ['revision', buildRevisionPrompt, 'REVISION_STATUS: BLOCKED', false],
];

for (const [name, build, blockingMarker, readOnly] of phases) {
  test(`${name} reserves a self-contained final-delivery contract even when body is clipped`, () => {
    const normal = build(brief);
    const heading = '# Required output contract';
    const contract = normal.slice(normal.lastIndexOf(heading));
    assert.match(contract, /entire requested artifact and its status marker together/);
    assert.match(contract, /one self-contained final response/);
    assert.match(contract, /earlier assistant messages are not the deliverable/);
    assert.match(contract, /Do not substitute a postscript/);
    assert.match(contract, /Do not invent evidence or approval/);
    assert.match(contract, /optional gaps without treating them as automatic blockers/);
    assert.ok(contract.includes(`then end with ${blockingMarker}.`));
    assert.equal(contract.includes('use Read/Glob/Grep only'), readOnly);
    assert.equal(contract.includes('Do not use Write, Edit, Bash, or ExitPlanMode'), readOnly);
    assert.equal(contract.includes('do not create a plan file'), readOnly);

    const huge = 'x'.repeat(200000);
    const overloaded = Object.fromEntries(Object.keys(brief).map((key) => [key, huge]));
    // Envelope metadata remains real and bounded; exhaust all artifact/list budgets.
    Object.assign(overloaded, {
      runId: brief.runId, cwd: brief.cwd, taskTier: brief.taskTier,
      constraints: Array(40).fill(huge), nonGoals: Array(40).fill(huge),
      fileScope: Array(80).fill(huge), acceptanceCriteria: Array(60).fill(huge),
    });
    const clipped = build(overloaded);
    assert.ok(clipped.length <= TOTAL_PROMPT_CHARS);
    assert.match(clipped, /RelayBridge omitted/);
    assert.equal(clipped.slice(clipped.lastIndexOf(heading)), contract);
    if (!readOnly) assert.match(clipped, /exclusive writer lease/);
  });
}

test('terminal postscripts cannot substitute for a final artifact marker', () => {
  const postscript = 'The plan above is the complete deliverable. Write and ExitPlanMode are disabled.';
  for (const parse of [parsePlanStatus, parseReviewVerdict, parseRevisionStatus]) {
    assert.equal(parse(postscript), 'UNKNOWN');
    assert.equal(parse(''), 'UNKNOWN');
  }
  // Do not concatenate an earlier assistant approval into the terminal result.
  const earlierAssistant = 'Inspected the code.\nREVIEW_VERDICT: APPROVE';
  assert.equal(parseReviewVerdict(earlierAssistant), 'APPROVE');
  assert.equal(parseReviewVerdict('See my earlier review.'), 'UNKNOWN');
});

test('explicit missing-evidence blocks preserve existing last-marker semantics', () => {
  assert.equal(parsePlanStatus('Required file is inaccessible.\nPLAN_STATUS: BLOCKED'), 'BLOCKED');
  assert.equal(parseReviewVerdict('Required evidence is missing.\nREVIEW_VERDICT: BLOCK'), 'BLOCK');
  assert.equal(parsePlanStatus('PLAN_STATUS: READY\nMissing required input.\nPLAN_STATUS: BLOCKED'), 'BLOCKED');
  assert.equal(parseReviewVerdict('REVIEW_VERDICT: APPROVE\nMissing evidence.\nREVIEW_VERDICT: BLOCK'), 'BLOCK');
  assert.equal(parseRevisionStatus('REVISION_STATUS: APPLIED\nBlocked.\nREVISION_STATUS: BLOCKED'), 'BLOCKED');
});
