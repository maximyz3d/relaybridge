'use strict';

// Shared provider effort controls. Planning and execution must use the same
// resolver; separate interpretations can turn a promised model/effort into a
// different invocation. Existing wire semantics are preserved here.
// Ordered weakest to strongest. This order is the ladder every step-down walks,
// so a new level must be inserted at its true rank, not appended.  `ultra` is
// Codex's top level: maximum reasoning plus automatic task delegation.
const SUPPORTED_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const EXTREME_EFFORTS = new Set(['xhigh', 'max', 'ultra']);
const EFFORT_BY_TASK_TIER = Object.freeze({ deterministic: 'minimal', utility: 'low', standard: 'medium', complex: 'high', critical: 'high' });

function normalizeEffort(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return SUPPORTED_EFFORTS.includes(normalized) ? normalized : null;
}

function parseReasoningEffortAssignment(value) {
  // Configuration assignments need only a short key and one enum value.
  // Bound before scanning; split once instead of backtracking over whitespace.
  if (typeof value !== 'string' || value.length > 256) return null;
  const equalAt = value.indexOf('=');
  if (equalAt < 0) return null;
  const key = value.slice(0, equalAt).trim().toLowerCase();
  if (key !== 'model_reasoning_effort' && key !== 'reasoning_effort') return null;
  let rawValue = value.slice(equalAt + 1).trim();
  if ((rawValue[0] === '"' || rawValue[0] === "'") && rawValue.at(-1) === rawValue[0]) {
    rawValue = rawValue.slice(1, -1);
  }
  rawValue = rawValue.toLowerCase();
  const effort = normalizeEffort(rawValue);
  return effort ? { key, effort } : null;
}

// Inspect only the explicit, documented effort forms RelayBridge knows how to
// reason about.  Unknown config assignments are left alone rather than being
// guessed at and then reported as an applied control.
function findEffortControl(args) {
  if (!Array.isArray(args)) return null;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') break;
    if (arg === '--effort' || arg === '--reasoning-effort') {
      const effort = normalizeEffort(args[index + 1]);
      return { index, width: 2, effort, flag: arg, method: 'flag', ...(!effort ? { invalid: true } : {}) };
    }
    const inlineEffort = /^(--effort|--reasoning-effort)=(.*)$/.exec(String(arg || ''));
    if (inlineEffort) {
      const effort = normalizeEffort(inlineEffort[2]);
      return { index, width: 1, effort, flag: inlineEffort[1], method: 'flag', ...(!effort ? { invalid: true } : {}) };
    }
    if ((arg === '--config' || arg === '-c') && index + 1 < args.length) {
      const assignment = parseReasoningEffortAssignment(args[index + 1]);
      if (assignment) {
        return {
          index, width: 2, effort: assignment.effort, flag: arg,
          configKey: assignment.key, method: 'config',
        };
      }
      if (isReasoningAssignment(args[index + 1])) return { index, width: 2, invalid: true };
    }
    const inlineConfig = /^--config=(.*)$/i.exec(String(arg || ''));
    const assignment = inlineConfig ? parseReasoningEffortAssignment(inlineConfig[1]) : null;
    if (assignment) {
      return {
        index, width: 1, effort: assignment.effort, flag: '--config',
        configKey: assignment.key, method: 'config',
      };
    }
    if (inlineConfig && isReasoningAssignment(inlineConfig[1])) return { index, width: 1, invalid: true };
  }
  return null;
}
function isReasoningAssignment(value) {
  if (typeof value !== 'string') return false;
  const equalAt = value.indexOf('=');
  const key = value.slice(0, equalAt < 0 ? value.length : equalAt).trim().toLowerCase();
  return key === 'model_reasoning_effort' || key === 'reasoning_effort';
}
function invalidEffortControl(args) {
  let remaining = args;
  for (;;) {
    const control = findEffortControl(remaining);
    if (!control) return false;
    if (control.invalid) return true;
    remaining = remaining.slice(control.index + control.width);
  }
}

function stripEffortControls(args) {
  const out = [];
  let firstRemovedAt = null;
  for (let index = 0; index < args.length;) {
    const control = findEffortControl(args.slice(index));
    if (!control) {
      out.push(...args.slice(index));
      break;
    }
    const absoluteIndex = index + control.index;
    out.push(...args.slice(index, absoluteIndex));
    if (firstRemovedAt == null) firstRemovedAt = out.length;
    index = absoluteIndex + control.width;
  }
  return { args: out, firstRemovedAt };
}

