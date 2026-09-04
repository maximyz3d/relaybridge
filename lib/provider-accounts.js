'use strict';

// Multiple accounts on one provider.
//
// A subscription CLI keeps its credentials in a config directory, and every one
// of them lets you move that directory with an environment variable — Claude
// Code reads CLAUDE_CONFIG_DIR, Codex reads CODEX_HOME, and the Copilot CLI
// reads COPILOT_HOME. Point that variable at a different directory and
// the same binary runs as a different account, with no HOME swapping and no
// re-login between calls.
//
// That is the whole mechanism. Everything else here exists so the rest of the
// bridge does not have to know about it:
//
//   - Each account gets its own quotaSeat, derived from the seat's configured
//     one. quotaSeat already means "the authenticated account whose finite
//     allowance these routes consume" (lib/quota-seat.js), so per-account
//     gauges, per-account cooldowns and load levelling across accounts all fall
//     out of machinery that already exists — three Claude plans read as three
//     seats to drain, which is the pooling the operator actually wanted.
//   - Selection prefers the least-drained account and skips ones in cooldown,
//     so a 429 on one plan moves work to the next instead of failing the seat.
//
// The credential directories hold live session tokens. They are created 0700 and
// never read, copied or logged by this module — it only ever hands their PATH to
// a child process.

const fs = require('fs');
const path = require('path');
const { BASE_QUOTA_SEAT_RE, QUOTA_SEAT_RE } = require('./quota-seat');

// Lowercase, portable path segments. Case variants and trailing dots alias on
// Windows/default macOS filesystems, while DOS device names are not usable
// directory identities there at all.
const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROVIDER_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_DEVICE_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const REGISTRY_FILE = 'accounts.json';
// `accounts.json` being absent used to mean a pristine single-account install.
// Once the operator manages a pool, however, silently interpreting a deleted
// registry that way can dispatch on (and bill) the implicit default login. Keep
// a separate, durable initialization bit so strict authority reads can tell the
// two states apart and fail closed after accidental registry loss.
const REGISTRY_SENTINEL_FILE = 'accounts.initialized';
const DEFAULT_AUTH_FAILURE_MARKER = 'relaybridge:implicit-default-auth-failed';

// A seat with no explicit account list still has exactly one account: whatever
// the CLI is already logged into. Naming it keeps every downstream path
// (selection, attribution, gauges) identical whether or not the operator has
// added a second plan.
const DEFAULT_ACCOUNT_ID = 'default';

function registryPath(dataDir) {
  return path.join(dataDir, REGISTRY_FILE);
}

function registrySentinelPath(dataDir) {
  return path.join(dataDir, REGISTRY_SENTINEL_FILE);
}

