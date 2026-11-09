'use strict';

// Test-only environment isolation. A fixture bridge or MCP child must never
// inherit a live RelayBridge store, token, URL or provider secret from the
// shell that runs the suite: server.js and mcp/*.mjs prefer RELAYBRIDGE_* over
// the PS_BRIDGE_* aliases, so overriding only one family is not enough.
const fs = require('node:fs');
const path = require('node:path');
const { CREDIT_SECRET_NAMES } = require('../../lib/allocated-credit');

const BRIDGE_PREFIX = /^(RELAYBRIDGE_|PS_BRIDGE_)/i;
const EXPLICIT_SECRET_NAMES = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_MESSAGING_TOKEN',
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN',
  'COPILOT_GITHUB_TOKEN', 'GITHUB_COPILOT_API_TOKEN', 'GITHUB_COPILOT_GITHUB_TOKEN',
  'COPILOT_PROVIDER_API_KEY', 'COPILOT_PROVIDER_BEARER_TOKEN', 'COPILOT_PROVIDER_HEADERS',
  'CURSOR_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
  'XAI_API_KEY', 'PERPLEXITY_API_KEY', 'PPLX_API_KEY', 'GROQ_API_KEY',
  ...CREDIT_SECRET_NAMES,
];
// Second source: credential-shaped names the shipped config strips or reads, so
// a newly configured provider is covered without editing this list. Limits such
// as COPILOT_PROVIDER_MAX_PROMPT_TOKENS do not match and stay inherited.
const CREDENTIAL_SHAPE = /(API_KEY|_TOKEN|AUTH_TOKEN|BEARER_TOKEN|SECRET)$/i;
function configCredentialNames() {
  const names = new Set();
  try {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'cli-config.json'), 'utf8'));
    const walk = (node, key) => {
      if (Array.isArray(node)) {
        for (const item of node) { if (/strip_env$/i.test(key) && typeof item === 'string') names.add(item); else walk(item, key); }
      } else if (node && typeof node === 'object') {
        for (const [name, value] of Object.entries(node)) {
          if (name === 'api_key_env' && typeof value === 'string') names.add(value); else walk(value, name);
        }
      }
    };
    walk(config, '');
  } catch { /* an unreadable config must never break test isolation */ }
  return [...names].filter((name) => CREDENTIAL_SHAPE.test(name));
}
const SECRET_NAMES = new Set([...EXPLICIT_SECRET_NAMES, ...configCredentialNames()].map((name) => name.toUpperCase()));

function isInheritedSecret(key) {
  return BRIDGE_PREFIX.test(key) || SECRET_NAMES.has(String(key).toUpperCase());
}

// Copy of process.env without inherited bridge or secret keys, then overrides.
// An override whose value is undefined removes that key from the copy.
function isolatedEnv(overrides = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!isInheritedSecret(key)) env[key] = value;
  for (const [key, value] of Object.entries(overrides || {})) {
    for (const existing of Object.keys(env)) if (existing !== key && existing.toUpperCase() === key.toUpperCase()) delete env[existing];
    if (value === undefined) delete env[key]; else env[key] = value;
  }
  return env;
}

// In-process modules (server.js, mcp/*.mjs) read process.env when loaded, so
// files that import them scrub the parent environment first.
function scrubInheritedEnv() {
  const removed = [];
  for (const key of Object.keys(process.env)) if (isInheritedSecret(key)) { removed.push(key); delete process.env[key]; }
  return removed;
}

module.exports = { isolatedEnv, scrubInheritedEnv, isInheritedSecret, EXPLICIT_SECRET_NAMES, configCredentialNames };
