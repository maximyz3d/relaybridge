'use strict';

// Task planning: company, model, AND effort.
//
// Routing alone answers "which CLI". That is not enough to avoid waste. Three
// decisions have to be made together:
//
//   company  which vendor's seat pays for this (or none — local/deterministic)
//   model    which weight class inside that vendor
//   effort   how hard that model is told to think
//
// Getting any one wrong costs real money. Spending Fable credits to tweak CSS
// wastes a frontier seat on a mechanical edit; running Opus at max effort to add
// two numbers wastes a reasoning budget on arithmetic. Equally, sending an
// architecture migration to a 1.5B local model wastes the user's time, which is
// more expensive than either.
//
// Effort is expressed three different ways depending on the provider, and this
// module hides that difference behind one plan:
//   - a flag the CLI accepts        (codex: model_reasoning_effort)
//   - a model-name variant          (cursor: gpt-5.6-sol-low vs -high)
//   - the model choice itself       (claude: haiku / sonnet / opus)

const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'max'];

// Routing tier to effort. Deliberately conservative at the top: "critical" gets
// high rather than max, because max effort on several providers is dramatically
// more expensive for a usually marginal gain. Callers who want max ask for it.
const EFFORT_BY_TIER = {
  deterministic: 'minimal',
  utility: 'low',
  standard: 'medium',
  complex: 'high',
  critical: 'high',
};

// What a call actually costs the user. This is the number that should drive
// routing, not model prestige.
const COST_CLASS = {
  none: { rank: 0, label: 'free — no model involved' },
  local: { rank: 1, label: 'free — runs on this machine' },
  subscription: { rank: 2, label: 'consumes a subscription seat you already pay for' },
  metered: { rank: 3, label: 'metered credits — billed per call' },
};

// Classified from explicit signals, never from a default. Getting this wrong in
// the optimistic direction is the expensive mistake: treating a metered provider
// as a subscription seat would route paid calls to it silently.
function costClassFor(entry = {}, kind = null) {
  if (!entry) return 'none';
  const transport = String(entry.transport || '');
  const shellFirst = Array.isArray(entry.safe) ? String(entry.safe[0] || '').toLowerCase() : '';
  // A plain shell has no model behind it, so it costs nothing at all. The
  // powershell entry declares no transport, which is why this is checked first.
  if (kind === 'powershell' || transport.startsWith('shell') || /^(powershell|pwsh|cmd)(\.exe)?$/.test(shellFirst)) {
    return 'none';
  }
  if (transport.startsWith('local') || transport.includes('ollama')) return 'local';
  if (transport.startsWith('subscription')) return 'subscription';
  if (entry.metered === true || transport.startsWith('api') || transport.startsWith('hosted') || transport.includes('key')) {
    return 'metered';
  }
  // Unknown transport: assume it bills, so an unclassified provider is never
  // quietly preferred over one we know is free.
  return 'metered';
}

function clampEffort(effort) {
  const value = String(effort || '').toLowerCase();
  return EFFORT_ORDER.includes(value) ? value : null;
}

function effortForTier(tier, requested) {
  return clampEffort(requested) || EFFORT_BY_TIER[String(tier || '').toLowerCase()] || 'medium';
}

// Finds a discovered model that is the same family as `baseModel` but carries the
// requested effort suffix. This is how Cursor expresses effort: the account lists
// gpt-5.6-sol-low, -medium, -high, -xhigh, -max as separate model ids.
function findEffortVariant({ baseModel, effort, availableModels }) {
  if (!baseModel || !Array.isArray(availableModels) || !availableModels.length) return null;
  const base = String(baseModel).toLowerCase().replace(/-(minimal|none|low|medium|high|xhigh|max|fast)$/g, '');
  // "max" maps to xhigh first where a vendor uses that spelling.
  const suffixes = effort === 'max' ? ['max', 'xhigh', 'high']
    : effort === 'high' ? ['high', 'xhigh', 'max']
      : effort === 'medium' ? ['medium', 'high', 'low']
        : effort === 'low' ? ['low', 'medium', 'none']
          : ['none', 'low', 'minimal'];
  for (const suffix of suffixes) {
    const hit = availableModels.find((id) => String(id).toLowerCase() === `${base}-${suffix}`);
    if (hit) return hit;
  }
  return null;
}

// Resolves how this provider expresses the requested effort. Returns args to add,
// a possibly-swapped model, and how the effort was achieved — so the caller can
// see when a provider simply cannot be tuned.
function resolveEffort({ entry = {}, effort, baseModel = null, availableModels = [] } = {}) {
  const wanted = clampEffort(effort) || 'medium';

  const flags = entry.effort_flags && entry.effort_flags[wanted];
  if (Array.isArray(flags) && flags.length) {
    return { effort: wanted, args: flags.slice(), model: baseModel, method: 'flag' };
  }

  const variant = findEffortVariant({ baseModel, effort: wanted, availableModels });
  if (variant && variant !== baseModel) {
    return { effort: wanted, args: [], model: variant, method: 'model_variant' };
  }

  // No knob: effort is already implied by which model was chosen.
  return { effort: wanted, args: [], model: baseModel, method: 'model_choice' };
}

