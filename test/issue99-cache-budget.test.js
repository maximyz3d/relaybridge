'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RunSupervisor, resolveSupervisorOptions } = require('../lib/run-supervisor');
const { parseProviderBudgetFlag, printPlan } = require('../bin/relaybridge');
const { buildTaskPlan } = require('../lib/task-plan');

test('issue #99: Claude provider override exceeds 2.5M cache read tokens without stopping', () => {
  const cfg = {
    _supervisor: {
      providerBudget: {
        maxOutputTokens: 100000,
        maxTotalTokens: 3000000,
        maxCacheReadTokens: 2500000,
        maxCacheCreationTokens: 500000,
        maxTurns: null,
      },
    },
    claude: {
      supervisor: {
        providerBudgetByTaskTier: {
          standard: {
            maxTotalTokens: 12000000,
            maxCacheReadTokens: 10000000,
          },
        },
      },
    },
  };

  const opts = resolveSupervisorOptions({
    entry: cfg.claude,
    globals: cfg._supervisor,
    taskTier: 'standard',
  });

  assert.equal(opts.providerBudget.maxTotalTokens, 12000000, 'Claude provider override raises the total-token ceiling');
  assert.equal(opts.providerBudget.maxCacheReadTokens, 10000000, 'Claude provider override raises the cache-read ceiling');

  const supervisor = new RunSupervisor(opts);
  supervisor.recordProviderUsage({ total_tokens: 3100000, cache_read_input_tokens: 3000000 }, { phase: 'incremental' });
  const verdict = supervisor.evaluate();
  assert.equal(verdict.action, 'continue', 'Claude session reading >2.5M cache tokens is not stopped');
});

test('issue #99: Claude utility work keeps the conservative global token budget', () => {
  const globals = {
    providerBudget: {
      maxTotalTokens: 3000000,
      maxCacheReadTokens: 2500000,
    },
  };
  const entry = {
    supervisor: {
      providerBudgetByTaskTier: {
        standard: { maxTotalTokens: 12000000, maxCacheReadTokens: 10000000 },
      },
    },
  };

  const opts = resolveSupervisorOptions({ entry, globals, taskTier: 'utility' });
  assert.equal(opts.providerBudget.maxTotalTokens, 3000000);
  assert.equal(opts.providerBudget.maxCacheReadTokens, 2500000);
});

test('issue #99: non-Claude default maxCacheReadTokens stays unchanged at 2.5M and stops when exceeded', () => {
  const cfg = {
    _supervisor: {
      providerBudget: {
        maxOutputTokens: 100000,
        maxTotalTokens: 3000000,
        maxCacheReadTokens: 2500000,
        maxCacheCreationTokens: 500000,
        maxTurns: null,
      },
    },
    powershell: {},
  };

  const opts = resolveSupervisorOptions({
    entry: cfg.powershell,
    globals: cfg._supervisor,
  });

  assert.equal(opts.providerBudget.maxCacheReadTokens, 2500000, 'non-Claude provider retains default 2.5M cap');

  const supervisor = new RunSupervisor(opts);
  supervisor.recordProviderUsage({ cache_read_input_tokens: 2500001 }, { phase: 'incremental' });
  const verdict = supervisor.evaluate();
  assert.equal(verdict.action, 'kill', 'non-Claude provider stops when exceeding 2.5M cache read tokens');
  assert.equal(verdict.reason, 'token_budget');
  assert.match(verdict.detail, /cache_read_input_tokens/);
});