function effortArgsInsertIndex(slot, entry = {}, preferredIndex = null) {
  if (Number.isInteger(preferredIndex)) return Math.max(1, Math.min(preferredIndex, slot.length));
  if (Number.isInteger(entry.effort_arg_index)) {
    return Math.max(1, Math.min(entry.effort_arg_index, slot.length));
  }
  const promptFileAt = slot.findIndex((arg) => typeof arg === 'string' && arg.includes('{prompt_file}'));
  if (promptFileAt >= 0) {
    // Keep `--prompt-file {prompt_file}` together.  This also leaves a script
    // path immediately after `node`, which makes deterministic CLI fixtures a
    // faithful stand-in for real providers.
    return promptFileAt > 0 && String(slot[promptFileAt - 1]).startsWith('-')
      ? promptFileAt - 1 : promptFileAt;
  }
  const inlinePromptAt = slot.findIndex((arg) => typeof arg === 'string' && arg.includes('{prompt}'));
  if (inlinePromptAt >= 0) return inlinePromptAt;
  if (slot.length > 1 && slot.at(-1) === '-') return slot.length - 1;
  return slot.length;
}

function insertEffortArgs(slot, effortArgs, entry = {}, preferredIndex = null) {
  const out = slot.slice();
  const delimiter = out.indexOf('--');
  const at = Math.min(effortArgsInsertIndex(out, entry, preferredIndex), delimiter < 0 ? out.length : delimiter);
  out.splice(at, 0, ...effortArgs);
  return out;
}

function configuredEffortArgs(entry, requestedEffort) {
  const configured = entry?.effort_flags?.[requestedEffort];
  if (!Array.isArray(configured) || !configured.length || configured.some((arg) => typeof arg !== 'string')) {
    return null;
  }
  return configured.slice();
}

function configuredReasoningEffortFamily(entry) {
  const values = entry?.effort_flags && typeof entry.effort_flags === 'object'
    ? Object.values(entry.effort_flags) : [];
  for (const args of values) {
    const control = findEffortControl(args);
    if (control?.method === 'config' && control.configKey) {
      return { flag: control.flag === '-c' ? '-c' : '--config', key: control.configKey };
    }
  }
  return null;
}

function modelImpliedEffort(modelChoice, entry = {}) {
  if (!modelChoice?.model) return null;
  const suffix = /(?:^|-)(minimal|low|medium|high|xhigh|max|ultra)$/i.exec(String(modelChoice.model));
  if (suffix) return suffix[1].toLowerCase();
  // A configured weight class is the only effort expression for several local
  // providers.  Do not make this claim for Codex-style seats, where model size
  // and reasoning effort are independent controls.
  if (entry.effort_flags && Object.keys(entry.effort_flags).length) return null;
  return { light: 'low', standard: 'medium', heavy: 'high' }[modelChoice.modelTier] || null;
}

// Walk down from the requested level to the strongest one this exact model
// actually accepts. Both alternatives are worse: sending a level the model does
// not offer fails the call outright, and refusing outright denies work the
// model could do one rung lower. With no catalog evidence the ladder is just
// the requested level, so behaviour is unchanged where nothing is known.
function effortLadderDown(requestedEffort, supportedEfforts) {
  if (!Array.isArray(supportedEfforts) || !supportedEfforts.length) return [requestedEffort];
  const from = SUPPORTED_EFFORTS.indexOf(requestedEffort);
  if (from < 0) return [requestedEffort];
  const out = [];
  for (let index = from; index >= 0; index--) {
    if (supportedEfforts.includes(SUPPORTED_EFFORTS[index])) out.push(SUPPORTED_EFFORTS[index]);
  }
  return out.length ? out : [requestedEffort];
}

