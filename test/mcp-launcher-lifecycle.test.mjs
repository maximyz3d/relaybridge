import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const TARGET = path.resolve(import.meta.dirname, '../mcp/launcher.mjs');
const { startLauncher } = await import(pathToFileURL(TARGET).href);
const CHILD = path.join(import.meta.dirname, 'helpers/mcp-launcher/protocol-child.cjs');
function bounded(promise, label, ms = 4000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture timeout: ' + label)), ms); })]).finally(() => clearTimeout(timer));
}
async function until(fn, label) {
  const end = Date.now() + 4000;
  while (Date.now() < end) { if (fn()) return; await delay(10); }
  throw new Error('fixture timeout: ' + label);
}
function setup(t, mode = 'normal', options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-launcher-supplementary-'));
  const log = path.join(dir, 'events.jsonl'); fs.writeFileSync(log, '');
  const input = new PassThrough(), output = new PassThrough();
  const messages = [], waiters = new Map(); let buffer = '', next = 1;
  const events = () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  output.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const pos = buffer.indexOf('\n'); if (pos < 0) break;
      const message = JSON.parse(buffer.slice(0, pos)); buffer = buffer.slice(pos + 1);
      messages.push(message);
      const waiter = waiters.get(message.id);
      if (!message.method && waiter) { waiters.delete(message.id); waiter(message); }
    }
  });
  const launcher = startLauncher({ command: process.execPath, args: [CHILD, log, mode], input, output, startupMs: 250, requireReady: true, ...options });
  const send = message => input.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const request = (method, params, id = 'request-' + next++) => {
    const pending = new Promise(resolve => waiters.set(id, resolve)); send({ id, method, params });
    return bounded(pending, method);
  };
  t.after(async () => {
    launcher.close();
    await bounded(launcher, 'launcher owned cleanup');
    // Wait only for fixture-owned processes. Safety cleanup verifies exact argv.
    for (const event of events().filter(item => item.event === 'start')) {
      try {
        const argv = fs.readFileSync('/proc/' + event.pid + '/cmdline', 'utf8').split('\0');
        if (argv.includes(CHILD) && argv.includes(log)) process.kill(event.pid, 'SIGKILL');
      } catch {}
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { launcher, input, send, request, messages, events };
}
async function initialize(host) {
  const response = await host.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'supplementary', version: '1' } });
  assert.equal(response.result?.protocolVersion, '2025-06-18');
  host.send({ method: 'notifications/initialized' });
}
function detail(response) {
  return response.error?.data || response.result?.structuredContent || JSON.parse(response.result.content[0].text);
}

test('invalid UTF-8 refuses before creating an adapter or changing prompt bytes', async t => {
  const host = setup(t);
  const frame = Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"prompt":"'),
    Buffer.from([0xc3, 0x28]), Buffer.from('"}}}\n')]);
  host.input.write(frame);
  await bounded(host.launcher, 'invalid UTF-8 closes');
  assert.equal(host.launcher.snapshot().lastFailure, 'invalid_utf8');
  assert.equal(host.launcher.snapshot().generation, 0);
  assert.deepEqual(host.events(), []);
});

test('sent cancellations release all pending capacity without replaying work', { timeout: 12000 }, async t => {
  const host = setup(t); await initialize(host);
  for (let index = 0; index < 128; index++) host.send({ id: 'held-' + index, method: 'tools/call', params: { name: 'hold', arguments: {} } });
  await until(() => host.events().filter(event => event.message?.method === 'tools/call').length === 128, 'all held calls dispatched');
  for (let index = 0; index < 128; index++) host.send({ method: 'notifications/cancelled', params: { requestId: 'held-' + index, reason: 'explicit host cancellation' } });
  await until(() => host.events().filter(event => event.message?.method === 'notifications/cancelled').length === 128, 'mapped cancellations forwarded');
  const response = await host.request('tools/call', { name: 'echo', arguments: {} });
  assert.equal(response.result?.isError, undefined, 'healthy adapter remains usable after 128 canceled requests: ' + JSON.stringify(response));
  assert.equal(response.result?.content?.[0]?.text, 'fixture-ok');
  assert.equal(host.launcher.snapshot().pending, 0);
  assert.equal(host.events().filter(event => event.message?.params?.name === 'hold').length, 128, 'canceled calls never replay');
});

test('server cancellation follows remapped reverse request identity', { timeout: 8000 }, async t => {
  const host = setup(t); await initialize(host);
  const result = host.request('tools/call', { name: 'reverse', arguments: {} });
  await until(() => host.messages.some(message => message.method === 'notifications/cancelled'), 'server cancellation forwarded');
  const reverse = host.messages.find(message => message.method === 'roots/list');
  const cancelled = host.messages.find(message => message.method === 'notifications/cancelled');
  assert.equal((await result).result?.content?.[0]?.text, 'reverse-cancelled');
  host.send({ id: reverse.id, result: { roots: [] } });
  await delay(20);
  assert.equal(cancelled.params.requestId, reverse.id, 'host must receive the same id on reverse request and its cancellation');
  assert.equal(host.events().some(event => event.message?.id === 'fixture-server-request' && !event.message?.method), false, 'late host response after server cancellation is discarded');
});

test('missing child executable is typed, never dispatched, and leaves host open', { timeout: 8000 }, async t => {
  const host = setup(t, 'normal', { command: path.join(os.tmpdir(), 'relaybridge-never-existent-fixture-command') });
  const response = await host.request('tools/call', { name: 'echo', arguments: {} });
  assert.equal(detail(response).failureClass, 'mcp_transport_unavailable');
  assert.equal(detail(response).dispatchState, 'not_dispatched');
  assert.equal(detail(response).modelInvocation, false);
  assert.equal(detail(response).automaticReplay, false);
  assert.equal(host.launcher.snapshot().closed, false);
  assert.equal(host.events().length, 0);
});

test('IPC readiness timeout blocks every business request before dispatch', { timeout: 8000 }, async t => {
  const host = setup(t, 'no-ready');
  const response = await host.request('tools/call', { name: 'echo', arguments: {} });
  assert.equal(detail(response).failureClass, 'mcp_startup_timeout');
  assert.equal(detail(response).dispatchState, 'not_dispatched');
  assert.equal(detail(response).modelInvocation, false);
  assert.equal(host.events().filter(event => event.event === 'in').length, 0);
});

test('restart circuit bounds repeated crashes without inventing invocation on blocked request', { timeout: 12000 }, async t => {
  const host = setup(t); await initialize(host);
  for (let index = 0; index < 3; index++) {
    const response = await host.request('tools/call', { name: 'crash', arguments: {} });
    assert.equal(detail(response).dispatchState, 'unknown_dispatch');
    assert.equal(detail(response).modelInvocation, null);
  }
  const response = await host.request('tools/call', { name: 'echo', arguments: {} });
  assert.equal(detail(response).failureClass, 'mcp_recovery_circuit_open');
  assert.equal(detail(response).dispatchState, 'not_dispatched');
  assert.equal(detail(response).modelInvocation, false);
  assert.equal(host.events().filter(event => event.event === 'start').length, 3);
  assert.equal(host.events().filter(event => event.event === 'effect').length, 3);
});
