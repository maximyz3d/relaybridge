'use strict';

// Platform abstraction: the one place that knows which OS this bridge is on.
//
// The port target is WSL/Linux/macOS with Windows kept working, and the rule
// that makes that maintainable is: server.js asks QUESTIONS ("give me a shell
// for this request", "how much CPU has this tree used", "kill this tree") and
// this module answers them per-platform. `process.platform === 'win32'`
// branches scattered through call sites are how the Windows-isms accumulated
// in the first place.
//
// Quoting principle, learned the hard way: a command travels as ONE argv
// element into `bash -c ...` / `powershell -Command ...`. No string
// concatenation into a shell line, ever — that is the PowerShell-quoting hell
// this port exists to escape, and reintroducing it on Linux would waste the
// move.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

let _detected = null;

// WSL is Linux to Node (`process.platform === 'linux'`), but it is worth
// knowing about separately: Windows paths are reachable under /mnt/c, the
// Windows host owns the clock and network, and interop lets .exe files run.
// Detection: the kernel string says microsoft, or WSL sets its env marker.
function detectPlatform() {
  if (_detected) return _detected;
  const p = process.platform;
  let isWSL = false;
  if (p === 'linux') {
    if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) isWSL = true;
    else {
      try { isWSL = /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')); }
      catch { /* not readable — plain linux */ }
    }
  }
  _detected = {
    os: p,
    isWindows: p === 'win32',
    isMac: p === 'darwin',
    isLinux: p === 'linux',
    isWSL,
    label: p === 'win32' ? 'Windows' : p === 'darwin' ? 'macOS' : isWSL ? 'WSL' : 'Linux',
  };
  return _detected;
}

// WSL is fastest when repositories, runtime state, Node, and model CLIs stay on
// its native Linux filesystem.  /mnt/* crosses the 9p/DrvFs boundary and makes
// metadata-heavy Git/npm workloads dramatically slower.  Keep this test pure
// so setup scripts and health checks can enforce the same rule.
function isSlowWslInteropPath(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const supplied = value.trim().replace(/\\/g, '/');
  // Keep this classifier pure when callers inject an isWSL platform in tests
  // or inspect WSL configuration from a Windows control process. Resolving a
  // Linux absolute path with win32 path semantics first would turn /mnt/c into
  // C:/mnt/c and incorrectly bless the interop path.
  if (supplied === '/mnt' || supplied.startsWith('/mnt/')) return true;
  let resolved = path.resolve(value);
  try { resolved = fs.realpathSync(resolved); } catch { /* non-existent output path */ }
  resolved = resolved.replace(/\\/g, '/');
  return resolved === '/mnt' || resolved.startsWith('/mnt/');
}

function wslNativeRuntimeStatus(locations = {}, options = {}) {
  const detected = options.platform || detectPlatform();
  const allowSlow = options.allowSlow === true
    || /^(1|true|yes)$/i.test(String(process.env.RELAYBRIDGE_ALLOW_SLOW_WSL_FS || ''));
  if (!detected.isWSL) {
    return {
      applicable: false,
      enforced: false,
      ok: true,
      nativeFilesystem: null,
      nativeNode: null,
      issues: [],
    };
  }
  const labels = ['checkout', 'data', 'token', 'config', 'node'];
  const issues = labels.filter((label) => isSlowWslInteropPath(locations[label]));
  return {
    applicable: true,
    enforced: !allowSlow,
    ok: allowSlow || issues.length === 0,
    nativeFilesystem: !issues.some((label) => label !== 'node'),
    nativeNode: !issues.includes('node'),
    issues,
  };
}

// ---------------------------------------------------------------------------
// Shells
// ---------------------------------------------------------------------------

