#!/usr/bin/env node
'use strict';

// RelayBridge CLI.
//
// The bridge already speaks HTTP and MCP. This adds the third surface: a plain
// command line, so any agent or script that can run a process — including ones
// with no MCP support at all — can plan and delegate work.
//
// Everything here is a thin, honest wrapper over the same endpoints the
// dashboard and MCP server use. No separate logic, so behaviour cannot drift
// between surfaces.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { TextDecoder } = require('util');

const DEFAULT_PORT = process.env.RELAYBRIDGE_PORT || process.env.PS_BRIDGE_PORT || '8787';
const DEFAULT_HOST = process.env.RELAYBRIDGE_HOST || '127.0.0.1';
// RELAYBRIDGE_URL wins so the CLI, the MCP server and the client configs all
// resolve the bridge the same way; the PORT/HOST pair remains as a fallback.
const BASE = (process.env.RELAYBRIDGE_URL || process.env.PS_BRIDGE_URL || `http://${DEFAULT_HOST}:${DEFAULT_PORT}`).replace(/\/+$/, '');

// The token lives beside the install. Checked in the same order the installer
// uses, so the CLI works from anywhere without configuration.
function findToken() {
  if (process.env.RELAYBRIDGE_TOKEN) return process.env.RELAYBRIDGE_TOKEN;
  const candidates = [
    path.join(process.cwd(), '.bridge-token'),
    path.join(process.env.LOCALAPPDATA || '', 'RelayBridge', '.bridge-token'),
    path.join(os.homedir(), 'AppData', 'Local', 'RelayBridge', '.bridge-token'),
    path.join(os.homedir(), '.relaybridge', 'token'),
    path.join(__dirname, '..', '.bridge-token'),
  ];
  for (const file of candidates) {
    try {
      if (file && fs.existsSync(file)) {
        const value = fs.readFileSync(file, 'utf8').trim();
        if (value) return value;
      }
    } catch { /* keep looking */ }
  }
  return null;
}

async function bridgeVersion() {
  try {
    const res = await fetch(BASE + '/api/health');
    const body = await res.json();
    return body.version || 'unknown';
  } catch { return 'unknown'; }
}

async function call(pathname, { method = 'GET', body = null } = {}) {
  const token = findToken();
  if (!token) {
    throw new Error('no bridge token found. Start RelayBridge, or set RELAYBRIDGE_TOKEN.');
  }
  const headers = { 'X-RelayBridge-Token': token, 'X-RelayBridge-Client': 'cli' };
  if (body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(BASE + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (err) {
    throw new Error(`cannot reach the bridge at ${BASE} (${err.message}). Is it running?`);
  }
  const text = await res.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
  if (res.status === 409 && payload.auth_required) {
    const err = new Error(`${payload.label || payload.kind} is not signed in. Run: relaybridge login ${payload.kind}`);
    err.authRequired = payload;
    throw err;
  }
  if (res.status === 404) {
    throw new Error(`${pathname} is not available on the running bridge (v${await bridgeVersion()}). `
      + 'The process is older than this endpoint — restart RelayBridge after syncing the install directory.');
  }
  if (!res.ok) throw new Error(payload.error || `${res.status} ${res.statusText}`);
  return payload;
}

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  const booleanFlags = new Set(['force', 'json', 'refresh', 'stdin']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const raw = arg.slice(2);
      const separator = raw.indexOf('=');
      const name = separator >= 0 ? raw.slice(0, separator) : raw;
      const inline = separator >= 0 ? raw.slice(separator + 1) : undefined;
      if (inline !== undefined) flags[name] = inline;
      else if (booleanFlags.has(name)) flags[name] = true;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[name] = argv[++i];
      else flags[name] = true;
    } else {
      rest.push(arg);
    }
  }
  return { flags, rest };
}

class InputError extends Error {}

function decodePromptUtf8(value, source) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw new InputError(`${source} is not valid UTF-8`);
  }
}

