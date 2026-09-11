'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { providerVersion, classifyAnswer, readPerplexityState } = require('../lib/perplexity-diagnostics');
const { answerHealth } = require('../lib/answer-health');

test('answer diagnostics preserve unknown causes and omit private version banners', () => {
  assert.equal(providerVersion('pwm, version 1.2.3\nprivate@example.test'), '1.2.3');
  assert.equal(providerVersion('private@example.test'), null);
  assert.equal(classifyAnswer({ stdout: 'No answer received', exitCode: 0 }), 'upstream_empty_answer');
  assert.equal(classifyAnswer({ stderr: 'Unknown model: private', exitCode: 1 }), 'unsupported_request');
  assert.equal(classifyAnswer({ stderr: 'AuthenticationError: private', exitCode: 1 }), 'authentication_failed');
  assert.equal(classifyAnswer({ stdout: 'ResponseParsingError: private', exitCode: 0 }), 'provider_protocol_error');
  assert.equal(classifyAnswer({ stdout: 'Discuss Unknown model errors', exitCode: 0 }), 'ready');
  const health = answerHealth({ model_invocation: true, exitCode: 0, stdout: 'No answer received',
    provider_state: { schema: 1, backend: 'pwm_subscription', version: '1.2.3', diagnosticCode: 'upstream_empty_answer' } }, { provider: 'perplexity' });
  assert.equal(health.status, 'incomplete'); assert.equal(health.diagnosticCode, 'upstream_empty_answer');
  assert.equal(health.providerState.version, '1.2.3'); assert.equal(health.providerState.rootCauseVerified, false);
  assert.equal(health.alternativeRecommended, true);
});

test('real wrapper captures bounded version/state and performs only one answer call', { skip: process.platform === 'win32' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-pwm-diagnostic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, 'calls');
  const fake = `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(process.env.FIXTURE_CALLS, process.argv[2]+'\\n');
if(process.argv[2]==='--version'){console.log('pwm, version 1.2.3');process.exit(0)}
if(process.argv[2]==='login'){process.exit(0)}
console.log('No answer received');`;
  fs.writeFileSync(path.join(dir, 'pwm'), fake, { mode: 0o700 });
  const env = { ...process.env, PATH: dir + path.delimiter + process.env.PATH, FIXTURE_CALLS: marker,
    PPLX_ALLOW_PAID_API_FALLBACK: '0', PERPLEXITY_API_KEY: '', PPLX_API_KEY: '' };
  const wrapper = path.resolve(__dirname, '../tools/pplx.js');
  const check = spawnSync(process.execPath, [wrapper, '--check'], { env, encoding: 'utf8', timeout: 15000 });
  assert.equal(check.status, 0);
  assert.equal(fs.readFileSync(marker, 'utf8').includes('ask'), false);
  fs.writeFileSync(marker, '');
  const answer = spawnSync(process.execPath, [wrapper, '--once'], { env, input: 'fixture', encoding: 'utf8', timeout: 15000 });
  assert.equal(answer.status, 0); assert.equal(answer.stdout.trim(), 'No answer received');
  assert.deepEqual(fs.readFileSync(marker, 'utf8').trim().split('\n'), ['--version', 'ask']);
  const state = readPerplexityState(answer.stderr);
  assert.equal(state.version, '1.2.3'); assert.equal(state.diagnosticCode, 'upstream_empty_answer');
  assert.equal(state.authenticationVerified, false);
});
