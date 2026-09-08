'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { Duplex } = require('node:stream');
const { framedPeer, createOwnerControl } = require('../lib/owner-control');
const { parseProcStat, pinLinuxNamespace, probeLinuxNamespace } = require('../lib/linux-owner-identity');

const tick = () => new Promise((resolve) => setImmediate(resolve));
function wire() { return new Duplex({ read() {}, write(_data, _encoding, done) { done(); } }); }
test('owner protocol frames bytes, bounds queues and rejects invalid UTF8/partial JSON', async () => {
  const socket = wire(), messages = [];
  const peer = framedPeer(socket, { onMessage: (message) => messages.push(message) });
  const frame = Buffer.from(JSON.stringify({ type: 'hello', text: 'bytes é 😀' }) + '\n');
  for (const byte of frame) socket.push(Buffer.of(byte));
  await tick(); assert.equal(messages[0].text, 'bytes é 😀');
  socket.push(Buffer.from('{"type":"other","bad":"')); socket.push(Buffer.from([255])); socket.push(Buffer.from('"}\n'));
  assert.equal((await peer.closed).code, 'OWNER_CONTROL_PROTOCOL');
  for (const [data, code] of [[Buffer.alloc(8193, 65), 'OWNER_CONTROL_FRAME_LIMIT'],
    [Buffer.from('{"type":"hello"}'), 'OWNER_CONTROL_TRUNCATED']]) {
    const stream = wire(), framed = framedPeer(stream);
    stream.push(data); stream.push(null);
    assert.equal((await framed.closed).code, code);
  }
  const blocked = wire();
  let release;
  const queued = framedPeer(blocked, { onMessage: () => new Promise((resolve) => { release = resolve; }) });
  blocked.push(Buffer.from(Array(12).fill('{"type":"hello"}\n').join('')));
  assert.equal((await queued.closed).code, 'OWNER_CONTROL_RATE_LIMIT'); release();
});

test('owner hello is single-use and cannot proceed after replay or wrong nonce', async (t) => {
  for (const wrong of [false, true]) {
    let messages = 0;
    const control = await createOwnerControl({ runId: 'run_protocol', onHello: () => true, onMessage: () => messages++ });
    t.after(() => control.dispose());
    const socket = net.createConnection(control.address);
    const peer = framedPeer(socket);
    const hello = { type: 'hello', version: 1, runId: 'run_protocol', nonce: wrong ? '0'.repeat(64) : control.nonce };
    await peer.send(hello);
    if (wrong) await assert.rejects(control.ready);
    else {
      await control.ready;
      await peer.send(hello);
    }
    await peer.closed;
    assert.equal(messages, 0);
    await assert.rejects(control.send({ type: 'proceed' }));
    await control.dispose();
  }
});

test('orderly EOF drains queued complete frames but bounds an unfinished handler', async () => {
  const socket = wire(), messages = [];
  let release;
  const peer = framedPeer(socket, { onMessage: async (message) => {
    messages.push(message.type);
    if (message.type === 'first') await new Promise((resolve) => { release = resolve; });
  } });
  socket.push(Buffer.from('{"type":"first"}\n{"type":"root_exit"}\n')); socket.push(null);
  await tick(); assert.deepEqual(messages, ['first']); release();
  assert.equal((await peer.closed).code, 'OWNER_CONTROL_EOF');
  assert.deepEqual(messages, ['first', 'root_exit']);
  const stuck = wire();
  const bounded = framedPeer(stuck, { onMessage: () => new Promise(() => {}), eofDrainTimeoutMs: 20 });
  // A ref'ed timer represents the surrounding attempt's liveness timer.
  const hold = setTimeout(() => {}, 1000);
  try {
    stuck.push(Buffer.from('{"type":"first"}\n')); stuck.push(null);
    assert.equal((await bounded.closed).code, 'OWNER_CONTROL_DRAIN_TIMEOUT');
  } finally { clearTimeout(hold); }
});

test('hello timeout is terminal, including a late connection and pending identity verification', async (t) => {
  let hellos = 0;
  const control = await createOwnerControl({ runId: 'run_late', helloTimeoutMs: 20, onHello: () => { hellos++; return true; } });
  t.after(() => control.dispose());
  await assert.rejects(control.ready, /HELLO_TIMEOUT/);
  const late = framedPeer(net.createConnection(control.address));
  late.send({ type: 'hello', version: 1, runId: 'run_late', nonce: control.nonce }).catch(() => {});
  await late.closed; assert.equal(hellos, 0);
  await assert.rejects(control.send({ type: 'proceed' }));

  let verify, started;
  const verifying = new Promise((resolve) => { started = resolve; });
  const pending = await createOwnerControl({ runId: 'run_pending', helloTimeoutMs: 50,
    onHello: () => { started(); return new Promise((resolve) => { verify = resolve; }); } });
  t.after(() => pending.dispose());
  const remote = framedPeer(net.createConnection(pending.address));
  await remote.send({ type: 'hello', version: 1, runId: 'run_pending', nonce: pending.nonce });
  await verifying;
  await assert.rejects(pending.send({ type: 'proceed' }), /not authenticated/);
  await assert.rejects(pending.ready, /HELLO_TIMEOUT/);
  verify(true); await tick();
  await assert.rejects(pending.send({ type: 'proceed' })); await remote.closed;
});

test('Linux owner identity handles hostile names, reuse, reboot and missing proof without signaling', () => {
  const stat = (pid, birth) => {
    const fields = Array(21).fill('0'); fields[0] = 'S'; fields[11] = '10'; fields[12] = '20'; fields[19] = String(birth);
    return `${pid} (name ) with spaces) ${fields.join(' ')}\n`;
  };
  assert.equal(parseProcStat(stat(123, 99)).starttime, '99');
  assert.equal(parseProcStat(stat(123, 99)).cpuTicks, 30n);
  let birth = 99, namespacePid = 1, currentBoot = 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12), error = null;
  const fsApi = { readFileSync(file) { if (file.endsWith('boot_id')) return currentBoot;
    if (file.endsWith('/status')) return `Name:\tfixture\nNSpid:\t123\t${namespacePid}\n`;
    if (error) throw Object.assign(new Error('injected'), { code: error }); return stat(123, birth); },
  statSync(file) { return { ino: file.includes('/self/') ? 7n : 8n }; } };
  const pin = pinLinuxNamespace(123, { fsApi });
  namespacePid = 2; assert.throws(() => pinLinuxNamespace(123, { fsApi }), /birth identity unproven/); namespacePid = 1;
  assert.equal(probeLinuxNamespace(pin, { fsApi }).state, 'alive');
  birth = 100; assert.equal(probeLinuxNamespace(pin, { fsApi }).evidence, 'birth_changed');
  birth = 99; error = 'EACCES'; assert.equal(probeLinuxNamespace(pin, { fsApi }).state, 'unverified');
  error = 'ENOENT'; assert.equal(probeLinuxNamespace(pin, { fsApi }).evidence, 'pid_absent');
  error = null; currentBoot = 'b'.repeat(8) + '-bbbb-bbbb-bbbb-' + 'b'.repeat(12);
  assert.equal(probeLinuxNamespace(pin, { fsApi }).evidence, 'boot_changed');
  assert.equal(probeLinuxNamespace({ ...pin, starttime: 'invalid' }, { fsApi }).state, 'unverified');
});
