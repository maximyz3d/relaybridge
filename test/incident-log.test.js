'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createIncidentLog, sanitizeText } = require('../lib/incident-log');

function tempLog(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-incidents-'));
  return {
    dir,
    file: path.join(dir, 'incidents.json'),
    log: createIncidentLog({ dataDir: dir, ...overrides }),
  };
}

const NO_VERDICT = {
  classification: 'no_verdict',
  summary: 'reviewer finished without REVIEW_VERDICT',
  runId: 'wf_1',
  phase: 'reviewing',
  provider: 'codex',
  correlation: {
    requestId: 'wf_1',
    invocationId: 't_abc',
    attemptId: 't_abc:attempt:1',
    receiptId: 'rcpt_1',
    taskId: 't_abc',
  },
  markerExpected: 'REVIEW_VERDICT',
  markerSeen: 'UNKNOWN',
};

test('an incident carries the exact ids needed to find the attempt again', () => {
  const { log } = tempLog();
  const { incident, deduplicated } = log.report(NO_VERDICT);
  assert.equal(deduplicated, false);
  assert.match(incident.incidentId, /^inc_/);
  assert.equal(incident.status, 'open');
  assert.equal(incident.classification, 'no_verdict');
  assert.deepEqual(incident.correlation, {
    requestId: 'wf_1',
    invocationId: 't_abc',
    attemptId: 't_abc:attempt:1',
    receiptId: 'rcpt_1',
    taskId: 't_abc',
    contractId: null,
    delegationId: null,
  });
  assert.equal(incident.evidence.markerExpected, 'REVIEW_VERDICT');
  assert.equal(incident.evidence.markerSeen, 'UNKNOWN');
});

test('an unrecognized classification is refused rather than stored as prose', () => {
  const { log } = tempLog();
  assert.throws(() => log.report({ classification: 'vibes' }), /unknown incident classification/);
});

test('the same failure re-observed increments occurrences instead of piling up', () => {
  const { log } = tempLog();
  const first = log.report(NO_VERDICT).incident;
  const second = log.report({ ...NO_VERDICT, summary: 'reworded but the same attempt' });
  assert.equal(second.deduplicated, true);
  assert.equal(second.incident.incidentId, first.incidentId);
  assert.equal(second.incident.occurrences, 2);
  assert.equal(log.list().length, 1);

  // A different attempt of the same run is a different incident.
  const other = log.report({
    ...NO_VERDICT,
    correlation: { ...NO_VERDICT.correlation, attemptId: 't_abc:attempt:2', receiptId: 'rcpt_2' },
  });
  assert.equal(other.deduplicated, false);
  assert.equal(log.list().length, 2);
});

test('the raw provider output is never stored, only a digest and a length', () => {
  const { log, file } = tempLog();
  const output = 'I looked at the code and it seems fine to me, no marker though.';
  const { incident } = log.report({ ...NO_VERDICT, output });
  assert.equal(incident.evidence.outputChars, output.length);
  assert.match(incident.evidence.outputDigest, /^[a-f0-9]{16}$/);
  assert.equal(JSON.stringify(incident).includes('seems fine to me'), false);
  assert.equal(fs.readFileSync(file, 'utf8').includes('seems fine to me'), false);
});

test('credentials and home paths are stripped from operator-visible text', () => {
  const dirty = 'failed with authorization: Bearer abcdef and token=hunter2 '
    + 'while reading /home/someone/secret/notes.md';
  const clean = sanitizeText(dirty);
  assert.equal(clean.includes('hunter2'), false);
  assert.equal(clean.includes('/home/someone'), false);
  assert.match(clean, /\[redacted\]/);
  assert.match(clean, /\[redacted-path\]/);

  const { log } = tempLog();
  const { incident } = log.report({ ...NO_VERDICT, summary: dirty });
  assert.equal(incident.summary.includes('hunter2'), false);
  assert.equal(incident.summary.includes('/home/someone'), false);
});

test('a long summary is truncated so one incident cannot dominate the inbox', () => {
  const { log } = tempLog();
  const { incident } = log.report({ ...NO_VERDICT, summary: 'the model kept talking. '.repeat(400) });
  assert.ok(incident.summary.length <= 601, `summary was ${incident.summary.length} chars`);
  assert.ok(incident.summary.endsWith('…'));
});

test('acknowledging closes an incident and keeps it out of the open stats', () => {
  const { log } = tempLog();
  const { incident } = log.report(NO_VERDICT);
  log.report({ ...NO_VERDICT, classification: 'empty_output' });
  assert.deepEqual(log.stats(), {
    total: 2, open: 2, occurrencesOpen: 2, byClassification: { no_verdict: 1, empty_output: 1 },
  });

  const acked = log.acknowledge(incident.incidentId, { actor: 'operator', note: 'prompt fixed' });
  assert.equal(acked.status, 'acknowledged');
  assert.equal(acked.note, 'prompt fixed');
  assert.equal(log.list({ status: 'open' }).length, 1);
  assert.equal(log.stats().open, 1);
  assert.throws(() => log.acknowledge('inc_nope'), /incident not found/);
});

test('the inbox survives a restart and a corrupt file does not block boot', () => {
  const { dir, file } = tempLog();
  const first = createIncidentLog({ dataDir: dir });
  const { incident } = first.report(NO_VERDICT);
  first.report(NO_VERDICT);

  const reopened = createIncidentLog({ dataDir: dir });
  assert.equal(reopened.get(incident.incidentId).occurrences, 2);
  // Dedup identity survives the round trip through disk.
  assert.equal(reopened.report(NO_VERDICT).deduplicated, true);

  fs.writeFileSync(file, '{not json', 'utf8');
  const recovered = createIncidentLog({ dataDir: dir });
  assert.deepEqual(recovered.list(), []);
});

test('the ring drops acknowledged incidents before open ones', () => {
  const { log } = tempLog({ maxEntries: 20 });
  for (let i = 0; i < 30; i += 1) {
    const { incident } = log.report({ ...NO_VERDICT, runId: `wf_${i}` });
    if (i % 2 === 0) log.acknowledge(incident.incidentId);
  }
  const kept = log.list({ limit: 200 });
  assert.equal(kept.length, 20);
  assert.equal(kept.filter((entry) => entry.status === 'open').length, 15);
});
