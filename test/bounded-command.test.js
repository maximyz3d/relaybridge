'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runBoundedCommand } = require('../lib/bounded-command');

test('bounded command decodes split Unicode once and preserves exit failures', async () => {
  const output = await runBoundedCommand(process.execPath, ['-e',
    "const b=Buffer.from('hello 🌍'); for(const byte of b)process.stdout.write(Buffer.from([byte])); process.stderr.write('error detail');process.exitCode=7;"],
  { maxOutputBytes: 100 });
  assert.equal(output.code, 7);
  assert.equal(output.stdout, 'hello 🌍');
  assert.equal(output.stderr, 'error detail');
  assert.equal(output.failure, null);
});

test('combined output cap stops accumulation and cannot become exit-zero success', async () => {
  const output = await runBoundedCommand(process.execPath, ['-e',
    "process.stdout.write('x'.repeat(512));process.stderr.write('y'.repeat(512));setInterval(()=>{},1000);"],
  { maxOutputBytes: 600, timeoutMs: 5000 });
  assert.equal(output.code, -1);
  assert.equal(output.failure, 'command_output_limit');
  assert.ok(Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) <= 600);
});

test('deadline terminates command and reports typed failure; no-shell argv preserves metacharacters', async () => {
  const timeout = await runBoundedCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 });
  assert.equal(timeout.code, -1);
  assert.equal(timeout.failure, 'command_timeout');
  const payload = 'hello & | $(never-run) %PATH% "quoted" 世界';
  const argv = await runBoundedCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', payload]);
  assert.equal(argv.code, 0);
  assert.equal(argv.stdout, payload);
});

test('spawn and resource limit failures are bounded explicit outcomes', async () => {
  const output = await runBoundedCommand('relaybridge-no-such-fixture-binary', []);
  assert.equal(output.code, -1);
  assert.equal(output.failure, 'command_spawn_failed');
  await assert.rejects(runBoundedCommand(process.execPath, [], { maxOutputBytes: Infinity }), TypeError);
  await assert.rejects(runBoundedCommand(process.execPath, [], { timeoutMs: 0 }), TypeError);
});
