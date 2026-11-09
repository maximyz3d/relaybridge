'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createReadOnlyTools, redactSecrets, REDACTED, SEARCH_QUERY_MAX_BYTES, TOOL_DEFINITIONS } = require('../lib/api-agent-tools');
const { isolatedEnv } = require('./helpers/isolated-env');

const POSIX = process.platform !== 'win32';

function workspace(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-tools-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'ws');
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), 'hello world\nsecond line needle\n');
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'const needle = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'deep', 'b.txt'), 'deep needle here\n');
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=needle\n');
  fs.writeFileSync(path.join(root, '.npmrc'), '//registry:_authToken=needle\n');
  fs.mkdirSync(path.join(root, '.ssh'));
  fs.writeFileSync(path.join(root, '.ssh', 'id_rsa'), 'needle');
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'config'), 'needle');
  fs.writeFileSync(path.join(root, 'server.pem'), 'needle');
  fs.writeFileSync(path.join(root, 'id_ed25519'), 'needle');
  const outside = path.join(base, 'outside.txt');
  fs.writeFileSync(outside, 'outside needle\n');
  return { base, root, outside };
}

const run = (tools, name, input, secrets) => {
  const r = tools.execute(name, input, { secrets });
  return { ...r, value: JSON.parse(r.output) };
};

test('tools are idempotent, read-only and the module never spawns', () => {
  assert.ok(TOOL_DEFINITIONS.every((d) => d.idempotent === true));
  assert.deepEqual(TOOL_DEFINITIONS.map((d) => d.name).sort(), ['list_dir', 'read_file', 'search']);
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api-agent-tools.js'), 'utf8');
  for (const forbidden of ['child_process', 'new RegExp', 'writeFile', 'unlink', 'rename', 'spawn(', 'exec(', 'writeSync']) assert.ok(!source.includes(forbidden), forbidden);
});

test('read, list and literal search work inside the workspace', (t) => {
  const { root } = workspace(t);
  const tools = createReadOnlyTools({ cwd: root });
  const read = run(tools, 'read_file', { path: 'README.md', offset: null, length: null });
  assert.equal(read.isError, false); assert.equal(read.value.content, 'hello world\nsecond line needle\n'); assert.equal(read.value.eof, true);
  const page = run(tools, 'read_file', { path: 'README.md', offset: 6, length: 5 });
  assert.equal(page.value.content, 'world'); assert.equal(page.value.eof, false);
  const list = run(tools, 'list_dir', { path: null });
  assert.deepEqual(list.value.entries.map((e) => e.name), ['README.md', 'src']);
  assert.ok(list.value.omitted >= 4);
  const found = run(tools, 'search', { query: 'needle', path: null });
  assert.deepEqual(found.value.matches.map((m) => m.path).sort(), ['README.md', 'src/a.js', 'src/deep/b.txt']);
  // Regex metacharacters are literal.
  assert.deepEqual(run(tools, 'search', { query: 'n..dle', path: null }).value.matches, []);
  assert.deepEqual(run(tools, 'search', { query: '(a+)+$', path: null }).value.matches, []);
  assert.equal(run(tools, 'search', { query: 'x'.repeat(SEARCH_QUERY_MAX_BYTES + 1), path: null }).value.error, 'invalid_argument');
});