function resolveTaskInput(flags, rest, {
  readFile = (file) => fs.readFileSync(file),
  readStdin = () => fs.readFileSync(0),
} = {}) {
  if (flags.stdin !== undefined && flags.stdin !== true) {
    throw new InputError('--stdin does not accept a value');
  }
  if (flags['prompt-file'] === true || flags['prompt-file'] === '') {
    throw new InputError('--prompt-file requires a path');
  }

  const hasPositional = rest.length > 0;
  const hasStdin = flags.stdin === true;
  const hasPromptFile = typeof flags['prompt-file'] === 'string';
  const selected = Number(hasPositional) + Number(hasStdin) + Number(hasPromptFile);
  if (selected > 1) {
    throw new InputError('choose exactly one prompt source: positional text, --stdin, or --prompt-file <path>');
  }
  if (selected === 0) {
    throw new InputError('a task description is required (positional text, --stdin, or --prompt-file <path>)');
  }

  let task;
  let source;
  if (hasStdin) {
    source = 'stdin prompt';
    task = decodePromptUtf8(readStdin(), source);
  } else if (hasPromptFile) {
    const promptFile = path.resolve(flags['prompt-file']);
    source = 'prompt file';
    let bytes;
    try {
      bytes = readFile(promptFile);
    } catch (err) {
      throw new InputError(`cannot read prompt file ${promptFile}: ${err.message}`);
    }
    task = decodePromptUtf8(bytes, source);
  } else {
    source = 'positional prompt';
    task = rest.join(' ').trim();
  }

  if (!task || /^\s*$/u.test(task)) throw new InputError(`${source} is empty`);
  return task;
}

function printPlan(plan, { json = false } = {}) {
  if (json) { console.log(JSON.stringify(plan, null, 2)); return; }
  const p = plan.primary;
  console.log(`tier      ${plan.tier}${plan.confidence != null ? `  (confidence ${plan.confidence})` : ''}`);
  console.log(`effort    ${plan.effort}`);
  if (p) {
    console.log(`company   ${p.company}`);
    console.log(`provider  ${p.kind}  (${p.label})`);
    console.log(`model     ${p.model || 'account default'}${p.modelTier ? `  [${p.modelTier}]` : ''}`);
    console.log(`cost      ${p.costNote}`);
    if (p.args && p.args.length) console.log(`args      ${p.args.join(' ')}`);
  } else {
    console.log('provider  (none ready — check relaybridge status)');
  }
  if (plan.alternates?.length) {
    console.log(`fallbacks ${plan.alternates.map((a) => `${a.kind}:${a.model || 'default'}`).join(', ')}`);
  }
  if (plan.humanGate) console.log('gate      HUMAN — advisory only, do not auto-execute');
  for (const line of plan.guidance || []) console.log(`note      ${line}`);
}

function buildAskBody(plan, task, cwd = process.cwd()) {
  return {
    kind: plan.primary.kind,
    prompt: task,
    taskTier: plan.tier,
    dangerous: false,
    cwd,
  };
}

const USAGE = `relaybridge — delegate work to AI CLIs on seats you already pay for

  relaybridge plan "<task>"            what to run this on: company, model, effort
  relaybridge plan --stdin              read a UTF-8 task from standard input
  relaybridge ask --prompt-file <path>  read a UTF-8 task without shell quoting
  relaybridge ask "<task>"             plan it, then actually run it
  relaybridge ask --kind claude "..."  run on a specific provider
  relaybridge status                   bridge health and provider readiness
  relaybridge models [--refresh]       models each provider can run, by tier
  relaybridge runs                     live runs: streaming, quiet, or looping
  relaybridge activity [--limit N]     recent calls from every client
  relaybridge auth                     who is installed but signed out
  relaybridge login <kind>             print the sign-in command for a provider
  relaybridge mcp-config               MCP server JSON for any client

Prompt: positional text | --stdin | --prompt-file <path>  (choose exactly one)
Flags: --effort minimal|low|medium|high|max   --kind <provider>   --json

Effort exists so a simple edit does not burn a frontier reasoning budget, and a
hard problem is not starved. Prefer 'plan' before 'ask' when unsure.`;

