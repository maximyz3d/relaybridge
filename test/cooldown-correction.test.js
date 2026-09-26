'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createCooldownStore, BACKOFF } = require('../lib/provider-cooldown');
const { authorizeContextCorrection, validCorrectionRequest, readCorrectionReceipts } = require('../lib/cooldown-correction');
const { startTestBridge, completeJsonLines } = require('./helpers/temporary-bridge');
const seat = 'subscription:anthropic:default';
function receipt(current, store = 'store') {
  return { receiptId: current.sourceReceiptId, receiptStoreId: store, timestamp: new Date(current.lastOffenceAt + 1).toISOString(),
    event: 'bridge_provider_call', modelInvocation: true, provider: 'claude_fable', failureClass: 'rate_limit', status: 'dropped', outputChars: 0,
    providerTerminalReason: 'rapid_refill_breaker', providerApiErrorStatus: null, quotaEvidence: null, vendorQuota: null,
    providerActionRequired: null, supervisorStopReason: null, providerErrorHash: null,
    providerRetryCount: 0, providerRetryObservedEvents: 0, providerRetryInvalidEvents: 0, providerRetryDuplicateEvents: 0,
    providerErrorCount: 0, providerErrorObserved: 0, providerErrorInvalid: 0, providerRetryEventsTruncated: false,
    providerErrorDiagnosticTruncated: false, providerRetryEvents: [], providerRetryByStatus: {}, providerRetryByError: {},
    cooldown: { seat, sourceReceiptId: current.sourceReceiptId, reason: 'rate_limited', source: 'backoff', scope: 'account',
      until: current.until, offences: current.offences } };
}
function local(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-correct-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'cooldowns.json'); let time = Date.now();
  const store = createCooldownStore({ file, now: () => time });
  const observation = store.noteFailure(seat, 'rate_limited');
  store.attachReceipt(observation, 'rcpt_false');
  const expected = store.status(seat);
  return { dir, file, store, expected, advance: () => { time += 10; } };
}
test('exact correction atomically persists audit and survives reopen; single-field mismatches never mutate', (t) => {
  const { file, store, expected } = local(t);
  const before = fs.readFileSync(file, 'utf8');
  for (const key of ['sourceReceiptId', 'sourceObservationId', 'until', 'lastOffenceAt', 'offences']) {
    const wrong = { ...expected, [key]: typeof expected[key] === 'number' ? expected[key] + 1 : 'wrong' };
    assert.equal(store.correctObservation(seat, wrong, () => ({ ok: true })).code, 'observation_changed');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
  const current = JSON.parse(before)[seat];
  const result = store.correctObservation(seat, expected, (row) => authorizeContextCorrection({ rows: [receipt(current)], receiptStoreId: 'store', seat, current: row }));
  assert.equal(result.ok, true);
  assert.equal(result.after.offences, 0);
  const reopened = createCooldownStore({ file });
  assert.equal(reopened.status(seat).cooling, false);
  assert.equal(reopened._state()[seat].correction.receiptId, result.correction.receiptId);
  assert.deepEqual(reopened._state()[seat].correction.before, current);
});
test('newer shorter failure is protected even when observation and receipt stay identical', (t) => {
  const { file, store, expected, advance } = local(t);
  advance();
  const second = createCooldownStore({ file });
  second.noteFailure(seat, 'overloaded');
  assert.equal(second.status(seat).sourceReceiptId, expected.sourceReceiptId);
  assert.equal(store.correctObservation(seat, expected, () => ({ ok: true })).code, 'observation_changed');
  assert.equal(store.status(seat).cooling, true);
});
test('known-defect authority rejects real quota, incomplete evidence, duplicates, and live predecessors', () => {
  const now = Date.now(), current = { sourceReceiptId: 'rcpt_false', lastOffenceAt: now - 10,
    until: now - 10 + BACKOFF[1], offences: 2, source: 'backoff', reason: 'rate_limited', scope: 'account' };
  const r = receipt(current), previous = { ...r, receiptId: 'rcpt_previous', timestamp: new Date(now - 1000).toISOString(),
    cooldown: { ...r.cooldown, offences: 1, sourceReceiptId: 'rcpt_previous', until: now - 500 } };
  const check = (rows) => authorizeContextCorrection({ rows, receiptStoreId: 'store', seat, current, now });
  assert.equal(check([previous, r]).ok, true);
  assert.equal(check([r]).ok, false);
  assert.equal(check([previous, r, r]).ok, false);
  for (const patch of [{ providerApiErrorStatus: 429 }, { providerRetryByStatus: { 429: 1 } },
    { providerRetryCount: 1 }, { providerRetryEventsTruncated: true }, { providerErrorCount: 1 },
    { quotaEvidence: {} }, { receiptStoreId: 'wrong' }, { providerErrorHash: undefined }]) {
    assert.equal(check([previous, { ...r, ...patch }]).ok, false, JSON.stringify(patch));
  }
  assert.equal(check([{ ...previous, cooldown: { ...previous.cooldown, until: now + 1 } }, r]).ok, false);
});
test('corrupt authority and incomplete journals fail closed; healthy lock does not quarantine unrelated seats', (t) => {
  const { dir, file, store, expected } = local(t);
  fs.mkdirSync(file + '.lock');
  assert.equal(store.status(seat).cooling, true);
  assert.equal(store.status('subscription:anthropic:other').cooling, false);
  fs.rmdirSync(file + '.lock');
  fs.writeFileSync(file, '{');
  assert.equal(store.correctObservation(seat, expected, () => ({ ok: true })).code, 'authority_unavailable');
  fs.writeFileSync(path.join(dir, '2026-09-26.jsonl'), '{"receiptId":"rcpt_false"}');
  assert.throws(() => readCorrectionReceipts(dir), /incomplete/);
});
test('independent process writers serialize and retain every offence', async (t) => {
  const { file } = local(t);
  const source = `const {createCooldownStore}=require(process.argv[1]); const s=createCooldownStore({file:process.argv[2]});
    for(let i=0;i<8;i++)s.noteFailure(${JSON.stringify(seat)},'overloaded');`;
  await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source, require.resolve('../lib/provider-cooldown'), file], { stdio: 'pipe' });
    let errors = ''; child.stderr.on('data', (x) => { errors += x; });
    child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(errors)));
  })));
  assert.equal(createCooldownStore({ file }).status(seat).offences, 33);
});
test('failed correction persistence cannot clear authority or claim an audit', (t) => {
  const { file, store, expected } = local(t), before = fs.readFileSync(file, 'utf8');
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === file) throw new Error('fixture disk failure'); return rename(from, to); };
  try {
    assert.equal(store.correctObservation(seat, expected, () => ({ ok: true, proof: {} })).code, 'persistence_failed');
    assert.equal(store.status(seat).authority, 'unknown');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally { fs.renameSync = rename; }
});
test('contended genuine failure creates durable unknown authority before correction can clear it', (t) => {
  const { file, store, expected } = local(t);
  const code = `const {createCooldownStore}=require(process.argv[1]);
    const result=createCooldownStore({file:process.argv[2]}).noteFailure(${JSON.stringify(seat)},'rate_limited',{retryAfterSec:3600});
    if(result!==null)throw new Error('contention must return null');`;
  const result = store.correctObservation(seat, expected, () => {
    const child = spawnSync(process.execPath, ['-e', code, require.resolve('../lib/provider-cooldown'), file]);
    assert.equal(child.status, 0, child.stderr.toString());
    return { ok: true, proof: {} };
  });
  assert.equal(result.code, 'persistence_failed');
  const reopened = createCooldownStore({ file });
  assert.equal(reopened.status(seat).authority, 'unknown');
  assert.equal(reopened.noteSuccess(seat), null);
  assert.equal(reopened.attachReceipt({ seat }, 'rcpt_unattached'), false);
  assert.equal(reopened.status(seat).authority, 'unknown');
  const pending = fs.readdirSync(file + '.unavailable');
  const intent = JSON.parse(fs.readFileSync(path.join(file + '.unavailable', pending[0]), 'utf8')).intent;
  assert.equal(intent.kind, 'rate_limited'); assert.equal(intent.retryAfterSec, 3600);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[seat].until, expected.until);
});
test('clock rollback cannot hide a newer on-disk observation from exact correction CAS', (t) => {
  const { file, store, expected } = local(t);
  const second = createCooldownStore({ file, now: () => expected.lastOffenceAt - 1 });
  const observation = second.noteFailure(seat, 'rate_limited', { retryAfterSec: 3600 });
  second.attachReceipt(observation, 'rcpt_real429');
  assert.equal(store.correctObservation(seat, expected, () => ({ ok: true })).code, 'observation_changed');
  assert.equal(store.status(seat).sourceReceiptId, 'rcpt_real429');
});
test('authenticated correction route rejects unsupported requests and mirrors durable exact correction', async (t) => {
  const fixture = await startTestBridge(t, () => ({ claude: { label: 'fixture', transport: 'subscription:anthropic',
    quota_seat: seat, oneshot_safe: [process.execPath, '-e', 'console.log("ok")'], oneshot_safe_filesystem_policy: 'read_only_enforced' } }));
  const call = await fixture.request('/api/oneshot', { kind: 'claude', prompt: 'fixture', dangerous: false });
  assert.equal(call.status, 200);
  const journal = path.join(fixture.root, 'data', 'receipts', new Date().toISOString().slice(0, 10) + '.jsonl');
  const real = completeJsonLines(journal).find((r) => r.receiptId === call.body.receiptId);
  const file = path.join(fixture.root, 'data', 'cooldowns.json'), now = Date.now();
  const current = { sourceReceiptId: 'rcpt_false', sourceObservationId: 'a'.repeat(24), lastOffenceAt: now,
    until: now + BACKOFF[0], offences: 1, source: 'backoff', reason: 'rate_limited', scope: 'account' };
  fs.writeFileSync(file, JSON.stringify({ [seat]: current }));
  fs.appendFileSync(journal, JSON.stringify(receipt(current, real.receiptStoreId)) + '\n');
  const body = { quotaSeat: seat, sourceReceiptId: current.sourceReceiptId, sourceObservationId: current.sourceObservationId,
    lastOffenceAt: current.lastOffenceAt, until: current.until, offences: current.offences };
  assert.equal(validCorrectionRequest(body), true);
  const url = '/api/cooldowns/corrections';
  assert.equal((await fixture.request(url, body, { headers: { 'Content-Type': 'application/json' } })).status, 401);
  assert.equal((await fixture.request(url, { ...body, force: true })).status, 400);
  assert.equal((await fixture.request(url, { ...body, until: body.until + 1 })).status, 409);
  const result = await fixture.request(url, body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.auditPersisted, true);
  assert.equal(result.body.journalMirrored, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[seat].until, 0);
  assert.ok(completeJsonLines(journal).find((r) => r.event === 'cooldown_correction' && r.receiptId === result.body.correction.receiptId));
  assert.equal((await fixture.request(url, body)).status, 409);
});
