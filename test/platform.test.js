'use strict';

// Platform abstraction for the WSL/Linux/macOS port. These tests run on the
// TARGET platform (the CI sandbox is Linux), so the POSIX paths here are
// exercised for real — not simulated the way the Windows paths must be.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('child_process');

const P = require('../lib/platform');

const posixOnly = process.platform === 'win32' ? test.skip : test;

// ---- detection -------------------------------------------------------------

test('platform detection is coherent', () => {
  const d = P.detectPlatform();
  assert.equal(d.os, process.platform);
  assert.equal([d.isWindows, d.isMac, d.isLinux].filter(Boolean).length, 1,
    'exactly one OS flag is set');
  if (d.isWSL) assert.ok(d.isLinux, 'WSL is Linux to Node');
  assert.ok(d.label.length > 0);
});

test('WSL bootstrap installs the active Linux port, not the retired fuel-gauge branch', () => {
  const setup = fs.readFileSync(path.join(__dirname, '..', 'setup-wsl.sh'), 'utf8');
  assert.doesNotMatch(setup, /BRANCH=.*feat\/usage-fuel-gauge/);
  assert.match(setup, /BRANCH="\$\{RELAYBRIDGE_BRANCH:-feat\/wsl-port-on-main\}"/);
});

// ---- shells ----------------------------------------------------------------

posixOnly('a POSIX system resolves a real default shell', () => {
  const s = P.defaultShell();
  assert.ok(s, 'bash or sh must exist on any POSIX system running Node');
  assert.ok(['bash', 'zsh', 'sh'].includes(s.kind), s.kind);
  assert.ok(require('fs').existsSync(s.exe), `${s.exe} must be a real path`);
});

posixOnly('a powershell request on POSIX falls back with an explanation, not an error', () => {
  // Every existing client of the Windows bridge sends shell:"powershell".
  // Breaking them all would make the port a regression.
  const s = P.resolveShell('powershell');
  assert.ok(s.exe, 'must still run the command');
  if (s.kind !== 'pwsh') {
    assert.match(s.fallbackNote, /not available/, 'the caller is told about the substitution');
    assert.match(s.fallbackNote, /ran with/);
  }
});

test('an unknown shell name falls back rather than throwing', () => {
  const s = P.resolveShell('quantumshell');
  assert.ok(s.exe);
  assert.match(s.fallbackNote, /quantumshell/);
});

posixOnly('the command travels as a single argv element — no interpolation layer', () => {
  const evil = `echo "a b" 'c d' $(echo nope) ; & | \n newline`;
  const built = P.buildExecSpawn(evil, { shell: 'bash' });
  assert.equal(built.args[built.args.length - 1], evil,
    'the exact string, byte for byte, as the last argv element');
  assert.equal(built.args.filter((a) => a.includes('nope')).length, 1,
    'appears exactly once — never re-quoted or expanded by us');
});

posixOnly('a real command with hostile quoting survives end to end', async () => {
  const built = P.buildExecSpawn(`printf '%s' "it's \\"fine\\""`, { shell: 'bash' });
  const out = await new Promise((resolve) => {
    const c = spawn(built.exe, built.args, built.options);
    let s = '';
    c.stdout.on('data', (d) => { s += d; });
    c.on('close', () => resolve(s));
  });
  assert.equal(out, `it's "fine"`, 'quoting hell is the thing this port escapes');
});

posixOnly('bash exec uses a login shell so CLIs in profile PATH are found', () => {
  // Model CLIs live in ~/.local/bin or nvm shims, which only enter PATH via
  // profile files. A non-login bash -c fails every provider call with ENOENT.
  const built = P.buildExecSpawn('claude --version', { shell: 'bash' });
  assert.ok(built.args.includes('-lc'), JSON.stringify(built.args));
});

posixOnly('exec spawns detached on POSIX so the tree can be group-killed', () => {
  assert.equal(P.buildExecSpawn('sleep 1').options.detached, true);
});

posixOnly('the PTY session entry matches the cli-config shape', () => {
  const e = P.platformShellEntry();
  assert.ok(Array.isArray(e.safe) && e.safe.length >= 1);
  assert.ok(require('fs').existsSync(e.safe[0]), 'session command must be a real executable');
  assert.match(e.label, /Shell \(/);
});

// ---- CPU accounting --------------------------------------------------------

test('ps TIME parsing covers Linux and macOS shapes', () => {
  assert.equal(P.parsePsTimeMs('0:03'), 3000);
  assert.equal(P.parsePsTimeMs('1:02:03'), 3723000);
  assert.equal(P.parsePsTimeMs('2-01:00:00'), 176400000, 'Linux dd-hh:mm:ss');
  assert.equal(P.parsePsTimeMs('0:01.50'), 1500, 'macOS centiseconds');
  assert.equal(P.parsePsTimeMs('garbage'), null);
});

posixOnly('CPU time of a busy tree is measured, not null', async () => {
  // The whole point of the port: this returned null everywhere but Windows,
  // leaving the supervisor blind to "thinking vs wedged".
  //
  // ps reports TIME at 1-second granularity, so a fixed early sample can
  // legitimately read 0 on a loaded box. Poll until the counter ticks over —
  // that is also how the supervisor consumes this signal: as a delta over
  // time, never a single absolute read.
  const child = spawn('bash', ['-c',
    'end=$((SECONDS+6)); while [ $SECONDS -lt $end ]; do :; done'], { detached: true });
  let ms = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    ms = await P.sampleTreeCpuMs(child.pid);
    if (ms !== null && ms >= 1000) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  assert.ok(ms !== null, 'must measure on POSIX now');
  assert.ok(ms >= 1000, `a busy loop must show CPU burn within 5s, got ${ms}`);
});

posixOnly('CPU time of a vanished tree resolves null, never throws', async () => {
  assert.equal(await P.sampleTreeCpuMs(999999), null);
});

// ---- process trees ---------------------------------------------------------

posixOnly('killTree takes out grandchildren, not just the direct child', async () => {
  // The old POSIX path was proc.kill('SIGTERM') — the CLI died, its node
  // subprocess kept running and holding the port/file locks.
  const root = spawn('bash', ['-c', 'sleep 30 & sleep 30 & wait'], { detached: true });
  await new Promise((r) => setTimeout(r, 300));
  const before = P.collectTreePids(root.pid);
  assert.ok(before.length >= 3, `expected root+2 sleeps, saw ${before.length}`);

  P.killTree(root);
  await new Promise((r) => setTimeout(r, 500));
  // kill(pid, 0) succeeds on zombies — dead but unreaped — so ask ps for the
  // state and only count processes actually running.
  const { spawnSync } = require('child_process');
  const ps = spawnSync('ps', ['-Ao', 'pid=,state='], { encoding: 'utf8' });
  const running = new Set((ps.stdout || '').split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\S+)/))
    .filter((m) => m && !m[2].startsWith('Z'))
    .map((m) => Number(m[1])));
  const alive = before.filter((pid) => running.has(pid));
  assert.deepEqual(alive, [], `still alive after killTree: ${alive.join(', ')}`);
});

posixOnly('killTree on an already-dead pid is a no-op, not a crash', () => {
  P.killTree(999999);
  P.killTree(null);
  P.killTree({});
});
