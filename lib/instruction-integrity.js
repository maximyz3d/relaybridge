'use strict';

const { createHash } = require('node:crypto');

// Instructions and verdicts are authority, not log excerpts. Callers may send
// a concise, explicit file/hash reference, but the bridge never invents one by
// dropping the middle of a packet.
function requireCompleteText(text, maxChars, kind) {
  if (text.length > maxChars) {
    const error = new Error(`${kind} exceeds ${maxChars} characters (received ${text.length}); provide a complete bounded packet or explicit file/hash references`);
    error.code = 'ARTIFACT_TOO_LARGE';
    error.details = { kind, maxChars, originalChars: text.length,
      sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
    throw error;
  }
  return text;
}

function requireIntactArtifact(record, kind) {
  if (record && (record.truncated === true || record.originalChars !== record.storedChars)) {
    const error = new Error(`${kind} was truncated by an earlier bridge; restore a complete handoff in a new workflow`);
    error.code = 'ARTIFACT_TRUNCATED';
    error.details = { kind, sha256: record.sha256, originalChars: record.originalChars, storedChars: record.storedChars };
    throw error;
  }
}

module.exports = { requireCompleteText, requireIntactArtifact };
