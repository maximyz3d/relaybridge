'use strict';

// Test-only child: drives one API agent run against a loopback fake and
// SIGKILLs itself at the named failpoint. Never loaded by production code.
// argv: dataDir runId provider port failpoint cwd qualificationActive('1'|'0')

const path = require('node:path');
const lib = path.join(__dirname, '..', '..', 'lib');
const { createCheckpointStore } = require(path.join(lib, 'api-agent-checkpoint'));
const { driveApiAgentRun } = require(path.join(lib, 'api-agent-run'));
const { ENDPOINTS, WIRES, resolveApiModel } = require(path.join(lib, 'api-agent-wire'));
const { createReadOnlyTools } = require(path.join(lib, 'api-agent-tools'));

const [dataDir, runId, provider, port, failpoint, cwd, qualification] = process.argv.slice(2);
const model = provider === 'claude' ? resolveApiModel('claude', 'claude-opus-5-5', 'medium') : resolveApiModel('openai', 'gpt-6.1-sol', 'low');
const store = createCheckpointStore({ dataDir });
const handle = store.create(runId, { binding: {}, initial: { state: WIRES[provider].initialState({ prompt: 'crash test' }) } });
const fetchImpl = (url, init) => {
  if (url !== ENDPOINTS[provider]) throw new Error('unexpected endpoint');
  return fetch(`http://127.0.0.1:${port}/`, init);
};

driveApiAgentRun({ handle, provider, model, tools: createReadOnlyTools({ cwd }), fetchImpl, endpoint: ENDPOINTS[provider],
  credential: 'sk-crash-child-credential', qualificationActive: qualification === '1', hooks: { at(name) { if (name === failpoint) process.kill(process.pid, 'SIGKILL'); } } })
  .then(() => process.exit(3), () => process.exit(4));
