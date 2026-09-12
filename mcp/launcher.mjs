// Persistent host stdio, replaceable MCP adapter. Builtins only: importing the
// SDK or adapter here would pin mutable installation code in the long-lived host.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ADAPTER = fileURLToPath(new URL('./server.mjs', import.meta.url));
const MAX_FRAME = 10 * 1024 * 1024;
const MAX_BUFFER = 32 * 1024 * 1024;
const MAX_PENDING = 128;
const HANDSHAKE_LIMIT = 65536;
const key = id => `${typeof id}:${id}`;
const hasId = message => Object.hasOwn(message, 'id');
const validId = id => typeof id === 'string' && id.length <= 512 || typeof id === 'number' && Number.isSafeInteger(id);
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}

function frames(stream, receive, broken) {
  let chunks = [], bytes = 0, failed = false;
  const data = chunk => {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < input.length && !failed) {
      const newline = input.indexOf(10, start);
      const end = newline < 0 ? input.length : newline;
      const piece = input.subarray(start, end);
      bytes += piece.length;
      if (bytes > MAX_FRAME) { failed = true; broken('frame_too_large'); return; }
      chunks.push(piece);
      if (newline < 0) return;
      let raw;
      try { raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)); }
      catch { failed = true; broken('invalid_utf8'); return; }
      chunks = []; bytes = 0; start = newline + 1;
      if (!raw.trim()) continue;
      let message;
      try { message = JSON.parse(raw); }
      catch { failed = true; broken('invalid_json'); return; }
      if (!message || Array.isArray(message) || message.jsonrpc !== '2.0'
        || hasId(message) && !validId(message.id) || message.method !== undefined && typeof message.method !== 'string') {
        failed = true; broken('invalid_frame'); return;
      }
      receive(message, Buffer.byteLength(raw));
    }
  };
  stream.on('data', data);
  return () => { failed = true; chunks = []; stream.removeListener('data', data); };
}

