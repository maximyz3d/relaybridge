#!/usr/bin/env node
'use strict';
const { startNamespaceForwarder } = require('../lib/namespace-forwarder');

(async () => {
  if (process.platform !== 'linux' || process.pid !== 1 || process.argv[2] !== '--') process.exit(78);
  // No owner hello or provider release occurs before the isolated proxy exists.
  const proxy = await startNamespaceForwarder({ address: '/relaybridge/proxy.sock' });
  for (const key of ['ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy', 'WS_PROXY', 'WSS_PROXY']) delete process.env[key];
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) process.env[key] = proxy.url;
  process.env.NO_PROXY = ''; process.env.no_proxy = '';
  // The existing gate owns authenticated proceed/stop and namespace death.
  // Its argv contract is unchanged, and its own module is mounted read-only.
  process.argv[1] = '/relaybridge/tools/pid1-gate.js';
  require('./pid1-gate');
})().catch(() => process.exit(78));
