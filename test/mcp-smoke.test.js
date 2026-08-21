'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

function result(structuredContent, isError = false) {
  return { structuredContent, ...(isError ? { isError: true } : {}) };
}

function baseResults(overrides = {}) {
  return {
    bridge_status: result({
      ok: true,
      health: { buildId: 'test-build', receiptStoreId: 'store-test' },
      providers: [{ kind: 'ollama_fast', readiness: { ready: true } }],
    }),
    get_context_bundle: result({
      ok: true,
      bundleId: 'bundle-test',
      receiptId: 'rcpt-context',
      transfer: { withinBudget: true },
      providers: [],
      activeWork: { runs: [] },
      registries: { fingerprints: { policySha256: 'policy-test' } },
    }),
    route_preview: result({ ok: true, route: { selected: [{ kind: 'ollama_fast' }] } }),
    route_and_ask: result({
      ok: true,
      winner: { kind: 'ollama_fast', stdout: 'MCP_LOCAL_ROUTE_OK', usage: {} },
      runId: 'run-route',
      receiptId: 'rcpt-route',
    }),
    run_committee: result({
      ok: true,
      status: 'completed',
      allSeatsSucceeded: true,
      runId: 'run-committee',
      receiptId: 'rcpt-committee',
      members: [
        { kind: 'ollama_fast', role: 'reviewer', exitCode: 0, droppedOut: false, receiptId: 'rcpt-fast' },
        { kind: 'ollama_coder', role: 'critic', exitCode: 0, droppedOut: false, receiptId: 'rcpt-coder' },
      ],
    }),
    ...overrides,
  };
}

function fakeHarness(results, {
  hangingClose = false,
  rejectingClose = false,
  failAt = null,
} = {}) {
  const calls = [];
  const never = () => new Promise(() => {});
  const client = {
    async connect() {
      calls.push({ name: 'connect' });
      if (failAt === 'connect') throw new Error('connect failed');
    },
    async listTools() { return { tools: [{ name: 'bridge_status' }] }; },
    async listResources() { return { resources: [{ uri: 'psbridge://status' }] }; },
    async callTool(request) {
      calls.push(request);
      if (failAt === request.name) throw new Error(`${request.name} failed`);
      const fixture = results[request.name];
      return typeof fixture === 'function' ? fixture(request) : fixture;
    },
    async close() {
      calls.push({ name: 'client.close' });
      if (rejectingClose) throw new Error('client close rejected');
      if (hangingClose) await never();
    },
  };
  const transport = {
    pid: 4242,
    stderr: { destroy() { calls.push({ name: 'stderr.destroy' }); } },
    async close() {
      calls.push({ name: 'transport.close' });
      if (rejectingClose) throw new Error('transport close rejected');
      if (hangingClose) await never();
    },
  };
  return { client, transport, calls };
}

test('completed persisted committee emits before bounded cleanup and cannot strand caller', async () => {
  const { runSmoke } = await import('../tools/mcp-smoke.mjs');
  const harness = fakeHarness(baseResults(), { hangingClose: true });
  const emitted = [];
  const terminated = [];
  const started = Date.now();
  const outcome = await runSmoke({
    ...harness,
    includeCommittee: true,
    cleanupBudgetMs: 20,
    emit: async (payload) => { emitted.push(payload); },
    terminatePid: async (pid) => { terminated.push(pid); return true; },
  });

  assert.ok(Date.now() - started < 500, 'hanging close paths remain bounded');
  assert.equal(outcome.exitCode, 0);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].ok, true);
  assert.deepEqual(emitted[0].cleanup, { status: 'pending', boundedMs: 20 });
  assert.deepEqual(emitted[0].committee, {
    ok: true,
    status: 'completed',
    allSeatsSucceeded: true,
    persisted: true,
    missingProviders: [],
    failedProviders: [],
    persistenceErrors: [],
    runId: 'run-committee',
    receiptId: 'rcpt-committee',
    members: [
      { kind: 'ollama_fast', role: 'reviewer', succeeded: true, usage: undefined, receiptId: 'rcpt-fast' },
      { kind: 'ollama_coder', role: 'critic', succeeded: true, usage: undefined, receiptId: 'rcpt-coder' },
    ],
  });
  assert.deepEqual(terminated, [4242]);
  assert.equal(outcome.cleanup.clientClose.settled, false);
  assert.equal(outcome.cleanup.transportClose.settled, false);
});

