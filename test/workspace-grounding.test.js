'use strict';

// Issue #16: an audit task was routed to ollama_coder, which has no filesystem
// access. It invented a patch for files that do not exist, exited 0, and the
// receipt recorded a successful call. Silent, confident, and recorded as
// success — the worst shape a failure can take.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  seatHasWorkspaceAccess, requiresWorkspace, checkGrounding,
  extractReferencedPaths, verifyReferencedPaths, prepareGroundedPrompt,
} = require('../lib/workspace-grounding');
const readCapabilities = { oneshot_capabilities: { safe: ['model_invocation', 'workspace_read', 'tool_use'] } };

// ---- which seats can actually read files ----------------------------------

test('HTTP-transport seats are known to have no filesystem access', () => {
  for (const adapter of ['local:ollama', 'hosted:openai-compatible', 'api:anthropic']) {
    assert.equal(seatHasWorkspaceAccess({ adapter }), false, adapter);
  }
});

test('CLI access requires an explicit per-mode tool capability, not a billing label', () => {
  for (const adapter of ['subscription:anthropic', 'subscription:chatgpt', 'subscription:cursor']) {
    assert.equal(seatHasWorkspaceAccess({ adapter, ...readCapabilities }), true, adapter);
    assert.equal(seatHasWorkspaceAccess({ adapter }), false, adapter);
  }
  assert.equal(seatHasWorkspaceAccess({}), false, 'cwd alone is not tool access');
  assert.equal(seatHasWorkspaceAccess(readCapabilities, 'claude', true), false, 'dangerous mode does not inherit safe capability');
});

test('unknown and tool-less execution adapters are not assumed grounded', () => {
  assert.equal(seatHasWorkspaceAccess({ adapter: 'something-new' }), false);
  for (const oneshot_adapter of ['ollama_api', 'openai_chat_api', 'unknown_http']) {
    assert.equal(seatHasWorkspaceAccess({ oneshot_adapter, workspaceAccess: true, ...readCapabilities }), false);
  }
  assert.equal(seatHasWorkspaceAccess(readCapabilities, 'perplexity'), false);
});

test('a legacy workspaceAccess flag can restrict but cannot grant missing capabilities', () => {
  assert.equal(seatHasWorkspaceAccess({ adapter: 'local:ollama', workspaceAccess: true, ...readCapabilities }), false);
  assert.equal(seatHasWorkspaceAccess({ adapter: 'subscription:anthropic', workspaceAccess: false }), false);
});

// ---- which tasks need the workspace ---------------------------------------

test('file-inspection tasks are recognised', () => {
  for (const p of [
    'inspect only the current git diff in the supplied cwd and report findings',
    'review the repository for P0 issues',
    'which files changed in this branch?',
    'read the file package.json and summarise the scripts',
    'audit the codebase for injection risks',
    'Review src/engine/resolve.ts and test/parser.test.js.',
  ]) {
    assert.equal(requiresWorkspace(p, { cwd: '/repo' }).required, true, p);
  }
});

test('inline work is NOT treated as needing the workspace', () => {
  // The most important negative case: blocking these would make cheap local
  // seats useless for the work they are best at.
  for (const p of [
    'review this code:\n\nfunction add(a,b){return a+b}',
    'explain what a Fletcher-16 checksum is',
    'write a regex that matches semver',
    'summarise the tradeoffs between mutexes and channels',
  ]) {
    assert.equal(requiresWorkspace(p, { cwd: '/repo' }).required, false, p);
  }
});

test('a cwd alone does not make a task workspace-bound', () => {
  const r = requiresWorkspace('write me a haiku about winter', { cwd: '/repo' });
  assert.equal(r.required, false, 'plenty of tasks carry a cwd incidentally');
});

// ---- the gate --------------------------------------------------------------

test('the reported case is blocked before any tokens are spent', () => {
  const r = checkGrounding({
    prompt: 'inspect only the current git diff in the supplied cwd, report exact P0/P1 findings or GO, do not edit',
    cwd: 'C:/repo',
    seat: 'ollama_coder',
    seatConfig: { adapter: 'local:ollama' },
  });
  assert.equal(r.allowed, false, 'this exact task produced a fabricated patch');
  assert.match(r.reason, /cannot read/);
  assert.match(r.reason, /fabricated/);
  assert.ok(r.remedy, 'a refusal must say what to do instead');
});

test('the same task on a grounded seat is allowed', () => {
  const r = checkGrounding({
    prompt: 'inspect the current git diff in the supplied cwd and report findings',
    cwd: 'C:/repo', seat: 'claude', seatConfig: { adapter: 'subscription:anthropic', ...readCapabilities },
  });
  assert.equal(r.allowed, true);
  assert.equal(r.required, true);
  assert.equal(r.hasAccess, true);
});

