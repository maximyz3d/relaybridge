import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const REPO = path.resolve(import.meta.dirname, '..');
const TARGET = path.join(REPO, 'mcp', 'launcher.mjs');
const req = createRequire(path.join(REPO, 'package.json'));
const { Client } = req('@modelcontextprotocol/client');
const { StdioClientTransport } = req('@modelcontextprotocol/client/stdio');
const DIR = path.join(import.meta.dirname, 'helpers/mcp-launcher');
const LIMIT = 6000;

function bounded(promise, name, timeout = LIMIT) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fixture timeout: ' + name)), timeout); }),
  ]).finally(() => clearTimeout(timer));
}
async function until(predicate, name) {
  const end = Date.now() + LIMIT;
  while (Date.now() < end) {
    const value = predicate();
    if (value) return value;
    await delay(20);
  }
  throw new Error('fixture timeout: ' + name);
}
function decode(result) {
  assert.notEqual(result?.isError, true, JSON.stringify(result));
  return JSON.parse(result.content.find((item) => item.type === 'text').text);
}
function fixtureEnv() {
  // No real provider/token configuration enters the fake child.
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(RELAYBRIDGE_|PS_BRIDGE_|OPENAI_|ANTHROPIC_|CLAUDE_|CODEX_)/.test(key)));
}
function makeState(t, throughLauncher) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-mcp-regression-'));
  const logPath = path.join(dir, 'events.jsonl');
  fs.writeFileSync(logPath, '');
  const events = () => fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const params = {
    command: process.execPath,
    args: throughLauncher ? [path.join(DIR, 'launcher-entry.mjs'), TARGET, REPO, logPath] : [path.join(DIR, 'child.cjs'), REPO, logPath],
    cwd: dir, env: fixtureEnv(), stderr: 'pipe',
  };
  const cleanups = [];
  t.after(async () => {
    try {
      for (const cleanup of cleanups.reverse()) await cleanup();
    } finally {
      // Kill only a still-running fake child whose /proc argv proves this exact fixture log.
      // This is cleanup, never the launcher restart mechanism under test.
      for (const event of events().filter((event) => event.event === 'start')) {
        try {
          const argv = fs.readFileSync('/proc/' + event.pid + '/cmdline', 'utf8').split('\0');
          if (argv.includes(logPath) && argv.includes(path.join(DIR, 'child.cjs'))) process.kill(event.pid, 'SIGKILL');
        } catch {}
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  return { dir, logPath, events, params, cleanups };
}
async function rawPeer(t, state) {
  const child = spawn(state.params.command, state.params.args, { cwd: state.params.cwd, env: state.params.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', buffer = '', sequence = 10, closed = false;
  const pending = new Map(), counts = new Map(), unexpected = [];
  const exit = new Promise((resolve) => child.once('exit', resolve));
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-6000); });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { unexpected.push({ invalidStdout: line.slice(0, 200) }); continue; }
      if (!Object.hasOwn(message, 'id')) continue;
      const key = typeof message.id + ':' + message.id;
      counts.set(key, (counts.get(key) || 0) + 1);
      const item = pending.get(key);
      if (!item) { unexpected.push(message); continue; }
      pending.delete(key);
      if (message.error) item.reject(Object.assign(new Error(message.error.message), { rpcError: message.error }));
      else item.resolve(message.result);
    }
  });
  child.on('error', (error) => { for (const item of pending.values()) item.reject(error); pending.clear(); });
  child.on('exit', (code) => {
    closed = true;
    for (const item of pending.values()) item.reject(new Error('peer exited ' + code + ': ' + stderr));
    pending.clear();
  });
  const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
  const request = (method, params = {}, id = sequence++) => {
    if (closed) return Promise.reject(new Error('peer already closed'));
    const promise = new Promise((resolve, reject) => pending.set(typeof id + ':' + id, { resolve, reject }));
    send({ jsonrpc: '2.0', id, method, params });
    return bounded(promise, method);
  };
  state.cleanups.push(async () => {
    child.stdin.end();
    await Promise.race([exit, delay(500)]);
    if (!closed) child.kill('SIGTERM');
    await bounded(exit, 'raw peer cleanup', 2000).catch(() => child.kill('SIGKILL'));
    assert.deepEqual(unexpected, [], 'no duplicate/internal/non-JSON responses may leak to client');
    for (const count of counts.values()) assert.equal(count, 1, 'each client id receives exactly one response');
  });
  const initialize = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw-legacy-fixture', version: '1' } }, 'fixture:init');
  assert.equal(initialize.protocolVersion, '2025-06-18');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return { call: (name, args, id) => request('tools/call', { name, arguments: args }, id), closed: () => closed, request, send };
}
async function sdkPeer(t, state, mode) {
  const transport = new StdioClientTransport(state.params);
  let stderr = '', closed = false;
  transport.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-6000); });
  const client = new Client({ name: 'sdk-' + mode + '-fixture', version: '1' }, { versionNegotiation: { mode: mode === 'modern' ? { pin: '2026-07-28' } : 'legacy' } });
  client.onclose = () => { closed = true; };
  state.cleanups.push(() => bounded(client.close(), 'SDK cleanup', 3000));
  await bounded(client.connect(transport), 'SDK ' + mode + ' connect').catch((error) => { error.message += '\n' + stderr; throw error; });
  return {
    call: (name, args) => bounded(client.callTool({ name, arguments: args }, undefined, { timeout: LIMIT - 500 }), 'SDK ' + name),
    closed: () => closed,
  };
}
async function connect(t, state, mode) {
  return mode === 'raw-legacy' ? rawPeer(t, state) : sdkPeer(t, state, mode);
}
function toolEvents(state, name, label) {
  return state.events().filter((event) => ['tool', 'side_effect'].includes(event.event) && event.name === name && event.label === label);
}
function failedOutcome(value) {
  if (value.kind === 'reject') {
    assert.doesNotMatch(value.error.message, /fixture timeout|Request timed out/, 'child death must settle promptly, not wait for caller deadline');
    return;
  }
  assert.equal(value.result?.isError, true, 'an interrupted in-flight tool must fail honestly');
}
const settled = (promise) => promise.then((result) => ({ kind: 'result', result }), (error) => ({ kind: 'reject', error }));

