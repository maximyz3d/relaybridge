'use strict';

// Model selection within a provider.
//
// Choosing the CLI is only half of "right tool for the job". Claude Code can
// run Haiku or Opus; Codex can run Luna or Sol. Sending a one-line lookup to
// Opus wastes quota, and sending an architecture review to Haiku wastes the
// user's time. This module maps a routing tier to a concrete model tier and
// returns the CLI arguments that select it.
//
// Two rules learned the hard way, because model identifiers rot:
//
//   1. Prefer stable aliases over versioned identifiers. Claude Code accepts
//      "opus"/"sonnet"/"haiku", which keep working across releases; pinning
//      "claude-opus-5" breaks the day the alias moves.
//   2. When a provider's lineup is account-dependent or changing (Cursor,
//      Copilot, Grok), configure nothing and let the account default apply. A
//      missing flag runs; a wrong flag fails the whole call.
//
// Anything configured here is a hint, never a hard requirement: an unknown
// tier or an unconfigured provider yields no arguments rather than an error.

// Routing tiers (from config/routing-policy.json) to model weight classes.
const TIER_TO_MODEL_TIER = {
  utility: 'light',
  standard: 'standard',
  complex: 'heavy',
  critical: 'heavy',
};

function modelTierForTaskTier(taskTier) {
  return TIER_TO_MODEL_TIER[String(taskTier || '').toLowerCase()] || 'standard';
}

// Resolves the CLI arguments that select a model tier for one provider.
// Returns { modelTier, args, model, source, note } — args is always an array,
// empty when nothing is configured, which means "use the account default".
function resolveModelArgs({ entry = {}, taskTier, modelTier: explicitTier } = {}) {
  const tiers = entry.model_tiers || null;
  const wanted = explicitTier || modelTierForTaskTier(taskTier);

  if (!tiers) {
    return {
      modelTier: wanted,
      args: [],
      model: null,
      source: 'account_default',
      note: entry.model_note || 'no model tiers configured; the account default applies',
      suppressFlags: [],
    };
  }

  // Fall back down the ladder rather than failing: a provider that only
  // defines "standard" should still answer a heavy request.
  const order = wanted === 'heavy' ? ['heavy', 'standard', 'light']
    : wanted === 'light' ? ['light', 'standard', 'heavy']
      : ['standard', 'heavy', 'light'];

  for (const candidate of order) {
    const spec = tiers[candidate];
    if (!spec) continue;
    const args = Array.isArray(spec) ? spec : Array.isArray(spec.args) ? spec.args : [];
    if (!args.length) continue;
    return {
      modelTier: candidate,
      args: args.slice(),
      model: Array.isArray(spec) ? args[args.length - 1] : (spec.model || args[args.length - 1]),
      source: candidate === wanted ? 'configured' : 'fallback',
      note: (Array.isArray(spec) ? '' : spec.note) || '',
      suppressFlags: Array.isArray(spec)
        ? []
        : (Array.isArray(spec.suppress_flags) ? spec.suppress_flags.slice() : []),
    };
  }

  return {
    modelTier: wanted,
    args: [],
    model: null,
    source: 'account_default',
    note: 'model tiers present but none usable; the account default applies',
    suppressFlags: [],
  };
}

// Injects model arguments into a resolved one-shot slot. The flag goes
// immediately after the subcommand when the provider declares one (cursor's
// "agent", for example), otherwise at the front — before any {prompt}
// placeholder, which must stay last for CLIs that read it positionally.
function applyModelArgs(slot, modelArgs, entry = {}, suppressFlags = []) {
  if (!Array.isArray(slot)) return [];
  const out = slot.slice();
  for (const flag of suppressFlags) {
    if (typeof flag !== 'string' || !flag.startsWith('-')) continue;
    for (let at = out.indexOf(flag); at >= 0; at = out.indexOf(flag)) {
      out.splice(at, at + 1 < out.length && !String(out[at + 1]).startsWith('-') ? 2 : 1);
    }
  }
  if (!modelArgs || !modelArgs.length) return out;
  // Never inject a second --model if the slot already pins one.
  const flag = modelArgs[0];
  if (typeof flag === 'string' && flag.startsWith('-') && out.includes(flag)) { const at = out.indexOf(flag); if (at >= 0 && at + 1 < out.length && modelArgs.length > 1) out[at + 1] = modelArgs[1]; return out; }
  const insertAt = Number.isInteger(entry.model_arg_index)
    ? entry.model_arg_index
    : (out.length && typeof out[0] === 'string' && !out[0].startsWith('-') ? 1 : 0);
  out.splice(Math.min(insertAt, out.length), 0, ...modelArgs);
  return out;
}

// Staleness surfacing. Model lineups change on weeks-long cycles, so a config
// that has not been checked in a while is reported rather than trusted
// silently — a pinned identifier that has been retired fails every call.
function modelConfigStaleness(globals = {}, now = Date.now()) {
  const checked = globals.modelsCheckedAt ? Date.parse(globals.modelsCheckedAt) : NaN;
  if (!Number.isFinite(checked)) {
    return { known: false, ageDays: null, stale: true, message: 'model pins have no checked date; verify them against each CLI' };
  }
  const ageDays = Math.floor((now - checked) / 86400000);
  const limit = Number(globals.staleAfterDays) > 0 ? Number(globals.staleAfterDays) : 45;
  return {
    known: true,
    ageDays,
    stale: ageDays > limit,
    message: ageDays > limit
      ? `model pins were last verified ${ageDays} days ago; re-check them, provider lineups change often`
      : `model pins verified ${ageDays} days ago`,
  };
}

module.exports = {
  TIER_TO_MODEL_TIER,
  modelTierForTaskTier,
  resolveModelArgs,
  applyModelArgs,
  modelConfigStaleness,
};