test('traversal, absolute, NUL, hidden and secret paths are refused', (t) => {
  const { root, outside } = workspace(t);
  const tools = createReadOnlyTools({ cwd: root });
  for (const [p, code] of [['../outside.txt', 'path_outside_workspace'], ['src/../../outside.txt', 'path_outside_workspace'],
    [outside.split(path.sep).join('/'), 'path_outside_workspace'], ['C:/x', 'path_outside_workspace'], ['a\0b', 'invalid_path'], ['src\\a.js', 'invalid_path'],
    ['.env', 'path_denied'], ['.npmrc', 'path_denied'], ['.ssh/id_rsa', 'path_denied'], ['.git/config', 'path_denied'],
    ['server.pem', 'path_denied'], ['id_ed25519', 'path_denied'], ['missing.txt', 'not_found'], ['src', 'not_a_file']]) {
    const r = run(tools, 'read_file', { path: p, offset: null, length: null });
    assert.equal(r.isError, true, p); assert.equal(r.value.error, code, p);
  }
  assert.equal(run(tools, 'list_dir', { path: '.ssh' }).value.error, 'path_denied');
  assert.equal(run(tools, 'search', { query: 'needle', path: '.git' }).value.error, 'path_denied');
  assert.equal(run(tools, 'read_file', { path: 'README.md', offset: null, length: null, extra: 1 }).value.error, 'invalid_argument');
  assert.equal(run(tools, 'write_file', { path: 'x' }).value.error, 'unknown_tool');
  assert.equal(run(tools, 'read_file', { path: 'README.md', offset: -1, length: null }).value.error, 'invalid_argument');
  assert.equal(run(tools, 'read_file', { path: 'README.md', offset: null, length: 256 * 1024 + 1 }).value.error, 'invalid_argument');
});

test('RelayBridge data, config and token paths are denied even when inside the workspace', (t) => {
  const { root } = workspace(t);
  fs.mkdirSync(path.join(root, 'data')); fs.writeFileSync(path.join(root, 'data', 'state.json'), 'needle');
  fs.writeFileSync(path.join(root, 'config.json'), 'needle');
  const tools = createReadOnlyTools({ cwd: root, deniedPaths: [path.join(root, 'data'), path.join(root, 'config.json')] });
  assert.equal(run(tools, 'read_file', { path: 'data/state.json', offset: null, length: null }).value.error, 'path_denied');
  assert.equal(run(tools, 'read_file', { path: 'config.json', offset: null, length: null }).value.error, 'path_denied');
  const names = run(tools, 'list_dir', { path: null }).value.entries.map((e) => e.name);
  assert.ok(!names.includes('data') && !names.includes('config.json'));
  assert.ok(run(tools, 'search', { query: 'needle', path: null }).value.matches.every((m) => !m.path.startsWith('data') && m.path !== 'config.json'));
});

test('symlinks, hard links and FIFOs are refused', { skip: !POSIX && 'POSIX file types' }, (t) => {
  const { root, outside } = workspace(t);
  fs.symlinkSync(outside, path.join(root, 'link.txt'));
  fs.symlinkSync(path.dirname(outside), path.join(root, 'linkdir'));
  fs.linkSync(outside, path.join(root, 'hard.txt'));
  let fifo = false;
  try { execFileSync('mkfifo', [path.join(root, 'pipe')], { env: isolatedEnv() }); fifo = true; } catch {}
  const tools = createReadOnlyTools({ cwd: root });
  assert.equal(run(tools, 'read_file', { path: 'link.txt', offset: null, length: null }).value.error, 'path_denied');
  assert.equal(run(tools, 'read_file', { path: 'linkdir/outside.txt', offset: null, length: null }).value.error, 'path_denied');
  assert.equal(run(tools, 'list_dir', { path: 'linkdir' }).value.error, 'path_denied');
  assert.equal(run(tools, 'read_file', { path: 'hard.txt', offset: null, length: null }).value.error, 'path_denied');
  if (fifo) assert.equal(run(tools, 'read_file', { path: 'pipe', offset: null, length: null }).value.error, 'path_denied');
  const found = run(tools, 'search', { query: 'outside needle', path: null }).value;
  assert.deepEqual(found.matches, []);
  const names = run(tools, 'list_dir', { path: null }).value.entries.map((e) => e.name);
  for (const hidden of ['link.txt', 'linkdir', 'hard.txt', 'pipe']) assert.ok(!names.includes(hidden), hidden);
});

