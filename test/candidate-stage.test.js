'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createCandidateStage, normalizeAllowedWritePaths, hash } = require('../lib/candidate-stage');
const linuxTest = process.platform === 'linux' ? test : test.skip;
const binding = { runId: 'run_fixture', attemptId: 'attempt_fixture', cwdIdentityHash: hash('cwd'), policyId: hash('policy') };
function fixture(t, { files = { 'dirty.txt': 'DIRTY INPUT\n', 'plain.txt': 'unchanged\n', 'untracked.txt': 'untracked input\n' }, ...extra } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-stage-test-'));
  const source = path.join(root, 'source'), parent = path.join(root, 'candidates');
  fs.mkdirSync(source, { mode: 0o700 }); fs.mkdirSync(parent, { mode: 0o700 });
  for (const [name, content] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true }); fs.writeFileSync(path.join(source, name), content); }
  let physical = false, outcome = 'completed', valid = true;
  const options = { sourceRoot: source, stagingParent: parent, allowedWritePaths: [], binding,
    validateBinding: b => valid && b.runId === binding.runId,
    readRunAuthority: () => ({ physicalSettled: physical, outcome }), ...extra };
  const handles = [];
  t.after(() => { for (const h of handles) try { h.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  return { root, source, parent, options, setPhysical: value => physical = value, setOutcome: value => outcome = value, setValid: value => valid = value,
    create(overrides = {}) { const h = createCandidateStage({ ...options, ...overrides }); handles.push(h); return h; } };
}
function bytes(source) { return Object.fromEntries(fs.readdirSync(source).filter(x => fs.lstatSync(path.join(source, x)).isFile()).map(x => [x, fs.readFileSync(path.join(source, x), 'utf8')])); }

test('closed exact-file allowlist rejects aliases, directories, glob syntax and control paths', () => {
  assert.deepEqual(normalizeAllowedWritePaths([]), []);
  assert.deepEqual(normalizeAllowedWritePaths(['src/a.js', 'new.txt']), ['new.txt', 'src/a.js']);
  for (const value of [null, {}, 'a', ['a', 'A'], ['a', 'a/b'], ['/a'], ['C:/x'], ['a\\b'], ['a//b'], ['a/../b'], ['./a'], ['a/'], ['*.js'], ['a?b'], ['.git/config'], ['a/.git/b'], ['.bridge-token'], ['a '], ['NUL.txt'], ['cafe\u0301']]) assert.throws(() => normalizeAllowedWritePaths(value), /STAGE_/);
});

linuxTest('actual git dirty tracked and ordinary untracked bytes become independent copied baseline', t => {
  const f = fixture(t); const git = args => { const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: f.source, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: f.root, GIT_CONFIG_NOSYSTEM: '1' } }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  fs.writeFileSync(path.join(f.source, 'dirty.txt'), 'HEAD BYTES\n'); git(['init', '-q']); git(['add', 'dirty.txt', 'plain.txt']); git(['commit', '-qm', 'fixture']); fs.writeFileSync(path.join(f.source, 'dirty.txt'), 'DIRTY INPUT\n');
  assert.match(git(['status', '--porcelain']), / M dirty.txt/); assert.match(git(['status', '--porcelain']), /\?\? untracked.txt/);
  const stage = f.create(), info = stage.inspectPrivate();
  assert.deepEqual(bytes(info.workspace), bytes(f.source)); assert.equal(fs.existsSync(path.join(info.workspace, '.git')), false); assert.equal(info.baseline.excludedGit, true);
  for (const name of ['dirty.txt', 'plain.txt', 'untracked.txt']) { const original = fs.statSync(path.join(f.source, name)), copied = fs.statSync(path.join(info.workspace, name)); assert.equal(copied.nlink, 1); assert.notEqual(copied.ino, original.ino); }
  assert.equal(stage.finalize().state, 'awaiting_physical_settlement'); f.setPhysical(true); assert.equal(stage.finalize().state, 'candidate_ready'); assert.equal(stage.finalize().applied, false);
});

linuxTest('all four forbidden final changes quarantine the whole candidate including dirty restore', t => {
  for (const [operation, mutate, target] of [
    ['create', dir => fs.writeFileSync(path.join(dir, 'extra.txt'), 'new'), 'extra.txt'],
    ['modify', dir => fs.writeFileSync(path.join(dir, 'untracked.txt'), 'changed'), 'untracked.txt'],
    ['delete', dir => fs.unlinkSync(path.join(dir, 'plain.txt')), 'plain.txt'],
    ['restore', dir => fs.writeFileSync(path.join(dir, 'dirty.txt'), 'HEAD BYTES\n'), 'dirty.txt'],
  ]) {
    const f = fixture(t), originals = bytes(f.source), stage = f.create(), info = stage.inspectPrivate(); mutate(info.workspace); f.setPhysical(true);
    const result = stage.finalize(); assert.equal(result.state, 'quarantined', operation); assert.equal(result.reason, 'STAGE_WRITESET_VIOLATION'); assert.equal(result.complete, true);
    assert.equal(stage.inspectPrivate().result.changes.find(x => x.path === target).allowed, false); assert.deepEqual(bytes(f.source), originals); assert.equal(result.applied, false);
  }
});

linuxTest('permitted changes stay candidate-only; mixed allowed and forbidden changes never salvage', t => {
  const f = fixture(t), originals = bytes(f.source), stage = f.create({ allowedWritePaths: ['dirty.txt', 'new/nested.txt'] }), info = stage.inspectPrivate();
  fs.writeFileSync(path.join(info.workspace, 'dirty.txt'), 'accepted candidate'); fs.mkdirSync(path.join(info.workspace, 'new')); fs.writeFileSync(path.join(info.workspace, 'new/nested.txt'), 'new');
  f.setPhysical(true); assert.equal(stage.finalize().state, 'candidate_ready'); assert.equal(stage.inspectPrivate().result.changes.every(x => x.allowed), true); assert.deepEqual(bytes(f.source), originals);
  assert.equal('promote' in stage, false); assert.equal('apply' in stage, false);
  const other = fixture(t), mixed = other.create({ allowedWritePaths: ['dirty.txt'] }), mixedInfo = mixed.inspectPrivate(); fs.writeFileSync(path.join(mixedInfo.workspace, 'dirty.txt'), 'allowed'); fs.unlinkSync(path.join(mixedInfo.workspace, 'untracked.txt')); other.setPhysical(true);
  assert.equal(mixed.finalize().state, 'quarantined'); assert.equal(mixed.finalize().forbiddenCount, 1); assert.equal(fs.readFileSync(path.join(other.source, 'dirty.txt'), 'utf8'), 'DIRTY INPUT\n');
});

linuxTest('source symlink, hardlink, special file, path alias and nested git fail before candidate creation', t => {
  for (const kind of ['symlink', 'hardlink', 'fifo', 'alias', 'nested-git']) {
    const f = fixture(t);
    if (kind === 'symlink') fs.symlinkSync(path.join(f.source, 'dirty.txt'), path.join(f.source, 'link.txt'));
    if (kind === 'hardlink') fs.linkSync(path.join(f.source, 'dirty.txt'), path.join(f.source, 'link.txt'));
    if (kind === 'fifo') assert.equal(spawnSync('/usr/bin/mkfifo', [path.join(f.source, 'pipe')]).status, 0);
    if (kind === 'alias') fs.writeFileSync(path.join(f.source, 'DIRTY.txt'), 'alias');
    if (kind === 'nested-git') { fs.mkdirSync(path.join(f.source, 'nested')); fs.mkdirSync(path.join(f.source, 'nested/.git')); }
    assert.throws(() => f.create(), /STAGE_/, kind);
  }
});

linuxTest('new stage symlink or hardlink cannot create complete compliant proof or mutate originals', t => {
  for (const kind of ['symlink', 'hardlink']) {
    const f = fixture(t), originals = bytes(f.source), stage = f.create({ allowedWritePaths: ['link.txt'] }), info = stage.inspectPrivate();
    if (kind === 'symlink') fs.symlinkSync(path.join(f.source, 'dirty.txt'), path.join(info.workspace, 'link.txt'));
    else fs.linkSync(path.join(info.workspace, 'dirty.txt'), path.join(info.workspace, 'link.txt'));
    f.setPhysical(true); const result = stage.finalize(); assert.equal(result.state, 'quarantined'); assert.equal(result.complete, false); assert.equal(result.reason, 'STAGE_LINK_UNSUPPORTED'); assert.deepEqual(bytes(f.source), originals);
  }
});

linuxTest('file mode, empty directory and existing directory metadata are part of the full scope', t => {
  for (const operation of ['mode', 'empty-directory', 'directory-mode']) {
    const f = fixture(t, { files: { 'nested/a.txt': 'a' } }), stage = f.create(), info = stage.inspectPrivate();
    if (operation === 'mode') fs.chmodSync(path.join(info.workspace, 'nested/a.txt'), 0o777);
    if (operation === 'empty-directory') fs.mkdirSync(path.join(info.workspace, 'empty'));
    if (operation === 'directory-mode') fs.chmodSync(path.join(info.workspace, 'nested'), 0o777);
    f.setPhysical(true); assert.equal(stage.finalize().state, 'quarantined', operation); assert.equal(stage.finalize().reason, 'STAGE_WRITESET_VIOLATION');
  }
});

linuxTest('count, byte, file, depth and manifest bounds fail closed in preflight and final scan', t => {
  const cases = [{ maxEntries: 1 }, { maxBytes: 1 }, { maxFileBytes: 1 }, { maxManifestBytes: 64 }];
  for (const limits of cases) assert.throws(() => fixture(t).create({ limits }), /STAGE_|DURABLE_FILE_FAILED/);
  const deep = fixture(t, { files: { 'a/b/c': 'deep' } }); assert.throws(() => deep.create({ limits: { maxDepth: 1 } }), /STAGE_SCAN_LIMIT/);
  const f = fixture(t), stage = f.create({ limits: { maxEntries: 3 } }), info = stage.inspectPrivate(); fs.writeFileSync(path.join(info.workspace, 'overflow.txt'), 'new'); f.setPhysical(true);
  const result = stage.finalize(); assert.equal(result.state, 'quarantined'); assert.equal(result.complete, false); assert.equal(result.reason, 'STAGE_SCAN_LIMIT');
});

linuxTest('read error and observed source replacement refuse a complete baseline', t => {
  for (const kind of ['read', 'replacement']) {
    const io = Object.create(fs); let fired = false;
    io.readSync = (...args) => { if (!fired) { fired = true; if (kind === 'read') throw Object.assign(new Error('fixture read denied'), { code: 'EACCES' }); const location = fs.readlinkSync('/proc/self/fd/' + args[0]); fs.renameSync(location, location + '.old'); fs.writeFileSync(location, 'replacement'); } return fs.readSync(...args); };
    const f = fixture(t); assert.throws(() => f.create({ fsApi: io }), /EACCES|STAGE_/);
  }
});

linuxTest('source drift including same-byte inode replacement quarantines without overwriting source', t => {
  for (const kind of ['bytes', 'identity']) {
    const f = fixture(t), stage = f.create({ allowedWritePaths: ['dirty.txt'] }), info = stage.inspectPrivate(); fs.writeFileSync(path.join(info.workspace, 'dirty.txt'), 'candidate');
    if (kind === 'bytes') fs.writeFileSync(path.join(f.source, 'dirty.txt'), 'new user bytes');
    else { const previous = fs.readFileSync(path.join(f.source, 'dirty.txt')); fs.unlinkSync(path.join(f.source, 'dirty.txt')); fs.writeFileSync(path.join(f.source, 'dirty.txt'), previous); }
    const expected = bytes(f.source); f.setPhysical(true); assert.equal(stage.finalize().reason, 'STAGE_SOURCE_CHANGED'); assert.deepEqual(bytes(f.source), expected);
  }
});

linuxTest('caller death proof cannot bypass private authority; cancellation never yields a ready candidate', t => {
  const f = fixture(t), stage = f.create(); assert.throws(() => stage.finalize({ physicalSettled: true }), /STAGE_CALLER_PROOF_FORBIDDEN/);
  assert.equal(stage.finalize().state, 'awaiting_physical_settlement'); f.setPhysical(true); f.setOutcome('cancelled'); assert.equal(stage.finalize().state, 'quarantined'); assert.equal(stage.finalize().reason, 'STAGE_RUN_NOT_COMPLETED');
  const other = fixture(t), changed = other.create(); other.setValid(false); assert.throws(() => changed.finalize(), /STAGE_BINDING_CHANGED/);
});

linuxTest('evidence fsync failure cannot publish candidate-ready even when bytes are readable', t => {
  const io = Object.create(fs); let fail = false;
  io.fsyncSync = fd => { if (fail && fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('fixture barrier failure'), { code: 'EIO' }); return fs.fsyncSync(fd); };
  const f = fixture(t), stage = f.create({ fsApi: io }), info = stage.inspectPrivate(); f.setPhysical(true); fail = true;
  assert.throws(() => stage.finalize(), /durable file operation failed/); assert.equal(stage.inspectPrivate().result, null);
  assert.equal(fs.existsSync(path.join(info.evidence, 'result.json')), true); assert.equal(bytes(f.source)['dirty.txt'], 'DIRTY INPUT\n');
});

linuxTest('overlap, symlink roots, changed pinned root and external stage path are refused', t => {
  const f = fixture(t); assert.throws(() => f.create({ stagingParent: f.source }), /STAGE_ROOT_OVERLAP/);
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.source, alias); assert.throws(() => f.create({ sourceRoot: alias }), /STAGE_ROOT_ALIAS/);
  const stage = f.create(), info = stage.inspectPrivate(); assert.equal(info.workspace.startsWith(f.source + '/'), false); assert.equal(fs.statSync(path.dirname(info.workspace)).mode & 0o777, 0o700);
  fs.renameSync(info.workspace, info.workspace + '-old'); fs.mkdirSync(info.workspace, { mode: 0o700 }); f.setPhysical(true); assert.throws(() => stage.finalize(), /STAGE_ROOT_CHANGED/);
});