function resolveProviderEffort({ slot, entry = {}, modelChoice = {}, requestedEffort = null, supportedEfforts = null }) {
  if (invalidEffortControl(slot)) return { error: 'provider has an invalid configured effort control' };
  const existing = findEffortControl(slot);
  if (!requestedEffort) {
    if (existing) {
      const tail = slot.slice(existing.index + existing.width);
      if (findEffortControl(tail)) return { error: 'provider has competing configured effort controls' };
      return {
        slot, appliedEffort: existing.effort,
        method: existing.method === 'config' ? 'effort_flags' : 'flag',
        control: existing.configKey ? `${existing.flag} ${existing.configKey}` : existing.flag,
      };
    }
    const implied = modelImpliedEffort(modelChoice, entry);
    return {
      slot, appliedEffort: implied,
      method: implied ? 'model_choice' : 'account_default',
      control: implied ? 'model' : null,
    };
  }

  let effortArgs = configuredEffortArgs(entry, requestedEffort);
  let method = effortArgs ? 'effort_flags' : null;

  // Current Codex accepts xhigh through model_reasoning_effort, but older
  // configurations may predate an explicit xhigh row.  Seeing that exact
  // configuration family is enough to construct xhigh safely.  Never perform
  // the same synthesis for max: Codex does not accept a literal max and must
  // use the provider's declared max fallback instead.
  const configFamily = configuredReasoningEffortFamily(entry)
    || (existing?.method === 'config' && existing.configKey
      ? { flag: existing.flag, key: existing.configKey } : null);
  // A catalog-declared level is the same kind of evidence an explicit xhigh row
  // is, so synthesize either one. This is what lets a newly shipped level
  // (Codex's `ultra`) be reachable before anyone edits effort_flags.
  const declaredLevel = Array.isArray(supportedEfforts) && supportedEfforts.includes(requestedEffort);
  if (!effortArgs && configFamily && (requestedEffort === 'xhigh' || declaredLevel)) {
    effortArgs = [configFamily.flag, `${configFamily.key}=${requestedEffort}`];
    method = 'effort_flags';
  }

  if (!effortArgs && existing?.method === 'flag') {
    effortArgs = [existing.flag, requestedEffort];
    method = 'flag';
  }
  if (!effortArgs && existing?.method === 'config' && (requestedEffort !== 'max' || declaredLevel)) {
    effortArgs = [existing.flag, `${existing.configKey}=${requestedEffort}`];
    method = 'effort_flags';
  }

  if (effortArgs) {
    const actual = findEffortControl(effortArgs);
    if (!actual || actual.invalid || findEffortControl(effortArgs.slice(actual.index + actual.width)) || effortArgs.includes('--')) {
      return { error: 'configured effort_flags do not contain a recognized effort control' };
    }
    if (actual.effort !== requestedEffort && !(requestedEffort === 'max' && actual.effort === 'xhigh')) {
      return { error: 'configured effort_flags contradict the requested effort' };
    }
    const stripped = stripEffortControls(slot);
    return {
      slot: insertEffortArgs(stripped.args, effortArgs, entry, stripped.firstRemovedAt),
      appliedEffort: actual.effort,
      method,
      control: actual.configKey ? `${actual.flag} ${actual.configKey}` : actual.flag,
      // A config row that maps the request to a weaker level used to be
      // invisible: a caller asking for max was sent xhigh and told nothing. Say
      // it, whenever the catalog shows the model would have taken the request.
      ...(actual.effort !== requestedEffort && declaredLevel
        ? { downgradeReason: `provider effort_flags map ${requestedEffort} to ${actual.effort}, but this account's catalog lists ${requestedEffort} for ${modelChoice?.model || 'the selected model'}; update effort_flags.${requestedEffort} to send it` }
        : {}),
    };
  }

  const implied = modelImpliedEffort(modelChoice, entry);
  if (implied === requestedEffort) {
    return { slot, appliedEffort: implied, method: 'model_choice', control: 'model' };
  }
  return {
    error: `provider cannot express requested effort=${requestedEffort}`
      + (implied ? `; selected model tier applies ${implied}` : ''),
  };
}


// Public entry point. Resolves the requested effort against the exact model's
// declared ladder, stepping down one rung at a time and reporting the reason
// rather than either failing or downgrading in silence.
function applyProviderEffort({ slot, entry = {}, modelChoice = {}, requestedEffort = null, supportedEfforts = null }) {
  const call = (target) => resolveProviderEffort({ slot, entry, modelChoice, requestedEffort: target, supportedEfforts });
  if (!requestedEffort) return call(null);

  const ladder = effortLadderDown(requestedEffort, supportedEfforts);
  let firstError = null;
  for (const target of ladder) {
    const result = call(target);
    if (result.error) { firstError ??= result.error; continue; }
    const unsupported = target !== requestedEffort;
    const reason = unsupported
      ? `${modelChoice?.model || 'the selected model'} does not accept effort=${requestedEffort} in this account's catalog; applied ${target}, the strongest level it does accept`
      : result.downgradeReason || null;
    const { downgradeReason, ...rest } = result;
    return { ...rest, ...(reason ? { effortFallbackReason: reason } : {}) };
  }
  return { error: firstError || `provider cannot express requested effort=${requestedEffort}` };
}

module.exports = { SUPPORTED_EFFORTS, EXTREME_EFFORTS, EFFORT_BY_TASK_TIER,
  normalizeEffort, parseReasoningEffortAssignment, findEffortControl,
  stripEffortControls, configuredEffortArgs, configuredReasoningEffortFamily,
  modelImpliedEffort, applyProviderEffort, resolveProviderEffort, effortLadderDown };
