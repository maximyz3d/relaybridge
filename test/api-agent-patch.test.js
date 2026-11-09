'use strict';
// In-process apply_patch: exact allowed existing files, journaled before the
// first effect, refused without effect for every unsupported input, and
// recovered only under proven-stopped ownership.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createPatchWriter, recoverPatchEffects, validRecord, opIdFor, tempNameFor, WRITE_BOUNDARY, PATCH_MAX_BYTES,
  PATCH_DEFINITION } = require('../lib/api-agent-patch');
const { createCheckpointStore, executionBindingHash, pendingPatchEffects } = require('../lib/api-agent-checkpoint');
const { digest } = require('../lib/api-agent-wire');
const { WORKSPACE_FS_TYPES } = require('../lib/linux-durable-file');

const LINUX = { skip: process.platform !== 'linux' && 'the patch writer uses Linux directory descriptors' };
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const ALLOWED = ['README.md', 'src/a.js', 'src/link.js', 'src/hard.js', 'src/bin.dat', 'src/big.txt', 'src/dir', 'missing.txt',
  '.env', 'server.pem', 'linked/inner.txt'];
// Functional tests may run on tmpfs; that is not a disk-durability claim.
const allowedTypes = WORKSPACE_FS_TYPES;

function setup(t, { allowed = ALLOWED } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rb-patch-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'ws');
  fs.mkdirSync(path.join(cwd, 'src', 'dir'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'README.md'), 'alpha\nbeta\n', { mode: 0o640 });
  fs.chmodSync(path.join(cwd, 'README.md'), 0o640);
  fs.writeFileSync(path.join(cwd, 'src', 'a.js'), 'const x = 1;\nconst x = 1;\n');
  fs.writeFileSync(path.join(base, 'outside.txt'), 'outside alpha\n');
  fs.symlinkSync(path.join(base, 'outside.txt'), path.join(cwd, 'src', 'link.js'));
  fs.writeFileSync(path.join(cwd, 'src', 'hard.js'), 'hard alpha\n');
  fs.linkSync(path.join(cwd, 'src', 'hard.js'), path.join(base, 'hard-twin.js'));
  fs.writeFileSync(path.join(cwd, 'src', 'bin.dat'), Buffer.from([0x61, 0, 0x62]));
  fs.writeFileSync(path.join(cwd, 'src', 'big.txt'), 'a'.repeat(PATCH_MAX_BYTES + 1));
  fs.writeFileSync(path.join(cwd, '.env'), 'TOKEN=alpha\n');
  fs.writeFileSync(path.join(cwd, 'server.pem'), 'alpha\n');
  fs.mkdirSync(path.join(base, 'real-linked'));
  fs.writeFileSync(path.join(base, 'real-linked', 'inner.txt'), 'inner alpha\n');
  fs.symlinkSync(path.join(base, 'real-linked'), path.join(cwd, 'linked'));
  const dataDir = path.join(base, 'data');
  const store = createCheckpointStore({ dataDir });
  const runId = store.newRunId();
  const execution = { unifiedRunId: 'ur_' + 'a'.repeat(24), segment: 1, taskId: 't_x', apiBindingHash: 'b'.repeat(64),
    toolsetHash: 'c'.repeat(64), writePathsHash: 'd'.repeat(64) };
  const handle = store.create(runId, { binding: {}, execution, initial: { state: {} } });
  let held = true;
  const events = [];
  const hooks = { at: (name, info) => { events.push(name); if (typeof hooks.on === 'function') hooks.on(name, info); } };
  const writer = createPatchWriter({ cwd, allowedWritePaths: allowed, journal: handle, assertHeld: () => { if (!held) throw Object.assign(new Error('x'), { code: 'gone' }); },
    hooks, allowedTypes });
  t.after(() => writer.close());
  let n = 0;
  const call = (input, turn = 1) => {
    const index = n++;
    const record = { turn, index, callId: `call_${index}`, name: 'apply_patch', argsDigest: digest(input), state: 'intent', at: 'x' };
    handle.writeTool(record);
    return { turn, index, callId: record.callId, argsDigest: record.argsDigest };
  };
  const listing = () => {
    const out = [];
    const walk = (dir, rel = '') => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name; out.push(r); if (e.isDirectory() && !e.isSymbolicLink()) walk(path.join(dir, e.name), r); } };
    walk(cwd); return out.sort();
  };
  return { base, cwd, store, runId, handle, writer, hooks, events, call, listing, setHeld: (v) => { held = v; },
    read: (rel) => fs.readFileSync(path.join(cwd, rel), 'utf8'), execution };
}

