'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequestLedger } = require('../lib/request-ledger');

const REVISION = 'a'.repeat(40);
const request = { requestId: 'req_queue', actor: 'operator', requirements: [
  { requirementId: 'R13', summary: 'Truthful counts' }, { requirementId: 'R14', summary: 'Durable backlog' },
] };
const event = { eventId: 'evt_test', requirementId: 'R13', actor: 'tester', revision: REVISION,
  milestone: 'tested', outcome: 'confirmed', evidence: [{ kind: 'test', ref: 'test_run_1', digest: 'b'.repeat(64) }],
  correlation: { runId: 'wf_queue', taskId: 't_test', receiptId: 'rcpt_exact' } };

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-request-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'request-ledger.json'), ledger: createRequestLedger({ dataDir: dir, ...options }) };
}

test('requirements, workflow links and revision-specific evidence survive restart', (t) => {
  const f = fixture(t);
  f.ledger.create(request);
  f.ledger.linkWorkflow(request.requestId, { runId: 'wf_queue', actor: 'operator' });
  f.ledger.record(request.requestId, event);
  const reopened = createRequestLedger({ dataDir: f.dir });
  assert.deepEqual(reopened.forWorkflow('wf_queue'), [{ requestId: request.requestId, requirementIds: ['R13', 'R14'] }]);
  const coverage = reopened.get(request.requestId, { revision: REVISION }).coverage;
  assert.equal(coverage[0].milestones.tested.outcome, 'confirmed');
  for (const milestone of ['planned', 'implemented', 'approved', 'merged', 'deployed']) {
    assert.equal(coverage[0].milestones[milestone].outcome, 'unknown');
  }
  assert.equal(coverage[1].milestones.tested.outcome, 'unknown');
  assert.equal(reopened.get(request.requestId, { revision: 'c'.repeat(40) }).coverage[0].milestones.tested.outcome, 'unknown');
  assert.equal(reopened.get(request.requestId).events[0].revision, REVISION);
  assert.equal(reopened.get(request.requestId).events[0].evidence[0].digest, 'b'.repeat(64));
});

test('rejected and missing evidence remain historical and never manufacture approval', (t) => {
  const f = fixture(t);
  f.ledger.create(request);
  f.ledger.record(request.requestId, event);
  f.ledger.record(request.requestId, { ...event, eventId: 'evt_reject', outcome: 'rejected', reason: 'Test failed' });
  f.ledger.record(request.requestId, { ...event, eventId: 'evt_missing', milestone: 'approved', outcome: 'missing',
    evidence: [], reason: 'NO VERDICT: review output incomplete' });
  const result = f.ledger.get(request.requestId, { revision: REVISION });
  assert.equal(result.events.length, 3);
  assert.equal(result.coverage[0].milestones.tested.outcome, 'rejected');
  assert.equal(result.coverage[0].milestones.approved.outcome, 'missing');
  assert.equal(Object.hasOwn(result, 'complete'), false);
});

test('event retries are idempotent and conflicting reuse is rejected', (t) => {
  const f = fixture(t);
  f.ledger.create(request);
  const first = f.ledger.record(request.requestId, event);
  const persisted = fs.readFileSync(f.file, 'utf8');
  assert.deepEqual(f.ledger.record(request.requestId, event), first);
  assert.equal(fs.readFileSync(f.file, 'utf8'), persisted);
  assert.throws(() => f.ledger.record(request.requestId, { ...event, milestone: 'approved' }), /conflicting/);
  assert.equal(f.ledger.get(request.requestId).events.length, 1);
});

test('all milestone assertions require explicit provenance and confirmed evidence', (t) => {
  const f = fixture(t);
  f.ledger.create(request);
  for (const patch of [{ actor: '' }, { revision: '' }, { evidence: [] }, { requirementId: 'R99' },
    { milestone: 'done' }, { outcome: 'approved' }, { evidence: [{ kind: 'raw_output', ref: 'private' }] },
    { evidence: [{ kind: 'review', ref: 'receipt', digest: 'not-a-digest' }] }, { outcome: 'missing', reason: null }]) {
    assert.throws(() => f.ledger.record(request.requestId, { ...event, ...patch }));
  }
  assert.equal(f.ledger.get(request.requestId).events.length, 0);
});

test('text is sanitized, credentials and local paths are rejected as references, SHAs remain exact', (t) => {
  const f = fixture(t);
  f.ledger.create({ ...request, requirements: [{ requirementId: 'R13', summary: 'token=private-value at /home/private/notes' }] });
  f.ledger.record(request.requestId, { ...event, reason: 'Authorization: Bearer private-value' });
  for (const ref of ['/home/private/notes', 'C:/Users/private/notes', 'ghp_abcdefghijklmnopqrstuv', 'https://host/path?token=private']) {
    assert.throws(() => f.ledger.record(request.requestId, { ...event, evidence: [{ kind: 'artifact', ref }] }), /invalid/);
  }
  const text = fs.readFileSync(f.file, 'utf8');
  assert.equal(text.includes('private-value'), false);
  assert.equal(text.includes('/home/private'), false);
  assert.ok(text.includes(REVISION));
});

