'use strict';

// Refresh Claude Code's own usage cache through its local `/usage` UI. The
// terminal is deliberately opaque: quota authority comes only from a newer,
// identity-bound native cache sample read by the caller.
function refreshClaudeUsageViaPty({
  ptyImpl,
  command,
  args = [],
  env,
  cwd,
  readSample,
  expectedIdentity,
  baselineFetchedAt = null,
  timeoutMs = 15000,
  pollMs = 100,
  exitGraceMs = 750,
} = {}) {
  return new Promise((resolve) => {
    let proc = null;
    let settled = false;
    let stopping = false;
    let outcome = null;
    let timeout = null;
    let poll = null;
    let force = null;
    let terminal = '';
    let usageSent = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout); clearInterval(poll); clearTimeout(force);
      resolve(value);
    };
    const stop = (value) => {
      if (stopping || settled) return;
      stopping = true; outcome = value;
      try { proc?.kill(); } catch {}
      force = setTimeout(() => {
        try { proc?.kill('SIGKILL'); } catch {}
        finish(outcome);
      }, exitGraceMs);
    };
    const sameIdentity = (sample) => !!sample?.identity
      && sample.identity.accountFingerprint === expectedIdentity?.accountFingerprint
      && sample.identity.profileHash === expectedIdentity?.profileHash;
    const inspect = () => {
      let sample;
      try { sample = readSample(); } catch { return; }
      const observedAt = sample?.observation?.observedAt;
      if (sameIdentity(sample) && Number.isSafeInteger(observedAt)
        && observedAt > (Number.isSafeInteger(baselineFetchedAt) ? baselineFetchedAt : 0)) {
        if (proc) stop({ refreshed: true, sample });
        else finish({ refreshed: true, sample });
      }
    };
    if (!ptyImpl?.spawn || typeof command !== 'string' || !command
      || typeof readSample !== 'function' || !expectedIdentity) {
      finish({ refreshed: false, reason: 'probe_unavailable' }); return;
    }
    inspect();
    if (settled) return;
    try {
      proc = ptyImpl.spawn(command, args, {
        name: 'xterm-256color', cols: 80, rows: 24, cwd, env,
      });
    } catch {
      finish({ refreshed: false, reason: 'probe_unavailable' }); return;
    }
    proc.onData?.((data) => {
      // UI text is used only to prove that the main input screen is ready. It
      // is capped, stripped in memory and never returned, logged or parsed for
      // quota. Known interactive gates fail closed without sending Enter.
      terminal = (terminal + String(data || '')).slice(-32768)
        .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ');
      // Claude draws words using cursor-positioning escapes. Stripping those
      // escapes can join visible words, so gate/readiness matching uses a
      // whitespace-free view of the bounded terminal buffer.
      const compactTerminal = terminal.replace(/\s/g, '').toLowerCase();
      if (compactTerminal.includes('quicksafetycheck:')
        || compactTerminal.includes('doyoutrustthefilesinthisfolder')) {
        stop({ refreshed: false, reason: 'probe_interactive_gate' }); return;
      }
      if (!usageSent && /claudecodev\d/.test(compactTerminal)
        && (compactTerminal.includes('forshortcuts') || compactTerminal.includes('planmodeon'))
        && terminal.includes('❯')) {
        usageSent = true;
        try { proc.write('/usage\r'); }
        catch { stop({ refreshed: false, reason: 'probe_write_failed' }); }
      }
    });
    proc.onExit?.(() => finish(outcome || { refreshed: false, reason: 'probe_exited' }));
    poll = setInterval(inspect, Math.max(25, pollMs));
    timeout = setTimeout(() => stop({ refreshed: false, reason: 'probe_timeout' }), Math.max(250, timeoutMs));
    // If no recognized main input screen appears, no bytes are written and the
    // probe times out. Trust, auth, onboarding and permission prompts therefore
    // cannot be accepted by an accidental carriage return.
  });
}

module.exports = { refreshClaudeUsageViaPty };
