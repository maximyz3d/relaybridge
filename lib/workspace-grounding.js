'use strict';

// Workspace grounding (issue #16).
//
// The failure: an audit task — "inspect the git diff in this cwd and report
// findings" — was routed to `ollama_coder`, which talks over local HTTP and
// has no filesystem access at all. The model could not see the workspace, so
// it invented one: a confident patch for `src/etchwise/symbol_validation.py`
// and `src/etchwise/resolver.py`, neither of which exists. Exit 0. No timeout,
// no auth error, no rate limit. The receipt recorded a completed, successful
// call, and 416 tokens of fabricated review looked exactly like real review.
//
// That is the worst shape a failure can take: silent, confident, and recorded
// as success. A crash would have been better, because a crash gets noticed.
//
// The defect is routing, not the model. A model with no file access asked to
// read files has only two options — refuse, or guess — and models are heavily
// disposed toward being helpful. So the fix belongs where the decision is
// made: never hand a file-inspection task to a seat that cannot read files.
//
// Two layers here, because neither alone is sufficient:
//   1. PRE-DISPATCH: block the route. Cheap, certain, and prevents the tokens
//      being spent at all.
//   2. POST-HOC: check whether the answer cites paths that do not exist. A
//      grounded seat can still hallucinate, and a fabricated path in the
//      output is strong evidence the answer is not about this repository.

const fs = require('fs');
const path = require('path');

// Adapters that reach the model over HTTP have no filesystem: the process
// running the model is not on this machine's working directory (or, for local
// Ollama, is a server process with no notion of cwd at all).
const NON_GROUNDED_ADAPTER_PREFIXES = ['local:', 'hosted:', 'api:', 'http:'];

/**
 * Can this seat actually read the workspace?
 * Unknown adapters are treated as GROUNDED: a false "cannot read" would block
 * legitimate work, while the post-hoc check still catches fabrication.
 */
function seatHasWorkspaceAccess(seatConfig = {}, seat = '') {
  if (seatConfig.workspaceAccess === true) return true;
  if (seatConfig.workspaceAccess === false) return false;
  const adapter = String(seatConfig.adapter || seatConfig.transport || '').toLowerCase();
  if (!adapter) return true; // a plain CLI spawned in cwd
  return !NON_GROUNDED_ADAPTER_PREFIXES.some((p) => adapter.startsWith(p));
}

// Phrases that only make sense if the model can see the workspace. Deliberately
// requires an explicit artifact reference — "review this code" pasted inline is
// fine on any seat and must not be blocked.
const INSPECTION_SIGNALS = [
  /\bgit (?:diff|status|log|show)\b/i,
  /\bthe (?:current |staged |uncommitted )?diff\b/i,
  /\b(?:inspect|examine|audit|review|analy[sz]e|check|read|open|look at)\b[^.\n]{0,40}\b(?:the )?(?:repo|repository|codebase|workspace|working (?:tree|directory)|source tree)\b/i,
  /\b(?:in|under|from|within) (?:the )?(?:supplied |given |provided )?cwd\b/i,
  /\bfiles? (?:in|under|changed in|modified in)\b/i,
  /\b(?:which|what) files\b/i,
  /\bchanged files\b/i,
  /\b(?:read|open|cat|inspect) (?:the )?file\b/i,
  /\bpackage\.json\b|\btsconfig\.json\b|\b\.gitignore\b/i,
  /\brun (?:the )?tests\b/i,
];

/**
 * Does this task require the seat to see the workspace?
 * `cwd` alone is not enough — plenty of tasks carry a cwd incidentally.
 */
function requiresWorkspace(prompt, { cwd = null } = {}) {
  const text = String(prompt || '');
  const matched = INSPECTION_SIGNALS.filter((re) => re.test(text));
  if (!matched.length) return { required: false, signals: [] };
  return {
    required: true,
    // The strongest case: an inspection verb AND a directory to inspect.
    strong: Boolean(cwd),
    signals: matched.map((re) => re.source.slice(0, 40)),
  };
}

/**
 * The pre-dispatch gate.
 *
 * Returns { allowed, reason, remedy }. Fails CLOSED for a non-grounded seat on
 * a workspace task: the whole point is that the alternative is fabricated
 * output recorded as success.
 */
