#!/usr/bin/env node
'use strict';
// Compose with an existing Claude statusLine command: the installer never
// replaces user settings. Reads stdin only; forwards an allowlisted quota DTO.
const fs = require('node:fs');
const path = require('node:path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { if (input.length < 262144) input += chunk; });
process.stdin.on('end', async () => {
  try {
    if (input.length > 262144) return;
    const payload = JSON.parse(input), rate_limits = {};
    for (const key of ['five_hour', 'seven_day']) {
      const value = payload.rate_limits?.[key];
      if (value) rate_limits[key] = { used_percentage: value.used_percentage, resets_at: value.resets_at };
    }
    if (!Object.keys(rate_limits).length) return;
    const root = path.resolve(__dirname, '..');
    const token = fs.readFileSync(process.env.RELAYBRIDGE_TOKEN_FILE || path.join(root, '.bridge-token'), 'utf8').trim();
    const base = new URL(process.env.RELAYBRIDGE_URL || 'http://127.0.0.1:8787');
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) return;
    await fetch(new URL('/api/usage/native', base), { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-RelayBridge-Token': token },
      body: JSON.stringify({ kind: 'claude', rate_limits,
        ...(process.env.RELAYBRIDGE_USAGE_ACCOUNT_ID ? { accountId: process.env.RELAYBRIDGE_USAGE_ACCOUNT_ID } : {}) }),
      signal: AbortSignal.timeout(1500) });
  } catch { /* A status line must never block or reveal credentials on failure. */ }
});