test('requested failed committee exits nonzero even when top-level tool ok is true', async () => {
  const { runSmoke } = await import('../tools/mcp-smoke.mjs');
  const harness = fakeHarness(baseResults({
    run_committee: result({
      ok: true,
      status: 'failed',
      allSeatsSucceeded: false,
      runId: 'run-failed',
      receiptId: 'rcpt-failed',
      members: [
        { kind: 'ollama_fast', exitCode: 0, droppedOut: false },
        { kind: 'ollama_coder', exitCode: 1, droppedOut: true },
      ],
    }),
  }));
  const emitted = [];
  const outcome = await runSmoke({
    ...harness,
    includeCommittee: true,
    cleanupBudgetMs: 20,
    emit: async (payload) => { emitted.push(payload); },
  });

  assert.equal(outcome.exitCode, 1);
  assert.equal(emitted[0].ok, false);
  assert.equal(emitted[0].failure.kind, 'requested_committee_failed');
  assert.equal(emitted[0].failure.status, 'failed');
  assert.deepEqual(emitted[0].failure.failedProviders, ['ollama_coder']);
  assert.equal(emitted[0].committee.runId, 'run-failed');
  assert.equal(emitted[0].committee.receiptId, 'rcpt-failed');
});

test('stale source build identity is nonzero and recommends installed-root recovery', async () => {
  const { runSmoke } = await import('../tools/mcp-smoke.mjs');
  const harness = fakeHarness(baseResults({
    route_and_ask: result({
      ok: false,
      error: 'RelayBridge action identity mismatch',
      failureClass: 'bridge_identity_mismatch',
      actionPreflight: {
        expectedBuildId: 'source-old',
        currentBuildId: 'installed-new',
        buildMatches: false,
      },
    }, true),
  }));
  const emitted = [];
  const outcome = await runSmoke({
    ...harness,
    cleanupBudgetMs: 20,
    emit: async (payload) => { emitted.push(payload); },
  });

  assert.equal(outcome.exitCode, 1);
  assert.equal(emitted[0].failure.kind, 'source_build_identity_mismatch');
  assert.equal(emitted[0].failure.failureClass, 'bridge_identity_mismatch');
  assert.equal(emitted[0].failure.detail.currentBuildId, 'installed-new');
  assert.match(emitted[0].failure.guidance, /installed root/i);
  assert.match(emitted[0].failure.guidance, /build-info\.json/i);
  assert.match(emitted[0].failure.guidance, /invoked no provider/i);
});

