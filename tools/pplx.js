#!/usr/bin/env node
// Perplexity bridge for RelayBridge — uses your Perplexity SUBSCRIPTION, not an API key.
//
// PRIMARY (subscription) mode: shells out to `pwm`, the community CLI
// `perplexity-web-mcp-cli` (https://github.com/jacob-bd/perplexity-web-mcp).
// `pwm` drives Perplexity's web interface with your logged-in account session
// (run `pwm login` once — email + one-time code). Works with a free or Pro
// account. No separate API billing, but calls consume the account's normal
// Perplexity web/search quota.
//
// OPTIONAL FALLBACK (api) mode: the official Perplexity HTTP API is used only
// when both an API key and PPLX_ALLOW_PAID_API_FALLBACK=1 are present. The
// bridge never silently converts a subscription/auth/rate-limit failure into
// paid API usage.
//
// Modes:
//   node tools/pplx.js --check  # verify pwm + authentication without querying
//   node tools/pplx.js --once   # read prompt on stdin, print one answer, exit (Collab Mode)
//   node tools/pplx.js          # interactive REPL (terminal session)
//
// One-time setup for subscription mode:
//   pip install perplexity-web-mcp-cli      (or: pipx install / uv tool install)
//   pwm login                               (authenticate with your Perplexity account)
// Optional: PPLX_MODEL=<name> (default: auto). Validate current names with
// `pwm ask --help`; the wrapper intentionally does not freeze a stale list.

const { spawnSync, spawn } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const IS_WIN = process.platform === 'win32';
const ONCE = process.argv.includes('--once');
const CHECK = process.argv.includes('--check');
const MODEL = (process.env.PPLX_MODEL || '').trim();
const API_KEY = process.env.PERPLEXITY_API_KEY || process.env.PPLX_API_KEY || '';
const ALLOW_PAID_API_FALLBACK = /^(1|true|yes)$/i.test(process.env.PPLX_ALLOW_PAID_API_FALLBACK || '');
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

// ---- locate the community `pwm` CLI -------------------------------------
// pip / pipx / uv install console scripts to assorted dirs that are not always
// on PATH. Probe PATH first (where/which), then the usual install locations.
let _pwmCache;
function findPwm() {
  if (_pwmCache !== undefined) return _pwmCache;
  const ok = (p) => { try { return p && fs.existsSync(p) ? p : null; } catch { return null; } };
  try {
    const r = spawnSync(IS_WIN ? 'where' : 'which', ['pwm'], { encoding: 'utf8' });
    if (r.status === 0) {
      const hit = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      if (ok(hit)) return (_pwmCache = hit);
    }
  } catch {}
  const home = os.homedir();
  const names = IS_WIN ? ['pwm.exe', 'pwm.cmd', 'pwm'] : ['pwm'];
  const dirs = [path.join(home, '.local', 'bin')];
  for (const d of dirs) {
    for (const n of names) {
      const p = ok(path.join(d, n));
      if (p) return (_pwmCache = p);
    }
  }
  return (_pwmCache = null);
}

function checkSubscription() {
  const pwm = findPwm();
  if (!pwm) return { ok: false, detail: 'pwm is not installed' };
  if (IS_WIN && !/\.exe$/i.test(pwm)) {
    return { ok: false, detail: 'pwm must resolve to an .exe on Windows; refusing an unsafe shell shim' };
  }
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  const versionRun = spawnSync(pwm, ['--version'], { encoding: 'utf8', windowsHide: true, env });
  const authRun = spawnSync(pwm, ['login', '--check'], {
    encoding: 'utf8', windowsHide: true, env, timeout: 15000,
  });
  const version = ((versionRun.stdout || versionRun.stderr || '').replace(ANSI, '').trim().split(/\r?\n/)[0] || 'pwm');
  if (authRun.error) return { ok: false, version, detail: authRun.error.message };
  if (authRun.status !== 0) return { ok: false, version, detail: 'pwm is installed but not authenticated; run pwm login' };
  return { ok: true, version, detail: 'subscription CLI authenticated' };
}