export function startLauncher({ command = process.execPath, args = [ADAPTER], input = process.stdin,
  output = process.stdout, startupMs = 10000, requireReady = false } = {}) {
  const nonce = crypto.randomBytes(12).toString('hex');
  const pending = new Map(), forwarded = new Map(), reverse = new Map(), lostIds = new Set();
  let child = null, generation = 0, starting = null, sequence = 0, queuedBytes = 0;
  let closed = false, incompatible = false, lastFailure = null, legacy = null, initialized = null, discovery = null;
  let modernMeta = null, internal = null;
  const starts = [];
  let finish;
  const done = new Promise(resolve => { finish = resolve; });

  function sendHost(message) {
    if (closed || output.destroyed) return;
    const line = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(line) > MAX_FRAME || output.writableLength + Buffer.byteLength(line) > MAX_BUFFER) { close(); return; }
    try {
      if (!output.write(line)) { input.pause(); child?.proc.stdout.pause(); }
    } catch { close(); }
  }
  function diagnostic(record, code) {
    return { failureClass: code, dispatchState: record.sent ? 'unknown_dispatch' : 'not_dispatched',
      modelInvocation: record.sent ? null : false, physicalAttemptCount: record.sent ? null : 0,
      tokenUsageSource: record.sent ? 'unknown' : 'not_invoked', automaticReplay: false,
      launcherPid: process.pid, generation: record.generation || generation,
      hostRequestId: record.message.id, method: record.message.method,
      recovery: incompatible ? 'reload_host_registration' : 'submit_a_fresh_request_after_inspecting_unknown_dispatch' };
  }
  function failRequest(record, code) {
    if (pending.get(key(record.message.id)) !== record) return;
    pending.delete(key(record.message.id)); forwarded.delete(record.wireId);
    queuedBytes -= record.bytes; record.bytes = 0;
    const detail = diagnostic(record, code);
    if (record.message.method === 'tools/call') sendHost({ jsonrpc: '2.0', id: record.message.id,
      result: { isError: true, content: [{ type: 'text', text: JSON.stringify(detail) }], structuredContent: detail } });
    else sendHost({ jsonrpc: '2.0', id: record.message.id, error: { code: -32000, message: code, data: detail } });
  }
  function childWrite(owner, message) {
    if (owner !== child || owner.failed || closed) throw new Error('mcp_transport_unavailable');
    const line = JSON.stringify(message) + '\n';
    if (owner.proc.stdin.destroyed || owner.proc.stdin.writableLength + Buffer.byteLength(line) > MAX_BUFFER) throw new Error('mcp_transport_backpressure');
    if (!owner.proc.stdin.write(line)) input.pause();
  }
  function rememberLost(id) {
    if (lostIds.has(id)) return;
    if (lostIds.size >= 4096) { incompatible = true; return; }
    lostIds.add(id);
  }
  function failChild(owner, code) {
    if (!owner || owner.failed) return;
    owner.failed = true; lastFailure = code;
    owner.unframe?.();
    if (internal?.owner === owner) { internal.reject(new Error(code)); internal = null; }
    owner.readyReject?.(new Error(code));
    for (const record of [...pending.values()]) if (record.generation === owner.generation || !record.sent) {
      if (record.sent) rememberLost(key(record.message.id));
      failRequest(record, record.sent ? 'mcp_transport_closed' : code);
    }
    for (const [id, record] of reverse) if (record.owner === owner) reverse.delete(id);
    try { owner.proc.stdin.end(); owner.proc.kill('SIGTERM'); } catch {}
    const kill = setTimeout(() => { if (owner.proc.exitCode === null && owner.proc.signalCode === null) try { owner.proc.kill('SIGKILL'); } catch {} }, 1000);
    kill.unref(); owner.proc.once('close', () => clearTimeout(kill));
    // Only the owned adapter is terminated. Its detached REST server survives.
    if (child === owner) child = null;
    if (!closed) input.resume();
  }
  function handshake(owner, message) {
    return new Promise((resolve, reject) => {
      const id = `rb_internal_${nonce}_${++sequence}`;
      internal = { owner, id, resolve, reject };
      try { childWrite(owner, { ...message, id }); }
      catch (error) { internal = null; reject(error); }
    });
  }
  function compatible(expected, actual, mode) {
    if (!actual || actual.error || !actual.result) return false;
    const a = expected.result, b = actual.result;
    const identity = result => mode === 'legacy' ? result?.serverInfo : result?._meta?.['io.modelcontextprotocol/serverInfo'];
    if (typeof identity(a)?.name !== 'string' || !identity(a).name || !a?.capabilities || !b?.capabilities) return false;
    return identity(a).name === identity(b)?.name
      && same(a?.capabilities, b?.capabilities)
      && (mode === 'legacy' ? typeof a?.protocolVersion === 'string' && a.protocolVersion === b?.protocolVersion
        : Array.isArray(a?.supportedVersions) && a.supportedVersions.length > 0 && same(a.supportedVersions, b?.supportedVersions));
  }
  async function ensureChild() {
    if (closed || incompatible) throw new Error('mcp_handshake_incompatible');
    if (starting) return starting;
    if (child && !child.failed) return child;
    const now = Date.now();
    while (starts.length && starts[0] < now - 60000) starts.shift();
    if (starts.length >= 3) throw new Error('mcp_recovery_circuit_open');
    starts.push(now);
    starting = (async () => {
      const proc = spawn(command, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, RELAYBRIDGE_LAUNCHER_PID: String(process.pid), RELAYBRIDGE_LAUNCHER_GENERATION: String(++generation) } });
      const owner = { proc, generation, failed: false, unframe: null }; child = owner;
      const ready = new Promise((resolve, reject) => {
        owner.readyReject = reject;
        proc.once('spawn', () => { if (!requireReady) resolve(); });
        proc.on('message', message => { if (message?.type === 'relaybridge_adapter_ready') resolve(); });
      });
      proc.once('error', () => failChild(owner, 'mcp_transport_unavailable'));
      proc.once('exit', () => failChild(owner, 'mcp_transport_closed'));
      proc.stdin.on('error', () => failChild(owner, 'mcp_transport_closed'));
      proc.stdin.on('drain', () => { if (!closed && output.writableLength < MAX_BUFFER / 2) input.resume(); });
      // Drain bounded chunks; raw child stderr may contain credentials.
      proc.stderr.on('data', () => {});
      owner.unframe = frames(proc.stdout, (message, bytes) => {
        if (owner !== child || owner.failed) return;
        if (internal?.owner === owner && message.id === internal.id && !message.method) {
          const request = internal; internal = null; request.resolve(message); return;
        }
        if (message.method && hasId(message)) {
          if (reverse.size >= MAX_PENDING) { failChild(owner, 'mcp_reverse_request_limit'); return; }
          const id = `rb_reverse_${nonce}_${++sequence}`;
          reverse.set(id, { owner, id: message.id }); sendHost({ ...message, id }); return;
        }
        if (!message.method && hasId(message)) {
          const record = forwarded.get(message.id);
          if (!record || record.generation !== owner.generation) return;
          if (!message.error && ['initialize', 'server/discover'].includes(record.message.method)) {
            if (bytes > HANDSHAKE_LIMIT || record.handshakeBytes > HANDSHAKE_LIMIT) { incompatible = true; failChild(owner, 'mcp_handshake_incompatible'); return; }
            const exchange = { request: record.message, response: message };
            if (record.message.method === 'initialize') legacy = exchange;
            else discovery = exchange;
          }
          pending.delete(key(record.message.id)); forwarded.delete(message.id);
          sendHost({ ...message, id: record.message.id }); return;
        }
        if (message.method === 'notifications/cancelled') {
          for (const [id, record] of reverse) {
            if (record.owner !== owner || key(record.id) !== key(message.params?.requestId)) continue;
            reverse.delete(id);
            sendHost({ ...message, params: { ...message.params, requestId: id } });
            break;
          }
          return;
        }
        sendHost(message);
      }, () => failChild(owner, 'mcp_invalid_child_frame'));
      const timer = setTimeout(() => failChild(owner, 'mcp_startup_timeout'), startupMs);
      timer.unref();
      try {
        await ready;
        if (legacy) {
          const reply = await handshake(owner, legacy.request);
          if (!compatible(legacy.response, reply, 'legacy')) throw new Error('mcp_handshake_incompatible');
          if (initialized) childWrite(owner, initialized);
        } else if (discovery || modernMeta) {
          const request = discovery?.request || { jsonrpc: '2.0', method: 'server/discover', params: { _meta: modernMeta } };
          const reply = await handshake(owner, request);
          if (!compatible(discovery?.response || reply, reply, 'modern')
            || Buffer.byteLength(JSON.stringify(reply)) > HANDSHAKE_LIMIT) throw new Error('mcp_handshake_incompatible');
          discovery ||= { request, response: reply };
        }
        if (owner.failed || closed) throw new Error('mcp_transport_unavailable');
        return owner;
      } catch (error) {
        if (error.message === 'mcp_handshake_incompatible') incompatible = true;
        failChild(owner, error.message); throw error;
      } finally { clearTimeout(timer); owner.readyReject = null; }
    })().finally(() => { starting = null; });
    return starting;
  }
  function receive(message, bytes) {
    if (!message.method && hasId(message)) {
      const record = reverse.get(message.id); reverse.delete(message.id);
      if (record && record.owner === child) try { childWrite(record.owner, { ...message, id: record.id }); } catch { failChild(record.owner, 'mcp_transport_closed'); }
      return;
    }
    if (!message.method) return;
    if (!hasId(message)) {
      if (message.method === 'notifications/initialized' && bytes <= HANDSHAKE_LIMIT) initialized = message;
      if (message.method === 'notifications/cancelled') {
        const record = pending.get(key(message.params?.requestId));
        if (record && !record.sent) { failRequest(record, 'mcp_request_cancelled'); return; }
        if (record && record.generation === child?.generation) {
          try { childWrite(child, { ...message, params: { ...message.params, requestId: record.wireId } }); }
          catch { failChild(child, 'mcp_transport_closed'); }
          rememberLost(key(record.message.id));
          failRequest(record, 'mcp_request_cancelled');
        }
        return;
      }
      // Notifications belong to their generation; only initialized is replayed.
      if (child && !child.failed) try { childWrite(child, message); } catch { failChild(child, 'mcp_transport_closed'); }
      return;
    }
    const id = key(message.id);
    if (pending.has(id)) {
      rememberLost(id); failRequest(pending.get(id), 'mcp_duplicate_request_id'); return;
    }
    const record = { message, bytes, sent: false, generation: null, wireId: null, handshakeBytes: bytes };
    pending.set(id, record); queuedBytes += bytes;
    if (pending.size > MAX_PENDING || queuedBytes > MAX_BUFFER || lostIds.has(id)) { failRequest(record, lostIds.has(id) ? 'mcp_interrupted_id_reused' : 'mcp_request_limit'); return; }
    if (message.params?._meta && !modernMeta) {
      if (Buffer.byteLength(JSON.stringify(message.params._meta)) > HANDSHAKE_LIMIT) { failRequest(record, 'mcp_handshake_too_large'); return; }
      modernMeta = message.params._meta;
    }
    ensureChild().then(owner => {
      if (pending.get(id) !== record) return;
      record.generation = owner.generation; record.wireId = `rb_request_${nonce}_${++sequence}`;
      forwarded.set(record.wireId, record);
      // Mark before write: false means buffered, never proof of non-dispatch.
      record.sent = true; queuedBytes -= record.bytes; record.bytes = 0;
      childWrite(owner, { ...message, id: record.wireId });
      // Retain only handshake instructions after dispatch, never tool prompts.
      if (!['initialize', 'server/discover'].includes(message.method)) record.message = { jsonrpc: '2.0', id: message.id, method: message.method };
    }).catch(error => failRequest(record, record.sent ? 'mcp_transport_closed' : error.message));
  }
  const unframe = frames(input, receive, code => { lastFailure = code; close(); });
  function drain() { if (!closed) { input.resume(); child?.proc.stdout.resume(); } }
  output.on('drain', drain);
  function close() {
    if (closed) return;
    closed = true; unframe(); input.pause();
    input.removeListener('end', close); input.removeListener('error', close); output.removeListener('error', close); output.removeListener('drain', drain);
    process.removeListener('SIGINT', close); process.removeListener('SIGTERM', close);
    const owner = child;
    failChild(owner, 'mcp_host_closed');
    if (!owner || owner.proc.exitCode !== null || owner.proc.signalCode !== null) finish();
    else owner.proc.once('close', finish);
  }
  input.on('end', close); input.on('error', close); output.on('error', close);
  process.on('SIGINT', close); process.on('SIGTERM', close);
  return Object.assign(done, { close, snapshot: () => ({ launcherPid: process.pid, generation,
    adapterPid: child?.proc.pid || null, pending: pending.size, queuedBytes, closed, lastFailure }) });
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) await startLauncher({ requireReady: true });
