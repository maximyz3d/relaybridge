'use strict';

// Metadata only. This module never opens credentials or qualifies a grant.
const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('./subscription-usage');
const { CREDIT_SECRET_NAMES } = require('./allocated-credit');
const { validAccountId } = require('./provider-accounts');
const error = (code = 'invalid_funding_profile') => Object.assign(new Error(code), { code });
const clone = (value) => JSON.parse(JSON.stringify(value));
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
function closed(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw error();
}
function ref(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value) || /^sk-/i.test(value)) throw error();
  return value;
}
function label(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 64 || /[\x00-\x1f\x7f]|sk-[A-Za-z0-9_-]+/i.test(value)) throw error();
  return value;
}
function identity(value) { closed(value, ['ref', 'label']); return { ref: ref(value.ref), label: label(value.label) }; }
function iso(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw error();
  return value;
}
function validateProfile(value) {
  closed(value, ['id', 'provider', 'label', 'subscription', 'organization', 'project', 'credentialRef', 'creditPeriod']);
  if (!['claude', 'openai'].includes(value.provider)) throw error();
  closed(value.subscription, ['kind', 'accountId']);
  if (!validAccountId(value.id) || !validAccountId(value.subscription.accountId)) throw error();
  // Subscription kinds are fixed; API routing must never reinterpret Codex auth.
  if (value.subscription.kind !== (value.provider === 'claude' ? 'claude' : 'codex')) throw error();
  let credentialRef = null, creditPeriod = null;
  if (value.credentialRef != null) {
    closed(value.credentialRef, ['type', 'name']);
    if (value.credentialRef.type !== 'reserved_env' || value.credentialRef.name !== CREDIT_SECRET_NAMES[value.provider === 'claude' ? 0 : 1]) throw error();
    credentialRef = { ...value.credentialRef };
  }
  if (value.creditPeriod != null) {
    closed(value.creditPeriod, ['start', 'end']);
    creditPeriod = { start: iso(value.creditPeriod.start), end: iso(value.creditPeriod.end) };
    if (creditPeriod.start >= creditPeriod.end) throw error();
  }
  return { id: ref(value.id), provider: value.provider, label: label(value.label),
    subscription: { kind: value.subscription.kind, accountId: ref(value.subscription.accountId) },
    organization: identity(value.organization), project: value.project == null ? null : identity(value.project), credentialRef, creditPeriod };
}
function createFundingProfiles({ dataDir }) {
  const directory = path.join(dataDir, 'funding-profiles'), file = path.join(directory, 'profiles.json');
  const marker = path.join(dataDir, 'funding-profiles.initialized');
  function safeStat(name, isDirectory = false) {
    const stat = fs.lstatSync(name);
    if (stat.isSymbolicLink() || (isDirectory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1 || stat.size > 65536)
      || (process.platform !== 'win32' && ((stat.mode & 0o777) !== (isDirectory ? 0o700 : 0o600) || stat.uid !== process.getuid()))) throw error();
    return stat;
  }
  function snapshot() {
    try {
      try { safeStat(directory, true); } catch (e) { if (e.code === 'ENOENT' && !fs.existsSync(marker)) return { storeState: 'empty', schemaVersion: 1, storeRevision: 0, selected: null, profiles: [] }; throw e; }
      let raw;
      try { safeStat(file); raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (e) {
        if (e.code === 'ENOENT' && !fs.existsSync(marker)) return { storeState: 'empty', schemaVersion: 1, storeRevision: 0, selected: null, profiles: [] };
        throw e;
      }
      closed(raw, ['schemaVersion', 'storeRevision', 'selected', 'profiles']);
      if (raw.schemaVersion !== 1 || !integer(raw.storeRevision) || raw.storeRevision < 1 || !Array.isArray(raw.profiles) || raw.profiles.length > 100) throw error();
      const ids = new Set();
      for (const row of raw.profiles) {
        const { revision, updatedAt, ...profile } = row;
        validateProfile(profile); iso(updatedAt);
        if (!integer(revision) || revision < 1 || revision > raw.storeRevision || ids.has(profile.id)) throw error();
        ids.add(profile.id);
      }
      if (raw.selected !== null) {
        closed(raw.selected, ['profileId', 'profileRevision']);
        if (!raw.profiles.some(p => p.id === raw.selected.profileId && p.revision === raw.selected.profileRevision)) throw error();
      }
      return { storeState: 'valid', ...raw };
    } catch { return { storeState: 'invalid', schemaVersion: 1, storeRevision: null, selected: null, profiles: [] }; }
  }
  function mutate(expectedRevision, apply) {
    const current = snapshot();
    if (current.storeState === 'invalid') throw error('funding_profile_store_invalid');
    if (!integer(expectedRevision) || expectedRevision !== current.storeRevision) throw error('funding_store_revision_conflict');
    const { storeState, ...next } = clone(current);
    next.storeRevision++;
    if (!Number.isSafeInteger(next.storeRevision)) throw error('funding_profile_store_invalid');
    apply(next);
    if (Buffer.byteLength(JSON.stringify(next, null, 2)) > 65536) throw error('funding_profile_store_full');
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); safeStat(directory, true);
      // The sentinel makes accidental file deletion fail closed across restarts.
      if (!fs.existsSync(marker)) atomicWrite(marker, '1\n');
      atomicWrite(file, next);
    } catch { throw error('funding_profile_write_failed'); }
    return snapshot();
  }
  return {
    snapshot,
    set(input) {
      closed(input, ['profile', 'expectedRevision']);
      const profile = validateProfile(input.profile);
      return mutate(input.expectedRevision, next => {
        const row = { ...profile, revision: next.storeRevision, updatedAt: new Date().toISOString() };
        const index = next.profiles.findIndex(p => p.id === row.id);
        if (index < 0) { if (next.profiles.length >= 100) throw error('funding_profile_store_full'); next.profiles.push(row); } else next.profiles[index] = row;
        if (next.selected?.profileId === row.id) next.selected.profileRevision = row.revision;
      });
    },
    remove(input) {
      closed(input, ['profileId', 'expectedRevision']); ref(input.profileId);
      return mutate(input.expectedRevision, next => {
        if (!next.profiles.some(p => p.id === input.profileId)) throw error('funding_profile_missing');
        next.profiles = next.profiles.filter(p => p.id !== input.profileId);
        if (next.selected?.profileId === input.profileId) next.selected = null;
      });
    },
    select(input) {
      closed(input, ['profileId', 'expectedRevision']);
      return mutate(input.expectedRevision, next => {
        if (input.profileId === null) { next.selected = null; return; }
        ref(input.profileId);
        const profile = next.profiles.find(p => p.id === input.profileId);
        if (!profile) throw error('funding_profile_missing');
        next.selected = { profileId: profile.id, profileRevision: profile.revision };
      });
    },
  };
}
module.exports = { createFundingProfiles, validateProfile };