// pwm takes the prompt as a command-line argument; Windows caps a process
// command line near 32k chars, and a long group-chat transcript can exceed
// that (spawn ENAMETOOLONG). Keep the instruction head + the most recent
// tail — the part Perplexity actually needs to answer the latest message.
function capForArgv(p) {
  const MAX = 12000;
  if (!p || p.length <= MAX) return p;
  const head = 1600;
  return p.slice(0, head) +
    '\n\n...[earlier conversation trimmed to fit Perplexity\'s input limit]...\n\n' +
    p.slice(p.length - (MAX - head));
}

function cleanPwmOutput(value) {
  const text = String(value || '').replace(ANSI, '').trim();
  // pwm prints useful routing/quota diagnostics after the answer. Keep those
  // in the CLI itself, but do not inject them as if they were chat content.
  return text.split(/\r?\n---\r?\n\r?\nRouting:/i)[0].trim();
}

// ---- subscription-mode query via pwm ------------------------------------
function askPwm(prompt) {
  return new Promise((resolve, reject) => {
    const pwm = findPwm();
    if (!pwm) {
      return reject(new Error(
        'Perplexity subscription CLI (pwm) is not installed.\n' +
        'Install it once:  pip install perplexity-web-mcp-cli\n' +
        'Then sign in (no API key needed):  pwm login'
      ));
    }
    if (IS_WIN && !/\.exe$/i.test(pwm)) {
      return reject(new Error(
        'Refusing to pass a prompt through a Windows shell shim. Install pwm as an executable with uv or pipx.'
      ));
    }
    const args = ['ask', capForArgv(prompt), '--source', 'all'];
    if (MODEL && MODEL.toLowerCase() !== 'auto') args.push('-m', MODEL);
    let proc;
    try {
      // Spawn the resolved executable directly. Never put a user prompt through
      // cmd.exe or another shell parser on Windows.
      // PYTHONUTF8 / PYTHONIOENCODING force pwm (a Python app) to emit UTF-8 to
      // the pipe instead of the Windows ANSI code page — otherwise smart quotes
      // and dashes in answers arrive as mojibake (Google�s, �agentic�).
      proc = spawn(pwm, args, {
        windowsHide: true,
        shell: false,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      });
    } catch (e) {
      return reject(new Error('Failed to run pwm: ' + e.message));
    }
    let out = '', err = '';
    // setEncoding('utf8') decodes via a StringDecoder that correctly handles
    // multi-byte characters split across chunk boundaries.
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', (e) => reject(new Error('Failed to run pwm: ' + e.message)));
    proc.on('close', (code) => {
      const rawText = (out || '').replace(ANSI, '').trim();
      const text = cleanPwmOutput(rawText);
      const semanticError = /^(?:error\s*\(|responseparsingerror\b)|failed to parse api response/i.test(rawText);
      if (code === 0 && text && !semanticError) return resolve(text);
      const tail = ((err || '') + '\n' + (out || '')).replace(ANSI, '').trim();
      reject(new Error(
        (text ? text + '\n\n' : '') +
        'pwm exited with code ' + code + '. ' +
        (tail ? tail.slice(0, 600) + ' ' : '') +
        'If this is an authentication error, run:  pwm login'
      ));
    });
  });
}

// ---- fallback: official Perplexity HTTP API -----------------------------
function askApi(prompt) {
  return new Promise((resolve, reject) => {
    const model = MODEL && MODEL.toLowerCase() !== 'auto' ? MODEL : 'sonar';
    const body = JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] });
    let settled = false;
    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const req = https.request({
      hostname: 'api.perplexity.ai',
      path: '/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        data += d;
        if (data.length > 2 * 1024 * 1024) req.destroy(new Error('Perplexity API response exceeded 2 MiB'));
      });
      res.on('end', () => {
        if (settled) return;
        try {
          const j = JSON.parse(data);
          if (res.statusCode < 200 || res.statusCode >= 300 || j.error) {
            const detail = j.error && (j.error.message || JSON.stringify(j.error));
            return finishReject(new Error('Perplexity API HTTP ' + res.statusCode + ': ' + (detail || data.slice(0, 200))));
          }
          const t = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (!t) return finishReject(new Error('Empty API response: ' + data.slice(0, 200)));
          const urls = [
            ...(Array.isArray(j.citations) ? j.citations : []),
            ...(Array.isArray(j.search_results) ? j.search_results.map((item) => item && item.url) : []),
          ].filter((url, index, all) => typeof url === 'string' && url && all.indexOf(url) === index);
          settled = true;
          resolve(urls.length ? t + '\n\nSources:\n' + urls.map((url) => '- ' + url).join('\n') : t);
        } catch (e) {
          finishReject(new Error('Bad JSON from Perplexity API: ' + data.slice(0, 200)));
        }
      });
    });
    req.setTimeout(120000, () => req.destroy(new Error('Perplexity API request timed out')));
    req.on('error', finishReject);
    req.write(body);
    req.end();
  });
}

