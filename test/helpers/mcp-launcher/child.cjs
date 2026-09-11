'use strict';
// Non-provider MCP process. All effects are confined to the supplied temp log.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const [repo, logPath] = process.argv.slice(2);
const req = createRequire(path.join(repo, 'package.json'));
const { McpServer } = req('@modelcontextprotocol/server');
const { serveStdio, StdioServerTransport } = req('@modelcontextprotocol/server/stdio');
const { z } = req('zod');
const record = (event) => fs.appendFileSync(logPath, JSON.stringify({ at: Date.now(), pid: process.pid, ...event }) + '\n');
record({ event: 'start', ppid: process.ppid });
process.on('exit', (code) => record({ event: 'exit', code }));
const wire = new StdioServerTransport();
const originalStart = wire.start.bind(wire);
wire.start = async () => {
  const downstream = wire.onmessage;
  wire.onmessage = (message) => {
    record({ event: 'in', message });
    downstream?.(message);
  };
  await originalStart();
};
const originalSend = wire.send.bind(wire);
wire.send = async (message) => {
  record({ event: 'out', message });
  return originalSend(message);
};
function result(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}
serveStdio(() => {
  const server = new McpServer({ name: 'relaybridge-launcher-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.registerTool('fixture_echo', {
    description: 'Return a fake child identity; never calls a model.',
    inputSchema: z.object({ label: z.string() }),
    annotations: { readOnlyHint: true },
  }, async ({ label }) => {
    record({ event: 'tool', name: 'fixture_echo', label });
    return result({ pid: process.pid, label });
  });
  server.registerTool('fixture_hold', {
    description: 'Hold a fake request until the fixture child exits.',
    inputSchema: z.object({ label: z.string() }),
  }, async ({ label }) => {
    record({ event: 'tool', name: 'fixture_hold', label });
    await new Promise((resolve) => setTimeout(resolve, 30000));
    return result({ pid: process.pid, label, completed: true });
  });
  server.registerTool('fixture_effect_then_crash', {
    description: 'Record a temp-file-only side effect, then exit without a response.',
    inputSchema: z.object({ label: z.string() }),
  }, async ({ label }) => {
    record({ event: 'side_effect', name: 'fixture_effect_then_crash', label });
    setImmediate(() => process.exit(86));
    return new Promise(() => {});
  });
  return server;
}, { transport: wire, onerror: (error) => record({ event: 'sdk_error', message: String(error.message) }) });
process.stdin.on('end', () => process.exit(0));
