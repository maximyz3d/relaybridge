'use strict';
const catalog = require('../config/workflow-library.json');
const FIELDS = ['id','title','sourceKind','url','pinnedCommit','contentDigest','license','licenseUrl',
  'sourceVersion','verifiedAt','phases','use','localGuidance','integrationState','connectionEvidence','trustNotes'];
function pinnedUrl(value, commit) {
  try { const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password
      && !url.port && !url.search && !url.hash && url.pathname.includes(`/blob/${commit}/`);
  } catch { return false; }
}
function listWorkflowLibrary(input = catalog) {
  if (!Number.isSafeInteger(input?.catalogVersion) || input.catalogVersion < 1
    || !Array.isArray(input.entries) || input.entries.length > 24) throw new Error('Invalid workflow library catalog.');
  const ids = new Set();
  const entries = input.entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !FIELDS.includes(key))
      || !/^[a-z][a-z0-9-]{0,63}$/.test(entry.id) || ids.has(entry.id)
      || !/^[0-9a-f]{40}$/.test(entry.pinnedCommit) || !/^[0-9a-f]{64}$/.test(entry.contentDigest)
      || !pinnedUrl(entry.url, entry.pinnedCommit) || !pinnedUrl(entry.licenseUrl, entry.pinnedCommit)
      || !['MIT','Apache-2.0','CC-BY-4.0','CC-BY-SA-4.0'].includes(entry.license)
      || entry.integrationState !== 'available_not_connected' || entry.connectionEvidence !== null
      || !Array.isArray(entry.phases) || !entry.phases.length || entry.phases.length > 8
      || entry.phases.some(phase => typeof phase !== 'string' || !/^[a-z-]{1,40}$/.test(phase))
      || ['title','sourceKind','sourceVersion','verifiedAt','use','localGuidance','trustNotes'].some(key =>
        typeof entry[key] !== 'string' || !entry[key].trim() || entry[key].length > 1200)) {
      throw new Error('Workflow references require bounded metadata, immutable source/license pins, and unconnected status.');
    }
    ids.add(entry.id);
    return { ...entry, phases:[...entry.phases] };
  });
  return { catalogVersion:input.catalogVersion, entries,
    notice:'Reference discovery only. No connection, installation or upstream tool execution is performed.' };
}
module.exports = { listWorkflowLibrary };
