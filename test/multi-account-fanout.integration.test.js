'use strict';

// End-to-end proof for running several accounts on one bridge: linking a second
// plan, swapping onto it, and fanning one brief across every plan at once.
//
// The fixture never launches a real vendor CLI. Each "provider" is a node script
// that records the credential directory it was handed and then blocks until the
// test releases it, so concurrency and per-account credential isolation are
// observed facts rather than inferences from the response body.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestBridge, waitFor, completeJsonLines } = require('./helpers/temporary-bridge');

// Clear inherited limits so the fixture measures shipped defaults.
const DEFAULT_ENV = Object.fromEntries(['RELAYBRIDGE_', 'PS_BRIDGE_'].flatMap((prefix) =>
  ['MAX_ACTIVE_ONESHOTS', 'MAX_ACTIVE_PER_PROVIDER', 'MAX_ACTIVE_PER_ACCOUNT', 'MAX_TASKS',
    'ONESHOT_CAPACITY_CEILING'].map((name) => [prefix + name, ''])));

// Two generic subscription seats. The account layer is provider-agnostic: all it
// needs is an env var that relocates credentials and a marker file that proves a
// sign-in. Deliberately NOT named CLAUDE_CONFIG_DIR, which would pull in
// Anthropic-specific native-identity admission that a fixture cannot satisfy.
const SEATS = {
  codex: { credentialEnv: 'CODEX_HOME', marker: 'auth.json', quotaSeat: 'subscription:chatgpt' },
  grok: { credentialEnv: 'GROK_HOME', marker: 'auth.json', quotaSeat: 'subscription:xai' },
};

async function fixture(t, env = {}) {
  let events, releaseAll;
  const cleanup = { after(fn) { t.after(async () => {
    if (releaseAll) fs.writeFileSync(releaseAll, 'release');
    await fn();
  }); } };
  const bridge = await startTestBridge(cleanup, (root) => {
    events = path.join(root, 'events.jsonl'); releaseAll = path.join(root, 'release-all');
    const script = path.join(root, 'recording-provider.cjs');
    fs.writeFileSync(script, [
      "const fs=require('node:fs'),path=require('node:path');",
      "const [kind,root,credentialEnv]=process.argv.slice(2);let raw='';",
      "process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>raw+=chunk);",
      "process.stdin.on('end',()=>{",
      "const id=(raw.match(/RB_CASE_[A-Za-z0-9_]+/)||['RB_CASE_unknown'])[0];",
      // An implicit account injects no env at all: that absence is the signal
      // that the operator's own sign-in was used.
      "const credentialDir=process.env[credentialEnv]||'implicit';",
      "const event=name=>fs.appendFileSync(path.join(root,'events.jsonl'),",
      "  JSON.stringify({id,kind,event:name,credentialDir,pid:process.pid})+'\\n');",
      "event('started');",
      "const timer=setInterval(()=>{",
      "  if(fs.existsSync(path.join(root,'release-all'))||fs.existsSync(path.join(root,id))){",
      "    clearInterval(timer);event('finished');",
      "    process.stdout.write('done '+id+' on '+credentialDir);}",
      "},10);});",
    ].join('\n'));
    return Object.fromEntries(Object.entries(SEATS).map(([kind, seat]) => [kind, {
      label: kind, tags: ['fanout'], safe: [process.execPath],
      probe: [process.execPath, '--version'], version_probe: [process.execPath, '--version'],
      credential_env: seat.credentialEnv,
      credential_markers: [seat.marker],
      login_command: [kind, 'login'],
      quota_seat: seat.quotaSeat,
      oneshot_safe: [process.execPath, script, kind, root, seat.credentialEnv],
      oneshot_safe_filesystem_policy: 'read_only_enforced',
      oneshot_capabilities: { safe: ['model_invocation', 'workspace_read', 'tool_use'] },
    }]));
  }, { env: { ...DEFAULT_ENV, ...env } });

  const all = () => completeJsonLines(events);
  const started = () => all().filter((event) => event.event === 'started');
  // Sign an account in the only way the bridge measures: a non-empty credential
  // marker in the directory it owns.
  const signIn = async (kind, id) => {
    const linked = await bridge.request(`/api/accounts/${kind}`, { id, label: `${kind} ${id}` });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    fs.writeFileSync(path.join(linked.body.credentialDir, SEATS[kind].marker), '{"token":"fixture"}');
    return linked.body;
  };
  const releaseEverything = () => fs.writeFileSync(releaseAll, 'release');
  return { ...bridge, all, started, signIn, releaseEverything };
}

