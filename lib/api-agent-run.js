'use strict';

// Checkpointed API agent loop. The order per model turn is fixed:
//   persist turn intent -> beforeDispatch -> fetch -> persist received ->
//   for each tool call: persist intent, execute, persist done -> next turn.
// There is no turn, token or time budget. The loop ends only on completion,
// cancellation, a provider stop/error, or an uncertain outcome. A turn whose
// outcome is uncertain is never re-sent; the run becomes terminal and only a
// separately admitted linked attempt may continue the conversation.
// apply_patch, the one journaled tool, is never re-executed: a patch whose
// outcome is not proven committed makes the run terminal
// patch_outcome_uncertain until recovery settles it under a retained hold.

const { WIRES, ERROR_CLASSES, classifyProviderError, modelMatches, digest } = require('./api-agent-wire');
const { finalizeInterrupted, pendingPatchEffects, lastProviderError } = require('./api-agent-checkpoint');
const { patchSummary } = require('./api-agent-patch');
const { redactSecrets, MIN_CREDENTIAL_LENGTH } = require('./api-agent-tools');

const TERMINAL_STOPS = new Set(['completed', 'refusal', 'content_filter', 'output_limit_reached',
  'context_window_exceeded', 'provider_protocol_error']);
const RESUMABLE_CLASSES = new Set(['cancelled', 'interrupted', 'rate_limited', 'provider_unavailable']);
const MESSAGE_PREVIEW = 600;

const fail = (code, message) => { throw Object.assign(new Error(message || code), { code }); };
const nowIso = () => new Date().toISOString();

function sumUsage(rows) {
  const total = {};
  for (const usage of rows) {
    for (const [key, value] of Object.entries(usage || {})) {
      if (Number.isSafeInteger(value)) total[key] = (total[key] || 0) + value;
    }
  }
  if (total.total_tokens === undefined && (total.input_tokens !== undefined || total.output_tokens !== undefined)) {
    total.total_tokens = (total.input_tokens || 0) + (total.output_tokens || 0);
  }
  return total;
}

// Rebuild the provider-format conversation from durable records.
function rebuild(wire, manifest, turns, tools) {
  let state = manifest.initial.state;
  for (const turn of turns) {
    if (turn.state === 'not_sent' || (turn.state === 'received' && turn.response?.error)) continue;
    if (turn.state !== 'received') return { state, pendingTurn: turn };
    if (!turn.response.assistant) return { state, stopped: turn };
    state = wire.appendAssistant(state, turn.response.assistant);
    if (turn.response.stop !== 'tool_calls') continue;
    const records = turn.response.toolCalls.map((_, i) => tools.get(`${turn.index}:${i}`));
    if (records.some((r) => r?.state !== 'done')) return { state, pendingTools: turn };
    state = wire.appendToolResults(state, records.map((r) => ({ id: r.callId, output: r.result.output, isError: r.result.isError })));
  }
  return { state };
}

function lastModelTurn(turns) {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].state === 'received' && !turns[i].response?.error) return turns[i];
  }
  return null;
}

function summarize(handle, loaded, requests, extra = {}) {
  const { manifest, turns } = loaded;
  const modelTurns = turns.filter((t) => t.state === 'received' && t.response && !t.response.error);
  const last = lastModelTurn(turns);
  return {
    runId: handle.runId, status: manifest.status, outcome: manifest.outcome,
    text: manifest.status === 'terminal' && manifest.outcome?.class === 'completed' ? last?.response?.text ?? '' : '',
    lastText: last?.response?.text ?? '',
    turns: turns.map((t) => ({ index: t.index, state: t.state, stop: t.response?.stop ?? t.response?.error?.class ?? null,
      usage: t.response?.usage ?? null, observedModel: t.response?.observedModel ?? null,
      providerStopReason: t.response?.providerStopReason ?? null })),
    totalUsage: sumUsage(modelTurns.map((t) => t.response.usage)),
    observedModels: [...new Set(modelTurns.map((t) => t.response.observedModel).filter(Boolean))],
    requestsThisAttempt: requests,
    patches: [...(loaded.patches || new Map()).entries()].sort(([a], [b]) => {
      const [at, ai] = a.split(':').map(Number), [bt, bi] = b.split(':').map(Number);
      return at - bt || ai - bi;
    }).map(([, record]) => patchSummary(record)),
    supersedes: manifest.supersedes ?? null,
    // Reported from the durable outcome so a resumed or crashed run keeps it.
    reserveReleaseEvidence: manifest.outcome?.reserveReleaseEvidence === true,
    ...extra,
  };
}

