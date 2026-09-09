// # rb-template v4
'use strict';

// Keep version selection outside the workflow shell so the exact behavior can
// be tested. This file is installed alongside version-on-merge.yml at
// .github/scripts/compute-version.cjs and intentionally has no dependencies.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const STRICT_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const text = value;
  const match = STRICT_VERSION.exec(text);
  if (!match) return null;
  return { text, parts: match.slice(1).map((part) => BigInt(part)) };
}

function compareParsed(left, right) {
  for (let i = 0; i < 3; i += 1) {
    if (left.parts[i] > right.parts[i]) return 1;
    if (left.parts[i] < right.parts[i]) return -1;
  }
  return 0;
}

function requireVersion(value, label) {
  const parsed = parseVersion(value);
  if (!parsed) {
    throw new Error(`${label} must be a strict X.Y.Z version (no prefix, suffix, or leading zeroes)`);
  }
  return parsed;
}

function packageVersion(packageText) {
  if (typeof packageText !== 'string') return null;
  try {
    return parseVersion(JSON.parse(packageText).version);
  } catch {
    return null;
  }
}

function findBaseline({ tags = [], versionText = null, packageText = null } = {}) {
  let latestTag = null;
  for (const tag of tags) {
    if (typeof tag !== 'string' || !tag.startsWith('v')) continue;
    const candidate = parseVersion(tag.slice(1));
    if (candidate && (!latestTag || compareParsed(candidate, latestTag) > 0)) {
      latestTag = candidate;
    }
  }
  if (latestTag) return { version: latestTag.text, source: 'tag' };

  // Permit the one line ending written by this workflow, but do not normalize
  // spaces or multiple lines into an otherwise invalid VERSION value.
  const versionFile = parseVersion(
    typeof versionText === 'string' ? versionText.replace(/\r?\n$/, '') : versionText);
  if (versionFile) return { version: versionFile.text, source: 'VERSION' };

  const packageFile = packageVersion(packageText);
  if (packageFile) return { version: packageFile.text, source: 'package.json' };

  return { version: '0.1.0', source: 'fallback' };
}

function nextVersion(current, { bump = 'patch', setVersion = null } = {}) {
  const baseline = requireVersion(current, 'baseline');

  if (setVersion !== null && setVersion !== undefined) {
    const explicit = requireVersion(setVersion, 'set-version');
    if (compareParsed(explicit, baseline) <= 0) {
      throw new Error(`set-version ${explicit.text} must be strictly greater than baseline ${baseline.text}`);
    }
    return explicit.text;
  }

  if (!['major', 'minor', 'patch'].includes(bump)) {
    throw new Error(`unknown bump ${JSON.stringify(bump)}; expected major, minor, or patch`);
  }

  let [major, minor, patch] = baseline.parts;
  if (bump === 'major') {
    major += 1n;
    minor = 0n;
    patch = 0n;
  } else if (bump === 'minor') {
    minor += 1n;
    patch = 0n;
  } else {
    patch += 1n;
  }
  return `${major}.${minor}.${patch}`;
}

function computeVersion(input = {}) {
  const baseline = findBaseline(input);
  return {
    current: baseline.version,
    next: nextVersion(baseline.version, {
      bump: input.bump,
      setVersion: input.setVersion,
    }),
    source: baseline.source,
  };
}

function readOptional(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

function repositoryTags() {
  const output = execFileSync('git', ['tag', '--list'], { encoding: 'utf8' });
  return output.split(/\r?\n/).filter(Boolean);
}

function writeReleaseVersion(version, root = process.cwd()) {
  requireVersion(version, 'release version');
  const pending = [];
  const read = name => {
    const file = path.join(root, name);
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${name} must be a regular file`);
    return { file, stat, bytes:fs.readFileSync(file) };
  };
  const versionFile = read('VERSION');
  pending.push({ name:'VERSION', existing:versionFile, text:version + '\n' });
  // Validate every present manifest before modifying any release file.
  for (const name of ['package.json', 'package-lock.json']) {
    const existing = read(name);
    if (!existing) continue;
    let manifest;
    try {
      const text = existing.bytes.toString('utf8');
      if (!Buffer.from(text,'utf8').equals(existing.bytes)) throw new Error('invalid UTF-8');
      manifest = JSON.parse(text);
    } catch { throw new Error(`${name} must contain valid JSON`); }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error(`${name} must contain a JSON object`);
    if (name === 'package-lock.json' && Object.hasOwn(manifest,'packages')
        && (!manifest.packages || typeof manifest.packages !== 'object' || Array.isArray(manifest.packages))) {
      throw new Error('package-lock.json packages must contain a JSON object');
    }
    const rootPackage = manifest.packages?.[''];
    if (name === 'package-lock.json' && rootPackage !== undefined
        && (!rootPackage || typeof rootPackage !== 'object' || Array.isArray(rootPackage))) {
      throw new Error('package-lock.json root package must contain a JSON object');
    }
    let changed = false;
    if (Object.hasOwn(manifest,'version')) { manifest.version = version; changed = true; }
    if (name === 'package-lock.json' && rootPackage && Object.hasOwn(rootPackage,'version')) {
      rootPackage.version = version; changed = true;
    }
    if (changed) pending.push({name,existing,text:JSON.stringify(manifest,null,2) + '\n'});
  }
  // Guard concurrent edits and symlink replacement before opening any writer.
  for (const item of pending) {
    const current = read(item.name);
    if (item.existing ? !current || current.stat.dev !== item.existing.stat.dev
        || current.stat.ino !== item.existing.stat.ino || !current.bytes.equals(item.existing.bytes) : current !== null) {
      throw new Error(`${item.name} changed during release preparation`);
    }
  }
  for (const item of pending) {
    const file = path.join(root,item.name);
    const flags = fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0)
      | (item.existing ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL);
    const fd = fs.openSync(file,flags,item.existing?.stat.mode || 0o644);
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || (item.existing && (opened.dev !== item.existing.stat.dev || opened.ino !== item.existing.stat.ino))) {
        throw new Error(`${item.name} changed before release write`);
      }
      fs.writeFileSync(fd,item.text); fs.ftruncateSync(fd,Buffer.byteLength(item.text)); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }
  return pending.map(item => item.name);
}

function main() {
  if (process.argv[2] === '--write-release') {
    if (process.argv.length !== 4) throw new Error('--write-release requires exactly one version');
    writeReleaseVersion(process.argv[3]);
    return;
  }
  if (process.argv.length > 2) throw new Error('unknown version command');
  const setVersionPresent = process.env.SET_VERSION_PRESENT === 'true';
  const result = computeVersion({
    tags: repositoryTags(),
    versionText: readOptional('VERSION'),
    packageText: readOptional('package.json'),
    bump: process.env.BUMP || 'patch',
    setVersion: setVersionPresent ? (process.env.SET_VERSION || '') : null,
  });
  process.stdout.write(`current=${result.current}\nnext=${result.next}\nsource=${result.source}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`Version computation failed: ${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  STRICT_VERSION,
  parseVersion,
  findBaseline,
  nextVersion,
  computeVersion,
  writeReleaseVersion,
};
