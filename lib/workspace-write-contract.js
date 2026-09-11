'use strict';

const { normalizeAllowedWritePaths } = require('./candidate-stage');
const { validationError } = require('./validation-contract');

// Never silently treat a caller's declared write boundary as prompt guidance.
// Candidate staging is implemented separately; native process-wide filesystem,
// network and ownership qualification must precede enabling execution here.
function validateWorkspaceWriteContract(body) {
  if (!Object.prototype.hasOwnProperty.call(body || {}, 'allowedWritePaths')) return null;
  try { normalizeAllowedWritePaths(body.allowedWritePaths); }
  catch { throw validationError('invalid_write_contract', 'allowedWritePaths',
    'Use at most 128 unique exact repository-relative files. Aliases, globs, control paths and special files are unsupported.'); }
  throw validationError('filesystem_contract_unsupported', 'allowedWritePaths',
    'This installation has no qualified native write-set executor. No provider was started and the declared boundary was not discarded.');
}
module.exports = { validateWorkspaceWriteContract };
