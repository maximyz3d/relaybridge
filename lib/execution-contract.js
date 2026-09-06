'use strict';

const crypto = require('node:crypto');
const { resolveModelArgs, modelTierForTaskTier, MODEL_FLAGS, normalizeSuppressArgs } = require('./model-tiers');
const { applyProviderEffort, findEffortControl, EFFORT_BY_TASK_TIER, SUPPORTED_EFFORTS, EXTREME_EFFORTS } = require('./effort-controls');
const { linkedAccountArgsFor } = require('./provider-accounts');
const { validationError } = require('./validation-contract');

const TASK_TIERS = ['deterministic', 'utility', 'standard', 'complex', 'critical'];
const MODEL_TIERS = ['light', 'standard', 'heavy'];
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const fail = (code, field, reason, extra) => { throw validationError(code, field, reason, extra); };
const family = (model) => String(model || '').replace(/-(minimal|none|low|medium|high|xhigh|max|fast)$/i, '').toLowerCase();

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function fingerprint(value) { return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
function optionalEnum(value, values, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !values.includes(value.trim().toLowerCase())) fail('invalid_control', field, `Unsupported ${field} value.`);
  return value.trim().toLowerCase();
}
function modelId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$/.test(value)) {
    fail('invalid_model', 'model', 'Model must be a bounded exact identifier without whitespace or control characters.');
  }
  return value;
}
function validateControlRequest({ taskTier, modelTier, model, effort, maxEffortOverride } = {}) {
  optionalEnum(taskTier, TASK_TIERS, 'taskTier');
  optionalEnum(modelTier, MODEL_TIERS, 'modelTier');
  optionalEnum(effort, SUPPORTED_EFFORTS, 'effort');
  if (model !== undefined && model !== null) modelId(model);
  if (maxEffortOverride !== undefined && typeof maxEffortOverride !== 'boolean') fail('invalid_control', 'maxEffortOverride', 'maxEffortOverride must be a boolean.');
}
function providerArgumentStart(args) {
  // Python's launcher consumes -m itself. It is not the provider's short
  // --model alias. Keep the interpreter/module prefix intact on assembly.
  if (/^(?:python(?:\d+(?:\.\d+)*)?|py)(?:\.exe)?$/i.test(String(args[0] || '').split(/[\\/]/).at(-1))) {
    for (let index = 1; index < args.length; index++) {
      if (args[index] === '-m' && typeof args[index + 1] === 'string' && !args[index + 1].startsWith('-')) return index + 2;
      if (args[index] === '--' || !args[index].startsWith('-')) return index + 1;
    }
  }
  return 0;
}
function modelControls(args, entry) {
  const flags = new Set([...MODEL_FLAGS, ...(Array.isArray(entry.model_flags) ? entry.model_flags : [])]);
  const controls = [];
  for (let index = providerArgumentStart(args); index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') break;
    if (typeof arg !== 'string') continue;
    const equalAt = arg.indexOf('=');
    const flag = equalAt < 0 ? arg : arg.slice(0, equalAt);
    if (!flags.has(flag)) continue;
    const value = equalAt < 0 ? args[index + 1] : arg.slice(equalAt + 1);
    modelId(value);
    controls.push({ index, width: equalAt < 0 ? 2 : 1, flag, value, inline: equalAt >= 0 });
    if (equalAt < 0) index++;
  }
  return controls;
}
function removeModelControls(args, entry) {
  const out = args.slice();
  for (const control of modelControls(out, entry).reverse()) out.splice(control.index, control.width);
  return out;
}
function suppress(args, specs) {
  const out = args.slice();
  for (const { flag, valueCount } of normalizeSuppressArgs(specs)) {
    for (let index = 0; index < out.length;) {
      if (out[index] === '--') break;
      if (out[index] === flag) {
        if (index + valueCount >= out.length || out.slice(index + 1, index + valueCount + 1).includes('--')) {
          fail('unsupported_model_control', 'provider', 'Suppressed provider control is missing its declared value before the argument delimiter.');
        }
        out.splice(index, valueCount + 1);
      }
      else if (typeof out[index] === 'string' && out[index].startsWith(flag + '=') && valueCount === 1) out.splice(index, 1);
      else index++;
    }
  }
  return out;
}
function configuredModels(entry) {
  return MODEL_TIERS.flatMap((tier) => {
    const spec = own(entry.model_tiers || {}, tier) ? entry.model_tiers[tier] : null;
    if (!spec) return [];
    const args = Array.isArray(spec) ? spec : spec.args;
    if (!Array.isArray(args) || !args.length || args.some((arg) => typeof arg !== 'string')) fail('unsupported_model_control', 'provider', 'Configured model tier needs a valid argument template.');
    const controls = modelControls(args, entry);
    if (args.includes('--')) fail('unsupported_model_control', 'provider', 'Model control templates cannot introduce an argument delimiter.');
    const model = Array.isArray(spec) ? controls[0]?.value : spec.model || controls[0]?.value;
    if (!model) fail('unsupported_model_control', 'provider', 'Configured model tier needs an exact model selector.');
    modelId(model);
    if (controls.length !== 1 || controls[0].value !== model) fail('unsupported_model_control', 'provider', 'Configured model selector is missing, ambiguous, or inconsistent with its identifier.');
    return [{ model, modelTier: tier, args: args.slice(), suppressArgs: Array.isArray(spec) ? [] : normalizeSuppressArgs(spec.suppress_args) }];
  });
}
function censusModels(registry, kind) {
  const census = registry?.providers?.[kind];
  if (!census || census.probed !== true || census.error || !Array.isArray(census.models)) return null;
  return census.models.map((row) => typeof row === 'string' ? row : row?.id).filter((id) => typeof id === 'string');
}
function isAlias(model, entry) {
  // Alias eligibility must be an explicit operator declaration; a short
  // alphabetic identifier can still name a retired model.
  return Array.isArray(entry.models_static) && entry.models_static.includes(model);
}
function modelTemplate(model, specs, available, baseControls, entry, modelTier) {
  const configured = specs.find((spec) => spec.model === model);
  if (configured) return { ...configured, modelTier: modelTier || configured.modelTier };
  if (available?.includes(model)) {
    const related = specs.find((spec) => family(spec.model) === family(model));
    const templates = related ? [related] : specs;
    const selectors = new Set(templates.map((spec) => modelControls(spec.args, entry)[0]?.flag));
    if (templates.length && selectors.size === 1) {
      const source = templates[0];
      const args = source.args.slice();
      const control = modelControls(args, entry)[0];
      if (control.inline) args[control.index] = `${control.flag}=${model}`;
      else args[control.index + 1] = model;
      return { ...source, model, args, modelTier: modelTier || source.modelTier };
    }
    if (!templates.length && baseControls.length === 1) {
      return { model, modelTier, args: [baseControls[0].flag, model], suppressArgs: [], fixed: true };
    }
  }
  if (baseControls.length === 1 && baseControls[0].value === model) {
    return { model, modelTier, args: [baseControls[0].flag, model], suppressArgs: [], fixed: true };
  }
  if ((entry.model === model || entry.oneshot_model === model) && baseControls.length === 0) {
    return { model, modelTier, args: [], suppressArgs: [], fixed: true };
  }
  fail(available?.includes(model) ? 'unsupported_model_control' : 'model_unavailable', 'model',
    'The exact model is not configured or cannot be selected by a supported provider control.');
}