const patchInput = (rel, text, edits) => ({ path: rel, expectedSha256: sha(text), edits });

test('boundary is reported as an in-process contract, never an OS sandbox or compare-and-swap', () => {
  assert.deepEqual({ ...WRITE_BOUNDARY }, { kind: 'in_process_tool_contract', osSandbox: false, atomicCompareAndSwap: false,
    scope: 'exact_allowed_existing_files', createOrDelete: false, shell: false });
  assert.equal(PATCH_DEFINITION.journaled, true); assert.equal(PATCH_DEFINITION.idempotent, false);
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api-agent-patch.js'), 'utf8');
  for (const forbidden of ['child_process', 'spawn(', 'exec(', 'rmSync', 'mkdirSync', 'O_TRUNC', 'writeFileSync', 'symlinkSync']) {
    assert.ok(!source.includes(forbidden), forbidden);
  }
});

test('an allowed existing file is edited once, journaled through prepared, temp_bound and committed', LINUX, (t) => {
  const env = setup(t);
  const before = fs.statSync(path.join(env.cwd, 'README.md'));
  const c = env.call(patchInput('README.md', 'alpha\nbeta\n', [{ oldText: 'beta', newText: 'gamma' }]));
  const result = env.writer.apply(c, patchInput('README.md', 'alpha\nbeta\n', [{ oldText: 'beta', newText: 'gamma' }]));
  assert.deepEqual(result, { path: 'README.md', sha256: sha('alpha\ngamma\n'), previousSha256: sha('alpha\nbeta\n'), bytes: 12, applied: true });
  assert.equal(env.read('README.md'), 'alpha\ngamma\n');
  assert.equal(fs.statSync(path.join(env.cwd, 'README.md')).mode & 0o7777, before.mode & 0o7777);
  assert.deepEqual(env.events, ['patch-prepared', 'patch-temp-created', 'patch-temp-bound', 'patch-temp-written', 'patch-before-publish',
    'patch-renamed', 'patch-published', 'patch-committed']);
  const record = env.store.load(env.runId).patches.get('1:0');
  assert.equal(record.state, 'committed');
  assert.equal(record.opId, opIdFor(record));
  assert.ok(validRecord(record, { runId: env.runId, allowed: ALLOWED }));
  assert.ok(!env.listing().some((name) => name.includes('.rb-patch-')), 'no temp remains');
  // The tool record is not the patch journal: generic intent never overwrites it.
  assert.equal(env.store.load(env.runId).tools.get('1:0').state, 'intent');
});

