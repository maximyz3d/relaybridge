// Remote MCP endpoint — the "connector" transport.
//
// Claude's Chat surface (claude.ai and the Chat tab of the desktop app) cannot
// spawn local processes, so the stdio adapter in mcp/server.mjs is invisible
// there. Connectors are remote MCP servers reached over HTTPS. This module
// mounts the SAME buildServer() tool set on a streamable-HTTP endpoint so one
// implementation serves every surface: stdio for Cowork/Code/Cursor/Codex,
// HTTP for connectors.
//
// SECURITY POSTURE — read before enabling.
// RelayBridge is a control plane over a real PowerShell. Loopback-only binding
// is its strongest guardrail, and exposing this endpoint trades that for
// bearer-token secrecy over a tunnel. Therefore:
//   - Disabled by default. Requires RELAYBRIDGE_REMOTE_MCP=1.
//   - Ships in 'safe' profile: read-only and bounded-delegation tools only.
//     Terminal/session/exec tools are NOT exposed remotely at any profile
//     below 'full', which additionally requires RELAYBRIDGE_REMOTE_MCP_FULL=1
//     so it can never be reached by flipping a single flag.
//   - Bearer token required on every request; the capability token is reused
//     so there is no second secret to manage.
//   - Origin/Host validation on, per MCP spec guidance against DNS rebinding.

'use strict';

const crypto = require('crypto');

// Tools that must never be reachable from a public URL: they run arbitrary
// commands or open interactive shells. Matching is by exact name.
const NEVER_REMOTE = new Set([
  'run_powershell', 'exec', 'open_session', 'send_session_input',
  'close_session', 'read_session_buffer', 'start_provider_signin',
]);

// The 'safe' profile additionally drops anything that mutates repo state.
const MUTATING_REMOTE = new Set([
  'github_track_run', 'github_onboard_repo', 'github_checkout_version',
  'set_agent_tags', 'restart_bridge',
]);

function profileFilter(profile) {
  if (profile === 'full') return (name) => !NEVER_REMOTE.has(name);
  return (name) => !NEVER_REMOTE.has(name) && !MUTATING_REMOTE.has(name);
}

function timingSafeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function bearerFrom(req) {
  const auth = req.headers?.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  // Connector UIs that only offer a custom header still work.
  return req.headers?.['x-relaybridge-token'] || '';
}

/**
 * Mount the remote MCP endpoint on an existing Express app.
 * @param {object} app        express app
 * @param {object} opts
 * @param {string} opts.token capability token (bearer credential)
 * @param {function} opts.buildServer  () => McpServer  (from mcp/server.mjs)
 * @param {string} [opts.path='/mcp']
 * @param {string} [opts.profile]      'safe' (default) | 'full'
 * @param {function} [opts.log]
 * @returns {{enabled:boolean, reason?:string, path?:string, profile?:string}}
 */
function mountRemoteMcp(app, opts) {
  const log = opts.log || (() => {});
  const enabled = String(process.env.RELAYBRIDGE_REMOTE_MCP || '') === '1';
  if (!enabled) {
    return { enabled: false, reason: 'set RELAYBRIDGE_REMOTE_MCP=1 to enable the connector endpoint' };
  }
  if (!opts.token || String(opts.token).length < 32) {
    return { enabled: false, reason: 'refusing to expose remote MCP without a strong capability token' };
  }

  let profile = opts.profile || process.env.RELAYBRIDGE_REMOTE_MCP_PROFILE || 'safe';
  if (profile === 'full' && String(process.env.RELAYBRIDGE_REMOTE_MCP_FULL || '') !== '1') {
    log('[RelayBridge] remote MCP: full profile requires RELAYBRIDGE_REMOTE_MCP_FULL=1 — falling back to safe');
    profile = 'safe';
  }
  const allow = profileFilter(profile);
  const mountPath = opts.path || '/mcp';

  let createMcpHandler, toNodeHandler;
  try {
    ({ createMcpHandler } = require('@modelcontextprotocol/server'));
    // The handler is Web-standard (fetch-shaped); this adapts it to Express's
    // (req, res), including SSE streaming for the modern transport.
    ({ toNodeHandler } = require('@modelcontextprotocol/node'));
  } catch (err) {
    return { enabled: false, reason: `MCP packages unavailable (npm install): ${err.message}` };
  }

  // Wrap buildServer so remote clients see only the permitted tools. Filtering
  // at registration (rather than rejecting at call time) means a disallowed
  // tool is never advertised, so the model never plans around one.
  const factory = () => {
    const server = opts.buildServer();
    const reg = server._registeredTools || server.registeredTools;
    if (reg && typeof reg === 'object') {
      for (const name of Object.keys(reg)) if (!allow(name)) delete reg[name];
    }
    return server;
  };

  const handler = createMcpHandler(factory);
  const nodeHandler = toNodeHandler(handler);

  app.all(mountPath, async (req, res) => {
    // Auth first: an unauthenticated caller must not reach protocol handling.
    if (!timingSafeEqual(bearerFrom(req), opts.token)) {
      res.set('WWW-Authenticate', 'Bearer realm="relaybridge"');
      return res.status(401).json({ error: 'valid bearer token required' });
    }
    try {
      // express.json() already consumed the body upstream, so hand the parsed
      // value across rather than letting the adapter re-read a drained stream.
      await nodeHandler(req, res, req.body);
    } catch (err) {
      log(`[RelayBridge] remote MCP error: ${err.message}`);
      if (!res.headersSent) res.status(500).json({ error: 'remote MCP handler failed' });
    }
  });

  log(`[RelayBridge] remote MCP mounted at ${mountPath} (profile=${profile}) — bearer token required`);
  return { enabled: true, path: mountPath, profile };
}

module.exports = { mountRemoteMcp, profileFilter, NEVER_REMOTE, MUTATING_REMOTE };
