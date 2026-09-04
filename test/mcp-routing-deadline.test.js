'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

function delayedStage(delayMs, value, observations, name) {
  return (signal, budgetMs) => new Promise((resolve, reject) => {
    observations.push({ name, budgetMs, startedAt: Date.now() });
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error(`${name} aborted`));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

test('account-aware routing spends one deadline across diagnostics and route lookup', async () => {
  const { runAccountAwareRouteStages } = await import('../mcp/server.mjs');
  const observations = [];
  const startedAt = Date.now();
  await assert.rejects(runAccountAwareRouteStages({
    timeoutMs: 90,
    loadDiagnostics: delayedStage(55, {}, observations, 'diagnostics'),
    requestRoute: delayedStage(55, { ok: true }, observations, 'route'),
  }), (error) => error?.name === 'TimeoutError');
  const elapsedMs = Date.now() - startedAt;
  assert.deepEqual(observations.map((item) => item.name), ['diagnostics', 'route']);
  assert.ok(observations[1].budgetMs < observations[0].budgetMs,
    'the route stage receives only the budget diagnostics left behind');
  assert.ok(elapsedMs < 160,
    `sequential stages exceeded the single overall deadline (${elapsedMs}ms)`);
});

test('MCP diagnostic envelope covers the server probe deadline and close grace', async () => {
  const {
    DIAGNOSTIC_UPSTREAM_TIMEOUT_MS,
    ACCOUNT_AWARE_ROUTE_TIMEOUT_MS,
  } = await import('../mcp/server.mjs');
  assert.ok(DIAGNOSTIC_UPSTREAM_TIMEOUT_MS >= 32000,
    '30s provider probes plus the 2s close grace must fit upstream');
  assert.ok(ACCOUNT_AWARE_ROUTE_TIMEOUT_MS >= DIAGNOSTIC_UPSTREAM_TIMEOUT_MS + 10000,
    'the route lookup keeps its own headroom after a maximum diagnostic');
});

test('account-aware routing returns when both stages fit inside the shared deadline', async () => {
  const { runAccountAwareRouteStages } = await import('../mcp/server.mjs');
  const observations = [];
  const cachedDiagnostics = { claude: { found: true, ready: false, authFailed: true } };
  let forwardedDiagnostics = null;
  const value = await runAccountAwareRouteStages({
    timeoutMs: 150,
    loadDiagnostics: delayedStage(20, cachedDiagnostics, observations, 'diagnostics'),
    requestRoute: (signal, budgetMs, diagnostics) => {
      forwardedDiagnostics = diagnostics;
      return delayedStage(20, { ok: true, routeId: 'route_fixture' }, observations, 'route')(
        signal, budgetMs,
      );
    },
  });
  assert.equal(value.routeId, 'route_fixture');
  assert.ok(observations[1].budgetMs < observations[0].budgetMs);
  assert.equal(forwardedDiagnostics, cachedDiagnostics,
    'cached readiness crosses a bridge restart by being sent to the new route endpoint');
});