test('every unsupported input is refused with no effect and no journal record', LINUX, (t) => {
  const env = setup(t);
  const snapshot = () => env.listing().map((rel) => {
    const abs = path.join(env.cwd, rel); const st = fs.lstatSync(abs);
    return [rel, st.isFile() ? sha(fs.readFileSync(abs)) : st.isSymbolicLink() ? 'link' : 'dir'];
  });
  const outside = fs.readFileSync(path.join(env.base, 'outside.txt'), 'utf8');
  const before = snapshot();
  const cases = [
    ['not_allowed', patchInput('src/other.js', 'x', [{ oldText: 'x', newText: 'y' }]), 'path_not_allowed'],
    ['traversal', patchInput('../outside.txt', outside, [{ oldText: 'alpha', newText: 'b' }]), 'path_not_allowed'],
    ['absolute', patchInput(path.join(env.base, 'outside.txt'), outside, [{ oldText: 'alpha', newText: 'b' }]), 'path_not_allowed'],
    ['hidden', patchInput('.env', 'TOKEN=alpha\n', [{ oldText: 'alpha', newText: 'b' }]), 'path_denied'],
    ['secret', patchInput('server.pem', 'alpha\n', [{ oldText: 'alpha', newText: 'b' }]), 'path_denied'],
    ['symlink leaf', patchInput('src/link.js', outside, [{ oldText: 'alpha', newText: 'b' }]), 'path_denied'],
    ['hard link', patchInput('src/hard.js', 'hard alpha\n', [{ oldText: 'alpha', newText: 'b' }]), 'path_denied'],
    ['symlinked parent', patchInput('linked/inner.txt', 'inner alpha\n', [{ oldText: 'alpha', newText: 'b' }]), null],
    ['missing (no create)', patchInput('missing.txt', '', [{ oldText: 'a', newText: 'b' }]), 'not_found'],
    ['directory', patchInput('src/dir', '', [{ oldText: 'a', newText: 'b' }]), 'not_a_file'],
    ['binary', patchInput('src/bin.dat', Buffer.from([0x61, 0, 0x62]), [{ oldText: 'a', newText: 'b' }]), 'not_text'],
    ['too large', patchInput('src/big.txt', 'a'.repeat(PATCH_MAX_BYTES + 1), [{ oldText: 'a', newText: 'b' }]), 'file_too_large'],
    ['stale hash', patchInput('README.md', 'other', [{ oldText: 'beta', newText: 'gamma' }]), 'patch_conflict'],
    ['edit missing', patchInput('README.md', 'alpha\nbeta\n', [{ oldText: 'zeta', newText: 'gamma' }]), 'edit_not_found'],
    ['edit ambiguous', patchInput('src/a.js', 'const x = 1;\nconst x = 1;\n', [{ oldText: 'const x', newText: 'let x' }]), 'edit_not_unique'],
    ['no-op', patchInput('README.md', 'alpha\nbeta\n', [{ oldText: 'beta', newText: 'beta' }]), 'invalid_argument'],
    ['extra field', { ...patchInput('README.md', 'alpha\nbeta\n', [{ oldText: 'beta', newText: 'g' }]), create: true }, 'invalid_argument'],
    ['edit extra field', patchInput('README.md', 'alpha\nbeta\n', [{ oldText: 'beta', newText: 'g', mode: 0o777 }]), 'invalid_argument'],
    ['empty edits', patchInput('README.md', 'alpha\nbeta\n', []), 'invalid_argument'],
    ['uppercase hash', { path: 'README.md', expectedSha256: sha('alpha\nbeta\n').toUpperCase(), edits: [{ oldText: 'beta', newText: 'g' }] }, 'invalid_argument'],
    ['credential in edit', patchInput('README.md', 'alpha\nbeta\n', [{ oldText: 'beta', newText: 'sk-secret-credential-value' }]), 'credential_present'],
  ];
  for (const [label, input, code] of cases) {
    const c = env.call(input);
    assert.throws(() => env.writer.apply(c, input, { secrets: ['sk-secret-credential-value'] }), (error) => {
      assert.equal(error.toolError, true, `${label}: ${error.code}`);
      if (code) assert.equal(error.code, code, label);
      return true;
    }, label);
  }
  assert.deepEqual(snapshot(), before, 'no file changed, appeared or disappeared');
  assert.equal(fs.readFileSync(path.join(env.base, 'outside.txt'), 'utf8'), outside);
  assert.equal(fs.readFileSync(path.join(env.base, 'real-linked', 'inner.txt'), 'utf8'), 'inner alpha\n');
  assert.equal(env.store.load(env.runId).patches.size, 0, 'no patch journal record');
  assert.deepEqual(env.events, []);
});

test('a lost writer hold before any effect refuses with no journal record', LINUX, (t) => {
  const env = setup(t);
  env.setHeld(false);
  const input = patchInput('README.md', 'alpha\nbeta\n', [{ oldText: 'beta', newText: 'gamma' }]);
  assert.throws(() => env.writer.apply(env.call(input), input), { code: 'writer_hold_lost' });
  assert.equal(env.read('README.md'), 'alpha\nbeta\n');
  assert.equal(env.store.load(env.runId).patches.size, 0);
});

test('a target displaced before publication is uncertain: the foreign content and the temp are kept', LINUX, (t) => {
  const env = setup(t);
  env.hooks.on = (name) => { if (name === 'patch-temp-written') fs.writeFileSync(path.join(env.cwd, 'README.md'), 'foreign\n'); };
  const input = patchInput('README.md', 'alpha\nbeta\n', [{ oldText: 'beta', newText: 'gamma' }]);
  assert.throws(() => env.writer.apply(env.call(input), input), (error) => error.code === 'patch_outcome_uncertain' && error.reason === 'target_displaced');
  assert.equal(env.read('README.md'), 'foreign\n');
  const record = env.store.load(env.runId).patches.get('1:0');
  assert.equal(record.state, 'temp_bound');
  assert.ok(fs.existsSync(path.join(env.cwd, record.tempName)), 'temp evidence kept');
  assert.deepEqual(pendingPatchEffects(env.store.load(env.runId)), ['1:0']);
});

