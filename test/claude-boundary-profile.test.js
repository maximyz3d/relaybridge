'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createClaudeRuntimeManifest, issueClaudeProfile, claudeLaunch, ADAPTER, EXECUTABLE } = require('../lib/claude-boundary-profile');
const { createBoundaryOwner, createClaudeBoundaryOwner } = require('../lib/linux-filesystem-boundary');
const { createConnectBroker } = require('../lib/connect-broker');
const { profileAt } = require('../tools/qualify-claude-boundary');
const linuxTest = process.platform === 'linux' && process.arch === 'x64' && fs.existsSync(EXECUTABLE) ? test : test.skip;

test('native launch is fixed, OAuth-compatible and rejects malformed/oversized prompts', () => {
  const launch = claudeLaunch('Read the fixture.');
  assert.ok(launch.args.includes('--safe-mode')); assert.ok(!launch.args.includes('--bare'));
  assert.ok(launch.args.includes('Read,Write,Edit')); assert.ok(!launch.args.includes('Bash'));
  assert.ok(launch.args.includes('--no-session-persistence'));
  for (const prompt of ['', '\0', 'x'.repeat(32769), {}]) assert.throws(() => claudeLaunch(prompt), { code: 'CLAUDE_PROFILE_PROMPT_INVALID' });
});
linuxTest('exact native manifest/profile compiles with zero provider execution and no qualification shortcut', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-claude-manifest-test-')); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = createClaudeRuntimeManifest(), profile = profileAt(root, manifest);
  fs.mkdirSync(path.join(profile.home.path, '.claude'), { mode: 0o700 });
  fs.writeFileSync(path.join(profile.home.path, '.claude/.credentials.json'), '{"fixture":"not-a-credential"}', { mode: 0o600 });
  fs.writeFileSync(path.join(profile.home.path, '.claude.json'), '{}', { mode: 0o600 });
  assert.equal(manifest.nativeQualified, false); assert.ok(manifest.hashes.length > 12);
  const changed = JSON.parse(JSON.stringify(manifest)); changed.hashes[0].sha256 = '0'.repeat(64);
  assert.throws(() => issueClaudeProfile({ profile, manifest: changed }), { code: 'CLAUDE_PROFILE_MANIFEST_MISMATCH' });
  const nativeToken = issueClaudeProfile({ profile, manifest });
  assert.throws(() => createBoundaryOwner({ profile, launch: claudeLaunch('x'), broker: {} }), { code: 'BOUNDARY_NATIVE_UNSUPPORTED' });
  assert.throws(() => createClaudeBoundaryOwner({ profile, nativeToken: { adapterId: ADAPTER }, prompt: 'x', broker: {} }), { code: 'CLAUDE_PROFILE_CAPABILITY_INVALID' });
  const broker = await createConnectBroker({ directory: path.join(root, 'broker'), policyId: 'claude_subscription_candidate_v1',
    lookup: async () => [{ address: '8.8.8.8', family: 4 }], networkInterfaces: () => ({}), connectLiteral: () => assert.fail('no upstream calls') });
  t.after(() => broker.close()); let compiled = 0;
  const owner = createClaudeBoundaryOwner({ profile, nativeToken, prompt: 'Read the fixture.', broker,
    spawnProcess(file, args, options) {
      compiled++; assert.equal(file, '/usr/bin/bwrap');
      assert.ok(args.includes('/runtime/bin/claude')); assert.ok(args.includes('--safe-mode')); assert.ok(args.includes('CLAUDE_CODE_PROXY_RESOLVES_HOSTS'));
      assert.ok(!args.includes('--share-net')); assert.ok(!args.includes('--bare')); assert.ok(!args.includes('CLAUDE_CODE_SIMPLE'));
      assert.equal(args.filter(x => x === '--as-pid-1').length, 1);
      assert.deepEqual(options.env, { PATH: '/usr/bin:/bin' }); assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe', 'pipe']);
      assert.doesNotMatch(JSON.stringify(args), /not-a-credential|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN/);
      throw new Error('TEST_BLOCKS_ALL_EXECUTION');
    } });
  await owner.start(); await assert.rejects(owner.ready);
  const physical = await owner.physicalDone;
  assert.equal(physical.evidence, 'spawn_failed'); assert.equal(compiled, 1);
  assert.equal(owner.snapshot().filesystemBoundary.nativeQualified, false);
  assert.equal(owner.snapshot().modelInvocation, false);
});
