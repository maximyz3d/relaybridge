'use strict';

const PROVIDER_BUDGET_USAGE_FIELDS = Object.freeze({
  maxOutputTokens: 'output_tokens',
  maxTotalTokens: 'total_tokens',
  maxCacheReadTokens: 'cache_read_input_tokens',
  maxCacheCreationTokens: 'cache_creation_input_tokens',
  maxTurns: 'turns',
});
const PROVIDER_BUDGET_FIELDS = Object.freeze(Object.keys(PROVIDER_BUDGET_USAGE_FIELDS));

function validateProviderBudget(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('providerBudget must be an object');
  }
  const allowed = new Set(PROVIDER_BUDGET_FIELDS);
  for (const [key, candidate] of Object.entries(value)) {
    if (!allowed.has(key)) throw new Error(`unknown providerBudget field: ${key}`);
    if (candidate !== null && (!Number.isSafeInteger(candidate) || candidate <= 0)) {
      throw new Error(`providerBudget.${key} must be a positive safe integer or null`);
    }
  }
  return { ...value };
}

const validateProviderBudgetRequest = validateProviderBudget;

module.exports = {
  PROVIDER_BUDGET_FIELDS,
  PROVIDER_BUDGET_USAGE_FIELDS,
  validateProviderBudget,
  validateProviderBudgetRequest,
};
