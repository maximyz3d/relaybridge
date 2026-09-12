#!/usr/bin/env node
'use strict';
// Explicit operator entry point. --manifest-only never reads credentials or
// invokes Claude. --run-once creates ONE bounded native CLI session, potentially
// several read/write tool turns. Never call this automatically during startup.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { createClaudeBoundaryProfile, createClaudeBoundaryOwner } = require('../lib/linux-filesystem-boundary');
const { createConnectBroker } = require('../lib/connect-broker');
const { ADAPTER, BROKER_POLICY, createClaudeRuntimeManifest, issueClaudeProfile } = require('../lib/claude-boundary-profile');
const fail = code => Object.assign(new Error(code), { code });
function readPrivate(file, credential) {
  if (fs.realpathSync(file) !== file) throw fail('CLAUDE_CREDENTIAL_SOURCE_UNTRUSTED');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid()) || before.size > 1048576n
      || (before.mode & (credential ? 0o7177n : 0o7022n)) !== 0n) throw fail('CLAUDE_CREDENTIAL_SOURCE_UNTRUSTED');
    const value = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    if (before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || before.size !== after.size) throw fail('CLAUDE_CREDENTIAL_SOURCE_CHANGED');
    return value;
  } finally { fs.closeSync(fd); }
}
function profileAt(root, manifest) {
  const names = ['source', 'evidence', 'workspace', 'home', 'cache', 'tmp', 'broker'];
  for (const name of names) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  const profile = createClaudeBoundaryProfile({
    runId: 'run_claude_boundary_' + crypto.randomBytes(12).toString('hex'),
    sourceRoot: path.join(root, 'source'), evidenceRoot: path.join(root, 'evidence'),
    ...Object.fromEntries(['workspace', 'home', 'cache', 'tmp'].map(name => [name, path.join(root, name)])), manifest,
  });
  return profile;
}
function copyPrivateAuth(profile, credentialSource, configSource) {
  // Only this explicit operator-run function reads auth. No host file is changed;
  // refresh/profile writes, if any, can affect only these ephemeral private copies.
  const credentials = readPrivate(credentialSource, true);
  const credentialDir = path.join(profile.home.path, '.claude'); fs.mkdirSync(credentialDir, { mode: 0o700 });
  try { fs.writeFileSync(path.join(credentialDir, '.credentials.json'), credentials, { flag: 'wx', mode: 0o600 }); }
  finally { credentials.fill(0); }
  const config = { hasCompletedOnboarding: true };
  if (fs.existsSync(configSource)) {
    const bytes = readPrivate(configSource, false);
    try {
      const original = JSON.parse(bytes.toString('utf8'));
      // Do not copy projects, hooks, MCP, environment, history, plugins, or settings.
      if (original.oauthAccount && typeof original.oauthAccount === 'object' && !Array.isArray(original.oauthAccount)) config.oauthAccount = original.oauthAccount;
    } finally { bytes.fill(0); }
  }
  fs.writeFileSync(path.join(profile.home.path, '.claude.json'), JSON.stringify(config), { flag: 'wx', mode: 0o600 });
}
const sleep = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref(); });
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--manifest-only', '--run-once'].includes(args[0])) throw fail('CLAUDE_QUALIFICATION_USAGE');
  const manifest = createClaudeRuntimeManifest();
  if (args[0] === '--manifest-only') { process.stdout.write(JSON.stringify(manifest, null, 2) + '\n'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-claude-boundary-')); fs.chmodSync(root, 0o700);
  let owner, broker, physical = null, released = false, timer = null, keepAlive = null;
  const report = { version: 1, adapterId: ADAPTER, nativeQualified: false, fixtureAttempted: false,
    manifestHash: crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), capturedAt: new Date().toISOString() };
  try {
    const profile = profileAt(root, manifest), marker = 'relaybridge-boundary-' + crypto.randomBytes(12).toString('hex');
    fs.writeFileSync(path.join(profile.sourceRoot.path, 'input.txt'), marker, { mode: 0o600 });
    fs.writeFileSync(path.join(profile.workspace.path, 'input.txt'), marker, { mode: 0o600 });
    fs.writeFileSync(path.join(profile.evidenceRoot.path, 'private-marker'), 'host evidence', { mode: 0o600 });
    copyPrivateAuth(profile, path.join(os.homedir(), '.claude/.credentials.json'), path.join(os.homedir(), '.claude.json'));
    const nativeToken = issueClaudeProfile({ profile, manifest });
    broker = await createConnectBroker({ directory: path.join(root, 'broker'), policyId: BROKER_POLICY });
    const prompt = 'Read /work/input.txt. Use the Write tool to create /work/result.txt containing exactly the same text, with no newline. Do not change any other workspace file. Reply only DONE.';
    owner = createClaudeBoundaryOwner({ profile, nativeToken, prompt, broker });
    keepAlive = setInterval(() => {}, 1000);
    timer = setTimeout(() => owner.requestStop(), 120000);
    const proc = await owner.start(); let stdoutBytes = 0, stderrBytes = 0, stdout = '';
    if (proc) {
      proc.stdout.on('data', chunk => { stdoutBytes += chunk.length; if (stdoutBytes <= 1048576) stdout += chunk; else owner.requestStop(); });
      proc.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 65536) owner.requestStop(); });
      proc.stdin.end();
    }
    await owner.ready; released = await owner.allowProvider(); report.fixtureAttempted = released;
    physical = await Promise.race([owner.physicalDone, sleep(135000).then(() => null)]);
    const snapshot = owner.snapshot();
    let terminalSuccess = false;
    try { const result = JSON.parse(stdout); terminalSuccess = result.type === 'result' && result.is_error === false; } catch {}
    stdout = '';
    report.physicalSettled = physical?.evidence === 'process_tree_settled';
    report.nativeExit = snapshot.rootExit; report.stdoutBytes = stdoutBytes; report.stderrBytes = stderrBytes;
    report.terminalSuccess = terminalSuccess;
    report.stagedWriteExact = fs.existsSync(path.join(profile.workspace.path, 'result.txt'))
      && fs.readFileSync(path.join(profile.workspace.path, 'result.txt'), 'utf8') === marker;
    report.workspaceOnlyExpectedFiles = fs.readdirSync(profile.workspace.path).sort().join('|') === 'input.txt|result.txt';
    report.sourceUnchanged = fs.readdirSync(profile.sourceRoot.path).join('|') === 'input.txt'
      && fs.readFileSync(path.join(profile.sourceRoot.path, 'input.txt'), 'utf8') === marker;
    report.evidenceUnchanged = fs.readdirSync(profile.evidenceRoot.path).join('|') === 'private-marker'
      && fs.readFileSync(path.join(profile.evidenceRoot.path, 'private-marker'), 'utf8') === 'host evidence';
    report.transport = broker.snapshot();
    report.fixturePassed = report.physicalSettled && released && snapshot.rootExit?.code === 0 && terminalSuccess
      && report.stagedWriteExact && report.workspaceOnlyExpectedFiles && report.sourceUnchanged && report.evidenceUnchanged && report.transport.accepted > 0;
  } catch (failure) { report.failureCode = /^[A-Z_]{1,80}$/.test(failure.code || '') ? failure.code : 'CLAUDE_QUALIFICATION_FAILED'; report.fixturePassed = false; }
  finally {
    clearTimeout(timer); owner?.requestStop(); await broker?.close();
    if (owner && !physical) physical = await Promise.race([owner.physicalDone, sleep(15000).then(() => null)]);
    clearInterval(keepAlive);
    if (!owner || physical) fs.rmSync(root, { recursive: true, force: true });
    else { report.quarantined = true; report.privateArtifactRoot = root; }
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (!report.fixturePassed) process.exitCode = 1;
}
if (require.main === module) main().catch(failure => {
  const code = /^[A-Z_]{1,80}$/.test(failure.code || '') ? failure.code : 'CLAUDE_QUALIFICATION_FAILED';
  process.stderr.write(JSON.stringify({ code, nativeQualified: false }) + '\n'); process.exitCode = 1;
});
module.exports = { profileAt, copyPrivateAuth };
