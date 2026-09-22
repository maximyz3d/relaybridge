'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestBridge } = require('./helpers/temporary-bridge');

// N2 (Refs #133): server.js settleFromClose used to re-run supervisor.evaluate()
// after the provider process had already exited (providerExited=true), and
// would latch any 'kill' verdict it returned into stopReason. A terminal usage
// envelope that only becomes parseable once the stream ends (a claude_json
// "result" event delivered with no trailing newline, requiring the usage
// observer's flush()) can legitimately cross the burn-without-progress streak
// at that exact moment -- but the process has already completed successfully
// by then. Only a verdict latched by latchSupervisorVerdict() while the
// process was alive (mid-stream, via proc.stdout 'data') may ever stop a run;
// a post-exit evaluate() may still record the check-in (evidence/history) but
// must never relabel a completed run as burn_without_progress / loop_confirmed.
async function fixture(t) {
  return startTestBridge(t, (root) => {
    const script = path.join(root, 'terminal-burn-provider.js');
    fs.writeFileSync(script, [
      "process.stdin.resume();process.stdin.on('end',()=>{",
      "const assistant={type:'assistant',message:{id:'m1',usage:{input_tokens:1,output_tokens:1,cache_read_input_tokens:1,cache_creation_input_tokens:0},content:[{type:'text',text:'working'}]}};",
      "const terminal={type:'result',subtype:'success',is_error:false,result:'FINAL_ANSWER',num_turns:1,usage:{input_tokens:1,output_tokens:1,cache_read_input_tokens:900000,cache_creation_input_tokens:0}};",
      "process.stdout.write(JSON.stringify(assistant)+'\\n');",
      // Delivered after the first line has already been checked in against, and
      // deliberately with NO trailing newline, so the terminal usage jump is
      // only parsed by the usage observer's flush() once the process exits.
      "setTimeout(()=>{process.stdout.write(JSON.stringify(terminal));},400);",
      "});",
    ].join('\n'));
    return {
      claude: {
        label: 'Terminal burn fixture', oneshot_output_parser: 'claude_json',
        oneshot_safe: [process.execPath, script], oneshot_dangerous: [process.execPath, script],
        oneshot_safe_filesystem_policy: 'read_only_enforced',
        supervisor: {
          checkInIntervalMs: 1, checkInTokens: 500000,
          burnCheckins: 1, burnTokens: 500000,
          loopCheckins: 100, wedgedCheckins: 100, unsampledWedgedCheckins: 100,
        },
      },
    };
  });
}

test('terminal usage that crosses the burn streak only at exit still completes as success', { timeout: 20000 }, async (t) => {
  const bridge = await fixture(t);
  const result = (await bridge.request('/api/oneshot', { kind: 'claude', prompt: 'go', dangerous: false })).body;
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(result.stdout, 'FINAL_ANSWER');
  assert.equal(result.timed_out, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.dropped_out, false);
  assert.notEqual(result.stop_reason, 'burn_without_progress');
  assert.notEqual(result.stop_reason, 'loop_confirmed');
  assert.equal(result.stop_reason, null, JSON.stringify(result));
  // The usage jump genuinely reached the supervisor (proving this is not a
  // no-op fixture): the terminal cache_read_input_tokens value is authoritative.
  assert.equal(result.usage.cache_read_input_tokens, 900000, JSON.stringify(result.usage));
});