function checkGrounding({ prompt, cwd = null, seat, seatConfig = {}, override = false }) {
  const need = requiresWorkspace(prompt, { cwd });
  const hasAccess = seatHasWorkspaceAccess(seatConfig, seat);
  if (!need.required || hasAccess) {
    return { allowed: true, required: need.required, hasAccess, seat };
  }
  if (override) {
    return {
      allowed: true, required: true, hasAccess: false, seat, overridden: true,
      reason: `${seat} cannot read the workspace; proceeding only because grounding was explicitly overridden — treat any file paths in the answer as unverified`,
    };
  }
  return {
    allowed: false,
    required: true,
    hasAccess: false,
    seat,
    reason: `${seat} reaches its model over ${seatConfig.adapter || 'a non-filesystem transport'} and cannot read ${cwd || 'the workspace'}. Asked to inspect files it cannot see, it will produce a confident, fabricated answer that records as success.`,
    remedy: 'route to a CLI seat that runs in the working directory, or supply the file contents in the prompt',
  };
}

// ---------------------------------------------------------------------------
// Post-hoc verification
// ---------------------------------------------------------------------------

// Path-like tokens in model output.
//
// Two shapes, because requiring a directory separator missed bare filenames —
// and a fabricated `resolver.py` is exactly the citation this needs to catch.
//   * with a separator: any extension (src/app/main.js, a/b/c.weird)
//   * bare filename: only a known source extension, so prose is not swept in
const PATH_WITH_DIR_RE = /(?:^|[\s`'"(\[])((?:\.{0,2}[\w.-]+\/){1,}[\w.-]+\.[A-Za-z0-9]{1,8})(?=[\s`'")\],.:;]|$)/g;
const BARE_FILE_RE = /(?:^|[\s`'"(\[])([\w-]+(?:\.[\w-]+)?\.(?:js|mjs|cjs|jsx|ts|tsx|py|go|rs|java|rb|php|c|h|cpp|hpp|cs|json|ya?ml|toml|md|sh|ps1|sql|html|css|scss|vue|swift|kt))(?=[\s`'")\],.:;]|$)/gi;

// Library names that look like filenames. Treating "node.js" as a missing file
// would flag honest answers as fabricated.
const NOT_FILES = new Set([
  'node.js', 'next.js', 'vue.js', 'three.js', 'd3.js', 'express.js',
  'react.js', 'angular.js', 'jquery.js', 'chart.js', 'ember.js', 'backbone.js',
]);

function extractReferencedPaths(text, limit = 60) {
  const out = new Set();
  const s = String(text || '');
  for (const re of [PATH_WITH_DIR_RE, BARE_FILE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) && out.size < limit) {
      const p = m[1];
      if (/^https?:/i.test(p)) continue;                 // URL, not a workspace path
      if (p.startsWith('node_modules/')) continue;        // dependency, not our code
      if (NOT_FILES.has(p.toLowerCase())) continue;       // library name, not a file
      out.add(p);
    }
  }
  return [...out];
}

/**
 * Does the answer cite files that do not exist in the workspace?
 *
 * Reports rather than judges: a missing path is strong evidence of fabrication
 * but not proof — a review may legitimately propose creating a new file. The
 * caller decides what to do with `confidence`.
 */
function verifyReferencedPaths(output, cwd, { minPaths = 1 } = {}) {
  if (!cwd || !fs.existsSync(cwd)) {
    return { checked: false, reason: 'no readable cwd to verify against' };
  }
  const referenced = extractReferencedPaths(output);
  if (referenced.length < minPaths) {
    return { checked: true, referenced: [], missing: [], present: [], confidence: 'no-paths-cited' };
  }
  const present = [];
  const missing = [];
  for (const rel of referenced) {
    // Resolve inside cwd only; a path escaping the workspace is not evidence
    // about this repository and must not be treated as one.
    const abs = path.resolve(cwd, rel);
    if (!abs.startsWith(path.resolve(cwd))) continue;
    (fs.existsSync(abs) ? present : missing).push(rel);
  }
  const total = present.length + missing.length;
  let confidence = 'ok';
  if (total > 0 && present.length === 0) confidence = 'likely-fabricated';
  else if (missing.length > present.length) confidence = 'suspect';
  else if (missing.length) confidence = 'partial';
  return {
    checked: true, referenced, present, missing, confidence,
    note: confidence === 'likely-fabricated'
      ? 'every file path cited in this answer is absent from the workspace — treat the result as ungrounded'
      : confidence === 'suspect'
        ? 'most cited paths are absent from the workspace'
        : null,
  };
}

module.exports = {
  seatHasWorkspaceAccess,
  requiresWorkspace,
  checkGrounding,
  extractReferencedPaths,
  verifyReferencedPaths,
  NON_GROUNDED_ADAPTER_PREFIXES,
};
