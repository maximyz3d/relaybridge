// # rb-template v3
'use strict';

// Keep version selection outside the workflow shell so the exact behavior can
// be tested. This file is installed alongside version-on-merge.yml at
// .github/scripts/compute-version.cjs and intentionally has no dependencies.

const fs = require('node:fs');
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

function main() {
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
};