test('a hold lost between temp and publication is uncertain and never publishes', LINUX, (t) => {
  const env = setup(t);
  env.hooks.on = (name) => { if (name === 'patch-temp-written') env.setHeld(false); };
  const input = patchInput('README.md', 'alpha\nbeta\n', [{ oldText: 'beta', newText: 'gamma' }]);
  assert.throws(() => env.writer.apply(env.call(input), input), (error) => error.code === 'patch_outcome_uncertain' && error.reason === 'writer_hold_lost');
  assert.equal(env.read('README.md'), 'alpha\nbeta\n');
});

test('stored records are acted on only in their exact shape', LINUX, (t) => {
  const env = setup(t);
  const input = patchInput('README.md', 'alpha\nbeta\n', [{ oldText: 'beta', newText: 'gamma' }]);
  env.writer.apply(env.call(input), input);
  const record = env.store.load(env.runId).patches.get('1:0');
  const opts = { runId: env.runId, allowed: ALLOWED };
  assert.ok(validRecord(record, opts));
  for (const [label, bad] of [
    ['other run', { ...record, runId: 'aar_x_' + 'e'.repeat(16) }],
    ['string index', { ...record, index: '0' }],
    ['unsafe index', { ...record, index: 2 ** 53 }],
    ['opId', { ...record, opId: 'f'.repeat(64) }],
    ['temp name', { ...record, tempName: tempNameFor('0'.repeat(64)) }],
    ['path outside list', { ...record, rel: 'src/other.js' }],
    ['post bytes', { ...record, postBytesB64: Buffer.from('tampered').toString('base64') }],
    ['extra key', { ...record, tool: 'shell' }],
    ['state', { ...record, state: 'done' }],
    ['missing temp identity', { ...record, tempIdentity: null }],
  ]) assert.equal(validRecord(bad, opts), false, label);
  assert.equal(validRecord(record, { runId: env.runId, allowed: ['src/a.js'] }), false, 'narrowed write list');
});

function stoppedStore(env) {
  assert.equal(env.handle.release({ stopped: true }), true);
  return executionBindingHash(env.store.load(env.runId).manifest);
}

test('recovery: an intent with no patch record is done as not applied; a mismatched pair stays uncertain', LINUX, (t) => {
  const env = setup(t);
  const input = patchInput('README.md', 'alpha\nbeta\n', [{ oldText: 'beta', newText: 'gamma' }]);
  env.call(input); // intent only, never prepared
  const second = patchInput('src/a.js', 'const x = 1;\nconst x = 1;\n', [{ oldText: 'const x = 1;\nconst', newText: 'let' }]);
  env.writer.apply(env.call(second), second);
  // A tool record rewritten with other arguments no longer matches its patch.
  const tool = env.store.load(env.runId).tools.get('1:1');
  env.handle.writeTool({ ...tool, argsDigest: 'e'.repeat(64) });
  const bindingHash = stoppedStore(env);
  const result = recoverPatchEffects({ store: env.store, runId: env.runId, executionBindingHash: bindingHash, cwd: env.cwd,
    allowedWritePaths: ALLOWED, assertHeld: () => {}, allowedTypes });
  assert.equal(result.settled, false);
  assert.deepEqual(result.uncertain, [{ key: '1:1', reason: 'record_mismatch' }]);
  const loaded = env.store.load(env.runId);
  assert.equal(loaded.tools.get('1:0').state, 'done');
  assert.match(loaded.tools.get('1:0').result.output, /patch_not_applied/);
  assert.equal(loaded.manifest.outcome.class, 'patch_outcome_uncertain');
  assert.equal(env.read('README.md'), 'alpha\nbeta\n');
});

test('recovery refuses a live owner and a different execution binding before any effect', LINUX, (t) => {
  const env = setup(t);
  const bindingHash = executionBindingHash(env.store.load(env.runId).manifest);
  assert.throws(() => recoverPatchEffects({ store: env.store, runId: env.runId, executionBindingHash: bindingHash, cwd: env.cwd,
    allowedWritePaths: ALLOWED, assertHeld: () => {}, allowedTypes }), (error) => /owner|lease/.test(error.code));
  stoppedStore(env);
  assert.throws(() => recoverPatchEffects({ store: env.store, runId: env.runId, executionBindingHash: 'f'.repeat(64), cwd: env.cwd,
    allowedWritePaths: ALLOWED, assertHeld: () => {}, allowedTypes }), { code: 'checkpoint_binding_stale' });
  assert.throws(() => recoverPatchEffects({ store: env.store, runId: env.runId, executionBindingHash: bindingHash, cwd: env.cwd,
    allowedWritePaths: ALLOWED, assertHeld: () => { throw Object.assign(new Error('x'), { code: 'writer_hold_lost' }); }, allowedTypes }),
  { code: 'writer_hold_lost' });
});