// Everything this module knows about invoking each shell. `execArgs` runs one
// command non-interactively; `sessionArgs` starts an interactive PTY.
//
// bash/zsh exec uses -l (login) deliberately: the model CLIs land in
// ~/.local/bin, ~/.npm-global/bin, or nvm shims, all of which enter PATH via
// profile files. A non-login `bash -c` cannot find them and every provider
// call fails with ENOENT — costing an hour of debugging to save ~20ms of
// profile sourcing. sh stays plain -c: -l is not portable across sh
// implementations.
const SHELLS = {
  powershell: {
    kind: 'powershell',
    exeNames: process.platform === 'win32' ? ['powershell.exe'] : ['powershell'],
    execArgs: (cmd) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd],
    sessionArgs: () => ['-NoLogo'],
  },
  pwsh: {
    kind: 'pwsh',
    exeNames: process.platform === 'win32' ? ['pwsh.exe'] : ['pwsh'],
    execArgs: (cmd) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd],
    sessionArgs: () => ['-NoLogo'],
  },
  bash: {
    kind: 'bash',
    exeNames: ['bash'],
    execArgs: (cmd) => ['-lc', cmd],
    sessionArgs: () => ['-l'],
  },
  zsh: {
    kind: 'zsh',
    exeNames: ['zsh'],
    execArgs: (cmd) => ['-lc', cmd],
    sessionArgs: () => ['-l'],
  },
  sh: {
    kind: 'sh',
    exeNames: ['sh'],
    execArgs: (cmd) => ['-c', cmd],
    sessionArgs: () => [],
  },
  cmd: {
    kind: 'cmd',
    exeNames: ['cmd.exe'],
    execArgs: (cmd) => ['/d', '/s', '/c', cmd],
    sessionArgs: () => [],
  },
};

const _shellPathCache = new Map();

function findExecutable(name) {
  if (_shellPathCache.has(name)) return _shellPathCache.get(name);
  let found = null;
  try {
    if (path.isAbsolute(name)) {
      found = fs.existsSync(name) ? name : null;
    } else {
      const probe = process.platform === 'win32'
        ? spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
        : spawnSync('which', [name], { encoding: 'utf8', timeout: 5000 });
      const line = (probe.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
      found = probe.status === 0 && line ? line : null;
    }
  } catch { found = null; }
  _shellPathCache.set(name, found);
  return found;
}

function shellAvailable(kind) {
  const def = SHELLS[kind];
  if (!def) return null;
  for (const name of def.exeNames) {
    const exe = findExecutable(name);
    if (exe) return { ...def, exe };
  }
  return null;
}

// The platform's default shell. On POSIX, honour $SHELL when it is one we
// know how to drive — an operator who chose zsh gets zsh — otherwise bash,
// otherwise sh (always present on anything POSIX enough to run Node).
function defaultShell() {
  if (process.platform === 'win32') {
    return shellAvailable('powershell') || shellAvailable('pwsh') || shellAvailable('cmd');
  }
  const fromEnv = process.env.SHELL ? path.basename(process.env.SHELL) : null;
  if (fromEnv && SHELLS[fromEnv]) {
    const s = shellAvailable(fromEnv);
    if (s) return s;
  }
  return shellAvailable('bash') || shellAvailable('zsh') || shellAvailable('sh');
}

/**
 * Resolve a requested shell kind to something this machine can actually run.
 *
 * Never throws for an unknown or unavailable kind — callers are HTTP handlers
 * and remote clients written against the Windows bridge will keep sending
 * `shell: "powershell"` after the move to WSL. Breaking every one of them
 * would make the port a regression, so an unavailable request falls back to
 * the platform default and says so in `fallbackNote` (the exec response
 * surfaces it), rather than failing the command.
 */
function resolveShell(requested = null) {
  const fallback = defaultShell();
  if (!fallback) throw new Error('no usable shell found on this system');
  if (!requested) return { ...fallback, requested: null, fallbackNote: null };

  const kind = String(requested).toLowerCase().trim();
  const hit = SHELLS[kind] ? shellAvailable(kind) : null;
  if (hit) return { ...hit, requested: kind, fallbackNote: null };

  // The one cross-family courtesy: a PowerShell request on POSIX prefers pwsh
  // (same language, different binary name) before giving up to bash.
  if ((kind === 'powershell' || kind === 'pwsh') && process.platform !== 'win32') {
    const pw = shellAvailable('pwsh');
    if (pw) return { ...pw, requested: kind, fallbackNote: null };
  }

  return {
    ...fallback,
    requested: kind,
    fallbackNote: `shell '${kind}' is not available on ${detectPlatform().label}; ran with ${fallback.kind} instead`,
  };
}

/**
 * Build the spawn for one non-interactive command.
 * The command string is passed as a single argv element — never interpolated.
 */
function buildExecSpawn(command, { shell = null, cwd = undefined, env = undefined } = {}) {
  const s = resolveShell(shell);
  return {
    exe: s.exe,
    args: s.execArgs(String(command)),
    options: {
      cwd,
      env,
      windowsHide: true, // ignored off Windows; harmless to always set
      // Own process group on POSIX so killTree can take out the whole tree
      // with one signal instead of orphaning grandchildren.
      detached: process.platform !== 'win32',
    },
    shellKind: s.kind,
    fallbackNote: s.fallbackNote,
  };
}

// What a PTY session for "give me a terminal" should run on this platform.
// Shaped like a cli-config entry so createSessionFromKind can use it directly.
function platformShellEntry() {
  const s = defaultShell();
  if (!s) throw new Error('no usable shell found on this system');
  return {
    label: process.platform === 'win32' ? 'PowerShell' : `Shell (${s.kind})`,
    company: process.platform === 'win32' ? 'Microsoft' : 'GNU',
    color: '#0078d4',
    tags: [],
    safe: [s.exe, ...s.sessionArgs()],
    // On POSIX there is no split like -ExecutionPolicy Bypass; the same shell
    // is both. Authority is decided by what the operator runs in it.
    dangerous: [s.exe, ...s.sessionArgs()],
  };
}

// ---------------------------------------------------------------------------
// Process trees
// ---------------------------------------------------------------------------

// pid -> [child pids], via one ps pass. Same flags work on Linux and macOS.
function psTree() {
  const out = spawnSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8', timeout: 8000 });
  const kids = new Map();
  if (out.status !== 0) return kids;
  for (const line of (out.stdout || '').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const [pid, ppid] = [Number(m[1]), Number(m[2])];
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  return kids;
}

function collectTreePids(rootPid) {
  const kids = psTree();
  const seen = new Set();
  const stack = [Number(rootPid)];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const c of kids.get(cur) || []) stack.push(c);
  }
  return [...seen];
}

