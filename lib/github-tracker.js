'use strict';

// GitHub integration middleware for RelayBridge.
//
// Activates only for runs whose working directory sits inside an *enrolled*
// repo (config/github-repos.json); it is a strict no-op otherwise. After a
// provider run finishes, it: detects changes, stages them (gitignore PLUS a
// hard secret skip-list), makes a checkpoint commit attributed to the run,
// optionally pushes, appends a DEVLOG entry, keeps a sticky issue/PR comment
// current, ensures a draft PR exists, and applies the bump label that the
// repo-side version-on-merge.yml Action turns into a real vX.Y.Z tag on merge.
//
// Division of labor (do not blur it):
//   - RelayBridge DICTATES the bump (a PR label) and READS version history.
//   - GitHub (version-on-merge.yml in the project repo) OWNS the version:
//     tags, CHANGELOG, Releases. This module never creates, moves, or deletes
//     tags, never writes VERSION, and never touches the default branch.
//
// Everything here is fire-and-forget relative to the provider response: the
// caller gets its one-shot result immediately; tracking failures are logged
// and surfaced via /api/github/activity, never propagated into the run.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY_FILE = process.env.RELAYBRIDGE_GITHUB_REPOS
  || path.join(ROOT, 'config', 'github-repos.json');

// Hard secret skip-list. Enforced even when a file is NOT gitignored: a
// credential accidentally dropped into a repo must never ride a checkpoint
// commit. Matched against the basename and the repo-relative path.
const SECRET_PATTERNS = [
  /^\.env(\..*)?$/i,
  /^\.(npmrc|netrc|pgpass|pypirc|envrc|dockercfg)$/i,
  /\.env$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i, /\.p12$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /credentials?(\.json|\.xml|\.yml|\.yaml)?$/i,
  /^\.bridge-token$/i,
  /secrets?\.(json|ya?ml|toml|env)$/i,
  /\.(kdbx|keystore|jks)$/i,
  /(^|[._-])token([._-]|$)/i,
  // The extension tail is restricted to credential-bearing formats on purpose.
  // With the old `(?:\.[^.]+)?` tail this matched ANY file whose name merely
  // ends in token/credential/secret, so ordinary source files (src/tokens.ts,
  // lib/secret.py, docs/design-secrets.md) were dropped from the staged set —
  // the checkpoint commit was still made and reported tracked:true with the
  // real work silently absent from it. Extensionless names and the credential
  // formats still match, as do token.json / secrets.yaml via the patterns above.
  // Fail CLOSED on the extension: an UNKNOWN tail is treated as a credential.
  // A closed allow-list of credential formats was tried and is wrong — it lets
  // credentials.pem, token.p12, auth-secret.jks and every other unlisted
  // key format through into a staged commit. The real complaint it was fixing
  // (ordinary sources like src/tokens.ts or lib/secret.py being dropped from a
  // checkpoint) is solved by excluding SOURCE extensions instead, so anything
  // we have not thought of still errs toward not committing it.
  /(?:access|api|auth|refresh)?(?:token|credential|secret)s?(?:\.(?!(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|h|cc|cpp|hpp|cs|swift|kt|kts|scala|ex|exs|lua|pl|r|m|mm|sql|md|mdx|rst|html?|css|scss|less|vue|svelte|astro|snap|lock|map)$)[^.]+)?$/i,
  /(^|[._-])(?:deploy|private|ssh)[._-]?key(?:[._-]|$)/i,
  /(^|[\\/])\.docker[\\/]config\.json$/i,
  /(^|[._-])(?:service[._-]?account(?:[._-]?key)?|gcp[._-]?key|sa[._-]?key)(?:[._-][^\\/]*)?\.json$/i,
];

