'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  parseFlags,
  resolveTaskInput,
  USAGE,
} = require('../bin/relaybridge.js');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'relaybridge.js');

test('stdin is a boolean flag and leaves positional text available for conflict validation', () => {
  const parsed = parseFlags(['ask', '--stdin', 'unexpected positional text']);
  assert.equal(parsed.flags.stdin, true);
  assert.deepEqual(parsed.rest, ['ask', 'unexpected positional text']);
});

test('prompt sources are mutually exclusive', () => {
  assert.throws(
    () => resolveTaskInput({ stdin: true }, ['also positional'], {
      readStdin: () => Buffer.from('stdin'),
    }),
    /choose exactly one prompt source/,
  );
  assert.throws(
    () => resolveTaskInput({ stdin: true, 'prompt-file': 'prompt.txt' }, [], {
      readStdin: () => Buffer.from('stdin'),
    }),
    /choose exactly one prompt source/,
  );
});

test('stdin preserves a Unicode payload larger than the Windows command-line limit', () => {
  const prompt = `review 🚗 café 漢字\r\n${'diff-line +value -old\n'.repeat(5000)}`;
  const resolved = resolveTaskInput({ stdin: true }, [], {
    readStdin: () => Buffer.from(prompt, 'utf8'),
  });
  assert.ok(Buffer.byteLength(resolved, 'utf8') > 32767);
  assert.equal(resolved, prompt);
});

test('prompt-file reads UTF-8 exactly and rejects empty or invalid input', () => {
  const prompt = 'first line\r\nemoji: 🧪\nlast line\n';
  assert.equal(
    resolveTaskInput({ 'prompt-file': 'prompt.txt' }, [], {
      readFile: () => Buffer.from(prompt, 'utf8'),
    }),
    prompt,
  );
  assert.throws(
    () => resolveTaskInput({ 'prompt-file': 'empty.txt' }, [], {
      readFile: () => Buffer.from(' \r\n\t', 'utf8'),
    }),
    /prompt file is empty/,
  );
  assert.throws(
    () => resolveTaskInput({ 'prompt-file': 'invalid.txt' }, [], {
      readFile: () => Buffer.from([0xc3, 0x28]),
    }),
    /prompt file is not valid UTF-8/,
  );
});

test('missing prompt-file values and valued stdin flags fail clearly', () => {
  assert.throws(() => resolveTaskInput({ 'prompt-file': true }, []), /requires a path/);
  assert.throws(() => resolveTaskInput({ 'prompt-file': '' }, []), /requires a path/);
  assert.throws(() => resolveTaskInput({ stdin: 'yes' }, []), /does not accept a value/);
});

test('inline prompt-file paths preserve equals signs', () => {
  const parsed = parseFlags(['plan', '--prompt-file=C:\\review=a.txt']);
  assert.equal(parsed.flags['prompt-file'], 'C:\\review=a.txt');
});

test('usage documents stdin and prompt-file for both planning and asking', () => {
  assert.match(USAGE, /relaybridge plan --stdin/);
  assert.match(USAGE, /relaybridge ask --prompt-file/);
  assert.match(USAGE, /choose exactly one/);
});

test('ask transports a long stdin prompt in request bodies, never argv', async (t) => {
  const requests = [];
  const server = await startBridgeStub(t, requests);
  const prompt = `review this Windows-sized diff 🛠️\n${'+ const value = 123;\n'.repeat(5000)}`;
  const result = await runCli(
    ['ask', '--kind', 'fake', '--stdin', '--json'],
    prompt,
    server.port,
  );

  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, '/api/plan');
  assert.equal(requests[0].body.task, prompt);
  assert.equal(requests[1].url, '/api/oneshot');
  assert.equal(requests[1].body.prompt, prompt);
  assert.ok(Buffer.byteLength(prompt, 'utf8') > 32767);
  assert.ok(!result.spawnArgs.some((arg) => arg.includes('const value')));
});

test('plan reads a long Unicode prompt file without placing its body in argv', async (t) => {
  const requests = [];
  const server = await startBridgeStub(t, requests);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-cli-prompt-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const promptFile = path.join(directory, 'review prompt.txt');
  const prompt = `architecture review λ 🚙\n${'context-line\n'.repeat(4000)}`;
  fs.writeFileSync(promptFile, prompt, 'utf8');

  const result = await runCli(['plan', '--prompt-file', promptFile, '--json'], '', server.port);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/plan');
  assert.equal(requests[0].body.task, prompt);
  assert.ok(!result.spawnArgs.some((arg) => arg.includes('architecture review')));
});

test('empty and conflicting CLI input fails before any bridge request', async (t) => {
  const requests = [];
  const server = await startBridgeStub(t, requests);

  const empty = await runCli(['ask', '--stdin'], ' \r\n\t', server.port);
  assert.equal(empty.code, 2);
  assert.match(empty.stderr, /stdin prompt is empty/);
  assert.equal(requests.length, 0);

  const conflict = await runCli(['plan', '--stdin', 'positional'], 'secret body', server.port);
  assert.equal(conflict.code, 2);
  assert.match(conflict.stderr, /choose exactly one prompt source/);
  assert.doesNotMatch(conflict.stderr, /secret body/);
  assert.equal(requests.length, 0);
});

async function startBridgeStub(t, requests) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    requests.push({ url: req.url, body: text ? JSON.parse(text) : {} });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/plan') {
      res.end(JSON.stringify({
        tier: 'standard', effort: 'medium', confidence: 1, humanGate: false,
        primary: {
          kind: 'fake', company: 'Fake', label: 'Fake Provider', model: null,
          modelTier: 'standard', costNote: 'test', args: [],
        },
        alternates: [], guidance: [],
      }));
      return;
    }
    if (req.url === '/api/oneshot') {
      res.end(JSON.stringify({ exitCode: 0, dropped_out: false, stdout: 'ok' }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port };
}

function runCli(args, input, port) {
  const spawnArgs = [CLI, ...args];
  const child = spawn(process.execPath, spawnArgs, {
    cwd: ROOT,
    env: {
      ...process.env,
      RELAYBRIDGE_URL: `http://127.0.0.1:${port}`,
      RELAYBRIDGE_TOKEN: 'test-token-not-a-secret',
    },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(input, 'utf8');
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr, spawnArgs }));
  });
}
