'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createCreditLedger, chargeCents, estimateCents } = require('../lib/credit-ledger');

const ID = 'pp_ledger_1', HASH = 'a'.repeat(64);
const RATES = { inputCentsPerMTok: 300, outputCentsPerMTok: 1500, cacheWriteCentsPerMTok: 375, cacheReadCentsPerMTok: 30 };
const base = (patch = {}) => ({ authorizationId: ID, authorizationHash: HASH, policy: 'owner_authorized_promotional', provider: 'claude',
  organization: 'org_x', scopeRef: 'wrk_x', evidence: 'qualification:pp_ledger_1', budgetCents: 100, reserveCents: 100,
  model: 'claude-sonnet-5-5', estimateCents: 10, requestKey: 'run_a:1', ...patch });
function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-ledger-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, ledger: createCreditLedger({ dataDir, now: () => Date.parse('2026-11-07T00:00:00.000Z') }) };
}
const receipts = (dataDir) => fs.readFileSync(path.join(dataDir, 'credit-ledger', 'receipts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

test('charge and estimate round up from integer cents-per-MTok rates', () => {
  assert.equal(chargeCents({ input_tokens: 1000, output_tokens: 100 }, RATES), 1); // 0.3 + 0.15 -> 1
  assert.equal(chargeCents({ input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 }, RATES), 300 + 1500 + 375 + 30);
  assert.equal(chargeCents({ input_tokens: 0, output_tokens: 0 }, RATES), 0);
  assert.equal(chargeCents(null, RATES), null); assert.equal(chargeCents({ input_tokens: 1, output_tokens: null }, RATES), null);
  assert.equal(chargeCents({ input_tokens: -1, output_tokens: 1 }, RATES), null);
  assert.equal(estimateCents({ requestBytes: 4000, maxOutputTokens: 1000, rates: RATES }), 3); // 1.2+1.5=2.7
  assert.equal(estimateCents({ requestBytes: 0, maxOutputTokens: 0, rates: RATES }), 1);
});

test('ledger files are private, reserve then settle charge usage, and receipts carry the scope but no secrets', (t) => {
  const { dataDir, ledger } = setup(t);
  const r = ledger.reserve(base());
  assert.equal(r.heldCents, 10); assert.equal(r.remainingCents, 90);
  const dir = path.join(dataDir, 'credit-ledger');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, `${ID}.json`)).mode & 0o777, 0o600);
  const s = ledger.settle({ authorizationId: ID, requestKey: 'run_a:1', disposition: 'settled', pricing: RATES,
    usage: { input_tokens: 10_000, output_tokens: 2000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
  assert.equal(s.chargedCents, 6); assert.equal(s.spentCents, 6); assert.equal(s.heldCents, 0); assert.equal(s.remainingCents, 94);
  assert.equal(fs.statSync(path.join(dir, 'receipts.jsonl')).mode & 0o777, 0o600);
  const [row] = receipts(dataDir);
  for (const k of ['at', 'provider', 'organization', 'scope', 'policy', 'authorizationId', 'authorizationHash', 'evidence', 'requestKey', 'model',
    'reservedCents', 'usage', 'chargedCents', 'disposition', 'providerErrorClass', 'spentCentsAfter', 'remainingCentsAfter', 'exhausted']) assert.ok(Object.hasOwn(row, k), k);
  assert.equal(row.disposition, 'settled'); assert.equal(row.scope, 'wrk_x'); assert.equal(row.spentCentsAfter, 6);
  assert.ok(!/hmac|fingerprint|sk-/i.test(JSON.stringify(row)));
  assert.equal(ledger.summary({ authorizationId: ID }).turns[0].chargedCents, 6);
  assert.equal(ledger.summary({ authorizationId: 'pp_none' }), null);
});

test('dispositions: provider_error and not_sent charge 0, uncertain and missing usage charge the reservation, overrun is recorded', (t) => {
  const { dataDir, ledger } = setup(t);
  const run = (k, disposition, extra = {}) => { ledger.reserve(base({ requestKey: k })); return ledger.settle({ authorizationId: ID, requestKey: k, disposition, pricing: RATES, ...extra }); };
  assert.equal(run('k:1', 'provider_error', { providerErrorClass: 'rate_limited' }).chargedCents, 0);
  assert.equal(run('k:2', 'not_sent').chargedCents, 0);
  assert.equal(run('k:3', 'outcome_uncertain').chargedCents, 10);
  const missing = run('k:4', 'settled', { usage: null });
  assert.equal(missing.chargedCents, 10); assert.equal(missing.disposition, 'usage_missing_charged_reservation');
  const over = run('k:5', 'settled', { usage: { input_tokens: 1_000_000, output_tokens: 0 } });
  assert.equal(over.chargedCents, 300); assert.equal(over.overrun, true);
  const rows = receipts(dataDir);
  assert.equal(rows[0].providerErrorClass, 'rate_limited'); assert.equal(rows[4].overrun, true);
  assert.equal(rows[3].disposition, 'usage_missing_charged_reservation');
});

test('exhaustion: budget is spendable (reserve excluded), refusals carry reasons, markExhausted is permanent', (t) => {
  const { ledger, dataDir } = setup(t);
  ledger.reserve(base({ estimateCents: 60 }));
  assert.throws(() => ledger.reserve(base({ requestKey: 'run_a:2', estimateCents: 41 })), (e) => e.code === 'funding_exhausted' && e.reason === 'local_budget_exhausted');
  ledger.reserve(base({ requestKey: 'run_a:2', estimateCents: 40 })); // exactly the budget
  assert.throws(() => ledger.reserve(base({ requestKey: 'run_a:3', estimateCents: 1 })), (e) => e.reason === 'local_budget_exhausted');
  // unsettled holds persist across a new ledger instance (crash = pessimistic hold)
  assert.equal(createCreditLedger({ dataDir }).summary({ authorizationId: ID }).heldCents, 100);
  ledger.markExhausted({ authorizationId: ID, cause: 'spend_limit' });
  assert.throws(() => ledger.reserve(base({ requestKey: 'run_a:9', estimateCents: 1 })), (e) => e.code === 'funding_exhausted' && e.reason === 'ledger_exhausted');
  assert.equal(ledger.summary({ authorizationId: ID }).exhausted, true);
  assert.throws(() => ledger.markExhausted({ authorizationId: ID, cause: 'bogus' }), { code: 'credit_ledger_invalid' });
});

test('duplicate keys, changed permit hash, bad inputs and unknown settle fail closed', (t) => {
  const { dataDir, ledger } = setup(t);
  ledger.reserve(base());
  assert.throws(() => ledger.reserve(base()), { code: 'credit_ledger_duplicate' });
  ledger.settle({ authorizationId: ID, requestKey: 'run_a:1', disposition: 'not_sent' });
  assert.throws(() => ledger.reserve(base()), { code: 'credit_ledger_duplicate' });
  assert.throws(() => ledger.settle({ authorizationId: ID, requestKey: 'run_a:1', disposition: 'not_sent' }), { code: 'credit_ledger_duplicate' });
  assert.throws(() => ledger.settle({ authorizationId: ID, requestKey: 'nope', disposition: 'not_sent' }), { code: 'credit_ledger_invalid' });
  assert.throws(() => ledger.reserve(base({ requestKey: 'run_a:2', authorizationHash: 'b'.repeat(64) })), { code: 'funding_decision_changed' });
  assert.throws(() => ledger.reserve(base({ requestKey: 'run_a:2', budgetCents: 99 })), { code: 'funding_decision_changed' });
  assert.throws(() => ledger.reserve(base({ requestKey: 'run_a:2', estimateCents: 0 })), { code: 'credit_ledger_invalid' });
  assert.throws(() => ledger.reserve(base({ authorizationId: '../x', requestKey: 'run_a:2' })), { code: 'credit_ledger_invalid' });
  fs.writeFileSync(path.join(dataDir, 'credit-ledger', `${ID}.json`), '{not json');
  assert.throws(() => ledger.reserve(base({ requestKey: 'run_a:3' })), { code: 'credit_ledger_invalid' });
});

test('a held lockfile fails closed with credit_ledger_locked and is never stolen', (t) => {
  const { dataDir, ledger } = setup(t);
  ledger.reserve(base());
  const lock = path.join(dataDir, 'credit-ledger', `${ID}.lock`);
  fs.writeFileSync(lock, '1', { mode: 0o600 });
  assert.throws(() => ledger.reserve(base({ requestKey: 'run_a:2' })), { code: 'credit_ledger_locked' });
  assert.ok(fs.existsSync(lock));
  fs.unlinkSync(lock);
  ledger.reserve(base({ requestKey: 'run_a:2' }));
});

test('parallel processes never over-reserve the budget', async (t) => {
  const { dataDir } = setup(t);
  const code = `const {createCreditLedger}=require(${JSON.stringify(path.resolve(__dirname, '../lib/credit-ledger'))});
const l=createCreditLedger({dataDir:${JSON.stringify(dataDir)}});let ok=0;
for(let i=0;i<10;i++){for(;;){try{l.reserve(Object.assign(${JSON.stringify(base())},{requestKey:process.argv[1]+':'+i}));ok++;}catch(e){if(e.code==='credit_ledger_locked')continue;if(e.code!=='funding_exhausted')throw e;}break;}}
process.stdout.write(String(ok));`;
  const outs = await Promise.all(Array.from({ length: 6 }, (_, n) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code, `p${n}`], { env: {} }); let out = '', errs = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { errs += d; });
    child.on('close', (c) => c === 0 ? resolve(Number(out)) : reject(new Error(errs)));
  })));
  assert.equal(outs.reduce((a, b) => a + b, 0), 10); // 100 budget / 10 per reservation
  const s = createCreditLedger({ dataDir }).summary({ authorizationId: ID });
  assert.equal(s.heldCents, 100); assert.equal(s.remainingCents, 0);
});