function markRegistryInitialized(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const sentinel = registrySentinelPath(dataDir);
  try {
    fs.writeFileSync(sentinel, '1\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
  }
}

function validAccountId(value) {
  const id = String(value || '');
  return ACCOUNT_ID_RE.test(id) && !id.endsWith('.') && !WINDOWS_DEVICE_RE.test(id);
}

function validProviderKey(value) {
  return PROVIDER_KEY_RE.test(String(value || ''));
}

function quotePosix(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function formatSignInCommand({ envName, credentialDir, environment = null, argv = null, platform = process.platform }) {
  const declaredEnvironment = environment || { [envName]: credentialDir };
  if (!declaredEnvironment || typeof declaredEnvironment !== 'object' || Array.isArray(declaredEnvironment)) {
    throw new Error('invalid credential environment');
  }
  const assignments = Object.entries(declaredEnvironment);
  if (!assignments.length || assignments.some(([name, value]) =>
    !/^[A-Z][A-Z0-9_]*$/.test(String(name || '')) || typeof value !== 'string' || value.includes('\0'))) {
    throw new Error('invalid credential environment variable');
  }
  const command = Array.isArray(argv) && argv.length
    ? argv.map((arg) => platform === 'win32' ? quotePowerShell(arg) : quotePosix(arg)).join(' ')
    : '<provider login command>';
  if (platform === 'win32') {
    const prefix = assignments.map(([name, value]) => `$env:${name} = ${quotePowerShell(value)}`).join('; ');
    return `${prefix}; & ${command}`;
  }
  const prefix = assignments.map(([name, value]) => `${name}=${quotePosix(value)}`).join(' ');
  return `${prefix} ${command}`;
}

function validateRegistry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || !raw.providers || typeof raw.providers !== 'object' || Array.isArray(raw.providers)) {
    throw new Error('account registry must contain a providers object');
  }
  for (const [kind, provider] of Object.entries(raw.providers)) {
    if (!validProviderKey(kind)) throw new Error(`account registry contains invalid provider '${kind}'`);
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)
      || !Array.isArray(provider.accounts)) {
      throw new Error(`account registry provider '${kind}' must contain an accounts array`);
    }
    const ids = new Set();
    for (const account of provider.accounts) {
      if (!account || typeof account !== 'object' || Array.isArray(account)
        || !validAccountId(account.id)) {
        throw new Error(`account registry provider '${kind}' contains an invalid account id`);
      }
      const id = String(account.id);
      if (ids.has(id)) throw new Error(`account registry provider '${kind}' contains duplicate account '${id}'`);
      ids.add(id);
      if (account.enabled !== undefined && typeof account.enabled !== 'boolean') {
        throw new Error(`account registry account '${kind}/${id}' has a non-boolean enabled field`);
      }
      if (account.label !== undefined && typeof account.label !== 'string') {
        throw new Error(`account registry account '${kind}/${id}' has a non-string label`);
      }
      if (account.authFailureMarker !== undefined && typeof account.authFailureMarker !== 'string') {
        throw new Error(`account registry account '${kind}/${id}' has an invalid auth-failure marker`);
      }
      if (account.authFailedAt !== undefined && !Number.isFinite(account.authFailedAt)) {
        throw new Error(`account registry account '${kind}/${id}' has an invalid auth-failure timestamp`);
      }
    }
  }
  return raw;
}

function loadRegistry(dataDir, { strict = false } = {}) {
  const file = registryPath(dataDir);
  try {
    const bytes = fs.readFileSync(file, 'utf8');
    // This also upgrades registries created before the sentinel existed. Mark
    // presence before parsing so a malformed authority file cannot later be
    // deleted to turn a strict failure into an implicit-default dispatch.
    markRegistryInitialized(dataDir);
    const raw = JSON.parse(bytes);
    if (strict) return validateRegistry(raw);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)
      && raw.providers && typeof raw.providers === 'object' && !Array.isArray(raw.providers)) return raw;
    return { providers: {} };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      if (strict && fs.existsSync(registrySentinelPath(dataDir))) {
        throw new Error('account registry is missing after account management was initialized');
      }
      return { providers: {} };
    }
    if (strict) throw new Error(`account registry is unreadable: ${err.message}`);
    return { providers: {} };
  }
}

function saveRegistry(dataDir, registry) {
  const tmp = registryPath(dataDir) + '.tmp';
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, registryPath(dataDir));
  markRegistryInitialized(dataDir);
  return registry;
}

// The env var that relocates this provider's credentials. Declared per seat in
// cli-config.json so a new provider is a config edit, not a code change.
function credentialEnvFor(entry) {
  const declared = entry && typeof entry.credential_env === 'string' ? entry.credential_env.trim() : '';
  return /^[A-Z][A-Z0-9_]*$/.test(declared) ? declared : null;
}

function supportsLinkedAccounts(entry) {
  if (entry?.linked_accounts_supported !== undefined
    && typeof entry.linked_accounts_supported !== 'boolean') {
    throw new Error('linked_accounts_supported must be a boolean');
  }
  return !!credentialEnvFor(entry) && entry?.linked_accounts_supported !== false;
}