// ---- final-review corrections ----------------------------------------------

const recoverAll = (env, extra = {}) => recoverPatchEffects({ store: env.store, runId: env.runId,
  executionBindingHash: executionBindingHash(env.store.load(env.runId).manifest), cwd: env.cwd, allowedWritePaths: ALLOWED,
  assertHeld: () => {}, allowedTypes, ...extra });

test('setuid and setgid targets are refused before any journal record or effect', LINUX, (t) => {
  const env = setup(t, { allowed: [...ALLOWED, 'suid.txt', 'sgid.txt'] });
  for (const [rel, mode] of [['suid.txt', 0o4644], ['sgid.txt', 0o2644]]) {
    fs.writeFileSync(path.join(env.cwd, rel), 'alpha\n');
    fs.chmodSync(path.join(env.cwd, rel), mode);
    assert.equal(fs.statSync(path.join(env.cwd, rel)).mode & 0o7777, mode, `${rel} fixture mode`);
    const input = patchInput(rel, 'alpha\n', [{ oldText: 'alpha', newText: 'beta' }]);
    assert.throws(() => env.writer.apply(env.call(input), input), (error) => error.toolError === true && error.code === 'path_denied', rel);
    assert.equal(env.read(rel), 'alpha\n');
    assert.equal(fs.statSync(path.join(env.cwd, rel)).mode & 0o7777, mode);
  }
  assert.equal(env.store.load(env.runId).patches.size, 0, 'no patch journal record');
  assert.deepEqual(env.events, []);
  assert.ok(!env.listing().some((name) => name.includes('.rb-patch-')), 'no temp');
  // A stored record can never carry those bits into a temp.
  const input = patchInput('README.md', 'alpha\nbeta\n', [{ oldText: 'beta', newText: 'gamma' }]);
  env.writer.apply(env.call(input), input);
  const record = env.store.load(env.runId).patches.get('1:2');
  const opts = { runId: env.runId, allowed: env.writer.allowed };
  assert.ok(validRecord(record, opts));
  for (const mode of [0o4640, 0o2640, 0o6640, 0o10640]) assert.equal(validRecord({ ...record, pinned: { ...record.pinned, mode } }, opts), false, mode.toString(8));
});

for (const failpoint of ['patch-renamed', 'patch-published']) {
  test(`a post image whose mode changes at ${failpoint} is uncertain and never committed`, LINUX, (t) => {
    const env = setup(t);
    env.hooks.on = (name) => { if (name === failpoint) fs.chmodSync(path.join(env.cwd, 'README.md'), 0o666); };
    const input = patchInput('README.md', 'alpha\nbeta\n', [{ oldText: 'beta', newText: 'gamma' }]);
    assert.throws(() => env.writer.apply(env.call(input), input), (error) => error.code === 'patch_outcome_uncertain'
      && error.reason === 'publication_unverified');
    assert.equal(env.store.load(env.runId).patches.get('1:0').state, 'temp_bound');
    assert.deepEqual(pendingPatchEffects(env.store.load(env.runId)), ['1:0']);
    assert.ok(!env.events.includes('patch-committed'));
  });
}

test('an ancestor swapped after rename and fsync is uncertain and never committed', LINUX, (t) => {
  const env = setup(t);
  env.hooks.on = (name) => {
    if (name !== 'patch-published') return;
    fs.renameSync(path.join(env.cwd, 'src'), path.join(env.cwd, 'moved'));
    fs.mkdirSync(path.join(env.cwd, 'src'));
    fs.copyFileSync(path.join(env.cwd, 'moved', 'a.js'), path.join(env.cwd, 'src', 'a.js'));
  };
  const input = patchInput('src/a.js', 'const x = 1;\nconst x = 1;\n', [{ oldText: 'const x = 1;\nconst', newText: 'let' }]);
  assert.throws(() => env.writer.apply(env.call(input), input), (error) => error.code === 'patch_outcome_uncertain'
    && error.reason === 'target_displaced');
  assert.equal(env.store.load(env.runId).patches.get('1:0').state, 'temp_bound');
  assert.ok(!env.events.includes('patch-committed'));
});

