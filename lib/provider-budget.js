'use strict';
const { validationError } = require('./validation-contract');

const PROVIDER_BUDGET_USAGE_FIELDS = Object.freeze({
  maxOutputTokens: 'output_tokens',
  maxTotalTokens: 'total_tokens',
  maxCacheReadTokens: 'cache_read_input_tokens',
  maxCacheCreationTokens: 'cache_creation_input_tokens',
  maxTurns: 'turns',
});
const PROVIDER_BUDGET_FIELDS = Object.freeze(Object.keys(PROVIDER_BUDGET_USAGE_FIELDS));

function validateProviderBudget(value) {
  // A null budget envelope means omitted. Null fields inside an actual
  // envelope remain explicit unlimited overrides.
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError('invalid_provider_budget', 'providerBudget', 'providerBudget must be an object');
  }
  const allowed = new Set(PROVIDER_BUDGET_FIELDS);
  for (const [key, candidate] of Object.entries(value)) {
    if (!allowed.has(key)) throw validationError('invalid_provider_budget', 'providerBudget', `unknown providerBudget field: ${key.slice(0, 96)}`);
    if (candidate !== null && (!Number.isSafeInteger(candidate) || candidate <= 0)) {
      throw validationError('invalid_provider_budget', `providerBudget.${key}`, `providerBudget.${key} must be a positive safe integer or null`);
    }
  }
  return { ...value };
}

module.exports = {
  PROVIDER_BUDGET_FIELDS,
  PROVIDER_BUDGET_USAGE_FIELDS,
  validateProviderBudget,
};