function credentialAuxEnvsFor(entry) {
  if (entry?.credential_aux_env === undefined) return [];
  if (!Array.isArray(entry.credential_aux_env) || entry.credential_aux_env.length > 8) {
    throw new Error('credential_aux_env must be an array of at most 8 environment names');
  }
  const primary = credentialEnvFor(entry);
  const seen = new Set();
  return entry.credential_aux_env.map((value) => {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || name === primary || seen.has(name)) {
      throw new Error('credential_aux_env contains an invalid or duplicate environment name');
    }
    seen.add(name);
    return name;
  });
}

function linkedAccountArgsFor(entry) {
  if (entry?.linked_account_args === undefined) return [];
  if (!Array.isArray(entry.linked_account_args) || entry.linked_account_args.length > 16
    || entry.linked_account_args.some((arg) => typeof arg !== 'string' || !arg || arg.includes('\0')
      || arg.includes('{prompt}') || arg.includes('{prompt_file}') || arg.includes('{cwd}'))) {
    throw new Error('linked_account_args must contain at most 16 non-placeholder string arguments');
  }
  return [...entry.linked_account_args];
}

function credentialEnvironmentFor(entry, credentialDir) {
  const primary = credentialEnvFor(entry);
  if (!primary) return {};
  return Object.fromEntries([primary, ...credentialAuxEnvsFor(entry)].map((name) => [name, credentialDir]));
}

function credentialMarkersFor(entry) {
  if (!Array.isArray(entry?.credential_markers)) return [];
  return entry.credential_markers.map(String).filter((marker) => {
    if (!marker || path.isAbsolute(marker)) return false;
    const normalized = path.normalize(marker);
    return normalized !== '..' && !normalized.startsWith(`..${path.sep}`);
  });
}

function accountDir(dataDir, kind, accountId) {
  if (!validProviderKey(kind)) throw new Error('invalid provider key');
  if (!validAccountId(accountId)) throw new Error('invalid account id');
  return path.join(dataDir, 'accounts', String(kind), String(accountId));
}

// Every account of a seat needs a DISTINCT quotaSeat or the ledger would pool
// their usage back into one allowance and the gauges would read as a single
// drained plan. The default account keeps the seat's configured quotaSeat
// verbatim so existing ledger rows, budgets and receipts keep matching.
function quotaSeatForAccount(baseQuotaSeat, accountId) {
  const base = String(baseQuotaSeat || '');
  if (!BASE_QUOTA_SEAT_RE.test(base)) throw new Error('invalid base quota seat');
  if (!validAccountId(accountId)) throw new Error('invalid account id');
  if (!accountId || accountId === DEFAULT_ACCOUNT_ID) return base;
  const quotaSeat = `${base}#${accountId}`;
  if (!QUOTA_SEAT_RE.test(quotaSeat)) throw new Error('generated account quota seat is invalid');
  return quotaSeat;
}

// Accounts configured for a seat. A provider absent from the registry gets the
// legacy implicit default. A present provider with an empty array is a durable
// tombstone: the operator removed every account, so default must not resurrect.
function accountsFor(kind, entry, registry) {
  const configured = registry?.providers?.[kind]?.accounts;
  const list = Array.isArray(configured) ? configured.filter((a) => a && validAccountId(a.id)) : [];
  const declaredBase = entry && typeof entry.quota_seat === 'string' ? entry.quota_seat.trim() : '';
  const base = declaredBase && BASE_QUOTA_SEAT_RE.test(declaredBase) ? declaredBase : String(kind);
  if (!Array.isArray(configured)) {
    return [{
      id: DEFAULT_ACCOUNT_ID,
      label: (entry && entry.label) || String(kind),
      quotaSeat: base,
      implicit: true,
      enabled: true,
    }];
  }
  return list.map((a) => {
    const id = String(a.id);
    // 'default' ALWAYS means "whatever the CLI is already logged into", even
    // once other accounts exist. It stays implicit so it injects no env and
    // reads the operator's own config directory. Making it explicit would point
    // it at an empty credential dir, and adding a second plan would silently
    // break the first — the sign-in the operator already had.
    const implicit = id === DEFAULT_ACCOUNT_ID;
    return {
      id,
      label: String(a.label || id),
      quotaSeat: quotaSeatForAccount(base, id),
      implicit,
      enabled: a.enabled !== false,
      authFailureMarker: typeof a.authFailureMarker === 'string' ? a.authFailureMarker : null,
      authFailedAt: Number.isFinite(a.authFailedAt) ? a.authFailedAt : null,
    };
  });
}

