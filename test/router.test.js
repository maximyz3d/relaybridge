'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let router;

test.before(async () => {
  router = await import('../mcp/router.mjs');
});

test('local code evidence remains code review while explicit outside-source work retains retrieval gates', () => {
  for (const task of [
    'Audit current server.js source and cite file/line evidence.',
    'Review the code against the research handoff and verification evidence.',
    'Review the git diff in this worktree; record current source lines and test evidence.',
  ]) {
    const result = router.routeTask({ task, diagnostics: readyDiagnostics(), preferredProviders: ['codex'] });
    assert.equal(result.primaryTag, 'code_review', task);
    assert.equal(result.candidates.find((r) => r.kind === 'codex').eligible, true, task);
    assert.equal(result.classification.tags.includes('research'), false, task);
  }
  for (const task of [
    'Review server.js against the latest official docs; browse the web and cite sources.',
    'Audit app.js and research the current official documentation.',
    'Review code and find external sources for protocol compatibility.',
    'Review server.js; retrieve https://nodejs.org/api/http.html and cite sources.',
    'Review app.js and fetch https://example.com/protocol.',
    'Review server.js and retrieve these sources:\nhttps://nodejs.org/api/http.html',
    'Review server.js and retrieve these sources:\n\n- https://nodejs.org/api/http.html',
    'Review app.js; fetch the following reference:\r\n1. [Protocol](https://example.com/protocol)',
  ]) {
    const result = router.routeTask({ task, diagnostics: readyDiagnostics(), preferredProviders: ['codex'] });
    assert.equal(result.primaryTag, 'research', task);
    assert.equal(result.candidates.find((r) => r.kind === 'codex').eligible, false, task);
  }
});

test('substantive short planning, collaboration and decisions do not fall to the utility tier', () => {
  for (const task of [
    'Plan a robust caching implementation with eviction correctness and testable acceptance criteria.',
    'Coordinate two teams to resolve conflicting recommendations with assigned owners and acceptance criteria.',
    'Reconcile conflicting proposals, identify assumptions, and assign accountable owners.',
    'Compare feasible options against constraints and explain the tradeoffs before recommending a decision.',
    'Diagnose an intermittent cache eviction bug and propose a correction with acceptance checks.',
    'Design a cache algorithm with eviction invariants and testable acceptance criteria.',
    'Plan a caching implementation meeting acceptance criteria.',
    'Plan a calendar implementation with conflict resolution and acceptance criteria.',
    'Compare the terms of these proposals against budget constraints.',
    'Can you please plan an implementation with acceptance criteria?',
    'Could you help me plan an implementation with dependencies?',
    'Coordinate a meeting to resolve conflicting proposals with assigned owners.',
  ]) {
    const c = router.classifyTask(task); assert.equal(c.tier,'standard',task);
    assert.ok(c.tags.includes('reasoning'),task); assert.notEqual(c.routingConfidence.level,'low',task);
  }
  for (const task of ['Plan a meeting for Tuesday','Plan my morning schedule',
    'Coordinate a 15-minute meeting tomorrow','Define implementation plan in one sentence',
    'What is a tradeoff?','List the acceptance criteria from this paragraph','Compare 2 and 3',
    'Compare the definitions of tradeoffs and constraints.',
    'Compare the meanings of the terms tradeoffs and constraints.']) assert.equal(router.classifyTask(task).tier,'utility',task);
  for (const task of ['Plan to rotate production signing keys','Plan to delete all records',
    'Plan a patient prescription dosage change']) assert.equal(router.classifyTask(task).tier,'critical',task);
});