// ---- unified ask: subscription first, API fallback ----------------------
async function ask(prompt) {
  if (findPwm()) {
    try {
      return await askPwm(prompt);
    } catch (subscriptionError) {
      if (API_KEY && ALLOW_PAID_API_FALLBACK) {
        try {
          return await askApi(prompt);
        } catch (apiError) {
          throw new Error('Subscription call failed: ' + subscriptionError.message + '\nPaid API fallback also failed: ' + apiError.message);
        }
      }
      const note = API_KEY && !ALLOW_PAID_API_FALLBACK
        ? '\nPaid API fallback is disabled. Set PPLX_ALLOW_PAID_API_FALLBACK=1 to opt in.'
        : '';
      throw new Error(subscriptionError.message + note);
    }
  }
  if (API_KEY && ALLOW_PAID_API_FALLBACK) return askApi(prompt);
  throw new Error(
    'Perplexity is not set up.\n' +
    'Recommended (uses your Perplexity subscription, no API key):\n' +
    '  pip install perplexity-web-mcp-cli\n' +
    '  pwm login\n' +
    (API_KEY
      ? 'A paid API key is present but fallback is disabled; set PPLX_ALLOW_PAID_API_FALLBACK=1 to opt in.'
      : 'To use the paid API instead, set PERPLEXITY_API_KEY and PPLX_ALLOW_PAID_API_FALLBACK=1.')
  );
}

// ---- entry points -------------------------------------------------------
function fail(msg, code = 1) { process.stderr.write(msg + '\n'); process.exit(code); }

if (CHECK) {
  const status = checkSubscription();
  if (status.ok) {
    console.log('ready: ' + status.version + '; ' + status.detail);
    process.exit(0);
  }
  if (API_KEY && ALLOW_PAID_API_FALLBACK) {
    console.log('ready: paid Perplexity API fallback explicitly enabled');
    process.exit(0);
  }
  fail('not ready: ' + status.detail);
} else if (ONCE) {
  let stdin = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { stdin += d; });
  process.stdin.on('end', async () => {
    const prompt = stdin.trim();
    if (!prompt) fail('Error: empty prompt on stdin');
    try {
      process.stdout.write((await ask(prompt)) + '\n');
    } catch (e) {
      fail(e.message);
    }
  });
} else {
  const mode = findPwm()
    ? 'subscription (pwm)'
    : (API_KEY && ALLOW_PAID_API_FALLBACK ? 'paid API (explicit opt-in)' : 'NOT CONFIGURED');
  console.log('Perplexity bridge — mode: ' + mode);
  if (mode === 'NOT CONFIGURED') {
    console.log('Set up with:  pip install perplexity-web-mcp-cli  &&  pwm login');
  }
  console.log('Type a prompt, blank line to send, /exit to quit.\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let buf = [];
  rl.setPrompt('you> ');
  rl.prompt();
  rl.on('line', async (line) => {
    if (line.trim() === '/exit' || line.trim() === '/quit') { rl.close(); return; }
    if (line === '') {
      if (!buf.length) { rl.prompt(); return; }
      const prompt = buf.join('\n').trim();
      buf = [];
      try {
        console.log('\nperplexity> ' + (await ask(prompt)) + '\n');
      } catch (e) {
        console.error('\n[error] ' + e.message + '\n');
      }
      rl.prompt();
    } else {
      buf.push(line);
    }
  });
  rl.on('close', () => process.exit(0));
}
