'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createOwnerControl } = require('../lib/owner-control');
const { pinLinuxNamespace, probeLinuxNamespace } = require('../lib/linux-owner-identity');
const { waitFor } = require('./helpers/temporary-bridge');
const ROOT = path.resolve(__dirname, '..');
const AVAILABLE = process.platform === 'linux' && fs.existsSync('/usr/bin/bwrap');

async function gate(t, program, extraEnv = {}) {
  let resolvePin, rejectPin, pin, info = '';
  const pinned = new Promise((resolve, reject) => { resolvePin = resolve; rejectPin = reject; }); pinned.catch(() => {});
  const events = [];
  const control = await createOwnerControl({ runId: 'run_gate_fixture',
    async onHello(message) { await pinned; return message.pid1 === true && message.namespacePid === 1; },
    onMessage: (message) => events.push(message) });
  const proc = spawn('/usr/bin/bwrap', ['--unshare-pid', '--as-pid-1', '--die-with-parent', '--dev-bind', '/', '/',
    '--proc', '/proc', '--info-fd', '3', '--chdir', ROOT, '--', process.execPath,
    path.join(ROOT, 'tools/pid1-gate.js'), '--', process.execPath, '-e', program], {
    cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv, RELAYBRIDGE_OWNER_SOCKET: control.address,
      RELAYBRIDGE_OWNER_NONCE: control.nonce, RELAYBRIDGE_OWNER_RUN_ID: 'run_gate_fixture' },
  });
  let stdout = [], stderr = [];
  proc.stdout.on('data', (data) => stdout.push(data)); proc.stderr.on('data', (data) => stderr.push(data));
  const closed = new Promise((resolve) => proc.once('close', (code, signal) => resolve({ code, signal })));
  proc.on('error', rejectPin);
  proc.stdio[3].on('data', (data) => {
    info += data.toString('utf8');
    if (info.length > 8192) { rejectPin(new Error('owner info limit')); return; }
    let record; try { record = JSON.parse(info); } catch { return; }
    try { pin = pinLinuxNamespace(record['child-pid']); resolvePin(pin); } catch (error) { rejectPin(error); }
  });
  proc.stdio[3].once('end', () => { if (!pin) rejectPin(new Error('owner pin unavailable: ' + Buffer.concat(stderr).toString('utf8').slice(0, 200))); });
  t.after(async () => {
    await control.dispose();
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
    await closed;
    if (pin) await waitFor(() => probeLinuxNamespace(pin).state === 'gone', 3000);
  });
  await control.ready;
  return { proc, control, events, pin, closed, stdout: () => Buffer.concat(stdout), stderr: () => Buffer.concat(stderr) };
}

test('real PID1 gate preserves binary stdin/stdout/stderr and removes control credentials', { skip: !AVAILABLE, timeout: 10000 }, async (t) => {
  const owned = await gate(t, [
    "if(process.env.RELAYBRIDGE_OWNER_NONCE||process.env.RELAYBRIDGE_OWNER_SOCKET||process.env.RELAYBRIDGE_OWNER_RUN_ID)process.exit(99);",
    "process.stderr.write(Buffer.from([0,255,195,169,10]));process.stdin.pipe(process.stdout);",
  ].join(''));
  assert.equal(probeLinuxNamespace(owned.pin).state, 'alive');
  await owned.control.send({ type: 'proceed' });
  const input = Buffer.alloc(1024 * 1024); for (let index = 0; index < input.length; index++) input[index] = index % 256;
  owned.proc.stdin.end(input);
  const exit = await owned.closed;
  await waitFor(() => probeLinuxNamespace(owned.pin).state === 'gone', 3000);
  assert.equal(exit.code, 0); assert.deepEqual(owned.stdout(), input); assert.deepEqual(owned.stderr(), Buffer.from([0,255,195,169,10]));
  assert.ok(owned.events.some((event) => event.type === 'provider_spawned'));
  assert.ok(owned.events.some((event) => event.type === 'root_exit' && event.code === 0));
});

test('PID1 teardown kills a setsid descendant even after it closes every stdio handle', { skip: !AVAILABLE, timeout: 10000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-owner-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const child = "const fs=require('fs');fs.writeFileSync(process.env.RB_OWNER_TEST_DIR+'/ready','ready');setTimeout(()=>fs.writeFileSync(process.env.RB_OWNER_TEST_DIR+'/late','unsafe'),800);setInterval(()=>{},1000);";
  const owned = await gate(t, `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000);`,
    { RB_OWNER_TEST_DIR: dir });
  await owned.control.send({ type: 'proceed' }); owned.proc.stdin.end();
  await waitFor(() => fs.existsSync(path.join(dir, 'ready')), 3000);
  await owned.control.send({ type: 'stop' });
  await owned.closed;
  await waitFor(() => probeLinuxNamespace(owned.pin).state === 'gone', 3000);
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(fs.existsSync(path.join(dir, 'late')), false);
});

test('no proceed means no provider dispatch; disconnect destroys the pinned namespace', { skip: !AVAILABLE, timeout: 10000 }, async (t) => {
  const owned = await gate(t, "process.stdout.write('SHOULD_NOT_DISPATCH');");
  await owned.control.dispose(); owned.proc.stdin.end();
  await owned.closed;
  await waitFor(() => probeLinuxNamespace(owned.pin).state === 'gone', 3000);
  assert.equal(owned.events.some((event) => event.type === 'provider_spawned'), false);
  assert.equal(owned.stdout().length, 0);
});

test('gate refuses to execute outside a namespace PID1 even with a valid-looking hello environment', { timeout: 5000 }, async () => {
  const proc = spawn(process.execPath, [path.join(ROOT, 'tools/pid1-gate.js'), '--', process.execPath, '-e', "process.stdout.write('UNOWNED');"],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RELAYBRIDGE_OWNER_SOCKET: '/tmp/no-owner-control',
      RELAYBRIDGE_OWNER_NONCE: 'a'.repeat(64), RELAYBRIDGE_OWNER_RUN_ID: 'run_not_pid1' } });
  let stdout = ''; proc.stdout.on('data', (data) => stdout += data); proc.stderr.resume();
  const code = await new Promise((resolve) => proc.once('close', resolve));
  assert.equal(code, 78); assert.equal(stdout, '');
});
