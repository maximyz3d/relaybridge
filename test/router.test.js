'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let router;

test.before(async () => {
  router = await import('../mcp/router.mjs');
});

function readyDiagnostics() {
  return Object.fromEntries([
    'powershell', 'ollama_fast', 'ollama_llama', 'ollama', 'ollama_coder', 'claude', 'codex', 'copilot', 'gemini', 'grok', 'perplexity', 'groq_llama_fast',
  ].map((kind) => [kind, { found: true, ready: true, detail: 'test ready' }]));
}

test('utility lookup is local-first and a complex coding task fails up', () => {
  const utility = router.routeTask({
    task: 'Define the word deterministic in one sentence.',
    diagnostics: readyDiagnostics(),
  });
  assert.equal(utility.classification.tier, 'utility');
  assert.equal(utility.primaryTag, 'quick_lookup');
  assert.equal(utility.selected[0].kind, 'ollama_fast');

  const complex = router.routeTask({
    task: 'Design a multi-agent architecture, migration, threat model, test strategy, rollout gates, and failure recovery for this TypeScript repository.',
    diagnostics: readyDiagnostics(),
  });
  assert.equal(complex.classification.tier, 'complex');
  assert.equal(complex.primaryTag, 'coding');
  assert.notEqual(complex.selected[0].kind, 'ollama_coder');
  assert.ok(complex.selected[0].qualification);
});

test('hosted free/quota providers are opt-in and can be explicitly preferred', () => {
  const normal = router.routeTask({
    task: 'Answer a quick coding question.',
    diagnostics: readyDiagnostics(),
  });
  assert.ok(!normal.selected.some((candidate) => candidate.kind === 'groq_llama_fast'));
  assert.ok(normal.candidates.find((candidate) => candidate.kind === 'groq_llama_fast').policyReasons.some((reason) => /opt-in provider/.test(reason)));

  const preferred = router.routeTask({
    task: 'Answer a quick coding question.',
    diagnostics: readyDiagnostics(),
    preferredProviders: ['groq_llama_fast'],
  });
  assert.equal(preferred.selected[0].kind, 'groq_llama_fast');
});

test('fresh research uses a source-capable route and local-only stays local', () => {
  const research = router.routeTask({
    task: 'Research the latest official sources and cite current evidence for this project.',
    diagnostics: readyDiagnostics(),
  });
  assert.equal(research.primaryTag, 'research');
  assert.equal(research.selected[0].kind, 'perplexity');

  const local = router.routeTask({
    task: 'Review this JavaScript function for a simple bug.',
    diagnostics: readyDiagnostics(),
    localOnly: true,
  });
  assert.ok(local.selected.length > 0);
  assert.ok(local.selected.every((candidate) => candidate.privacyBoundary.startsWith('local')));
});

test('high-stakes tags are explicit and require the advisory human gate', () => {
  const route = router.routeTask({
    task: 'Read this API key and make an investment decision for a patient prescription.',
    diagnostics: readyDiagnostics(),
  });
  assert.equal(route.classification.tier, 'critical');
  for (const tag of ['medical', 'financial', 'secrets']) {
    assert.ok(route.classification.tags.includes(tag), `missing ${tag}`);
    assert.ok(route.humanGateReasons.includes(tag), `missing human gate for ${tag}`);
  }
  assert.equal(route.humanGateRequired, true);
});

test('general prompts expose low classifier confidence instead of pretending precision', () => {
  const classification = router.classifyTask('Think about this carefully.');
  assert.deepEqual(classification.tags, ['general']);
  assert.equal(classification.routingConfidence.level, 'low');
  assert.match(classification.routingConfidence.basis, /No task-family signal/);
});

test('reasoning and mutation signals avoid the known under- and over-routing cases', () => {
  const unsolved = router.classifyTask('Prove whether P equals NP.');
  assert.equal(unsolved.tier, 'complex');
  assert.ok(unsolved.tags.includes('reasoning'));

  const keyRotation = router.classifyTask('Rotate the production signing keys and deploy the change.');
  assert.equal(keyRotation.tier, 'critical');
  assert.ok(keyRotation.tags.includes('destructive'));
  assert.ok(keyRotation.tags.includes('secrets'));

  const cssCleanup = router.classifyTask('Delete the unused CSS class.');
  assert.notEqual(cssCleanup.tier, 'critical');
  assert.ok(!cssCleanup.tags.includes('destructive'));
});

test('specialized capability routes fail closed when no capable provider is ready', () => {
  const diagnostics = readyDiagnostics();
  diagnostics.gemini = { found: true, ready: false, detail: 'unavailable' };
  const vision = router.routeTask({
    task: 'Inspect this screenshot and perform OCR on the image.',
    diagnostics,
  });
  assert.equal(vision.primaryTag, 'vision');
  assert.equal(vision.noEligibleRoute, true);
  assert.deepEqual(vision.selected, []);
});

test('low-confidence standard work applies the configured fail-up margin', () => {
  const task = ('Contemplate an ambiguous situation with bounded uncertainty. ').repeat(25);
  const route = router.routeTask({ task, diagnostics: readyDiagnostics() });
  assert.equal(route.classification.routingConfidence.level, 'low');
  assert.equal(route.classification.tier, 'standard');
  assert.notEqual(route.selected[0].kind, 'ollama');
  assert.ok(route.candidates.find((candidate) => candidate.kind === 'ollama').policyReasons.some((reason) => /fail-up/.test(reason)));
});