/**
 * Kill a process and all of its descendants.
 *
 * Windows: taskkill /T /F — atomic, the OS walks the tree.
 * POSIX, in order:
 *   1. Group signal (kill(-pid)) when the child owns its process group
 *      (spawned detached, as buildExecSpawn arranges). One syscall, no race.
 *   2. Otherwise enumerate the tree via ps and signal every pid. Children are
 *      signalled before the root so the root cannot reap-and-respawn between
 *      our snapshot and our signals.
 * Either way a SIGKILL follow-up lands 3s later for anything that ignored
 * SIGTERM — model CLIs trap signals to flush telemetry and sometimes hang
 * doing it.
 */
function killTree(procOrPid) {
  const pid = typeof procOrPid === 'number' ? procOrPid : procOrPid?.pid;
  if (!pid) return;

  if (process.platform === 'win32') {
    try {
      spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref();
    } catch {
      try { (typeof procOrPid === 'object' ? procOrPid : process).kill(pid); } catch { /* already gone */ }
    }
    return;
  }

  const signalAll = (sig) => {
    let grouped = false;
    try { process.kill(-pid, sig); grouped = true; } catch { /* not a group leader */ }
    if (!grouped) {
      const pids = collectTreePids(pid).sort((a, b) => (a === pid ? 1 : b === pid ? -1 : 0));
      for (const p of pids) { try { process.kill(p, sig); } catch { /* already gone */ } }
    }
  };
  signalAll('SIGTERM');
  const escalate = setTimeout(() => signalAll('SIGKILL'), 3000);
  if (typeof escalate.unref === 'function') escalate.unref();
}

// ---------------------------------------------------------------------------
// CPU accounting
// ---------------------------------------------------------------------------

