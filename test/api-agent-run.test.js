'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createCheckpointStore } = require('../lib/api-agent-checkpoint');
const { driveApiAgentRun, linkedSeed } = require('../lib/api-agent-run');
const { ENDPOINTS, WIRES, resolveApiModel } = require('../lib/api-agent-wire');
const { createReadOnlyTools, TOOL_DEFINITIONS } = require('../lib/api-agent-tools');
const { startFakeProvider, reply, claudeMessage, openaiResponse } = require('./helpers/fake-provider-api');
const { isolatedEnv } = require('./helpers/isolated-env');

const KEY = 'sk-test-runner-credential-0123456789';
const PROVIDERS = ['claude', 'openai'];
const MODELS = { claude: () => resolveApiModel('claude', 'claude-opus-5-5', 'medium'), openai: () => resolveApiModel('openai', 'gpt-6.1-sol', 'low') };
const READ = (p) => ({ name: 'read_file', input: { path: p, offset: null, length: null } });
const LIST = (p = null) => ({ name: 'list_dir', input: { path: p } });
const SEARCH = (q) => ({ name: 'search', input: { query: q, path: null } });

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function setup(t, provider, script) {
  const respond = typeof script === 'function' ? script : (req) => {
    const step = script[Math.min(req.index, script.length) - 1];
    return typeof step === 'function' ? step(req) : step;
  };
  const fake = await startFakeProvider(t, { provider, respond });
  const base = tmp(t, 'rb-run-');
  const cwd = path.join(base, 'ws'); fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'README.md'), 'project readme needle\n');
  fs.writeFileSync(path.join(cwd, 'src', 'main.js'), `// needle\nconst key = '${KEY}';\n`);
  const store = createCheckpointStore({ dataDir: path.join(base, 'data') });
  const model = MODELS[provider]();
  const tools = createReadOnlyTools({ cwd });
  const create = (state = WIRES[provider].initialState({ prompt: 'inspect the project', system: 'be brief' }), extra = {}) =>
    store.create(store.newRunId(), { binding: {}, initial: { state }, supersedes: null, ...extra });
  const drive = (handle, extra = {}) => driveApiAgentRun({ handle, provider, model, tools, fetchImpl: fake.fetchImpl,
    endpoint: ENDPOINTS[provider], credential: KEY, headerContext: provider === 'openai' ? { organization: 'org_x', project: 'proj_x' } : {}, ...extra });
  const resume = (runId, extra) => { const h = store.acquire(runId); return drive(h, extra).finally(() => h.release()); };
  return { fake, store, cwd, model, tools, create, drive, resume, base };
}

const ok = (provider, spec) => ({ status: 200, json: reply(provider, spec) });
const err = (status, json) => ({ status, json });

function dirDigest(dir) {
  const h = crypto.createHash('sha256');
  for (const name of fs.readdirSync(dir).sort()) h.update(name).update(fs.readFileSync(path.join(dir, name)));
  return h.digest('hex');
}