test('deterministic preference cannot replace architecture or mixed semantic work', () => {
  for (const task of ['Design the architecture and migration for this repository.',
    'Compute SHA256 then review architecture safety.', 'Compute SHA256 then explain how collision resistance works.',
    "List files and summarize each file's purpose.", 'Compute SHA256 then draft a poem.', 'Is SHA256 secure?',
    'Compute SHA256 plus draft a short poem.', 'Show git status followed by a short poem.',
    'Compute SHA256 while drafting a short poem.', 'Show git status with a short poem.']) {
    const route = router.routeTask({ task, diagnostics: readyDiagnostics(), preferredProviders: ['powershell'] });
    assert.equal(route.classification.signals.whollyDeterministic, false);
    assert.notEqual(route.primaryTag, 'deterministic');
    assert.equal(route.selected.some((row) => row.kind === 'powershell'), false);
    const shell = route.candidates.find((row) => row.kind === 'powershell');
    assert.equal(shell.eligible, false); assert.ok(shell.policyScore > 0, 'hard gate wins despite boosted positive preference');
    assert.match(shell.ineligibilityReasons.join(' '), /model invocation/);
  }
  for (const task of ['Compute the SHA256 hash.', 'Show git status.', 'Count lines in the text.', 'Compute SHA256 of "input file.txt".']) {
    const route = router.routeTask({ task, diagnostics: readyDiagnostics() });
    assert.equal(route.classification.signals.whollyDeterministic, true, task);
    assert.equal(route.selected[0].kind, 'powershell', task);
  }
  const heavy = router.routeTask({ task: 'Compute SHA256.', diagnostics: readyDiagnostics(), modelTier: 'heavy', preferredProviders: ['powershell'] });
  assert.equal(heavy.selected.some((row) => row.kind === 'powershell'), false);
});

test('software scanner/render and terse security engineering receive semantic coding classification', () => {
  for (const task of ['Repair the placeholder scanner and binder calls; add mutation tests for render calls.',
    'Fix fail-closed gates and races; add regression tests.', 'Hostile audit of CLI isolation and schema validation.',
    'Repair the image placeholder scanner and update render calls.', 'Implement OCR error handling in scanner.js.']) {
    const classification = router.classifyTask(task);
    assert.notEqual(classification.tier, 'utility', task); assert.ok(classification.tags.includes('coding'), task);
    assert.equal(classification.tags.includes('vision'), false, task);
  }
  assert.ok(router.classifyTask('Implement scanner.js after inspecting the screenshot; describe the image.').tags.includes('vision'));
  for (const task of ['Review the screenshot then fix app.js.', 'Check this screenshot and implement the UI fix.']) {
    const route = router.routeTask({ task, diagnostics: readyDiagnostics() });
    assert.ok(route.classification.tags.includes('vision'), task);
    assert.equal(route.noEligibleRoute, true, 'no shipped vision-qualified seat may claim this task');
  }
});

test('undersized and unavailable providers cannot re-enter through preference or fallback', () => {
  const diagnostics = readyDiagnostics();
  for (const kind of ['claude', 'claude_fable', 'codex', 'gemini', 'grok', 'perplexity']) diagnostics[kind] = { found: true, ready: false };
  const route = router.routeTask({ task: 'Design the architecture and migration for this repository.', diagnostics,
    preferredProviders: ['copilot', 'ollama_fast', 'powershell'] });
  assert.equal(route.noEligibleRoute, true); assert.deepEqual(route.selected, []);
  for (const kind of ['copilot', 'ollama_fast', 'ollama_llama', 'ollama_coder']) {
    const row = route.candidates.find((candidate) => candidate.kind === kind);
    assert.equal(row.eligible, false); assert.match(row.ineligibilityReasons.join(' '), /tier ceiling/);
  }
});

test('vision and invocation-mode declarations are explicit capabilities, not provider-name guesses', () => {
  const routingData = router.loadRoutingData();
  routingData.evidence.providers.gemini.capabilities.push('vision'); // Fixture-only qualification.
  const args = { task: 'Inspect this screenshot and perform OCR on the image.', diagnostics: readyDiagnostics(), routingData,
    invocationCapabilities: { gemini: ['model_invocation'] } };
  assert.equal(router.routeTask(args).selected[0].kind, 'gemini');
  assert.equal(router.routeTask({ ...args, dangerous: true, invocationCapabilities: {} }).noEligibleRoute, true);
  assert.equal(router.routeTask({ ...args, invocationCapabilities: { gemini: ['tool_use', 'workspace_read'] } }).noEligibleRoute, true);
});

