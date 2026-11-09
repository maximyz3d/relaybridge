'use strict';

// Test-only preload (`node --require`). Refuses and records every
// non-loopback connection or name lookup made by the process, so a test can
// prove a real provider API was never contacted. Never loaded by production.

const fs = require('node:fs');
const net = require('node:net');
const dns = require('node:dns');

const LOG = process.env.DENY_EGRESS_LOG;
const loopback = (host) => host === undefined || host === null || host === '' || host === 'localhost'
  || /^127\./.test(host) || host === '::1' || host === '[::1]' || host === '::ffff:127.0.0.1';
const record = (kind, host) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify({ kind, host: String(host) }) + '\n'); };
const refusal = (host) => Object.assign(new Error(`egress denied: ${host}`), { code: 'EGRESS_DENIED' });

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first && typeof first === 'object' ? first : { port: first, host: typeof args[1] === 'string' ? args[1] : undefined };
  if (!options.path && !loopback(options.host)) {
    record('connect', options.host);
    process.nextTick(() => this.destroy(refusal(options.host)));
    return this;
  }
  return connect.apply(this, args);
};

const lookup = dns.lookup;
dns.lookup = function (host, ...rest) {
  if (!loopback(host)) {
    record('lookup', host);
    const callback = rest.find((value) => typeof value === 'function');
    if (callback) process.nextTick(() => callback(refusal(host)));
    return {};
  }
  return lookup.call(this, host, ...rest);
};
const lookupAsync = dns.promises.lookup;
dns.promises.lookup = function (host, ...rest) {
  if (!loopback(host)) { record('lookup', host); return Promise.reject(refusal(host)); }
  return lookupAsync.call(this, host, ...rest);
};