const BUMP_LEVELS = new Set(['patch', 'minor', 'major']);

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function defaultRepoEntry(partial = {}) {
  return {
    name: '',
    path: '',
    autoCommit: true,
    autoPush: false,               // opt-in per repo — safe default
    dryRun: false,                 // log intended actions without doing them
    trackingMode: 'checkpoint-on-branch', // or 'mirror-branch'
    branchPrefix: 'relaybridge/',
    devlogPath: 'docs/DEVLOG.md',
    openDraftPr: true,
    summaryProvider: 'copilot',
    versioning: {
      dictateBump: true,
      defaultBump: 'patch',
      mirrorFromGitHub: true,
    },
    ...partial,
    versioning: { dictateBump: true, defaultBump: 'patch', mirrorFromGitHub: true, ...(partial.versioning || {}) },
  };
}

function loadRegistry(file = REGISTRY_FILE) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { repos: [] }; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) {
    throw new Error(`github-repos.json is not valid JSON: ${err.message}`);
  }
  const repos = Array.isArray(parsed.repos) ? parsed.repos.map((r) => defaultRepoEntry(r)) : [];
  for (const repo of repos) {
    if (!repo.name || !/^[\w.-]+\/[\w.-]+$/.test(repo.name)) {
      throw new Error(`registry entry has invalid repo name: ${JSON.stringify(repo.name)}`);
    }
    if (!repo.path) throw new Error(`registry entry ${repo.name} has no local path`);
    if (!['checkpoint-on-branch', 'mirror-branch'].includes(repo.trackingMode)) {
      throw new Error(`registry entry ${repo.name} has unknown trackingMode ${repo.trackingMode}`);
    }
  }
  return { repos };
}

function saveRegistry(registry, file = REGISTRY_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(registry, null, 2) + '\n', 'utf8');
}

// Longest-prefix match so nested enrolled repos resolve to the deepest one.
//
// Normalization is deliberately platform-aware. This used to lowercase both
// sides unconditionally, which is right on Windows and WRONG everywhere else:
// on a case-sensitive filesystem /home/u/Projects/app and /home/u/projects/app
// are two different directories, yet a run in the first matched the enrolled
// second — and since trackRun then runs git in repo.path, not in meta.cwd, it
// would checkpoint (and with autoPush push, and comment on the linked issue)
// whatever happened to be dirty in the enrolled repo on behalf of a run that
// never touched it. Both sides also go through realpath so a workspace reached
// through a symlink still matches its enrolled root instead of silently
// no-opping.
function repoForCwd(cwd, registry = loadRegistry()) {
  if (!cwd) return null;
  const cased = (v) => (process.platform === 'win32' ? v.toLowerCase() : v);
  const norm = (p) => {
    const resolved = path.resolve(String(p)).replace(/[\\/]+$/, '');
    // realpath only works on a path that exists, and a registry root (or a cwd
    // that has not been created yet) may not — so resolve the deepest ancestor
    // that does and re-attach the tail. Both sides must normalize the same way
    // or an existing cwd under a symlinked root would stop matching its own
    // enrolled root (/var -> /private/var on macOS is the common case).
    let head = resolved, tail = '';
    for (;;) {
      let real = null;
      try { real = fs.realpathSync.native(head); } catch {}
      if (real !== null) return cased(tail ? path.join(real, tail) : real);
      const parent = path.dirname(head);
      if (parent === head) return cased(resolved);
      tail = tail ? path.join(path.basename(head), tail) : path.basename(head);
      head = parent;
    }
  };
  const target = norm(cwd);
  let best = null;
  let bestRootLength = -1;
  for (const repo of registry.repos) {
    const root = norm(repo.path);
    // Segment-compare (root + separator), never a bare prefix, so /a/bc cannot
    // match an enrolled root of /a/b.
    if (target === root || target.startsWith(root + path.sep) || target.startsWith(root + '/')) {
      if (root.length > bestRootLength) { best = repo; bestRootLength = root.length; }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Run association — parse tags out of the prompt
// ---------------------------------------------------------------------------

// Recognized anywhere in the prompt:
//   #123  |  issue:123          -> linked issue
//   bump:patch|minor|major      -> requested bump for the PR label
//   version:1.4.0               -> explicit set-version label
function parseRunTags(prompt) {
  const text = String(prompt || '');
  const out = { issue: null, bump: null, setVersion: null };
  const issue = text.match(/(?:^|[\s(])(?:issue:|#)(\d{1,7})\b/);
  if (issue) out.issue = Number(issue[1]);
  const bump = text.match(/\bbump:(patch|minor|major)\b/i);
  if (bump) out.bump = bump[1].toLowerCase();
  const setv = text.match(/\bversion:(\d+\.\d+\.\d+)\b/);
  if (setv) out.setVersion = setv[1];
  return out;
}

function bumpLabelFor(tags, repo) {
  if (tags.setVersion) return `set-version:${tags.setVersion}`;
  const bump = tags.bump || repo?.versioning?.defaultBump || 'patch';
  return BUMP_LEVELS.has(bump) ? `bump:${bump}` : 'bump:patch';
}

// ---------------------------------------------------------------------------
// Secret skip-list
// ---------------------------------------------------------------------------

function isSecretPath(relPath) {
  const base = path.basename(String(relPath));
  return SECRET_PATTERNS.some((re) => re && (re.test(base) || re.test(String(relPath))));
}

function partitionSecretPaths(paths) {
  const safe = [], skipped = [];
  for (const p of paths) (isSecretPath(p) ? skipped : safe).push(p);
  return { safe, skipped };
}

// Parse `git status --porcelain -uall -z`. Records are "XY <path>\0", except
// renames/copies which emit "R? <new>\0<old>\0" — the extra field must be
// consumed or it would be misread as a status record. Paths come through raw
// (no quoting, no octal escapes), which is the whole point of -z.
function parsePorcelainZ(raw) {
  const fields = String(raw || '').split('\0');
  const out = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field || field.length < 4) continue;
    const xy = field.slice(0, 2);
    out.push(field.slice(3));
    // A rename/copy carries its source path in the following field.
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      const src = fields[++i];
      if (src) out.push(src); // stage the deletion of the old path too
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Subprocess helpers (git / gh) — always cwd-bound, never shell-interpolated
// ---------------------------------------------------------------------------

function run(bin, args, { cwd, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    let proc;
    try {
      proc = spawn(bin, args, { cwd, windowsHide: true, env: process.env });
    } catch (err) {
      return resolve({ code: -1, stdout: '', stderr: err.message });
    }
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    if (timer.unref) timer.unref();
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message }); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: String(stdout), stderr: String(stderr) }); });
  });
}