for (const mode of ['raw-legacy', 'legacy', 'modern']) {
  test('fixture baseline: installed SDK supports ' + mode, { timeout: 15000 }, async (t) => {
    const state = makeState(t, false);
    const peer = await connect(t, state, mode);
    const first = decode(await peer.call('fixture_echo', { label: 'baseline' }));
    assert.equal(first.label, 'baseline');
    const incoming = state.events().filter((event) => event.event === 'in');
    const sessionMessages = incoming.filter((event) => event.pid === first.pid);
    if (mode === 'modern') {
      assert.ok(incoming.some((event) => event.message.method === 'server/discover'));
      assert.equal(sessionMessages.some((event) => event.message.method === 'initialize'), false);
      assert.ok(sessionMessages[0].message.params?._meta, 'modern session begins with an envelope and no initialize');
    } else {
      assert.equal(sessionMessages[0].message.method, 'initialize');
      assert.equal(sessionMessages.filter((event) => event.message.method === 'notifications/initialized').length, 1);
    }
    const failure = await settled(peer.call('fixture_effect_then_crash', { label: 'baseline-effect' }));
    failedOutcome(failure);
    assert.equal(toolEvents(state, 'fixture_effect_then_crash', 'baseline-effect').length, 1);
  });

  test('persistent launcher: ' + mode + ' recovers, never replays in-flight tools', { timeout: 25000, skip: TARGET ? false : 'Set RB_FIXTURE_LAUNCHER to the new module exporting startLauncher' }, async (t) => {
    const state = makeState(t, true);
    const peer = await connect(t, state, mode);
    const initial = decode(await peer.call('fixture_echo', { label: 'initial' }));
    const baselineStarts = state.events().filter((event) => event.event === 'start').length;
    // Two distinct in-flight tools share the killed child. Neither can replay.
    const held = settled(peer.call('fixture_hold', { label: 'held-before-crash' }, 0));
    await until(() => toolEvents(state, 'fixture_hold', 'held-before-crash').length === 1, 'held tool entered');
    const crashed = settled(peer.call('fixture_effect_then_crash', { label: 'effect-before-crash' }, '0'));
    failedOutcome(await crashed);
    failedOutcome(await held);
    assert.equal(peer.closed(), false, 'upstream stdio remains usable after adapter child death');
    const echoes = await Promise.all(Array.from({ length: 4 }, (_, index) => peer.call('fixture_echo', { label: 'recovered-' + index }).then(decode)));
    assert.ok(echoes.every((value) => value.pid !== initial.pid));
    assert.equal(new Set(echoes.map((value) => value.pid)).size, 1, 'concurrent requests share one replacement child');
    assert.equal(state.events().filter((event) => event.event === 'start').length, baselineStarts + 1, 'exactly one child restarted');
    assert.equal(toolEvents(state, 'fixture_effect_then_crash', 'effect-before-crash').length, 1, 'side-effecting tools/call never replays');
    assert.equal(toolEvents(state, 'fixture_hold', 'held-before-crash').length, 1, 'other unanswered tools/call never replays');
    const replacementPid = echoes[0].pid;
    const recoveryMessages = state.events().filter((event) => event.event === 'in' && event.pid === replacementPid).map((event) => event.message);
    if (mode === 'modern') {
      assert.equal(recoveryMessages.some((message) => message.method === 'initialize'), false, 'modern restart must not invent a legacy handshake');
      for (const message of recoveryMessages.filter((message) => message.method === 'tools/call')) assert.ok(message.params?._meta, 'modern envelope survives forwarding');
    } else {
      assert.equal(recoveryMessages[0].method, 'initialize', 'legacy replacement is initialized before business requests');
      assert.equal(recoveryMessages.filter((message) => message.method === 'initialize').length, 1);
      assert.equal(recoveryMessages.filter((message) => message.method === 'notifications/initialized').length, 1);
      assert.ok(recoveryMessages.findIndex((message) => message.method === 'notifications/initialized') < recoveryMessages.findIndex((message) => message.method === 'tools/call'));
    }
    // A second independent child death must remain recoverable.
    failedOutcome(await settled(peer.call('fixture_effect_then_crash', { label: 'second-effect' })));
    const final = decode(await peer.call('fixture_echo', { label: 'second-recovery' }));
    assert.notEqual(final.pid, replacementPid);
    assert.equal(toolEvents(state, 'fixture_effect_then_crash', 'second-effect').length, 1);
  });
}