test('in-process parallel reserves never exceed the budget', async (t) => {
  const { ledger } = setup(t);
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => Promise.resolve().then(() => {
    try { ledger.reserve(base({ requestKey: `r:${i}`, estimateCents: 7 })); return 1; } catch (e) { assert.equal(e.code, 'funding_exhausted'); return 0; }
  })));
  assert.equal(results.reduce((a, b) => a + b, 0), 14);
});

test('a held lock fails fast (bounded spin) instead of blocking for seconds', (t) => {
  const { dataDir, ledger } = setup(t);
  ledger.reserve(base());
  const lock = path.join(dataDir, 'credit-ledger', `${ID}.lock`);
  fs.writeFileSync(lock, '1', { mode: 0o600 });
  const t0 = Date.now();
  assert.throws(() => ledger.reserve(base({ requestKey: 'run_a:2' })), { code: 'credit_ledger_locked' });
  assert.ok(Date.now() - t0 < 1500, 'lock wait must be short');
  assert.ok(fs.existsSync(lock));
});

test('settle and markExhausted validate the authorizationId before any filesystem effect', (t) => {
  const { dataDir, ledger } = setup(t);
  const outside = path.join(dataDir, 'x.lock');
  assert.throws(() => ledger.settle({ authorizationId: '../x', requestKey: 'run_a:1', disposition: 'not_sent' }), { code: 'credit_ledger_invalid' });
  assert.throws(() => ledger.markExhausted({ authorizationId: '../x', cause: 'operator' }), { code: 'credit_ledger_invalid' });
  assert.ok(!fs.existsSync(outside)); assert.ok(!fs.existsSync(path.join(dataDir, 'credit-ledger')));
});