// True when the operator has actually added a second plan. Used to keep the
// no-accounts path byte-identical to the bridge's behaviour before this module.
function hasMultipleAccounts(kind, entry, registry) {
  return accountsFor(kind, entry, registry).length > 1;
}

// The env overlay that makes the child run as this account. An implicit default
// account injects NOTHING: the CLI reads the operator's own config directory
// exactly as it always has, so adding this module changes no existing install.
function envForAccount({ entry, account, dataDir, kind }) {
  if (!account || account.implicit) return {};
  if (!supportsLinkedAccounts(entry)) {
    throw new Error('provider does not support attribution-safe linked accounts');
  }
  const varName = credentialEnvFor(entry);
  if (!varName) return {};
  const dir = accountDir(dataDir, kind, account.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return credentialEnvironmentFor(entry, dir);
}

// Has this account ever been signed in? An empty credential directory means the
// CLI will report "not logged in" and burn a dispatch discovering that, so
// selection can skip it and the dashboard can prompt instead.
function accountIsProvisioned({ entry, account, dataDir, kind }) {
  if (!account) return false;
  if (account.implicit) return true; // the operator's own config dir
  if (!supportsLinkedAccounts(entry)) return false;
  const dir = accountDir(dataDir, kind, account.id);
  const markers = credentialMarkersFor(entry);
  if (!markers.length) return false;
  for (const marker of markers) {
    try {
      const stat = fs.statSync(path.join(dir, marker));
      if (stat.isFile() && stat.size > 0) return true;
    } catch { /* try the next provider-declared marker */ }
  }
  return false;
}

function credentialMarkerFingerprint({ entry, account, dataDir, kind }) {
  if (!account || account.implicit) return null;
  const dir = accountDir(dataDir, kind, account.id);
  const parts = [];
  for (const marker of credentialMarkersFor(entry).sort()) {
    try {
      const stat = fs.statSync(path.join(dir, marker));
      if (stat.isFile() && stat.size > 0) parts.push(`${marker}:${stat.size}:${stat.mtimeMs}`);
    } catch { /* absent markers are not credential authority */ }
  }
  return parts.length ? parts.join('|') : null;
}

function accountAuthAvailable({ entry, account, dataDir, kind }) {
  if (!account || !account.authFailureMarker) return true;
  // The implicit login lives in the provider's normal home, whose credential
  // location is vendor-specific and cannot be fingerprinted generically. A
  // live, authoritative auth failure quarantines it until a successful probe
  // or default-account run explicitly clears this marker.
  if (account.implicit) return account.authFailureMarker !== DEFAULT_AUTH_FAILURE_MARKER;
  const current = credentialMarkerFingerprint({ entry, account, dataDir, kind });
  return !!current && current !== account.authFailureMarker;
}

function noteAccountAuthFailure(dataDir, kind, accountId, entry) {
  if (!validProviderKey(kind) || !validAccountId(accountId)) return null;
  const registry = loadRegistry(dataDir, { strict: true });
  // A pristine install has an implicit default but no registry row yet. The
  // first live auth failure must materialize that row; otherwise the durable
  // quarantine silently disappears on restart and /api/accounts cannot offer
  // an honest recovery action.
  if (accountId === DEFAULT_ACCOUNT_ID
    && !Object.prototype.hasOwnProperty.call(registry.providers, kind)) {
    registry.providers[kind] = {
      accounts: [{
        id: DEFAULT_ACCOUNT_ID,
        label: String(entry?.label || kind),
        enabled: true,
      }],
    };
  }
  const account = registry.providers?.[kind]?.accounts?.find((item) => item.id === accountId);
  if (!account) return null;
  const marker = accountId === DEFAULT_ACCOUNT_ID
    ? DEFAULT_AUTH_FAILURE_MARKER
    : credentialMarkerFingerprint({
        entry,
        account: accountsFor(kind, entry, registry).find((item) => item.id === accountId),
        dataDir,
        kind,
      });
  if (!marker) return null;
  account.authFailureMarker = marker;
  account.authFailedAt = Date.now();
  saveRegistry(dataDir, registry);
  return { kind, accountId, authFailedAt: account.authFailedAt };
}

function clearAccountAuthFailure(dataDir, kind, accountId) {
  if (!validProviderKey(kind) || !validAccountId(accountId)) return null;
  const registry = loadRegistry(dataDir, { strict: true });
  const account = registry.providers?.[kind]?.accounts?.find((item) => item.id === accountId);
  if (!account || (account.authFailureMarker === undefined && account.authFailedAt === undefined)) return null;
  delete account.authFailureMarker;
  delete account.authFailedAt;
  saveRegistry(dataDir, registry);
  return { kind, accountId, cleared: true };
}

// Pick the account to run this dispatch on.
//
// Order: enabled and provisioned first, then not cooling, then the most quota
// left. `gauges` is keyed by quotaSeat and `coolingQuotaSeats` is a Set of the
// quotaSeats currently in cooldown — both already exist for single-account
// seats, which is why a second plan needs no new accounting.
//
// Returns null only when the seat has no usable account at all, which the caller
// must treat as "not ready" rather than falling back to an arbitrary one: a
// silent fallback would run work on a plan the operator disabled.
function selectAccount({
  kind,
  entry,
  registry,
  dataDir,
  gauges = {},
  coolingQuotaSeats = new Set(),
  unavailableAccountIds = new Set(),
  allowCoolingFallback = false,
}) {
  const all = accountsFor(kind, entry, registry);
  if (!(unavailableAccountIds instanceof Set)) unavailableAccountIds = new Set();
  const usable = all.filter((a) => a.enabled && !unavailableAccountIds.has(a.id)
    && accountIsProvisioned({ entry, account: a, dataDir, kind })
    && accountAuthAvailable({ entry, account: a, dataDir, kind }));
  if (!usable.length) return null;
  const quotaEligible = usable.filter((account) => {
    const gauge = gauges[account.quotaSeat];
    return !(gauge && gauge.basis === 'vendor_observed' && gauge.vendorQuota
      && Number.isFinite(gauge.remaining) && gauge.remaining <= 0);
  });
  if (!quotaEligible.length) return null;
  const nonCooling = quotaEligible.filter((account) => !coolingQuotaSeats.has(account.quotaSeat));
  const candidates = nonCooling.length ? nonCooling : (allowCoolingFallback ? quotaEligible : []);
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];

  const scored = candidates.map((a) => {
    const gauge = gauges[a.quotaSeat];
    // An unmetered or unbudgeted account reports no percentage. Treat it as
    // fully available rather than as drained, but rank it BELOW any account
    // with a real measurement so a known-good plan is preferred over a guess.
    const pct = typeof gauge?.percentRemaining === 'number' && Number.isFinite(gauge.percentRemaining)
      ? gauge.percentRemaining : null;
    return { account: a, pct, measured: pct !== null };
  });

  scored.sort((x, y) => {
    if (x.measured !== y.measured) return x.measured ? -1 : 1;
    if (x.measured && y.measured && x.pct !== y.pct) return y.pct - x.pct; // most remaining first
    return x.account.id.localeCompare(y.account.id);                       // stable
  });
  return scored[0].account;
}