test('non-workspace work still runs on cheap local seats', () => {
  const r = checkGrounding({
    prompt: 'explain what a Fletcher-16 checksum is',
    seat: 'ollama_fast', seatConfig: { adapter: 'local:ollama' },
  });
  assert.equal(r.allowed, true, 'local seats must stay useful for what they are good at');
});

test('an override cannot turn an ungrounded required audit into usable evidence', () => {
  const r = checkGrounding({
    prompt: 'review the repository layout', cwd: '/repo',
    seat: 'ollama_coder', seatConfig: { adapter: 'local:ollama' }, override: true,
  });
  assert.equal(r.allowed, false);
  assert.match(r.remedy, /inlineEvidence/);
});

test('explicit access requirements and exact caller-supplied evidence compose once without granting writes', () => {
  const crypto = require('node:crypto');
  const content = 'src/a.js\r\nexport const π = "雪";\n';
  const cwdIdentityHash = 'a'.repeat(64);
  const inlineEvidence = { content, sha256: crypto.createHash('sha256').update(content).digest('hex'), cwdIdentityHash };
  const request = { prompt: 'Review src/a.js', seat: 'ollama', seatConfig: { oneshot_adapter: 'ollama_api' },
    requiresWorkspaceAccess: true, cwdIdentityHash, inlineEvidence };
  const result = prepareGroundedPrompt(request);
  assert.equal(result.grounding.mode, 'inline_evidence'); assert.equal(result.grounding.evidence.source, 'caller_supplied');
  assert.equal(result.prompt.split(content).length, 2);
  assert.throws(() => prepareGroundedPrompt({ ...request, dangerous: true }), { code: 'workspace_grounding' });
  assert.throws(() => prepareGroundedPrompt({ ...request, prompt: 'Edit src/a.js.' }), { code: 'workspace_grounding' });
  assert.equal(prepareGroundedPrompt({ ...request, prompt: 'Review src/a.js; do not edit files.' }).grounding.allowed, true);
  for (const patch of [{ sha256: 'b'.repeat(64) }, { cwdIdentityHash: 'c'.repeat(64) }, { extra: true }, { content: '' }]) {
    assert.throws(() => prepareGroundedPrompt({ ...request, inlineEvidence: { ...inlineEvidence, ...patch } }), { code: 'invalid_grounding' });
  }
  assert.equal(requiresWorkspace('Return findings.', { requiresWorkspaceAccess: true }).required, true);
  assert.equal(requiresWorkspace('Review src/a.js.', { requiresWorkspaceAccess: false }).required, true);
  assert.throws(() => requiresWorkspace('Return findings.', { requiresWorkspaceAccess: 'true' }), { code: 'invalid_grounding' });
});

test('Markdown targets, file URIs and canonical containment never reparse labels as missing basenames', (t) => {
  const { pathToFileURL } = require('node:url');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-citations-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'repo'); fs.mkdirSync(path.join(root, '.rb-wt', 'space dir'), { recursive: true });
  const file = path.join(root, '.rb-wt', 'space dir', 'real.js'); fs.writeFileSync(file, 'real');
  const uri = pathToFileURL(file).href;
  const result = verifyReferencedPaths(`[absent-label.js](${uri}#L3) and [other.js](<${file}:4>)`, root);
  assert.equal(result.confidence, 'ok'); assert.equal(result.present.length, 2); assert.deepEqual(result.missing, []);
  assert.equal(result.citations.every((row) => row.status === 'present'), true);
  const invalid = verifyReferencedPaths('[label.js](file://remote-host/a.js) and [label.js](file:///bad%XX/a.js)', root);
  assert.equal(invalid.citations.every((row) => row.status === 'invalid_uri'), true);
  assert.deepEqual(invalid.missing, []);
  if (process.platform !== 'win32') {
    const foreign = verifyReferencedPaths('[label.js](file:///C:/repo/main.js#L3)', root);
    assert.equal(foreign.citations[0].status, 'foreign_platform'); assert.deepEqual(foreign.missing, []);
  }
  const outside = path.join(parent, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'real.js'), 'outside');
  fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const escaped = verifyReferencedPaths('escape/real.js and escape/absent.js', root);
  assert.equal(escaped.citations.every((row) => row.status === 'outside_workspace'), true);
  assert.deepEqual(escaped.present, []); assert.deepEqual(escaped.missing, []);
  const ambiguous = verifyReferencedPaths('escape/../outside/real.js and escape/../outside/absent.js', root);
  assert.equal(ambiguous.citations.every((row) => row.status === 'unverifiable'), true);
  assert.deepEqual(ambiguous.missing, []); assert.deepEqual(ambiguous.present, []);
  fs.writeFileSync(path.join(root, 'a(b).ts'), 'real');
  fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src', '[id].tsx'), 'real');
  for (const text of [
    '[See [src/missing.ts]](a(b).ts)',
    '[src/missing.ts][ref]\n\n[ref]: a(b).ts',
    '[src/missing.ts](a%28b%29%2Ets)',
    '[missing.ts](.rb-wt%2Fspace%20dir%2Freal.js)',
    '`src/[id].tsx`', '<src/[id].tsx>',
    '[See `src/missing.ts`](a(b).ts)',
  ]) {
    const parsed = verifyReferencedPaths(text, root);
    assert.equal(parsed.confidence, 'ok', text); assert.equal(parsed.present.length, 1, text);
    assert.deepEqual(parsed.missing, [], text);
  }
  if (process.platform !== 'win32') assert.equal(verifyReferencedPaths('C:src/real.ts', root).citations[0].status, 'foreign_platform');
  else {
    const drive = path.parse(root).root.slice(0, 2);
    assert.equal(verifyReferencedPaths(`${drive}escape/../src/real.ts`, root).citations[0].status, 'unverifiable');
    const legacyUri = 'file://' + file.replace(/\\/g, '/');
    assert.equal(verifyReferencedPaths(`[real.js](${legacyUri})`, root).citations[0].status, 'present');
  }
});

