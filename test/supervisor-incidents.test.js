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
        // The supervisor polls on a fixed 5s tick (server.js ~5555-5576), but
        // each tick's verdict is only applied in applyVerdict(), which runs
        // in sampleProcessCensus().finally() -- so the tick's effective time
        // is "5s plus however long the process census takes". On Windows
        // that census can take 1-3s, so a fixture silent for only one tick
        // (5500ms) can have its output already parsed by the time the census
        // resolves, and no stall detector fires (Refs #133, Round 7 G8).
        // Staying silent across two ticks (10s) plus census-latency margin
        // guarantees at least one fully-silent check-in regardless of census
        // speed. Dedup (server.js:5510-5522, stallIncidentReported) ensures
        // this still files exactly one supervision_stall incident even if
        // more than one silent check-in occurs before output arrives.
        oneshot_safe: [process.execPath, helper, '--prompt-file', '{prompt_file}', '--delay', '14000'],
        oneshot_dangerous: [process.execPath, helper, '--prompt-file', '{prompt_file}', '--delay', '14000'],
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
  // server.js:5510-5527 tracks two independent dedupe flags: stallIncidentReported
  // (snap.stall, summary prefix "stallAction notify:") and
  // unsampledStallIncidentReported (snap.unsampledStall, summary prefix
  // "unsampled CPU silence"). Each fires at most once per run, but both can
  // legitimately fire in the same run -- e.g. when a 14s-silent fixture hits
  // a tick whose census is still in flight or fails (recordCpuSample(null)),
  // producing an unsampledStall on top of a stall. So the correct assertion
  // is "at least one incident, and every incident is one of the two known
  // kinds, each appearing at most once" -- not an exact count of 1.
  assert.ok(stallIncidents.length >= 1, JSON.stringify(incidentsResponse.body.incidents));
  const notifyStalls = stallIncidents.filter((i) => i.summary.startsWith('stallAction notify:'));
  const unsampledStalls = stallIncidents.filter((i) => i.summary.startsWith('unsampled CPU silence'));
  assert.ok(notifyStalls.length <= 1, 'at most one stallAction notify incident per run');
  assert.ok(unsampledStalls.length <= 1, 'at most one unsampled CPU silence incident per run');
  assert.equal(
    notifyStalls.length + unsampledStalls.length,
    stallIncidents.length,
    'every supervision_stall incident must be one of the two known kinds',
  );
  const runIds = new Set(stallIncidents.map((incident) => incident.runId));
  assert.equal(runIds.size, 1, 'all stall incidents must correlate to the same run');
  for (const incident of stallIncidents) {
    assert.ok(incident.runId, 'incident carries the correlated runId');
    assert.ok(incident.summary.length < 300, 'summary must stay bounded under 300 chars');
  }
});
