'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REAL_TIMEOUT_POLICY = path.join(ROOT, 'config', 'timeout-policy.json');

// This is the same snippet install-mcp.sh evaluates to derive
// mcp_tool_timeout_sec from [mcpInlineWaitMs, transportGraceMs, mcpHostGraceMs].
// It is a standalone copy (not a require of install-mcp.sh) so the test
// never runs the real installer.
const SNIPPET = `
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const values = [p.mcpInlineWaitMs, p.transportGraceMs, p.mcpHostGraceMs];
  if (!values.every(Number.isFinite)) process.exit(2);
  const seconds = Math.ceil(values.reduce((a, b) => a + b, 0) / 1000);
  if (!Number.isInteger(seconds) || seconds < 1) process.exit(3);
  process.stdout.write(String(seconds));
`;

function runSnippet(policyPath) {
  return spawnSync(process.execPath, ['-e', SNIPPET, policyPath], { encoding: 'utf8' });
}

function writePolicy(dir, overrides) {
  const base = JSON.parse(fs.readFileSync(REAL_TIMEOUT_POLICY, 'utf8'));
  const merged = { ...base, ...overrides };
  const file = path.join(dir, 'timeout-policy.json');
  fs.writeFileSync(file, JSON.stringify(merged));
  return file;
}

test('install-mcp.sh timeout derivation against the real policy yields 2745', () => {
  const result = runSnippet(REAL_TIMEOUT_POLICY);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, '2745');
});

test('install-mcp.sh timeout derivation fails when mcpInlineWaitMs is missing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-mcp-timeout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = JSON.parse(fs.readFileSync(REAL_TIMEOUT_POLICY, 'utf8'));
  delete base.mcpInlineWaitMs;
  const file = path.join(dir, 'timeout-policy.json');
  fs.writeFileSync(file, JSON.stringify(base));

  const result = runSnippet(file);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
});

test('install-mcp.sh timeout derivation fails when mcpInlineWaitMs is null', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-mcp-timeout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = writePolicy(dir, { mcpInlineWaitMs: null });

  const result = runSnippet(file);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
});

test('timeout-policy.cjs rejects a missing or non-positive mcpInlineWaitMs', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-mcp-timeout-cjs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configDir = path.join(dir, 'config');
  fs.mkdirSync(configDir);
  const base = JSON.parse(fs.readFileSync(REAL_TIMEOUT_POLICY, 'utf8'));
  delete base.mcpInlineWaitMs;
  fs.writeFileSync(path.join(configDir, 'timeout-policy.json'), JSON.stringify(base));
  fs.copyFileSync(path.join(ROOT, 'timeout-policy.cjs'), path.join(dir, 'timeout-policy.cjs'));

  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(dir, 'timeout-policy.cjs'))})`], {
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mcpInlineWaitMs must be a positive integer/);
});
