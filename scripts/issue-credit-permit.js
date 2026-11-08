#!/usr/bin/env node
'use strict';
// Owner-run issuer for a v2 (spend-ledger) credit permit. Not reachable from the
// server, CLI or MCP. No network. The credential is read from --key-file only to
// compute credentialHmac; it is never printed or stored.
//   node scripts/issue-credit-permit.js --provider openai|claude --data-dir <dir> --key-file <path> [--replace]
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const prepaid = require('../lib/prepaid-authorization');
const promo = require('../lib/promotional-authorization');

const fail = (message) => { throw Object.assign(new Error(message), { issuer: true }); };

function parseArgs(argv) {
  const out = { replace: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--replace') out.replace = true;
    else if (['--provider', '--data-dir', '--key-file'].includes(a)) {
      if (i + 1 >= argv.length) fail(`${a} needs a value`);
      out[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
    } else fail(`unknown argument ${a}`);
  }
  if (!['openai', 'claude'].includes(out.provider)) fail('--provider must be openai or claude');
  if (!out.dataDir || !out.keyFile) fail('--data-dir and --key-file are required');
  return out;
}

const iso = (ms) => new Date(ms).toISOString();

// Pure: observed values in, validated permit out. Throws on any validation failure.
function buildPermit(provider, v, { credential, now }) {
  const id = v.authorizationId || `${provider === 'openai' ? 'pa' : 'pp'}_${crypto.randomBytes(6).toString('hex')}`;
  const issuedAt = iso(now), observedAt = v.observedAt || issuedAt;
  const pricing = Object.fromEntries(v.models.map((m) => [m, { ...v.pricing[m] }]));
  const ledger = { budgetCents: v.budgetCents, reserveCents: v.reserveCents, pricing };
  const common = { schemaVersion: 2, authorizationId: id, supervised: true, noPurchases: true, profileId: v.profileId,
    profileRevision: v.profileRevision, organization: v.organization, credentialHmac: prepaid.credentialHmac(id, credential),
    models: v.models, issuedAt, expiresAt: iso(now + v.validHours * 3600 * 1000), revokedAt: null };
  if (provider === 'openai') {
    return prepaid.validateAuthorization({ ...common, policy: prepaid.PREPAID_POLICY, provider, surface: 'openai_responses_agent',
      project: v.project,
      providerControls: { autoReload: 'off', hardLimitCents: v.hardLimitCents, hardLimitScope: v.hardLimitScope, hardLimitEnforced: true, observedAt },
      balance: { observedBalanceCents: v.observedBalanceCents, observedAt, earliestCreditExpiry: v.earliestCreditExpiry }, ledger });
  }
  return promo.validateAuthorization({ ...common, policy: promo.PROMOTIONAL_POLICY, provider, surface: 'claude_messages_agent',
    workspace: v.workspace,
    providerControls: { autoReload: 'off', billingMode: 'pay_as_you_go', operatorSpendLimitCents: v.operatorSpendLimitCents,
      operatorSpendLimitScope: 'organization', operatorSpendLimitActive: true, observedAt },
    balance: { observedPromotionalCents: v.observedPromotionalCents, observedPurchasedCents: v.observedPurchasedCents,
      observedMonthSpendCents: v.observedMonthSpendCents, promotionalExpiry: v.promotionalExpiry, observedAt }, ledger });
}

function existingUnexpired(file, now) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  try {
    const p = JSON.parse(raw);
    return p.revokedAt == null && Date.parse(p.expiresAt) > now;
  } catch { return true; } // unreadable: do not overwrite blindly
}

