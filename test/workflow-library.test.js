'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { listWorkflowLibrary } = require('../lib/workflow-library');
test('curated references have immutable public source/license pins and no connection claims', () => {
  const library = listWorkflowLibrary(); assert.equal(library.entries.length, 6);
  for (const entry of library.entries) {
    assert.equal(entry.integrationState, 'available_not_connected'); assert.equal(entry.connectionEvidence, null);
    assert.ok(entry.url.includes(entry.pinnedCommit)); assert.ok(entry.licenseUrl.includes(entry.pinnedCommit));
    assert.match(entry.contentDigest, /^[0-9a-f]{64}$/);
  }
  assert.equal(library.entries.find(entry => entry.id === 'agent-skills').license, 'CC-BY-4.0');
  library.entries[0].phases.push('changed'); assert.equal(listWorkflowLibrary().entries[0].phases.includes('changed'), false);
});
test('discovery cannot introduce executable configuration or pretend to establish a connection', () => {
  const original = listWorkflowLibrary().entries[0];
  for (const patch of [{ commands:['execute'] }, { permissions:'full' }, { tools:['shell'] },
    { integrationState:'connected', connectionEvidence:'caller said so' }, { url:'https://localhost/private' },
    { licenseUrl:'https://github.com/owner/repo/blob/main/LICENSE' }, { contentDigest:null }]) {
    assert.throws(() => listWorkflowLibrary({ catalogVersion:1, entries:[{ ...original, ...patch }] }));
  }
  assert.throws(() => listWorkflowLibrary({ catalogVersion:1, entries:[original, original] }));
});