const CONTRACT_FIELDS = ['version', 'provider', 'authorityMode', 'model', 'requestedTaskTier', 'resolvedTaskTier',
  'requestedModelTier', 'resolvedModelTier', 'requestedEffort', 'targetEffort', 'appliedEffort', 'effortSource',
  'effortMethod', 'effortControl', 'effortFallbackReason', 'configFingerprint'];
function validateContract(value, kind, mode, currentFingerprint) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || CONTRACT_FIELDS.some((field) => !own(value, field))
    || Object.keys(value).some((field) => !CONTRACT_FIELDS.includes(field))
    || value.version !== 1 || value.provider !== kind || value.authorityMode !== mode) {
    fail('invalid_execution_contract', 'execution', 'Execution contract version, provider, authority mode, or fields do not match this request.');
  }
  if (value.configFingerprint !== currentFingerprint) {
    fail('execution_config_changed', 'execution', 'Provider controls changed after planning; obtain a new plan.', {
      expectedFingerprint: typeof value.configFingerprint === 'string' && /^[0-9a-f]{64}$/.test(value.configFingerprint) ? value.configFingerprint : undefined,
      observedFingerprint: currentFingerprint,
    });
  }
  if (value.model !== null) modelId(value.model);
  for (const field of ['requestedTaskTier', 'resolvedTaskTier']) optionalEnum(value[field], TASK_TIERS, 'execution');
  for (const field of ['requestedModelTier', 'resolvedModelTier']) optionalEnum(value[field], MODEL_TIERS, 'execution');
  for (const field of ['requestedEffort', 'targetEffort', 'appliedEffort']) optionalEnum(value[field], SUPPORTED_EFFORTS, 'execution');
  if (!['request', 'task_tier', 'provider_default'].includes(value.effortSource)
    || typeof value.effortMethod !== 'string' || value.effortMethod.length > 96
    || (value.effortControl !== null && (typeof value.effortControl !== 'string' || value.effortControl.length > 128))
    || (value.effortFallbackReason !== null && (typeof value.effortFallbackReason !== 'string' || value.effortFallbackReason.length > 512))) {
    fail('invalid_execution_contract', 'execution', 'Execution contract controls must be bounded normalized scalar values.');
  }
}