test('an ancestor swapped for a symlink between check and open is refused', { skip: !POSIX && 'POSIX symlinks' }, (t) => {
  const { base, root } = workspace(t);
  const evil = path.join(base, 'evil'); fs.mkdirSync(path.join(evil, 'deep'), { recursive: true });
  fs.writeFileSync(path.join(evil, 'deep', 'b.txt'), 'stolen');
  let swapped = false;
  const tools = createReadOnlyTools({ cwd: root, hooks: { afterValidate() {
    if (swapped) return;
    swapped = true;
    fs.renameSync(path.join(root, 'src'), path.join(base, 'src-moved'));
    fs.symlinkSync(evil, path.join(root, 'src'));
  } } });
  const r = run(tools, 'read_file', { path: 'src/deep/b.txt', offset: null, length: null });
  assert.equal(r.isError, true); assert.equal(r.value.error, 'path_changed');
  assert.ok(!r.output.includes('stolen'));
});

test('an ancestor replaced by a different directory is refused', (t) => {
  const { base, root } = workspace(t);
  let swapped = false;
  const tools = createReadOnlyTools({ cwd: root, hooks: { afterValidate() {
    if (swapped) return;
    swapped = true;
    fs.renameSync(path.join(root, 'src'), path.join(base, 'src-moved'));
    fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'deep', 'b.txt'), 'replaced');
  } } });
  const r = run(tools, 'read_file', { path: 'src/deep/b.txt', offset: null, length: null });
  assert.equal(r.value.error, 'path_changed');
});

test('workspace identity change is fatal, not a tool error', (t) => {
  const { base, root } = workspace(t);
  const tools = createReadOnlyTools({ cwd: root });
  fs.renameSync(root, path.join(base, 'moved'));
  fs.mkdirSync(root);
  assert.throws(() => tools.execute('list_dir', { path: null }), { code: 'cwd_identity_changed' });
  let calls = 0;
  const guarded = createReadOnlyTools({ cwd: root, revalidateCwd() { calls++; throw Object.assign(new Error('gone'), { code: 'cwd_identity_changed' }); } });
  assert.throws(() => guarded.execute('search', { query: 'x', path: null }), { code: 'cwd_identity_changed' });
  assert.equal(calls, 1);
});

test('credential values are redacted from tool output', (t) => {
  const { root } = workspace(t);
  const key = 'sk-test-abcdefghijklmnop';
  fs.writeFileSync(path.join(root, 'leak.txt'), `token is ${key} ok\n`);
  const tools = createReadOnlyTools({ cwd: root });
  const r = tools.execute('read_file', { path: 'leak.txt', offset: null, length: null }, { secrets: [key] });
  assert.ok(!r.output.includes(key)); assert.equal(JSON.parse(r.output).error, 'credential_present');
  // Output redaction remains a second layer, e.g. for a credential echoed in an error message.
  assert.equal(redactSecrets(`echo ${key}`, [key]), `echo ${REDACTED}`);
  const s = tools.execute('search', { query: 'token is', path: null }, { secrets: [key] });
  assert.ok(!s.output.includes(key));
  assert.equal(redactSecrets('short abc', ['abc']), 'short abc');
});

const KEY = 'sk-Zq7vX2pLm9Wt4Rb8Kd3Nf6Hj1Yc5Gs0Qe';
const PAGE = 256 * 1024;
// Every key fragment long enough to be meaningful, so a partial leak is caught.
function assertNoFragment(text, key = KEY) {
  for (let len = 6; len <= key.length; len++) {
    for (let i = 0; i + len <= key.length; i++) assert.ok(!text.includes(key.slice(i, i + len)), `fragment ${key.slice(i, i + len)}`);
  }
}

test('read_file refuses a file holding the credential even when the key straddles the 256 KiB page edge', (t) => {
  const { root } = workspace(t);
  const body = Buffer.alloc(2 * PAGE + 17, 'a');
  const at = PAGE - 11;
  Buffer.from(KEY).copy(body, at);
  fs.writeFileSync(path.join(root, 'big.txt'), body);
  const tools = createReadOnlyTools({ cwd: root });
  for (const [offset, length] of [[0, PAGE], [PAGE, PAGE], [at, 5], [at + KEY.length, 10], [2 * PAGE, null], [null, null]]) {
    const r = run(tools, 'read_file', { path: 'big.txt', offset, length }, [KEY]);
    assert.equal(r.isError, true, `${offset}/${length}`); assert.equal(r.value.error, 'credential_present');
    assertNoFragment(r.output);
  }
  // Without a configured credential the same pages read exactly, from the scanned pass.
  const left = run(tools, 'read_file', { path: 'big.txt', offset: 0, length: PAGE });
  const right = run(tools, 'read_file', { path: 'big.txt', offset: PAGE, length: PAGE });
  assert.equal(left.value.content + right.value.content, body.subarray(0, 2 * PAGE).toString());
  assert.equal(left.value.length, PAGE); assert.equal(right.value.eof, false);
});

