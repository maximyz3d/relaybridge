#!/usr/bin/env node
'use strict';

const net = require('node:net');
const { spawn } = require('node:child_process');
const { framedPeer } = require('../lib/owner-control');

// Must actually be PID 1: a PID-2 gate exiting does not destroy its namespace.
// No provider is started until the relay birth-pins this namespace and grants
// proceed over the private, one-run control channel. Provider stdio is passed
// through unchanged; the gate never reads provider stdin or copies output.
async function main() {
  const address = process.env.RELAYBRIDGE_OWNER_SOCKET;
  const nonce = process.env.RELAYBRIDGE_OWNER_NONCE;
  const runId = process.env.RELAYBRIDGE_OWNER_RUN_ID;
  const providerNodeOptions = process.env.RELAYBRIDGE_OWNER_PROVIDER_NODE_OPTIONS;
  for (const key of ['RELAYBRIDGE_OWNER_SOCKET', 'RELAYBRIDGE_OWNER_NONCE', 'RELAYBRIDGE_OWNER_RUN_ID']) delete process.env[key];
  delete process.env.RELAYBRIDGE_OWNER_PROVIDER_NODE_OPTIONS;
  if (process.platform !== 'linux' || process.pid !== 1 || process.argv[2] !== '--'
    || !process.argv[3]?.startsWith('/') || !address || !/^[a-f0-9]{64}$/.test(nonce || '')
    || !/^run_[A-Za-z0-9_-]{1,100}$/.test(runId || '')) process.exit(78);
  let released = false, stopping = false, child = null;
  const socket = net.createConnection(address);
  const terminate = () => {
    if (stopping) return;
    stopping = true;
    // Exiting namespace PID 1 atomically denies further forks and makes the
    // kernel kill all remaining namespace processes, including setsid orphans.
    process.exit(78);
  };
  const timer = setTimeout(terminate, 2000);
  const peer = framedPeer(socket, {
    onClose: terminate,
    async onMessage(message) {
      if (message.runId !== runId || message.nonce !== undefined) throw new Error('wrong owner association');
      if (message.type === 'stop') {
        try { await peer.send({ type: 'stop_ack', runId }); } finally { terminate(); }
        return;
      }
      if (message.type !== 'proceed' || released || stopping) throw new Error('out-of-order owner command');
      released = true; clearTimeout(timer);
      await peer.send({ type: 'proceed_ack', runId });
      if (peer.ended || stopping) return terminate();
      const providerEnv = { ...process.env };
      if (providerNodeOptions !== undefined) {
        if (providerNodeOptions) providerEnv.NODE_OPTIONS = providerNodeOptions;
        else delete providerEnv.NODE_OPTIONS;
      }
      child = spawn(process.argv[3], process.argv.slice(4), { stdio: 'inherit', env: providerEnv });
      child.once('spawn', () => { peer.send({ type: 'provider_spawned', runId, pid: child.pid }).catch(terminate); });
      child.once('error', async () => {
        try { await peer.send({ type: 'provider_spawn_failed', runId }); } finally { terminate(); }
      });
      child.once('exit', async (code, signal) => {
        stopping = true;
        try { await peer.send({ type: 'root_exit', runId, code, signal }); }
        finally { process.exit(Number.isInteger(code) && code >= 0 && code <= 255 ? code : 1); }
      });
    },
  });
  process.on('SIGTERM', terminate); process.on('SIGINT', terminate); process.on('SIGHUP', terminate);
  socket.once('connect', () => { peer.send({ type: 'hello', version: 1, runId, nonce, pid1: true, namespacePid: process.pid }).catch(terminate); });
}

main().catch(() => process.exit(78));
