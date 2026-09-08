'use strict';

const { spawn } = require('node:child_process');
const platform = require('./platform');

// Internal git/gh commands are argv calls, not model invocations. Retain only
// a bounded combined output budget and decode once, preserving split UTF-8.
// A timeout/overflow is never a successful command, even if a child exits 0.
function runBoundedCommand(file, args, {
  timeoutMs = 120000, maxOutputBytes = 1024 * 1024, cwd, env = process.env,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000 ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 16 * 1024 * 1024) {
    return Promise.reject(new TypeError('invalid command resource limit'));
  }
  return new Promise((resolve) => {
    const stdout = [], stderr = [];
    let bytes = 0, failure = null, settled = false, timer, child;
    const finish = (code, spawnError = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: failure || spawnError ? -1 : code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: spawnError ? String(spawnError.message).slice(0, 1000) : Buffer.concat(stderr).toString('utf8'),
        failure: failure || (spawnError ? 'command_spawn_failed' : null),
      });
    };
    const stop = (reason) => {
      if (settled || failure) return;
      failure = reason;
      platform.killTree(child);
    };
    const collect = (parts, data) => {
      if (failure) return;
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const remaining = maxOutputBytes - bytes;
      if (buffer.length <= remaining) { parts.push(buffer); bytes += buffer.length; }
      else {
        if (remaining > 0) parts.push(buffer.subarray(0, remaining));
        bytes = maxOutputBytes;
        stop('command_output_limit');
      }
    };
    try {
      child = spawn(file, args, {
        cwd, env, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) { finish(-1, error); return; }
    timer = setTimeout(() => stop('command_timeout'), timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (data) => collect(stdout, data));
    child.stderr.on('data', (data) => collect(stderr, data));
    child.once('error', (error) => finish(-1, error));
    child.once('close', (code) => finish(code));
  });
}

module.exports = { runBoundedCommand };
