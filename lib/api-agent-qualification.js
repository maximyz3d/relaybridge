'use strict';

// Qualification authority for included-API-credit dispatch. A provider can be
// qualified only by an in-process adapter function. Production constructs one
// authority with frozen empty adapters, so no provider qualifies and the
// credential thunk is never called. Environment variables, settings, HTTP,
// MCP and request bodies cannot supply a qualification.
//
// Branding is a test seam, not a security boundary against arbitrary code
// already running in this process: it only ensures that plain or deserialized
// objects are never mistaken for a qualification result.

const AUTHORITIES = new WeakSet();
const RESULTS = new WeakSet();
const PROVIDERS = Object.freeze(['claude', 'openai']);
const fail = (code, message) => { throw Object.assign(new Error(message || code), { code }); };

function brand(value) {
  const result = Object.freeze(value);
  RESULTS.add(result);
  return result;
}

function createQualificationAuthority({ adapters } = {}) {
  if (!adapters || typeof adapters !== 'object' || Array.isArray(adapters)) throw new TypeError('qualification adapters must be an object');
  const table = {};
  for (const [provider, adapter] of Object.entries(adapters)) {
    if (!PROVIDERS.includes(provider) || typeof adapter !== 'function') throw new TypeError('invalid qualification adapter');
    table[provider] = adapter;
  }
  Object.freeze(table);
  const authority = Object.freeze({
    providers: Object.freeze(Object.keys(table)),
    // credentialSource is a lazy thunk returning { value, fingerprint }. It is
    // called only when an adapter exists for this provider.
    verify({ provider, profile, credentialSource, now }) {
      if (!PROVIDERS.includes(provider)) fail('api_qualification_invalid', 'Unknown provider.');
      if (!Object.hasOwn(table, provider)) {
        return brand({ qualified: false, provider, qualificationId: null, credentialFingerprint: null, reason: 'no_qualification_adapter' });
      }
      if (typeof credentialSource !== 'function') fail('api_credential_unbound', 'No credential source is bound.');
      const credential = credentialSource();
      if (!credential || typeof credential.value !== 'string' || !credential.value || typeof credential.fingerprint !== 'string') {
        return brand({ qualified: false, provider, qualificationId: null, credentialFingerprint: null, reason: 'credential_missing' });
      }
      let verdict;
      try { verdict = table[provider]({ provider, profile, credential: credential.value, now }); }
      catch { verdict = null; }
      const qualified = verdict?.qualified === true && typeof verdict.qualificationId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(verdict.qualificationId);
      return brand({ qualified, provider, qualificationId: qualified ? verdict.qualificationId : null,
        credentialFingerprint: credential.fingerprint, reason: qualified ? null : String(verdict?.reason || 'not_qualified').slice(0, 64) });
    },
  });
  AUTHORITIES.add(authority);
  return authority;
}

const isQualificationAuthority = (value) => AUTHORITIES.has(value);
const isBrandedQualification = (value) => RESULTS.has(value);

module.exports = { createQualificationAuthority, isQualificationAuthority, isBrandedQualification };
