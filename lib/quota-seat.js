'use strict';

const QUOTA_SEAT_RE = /^[a-z0-9][a-z0-9:._-]{0,127}$/i;

// Provider keys identify a route/model. quotaSeat identifies the authenticated
// account whose finite allowance those routes consume. It is explicit because
// two entries with the same transport can still be signed into different
// accounts on another installation.
function buildQuotaSeatGroups(config = {}) {
  const providerToQuotaSeat = {};
  const groups = {};
  for (const [provider, entry] of Object.entries(config || {})) {
    if (provider.startsWith('_') || !entry || typeof entry !== 'object') continue;
    const declared = typeof entry.quota_seat === 'string' ? entry.quota_seat.trim() : '';
    const quotaSeat = declared && QUOTA_SEAT_RE.test(declared) ? declared : provider;
    providerToQuotaSeat[provider] = quotaSeat;
    const group = groups[quotaSeat] || (groups[quotaSeat] = {
      quotaSeat,
      providers: [],
      transport: entry.transport || null,
      explicitlyGrouped: !!declared,
    });
    group.providers.push(provider);
    group.providers.sort();
    if (group.transport !== (entry.transport || null)) group.transport = null;
    group.explicitlyGrouped = group.explicitlyGrouped || !!declared;
  }
  return { providerToQuotaSeat, groups };
}

module.exports = { buildQuotaSeatGroups, QUOTA_SEAT_RE };
