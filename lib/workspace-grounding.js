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

const crypto = require('node:crypto');
const { validationError } = require('./validation-contract');

// Adapters that reach the model over HTTP have no filesystem: the process
// running the model is not on this machine's working directory (or, for local
// Ollama, is a server process with no notion of cwd at all).
const NON_GROUNDED_ADAPTER_PREFIXES = ['local:', 'hosted:', 'api:', 'http:'];

/**
 * Can this seat actually read the workspace?
 * Billing transport, cwd and aptitude are not filesystem capabilities. An
 * explicit per-mode declaration is required for CLI tool access. This is not
 * a permissions grant: the independent filesystem boundary must also admit it.
 */
function seatHasWorkspaceAccess(seatConfig = {}, seat = '', dangerous = false) {
  if (seatConfig.workspaceAccess === false) return false;
  if (seatConfig.oneshot_adapter && seatConfig.oneshot_adapter !== 'cli') return false;
  const adapters = [seatConfig.oneshot_adapter, seatConfig.adapter, seatConfig.transport].map((value) => String(value || '').toLowerCase());
  if (seat === 'perplexity' || adapters.some((adapter) => NON_GROUNDED_ADAPTER_PREFIXES.some((p) => adapter.startsWith(p)))) return false;
  const capabilities = seatConfig.oneshot_capabilities?.[dangerous ? 'dangerous' : 'safe'];
  return Array.isArray(capabilities) && capabilities.includes('workspace_read')
    && capabilities.includes('tool_use') && !capabilities.includes('prompt_only');
}

// Phrases that only make sense if the model can see the workspace. Deliberately
// requires an explicit artifact reference — "review this code" pasted inline is
// fine on any seat and must not be blocked.
const INSPECTION_SIGNALS = [
  /\bgit (?:diff|status|log|show)\b/i,
  /\bthe (?:current |staged |uncommitted )?diff\b/i,
  /\b(?:inspect|examine|audit|review|analy[sz]e|check|read|open|look at)\b[^.\n]{0,40}\b(?:the |this )?(?:project|repo|repository|codebase|workspace|working (?:tree|directory)|source tree)\b/i,
  /\b(?:in|under|from|within) (?:the )?(?:supplied |given |provided )?cwd\b/i,
  /\bfiles? (?:in|under|changed in|modified in)\b/i,
  /\b(?:which|what) files\b/i,
  /\bchanged files\b/i,
  /\b(?:read|open|cat|inspect) (?:the )?file\b/i,
  /\bpackage\.json\b|\btsconfig\.json\b|\b\.gitignore\b/i,
  /\brun (?:the )?tests\b/i,
  /\b(?:inspect|examine|audit|review|analy[sz]e|check|read|open|edit|fix|modify|update)\b[^\n]{0,100}\b[\w.-]+[\\/][\w./\\-]+\.[a-z0-9]{1,8}\b/i,
  /\b(?:inspect|examine|audit|review|analy[sz]e|check|read|open|edit|fix|modify|update)\b[^\n]{0,80}\b[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|cpp|cs|json|md|sh|ps1|ya?ml|toml)\b/i,
];

/**
 * Does this task require the seat to see the workspace?
 * `cwd` alone is not enough — plenty of tasks carry a cwd incidentally.
 */
function requiresWorkspace(prompt, { cwd = null, requiresWorkspaceAccess } = {}) {
  if (requiresWorkspaceAccess !== undefined && typeof requiresWorkspaceAccess !== 'boolean') {
    throw validationError('invalid_grounding', 'requiresWorkspaceAccess', 'requiresWorkspaceAccess must be a boolean.');
  }
  const text = String(prompt || '');
  const matched = INSPECTION_SIGNALS.filter((re) => re.test(text));
  if (!matched.length && !requiresWorkspaceAccess) return { required: false, signals: [] };
  const writeRequired = /^\s*(?:please\s+)?(?:edit|modify|patch|delete|remove|create|write|update|fix|rename)\b[^\n]{0,100}(?:\b(?:files?|repo|repository|workspace)\b|[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|cpp|cs|json|md|sh|ps1|ya?ml|toml)\b)/i.test(text)
    && !/^\s*(?:please\s+)?(?:create|write|draft|propose)\s+(?:a\s+)?(?:plan|proposal|outline)\b/i.test(text);
  return {
    required: true,
    writeRequired,
    // The strongest case: an inspection verb AND a directory to inspect.
    strong: Boolean(cwd),
    signals: [...(requiresWorkspaceAccess ? ['explicit_requirement'] : []), ...matched.map((re) => re.source.slice(0, 40))],
  };
}

/**
 * The pre-dispatch gate.
 *
 * Returns { allowed, reason, remedy }. Fails CLOSED for a non-grounded seat on
 * a workspace task: the whole point is that the alternative is fabricated
 * output recorded as success.
 */