// Leaves a temp_bound record whose rename landed, as a writer killed between
// rename and commit does.
function landedRename(t, rel, text, edits) {
  const env = setup(t);
  env.hooks.on = (name) => { if (name === 'patch-published') throw new Error('stopped after publication'); };
  const input = patchInput(rel, text, edits);
  assert.throws(() => env.writer.apply(env.call(input), input), { code: 'patch_outcome_uncertain' });
  env.hooks.on = null;
  assert.equal(env.store.load(env.runId).patches.get('1:0').state, 'temp_bound');
  stoppedStore(env);
  return env;
}

test('recovery revalidates the post image mode and owner before the barriers', LINUX, (t) => {
  const env = landedRename(t, 'README.md', 'alpha\nbeta\n', [{ oldText: 'beta', newText: 'gamma' }]);
  assert.equal(env.read('README.md'), 'alpha\ngamma\n');
  fs.chmodSync(path.join(env.cwd, 'README.md'), 0o666);
  const held = recoverAll(env);
  assert.equal(held.settled, false);
  assert.deepEqual(held.uncertain, [{ key: '1:0', reason: 'target_displaced' }]);
  assert.equal(env.store.load(env.runId).patches.get('1:0').state, 'temp_bound');
  // Restoring the journaled mode lets a later recovery commit exactly once.
  fs.chmodSync(path.join(env.cwd, 'README.md'), 0o640);
  const settled = recoverAll(env);
  assert.equal(settled.settled, true, JSON.stringify(settled.uncertain));
  assert.equal(env.store.load(env.runId).patches.get('1:0').state, 'committed');
});

test('recovery revalidates mode, chain and post image after the barriers', LINUX, async (t) => {
  await t.test('mode', (t2) => {
    const env = landedRename(t2, 'README.md', 'alpha\nbeta\n', [{ oldText: 'beta', newText: 'gamma' }]);
    const hooks = { at: (name) => { if (name === 'patch-recovery-synced') fs.chmodSync(path.join(env.cwd, 'README.md'), 0o600); } };
    const result = recoverAll(env, { hooks });
    assert.deepEqual(result.uncertain, [{ key: '1:0', reason: 'target_displaced' }]);
    assert.equal(env.store.load(env.runId).patches.get('1:0').state, 'temp_bound');
  });
  await t.test('ancestor chain', (t2) => {
    const env = landedRename(t2, 'src/a.js', 'const x = 1;\nconst x = 1;\n', [{ oldText: 'const x = 1;\nconst', newText: 'let' }]);
    const hooks = { at: (name) => {
      if (name !== 'patch-recovery-synced') return;
      fs.renameSync(path.join(env.cwd, 'src'), path.join(env.cwd, 'moved'));
      fs.mkdirSync(path.join(env.cwd, 'src'));
      fs.copyFileSync(path.join(env.cwd, 'moved', 'a.js'), path.join(env.cwd, 'src', 'a.js'));
    } };
    const result = recoverAll(env, { hooks });
    assert.deepEqual(result.uncertain, [{ key: '1:0', reason: 'target_displaced' }]);
    assert.equal(env.store.load(env.runId).patches.get('1:0').state, 'temp_bound');
  });
});

test('a directory on an unqualified nested filesystem refuses in-process writes', LINUX, (t) => {
  const env = setup(t);
  const nested = path.join(env.cwd, 'src');
  const fsApi = new Proxy(fs, { get(target, key) {
    if (key !== 'statfsSync') return target[key];
    return (p, ...rest) => {
      let real = null; try { real = fs.readlinkSync(p); } catch {}
      return real === nested ? { type: 0x6969 } : target.statfsSync(p, ...rest);
    };
  } });
  const writer = createPatchWriter({ cwd: env.cwd, allowedWritePaths: ALLOWED, journal: env.handle, assertHeld: () => {}, hooks: env.hooks,
    allowedTypes, fsApi });
  t.after(() => writer.close());
  const input = patchInput('src/a.js', 'const x = 1;\nconst x = 1;\n', [{ oldText: 'const x = 1;\nconst', newText: 'let' }]);
  assert.throws(() => writer.apply(env.call(input), input), (error) => error.toolError === true && error.code === 'api_write_unavailable');
  assert.equal(env.read('src/a.js'), 'const x = 1;\nconst x = 1;\n');
  assert.equal(env.store.load(env.runId).patches.size, 0);
  // The qualified root still accepts its own files.
  const ok = patchInput('README.md', 'alpha\nbeta\n', [{ oldText: 'beta', newText: 'gamma' }]);
  assert.equal(writer.apply(env.call(ok), ok).applied, true);
});
