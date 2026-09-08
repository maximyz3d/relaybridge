'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compileOutputProfile, listOutputProfiles, resolveOutputProfile } = require('../lib/output-profiles');

test('unprofiled prompts remain ordinary text with byte-identical behavior', () => {
  for (const prompt of ['', '  keep whitespace\r\n', '[RelayBridge output guidance: user-authored]\nraw']) {
    assert.equal(compileOutputProfile(prompt).prompt, prompt);
    assert.equal(compileOutputProfile(prompt, null).profile, null);
  }
});
test('chosen guidance records immutable identity and preserves the original request first', () => {
  for (const profile of listOutputProfiles().profiles) {
    const selection = { id:profile.id, version:profile.version };
    const prompt = 'Do not modify files. Explain the observed failure.';
    const compiled = compileOutputProfile(prompt, selection);
    assert.ok(compiled.prompt.startsWith(prompt + '\n\n'));
    assert.equal(compiled.profile.digest, profile.digest);
    assert.ok(compiled.prompt.includes(`catalog:${profile.catalogVersion};`));
    assert.ok(compiled.prompt.includes(profile.text));
    assert.deepEqual(compileOutputProfile(prompt, selection), compiled);
    assert.equal(Object.isFrozen(compiled.profile), true);
  }
});
test('catalog discovery rejects malformed envelopes and null entries consistently', () => {
  for (const catalog of [{ profiles:[] }, { catalogVersion:0, profiles:[] }, { catalogVersion:1, profiles:[null] }]) {
    assert.throws(() => listOutputProfiles(catalog), { code:'invalid_output_profile' });
  }
});
test('unknown versions, changed preview digests and authority-bearing schema fields reject', () => {
  for (const selection of [{ id:'missing', version:1 }, { id:'code-debug', version:999 },
    { id:'code-debug', version:1, digest:'0'.repeat(64) }, { id:'code-debug', version:1, dangerous:true },
    'code-debug', false, { id:'code-debug', version:'1' }]) {
    assert.throws(() => compileOutputProfile('Task', selection), { code:'invalid_output_profile' });
  }
  const item = { id:'fixture', version:1, title:'Fixture', description:'A fixture', text:'Keep the result concise.' };
  for (const changed of [{ ...item, commands:['run something'] }, { ...item, text:'x'.repeat(4001) }, { ...item, text:'bad\0data' }]) {
    assert.throws(() => resolveOutputProfile({ id:'fixture', version:1 }, { catalogVersion:1, profiles:[changed] }));
  }
});
test('catalog changes affect new compilation and cannot mutate already compiled queued text', () => {
  const catalog = { catalogVersion:1, profiles:[{ id:'fixture', version:1, title:'Fixture', description:'Fixture', text:'Criteria A.' }] };
  const first = compileOutputProfile('Original', { id:'fixture', version:1 }, catalog);
  catalog.profiles[0].text = 'Criteria B.';
  const second = compileOutputProfile('Original', { id:'fixture', version:1 }, catalog);
  assert.notEqual(first.profile.digest, second.profile.digest);
  assert.match(first.prompt, /Criteria A/); assert.doesNotMatch(first.prompt, /Criteria B/);
  assert.throws(() => compileOutputProfile('Original', { id:'fixture', version:1, digest:first.profile.digest }, catalog));
});