test('linking a plan returns its exact sign-in command and keeps the existing login addressable',
  { timeout: 30000 }, async (t) => {
    const bridge = await fixture(t);
    const linked = await bridge.signIn('codex', 'work');
    // Every element is shell-quoted separately, so a path with a space in it is
    // still one runnable command the operator can paste.
    assert.match(linked.signInCommand, /^CODEX_HOME='.*accounts\/codex\/work' 'codex' 'login'$/,
      'the operator needs the exact command, not a description of one');
    assert.equal(linked.signIn.environment.CODEX_HOME, linked.credentialDir);

    const accounts = (await bridge.request('/api/accounts')).body;
    assert.equal(accounts.providers.codex.supportsMultipleAccounts, true);
    assert.deepEqual(accounts.providers.codex.accounts.map((a) => a.id), ['default', 'work']);
    const work = accounts.providers.codex.accounts.find((a) => a.id === 'work');
    assert.equal(work.provisioned, true);
    assert.equal(work.implicit, false);
    // Separate allowances, or the gauges would pool two plans into one bar.
    assert.equal(work.quotaSeat, 'subscription:chatgpt#work');
    assert.equal(accounts.providers.codex.accounts.find((a) => a.id === 'default').quotaSeat,
      'subscription:chatgpt', 'the existing seat identity must not move');
    // One linked plan widens the fleet by one account-worth of slots.
    assert.equal(accounts.capacity.configuredFleet, 8);
    assert.equal(accounts.capacity.linkedAccountCount, 1);
    assert.equal(accounts.capacity.fleet, 12);
    assert.equal(accounts.providers.codex.maxActiveForProvider, 8, 'two usable plans, four slots each');
  });

test('a swap moves both which AI and which plan unqualified work runs on',
  { timeout: 30000 }, async (t) => {
    const bridge = await fixture(t);
    await bridge.signIn('codex', 'work');

    const before = (await bridge.request('/api/accounts/active')).body;
    assert.equal(before.activeProvider, null);
    assert.equal(before.seats.codex.selection, 'automatic');

    const swap = (await bridge.request('/api/accounts/swap', { kind: 'codex', accountId: 'work' })).body;
    assert.equal(swap.ok, true);
    assert.equal(swap.activeProvider, 'codex');
    assert.equal(swap.accountId, 'work');
    assert.equal(swap.readiness.dispatchable, true);
    assert.equal(swap.readiness.pinHonored, true);
    assert.equal(swap.readiness.quotaSeat, 'subscription:chatgpt#work');

    const active = (await bridge.request('/api/accounts/active')).body;
    assert.equal(active.activeProvider, 'codex');
    assert.deepEqual(active.unqualifiedWorkRunsOn, { kind: 'codex', accountId: 'work' });
    assert.equal(active.seats.codex.selection, 'pinned');

    // A request that names no provider must now land on the swapped-to plan.
    const call = bridge.request('/api/oneshot', { prompt: 'Report for RB_CASE_pinned.', cwd: bridge.root, dangerous: false });
    const run = await waitFor(() => bridge.started().find((event) => event.id === 'RB_CASE_pinned'));
    assert.equal(run.kind, 'codex');
    assert.match(run.credentialDir, /accounts[\\/]codex[\\/]work$/,
      'the child must have been handed the pinned account credential directory');
    bridge.releaseEverything();
    const response = await call;
    assert.equal(response.status, 200);
    assert.equal(response.body.route.account, 'work');
    assert.equal(response.body.route.quota_seat, 'subscription:chatgpt#work');
  });