linuxTest('no partial salvage or claim of complete transient-write history', t => {
  const f = fixture(t), originals = bytes(f.source), stage = f.create(), info = stage.inspectPrivate();
  fs.writeFileSync(path.join(info.workspace, 'transient.txt'), 'created and removed inside disposable copy'); fs.unlinkSync(path.join(info.workspace, 'transient.txt'));
  f.setPhysical(true); assert.equal(stage.finalize().state, 'candidate_ready'); assert.equal(stage.finalize().changedCount, 0); assert.deepEqual(bytes(f.source), originals);
  const summary = JSON.stringify(stage.finalize()); assert.equal(summary.includes(info.workspace), false); assert.equal(summary.includes('DIRTY INPUT'), false); assert.equal(summary.includes('dirty.txt'), false);
});

linuxTest('native colon-bearing attempt identities are bounded references, never paths', t => {
  const f = fixture(t), attemptId = 'mcp:1d8adc7a-7162-4249-90a6-cef0daa2b5bf:attempt:1';
  const stage = f.create({ binding: { ...binding, attemptId } });
  f.setPhysical(true);
  assert.equal(stage.finalize().state, 'candidate_ready');
  const owner = JSON.parse(fs.readFileSync(path.join(stage.inspectPrivate().evidence, 'owner.json'), 'utf8'));
  assert.equal(owner.binding.attemptId, attemptId);
  for (const invalid of ['x'.repeat(201), 'mcp:/attempt:1', 'mcp:\0:attempt:1', 123, {}]) {
    assert.throws(() => f.create({ binding: { ...binding, attemptId: invalid } }), { code: 'STAGE_BINDING_INVALID' });
  }
});

