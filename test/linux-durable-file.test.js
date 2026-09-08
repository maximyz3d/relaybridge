'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { openLinuxDurableDirectory, DurableFileError, MAX_BYTES, MAX_WRITE_CALLS } = require('../lib/linux-durable-file');

const native = process.platform === 'linux';
const run = (name, fn) => test(name, { skip: !native }, fn);
const ioError = (code = 'EIO') => Object.assign(new Error('injected private diagnostic must not escape'), { code });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-durable-file-'));
  const calls = [], descriptors = new Map(), state = { fault: () => {}, after: () => {}, writeSize: null };
  const api = new Proxy(fs, { get(target, key) {
    const original = target[key];
    if (typeof original !== 'function') return original;
    return (...args) => {
      const event = { method: key, directory: typeof args[0] === 'number' ? descriptors.get(args[0])?.directory : false,
        path: typeof args[0] === 'string' ? args[0] : descriptors.get(args[0])?.path, args };
      calls.push(event);
      state.fault(event);
      if (key === 'writeSync' && state.writeSize !== null) args[3] = Math.min(args[3], state.writeSize);
      const value = original.apply(target, args);
      if (key === 'openSync') descriptors.set(value, { directory: fs.fstatSync(value).isDirectory(), path: args[0] });
      if (key === 'closeSync') descriptors.delete(args[0]);
      state.after(event, value);
      return value;
    };
  } });
  const handles = [];
  function open() { const handle = openLinuxDurableDirectory({ directory: root, fsApi: api }); handles.push(handle); return handle; }
  t.after(() => {
    state.fault = () => {}; state.after = () => {};
    for (const handle of handles) handle.close();
    for (const fd of descriptors.keys()) { try { fs.closeSync(fd); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, calls, state, api, open, handles };
}

function failed(fn, expected) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof DurableFileError);
    for (const [key, value] of Object.entries(expected)) assert.equal(error.details[key], value, key);
    assert.equal(error.message.includes('private diagnostic'), false);
    assert.ok(Object.isFrozen(error.details));
    return true;
  });
}

run('exclusive publish and atomic replacement confirm file then directory durability', (t) => {
  const f = fixture(t), handle = f.open(); f.calls.length = 0;
  assert.deepEqual(handle.createExclusive('attempt.json', 'first'), {
    publication: 'published', durability: 'confirmed', cleanupPending: false, cleanupError: null,
  });
  assert.deepEqual(f.calls.map((x) => x.method), ['openSync', 'fchmodSync', 'fstatSync', 'writeSync', 'fsyncSync', 'closeSync', 'linkSync', 'fsyncSync', 'unlinkSync']);
  assert.equal(f.calls[4].directory, false); assert.equal(f.calls[7].directory, true);
  assert.equal(fs.statSync(path.join(f.root, 'attempt.json')).mode & 0o777, 0o600);
  handle.replaceAtomic('attempt.json', 'second');
  assert.equal(fs.readFileSync(path.join(f.root, 'attempt.json'), 'utf8'), 'second');
  assert.deepEqual(fs.readdirSync(f.root), ['attempt.json']);
  assert.equal(f.calls.filter((x) => x.method === 'unlinkSync').some((x) => x.path.endsWith('/attempt.json')), false);
});

