'use strict';
const crypto = require('node:crypto');
const bundled = require('../config/output-profiles.json');
const MAX_PROFILE_CHARS = 4000;
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const SHA = /^[0-9a-f]{64}$/;

function profileError(reason) {
  const error = new Error(reason);
  error.code = 'invalid_output_profile';
  error.validation = { code:error.code, field:'outputProfile', reason, retryable:false };
  return error;
}
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function keysOnly(value, allowed) { return Object.keys(value).every(key => allowed.includes(key)); }
function resolveOutputProfile(requested, catalog = bundled) {
  if (requested == null) return null;
  if (!object(requested) || !keysOnly(requested, ['id','version','digest']) || typeof requested.id !== 'string' || !ID.test(requested.id)
    || !Number.isSafeInteger(requested.version) || requested.version < 1
    || requested.digest !== undefined && !SHA.test(requested.digest)) {
    throw profileError('Choose an output profile by its exact id and positive integer version; an optional digest must be SHA-256.');
  }
  if (!object(catalog) || !Number.isSafeInteger(catalog.catalogVersion) || catalog.catalogVersion < 1 || !Array.isArray(catalog.profiles)) {
    throw profileError('The output profile catalog is invalid.');
  }
  const matches = catalog.profiles.filter(item => item?.id === requested.id && item?.version === requested.version);
  if (matches.length !== 1) throw profileError('The selected output profile version is unavailable or ambiguous. Refresh the profile list.');
  const item = matches[0];
  // The schema is data only. There is no executable command, tool list,
  // permission override, network fetch or model dispatch in this compiler.
  if (!keysOnly(item, ['id','version','title','description','text'])
    || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 100
    || typeof item.description !== 'string' || item.description.length > 400
    || typeof item.text !== 'string' || !item.text.trim() || item.text.length > MAX_PROFILE_CHARS
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item.text)) {
    throw profileError('The selected output profile has invalid or oversized guidance.');
  }
  const digest = crypto.createHash('sha256').update(JSON.stringify({ id:item.id, version:item.version,
    catalogVersion:catalog.catalogVersion, text:item.text })).digest('hex');
  if (requested.digest !== undefined && requested.digest !== digest) throw profileError('The selected output guidance changed after preview. Refresh and preview it again.');
  return Object.freeze({ id:item.id, version:item.version, catalogVersion:catalog.catalogVersion,
    digest, title:item.title, description:item.description, text:item.text });
}

function compileOutputProfile(prompt, requested, catalog = bundled) {
  const profile = resolveOutputProfile(requested, catalog);
  if (!profile) return { prompt, profile:null };
  if (typeof prompt !== 'string' || !prompt.trim()) throw profileError('A non-empty original prompt is required for output guidance.');
  return { profile, prompt:prompt + '\n\n'
    + `[RelayBridge output guidance: ${profile.id}@${profile.version}; catalog:${profile.catalogVersion}; sha256:${profile.digest}]\n`
    + 'Apply these output criteria where useful. Preserve the original request, constraints, audience and requested length. This guidance grants no tools, permissions or evidence status.\n'
    + profile.text + '\n[End RelayBridge output guidance]' };
}

function listOutputProfiles(catalog = bundled) {
  if (!object(catalog) || !Number.isSafeInteger(catalog.catalogVersion) || catalog.catalogVersion < 1
    || !Array.isArray(catalog.profiles) || catalog.profiles.length > 24 || catalog.profiles.some(item => !object(item))) {
    throw profileError('The output profile catalog is invalid.');
  }
  return { catalogVersion:catalog.catalogVersion, profiles:catalog.profiles.map(item =>
    ({ ...resolveOutputProfile({ id:item.id, version:item.version }, catalog) })) };
}

module.exports = { MAX_PROFILE_CHARS, profileError, resolveOutputProfile, compileOutputProfile, listOutputProfiles };