// --- registry mutation, used by the REST surface ---

function addAccount(dataDir, kind, { id, label }) {
  if (!validProviderKey(kind)) throw new Error('invalid provider key');
  if (!validAccountId(id)) {
    throw new Error('account id must be a portable lowercase 1-64 character path segment');
  }
  if (String(id) === DEFAULT_ACCOUNT_ID) {
    throw new Error("account id 'default' is reserved for the operator's existing sign-in");
  }
  const registry = loadRegistry(dataDir, { strict: true });
  const providerExisted = Object.prototype.hasOwnProperty.call(registry.providers, kind);
  const provider = registry.providers[kind] || (registry.providers[kind] = { accounts: [] });
  if (!Array.isArray(provider.accounts)) provider.accounts = [];
  if (provider.accounts.some((a) => String(a.id) === String(id))) {
    throw new Error(`account '${id}' already exists for ${kind}`);
  }
  // Adding the FIRST explicit account would otherwise silently orphan the
  // operator's existing login: the seat would stop being implicit, and the new
  // account's empty directory would be its only credential source. Seed the
  // list with 'default' so the existing session stays usable and addressable.
  if (!providerExisted && !provider.accounts.length && String(id) !== DEFAULT_ACCOUNT_ID) {
    provider.accounts.push({ id: DEFAULT_ACCOUNT_ID, label: 'existing sign-in', enabled: true });
  }
  provider.accounts.push({ id: String(id), label: String(label || id), enabled: true });
  saveRegistry(dataDir, registry);
  return registry;
}