// Parse ps TIME: [[dd-]hh:]mm:ss(.ms). Linux prints dd-hh:mm:ss, macOS
// mm:ss.cc — both fit this shape.
function parsePsTimeMs(text) {
  const m = String(text).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const [, dd, hh, mm, ss] = m;
  return Math.round(((Number(dd || 0) * 24 + Number(hh || 0)) * 60 + Number(mm)) * 60000 + Number(ss) * 1000);
}

const WIN_CPU_SCRIPT_HEAD = [
  "$ErrorActionPreference='SilentlyContinue';",
  '$all=Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,KernelModeTime,UserModeTime;',
  'if(-not $all){exit 0};',
  '$byId=@{};foreach($p in $all){$byId[[int]$p.ProcessId]=$p};',
  '$kids=@{};foreach($p in $all){$k=[int]$p.ParentProcessId;if(-not $kids.ContainsKey($k)){$kids[$k]=@()};$kids[$k]+=[int]$p.ProcessId};',
  '$stack=New-Object System.Collections.Stack;$stack.Push($root);$seen=@{};$total=0.0;',
  'while($stack.Count -gt 0){$cur=[int]$stack.Pop();if($seen.ContainsKey($cur)){continue};$seen[$cur]=$true;',
  '$proc=$byId[$cur];if($proc){$total+=([double]$proc.KernelModeTime+[double]$proc.UserModeTime)/10000.0};',
  'if($kids.ContainsKey($cur)){foreach($c in $kids[$cur]){$stack.Push($c)}}};',
  '[math]::Round($total)',
].join('');

/**
 * Cumulative CPU milliseconds for a process tree. This is what separates "the
 * model is thinking and has not printed yet" from "the stage is wedged":
 * print-mode CLIs buffer their whole answer, so silence alone proves nothing.
 * Previously Windows-only (WMI); everywhere else the supervisor was blind and
 * treated null as "cannot tell". Best effort — resolves null when unreadable.
 */
function sampleTreeCpuMs(rootPid) {
  return new Promise((resolve) => {
    if (!rootPid) return resolve(null);

    if (process.platform === 'win32') {
      const script = `$root=${Number(rootPid)};` + WIN_CPU_SCRIPT_HEAD;
      let out = '';
      let done = false;
      let child;
      const finish = (v) => { if (done) return; done = true; try { child?.kill(); } catch {} resolve(v); };
      try {
        child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
      } catch { return resolve(null); }
      const guard = setTimeout(() => finish(null), 8000);
      if (typeof guard.unref === 'function') guard.unref();
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.on('error', () => { clearTimeout(guard); finish(null); });
      child.on('close', () => {
        clearTimeout(guard);
        const parsed = Number(String(out).trim());
        finish(Number.isFinite(parsed) ? parsed : null);
      });
      return;
    }

    // POSIX: one ps pass gives pid, ppid and cputime; walk the tree and sum.
    try {
      const out = spawnSync('ps', ['-Ao', 'pid=,ppid=,time='], { encoding: 'utf8', timeout: 8000 });
      if (out.status !== 0) return resolve(null);
      const rows = new Map();
      const kids = new Map();
      for (const line of (out.stdout || '').split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/);
        if (!m) continue;
        const pid = Number(m[1]);
        const ppid = Number(m[2]);
        rows.set(pid, parsePsTimeMs(m[3]) ?? 0);
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid).push(pid);
      }
      if (!rows.has(Number(rootPid))) return resolve(null); // tree already gone
      let total = 0;
      const seen = new Set();
      const stack = [Number(rootPid)];
      while (stack.length) {
        const cur = stack.pop();
        if (seen.has(cur)) continue;
        seen.add(cur);
        total += rows.get(cur) || 0;
        for (const c of kids.get(cur) || []) stack.push(c);
      }
      resolve(total);
    } catch { resolve(null); }
  });
}

module.exports = {
  detectPlatform,
  isSlowWslInteropPath,
  wslNativeRuntimeStatus,
  resolveShell,
  defaultShell,
  buildExecSpawn,
  platformShellEntry,
  killTree,
  collectTreePids,
  sampleTreeCpuMs,
  parsePsTimeMs,
  SHELLS,
};
