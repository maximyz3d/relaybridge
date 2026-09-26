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
  { match: 'sol', tier: 'heavy', bestAt: 'hard coding and reasoning' },
  { match: 'astra', tier: 'heavy', bestAt: 'complex coding, research, reasoning and multistep tool use' },
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

// A CLI that can print its own catalog as JSON tells us more than a list of
// ids: which reasoning levels each model accepts, and how the vendor ranks
// them. Both matter. Without the effort list the bridge cannot know that
// gpt-6-astra accepts `ultra` while gpt-6-luna stops at `max`, so it either
// refuses a level that would have worked or sends one that fails. Without the
// ranking it cannot tell that a pin has fallen a generation behind.
const CATALOG_ARRAY_FIELDS = ['models', 'data', 'items'];
const CATALOG_ID_FIELDS = ['slug', 'id', 'name', 'model'];

function catalogArray(parsed, entry = {}) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return null;
  if (entry.models_json_array) {
    return Array.isArray(parsed[entry.models_json_array]) ? parsed[entry.models_json_array] : null;
  }
  for (const field of CATALOG_ARRAY_FIELDS) if (Array.isArray(parsed[field])) return parsed[field];
  return null;
}

function catalogId(row, entry = {}) {
  for (const field of (entry.models_json_id ? [entry.models_json_id] : CATALOG_ID_FIELDS)) {
    const value = row?.[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

// Reasoning levels arrive either as bare strings or as objects describing each
// level. Accept both, and keep the vendor's own order: that order IS the
// ladder, and inventing one would be guessing which level is strongest.
function catalogEfforts(row, entry = {}) {
  const raw = row?.[entry.models_json_efforts || 'supported_reasoning_levels'];
  if (!Array.isArray(raw)) return null;
  const key = entry.models_json_effort_key || 'effort';
  const out = [];
  for (const level of raw.slice(0, 32)) {
    const value = typeof level === 'string' ? level
      : level && typeof level === 'object' ? level[key] : null;
    const id = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (id && /^[a-z]{2,16}$/.test(id) && !out.includes(id)) out.push(id);
  }
  return out.length ? out : null;
}

// Tolerant JSON catalog reader. Every failure degrades to an empty list, which
// callers already treat as "no list to check against" — never to a throw that
// would take the whole discovery pass down with it.
function parseModelCatalog(raw, entry = {}) {
  let parsed;
  try { parsed = JSON.parse(String(raw || '').replace(ANSI, '')); }
  catch { return []; }
  const rows = catalogArray(parsed, entry);
  if (!rows) return [];
  const records = [];
  const seen = new Set();
  for (const row of rows.slice(0, 500)) {
    const id = catalogId(row, entry);
    if (!id || !looksLikeModelId(id) || seen.has(id.toLowerCase())) continue;
    // A model the vendor marks hidden is not on offer. Pinning one would read
    // as available here and then fail at call time.
    const visibility = typeof row?.visibility === 'string' ? row.visibility.toLowerCase() : null;
    if (visibility === 'hide' && entry.models_include_hidden !== true) continue;
    seen.add(id.toLowerCase());
    const priority = Number(row?.[entry.models_json_priority || 'priority']);
    const defaultEffort = row?.[entry.models_json_default_effort || 'default_reasoning_level'];
    records.push({
      id,
      displayName: typeof row?.display_name === 'string' ? row.display_name : null,
      priority: Number.isFinite(priority) ? priority : null,
      efforts: catalogEfforts(row, entry),
      defaultEffort: typeof defaultEffort === 'string' ? defaultEffort.toLowerCase() : null,
    });
  }
  return records;
}

// Which reasoning levels may this exact model be asked for? Only a positive
// catalog entry answers; anything else returns null, meaning "no evidence",
// which every caller must treat as permission to proceed unchanged rather than
// as a denial.
function supportedEffortsFor(registry, kind, model) {
  if (!model) return null;
  const rows = registry?.providers?.[kind]?.models;
  if (!Array.isArray(rows)) return null;
  const hit = rows.find((row) => String(row?.id || '').toLowerCase() === String(model).toLowerCase());
  return Array.isArray(hit?.efforts) && hit.efforts.length ? hit.efforts.slice() : null;
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
function reconcileProvider({ kind, entry = {}, discovered = null, catalog = null, error = null }) {
  const tiers = entry.model_tiers || {};
  const configured = Object.entries(tiers).map(([tier, spec]) => ({
    tier,
    model: Array.isArray(spec) ? spec[spec.length - 1] : (spec.model || null),
  })).filter((c) => c.model);

  const available = Array.isArray(discovered) ? discovered : null;
  const records = Array.isArray(catalog) ? catalog : null;
  const metaFor = (id) => records?.find((row) => row.id.toLowerCase() === String(id).toLowerCase()) || null;
  const models = (available || []).map((id) => {
    const meta = metaFor(id);
    return {
      id,
      ...classifyModel(id),
      ...(meta ? {
        displayName: meta.displayName,
        priority: meta.priority,
        efforts: meta.efforts,
        defaultEffort: meta.defaultEffort,
      } : {}),
    };
  });
  const warnings = [];
  const verified = {};

  // The vendor's own ranking, when it publishes one, is the only evidence that
  // a pin has fallen behind. Lower priority number means the vendor ranks it
  // higher; a model with no rank cannot displace one that has a rank.
  const frontierFor = (tier, pinned) => {
    if (!records) return null;
    const ranked = models
      .filter((m) => m.tier === tier && Number.isFinite(m.priority))
      .sort((a, b) => a.priority - b.priority);
    const best = ranked[0];
    if (!best || best.id.toLowerCase() === String(pinned).toLowerCase()) return null;
    const pinnedRank = ranked.find((m) => m.id.toLowerCase() === String(pinned).toLowerCase());
    // Only report a lag when the pin is actually ranked lower, never when the
    // pin is simply absent from the ranking for some other reason.
    return pinnedRank && pinnedRank.priority > best.priority ? best.id : null;
  };

  for (const { tier, model } of configured) {
    if (!available) {
      // No list to check against: trust the pin, but say so.
      verified[tier] = { model, status: 'unverified' };
      continue;
    }
    const hit = available.find((id) => id.toLowerCase() === String(model).toLowerCase())
      ;
    if (hit) {
      // Ranking advice only applies when the pin sits in the slot its own weight
      // class implies. An operator who deliberately pins a heavy model to the
      // standard slot has made a cost decision, and telling them a heavier model
      // exists is not news.
      const pinTier = classifyModel(hit).tier;
      const frontier = pinTier === tier ? frontierFor(pinTier, hit) : null;
      verified[tier] = { model: hit, status: 'available', ...(frontier ? { newerAvailable: frontier } : {}) };
      if (frontier) {
        warnings.push(`${kind}: configured ${tier} model "${hit}" is no longer this account's top-ranked ${tier} model — "${frontier}" now is; update model_tiers.${tier} to use it`);
      }
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
      catalog: result.catalog || null,
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
  parseModelCatalog,
  supportedEffortsFor,
  classifyModel,
  reconcileProvider,
  buildRegistry,
  pinIsRetired,
  looksLikeModelId,
};
