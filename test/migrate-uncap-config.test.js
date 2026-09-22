'use strict';

// Covers scripts/migrate-uncap-config.sh: it must never touch the real
// config (every invocation here targets a temp fixture), --dry-run must
// leave the target file byte-identical, and a real run must remove the
// wall-clock ceilings (hardCapMs, providerBudget.*, providerBudgetByTaskTier,
// --max-turns) while leaving the rest of the config intact.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'migrate-uncap-config.sh');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rb-migrate-')); }
function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

function fixtureConfig() {
  return {
    _supervisor: {
      idleMs: 1200000,
      hardCapMs: 2700000,
      providerBudget: { maxOutputTokens: 100000, maxTotalTokens: 3000000, maxTurns: null },
    },
    claude: {
      supervisor: {
        providerBudgetByTaskTier: { standard: { maxTotalTokens: 12000000 } },
      },
      oneshot_safe: ['--foo', '--max-turns', '32', '--bar'],
      oneshot_dangerous: ['--max-turns', '32'],
      label: 'Claude',
    },
    other_provider: {
      safe: ['--keep-me'],
    },
  };
}

function writeFixture(dir) {
  const cfgDir = path.join(dir, 'cfgdir');
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfgPath = path.join(cfgDir, 'cli-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(fixtureConfig(), null, 2) + '\n');
  return cfgPath;
}

function run(args) {
  return spawnSync('bash', [SCRIPT_PATH, ...args], { encoding: 'utf8' });
}

test('migrate-uncap-config: --dry-run leaves the target file untouched', () => {
  const dir = tmpdir();
  const cfgPath = writeFixture(dir);
  const backupDir = path.join(dir, 'backup');
  const before = sha256(cfgPath);

  const result = run(['--config', cfgPath, '--backup-dir', backupDir, '--dry-run']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(sha256(cfgPath), before, 'dry-run must not modify the config file');
  assert.match(result.stdout, /dry-run: not writing changes/);
});

test('migrate-uncap-config: real run removes the wall-clock ceilings', () => {
  const dir = tmpdir();
  const cfgPath = writeFixture(dir);
  const backupDir = path.join(dir, 'backup');

  const result = run(['--config', cfgPath, '--backup-dir', backupDir]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^migrated /m);

  const migrated = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

  // _supervisor.hardCapMs deleted; providerBudget values nulled, keys kept.
  assert.equal(migrated._supervisor.hardCapMs, undefined);
  assert.deepEqual(migrated._supervisor.providerBudget, {
    maxOutputTokens: null,
    maxTotalTokens: null,
    maxTurns: null,
  });
  assert.equal(migrated._supervisor.idleMs, 1200000, 'unrelated fields must survive');

  // claude.supervisor.providerBudgetByTaskTier deleted entirely.
  assert.deepEqual(migrated.claude.supervisor, {});

  // --max-turns and its value stripped from every arg array, order preserved.
  assert.deepEqual(migrated.claude.oneshot_safe, ['--foo', '--bar']);
  assert.deepEqual(migrated.claude.oneshot_dangerous, []);
  assert.equal(migrated.claude.label, 'Claude', 'unrelated fields must survive');

  // Untouched provider left alone.
  assert.deepEqual(migrated.other_provider.safe, ['--keep-me']);

  // A backup of the original was written.
  const backups = fs.readdirSync(backupDir);
  assert.equal(backups.length, 1);
  const backedUp = JSON.parse(fs.readFileSync(path.join(backupDir, backups[0]), 'utf8'));
  assert.equal(backedUp._supervisor.hardCapMs, 2700000, 'backup must hold the pre-migration content');
});

test('migrate-uncap-config: refuses without --backup-dir', () => {
  const dir = tmpdir();
  const cfgPath = writeFixture(dir);

  const result = run(['--config', cfgPath]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--backup-dir is required/);
});

test('migrate-uncap-config: refuses a missing config file', () => {
  const dir = tmpdir();
  const result = run(['--config', path.join(dir, 'nope.json'), '--backup-dir', path.join(dir, 'backup')]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /config not found/);
});

test('migrate-uncap-config: strips --max-turns=N, keeps file mode, and leaves no temp file', () => {
  const dir = tmpdir();
  const cfgPath = writeFixture(dir);
  const cfg = fixtureConfig();
  cfg.grok = { oneshot_safe: ['--max-turns=32', '--keep'] };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  fs.chmodSync(cfgPath, 0o640);

  const result = run(['--config', cfgPath, '--backup-dir', path.join(dir, 'backup')]);

  assert.equal(result.status, 0, result.stderr);
  const migrated = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.deepEqual(migrated.grok.oneshot_safe, ['--keep']);
  assert.equal(fs.statSync(cfgPath).mode & 0o777, 0o640, 'config mode must survive the atomic replace');
  assert.deepEqual(fs.readdirSync(path.dirname(cfgPath)), ['cli-config.json'], 'no temp file may be left beside the config');
});