test('historical context identity mismatch cannot fail a healthy current action', async () => {
  const { runSmoke } = await import('../tools/mcp-smoke.mjs');
  const healthyContext = baseResults().get_context_bundle.structuredContent;
  const harness = fakeHarness(baseResults({
    get_context_bundle: result({
      ...healthyContext,
      recentReceipts: [{
        receiptId: 'rcpt-historical-mismatch',
        failureClass: 'bridge_identity_mismatch',
        modelInvocation: false,
        tokenUsageSource: 'not_invoked',
        actionPreflight: {
          expectedBuildId: 'historical-source',
          currentBuildId: 'historical-runtime',
          buildMatches: false,
          receiptStoreMatches: true,
        },
      }],
    }),
  }));
  const emitted = [];
  const outcome = await runSmoke({
    ...harness,
    cleanupBudgetMs: 20,
    emit: async (payload) => { emitted.push(payload); },
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(emitted[0].ok, true);
  assert.equal(emitted[0].failure, null);
  assert.equal(emitted[0].routed.receiptId, 'rcpt-route');
});

test('verified current action-owned committee mismatch preserves exact diagnostic and preflight', async () => {
  const { runSmoke } = await import('../tools/mcp-smoke.mjs');
  const rootReceiptId = 'rcpt_mt2root_1234abcd';
  const staleMember = {
    kind: 'ollama_coder',
    role: 'critic',
    exitCode: 1,
    droppedOut: true,
    receiptId: 'rcpt_mt2member_5678abcd',
    failureClass: 'bridge_identity_mismatch',
    modelInvocation: false,
    tokenUsageSource: 'not_invoked',
    actionPreflight: {
      expectedBuildId: 'source-old',
      currentBuildId: 'installed-new',
      buildMatches: false,
      receiptStoreMatches: true,
    },
  };
  assert.equal(Object.hasOwn(staleMember, 'invocationId'), false);
  const harness = fakeHarness(baseResults({
    run_committee: result({
      ok: true,
      status: 'failed',
      allSeatsSucceeded: false,
      runId: 'run-stale-committee',
      receiptId: rootReceiptId,
      members: [
        { kind: 'ollama_fast', role: 'reviewer', exitCode: 0, droppedOut: false },
        staleMember,
      ],
    }),
    get_receipt: (request) => result({
      receipt: {
        receiptId: request.arguments.receiptId,
        event: 'provider_call',
        parentReceiptId: rootReceiptId,
        provider: staleMember.kind,
        failureClass: staleMember.failureClass,
        actionPreflight: staleMember.actionPreflight,
      },
      chain: [],
      chainTruncated: false,
    }),
  }));
  const emitted = [];
  const outcome = await runSmoke({
    ...harness,
    includeCommittee: true,
    cleanupBudgetMs: 20,
    emit: async (payload) => { emitted.push(payload); },
  });

  assert.equal(outcome.exitCode, 1);
  assert.equal(emitted[0].failure.kind, 'source_build_identity_mismatch');
  assert.equal(emitted[0].failure.phase, 'committee');
  assert.equal(emitted[0].failure.diagnosticPath, 'structuredContent.members.1');
  assert.equal(emitted[0].failure.ownedReceiptId, staleMember.receiptId);
  assert.equal(emitted[0].failure.verifiedReceipt.parentReceiptId, rootReceiptId);
  assert.deepEqual(emitted[0].failure.diagnostic, staleMember);
  assert.deepEqual(emitted[0].failure.detail, staleMember.actionPreflight);
  assert.match(emitted[0].failure.guidance, /installed root/i);
  assert.match(emitted[0].failure.guidance, /build-info\.json/i);
  assert.match(emitted[0].failure.guidance, /invoked no provider/i);
});

test('verified current routed attempt mismatch uses the real return shape without invocationId', async () => {
  const { runSmoke } = await import('../tools/mcp-smoke.mjs');
  const rootReceiptId = 'rcpt_mt2route_1234abcd';
  const staleAttempt = {
    kind: 'ollama_fast',
    exitCode: -1,
    droppedOut: true,
    receiptId: 'rcpt_mt2attempt_5678abcd',
    failureClass: 'bridge_identity_mismatch',
    modelInvocation: false,
    tokenUsageSource: 'not_invoked',
    actionPreflight: {
      expectedBuildId: 'source-old',
      currentBuildId: 'installed-new',
      buildMatches: false,
      receiptStoreMatches: true,
    },
  };
  assert.equal(Object.hasOwn(staleAttempt, 'invocationId'), false);
  const harness = fakeHarness(baseResults({
    route_and_ask: result({
      ok: false,
      status: 'failed',
      route: { selected: [{ kind: staleAttempt.kind }] },
      winner: null,
      attempts: [staleAttempt],
      runId: 'run-stale-route',
      receiptId: rootReceiptId,
    }),
    get_receipt: (request) => result({
      receipt: {
        receiptId: request.arguments.receiptId,
        event: 'provider_call',
        parentReceiptId: rootReceiptId,
        provider: staleAttempt.kind,
        failureClass: staleAttempt.failureClass,
        actionPreflight: staleAttempt.actionPreflight,
      },
      chain: [],
      chainTruncated: false,
    }),
  }));
  const emitted = [];
  const outcome = await runSmoke({
    ...harness,
    cleanupBudgetMs: 20,
    emit: async (payload) => { emitted.push(payload); },
  });

  assert.equal(outcome.exitCode, 1);
  assert.equal(emitted[0].failure.kind, 'source_build_identity_mismatch');
  assert.equal(emitted[0].failure.phase, 'routed');
  assert.equal(emitted[0].failure.diagnosticPath, 'structuredContent.attempts.0');
  assert.equal(emitted[0].failure.ownedReceiptId, staleAttempt.receiptId);
  assert.equal(emitted[0].failure.verifiedReceipt.parentReceiptId, rootReceiptId);
});

test('unowned nested mismatch diagnostics never masquerade as current identity failure', async (t) => {
  const { runSmoke } = await import('../tools/mcp-smoke.mjs');
  const rootReceiptId = 'rcpt_mt2root_1234abcd';
  const baseMember = {
    kind: 'ollama_coder',
    role: 'critic',
    exitCode: 1,
    droppedOut: true,
    receiptId: 'rcpt_mt2member_5678abcd',
    failureClass: 'bridge_identity_mismatch',
    modelInvocation: false,
    tokenUsageSource: 'not_invoked',
    actionPreflight: {
      expectedBuildId: 'source-old',
      currentBuildId: 'installed-new',
      buildMatches: false,
      receiptStoreMatches: true,
    },
  };
  const cases = [
    {
      name: 'unexpected historical_intruder member',
      member: { ...baseMember, kind: 'historical_intruder' },
      receipt: null,
    },
    {
      name: 'fabricated canonical-looking receipt',
      member: baseMember,
      receipt: null,
    },
    {
      name: 'noncanonical receipt id',
      member: { ...baseMember, receiptId: 'fabricated-receipt' },
      receipt: null,
    },
    {
      name: 'spoofed parent receipt',
      member: baseMember,
      receipt: {
        receiptId: baseMember.receiptId,
        event: 'provider_call',
        parentReceiptId: 'rcpt_otherroot_8765dcba',
        provider: baseMember.kind,
        failureClass: baseMember.failureClass,
        actionPreflight: baseMember.actionPreflight,
      },
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const harness = fakeHarness(baseResults({
        run_committee: result({
          ok: true,
          status: 'failed',
          allSeatsSucceeded: false,
          runId: 'run-unowned-committee',
          receiptId: rootReceiptId,
          members: [
            { kind: 'ollama_fast', role: 'reviewer', exitCode: 0, droppedOut: false },
            testCase.member,
          ],
        }),
        get_receipt: testCase.receipt
          ? result({ receipt: testCase.receipt, chain: [], chainTruncated: false })
          : result({ ok: false, error: 'receipt not found' }, true),
      }));
      const emitted = [];
      const outcome = await runSmoke({
        ...harness,
        includeCommittee: true,
        cleanupBudgetMs: 20,
        emit: async (payload) => { emitted.push(payload); },
      });

      assert.equal(outcome.exitCode, 1);
      assert.equal(emitted[0].failure.kind, 'requested_committee_failed');
      assert.notEqual(emitted[0].failure.kind, 'source_build_identity_mismatch');
    });
  }
});

test('partial JSON is emitted on an MCP exception before cleanup', async () => {
  const { runSmoke } = await import('../tools/mcp-smoke.mjs');
  const harness = fakeHarness(baseResults(), { failAt: 'get_context_bundle' });
  const events = [];
  const outcome = await runSmoke({
    ...harness,
    cleanupBudgetMs: 20,
    emit: async (payload) => { events.push({ type: 'emit', payload }); },
    terminatePid: async () => { events.push({ type: 'terminate' }); return true; },
  });

  assert.equal(outcome.exitCode, 1);
  assert.equal(events[0].type, 'emit');
  assert.equal(events[0].payload.failure.phase, 'get_context_bundle');
  assert.deepEqual(events[0].payload.partial.completedPhases, ['status']);
});

test('emit failure still bounds cleanup and terminates only the captured transport pid', async () => {
  const { runSmoke } = await import('../tools/mcp-smoke.mjs');
  const harness = fakeHarness(baseResults(), { hangingClose: true });
  const terminated = [];
  const outputError = Object.assign(new Error('broken stdout'), { code: 'EPIPE' });

  await assert.rejects(runSmoke({
    ...harness,
    cleanupBudgetMs: 20,
    emit: async () => { throw outputError; },
    terminatePid: async (pid) => { terminated.push(pid); return true; },
  }), (error) => error === outputError);

  assert.ok(harness.calls.some((entry) => entry.name === 'client.close'));
  assert.ok(harness.calls.some((entry) => entry.name === 'transport.close'));
  assert.ok(harness.calls.some((entry) => entry.name === 'stderr.destroy'));
  assert.deepEqual(terminated, [4242]);
});

test('emit failure plus rejected closes still terminates only the captured transport pid', async () => {
  const { runSmoke } = await import('../tools/mcp-smoke.mjs');
  const harness = fakeHarness(baseResults(), { rejectingClose: true });
  const terminated = [];
  const outputError = Object.assign(new Error('broken stdout'), { code: 'EPIPE' });

  await assert.rejects(runSmoke({
    ...harness,
    cleanupBudgetMs: 20,
    emit: async () => { throw outputError; },
    terminatePid: async (pid) => { terminated.push(pid); return true; },
  }), (error) => error === outputError);

  assert.deepEqual(
    harness.calls.filter((entry) => entry.name.endsWith('.close')).map((entry) => entry.name),
    ['client.close', 'transport.close'],
  );
  assert.equal(harness.calls.filter((entry) => entry.name === 'stderr.destroy').length, 1);
  assert.deepEqual(terminated, [4242]);
});

test('smoke requests never send provider timeoutMs or retry instructions', async () => {
  const { runSmoke } = await import('../tools/mcp-smoke.mjs');
  const harness = fakeHarness(baseResults());
  const outcome = await runSmoke({
    ...harness,
    includeCommittee: true,
    cleanupBudgetMs: 20,
    emit: async () => {},
  });
  assert.equal(outcome.exitCode, 0);
  const requests = harness.calls.filter((entry) => entry.arguments);
  assert.ok(requests.length > 0);
  for (const request of requests) {
    assert.equal(Object.hasOwn(request.arguments, 'timeoutMs'), false, request.name);
    assert.equal(Object.hasOwn(request.arguments, 'retry'), false, request.name);
    assert.equal(Object.hasOwn(request.arguments, 'retries'), false, request.name);
  }
});
