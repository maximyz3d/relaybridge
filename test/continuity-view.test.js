'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createSettingsState, progressCounts, assessmentLabel } = require('../public/continuity-view');
test('edits during a pending save survive the response and overlapping save is excluded', () => {
  const state = createSettingsState(); state.edit(); const first = state.beginSave();
  assert.equal(state.canHydrate, false); assert.equal(state.beginSave(), null);
  state.edit(); assert.equal(state.finishSave(first, true), true);
  assert.equal(state.dirty, true); assert.equal(state.canHydrate, false);
  const second = state.beginSave(); assert.equal(state.finishSave(first, true), false);
  state.finishSave(second, true); assert.equal(state.dirty, false); assert.equal(state.canHydrate, true);
});
test('failed saves keep unsaved values and unchanged in-flight forms cannot hydrate stale server values', () => {
  const state = createSettingsState(); const first = state.beginSave(); assert.equal(state.canHydrate, false);
  state.edit(); state.finishSave(first, false); assert.equal(state.canHydrate, false); assert.equal(state.dirty, true);
});
test('progress and stale assessment labels convey observable work without internal JSON', () => {
  assert.equal(progressCounts({ assistantUpdates: 2, toolsStarted: 1, toolsCompleted: 1, toolsFailed: 1, retries: 2 }), '2 updates · 1 tool started · 1 tool completed · 1 tool failed · 2 retries');
  assert.match(progressCounts(), /No structured progress/);
  assert.match(assessmentLabel({ state: 'assessed', stale: true, verdict: { verdict: 'stuck' } }), /stale; newer work/);
  assert.equal(assessmentLabel({ enabled: false, stale: true }), 'Progress assessment off');
  assert.match(assessmentLabel({ state: 'exhausted_until_progress' }), /waiting for new progress/);
});
