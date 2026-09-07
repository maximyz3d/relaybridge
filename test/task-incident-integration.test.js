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
