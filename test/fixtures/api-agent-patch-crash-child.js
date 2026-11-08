'use strict';

// Test-only child: journals one apply_patch intent for a writer checkpoint and
// SIGKILLs itself at the named patch failpoint. Never loaded by production code.
// argv: dataDir runId cwd failpoint

const path = require('node:path');
const crypto = require('node:crypto');
const lib = path.join(__dirname, '..', '..', 'lib');
const { createCheckpointStore } = require(path.join(lib, 'api-agent-checkpoint'));
const { createPatchWriter } = require(path.join(lib, 'api-agent-patch'));
const { digest } = require(path.join(lib, 'api-agent-wire'));

const [dataDir, runId, cwd, failpoint] = process.argv.slice(2);
const execution = { unifiedRunId: 'ur_' + 'a'.repeat(24), segment: 0, taskId: 't_crash', apiBindingHash: 'b'.repeat(64),
  toolsetHash: 'c'.repeat(64), writePathsHash: 'd'.repeat(64) };
const store = createCheckpointStore({ dataDir });
const handle = store.create(runId, { binding: {}, execution, initial: { state: {} } });
const input = { path: 'notes.txt', expectedSha256: crypto.createHash('sha256').update('one\ntwo\n').digest('hex'),
  edits: [{ oldText: 'two', newText: 'three' }] };
const call = { turn: 1, index: 0, callId: 'call_crash', argsDigest: digest(input) };
handle.writeTool({ ...call, name: 'apply_patch', state: 'intent', at: new Date().toISOString() });
const writer = createPatchWriter({ cwd, allowedWritePaths: ['notes.txt'], journal: handle, assertHeld: () => {},
  hooks: { at(name) { if (name === failpoint) process.kill(process.pid, 'SIGKILL'); } } });
try { writer.apply(call, input); } catch { process.exit(4); }
process.exit(3);