test('swapping to another AI redirects unqualified work without losing the first pin',
  { timeout: 30000 }, async (t) => {
    const bridge = await fixture(t);
    await bridge.signIn('codex', 'work');
    await bridge.request('/api/accounts/swap', { kind: 'codex', accountId: 'work' });
    const swap = (await bridge.request('/api/accounts/swap', { kind: 'grok' })).body;
    assert.equal(swap.activeProvider, 'grok');

    const call = bridge.request('/api/oneshot', { prompt: 'Report for RB_CASE_crossai.', cwd: bridge.root, dangerous: false });
    const run = await waitFor(() => bridge.started().find((event) => event.id === 'RB_CASE_crossai'));
    assert.equal(run.kind, 'grok', 'a cross-AI swap must move unqualified work to the other vendor');
    bridge.releaseEverything();
    await call;

    const active = (await bridge.request('/api/accounts/active')).body;
    assert.equal(active.seats.codex.activeAccountId, 'work', 'the Codex pin survives an AI swap');
  });

test('naming a provider explicitly always beats the pin', { timeout: 30000 }, async (t) => {
  const bridge = await fixture(t);
  await bridge.request('/api/accounts/swap', { kind: 'grok' });
  const call = bridge.request('/api/oneshot', { kind: 'codex', prompt: 'Report for RB_CASE_explicit.', cwd: bridge.root, dangerous: false });
  const run = await waitFor(() => bridge.started().find((event) => event.id === 'RB_CASE_explicit'));
  assert.equal(run.kind, 'codex');
  bridge.releaseEverything();
  await call;
});

test('a swap onto a plan that was never signed in is durable but honestly reported',
  { timeout: 30000 }, async (t) => {
    const bridge = await fixture(t);
    // Linked but deliberately not signed in: no credential marker is written.
    const linked = await bridge.request('/api/accounts/codex', { id: 'unsigned', label: 'not yet' });
    assert.equal(linked.status, 200);
    const swap = (await bridge.request('/api/accounts/swap', { kind: 'codex', accountId: 'unsigned' })).body;
    assert.equal(swap.accountId, 'unsigned', 'the pin is stored so it takes effect after sign-in');
    assert.equal(swap.readiness.pinHonored, false);
    assert.equal(swap.readiness.willRunOnAccountId, 'default');
    assert.match(swap.note, /cannot take work right now/);

    // Dispatch falls back rather than failing.
    const call = bridge.request('/api/oneshot', { prompt: 'Report for RB_CASE_fallback.', cwd: bridge.root, dangerous: false });
    const run = await waitFor(() => bridge.started().find((event) => event.id === 'RB_CASE_fallback'));
    assert.equal(run.credentialDir, 'implicit', 'fell back to the operator existing sign-in');
    bridge.releaseEverything();
    assert.equal((await call).status, 200);
  });

test('swapping onto an unknown plan is refused and changes nothing', { timeout: 30000 }, async (t) => {
  const bridge = await fixture(t);
  const refused = await bridge.request('/api/accounts/swap', { kind: 'codex', accountId: 'ghost' });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /unknown account/);
  assert.equal((await bridge.request('/api/accounts/active')).body.activeProvider, null);
  const unknownField = await bridge.request('/api/accounts/swap', { kind: 'codex', nope: 1 });
  assert.equal(unknownField.status, 400);
  assert.match(unknownField.body.error, /unknown field/);
});