test('search checks the whole file before line splitting, the 300-character cut and the query', (t) => {
  const { root } = workspace(t);
  fs.writeFileSync(path.join(root, 'long.txt'), `marker ${'x'.repeat(400)}${KEY} tail\nmarker plain\n`);
  fs.writeFileSync(path.join(root, 'clean.txt'), 'marker clean\n');
  const tools = createReadOnlyTools({ cwd: root });
  const s = run(tools, 'search', { query: 'marker', path: null }, [KEY]);
  assert.deepEqual(s.value.matches.map((m) => m.path), ['clean.txt']);
  assert.equal(s.output.includes('long.txt'), false); assertNoFragment(s.output);
  // A prefix query cannot confirm the key: the result is the same as for absent text.
  const baseline = run(tools, 'search', { query: 'zz-absent-text', path: null }, [KEY]).value;
  for (const query of [KEY.slice(0, 8), KEY.slice(0, KEY.length - 1), KEY.slice(4, 20)]) {
    const probe = run(tools, 'search', { query, path: null }, [KEY]);
    assert.deepEqual(probe.value.matches, [], query);
    assert.deepEqual({ ...probe.value, query: null }, { ...baseline, query: null }, query);
  }
  assert.equal(s.value.skipped, baseline.skipped);
  assert.equal(run(tools, 'read_file', { path: 'long.txt', offset: 0, length: 300 }, [KEY]).value.error, 'credential_present');
  // Ordinary files are unaffected when a credential is configured.
  assert.equal(run(tools, 'read_file', { path: 'README.md', offset: null, length: null }, [KEY]).value.content, 'hello world\nsecond line needle\n');
  assert.deepEqual(run(tools, 'search', { query: 'needle', path: null }, [KEY]).value.matches.map((m) => m.path).sort(),
    ['README.md', 'src/a.js', 'src/deep/b.txt']);
});

test('a file that changes or shrinks during the credential scan is refused, not shown', (t) => {
  const { root } = workspace(t);
  const file = path.join(root, 'moving.txt');
  const reset = () => fs.writeFileSync(file, Buffer.alloc(2 * PAGE + 5, 'b'));
  const mutations = {
    grow: () => fs.appendFileSync(file, 'more'),
    shrink: () => fs.truncateSync(file, PAGE + 3),
    rewrite: () => { const fd = fs.openSync(file, 'r+'); fs.writeSync(fd, 'c', 0); fs.closeSync(fd); fs.utimesSync(file, new Date(), new Date(Date.now() + 5000)); },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    for (const tool of ['read_file', 'search']) {
      reset();
      let fired = 0;
      const tools = createReadOnlyTools({ cwd: root, hooks: { afterScanChunk(abs, position) { if (abs === file && position === PAGE && !fired++) mutate(); } } });
      const input = tool === 'read_file' ? { path: 'moving.txt', offset: 0, length: 16 } : { query: 'b', path: 'moving.txt' };
      const r = run(tools, tool, input, [KEY]);
      assert.equal(fired, 1, `${name}/${tool}`);
      if (tool === 'read_file') {
        assert.equal(r.isError, true, name); assert.ok(['path_changed', 'read_incomplete'].includes(r.value.error), `${name}: ${r.value.error}`);
        assert.equal(r.output.includes('bbbb'), false);
      } else {
        assert.deepEqual(r.value.matches, [], name); assert.equal(r.value.skipped, 1, name);
      }
    }
  }
});
