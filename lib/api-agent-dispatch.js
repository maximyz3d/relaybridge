'use strict';

// Internal API agent dispatcher. There is no public HTTP route for it yet.
// Every entry point performs full re-admission: a freshly resolved funding
// decision that allows included API credit or an owner-authorized prepaid or
// promotional permit (whose model allowlist is checked here; a promotional
// permit never admits a writer), an exact model capability, the
// credential fingerprint the qualification was issued for, a binding check
// against the stored checkpoint, and an exclusive checkpoint lease.
//
// The provider key is read only here, at dispatch, through the injected
// reader. It is never logged, stored or placed in a receipt.

const fs = require('node:fs');
const path = require('node:path');
const { ENDPOINTS, SURFACES, WIRES, API_MODEL_CAPABILITIES, resolveApiModel, digest } = require('./api-agent-wire');
const { driveApiAgentRun, linkedSeed, RESUMABLE_CLASSES } = require('./api-agent-run');
const { RunSupervisor } = require('./run-supervisor');
const { createAttemptLifecycle } = require('./attempt-lifecycle');
const { redactSecrets, MIN_CREDENTIAL_LENGTH, toolsetHashFor } = require('./api-agent-tools');
const { executionBindingHash, pendingPatchEffects } = require('./api-agent-checkpoint');
const { WRITE_BOUNDARY, READ_ONLY_BOUNDARY, recoverPatchEffects, validRecord } = require('./api-agent-patch');
const { hash: canonicalHash } = require('./candidate-stage');
const { isApiDecision } = require('./funding-routing');

const fail = (code, message, extra = {}) => { throw Object.assign(new Error(message || code), { code, ...extra }); };
const BINDING_FIELDS = Object.freeze(['provider', 'apiModel', 'effort', 'profileId', 'profileRevision', 'organization', 'project',
  'creditPeriod', 'credentialFingerprint', 'decisionHash', 'cwdIdentityHash', 'toolsetHash', 'writePathsHash', 'fundingPolicy']);
// Fields a linked attempt must share with its parent; the rest are re-admitted fresh.
// fundingPolicy is present only for owner-authorized prepaid or promotional
// runs, so a grant binding (and its digest) is unchanged and a link can never
// switch policy.
const LINK_FIELDS = Object.freeze(['provider', 'apiModel', 'effort', 'cwdIdentityHash', 'toolsetHash', 'writePathsHash', 'fundingPolicy']);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const HASH = /^[a-f0-9]{64}$/;

// A binding stored before tool sets were bound carries neither field; such a
// checkpoint could only have been read-only, so it normalizes to exactly that
// and can never match a writer admission.
function normalizeBinding(binding) {
  if (!binding || typeof binding !== 'object') return binding;
  if (!Object.hasOwn(binding, 'toolsetHash') && !Object.hasOwn(binding, 'writePathsHash')) {
    return { ...binding, toolsetHash: toolsetHashFor(false), writePathsHash: null };
  }
  return binding;
}

// admission.writer: { allowedWritePaths, writePathsHash, assertHeld, execution: { unifiedRunId, segment, taskId } }
function validWriter(writer) {
  if (writer === undefined || writer === null) return null;
  if (typeof writer !== 'object' || !Array.isArray(writer.allowedWritePaths) || !writer.allowedWritePaths.length
    || writer.allowedWritePaths.some((p) => typeof p !== 'string' || !p) || typeof writer.writePathsHash !== 'string'
    || !HASH.test(writer.writePathsHash) || typeof writer.assertHeld !== 'function' || !writer.execution
    || typeof writer.execution.unifiedRunId !== 'string' || !Number.isSafeInteger(writer.execution.segment)
    || typeof writer.execution.taskId !== 'string') {
    fail('api_write_contract_invalid', 'The writer admission is incomplete.');
  }
  return writer;
}

