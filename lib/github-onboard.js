'use strict';

// Repo onboarding framework: provision the full GitHub automation stack into
// any repo in ONE action, from a single source of truth
// (templates/github-automations/). Installs BOTH layers — the server-side
// Actions (source of truth) and RelayBridge enrollment (real-time control
// plane) — so every repo gets the identical best-of-both-worlds setup.
//
// Guardrails: operates on a branch, opens a DRAFT PR, never merges, never
// clobbers a newer local template, never touches branch protection/org/billing
// (those are reported as manual steps). Registry enrollment needs a real local
// checkout path — the temporary clone this works in must never become one.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const tracker = require('./github-tracker');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE_DIR = path.join(ROOT, 'templates', 'github-automations');
const CONTRIBUTING_HISTORY_DIR = path.join(TEMPLATE_DIR, 'history');
// Fleet state is runtime state, so it belongs under data/ — the one directory
// .gitignore covers and install.ps1 excludes from the staged release tree. At
// .relaybridge/onboarded.json it was an untracked file in the checkout root:
// it rode into any `git add -A` rescue commit, showed up as a phantom change
// on every other machine, and an upgrade copied one install's fleet list
// forward as if it were shipped content.
const DATA_DIR = path.resolve(
  process.env.RELAYBRIDGE_DATA_DIR || process.env.PS_BRIDGE_DATA_DIR || path.join(ROOT, 'data'));
const FLEET_FILE = path.join(DATA_DIR, 'onboarded.json');
const LEGACY_FLEET_FILE = path.join(ROOT, '.relaybridge', 'onboarded.json');
const ONBOARD_BRANCH = 'chore/relaybridge-onboarding';

// Every gh/git child gets a deadline. Without one a stalled clone (dead
// network, or a credential helper waiting on input) never resolves, and since
// server.js awaits onboardRepo inside the Express handler the HTTP request
// hangs open forever with no response and no error — and upgradeRepos, which
// walks the fleet serially, stops dead on the first hung repo.
const DEFAULT_TIMEOUT_MS = 120000;   // same budget as lib/github-tracker.js's run()
const CLONE_TIMEOUT_MS = 600000;     // a full (non-shallow) clone of a big repo is legitimately slow

const TEMPLATE_TARGETS = [
  { src: 'claim-on-start.yml', dest: '.github/workflows/claim-on-start.yml' },
  { src: 'version-on-merge.yml', dest: '.github/workflows/version-on-merge.yml' },
  { src: 'compute-version.cjs', dest: '.github/scripts/compute-version.cjs' },
  { src: 'pull_request_template.md', dest: '.github/pull_request_template.md' },
  { src: 'CONTRIBUTING-snippet.md', dest: 'CONTRIBUTING.md', appendIfExists: true },
];

function run(bin, args, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...spawnOpts } = opts;
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    let proc;
    try {
      proc = spawn(bin, args, {
        windowsHide: true,
        // No child may sit waiting for a human: this runs in a service with no
        // terminal, so a git credential prompt would only burn the timeout.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' },
        ...spawnOpts,
      });
    } catch (err) { return resolve({ code: -1, stdout, stderr: err.message }); }
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    if (timer.unref) timer.unref();
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + err.message }); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: String(stdout), stderr: String(stderr) }); });
  });
}
const git = (args, opts) => run('git', args, opts);
const gh = (args, opts) => run('gh', args, opts);

