'use strict';

// Multiple accounts on one provider.
//
// A subscription CLI keeps its credentials in a config directory, and every one
// of them lets you move that directory with an environment variable — Claude
// Code reads CLAUDE_CONFIG_DIR, Codex reads CODEX_HOME, the GitHub CLI (and so
// Copilot) reads GH_CONFIG_DIR. Point that variable at a different directory and
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

const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const REGISTRY_FILE = 'accounts.json';

// A seat with no explicit account list still has exactly one account: whatever
// the CLI is already logged into. Naming it keeps every downstream path
// (selection, attribution, gauges) identical whether or not the operator has
// added a second plan.
const DEFAULT_ACCOUNT_ID = 'default';

function registryPath(dataDir) {
  return path.join(dataDir, REGISTRY_FILE);
}

function loadRegistry(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath(dataDir), 'utf8'));
    return raw && typeof raw === 'object' && raw.providers && typeof raw.providers === 'object'
      ? raw
      : { providers: {} };
  } catch {
    return { providers: {} };
  }
}

function saveRegistry(dataDir, registry) {
  const tmp = registryPath(dataDir) + '.tmp';
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, registryPath(dataDir));
  return registry;
}

// The env var that relocates this provider's credentials. Declared per seat in
// cli-config.json so a new provider is a config edit, not a code change.
function credentialEnvFor(entry) {
  const declared = entry && typeof entry.credential_env === 'string' ? entry.credential_env.trim() : '';
  return /^[A-Z][A-Z0-9_]*$/.test(declared) ? declared : null;
}

function accountDir(dataDir, kind, accountId) {
  return path.join(dataDir, 'accounts', String(kind), String(accountId));
}

// Every account of a seat needs a DISTINCT quotaSeat or the ledger would pool
// their usage back into one allowance and the gauges would read as a single
// drained plan. The default account keeps the seat's configured quotaSeat
// verbatim so existing ledger rows, budgets and receipts keep matching.
function quotaSeatForAccount(baseQuotaSeat, accountId) {
  const base = String(baseQuotaSeat || '');
  if (!accountId || accountId === DEFAULT_ACCOUNT_ID) return base;
  return `${base}#${accountId}`;
}

// Accounts configured for a seat, always at least one.
function accountsFor(kind, entry, registry) {
  const configured = registry?.providers?.[kind]?.accounts;
  const list = Array.isArray(configured) ? configured.filter((a) => a && ACCOUNT_ID_RE.test(String(a.id || ''))) : [];
  const base = (entry && typeof entry.quota_seat === 'string' && entry.quota_seat.trim()) || String(kind);
  if (!list.length) {
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
  const varName = credentialEnvFor(entry);
  if (!varName) return {};
  const dir = accountDir(dataDir, kind, account.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { [varName]: dir };
}

// Has this account ever been signed in? An empty credential directory means the
// CLI will report "not logged in" and burn a dispatch discovering that, so
// selection can skip it and the dashboard can prompt instead.
function accountIsProvisioned({ entry, account, dataDir, kind }) {
  if (!account) return false;
  if (account.implicit) return true; // the operator's own config dir
  if (!credentialEnvFor(entry)) return false;
  const dir = accountDir(dataDir, kind, account.id);
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
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
function selectAccount({ kind, entry, registry, dataDir, gauges = {}, coolingQuotaSeats = new Set() }) {
  const all = accountsFor(kind, entry, registry);
  const usable = all.filter((a) => a.enabled && accountIsProvisioned({ entry, account: a, dataDir, kind }));
  if (!usable.length) return null;
  if (usable.length === 1) return usable[0];

  const scored = usable.map((a) => {
    const gauge = gauges[a.quotaSeat];
    const cooling = coolingQuotaSeats.has(a.quotaSeat);
    // An unmetered or unbudgeted account reports no percentage. Treat it as
    // fully available rather than as drained, but rank it BELOW any account
    // with a real measurement so a known-good plan is preferred over a guess.
    const pct = Number.isFinite(Number(gauge?.percentRemaining)) ? Number(gauge.percentRemaining) : null;
    return { account: a, cooling, pct, measured: pct !== null };
  });

  scored.sort((x, y) => {
    if (x.cooling !== y.cooling) return x.cooling ? 1 : -1;
    if (x.measured !== y.measured) return x.measured ? -1 : 1;
    if (x.measured && y.measured && x.pct !== y.pct) return y.pct - x.pct; // most remaining first
    return x.account.id.localeCompare(y.account.id);                       // stable
  });
  return scored[0].account;
}

// --- registry mutation, used by the REST surface ---

function addAccount(dataDir, kind, { id, label }) {
  if (!ACCOUNT_ID_RE.test(String(id || ''))) {
    throw new Error('account id must be 1-64 chars of [A-Za-z0-9._-] and start alphanumeric');
  }
  const registry = loadRegistry(dataDir);
  const provider = registry.providers[kind] || (registry.providers[kind] = { accounts: [] });
  if (!Array.isArray(provider.accounts)) provider.accounts = [];
  if (provider.accounts.some((a) => String(a.id) === String(id))) {
    throw new Error(`account '${id}' already exists for ${kind}`);
  }
  // Adding the FIRST explicit account would otherwise silently orphan the
  // operator's existing login: the seat would stop being implicit, and the new
  // account's empty directory would be its only credential source. Seed the
  // list with 'default' so the existing session stays usable and addressable.
  if (!provider.accounts.length && String(id) !== DEFAULT_ACCOUNT_ID) {
    provider.accounts.push({ id: DEFAULT_ACCOUNT_ID, label: 'existing sign-in', enabled: true });
  }
  provider.accounts.push({ id: String(id), label: String(label || id), enabled: true });
  saveRegistry(dataDir, registry);
  return registry;
}

function removeAccount(dataDir, kind, id) {
  const registry = loadRegistry(dataDir);
  const provider = registry.providers[kind];
  if (!provider || !Array.isArray(provider.accounts)) return registry;
  provider.accounts = provider.accounts.filter((a) => String(a.id) !== String(id));
  if (!provider.accounts.length) delete registry.providers[kind];
  saveRegistry(dataDir, registry);
  return registry;
}

function setAccountEnabled(dataDir, kind, id, enabled) {
  const registry = loadRegistry(dataDir);
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
  if (!ACCOUNT_ID_RE.test(String(id || ''))) throw new Error('invalid account id');
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
  DEFAULT_ACCOUNT_ID,
  loadRegistry,
  saveRegistry,
  credentialEnvFor,
  accountDir,
  quotaSeatForAccount,
  accountsFor,
  hasMultipleAccounts,
  envForAccount,
  accountIsProvisioned,
  selectAccount,
  addAccount,
  removeAccount,
  setAccountEnabled,
  forgetAccountCredentials,
};