async function driveApiAgentRun({ handle, provider, model, tools, fetchImpl, endpoint, credential,
  headerContext = {}, signal = null, onTurn = () => {}, beforeDispatch = () => true, afterTurn = () => {}, hooks = {},
  qualificationActive = false }) {
  const wire = WIRES[provider];
  if (!wire) fail('api_model_unmapped', 'Unknown API provider.');
  if (typeof fetchImpl !== 'function' || typeof endpoint !== 'string') fail('api_transport_invalid', 'Transport is not configured.');
  // A non-idempotent tool is accepted only as a journaled one, and only from
  // a tool set that carries a bound writer.
  if (!tools?.definitions?.length || tools.definitions.some((d) => d.idempotent !== true && !(d.journaled === true && tools.writer))) {
    fail('api_tool_not_idempotent', 'Only idempotent tools, or journaled tools of a bound writer, may be registered.');
  }
  // A key too short to match safely would leave tool output unprotected.
  if (typeof credential !== 'string' || credential.length < MIN_CREDENTIAL_LENGTH) fail('api_credential_unbound', 'The reserved credential is not available.');
  const at = (name) => { if (typeof hooks.at === 'function') hooks.at(name); };
  const secrets = [credential];
  const safeText = (text) => redactSecrets(String(text ?? ''), secrets).slice(0, MESSAGE_PREVIEW);
  // Model output is persisted and replayed; a credential echoed by the model never reaches disk.
  const scrub = (value) => typeof value === 'string' ? redactSecrets(value, secrets)
    : Array.isArray(value) ? value.map(scrub)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)])) : value;

  let loaded = handle.load();
  let { manifest } = loaded;
  const turns = [...loaded.turns];
  const toolRecords = new Map(loaded.tools);
  let requests = 0;
  const patchesNow = () => { try { return handle.load().patches; } catch { return loaded.patches; } };
  const snapshot = () => ({ manifest, turns, tools: toolRecords, patches: patchesNow() });
  const done = (extra) => summarize(handle, snapshot(), requests, extra);
  const setManifest = (status, outcome) => {
    manifest = { ...manifest, status, outcome: outcome ? { ...outcome, at: nowIso() } : null, updatedAt: nowIso() };
    handle.writeManifest(manifest);
  };
  const writeTurn = (record) => {
    handle.writeTurn(record);
    const i = turns.findIndex((t) => t.index === record.index);
    if (i >= 0) turns[i] = record; else turns.push(record);
  };
  const finish = (cls, extra = {}) => {
    setManifest(RESUMABLE_CLASSES.has(cls) && !extra.uncertainTurn ? 'resumable' : 'terminal', { class: cls, ...extra });
    return done();
  };

  // A terminal checkpoint is returned as stored with zero provider calls.
  if (manifest.status === 'terminal') return done();
  if (turns.some((t) => t.state === 'intent' || t.state === 'uncertain') || pendingPatchEffects(loaded).length) {
    manifest = finalizeInterrupted(handle, manifest, turns, loaded);
    return summarize(handle, handle.load(), 0);
  }
  if (manifest.status !== 'active') setManifest('active', null);

  const cancelled = () => signal?.aborted === true;
  for (;;) {
    const last = turns.length ? turns[turns.length - 1] : null;
    // A response from an unrequested model is billed but never acted on.
    if (last?.state === 'received' && last.response?.modelMismatch) return finish('api_model_mismatch', { observedModel: last.response.observedModel });
    if (last?.state === 'received' && !last.response.error && TERMINAL_STOPS.has(last.response.stop)) return finish(last.response.stop);
    // A durably received non-resumable provider error ends the run as stored,
    // even if the process died before its manifest was written. A resumable
    // one (rate_limited, provider_unavailable) falls through to one new request.
    const stored = lastProviderError(turns);
    if (stored && !stored.resumable) return finish(stored.outcome.class, stored.outcome);
    const view = rebuild(wire, manifest, turns, toolRecords);
    const state = view.state;
    if (view.pendingTools) {
      // Read-only tool calls left in intent are re-run; they are idempotent.
      // An apply_patch left in intent never reaches here (see above).
      const turn = view.pendingTools;
      for (let i = 0; i < turn.response.toolCalls.length; i++) {
        const call = turn.response.toolCalls[i];
        const key = `${turn.index}:${i}`;
        if (toolRecords.get(key)?.state === 'done') continue;
        if (cancelled()) return finish('cancelled');
        const intent = { turn: turn.index, index: i, callId: call.id, name: call.name, argsDigest: digest(call.input), state: 'intent', at: nowIso() };
        handle.writeTool(intent); toolRecords.set(key, intent);
        at('after-tool-intent');
        let result;
        try {
          result = tools.execute(call.name, call.input, { secrets,
            call: { turn: turn.index, index: i, callId: call.id, argsDigest: intent.argsDigest } });
        } catch (error) {
          if (error.code === 'patch_outcome_uncertain') {
            // Evidence stays as journaled; no further tool runs.
            return finish('patch_outcome_uncertain', { effectsPending: [key], reason: error.reason || null });
          }
          if (error.code === 'writer_hold_lost') {
            // Refused before any effect: settle the call so the journal shows none.
            const refused = { output: JSON.stringify({ error: 'writer_hold_lost', message: 'The workspace writer hold was lost.' }), isError: true };
            handle.writeTool({ ...intent, state: 'done', result: refused, resultDigest: digest(refused.output), doneAt: nowIso() });
            return finish('writer_hold_lost');
          }
          return finish(error.code === 'cwd_identity_changed' ? 'cwd_identity_changed' : 'tool_failed', { detail: safeText(error.message) });
        }
        const record = { ...intent, state: 'done', result, resultDigest: digest(result.output), doneAt: nowIso() };
        handle.writeTool(record); toolRecords.set(key, record);
        at('after-tool-done');
      }
      continue;
    }
    if (cancelled()) return finish('cancelled');

    // ---- send one model turn --------------------------------------------
    const index = turns.length + 1;
    const requestObject = wire.buildRequest(state, model, tools.definitions);
    const bodyText = JSON.stringify(requestObject);
    const intent = { index, state: 'intent', requestDigest: digest(bodyText), at: nowIso() };
    writeTurn(intent);
    at('after-turn-intent');
    // A string `stop` from the hook (e.g. a spend-ledger refusal) sends nothing and ends the run with that code.
    const gate = cancelled() ? false : beforeDispatch(index, { requestBytes: Buffer.byteLength(bodyText),
      maxOutputTokens: requestObject.max_tokens ?? requestObject.max_output_tokens ?? null });
    if (gate !== true && gate !== undefined && gate !== null && typeof gate === 'object' && typeof gate.stop === 'string') {
      writeTurn({ ...intent, state: 'not_sent' });
      return finish(gate.stop);
    }
    if (gate === false) {
      writeTurn({ ...intent, state: 'not_sent' });
      return finish('cancelled');
    }
    let response, text;
    requests++;
    try {
      response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', signal: signal || undefined,
        headers: wire.headers(credential, headerContext), body: bodyText });
      text = await response.text();
    } catch {
      writeTurn({ ...intent, state: 'uncertain', uncertainAt: nowIso() });
      try { afterTurn(index, { disposition: 'outcome_uncertain' }); } catch {}
      // The request may have reached the provider, cancelled or not.
      return finish('outcome_uncertain', { uncertainTurn: index, cancelled: cancelled() });
    }
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!response.ok) {
      const cls = classifyProviderError(provider, response.status, json);
      const reserveReleaseEvidence = cls.releaseEligible && qualificationActive === true;
      writeTurn({ ...intent, state: 'received', status: response.status, receivedAt: nowIso(), response: { error: {
        class: cls.errorClass, status: response.status, providerCode: cls.providerCode, providerType: cls.providerType,
        resumable: ERROR_CLASSES[cls.errorClass].resumable, reserveReleaseEvidence,
        message: safeText(json?.error?.message ?? '') } } });
      at('after-received');
      try { afterTurn(index, { disposition: 'provider_error', errorClass: cls.errorClass }); } catch {}
      return finish(cls.errorClass, { status: response.status, providerCode: cls.providerCode, reserveReleaseEvidence });
    }
    const parsed = json === null
      ? { stop: 'provider_protocol_error', assistant: null, toolCalls: [], text: '', usage: null, observedModel: null, providerStopReason: null }
      : scrub(wire.parseResponse(json));
    const modelMismatch = parsed.stop !== 'provider_protocol_error' && !modelMatches(model, parsed.observedModel);
    writeTurn({ ...intent, state: 'received', status: response.status, receivedAt: nowIso(), response: { ...parsed, modelMismatch } });
    at('after-received');
    try { afterTurn(index, { disposition: 'settled', usage: parsed.usage ?? null }); } catch {}
    try {
      onTurn({ index, stop: parsed.stop, usage: parsed.usage, text: parsed.text,
        observedModel: parsed.observedModel, totalUsage: sumUsage(turns.filter((t) => t.state === 'received' && !t.response.error).map((t) => t.response.usage)) });
    } catch {}
  }
}