run('exclusive conflict preserves canonical bytes and removes only its own temporary link', (t) => {
  const f = fixture(t), handle = f.open(); handle.createExclusive('attempt.json', 'original');
  failed(() => handle.createExclusive('attempt.json', 'replacement'), {
    stage: 'publish_exclusive', publication: 'conflict', durability: 'unconfirmed', errno: 'EEXIST',
  });
  assert.equal(fs.readFileSync(path.join(f.root, 'attempt.json'), 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(f.root), ['attempt.json']);
});

for (const [method, stage] of [['openSync', 'temp_create'], ['fchmodSync', 'temp_mode'], ['fstatSync', 'temp_mode'], ['writeSync', 'file_write'], ['fsyncSync', 'file_sync'], ['closeSync', 'file_close']]) {
  run(`prepublication ${stage} failure never publishes or masks the original error`, (t) => {
    const f = fixture(t), handle = f.open();
    let fired = false;
    // Inject close failure after its real syscall: Linux must not retry close.
    const inject = (e) => { if (!fired && e.method === method && !e.directory) { fired = true; throw ioError(); } };
    if (method === 'closeSync') f.state.after = inject; else f.state.fault = inject;
    failed(() => handle.createExclusive('attempt.json', 'bounded'), {
      stage, publication: 'not_attempted', durability: 'unconfirmed', errno: 'EIO',
    });
    assert.equal(fs.existsSync(path.join(f.root, 'attempt.json')), false);
    assert.deepEqual(fs.readdirSync(f.root), []);
    assert.equal(f.calls.filter((e) => e.method === 'closeSync' && !e.directory).length, method === 'openSync' ? 0 : 1);
  });
}

for (const exclusive of [true, false]) {
  for (const code of ['EIO', 'ENOSPC', 'EINVAL']) {
    run(`${exclusive ? 'exclusive' : 'replacement'} publication remains visible when directory sync fails ${code}`, (t) => {
      const f = fixture(t), handle = f.open();
      if (!exclusive) handle.createExclusive('attempt.json', 'original');
      f.state.fault = (e) => { if (e.method === 'fsyncSync' && e.directory) throw ioError(code); };
      failed(() => handle[exclusive ? 'createExclusive' : 'replaceAtomic']('attempt.json', 'published'), {
        stage: 'directory_sync', publication: 'published', durability: 'unconfirmed', errno: code,
      });
      assert.equal(fs.readFileSync(path.join(f.root, 'attempt.json'), 'utf8'), 'published');
      assert.deepEqual(fs.readdirSync(f.root), ['attempt.json']);
    });
  }
  for (const afterPublish of [false, true]) {
    run(`${exclusive ? 'link' : 'rename'} throwing ${afterPublish ? 'after' : 'before'} publication retains uncertainty without rollback`, (t) => {
      const f = fixture(t), handle = f.open();
      if (!exclusive) handle.createExclusive('attempt.json', 'original');
      const method = exclusive ? 'linkSync' : 'renameSync';
      f.state[afterPublish ? 'after' : 'fault'] = (e) => { if (e.method === method) throw ioError(); };
      failed(() => handle[exclusive ? 'createExclusive' : 'replaceAtomic']('attempt.json', 'next'), {
        stage: exclusive ? 'publish_exclusive' : 'publish_replace', publication: 'unknown', durability: 'unconfirmed', errno: 'EIO',
      });
      const canonical = path.join(f.root, 'attempt.json');
      assert.equal(fs.existsSync(canonical), !exclusive || afterPublish);
      if (fs.existsSync(canonical)) assert.equal(fs.readFileSync(canonical, 'utf8'), afterPublish ? 'next' : 'original');
      assert.equal(f.calls.some((e) => e.method === 'unlinkSync' && e.path.endsWith('/attempt.json')), false);
    });
  }
}

run('cleanup failure after confirmation preserves confirmed durability; prior errors keep precedence', (t) => {
  const f = fixture(t), handle = f.open();
  f.state.fault = (e) => { if (e.method === 'unlinkSync') throw ioError('EPERM'); };
  assert.deepEqual(handle.createExclusive('attempt.json', 'committed'), {
    publication: 'published', durability: 'confirmed', cleanupPending: true, cleanupError: 'EPERM',
  });
  f.state.fault = (e) => {
    if (e.method === 'unlinkSync') throw ioError('EPERM');
    if (e.method === 'writeSync') throw ioError('ENOSPC');
  };
  failed(() => handle.createExclusive('other.json', 'not committed'), {
    stage: 'file_write', errno: 'ENOSPC', cleanupPending: true, cleanupError: 'EPERM', publication: 'not_attempted',
  });
  assert.equal(fs.readFileSync(path.join(f.root, 'attempt.json'), 'utf8'), 'committed');
  assert.equal(fs.existsSync(path.join(f.root, 'other.json')), false);
});

run('short writes finish exactly; zero progress and excessive write calls fail before publication', (t) => {
  const f = fixture(t), handle = f.open(); f.state.writeSize = 2;
  handle.createExclusive('short.json', 'abcdefg');
  assert.equal(fs.readFileSync(path.join(f.root, 'short.json'), 'utf8'), 'abcdefg');
  f.state.writeSize = 0;
  failed(() => handle.createExclusive('zero.json', 'x'), { stage: 'file_write', errno: 'WRITE_NO_PROGRESS', publication: 'not_attempted' });
  f.state.writeSize = 1;
  failed(() => handle.createExclusive('many.json', Buffer.alloc(MAX_WRITE_CALLS + 1)), { errno: 'WRITE_LIMIT', publication: 'not_attempted' });
});

run('bounds and private directory/target validation reject before publication', (t) => {
  const f = fixture(t), handle = f.open();
  for (const name of ['../bad', 'a/b', '.', 'a..b', '', 'x'.repeat(129)]) assert.throws(() => handle.createExclusive(name, 'x'), TypeError);
  for (const input of [null, {}, Buffer.alloc(MAX_BYTES + 1), 'é'.repeat(MAX_BYTES)]) {
    assert.throws(() => handle.createExclusive('bounded.json', input), TypeError);
  }
  failed(() => handle.replaceAtomic('absent.json', 'x'), { stage: 'target_validate', publication: 'not_attempted', errno: 'ENOENT' });
  const link = path.join(f.root, 'linked'); fs.symlinkSync(f.root, link);
  failed(() => openLinuxDurableDirectory({ directory: link }), { stage: 'directory_open', publication: 'not_attempted' });
  for (const directory of [link + '/', link + '/.', f.root + '//', f.root + '/x/..', '/']) {
    assert.throws(() => openLinuxDurableDirectory({ directory }), TypeError);
  }
  fs.chmodSync(f.root, 0o755);
  failed(() => openLinuxDurableDirectory({ directory: f.root }), { stage: 'directory_validate', errno: 'UNTRUSTED_DIRECTORY' });
  fs.chmodSync(f.root, 0o700);
  fs.symlinkSync('absent', path.join(f.root, 'target.json'));
  failed(() => handle.replaceAtomic('target.json', 'x'), { stage: 'target_validate', errno: 'UNTRUSTED_TARGET' });
  assert.ok(fs.lstatSync(path.join(f.root, 'target.json')).isSymbolicLink());
});

run('child initialization syncs child and parent and leaves failed publications for explicit recovery', (t) => {
  const f = fixture(t), handle = f.open(); f.calls.length = 0;
  const child = handle.initializeChild('attempts'); f.handles.push(child);
  assert.deepEqual(f.calls.map((e) => e.method), ['mkdirSync', 'lstatSync', 'chmodSync', 'openSync', 'fstatSync', 'fsyncSync', 'fsyncSync']);
  assert.notEqual(f.calls[5].args[0], f.calls[6].args[0]);
  child.createExclusive('nested.json', 'durable');
  assert.equal(fs.readFileSync(path.join(f.root, 'attempts', 'nested.json'), 'utf8'), 'durable');
  let syncs = 0;
  f.state.fault = (e) => { if (e.method === 'fsyncSync' && ++syncs === 2) throw ioError(); };
  failed(() => handle.initializeChild('unconfirmed'), { stage: 'parent_directory_sync', publication: 'published', durability: 'unconfirmed' });
  assert.ok(fs.statSync(path.join(f.root, 'unconfirmed')).isDirectory());
  f.state.fault = () => {};
  const recovered = handle.initializeChild('unconfirmed'); f.handles.push(recovered);
  recovered.createExclusive('ready.json', 'after resync');
});

for (const [method, stage] of [['mkdirSync', 'directory_create'], ['lstatSync', 'child_directory_mode'],
  ['chmodSync', 'child_directory_mode'], ['openSync', 'child_directory_open'],
  ['fstatSync', 'child_directory_validate'], ['fsyncSync', 'child_directory_sync']]) {
  run(`child initialization surfaces ${method} failure without removing visible directories`, (t) => {
    const f = fixture(t), handle = f.open();
    f.state.fault = (e) => { if (e.method === method) throw ioError(); };
    failed(() => handle.initializeChild('child'), { stage, durability: 'unconfirmed', errno: 'EIO' });
    assert.equal(fs.existsSync(path.join(f.root, 'child')), method !== 'mkdirSync');
  });
}

run('pinned directory keeps writes in its original inode after pathname replacement', (t) => {
  const f = fixture(t), parent = f.open(), child = parent.initializeChild('original'); f.handles.push(child);
  fs.renameSync(path.join(f.root, 'original'), path.join(f.root, 'moved'));
  fs.mkdirSync(path.join(f.root, 'original'), { mode: 0o700 });
  child.createExclusive('attempt.json', 'pinned');
  assert.equal(fs.existsSync(path.join(f.root, 'original', 'attempt.json')), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'moved', 'attempt.json'), 'utf8'), 'pinned');
  assert.equal(child.close(), true); assert.equal(child.close(), false);
  assert.throws(() => child.createExclusive('closed.json', 'x'), /closed/);
});