async function main() {
  const argv = process.argv.slice(2);
  const { flags, rest } = parseFlags(argv);
  const command = rest.shift();
  const json = !!flags.json;

  try {
    switch (command) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        console.log(USAGE);
        return 0;

      case 'plan': {
        const task = resolveTaskInput(flags, rest);
        const plan = await call('/api/plan', { method: 'POST', body: { task, effort: flags.effort || null, kind: flags.kind || null } });
        printPlan(plan, { json });
        return 0;
      }

      case 'ask': {
        const task = resolveTaskInput(flags, rest);
        const plan = await call('/api/plan', { method: 'POST', body: { task, effort: flags.effort || null, kind: flags.kind || null } });
        if (!plan.primary) { console.error('no ready provider for this task; run: relaybridge status'); return 1; }
        if (plan.humanGate && !flags.force) {
          printPlan(plan, { json: false });
          console.error('\nthis task is critical tier: re-run with --force if you accept advisory-only output');
          return 1;
        }
        if (!json) console.error(`# ${plan.primary.kind} · ${plan.primary.model || 'default'} · effort ${plan.effort}`);
        const result = await call('/api/oneshot', {
          method: 'POST',
          // A CLI provider is only workspace-grounded when the bridge spawns
          // it in the directory from which `relaybridge ask` was invoked.
          body: buildAskBody(plan, task),
        });
        if (json) { console.log(JSON.stringify(result, null, 2)); return result.exitCode === 0 && !result.dropped_out ? 0 : 1; }
        if (result.stdout) console.log(result.stdout.trim());
        if (result.stop_reason) console.error(`\n# stopped: ${result.stop_reason} — ${result.stop_detail || ''}`);
        return result.exitCode === 0 && !result.dropped_out ? 0 : 1;
      }

      case 'status': {
        const [health, diag] = await Promise.all([call('/api/health'), call('/api/diag')]);
        if (json) { console.log(JSON.stringify({ health, diag }, null, 2)); return 0; }
        console.log(`bridge    v${health.version}  pid ${health.pid}  ${health.sessionCount} session(s)`);
        const results = diag.results || {};
        const ready = Object.entries(results).filter(([, v]) => v && v.ready).map(([k]) => k);
        const signedOut = Object.entries(results).filter(([, v]) => v && v.found && !v.ready).map(([k]) => k);
        const missing = Object.entries(results).filter(([, v]) => v && !v.found).map(([k]) => k);
        console.log(`ready     ${ready.join(', ') || '(none)'}`);
        if (signedOut.length) console.log(`signedOut ${signedOut.join(', ')}  → relaybridge login <kind>`);
        if (missing.length) console.log(`missing   ${missing.join(', ')}`);
        return 0;
      }

      case 'models': {
        const data = await call('/api/models' + (flags.refresh ? '?refresh=1' : ''));
        if (json) { console.log(JSON.stringify(data, null, 2)); return 0; }
        for (const [kind, provider] of Object.entries(data.providers || {})) {
          if (!provider.modelCount) continue;
          const byTier = { light: [], standard: [], heavy: [] };
          for (const m of provider.models) (byTier[m.tier] || byTier.standard).push(m.id);
          console.log(`${kind}`);
          for (const tier of ['light', 'standard', 'heavy']) {
            if (byTier[tier].length) console.log(`  ${tier.padEnd(9)} ${byTier[tier].slice(0, 6).join(', ')}${byTier[tier].length > 6 ? ` (+${byTier[tier].length - 6})` : ''}`);
          }
        }
        for (const w of data.warnings || []) console.log(`warning   ${w}`);
        return 0;
      }

      case 'runs': {
        const data = await call('/api/runs/active');
        if (json) { console.log(JSON.stringify(data, null, 2)); return 0; }
        if (!data.count) { console.log('no active runs'); return 0; }
        for (const run of data.runs) {
          console.log(`${run.kind.padEnd(14)} ${run.phase.padEnd(13)} ${Math.round(run.idleMs / 1000)}s quiet  ${run.lines} lines  — ${run.assessment}`);
        }
        return 0;
      }

      case 'activity': {
        const data = await call(`/api/telemetry?limit=${Number(flags.limit) || 40}`);
        if (json) { console.log(JSON.stringify(data, null, 2)); return 0; }
        console.log(`totals    ui ${data.totals.ui} · mcp ${data.totals.mcp}${data.totals.other ? ` · other ${data.totals.other}` : ''}`);
        for (const c of data.calls) {
          console.log(`${c.ts.slice(11, 19)}  ${String(c.client).padEnd(4)} ${String(c.method).padEnd(5)} ${c.path.padEnd(26)} ${c.status}  ${c.ms}ms`);
        }
        return 0;
      }

      case 'auth': {
        const data = await call('/api/auth/status' + (flags.refresh ? '?refresh=1' : ''));
        if (json) { console.log(JSON.stringify(data, null, 2)); return 0; }
        if (!data.signedOutCount) { console.log('every installed provider is signed in'); }
        for (const p of data.signedOut || []) {
          console.log(`${p.kind.padEnd(14)} ${p.canSignIn ? `→ relaybridge login ${p.kind}` : 'sign in manually'}  ${p.detail || ''}`);
        }
        if (data.homeMismatch) {
          console.log(`\nWARNING: the bridge home (${data.bridgeHome}) differs from what its children see (${data.credentialHome}).`);
          console.log('That is why sign-ins do not stick — the CLI reads a different profile than the one you logged into.');
        }
        return 0;
      }

      case 'login': {
        const kind = rest[0];
        if (!kind) { console.error('usage: relaybridge login <kind>'); return 2; }
        const data = await call('/api/auth/status');
        const entry = (data.signedOut || []).find((p) => p.kind === kind);
        const cmd = entry?.loginCommand;
        if (!cmd) {
          console.log(`${kind}: no login command configured, or already signed in.`);
          return 0;
        }
        // Printed rather than executed: these flows are interactive browser or
        // device auth and need a real terminal the user is watching.
        console.log(cmd.join(' '));
        return 0;
      }

      case 'mcp-config': {
        const serverPath = path.resolve(__dirname, '..', 'mcp', 'server.mjs');
        const config = {
          mcpServers: {
            relaybridge: {
              command: process.execPath,
              args: [serverPath],
              env: { RELAYBRIDGE_PORT: String(DEFAULT_PORT) },
            },
          },
        };
        console.log(JSON.stringify(config, null, 2));
        return 0;
      }

      default:
        console.error(`unknown command: ${command}\n`);
        console.log(USAGE);
        return 2;
    }
  } catch (err) {
    console.error(`relaybridge: ${err.message}`);
    return err instanceof InputError ? 2 : 1;
  }
}

if (require.main === module) {
  // Set exitCode and let the loop drain instead of calling process.exit().
  // Exiting while the HTTP socket is still closing trips a libuv assertion on
  // Windows (UV_HANDLE_CLOSING) and prints a crash after otherwise-good output.
  const finish = (code) => {
    process.exitCode = code;
    // fetch keeps sockets alive briefly. This timer is unref'd, so it cannot
    // hold the process open by itself, but it will fire and force a clean exit
    // if a lingering keep-alive socket is the only thing left running.
    const bail = setTimeout(() => process.exit(process.exitCode || 0), 1500);
    if (typeof bail.unref === 'function') bail.unref();
  };
  main().then(finish).catch((err) => {
    console.error(`relaybridge: ${err.message}`);
    finish(1);
  });
}

module.exports = { parseFlags, resolveTaskInput, findToken, buildAskBody, USAGE };
