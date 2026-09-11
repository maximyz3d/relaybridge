'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { Duplex } = require('node:stream');
const { isPublicAddress, addressKey } = require('../lib/public-address');
const { POLICIES, parseConnect, createConnectBroker } = require('../lib/connect-broker');
const linuxTest = process.platform === 'linux' ? test : test.skip;
const request = (host = 'chatgpt.com') => `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`;
class Echo extends Duplex {
  constructor(options, remoteAddress = options.host) { super({ allowHalfOpen: true }); this.remoteAddress = remoteAddress; this.remotePort = 443; queueMicrotask(() => this.emit('connect')); }
  _read() {}
  _write(chunk, encoding, done) { this.push(Buffer.from('echo:' + chunk)); done(); }
  _final(done) { this.push(null); done(); }
}
async function fixture(t, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-broker-test-')); fs.chmodSync(directory, 0o700);
  const lookups = [], dials = [];
  const options = { directory, policyId: 'codex_subscription_candidate_v1', networkInterfaces: () => ({}),
    lookup: async host => { lookups.push(host); return [{ address: '8.8.8.8', family: 4 }]; },
    connectLiteral: options => { dials.push(options); return new Echo(options); }, ...extra };
  const broker = await createConnectBroker(options);
  t.after(async () => { await broker.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { broker, lookups, dials };
}
function exchange(address, bytes, { afterConnect = '', end = true } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: address, allowHalfOpen: true }); let output = '', sent = false;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('fixture exchange timeout')); }, 2000);
    socket.on('error', reject);
    socket.on('connect', () => { socket.write(bytes); if (end && !afterConnect) socket.end(); });
    socket.on('data', chunk => {
      output += chunk;
      if (!sent && afterConnect && output.includes('200 Connection Established')) { sent = true; socket.end(afterConnect); }
    });
    socket.on('end', () => socket.end());
    socket.on('close', () => { clearTimeout(timer); resolve(output); });
  });
}

test('public address policy excludes special, ambiguous and transition forms', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(address), true, address);
  for (const address of ['0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.31.1.1',
    '192.0.0.9', '192.168.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.1.1.1', '255.255.255.255',
    '127.1', '0177.0.0.1', '0x7f000001', '2130706433', '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8',
    '64:ff9b::808:808', '2001::1', '2001:db8::1', '2002:0808:0808::1', '3fff::1', 'fc00::1', 'fe80::1', 'fe80::1%eth0', 'ff02::1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(addressKey('2001:4860::1'), addressKey('2001:4860:0:0:0:0:0:1'));
});
test('CONNECT parsing accepts exact approved authority only', () => {
  assert.equal(parseConnect(Buffer.from(request('CHATGPT.COM')), POLICIES.codex_subscription_candidate_v1), 'chatgpt.com');
  for (const text of [request('chatgpt.com.'), request('chatgpt.com.attacker.test'), request('127.0.0.1'), request('2130706433'),
    request('chatgpt.com@evil.test'), request('chatgpt.com%00'), 'GET / HTTP/1.1\r\nHost: chatgpt.com\r\n\r\n',
    request().replace(':443', ':8443'), request().replace('\r\n\r\n', '\r\nHost: chatgpt.com:443\r\n\r\n'),
    request().replace('\r\n\r\n', '\r\nContent-Length: 1\r\n\r\n'), request().replace('\r\n\r\n', '\r\nProxy-Authorization: SECRET\r\n\r\n'),
    request().replace('Host:', ' Host:'), request().replace('Host: chatgpt.com', 'Host: auth.openai.com')]) assert.throws(() => parseConnect(Buffer.from(text), POLICIES.codex_subscription_candidate_v1), text);
});
linuxTest('pinned public literal connects without a second lookup; head and half-close survive', async t => {
  const f = await fixture(t);
  const first = await exchange(f.broker.address, request(), { afterConnect: 'one' });
  assert.match(first, /200 Connection Established/); assert.match(first, /echo:one/);
  const second = await exchange(f.broker.address, request() + 'two');
  assert.match(second, /echo:two/);
  assert.deepEqual(f.lookups, ['chatgpt.com', 'auth.openai.com']);
  assert.equal(f.dials.length, 2);
  for (const dial of f.dials) { assert.equal(dial.host, '8.8.8.8'); assert.equal(dial.port, 443); assert.equal(dial.family, 4); assert.throws(() => dial.lookup(), { code: 'CONNECT_RERESOLUTION_FORBIDDEN' }); }
});
linuxTest('private, mixed and local-interface DNS answers refuse before listening/dialing', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-broker-deny-')); fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const answers of [[{ address: '127.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }], [{ address: '::ffff:8.8.8.8', family: 6 }], []]) {
    await assert.rejects(createConnectBroker({ directory, policyId: 'codex_subscription_candidate_v1', lookup: async () => answers,
      connectLiteral: () => assert.fail('must not dial') }), /CONNECT_/);
    assert.deepEqual(fs.readdirSync(directory), []);
  }
  await assert.rejects(createConnectBroker({ directory, policyId: 'codex_subscription_candidate_v1', lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    networkInterfaces: () => ({ eth0: [{ address: '8.8.8.8' }] }) }), { code: 'CONNECT_ADDRESS_DENIED' });
});
linuxTest('denied inputs never dial or retain raw headers/payload in telemetry', async t => {
  const f = await fixture(t, { limits: { maxHeaderBytes: 100, maxHeadBytes: 100 } });
  for (const input of [request('localhost'), 'GET /raw-secret-123 HTTP/1.1\r\nHost: chatgpt.com\r\n\r\n', 'x'.repeat(300)]) {
    assert.match(await exchange(f.broker.address, input), /403 Forbidden/);
  }
  assert.equal(f.dials.length, 0);
  assert.equal(f.broker.snapshot().denied, 3);
  assert.doesNotMatch(JSON.stringify(f.broker.snapshot()), /raw-secret|localhost|8\.8\.8\.8|CONNECT /);
});
linuxTest('expired DNS pins and mismatching remote identity fail closed', async t => {
  let now = 1000;
  const f = await fixture(t, { now: () => now, limits: { maxPinAgeMs: 10 } });
  now += 11; assert.match(await exchange(f.broker.address, request()), /403 Forbidden/); assert.equal(f.dials.length, 0);
  const other = await fixture(t, { connectLiteral: options => new Echo(options, '9.9.9.9') });
  const answer = await exchange(other.broker.address, request()); assert.doesNotMatch(answer, /200 Connection Established/);
  assert.equal(other.broker.snapshot().deniedReasons.remote_mismatch, 1);
});
linuxTest('broker cancellation closes active tunnels and incomplete headers', async t => {
  const f = await fixture(t);
  const client = net.createConnection(f.broker.address); client.on('error', () => {});
  await new Promise(resolve => client.once('connect', resolve)); client.write('CON');
  await f.broker.close();
  await new Promise(resolve => client.destroyed ? resolve() : client.once('close', resolve));
  assert.equal(f.broker.snapshot().activeConnections, 0);
  await f.broker.close();
});
