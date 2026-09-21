'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { refreshClaudeUsageViaPty } = require('../lib/claude-usage-probe');

const identity = { accountFingerprint: 'account', profileHash: 'profile' };
function fakePty({ onWrite = () => {}, exitOnKill = true, screen = 'Claude Code v1.0\n? for shortcuts\n❯ ' } = {}) {
  const state = { spawns: 0, writes: [], kills: [] };
  return { state, spawn() {
    state.spawns++;
    const events = new EventEmitter();
    const proc = {
      write(value) { state.writes.push(value); onWrite(value); },
      kill(signal) { state.kills.push(signal || null); if (exitOnKill) queueMicrotask(() => events.emit('exit', { exitCode: 0 })); },
      onData(handler) { events.on('data', handler); },
      onExit(handler) { events.on('exit', handler); },
    };
    queueMicrotask(() => events.emit('data', screen));
    return proc;
  } };
}

test('Claude usage PTY accepts only a newer cache sample for the same profile', async () => {
  let sample = { identity, observation: null };
  const pty = fakePty({ onWrite(value) {
    if (value === '/usage\r') sample = { identity, observation: { observedAt: 201 } };
  } });
  const result = await refreshClaudeUsageViaPty({ ptyImpl: pty, command: 'claude', readSample: () => sample,
    expectedIdentity: identity, baselineFetchedAt: 200, timeoutMs: 500, pollMs: 10, startupDelayMs: 0, exitGraceMs: 10 });
  assert.equal(result.refreshed, true); assert.equal(result.sample.observation.observedAt, 201);
  assert.equal(pty.state.spawns, 1); assert.equal(pty.state.writes[0], '/usage\r'); assert.ok(pty.state.kills.length >= 1);
});

test('Claude usage PTY recognizes the restricted plan-mode main screen', async () => {
  let sample = { identity, observation: null };
  const pty = fakePty({ screen: 'Claude Code v2.1.278\n❯ Try "edit <filepath> to..."\n⏸ plan mode on', onWrite(value) {
    if (value === '/usage\r') sample = { identity, observation: { observedAt: 201 } };
  } });
  const result = await refreshClaudeUsageViaPty({ ptyImpl: pty, command: 'claude', readSample: () => sample,
    expectedIdentity: identity, baselineFetchedAt: 200, timeoutMs: 500, pollMs: 10, exitGraceMs: 10 });
  assert.equal(result.refreshed, true);
  assert.deepEqual(pty.state.writes, ['/usage\r']);
});

test('Claude usage PTY rejects unchanged and changed-identity samples and cleans up', async () => {
  for (const sample of [
    { identity, observation: { observedAt: 200 } },
    { identity: { accountFingerprint: 'other', profileHash: 'profile' }, observation: { observedAt: 201 } },
  ]) {
    const pty = fakePty();
    const result = await refreshClaudeUsageViaPty({ ptyImpl: pty, command: 'claude', readSample: () => sample,
      expectedIdentity: identity, baselineFetchedAt: 200, timeoutMs: 30, pollMs: 5, startupDelayMs: 0, exitGraceMs: 10 });
    assert.equal(result.refreshed, false); assert.equal(result.reason, 'probe_timeout'); assert.ok(pty.state.kills.length >= 1);
  }
});

test('Claude usage PTY fails closed when unavailable and never exposes terminal data', async () => {
  const unavailable = await refreshClaudeUsageViaPty({ command: 'claude', readSample: () => ({}), expectedIdentity: identity });
  assert.deepEqual(unavailable, { refreshed: false, reason: 'probe_unavailable' });
  const pty = fakePty({ exitOnKill: false });
  const result = await refreshClaudeUsageViaPty({ ptyImpl: pty, command: 'claude', readSample: () => ({ identity, observation: null }),
    expectedIdentity: identity, timeoutMs: 30, pollMs: 5, startupDelayMs: 0, exitGraceMs: 10 });
  assert.deepEqual(result, { refreshed: false, reason: 'probe_timeout' });
  assert.deepEqual(Object.keys(result).sort(), ['reason', 'refreshed']);
});

test('Claude usage PTY never types into a trust dialog', async () => {
  const pty = fakePty({ screen: 'Quick safety check: Do you trust the files in this folder?' });
  const result = await refreshClaudeUsageViaPty({ ptyImpl: pty, command: 'claude',
    readSample: () => ({ identity, observation: null }), expectedIdentity: identity, timeoutMs: 500, exitGraceMs: 10 });
  assert.deepEqual(result, { refreshed: false, reason: 'probe_interactive_gate' });
  assert.deepEqual(pty.state.writes, []);
});