function templateVersion(text) {
  const m = String(text).match(/#\s*rb-template\s+v(\d+)/);
  if (m) return Number(m[1]);
  return managedContributingBlock(text)?.version || 0;
}

function managedContributingBlock(text) {
  const value = String(text);
  const beginPattern = /<!-- BEGIN relaybridge-contributing \(rb-template v(\d+)\) -->/g;
  const begins = [...value.matchAll(beginPattern)];
  const endMarker = '<!-- END relaybridge-contributing -->';
  const ends = [];
  for (let at = value.indexOf(endMarker); at !== -1; at = value.indexOf(endMarker, at + endMarker.length)) {
    ends.push(at);
  }
  if (begins.length !== 1 || ends.length !== 1) return null;
  const version = Number(begins[0][1]);
  const start = begins[0].index;
  const end = ends[0] + endMarker.length;
  if (!Number.isSafeInteger(version) || version < 1 || ends[0] < start + begins[0][0].length) return null;
  return { version, start, end, text: value.slice(start, end) };
}

function normalizedManagedBlock(text) {
  return String(text).replace(/\r\n/g, '\n');
}

function knownContributingSnippet(version) {
  try {
    return fs.readFileSync(path.join(CONTRIBUTING_HISTORY_DIR,
      `CONTRIBUTING-snippet.v${version}.md`), 'utf8');
  } catch {
    return null;
  }
}

function planContributingUpdate(existingText, shippedText) {
  const existing = managedContributingBlock(existingText);
  const shipped = managedContributingBlock(shippedText);
  if (!shipped || shipped.start !== 0 || shipped.end !== String(shippedText).trimEnd().length) {
    throw new Error('shipped CONTRIBUTING snippet has malformed managed markers');
  }
  const hasManagedMarker = String(existingText).includes('BEGIN relaybridge-contributing')
    || String(existingText).includes('END relaybridge-contributing');
  if (!hasManagedMarker) {
    return { action: 'append', text: String(existingText).trimEnd() + '\n\n' + String(shippedText) };
  }
  if (!existing) {
    return { action: 'manual', reason: 'managed block is malformed or duplicated' };
  }
  if (existing.version >= shipped.version) {
    return { action: 'skip', reason: `managed rb-template v${existing.version} >= shipped v${shipped.version}` };
  }
  const historicalText = knownContributingSnippet(existing.version);
  const historical = historicalText ? managedContributingBlock(historicalText) : null;
  if (!historical || normalizedManagedBlock(existing.text) !== normalizedManagedBlock(historical.text)) {
    return { action: 'manual', reason: `managed rb-template v${existing.version} was edited or is not a known shipped block` };
  }
  return {
    action: 'replace',
    text: String(existingText).slice(0, existing.start) + shipped.text
      + String(existingText).slice(existing.end),
  };
}

function canonicalVersion() {
  let max = 1;
  for (const t of TEMPLATE_TARGETS) {
    const f = path.join(TEMPLATE_DIR, t.src);
    if (fs.existsSync(f)) max = Math.max(max, templateVersion(fs.readFileSync(f, 'utf8')));
  }
  return max;
}

function loadFleet() {
  try { return JSON.parse(fs.readFileSync(FLEET_FILE, 'utf8')); } catch {}
  // Installs that onboarded repos before the file moved keep their fleet list
  // at the old checkout-root path; the next saveFleet writes the new location.
  try { return JSON.parse(fs.readFileSync(LEGACY_FLEET_FILE, 'utf8')); } catch {}
  return { repos: [] };
}
function saveFleet(fleet) {
  fs.mkdirSync(path.dirname(FLEET_FILE), { recursive: true });
  fs.writeFileSync(FLEET_FILE, JSON.stringify(fleet, null, 2) + '\n', 'utf8');
}

// Main entry. opts: { name: "owner/repo", path?: localPath, cloneUrl? }
async function onboardRepo(opts) {
  const report = { repo: opts.name, installed: [], skipped: [], manual: [], warnings: [] };
  if (!opts.name || !/^[\w.-]+\/[\w.-]+$/.test(opts.name)) throw new Error('name must be owner/repo');

  // 1. Auth + Actions preflight — STOP if it can't push.
  const auth = await gh(['auth', 'status']);
  if (auth.code !== 0) throw new Error('gh auth status failed — sign in with `gh auth login` first:\n' + auth.stderr.trim());
  const scopes = (auth.stderr + auth.stdout);
  if (!/workflow/.test(scopes)) report.warnings.push("gh token may lack 'workflow' scope — pushing workflow files can be rejected. Run: gh auth refresh -s workflow");
  const perm = await gh(['api', `repos/${opts.name}`, '--jq', '.permissions.push']);
  if (perm.code !== 0 || !/true/.test(perm.stdout)) {
    throw new Error(`the active gh account cannot push to ${opts.name} — check which account is active (gh auth status) and repo permissions`);
  }

  // 2. Clone into a private temporary directory and branch off default. Never
  // switch branches in a caller's existing checkout: it may contain unrelated
  // work or be actively used by an IDE. A supplied checkout is registry context
  // only; onboarding happens in a fresh temporary clone of the named GitHub
  // repository.
  //
  // mkdtempSync (0700, unguessable) for BOTH cases now. The no-local-path case
  // used to clone into a fixed os.tmpdir()/rb-onboard/<owner>__<repo>, which was
  // fine on Windows (%TEMP% is per-user) but not on the POSIX port: /tmp is
  // world-readable and world-writable, so any other local account could read a
  // cloned private repo, or pre-create that path as a symlink — mkdirSync
  // recursive follows symlinks — and redirect the clone and every template write
  // into a directory it controls. It was also never removed, so the next
  // onboarding of the same repo silently reused a stale checkout.
  const registryPath = opts.path;
  const hasLocalCheckout = !!(registryPath && fs.existsSync(path.join(registryPath, '.git')));
  const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-onboard-work-'));
  const cwd = path.join(tempParent, opts.name.replace('/', '__'));
  // Returns a warning string instead of throwing: cleanup failure must never
  // mask the real error on a path that is already failing.
  const cleanupClone = () => {
    try { fs.rmSync(tempParent, { recursive: true, force: true }); return null; }
    catch (err) { return `temporary clone cleanup failed: ${err.message}`; }
  };
  // NOT a shallow clone: GitHub rejects pushes from shallow history
  // ("shallow update not allowed"), which would fail at the very last step
  // after all the work was done.
  const clone = await gh(['repo', 'clone', opts.name, cwd], { timeoutMs: CLONE_TIMEOUT_MS });
  if (clone.code !== 0) { cleanupClone(); throw new Error('temporary clone failed: ' + clone.stderr.trim()); }
  await git(['fetch', 'origin'], { cwd });
  const co = await git(['checkout', '-B', ONBOARD_BRANCH], { cwd });
  if (co.code !== 0) { cleanupClone(); throw new Error('could not create onboarding branch: ' + co.stderr.trim()); }

  // 3. Copy templates — never clobber newer/diverged files.
  const canonical = canonicalVersion();
  for (const t of TEMPLATE_TARGETS) {
    const srcFile = path.join(TEMPLATE_DIR, t.src);
    if (!fs.existsSync(srcFile)) { report.warnings.push(`template missing: ${t.src}`); continue; }
    const srcText = fs.readFileSync(srcFile, 'utf8');
    const destFile = path.join(cwd, t.dest);
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    if (fs.existsSync(destFile)) {
      const destText = fs.readFileSync(destFile, 'utf8');
      if (t.appendIfExists) {
        const planned = planContributingUpdate(destText, srcText);
        if (planned.action === 'append') {
          fs.writeFileSync(destFile, planned.text, 'utf8');
          report.installed.push(t.dest + ' (appended)');
        } else if (planned.action === 'replace') {
          fs.writeFileSync(destFile, planned.text, 'utf8');
          report.installed.push(t.dest + ' (updated managed block)');
        } else {
          report.skipped.push(t.dest + ` (${planned.reason})`);
          if (planned.action === 'manual') {
            report.manual.push(`Review ${t.dest}: ${planned.reason}; RelayBridge preserved it byte-for-byte.`);
          }
        }
        continue;
      }
      if (destText === srcText) { report.skipped.push(t.dest + ' (identical)'); continue; }
      // Compare against THIS template's own version, not canonicalVersion().
      // canonicalVersion() is the max across every template, so bumping any one
      // of them raised the bar for all the others and silently re-enabled
      // clobbering of local edits to files that had not changed at all.
      const srcVersion = templateVersion(srcText);
      if (templateVersion(destText) >= srcVersion) {
        report.skipped.push(t.dest + ` (local rb-template v${templateVersion(destText)} >= shipped v${srcVersion} — not clobbering; diff it manually)`);
        continue;
      }
    }
    fs.writeFileSync(destFile, srcText, 'utf8');
    report.installed.push(t.dest);
  }

  // 4. Labels — idempotent creation from labels.json.
  const labelsFile = path.join(TEMPLATE_DIR, 'labels.json');
  if (fs.existsSync(labelsFile)) {
    const labels = JSON.parse(fs.readFileSync(labelsFile, 'utf8'));
    for (const l of labels) {
      // No --force: overwriting a repo's existing same-named label would
      // silently repaint someone else's taxonomy. Existing = skip, not clobber.
      const r = await gh(['label', 'create', l.name, '--repo', opts.name, '--color', l.color || 'ededed', '--description', l.description || '']);
      if (r.code === 0) report.installed.push(`label ${l.name}`);
      else if (/already exists/i.test(r.stderr)) report.skipped.push(`label ${l.name} (already exists — left as-is)`);
      else report.warnings.push(`label ${l.name}: ${r.stderr.trim().slice(0, 120)}`);
    }
  }

  // 5. Enroll in the RelayBridge registry with safe defaults — but ONLY with a
  // real local checkout. registry.path is where every later trackRun runs git,
  // so enrolling `cwd` (the throwaway clone, which used to be the fallback)
  // wrote a temp path into config/github-repos.json permanently: tracking then
  // ran git in a directory that tmp cleanup eventually deletes, repoForCwd
  // claimed any run whose cwd happened to sit under it, and the entry was never
  // corrected because a second onboarding short-circuits on the name.
  const registry = tracker.loadRegistry();
  if (registry.repos.some((r) => r.name === opts.name)) {
    report.skipped.push('registry entry (already enrolled)');
  } else if (hasLocalCheckout) {
    registry.repos.push(tracker.defaultRepoEntry({ name: opts.name, path: registryPath }));
    tracker.saveRegistry(registry);
    report.installed.push('RelayBridge registry entry (autoPush:false, dryRun off, dictateBump on)');
  } else {
    report.skipped.push('registry entry (no local checkout path supplied — onboarding ran in a temporary clone)');
    report.manual.push(`Enroll ${opts.name} for run tracking by re-running onboarding with the path of your local working copy — the temporary clone this ran in is deleted and must never become the registry path.`);
  }

  // 6. Commit, push branch, open DRAFT PR — never merge.
  await git(['add', '--', ...TEMPLATE_TARGETS.map((t) => t.dest)], { cwd });
  const commit = await git(['commit', '-m', `chore: RelayBridge onboarding (rb-template v${canonical})`], { cwd });
  let prNumber = null, prUrl = null;
  if (commit.code === 0) {
    const push = await git(['push', '-u', 'origin', ONBOARD_BRANCH], { cwd });
    if (push.code !== 0) { cleanupClone(); throw new Error('push failed: ' + push.stderr.trim()); }
    const pr = await gh(['pr', 'create', '--draft', '--repo', opts.name, '--head', ONBOARD_BRANCH,
      '--title', 'chore: RelayBridge onboarding — automations, PR template, labels',
      '--body', `Installs the canonical RelayBridge automation stack (rb-template v${canonical}): issue-claim guard, GitHub-native versioning, PR template, and bump labels.\n\nReview and merge when ready — nothing here is auto-merged.`]);
    const m = pr.stdout.match(/\/pull\/(\d+)/);
    prNumber = m ? Number(m[1]) : null;
    prUrl = pr.stdout.trim().split('\n').pop();
  } else {
    report.skipped.push('commit/PR (no file changes — repo already current)');
  }

  // 7. Manual steps that must never be automated.
  report.manual.push(
    "If the default branch is protected: allow github-actions[bot] to bypass push protection (or use a PAT) so version-on-merge.yml can write VERSION/CHANGELOG/tags.",
    "Optionally set repo variable CREATE_RELEASE=true for downloadable Release archives per version.",
    "If using the API summary workflow instead of the Copilot seat: add ANTHROPIC_API_KEY as a repo secret.",
  );

  // 8. Fleet registry.
  const fleet = loadFleet();
  const existing = fleet.repos.find((r) => r.repo === opts.name);
  const entry = { repo: opts.name, templateVersion: canonical, onboardedAt: new Date().toISOString(), prNumber };
  if (existing) Object.assign(existing, entry); else fleet.repos.push(entry);
  saveFleet(fleet);

  tracker.logActivity({ action: 'onboard_repo', repo: opts.name, prNumber, templateVersion: canonical });
  const result = { ...report, prNumber, prUrl, templateVersion: canonical };
  const cleanupWarning = cleanupClone();
  if (cleanupWarning) result.warnings.push(cleanupWarning);
  return result;
}

// Fleet upgrade: re-run onboarding only where installed version < canonical.
async function upgradeRepos() {
  const fleet = loadFleet();
  const canonical = canonicalVersion();
  const results = [];
  for (const r of fleet.repos) {
    if ((r.templateVersion || 0) >= canonical) { results.push({ repo: r.repo, action: 'current' }); continue; }
    try {
      const reg = tracker.loadRegistry().repos.find((x) => x.name === r.repo);
      results.push({ repo: r.repo, action: 'upgraded', result: await onboardRepo({ name: r.repo, path: reg?.path }) });
    } catch (err) { results.push({ repo: r.repo, action: 'failed', error: err.message }); }
  }
  return { canonical, results };
}

module.exports = {
  onboardRepo, upgradeRepos, canonicalVersion, templateVersion, loadFleet,
  managedContributingBlock, planContributingUpdate,
  TEMPLATE_DIR, TEMPLATE_TARGETS,
};
