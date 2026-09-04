'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const versioning = require('../templates/github-automations/compute-version.cjs');

test('strict versions contain exactly three canonical numeric components', () => {
  assert.equal(versioning.parseVersion('0.0.0').text, '0.0.0');
  assert.equal(versioning.parseVersion('12.345.678').text, '12.345.678');

  for (const invalid of [
    '', '1', '1.2', '1.2.3.4', 'v1.2.3', '1.2.3-beta', '1.2.3+build',
    '01.2.3', '1.02.3', '1.2.03', ' 1.2.3', '1.2.3 ', '1.2.3\n',
  ]) {
    assert.equal(versioning.parseVersion(invalid), null, `${JSON.stringify(invalid)} must be rejected`);
  }
});

test('baseline precedence is highest valid tag, VERSION, package.json, fallback', () => {
  assert.deepEqual(versioning.findBaseline({
    tags: ['v1.9.99', 'v2.0.0-rc.1', 'release-99.0.0', 'v2.0.0', 'v01.0.0'],
    versionText: '9.0.0\n',
    packageText: '{"version":"10.0.0"}',
  }), { version: '2.0.0', source: 'tag' });

  assert.deepEqual(versioning.findBaseline({
    tags: ['v2.0', 'v3.0.0-beta'],
    versionText: '3.4.5\r\n',
    packageText: '{"version":"10.0.0"}',
  }), { version: '3.4.5', source: 'VERSION' });

  assert.deepEqual(versioning.findBaseline({
    tags: ['not-a-version'],
    versionText: ' 3.4.5\n',
    packageText: '{"version":"2.0.1"}',
  }), { version: '2.0.1', source: 'package.json' });

  assert.deepEqual(versioning.findBaseline({
    versionText: 'invalid\n',
    packageText: '{not-json',
  }), { version: '0.1.0', source: 'fallback' });
});

test('semantic tag comparison is numeric and safe beyond Number precision', () => {
  assert.deepEqual(versioning.findBaseline({
    tags: ['v9.99.99', 'v10.0.0', 'v9007199254740993.0.0', 'v9007199254740992.999.999'],
  }), { version: '9007199254740993.0.0', source: 'tag' });
});

test('RelayBridge package 2.0.1 produces 2.0.2 on its first patch release', () => {
  const packageText = '{"name":"relaybridge","version":"2.0.1"}';
  assert.deepEqual(versioning.computeVersion({ packageText, bump: 'patch' }), {
    current: '2.0.1',
    next: '2.0.2',
    source: 'package.json',
  });
});

test('installed CLI reads repository state and emits safe GitHub outputs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-version-'));
  const script = path.resolve(__dirname, '..', '.github', 'scripts', 'compute-version.cjs');
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"2.0.1"}\n');
    const success = spawnSync(process.execPath, [script], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, BUMP: 'patch', SET_VERSION_PRESENT: 'false' },
    });
    assert.equal(success.status, 0, success.stderr);
    assert.equal(success.stdout, 'current=2.0.1\nnext=2.0.2\nsource=package.json\n');

    const rejected = spawnSync(process.execPath, [script], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        BUMP: 'patch',
        SET_VERSION_PRESENT: 'true',
        SET_VERSION: '2.0.1',
      },
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /must be strictly greater/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('normal bumps reset the appropriate components', () => {
  assert.equal(versioning.nextVersion('1.2.3', { bump: 'patch' }), '1.2.4');
  assert.equal(versioning.nextVersion('1.2.3', { bump: 'minor' }), '1.3.0');
  assert.equal(versioning.nextVersion('1.2.3', { bump: 'major' }), '2.0.0');
  assert.equal(versioning.nextVersion('999999999999999999999.2.3', { bump: 'major' }),
    '1000000000000000000000.0.0');
  assert.throws(() => versioning.nextVersion('1.2.3', { bump: 'banana' }), /unknown bump/);
});

test('explicit versions must be strict and strictly greater than the baseline', () => {
  assert.equal(versioning.nextVersion('2.0.1', { setVersion: '2.1.0' }), '2.1.0');
  for (const invalid of ['2.0.1', '2.0.0', '02.1.0', '2.1.0-beta', ' 2.1.0', '']) {
    assert.throws(
      () => versioning.nextVersion('2.0.1', { setVersion: invalid }),
      /strictly greater|strict X\.Y\.Z/,
      `${JSON.stringify(invalid)} must be rejected`,
    );
  }
});