// Builds the complete execution plan. `route` is the output of the existing
// router (tier + ranked providers); `resolveModelArgs` is injected so this module
// stays free of require cycles and easy to test.
function buildTaskPlan({
  route = {},
  config = {},
  registry = null,
  resolveModelArgs,
  requestedEffort = null,
  requestedKind = null,
} = {}) {
  const tier = route.classification?.tier || 'standard';
  const effort = effortForTier(tier, requestedEffort);
  const selected = Array.isArray(route.selected) ? route.selected : [];

  const candidates = requestedKind
    ? selected.filter((pick) => pick.kind === requestedKind).concat(
      selected.some((pick) => pick.kind === requestedKind) ? [] : [{ kind: requestedKind, reason: 'explicitly requested' }])
    : selected;

  const plans = candidates.map((pick) => {
    const entry = config[pick.kind] || {};
    const modelChoice = typeof resolveModelArgs === 'function'
      ? resolveModelArgs({ entry, taskTier: tier })
      : { model: null, args: [], modelTier: 'standard' };
    const available = registry?.providers?.[pick.kind]?.models?.map((m) => m.id) || [];
    const effortPlan = resolveEffort({ entry, effort, baseModel: modelChoice.model, availableModels: available });

    // If effort swapped the model, the model flag has to carry the new id.
    const modelArgs = effortPlan.model && effortPlan.model !== modelChoice.model
      ? (modelChoice.args.length ? modelChoice.args.slice(0, -1).concat(effortPlan.model) : ['--model', effortPlan.model])
      : modelChoice.args.slice();

    const cost = costClassFor(entry, pick.kind);
    return {
      company: entry.company || entry.label || pick.kind,
      kind: pick.kind,
      label: entry.label || pick.kind,
      model: effortPlan.model,
      modelTier: modelChoice.modelTier,
      effort: effortPlan.effort,
      effortMethod: effortPlan.method,
      args: modelArgs.concat(effortPlan.args),
      costClass: cost,
      costNote: COST_CLASS[cost].label,
      ready: pick.ready !== false,
      reason: pick.reason || null,
    };
  });

  // Cheapest capable option first: the router already ordered by capability, so
  // this only breaks ties toward the cheaper seat, never toward a weaker one.
  const ordered = plans.slice().sort((a, b) => COST_CLASS[a.costClass].rank - COST_CLASS[b.costClass].rank);
  const primary = plans[0] || null;

  const guidance = [];
  if (!primary) {
    // Returning a null plan with no explanation leaves a caller with nothing to
    // act on. Say why there is no plan and what would fix it.
    guidance.push('No provider is both installed and signed in for this task. '
      + 'Check bridge_status or `relaybridge status`, and sign in with `relaybridge login <kind>` if one is installed but signed out.');
  }
  if (tier === 'deterministic') {
    guidance.push('A command answers this exactly. Use powershell and no model at all.');
  }
  if (primary && primary.costClass === 'metered') {
    guidance.push(`${primary.label} bills per call. Confirm a cheaper seat cannot do this first.`);
  }
  if (primary && primary.effortMethod === 'model_choice') {
    guidance.push(`${primary.label} has no effort knob; effort here is the model choice (${primary.model || 'account default'}).`);
  }
  if (tier === 'critical') {
    guidance.push('Critical tier: gather more than one opinion and return a recommendation. Do not auto-execute.');
  }
  const cheaper = ordered.find((p) => COST_CLASS[p.costClass].rank < COST_CLASS[primary?.costClass || 'metered'].rank);
  if (primary && cheaper && tier !== 'complex' && tier !== 'critical') {
    guidance.push(`${cheaper.label} is cheaper (${cheaper.costNote}) and rated for ${tier} work — try it before ${primary.label}.`);
  }

  return {
    tier,
    effort,
    taskTags: route.classification?.tags || route.tags || route.taskTags || [],
    confidence: route.classification?.confidence ?? null,
    humanGate: tier === 'critical' || route.humanGate === true,
    primary,
    alternates: plans.slice(1, 4),
    cheapestCapable: ordered[0] || null,
    guidance,
  };
}

module.exports = {
  EFFORT_ORDER,
  EFFORT_BY_TIER,
  COST_CLASS,
  costClassFor,
  effortForTier,
  resolveEffort,
  findEffortVariant,
  buildTaskPlan,
};