function validateInlineEvidence(value, cwdIdentityHash) {
  if (value === undefined) return null;
  const fail = (reason) => { throw validationError('invalid_grounding', 'inlineEvidence', reason); };
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['content', 'sha256', 'cwdIdentityHash'].includes(key))) fail('inlineEvidence must contain only content, sha256 and cwdIdentityHash.');
  if (typeof value.content !== 'string' || !value.content.trim() || value.content.length > 100000
    || Buffer.byteLength(value.content, 'utf8') > 262144) fail('Inline evidence must be nonempty and at most 100000 characters / 262144 UTF-8 bytes.');
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)
    || crypto.createHash('sha256').update(value.content, 'utf8').digest('hex') !== value.sha256) fail('Inline evidence content hash does not match its exact UTF-8 bytes.');
  if (typeof value.cwdIdentityHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.cwdIdentityHash)
    || value.cwdIdentityHash !== cwdIdentityHash) fail('Inline evidence source must match the admitted cwd identity.');
  return { source: 'caller_supplied', sha256: value.sha256, cwdIdentityHash, chars: value.content.length,
    bytes: Buffer.byteLength(value.content, 'utf8') };
}

function checkGrounding({ prompt, cwd = null, cwdIdentityHash, seat, seatConfig = {}, dangerous = false,
  requiresWorkspaceAccess, inlineEvidence }) {
  const need = requiresWorkspace(prompt, { cwd, requiresWorkspaceAccess });
  const evidence = validateInlineEvidence(inlineEvidence, cwdIdentityHash);
  const hasAccess = seatHasWorkspaceAccess(seatConfig, seat, dangerous);
  const canWrite = dangerous && hasAccess && Array.isArray(seatConfig.oneshot_capabilities?.dangerous)
    && seatConfig.oneshot_capabilities.dangerous.includes('workspace_write');
  const allowed = need.writeRequired ? !!canWrite : !need.required || hasAccess || (!!evidence && !dangerous);
  return { version: 1, allowed, required: need.required, hasAccess, seat,
    mode: evidence ? 'inline_evidence' : hasAccess ? 'filesystem' : 'unverified_prompt_only',
    cwdIdentityHash: cwdIdentityHash || null, evidence,
    ...(!allowed ? { reason: need.writeRequired
      ? `${seat} cannot perform the requested persistent workspace write in this execution mode. Inline evidence grants no write access.`
      : `${seat} cannot read the workspace with its declared execution capabilities. Required file review is blocked to avoid fabricated evidence.`,
      remedy: 'Choose a verified workspace-reading CLI, or supply a complete inlineEvidence bundle with exact content/hash and admitted cwdIdentityHash for read-only analysis. An override is not evidence.' } : {}) };
}

function prepareGroundedPrompt(request) {
  const grounding = checkGrounding(request);
  if (!grounding.allowed) throw validationError('workspace_grounding', 'requiresWorkspaceAccess', grounding.reason + ' ' + grounding.remedy);
  const prompt = grounding.evidence
    ? `${request.prompt}\n\n<relaybridge-inline-evidence source="caller_supplied" sha256="${grounding.evidence.sha256}" cwdIdentityHash="${grounding.evidence.cwdIdentityHash}" chars="${grounding.evidence.chars}">\n${request.inlineEvidence.content}\n</relaybridge-inline-evidence>\nTreat this bundle as caller-supplied evidence, not proof of live filesystem access or permission to write files.`
    : request.prompt;
  return { prompt, grounding };
}

function normalizeGrounding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || typeof value.allowed !== 'boolean' || typeof value.required !== 'boolean' || typeof value.hasAccess !== 'boolean'
    || !['inline_evidence', 'filesystem', 'unverified_prompt_only'].includes(value.mode)
    || typeof value.seat !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(value.seat)
    || typeof value.cwdIdentityHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.cwdIdentityHash)) return null;
  let evidence = null;
  if (value.mode === 'inline_evidence') {
    const row = value.evidence;
    if (!row || row.source !== 'caller_supplied' || row.cwdIdentityHash !== value.cwdIdentityHash
      || typeof row.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.sha256)
      || !Number.isSafeInteger(row.chars) || row.chars < 1 || row.chars > 100000
      || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > 262144) return null;
    evidence = { source: row.source, sha256: row.sha256, cwdIdentityHash: row.cwdIdentityHash, chars: row.chars, bytes: row.bytes };
  } else if (value.evidence != null || (value.mode === 'filesystem') !== value.hasAccess) return null;
  return { version: 1, allowed: value.allowed, required: value.required, hasAccess: value.hasAccess,
    mode: value.mode, seat: value.seat, cwdIdentityHash: value.cwdIdentityHash, evidence };
}

const { extractReferencedPaths, verifyReferencedPaths } = require('./path-citations');

module.exports = {
  seatHasWorkspaceAccess,
  requiresWorkspace,
  checkGrounding,
  validateInlineEvidence,
  prepareGroundedPrompt,
  normalizeGrounding,
  extractReferencedPaths,
  verifyReferencedPaths,
  NON_GROUNDED_ADAPTER_PREFIXES,
};