// ---- post-hoc verification -------------------------------------------------

test('path extraction finds real file references and ignores prose', () => {
  const paths = extractReferencedPaths('I changed `src/app/main.js` and lib/util.ts but not the resolver module.');
  assert.ok(paths.includes('src/app/main.js'));
  assert.ok(paths.includes('lib/util.ts'));
  assert.equal(paths.length, 2, 'prose must not be mistaken for a path');
});

test('URLs and node_modules are not treated as workspace paths', () => {
  const paths = extractReferencedPaths('see https://example.com/a/b.html and node_modules/left-pad/index.js');
  assert.equal(paths.length, 0);
});

test('an answer citing only nonexistent files is flagged as likely fabricated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbws-'));
  fs.mkdirSync(path.join(dir, 'backend'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'backend', 'parts.py'), '# real');

  const v = verifyReferencedPaths(
    'P0 in src/etchwise/symbol_validation.py and src/etchwise/resolver.py — patch below', dir);
  assert.equal(v.confidence, 'likely-fabricated');
  assert.deepEqual(v.present, []);
  assert.equal(v.missing.length, 2);
  assert.match(v.note, /absent from the workspace/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an answer citing real files passes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbws-'));
  fs.mkdirSync(path.join(dir, 'backend'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'backend', 'parts.py'), '# real');
  const v = verifyReferencedPaths('the change in backend/parts.py looks correct', dir);
  assert.equal(v.confidence, 'ok');
  assert.deepEqual(v.missing, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('proposing one new file alongside real ones is not called fabrication', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbws-'));
  fs.writeFileSync(path.join(dir, 'a.js'), '');
  fs.writeFileSync(path.join(dir, 'b.js'), '');
  const v = verifyReferencedPaths('edit a.js and b.js, and add tests/new.test.js', dir);
  assert.equal(v.confidence, 'partial', 'a legitimate proposal must not be called fabrication');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an answer citing no paths is reported honestly, not as a pass', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbws-'));
  const v = verifyReferencedPaths('GO — no findings', dir);
  assert.equal(v.confidence, 'no-paths-cited');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('paths escaping the workspace are not counted as evidence either way', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbws-'));
  fs.writeFileSync(path.join(dir, 'real.js'), '');
  const v = verifyReferencedPaths('see ../../etc/passwd.txt and real.js', dir);
  assert.ok(!v.missing.includes('../../etc/passwd.txt'));
  assert.ok(v.present.includes('real.js'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('project wording is recognised as workspace-bound', () => {
  const r = requiresWorkspace('review this project for security issues', { cwd: '/repo' });
  assert.equal(r.required, true);
});

test('a sibling whose name shares the workspace prefix is still outside', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rbws-parent-'));
  const dir = path.join(parent, 'repo');
  const sibling = path.join(parent, 'repo-copy');
  fs.mkdirSync(dir);
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, 'outside.js'), '');
  const v = verifyReferencedPaths('see ../repo-copy/outside.js', dir);
  assert.deepEqual(v.present, []);
  assert.deepEqual(v.missing, []);
  fs.rmSync(parent, { recursive: true, force: true });
});

test('verification degrades honestly when there is no cwd to check against', () => {
  const v = verifyReferencedPaths('src/a.js changed', null);
  assert.equal(v.checked, false);
  assert.match(v.reason, /no readable cwd/);
});
