'use strict';

// Windows-side half of RelayBridge's WSL NAT fallback. It binds only the
// private Hyper-V/WSL adapter address and forwards to Chrome's loopback-only
// DevTools listener. A second, Linux-side socat process keeps the MCP endpoint
// itself on 127.0.0.1 inside WSL.

const net = require('node:net');

const listenHost = String(process.argv[2] || '');
const listenPortText = String(process.argv[3] || '');
const targetPortText = String(process.argv[4] || '');
const allowedSource = String(process.argv[5] || '');

function isPrivateIpv4(value) {
  if (net.isIP(value) !== 4) return false;
  const octets = value.split('.').map(Number);
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function validPort(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 65535;
}

function parsePort(value) {
  if (!/^[0-9]+$/.test(value)) return null;
  const parsed = Number(value);
  return validPort(parsed) ? parsed : null;
}

function normalizeIpv4(value) {
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}

function createProxy({ host, port, destinationPort, source }, netModule = net) {
  const server = netModule.createServer((client) => {
    if (normalizeIpv4(String(client.remoteAddress || '')) !== source) {
      client.destroy();
      return;
    }

    const upstream = netModule.connect({ host: '127.0.0.1', port: destinationPort });
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    client.on('error', close);
    client.on('close', () => upstream.destroy());
    upstream.on('error', close);
    upstream.on('close', () => client.destroy());
    client.pipe(upstream).pipe(client);
  });

  server.maxConnections = 64;
  server.on('error', (error) => {
    process.stderr.write(`${error.code || 'ERROR'}: ${error.message}\n`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    process.stdout.write(`ready ${host}:${port}\n`);
  });
  return server;
}

if (require.main === module) {
  const listenPort = parsePort(listenPortText);
  const targetPort = parsePort(targetPortText);
  if (process.platform !== 'win32') {
    process.stderr.write('this helper must run with Windows node.exe\n');
    process.exit(2);
  }
  if (!isPrivateIpv4(listenHost) || listenPort === null || targetPort === null
      || !isPrivateIpv4(allowedSource) || allowedSource === listenHost) {
    process.stderr.write('private WSL adapter/source addresses and valid ports are required\n');
    process.exit(2);
  }

  const server = createProxy({
    host: listenHost,
    port: listenPort,
    destinationPort: targetPort,
    source: allowedSource,
  });
  const closeServer = () => server.close(() => process.exit(0));
  process.once('SIGINT', closeServer);
  process.once('SIGTERM', closeServer);
}

module.exports = { createProxy, isPrivateIpv4, normalizeIpv4, parsePort, validPort };