run('two native processes publishing one exclusive intent have exactly one complete winner', async (t) => {
  const f = fixture(t);
  const script = `const {openLinuxDurableDirectory}=require(process.argv[1]);const h=openLinuxDurableDirectory({directory:process.argv[2]});
    try{h.createExclusive('intent.json',process.argv[3].repeat(4096));process.stdout.write('confirmed');}
    catch(e){process.stdout.write(e.details.publication);}finally{h.close();}`;
  const results = await Promise.all(['a', 'b'].map((value) => promisify(execFile)(process.execPath,
    ['-e', script, require.resolve('../lib/linux-durable-file'), f.root, value], { timeout: 10000, maxBuffer: 1024 })));
  assert.deepEqual(results.map((r) => r.stdout).sort(), ['confirmed', 'conflict']);
  assert.match(fs.readFileSync(path.join(f.root, 'intent.json'), 'utf8'), /^(?:a{4096}|b{4096})$/);
  assert.deepEqual(fs.readdirSync(f.root), ['intent.json']);
});

run('restrictive inherited umask cannot publish an unusable canonical file', async (t) => {
  const f = fixture(t);
  const script = `const fs=require('node:fs');const {openLinuxDurableDirectory}=require(process.argv[1]);
    process.umask(0o777);const h=openLinuxDurableDirectory({directory:process.argv[2]});
    try{h.createExclusive('intent.json','first');h.replaceAtomic('intent.json','next');
      process.stdout.write(JSON.stringify({mode:fs.statSync(process.argv[2]+'/intent.json').mode&0o777,bytes:fs.readFileSync(process.argv[2]+'/intent.json','utf8')}));}
    finally{h.close();}`;
  const result = await promisify(execFile)(process.execPath,
    ['-e', script, require.resolve('../lib/linux-durable-file'), f.root], { timeout: 10000, maxBuffer: 1024 });
  assert.deepEqual(JSON.parse(result.stdout), { mode: 0o600, bytes: 'next' });
});

