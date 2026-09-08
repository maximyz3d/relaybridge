'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');

test('repeated MCP run listings preserve overdue and ambiguous execution records byte for byte', (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-inert-runs-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const directory = path.join(data, 'runs'); fs.mkdirSync(directory);
  const records = [
    { runId: 'run_past', status: 'running', deadlineAt: '2000-01-01T00:00:00.000Z' },
    { runId: 'run_legacy', status: 'running', createdAt: '2000-01-01T00:00:00.000Z' },
    { runId: 'run_unknown', status: 'running', deadlineAt: 'invalid' },
    { runId: 'run_future', status: 'running', deadlineAt: '2999-01-01T00:00:00.000Z' },
    { runId: 'run_done', status: 'complete', updatedAt: '2000-01-01T00:00:00.000Z' },
  ];
  const originals = records.map((r) => {
    const file = path.join(directory, r.runId + '.json'); fs.writeFileSync(file, JSON.stringify(r));
    return { file, bytes: fs.readFileSync(file), mtime: fs.statSync(file).mtimeMs };
  });
  const moduleUrl = pathToFileURL(path.resolve(__dirname, '../mcp/receipts.mjs')).href;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e',
    `const { listRuns, readRun } = await import(${JSON.stringify(moduleUrl)});
     const a = listRuns(); const b = listRuns();
     process.stdout.write(JSON.stringify({a,b,read:readRun('run_past')}));`], {
    env: { ...process.env, RELAYBRIDGE_DATA_DIR: data }, encoding: 'utf8', timeout: 10000,
  });
  const result = JSON.parse(stdout); assert.deepEqual(result.a, result.b);
  for (const original of originals) {
    assert.deepEqual(fs.readFileSync(original.file), original.bytes);
    assert.equal(fs.statSync(original.file).mtimeMs, original.mtime);
  }
  const byId = Object.fromEntries(result.a.map((r) => [r.runId, r]));
  for (const id of ['run_past', 'run_legacy', 'run_unknown', 'run_future']) {
    assert.equal(byId[id].status, 'running'); assert.equal(byId[id].executionAssessment, 'unknown');
  }
  assert.equal(byId.run_past.progressOverdue, true);
  assert.equal(byId.run_legacy.progressOverdue, true);
  assert.equal(byId.run_unknown.progressOverdue, null);
  assert.equal(byId.run_future.progressOverdue, false);
  assert.equal(result.read.status, 'running');
  assert.equal(result.read.interruptedAt, undefined);
});
