'use strict';
const net = require('node:net');

// This listener runs inside the private network namespace. It performs no
// policy decisions; every byte must traverse the parent CONNECT broker.
async function startNamespaceForwarder({ address, maxConnections = 32, readyTimeoutMs = 1500 } = {}) {
  if (address !== '/relaybridge/proxy.sock' || !Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 32) throw new Error('FORWARDER_CONFIG_INVALID');
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(address);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('FORWARDER_BROKER_UNAVAILABLE')); }, readyTimeoutMs);
    socket.once('error', () => { clearTimeout(timer); reject(new Error('FORWARDER_BROKER_UNAVAILABLE')); });
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(); });
  });
  const peers = new Set(); let closing = false;
  const server = net.createServer({ allowHalfOpen: true }, client => {
    if (closing || peers.size >= maxConnections * 2) return client.destroy();
    const upstream = net.createConnection({ path: address, allowHalfOpen: true });
    peers.add(client); peers.add(upstream);
    const timer = setTimeout(() => { client.destroy(); upstream.destroy(); }, readyTimeoutMs);
    client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
    client.once('close', () => { clearTimeout(timer); peers.delete(client); upstream.destroy(); });
    upstream.once('close', () => { clearTimeout(timer); peers.delete(upstream); client.destroy(); });
    upstream.once('connect', () => { clearTimeout(timer); client.pipe(upstream); upstream.pipe(client); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  const url = 'http://127.0.0.1:' + server.address().port;
  return { url, close() { closing = true; for (const peer of peers) peer.destroy(); return new Promise(resolve => server.close(resolve)); } };
}
module.exports = { startNamespaceForwarder };
