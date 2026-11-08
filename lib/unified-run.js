'use strict';

// Unified runs: one objective carried across native (and, read-only, API)
// segments. Every segment is a durable queue task with a bound account, quota
// seat, model and effort. Each step persists intent before dispatch and settles
// from the queue's own record, so a crash never replays a segment: the queue
// task id is fixed at intent time and submitDurable never re-executes an id.
//
// The write boundary is advisory. advisoryFileScope is shown to the provider
// in the handoff only; nothing here enforces it. The one exception is an
// API-only run with an exact allowedWritePaths contract: its API segments edit
// only those existing files through the in-process patch tool, whose own
// boundary (not an OS sandbox, not atomic compare-and-swap) is reported per
// segment.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { buildNeutralHandoff, assertNoBannedContent } = require('./neutral-handoff');
const { selectSegment, assertCanonicalFunding, assertNoInternalFields, assertReserveSegmentAdmission, apiReleaseBinding,
  nativeExhausted } = require('./funding-routing');
const { workspacesOverlap } = require('./continuity');
const { intentHash } = require('./result-delivery');
const { normalizeAllowedWritePaths, hash: canonicalHash } = require('./candidate-stage');
const { isSecretPath } = require('./github-tracker');
const { WRITE_BOUNDARY: API_WRITE_BOUNDARY, READ_ONLY_BOUNDARY: API_READ_ONLY_BOUNDARY } = require('./api-agent-patch');

const RUN_ID_RE = /^ur_[a-f0-9]{24}$/;
const TERMINAL = new Set(['complete', 'failed', 'cancelled']);
const WAITING = new Set(['waiting_for_quota', 'waiting_for_writer']);
// Segment outcomes that hand the objective to the next listed entry.
const TRANSFER = new Set(['quota_reserve', 'quota_unknown']);
const QUEUE_TERMINAL = new Set(['done', 'failed', 'cancelled', 'interrupted']);
const PHYSICALLY_STOPPED = new Set(['settled', 'fenced', 'not_invoked', 'never_started']);
const RUN_STATES = new Set(['running', 'waiting_for_quota', 'waiting_for_writer', 'needs_attention', 'stopped', ...TERMINAL]);
const SEGMENT_STATES = new Set(['intent', 'dispatched', 'settled', 'uncertain', 'not_submitted', 'cancelled']);
// Segment states whose work is over by the run's own authoritative record. A
// failed submit is never one of them: the queue may hold the task anyway.
// not_submitted is read only from earlier records and is reconciled like intent.
const SEGMENT_CLOSED = new Set(['settled', 'cancelled']);
const SEGMENT_OPEN_INTENT = new Set(['intent', 'not_submitted']);
const PHASES = new Set(['subscription', 'api', 'reserve']);
// Platforms where the manifest's directory barrier (fsync of the directory
// after rename) is supported and its failure is observable. Elsewhere new
// unified mutations are refused before any effect.
const DURABLE_PLATFORMS = new Set(['linux']);
const MAX_ENTRIES = 8;
const MAX_SEGMENTS = 64;
const WRITE_BOUNDARY = 'advisory_unenforced';
const ENTRY_KEYS = new Set(['kind', 'accountId', 'transport', 'model', 'effort', 'fundingProfileId', 'expectedProfileRevision', 'fundingRoute']);
// The only per-entry funding route a caller may opt into. Absent means the
// included-credit grant, so existing manifests and their hashes are unchanged.
const PREPAID_ROUTE = 'authorized_prepaid';
const PROMOTIONAL_ROUTE = 'authorized_promotional';
const CREDIT_ROUTES = Object.freeze([PREPAID_ROUTE, PROMOTIONAL_ROUTE]);
const permitField = (route) => route === PROMOTIONAL_ROUTE ? 'promotional' : 'prepaid';
const INPUT_KEYS = new Set(['objective', 'constraints', 'advisoryFileScope', 'cwd', 'dangerous', 'acknowledgeFilesystemWrites', 'segments', 'title']);
const HASH_RE = /^[a-f0-9]{64}$/;

function failure(code, message, status = 409, extra = {}) {
  return Object.assign(new Error(message || code), { code, status, ...extra });
}
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function syncDirectoryDefault(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// A failure before rename leaves the previous manifest published. A failure of
// the directory barrier after rename leaves publication uncertain: the new
// bytes are visible now but may not survive a crash.
function atomicWriteJson(file, value, syncDirectory) {
  const directory = path.dirname(file);
  const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let fd, renamed = false;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    renamed = true;
    syncDirectory(directory);
  } catch (error) {
    throw renamed
      ? failure('unified_run_publication_uncertain', 'The unified run record was written but its directory barrier failed.', 500, { publication: 'uncertain', cause: error })
      : failure('unified_run_write_failed', 'The unified run record could not be written.', 500, { publication: 'unchanged', cause: error });
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    if (!renamed) try { fs.rmSync(temp, { force: true }); } catch {}
  }
}

// Snapshots are stored in plain JSON so a later link can recompute effects
// against the exact pre-dispatch state.
function storeSnapshot(snapshot) {
  if (!snapshot?.available) return { available: false, reason: snapshot?.reason || 'workspace_snapshot_unavailable' };
  const entries = [...snapshot.entries].sort(([a], [b]) => a.localeCompare(b));
  const fingerprints = [...(snapshot.fingerprints || new Map())].sort(([a], [b]) => a.localeCompare(b));
  const body = { head: snapshot.head, entries, fingerprints, fingerprintsTruncated: snapshot.fingerprintsTruncated === true };
  return { available: true, reason: null, ...body, digest: sha256(JSON.stringify(body)) };
}
function loadSnapshot(stored) {
  if (!stored?.available) return { available: false, reason: stored?.reason || 'workspace_snapshot_unavailable', entries: new Map() };
  return { available: true, reason: null, head: stored.head, entries: new Map(stored.entries),
    fingerprints: new Map(stored.fingerprints), fingerprintsTruncated: stored.fingerprintsTruncated === true };
}

function validateEntry(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some((key) => !ENTRY_KEYS.has(key))) {
    throw failure('invalid_unified_run', `segments[${index}] has unsupported fields`, 400);
  }
  const transport = raw.transport;
  if (!['native', 'api'].includes(transport)) throw failure('invalid_unified_run', `segments[${index}].transport must be native or api`, 400);
  if (typeof raw.kind !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.kind)) throw failure('invalid_unified_run', `segments[${index}].kind is required`, 400);
  // Account identity is never inferred: 'default' is an explicit binding to the
  // existing login, while a missing or null account is refused.
  if (typeof raw.accountId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(raw.accountId)) {
    throw failure('account_binding_required', `segments[${index}].accountId must name the authorized account`, 400);
  }
  for (const field of ['model', 'effort']) {
    if (typeof raw[field] !== 'string' || !raw[field].trim() || raw[field].length > 160) {
      throw failure('invalid_unified_run', `segments[${index}].${field} is required for its transport`, 400);
    }
  }
  const funded = raw.fundingProfileId !== undefined || raw.expectedProfileRevision !== undefined;
  if (transport === 'api' && !funded) throw failure('invalid_funding_envelope', `segments[${index}] API transport requires an explicit funding profile`, 400);
  if (funded && (typeof raw.fundingProfileId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(raw.fundingProfileId)
    || !Number.isSafeInteger(raw.expectedProfileRevision) || raw.expectedProfileRevision < 1)) {
    throw failure('invalid_funding_envelope', `segments[${index}] funding profile and expected revision must both be explicit`, 400);
  }
  if (raw.fundingRoute !== undefined && (!CREDIT_ROUTES.includes(raw.fundingRoute) || transport !== 'api')) {
    throw failure('invalid_funding_envelope', `segments[${index}].fundingRoute may only opt an API entry into authorized_prepaid or authorized_promotional`, 400);
  }
  return Object.freeze({ kind: raw.kind, accountId: raw.accountId, transport, model: raw.model, effort: raw.effort,
    ...(funded ? { fundingProfileId: raw.fundingProfileId, expectedProfileRevision: raw.expectedProfileRevision } : {}),
    ...(raw.fundingRoute !== undefined ? { fundingRoute: raw.fundingRoute } : {}) });
}

const plain = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const corrupt = (detail) => failure('unified_run_corrupt', `unified run record is invalid (${detail})`, 500);
const segmentTaskId = (id, index) => `t_ur_${id.slice(3)}_s${String(index).padStart(3, '0')}`;
// The API checkpoint each contract segment runs under is fixed by the run and
// segment index, so resume, link and recovery name exactly one journal.
const apiCheckpointRunId = (id, index) => `aar_${id.slice(3)}_${sha256(`${id}:${index}`).slice(0, 16)}`;