test('issue #99: explicit per-call lower providerBudget override wins over provider default and stops deterministically', () => {
  const cfg = {
    _supervisor: {
      providerBudget: {
        maxOutputTokens: 100000,
        maxTotalTokens: 3000000,
        maxCacheReadTokens: 2500000,
        maxCacheCreationTokens: 500000,
        maxTurns: null,
      },
    },
    claude: {
      supervisor: {
        providerBudgetByTaskTier: {
          standard: {
            maxTotalTokens: 12000000,
            maxCacheReadTokens: 10000000,
          },
        },
      },
    },
  };

  const opts = resolveSupervisorOptions({
    entry: cfg.claude,
    globals: cfg._supervisor,
    providerBudget: { maxTotalTokens: 110000, maxCacheReadTokens: 100000 },
    taskTier: 'standard',
  });

  assert.equal(opts.providerBudget.maxCacheReadTokens, 100000, 'explicit per-call budget overrides Claude null default');

  const supervisor = new RunSupervisor(opts);
  supervisor.recordProviderUsage({ cache_read_input_tokens: 89999 }, { phase: 'incremental' });
  assert.equal(supervisor.evaluate().action, 'continue', 'below the finalization reserve runs safely');
  supervisor.recordProviderUsage({ cache_read_input_tokens: 100000 }, { phase: 'incremental' });
  assert.equal(supervisor.evaluate().action, 'finalize', 'the checkpoint reserve finalizes without increasing the per-call ceiling');

  supervisor.recordProviderUsage({ cache_read_input_tokens: 100001 }, { phase: 'incremental' });
  const verdict = supervisor.evaluate();
  assert.equal(verdict.action, 'kill', 'stops deterministically when exceeding per-call budget');
  assert.equal(verdict.reason, 'token_budget');
  assert.match(verdict.detail, /cache_read_input_tokens/);
});

test('issue #99: explicit null per-call budget disables one tier-specific ceiling', () => {
  const opts = resolveSupervisorOptions({
    globals: { providerBudget: { maxCacheReadTokens: 2500000 } },
    entry: {
      supervisor: {
        providerBudgetByTaskTier: {
          standard: { maxCacheReadTokens: 10000000 },
        },
      },
    },
    providerBudget: { maxCacheReadTokens: null },
    taskTier: 'standard',
  });

  assert.equal(opts.providerBudget.maxCacheReadTokens, null);
});

test('issue #99: malformed CLI providerBudget is rejected with clear InputError', () => {
  assert.throws(
    () => parseProviderBudgetFlag('invalid-json'),
    /invalid --provider-budget JSON format/,
  );
  assert.throws(
    () => parseProviderBudgetFlag('{"maxCacheReadTokens": -500}'),
    /must be a positive safe integer or null/,
  );
  assert.throws(
    () => parseProviderBudgetFlag('{"unknownField": 100}'),
    /unknown providerBudget field: unknownField/,
  );
  assert.throws(
    () => parseProviderBudgetFlag(true),
    /requires a JSON object string/,
  );
  assert.throws(
    () => parseProviderBudgetFlag('true'),
    /providerBudget must be an object/,
  );
  assert.throws(
    () => parseProviderBudgetFlag('[1, 2, 3]'),
    /providerBudget must be an object/,
  );
});

test('issue #99: buildTaskPlan reports resolved providerBudget for candidate providers', () => {
  const cfg = {
    _supervisor: {
      providerBudget: {
        maxOutputTokens: 100000,
        maxTotalTokens: 3000000,
        maxCacheReadTokens: 2500000,
        maxCacheCreationTokens: 500000,
        maxTurns: null,
      },
    },
    claude: {
      supervisor: {
        providerBudgetByTaskTier: {
          standard: {
            maxTotalTokens: 12000000,
            maxCacheReadTokens: 10000000,
          },
        },
      },
    },
  };

  const route = {
    classification: { tier: 'standard' },
    selected: [{ kind: 'claude', ready: true }],
  };

  const plan = buildTaskPlan({
    route,
    config: cfg,
    requestedKind: 'claude',
  });

  assert.ok(plan.primary, 'primary plan constructed');
  assert.equal(plan.primary.providerBudget.maxTotalTokens, 12000000, 'resolved total budget reported in plan primary');
  assert.equal(plan.primary.providerBudget.maxCacheReadTokens, 10000000, 'resolved cache budget reported in plan primary');
});

test('issue #99: human-readable CLI plans disclose the resolved provider budget', () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    printPlan({
      tier: 'standard',
      effort: 'medium',
      primary: {
        company: 'Anthropic', kind: 'claude', label: 'Claude Code',
        model: 'sonnet', modelTier: 'standard', costNote: 'subscription', args: [],
        providerBudget: { maxTotalTokens: 12000000, maxCacheReadTokens: 10000000, maxTurns: null },
      },
      alternates: [], guidance: [], humanGate: false,
    });
  } finally {
    console.log = original;
  }
  assert.ok(lines.some((line) => line.includes('maxCacheReadTokens=10000000')));
  assert.ok(lines.some((line) => line.includes('maxTurns=off')));
});
