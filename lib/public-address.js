'use strict';
const net = require('node:net');

// Conservative subset of global unicast. All IANA special-purpose allocations
// below are denied, including their public exceptions. This is a versioned
// policy, not proof of actual routing or a substitute for trusted host routes.
const POLICY = 'iana-global-unicast-subset-2025-10-09-v1';
const V4_DENIED = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
  '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
  '192.31.196.0/24', '192.52.193.0/24', '192.88.99.0/24', '192.168.0.0/16',
  '192.175.48.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
  '224.0.0.0/4', '240.0.0.0/4'];
const V6_DENIED = ['2001::/23', '2001:db8::/32', '2002::/16', '2620:4f:8000::/48', '3ffe::/16', '3fff::/20'];
function numeric(address) {
  if (typeof address !== 'string' || address.includes('%')) return null;
  const family = net.isIP(address);
  if (family === 4) return { family, bits: 32, value: address.split('.').reduce((n, x) => (n << 8n) | BigInt(x), 0n) };
  if (family !== 6 || address.includes('.')) return null; // No mapped/transition IPv4 forms.
  const halves = address.toLowerCase().split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return { family, bits: 128, value: words.reduce((n, x) => (n << 16n) | BigInt('0x' + x), 0n) };
}
function inPrefix(ip, cidr) {
  const [address, size] = cidr.split('/'), base = numeric(address);
  return ip.family === base.family && (ip.value >> BigInt(ip.bits - Number(size))) === (base.value >> BigInt(base.bits - Number(size)));
}
function addressKey(address) { const ip = numeric(address); return ip ? ip.family + ':' + ip.value.toString(16) : null; }
function isPublicAddress(address) {
  const ip = numeric(address); if (!ip) return false;
  if (ip.family === 4) return !V4_DENIED.some(cidr => inPrefix(ip, cidr));
  return inPrefix(ip, '2000::/3') && !V6_DENIED.some(cidr => inPrefix(ip, cidr));
}
module.exports = { POLICY, isPublicAddress, addressKey };
