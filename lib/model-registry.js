'use strict';

// Model discovery.
//
// Configured model pins rot: gpt-5.4 retires 2026-08-31, Gemini's Flash line
// turned over twice in 2026, Grok 4.1 was shut down. A pin that has been
// retired fails *every* call to that provider, and the failure looks like a
// broken bridge rather than a stale config.
//
// So the bridge asks each CLI what it can actually run, at boot, and keeps the
// answer. Discovery is what makes the pins self-correcting: a configured model
// that no longer appears in a provider's own list is reported and bypassed
// rather than sent.
//
// Three things this must survive, because probing other people's CLIs is
// inherently unreliable:
//   - a provider with no list command at all (most of them)
//   - a probe that fails, hangs, or needs auth
//   - output in a format nobody documented and that changes without notice
// Every one of those degrades to "use the account default", never to an error.

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

// Capability metadata. Matched by pattern rather than exact id so a new version
// inherits its family's profile: gpt-5.7-luna is still the fast subagent tier
// the day it ships, without a config edit.
const DEFAULT_CAPABILITIES = [
  { match: 'haiku', tier: 'light', bestAt: 'lookups, classification, short explanations — cheapest Claude tier' },
  { match: 'sonnet', tier: 'standard', bestAt: 'everyday coding, review, bounded reasoning' },
  { match: 'opus', tier: 'heavy', bestAt: 'architecture, hard debugging, long context, ambiguous problems' },
  { match: 'fable', tier: 'heavy', bestAt: 'frontier reasoning with additional safety measures' },
  { match: 'luna', tier: 'light', bestAt: 'fast subagent work: search, triage, parallel subtasks' },
  { match: 'spark', tier: 'light', bestAt: 'near-instant pairing latency (Pro plans only)' },
  { match: 'terra', tier: 'standard', bestAt: 'everyday coding and agentic tool use' },
  { match: 'sol', tier: 'heavy', bestAt: 'hardest coding and reasoning; current Codex default' },
  { match: 'flash-lite', tier: 'light', bestAt: 'high-volume, low-latency automation' },
  { match: 'flash', tier: 'standard', bestAt: 'fast general work with good token efficiency' },
  { match: 'pro', tier: 'heavy', bestAt: 'complex multimodal and agentic tasks' },
  { match: 'coder', tier: 'standard', bestAt: 'local code generation with no quota cost' },
  { match: 'mini', tier: 'light', bestAt: 'cheap, fast, narrow tasks' },
  { match: 'auto', tier: 'heavy', bestAt: 'lets the CLI route to its own best model' },
];

// Ids that are obviously not models — probe output is full of headings,
// prompts and column labels, and treating one as a model would pin a
// nonexistent name.
const NOT_A_MODEL = /^(name|id|model|models|available|current|default|size|modified|description|tier|usage|error|warning|note|select|use|running|installed|—|-+)$/i;

function looksLikeModelId(token) {
  if (!token || token.length < 2 || token.length > 80) return false;
  if (NOT_A_MODEL.test(token)) return false;
  if (!/[a-z]/i.test(token)) return false;
  // Real ids look like gpt-5.6-sol, gemini-3.6-flash, qwen2.5-coder:7b, opus.
  return /^[a-z][a-z0-9]*([.\-_:][a-z0-9]+)*$/i.test(token);
}