function removeAccount(dataDir, kind, id) {
  if (!validProviderKey(kind)) throw new Error('invalid provider key');
  if (!validAccountId(id)) throw new Error('invalid account id');
  const registry = loadRegistry(dataDir, { strict: true });
  const provider = registry.providers[kind];
  if (!provider || !provider.accounts.some((account) => String(account.id) === String(id))) {
    throw new Error(`unknown account '${id}' for ${kind}`);
  }
  provider.accounts = provider.accounts.filter((a) => String(a.id) !== String(id));
  // Preserve an empty managed provider as a tombstone. Removing the key would
  // mean "never configured" and silently recreate the implicit default login.
  saveRegistry(dataDir, registry);
  return registry;
}

function setAccountEnabled(dataDir, kind, id, enabled) {
  if (!validProviderKey(kind)) throw new Error('invalid provider key');
  if (!validAccountId(id)) throw new Error('invalid account id');
  const registry = loadRegistry(dataDir, { strict: true });
  const account = registry.providers?.[kind]?.accounts?.find((a) => String(a.id) === String(id));
  if (!account) throw new Error(`unknown account '${id}' for ${kind}`);
  account.enabled = !!enabled;
  saveRegistry(dataDir, registry);
  return registry;
}

// Deleting the credential directory is a sign-out: the session token lives only
// there. Refuse anything that is not the exact directory this module owns, so a
// malformed id can never turn into a recursive delete somewhere else.
function forgetAccountCredentials(dataDir, kind, id) {
  if (!validProviderKey(kind)) throw new Error('invalid provider key');
  if (!validAccountId(id)) throw new Error('invalid account id');
  const root = path.resolve(dataDir, 'accounts', String(kind));
  const dir = path.resolve(accountDir(dataDir, kind, id));
  const rel = path.relative(root, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
    throw new Error('refusing to remove a path outside the account namespace');
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return dir;
}

module.exports = {
  ACCOUNT_ID_RE,
  PROVIDER_KEY_RE,
  validAccountId,
  validProviderKey,
  validateRegistry,
  formatSignInCommand,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_AUTH_FAILURE_MARKER,
  loadRegistry,
  saveRegistry,
  credentialEnvFor,
  supportsLinkedAccounts,
  credentialAuxEnvsFor,
  credentialEnvironmentFor,
  linkedAccountArgsFor,
  credentialMarkersFor,
  accountDir,
  quotaSeatForAccount,
  accountsFor,
  hasMultipleAccounts,
  envForAccount,
  accountIsProvisioned,
  credentialMarkerFingerprint,
  accountAuthAvailable,
  noteAccountAuthFailure,
  clearAccountAuthFailure,
  selectAccount,
  addAccount,
  removeAccount,
  setAccountEnabled,
  forgetAccountCredentials,
};