function readyDiagnostics() {
  return Object.fromEntries([
    'powershell', 'ollama_fast', 'ollama_llama', 'ollama', 'ollama_coder', 'claude', 'codex', 'copilot', 'gemini', 'grok', 'perplexity', 'groq_llama_fast',
  ].map((kind) => [kind, { found: true, ready: true, detail: 'test ready' }]));
}

test('Fable critical planning qualification retains exact observed evidence and no writer slot', () => {
  const evidence = router.loadRoutingData().evidence.providers.claude_fable;
  assert.equal(evidence.maxRecommendedTier, 'critical');
  assert.equal(evidence.qualificationEvidence.receiptId, 'rcpt_mtnq79ny_eaa8acc5');
  assert.equal(evidence.qualificationEvidence.resolvedModelIdentity, 'claude-fable-5');
  assert.equal(evidence.qualificationEvidence.result, 'completed_plan_ready');
  const config = require('../cli-config.json');
  assert.ok(!config.claude_fable.oneshot_dangerous?.length);
  const route = router.routeTask({ task: 'Critical security architecture planning for fail-closed native process ownership and crash recovery.',
    diagnostics: { ...readyDiagnostics(), claude_fable: { found: true, ready: true } }, preferredProviders: ['claude_fable'] });
  assert.equal(route.candidates.find((row) => row.kind === 'claude_fable').eligible, true);
  const { buildTaskPlan } = require('../lib/task-plan');
  const safe = buildTaskPlan({ route, config, requestedKind: 'claude_fable', requestedModelTier: 'heavy' });
  assert.equal(safe.primary.execution.model, 'fable');
  assert.equal(safe.primary.execution.authorityMode, 'safe');
  const writer = buildTaskPlan({ route, config, requestedKind: 'claude_fable', requestedModelTier: 'heavy', dangerous: true });
  assert.equal(writer.primary.blocked, true);
  assert.equal(writer.primary.execution, null);
});

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

test('manufacturer-datasheet evidence audits require retrieval-capable providers', () => {
  const task = 'Read-only manufacturer-datasheet audit of BNO085 and KX134 exact pins, packages, required support circuits, interrupt/reset/boot topology, and power-domain isolation requirements for an automotive ESP32-S31 plus RP2350 sensor board; no file edits';
  const route = router.routeTask({ task, diagnostics: readyDiagnostics() });

  assert.equal(route.classification.tier, 'standard');
  assert.equal(route.classification.signals.authoritativeDocumentResearch, true);
  assert.ok(route.classification.tags.includes('research'));
  assert.equal(route.primaryTag, 'research');
  assert.equal(route.selected[0].kind, 'perplexity');
  assert.ok(route.selected.every((candidate) => candidate.capabilities.includes('research')));
  assert.ok(route.candidates.find((candidate) => candidate.kind === 'ollama').policyReasons.some((reason) => /missing required capability: research/.test(reason)));
});

test('authoritative document evidence variants route to research without matching bare datasheet mentions', () => {
  const positives = [
    'Audit the official datasheet and cite evidence for the exact land pattern.',
    'Find the manufacturer documentation for this regulator and cite the source-backed electrical limits.',
    'Verify the exact pinout and package drawing against the vendor datasheet.',
    'Retrieve the current application note and provide citations for its support circuit.',
    'Audit the manufacturer\ndatasheet against the exact thermal characteristics.',
    'Find the vendor errata and cite evidence for the corrected pin behavior.',
  ];
  for (const task of positives) {
    const classification = router.classifyTask(task);
    assert.ok(classification.tags.includes('research'), task);
    assert.equal(classification.signals.authoritativeDocumentResearch, true, task);
  }

  const negatives = [
    'Summarize this datasheet section in one paragraph.',
    'The README says to consult the manufacturer datasheet.',
    'Fix the spelling of datasheet in this comment.',
    'Verify that the phrase manufacturer datasheet appears in README.md.',
  ];
  for (const task of negatives) {
    const classification = router.classifyTask(task);
    assert.ok(!classification.tags.includes('research'), task);
    assert.equal(classification.signals.authoritativeDocumentResearch, false, task);
  }
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