linuxTest('source root metadata participates in drift checks even for an empty source', t => {
  const f = fixture(t, { files: {} }), stage = f.create();
  assert.equal(stage.inspectPrivate().baseline.root.mode, 0o700);
  fs.chmodSync(f.source, 0o750);
  f.setPhysical(true);
  const result = stage.finalize();
  assert.equal(result.state, 'quarantined');
  assert.equal(result.reason, 'STAGE_SOURCE_CHANGED');
  assert.equal(result.complete, true);
  assert.equal(fs.statSync(f.source).mode & 0o777, 0o750);
});

linuxTest('source root permissions need not equal the private stage root permissions', t => {
  const f = fixture(t);
  fs.chmodSync(f.source, 0o755);
  const stage = f.create(); f.setPhysical(true);
  assert.equal(stage.inspectPrivate().baseline.root.mode, 0o755);
  assert.equal(stage.finalize().state, 'candidate_ready');
  assert.equal(fs.statSync(stage.inspectPrivate().workspace).mode & 0o777, 0o700);
});

linuxTest('post-scan validation catches an earlier file changed during a later file read', t => {
  for (const target of ['source', 'stage']) {
    const f = fixture(t, { files: { 'a.txt': 'original a', 'b.txt': 'original b' } });
    const io = Object.create(fs); let armed = false, workspace;
    io.readSync = (fd, ...args) => {
      const location = fs.readlinkSync('/proc/self/fd/' + fd);
      if (armed && location === path.join(target === 'source' ? f.source : workspace, 'b.txt')) {
        armed = false;
        fs.writeFileSync(path.join(path.dirname(location), 'a.txt'), 'concurrent mutation');
      }
      return fs.readSync(fd, ...args);
    };
    const stage = f.create({ fsApi: io }); workspace = stage.inspectPrivate().workspace;
    armed = true; f.setPhysical(true);
    const result = stage.finalize();
    assert.equal(result.state, 'quarantined', target);
    assert.equal(result.complete, false, target);
    assert.equal(result.reason, 'STAGE_CHANGED_DURING_SCAN', target);
    assert.equal(fs.readFileSync(path.join(target === 'source' ? f.source : workspace, 'a.txt'), 'utf8'), 'concurrent mutation');
  }
});

