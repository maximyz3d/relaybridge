'use strict';
const fs = require('node:fs');
const readline = require('node:readline');
const [logPath, mode = 'normal'] = process.argv.slice(2);
const record = value => fs.appendFileSync(logPath, JSON.stringify({ pid: process.pid, ...value }) + '\n');
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
record({ event: 'start' });
if (mode !== 'no-ready') process.send?.({ type: 'relaybridge_adapter_ready' });
let reverseCall = null;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); record({ event: 'in', message });
  if (message.method === 'initialize') {
    send({ id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'protocol-fixture', version: '1' } } });
  } else if (message.method === 'tools/call') {
    if (message.params.name === 'hold') return;
    if (message.params.name === 'crash') { record({ event: 'effect' }); process.exit(86); }
    if (message.params.name === 'reverse') {
      reverseCall = message.id;
      send({ id: 'fixture-server-request', method: 'roots/list', params: {} });
      send({ method: 'notifications/cancelled', params: { requestId: 'fixture-server-request', reason: 'fixture cancellation' } });
      send({ id: reverseCall, result: { content: [{ type: 'text', text: 'reverse-cancelled' }] } });
      return;
    }
    send({ id: message.id, result: { content: [{ type: 'text', text: 'fixture-ok' }] } });
  } else if (!message.method && message.id === 'fixture-server-request' && reverseCall) {
    send({ id: reverseCall, result: { content: [{ type: 'text', text: 'reverse-reply-routed' }] } });
  }
});
process.stdin.on('end', () => process.exit(0));
