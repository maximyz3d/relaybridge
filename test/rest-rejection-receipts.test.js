'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TEST_BUILD_ID = 'rest-rejection-receipts-test';

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, proc) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`test bridge exited ${proc.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('test bridge did not become healthy');
}

function dereferenceReceipt(dataDir, receiptId) {
  const moduleUrl = pathToFileURL(path.join(ROOT, 'mcp', 'receipts.mjs')).href;
  const script = [
    `import { readReceipt } from ${JSON.stringify(moduleUrl)};`,
    `process.stdout.write(JSON.stringify(readReceipt(${JSON.stringify(receiptId)})));`,
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: ROOT,
    env: { ...process.env, RELAYBRIDGE_DATA_DIR: dataDir },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function pathIdentity(value) {
  const normalized = path.resolve(String(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

let pathHashKey = null;
function pathHash(value, { raw = false } = {}) {
  assert.ok(pathHashKey, 'test capability must be loaded before path identities are checked');
  return crypto.createHmac('sha256', pathHashKey)
    .update(raw ? String(value) : pathIdentity(value)).digest('hex');
}

function existingPathIdentity(value) {
  const canonical = fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);
  return pathIdentity(canonical);
}

function containsPath(value, candidate) {
  const needle = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  if (typeof value === 'string') {
    const text = process.platform === 'win32' ? value.toLowerCase() : value;
    return text.includes(needle);
  }
  if (Array.isArray(value)) return value.some((item) => containsPath(item, candidate));
  if (value && typeof value === 'object') return Object.values(value).some((item) => containsPath(item, candidate));
  return false;
}

test('direct REST pre-admission failures persist deduplicated zero-invocation receipts', { timeout: 30000 }, async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relaybridge-rest-rejections-'));
  const dataDir = path.join(tempRoot, 'data');
  const tokenPath = path.join(tempRoot, 'bridge.token');
  const configPath = path.join(tempRoot, 'config.json');
  const invocationMarker = path.join(tempRoot, 'provider-invocations.txt');
  const cwdInvocationMarker = path.join(tempRoot, 'cwd-provider-invocations.txt');
  const allowedRoots = Array.from({ length: 34 }, (_, index) => path.join(tempRoot, `allowed-${index}`));
  const [allowedRootA, allowedRootB] = allowedRoots;
  const outsideRoot = path.join(tempRoot, 'outside');
  const symlinkOutside = path.join(allowedRootA, 'outside-link');
  allowedRoots.forEach((root) => fs.mkdirSync(root, { recursive: true }));
  fs.mkdirSync(outsideRoot, { recursive: true });
  fs.symlinkSync(outsideRoot, symlinkOutside, process.platform === 'win32' ? 'junction' : 'dir');
  const helper = path.join(ROOT, 'test', 'prompt-file-cli.js');
  const baseSlot = [process.execPath, helper, '--prompt-file', '{prompt_file}', '--invocation-marker', invocationMarker];
  const probe = [process.execPath, helper, '--version'];
  const provider = (label, slot = baseSlot, extra = {}) => ({
    label,
    safe: probe,
    dangerous: probe,
    oneshot_safe: slot,
    oneshot_dangerous: slot,
    diagnostic_binary: process.execPath,
    probe,
    ...extra,
  });

  fs.writeFileSync(configPath, JSON.stringify({
    guarded: provider('Guarded', [...baseSlot, '--delay', '10000']),
    cwd_guarded: provider('Cwd guarded', [
      process.execPath, '-e',
      "require('node:fs').appendFileSync(process.argv[1], process.cwd() + '\\n'); process.stdout.write(process.cwd())",
      cwdInvocationMarker,
    ]),
    bad_env: provider('Bad environment', baseSlot, { oneshot_env: ['invalid'] }),
    no_slot: provider('No one-shot slot', null, { oneshot_safe: [], oneshot_dangerous: [] }),
    mixed_transport: provider('Mixed transport', [process.execPath, helper, '--prompt-file', '{prompt_file}', '--output', '{prompt}']),
    signed_out: provider('Signed out', baseSlot, {
      probe: [process.execPath, '-e', 'process.exit(1)'],
      login_command: [process.execPath, '-e', 'process.exit(0)'],
    }),
  }), 'utf8');

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      RELAYBRIDGE_TEST_BUILD_ID: TEST_BUILD_ID,
      PORT: String(port),
      PTY_MODE: 'none',
      RELAYBRIDGE_CONFIG_FILE: configPath,
      RELAYBRIDGE_TOKEN_FILE: tokenPath,
      RELAYBRIDGE_DATA_DIR: dataDir,
      RELAYBRIDGE_MAX_ACTIVE_ONESHOTS: '4',
      RELAYBRIDGE_MAX_ACTIVE_PER_PROVIDER: '1',
      RELAYBRIDGE_ALLOWED_ROOTS: allowedRoots.join(';'),
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  proc.stdout.on('data', (chunk) => { serverOutput += chunk; });
  proc.stderr.on('data', (chunk) => { serverOutput += chunk; });
  t.after(async () => {
    if (proc.exitCode === null) proc.kill('SIGTERM');
    await new Promise((resolve) => proc.exitCode !== null ? resolve() : proc.once('exit', resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  let health;
  try { health = await waitForHealth(baseUrl, proc); }
  catch (error) { throw new Error(`${error.message}\n${serverOutput}`); }
  const capability = await (await fetch(`${baseUrl}/api/capability`)).json();
  pathHashKey = capability.token;
  const headers = {
    'Content-Type': 'application/json',
    'X-RelayBridge-Token': capability.token,
  };

  const assertRejected = async ({ body, status, failureClass }) => {
    const response = await fetch(`${baseUrl}/api/oneshot`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(response.status, status);
    const payload = await response.json();
    assert.equal(payload.failureClass, failureClass);
    assert.equal(payload.model_invocation, false);
    assert.equal(payload.token_usage_source, 'not_invoked');
    assert.equal(payload.transportReceiptId, null);
    assert.equal(payload.transport_retry_count, 0);
    assert.equal(payload.provider_retries.count, 0);
    assert.equal(payload.receiptPersisted, true);
    assert.match(payload.receiptId, /^rcpt_/);
    assert.equal(payload.requestId, body.requestId);
    assert.equal(response.headers.get('x-relaybridge-receipt-id'), payload.receiptId);
    assert.equal(response.headers.get('x-relaybridge-request-id'), body.requestId);
    assert.equal(response.headers.get('x-relaybridge-build-id'), health.buildId);
    assert.equal(response.headers.get('x-relaybridge-receipt-store-id'), health.receiptStoreId);

    const receipt = dereferenceReceipt(dataDir, payload.receiptId);
    assert.equal(receipt.receiptId, payload.receiptId);
    assert.equal(receipt.event, 'bridge_provider_rejection');
    assert.equal(receipt.status, 'rejected');
    assert.equal(receipt.failureClass, failureClass);
    assert.equal(receipt.modelInvocation, false);
    assert.equal(receipt.tokenUsageSource, 'not_invoked');
    assert.equal(receipt.transportReceiptId, null);
    assert.equal(receipt.physicalAttemptCount, 0);
    assert.equal(receipt.transportRetryCount, 0);
    assert.equal(receipt.providerRetryCount, 0);
    assert.equal(receipt.requestId, body.requestId);
    assert.equal(receipt.invocationId, body.requestId);
    assert.equal(receipt.attemptId, body.requestId);
    assert.equal(receipt.bridgeBuildId, health.buildId);
    assert.equal(receipt.receiptStoreId, health.receiptStoreId);
    assert.ok(Number.isInteger(receipt.durationMs) && receipt.durationMs >= 0);
    assert.match(receipt._cursor, /^[A-Za-z0-9_-]+$/);
    return { response, payload, receipt };
  };

  const assertCwdRejected = async (cwd, requestId, { canonical = null } = {}) => {
    const rejected = await assertRejected({
      body: { kind: 'cwd_guarded', prompt: 'cwd must not start', cwd, requestId },
      status: 400,
      failureClass: 'validation',
    });
    const expected = {
      code: 'cwd_outside_allowed_roots',
      field: 'cwd',
      reason: 'The requested working directory resolves outside RelayBridge allowed roots.',
      retryable: false,
      requestedRootHash: pathHash(cwd, { raw: true }),
      normalizedRootHash: pathHash(path.resolve(cwd)),
      canonicalRootHash: canonical ? pathHash(existingPathIdentity(canonical)) : null,
      allowedRootHashes: allowedRoots.slice(0, 32).map((root) => pathHash(existingPathIdentity(root))),
      allowedRootHashCount: 34,
      allowedRootHashesTruncated: true,
      guidance: 'Use an existing allowed working directory, or explicitly add the intended root to RELAYBRIDGE_ALLOWED_ROOTS and restart RelayBridge. RelayBridge did not change the allowlist.',
      allowlistChanged: false,
      restartRequiredForEnrollment: true,
    };
    assert.equal(rejected.payload.errorCode, expected.code);
    assert.deepEqual(rejected.payload.validation, expected);
    assert.equal(rejected.receipt.errorCode, expected.code);
    assert.deepEqual(rejected.receipt.validation, expected);
    if (String(cwd) !== path.resolve(cwd)) {
      assert.notEqual(expected.requestedRootHash, expected.normalizedRootHash, 'raw traversal identity must remain distinguishable from its normalized identity');
    }
    if (canonical) {
      assert.notEqual(expected.canonicalRootHash, expected.normalizedRootHash, 'symlink target identity must remain distinguishable from its lexical path');
    }
    for (const secretPath of [cwd, path.resolve(cwd), ...allowedRoots, outsideRoot]) {
      assert.equal(containsPath(rejected.payload, secretPath), false);
      assert.equal(containsPath(rejected.receipt, secretPath), false);
    }
    assert.equal(fs.existsSync(cwdInvocationMarker), false, 'cwd rejection must not start a provider process');
    assert.notEqual(
      rejected.payload.validation.requestedRootHash,
      crypto.createHash('sha256').update(String(cwd)).digest('hex'),
      'path identities must not be predictable unsalted path digests',
    );
    return rejected;
  };

  const firstOutside = await assertCwdRejected(outsideRoot, 'request:validation:cwd-outside');
  const secondOutside = path.join(tempRoot, 'outside-second');
  fs.mkdirSync(secondOutside, { recursive: true });
  const reusedRequest = await assertCwdRejected(secondOutside, 'request:validation:cwd-outside');
  assert.notEqual(reusedRequest.payload.receiptId, firstOutside.payload.receiptId);
  assert.notEqual(
    reusedRequest.receipt.rejectionFingerprint,
    firstOutside.receipt.rejectionFingerprint,
    'requestId reuse across distinct cwd policy decisions must not alias receipts',
  );
  await assertCwdRejected(
    `${allowedRootA}${path.sep}child${path.sep}..${path.sep}..${path.sep}outside`,
    'request:validation:cwd-traversal',
  );
  await assertCwdRejected(symlinkOutside, 'request:validation:cwd-symlink', { canonical: outsideRoot });

  await assertRejected({
    body: { kind: 'unknown', prompt: 'must not start', requestId: 'request:validation:unknown' },
    status: 400,
    failureClass: 'validation',
  });
  await assertRejected({
    body: { kind: 'bad_env', prompt: 'must not start', requestId: 'request:configuration:env' },
    status: 500,
    failureClass: 'configuration',
  });
  await assertRejected({
    body: { kind: 'no_slot', prompt: 'must not start', requestId: 'request:configuration:slot' },
    status: 400,
    failureClass: 'configuration',
  });
  await assertRejected({
    body: { kind: 'mixed_transport', prompt: 'must not start', requestId: 'request:configuration:mixed' },
    status: 400,
    failureClass: 'configuration',
  });
  assert.equal(fs.existsSync(invocationMarker), false, 'validation/config rejections must not start a provider process');

  const diag = await fetch(`${baseUrl}/api/diag`, { headers });
  assert.equal(diag.status, 200);
  await assertRejected({
    body: { kind: 'signed_out', prompt: 'must not start', requestId: 'request:auth:signed-out' },
    status: 409,
    failureClass: 'auth',
  });
  assert.equal(fs.existsSync(invocationMarker), false, 'signed-out auth rejection must not start a provider process');

  const allowedSecondRoot = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({
      kind: 'cwd_guarded', prompt: 'allowed second root', cwd: allowedRootB,
      requestId: 'request:allowed:second-root',
    }),
  });
  assert.equal(allowedSecondRoot.status, 200);
  assert.equal(path.resolve((await allowedSecondRoot.json()).stdout), path.resolve(allowedRootB));
  const allowedNoncanonical = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({
      kind: 'cwd_guarded', prompt: 'allowed normalized root',
      cwd: `${allowedRootB}${path.sep}nested${path.sep}..`, requestId: 'request:allowed:normalized-root',
    }),
  });
  assert.equal(allowedNoncanonical.status, 200);
  assert.equal(path.resolve((await allowedNoncanonical.json()).stdout), path.resolve(allowedRootB));
  assert.deepEqual(
    fs.readFileSync(cwdInvocationMarker, 'utf8').trim().split(/\r?\n/).map((value) => path.resolve(value)),
    [path.resolve(allowedRootB), path.resolve(allowedRootB)],
  );

  const firstController = new AbortController();
  const first = fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'guarded', prompt: 'first admitted provider', requestId: 'request:admitted:first' }),
    signal: firstController.signal,
  });
  const markerDeadline = Date.now() + 5000;
  while (Date.now() < markerDeadline && !fs.existsSync(invocationMarker)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(fs.readFileSync(invocationMarker, 'utf8').trim(), 'first admitted provider');

  const admissionBody = {
    kind: 'guarded',
    prompt: 'rejected provider must never start',
    requestId: 'request:admission:duplicate',
  };
  const firstRejection = await assertRejected({ body: admissionBody, status: 429, failureClass: 'admission_limit' });
  assert.equal(firstRejection.payload.receiptDeduplicated, false);
  const duplicateRejection = await assertRejected({ body: admissionBody, status: 429, failureClass: 'admission_limit' });
  assert.equal(duplicateRejection.payload.receiptDeduplicated, true);
  assert.equal(duplicateRejection.payload.receiptId, firstRejection.payload.receiptId);
  assert.equal(fs.readFileSync(invocationMarker, 'utf8').trim(), 'first admitted provider', 'admission rejection must not spawn a second provider');

  const receiptFile = path.join(dataDir, 'receipts', `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const rows = fs.readFileSync(receiptFile, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(rows.filter((row) => row.requestId === admissionBody.requestId).length, 1, 'one requestId persists exactly one rejection receipt');

  firstController.abort();
  await first.catch(() => {});

  const pinnedRoot = allowedRoots.at(-1);
  const cwdCountBeforeRetarget = fs.readFileSync(cwdInvocationMarker, 'utf8').trim().split(/\r?\n/).length;
  fs.rmSync(pinnedRoot, { recursive: true, force: true });
  fs.symlinkSync(outsideRoot, pinnedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const retargeted = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({
      kind: 'cwd_guarded', prompt: 'retargeted root must not start', cwd: pinnedRoot,
      requestId: 'request:validation:root-retargeted',
    }),
  });
  assert.equal(retargeted.status, 400);
  const retargetedPayload = await retargeted.json();
  assert.equal(retargetedPayload.errorCode, 'cwd_outside_allowed_roots');
  assert.equal(retargetedPayload.model_invocation, false);
  assert.equal(containsPath(retargetedPayload, pinnedRoot), false);
  assert.equal(containsPath(retargetedPayload, outsideRoot), false);

  fs.rmSync(pinnedRoot, { recursive: true, force: true });
  fs.mkdirSync(pinnedRoot, { recursive: true });
  const recreated = await fetch(`${baseUrl}/api/oneshot`, {
    method: 'POST', headers,
    body: JSON.stringify({
      kind: 'cwd_guarded', prompt: 'recreated root must await restart', cwd: pinnedRoot,
      requestId: 'request:validation:root-recreated',
    }),
  });
  assert.equal(recreated.status, 400);
  const recreatedPayload = await recreated.json();
  assert.equal(recreatedPayload.errorCode, 'cwd_outside_allowed_roots');
  assert.equal(recreatedPayload.model_invocation, false);
  assert.equal(
    fs.readFileSync(cwdInvocationMarker, 'utf8').trim().split(/\r?\n/).length,
    cwdCountBeforeRetarget,
    'retargeted and recreated startup trust roots must never spawn a child',
  );
});