// Seed for a linked attempt: the parent's conversation before `fromTurn`.
// The parent checkpoint is only read, never mutated.
function linkedSeed(provider, parent, fromTurn) {
  const wire = WIRES[provider];
  const { manifest, turns, tools } = parent;
  if (manifest.status !== 'terminal') fail('linked_attempt_parent_not_terminal', 'Only a terminal checkpoint can seed a linked attempt.');
  if (!Number.isSafeInteger(fromTurn) || fromTurn < 1 || fromTurn > turns.length + 1) fail('linked_attempt_invalid', 'fromTurn is outside the parent checkpoint.');
  const prefix = turns.filter((t) => t.index < fromTurn);
  if (prefix.some((t) => t.state !== 'received' && t.state !== 'not_sent')) fail('linked_attempt_invalid', 'fromTurn must not follow an uncertain turn.');
  const view = rebuild(wire, manifest, prefix, tools);
  if (view.pendingTools || view.pendingTurn || view.stopped) fail('linked_attempt_invalid', 'Parent tool calls before fromTurn are incomplete.');
  const last = lastModelTurn(prefix);
  if (last && last.response.stop !== 'tool_calls' && last.response.stop !== 'pause_turn') {
    fail('linked_attempt_invalid', 'The parent conversation had already stopped before fromTurn.');
  }
  return view.state;
}

module.exports = { driveApiAgentRun, linkedSeed, rebuild, sumUsage, RESUMABLE_CLASSES, TERMINAL_STOPS };