run('restrictive inherited umask cannot leave a successfully initialized child unusable', async (t) => {
  const f = fixture(t);
  const script = `const fs=require('node:fs');const {openLinuxDurableDirectory}=require(process.argv[1]);
    process.umask(0o777);const h=openLinuxDurableDirectory({directory:process.argv[2]});let child;
    try{child=h.initializeChild('child');child.createExclusive('intent.json','first');child.close();
      child=h.initializeChild('child');child.replaceAtomic('intent.json','next');
      process.stdout.write(JSON.stringify({mode:fs.statSync(process.argv[2]+'/child').mode&0o777,
        bytes:fs.readFileSync(process.argv[2]+'/child/intent.json','utf8')}));}
    finally{if(child)child.close();h.close();}`;
  const result = await promisify(execFile)(process.execPath,
    ['-e', script, require.resolve('../lib/linux-durable-file'), f.root], { timeout: 10000, maxBuffer: 1024 });
  assert.deepEqual(JSON.parse(result.stdout), { mode: 0o700, bytes: 'next' });
});

run('existing children are validated without repairing permissions or following a leaf symlink', (t) => {
  const f = fixture(t), handle = f.open();
  const existing = path.join(f.root, 'existing'); fs.mkdirSync(existing, { mode: 0o755 });
  fs.chmodSync(existing, 0o755);
  fs.symlinkSync(existing, path.join(f.root, 'linked'));
  f.calls.length = 0;
  failed(() => handle.initializeChild('existing'), { stage: 'child_directory_validate', errno: 'UNTRUSTED_DIRECTORY' });
  failed(() => handle.initializeChild('linked'), { stage: 'child_directory_open' });
  assert.equal(fs.statSync(existing).mode & 0o777, 0o755);
  assert.equal(f.calls.some((e) => e.method === 'chmodSync'), false);
  fs.chmodSync(existing, 0o700); f.calls.length = 0;
  const child = handle.initializeChild('existing'); f.handles.push(child);
  assert.equal(f.calls.some((e) => e.method === 'chmodSync'), false);
});

