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
//   - No Origin or Host allowlist of its own. This route has none, and the
//     bridge's global CORS gate admits only the loopback origins, so a
//     browser-surface client is refused there before the bearer check ever
//     runs, while a tunneled server-to-server request carrying any Host reaches
//     protocol handling as soon as it presents the token. The token is the whole
//     boundary: terminate the tunnel somewhere that can add its own
//     authentication if you need more than that. (This comment previously
//     claimed Origin/Host validation "per MCP spec guidance against DNS
//     rebinding"; no such check was ever implemented here, and an operator
//     reviewing the posture deserves the real answer.)

'use strict';

const crypto = require('crypto');

// Tools that must never be reachable from a public URL: they run arbitrary
// commands or open interactive shells. Matching is by exact name.
const NEVER_REMOTE = new Set([
  'run_powershell', 'exec',
  'list_sessions', 'start_safe_session', 'send_session_input',
  'stop_session', 'read_session_output',
  'start_bridge', 'restart_bridge', 'stop_bridge',
  'start_provider_signin', 'get_context_bundle',
  'start_codex_claude_pipeline', 'list_pipelines', 'get_pipeline', 'reconcile_pipeline',
  'submit_pipeline_research', 'claim_pipeline_implementation',
  'complete_pipeline_implementation', 'start_pipeline_revision',
  'start_pipeline_final_review', 'retry_failed_pipeline_provider', 'renew_pipeline_writer_lease',
  'cancel_pipeline',
  'open_in_chrome',
]);

const NEVER_REMOTE_RESOURCES = new Set(['context', 'sessions']);

// Treat every present or future session surface as terminal authority. This is
// intentionally broader than the exact registry census above so a renamed or
// newly-added session tool cannot silently become public before this policy is
// reviewed.
function isNeverRemote(name) {
  const normalized = String(name || '');
  return NEVER_REMOTE.has(normalized) || /(^|_)sessions?($|_)/i.test(normalized);
}

function isNeverRemoteResource(name) {
  const normalized = String(name || '');
  return NEVER_REMOTE_RESOURCES.has(normalized)
    || normalized === 'psbridge://context'
    || normalized === 'psbridge://sessions'
    || /(^|_)sessions?($|_)/i.test(normalized);
}

// The 'safe' profile additionally drops anything that mutates repo state.
const MUTATING_REMOTE = new Set([
  'github_track_run', 'github_onboard_repo', 'github_checkout_version',
  'set_agent_tags', 'restart_bridge',
]);

function profileFilter(profile) {
  if (profile === 'full') return (name) => !isNeverRemote(name);
  return (name) => !isNeverRemote(name) && !MUTATING_REMOTE.has(name);
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
  //
  // Both registries are SDK privates (`_registeredTools`, `_registeredResources`
  // — plain objects keyed by tool name / resource URI) and package.json takes
  // '@modelcontextprotocol/server' on a caret range, so an `npm install` can
  // rename or reshape them. The previous code simply skipped the loop when it
  // did not recognise the registry: the filter became a silent no-op while
  // mountRemoteMcp still reported enabled:true in the 'safe' profile, which
  // would advertise run_powershell, the session tools and stop_bridge on a
  // public tunnel behind nothing but the bearer token. setup-wsl.sh runs
  // `npm install` and then starts the bridge with RELAYBRIDGE_REMOTE_MCP=1, so
  // a floating SDK minor and an enabled endpoint arrive together. A security
  // filter must fail closed, so a registry this code cannot enumerate and
  // re-check is fatal: the factory throws, the request gets a 500, and nothing
  // is ever advertised.
  const registryNames = (registry) => {
    if (!registry || typeof registry !== 'object') return null;
    // Map-like registries would enumerate as zero keys and pass the re-check
    // below without a single deletion having happened.
    if (typeof registry.size === 'number' || typeof registry.get === 'function') return null;
    return Object.keys(registry);
  };
  const filterRegistry = (registry, label, forbidden, requireEntries) => {
    const names = registryNames(registry);
    if (names === null || (requireEntries && !names.length)) {
      throw new Error(`this MCP SDK build exposes no ${label} registry the remote allowlist can filter`);
    }
    for (const name of names) if (forbidden(name)) delete registry[name];
    const survived = Object.keys(registry).filter(forbidden);
    if (survived.length) {
      throw new Error(`the remote ${label} allowlist did not take effect: ${survived.join(', ')} survived`);
    }
  };
  const factory = () => {
    const server = opts.buildServer();
    try {
      filterRegistry(server._registeredTools || server.registeredTools, 'tool', (name) => !allow(name), true);
      filterRegistry(server._registeredResources || server.registeredResources, 'resource', isNeverRemoteResource, false);
    } catch (error) {
      log(`[RelayBridge] remote MCP: refusing to serve a session — ${error.message}`);
      throw error;
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

module.exports = {
  mountRemoteMcp, profileFilter, isNeverRemote, isNeverRemoteResource,
  NEVER_REMOTE, NEVER_REMOTE_RESOURCES, MUTATING_REMOTE,
};
