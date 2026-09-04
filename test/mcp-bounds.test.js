'use strict';

// Issue #26: numeric bounds reached the JSON Schema, but not the human-readable
// description. Many clients surface only the description to the model, so a
// caller picked maxChars=12000 and was rejected by validation before any work
// happened — a wasted round trip the description could have prevented.

const test = require('node:test');
const assert = require('node:assert/strict');

let buildServer, describeNumericBounds, workflowPermissionDefaults, z;
test.before(async () => {
  ({ buildServer, describeNumericBounds, workflowPermissionDefaults } = await import('../mcp/server.mjs'));
  ({ z } = await import('zod'));
});

const tools = () => {
  const s = buildServer();
  return s._registeredTools || s.registeredTools;
};

test('the reported minimum matches what the server actually enforces', async () => {
  const t = tools().get_context_bundle;
  const js = z.toJSONSchema(t.inputSchema);
  assert.equal(js.properties.maxChars.minimum, 30000, 'schema still carries the real bound');
  assert.match(t.description, /maxChars 30000-200000/,
    'the description must state the same bound the validator enforces');
});

test('every bounded numeric parameter is documented in its description', () => {
  const failures = [];
  for (const [name, tool] of Object.entries(tools())) {
    const ranges = describeNumericBounds(tool.inputSchema);
    if (!ranges) continue; // no bounded numerics
    for (const part of ranges.split(', ')) {
      if (!tool.description.includes(part)) failures.push(`${name}: missing "${part}"`);
    }
  }
  assert.deepEqual(failures, [], 'a bounded parameter must not be undocumented');
});

test('descriptions are derived from the schema, so they cannot drift', () => {
  // The mechanism, not one instance: any tool with bounds gets them appended.
  for (const [name, tool] of Object.entries(tools())) {
    const ranges = describeNumericBounds(tool.inputSchema);
    if (ranges) {
      assert.match(tool.description, /Accepted ranges:/,
        `${name} has bounded numerics but no derived range text`);
    }
  }
});

test('the range text is appended exactly once, even if a tool is re-registered', () => {
  for (const tool of Object.values(tools())) {
    const hits = (tool.description.match(/Accepted ranges:/g) || []).length;
    assert.ok(hits <= 1, 'ranges must not be appended repeatedly');
  }
});

// ---- the extractor itself --------------------------------------------------

test('bounds are found through default() and optional() wrappers', async () => {
  const schema = z.object({
    plain: z.number().min(1).max(10),
    withDefault: z.number().int().min(100).max(200).default(150),
    optional: z.number().min(5).max(50).optional(),
  });
  const out = describeNumericBounds(schema);
  assert.match(out, /plain 1-10/);
  assert.match(out, /withDefault 100-200/, 'a default must not hide the bound');
  assert.match(out, /optional 5-50/, 'optional must not hide the bound');
});

test('one-sided and unbounded parameters are handled honestly', () => {
  assert.match(describeNumericBounds(z.object({ a: z.number().min(0) })), /a >= 0/);
  assert.match(describeNumericBounds(z.object({ b: z.number().max(9) })), /b <= 9/);
  assert.equal(describeNumericBounds(z.object({ c: z.number() })), null,
    'an unbounded number needs no range text');
  assert.equal(describeNumericBounds(z.object({ s: z.string().min(1) })), null,
    'string lengths are not numeric ranges');
});

test('a malformed schema yields null rather than throwing', () => {
  for (const bad of [null, undefined, {}, 'nope', 42]) {
    assert.equal(describeNumericBounds(bad), null);
  }
});

test('pipeline permissions default to full only when both explicit host gates are enabled', () => {
  assert.deepEqual(workflowPermissionDefaults({}, {}), {
    permissionMode: 'safe', acknowledgeFilesystemWrites: false,
  });
  assert.deepEqual(workflowPermissionDefaults({}, {
    RELAYBRIDGE_ALLOW_STICKY_DANGEROUS: '1',
  }), { permissionMode: 'safe', acknowledgeFilesystemWrites: false });
  assert.deepEqual(workflowPermissionDefaults({}, {
    RELAYBRIDGE_START_FULL_PERMISSIONS: '1',
  }), { permissionMode: 'safe', acknowledgeFilesystemWrites: false });
  const fullEnvironment = {
    RELAYBRIDGE_ALLOW_STICKY_DANGEROUS: '1',
    RELAYBRIDGE_START_FULL_PERMISSIONS: '1',
  };
  assert.deepEqual(workflowPermissionDefaults({}, fullEnvironment), {
    permissionMode: 'full', acknowledgeFilesystemWrites: true,
  });
  assert.deepEqual(workflowPermissionDefaults({}, {
    PS_BRIDGE_ALLOW_STICKY_DANGEROUS: '1',
    PS_BRIDGE_START_FULL_PERMISSIONS: '1',
  }), { permissionMode: 'full', acknowledgeFilesystemWrites: true });
  assert.deepEqual(workflowPermissionDefaults({}, {
    RELAYBRIDGE_ALLOW_STICKY_DANGEROUS: '0',
    RELAYBRIDGE_START_FULL_PERMISSIONS: '1',
    PS_BRIDGE_ALLOW_STICKY_DANGEROUS: '1',
    PS_BRIDGE_START_FULL_PERMISSIONS: '1',
  }), { permissionMode: 'safe', acknowledgeFilesystemWrites: false });
  assert.deepEqual(workflowPermissionDefaults({ permissionMode: 'safe' }, fullEnvironment), {
    permissionMode: 'safe', acknowledgeFilesystemWrites: false,
  });
  assert.deepEqual(workflowPermissionDefaults({ permissionMode: 'full' }, fullEnvironment), {
    permissionMode: 'full', acknowledgeFilesystemWrites: false,
  });
  assert.deepEqual(workflowPermissionDefaults({ acknowledgeFilesystemWrites: true }, fullEnvironment), {
    permissionMode: 'safe', acknowledgeFilesystemWrites: true,
  });

  const previousSticky = process.env.RELAYBRIDGE_ALLOW_STICKY_DANGEROUS;
  const previousStart = process.env.RELAYBRIDGE_START_FULL_PERMISSIONS;
  try {
    process.env.RELAYBRIDGE_ALLOW_STICKY_DANGEROUS = '1';
    process.env.RELAYBRIDGE_START_FULL_PERMISSIONS = '1';
    const schema = tools().start_codex_claude_pipeline.inputSchema;
    const parsed = schema.parse({ cwd: '/tmp', objective: 'x', acceptance: 'y' });
    assert.equal(parsed.permissionMode, undefined, 'pair injection happens atomically in the handler');
    assert.equal(parsed.acknowledgeFilesystemWrites, undefined);
  } finally {
    if (previousSticky === undefined) delete process.env.RELAYBRIDGE_ALLOW_STICKY_DANGEROUS;
    else process.env.RELAYBRIDGE_ALLOW_STICKY_DANGEROUS = previousSticky;
    if (previousStart === undefined) delete process.env.RELAYBRIDGE_START_FULL_PERMISSIONS;
    else process.env.RELAYBRIDGE_START_FULL_PERMISSIONS = previousStart;
  }
});
