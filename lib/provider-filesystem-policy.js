'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SAFE_POLICIES = new Set([
  'read_only_enforced',
  'isolated_home',
  'unverified_provider_policy',
]);
const PREFIX = 'RelayBridge-provider-home-';
const MARKER = '.relaybridge-isolated-home.json';

function resolveFilesystemPolicy(entry, dangerous) {
  if (dangerous) return 'writer_authorized';
  const value = entry?.oneshot_safe_filesystem_policy ?? 'unverified_provider_policy';
  if (!SAFE_POLICIES.has(value)) {
    throw new Error(`oneshot_safe_filesystem_policy must be one of ${[...SAFE_POLICIES].join(', ')}`);
  }
  if (entry?.oneshot_adapter && value === 'isolated_home') {
    throw new Error('isolated_home is valid only for spawned CLI providers');
  }
  return value;
}

function providerFilesystemEligibility(entry, { dangerous = false } = {}) {
  try {
    const policy = resolveFilesystemPolicy(entry, dangerous);
    const eligible = dangerous || policy !== 'unverified_provider_policy';
    return {
      policy,
      eligible,
      readOnlyEnforced: !dangerous && policy === 'read_only_enforced',
      isolatedHome: !dangerous && policy === 'isolated_home',
      blockedReason: eligible ? null
        : 'safe one-shot blocked: provider filesystem policy is unverified',
    };
  } catch (error) {
    return {
      policy: 'unverified_provider_policy',
      eligible: false,
      readOnlyEnforced: false,
      isolatedHome: false,
      blockedReason: `safe one-shot blocked: invalid filesystem policy (${error.message})`,
    };
  }
}

function isDirectChild(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep);
}

function createIsolatedProviderHome(options = {}) {
  const tempRoot = path.resolve(options.tempRoot || os.tmpdir());
  fs.mkdirSync(tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(tempRoot, PREFIX));
  if (!isDirectChild(tempRoot, root)) throw new Error('isolated provider home escaped its temp root');
  const owner = crypto.randomUUID();
  fs.writeFileSync(path.join(root, MARKER), JSON.stringify({ owner, version: 1 }), { encoding: 'utf8', flag: 'wx' });
  const dirs = {
    APPDATA: path.join(root, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(root, '.config'),
    XDG_CACHE_HOME: path.join(root, '.cache'),
    XDG_DATA_HOME: path.join(root, '.local', 'share'),
    XDG_STATE_HOME: path.join(root, '.local', 'state'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  return {
    id: crypto.createHash('sha256').update(owner).digest('hex').slice(0, 16),
    root,
    tempRoot,
    owner,
    env: { HOME: root, USERPROFILE: root, ...dirs },
  };
}

function cleanupIsolatedProviderHome(home) {
  if (!home || !isDirectChild(home.tempRoot, home.root) || !path.basename(home.root).startsWith(PREFIX)) {
    return { ok: false, status: 'failed_preserved', detail: 'refused cleanup outside the owned temp namespace' };
  }
  let cleanupRoot = home.root;
  try {
    // Move the exact child to a fresh, unguessable name first. A detached
    // provider descendant that retained the old path can no longer race marker
    // validation and recursive removal. Renaming a junction moves the junction,
    // then lstat below refuses to traverse it.
    cleanupRoot = path.join(home.tempRoot, `${PREFIX}cleanup-${crypto.randomUUID()}`);
    fs.renameSync(home.root, cleanupRoot);
    const stat = fs.lstatSync(cleanupRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { ok: false, status: 'failed_preserved', detail: 'isolated home was replaced by a link; preserved', preservedPath: cleanupRoot };
    }
    const marker = JSON.parse(fs.readFileSync(path.join(cleanupRoot, MARKER), 'utf8'));
    if (marker.owner !== home.owner || marker.version !== 1) {
      return { ok: false, status: 'failed_preserved', detail: 'ownership marker mismatch; directory preserved', preservedPath: cleanupRoot };
    }
    fs.rmSync(cleanupRoot, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 });
    return { ok: true, status: 'complete', detail: '' };
  } catch (error) {
    return { ok: false, status: 'failed_preserved', detail: `isolated home preserved: ${error.code || 'cleanup_error'}`, preservedPath: cleanupRoot };
  }
}

module.exports = {
  SAFE_POLICIES, PREFIX, MARKER, resolveFilesystemPolicy,
  providerFilesystemEligibility,
  createIsolatedProviderHome, cleanupIsolatedProviderHome,
};
