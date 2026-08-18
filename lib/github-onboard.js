'use strict';

// Repo onboarding framework: provision the full GitHub automation stack into
// any repo in ONE action, from a single source of truth
// (templates/github-automations/). Installs BOTH layers — the server-side
// Actions (source of truth) and RelayBridge enrollment (real-time control
// plane) — so every repo gets the identical best-of-both-worlds setup.
//
// Guardrails: operates on a branch, opens a DRAFT PR, never merges, never
// clobbers a newer local template, never touches branch protection/org/billing
// (those are reported as manual steps).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const tracker = require('./github-tracker');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE_DIR = path.join(ROOT, 'templates', 'github-automations');
const FLEET_FILE = path.join(ROOT, '.relaybridge', 'onboarded.json');
const ONBOARD_BRANCH = 'chore/relaybridge-onboarding';

const TEMPLATE_TARGETS = [
  { src: 'claim-on-start.yml', dest: '.github/workflows/claim-on-start.yml' },
  { src: 'version-on-merge.yml', dest: '.github/workflows/version-on-merge.yml' },
  { src: 'pull_request_template.md', dest: '.github/pull_request_template.md' },
  { src: 'CONTRIBUTING-snippet.md', dest: 'CONTRIBUTING.md', appendIfExists: true },
];

function run(bin, args, opts = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    let proc;
    try { proc = spawn(bin, args, { windowsHide: true, env: process.env, ...opts }); }
    catch (err) { return resolve({ code: -1, stdout, stderr: err.message }); }
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + err.message }));
    proc.on('close', (code) => resolve({ code, stdout: String(stdout), stderr: String(stderr) }));
  });
}
const git = (args, opts) => run('git', args, opts);
const gh = (args, opts) => run('gh', args, opts);

function templateVersion(text) {
  const m = String(text).match(/#\s*rb-template\s+v(\d+)/);
  return m ? Number(m[1]) : 0;
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
  try { return JSON.parse(fs.readFileSync(FLEET_FILE, 'utf8')); } catch { return { repos: [] }; }
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

  // 2. Locate or clone; branch off default.
  let cwd = opts.path;
  if (!cwd || !fs.existsSync(path.join(cwd, '.git'))) {
    cwd = path.join(os.tmpdir(), 'rb-onboard', opts.name.replace('/', '__'));
    fs.mkdirSync(cwd, { recursive: true });
    if (!fs.existsSync(path.join(cwd, '.git'))) {
      // NOT a shallow clone: GitHub rejects pushes from shallow history
      // ("shallow update not allowed"), which would fail at the very last step
      // after all the work was done.
      const clone = await gh(['repo', 'clone', opts.name, cwd]);
      if (clone.code !== 0) throw new Error('clone failed: ' + clone.stderr.trim());
    }
    report.clonedTo = cwd;
  }
  await git(['fetch', 'origin'], { cwd });
  const co = await git(['checkout', '-B', ONBOARD_BRANCH], { cwd });
  if (co.code !== 0) throw new Error('could not create onboarding branch: ' + co.stderr.trim());

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
        if (!destText.includes('BEGIN relaybridge-contributing')) {
          fs.writeFileSync(destFile, destText.trimEnd() + '\n\n' + srcText, 'utf8');
          report.installed.push(t.dest + ' (appended)');
        } else report.skipped.push(t.dest + ' (snippet already present)');
        continue;
      }
      if (destText === srcText) { report.skipped.push(t.dest + ' (identical)'); continue; }
      if (templateVersion(destText) >= canonical) {
        report.skipped.push(t.dest + ` (local rb-template v${templateVersion(destText)} >= canonical v${canonical} — not clobbering; diff it manually)`);
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

  // 5. Enroll in the RelayBridge registry with safe defaults.
  const registry = tracker.loadRegistry();
  if (!registry.repos.some((r) => r.name === opts.name)) {
    registry.repos.push(tracker.defaultRepoEntry({ name: opts.name, path: opts.path || cwd }));
    tracker.saveRegistry(registry);
    report.installed.push('RelayBridge registry entry (autoPush:false, dryRun off, dictateBump on)');
  } else report.skipped.push('registry entry (already enrolled)');

  // 6. Commit, push branch, open DRAFT PR — never merge.
  await git(['add', '-A'], { cwd });
  const commit = await git(['commit', '-m', `chore: RelayBridge onboarding (rb-template v${canonical})`], { cwd });
  let prNumber = null, prUrl = null;
  if (commit.code === 0) {
    const push = await git(['push', '-u', 'origin', ONBOARD_BRANCH], { cwd });
    if (push.code !== 0) throw new Error('push failed: ' + push.stderr.trim());
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
  return { ...report, prNumber, prUrl, templateVersion: canonical };
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

module.exports = { onboardRepo, upgradeRepos, canonicalVersion, templateVersion, loadFleet, TEMPLATE_DIR, TEMPLATE_TARGETS };