// Exact write list for an API-only writer run. Hidden and secret paths are
// refused outright; the patch tool re-checks every path at use.
function normalizeWriteContract(paths) {
  let normalized;
  try { normalized = normalizeAllowedWritePaths(paths); }
  catch (error) { throw failure('invalid_write_contract', `allowedWritePaths is invalid (${error.code || 'invalid'})`, 400); }
  if (!normalized.length) throw failure('invalid_write_contract', 'allowedWritePaths must list at least one existing file', 400);
  for (const item of normalized) {
    const parts = item.split('/');
    if (parts.some((part) => part.startsWith('.')) || isSecretPath(item) || parts.some((part, i) => isSecretPath(part) || isSecretPath(parts.slice(0, i + 1).join('/')))) {
      throw failure('invalid_write_contract', 'allowedWritePaths may not name hidden or secret paths', 400);
    }
  }
  return Object.freeze({ paths: [...normalized], pathsHash: canonicalHash({ version: 1, allowedWritePaths: normalized }) });
}
const contractSegment = (run, segment) => !!run.apiWriteContract && segment?.phase === 'api';

// The stored queue intent must hash to the recorded digest and carry exactly
// the run's workspace, danger, account, seat, model and funding: the queue
// enforces what it is given, so a damaged manifest field must not diverge from
// the intent it would submit.
function queueInputMatches(run, segment, entry) {
  const q = segment.queueInput;
  if (intentHash(q) !== segment.intentHash) return false;
  if (q.dangerous !== run.dangerous || q.cwd !== run.cwd || q.kind !== segment.kind || q.source !== 'unified_run'
    || q.model !== segment.model || q.effort !== segment.effort || q.expectedAccountId !== segment.accountId
    || q.requestId !== `queued:${segment.taskId}` || !plain(q.unifiedRun)
    || q.unifiedRun.id !== run.id || q.unifiedRun.segment !== segment.index) return false;
  if (contractSegment(run, segment)) {
    if (Object.keys(q.unifiedRun).length !== 4 || q.unifiedRun.apiCheckpointRunId !== apiCheckpointRunId(run.id, segment.index)
      || q.unifiedRun.writePathsHash !== run.apiWriteContract.pathsHash) return false;
  } else if (Object.keys(q.unifiedRun).length !== 2) return false;
  if (entry.transport === 'native' ? q.expectedQuotaSeat !== segment.quotaSeat : q.expectedQuotaSeat !== undefined) return false;
  const route = segment.phase === 'api' ? entry.fundingRoute || 'included_api_credit' : entry.fundingProfileId ? 'subscription' : null;
  if (!route) return q.funding === undefined;
  return plain(q.funding) && q.funding.route === route && q.funding.profileId === entry.fundingProfileId
    && q.funding.expectedProfileRevision === entry.expectedProfileRevision && q.funding.fallback === 'none';
}

const prepaidEntry = (entry) => entry?.transport === 'api' && CREDIT_ROUTES.includes(entry.fundingRoute);
// A prepaid segment records the permit it was planned under and the exhaustion
// evidence that allowed it; it never carries a grant release binding. No other
// segment may carry either prepaid field.
function prepaidSegmentMatches(segment, entry) {
  if (!prepaidEntry(entry)) return segment.prepaidBinding === undefined && segment.exhaustionEvidence === undefined;
  const binding = segment.prepaidBinding;
  // A promotional segment's binding names its route; a prepaid binding never carries one.
  return plain(binding) && (entry.fundingRoute === PROMOTIONAL_ROUTE ? binding.route === PROMOTIONAL_ROUTE : binding.route === undefined) && typeof binding.authorizationId === 'string' && !!binding.authorizationId
    && typeof binding.authorizationHash === 'string' && HASH_RE.test(binding.authorizationHash)
    && Number.isSafeInteger(binding.profileRevision) && binding.profileRevision === entry.expectedProfileRevision
    && Array.isArray(segment.exhaustionEvidence) && segment.exhaustionEvidence.length > 0
    && segment.exhaustionEvidence.every((e) => plain(e) && typeof e.quotaSeat === 'string' && !!e.quotaSeat
      && typeof e.accountId === 'string' && Number.isFinite(e.percentRemaining) && e.percentRemaining <= 0)
    && (segment.apiBinding === undefined || segment.apiBinding === null);
}

// A manifest is trusted only in full. Any field that decides holding, dispatch
// or reserve authority must have its exact shape; anything else is corrupt.
function validateManifest(run, id) {
  if (!plain(run) || run.version !== 1 || run.id !== id || !RUN_ID_RE.test(run.id)) throw corrupt('identity');
  if (!RUN_STATES.has(run.state)) throw corrupt('state');
  if (typeof run.dangerous !== 'boolean') throw corrupt('dangerous');
  if (typeof run.cwd !== 'string' || !path.isAbsolute(run.cwd) || run.cwd.includes('\0')) throw corrupt('cwd');
  if (!Array.isArray(run.entries) || !run.entries.length || run.entries.length > MAX_ENTRIES) throw corrupt('entries');
  run.entries.forEach((entry, index) => { try { validateEntry(entry, index); } catch { throw corrupt('entries'); } });
  // Prepaid is read-only: a writer or contract run can never carry it.
  if (run.entries.some(prepaidEntry) && (run.dangerous || (run.apiWriteContract !== undefined && run.apiWriteContract !== null))) throw corrupt('entries');
  if (!Array.isArray(run.bindings) || run.bindings.length !== run.entries.length) throw corrupt('bindings');
  run.bindings.forEach((binding, index) => {
    if (run.entries[index].transport !== 'native') { if (binding !== null) throw corrupt('bindings'); return; }
    if (!plain(binding) || binding.accountId !== run.entries[index].accountId
      || typeof binding.quotaSeat !== 'string' || !binding.quotaSeat) throw corrupt('bindings');
  });
  if (run.apiWriteContract !== undefined && run.apiWriteContract !== null) {
    const contract = run.apiWriteContract;
    let expected = null;
    try { expected = plain(contract) && Object.keys(contract).length === 2 ? normalizeWriteContract(contract.paths) : null; } catch {}
    if (!expected || run.dangerous !== true || run.entries.some((entry) => entry.transport !== 'api')
      || expected.pathsHash !== contract.pathsHash || JSON.stringify(expected.paths) !== JSON.stringify(contract.paths)) throw corrupt('apiWriteContract');
  }
  if (!Array.isArray(run.segments) || run.segments.length > MAX_SEGMENTS) throw corrupt('segments');
  run.segments.forEach((segment, i) => {
    const entry = plain(segment) && Number.isSafeInteger(segment.entryIndex) ? run.entries[segment.entryIndex] : null;
    if (!entry || segment.index !== i + 1 || segment.taskId !== segmentTaskId(run.id, i + 1)
      || !PHASES.has(segment.phase) || !SEGMENT_STATES.has(segment.state)
      || segment.transport !== entry.transport || segment.kind !== entry.kind || segment.accountId !== entry.accountId
      || segment.model !== entry.model || segment.effort !== entry.effort
      || (segment.phase === 'api') !== (entry.transport === 'api')
      || (entry.transport === 'native' && segment.quotaSeat !== run.bindings[segment.entryIndex].quotaSeat)
      || typeof segment.intentHash !== 'string' || !/^[a-f0-9]{64}$/.test(segment.intentHash) || !plain(segment.queueInput)
      || !queueInputMatches(run, segment, entry)
      || (segment.apiBinding !== undefined && segment.apiBinding !== null && !plain(segment.apiBinding))
      || !prepaidSegmentMatches(segment, entry)
      || (segment.effectsRecovery !== undefined && (!contractSegment(run, segment) || !plain(segment.effectsRecovery)
        || segment.effectsRecovery.checkpointRunId !== apiCheckpointRunId(run.id, segment.index)))
      || (i < run.segments.length - 1 && !SEGMENT_CLOSED.has(segment.state))) throw corrupt('segments');
  });
  const last = run.segments[run.segments.length - 1];
  if (TERMINAL.has(run.state) && last && !SEGMENT_CLOSED.has(last.state)) throw corrupt('terminal');
  if (run.state === 'complete' && (!last || last.state !== 'settled')) throw corrupt('terminal');
  if (run.pendingStart !== undefined && run.pendingStart !== null && !plain(run.pendingStart)) throw corrupt('pendingStart');
  if (TERMINAL.has(run.state) && run.pendingStart) throw corrupt('pendingStart');
  if (!Array.isArray(run.exhaustedApi ?? []) || (run.exhaustedApi ?? []).some((i) => run.entries[i]?.transport !== 'api')) throw corrupt('exhaustedApi');
  const release = run.reserveRelease;
  if (release !== undefined && release !== null) {
    const consumer = release.consumedBy == null ? null : run.segments.find((s) => s.taskId === release.consumedBy);
    if (!plain(release) || run.entries[release.index]?.transport !== 'api' || prepaidEntry(run.entries[release.index])
      || release.errorClass !== 'funding_exhausted'
      || release.reserveReleaseEvidence !== true || typeof release.qualificationId !== 'string' || !plain(release.binding)
      || release.binding.qualificationId !== release.qualificationId
      || (release.consumedBy != null && consumer?.phase !== 'reserve')) throw corrupt('reserveRelease');
  }
  // An open reserve segment must be the recorded consumer of the release.
  if (last?.phase === 'reserve' && !SEGMENT_CLOSED.has(last.state) && release?.consumedBy !== last.taskId) throw corrupt('reserveRelease');
  if (run.holder !== undefined && run.holder !== null && !plain(run.holder)) throw corrupt('holder');
  return run;
}