linuxTest('post-scan validation revisits earlier directory identities and censuses', t => {
  const f = fixture(t, { files: { 'a/one.txt': 'one', 'z.txt': 'last' } });
  const io = Object.create(fs); let armed = false, workspace;
  io.readSync = (fd, ...args) => {
    const location = fs.readlinkSync('/proc/self/fd/' + fd);
    if (armed && location === path.join(workspace, 'z.txt')) {
      armed = false; fs.writeFileSync(path.join(workspace, 'a/late.txt'), 'late forbidden addition');
    }
    return fs.readSync(fd, ...args);
  };
  const stage = f.create({ fsApi: io }); workspace = stage.inspectPrivate().workspace;
  armed = true; f.setPhysical(true);
  assert.equal(stage.finalize().reason, 'STAGE_CHANGED_DURING_SCAN');
  assert.equal(stage.finalize().complete, false);
});

linuxTest('a destination directory symlink swap cannot redirect a copy outside its pinned tree', t => {
  for (const timing of ['before-open', 'after-open']) {
    const f = fixture(t, { files: { 'nested/escape.txt': 'copy must remain private' } });
    const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
    const originals = fs.readFileSync(path.join(f.source, 'nested/escape.txt'));
    const io = Object.create(fs); let swapped = false;
    if (timing === 'before-open') {
      io.mkdirSync = (directory, options) => {
        const value = fs.mkdirSync(directory, options);
        if (!swapped && String(directory).startsWith('/proc/self/fd/') && String(directory).endsWith('/nested')) {
          swapped = true; fs.rmdirSync(directory); fs.symlinkSync(outside, directory);
        }
        return value;
      };
    } else {
      io.openSync = (file, flags, ...args) => {
        const fd = fs.openSync(file, flags, ...args);
        const location = fs.readlinkSync('/proc/self/fd/' + fd);
        if (!swapped && (flags & fs.constants.O_DIRECTORY) && location.startsWith(f.parent + '/') && location.endsWith('/workspace/nested')) {
          swapped = true; fs.renameSync(location, location + '-old'); fs.symlinkSync(outside, location);
        }
        return fd;
      };
    }
    assert.throws(() => f.create({ fsApi: io }), /STAGE_|ENOTDIR|ELOOP/, timing);
    assert.equal(swapped, true, timing);
    assert.deepEqual(fs.readdirSync(outside), [], timing);
    assert.deepEqual(fs.readFileSync(path.join(f.source, 'nested/escape.txt')), originals);
  }
});

