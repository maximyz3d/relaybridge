'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startTestBridge } = require('./helpers/temporary-bridge');

// Refs #133: stallAction:"notify" and unsampled-CPU stalls must never kill
// the run, but they must be visible as 'supervision_stall' incidents with
// check-in evidence attached.
test('a notify-only supervisor stall never kills the run and is filed as a supervision_stall incident', { timeout: 30000 }, async (t) => {
  const bridge = await startTestBridge(t, () => {
    const helper = path.join(__dirname, 'prompt-file-cli.js');
    return {
      stall_notify: {
        label: 'Stall Notify Fixture',
        safe: [process.execPath, helper, '--version'],
        dangerous: [process.execPath, helper, '--version'],
        // The supervisor polls on a fixed 5s tick (server.js executeOneShot),
        // so the fixture must stay silent across at least one tick before it
        // produces output, or the only check-in coincides with fresh bytes
        // arriving and no stall detector fires.
        oneshot_safe: [process.execPath, helper, '--prompt-file', '{prompt_file}', '--delay', '5500'],
        oneshot_dangerous: [process.execPath, helper, '--prompt-file', '{prompt_file}', '--delay', '5500'],
        supervisor: {
          stallAction: 'notify',
          checkInIntervalMs: 1000,
          noNewContentMs: 1000,
          loopCheckins: 1,
          wedgedCheckins: 1,
          unsampledWedgedCheckins: 1,
          burnCheckins: 1,
        },
      },
    };
  });

  const result = await bridge.request('/api/oneshot', {
    kind: 'stall_notify', prompt: 'stall then finish', cwd: bridge.root, dangerous: false,
  });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.exitCode, 0, 'a notify-only stall must not kill the provider process');
  assert.equal(result.body.timed_out, false);
  assert.equal(result.body.cancelled, false);
  assert.notEqual(result.body.stop_reason, 'wedged');
  assert.notEqual(result.body.stop_reason, 'loop_confirmed');
  assert.notEqual(result.body.stop_reason, 'burn_without_progress');

  const checkins = result.body.progress?.checkins || [];
  assert.ok(checkins.some((c) => c.type === 'progress_checkin'), 'progress snapshot carries at least one check-in');

  const incidentsResponse = await bridge.request('/api/incidents');
  assert.equal(incidentsResponse.status, 200);
  const stallIncidents = incidentsResponse.body.incidents.filter(
    (incident) => incident.classification === 'supervision_stall',
  );
  assert.equal(stallIncidents.length, 1, JSON.stringify(incidentsResponse.body.incidents));
  assert.ok(stallIncidents[0].runId, 'incident carries the correlated runId');
  assert.ok(stallIncidents[0].summary.length < 300, 'summary must stay bounded under 300 chars');
});