function createApiAgentDispatcher({ fetchImpl, store, readCredential, createTools, registry,
  capabilities = API_MODEL_CAPABILITIES, supervisorOptions = {}, hooks = {} } = {}) {
  if (typeof fetchImpl !== 'function' || !store || typeof readCredential !== 'function'
    || typeof createTools !== 'function' || !(registry instanceof Map)) {
    throw new TypeError('API agent dispatcher requires fetch, store, credential reader, tools factory and lifecycle registry');
  }

  // admission: { resolveDecision(): decision, expectedDecisionHash?, cwd, cwdIdentityHash, revalidateCwd?, deniedPaths?, writer? }
  function admit({ admission, model, effort }) {
    if (!admission || typeof admission.resolveDecision !== 'function') fail('api_dispatch_unavailable', 'Admission context is missing.');
    const writer = validWriter(admission.writer);
    const decision = admission.resolveDecision();
    if (!isApiDecision(decision)) {
      fail(decision?.blockedReason || 'api_dispatch_unavailable', 'API agent dispatch is not allowed for this request.');
    }
    const prepaid = decision.actual === 'authorized_prepaid';
    const promotional = decision.actual === 'authorized_promotional';
    const permit = prepaid ? decision.prepaid : promotional ? decision.promotional : null;
    if (promotional && writer) fail('api_write_unauthorized', 'Owner-authorized promotional credit runs only the read-only API agent.');
    if (admission.expectedDecisionHash && admission.expectedDecisionHash !== decision.decisionHash) {
      fail('funding_decision_changed', 'The funding decision changed after admission.');
    }
    const provider = decision.identity.provider;
    const resolved = resolveApiModel(provider, model, effort ?? null, capabilities);
    // Checked here so one-shot, resume and linked attempts are all covered.
    if (prepaid && !decision.prepaid.models.includes(resolved.apiModel)) {
      fail('prepaid_model_not_permitted', 'The owner prepaid authorization does not permit this model.');
    }
    if (promotional && !decision.promotional.models.includes(resolved.apiModel)) {
      fail('promotional_model_not_permitted', 'The owner promotional authorization does not permit this model.');
    }
    const credential = readCredential(provider);
    if (typeof credential !== 'string' || credential.length < MIN_CREDENTIAL_LENGTH) fail('api_credential_unbound', 'The reserved credential is not available.');
    const credentialFingerprint = store.fingerprint(credential);
    if (credentialFingerprint !== decision.qualification.credentialFingerprint) {
      fail('funding_decision_changed', 'The credential changed after qualification.');
    }
    if (typeof admission.cwd !== 'string' || typeof admission.cwdIdentityHash !== 'string') fail('api_dispatch_unavailable', 'Workspace identity is missing.');
    const binding = { provider, apiModel: resolved.apiModel, effort: resolved.effort,
      profileId: decision.requested.profileId, profileRevision: decision.identity.profileRevision,
      organization: decision.identity.organization, project: decision.identity.project,
      creditPeriod: decision.identity.creditPeriod, credentialFingerprint, decisionHash: decision.decisionHash,
      cwdIdentityHash: admission.cwdIdentityHash, toolsetHash: toolsetHashFor(!!writer), writePathsHash: writer ? writer.writePathsHash : null,
      ...(permit ? { fundingPolicy: { policy: decision.fundingPolicy, authorizationId: permit.authorizationId,
        authorizationHash: permit.authorizationHash } } : {}) };
    const execution = writer ? { unifiedRunId: writer.execution.unifiedRunId, segment: writer.execution.segment,
      taskId: writer.execution.taskId, apiBindingHash: digest(binding), toolsetHash: binding.toolsetHash,
      writePathsHash: binding.writePathsHash } : null;
    return { decision, provider, resolved, credential, binding, writer, execution };
  }

  function assertBinding(stored, fresh, fields = BINDING_FIELDS) {
    const normalized = normalizeBinding(stored);
    const changed = fields.filter((f) => !same(normalized?.[f], fresh[f]));
    if (changed.length) fail('checkpoint_binding_stale', 'The checkpoint binding no longer matches this admission.', { changedFields: changed });
  }

  // reauthorize: optional caller re-admission checked before every turn is sent.
  // Anything but `true` stops the run before the request; that turn stays not_sent.
  async function execute({ admitted, handle, deliver, releaseAdmission, signal: outerSignal, kind = null, route: baseRoute = {}, reauthorize = null }) {
    const { decision, provider, resolved, credential, writer } = admitted;
    const runId = `run_${handle.runId}`;
    const route = { ...baseRoute, provider: kind || baseRoute.provider || provider, run_id: runId,
      funding: { actual: decision.actual, decisionHash: decision.decisionHash, qualificationId: decision.qualification.qualificationId,
        ...(decision.actual === 'authorized_prepaid' ? { policy: decision.fundingPolicy, authorizationId: decision.prepaid.authorizationId,
          expiresAt: decision.prepaid.expiresAt, grantOnly: false, providerControls: { ...decision.prepaid.providerControls },
          limitations: [...decision.prepaid.limitations] } : {}),
        ...(decision.actual === 'authorized_promotional' ? { policy: decision.fundingPolicy, authorizationId: decision.promotional.authorizationId,
          expiresAt: decision.promotional.expiresAt, grantOnly: false, fundingSource: decision.fundingSource,
          providerControls: { ...decision.promotional.providerControls }, limitations: [...decision.promotional.limitations],
          reserveRelease: 'never' } : {}) } };
    const controller = new AbortController();
    let tools, supervisor, lifecycle;
    // The attempt can make no further effect once it returns here; for a
    // writer run that is recorded as lifecycle_settled stopped evidence.
    const release = () => { try { handle.release({ stopped: true }); } catch {} };
    try {
      tools = createTools({ writer: writer ? { allowedWritePaths: writer.allowedWritePaths, assertHeld: writer.assertHeld, journal: handle } : null });
      if (tools.toolsetHash !== undefined && tools.toolsetHash !== admitted.binding.toolsetHash) {
        fail('checkpoint_binding_stale', 'The registered tool set does not match the admitted binding.');
      }
      if (writer && (!tools.writer || !same([...tools.writer.allowedWritePaths], writer.allowedWritePaths))) {
        fail('api_write_contract_invalid', 'The tool set does not carry the admitted write list.');
      }
      supervisor = new RunSupervisor({ ...supervisorOptions, stallAction: 'notify', hardDeadline: false });
      lifecycle = createAttemptLifecycle({ runId, kind: route.provider, route, supervisor, registry,
        releaseAdmission: typeof releaseAdmission === 'function' ? releaseAdmission : () => {}, tickMs: 1000 });
    } catch (error) {
      // Nothing was dispatched; the lifecycle never took ownership of admission.
      try { tools?.close?.(); } catch {}
      release();
      if (!lifecycle && typeof releaseAdmission === 'function') releaseAdmission();
      throw error;
    }
    lifecycle.bindTransport({ type: 'http', requestStop: () => controller.abort() });
    const onOuterAbort = () => lifecycle.requestStop({ reason: 'client_cancelled', detail: 'Caller cancelled the API agent run.', source: 'client' });
    if (outerSignal) { if (outerSignal.aborted) onOuterAbort(); else outerSignal.addEventListener('abort', onOuterAbort, { once: true }); }
    let result = null, failure = null;
    try {
      result = await driveApiAgentRun({ handle, provider, model: resolved, tools, fetchImpl, endpoint: ENDPOINTS[provider],
        credential, signal: controller.signal, hooks,
        headerContext: provider === 'openai' ? { organization: admitted.binding.organization, project: admitted.binding.project } : {},
        // Only qualified included credit can carry reserve-release evidence;
        // prepaid exhaustion is terminal and never releases the reserve.
        qualificationActive: decision.actual === 'included_api_credit',
        beforeDispatch: () => {
          const state = lifecycle.snapshot();
          if (state.stop) return false;
          if (typeof reauthorize === 'function') {
            let current = false;
            try { current = reauthorize() === true; } catch { current = false; }
            if (!current) {
              lifecycle.requestStop({ reason: 'funding_decision_changed', detail: 'Funding authorization changed before the next turn.', source: 'funding' });
              return false;
            }
          }
          return state.dispatched ? true : lifecycle.markDispatched();
        },
        onTurn: (turn) => {
          lifecycle.observeUsage({ ...turn.totalUsage, turns: turn.index }, 'incremental');
          if (turn.text) lifecycle.observeOutput(turn.text);
        } });
    } catch (error) {
      failure = { code: typeof error.code === 'string' ? error.code : 'api_agent_failed', message: redactSecrets(String(error.message || error), [credential]).slice(0, 600) };
    } finally {
      if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
      try { tools.close?.(); } catch {}
      release();
    }
    const receipt = buildReceipt({ provider, resolved, handle, result, failure, route, supervisor, credential, writer });
    lifecycle.sealOutcome(receipt);
    const state = lifecycle.snapshot();
    let delivered = receipt;
    await lifecycle.settlePhysical({ evidence: state.dispatched ? 'http_transport_settled' : 'not_dispatched',
      persist: async ({ snapshot }) => {
        delivered = { ...receipt, transport_lifecycle: snapshot };
        if (typeof deliver === 'function') await deliver(delivered);
      } });
    return delivered;
  }

  function buildReceipt({ provider, resolved, handle, result, failure, route, supervisor, credential, writer }) {
    const cls = failure ? failure.code : result.outcome?.class || 'interrupted';
    const completed = !failure && result.status === 'terminal' && cls === 'completed';
    const priorTurns = result ? result.turns.filter((t) => t.state !== 'not_sent').length : 0;
    const apiAgent = { provider, surface: SURFACES[provider], requested_model: resolved.apiModel, effort: resolved.effort,
      observed_model: result?.observedModels?.at(-1) ?? null, observed_models: result?.observedModels ?? [],
      turns: result ? result.turns.map((t) => ({ index: t.index, state: t.state, stop: t.stop, usage: t.usage, observed_model: t.observedModel })) : [],
      total_usage: result?.totalUsage ?? {}, outcome_class: cls, checkpoint_status: result?.status ?? null,
      resumable: !failure && result.status === 'resumable' && RESUMABLE_CLASSES.has(cls),
      checkpoint_run_id: handle.runId, supersedes: result?.supersedes ?? null,
      physical_attempt_count: result?.requestsThisAttempt ?? 0, model_invocation: priorTurns > 0,
      reserve_release_evidence: result?.reserveReleaseEvidence === true,
      uncertain_turn: result?.outcome?.uncertainTurn ?? null,
      patches: result?.patches ?? [], effects_pending: result?.outcome?.effectsPending ?? [],
      write_boundary: writer ? WRITE_BOUNDARY : READ_ONLY_BOUNDARY,
      ...(writer ? { allowed_write_paths: [...writer.allowedWritePaths] } : {}) };
    const text = redactSecrets(completed ? result.text : '', [credential]);
    return { exitCode: completed ? 0 : -1, stdout: text, stderr: failure ? failure.message : '',
      failureClass: completed ? null : cls, errorCode: failure ? failure.code : null, dropped_out: !completed,
      cancelled: cls === 'cancelled', rate_limited: cls === 'rate_limited', auth_failed: cls === 'auth', permission_denied: cls === 'permission',
      usage: apiAgent.total_usage, model_invocation: apiAgent.model_invocation, stop_reason: cls,
      partial_result: !completed && !!result?.lastText,
      ...(!completed && result?.lastText ? { partial_diagnostic: redactSecrets(result.lastText, [credential]).slice(0, 4000) } : {}),
      kind: route.provider, runId: route.run_id, route: { ...route, api_agent: apiAgent },
      physical_attempt_count: apiAgent.physical_attempt_count, progress: supervisor.snapshot() };
  }

  // New run. `admission` must come from the caller's own admission path.
  // `runId` may be pre-allocated by a caller that records it durably first.
  async function runApiAgentOneShot({ admission, prompt, system = null, model, effort = null, deliver, releaseAdmission, signal, kind, route, runId: preallocated = null, reauthorize = null }) {
    let admitted;
    try { admitted = admit({ admission, model, effort }); }
    catch (error) { if (typeof releaseAdmission === 'function') releaseAdmission(); throw error; }
    const wire = WIRES[admitted.provider];
    const runId = preallocated ?? store.newRunId();
    let handle;
    try {
      handle = store.create(runId, { binding: admitted.binding, initial: { state: wire.initialState({ prompt, system }) }, supersedes: null,
        ...(admitted.execution ? { execution: admitted.execution } : {}) });
    } catch (error) { if (typeof releaseAdmission === 'function') releaseAdmission(); throw error; }
    return execute({ admitted, handle, deliver, releaseAdmission, signal, kind, route, reauthorize });
  }

  // Explicit resume of an existing checkpoint. Terminal checkpoints return
  // their stored result with zero provider requests.
  async function resumeApiAgentRun({ runId, admission, model, effort = null, deliver, releaseAdmission, signal, kind, route, reauthorize = null }) {
    let admitted, handle;
    try {
      admitted = admit({ admission, model, effort });
      handle = store.acquire(runId);
      try {
        const { manifest } = handle.load();
        assertBinding(manifest.binding, admitted.binding);
        // A writer resumes only its own execution; a read-only checkpoint has none and never gains one.
        if (!same(manifest.execution ?? null, admitted.execution)) {
          fail('checkpoint_binding_stale', 'The checkpoint execution binding no longer matches this admission.', { changedFields: ['execution'] });
        }
      } catch (error) { handle.release({ stopped: true }); throw error; }
    } catch (error) { if (typeof releaseAdmission === 'function') releaseAdmission(); throw error; }
    return execute({ admitted, handle, deliver, releaseAdmission, signal, kind, route, reauthorize });
  }

  // The only way past an uncertain turn: a new run linked to its parent, with
  // explicit caller authorization and full re-admission. The parent
  // checkpoint is read only and never mutated or retried.
  async function startLinkedAttempt({ parentRunId, fromTurn, authorization, admission, model, effort = null, deliver, releaseAdmission, signal, kind, route, reauthorize = null, runId: preallocated = null }) {
    let admitted, handle;
    try {
      if (!authorization || authorization.parentRunId !== parentRunId || authorization.fromTurn !== fromTurn
        || authorization.confirmDuplicateBillingRisk !== true) {
        fail('linked_attempt_unauthorized', 'A linked attempt requires explicit authorization naming the parent and turn.');
      }
      admitted = admit({ admission, model, effort });
      const parent = store.load(parentRunId);
      assertBinding(parent.manifest.binding, admitted.binding, LINK_FIELDS);
      // A writer parent's effects must be settled before its conversation continues.
      if (parent.manifest.execution && pendingPatchEffects(parent).length) {
        fail('patch_outcome_uncertain', 'The parent checkpoint has unsettled patch effects.');
      }
      const seed = linkedSeed(admitted.provider, parent, fromTurn);
      handle = store.create(preallocated ?? store.newRunId(), { binding: admitted.binding, initial: { state: seed },
        supersedes: { parentRunId, fromTurn, parentOutcome: parent.manifest.outcome?.class ?? null },
        ...(admitted.execution ? { execution: admitted.execution } : {}) });
    } catch (error) { if (typeof releaseAdmission === 'function') releaseAdmission(); throw error; }
    return execute({ admitted, handle, deliver, releaseAdmission, signal, kind, route, reauthorize });
  }

  // ---- writer effects ------------------------------------------------------
  // expect: { unifiedRunId, segment, writePathsHash } — the unified-run
  // segment that owns this checkpoint. Its stored execution must name exactly
  // that segment, the writer tool set and the same write list.

  function checkpointExists(runId) {
    try { fs.lstatSync(path.join(store.root, runId)); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }

  function boundExecution(manifest, expect) {
    const execution = manifest?.execution;
    if (!execution || !expect || execution.unifiedRunId !== expect.unifiedRunId || execution.segment !== expect.segment
      || execution.writePathsHash !== expect.writePathsHash || execution.toolsetHash !== toolsetHashFor(true)
      || !same(normalizeBinding(manifest.binding)?.toolsetHash, execution.toolsetHash)
      || !same(manifest.binding?.writePathsHash, execution.writePathsHash) || execution.apiBindingHash !== digest(manifest.binding)) {
      fail('checkpoint_binding_stale', 'The checkpoint is not this segment\'s writer execution.');
    }
    return executionBindingHash(manifest);
  }

  // Predicate (c): every effect of the run is settled. A checkpoint that was
  // never created had no effect. Every patch record, committed ones included,
  // must be valid in its exact shape for the bound write list, match its
  // apply_patch tool record, and name only attempts proven stopped.
  function apiEffectsSettled({ runId, expect }) {
    if (!checkpointExists(runId)) return { settled: true, exists: false };
    let loaded;
    try { loaded = store.load(runId); } catch (error) { return { settled: false, exists: true, reason: error.code || 'checkpoint_unreadable' }; }
    let bindingHash;
    try { bindingHash = boundExecution(loaded.manifest, expect); } catch (error) { return { settled: false, exists: true, reason: error.code }; }
    if (loaded.manifest.status === 'active') return { settled: false, exists: true, reason: 'execution_active' };
    const owners = store.stoppedAttempts(runId, bindingHash);
    if (!owners) return { settled: false, exists: true, reason: 'owner_not_proven_stopped' };
    // No owning attempt is consistent only with a run that recorded nothing.
    if (!owners.length && (loaded.turns.length || loaded.tools.size || loaded.patches.size)) {
      return { settled: false, exists: true, reason: 'owner_not_proven_stopped' };
    }
    const allowed = Array.isArray(expect.allowedWritePaths)
      && canonicalHash({ version: 1, allowedWritePaths: expect.allowedWritePaths }) === expect.writePathsHash ? expect.allowedWritePaths : null;
    if (!allowed) return { settled: false, exists: true, reason: 'write_paths_unbound' };
    const stopped = new Set(owners);
    for (const [key, record] of [...loaded.patches].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const tool = loaded.tools.get(key);
      if (!validRecord(record, { runId, allowed }) || !tool || tool.name !== 'apply_patch' || tool.callId !== record.callId
        || tool.argsDigest !== record.argsDigest) return { settled: false, exists: true, reason: 'patch_record_invalid', effectsPending: [key] };
      if (!stopped.has(record.attemptNonce) || (record.recoveryNonce !== undefined && !stopped.has(record.recoveryNonce))) {
        return { settled: false, exists: true, reason: 'owner_not_proven_stopped', effectsPending: [key] };
      }
    }
    const pending = pendingPatchEffects(loaded);
    return pending.length ? { settled: false, exists: true, reason: 'patch_outcome_uncertain', effectsPending: pending }
      : { settled: true, exists: true, outcome: loaded.manifest.outcome?.class ?? null };
  }

  // Recovery of a stopped writer run's effects. No provider request, no
  // credential read. assertHeld must prove the workspace hold is still this
  // run's.
  function reconcileApiEffects({ runId, expect, cwd, allowedWritePaths, deniedPaths = [], assertHeld, revalidateCwd = null, hooks: recoverHooks = {} }) {
    if (!checkpointExists(runId)) return { settled: true, exists: false, patches: [], uncertain: [] };
    const bindingHash = boundExecution(store.load(runId).manifest, expect);
    return { exists: true, ...recoverPatchEffects({ store, runId, executionBindingHash: bindingHash, cwd, allowedWritePaths, deniedPaths,
      assertHeld, revalidateCwd, hooks: recoverHooks }) };
  }

  return Object.freeze({ runApiAgentOneShot, resumeApiAgentRun, startLinkedAttempt, apiEffectsSettled, reconcileApiEffects });
}

module.exports = { createApiAgentDispatcher, BINDING_FIELDS, LINK_FIELDS, normalizeBinding };
