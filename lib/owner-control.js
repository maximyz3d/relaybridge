'use strict';

const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');

// Process-owner IPC only, never provider stdin/stdout. This is not a security
// boundary against another process with the same user's authority.
function framedPeer(socket, { onMessage = () => {}, onClose = () => {}, now = Date.now,
  maxFrameBytes = 8192, maxQueuedFrames = 8, maxFramesPerSecond = 64, writeTimeoutMs = 2000,
  eofDrainTimeoutMs = 2000 } = {}) {
  let parts = [], bytes = 0, ended = false, draining = false, pendingWrites = 0, readEnded = false, eofTimer = null;
  let windowAt = now(), frames = 0;
  const queue = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  function close(code = 'OWNER_CONTROL_CLOSED') {
    if (ended) return;
    ended = true; clearTimeout(eofTimer); parts = []; bytes = 0; queue.length = 0;
    socket.destroy(); resolveClosed({ code });
    try { onClose({ code }); } catch {}
  }
  async function drain() {
    if (draining || ended) return;
    draining = true;
    try { while (!ended && queue.length) await onMessage(queue.shift()); }
    catch { close('OWNER_CONTROL_PROTOCOL'); }
    finally { draining = false; if (readEnded && !ended) close('OWNER_CONTROL_EOF'); }
  }
  socket.on('data', (chunk) => {
    if (ended || readEnded) return;
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let begin = 0;
    while (!ended && begin < input.length) {
      const newline = input.indexOf(10, begin);
      const end = newline < 0 ? input.length : newline;
      const piece = input.subarray(begin, end);
      if (bytes + piece.length > maxFrameBytes) return close('OWNER_CONTROL_FRAME_LIMIT');
      if (piece.length) { parts.push(piece); bytes += piece.length; }
      if (newline < 0) break;
      if (now() - windowAt >= 1000) { windowAt = now(); frames = 0; }
      if (++frames > maxFramesPerSecond || queue.length >= maxQueuedFrames) return close('OWNER_CONTROL_RATE_LIMIT');
      try {
        const text = decoder.decode(Buffer.concat(parts, bytes));
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string') throw new Error('shape');
        queue.push(value);
      } catch { return close('OWNER_CONTROL_PROTOCOL'); }
      parts = []; bytes = 0; begin = newline + 1;
      void drain();
    }
  });
  socket.on('error', () => close('OWNER_CONTROL_IO'));
  socket.on('end', () => {
    if (ended) return;
    if (bytes) return close('OWNER_CONTROL_TRUNCATED');
    readEnded = true;
    // EOF does not invalidate complete frames already queued behind an async
    // handler. A stuck handler cannot hold control resources indefinitely.
    eofTimer = setTimeout(() => close('OWNER_CONTROL_DRAIN_TIMEOUT'), eofDrainTimeoutMs);
    eofTimer.unref?.();
    if (!draining) void drain();
  });
  socket.on('close', () => { if (!readEnded) close('OWNER_CONTROL_CLOSED'); });
  function send(value) {
    if (ended || readEnded || pendingWrites >= maxQueuedFrames) return Promise.reject(new Error('owner control unavailable'));
    let frame;
    try {
      frame = Buffer.from(JSON.stringify(value) + '\n');
      if (frame.length > maxFrameBytes + 1) throw new Error('owner control frame limit');
    } catch (error) { return Promise.reject(error); }
    pendingWrites++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error) => {
        if (finished) return;
        finished = true; clearTimeout(timer); pendingWrites--;
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => { close('OWNER_CONTROL_WRITE_TIMEOUT'); finish(new Error('owner control write timeout')); }, writeTimeoutMs);
      timer.unref?.();
      try { socket.write(frame, finish); } catch (error) { finish(error); }
    });
  }
  return { send, close, closed, get ended() { return ended; } };
}

async function createOwnerControl({ runId, onHello, onMessage = () => {}, onClose = () => {}, helloTimeoutMs = 2000 } = {}) {
  if (!/^run_[A-Za-z0-9_-]{1,100}$/.test(runId || '') || typeof onHello !== 'function') throw new TypeError('owner identity required');
  const nonce = crypto.randomBytes(32).toString('hex');
  const dir = process.platform === 'win32' ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'rb-owner-'));
  if (dir) fs.chmodSync(dir, 0o700);
  const address = dir ? path.join(dir, 'control.sock') : `\\\\.\\pipe\\relaybridge-owner-${crypto.randomBytes(16).toString('hex')}`;
  let peer = null, helloSeen = false, disposed = false, failed = false, authenticated = false, timer = null;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // The caller may still be constructing its owner when startup fails.
  ready.catch(() => {});
  function fail(code) {
    if (failed || disposed) return;
    failed = true; authenticated = false; clearTimeout(timer);
    rejectReady(new Error(code));
    peer?.close(code);
    try { server.close(); } catch {}
    try { onClose({ code }); } catch {}
  }
  const server = net.createServer((socket) => {
    if (peer || disposed || failed) { socket.destroy(); return; }
    peer = framedPeer(socket, {
      async onMessage(message) {
        if (disposed || failed) throw new Error('owner control unavailable');
        if (!helloSeen) {
          helloSeen = true; // Single use, including an invalid first hello.
          if (message.type !== 'hello' || message.version !== 1 || message.runId !== runId
            || typeof message.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(message.nonce)
            || !crypto.timingSafeEqual(Buffer.from(nonce, 'hex'), Buffer.from(message.nonce, 'hex'))) throw new Error('invalid hello');
          const accepted = await onHello(message);
          if (disposed || failed || peer.ended || accepted !== true) throw new Error('owner identity not proven');
          clearTimeout(timer); timer = null;
          authenticated = true;
          resolveReady();
          return;
        }
        if (!authenticated || message.type === 'hello' || message.nonce !== undefined || message.runId !== runId) throw new Error('replayed owner control');
        await onMessage(message);
      },
      onClose(event) { fail(event.code); },
    });
  });
  server.on('error', () => fail('OWNER_CONTROL_LISTENER'));
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(address, () => { server.removeListener('error', reject); resolve(); }); });
    if (dir) fs.chmodSync(address, 0o600);
    timer = setTimeout(() => fail('OWNER_CONTROL_HELLO_TIMEOUT'), helloTimeoutMs);
    timer.unref?.();
  } catch (error) {
    try { server.close(); } catch {}
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    address, nonce, ready,
    send(value) { return peer && authenticated && !failed && !disposed ? peer.send({ ...value, runId }) : Promise.reject(new Error('owner not authenticated')); },
    async dispose() {
      if (disposed) return;
      disposed = true; clearTimeout(timer); rejectReady(new Error('owner control disposed'));
      peer?.close('OWNER_CONTROL_DISPOSED');
      await new Promise((resolve) => { try { server.close(resolve); } catch { resolve(); } });
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { framedPeer, createOwnerControl };
