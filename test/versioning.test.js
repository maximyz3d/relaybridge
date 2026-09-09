'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const versioning = require('../templates/github-automations/compute-version.cjs');

test('release write mode synchronizes existing npm roots and preserves dependencies without lifecycle execution', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'rb-release-write-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const pkg = {name:'fixture',version:'1.0.0',scripts:{version:'must never execute'},dependencies:{fixture:'^3.0.0'}};
  const lock = {name:'fixture',version:'1.0.0',lockfileVersion:3,packages:{'':{name:'fixture',version:'1.0.0',dependencies:pkg.dependencies},'node_modules/fixture':{version:'3.1.0',integrity:'fixture'}}};
  fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify(pkg));
  fs.writeFileSync(path.join(dir,'package-lock.json'),JSON.stringify(lock));
  const script = path.resolve(__dirname,'../.github/scripts/compute-version.cjs');
  const result = spawnSync(process.execPath,[script,'--write-release','2.3.1'],{cwd:dir,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr); assert.equal(result.stdout,'');
  assert.equal(fs.readFileSync(path.join(dir,'VERSION'),'utf8'),'2.3.1\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'package.json'))),{...pkg,version:'2.3.1'});
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'package-lock.json'))),{...lock,version:'2.3.1',packages:{...lock.packages,'':{...lock.packages[''],version:'2.3.1'}}});
});

test('release writes support non-npm and unversioned private repositories', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'rb-release-no-npm-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  assert.deepEqual(versioning.writeReleaseVersion('1.2.3',dir),['VERSION']);
  const original = '{"private":true,"dependencies":{"fixture":"1.0.0"}}';
  fs.writeFileSync(path.join(dir,'package.json'),original);
  assert.deepEqual(versioning.writeReleaseVersion('1.2.4',dir),['VERSION']);
  assert.equal(fs.readFileSync(path.join(dir,'package.json'),'utf8'),original);
});

test('invalid release versions and malformed later manifests fail before changing any file', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'rb-release-invalid-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'VERSION'),'1.0.0\n');
  fs.writeFileSync(path.join(dir,'package.json'),'{"version":"1.0.0"}');
  for (const malformed of ['{invalid','null','[]','{"packages":null}','{"packages":{"":false}}']) {
    fs.writeFileSync(path.join(dir,'package-lock.json'),malformed);
    assert.throws(() => versioning.writeReleaseVersion('2.0.0',dir),/JSON/);
    assert.equal(fs.readFileSync(path.join(dir,'VERSION'),'utf8'),'1.0.0\n');
    assert.equal(fs.readFileSync(path.join(dir,'package.json'),'utf8'),'{"version":"1.0.0"}');
  }
  for (const invalid of ['v2.0.0','2.0.0\n','2.0','02.0.0']) assert.throws(() => versioning.writeReleaseVersion(invalid,dir),/strict/);
});

test('release write refuses symlinked metadata before modifying VERSION', {skip:process.platform === 'win32'}, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'rb-release-link-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'VERSION'),'1.0.0\n');
  fs.writeFileSync(path.join(dir,'target.json'),'{"version":"1.0.0"}');
  fs.symlinkSync('target.json',path.join(dir,'package.json'));
  assert.throws(() => versioning.writeReleaseVersion('2.0.0',dir),/regular file/);
  assert.equal(fs.readFileSync(path.join(dir,'VERSION'),'utf8'),'1.0.0\n');
  assert.equal(fs.readFileSync(path.join(dir,'target.json'),'utf8'),'{"version":"1.0.0"}');
});

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
