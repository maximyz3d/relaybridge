// Functional MCP smoke test: initialize -> tools/list -> tools/call.
//
// tools/list only proves the server advertises tools. This actually invokes
// them over stdio the way Claude Desktop or Cursor would, so a broken handler
// or a bridge that is down shows up here rather than in front of a user.
import { spawn } from 'node:child_process';

// The MCP client resolves the bridge from RELAYBRIDGE_URL, so the test must set
// that — setting RELAYBRIDGE_PORT alone silently targets the default port.
const PORT = process.env.RELAYBRIDGE_PORT || '8787';
const BRIDGE_URL = process.env.RELAYBRIDGE_URL || `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, ['mcp/server.mjs'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, RELAYBRIDGE_URL: BRIDGE_URL, RELAYBRIDGE_PORT: PORT },
});

const pending = new Map();
let nextId = 1;
let buf = '';

child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function rpc(method, params = {}, timeoutMs = 30000) {
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve({ error: { message: `timed out after ${timeoutMs}ms` } }); }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function textOf(res) {
  const content = res?.result?.content;
  if (!Array.isArray(content)) return null;
  return content.map((c) => c.text || '').join('').trim();
}

const line = (label, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(34)} ${detail}`);
let failures = 0;
const check = (label, ok, detail) => { if (!ok) failures++; line(label, ok, detail); };

(async () => {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'relaybridge-smoke', version: '1.0' },
  });
  check('initialize', !!init.result, init.result ? `${init.result.serverInfo?.name} ${init.result.serverInfo?.version}` : JSON.stringify(init.error));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await rpc('tools/list');
  const names = list.result?.tools?.map((t) => t.name) || [];
  check('tools/list', names.length > 0, `${names.length} tools`);

  // Calling, not just listing. A handler that throws or a bridge that is not
  // running both surface here.
  const status = await rpc('tools/call', { name: 'bridge_status', arguments: {} });
  const statusText = textOf(status);
  check('call bridge_status', !!statusText && !status.result?.isError, (statusText || '').slice(0, 70).replace(/\s+/g, ' '));

  const plan = await rpc('tools/call', { name: 'plan_task', arguments: { task: 'rename a CSS class in one stylesheet' } });
  const planText = textOf(plan);
  let planOk = false;
  let planDetail = (planText || '').slice(0, 70);
  try {
    const parsed = JSON.parse(planText);
    // A trivial edit must not be planned onto a frontier seat at high effort —
    // that is the whole reason this tool exists.
    if (parsed.primary) {
      planOk = ['minimal', 'low', 'medium'].includes(parsed.effort);
      planDetail = `tier=${parsed.tier} effort=${parsed.effort} -> ${parsed.primary.kind} (${parsed.primary.costClass})`;
    } else {
      // No providers ready is a valid answer on a bare machine, but only if the
      // plan explains itself rather than returning a silent null.
      planOk = Array.isArray(parsed.guidance) && parsed.guidance.some((g) => /No provider is both installed/.test(g));
      planDetail = planOk ? 'no ready provider (explained correctly)' : 'no ready provider AND no explanation';
    }
  } catch { /* keep the raw text as the detail */ }
  check('call plan_task (trivial task)', planOk, planDetail);

  const models = await rpc('tools/call', { name: 'list_models', arguments: { refresh: false } });
  const modelsText = textOf(models);
  let modelCount = 0;
  try { modelCount = JSON.parse(modelsText).totalModels || 0; } catch { /* ignore */ }
  check('call list_models', !!modelsText && !models.result?.isError, `${modelCount} models discovered`);

  const runs = await rpc('tools/call', { name: 'list_active_runs', arguments: {} });
  check('call list_active_runs', !!textOf(runs) && !runs.result?.isError, (textOf(runs) || '').slice(0, 60).replace(/\s+/g, ' '));

  console.log('');
  console.log(failures === 0 ? 'MCP server is fully functional over stdio.' : `${failures} check(s) failed.`);
  child.kill();
  process.exitCode = failures === 0 ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 500).unref();
})();