linuxTest('healthy retry reconfirms exact result bytes after interrupted publication', t => {
  const f = fixture(t), io = Object.create(fs); let fail = false;
  io.fsyncSync = fd => {
    if (fail && fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('fixture barrier'), { code: 'EIO' });
    return fs.fsyncSync(fd);
  };
  const stage = f.create({ fsApi: io }); f.setPhysical(true); fail = true;
  assert.throws(() => stage.finalize());
  const file = path.join(stage.inspectPrivate().evidence, 'result.json'), visible = fs.readFileSync(file);
  assert.throws(() => stage.finalize(), { code: 'STAGE_DURABILITY_UNCONFIRMED' });
  assert.equal(stage.inspectPrivate().result, null);
  fail = false;
  const result = stage.finalize();
  assert.equal(result.state, 'candidate_ready');
  assert.deepEqual(fs.readFileSync(file), visible);
  assert.deepEqual(stage.finalize(), result);
  assert.equal(result.applied, false);
  assert.equal(result.atomicSnapshot, false);
  assert.equal(result.evidenceScope, 'final_filesystem_delta');
});

linuxTest('result recovery repairs only an exact private leftover publication alias', t => {
  const f = fixture(t), io = Object.create(fs); let fail = false;
  io.unlinkSync = file => {
    if (fail && /\.rb-[a-f0-9]{32}\.tmp$/.test(file)) throw Object.assign(new Error('fixture cleanup'), { code: 'EIO' });
    return fs.unlinkSync(file);
  };
  const stage = f.create({ fsApi: io }); f.setPhysical(true); fail = true;
  assert.throws(() => stage.finalize(), { code: 'STAGE_DURABILITY_UNCONFIRMED' });
  const evidence = stage.inspectPrivate().evidence, file = path.join(evidence, 'result.json');
  assert.equal(fs.statSync(file).nlink, 2);
  fail = false;
  assert.equal(stage.finalize().state, 'candidate_ready');
  assert.equal(fs.statSync(file).nlink, 1);
  assert.deepEqual(fs.readdirSync(evidence).sort(), ['baseline.json', 'owner.json', 'result.json']);
});