test('three plans on one provider run six agents at once, each on its own credentials',
  { timeout: 60000 }, async (t) => {
    const bridge = await fixture(t);
    await bridge.signIn('codex', 'work');
    await bridge.signIn('codex', 'personal');

    // Two replicas across three accounts is six concurrent Claude processes.
    // The old per-provider cap of four could not have started more than four,
    // which is exactly what made linked accounts unusable in parallel.
    const fanout = bridge.request('/api/fanout', {
      prompt: 'Report for RB_CASE_wide.', providers: ['codex'], accounts: 'all', replicas: 2, cwd: bridge.root,
    });
    const runs = await waitFor(() => {
      const started = bridge.started().filter((event) => event.kind === 'codex');
      return started.length >= 6 ? started : null;
    }, 30000);
    assert.equal(runs.length, 6, 'every member of the fan-out must be in flight together');
    const dirs = new Map();
    for (const run of runs) dirs.set(run.credentialDir, (dirs.get(run.credentialDir) || 0) + 1);
    assert.equal(dirs.size, 3, 'one distinct credential directory per linked plan');
    for (const [dir, count] of dirs) assert.equal(count, 2, `two replicas on ${dir}`);
    assert.equal(dirs.get('implicit'), 2, 'the existing sign-in is one of the three plans');

    const health = (await bridge.request('/api/health')).body;
    assert.equal(health.activeOneShotCount, 6);
    assert.equal(health.maxActivePerAccount, 4);
    assert.equal(health.linkedAccountCount, 2);
    assert.equal(health.maxActiveOneShots, 16, 'two linked plans widen the fleet from eight to sixteen');
    assert.equal(Object.keys(health.activeOneShotsByAccount).length, 3);

    bridge.releaseEverything();
    const response = await fanout;
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 400));
    assert.equal(response.body.status, 'completed');
    assert.equal(response.body.expansion.members, 6);
    assert.equal(response.body.expansion.accounts, 3);
    assert.equal(response.body.results.length, 6);
    assert.equal(response.body.results.every((member) => member.ok), true);
    assert.deepEqual([...new Set(response.body.results.map((m) => m.accountId))].sort(),
      ['default', 'personal', 'work']);
    assert.deepEqual(response.body.seatsUsed.sort(),
      ['codex#default', 'codex#personal', 'codex#work']);
  });

test('a fan-out multiplies across AIs, accounts and per-branch assignments together',
  { timeout: 60000 }, async (t) => {
    const bridge = await fixture(t);
    await bridge.signIn('codex', 'work');
    await bridge.signIn('grok', 'second');

    // 2 providers x 2 accounts each x 2 assignments = 8 agents.
    const fanout = bridge.request('/api/fanout', {
      prompt: 'Report for RB_CASE_matrix.', all: true, accounts: 'all', cwd: bridge.root,
      variants: ['Cover the read path.', 'Cover the write path.'],
    });
    const runs = await waitFor(() => {
      const started = bridge.started();
      return started.length >= 8 ? started : null;
    }, 30000);
    assert.equal(runs.length, 8);
    assert.deepEqual([...new Set(runs.map((r) => r.kind))].sort(), ['codex', 'grok']);
    assert.equal(new Set(runs.map((r) => `${r.kind}:${r.credentialDir}`)).size, 4,
      'four distinct plans across two vendors');

    bridge.releaseEverything();
    const response = await fanout;
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 400));
    assert.equal(response.body.expansion.members, 8);
    assert.equal(response.body.expansion.variants, 2);
    assert.equal(response.body.expansion.providers, 2);
    assert.equal(response.body.seatsUsed.length, 4);
    // Each branch carries its own assignment, so the agents are not duplicates.
    const assignments = new Set(response.body.results.map((member) => member.assignment));
    assert.deepEqual([...assignments].sort(), ['Cover the read path.', 'Cover the write path.']);
    // The shared brief reaches every branch, and each output names the plan it ran on.
    assert.equal(response.body.results.filter((m) => m.output.includes('RB_CASE_matrix')).length, 8);
  });

test("accounts:'active' fans out only onto the plan the operator swapped to",
  { timeout: 40000 }, async (t) => {
    const bridge = await fixture(t);
    await bridge.signIn('codex', 'work');
    await bridge.signIn('codex', 'personal');
    await bridge.request('/api/accounts/swap', { kind: 'codex', accountId: 'personal' });

    const fanout = bridge.request('/api/fanout', {
      prompt: 'Report for RB_CASE_activeonly.', providers: ['codex'], accounts: 'active',
      replicas: 2, cwd: bridge.root,
    });
    const runs = await waitFor(() => {
      const started = bridge.started();
      return started.length >= 2 ? started : null;
    }, 20000);
    assert.equal(runs.length, 2);
    assert.equal(new Set(runs.map((r) => r.credentialDir)).size, 1);
    assert.match(runs[0].credentialDir, /accounts[\\/]codex[\\/]personal$/);
    bridge.releaseEverything();
    const response = await fanout;
    assert.deepEqual(response.body.seatsUsed, ['codex#personal']);
  });