// This unsigned tuple is intent, not authority and not executable argv. Every
// replay reconstructs arguments from current server-owned provider controls.
function resolveProviderControls({ kind, entry = {}, registry, slot, taskTier, modelTier, model,
  effort, maxEffortOverride, execution, phase = 'execute', dangerous = false } = {}) {
  validateControlRequest({ taskTier, modelTier, model, effort, maxEffortOverride });
  if (!Array.isArray(slot) || !slot.length || slot.some((arg) => typeof arg !== 'string')) fail('invalid_provider_slot', 'provider', 'Provider needs a valid configured one-shot argument list.');
  if (maxEffortOverride !== undefined && typeof maxEffortOverride !== 'boolean') fail('invalid_control', 'maxEffortOverride', 'maxEffortOverride must be a boolean.');
  const mode = dangerous ? 'dangerous' : 'safe';
  let accountArgs;
  try { accountArgs = linkedAccountArgsFor(entry); }
  catch { fail('invalid_account_controls', 'provider', 'Linked account arguments are invalid.'); }
  if (accountArgs.length && (accountArgs.includes('--') || slot.includes('--')
    || accountArgs.some((arg) => /^--print-timeout(?:=|$)/.test(arg) || arg.includes('{supervisor_print_timeout}'))
    || modelControls(['account-controls', ...accountArgs], entry).length || findEffortControl(accountArgs))) {
    fail('invalid_account_controls', 'provider', 'Linked account arguments cannot change model, effort, timeout, or argument delimiter semantics.');
  }
  const specs = configuredModels(entry);
  const configFingerprint = fingerprint({ slot, mode, models: specs,
    model: entry.model || null, oneshot_model: entry.oneshot_model || null,
    adapter: entry.oneshot_adapter || null, model_flags: entry.model_flags || null,
    linked_account_args: accountArgs,
    print_timeout_policy: entry.print_timeout_policy ?? null,
    models_static: entry.models_static || null, oneshot_env: entry.oneshot_env || null, strip_env: entry.strip_env || null,
    model_arg_index: entry.model_arg_index ?? null, effort_flags: entry.effort_flags || null,
    effort_arg_index: entry.effort_arg_index ?? null });
  if (execution !== undefined && execution !== null) validateContract(execution, kind, mode, configFingerprint);
  const contract = execution || null;
  for (const [field, value, planned] of [['taskTier', taskTier, contract?.requestedTaskTier],
    ['modelTier', modelTier, contract?.requestedModelTier], ['effort', effort, contract?.requestedEffort], ['model', model, contract?.model]]) {
    if (contract && value !== undefined && value !== null && value !== planned) {
      // Flat tier fields may carry the plan's resolved tier as a convenience.
      const resolved = field === 'taskTier' ? contract.resolvedTaskTier : field === 'modelTier' ? contract.resolvedModelTier : undefined;
      if (value !== resolved) fail('execution_control_conflict', field, 'Request controls conflict with the supplied execution contract.');
    }
  }
  const requestedTaskTier = optionalEnum(contract ? contract.requestedTaskTier : taskTier, TASK_TIERS, 'taskTier');
  const requestedModelTier = optionalEnum(contract ? contract.requestedModelTier : modelTier, MODEL_TIERS, 'modelTier');
  const requestedEffort = optionalEnum(contract ? contract.requestedEffort : effort, SUPPORTED_EFFORTS, 'effort');
  if (EXTREME_EFFORTS.has(requestedEffort) && phase !== 'plan' && maxEffortOverride !== true) fail('extreme_effort_requires_override', 'maxEffortOverride', 'Explicit xhigh/max effort requires maxEffortOverride=true.');
  const resolvedTaskTier = requestedTaskTier || 'standard';
  const desiredTier = requestedModelTier || modelTierForTaskTier(resolvedTaskTier);
  const targetEffort = requestedEffort || (requestedTaskTier ? EFFORT_BY_TASK_TIER[requestedTaskTier] : null);
  const available = censusModels(registry, kind);
  const baseControls = modelControls(slot, entry);
  if (new Set(baseControls.map((control) => control.value)).size > 1 && !specs.length) {
    fail('ambiguous_model_control', 'provider', 'Provider slot has conflicting fixed model controls.');
  }
  const exact = !!contract || (model !== undefined && model !== null);
  let selected;
  if (exact) {
    const exactModel = contract ? contract.model : modelId(model);
    if (exactModel === null && (entry.model || entry.oneshot_model || baseControls.length)) {
      fail('unsupported_model_control', 'execution', 'This provider requires its configured model and cannot reproduce account-default intent.');
    }
    selected = exactModel === null
      ? { model: null, modelTier: contract.resolvedModelTier, args: [], suppressArgs: [] }
      : modelTemplate(exactModel, specs, available, baseControls, entry, contract?.resolvedModelTier || null);
    if (!selected.modelTier) selected.modelTier = desiredTier;
  } else {
    const tierChoice = resolveModelArgs({ entry, taskTier: resolvedTaskTier, modelTier: desiredTier });
    selected = specs.find((spec) => spec.modelTier === tierChoice.modelTier) || null;
    if (!selected) {
      const fixed = baseControls[0]?.value || entry.model || entry.oneshot_model || null;
      selected = { model: fixed, modelTier: desiredTier, args: baseControls[0] ? [baseControls[0].flag, fixed] : [], suppressArgs: [], fixed: !!fixed };
    }
  }
  if (selected.model && available && !available.includes(selected.model) && !isAlias(selected.model, entry)) {
    fail('model_unavailable', 'model', 'The exact selected model is absent from the available provider catalog; refresh or explicitly select another model.');
  }
  const assemble = (choice) => {
    const suppressed = suppress(slot, choice.suppressArgs);
    const firstSelector = modelControls(suppressed, entry)[0]?.index;
    let out = removeModelControls(suppressed, entry);
    if (choice.args.length) {
      const delimiter = out.indexOf('--');
      const ceiling = delimiter >= 0 ? delimiter : out.length;
      const preferred = Number.isInteger(entry.model_arg_index) ? entry.model_arg_index
        : firstSelector ?? (providerArgumentStart(out) || (out[1] && !out[1].startsWith('-') ? 2 : 1));
      const at = Math.max(1, Math.min(preferred, ceiling));
      out.splice(at, 0, ...choice.args);
    }
    return out;
  };
  let resolvedSlot = assemble(selected);
  const httpAdapter = ['ollama_api', 'openai_chat_api'].includes(entry.oneshot_adapter);
  if (httpAdapter && requestedEffort) fail('unsupported_effort', 'effort', 'This HTTP adapter does not send a reasoning-effort control.');
  let effortResolution = httpAdapter ? { slot: resolvedSlot, appliedEffort: null, method: 'not_supported', control: null }
    : applyProviderEffort({ slot: resolvedSlot, entry,
    modelChoice: selected.fixed ? { model: selected.model } : selected, requestedEffort: targetEffort });
  if (effortResolution.error && !exact && targetEffort && selected.model) {
    const variant = [...specs.map((spec) => spec.model), ...(available || [])]
      .find((id) => id.toLowerCase() === `${family(selected.model)}-${targetEffort}`);
    if (variant) {
      const variantSpec = modelTemplate(variant, specs, available, baseControls, entry, selected.modelTier);
      selected = variantSpec;
      resolvedSlot = assemble(selected);
      effortResolution = applyProviderEffort({ slot: resolvedSlot, entry, modelChoice: selected, requestedEffort: targetEffort });
    }
  }
  let effortFallbackReason = httpAdapter && targetEffort ? 'This HTTP adapter does not send a reasoning-effort control.' : null;
  if (effortResolution.error && !requestedEffort) {
    effortFallbackReason = effortResolution.error;
    effortResolution = applyProviderEffort({ slot: resolvedSlot, entry,
      modelChoice: selected.fixed ? { model: selected.model } : selected, requestedEffort: null });
  }
  if (effortResolution.error) fail('unsupported_effort', 'effort', 'The selected exact model and provider controls cannot express the requested effort.');
  // Variant resolution is another selection; its final model must pass the
  // catalog check too, including configured variants absent from a good census.
  if (selected.model && available && !available.includes(selected.model) && !isAlias(selected.model, entry)) {
    fail('model_unavailable', 'model', 'The exact selected model is absent from the available provider catalog; refresh or explicitly select another model.');
  }
  const appliedExtreme = EXTREME_EFFORTS.has(effortResolution.appliedEffort);
  const explicitlyExtreme = EXTREME_EFFORTS.has(requestedEffort)
    || (exact && /-(xhigh|max)$/i.test(selected.model || ''));
  if (appliedExtreme && phase !== 'plan' && maxEffortOverride !== true) {
    fail('extreme_effort_requires_override', 'maxEffortOverride', 'The selected model applies xhigh/max effort and requires maxEffortOverride=true.');
  }
  if (maxEffortOverride === true && !explicitlyExtreme) fail('invalid_control', 'maxEffortOverride', 'maxEffortOverride applies only to an explicit xhigh/max effort or exact model request.');
  const outgoing = modelControls(effortResolution.slot, entry);
  if (outgoing.length > 1 || (outgoing[0] && outgoing[0].value !== selected.model)
    || (selected.args.length && !outgoing.length)) fail('ambiguous_model_control', 'provider', 'Outgoing model controls do not match the resolved exact model.');
  const normalized = { version: 1, provider: kind, authorityMode: mode, model: selected.model,
    requestedTaskTier, resolvedTaskTier, requestedModelTier, resolvedModelTier: selected.modelTier,
    requestedEffort, targetEffort, appliedEffort: effortResolution.appliedEffort,
    effortSource: requestedEffort ? 'request' : requestedTaskTier ? 'task_tier' : 'provider_default',
    effortMethod: effortResolution.method, effortControl: effortResolution.control,
    effortFallbackReason, configFingerprint };
  if (contract && fingerprint(contract) !== fingerprint(normalized)) fail('execution_contract_changed', 'execution', 'The planned model/effort tuple cannot be reproduced exactly with current provider controls.');
  return { slot: effortResolution.slot, modelChoice: { ...selected, source: exact ? 'exact' : selected.fixed ? 'configured_fixed' : selected.model ? 'configured' : 'account_default' },
    effortResolution, execution: normalized, diagnostics: { effortFallbackReason } };
}

module.exports = { resolveProviderControls, validateControlRequest, modelControls, fingerprint, CONTRACT_FIELDS };
