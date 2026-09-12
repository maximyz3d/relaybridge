'use strict';
const crypto = require('node:crypto');
const { readBoundedJson } = require('./bounded-json-read');

function catalogUrl(chatUrl, configured) {
  const chat = new URL(chatUrl);
  if (!configured && !/\/chat\/completions\/?$/.test(chat.pathname)) throw new Error('catalog_unsupported');
  const url = configured ? new URL(configured) : new URL(chat.href.replace(/\/chat\/completions\/?$/, '/models'));
  if (url.protocol !== 'https:' || url.origin !== chat.origin || url.username || url.password || url.hash || url.search)
    throw new Error('catalog_endpoint_invalid');
  return url;
}

function createHostedModelCatalog({ pool, now = Date.now, ttlMs = 60000, maxEntries = 128 } = {}) {
  const cache = new Map(), identities = new Map();
  async function check({ chatUrl, modelsUrl, key, model, generation = '', signal, currentIdentity = () => true }) {
    const stale = () => ({ status: 'unknown', diagnosticCode: 'catalog_identity_changed', model, checkedAt: null });
    if (!currentIdentity()) return stale();
    let url;
    try { url = catalogUrl(chatUrl, modelsUrl); }
    catch (error) { return { status: 'unknown', diagnosticCode: error.message, model, checkedAt: null }; }
    if (!key?.value) return { status: 'unknown', diagnosticCode: 'catalog_key_missing', model, checkedAt: null };
    // Credential equality is private and short-lived. Operation-pool keys are
    // random IDs, never a password hash or stable credential fingerprint.
    const identity = JSON.stringify([url.href, model, key.name, key.value, generation]);
    for (const [value, entry] of identities) if (entry.expiresAt <= now()) identities.delete(value);
    let identityEntry = identities.get(identity);
    if (!identityEntry) {
      identityEntry = { id: crypto.randomUUID(), expiresAt: now() + ttlMs };
      identities.set(identity, identityEntry);
      while (identities.size > maxEntries) identities.delete(identities.keys().next().value);
    }
    const id = identityEntry.id;
    const prior = cache.get(id);
    if (prior && prior.expiresAt > now() && currentIdentity()) return { ...prior };
    const work = async workerSignal => {
      if (!currentIdentity()) return stale();
      const result = await readBoundedJson(url, { signal: workerSignal, headers: { Authorization: `Bearer ${key.value}` } });
      const at = now();
      let status = 'unknown', diagnosticCode = 'catalog_unreachable', models = null;
      if (result.completed) {
        diagnosticCode = `catalog_http_${result.status}`;
        if (result.status === 401) status = 'auth_failed';
        else if (result.status === 403) status = 'permission_denied';
        else if (result.status === 200) {
          const rows = result.body?.data;
          if (!Array.isArray(rows) || rows.length > 10000 || rows.some(row => !row || typeof row.id !== 'string' || !row.id || row.id.length > 256)) {
            diagnosticCode = 'catalog_schema_invalid';
          } else {
            models = [...new Set(rows.filter(row => row.active !== false).map(row => row.id))];
            status = models.includes(model) ? 'available' : 'unavailable';
            diagnosticCode = status === 'available' ? null : 'configured_model_not_available';
          }
        }
      }
      return { status, diagnosticCode, model, checkedAt: at, expiresAt: at + ttlMs,
        ...(models ? { models } : {}), quotaVerified: false, completionVerified: false };
    };
    let result;
    try { result = pool ? await pool.run(`hosted_catalog:${id}`, work, { signal }) : await work(signal); }
    catch { result = { status: 'unknown', diagnosticCode: 'catalog_admission_unavailable', model, checkedAt: null }; }
    if (!currentIdentity()) return { status: 'unknown', diagnosticCode: 'catalog_identity_changed', model, checkedAt: null };
    if (!signal?.aborted && result.expiresAt) {
      cache.delete(id); cache.set(id, result);
      while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
    }
    return { ...result };
  }
  return { check };
}
module.exports = { catalogUrl, createHostedModelCatalog };
