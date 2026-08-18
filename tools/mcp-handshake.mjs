// Speaks the real MCP stdio handshake, exactly as Cursor/Claude Desktop would:
// initialize -> tools/list. If this works, a client can use the server.
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['mcp/server.mjs'], { stdio: ['pipe','pipe','pipe'], env: { ...process.env, RELAYBRIDGE_PORT: '8817' } });
let buf = '';
const seen = [];
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { seen.push(JSON.parse(line)); } catch { /* not a frame */ }
  }
});
const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'handshake-probe', version: '1.0' } } });
setTimeout(() => { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }); }, 900);
setTimeout(() => {
  const init = seen.find((m) => m.id === 1);
  const tools = seen.find((m) => m.id === 2);
  console.log('initialize:', init?.result ? `OK (${init.result.serverInfo?.name} ${init.result.serverInfo?.version})` : 'FAILED');
  const names = tools?.result?.tools?.map((t) => t.name) || [];
  console.log('tools/list:', names.length ? `${names.length} tools` : 'FAILED');
  for (const want of ['plan_task','list_models','list_active_runs','bridge_activity','ask_provider','route_preview']) {
    console.log(`  ${names.includes(want) ? 'OK  ' : 'MISS'} ${want}`);
  }
  child.kill();
  process.exit(0);
}, 4000);
