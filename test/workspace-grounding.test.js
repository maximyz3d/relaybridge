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
  extractReferencedPaths, verifyReferencedPaths,
} = require('../lib/workspace-grounding');

// ---- which seats can actually read files ----------------------------------

test('HTTP-transport seats are known to have no filesystem access', () => {
  for (const adapter of ['local:ollama', 'hosted:openai-compatible', 'api:anthropic']) {
    assert.equal(seatHasWorkspaceAccess({ adapter }), false, adapter);
  }
});

test('CLI seats that run in the working directory do have access', () => {
  for (const adapter of ['subscription:anthropic', 'subscription:chatgpt', 'subscription:cursor']) {
    assert.equal(seatHasWorkspaceAccess({ adapter }), true, adapter);
  }
  assert.equal(seatHasWorkspaceAccess({}), true, 'a plain CLI spawned in cwd');
});

test('an unknown adapter is assumed grounded rather than blocked', () => {
  // A false "cannot read" blocks legitimate work; the post-hoc check still
  // catches fabrication, so the safe default here is to allow.
  assert.equal(seatHasWorkspaceAccess({ adapter: 'something-new' }), true);
});

test('an explicit workspaceAccess flag overrides adapter inference', () => {
  assert.equal(seatHasWorkspaceAccess({ adapter: 'local:ollama', workspaceAccess: true }), true);
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
    cwd: 'C:/repo', seat: 'claude', seatConfig: { adapter: 'subscription:anthropic' },
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

test('an explicit override is allowed but flagged as unverified', () => {
  const r = checkGrounding({
    prompt: 'review the repository layout', cwd: '/repo',
    seat: 'ollama_coder', seatConfig: { adapter: 'local:ollama' }, override: true,
  });
  assert.equal(r.allowed, true);
  assert.equal(r.overridden, true);
  assert.match(r.reason, /unverified/, 'the caller must be told the answer is not grounded');
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

test('verification degrades honestly when there is no cwd to check against', () => {
  const v = verifyReferencedPaths('src/a.js changed', null);
  assert.equal(v.checked, false);
  assert.match(v.reason, /no readable cwd/);
});
