'use strict';

const REPORTING_VALUES = new Set(['authoritative', 'unavailable']);

// Provider configuration is the source of truth for telemetry capability.
// Absence means unknown, never "probably available" and never an invitation
// to estimate tokens from output characters.
function providerUsageCapability(entry = {}, { runtimeVersion = '' } = {}) {
  const raw = entry?.usage_capability;
  if (!raw || typeof raw !== 'object') return null;
  const tokens = REPORTING_VALUES.has(raw.tokens) ? raw.tokens : 'unavailable';
  const turns = REPORTING_VALUES.has(raw.turns) ? raw.turns : 'unavailable';
  const authoritative = tokens === 'authoritative' || turns === 'authoritative';
  const verifiedRuntimeVersion = typeof raw.verified_runtime_version === 'string'
    ? raw.verified_runtime_version.slice(0, 80) : null;
  const currentRuntimeVersion = typeof runtimeVersion === 'string' && runtimeVersion.trim()
    ? runtimeVersion.trim().slice(0, 80) : null;
  return {
    authoritative,
    tokens,
    turns,
    tokenBudgetEnforceable: tokens === 'authoritative',
    turnBudgetEnforceable: turns === 'authoritative',
    budgetEnforcement: authoritative ? 'provider_reported' : 'unenforceable',
    characterEstimateFallback: false,
    verifiedRuntimeVersion,
    currentRuntimeVersion,
    evidenceCurrent: verifiedRuntimeVersion && currentRuntimeVersion
      ? verifiedRuntimeVersion === currentRuntimeVersion : null,
    evidence: typeof raw.evidence === 'string' ? raw.evidence.slice(0, 500) : '',
  };
}

function providerUsageCapabilities(config = {}, runtimeVersions = {}) {
  return Object.fromEntries(Object.entries(config)
    .filter(([kind, entry]) => !kind.startsWith('_') && entry && typeof entry === 'object')
    .map(([kind, entry]) => [kind, providerUsageCapability(entry, { runtimeVersion: runtimeVersions[kind] || '' })])
    .filter(([, capability]) => capability));
}

module.exports = { providerUsageCapability, providerUsageCapabilities };
