'use strict';

// Batch files are metadata, never an execution transport. Decode only known
// complete vendor templates into native executable + argv; an unknown wrapper
// must be upgraded/qualified explicitly, even for probes or install commands.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_SHIM_BYTES = 64 * 1024;
const NPM_PREFIX = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b',
  ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\',
].join('\n');
const NPM_SUFFIX = '" %*';
// Normalized complete upstream templates observed with the installed npm and
// Cursor Windows distributions. Hashes are not executable-file trust claims.
const TEMPLATE_HASHES = new Map([
  ['6ebda0fb14f57a9fa5b31605929f4ec39a9aa672a9161a4ee9db2997cbff0d3c', 'npm'],
  ['c2b2dbbe8315706f12feb981e8d172416b62d83ebb627355c9c793fc1cba16f4', 'npx'],
  ['044bb587ab016ec3a45ad7dba6a7f415748d189c33dfeabb07bb49d29e2efe7f', 'cursor'],
]);
const CURSOR_PS1_HASH = '11169ef90694ac10c60e685761b25be5848f92d44cfe5ee6a89010ed5735eff7';

function normalizedTemplate(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('invalid shim encoding');
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trimEnd();
}

function fingerprint(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

function assertRegularPath(file, io) {
  const stat = io.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('non-regular launch file');
  // Reject junctions/symlinks in ancestors too; npm link and unknown wrappers
  // need explicit qualification, not a shell fallback.
  for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
    const entry = io.lstatSync(parent);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('indirect launch path');
    if (path.dirname(parent) === parent) break;
  }
  return stat;
}

function readTemplate(file, io) {
  const before = assertRegularPath(file, io);
  if (before.size > MAX_SHIM_BYTES) throw new Error('shim too large');
  let handle;
  try {
    handle = io.openSync(file, fs.constants.O_RDONLY |
      (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = io.fstatSync(handle);
    if (!opened.isFile() || fingerprint(opened) !== fingerprint(before)) throw new Error('shim changed');
    // Bound the descriptor read too, so growth/replacement cannot allocate an
    // arbitrarily large buffer between lstat and read.
    const buffer = Buffer.alloc(MAX_SHIM_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = io.readSync(handle, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length > MAX_SHIM_BYTES || fingerprint(io.fstatSync(handle)) !== fingerprint(opened) ||
        fingerprint(assertRegularPath(file, io)) !== fingerprint(opened)) throw new Error('shim changed');
    return normalizedTemplate(buffer.subarray(0, length));
  } finally {
    if (handle !== undefined) io.closeSync(handle);
  }
}

function hash(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

function packageScript(text) {
  if (!text.startsWith(NPM_PREFIX) || !text.endsWith(NPM_SUFFIX)) return null;
  const relative = text.slice(NPM_PREFIX.length, -NPM_SUFFIX.length);
  const segments = relative.split('\\');
  if (segments[0] !== 'node_modules' || segments.length < 3 ||
      segments.some((part) => !/^[A-Za-z0-9_@.+-]+$/.test(part) || part === '.' || part === '..') ||
      !/\.(?:c?js|mjs)$/.test(segments.at(-1))) return null;
  return segments;
}

function resolveWindowsLaunch({ file, args = [], env = process.env,
  platform = process.platform, nodeExecutable = process.execPath, fsApi = fs } = {}) {
  const unsupported = (reason) => ({ mode: 'unsupported', code: 'unsupported_windows_shim', reason });
  if (typeof file !== 'string' || !file || file.includes('\0') || !Array.isArray(args) ||
      args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) return unsupported('invalid_launch_arguments');
  if (platform !== 'win32') return { mode: 'direct', file, args: [...args], envPatch: {}, adapter: 'native' };
  const extension = path.extname(file).toLowerCase();
  if (extension === '.exe' || extension === '.com') {
    if (!path.isAbsolute(file)) return unsupported('absolute_native_executable_required');
    try { assertRegularPath(file, fsApi); }
    catch { return unsupported('unreadable_or_indirect_native_executable'); }
    return { mode: 'direct', file, args: [...args], envPatch: {}, adapter: 'native' };
  }
  if (!['.cmd', '.bat'].includes(extension) || !path.isAbsolute(file)) {
    return unsupported('native_executable_or_known_batch_required');
  }
  try {
    const text = readTemplate(file, fsApi);
    const templateHash = hash(text);
    const template = TEMPLATE_HASHES.get(templateHash);
    const root = path.dirname(file);
    const packageParts = packageScript(text);
    let executable;
    let script;
    let adapter;
    const envPatch = {};
    if (packageParts || template === 'npm' || template === 'npx') {
      script = path.join(root, ...(packageParts || ['node_modules', 'npm', 'bin', `${template}-cli.js`]));
      const localNode = path.join(root, 'node.exe');
      try { fsApi.lstatSync(localNode); executable = localNode; }
      catch (error) { if (error.code !== 'ENOENT') throw error; executable = nodeExecutable; }
      adapter = packageParts ? 'npm-package-shim' : `npm-bundled-${template}`;
    } else if (template === 'cursor') {
      const ps1 = readTemplate(path.join(root, 'cursor-agent.ps1'), fsApi);
      if (hash(ps1) !== CURSOR_PS1_HASH) return unsupported('unqualified_cursor_powershell_template');
      let versionRoot = root;
      try { fsApi.lstatSync(path.join(root, 'node.exe')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const versionsRoot = path.join(root, 'versions');
        const versions = fsApi.readdirSync(versionsRoot, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() &&
            /^\d{4}\.\d{1,2}\.\d{1,2}(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(entry.name))
          .map((entry) => ({ name: entry.name, order: entry.name.match(
            /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-/,
          ).slice(1).map((part) => Number(part || 0)) }))
          .sort((a, b) => {
            for (let index = 0; index < 6; index += 1) {
              const delta = (b.order[index] || 0) - (a.order[index] || 0);
              if (delta) return delta;
            }
            return b.name.localeCompare(a.name);
          });
        if (!versions.length) return unsupported('cursor_runtime_missing');
        versionRoot = path.join(versionsRoot, versions[0].name);
      }
      executable = path.join(versionRoot, 'node.exe');
      script = path.join(versionRoot, 'index.js');
      envPatch.CURSOR_INVOKED_AS = path.basename(file);
      if (!env.NODE_COMPILE_CACHE && env.LOCALAPPDATA) {
        envPatch.NODE_COMPILE_CACHE = path.join(env.LOCALAPPDATA, 'cursor-compile-cache');
      }
      adapter = 'cursor-bundled-node';
    } else return unsupported('unqualified_batch_template');
    if (!path.isAbsolute(executable) || path.extname(executable).toLowerCase() !== '.exe') {
      return unsupported('native_node_executable_required');
    }
    assertRegularPath(executable, fsApi);
    assertRegularPath(script, fsApi);
    return { mode: 'direct', file: executable, args: [script, ...args], envPatch, adapter, templateHash };
  } catch {
    // Paths and shim contents can contain private operator data. Diagnostics
    // expose only the typed qualification outcome, never shell/parser excerpts.
    return unsupported('unreadable_or_unstable_shim_runtime');
  }
}

module.exports = { resolveWindowsLaunch };