// Tolerant parser. Providers are free to declare `models_parse` (a regex with
// one capture group); otherwise we scan tokens and keep the plausible ones.
function parseModelList(raw, entry = {}) {
  const text = String(raw || '').replace(ANSI, '');
  if (!text.trim()) return [];
  const found = [];
  const seen = new Set();
  const push = (value) => {
    const id = String(value || '').trim().replace(/[,;'"`]+$/g, '').replace(/^[*\-•\s]+/, '');
    if (!looksLikeModelId(id) || seen.has(id.toLowerCase())) return;
    seen.add(id.toLowerCase());
    found.push(id);
  };

  if (entry.models_parse) {
    try {
      const re = new RegExp(entry.models_parse, 'gim');
      let m;
      while ((m = re.exec(text)) !== null) { if (m.index === re.lastIndex) re.lastIndex++; push(m[1] ?? m[0]); }
      if (found.length) return found;
    } catch { /* fall through to the generic scan */ }
  }

  for (const line of text.split('\n')) {
    // Strip list bullets and picker markers before splitting, or the first
    // token of "  * gpt-5.6-sol" is the bullet rather than the model.
    const trimmed = line.trim().replace(/^[*\-•>\u2022]+\s*/, '').replace(/^\[[ x*]\]\s*/i, '').trim();
    if (!trimmed || /^[-=_\s]+$/.test(trimmed)) continue;
    // First column is the id in every table-style listing seen so far
    // (`ollama list`, `agent models`), and bullets/pickers put it first too.
    push(trimmed.split(/[\s|\t]+/)[0]);
  }
  return found;
}

function classifyModel(modelId, capabilities = DEFAULT_CAPABILITIES) {
  const id = String(modelId || '').toLowerCase();
  // Longest match wins so "flash-lite" is not swallowed by "flash".
  const ranked = capabilities.slice().sort((a, b) => String(b.match).length - String(a.match).length);
  for (const cap of ranked) {
    if (id.includes(String(cap.match).toLowerCase())) {
      return { tier: cap.tier, bestAt: cap.bestAt, matched: cap.match };
    }
  }
  return { tier: 'standard', bestAt: 'uncategorized — profile it before relying on it', matched: null };
}

// Compares what a provider says it has against what the config pins, so a
// retired pin surfaces as a warning instead of a wall of failed calls.
function reconcileProvider({ kind, entry = {}, discovered = null, error = null }) {
  const tiers = entry.model_tiers || {};
  const configured = Object.entries(tiers).map(([tier, spec]) => ({
    tier,
    model: Array.isArray(spec) ? spec[spec.length - 1] : (spec.model || null),
  })).filter((c) => c.model);

  const available = Array.isArray(discovered) ? discovered : null;
  const models = (available || []).map((id) => ({ id, ...classifyModel(id) }));
  const warnings = [];
  const verified = {};

  for (const { tier, model } of configured) {
    if (!available) {
      // No list to check against: trust the pin, but say so.
      verified[tier] = { model, status: 'unverified' };
      continue;
    }
    const hit = available.find((id) => id.toLowerCase() === String(model).toLowerCase())
      ;
    if (hit) {
      verified[tier] = { model: hit, status: 'available' };
    } else {
      verified[tier] = { model, status: 'missing' };
      warnings.push(`${kind}: configured ${tier} model "${model}" was not in this account's model list — it may have been retired; the account default will be used instead`);
    }
  }

  return {
    kind,
    label: entry.label || kind,
    probed: available != null,
    error: error || null,
    models,
    modelCount: models.length,
    configured: verified,
    warnings,
    source: available ? 'probe' : (configured.length ? 'config' : 'account_default'),
  };
}

function buildRegistry({ probeResults = {}, config = {}, now = Date.now() } = {}) {
  const capabilities = (config._models && config._models.capabilities) || DEFAULT_CAPABILITIES;
  const providers = {};
  const warnings = [];
  for (const [kind, entry] of Object.entries(config)) {
    if (kind.startsWith('_') || !entry || typeof entry !== 'object') continue;
    if (kind === 'powershell') continue;
    const result = probeResults[kind] || {};
    const reconciled = reconcileProvider({
      kind,
      entry,
      discovered: result.models || null,
      error: result.error || null,
    });
    reconciled.models = reconciled.models.map((m) => ({ ...m, ...classifyModel(m.id, capabilities) }));
    providers[kind] = reconciled;
    warnings.push(...reconciled.warnings);
  }
  return {
    generatedAt: new Date(now).toISOString(),
    providerCount: Object.keys(providers).length,
    probedCount: Object.values(providers).filter((p) => p.probed).length,
    totalModels: Object.values(providers).reduce((sum, p) => sum + p.modelCount, 0),
    providers,
    warnings,
  };
}

// True when a pinned model is known to be absent from the provider's own list.
// Only a positive probe result can veto a pin: an unprobed provider is left
// alone rather than second-guessed.
function pinIsRetired(registry, kind, model) {
  const provider = registry?.providers?.[kind];
  if (!provider || !provider.probed || !model) return false;
  return !provider.models.some((m) => m.id.toLowerCase() === String(model).toLowerCase()
  );
}

module.exports = {
  DEFAULT_CAPABILITIES,
  parseModelList,
  classifyModel,
  reconcileProvider,
  buildRegistry,
  pinIsRetired,
  looksLikeModelId,
};
