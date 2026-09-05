'use strict';

// Shared provider effort controls. Planning and execution must use the same
// resolver; separate interpretations can turn a promised model/effort into a
// different invocation. Existing wire semantics are preserved here.
const SUPPORTED_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const EXTREME_EFFORTS = new Set(['xhigh', 'max']);
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
    if ((arg === '--effort' || arg === '--reasoning-effort') && index + 1 < args.length) {
      const effort = normalizeEffort(String(args[index + 1]));
      if (effort) return { index, width: 2, effort, flag: arg, method: 'flag' };
    }
    if ((arg === '--config' || arg === '-c') && index + 1 < args.length) {
      const assignment = parseReasoningEffortAssignment(args[index + 1]);
      if (assignment) {
        return {
          index, width: 2, effort: assignment.effort, flag: arg,
          configKey: assignment.key, method: 'config',
        };
      }
    }
    const inlineConfig = /^--config=(.*)$/i.exec(String(arg || ''));
    const assignment = inlineConfig ? parseReasoningEffortAssignment(inlineConfig[1]) : null;
    if (assignment) {
      return {
        index, width: 1, effort: assignment.effort, flag: '--config',
        configKey: assignment.key, method: 'config',
      };
    }
  }
  return null;
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
  const at = effortArgsInsertIndex(out, entry, preferredIndex);
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
  const suffix = /(?:^|-)(minimal|low|medium|high|xhigh|max)$/i.exec(String(modelChoice.model));
  if (suffix) return suffix[1].toLowerCase();
  // A configured weight class is the only effort expression for several local
  // providers.  Do not make this claim for Codex-style seats, where model size
  // and reasoning effort are independent controls.
  if (entry.effort_flags && Object.keys(entry.effort_flags).length) return null;
  return { light: 'low', standard: 'medium', heavy: 'high' }[modelChoice.modelTier] || null;
}

function applyProviderEffort({ slot, entry = {}, modelChoice = {}, requestedEffort = null }) {
  const existing = findEffortControl(slot);
  if (!requestedEffort) {
    if (existing) {
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
  if (!effortArgs && requestedEffort === 'xhigh' && configFamily) {
    effortArgs = [configFamily.flag, `${configFamily.key}=xhigh`];
    method = 'effort_flags';
  }

  if (!effortArgs && existing?.method === 'flag') {
    effortArgs = [existing.flag, requestedEffort];
    method = 'flag';
  }
  if (!effortArgs && existing?.method === 'config' && requestedEffort !== 'max') {
    effortArgs = [existing.flag, `${existing.configKey}=${requestedEffort}`];
    method = 'effort_flags';
  }

  if (effortArgs) {
    const actual = findEffortControl(effortArgs);
    if (!actual) {
      return { error: 'configured effort_flags do not contain a recognized effort control' };
    }
    const stripped = stripEffortControls(slot);
    return {
      slot: insertEffortArgs(stripped.args, effortArgs, entry, stripped.firstRemovedAt),
      appliedEffort: actual.effort,
      method,
      control: actual.configKey ? `${actual.flag} ${actual.configKey}` : actual.flag,
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


module.exports = { SUPPORTED_EFFORTS, EXTREME_EFFORTS, EFFORT_BY_TASK_TIER,
  normalizeEffort, parseReasoningEffortAssignment, findEffortControl,
  stripEffortControls, configuredEffortArgs, configuredReasoningEffortFamily,
  modelImpliedEffort, applyProviderEffort };
