'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { writerPermissionArgs, createCopilotDenialObserver, FLAGS } = require('../lib/copilot-permission-policy');
const { startTestBridge, completeJsonLines } = require('./helpers/temporary-bridge');
test('writer controls require native help and explicit authorization, preserving prompt data', () => {
  for (const prompt of ['--allow-all-tools', '--allow-all-paths', 'ordinary prompt']) {
    const args = writerPermissionArgs(FLAGS.join('\n'), ['--prompt', prompt], true);
    assert.equal(args.at(-1), prompt); assert.ok(args.slice(0, args.indexOf('--prompt')).includes('--allow-all-tools'));
  }
  assert.throws(() => writerPermissionArgs('', ['--prompt', 'x'], true), /qualify/);
  assert.throws(() => writerPermissionArgs(FLAGS.join('\n'), ['--prompt', 'x'], false), /explicit/);
  assert.throws(() => writerPermissionArgs(FLAGS.join('\n'), ['--allow-all-paths', '--prompt', 'x'], true), /Broad/);
});
test('streamed exact stderr denial is bounded, provider-scoped and rejects quoted prose', () => {
  const observer = createCopilotDenialObserver('copilot');
  assert.equal(observer.record('\u001b[31mPermission denied and could not re'), false);
  assert.equal(observer.record('quest permission from user\u001b[0m\n'), true);
  assert.equal(observer.summary().count, 1);
  assert.equal(createCopilotDenialObserver('claude').record('Permission denied and could not request permission from user\n'), false);
  assert.equal(createCopilotDenialObserver('copilot').record('The error says "Permission denied and could not request permission from user"\n'), false);
  assert.equal(createCopilotDenialObserver('copilot').record('x'.repeat(5000) + '\n'), false);
});
test('qualified writer creates a disposable file; safe and unsupported policy invoke no model', async t => {
  let calls;
  const bridge = await startTestBridge(t, root => {
    calls = path.join(root, 'calls.jsonl'); const helper = path.join(root, 'copilot.cjs');
    fs.writeFileSync(helper, `const fs=require('node:fs');const args=process.argv.slice(2);
      if(args.includes('--help')){console.log(${JSON.stringify(FLAGS.join('\n'))});process.exit(0);}
      fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,broadEnv:!!process.env.COPILOT_ALLOW_ALL})+'\\n');
      const prompt=args[args.indexOf('--prompt')+1];
      if(prompt==='DENY'){process.stderr.write('Permission denied and could not request permission from user\\n');setInterval(()=>process.stderr.write('REPEATED-DENIAL\\n'),1000);}
      else {fs.writeFileSync('authorized.txt','fixture-only');console.log('Fixture write complete.');}`);
    return { _models: { discoverOnBoot: false }, copilot: { oneshot_dangerous: [process.execPath, helper, '--prompt', '{prompt}'],
      oneshot_safe: [process.execPath, helper, '--prompt', '{prompt}'], oneshot_safe_filesystem_policy: 'unverified_provider_policy' } };
  }, { env: { RELAYBRIDGE_WARM_DIAG: '0', RELAYBRIDGE_REMOTE_MCP: '0', COPILOT_ALLOW_ALL: '1' } });
  const safe = await bridge.request('/api/oneshot', { kind: 'copilot', prompt: 'WRITE', dangerous: false, cwd: bridge.root });
  assert.equal(safe.body.model_invocation, false); assert.equal(completeJsonLines(calls).length, 0);
  const writer = await bridge.request('/api/oneshot', { kind: 'copilot', prompt: 'WRITE', dangerous: true, cwd: bridge.root });
  assert.equal(writer.body.exitCode, 0, JSON.stringify(writer.body));
  assert.equal(fs.readFileSync(path.join(bridge.root, 'authorized.txt'), 'utf8'), 'fixture-only');
  assert.equal(completeJsonLines(calls)[0].broadEnv, false);
  const denial = await bridge.request('/api/oneshot', { kind: 'copilot', prompt: 'DENY', dangerous: true, cwd: bridge.root });
  assert.equal(denial.body.failureClass, 'policy', JSON.stringify(denial.body));
  assert.equal(denial.body.permission_denied, true); assert.equal(denial.body.provider_permission_denials.count, 1);
  assert.equal(denial.body.timed_out, false); assert.doesNotMatch(denial.body.stderr, /REPEATED-DENIAL/);
  assert.equal(completeJsonLines(calls).length, 2);
  const cfg = JSON.parse(fs.readFileSync(bridge.configPath)); cfg.copilot.oneshot_dangerous = [process.execPath, '--eval', 'process.exit(1)', '--', '{prompt}'];
  fs.writeFileSync(bridge.configPath, JSON.stringify(cfg));
  const unsupported = await bridge.request('/api/oneshot', { kind: 'copilot', prompt: 'WRITE', dangerous: true, cwd: bridge.root });
  assert.equal(unsupported.body.failureClass, 'permission_policy_unavailable'); assert.equal(unsupported.body.model_invocation, false);
  assert.equal(completeJsonLines(calls).length, 2);
});