test('capacity refusal preserves prior coverage and returns defensive copies', (t) => {
  const f = fixture(t, { maxRequests: 1, maxEvents: 1 });
  const created = f.ledger.create(request);
  created.requirements[0].summary = 'tampered';
  f.ledger.record(request.requestId, event);
  const observed = f.ledger.get(request.requestId);
  observed.events[0].evidence[0].ref = 'tampered';
  assert.throws(() => f.ledger.create({ ...request, requestId: 'req_second' }), /capacity/);
  assert.throws(() => f.ledger.record(request.requestId, { ...event, eventId: 'evt_second' }), /capacity/);
  assert.equal(f.ledger.get(request.requestId).events[0].evidence[0].ref, 'test_run_1');
  assert.equal(f.ledger.get(request.requestId).requirements[0].summary, 'Truthful counts');
});

test('corrupt or incompatible ledgers fail visibly without erasing evidence', (t) => {
  const f = fixture(t);
  for (const raw of ['{invalid', 'null', '{"version":999,"requests":[]}']) {
    fs.writeFileSync(f.file, raw);
    assert.throws(() => createRequestLedger({ dataDir: f.dir }), /corrupt/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), raw);
  }
});

test('persistence failure never publishes in-memory evidence', (t) => {
  const f = fixture(t);
  f.ledger.create(request);
  fs.renameSync(f.file, `${f.file}.saved`);
  fs.mkdirSync(f.file); // Atomic replacement must fail without touching the in-memory state.
  assert.throws(() => f.ledger.record(request.requestId, event));
  assert.equal(f.ledger.get(request.requestId).events.length, 0);
  fs.rmdirSync(f.file);
  fs.renameSync(`${f.file}.saved`, f.file);
  assert.equal(f.ledger.record(request.requestId, event).eventId, event.eventId);
});

test('expanding redactions remain bounded, idempotent and restart-readable', (t) => {
  const f = fixture(t);
  const summary = 'token=x '.repeat(75);
  f.ledger.create({ ...request, requirements: [{ requirementId: 'R13', summary }] });
  const input = { ...event, reason: summary };
  const first = f.ledger.record(request.requestId, input);
  assert.ok(first.reason.length <= 600);
  assert.deepEqual(f.ledger.record(request.requestId, input), first);
  const reopened = createRequestLedger({ dataDir: f.dir });
  assert.deepEqual(reopened.record(request.requestId, input), first);
});

test('byte capacity rejects multibyte writes before making the ledger unreopenable', (t) => {
  const f = fixture(t, { maxBytes: 3000 });
  f.ledger.create(request);
  f.ledger.record(request.requestId, event);
  const before = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => f.ledger.record(request.requestId, { ...event, eventId: 'evt_huge', reason: '界'.repeat(600) }), /byte capacity/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.equal(createRequestLedger({ dataDir: f.dir, maxBytes: 3000 }).get(request.requestId).events.length, 1);
});

test('loaded records are normalized to allowed fields and require timestamp provenance', (t) => {
  const f = fixture(t);
  f.ledger.create(request);
  f.ledger.record(request.requestId, event);
  const stored = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  stored.requests[0].requirements[0].summary = 'token=secret123';
  stored.requests[0].events[0].rawOutput = 'PRIVATE_TRANSCRIPT';
  fs.writeFileSync(f.file, JSON.stringify(stored));
  const reopened = createRequestLedger({ dataDir: f.dir });
  assert.doesNotMatch(JSON.stringify(reopened.get(request.requestId)), /secret123|PRIVATE_TRANSCRIPT/);
  delete stored.requests[0].events[0].recordedAt;
  fs.writeFileSync(f.file, JSON.stringify(stored));
  assert.throws(() => createRequestLedger({ dataDir: f.dir }), /corrupt/);
});

test('fractional bounds, mutable revisions and credential-shaped identifiers are refused', (t) => {
  const f = fixture(t);
  assert.throws(() => createRequestLedger({ dataDir: f.dir, maxRequests: 1.5 }), /integer/);
  assert.throws(() => createRequestLedger({ dataDir: f.dir, maxEvents: 1.5 }), /integer/);
  f.ledger.create(request);
  for (const revision of ['HEAD', 'main', 'abc123']) assert.throws(() => f.ledger.record(request.requestId, { ...event, revision }), /immutable/);
  for (const secret of ['token:secret123', 'actor-ghp_abcdefghijklmnopqrstuv']) {
    for (const key of ['eventId', 'requirementId', 'actor']) assert.throws(() => f.ledger.record(request.requestId, { ...event, [key]: secret }), /invalid/);
    assert.throws(() => f.ledger.record(request.requestId, { ...event, correlation: { taskId: secret } }), /invalid/);
    assert.throws(() => f.ledger.record(request.requestId, { ...event, evidence: [{ kind: 'review', ref: secret }] }), /invalid/);
  }
});
