'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTaskQueue } = require('../lib/task-queue');
const { createIncidentLog, taskFailureDetails } = require('../lib/incident-log');

test('queue budget failure reaches durable incident inbox without a workflow', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-task-incident-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const incidentDir = path.join(root, 'incidents');
  const incidents = createIncidentLog({ dataDir: incidentDir });
  let observed;
  const settled = new Promise((resolve) => { observed = resolve; });
  const queue = createTaskQueue({
    dataDir: path.join(root, 'tasks'),
    executeOneShot: async (_body, res) => res.json({
      stdout: 'partial answer', exitCode: 0, failureClass: 'token_budget',
      receiptId: 'rcpt_budget', stop_reason: 'token_budget',
      stop_detail: '50060 exceeded maxTotalTokens 50000',
    }),
    onFailure: (task) => {
      incidents.report(taskFailureDetails(task));
      observed(task.id);
    },
  });
  const submitted = queue.submit({ kind: 'claude', prompt: 'bounded review' });
  assert.equal(await settled, submitted.id);
  assert.equal(queue.get(submitted.id).status, 'failed');
  const reopened = createIncidentLog({ dataDir: incidentDir });
  const [incident] = reopened.list();
  assert.equal(incident.classification, 'budget_exceeded');
  assert.equal(incident.correlation.taskId, submitted.id);
  assert.equal(incident.correlation.receiptId, 'rcpt_budget');
  assert.match(incident.summary, /local execution budget/);
  assert.equal(JSON.stringify(incident).includes('partial answer'), false);
});

test('partial output reports a correlated no-verdict explanation to the task, incident and conversation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-partial-incident-'));
  const incidentDir = path.join(root, 'incidents');
  const incidents = createIncidentLog({ dataDir: incidentDir });
  let collab = { transcript: [] };
  const queue = createTaskQueue({ dataDir: path.join(root, 'tasks'),
    executeOneShot: async (_body, res) => res.json({ stdout: 'REVIEW_VERDICT: APPROVE token=PRIVATE_RESULT',
      partial_result: true, error: 'Authorization: Bearer PRIVATE_ERROR', receiptId: 'rcpt_partial',
      route: { request_id: 'req_exact', invocation_id: 'inv_exact', attempt_id: 'attempt_exact' } }),
    readCollab: () => collab,
    writeCollab: (_id, value) => { collab = value; },
    onFailure: (task) => incidents.report(taskFailureDetails(task)),
  });
  t.after(() => { queue.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const submitted = queue.submit({ kind: 'claude', prompt: 'review', collab: 'c_shared', requirementIds: ['R16'],
    correlation: { runId: 'wf_exact' } });
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(queue.get(submitted.id).status, 'failed');
  const [incident] = createIncidentLog({ dataDir: incidentDir }).list();
  assert.equal(incident.classification, 'partial_output');
  assert.equal(incident.correlation.requestId, 'req_exact');
  assert.equal(incident.correlation.invocationId, 'inv_exact');
  assert.equal(incident.correlation.attemptId, 'attempt_exact');
  assert.deepEqual(incident.requirementIds, ['R16']);
  assert.match(collab.transcript[0].text, /No verdict/);
  assert.match(queue.list()[0].nextAction, /fresh complete review/);
  assert.doesNotMatch(JSON.stringify({ incident, collab, summary: queue.list() }), /PRIVATE_RESULT|PRIVATE_ERROR|REVIEW_VERDICT: APPROVE/);
});