test('a fan-out naming explicit accounts reports the ones it had to skip',
  { timeout: 40000 }, async (t) => {
    const bridge = await fixture(t);
    await bridge.signIn('codex', 'work');
    await bridge.request('/api/accounts/codex', { id: 'unsigned', label: 'not yet' });

    const fanout = bridge.request('/api/fanout', {
      prompt: 'Report for RB_CASE_skip.', providers: ['codex'],
      accounts: { codex: ['work', 'unsigned', 'ghost'] }, cwd: bridge.root,
    });
    await waitFor(() => bridge.started().find((event) => event.id === 'RB_CASE_skip'), 20000);
    bridge.releaseEverything();
    const response = await fanout;
    assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 400));
    assert.equal(response.body.expansion.members, 1);
    assert.deepEqual(response.body.seatsUsed, ['codex#work']);
    const skipped = Object.fromEntries(response.body.skipped.map((row) => [row.accountId, row.reason]));
    assert.match(skipped.unsigned, /never signed in/);
    assert.match(skipped.ghost, /unknown account/);
  });

test('fan-out refuses to write and refuses to start an unbounded fleet',
  { timeout: 30000 }, async (t) => {
    const bridge = await fixture(t);
    const dangerous = await bridge.request('/api/fanout', {
      prompt: 'write something', providers: ['codex'], dangerous: true, cwd: bridge.root,
    });
    assert.equal(dangerous.status, 400);
    assert.match(dangerous.body.error, /read-only/);

    for (const body of [
      { replicas: 0 }, { replicas: 9 }, { replicas: 1.5 },
      { accounts: 'sometimes' }, { variants: [] , replicas: 1 },
    ]) {
      const rejected = await bridge.request('/api/fanout',
        { prompt: 'Report for RB_CASE_bad.', providers: ['codex'], cwd: bridge.root, ...body });
      assert.equal(rejected.status, 400, JSON.stringify({ body, got: rejected.body }));
    }
    // 2 providers x 1 account x 16 variants x 8 replicas is 256 agents.
    const tooWide = await bridge.request('/api/fanout', {
      prompt: 'Report for RB_CASE_wide2.', all: true, replicas: 8, cwd: bridge.root,
      variants: Array.from({ length: 16 }, (_unused, index) => `branch ${index}`),
    });
    assert.equal(tooWide.status, 400);
    assert.match(tooWide.body.error, /the ceiling is 64/);
  });

test('a fan-out with no selection falls back to the swapped-to seat', { timeout: 40000 }, async (t) => {
  const bridge = await fixture(t);
  await bridge.signIn('grok', 'second');
  await bridge.request('/api/accounts/swap', { kind: 'grok', accountId: 'second' });
  const fanout = bridge.request('/api/fanout', { prompt: 'Report for RB_CASE_default.', cwd: bridge.root });
  const run = await waitFor(() => bridge.started().find((event) => event.id === 'RB_CASE_default'), 20000);
  assert.equal(run.kind, 'grok');
  bridge.releaseEverything();
  const response = await fanout;
  assert.deepEqual(response.body.targets, ['grok']);
});

test('disabling a plan removes it from both the pin and every fan-out', { timeout: 40000 }, async (t) => {
  const bridge = await fixture(t);
  await bridge.signIn('codex', 'work');
  await bridge.request('/api/accounts/swap', { kind: 'codex', accountId: 'work' });
  const disabled = await bridge.request('/api/accounts/codex/work/enabled', { enabled: false });
  assert.equal(disabled.status, 200);

  const active = (await bridge.request('/api/accounts/active')).body;
  assert.equal(active.seats.codex.activeAccountId, null, 'a disabled plan cannot stay pinned');
  assert.equal(active.activeProvider, 'codex', 'the provider pin is still valid');

  const fanout = bridge.request('/api/fanout', {
    prompt: 'Report for RB_CASE_disabled.', providers: ['codex'], accounts: 'all', cwd: bridge.root,
  });
  await waitFor(() => bridge.started().find((event) => event.id === 'RB_CASE_disabled'), 20000);
  bridge.releaseEverything();
  const response = await fanout;
  assert.deepEqual(response.body.seatsUsed, ['codex#default']);
  assert.match(response.body.skipped.find((row) => row.accountId === 'work').reason, /disabled/);
});