linuxTest('different, aliased or unreadable published evidence cannot be recovered as ready', t => {
  for (const tamper of ['bytes', 'external-hardlink', 'symlink', 'read-error']) {
    const f = fixture(t), io = Object.create(fs); let failBarrier = false, failRead = false;
    io.fsyncSync = fd => {
      if (failBarrier && fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('fixture barrier'), { code: 'EIO' });
      return fs.fsyncSync(fd);
    };
    io.readSync = (fd, ...args) => {
      if (failRead && fs.readlinkSync('/proc/self/fd/' + fd).endsWith('/result.json')) throw Object.assign(new Error('fixture read'), { code: 'EIO' });
      return fs.readSync(fd, ...args);
    };
    const stage = f.create({ fsApi: io }); f.setPhysical(true); failBarrier = true;
    assert.throws(() => stage.finalize()); failBarrier = false;
    const file = path.join(stage.inspectPrivate().evidence, 'result.json');
    const original = fs.readFileSync(file), outside = path.join(f.root, 'outside-evidence');
    if (tamper === 'bytes') fs.writeFileSync(file, original.toString().replace('candidate_ready', 'candidate_other'));
    else if (tamper === 'external-hardlink') fs.linkSync(file, outside);
    else if (tamper === 'symlink') { fs.renameSync(file, outside); fs.symlinkSync(outside, file); }
    else failRead = true;
    assert.throws(() => stage.finalize(), /STAGE_/, tamper);
    assert.equal(stage.inspectPrivate().result, null, tamper);
    if (fs.existsSync(outside)) assert.deepEqual(fs.readFileSync(outside), original, tamper);
  }
});

linuxTest('a published quarantine cannot be retried into partial salvage', t => {
  const f = fixture(t), io = Object.create(fs); let fail = false;
  io.fsyncSync = fd => {
    if (fail && fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('fixture barrier'), { code: 'EIO' });
    return fs.fsyncSync(fd);
  };
  const stage = f.create({ fsApi: io, allowedWritePaths: ['dirty.txt'] }), info = stage.inspectPrivate();
  fs.writeFileSync(path.join(info.workspace, 'dirty.txt'), 'allowed candidate');
  fs.writeFileSync(path.join(info.workspace, 'forbidden.txt'), 'forbidden candidate');
  f.setPhysical(true); fail = true; assert.throws(() => stage.finalize());
  const published = JSON.parse(fs.readFileSync(path.join(info.evidence, 'result.json'), 'utf8'));
  assert.equal(published.state, 'quarantined');
  fail = false; fs.unlinkSync(path.join(info.workspace, 'forbidden.txt'));
  assert.throws(() => stage.finalize(), { code: 'STAGE_EVIDENCE_CONFLICT' });
  assert.equal(stage.inspectPrivate().result, null);
  assert.equal(fs.readFileSync(path.join(f.source, 'dirty.txt'), 'utf8'), 'DIRTY INPUT\n');
});

linuxTest('the durability substrate must open the already pinned evidence directory', t => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside, { mode: 0o700 });
  const io = Object.create(fs); let evidenceOpens = 0;
  io.openSync = (file, flags, ...args) => {
    if (String(file).endsWith('/evidence') && (flags & fs.constants.O_DIRECTORY) && ++evidenceOpens === 2) {
      return fs.openSync(outside, flags, ...args);
    }
    return fs.openSync(file, flags, ...args);
  };
  assert.throws(() => f.create({ fsApi: io }), /STAGE_|DURABLE_FILE_FAILED/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