for (const provider of PROVIDERS) {
  test(`${provider}: multistep read-only tool loop completes and replays reasoning verbatim`, async (t) => {
    const env = await setup(t, provider, [
      ok(provider, { text: 'looking', tools: [LIST()], thinking: true, reasoning: true }),
      ok(provider, { tools: [READ('README.md'), READ('.env')] }),
      ok(provider, { tools: [SEARCH('needle')] }),
      ok(provider, { text: 'all done' }),
    ]);
    const h = env.create();
    const turns = [];
    const result = await env.drive(h, { onTurn: (turn) => turns.push(turn) });
    h.release();
    assert.equal(result.status, 'terminal'); assert.equal(result.outcome.class, 'completed');
    assert.equal(result.text, 'all done'); assert.equal(result.requestsThisAttempt, 4);
    assert.equal(env.fake.requests.length, 4); assert.equal(turns.length, 4);
    assert.equal(result.totalUsage.output_tokens, 40);
    assert.deepEqual(result.observedModels, [provider === 'claude' ? 'claude-opus-5-5' : 'gpt-6.1-sol']);
    const [r1, r2, r3, r4] = env.fake.requests;
    if (provider === 'claude') {
      assert.equal(r1.headers['x-api-key'], KEY); assert.equal(r1.headers['anthropic-version'], '2023-06-01');
      assert.equal(r1.body.max_tokens, 128000); assert.equal(r1.body.system, 'be brief');
      assert.deepEqual(r1.body.output_config, { effort: 'medium' }); assert.equal(r1.body.model, 'claude-opus-5-5');
      assert.equal(r2.body.messages[1].content[0].signature, 'sig-opaque-1');
      const results = r3.body.messages[4].content;
      assert.equal(results.length, 2); assert.match(results[0].content, /project readme needle/);
      assert.equal(results[1].is_error, true); assert.match(results[1].content, /path_denied/);
      assert.equal(r4.body.messages.length, 7);
    } else {
      assert.equal(r1.headers.authorization, `Bearer ${KEY}`);
      assert.equal(r1.headers['openai-organization'], 'org_x'); assert.equal(r1.headers['openai-project'], 'proj_x');
      assert.deepEqual(r1.body.reasoning, { effort: 'low' }); assert.equal(r1.body.store, false); assert.equal(r1.body.model, 'gpt-6.1-sol');
      assert.ok(r2.body.input.some((i) => i.type === 'reasoning' && i.encrypted_content === 'enc-opaque-1'));
      const outputs = r3.body.input.filter((i) => i.type === 'function_call_output');
      assert.equal(outputs.length, 3); assert.match(outputs[1].output, /project readme needle/); assert.match(outputs[2].output, /path_denied/);
    }
    // Search results that contained the key were redacted before reaching the provider or the checkpoint.
    assert.ok(!JSON.stringify(r4.body).includes(KEY));
    for (const name of fs.readdirSync(h.dir)) assert.ok(!fs.readFileSync(path.join(h.dir, name), 'utf8').includes(KEY), name);
  });

  test(`${provider}: a long productive run is not capped by turns`, async (t) => {
    const TURNS = 41;
    const env = await setup(t, provider, (req) => ok(provider, req.index < TURNS ? { tools: [READ('README.md')] } : { text: 'finished' }));
    const h = env.create();
    const result = await env.drive(h);
    h.release();
    assert.equal(result.outcome.class, 'completed'); assert.equal(result.requestsThisAttempt, TURNS);
    assert.equal(result.turns.length, TURNS);
  });

  test(`${provider}: output limit, refusal and protocol errors are terminal and never execute partial calls`, async (t) => {
    for (const [spec, cls] of [[{ limit: true, tools: [READ('README.md')] }, 'output_limit_reached'],
      [provider === 'claude' ? { text: 'x', stop: 'refusal' } : { refusal: true }, 'refusal']]) {
      const env = await setup(t, provider, [ok(provider, spec)]);
      const h = env.create();
      const result = await env.drive(h);
      h.release();
      assert.equal(result.status, 'terminal'); assert.equal(result.outcome.class, cls);
      assert.equal(env.fake.requests.length, 1);
      assert.equal(env.store.load(h.runId).tools.size, 0);
      assert.equal(result.text, '');
    }
    const env = await setup(t, provider, [{ status: 200, raw: 'not json' }]);
    const h = env.create();
    assert.equal((await env.drive(h)).outcome.class, 'provider_protocol_error');
  });

  test(`${provider}: a mismatched response model stops the run and the turn stays billed`, async (t) => {
    const env = await setup(t, provider, [ok(provider, { tools: [READ('README.md')], model: provider === 'claude' ? 'claude-sonnet-5-5' : 'gpt-6-astra' })]);
    const h = env.create();
    const result = await env.drive(h);
    assert.equal(result.outcome.class, 'api_model_mismatch'); assert.equal(result.status, 'terminal');
    assert.equal(result.turns[0].state, 'received'); assert.equal(result.totalUsage.output_tokens, 10);
    assert.equal(env.store.load(h.runId).tools.size, 0);
  });

  test(`${provider}: generic 429 sends nothing further and resumes the same conversation`, async (t) => {
    const env = await setup(t, provider, [ok(provider, { tools: [READ('README.md')] }), err(429, { error: { type: 'rate_limit_error', message: 'slow down' } }),
      ok(provider, { text: 'resumed' })]);
    const h = env.create();
    const first = await env.drive(h, { qualificationActive: true });
    h.release();
    assert.equal(first.status, 'resumable'); assert.equal(first.outcome.class, 'rate_limited');
    assert.equal(first.reserveReleaseEvidence, false); assert.equal(env.fake.requests.length, 2);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(env.fake.requests.length, 2);
    const second = await env.resume(h.runId);
    assert.equal(second.outcome.class, 'completed'); assert.equal(second.requestsThisAttempt, 1);
    assert.deepEqual(env.fake.requests[2].body, env.fake.requests[1].body);
    const again = await env.resume(h.runId);
    assert.equal(again.requestsThisAttempt, 0); assert.equal(again.text, 'resumed'); assert.equal(env.fake.requests.length, 3);
  });

  test(`${provider}: each provider error maps to its class with no fallback`, async (t) => {
    const cases = provider === 'openai' ? [
      [429, { error: { code: 'credit_balance_exhausted', message: 'out' } }, 'funding_exhausted', 'terminal'],
      [429, { error: { code: 'insufficient_quota' } }, 'funding_ambiguous', 'terminal'],
      [429, { error: { code: 'project_spend_limit_exceeded' } }, 'spend_limit', 'terminal'],
      [503, null, 'provider_unavailable', 'resumable'], [401, null, 'auth', 'terminal'], [403, null, 'permission', 'terminal'],
      [400, { error: { message: 'bad' } }, 'provider_request_rejected', 'terminal'],
    ] : [
      [400, { error: { message: 'Your credit balance is too low to access the Anthropic API.' } }, 'account_credit_low', 'terminal'],
      [429, { error: { type: 'rate_limit_error', details: { error_code: 'enforced_spend_limit_reached' } } }, 'spend_limit', 'terminal'],
      [400, { error: { message: 'You have reached your specified API usage limits.' } }, 'spend_limit', 'terminal'],
      [529, { error: { type: 'overloaded_error' } }, 'provider_unavailable', 'resumable'], [500, null, 'provider_unavailable', 'resumable'],
      [401, null, 'auth', 'terminal'], [403, null, 'permission', 'terminal'],
      // An unrecognized Claude 400 is terminal and never a funding signal.
      [400, { error: { type: 'invalid_request_error', message: 'bad' } }, 'provider_request_rejected', 'terminal'],
    ];
    for (const [status, body, cls, state] of cases) {
      const env = await setup(t, provider, [err(status, body)]);
      const h = env.create();
      const result = await env.drive(h, { qualificationActive: true });
      h.release();
      assert.equal(result.outcome.class, cls, `${status} ${JSON.stringify(body)}`); assert.equal(result.status, state);
      assert.equal(env.fake.requests.length, 1);
      assert.equal(result.reserveReleaseEvidence, cls === 'funding_exhausted');
      assert.equal(result.text, '');
    }
    if (provider === 'openai') {
      const env = await setup(t, provider, [err(429, { error: { code: 'credit_balance_exhausted' } })]);
      const h = env.create();
      assert.equal((await env.drive(h, { qualificationActive: false })).reserveReleaseEvidence, false);
    }
  });

  test(`${provider}: a destroyed socket after send is uncertain and never re-sent`, async (t) => {
    const env = await setup(t, provider, [ok(provider, { tools: [READ('README.md')] }), { destroy: true }, ok(provider, { text: 'never' })]);
    const h = env.create();
    const result = await env.drive(h);
    h.release();
    assert.equal(result.status, 'terminal'); assert.equal(result.outcome.class, 'outcome_uncertain');
    assert.equal(result.outcome.uncertainTurn, 2); assert.equal(result.turns[1].state, 'uncertain');
    const again = await env.resume(h.runId);
    assert.equal(again.requestsThisAttempt, 0); assert.equal(env.fake.requests.length, 2);
  });

  test(`${provider}: cancellation mid-fetch is uncertain; cancellation between turns is resumable`, async (t) => {
    let controller;
    const env = await setup(t, provider, [ok(provider, { tools: [READ('README.md')] }), () => { setImmediate(() => controller.abort()); return { hang: true }; }]);
    controller = new AbortController();
    const h = env.create();
    const result = await env.drive(h, { signal: controller.signal });
    h.release();
    assert.equal(result.outcome.class, 'outcome_uncertain'); assert.equal(result.outcome.cancelled, true); assert.equal(result.status, 'terminal');

    const env2 = await setup(t, provider, [ok(provider, { tools: [READ('README.md')] }), ok(provider, { text: 'later' })]);
    const h2 = env2.create();
    const stopped = await env2.drive(h2, { beforeDispatch: (index) => index < 2 });
    h2.release();
    assert.equal(stopped.status, 'resumable'); assert.equal(stopped.outcome.class, 'cancelled');
    assert.equal(stopped.turns[1].state, 'not_sent'); assert.equal(env2.fake.requests.length, 1);
    const resumed = await env2.resume(h2.runId);
    assert.equal(resumed.outcome.class, 'completed'); assert.equal(env2.fake.requests.length, 2);
  });

  test(`${provider}: a linked attempt continues from a safe turn and never mutates the parent`, async (t) => {
    const env = await setup(t, provider, [ok(provider, { tools: [LIST()] }), ok(provider, { tools: [READ('README.md')] }), { destroy: true },
      ok(provider, { text: 'linked done' })]);
    const parent = env.create();
    const failed = await env.drive(parent);
    parent.release();
    assert.equal(failed.outcome.class, 'outcome_uncertain'); assert.equal(failed.outcome.uncertainTurn, 3);
    const before = dirDigest(parent.dir);
    const loaded = env.store.load(parent.runId);
    assert.throws(() => linkedSeed(provider, loaded, 4), { code: 'linked_attempt_invalid' });
    assert.throws(() => linkedSeed(provider, loaded, 0), { code: 'linked_attempt_invalid' });
    const seed = linkedSeed(provider, loaded, 3);
    const child = env.create(seed, { supersedes: { parentRunId: parent.runId, fromTurn: 3 } });
    const result = await env.drive(child);
    child.release();
    assert.equal(result.outcome.class, 'completed'); assert.equal(result.text, 'linked done');
    assert.deepEqual(result.supersedes, { parentRunId: parent.runId, fromTurn: 3 });
    assert.equal(dirDigest(parent.dir), before);
    assert.equal(env.store.load(parent.runId).manifest.outcome.class, 'outcome_uncertain');
    // Same conversation prefix as the uncertain request.
    assert.deepEqual(env.fake.requests[3].body, env.fake.requests[2].body);
    const active = env.create();
    assert.throws(() => linkedSeed(provider, env.store.load(active.runId), 1), { code: 'linked_attempt_parent_not_terminal' });
  });

  test(`${provider}: crash at each failpoint resumes safely`, { skip: process.platform !== 'linux' && 'needs /proc owner identity' }, async (t) => {
    const fixture = path.join(__dirname, 'fixtures', 'api-agent-crash-child.js');
    for (const [failpoint, expected, extraRequests] of [['after-turn-intent', 'outcome_uncertain', 0], ['after-received', 'completed', 1],
      ['after-tool-intent', 'completed', 1], ['after-tool-done', 'completed', 1]]) {
      const env = await setup(t, provider, [ok(provider, { tools: [READ('README.md')] }), ok(provider, { text: 'recovered' })]);
      const runId = env.store.newRunId();
      const dataDir = path.dirname(env.store.root);
      const signal = await new Promise((resolve) => {
        const child = spawn(process.execPath, [fixture, dataDir, runId, provider, String(env.fake.port), failpoint, env.cwd], { env: isolatedEnv(), stdio: 'inherit' });
        child.on('exit', (code, sig) => resolve(sig || code));
      });
      assert.equal(signal, 'SIGKILL', failpoint);
      const sentByChild = env.fake.requests.length;
      assert.equal(sentByChild, failpoint === 'after-turn-intent' ? 0 : 1, failpoint);
      const result = await env.resume(runId);
      assert.equal(result.outcome.class, expected, failpoint);
      assert.equal(result.requestsThisAttempt, extraRequests, failpoint);
      const loaded = env.store.load(runId);
      if (expected === 'completed') {
        assert.equal(loaded.tools.get('1:0').state, 'done');
        assert.match(env.fake.requests.at(-1).body[provider === 'claude' ? 'messages' : 'input'].map((m) => JSON.stringify(m)).join(''), /project readme needle/);
      } else assert.equal(loaded.turns[0].state, 'uncertain');
    }
  });

  const crashChild = (env, runId, failpoint, qualificationActive) => new Promise((resolve) => {
    const fixture = path.join(__dirname, 'fixtures', 'api-agent-crash-child.js');
    const child = spawn(process.execPath, [fixture, path.dirname(env.store.root), runId, provider, String(env.fake.port), failpoint, env.cwd,
      qualificationActive ? '1' : '0'], { env: isolatedEnv(), stdio: 'inherit' });
    child.on('exit', (code, sig) => resolve(sig || code));
  });

  test(`${provider}: a crash after a received non-resumable error stays terminal with its evidence and sends nothing`, { skip: process.platform !== 'linux' && 'needs /proc owner identity' }, async (t) => {
    const credit = provider === 'openai'
      ? [429, { error: { code: 'credit_balance_exhausted', message: 'out' } }, 'funding_exhausted', true]
      : [400, { error: { message: 'Your credit balance is too low to access the Anthropic API.' } }, 'account_credit_low', false];
    const spend = provider === 'openai'
      ? [429, { error: { code: 'project_spend_limit_exceeded' } }, 'spend_limit', false]
      : [429, { error: { type: 'rate_limit_error', details: { error_code: 'enforced_spend_limit_reached' } } }, 'spend_limit', false];
    for (const [status, body, cls, evidence] of [credit, spend, [401, null, 'auth', false]]) {
      for (const via of ['resume', 'reconcile']) {
        const label = `${status} ${cls} via ${via}`;
        const env = await setup(t, provider, [err(status, body), ok(provider, { text: 'never' })]);
        const runId = env.store.newRunId();
        assert.equal(await crashChild(env, runId, 'after-received', true), 'SIGKILL', label);
        assert.equal(env.fake.requests.length, 1, label);
        const stored = env.store.load(runId);
        assert.equal(stored.manifest.status, 'active', label);
        assert.equal(stored.turns[0].response.error.class, cls, label);
        assert.equal(stored.turns[0].response.error.resumable, false, label);
        assert.equal(stored.turns[0].response.error.reserveReleaseEvidence, evidence, label);
        if (via === 'reconcile') {
          const row = env.store.reconcile().find((r) => r.runId === runId);
          assert.deepEqual({ action: row.action, status: row.status }, { action: cls, status: 'terminal' }, label);
          const manifest = env.store.load(runId).manifest;
          assert.equal(manifest.status, 'terminal', label); assert.equal(manifest.outcome.class, cls, label);
          assert.equal(manifest.outcome.reserveReleaseEvidence, evidence, label);
        }
        const result = await env.resume(runId);
        assert.equal(result.status, 'terminal', label); assert.equal(result.outcome.class, cls, label);
        assert.equal(result.outcome.status, status, label);
        assert.equal(result.requestsThisAttempt, 0, label); assert.equal(env.fake.requests.length, 1, label);
        assert.equal(result.reserveReleaseEvidence, evidence, label);
        const again = await env.resume(runId);
        assert.equal(again.requestsThisAttempt, 0, label); assert.equal(again.reserveReleaseEvidence, evidence, label);
        assert.equal(env.fake.requests.length, 1, label);
      }
    }
    if (provider === 'openai') {
      const env = await setup(t, provider, [err(429, { error: { code: 'credit_balance_exhausted' } })]);
      const runId = env.store.newRunId();
      assert.equal(await crashChild(env, runId, 'after-received', false), 'SIGKILL');
      const result = await env.resume(runId);
      assert.equal(result.outcome.class, 'funding_exhausted'); assert.equal(result.reserveReleaseEvidence, false);
      assert.equal(result.requestsThisAttempt, 0);
    }
  });

  test(`${provider}: a crash after a received 429 or 503 resumes with exactly one new request`, { skip: process.platform !== 'linux' && 'needs /proc owner identity' }, async (t) => {
    for (const [status, body, cls] of [[429, { error: { type: 'rate_limit_error', message: 'slow down' } }, 'rate_limited'], [503, null, 'provider_unavailable']]) {
      for (const via of ['resume', 'reconcile']) {
        const label = `${status} via ${via}`;
        const env = await setup(t, provider, [err(status, body), ok(provider, { text: 'recovered' })]);
        const runId = env.store.newRunId();
        assert.equal(await crashChild(env, runId, 'after-received', true), 'SIGKILL', label);
        assert.equal(env.store.load(runId).turns[0].response.error.resumable, true, label);
        if (via === 'reconcile') {
          const row = env.store.reconcile().find((r) => r.runId === runId);
          assert.deepEqual({ action: row.action, status: row.status }, { action: cls, status: 'resumable' }, label);
        }
        const result = await env.resume(runId);
        assert.equal(result.outcome.class, 'completed', label); assert.equal(result.text, 'recovered', label);
        assert.equal(result.requestsThisAttempt, 1, label); assert.equal(env.fake.requests.length, 2, label);
        assert.deepEqual(env.fake.requests[1].body, env.fake.requests[0].body, label);
        assert.equal(result.reserveReleaseEvidence, false, label);
      }
    }
  });
}

