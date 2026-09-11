'use strict';
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const dns = require('node:dns').promises;
const { POLICY, isPublicAddress, addressKey } = require('./public-address');

// Deliberately fixed, exact endpoints. These transport policies DO NOT qualify
// a native adapter's inference/auth/runtime behavior inside the boundary.
const POLICIES = Object.freeze({
  claude_subscription_candidate_v1: Object.freeze(['api.anthropic.com', 'claude.ai', 'platform.claude.com']),
  codex_subscription_candidate_v1: Object.freeze(['chatgpt.com', 'auth.openai.com']),
});
const LIMITS = Object.freeze({ maxConnections: 32, maxHeaderBytes: 8192, maxHeadBytes: 65536,
  headerTimeoutMs: 3000, connectTimeoutMs: 5000, resolveTimeoutMs: 5000, maxPinAgeMs: 3600000 });
const bindings = new WeakMap();
const error = code => Object.assign(new Error(code), { code });
function limitsFor(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !(k in LIMITS))) throw error('CONNECT_LIMIT_INVALID');
  const result = { ...LIMITS, ...input };
  if (Object.entries(result).some(([k, n]) => !Number.isSafeInteger(n) || n < 1 || n > LIMITS[k])) throw error('CONNECT_LIMIT_INVALID');
  return result;
}
function parseConnect(bytes, approvedHosts) {
  if (bytes.some(byte => byte > 126 || (byte < 32 && ![13, 10].includes(byte)))) throw error('invalid_header');
  const lines = bytes.toString('ascii').split('\r\n');
  if (lines.pop() !== '' || lines.pop() !== '') throw error('invalid_header');
  const match = /^CONNECT ([A-Za-z0-9.-]+):443 HTTP\/1\.1$/.exec(lines.shift() || '');
  if (!match) throw error('invalid_authority');
  const host = match[1].toLowerCase();
  if (!approvedHosts.includes(host)) throw error('destination_denied');
  let hostCount = 0;
  for (const line of lines) {
    const header = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+): *([\x20-\x7e]*)$/.exec(line);
    if (!header) throw error('invalid_header');
    const key = header[1].toLowerCase();
    if (['content-length', 'transfer-encoding', 'upgrade', 'proxy-authorization'].includes(key)) throw error('invalid_header');
    if (key === 'host' && (++hostCount !== 1 || header[2].toLowerCase() !== host + ':443')) throw error('invalid_header');
  }
  if (hostCount !== 1) throw error('invalid_header');
  return host;
}
function deadline(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(error('CONNECT_DNS_UNCONFIRMED')), ms); })])
    .finally(() => clearTimeout(timer));
}
async function createConnectBroker({ directory, policyId, limits: inputLimits,
  lookup = (host, options) => dns.lookup(host, options), connectLiteral = options => net.createConnection(options),
  networkInterfaces = os.networkInterfaces, now = Date.now } = {}) {
  if (process.platform !== 'linux') throw error('CONNECT_PLATFORM_UNSUPPORTED');
  const hosts = POLICIES[policyId]; if (!hosts) throw error('CONNECT_POLICY_UNSUPPORTED');
  const limits = limitsFor(inputLimits), local = new Set();
  for (const entries of Object.values(networkInterfaces())) for (const entry of entries || []) {
    const key = addressKey(entry.address); if (key) local.add(key);
  }
  const pinned = new Map();
  for (const host of hosts) {
    const answers = await deadline(Promise.resolve().then(() => lookup(host, { all: true, verbatim: true })), limits.resolveTimeoutMs);
    if (!Array.isArray(answers) || !answers.length || answers.length > 8) throw error('CONNECT_DNS_UNCONFIRMED');
    for (const answer of answers) {
      if (!answer || ![4, 6].includes(answer.family) || net.isIP(answer.address) !== answer.family
        || !isPublicAddress(answer.address) || local.has(addressKey(answer.address))) throw error('CONNECT_ADDRESS_DENIED');
    }
    // One immutable literal per hostname for this run; there is no re-resolution,
    // hostname fallback, inherited proxy, or host-network fallback at connect.
    pinned.set(host, Object.freeze({ ...answers.find(x => x.family === 4) || answers[0] }));
  }
  const pinnedAt = now();
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.normalize(directory) !== directory
    || directory.includes('\0') || fs.realpathSync(directory) !== directory) throw error('CONNECT_DIRECTORY_UNTRUSTED');
  const anchor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const stat = fs.fstatSync(anchor, { bigint: true });
  if (stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o7777n) !== 0o700n) { fs.closeSync(anchor); throw error('CONNECT_DIRECTORY_UNTRUSTED'); }
  const address = path.join(directory, 'broker.sock'), listenAddress = '/proc/self/fd/' + anchor + '/broker.sock';
  const sockets = new Set(), upstreams = new Set();
  let closing = false, closePromise = null;
  const counts = { connections: 0, accepted: 0, denied: 0, upstreamErrors: 0 };
  const reasons = Object.create(null);
  const recordDenial = reason => { counts.denied++; reasons[reason] = (reasons[reason] || 0) + 1; };
  const server = net.createServer({ allowHalfOpen: true }, client => {
    counts.connections++;
    if (closing || sockets.size >= limits.maxConnections) { recordDenial('connection_limit'); client.end('HTTP/1.1 503 Unavailable\r\nConnection: close\r\n\r\n', () => client.destroy()); return; }
    sockets.add(client);
    let header = Buffer.alloc(0), upstream = null, connectTimer = null, phase = 'header';
    const reject = reason => {
      if (phase === 'rejected' || phase === 'closed') return;
      const wasTunnel = phase === 'tunnel';
      phase = 'rejected'; recordDenial(reason); clearTimeout(connectTimer); upstream?.destroy();
      if (wasTunnel) return client.destroy();
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n', () => client.destroy());
    };
    client.on('error', () => { upstream?.destroy(); });
    client.on('close', () => { phase = 'closed'; clearTimeout(connectTimer); sockets.delete(client); upstream?.destroy(); });
    client.setTimeout(limits.headerTimeoutMs, () => reject('header_timeout'));
    const receive = chunk => {
      if (phase !== 'header') return;
      if (header.length + chunk.length > limits.maxHeaderBytes + limits.maxHeadBytes) return reject('header_limit');
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf('\r\n\r\n');
      if (end < 0) { if (header.length > limits.maxHeaderBytes) reject('header_limit'); return; }
      if (end + 4 > limits.maxHeaderBytes) return reject('header_limit');
      const head = header.subarray(end + 4); if (head.length > limits.maxHeadBytes) return reject('head_limit');
      let host;
      try { host = parseConnect(header.subarray(0, end + 4), hosts); }
      catch (failure) { return reject(['invalid_header', 'invalid_authority', 'destination_denied'].includes(failure.code) ? failure.code : 'invalid_header'); }
      if (now() - pinnedAt < 0 || now() - pinnedAt > limits.maxPinAgeMs) return reject('pin_expired');
      phase = 'connecting'; client.pause(); client.removeListener('data', receive); client.setTimeout(0);
      const target = pinned.get(host);
      try { upstream = connectLiteral({ host: target.address, port: 443, family: target.family,
        lookup: () => { throw error('CONNECT_RERESOLUTION_FORBIDDEN'); }, allowHalfOpen: true }); }
      catch { counts.upstreamErrors++; return reject('upstream_unavailable'); }
      upstreams.add(upstream);
      connectTimer = setTimeout(() => reject('connect_timeout'), limits.connectTimeoutMs);
      upstream.once('close', () => { upstreams.delete(upstream); clearTimeout(connectTimer); if (['connecting', 'tunnel'].includes(phase)) client.destroy(); });
      upstream.once('error', () => { counts.upstreamErrors++; reject('upstream_unavailable'); });
      upstream.once('connect', () => {
        clearTimeout(connectTimer);
        if (closing || client.destroyed || phase !== 'connecting') return upstream.destroy();
        if (addressKey(upstream.remoteAddress) !== addressKey(target.address) || upstream.remotePort !== 443) return reject('remote_mismatch');
        phase = 'tunnel'; counts.accepted++; header = null;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client); client.pipe(upstream); client.resume();
      });
    };
    client.on('data', receive);
  });
  // Listener errors never include user-supplied headers or payloads in telemetry.
  server.on('error', () => {});
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(listenAddress, () => { server.removeListener('error', reject); resolve(); }); });
    fs.chmodSync(address, 0o600);
    const named = fs.statSync(directory, { bigint: true });
    if (named.dev !== stat.dev || named.ino !== stat.ino || fs.realpathSync(directory) !== directory) throw error('CONNECT_DIRECTORY_CHANGED');
  } catch (failure) { server.close(); fs.closeSync(anchor); throw failure; }
  const socketStat = fs.lstatSync(address, { bigint: true });
  const handle = Object.freeze({ address, policyId,
    snapshot: () => ({ policyId, addressPolicy: POLICY, nativeQualified: false, ...counts,
      activeConnections: sockets.size, activeTunnels: upstreams.size, deniedReasons: { ...reasons } }),
    close() {
      if (closePromise) return closePromise;
      closing = true;
      for (const socket of sockets) socket.destroy();
      for (const socket of upstreams) socket.destroy();
      closePromise = new Promise(resolve => server.close(() => { fs.closeSync(anchor); resolve(); }));
      return closePromise;
    },
  });
  bindings.set(handle, () => {
    if (closing || !server.listening) throw error('CONNECT_BROKER_UNAVAILABLE');
    const current = fs.lstatSync(address, { bigint: true });
    const parent = fs.statSync(directory, { bigint: true });
    if (fs.realpathSync(directory) !== directory || parent.dev !== stat.dev || parent.ino !== stat.ino
      || parent.uid !== stat.uid || (parent.mode & 0o7777n) !== 0o700n || !current.isSocket()
      || current.dev !== socketStat.dev || current.ino !== socketStat.ino
      || current.uid !== stat.uid || (current.mode & 0o7777n) !== 0o600n || current.nlink !== 1n) throw error('CONNECT_BROKER_IDENTITY_CHANGED');
    return Object.freeze({ address, policyId });
  });
  return handle;
}
function assertConnectBroker(handle) {
  const binding = bindings.get(handle);
  if (!binding) throw error('CONNECT_BROKER_UNTRUSTED');
  try { return binding(); } catch (failure) {
    if (failure.code?.startsWith('CONNECT_')) throw failure;
    throw error('CONNECT_BROKER_UNAVAILABLE');
  }
}
module.exports = { POLICIES, LIMITS, parseConnect, createConnectBroker, assertConnectBroker };
