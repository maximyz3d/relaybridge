'use strict';

// The connector transport: the same tools as stdio, over HTTP, minus anything
// that must never be reachable from a public URL.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
  mountRemoteMcp, profileFilter, isNeverRemote, isNeverRemoteResource, NEVER_REMOTE,
} = require('../lib/remote-mcp');

const TOKEN = 'a'.repeat(64);

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) { prev[k] = process.env[k]; if (v === null) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('the connector endpoint is OFF unless explicitly enabled', () => {
  withEnv({ RELAYBRIDGE_REMOTE_MCP: null }, () => {
    const status = mountRemoteMcp(express(), { token: TOKEN, buildServer: () => ({}) });
    assert.equal(status.enabled, false);
    assert.match(status.reason, /RELAYBRIDGE_REMOTE_MCP=1/);
  });
});

test('a weak or missing token blocks exposure entirely', () => {
  withEnv({ RELAYBRIDGE_REMOTE_MCP: '1' }, () => {
    for (const token of ['', 'short', undefined]) {
      const status = mountRemoteMcp(express(), { token, buildServer: () => ({}) });
      assert.equal(status.enabled, false, `token ${JSON.stringify(token)} must not expose the endpoint`);
      assert.match(status.reason, /strong capability token/);
    }
  });
});

test('terminal and exec tools are unreachable at EVERY profile', () => {
  const safe = profileFilter('safe');
  const full = profileFilter('full');
  for (const name of NEVER_REMOTE) {
    assert.equal(safe(name), false, `${name} must be blocked in safe`);
    assert.equal(full(name), false, `${name} must be blocked even in full`);
  }
  assert.ok(NEVER_REMOTE.has('run_powershell'), 'the PowerShell tool must be on the never-remote list');
  for (const actual of ['list_sessions', 'start_safe_session', 'send_session_input', 'stop_session', 'read_session_output']) {
    assert.ok(isNeverRemote(actual), `${actual} must match the terminal/session policy`);
  }
  assert.ok(isNeverRemote('future_session_control'), 'future session surfaces must fail closed');
  assert.ok(isNeverRemote('get_context_bundle'), 'the context bundle can expose live terminal output');
  assert.ok(isNeverRemoteResource('sessions'), 'the session resource must fail closed');
  assert.ok(isNeverRemoteResource('context'), 'the context resource includes session metadata');
  assert.ok(isNeverRemoteResource('psbridge://sessions'), 'the live registry is keyed by URI');
  assert.ok(isNeverRemoteResource('psbridge://context'), 'the context URI must fail closed');
});

test('the safe profile withholds repo-mutating tools but keeps read and delegation', () => {
  const safe = profileFilter('safe');
  for (const blocked of ['github_onboard_repo', 'github_track_run', 'github_checkout_version']) {
    assert.equal(safe(blocked), false, `${blocked} must not be remote in safe profile`);
  }
  for (const allowed of ['bridge_status', 'route_and_ask', 'github_list_versions', 'plan_task']) {
    assert.equal(safe(allowed), true, `${allowed} should be available remotely`);
  }
});

test('the full profile cannot be reached by one flag alone', () => {
  withEnv({ RELAYBRIDGE_REMOTE_MCP: '1', RELAYBRIDGE_REMOTE_MCP_PROFILE: 'full', RELAYBRIDGE_REMOTE_MCP_FULL: null }, () => {
    const logs = [];
    const status = mountRemoteMcp(express(), { token: TOKEN, buildServer: () => ({}), log: (m) => logs.push(m) });
    assert.equal(status.profile, 'safe', 'must fall back to safe without the second flag');
    assert.ok(logs.some((l) => /falling back to safe/.test(l)), 'the downgrade must be announced');
  });
});

test('the endpoint speaks MCP over HTTP and refuses unauthenticated callers', async (t) => {
  const mcpModule = await import('../mcp/server.mjs');
  const app = express();
  app.use(express.json());
  const status = withEnv({ RELAYBRIDGE_REMOTE_MCP: '1' }, () =>
    mountRemoteMcp(app, { token: TOKEN, buildServer: () => mcpModule.buildServer(), log: () => {} }));
  assert.equal(status.enabled, true);

  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const accept = 'application/json, text/event-stream';

  // Unauthenticated: rejected before any protocol handling.
  const anon = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: accept },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
  });
  assert.equal(anon.status, 401);
  assert.match(anon.headers.get('www-authenticate') || '', /Bearer/);

  // A wrong token of the same length must also fail (no partial match).
  const wrong = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: accept, Authorization: `Bearer ${'b'.repeat(64)}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
  });
  assert.equal(wrong.status, 401);

  // Authenticated handshake.
  const H = { 'Content-Type': 'application/json', Accept: accept, Authorization: `Bearer ${TOKEN}` };
  const init = await fetch(url, {
    method: 'POST', headers: H,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'connector-test', version: '1' } } }),
  });
  assert.equal(init.status, 200);
  const initBody = await init.text();
  assert.match(initBody, /relaybridge/, 'the server must identify itself');

  const sessionId = init.headers.get('mcp-session-id');
  const H2 = sessionId ? { ...H, 'mcp-session-id': sessionId } : H;
  await fetch(url, { method: 'POST', headers: H2, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });

  const listed = await fetch(url, { method: 'POST', headers: H2, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
  assert.equal(listed.status, 200);
  const names = new Set([...(await listed.text()).matchAll(/"name":"([a-z_0-9]+)"/g)].map((m) => m[1]));

  assert.ok(names.size > 20, `expected a substantial tool set, got ${names.size}`);
  assert.ok(names.has('bridge_status'), 'read tools must be advertised');
  assert.ok(names.has('github_list_versions'), 'the GitHub read tools must be advertised');
  // The security property that matters: never advertised, so a model never plans around it.
  assert.ok(!names.has('run_powershell'), 'the PowerShell tool must NOT be advertised remotely');
  for (const terminalTool of ['list_sessions', 'start_safe_session', 'send_session_input', 'stop_session', 'read_session_output']) {
    assert.ok(!names.has(terminalTool), `${terminalTool} must NOT be advertised remotely`);
  }
  assert.ok(!names.has('get_context_bundle'), 'the terminal-capable context bundle must NOT be advertised remotely');
  assert.ok(!names.has('github_onboard_repo'), 'mutating tools must NOT be advertised in safe profile');

  const resources = await fetch(url, { method: 'POST', headers: H2, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'resources/list' }) });
  assert.equal(resources.status, 200);
  const resourceBody = await resources.text();
  assert.doesNotMatch(resourceBody, /psbridge:\/\/sessions/, 'session resources must not be advertised remotely');
  assert.doesNotMatch(resourceBody, /psbridge:\/\/context/, 'context resources must not be advertised remotely');
});
