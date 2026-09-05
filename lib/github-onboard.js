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
const tracker = require('./github-tracker');
const { runBoundedCommand } = require('./bounded-command');
const { gitEnvironment, validateCheckoutIdentity, prepareTemplateTargets, publishTemplateTargets } = require('./onboard-safety');

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
  { src: 'claim-issues.cjs', dest: '.github/scripts/claim-issues.cjs' },
  { src: 'version-on-merge.yml', dest: '.github/workflows/version-on-merge.yml' },
  { src: 'compute-version.cjs', dest: '.github/scripts/compute-version.cjs' },
  { src: 'pull_request_template.md', dest: '.github/pull_request_template.md' },
  { src: 'CONTRIBUTING-snippet.md', dest: 'CONTRIBUTING.md', appendIfExists: true },
];

function run(bin, args, opts = {}) {
  return runBoundedCommand(bin, args, {
    timeoutMs: DEFAULT_TIMEOUT_MS, ...opts, env: gitEnvironment(opts.env || process.env),
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
async function onboardRepo(opts, dependencies = {}) {
  const gitRun = dependencies.git || git;
  const ghRun = dependencies.gh || gh;
  const registryApi = dependencies.tracker || tracker;
  const readFleet = dependencies.loadFleet || loadFleet;
  const writeFleet = dependencies.saveFleet || saveFleet;
  const report = { repo: opts.name, installed: [], skipped: [], manual: [], warnings: [] };
  if (!opts.name || !/^[\w.-]+\/[\w.-]+$/.test(opts.name) || opts.name.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('name must be owner/repo');
  }
  // A supplied checkout is authority, not a hint. Validate it before any
  // clone, branch, label, template or registry side effect. Inspect effective
  // fetch AND push URLs, including Git insteadOf/pushInsteadOf rewrites.
  const pathSupplied = opts.path !== undefined && opts.path !== null;
  if (pathSupplied && (typeof opts.path !== 'string' || !opts.path.trim())) {
    throw Object.assign(new Error('invalid_onboarding_checkout_path'), { code: 'invalid_onboarding_checkout_path' });
  }
  const registryPath = pathSupplied ? registryApi.normalizeRepoPath(opts.path) : '';
  const checkout = registryPath ? await validateCheckoutIdentity({
    requestedRepo: opts.name, checkoutPath: registryPath, gitRun,
  }) : null;
  const verifyRegistryConflict = (registry) => {
    const existing = registry.repos.find((row) => row.name.toLowerCase() === opts.name.toLowerCase());
    if (existing && checkout && registryApi.normalizeRepoPath(existing.path) !== checkout.canonicalRoot) {
      throw Object.assign(new Error('onboarding_registry_path_conflict'), { code: 'onboarding_registry_path_conflict' });
    }
    return existing;
  };
  verifyRegistryConflict(registryApi.loadRegistry(undefined, { migrate: false }));

  // 1. Auth + Actions preflight — STOP if it can't push.
  const auth = await ghRun(['auth', 'status']);
  if (auth.code !== 0) throw new Error('gh auth status failed — sign in with `gh auth login` first:\n' + auth.stderr.trim());
  const scopes = (auth.stderr + auth.stdout);
  if (!/workflow/.test(scopes)) report.warnings.push("gh token may lack 'workflow' scope — pushing workflow files can be rejected. Run: gh auth refresh -s workflow");
  const perm = await ghRun(['api', `repos/${opts.name}`, '--jq', '.permissions.push']);
  if (perm.code !== 0 || perm.stdout.trim() !== 'true') {
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
  // Resolve the checkout through the same platform-aware validator used by
  // load/save. On WSL this both canonicalizes symlinks into the Linux-native
  // tree and rejects Windows drive or /mnt paths before they can become a
  // silently dead enrollment.
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
  let primaryFailure = null;
  try {
  const clone = await ghRun(['repo', 'clone', `https://github.com/${opts.name}.git`, cwd], { timeoutMs: CLONE_TIMEOUT_MS });
  if (clone.code !== 0) throw new Error('temporary clone failed: ' + clone.stderr.trim());
  await validateCheckoutIdentity({ requestedRepo: opts.name, checkoutPath: cwd, gitRun });
  const fetched = await gitRun(['fetch', 'origin'], { cwd });
  if (fetched.code !== 0) throw new Error('temporary clone fetch failed: ' + fetched.stderr.trim());
  const co = await gitRun(['checkout', '-B', ONBOARD_BRANCH], { cwd });
  if (co.code !== 0) throw new Error('could not create onboarding branch: ' + co.stderr.trim());

  // 3. Copy templates — never clobber newer/diverged files.
  const canonical = canonicalVersion();
  const targetPlan = await prepareTemplateTargets({ root: cwd,
    relativePaths: TEMPLATE_TARGETS.map((target) => target.dest), gitRun });
  const targets = new Map(targetPlan.targets.map((target) => [target.relative, target]));
  const writes = [];
  for (const t of TEMPLATE_TARGETS) {
    const srcFile = path.join(TEMPLATE_DIR, t.src);
    if (!fs.existsSync(srcFile)) { report.warnings.push(`template missing: ${t.src}`); continue; }
    const srcText = fs.readFileSync(srcFile, 'utf8');
    const destText = targets.get(t.dest).text;
    if (destText !== null) {
      if (t.appendIfExists) {
        const planned = planContributingUpdate(destText, srcText);
        if (planned.action === 'append') {
          writes.push({ relative: t.dest, content: planned.text });
          report.installed.push(t.dest + ' (appended)');
        } else if (planned.action === 'replace') {
          writes.push({ relative: t.dest, content: planned.text });
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
    writes.push({ relative: t.dest, content: srcText });
    report.installed.push(t.dest);
  }
  publishTemplateTargets({ plan: targetPlan, writes });

  // 4. Labels — idempotent creation from labels.json.
  const labelsFile = path.join(TEMPLATE_DIR, 'labels.json');
  if (fs.existsSync(labelsFile)) {
    const labels = JSON.parse(fs.readFileSync(labelsFile, 'utf8'));
    for (const l of labels) {
      // No --force: overwriting a repo's existing same-named label would
      // silently repaint someone else's taxonomy. Existing = skip, not clobber.
      const r = await ghRun(['label', 'create', l.name, '--repo', opts.name, '--color', l.color || 'ededed', '--description', l.description || '']);
      if (r.code === 0) report.installed.push(`label ${l.name}`);
      else if (/already exists/i.test(r.stderr)) report.skipped.push(`label ${l.name} (already exists — left as-is)`);
      else report.warnings.push(`label ${l.name}: ${r.stderr.trim().slice(0, 120)}`);
    }
  }

  // 5. Enroll in the RelayBridge registry with safe defaults — but ONLY with a
  // real local checkout. registry.path is where every later trackRun runs git,
  // so enrolling `cwd` (the throwaway clone, which used to be the fallback)
  // wrote a temp path into the legacy config/github-repos.json permanently:
  // tracking then
  // ran git in a directory that tmp cleanup eventually deletes, repoForCwd
  // claimed any run whose cwd happened to sit under it, and the entry was never
  // corrected because a second onboarding short-circuits on the name.
  // 6. Commit, push branch, open DRAFT PR — never merge.
  const added = await gitRun(['add', '--', ...TEMPLATE_TARGETS.map((t) => t.dest)], { cwd });
  if (added.code !== 0) throw new Error('could not stage onboarding templates: ' + added.stderr.trim());
  const changed = await gitRun(['diff', '--cached', '--quiet', '--exit-code'], { cwd });
  if (![0, 1].includes(changed.code)) throw new Error('could not inspect staged onboarding changes');
  let prNumber = null, prUrl = null;
  if (changed.code === 1) {
    const commit = await gitRun(['commit', '-m', `chore: RelayBridge onboarding (rb-template v${canonical})`], { cwd });
    if (commit.code !== 0) throw new Error('onboarding commit failed: ' + commit.stderr.trim());
    const push = await gitRun(['push', '-u', 'origin', ONBOARD_BRANCH], { cwd });
    if (push.code !== 0) throw new Error('push failed: ' + push.stderr.trim());
    const pr = await ghRun(['pr', 'create', '--draft', '--repo', opts.name, '--head', ONBOARD_BRANCH,
      '--title', 'chore: RelayBridge onboarding — automations, PR template, labels',
      '--body', `Installs the canonical RelayBridge automation stack (rb-template v${canonical}): issue-claim guard, GitHub-native versioning, PR template, and bump labels.\n\nReview and merge when ready — nothing here is auto-merged.`]);
    if (pr.code !== 0) throw new Error('draft PR creation failed: ' + pr.stderr.trim());
    const m = pr.stdout.match(/\/pull\/(\d+)/);
    prNumber = m ? Number(m[1]) : null;
    prUrl = pr.stdout.trim().split('\n').pop();
  } else {
    report.skipped.push('commit/PR (no file changes — repo already current)');
  }

  // Revalidate the caller before enrollment; the temporary clone is never a
  // registry target, and a failed commit/PR cannot report completed enrollment.
  if (checkout) {
    const current = await validateCheckoutIdentity({ requestedRepo: opts.name,
      checkoutPath: checkout.canonicalRoot, gitRun });
    if (current.rootIdentity !== checkout.rootIdentity) throw new Error('onboarding_checkout_changed');
  }
  const registry = registryApi.loadRegistry();
  if (verifyRegistryConflict(registry)) {
    report.skipped.push('registry entry (already enrolled)');
  } else if (checkout) {
    registry.repos.push(registryApi.defaultRepoEntry({ name: opts.name, path: checkout.canonicalRoot }));
    registryApi.saveRegistry(registry);
    report.installed.push('RelayBridge registry entry (autoPush:false, dryRun off, dictateBump on)');
  } else {
    report.skipped.push('registry entry (no local checkout path supplied — onboarding ran in a temporary clone)');
    report.manual.push(`Enroll ${opts.name} by re-running onboarding with your local working-copy path; the temporary clone is deleted.`);
  }

  // 7. Manual steps that must never be automated.
  report.manual.push(
    "If the default branch is protected: allow github-actions[bot] to bypass push protection (or use a PAT) so version-on-merge.yml can write VERSION/CHANGELOG/tags.",
    "Optionally set repo variable CREATE_RELEASE=true for downloadable Release archives per version.",
    "If using the API summary workflow instead of the Copilot seat: add ANTHROPIC_API_KEY as a repo secret.",
  );

  // 8. Fleet registry.
  const fleet = readFleet();
  const existing = fleet.repos.find((r) => r.repo === opts.name);
  const entry = { repo: opts.name, templateVersion: canonical, onboardedAt: new Date().toISOString(), prNumber };
  if (existing) Object.assign(existing, entry); else fleet.repos.push(entry);
  writeFleet(fleet);

  registryApi.logActivity({ action: 'onboard_repo', repo: opts.name, prNumber, templateVersion: canonical });
  const result = { ...report, prNumber, prUrl, templateVersion: canonical };
  return result;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    const cleanupWarning = cleanupClone();
    if (cleanupWarning) {
      report.warnings.push(cleanupWarning);
      if (primaryFailure) {
        primaryFailure.message += '; temporary clone cleanup failed (private clone retained)';
        primaryFailure.cleanupFailure = { code: 'onboarding_cleanup_failed', retainedPath: tempParent };
      }
    }
  }
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
