'use strict';

function validationError(code, field, reason, evidence = {}) {
  return Object.assign(new Error(reason), {
    code, validation: { code, field, reason, retryable: false, ...evidence },
  });
}

// The transport preserves typed diagnostics, not arbitrary exception objects.
// Workspace authority diagnostics have a separate stricter normalizer in MCP.
function normalizeGenericValidation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.code !== 'string' || !/^[a-z][a-z0-9_]{1,95}$/.test(value.code)
    || typeof value.field !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.]{0,95}$/.test(value.field)
    || typeof value.reason !== 'string' || !value.reason.trim()
    || (value.retryable !== undefined && value.retryable !== false)) return null;
  const out = { code: value.code, field: value.field,
    reason: value.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512), retryable: false };
  for (const key of ['inputChars', 'maxChars', 'originalChars', 'effectiveChars']) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) out[key] = value[key];
  }
  for (const key of ['inputHash', 'expectedFingerprint', 'observedFingerprint']) {
    if (typeof value[key] === 'string' && /^[0-9a-f]{64}$/.test(value[key])) out[key] = value[key];
  }
  if (['argument', 'file', 'stdin', 'hosted_openai_compatible', 'local_http'].includes(value.transport)) out.transport = value.transport;
  if (value.units === 'utf16_code_units') out.units = value.units;
  if (value.inputTruncated === false) out.inputTruncated = false;
  return out;
}

module.exports = { validationError, normalizeGenericValidation };