test('claude pause_turn re-sends with the paused assistant content', async (t) => {
  const env = await setup(t, 'claude', [{ status: 200, json: claudeMessage({ text: 'partial', stop: 'pause_turn' }) }, ok('claude', { text: 'done' })]);
  const h = env.create();
  const result = await env.drive(h);
  assert.equal(result.outcome.class, 'completed'); assert.equal(env.fake.requests.length, 2);
  assert.equal(env.fake.requests[1].body.messages.at(-1).role, 'assistant');
  assert.equal(env.fake.requests[1].body.messages.at(-1).content[0].text, 'partial');
});

test('openai content_filter is terminal', async (t) => {
  const env = await setup(t, 'openai', [{ status: 200, json: openaiResponse({ status: 'incomplete', incomplete: 'content_filter' }) }]);
  const result = await env.drive(env.create());
  assert.equal(result.outcome.class, 'content_filter'); assert.equal(result.status, 'terminal');
});

test('runner refuses non-idempotent tools and unknown providers', async (t) => {
  const env = await setup(t, 'claude', [ok('claude', { text: 'x' })]);
  const h = env.create();
  const tools = { definitions: [...TOOL_DEFINITIONS, { name: 'write', idempotent: false, inputSchema: {} }], execute() {} };
  await assert.rejects(env.drive(h, { tools }), { code: 'api_tool_not_idempotent' });
  await assert.rejects(env.drive(h, { provider: 'codex' }), { code: 'api_model_unmapped' });
  for (const credential of ['', 'sk-1234', null]) await assert.rejects(env.drive(h, { credential }), { code: 'api_credential_unbound' });
  assert.equal(env.fake.requests.length, 0);
});

test('workspace identity loss during a tool is fatal and terminal', async (t) => {
  const env = await setup(t, 'claude', [ok('claude', { tools: [READ('README.md')] }), ok('claude', { text: 'never' })]);
  const h = env.create();
  const tools = createReadOnlyTools({ cwd: env.cwd, revalidateCwd() { throw Object.assign(new Error('moved'), { code: 'cwd_identity_changed' }); } });
  const result = await env.drive(h, { tools });
  assert.equal(result.outcome.class, 'cwd_identity_changed'); assert.equal(result.status, 'terminal');
  assert.equal(env.fake.requests.length, 1);
});