function writeAtomic(file, permit, { replace = true } = {}) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeSync(fd, JSON.stringify(permit, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.chmodSync(tmp, 0o600);
  if (replace) { fs.renameSync(tmp, file); return; }
  // Exclusive publish: link fails with EEXIST rather than overwrite a permit created meanwhile.
  try { fs.linkSync(tmp, file); }
  catch (e) { try { fs.unlinkSync(tmp); } catch {} if (e.code === 'EEXIST') fail(`a permit appeared at ${file}; pass --replace to overwrite`); throw e; }
  try { fs.unlinkSync(tmp); } catch {}
}

function createAsker(input, output) {
  const rl = readline.createInterface({ input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  return {
    async ask(label, { parse = (s) => s, fallback } = {}) {
      output.write(`${label}${fallback !== undefined ? ` [${fallback}]` : ''}: `);
      const { value, done } = await lines.next();
      if (done) fail(`input ended while asking: ${label}`);
      const text = String(value).trim();
      return text === '' && fallback !== undefined ? fallback : parse(text);
    },
    close: () => rl.close(),
  };
}
const int = (s) => { if (!/^\d+$/.test(s)) fail(`not a non-negative integer: ${s}`); return Number(s); };
const text = (s) => { if (!s) fail('a value is required'); return s; };

async function collect(provider, a) {
  const v = {};
  v.authorizationId = await a.ask('authorizationId (blank to generate)', { fallback: '' }) || undefined;
  v.profileId = await a.ask('funding profile id', { parse: text });
  v.profileRevision = await a.ask('profile revision', { parse: int });
  v.organization = await a.ask('organization reference', { parse: text });
  v.models = (await a.ask('models (comma separated)', { parse: text })).split(',').map((s) => s.trim()).filter(Boolean);
  v.validHours = await a.ask('permit window in hours', { parse: int, fallback: 24 });
  if (provider === 'openai') {
    v.project = await a.ask('project reference', { parse: text });
    v.hardLimitCents = await a.ask('observed provider hard limit (cents)', { parse: int });
    v.hardLimitScope = await a.ask('hard limit scope (organization|project)', { parse: text });
    v.observedBalanceCents = await a.ask('observed credit balance (cents)', { parse: int });
    v.earliestCreditExpiry = await a.ask('earliest credit expiry (YYYY-MM-DD)', { parse: text });
  } else {
    const ws = await a.ask('workspace reference (blank for none)', { fallback: '' });
    v.workspace = ws === '' ? null : ws;
    v.operatorSpendLimitCents = await a.ask('observed monthly spend limit (cents)', { parse: int });
    v.observedPromotionalCents = await a.ask('observed promotional balance (cents)', { parse: int });
    v.observedPurchasedCents = await a.ask('observed purchased balance (cents)', { parse: int });
    v.observedMonthSpendCents = await a.ask('observed month-to-date spend (cents)', { parse: int });
    v.promotionalExpiry = await a.ask('promotional credit expiry (YYYY-MM-DD)', { parse: text });
  }
  v.budgetCents = await a.ask('ledger budget (cents, excludes reserve)', { parse: int });
  v.reserveCents = await a.ask('ledger reserve (cents)', { parse: int });
  v.pricing = {};
  for (const m of v.models) {
    v.pricing[m] = {};
    for (const k of ['inputCentsPerMTok', 'outputCentsPerMTok', 'cacheWriteCentsPerMTok', 'cacheReadCentsPerMTok']) {
      v.pricing[m][k] = await a.ask(`${m} ${k}`, { parse: int });
    }
  }
  return v;
}

async function main(argv = process.argv.slice(2), { input = process.stdin, output = process.stdout, now = Date.now() } = {}) {
  const args = parseArgs(argv);
  const dataDir = path.resolve(args.dataDir);
  const file = path.join(dataDir, args.provider === 'openai' ? 'prepaid-authorization.json' : 'promotional-authorization.json');
  if (!fs.statSync(dataDir, { throwIfNoEntry: false })?.isDirectory()) fail('--data-dir must be an existing directory');
  if (existingUnexpired(file, now) && !args.replace) fail(`an unexpired permit exists at ${file}; pass --replace to overwrite`);
  // The server compares the raw env value untrimmed, so the HMAC input must be the exact key:
  // only one trailing newline is dropped; any other surrounding whitespace is refused.
  let credential = fs.readFileSync(args.keyFile, 'utf8');
  if (credential.endsWith('\n')) credential = credential.slice(0, -1);
  if (credential !== credential.trim()) fail('key file has leading or trailing whitespace other than one trailing newline; fix the file');
  if (!credential) fail('key file is empty');
  const asker = createAsker(input, output);
  let values;
  try { values = await collect(args.provider, asker); } finally { asker.close(); }
  const permit = buildPermit(args.provider, values, { credential, now });
  writeAtomic(file, permit, { replace: !!args.replace });
  output.write(`\nwrote ${file} (mode 0600)\nauthorizationId ${permit.authorizationId}\nexpires ${permit.expiresAt}\n`);
  return permit;
}

if (require.main === module) {
  main().catch((error) => { process.stderr.write(`issue-credit-permit: ${error.issuer ? error.message : error.code || error.message}\n`); process.exit(1); });
}
module.exports = { main, buildPermit, parseArgs };