const git = (args, opts) => run('git', args, opts);
const gh = (args, opts) => run('gh', args, opts);

async function currentBranch(cwd) {
  const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  return r.code === 0 ? r.stdout.trim() : null;
}

// The repo's default branch, or null when it cannot be determined locally.
// Returning null rather than guessing is the whole point: this feeds the
// never-commit-on-default guard in trackRun, and the old `return 'main'`
// silently disarmed it in two very ordinary repos — one whose default branch is
// master/develop/trunk, and any repo wired up with `git remote add` instead of
// `git clone` (refs/remotes/origin/HEAD is only written by clone, so
// symbolic-ref exits 128). In both, 'master' === 'main' is false, and the
// checkpoint + devlog commits — and with autoPush the push — landed on the
// default branch, which the module header promises can never happen.
async function defaultBranch(cwd) {
  const r = await git(['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'], { cwd });
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim().replace(/^origin\//, '');
  return null;
}

// Consulted ONLY when defaultBranch() came back null. With no authoritative
// answer the guard falls back to refusing the names that are a default branch
// somewhere: refusing a checkpoint is recoverable (make a feature branch and
// re-run), committing on the default branch is not. Deliberately not resolved
// over the network — defaultBranch runs on every tracked run, and `git remote
// show origin` would add a round trip (and a credential stall) to each one.
const LIKELY_DEFAULT_BRANCHES = new Set(['main', 'master', 'develop', 'trunk']);

// ---------------------------------------------------------------------------
// Commit message
// ---------------------------------------------------------------------------

function checkpointMessage({ runId, intent, issue, files, provider, user }) {
  const oneLine = String(intent || 'checkpoint').replace(/\s+/g, ' ').slice(0, 72);
  const head = `relaybridge(run ${runId}): ${oneLine}${issue ? ` [#${issue}]` : ''}`;
  const body = [
    '',
    `provider: ${provider || 'unknown'}`,
    `user: ${user || 'unknown'}`,
    'files:',
    ...files.slice(0, 50).map((f) => `  - ${f}`),
    files.length > 50 ? `  … and ${files.length - 50} more` : null,
  ].filter((l) => l !== null);
  return [head, ...body].join('\n');
}

function devlogEntry({ runId, ts, user, provider, issue, intent, diffstat }) {
  return [
    `## ${ts} — run ${runId}`,
    `- user: ${user || 'unknown'}  ·  provider: ${provider || 'unknown'}${issue ? `  ·  issue: #${issue}` : ''}`,
    `- intent: ${String(intent || '').replace(/\s+/g, ' ').slice(0, 300)}`,
    diffstat ? '```\n' + diffstat.trim() + '\n```' : null,
    '',
  ].filter(Boolean).join('\n');
}

function boundedTrackingUser(value) {
  if (typeof value !== 'string') return null;
  const bounded = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
  return bounded || null;
}

// ---------------------------------------------------------------------------
// Activity log (in-memory ring + JSONL) so the dashboard/MCP can show it
// ---------------------------------------------------------------------------

const activity = [];
const ACTIVITY_MAX = 200;
let activityFile = null;

function setActivityFile(file) { activityFile = file; }

function logActivity(event) {
  const entry = { ts: new Date().toISOString(), ...event };
  activity.push(entry);
  if (activity.length > ACTIVITY_MAX) activity.shift();
  if (activityFile) {
    try {
      fs.mkdirSync(path.dirname(activityFile), { recursive: true });
      fs.appendFileSync(activityFile, JSON.stringify(entry) + '\n', 'utf8');
    } catch {}
  }
  return entry;
}

function recentActivity(limit = 50) {
  return activity.slice(-Math.max(1, Math.min(200, limit))).reverse();
}

// ---------------------------------------------------------------------------
// Core: track one finished run
// ---------------------------------------------------------------------------

// meta: { runId, kind (provider), user, prompt, cwd, intent }
async function trackRun(meta, registry = null) {
  meta = { ...meta, user: boundedTrackingUser(meta?.user) };
  const reg = registry || loadRegistry();
  const repo = repoForCwd(meta.cwd, reg);
  if (!repo || repo.autoCommit === false) return { tracked: false, reason: repo ? 'autoCommit disabled' : 'cwd not enrolled' };

  const cwd = repo.path;
  const tags = parseRunTags(meta.prompt);
  const record = {
    action: 'track_run', runId: meta.runId, repo: repo.name, provider: meta.kind,
    user: meta.user || null, issue: tags.issue, bump: tags.bump, setVersion: tags.setVersion,
    dryRun: !!repo.dryRun,
  };

  try {
    // Guard: never operate on the default branch.
    const branch = await currentBranch(cwd);
    const def = await defaultBranch(cwd);
    if (!branch) return logActivity({ ...record, tracked: false, reason: 'not a git repo or no HEAD' });
    let workBranch = branch;
    const onDefault = def ? branch === def : LIKELY_DEFAULT_BRANCHES.has(branch);
    if (onDefault || branch === 'HEAD') {
      // checkpoint-on-branch refuses to commit on default; mirror-branch moves aside.
      if (repo.trackingMode === 'mirror-branch' && tags.issue) {
        workBranch = `${repo.branchPrefix}${meta.user || 'run'}/${tags.issue}`;
        if (!repo.dryRun) {
          const co = await git(['checkout', '-B', workBranch], { cwd });
          if (co.code !== 0) return logActivity({ ...record, tracked: false, reason: 'could not create mirror branch', detail: co.stderr.trim() });
        }
      } else {
        const which = def
          ? `default branch '${def}'`
          : `branch '${branch}' — origin/HEAD is unset so the default branch is unknown, and this name is a default branch in most repos`;
        return logActivity({ ...record, tracked: false, reason: `refusing to commit on ${which} — create a feature branch (or use mirror-branch mode with an issue tag)` });
      }
    }
    record.branch = workBranch;

    // Detect changes.
    // -uall is SECURITY-CRITICAL: without it git collapses an untracked
    // directory to a single "newdir/" entry, the skip-list sees a directory
    // name (never a secret), and `git add newdir/` then stages every file
    // inside it — including newdir/.env. -z is correctness-critical: default
    // porcelain quotes paths with spaces and octal-escapes non-ASCII
    // ("caf\303\251.js"), which would be passed to `git add` as a filename
    // that does not exist and fail the whole commit.
    const status = await git(['status', '--porcelain', '-uall', '-z'], { cwd });
    if (status.code !== 0) return logActivity({ ...record, tracked: false, reason: 'git status failed', detail: status.stderr.trim() });
    const changed = parsePorcelainZ(status.stdout);
    if (!changed.length) return logActivity({ ...record, tracked: false, reason: 'no changes' });

    const { safe, skipped } = partitionSecretPaths(changed);
    if (skipped.length) record.secretsSkipped = skipped;
    if (!safe.length) return logActivity({ ...record, tracked: false, reason: 'only secret-listed files changed — nothing staged' });

    const message = checkpointMessage({
      runId: meta.runId, intent: meta.intent || meta.prompt, issue: tags.issue,
      files: safe, provider: meta.kind, user: meta.user,
    });

    if (repo.dryRun) {
      return logActivity({
        ...record, tracked: true, dryRunPlan: {
          wouldStage: safe, wouldSkip: skipped, commitMessage: message,
          wouldPush: !!repo.autoPush, wouldLabel: repo.versioning?.dictateBump ? bumpLabelFor(tags, repo) : null,
          wouldOpenDraftPr: !!(repo.openDraftPr && tags.issue),
        },
      });
    }

    // Stage and commit only the safe set. The commit pathspec is
    // security-critical: a caller may already have unrelated or secret files
    // staged before RelayBridge runs, and a pathless commit would include them.
    const add = await git(['add', '--', ...safe], { cwd });
    if (add.code !== 0) return logActivity({ ...record, tracked: false, reason: 'git add failed', detail: add.stderr.trim() });
    const commit = await git(['commit', '-m', message, '--', ...safe], { cwd });
    if (commit.code !== 0) {
      const detail = (commit.stderr + commit.stdout).trim();
      // Unstage so a failed checkpoint doesn't leave a half-staged index the
      // person then commits by hand without realizing what's in it.
      await git(['reset', '--quiet'], { cwd });
      const identity = /Please tell me who you are|user\.email|user\.name/i.test(detail)
        ? ' — set git identity: git config --global user.name/user.email' : '';
      return logActivity({ ...record, tracked: false, reason: 'git commit failed' + identity, detail: detail.slice(0, 400) });
    }
    const sha = (await git(['rev-parse', '--short', 'HEAD'], { cwd })).stdout.trim();
    record.commit = sha;

    // DEVLOG — second commit so the checkpoint diff stays clean.
    const diffstat = (await git(['show', '--stat', '--format=', 'HEAD'], { cwd })).stdout;
    const devlogAbs = path.join(cwd, repo.devlogPath);
    try {
      fs.mkdirSync(path.dirname(devlogAbs), { recursive: true });
      const entry = devlogEntry({
        runId: meta.runId, ts: new Date().toISOString(), user: meta.user,
        provider: meta.kind, issue: tags.issue, intent: meta.intent || meta.prompt, diffstat,
      });
      const existing = fs.existsSync(devlogAbs) ? fs.readFileSync(devlogAbs, 'utf8') : '# Development log\n\n';
      fs.writeFileSync(devlogAbs, existing + '\n' + entry, 'utf8');
      await git(['add', '--', repo.devlogPath], { cwd });
      await git(['commit', '-m', `relaybridge(run ${meta.runId}): devlog`, '--', repo.devlogPath], { cwd });
      record.devlog = true;
    } catch (err) { record.devlogError = err.message; }

    // Push — opt-in only. Never force, never to default (guarded above).
    if (repo.autoPush) {
      const push = await git(['push', '-u', 'origin', workBranch], { cwd });
      record.pushed = push.code === 0;
      if (push.code !== 0) record.pushError = push.stderr.trim().slice(0, 400);
    }

    // GitHub side effects need the branch on the remote.
    if (record.pushed && tags.issue) {
      await ensureDraftPrAndLabel({ repo, cwd, branch: workBranch, tags, meta, record });
      await upsertStickyComment({ repo, cwd, tags, meta, record, diffstat });
    }

    return logActivity({ ...record, tracked: true });
  } catch (err) {
    return logActivity({ ...record, tracked: false, reason: 'tracker error', detail: err.message });
  }
}

async function ensureDraftPrAndLabel({ repo, cwd, branch, tags, meta, record }) {
  if (!repo.openDraftPr) return;
  // Reuse an existing PR for this branch, else create a draft one.
  const list = await gh(['pr', 'list', '--head', branch, '--json', 'number,isDraft', '--repo', repo.name], { cwd });
  let prNumber = null;
  try { prNumber = JSON.parse(list.stdout || '[]')[0]?.number ?? null; } catch {}
  if (!prNumber) {
    const title = `relaybridge: ${String(meta.intent || meta.prompt || 'work in progress').replace(/\s+/g, ' ').slice(0, 60)}`;
    const body = `Fixes #${tags.issue}\n\nOpened automatically by RelayBridge for run \`${meta.runId}\` (${meta.kind}, ${meta.user || 'unknown'}). Checkpoint commits land here as work happens.`;
    const create = await gh(['pr', 'create', '--draft', '--repo', repo.name, '--head', branch, '--title', title, '--body', body], { cwd });
    if (create.code !== 0) { record.prError = create.stderr.trim().slice(0, 400); return; }
    const m = create.stdout.match(/\/pull\/(\d+)/);
    prNumber = m ? Number(m[1]) : null;
    record.prCreated = true;
  }
  record.pr = prNumber;
  // Dictate the bump: apply the label; version-on-merge.yml does the rest.
  if (repo.versioning?.dictateBump && prNumber) {
    const label = bumpLabelFor(tags, repo);
    const lbl = await gh(['pr', 'edit', String(prNumber), '--repo', repo.name, '--add-label', label], { cwd });
    if (lbl.code === 0) record.label = label;
    else record.labelError = lbl.stderr.trim().slice(0, 300);
  }
}

const STICKY_MARK = '<!-- relaybridge-sticky -->';

async function upsertStickyComment({ repo, cwd, tags, meta, record, diffstat }) {
  const body = [
    STICKY_MARK,
    `**RelayBridge activity** — last run \`${meta.runId}\``,
    `- who: ${meta.user || 'unknown'} via ${meta.kind}`,
    `- branch: \`${record.branch}\`  ·  commit: \`${record.commit || '?'}\`${record.pr ? `  ·  PR #${record.pr}` : ''}`,
    `- intent: ${String(meta.intent || meta.prompt || '').replace(/\s+/g, ' ').slice(0, 200)}`,
    diffstat ? '```\n' + diffstat.trim().slice(0, 1500) + '\n```' : '',
  ].join('\n');
  // --paginate is load-bearing, not cosmetic: the REST list-comments endpoint
  // defaults to 30 per page and gh fetches only the first page without it. Once
  // an issue grows past 30 comments the sticky comment falls off page 1, the
  // lookup returns nothing, and the else-branch below posts a BRAND NEW sticky
  // comment on every tracked run — one per run on exactly the long-lived issues
  // the single self-updating comment exists for. With --paginate gh applies
  // --jq per page and concatenates, so the filter must emit ids line by line
  // (nothing for pages with no match) instead of indexing one array; take the
  // first id that comes back.
  const listed = await gh(['api', `repos/${repo.name}/issues/${tags.issue}/comments`,
    '--paginate', '-X', 'GET', '-f', 'per_page=100',
    '--jq', `.[] | select(.body | startswith("${STICKY_MARK}")) | .id`], { cwd });
  const existingId = String(listed.stdout).split('\n')
    .map((line) => Number(line.trim()))
    .find((id) => Number.isInteger(id) && id > 0) || null;
  if (existingId) {
    await gh(['api', '--method', 'PATCH', `repos/${repo.name}/issues/comments/${existingId}`, '-f', `body=${body}`], { cwd });
    record.stickyComment = 'updated';
  } else {
    await gh(['api', '--method', 'POST', `repos/${repo.name}/issues/${tags.issue}/comments`, '-f', `body=${body}`], { cwd });
    record.stickyComment = 'created';
  }
}

// ---------------------------------------------------------------------------
// Versions — READ from GitHub (tags are the truth); checkout = new branch only
// ---------------------------------------------------------------------------

async function listVersions(repoName, registry = null) {
  const repo = (registry || loadRegistry()).repos.find((r) => r.name === repoName);
  if (!repo) throw new Error(`repo not enrolled: ${repoName}`);
  await git(['fetch', '--tags', '--quiet'], { cwd: repo.path });
  const r = await git(['tag', '--list', 'v*', '--sort=-v:refname', '--format=%(refname:short)|%(creatordate:iso-strict)|%(subject)'], { cwd: repo.path });
  if (r.code !== 0) throw new Error('git tag list failed: ' + r.stderr.trim());
  return r.stdout.split('\n').filter(Boolean).map((line) => {
    const [tag, date, subject] = line.split('|');
    return { tag, date, subject: subject || '' };
  });
}

async function showVersion(repoName, tag, registry = null) {
  const repo = (registry || loadRegistry()).repos.find((r) => r.name === repoName);
  if (!repo) throw new Error(`repo not enrolled: ${repoName}`);
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('tag must look like vX.Y.Z');
  const r = await git(['show', '--stat', '--format=%H%n%an%n%ad%n%s', tag], { cwd: repo.path });
  if (r.code !== 0) throw new Error(r.stderr.trim());
  return { tag, detail: r.stdout.slice(0, 8000) };
}

// Rollback convenience: create a NEW branch from the tag. Never resets, never
// force-pushes, never deletes anything — append-only history stays intact.
// It also does NOT switch the working tree: `git branch` rather than
// `git checkout -b`, because this can fire from the dashboard while someone is
// mid-edit on another branch. Switching under them would strand their work and
// would fail outright on a dirty tree. The caller gets the branch name and
// checks it out themselves when ready.
async function checkoutVersion(repoName, tag, registry = null) {
  const repo = (registry || loadRegistry()).repos.find((r) => r.name === repoName);
  if (!repo) throw new Error(`repo not enrolled: ${repoName}`);
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('tag must look like vX.Y.Z');
  await git(['fetch', '--tags', '--quiet'], { cwd: repo.path });
  const verify = await git(['rev-parse', '--verify', `refs/tags/${tag}`], { cwd: repo.path });
  if (verify.code !== 0) throw new Error(`tag ${tag} not found in ${repoName}`);
  const branch = `restore/${tag}-${Date.now().toString(36)}`;
  const r = await git(['branch', branch, `refs/tags/${tag}`], { cwd: repo.path });
  if (r.code !== 0) throw new Error(r.stderr.trim());
  logActivity({ action: 'checkout_version', repo: repoName, tag, branch, switched: false });
  return { branch, tag, switched: false, hint: `git checkout ${branch}` };
}

module.exports = {
  REGISTRY_FILE,
  defaultRepoEntry, loadRegistry, saveRegistry, repoForCwd,
  parseRunTags, bumpLabelFor,
  isSecretPath, partitionSecretPaths, parsePorcelainZ, boundedTrackingUser,
  checkpointMessage, devlogEntry,
  trackRun, listVersions, showVersion, checkoutVersion,
  logActivity, recentActivity, setActivityFile,
};
