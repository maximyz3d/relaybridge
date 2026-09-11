'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestBridge, waitFor, completeJsonLines } = require('./helpers/temporary-bridge');

test('all provider launch paths use one shell-free qualifier; no command-line reconstruction remains', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  assert.doesNotMatch(source, /quoteCmdArg|windowsVerbatimArguments|isWindowsShim/);
  for (const section of ['_spawn()', 'async function runProbe', 'async function executeOneShot', "app.post('/api/install'"]) {
    const start = source.indexOf(section);
    assert.ok(start >= 0);
    assert.ok(source.indexOf('qualifiedProviderLaunch(', start) > start);
  }
  assert.match(source, /pty\.spawn\(launch\.file, launch\.args/);
  assert.equal((source.match(/spawn\(launch\.file, launch\.args/g) || []).length, 6);
});

test('native Windows REST keeps hostile argv/env exact across argument/file/stdin/session/probe/install and rejects unknown shims', {
  skip: process.platform !== 'win32', timeout: 60000,
}, async (t) => {
  const payload = 'keep "quotes" & | > < ^ %PATH% !bang! (parentheses) \\ 世界\r\nlast constraint';
  let marker, sentinel;
  const bridge = await startTestBridge(t, (root) => {
    marker = path.join(root, 'events.jsonl'); sentinel = path.join(root, 'injection-sentinel');
    const shim = path.join(root, 'provider.cmd');
    const bad = path.join(root, 'bad.cmd');
    const entry = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.copyFileSync(process.execPath, path.join(root, 'node.exe'));
    fs.copyFileSync(path.join(__dirname, 'fixtures/windows-shims/npm-package.cmd'), shim);
    fs.writeFileSync(bad, `@echo off\r\necho injected > "${sentinel}"\r\n`);
    fs.writeFileSync(entry, [
      "const fs=require('fs'); const [role,...args]=process.argv.slice(2);",
      `const marker=${JSON.stringify(marker)};`,
      "let input=''; const finish=()=>{const record={role,args,input,env:process.env.RB_FIXTURE_ENV};",
      "if(role==='file')record.input=fs.readFileSync(args[0],'utf8');",
      "fs.appendFileSync(marker,JSON.stringify(record)+'\\n');process.stdout.write(JSON.stringify(record));",
      "if(role==='exit')process.exitCode=7;};",
      "if(role==='stdin'){process.stdin.setEncoding('utf8');process.stdin.on('data',d=>input+=d);process.stdin.on('end',finish);}else finish();",
    ].join('\n'));
    const base = { label: 'fixture', safe: [shim, 'session', payload], oneshot_env: { RB_FIXTURE_ENV: payload },
      oneshot_safe: [shim, 'argument', '{prompt}'], prompt_max_chars: 24000 };
    return {
      argument: base,
      file: { ...base, oneshot_safe: [shim, 'file', '{prompt_file}'] },
      stdin: { ...base, oneshot_safe: [shim, 'stdin'] },
      exit: { ...base, oneshot_safe: [shim, 'exit', '{prompt}'] },
      probe: { ...base, probe: [shim, 'probe', payload] },
      install: { ...base, install_command: [shim, 'install', payload] },
      bad: { ...base, safe: [bad], probe: [bad], probe_auth_authoritative: true,
        oneshot_safe: [bad, '{prompt_file}'], install_command: [bad] },
    };
  });
  for (const kind of ['argument', 'file', 'stdin']) {
    const result = await bridge.request('/api/oneshot', { kind, prompt: payload, dangerous: false });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.exitCode, 0);
    assert.equal(result.body.route.launch_adapter, 'npm-package-shim');
    const output = JSON.parse(result.body.stdout);
    assert.equal(kind === 'argument' ? output.args[0] : output.input, payload);
    assert.equal(output.env, payload);
    if (kind === 'file') assert.equal(fs.existsSync(output.args[0]), false, 'prompt file removed');
  }
  assert.equal((await bridge.request('/api/oneshot', { kind: 'exit', prompt: payload, dangerous: false })).body.exitCode, 7);
  const installed = await bridge.request('/api/install', { kind: 'install' });
  assert.equal(installed.body.success, true);
  assert.equal(JSON.parse(installed.body.stdout).args[0], payload);
  const session = await bridge.request('/api/sessions', { kind: 'argument', dangerous: false });
  assert.equal(session.status, 200);
  await waitFor(() => completeJsonLines(marker).find((event) => event.role === 'session'));
  assert.equal(completeJsonLines(marker).find((event) => event.role === 'session').args[0], payload);
  const diagnostics = await bridge.request('/api/diag');
  assert.equal(diagnostics.body.results.probe.ready, true);
  assert.equal(diagnostics.body.results.bad.ready, false);
  assert.equal(diagnostics.body.results.bad.authAuthoritative, false);
  assert.equal(diagnostics.body.results.bad.qualificationFailure.code, 'unsupported_windows_shim');
  assert.equal(completeJsonLines(marker).find((event) => event.role === 'probe').args[0], payload);
  const count = completeJsonLines(marker).length;
  for (const [route, body] of [
    ['/api/oneshot', { kind: 'bad', prompt: payload, dangerous: false }],
    ['/api/install', { kind: 'bad' }], ['/api/sessions', { kind: 'bad', dangerous: false }],
  ]) {
    const rejected = await bridge.request(route, body);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.validation.code, 'unsupported_windows_shim');
    assert.equal(rejected.body.model_invocation, false);
    assert.equal(rejected.body.physical_attempt_count, 0);
  }
  assert.equal(completeJsonLines(marker).length, count);
  assert.equal(fs.existsSync(sentinel), false);
});