run('an ambiguous mkdir failure leaves its visible child untouched and reports unknown publication', (t) => {
  const f = fixture(t), handle = f.open();
  f.state.after = (e) => { if (e.method === 'mkdirSync') throw ioError(); };
  f.calls.length = 0;
  failed(() => handle.initializeChild('uncertain'), {
    stage: 'directory_create', publication: 'unknown', durability: 'unconfirmed', errno: 'EIO',
  });
  assert.ok(fs.statSync(path.join(f.root, 'uncertain')).isDirectory());
  assert.equal(f.calls.some((e) => e.method === 'chmodSync'), false);
});

for (const code of ['EACCES', 'ENOSPC']) {
  for (const afterCreate of [false, true]) {
    run(`mkdir ${code} ${afterCreate ? 'after' : 'before'} effect retains unknown publication without errno inference`, (t) => {
      const f = fixture(t), handle = f.open(); f.calls.length = 0;
      f.state[afterCreate ? 'after' : 'fault'] = (e) => { if (e.method === 'mkdirSync') throw ioError(code); };
      failed(() => handle.initializeChild('candidate'), {
        stage: 'directory_create', publication: 'unknown', durability: 'unconfirmed', errno: code,
      });
      assert.equal(fs.existsSync(path.join(f.root, 'candidate')), afterCreate);
      assert.equal(f.calls.some((e) => ['chmodSync', 'unlinkSync', 'rmdirSync', 'fsyncSync'].includes(e.method)), false);
    });
  }
}

run('a failed directory close is not retried even if its descriptor number is reused', (t) => {
  const f = fixture(t), handle = f.open();
  let oldFd;
  f.state.after = (e) => { if (e.method === 'closeSync' && e.directory) { oldFd = e.args[0]; throw ioError(); } };
  assert.throws(() => handle.close(), { code: 'EIO' });
  const replacementFd = fs.openSync('/dev/null', 'r');
  try {
    assert.equal(replacementFd, oldFd, 'native fixture obtains the released descriptor');
    assert.equal(handle.close(), false);
    assert.ok(fs.fstatSync(replacementFd).isCharacterDevice());
    assert.throws(() => handle.initializeChild('closed'), /closed/);
  } finally { fs.closeSync(replacementFd); }
});

run('child cleanup close failure cannot mask failed parent durability', (t) => {
  const f = fixture(t), handle = f.open();
  let syncs = 0;
  f.state.fault = (e) => { if (e.method === 'fsyncSync' && ++syncs === 2) throw ioError('ENOSPC'); };
  f.state.after = (e) => { if (e.method === 'closeSync') throw ioError('EIO'); };
  failed(() => handle.initializeChild('child'), {
    stage: 'parent_directory_sync', publication: 'published', durability: 'unconfirmed',
    errno: 'ENOSPC', cleanupPending: true, cleanupError: 'EIO',
  });
  assert.ok(fs.statSync(path.join(f.root, 'child')).isDirectory());
});