function createUnifiedRuns({
  dataDir, queue, now = Date.now,
  resolveCwd = (cwd) => cwd,
  validateWriteContract = () => {},
  // bindSegment(entry, { dangerous }) -> { accountId, quotaSeat }. It must
  // resolve exactly entry.accountId and throw rather than substitute.
  bindSegment,
  headroom = () => null,
  // apiDecision(entry) -> funding decision; never called for native entries.
  apiDecision = () => null,
  // validateApiEntry(entry) throws for unmapped models/efforts.
  validateApiEntry = () => {},
  // validateNativeEntry(entry, { dangerous, cwd }) checks transport-specific
  // model/effort controls without dispatch.
  validateNativeEntry = () => {},
  // prepareQueueInput(input) returns the exact admitted queue intent
  // (resolved controls, cwd identity and prompt hash). Its result is stored
  // and resubmitted verbatim, so a crash retry hashes identically.
  prepareQueueInput = (input) => input,
  // nativeFunding(entry, binding) validates a funded native entry's profile.
  nativeFunding = () => {},
  reservePercent = () => 0,
  // externalHolder(cwd, { runId, taskIds }) -> { holder, id } | null over
  // every writer holder except this run and its own settled segment tasks.
  externalHolder = () => null,
  physicallySettled = () => true,
  // apiJournalSettled({ checkpointRunId, expect }) -> { settled, reason?, effectsPending?, outcome? }
  // decides whether an API writer segment's journal proves every effect
  // settled. Only that proof lets a contract segment settle; the queue's
  // record or the API transport alone never does.
  apiJournalSettled = () => ({ settled: false, reason: 'api_journal_unavailable' }),
  // apiReconcileEffects({ checkpointRunId, expect, cwd, allowedWritePaths, assertHeld })
  // -> { settled, outcome, patches, uncertain } recovers a stopped writer
  // journal under this run's retained hold. No provider request.
  apiReconcileEffects = () => { throw failure('api_reconciliation_unavailable', 'API effects reconciliation is unavailable.'); },
  snapshot = () => ({ available: false, reason: 'workspace_snapshot_unavailable', entries: new Map() }),
  summarize = () => null,
  log = () => {},
  // syncDirectory(dir) must make a completed rename in dir durable or throw.
  syncDirectory = syncDirectoryDefault,
  platform = process.platform,
} = {}) {
  if (typeof bindSegment !== 'function') throw new TypeError('bindSegment is required');
  const root = path.join(dataDir, 'unified-runs');
  const file = (id) => path.join(root, id, 'manifest.json');
  const durable = DURABLE_PLATFORMS.has(platform);
  // Runs whose last published manifest may not survive a crash. While listed,
  // a run holds its workspace even if terminal and dispatches nothing until a
  // later save re-establishes the barrier.
  const uncertain = new Set();
  // Runs whose manifest this process has made durable. Both sets are
  // process-local, so a reopened engine trusts no record it has not barriered
  // itself: a crash may have followed a rename whose barrier never succeeded.
  const confirmed = new Set();
  let rootConfirmed = false;

  function assertDurablePlatform() {
    if (!durable) {
      throw failure('unified_run_platform_unsupported', `Unified runs require a directory barrier that is not supported on ${platform}.`, 409);
    }
  }
  function read(id) {
    if (!RUN_ID_RE.test(String(id || ''))) return null;
    let text;
    try { text = fs.readFileSync(file(id), 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw corrupt('unreadable');
      // A run directory without its manifest is an interrupted create or a
      // damaged record; it cannot be proven inert.
      if (fs.existsSync(path.join(root, id))) throw corrupt('manifest_missing');
      return null;
    }
    let run;
    try { run = JSON.parse(text); } catch { throw corrupt('unparseable'); }
    return validateManifest(run, id);
  }
  function save(run) {
    run.updatedAt = new Date(now()).toISOString();
    try { atomicWriteJson(file(run.id), run, syncDirectory); }
    catch (error) {
      if (error.code === 'unified_run_publication_uncertain') { uncertain.add(run.id); confirmed.delete(run.id); }
      error.runId = run.id;
      throw error;
    }
    uncertain.delete(run.id);
    if (rootConfirmed) confirmed.add(run.id);
    return run;
  }
  // Makes the surviving manifest, and its directory entry, durable before this
  // process takes any effect from it. A failure leaves the run uncertain.
  function barrier(id) {
    if (confirmed.has(id)) return;
    try {
      if (!durable) throw failure('unified_run_platform_unsupported', `No directory barrier on ${platform}.`);
      if (!rootConfirmed) { syncDirectory(root); syncDirectory(path.dirname(root)); rootConfirmed = true; }
      syncDirectory(path.join(root, id));
    } catch (error) {
      uncertain.add(id);
      throw failure('unified_run_publication_uncertain', 'The unified run record could not be confirmed durable.', 500,
        { publication: 'uncertain', runId: id, cause: error });
    }
    uncertain.delete(id); confirmed.add(id);
  }
  // Re-establishes publication before any further effect, including after a
  // restart.
  function confirmPublication(run) {
    barrier(run.id);
  }
  function ids() {
    try { return fs.readdirSync(root).filter((name) => RUN_ID_RE.test(name)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  const current = (run) => run.segments[run.segments.length - 1] || null;
  const taskOf = (segment) => (segment?.taskId ? queue.get(segment.taskId) : null);
  // Queue-recorded stops count only for unowned tasks; an owned task is stopped
  // only by the queue's private settlement projection. Legacy uncertainty is
  // never settled here.
  const physicallyStopped = (task) => !!task && QUEUE_TERMINAL.has(task.status)
    && (task.executionReservation ? task.execution?.state === 'owned_settled' && queue.isOwnedSettled?.(task.id) === true
      : PHYSICALLY_STOPPED.has(task.execution?.state));

  // Writer holders other runs and one-shots must respect. A run holds its
  // workspace from create until terminal. An unreadable manifest holds every
  // workspace, because its scope cannot be proven disjoint.
  function holderFor(cwd, { taskId = null, intentHash: taskIntentHash = null, exceptRunId = null } = {}) {
    for (const id of ids()) {
      if (id === exceptRunId) continue;
      let run;
      try { run = read(id); } catch { return { holder: 'unified_run', id }; }
      if (!run || run.dangerous !== true || !workspacesOverlap(cwd, run.cwd)) continue;
      // An unconfirmed publication may revert to an earlier, non-terminal state.
      try { barrier(id); } catch { return { holder: 'unified_run', id }; }
      if (TERMINAL.has(run.state)) continue;
      const segment = current(run);
      // Only the run's own current segment task, with the exact recorded
      // intent, is exempt.
      if (taskId && segment?.taskId === taskId && segment.intentHash && segment.intentHash === taskIntentHash) continue;
      return { holder: 'unified_run', id };
    }
    return null;
  }

  function headroomList(run) {
    return run.entries.map((entry, index) => {
      if (entry.transport !== 'native') return undefined;
      const binding = run.bindings[index];
      return binding ? { ...(headroom(entry, binding) || {}), quotaSeat: binding.quotaSeat } : undefined;
    });
  }
  function apiDecisionList(run) {
    if (run.dangerous && !run.apiWriteContract) return [];
    return run.entries.map((entry) => {
      if (entry.transport !== 'api') return undefined;
      try { return apiDecision(entry); } catch (error) { return { code: error.code || 'api_dispatch_unavailable', apiDispatchAllowed: false }; }
    });
  }
  function rebind(run, index) {
    const entry = run.entries[index];
    if (entry.transport !== 'native') return null;
    const binding = bindSegment(entry, { dangerous: run.dangerous });
    const recorded = run.bindings[index];
    if (!binding || binding.accountId !== entry.accountId
      || (recorded && (binding.accountId !== recorded.accountId || binding.quotaSeat !== recorded.quotaSeat))) {
      throw failure('account_identity_changed', 'The bound account or quota seat changed; no other account is substituted.');
    }
    if (entry.fundingProfileId) nativeFunding(entry, binding);
    return binding;
  }

  const journalExpect = (run, segment) => ({ unifiedRunId: run.id, segment: segment.index, writePathsHash: run.apiWriteContract.pathsHash,
    allowedWritePaths: [...run.apiWriteContract.paths] });
  // Predicates (a) and (c) for a contract segment, from its own journal.
  function journalSettled(run, segment) {
    try {
      const result = apiJournalSettled({ checkpointRunId: apiCheckpointRunId(run.id, segment.index), expect: journalExpect(run, segment) });
      return plain(result) ? result : { settled: false, reason: 'api_journal_unavailable' };
    } catch (error) { return { settled: false, reason: error.code || 'api_journal_unavailable' }; }
  }

  function handoffFor(run, nextAction) {
    const segments = run.segments.map((segment) => ({ index: segment.index, kind: segment.kind, transport: segment.transport,
      model: segment.model, effort: segment.effort, outcome: segment.outcome || segment.state, finalText: segment.finalText || '' }));
    const last = run.segments[run.segments.length - 1];
    return buildNeutralHandoff({ runId: run.id, objective: run.objective, constraints: run.constraints,
      advisoryFileScope: run.advisoryFileScope, segments, writerDiffSummary: last?.writerDiffSummary || null,
      workspaceDigest: last?.preSnapshot?.digest || null, nextAction });
  }

  function stopRun(run, code, state = code === 'waiting_for_quota' ? 'waiting_for_quota' : 'stopped') {
    run.state = state; run.stopReason = code;
    return save(run);
  }

  // Select, rebind, check holders and prepare the exact queue intent. Nothing
  // is persisted here, so a refused plan leaves no trace.
  function planSegment(run, { source = null, nextAction = null, linkedFrom = null } = {}) {
    if (run.segments.length >= MAX_SEGMENTS) return { stop: 'segment_limit_reached', state: 'needs_attention' };
    const apiDecisions = apiDecisionList(run);
    // A contract run writes only through the API patch tool, so routing sees
    // it as a non-writer and every native writer path stays unavailable. The
    // run itself remains dangerous and keeps every workspace hold.
    const headrooms = headroomList(run);
    const choice = selectSegment({ entries: run.entries, writer: run.dangerous && !run.apiWriteContract, source,
      headrooms, apiDecisions, reservePercent: reservePercent(),
      exhaustedApi: run.exhaustedApi || [], reserveRelease: run.reserveRelease || null });
    if (choice.stop) return { stop: choice.stop };
    const entry = run.entries[choice.index];
    if (run.apiWriteContract && (choice.phase !== 'api' || entry.transport !== 'api')) return { stop: 'api_write_unavailable', state: 'needs_attention' };
    const prepaid = choice.phase === 'api' && prepaidEntry(entry);
    // Prepaid is read-only and never a writer or contract segment.
    if (prepaid && (run.dangerous || run.apiWriteContract)) return { stop: 'api_agent_read_only', state: 'needs_attention' };
    let binding = null;
    try { binding = rebind(run, choice.index); }
    catch (error) { return { stop: error.code || 'account_identity_changed', state: 'needs_attention', error }; }
    if (run.dangerous) {
      const held = externalHolder(run.cwd, { runId: run.id, taskIds: run.segments.map((s) => s.taskId) });
      if (held) return { stop: 'workspace_writer_busy', state: 'waiting_for_writer', holder: held };
    }
    const index = run.segments.length + 1;
    const taskId = segmentTaskId(run.id, index);
    // A grant API segment records the exact binding its exhaustion would
    // release. A prepaid segment never releases the reserve; it records the
    // permit it was planned under and the exhaustion evidence of every listed
    // native seat, each rebound to its configured account.
    const apiBinding = choice.phase === 'api' && !prepaid ? apiReleaseBinding(apiDecisions[choice.index]) : null;
    if (choice.phase === 'api' && !prepaid && !apiBinding) return { stop: 'api_dispatch_unavailable', state: 'needs_attention' };
    let prepaidBinding = null, exhaustionEvidence = null;
    if (prepaid) {
      const permit = apiDecisions[choice.index]?.[permitField(entry.fundingRoute)];
      if (!permit) return { stop: 'api_dispatch_unavailable', state: 'needs_attention' };
      prepaidBinding = { authorizationId: permit.authorizationId, authorizationHash: permit.authorizationHash,
        profileRevision: apiDecisions[choice.index].identity.profileRevision,
        ...(entry.fundingRoute === PROMOTIONAL_ROUTE ? { route: PROMOTIONAL_ROUTE } : {}) };
      exhaustionEvidence = [];
      for (const [i, native] of run.entries.entries()) {
        if (native.transport !== 'native') continue;
        let nativeBinding;
        try { nativeBinding = rebind(run, i); }
        catch (error) { return { stop: error.code || 'account_identity_changed', state: 'needs_attention', error }; }
        const h = headrooms[i];
        if (!nativeExhausted(h, nativeBinding.quotaSeat)) return { stop: 'waiting_for_quota' };
        exhaustionEvidence.push({ quotaSeat: nativeBinding.quotaSeat, accountId: nativeBinding.accountId,
          observedAt: h.observedAt ?? null, percentRemaining: h.percentRemaining, evidenceHash: h.evidenceHash ?? null });
      }
    }
    const handoff = handoffFor(run, nextAction);
    let queueInput;
    try {
      queueInput = prepareQueueInput({
        kind: entry.kind, prompt: handoff.text, title: run.title, source: 'unified_run', cwd: run.cwd,
        dangerous: run.dangerous, requireFreshUsage: true, model: entry.model, effort: entry.effort,
        expectedAccountId: entry.accountId,
        ...(binding ? { expectedQuotaSeat: binding.quotaSeat } : {}),
        // Unfunded native work carries no funding envelope at all; funded
        // entries carry their explicit profile and revision.
        ...(choice.phase === 'api' ? { funding: { route: prepaid ? entry.fundingRoute : 'included_api_credit', profileId: entry.fundingProfileId,
          expectedProfileRevision: entry.expectedProfileRevision, fallback: 'none' } }
          : entry.fundingProfileId ? { funding: { route: 'subscription', profileId: entry.fundingProfileId,
            expectedProfileRevision: entry.expectedProfileRevision, fallback: 'none' } } : {}),
        unifiedRun: run.apiWriteContract ? { id: run.id, segment: index, apiCheckpointRunId: apiCheckpointRunId(run.id, index),
          writePathsHash: run.apiWriteContract.pathsHash } : { id: run.id, segment: index },
        requestId: `queued:${taskId}`,
      });
    } catch (error) { return { stop: error.code || 'invalid_unified_run', state: 'needs_attention', error }; }
    const preSnapshot = run.dangerous ? storeSnapshot(snapshot(run.cwd)) : null;
    return { segment: { index, taskId, entryIndex: choice.index, phase: choice.phase, kind: entry.kind, transport: entry.transport,
      accountId: entry.accountId, quotaSeat: binding?.quotaSeat ?? null, model: entry.model, effort: entry.effort,
      ...(entry.fundingProfileId ? { fundingProfileId: entry.fundingProfileId, profileRevision: entry.expectedProfileRevision } : {}),
      handoffDigest: handoff.digest, preSnapshot, queueInput, intentHash: intentHash(queueInput),
      ...(apiBinding ? { apiBinding } : {}),
      ...(prepaid ? { prepaidBinding, exhaustionEvidence } : {}),
      state: 'intent', outcome: null, ...(linkedFrom ? { linkedFrom } : {}), createdAt: new Date(now()).toISOString() } };
  }

  // Intent is always durable before the queue task can exist: a failed or
  // uncertain save throws before submit. A reserve segment consumes the
  // release in the same save, so the release admits only that task.
  function commitSegment(run, segment) {
    run.segments.push(segment);
    run.state = 'running'; run.stopReason = null; run.holder = null; run.pendingStart = null;
    if (segment.phase === 'reserve') run.reserveRelease = { ...run.reserveRelease, consumedBy: segment.taskId };
    save(run);
    return dispatch(run, segment);
  }

  function startSegment(run, options = {}) {
    if (!durable) return run;
    const plan = planSegment(run, options);
    if (plan.stop) {
      run.holder = plan.holder || null;
      // A waiting run retries the same transition on later ticks.
      run.pendingStart = WAITING.has(plan.state || (plan.stop === 'waiting_for_quota' ? 'waiting_for_quota' : 'stopped')) ? options : null;
      return stopRun(run, plan.stop, plan.state);
    }
    run.pendingStart = null;
    return commitSegment(run, plan.segment);
  }

  // Submits the recorded intent under its fixed task id. A submit exception
  // never proves the task does not exist: only the queue's own record of the
  // exact intent decides. With no record the intent stays open and is
  // resubmitted idempotently; any other record makes the segment uncertain.
  function dispatch(run, segment) {
    barrier(run.id);
    let submitError = null, task = null;
    try { queue.submitDurable(segment.taskId, segment.queueInput); } catch (error) { submitError = error; }
    try { task = queue.get(segment.taskId); } catch (error) { submitError ||= error; task = null; }
    if (!submitError && task?.delivery?.intentHash === segment.intentHash) {
      segment.state = 'dispatched'; segment.dispatchedAt = new Date(now()).toISOString();
      delete segment.submitError;
      return save(run);
    }
    if (task) {
      segment.state = 'uncertain';
      segment.outcome = submitError?.code || (task.delivery?.intentHash === segment.intentHash ? 'submit_failed' : 'TASK_INTENT_CONFLICT');
      return stopRun(run, run.dangerous ? 'writer_execution_uncertain' : 'outcome_uncertain', 'needs_attention');
    }
    const code = submitError?.code || 'submit_failed';
    if (segment.state === 'intent' && segment.submitError === code && run.state === 'needs_attention' && run.stopReason === code) return run;
    segment.state = 'intent'; segment.submitError = code;
    return stopRun(run, code, 'needs_attention');
  }

  // Records a physically settled segment without deciding what follows.
  function recordSettlement(run, segment, task) {
    segment.state = 'settled';
    segment.outcome = task.status === 'done' ? 'done' : task.stopReason || task.failureClass || task.status;
    segment.finalText = typeof task.result === 'string' ? task.result.slice(0, 4000) : '';
    segment.settledAt = new Date(now()).toISOString();
    if (run.dangerous) {
      segment.writerDiffSummary = summarize(loadSnapshot(segment.preSnapshot), snapshot(run.cwd));
    }
    const apiAgent = task.route?.api_agent;
    // A prepaid segment refused at admission (subscription recovered or
    // exhaustion unproven) never invoked a model, so its entry stays usable.
    const prepaidDeferred = !!segment.prepaidBinding && task.failureClass === 'quota_unknown' && task.execution?.state === 'not_invoked';
    if (segment.transport === 'api' && !prepaidDeferred) {
      run.exhaustedApi = [...new Set([...(run.exhaustedApi || []), segment.entryIndex])];
      // Release evidence counts only for the exact qualification the segment
      // was dispatched under; the receipt's funding record carries it.
      const qualificationId = task.route?.funding?.qualificationId;
      if (apiAgent?.reserve_release_evidence === true && task.failureClass === 'funding_exhausted'
        && segment.apiBinding && typeof qualificationId === 'string' && qualificationId === segment.apiBinding.qualificationId) {
        run.reserveRelease = { index: segment.entryIndex, errorClass: 'funding_exhausted', reserveReleaseEvidence: true,
          qualificationId, binding: segment.apiBinding, taskId: segment.taskId, consumedBy: null };
      }
    }
  }

  function settle(run, segment, task) {
    recordSettlement(run, segment, task);
    const atReserve = TRANSFER.has(segment.outcome) || TRANSFER.has(task.failureClass);
    if (task.status === 'done' && !atReserve) { run.state = 'complete'; run.stopReason = null; return save(run); }
    if (atReserve || (segment.transport === 'api' && ['funding_exhausted', 'rate_limited'].includes(task.failureClass))) {
      const sourceHeadroom = segment.transport === 'native'
        ? { index: segment.entryIndex, quotaSeat: segment.quotaSeat, ...(headroomList(run)[segment.entryIndex] || {}) }
        : { index: segment.entryIndex };
      // The pending transition is durable with the settle, so a crash here
      // restarts the same transition rather than stranding the run.
      run.pendingStart = { source: sourceHeadroom };
      save(run);
      return startSegment(run, run.pendingStart);
    }
    run.state = 'needs_attention'; run.stopReason = segment.outcome;
    return save(run);
  }

  // Advance one run from its durable record. Safe to call repeatedly.
  function advance(run) {
    if (!durable) return run;
    confirmPublication(run);
    if (TERMINAL.has(run.state)) return run;
    const segment = current(run);
    if (!segment) return WAITING.has(run.state) ? startSegment(run, run.pendingStart || {}) : run;
    if (SEGMENT_OPEN_INTENT.has(segment.state)) {
      // A crash between intent and submit, or a submit whose outcome the
      // queue has not recorded. The fixed task id makes this
      // idempotent; an existing task is never replayed.
      if (!queue.get(segment.taskId) && run.dangerous) {
        const held = externalHolder(run.cwd, { runId: run.id, taskIds: run.segments.map((s) => s.taskId) });
        if (held) { run.holder = held; return stopRun(run, 'workspace_writer_busy', 'waiting_for_writer'); }
      }
      return dispatch(run, segment);
    }
    if ((WAITING.has(run.state) || run.pendingStart) && segment.state === 'settled') return startSegment(run, run.pendingStart || {});
    if (segment.state !== 'dispatched') return run;
    const task = taskOf(segment);
    if (!task) { segment.state = 'uncertain'; return stopRun(run, run.dangerous ? 'writer_execution_uncertain' : 'outcome_uncertain', 'needs_attention'); }
    if (task.execution?.state === 'uncertain' || task.execution?.state === 'owned_unverified' && QUEUE_TERMINAL.has(task.status)) {
      segment.state = 'uncertain'; segment.outcome = 'uncertain';
      return stopRun(run, run.dangerous ? 'writer_execution_uncertain' : 'outcome_uncertain', 'needs_attention');
    }
    if (!physicallyStopped(task)) return run;
    // A contract segment settles only when its journal proves every patch
    // committed and its owner stopped; anything else keeps the hold.
    if (contractSegment(run, segment)) {
      const journal = journalSettled(run, segment);
      if (journal.settled !== true) {
        segment.state = 'uncertain'; segment.outcome = journal.reason || 'patch_outcome_uncertain';
        return stopRun(run, 'writer_execution_uncertain', 'needs_attention');
      }
    }
    return settle(run, segment, task);
  }

  function tick() {
    for (const id of ids()) {
      try { const run = read(id); if (run && (!TERMINAL.has(run.state) || !confirmed.has(id))) advance(run); }
      catch (error) { log(`unified run ${id}: ${error.code || error.message}`); }
    }
  }

  // Cancel is safe only where the run's own record, or the queue's durable
  // record of the exact intent, proves no work is running and none will start.
  // A missing queue record for a recorded intent is uncertain: the submit may
  // have landed, so it is refused and no record is synthesized.
  function cancelPlan(run) {
    if (TERMINAL.has(run.state)) return { safe: true, action: 'none' };
    const segment = current(run);
    if (!segment || SEGMENT_CLOSED.has(segment.state)) return { safe: true, action: 'close' };
    const code = run.dangerous ? 'writer_execution_uncertain' : 'outcome_uncertain';
    if (segment.state === 'uncertain') return { safe: false, code };
    const task = taskOf(segment);
    if (!task) return { safe: false, code };
    if (task.delivery?.intentHash !== segment.intentHash) return { safe: false, code: 'TASK_INTENT_CONFLICT' };
    if (task.status === 'queued' && task.execution?.state === 'never_started' && task.startedAt == null) {
      // Owned tasks carry a capacity reservation whose release is the owner's
      // private decision; they are not cancelled here.
      if (task.executionReservation) return { safe: false, code: 'owned_task_cancel_unsupported' };
      return { safe: true, action: 'cancel_queued', task };
    }
    if (physicallyStopped(task) && physicallySettled(task)) {
      if (contractSegment(run, segment) && journalSettled(run, segment).settled !== true) return { safe: false, code };
      return { safe: true, action: 'record_settled', task };
    }
    return { safe: false, code: QUEUE_TERMINAL.has(task.status) ? code : 'unified_run_segment_running' };
  }

  function cancel(id, input = {}) {
    assertNoInternalFields(input);
    if (input && Object.keys(input).length) throw failure('invalid_unified_run', 'cancel takes no fields', 400);
    assertDurablePlatform();
    const run = load(id);
    confirmPublication(run);
    const plan = cancelPlan(run);
    if (!plan.safe) throw failure(plan.code, 'The run cannot be cancelled safely: its current segment may be running or its outcome is uncertain.');
    if (plan.action === 'none') return publicView(run);
    const segment = current(run);
    if (plan.action === 'cancel_queued') {
      queue.cancel(segment.taskId);
      const after = queue.get(segment.taskId);
      if (after?.status !== 'cancelled' || after.execution?.state !== 'never_started' || after.startedAt != null
        || after.delivery?.intentHash !== segment.intentHash) {
        throw failure('unified_run_cancel_unverified', 'The queued segment could not be verified as cancelled before it started.');
      }
      segment.state = 'cancelled'; segment.outcome = 'cancelled_before_start';
      segment.settledAt = new Date(now()).toISOString();
    } else if (plan.action === 'record_settled') {
      recordSettlement(run, segment, plan.task);
    }
    // Pending work is dropped in the same save that makes the run terminal, so
    // no later tick or resume can start it.
    run.pendingStart = null; run.holder = null;
    run.state = 'cancelled'; run.stopReason = 'cancelled';
    return publicView(save(run));
  }

  // Private reserve authority for one native dispatch. It is recomputed on
  // every gate and supervision check from the queue's private running-task
  // context, the run's current reserve segment and a fresh funding decision;
  // nothing a client sends can satisfy it. Returns null when the task is not a
  // reserve segment and throws when a reserve claim cannot be proven.
  function reserveAuthority(body, privateContext, { usage = null } = {}) {
    const ref = body?.unifiedRun;
    if (ref === undefined) return null;
    const refuse = (code = 'reserve_release_unavailable') => { throw failure(code, 'Reserve admission is not authorized for this task.'); };
    if (!plain(ref) || !RUN_ID_RE.test(String(ref.id)) || !Number.isSafeInteger(ref.segment)) refuse();
    if (typeof queue.isTaskContext !== 'function' || !queue.isTaskContext(privateContext)) refuse();
    let run;
    try { run = read(ref.id); } catch { refuse(); }
    if (!run || TERMINAL.has(run.state)) refuse();
    try { barrier(run.id); } catch { refuse(); }
    const segment = current(run);
    if (!segment || segment.index !== ref.segment || segment.taskId !== privateContext.taskId) refuse();
    if (segment.phase !== 'reserve') return null;
    const task = queue.get(segment.taskId);
    const entry = run.entries[segment.entryIndex];
    if (task?.status !== 'running' || task.delivery?.intentHash !== segment.intentHash
      || !['intent', 'not_submitted', 'dispatched'].includes(segment.state)
      || body.kind !== segment.kind || task.body?.kind !== segment.kind
      || body.expectedAccountId !== segment.accountId || task.body?.expectedAccountId !== segment.accountId
      || body.expectedQuotaSeat !== segment.quotaSeat || task.body?.expectedQuotaSeat !== segment.quotaSeat) refuse();
    let binding;
    try { binding = bindSegment(entry, { dangerous: run.dangerous }); } catch { refuse(); }
    if (binding?.accountId !== segment.accountId || binding.quotaSeat !== segment.quotaSeat) refuse();
    const release = run.reserveRelease;
    let decision;
    try { decision = apiDecision(run.entries[release?.index]); } catch { refuse(); }
    const supplied = usage ? { freshness: usage.freshness, percentRemaining: usage.percentRemaining,
      vendorBlocked: usage.vendorBlocked === true } : null;
    for (const view of [headroom(entry, binding), supplied].filter((v) => v !== null && v !== undefined)) {
      assertReserveSegmentAdmission({ release, decision, headroom: view, taskId: segment.taskId });
    }
    if (!headroom(entry, binding) && !supplied) refuse('quota_unknown');
    return Object.freeze({ runId: run.id, segment: segment.index, taskId: segment.taskId, accountId: segment.accountId,
      quotaSeat: segment.quotaSeat, qualificationId: release.qualificationId });
  }

  // Private prepaid authority for one opted-in read-only API segment, checked
  // at admission before any provider request. The permit must be the one the
  // segment was planned under, and every listed native seat, rebound to its
  // configured account, must still be positively exhausted. A seat whose
  // allowance has recovered (or whose evidence is no longer current) refuses
  // with failureClass quota_unknown, so the run hands the objective to the next
  // segment boundary instead of spending. Recovery is never checked mid-turn.
  // Returns null for a task that names no unified run.
  function prepaidAuthority(body, privateContext, { decision = null } = {}) {
    const ref = body?.unifiedRun;
    if (ref === undefined) return null;
    const refuse = (code = 'prepaid_authorization_invalid', message = 'Prepaid or promotional admission is not authorized for this task.', extra = {}) => {
      throw failure(code, message, 409, extra);
    };
    if (!plain(ref) || !RUN_ID_RE.test(String(ref.id)) || !Number.isSafeInteger(ref.segment) || Object.keys(ref).length !== 2) refuse();
    if (typeof queue.isTaskContext !== 'function' || !queue.isTaskContext(privateContext)) refuse();
    let run;
    try { run = read(ref.id); } catch { refuse(); }
    if (!run || TERMINAL.has(run.state) || run.dangerous || run.apiWriteContract) refuse();
    try { barrier(run.id); } catch { refuse(); }
    const segment = current(run);
    if (!segment || segment.index !== ref.segment || segment.taskId !== privateContext.taskId) refuse();
    const entry = run.entries[segment.entryIndex];
    if (segment.phase !== 'api' || !prepaidEntry(entry) || !plain(segment.prepaidBinding)) refuse();
    const task = queue.get(segment.taskId);
    if (task?.status !== 'running' || task.delivery?.intentHash !== segment.intentHash
      || !['intent', 'not_submitted', 'dispatched'].includes(segment.state)
      || body.kind !== segment.kind || task.body?.kind !== segment.kind || body.dangerous === true || task.body?.dangerous === true
      || body.expectedAccountId !== segment.accountId || task.body?.expectedAccountId !== segment.accountId) refuse();
    const field = permitField(entry.fundingRoute);
    if (decision && (decision.actual !== entry.fundingRoute || decision[field]?.authorizationId !== segment.prepaidBinding.authorizationId
      || decision[field]?.authorizationHash !== segment.prepaidBinding.authorizationHash
      || decision.identity?.profileRevision !== segment.prepaidBinding.profileRevision)) refuse('funding_decision_changed');
    const transfer = (code, message) => refuse(code, message, { failureClass: 'quota_unknown' });
    const floor = Math.max(Number(reservePercent()) || 0, 2);
    let recovered = false, unproven = false;
    for (const [i, native] of run.entries.entries()) {
      if (native.transport !== 'native') continue;
      let binding;
      try { binding = bindSegment(native, { dangerous: false }); } catch { refuse('account_identity_changed'); }
      const recorded = run.bindings[i];
      if (binding?.accountId !== native.accountId || (recorded && binding.quotaSeat !== recorded.quotaSeat)) refuse('account_identity_changed');
      const h = { ...(headroom(native, binding) || {}), quotaSeat: binding.quotaSeat };
      if (nativeExhausted(h, binding.quotaSeat)) continue;
      if (h.freshness === 'fresh' && !h.protected && !h.vendorBlocked && Number.isFinite(h.percentRemaining) && h.percentRemaining > floor) recovered = true;
      else unproven = true;
    }
    const noun = entry.fundingRoute === PROMOTIONAL_ROUTE ? 'promotional' : 'prepaid';
    if (recovered) transfer(`${noun}_subscription_available`, `A configured subscription seat has verified allowance; ${noun} credit is not spent.`);
    if (unproven) transfer('quota_unknown', `Subscription exhaustion is not currently proven; ${noun} credit is not spent.`);
    return Object.freeze({ runId: run.id, segment: segment.index, taskId: segment.taskId, accountId: segment.accountId,
      authorizationId: segment.prepaidBinding.authorizationId });
  }

  // Private writer authority for one API contract segment, recomputed at
  // admission and before every patch from the queue's private running-task
  // context and this run's durable record. Returns null for a task that is not
  // a contract segment and throws for any claim that cannot be proven. Other
  // writer holders are the caller's check (its one-shot holder check, which
  // exempts only this running segment), at admission and before every patch.
  function apiWriterAuthority(body, privateContext) {
    const ref = body?.unifiedRun;
    if (ref === undefined) return null;
    const refuse = (code = 'api_write_unauthorized') => { throw failure(code, 'API writer admission is not authorized for this task.'); };
    if (!plain(ref) || !RUN_ID_RE.test(String(ref.id)) || !Number.isSafeInteger(ref.segment) || ref.segment < 1) refuse();
    const keys = Object.keys(ref);
    if (keys.length === 2) return null;
    if (keys.length !== 4 || typeof ref.apiCheckpointRunId !== 'string' || typeof ref.writePathsHash !== 'string' || !HASH_RE.test(ref.writePathsHash)) refuse();
    if (typeof queue.isTaskContext !== 'function' || !queue.isTaskContext(privateContext)) refuse();
    let run;
    try { run = read(ref.id); } catch { refuse(); }
    if (!run || TERMINAL.has(run.state) || !run.apiWriteContract || run.dangerous !== true) refuse();
    try { barrier(run.id); } catch { refuse(); }
    const segment = current(run);
    if (!segment || segment.index !== ref.segment || segment.taskId !== privateContext.taskId || !contractSegment(run, segment)) refuse();
    const task = queue.get(segment.taskId);
    if (task?.status !== 'running' || task.delivery?.intentHash !== segment.intentHash
      || !['intent', 'not_submitted', 'dispatched'].includes(segment.state)
      || ref.apiCheckpointRunId !== apiCheckpointRunId(run.id, segment.index) || ref.writePathsHash !== run.apiWriteContract.pathsHash
      || body.dangerous !== true || task.body?.dangerous !== true || body.cwd !== run.cwd || task.body?.cwd !== run.cwd
      || body.kind !== segment.kind || task.body?.kind !== segment.kind) refuse();
    return Object.freeze({ runId: run.id, segment: segment.index, taskId: segment.taskId, cwd: run.cwd,
      checkpointRunId: ref.apiCheckpointRunId, allowedWritePaths: Object.freeze([...run.apiWriteContract.paths]),
      writePathsHash: run.apiWriteContract.pathsHash });
  }

  function recoveryView(run) {
    const segment = current(run);
    const plan = durable ? cancelPlan(run) : { safe: false, code: 'unified_run_platform_unsupported' };
    return {
      cancel: TERMINAL.has(run.state) ? 'not_applicable' : plan.safe ? 'available' : 'refused',
      cancelRefusal: TERMINAL.has(run.state) || plan.safe ? null : plan.code,
      link: segment?.state === 'uncertain' ? 'after_physical_settlement_and_reconciliation' : 'not_applicable',
      ...(contractSegment(run, segment) ? { effectsRecovery: segment.state === 'uncertain' ? 'resume_reconciles_journal' : 'not_applicable' } : {}),
      // Nothing is retried automatically: an uncertain or crashed segment is
      // never replayed, and legacy native uncertainty stays held.
      automaticRetry: false,
    };
  }

  function workspaceEffects(run, segment) {
    if (!run.dangerous) return { available: true, digest: null, summary: null };
    const pre = segment?.preSnapshot;
    if (!pre?.available || pre.fingerprintsTruncated) return { available: false, reason: pre?.reason || 'fingerprints_truncated' };
    const after = snapshot(run.cwd);
    if (!after?.available || after.fingerprintsTruncated) return { available: false, reason: after?.reason || 'fingerprints_truncated' };
    const stored = storeSnapshot(after);
    const summary = summarize(loadSnapshot(pre), after);
    return { available: true, summary,
      digest: sha256(JSON.stringify({ runId: run.id, taskId: segment.taskId, before: pre.digest, after: stored.digest, statusHash: summary?.statusHash ?? null })) };
  }

  function publicView(run, { includeEffects = false } = {}) {
    const segment = current(run);
    const view = {
      id: run.id, state: run.state, stopReason: run.stopReason || null, cwd: run.cwd, dangerous: run.dangerous,
      writeBoundary: run.apiWriteContract ? 'per_segment' : WRITE_BOUNDARY, objective: run.objective, advisoryFileScope: run.advisoryFileScope,
      ...(run.apiWriteContract ? { allowedWritePaths: [...run.apiWriteContract.paths], writePathsHash: run.apiWriteContract.pathsHash } : {}),
      createdAt: run.createdAt, updatedAt: run.updatedAt, holder: run.holder || null,
      segments: run.segments.map((s) => ({ index: s.index, taskId: s.taskId, phase: s.phase, kind: s.kind, transport: s.transport,
        accountId: s.accountId, quotaSeat: s.quotaSeat, model: s.model, effort: s.effort,
        ...(s.fundingProfileId ? { fundingProfileId: s.fundingProfileId, profileRevision: s.profileRevision } : {}),
        state: s.state, outcome: s.outcome, handoffDigest: s.handoffDigest, preSnapshotDigest: s.preSnapshot?.digest ?? null,
        writer_diff_summary: s.writerDiffSummary ?? null, linkedFrom: s.linkedFrom ?? null,
        // The boundary this segment actually ran under.
        writeBoundary: contractSegment(run, s) ? { ...API_WRITE_BOUNDARY }
          : s.transport === 'api' ? { ...API_READ_ONLY_BOUNDARY } : WRITE_BOUNDARY,
        ...(contractSegment(run, s) ? { apiCheckpointRunId: apiCheckpointRunId(run.id, s.index),
          effectsRecovery: s.effectsRecovery ?? null } : {}) })),
      writer_diff_summary: segment?.writerDiffSummary ?? null,
      durability: { platform, directoryBarrier: durable ? 'enforced' : 'unsupported',
        publication: uncertain.has(run.id) ? 'uncertain' : confirmed.has(run.id) ? 'confirmed' : 'unconfirmed' },
      recovery: recoveryView(run),
    };
    if (includeEffects && segment?.state === 'uncertain' && run.dangerous) {
      const effects = workspaceEffects(run, segment);
      view.workspaceReconciliation = effects.available
        ? { available: true, workspaceEffectsDigest: effects.digest, writer_diff_summary: effects.summary }
        : { available: false, reason: effects.reason };
    }
    return view;
  }

  function validateCreate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('invalid_unified_run', 'request body must be an object', 400);
    assertNoInternalFields(input);
    assertCanonicalFunding(input, false);
    // Prepaid is read-only: it is never a writer or contract segment.
    const prepaidRequested = Array.isArray(input.segments) && input.segments.some((entry) => plain(entry) && CREDIT_ROUTES.includes(entry.fundingRoute));
    if (prepaidRequested && (input.dangerous === true || Object.hasOwn(input, 'allowedWritePaths'))) {
      throw failure('api_agent_read_only', 'Owner-authorized credit runs only the read-only API agent.', 409);
    }
    // An exact write contract is never silently downgraded to an advisory one:
    // it is enforced by the API patch tool for an API-only dangerous run, and
    // refused for anything else.
    let contract = null;
    if (Object.hasOwn(input, 'allowedWritePaths')) {
      const apiOnly = Array.isArray(input.segments) && input.segments.length > 0
        && input.segments.every((entry) => plain(entry) && entry.transport === 'api');
      if (!apiOnly) {
        validateWriteContract(input);
        throw failure('filesystem_contract_unsupported', 'Exact write contracts are supported only for API-only unified runs.', 409);
      }
      if (input.dangerous !== true || input.acknowledgeFilesystemWrites !== true) {
        throw failure('filesystem_acknowledgement_required', 'allowedWritePaths requires dangerous=true and acknowledgeFilesystemWrites=true', 400);
      }
      contract = normalizeWriteContract(input.allowedWritePaths);
    }
    assertNoBannedContent(input);
    if (Object.keys(input).some((key) => key !== 'allowedWritePaths' && !INPUT_KEYS.has(key))) throw failure('invalid_unified_run', 'unsupported unified run field', 400);
    if (typeof input.objective !== 'string' || !input.objective.trim() || input.objective.length > 20000) {
      throw failure('invalid_unified_run', 'objective is required', 400);
    }
    if (input.dangerous !== undefined && typeof input.dangerous !== 'boolean') throw failure('invalid_unified_run', 'dangerous must be boolean', 400);
    const dangerous = input.dangerous === true;
    if (dangerous && input.acknowledgeFilesystemWrites !== true) {
      throw failure('filesystem_acknowledgement_required', 'dangerous=true requires acknowledgeFilesystemWrites=true', 400);
    }
    if (!dangerous && input.acknowledgeFilesystemWrites !== undefined) {
      throw failure('invalid_unified_run', 'acknowledgeFilesystemWrites is valid only with dangerous=true', 400);
    }
    if (!Array.isArray(input.segments) || !input.segments.length || input.segments.length > MAX_ENTRIES) {
      throw failure('invalid_unified_run', `segments must list 1-${MAX_ENTRIES} authorized entries`, 400);
    }
    const entries = input.segments.map(validateEntry);
    for (const entry of entries) if (entry.transport === 'api') validateApiEntry(entry);
    // Prepaid spends only after a listed native seat of the same provider and
    // account is positively exhausted, so that seat must be listed.
    for (const entry of entries.filter(prepaidEntry)) {
      if (!entries.some((native) => native.transport === 'native' && native.kind === entry.kind && native.accountId === entry.accountId)) {
        throw failure('prepaid_exhaustion_source_required', `An ${entry.fundingRoute} entry requires a listed native entry for the same provider and account.`, 400);
      }
    }
    const scope = input.advisoryFileScope === undefined ? [] : input.advisoryFileScope;
    if (!Array.isArray(scope) || scope.length > 128 || scope.some((p) => typeof p !== 'string' || !p || p.length > 500)) {
      throw failure('invalid_unified_run', 'advisoryFileScope must be a bounded list of paths', 400);
    }
    if (input.constraints !== undefined && (typeof input.constraints !== 'string' || input.constraints.length > 12000)) {
      throw failure('invalid_unified_run', 'constraints must be bounded text', 400);
    }
    return { dangerous, entries, scope, contract };
  }

  // All validation, binding and holder checks run before any directory exists.
  function create(input) {
    assertDurablePlatform();
    const { dangerous, entries, scope, contract } = validateCreate(input);
    const cwd = resolveCwd(input.cwd);
    for (const entry of entries) if (entry.transport === 'native') validateNativeEntry(entry, { dangerous, cwd });
    const bindings = entries.map((entry) => {
      if (entry.transport !== 'native') return null;
      const binding = bindSegment(entry, { dangerous });
      if (!binding || binding.accountId !== entry.accountId) throw failure('account_binding_required', 'The listed account is not available; no other account is substituted.');
      if (entry.fundingProfileId) nativeFunding(entry, binding);
      return { accountId: binding.accountId, quotaSeat: binding.quotaSeat };
    });
    if (dangerous) {
      const held = externalHolder(cwd, { runId: null, taskIds: [] });
      if (held) throw failure('workspace_writer_busy', 'Another writer holds an overlapping workspace.', 409, { holder: held });
    }
    const run = { version: 1, id: `ur_${crypto.randomBytes(12).toString('hex')}`, createdAt: new Date(now()).toISOString(),
      updatedAt: null, state: 'running', stopReason: null, objective: input.objective,
      constraints: input.constraints || '', advisoryFileScope: scope, title: typeof input.title === 'string' ? input.title.slice(0, 120) : input.objective.split('\n')[0].slice(0, 120),
      cwd, dangerous, writeBoundary: contract ? 'per_segment' : WRITE_BOUNDARY, ...(contract ? { apiWriteContract: { paths: contract.paths, pathsHash: contract.pathsHash } } : {}),
      entries, bindings, segments: [], exhaustedApi: [], reserveRelease: null, holder: null };
    // Plan before persisting: a run that cannot start leaves no directory.
    const plan = planSegment(run);
    if (plan.stop) throw failure(plan.error?.code || plan.stop, plan.error?.message || `No listed segment can start: ${plan.stop}`,
      plan.error?.status || 409, plan.holder ? { holder: plan.holder } : {});
    const runDir = path.join(root, run.id);
    try {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      fs.mkdirSync(runDir, { mode: 0o700 });
      syncDirectory(root); syncDirectory(path.dirname(root));
      rootConfirmed = true;
    } catch (error) {
      try { fs.rmdirSync(runDir); } catch {}
      throw failure('unified_run_write_failed', 'The unified run record could not be created.', 500, { publication: 'unchanged', cause: error });
    }
    try { return publicView(commitSegment(run, plan.segment)); }
    catch (error) {
      // Before the manifest's rename nothing was published: remove the empty
      // directory. rmdir leaves a published manifest in place.
      if (error.code === 'unified_run_write_failed') try { fs.rmdirSync(runDir); } catch {}
      if (fs.existsSync(runDir)) error.runId = run.id; else delete error.runId;
      throw error;
    }
  }

  function load(id) {
    const run = read(id);
    if (!run) throw failure('unified_run_not_found', 'unified run not found', 404);
    return run;
  }

  function status(id) {
    const run = load(id);
    return publicView(advance(run), { includeEffects: true });
  }

  function resume(id, input = {}) {
    assertNoInternalFields(input);
    assertDurablePlatform();
    const run = load(id);
    confirmPublication(run);
    if (TERMINAL.has(run.state)) return publicView(run); // terminal: no submit, no call
    const segment = current(run);
    if (segment?.state === 'uncertain' && contractSegment(run, segment)) return publicView(recoverEffects(run, segment));
    if (segment?.state === 'uncertain') throw failure(run.dangerous ? 'writer_execution_uncertain' : 'outcome_uncertain',
      'The last segment may have run; use link after it is physically settled and reconciled.');
    // An open segment, including one whose submit failed, is only ever
    // reconciled; resume never starts a second segment beside it.
    if (segment && !SEGMENT_CLOSED.has(segment.state)) return publicView(advance(run));
    if (run.pendingStart) return publicView(startSegment(run, run.pendingStart));
    return publicView(startSegment(run, { source: segment?.transport === 'native'
      ? { index: segment.entryIndex, quotaSeat: segment.quotaSeat, ...(headroomList(run)[segment.entryIndex] || {}) } : null }));
  }

  // Journal recovery of an uncertain contract segment. The queue task must be
  // terminal, the journal must prove every attempt stopped, and the run's
  // workspace hold must still be this run's at every patch step. Settled
  // recovery closes the segment as effects_reconciled and stops the run for
  // the client; anything else stays uncertain with its evidence and hold.
  function recoverEffects(run, segment) {
    const task = taskOf(segment);
    if (!task || !QUEUE_TERMINAL.has(task.status)) {
      throw failure('writer_execution_uncertain', 'The segment is not stopped; its journal cannot be reconciled yet.');
    }
    const checkpointRunId = apiCheckpointRunId(run.id, segment.index);
    const assertHeld = () => {
      let fresh = null;
      try { fresh = read(run.id); } catch {}
      const last = fresh && current(fresh);
      if (!fresh || TERMINAL.has(fresh.state) || last?.taskId !== segment.taskId || last.state !== 'uncertain'
        || fresh.apiWriteContract?.pathsHash !== run.apiWriteContract.pathsHash) {
        throw failure('writer_hold_lost', 'The unified run no longer holds this segment.');
      }
      if (externalHolder(run.cwd, { runId: run.id, taskIds: run.segments.map((s) => s.taskId) })) {
        throw failure('writer_hold_lost', 'Another writer holds an overlapping workspace.');
      }
    };
    assertHeld();
    let result;
    try {
      result = apiReconcileEffects({ checkpointRunId, expect: journalExpect(run, segment), cwd: run.cwd,
        allowedWritePaths: [...run.apiWriteContract.paths], assertHeld });
    } catch (error) {
      segment.effectsRecovery = { checkpointRunId, settled: false, reason: error.code || 'effects_recovery_failed',
        attemptedAt: new Date(now()).toISOString() };
      save(run);
      throw failure(error.code === 'workspace_writer_busy' ? 'workspace_writer_busy' : 'writer_execution_uncertain',
        `The segment's effects could not be reconciled (${error.code || 'effects_recovery_failed'}).`);
    }
    const settled = result?.settled === true;
    segment.effectsRecovery = { checkpointRunId, settled, outcome: result?.outcome?.class ?? result?.outcome ?? null,
      patches: Array.isArray(result?.patches) ? result.patches.slice(0, 256) : [],
      uncertain: Array.isArray(result?.uncertain) ? result.uncertain.slice(0, 256) : [],
      attemptedAt: new Date(now()).toISOString() };
    if (!settled) { save(run); return run; }
    segment.state = 'settled'; segment.outcome = 'effects_reconciled';
    segment.finalText = typeof task.result === 'string' ? task.result.slice(0, 4000) : '';
    segment.settledAt = new Date(now()).toISOString();
    segment.writerDiffSummary = summarize(loadSnapshot(segment.preSnapshot), snapshot(run.cwd));
    run.state = 'needs_attention'; run.stopReason = 'effects_reconciled';
    return save(run);
  }

  // Continue after an uncertain segment only once it is physically settled,
  // its workspace effects are reconciled against the client's echoed digest,
  // and no other writer holds the workspace.
  function link(id, input = {}) {
    assertNoInternalFields(input);
    assertDurablePlatform();
    const run = load(id);
    confirmPublication(run);
    if (TERMINAL.has(run.state)) throw failure('linked_attempt_parent_not_terminal', 'run is terminal');
    const segment = current(run);
    if (segment?.state !== 'uncertain') throw failure('linked_attempt_invalid', 'link applies only to an uncertain segment');
    const code = run.dangerous ? 'writer_execution_uncertain' : 'outcome_uncertain';
    const task = taskOf(segment);
    if (!physicallyStopped(task) || !physicallySettled(task)) throw failure(code, 'The segment is not physically settled or fenced.');
    if (contractSegment(run, segment) && journalSettled(run, segment).settled !== true) {
      throw failure(code, 'The segment\'s journal does not prove its effects settled; resume reconciles it first.');
    }
    if (run.dangerous) {
      const effects = workspaceEffects(run, segment);
      if (!effects.available) throw failure('workspace_reconciliation_unavailable', `Workspace effects cannot be reconciled (${effects.reason}).`);
      if (typeof input.workspaceEffectsDigest !== 'string' || input.workspaceEffectsDigest !== effects.digest) {
        throw failure(code, 'workspaceEffectsDigest is missing or stale; read status again.');
      }
      segment.writerDiffSummary = effects.summary;
    }
    if (task.execution?.state !== 'never_started' && input.confirmDuplicateBillingRisk !== true) {
      throw failure('linked_attempt_unauthorized', 'confirmDuplicateBillingRisk=true is required because a call may have been sent.');
    }
    if (run.dangerous) {
      const held = externalHolder(run.cwd, { runId: run.id, taskIds: run.segments.map((s) => s.taskId) });
      if (held) throw failure('workspace_writer_busy', 'Another writer holds an overlapping workspace.', 409, { holder: held });
    }
    segment.state = 'settled'; segment.outcome = 'linked_after_uncertain';
    segment.settledAt = new Date(now()).toISOString();
    save(run);
    return publicView(startSegment(run, { linkedFrom: segment.taskId,
      nextAction: 'The previous segment ended with an uncertain outcome. Inspect the workspace state before continuing; do not assume its edits completed.' }));
  }

  return Object.freeze({ create, status, resume, link, cancel, tick, holderFor, reserveAuthority, prepaidAuthority, apiWriterAuthority,
    get: (id) => { const run = read(id); return run ? publicView(run) : null; }, WRITE_BOUNDARY, durable });
}

module.exports = { createUnifiedRuns, WRITE_BOUNDARY, RUN_ID_RE, DURABLE_PLATFORMS, apiCheckpointRunId, normalizeWriteContract };
