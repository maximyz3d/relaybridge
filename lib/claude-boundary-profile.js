'use strict';
// Trusted host construction only. This module never invokes Claude or reads credentials.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ADAPTER = 'claude_linux_2_1_258_candidate_v1';
const EXECUTABLE = path.join(os.homedir(), '.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
const MAX_HASH_BYTES = 256 * 1024 * 1024;
const EXEC_DEST = '/runtime/bin/claude';
const BROKER_POLICY = 'claude_subscription_candidate_v1';
const holders = new WeakMap();
const fail = code => Object.assign(new Error(code), { code, model_invocation: false });
const hash = file => {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), digest = crypto.createHash('sha256');
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_HASH_BYTES) || (before.nlink !== 1n && file !== EXECUTABLE) || (before.mode & 0o7022n) !== 0n || ![0n, BigInt(process.getuid())].includes(before.uid)) throw fail('CLAUDE_PROFILE_FILE_UNTRUSTED');
    const buffer = Buffer.alloc(1048576); let n, total = 0;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) {
      total += n; if (total > MAX_HASH_BYTES) throw fail('CLAUDE_PROFILE_HASH_LIMIT');
      digest.update(buffer.subarray(0, n));
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || before.size !== after.size) throw fail('CLAUDE_PROFILE_FILE_CHANGED');
    return digest.digest('hex');
  } finally { fs.closeSync(fd); }
};
function runtimeFiles() {
  return [process.execPath, '/usr/bin/bwrap', EXECUTABLE,
    ...['linux-filesystem-boundary', 'connect-broker', 'public-address', 'namespace-forwarder', 'linux-physical-owner', 'linux-owner-identity', 'owner-control', 'claude-boundary-profile'].map(name => path.join(__dirname, name + '.js')),
    ...['pid1-gate', 'boundary-pid1-entry'].map(name => path.join(__dirname, '../tools', name + '.js'))];
}
function dependencies(file) {
  // Only fixed, trusted host runtimes are inspected; never a task-supplied binary.
  const result = spawnSync('ldd', [file], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, maxBuffer: 65536, timeout: 3000 });
  if (result.status !== 0 || /not found/.test(result.stdout)) throw fail('CLAUDE_PROFILE_DEPENDENCY_UNSUPPORTED');
  return result.stdout.split('\n').flatMap(line => {
    const target = /=>\s+(\/\S+)/.exec(line)?.[1] || /^\s*(\/\S+)/.exec(line)?.[1];
    return target ? [{ path: fs.realpathSync(target), destination: target }] : [];
  });
}
function createClaudeRuntimeManifest() {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw fail('CLAUDE_PROFILE_PLATFORM_UNSUPPORTED');
  const packageFile = path.resolve(EXECUTABLE, '../../package.json');
  if (fs.statSync(packageFile).size > 65536) throw fail('CLAUDE_PROFILE_PACKAGE_LIMIT');
  if (JSON.parse(fs.readFileSync(packageFile, 'utf8')).version !== '2.1.258') throw fail('CLAUDE_PROFILE_VERSION_UNSUPPORTED');
  const fd = fs.openSync(EXECUTABLE, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { const bytes = Buffer.alloc(20); if (fs.readSync(fd, bytes, 0, 20, 0) !== 20 || bytes.subarray(0, 4).toString('hex') !== '7f454c46' || bytes[4] !== 2 || bytes.readUInt16LE(18) !== 62) throw fail('CLAUDE_PROFILE_BINARY_UNSUPPORTED'); }
  finally { fs.closeSync(fd); }
  const files = [...dependencies(process.execPath), ...dependencies(EXECUTABLE),
    { path: EXECUTABLE, destination: EXEC_DEST },
    { path: fs.realpathSync('/etc/ssl/certs/ca-certificates.crt'), destination: '/etc/ssl/certs/ca-certificates.crt' }];
  const readonlyFiles = [...new Map(files.map(item => [item.destination, item])).values()];
  const hashes = [...new Set([...runtimeFiles(), ...readonlyFiles.map(item => item.path)].map(file => fs.realpathSync(file)))].sort().map(file => ({ path: file, sha256: hash(file) }));
  return { version: 1, adapterId: ADAPTER, binaryVersion: '2.1.258', brokerPolicy: BROKER_POLICY,
    nativeQualified: false, qualificationScope: 'read_write_edit_only_no_shell', readonlyFiles, hashes };
}
function canonical(value) {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
function same(a, b) { return canonical(a) === canonical(b); }
function issueClaudeProfile({ profile, manifest } = {}) {
  // Reconstruct all fixed fields and rehash at issuance. Serialized manifests are
  // review evidence, not a capability and not a claim of native qualification.
  const actual = createClaudeRuntimeManifest();
  if (!same(actual, manifest) || profile.adapterId !== ADAPTER
    || !same(profile.readonlyFiles.map(x => ({ path: x.source.path, destination: x.destination })), actual.readonlyFiles)) throw fail('CLAUDE_PROFILE_MANIFEST_MISMATCH');
  const token = Object.freeze({ adapterId: ADAPTER });
  const record = { profile: JSON.parse(JSON.stringify(profile)), manifest: actual };
  holders.set(token, record); return token;
}
function assertClaudeProfile(token, profile) {
  const record = holders.get(token);
  if (!record || !same(record.profile, profile)) throw fail('CLAUDE_PROFILE_CAPABILITY_INVALID');
  for (const item of record.manifest.hashes) if (hash(item.path) !== item.sha256) throw fail('CLAUDE_PROFILE_RUNTIME_CHANGED');
  return record;
}
function claudeLaunch(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0') || Buffer.byteLength(prompt) > 32768) throw fail('CLAUDE_PROFILE_PROMPT_INVALID');
  return { file: EXEC_DEST, args: ['--print', '--safe-mode', '--output-format', 'json', '--no-session-persistence',
    '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'Read,Write,Edit',
    '--allowedTools', 'Read,Write,Edit', '--disallowedTools', 'mcp__*', '--permission-mode', 'dontAsk',
    '--disable-slash-commands', '--no-chrome', '--max-turns', '4', '--', prompt] };
}
const ENVIRONMENT = Object.freeze({ CLAUDE_CODE_PROXY_RESOLVES_HOSTS: '1',
  DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1024', CLAUDE_CODE_MAX_RETRIES: '0', SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt' });
module.exports = { ADAPTER, EXECUTABLE, BROKER_POLICY, ENVIRONMENT, createClaudeRuntimeManifest, issueClaudeProfile, assertClaudeProfile, claudeLaunch };
