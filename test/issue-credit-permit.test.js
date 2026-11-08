'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { main } = require('../scripts/issue-credit-permit');
const prepaid = require('../lib/prepaid-authorization');
const promo = require('../lib/promotional-authorization');

const KEY = 'sk-test-issuer-sentinel-0123456789';
const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const OPENAI = ['pa_issue1', 'one', '3', 'org_one', 'gpt-6.1-sol', '24', 'proj_one', '12000', 'organization', '20100', '2026-11-30',
  '10000', '1500', '300', '1500', '375', '30'];
const CLAUDE = ['pp_issue1', 'one', '3', 'org_one', 'claude-sonnet-5-5', '24', '', '12000', '19999', '370', '0', '2026-11-30',
  '10000', '1500', '300', '1500', '375', '30'];

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-permit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'key'); fs.writeFileSync(keyFile, KEY + '\n', { mode: 0o600 });
  const data = path.join(dir, 'data'); fs.mkdirSync(data);
  return { data, keyFile };
}
async function run(provider, answers, { data, keyFile }, extra = []) {
  const input = new PassThrough(), output = new PassThrough();
  let out = ''; output.on('data', (d) => { out += d; });
  input.end(answers.join('\n') + '\n');
  const permit = await main(['--provider', provider, '--data-dir', data, '--key-file', keyFile, ...extra], { input, output, now: NOW });
  return { permit, out };
}

test('issues a valid v2 OpenAI permit 0600 without printing or storing the key', async (t) => {
  const env = setup(t);
  const { permit, out } = await run('openai', OPENAI, env);
  const file = path.join(env.data, 'prepaid-authorization.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.schemaVersion, 2); assert.equal(stored.credentialHmac, prepaid.credentialHmac('pa_issue1', KEY));
  prepaid.validateAuthorization(stored);
  assert.equal(permit.ledger.budgetCents, 10000);
  assert.ok(!out.includes(KEY) && !fs.readFileSync(file, 'utf8').includes(KEY));
  assert.deepEqual(fs.readdirSync(env.data), ['prepaid-authorization.json']);
});

test('issues a valid v2 Claude permit; refuses to overwrite an unexpired one without --replace', async (t) => {
  const env = setup(t);
  await run('claude', CLAUDE, env);
  const file = path.join(env.data, 'promotional-authorization.json');
  promo.validateAuthorization(JSON.parse(fs.readFileSync(file, 'utf8')));
  const before = fs.readFileSync(file, 'utf8');
  await assert.rejects(run('claude', CLAUDE, env), /unexpired permit exists/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  await run('claude', CLAUDE.map((v, i) => (i === 0 ? 'pp_issue2' : v)), env, ['--replace']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).authorizationId, 'pp_issue2');
});

test('an invalid observation is rejected by the module validator and writes nothing', async (t) => {
  const env = setup(t);
  const tooBig = OPENAI.map((v, i) => (i === 11 ? '99999' : v)); // budget above the cap
  await assert.rejects(run('openai', tooBig, env), { code: 'prepaid_authorization_invalid' });
  assert.deepEqual(fs.readdirSync(env.data), []);
  await assert.rejects(run('openai', OPENAI.slice(0, 5), env), /input ended/);
  assert.deepEqual(fs.readdirSync(env.data), []);
});

test('the issuer is not reachable from the server, CLI or MCP', () => {
  const root = path.join(__dirname, '..');
  for (const f of ['server.js', 'bin/relaybridge.js']) assert.ok(!fs.readFileSync(path.join(root, f), 'utf8').includes('issue-credit-permit'), f);
});
