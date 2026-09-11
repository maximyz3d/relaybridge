'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createLinuxPhysicalOwner } = require('./linux-physical-owner');
const { assertConnectBroker } = require('./connect-broker');
const native = require('./claude-boundary-profile');

const POLICY = 'linux-minimal-connect-boundary-v1';
const FIXED = Object.freeze({ node: '/relaybridge/node', gate: '/relaybridge/tools/pid1-gate.js',
  entry: '/relaybridge/tools/boundary-pid1-entry.js', control: '/relaybridge/lib/owner-control.js',
  forwarder: '/relaybridge/lib/namespace-forwarder.js', ownerSocket: '/relaybridge/owner.sock', proxySocket: '/relaybridge/proxy.sock' });
const ROOTS = Object.freeze({ workspace: '/work', home: '/home/agent', cache: '/cache', tmp: '/tmp' });
const error = code => Object.assign(new Error(code), { code, model_invocation: false });
const canonical = x => x === null || typeof x !== 'object' ? JSON.stringify(x)
  : Array.isArray(x) ? '[' + x.map(canonical).join(',') + ']'
    : '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}';
const digest = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const clone = value => JSON.parse(canonical(value));
function closed(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== [...fields].sort().join('|')) throw error('BOUNDARY_SCHEMA_INVALID');
}
function absolute(value) {
  return typeof value === 'string' && value !== '/' && value.length <= 4096 && value.startsWith('/')
    && path.normalize(value) === value && !value.endsWith('/') && !/[\0-\x1f\x7f]/.test(value);
}
function inspectPath(file, kind) {
  try {
  if (!absolute(file) || fs.realpathSync(file) !== file) throw error('BOUNDARY_PATH_UNTRUSTED');
  const stat = fs.lstatSync(file, { bigint: true });
  const owned = stat.uid === BigInt(process.getuid());
  if (kind === 'source_directory' ? !stat.isDirectory() || !owned
    : kind === 'directory' ? !stat.isDirectory() || !owned || (stat.mode & 0o7777n) !== 0o700n
    : kind === 'socket' ? !stat.isSocket() || !owned || (stat.mode & 0o7777n) !== 0o600n || stat.nlink !== 1n
      : !stat.isFile() || ![0n, BigInt(process.getuid())].includes(stat.uid) || (stat.mode & 0o7022n) !== 0n || (stat.nlink !== 1n && file !== native.EXECUTABLE)) {
    throw error('BOUNDARY_PATH_UNTRUSTED');
  }
  return { path: file, dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode),
    size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
  } catch (failure) { if (failure.code?.startsWith('BOUNDARY_')) throw failure; throw error('BOUNDARY_PATH_UNTRUSTED'); }
}
function pinPath(file, kind) { return Object.freeze(inspectPath(file, kind)); }
function validatePin(pin, kind, stableBytes = true) {
  closed(pin, ['path', 'dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs']);
  const current = inspectPath(pin.path, kind);
  const fields = stableBytes ? Object.keys(current) : ['path', 'dev', 'ino', 'mode'];
  if (fields.some(key => current[key] !== pin[key])) throw error('BOUNDARY_IDENTITY_CHANGED');
  return current;
}
function destination(value) {
  return typeof value === 'string' && /^\/(?:runtime|usr|lib|lib64|etc)\/[A-Za-z0-9_./+@-]+$/.test(value)
    && value.length <= 4096 && path.posix.normalize(value) === value && !value.endsWith('/');
}
function overlaps(a, b) { return a === b || a.startsWith(b + '/') || b.startsWith(a + '/'); }
function assertNoPrivateMounts(roots, mountInfo) {
  if (typeof mountInfo !== 'string' || Buffer.byteLength(mountInfo) > 4194304) throw error('BOUNDARY_MOUNT_CENSUS_INVALID');
  for (const line of mountInfo.trimEnd().split('\n')) {
    const fields = line.split(' ');
    if (fields.length < 10 || !fields.includes('-') || !/^\d+$/.test(fields[0])) throw error('BOUNDARY_MOUNT_CENSUS_INVALID');
    const target = fields[4].replace(/\\(040|011|012|134)/g, (_, code) => String.fromCharCode(parseInt(code, 8)));
    if (!target.startsWith('/') || target.includes('\\') || path.normalize(target) !== target) throw error('BOUNDARY_MOUNT_CENSUS_INVALID');
    if (roots.some(root => target === root || target.startsWith(root + '/'))) throw error('BOUNDARY_PRIVATE_MOUNT_PRESENT');
  }
}
function validatePrivateTrees(profile, nativeToken) {
  const census = fs.openSync('/proc/self/mountinfo', fs.constants.O_RDONLY);
  try {
    const buffer = Buffer.alloc(4194305); let length = 0, count;
    while (length < buffer.length && (count = fs.readSync(census, buffer, length, buffer.length - length, null)) > 0) length += count;
    assertNoPrivateMounts(Object.keys(ROOTS).map(name => profile[name].path), buffer.subarray(0, length).toString('utf8'));
  } finally { fs.closeSync(census); }
  if (nativeToken) {
    const home = profile.home.path;
    if (fs.readdirSync(home).sort().join('|') !== '.claude|.claude.json'
      || fs.readdirSync(path.join(home, '.claude')).join('|') !== '.credentials.json') throw error('BOUNDARY_NATIVE_PROFILE_INVALID');
    for (const relative of ['.claude/.credentials.json', '.claude.json']) {
      const stat = fs.lstatSync(path.join(home, relative), { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o7777n) !== 0o600n || stat.size > 1048576n) throw error('BOUNDARY_NATIVE_PROFILE_INVALID');
    }
  }
  let entries = 0;
  const seen = new Set();
  function visit(fd, depth, requireEmpty) {
    if (depth > 32) throw error('BOUNDARY_TREE_LIMIT');
    const before = fs.fstatSync(fd, { bigint: true }), at = '/proc/self/fd/' + fd;
    const key = String(before.dev) + ':' + String(before.ino);
    if (seen.has(key)) throw error('BOUNDARY_ROOT_ALIAS');
    seen.add(key);
    const directory = fs.opendirSync(at);
    try {
      for (;;) {
        const entry = directory.readSync(); if (!entry) break;
        if (++entries > 4096) throw error('BOUNDARY_TREE_LIMIT');
        if (requireEmpty) throw error('BOUNDARY_PROFILE_NOT_EMPTY');
        const named = at + '/' + entry.name, stat = fs.lstatSync(named, { bigint: true });
        if (stat.uid !== BigInt(process.getuid()) || (stat.mode & 0o7000n) !== 0n) throw error('BOUNDARY_TREE_UNTRUSTED');
        if (stat.isDirectory()) {
          const child = fs.openSync(named, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
          try {
            const opened = fs.fstatSync(child, { bigint: true });
            if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw error('BOUNDARY_IDENTITY_CHANGED');
            visit(child, depth + 1, false);
          } finally { fs.closeSync(child); }
        } else if (!stat.isFile() || stat.nlink !== 1n) throw error('BOUNDARY_TREE_UNTRUSTED');
        const after = fs.lstatSync(named, { bigint: true });
        if (after.dev !== stat.dev || after.ino !== stat.ino || after.mode !== stat.mode
          || after.nlink !== stat.nlink || after.ctimeNs !== stat.ctimeNs) throw error('BOUNDARY_IDENTITY_CHANGED');
      }
    } finally { directory.closeSync(); }
    const after = fs.fstatSync(fd, { bigint: true });
    if (after.ctimeNs !== before.ctimeNs || after.mtimeNs !== before.mtimeNs) throw error('BOUNDARY_IDENTITY_CHANGED');
  }
  for (const name of Object.keys(ROOTS)) {
    const fd = fs.openSync(profile[name].path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (String(stat.dev) !== profile[name].dev || String(stat.ino) !== profile[name].ino) throw error('BOUNDARY_IDENTITY_CHANGED');
      visit(fd, 0, name !== 'workspace' && !(nativeToken && name === 'home'));
    } finally { fs.closeSync(fd); }
  }
}
function checkProfile(input, nativeToken) {
  if (process.platform !== 'linux') throw error('BOUNDARY_PLATFORM_UNSUPPORTED');
  closed(input, ['version', 'policyId', 'adapterId', 'runId', 'sourceRoot', 'evidenceRoot', 'workspace', 'home', 'cache', 'tmp', 'bwrap', 'runtime', 'readonlyFiles']);
  if (input.version !== 1 || input.policyId !== POLICY) throw error('BOUNDARY_POLICY_UNSUPPORTED');
  // No native provider has been qualified by this artifact. A production native
  // adapter must be separately implemented/reviewed; no caller flag unlocks it.
  if (input.adapterId !== 'node_fixture_v1') {
    if (!nativeToken) throw error('BOUNDARY_NATIVE_UNSUPPORTED');
    native.assertClaudeProfile(nativeToken, input);
  } else if (nativeToken) throw error('BOUNDARY_SCHEMA_INVALID');
  if (typeof input.runId !== 'string' || !/^run_[A-Za-z0-9_-]{1,100}$/.test(input.runId)) throw error('BOUNDARY_RUN_INVALID');
  closed(input.runtime, ['node', 'gate', 'entry', 'control', 'forwarder']);
  validatePin(input.sourceRoot, 'source_directory', false); validatePin(input.evidenceRoot, 'directory', false);
  for (const name of Object.keys(ROOTS)) validatePin(input[name], 'directory', false);
  const privateRoots = Object.keys(ROOTS).map(name => input[name]);
  const protectedRoots = [input.sourceRoot, input.evidenceRoot];
  for (const root of privateRoots) for (const protectedRoot of protectedRoots) {
    if (overlaps(root.path, protectedRoot.path) || (root.dev === protectedRoot.dev && root.ino === protectedRoot.ino)) throw error('BOUNDARY_PROTECTED_ROOT');
  }
  for (let i = 0; i < privateRoots.length; i++) for (let j = i + 1; j < privateRoots.length; j++) {
    if (overlaps(privateRoots[i].path, privateRoots[j].path)
      || (privateRoots[i].dev === privateRoots[j].dev && privateRoots[i].ino === privateRoots[j].ino)) throw error('BOUNDARY_ROOT_ALIAS');
  }
  validatePin(input.bwrap, 'file');
  for (const pin of Object.values(input.runtime)) validatePin(pin, 'file');
  const trustedRuntime = { node: process.execPath, gate: path.resolve(__dirname, '../tools/pid1-gate.js'),
    entry: path.resolve(__dirname, '../tools/boundary-pid1-entry.js'), control: path.resolve(__dirname, 'owner-control.js'),
    forwarder: path.resolve(__dirname, 'namespace-forwarder.js') };
  if (input.bwrap.path !== '/usr/bin/bwrap' || Object.entries(trustedRuntime).some(([name, file]) => input.runtime[name].path !== fs.realpathSync(file))) {
    throw error('BOUNDARY_FIXTURE_RUNTIME_UNSUPPORTED');
  }
  if (!Array.isArray(input.readonlyFiles) || input.readonlyFiles.length > 256) throw error('BOUNDARY_MOUNT_LIMIT');
  const targets = new Set(Object.values(FIXED));
  for (const mount of input.readonlyFiles) {
    closed(mount, ['source', 'destination']); validatePin(mount.source, 'file');
    if (!destination(mount.destination) || targets.has(mount.destination)) throw error('BOUNDARY_MOUNT_INVALID');
    for (const other of targets) if (overlaps(other, mount.destination)) throw error('BOUNDARY_MOUNT_ALIAS');
    targets.add(mount.destination);
  }
  for (const pin of [input.bwrap, ...Object.values(input.runtime), ...input.readonlyFiles.map(x => x.source)]) {
    if (privateRoots.some(root => overlaps(root.path, pin.path))) throw error('BOUNDARY_RUNTIME_WRITABLE');
    if (protectedRoots.some(root => overlaps(root.path, pin.path))) throw error('BOUNDARY_PROTECTED_ROOT');
  }
  if ((BigInt(input.bwrap.mode) & 0o111n) === 0n || (BigInt(input.runtime.node.mode) & 0o111n) === 0n) throw error('BOUNDARY_EXECUTABLE_INVALID');
  validatePrivateTrees(input, nativeToken);
  return clone(input);
}
function validateProfile(input) { return checkProfile(input, null); }
function validateLaunch(profile, launch, nativeToken) {
  closed(launch, ['file', 'args']);
  const files = new Set([FIXED.node, ...profile.readonlyFiles.map(x => x.destination)]);
  if (!files.has(launch.file) || !Array.isArray(launch.args) || launch.args.length > 512
    || launch.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
    || Buffer.byteLength(canonical(launch)) > 65536) throw error('BOUNDARY_LAUNCH_INVALID');
  // This research adapter executes only its pinned Node runtime. It cannot be
  // relabelled as a native Claude/Codex executable by a profile field.
  if (nativeToken) {
    const expected = native.claudeLaunch(launch.args.at(-1));
    if (canonical(expected) !== canonical(launch)) throw error('BOUNDARY_NATIVE_LAUNCH_INVALID');
  } else if (launch.file !== FIXED.node) throw error('BOUNDARY_NATIVE_UNSUPPORTED');
  return clone(launch);
}
function compile({ profile: input, launch: requested, ownerEnv, broker }, nativeToken) {
  const profile = checkProfile(input, nativeToken), launch = validateLaunch(profile, requested, nativeToken);
  closed(ownerEnv, ['RELAYBRIDGE_OWNER_SOCKET', 'RELAYBRIDGE_OWNER_NONCE', 'RELAYBRIDGE_OWNER_RUN_ID', 'RELAYBRIDGE_OWNER_PROVIDER_NODE_OPTIONS']);
  if (ownerEnv.RELAYBRIDGE_OWNER_RUN_ID !== profile.runId || !/^[a-f0-9]{64}$/.test(ownerEnv.RELAYBRIDGE_OWNER_NONCE || '')
    || ownerEnv.RELAYBRIDGE_OWNER_PROVIDER_NODE_OPTIONS !== '') throw error('BOUNDARY_OWNER_INVALID');
  const binding = assertConnectBroker(broker);
  if (nativeToken && binding.policyId !== native.BROKER_POLICY) throw error('BOUNDARY_NATIVE_BROKER_INVALID');
  const brokerSocket = pinPath(binding.address, 'socket');
  const ownerSocket = inspectPath(ownerEnv.RELAYBRIDGE_OWNER_SOCKET, 'socket');
  for (const socket of [brokerSocket, ownerSocket]) {
    if (Object.keys(ROOTS).some(name => overlaps(profile[name].path, socket.path))) throw error('BOUNDARY_CONTROL_WRITABLE');
    if ([profile.sourceRoot, profile.evidenceRoot].some(root => overlaps(root.path, socket.path))) throw error('BOUNDARY_PROTECTED_ROOT');
    const parent = fs.statSync(path.dirname(socket.path), { bigint: true });
    if (parent.uid !== BigInt(process.getuid()) || (parent.mode & 0o7777n) !== 0o700n) throw error('BOUNDARY_CONTROL_UNTRUSTED');
  }
  const mounts = Object.keys(profile.runtime).map(name => ({ source: profile.runtime[name].path, destination: FIXED[name] }))
    .concat(profile.readonlyFiles.map(mount => ({ source: mount.source.path, destination: mount.destination })));
  const directories = new Set(['/relaybridge', '/work', '/home', '/home/agent', '/cache', '/tmp', '/run', '/proc', '/dev']);
  for (const mount of mounts) {
    let current = path.posix.dirname(mount.destination);
    while (current !== '/') { directories.add(current); current = path.posix.dirname(current); }
  }
  const args = ['--unshare-all', '--unshare-user', '--as-pid-1', '--die-with-parent', '--new-session',
    '--cap-drop', 'ALL', '--disable-userns', '--assert-userns-disabled', '--info-fd', '3', '--hostname', 'relaybridge'];
  for (const directory of [...directories].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) args.push('--dir', directory);
  for (const mount of mounts) args.push('--ro-bind', mount.source, mount.destination);
  for (const [name, target] of Object.entries(ROOTS)) args.push('--bind', profile[name].path, target);
  args.push('--ro-bind', ownerSocket.path, FIXED.ownerSocket, '--ro-bind', brokerSocket.path, FIXED.proxySocket,
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/run', '--clearenv');
  const env = { PATH: '/runtime/bin', HOME: '/home/agent', XDG_CONFIG_HOME: '/home/agent/.config', XDG_DATA_HOME: '/home/agent/.local/share',
    XDG_CACHE_HOME: '/cache', TMPDIR: '/tmp', TMP: '/tmp', TEMP: '/tmp', LANG: 'C.UTF-8',
    RELAYBRIDGE_OWNER_SOCKET: FIXED.ownerSocket, RELAYBRIDGE_OWNER_NONCE: ownerEnv.RELAYBRIDGE_OWNER_NONCE,
    RELAYBRIDGE_OWNER_RUN_ID: profile.runId, RELAYBRIDGE_OWNER_PROVIDER_NODE_OPTIONS: '' };
  if (nativeToken) Object.assign(env, native.ENVIRONMENT);
  for (const [name, value] of Object.entries(env)) args.push('--setenv', name, value);
  args.push('--chdir', '/work', '--', FIXED.node, FIXED.entry, '--', launch.file, ...launch.args);
  return { file: profile.bwrap.path, args, options: { cwd: profile.workspace.path,
    env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] }, profileHash: digest(profile) };
}
function compileBoundaryLaunch(options) { return compile(options, null); }
function buildOwner({ profile: input, launch: requested, broker, createOwner = createLinuxPhysicalOwner, spawnProcess = spawn } = {}, nativeToken) {
  const profile = checkProfile(input, nativeToken), launch = validateLaunch(profile, requested, nativeToken);
  assertConnectBroker(broker);
  const owner = createOwner({ runId: profile.runId, bwrapPath: profile.bwrap.path,
    nodePath: profile.runtime.node.path, gatePath: profile.runtime.gate.path,
    spawnProcess(file, args, options) {
      const expected = ['--unshare-pid', '--as-pid-1', '--die-with-parent', '--dev-bind', '/', '/', '--proc', '/proc',
        '--info-fd', '3', '--chdir', profile.workspace.path, '--', profile.runtime.node.path, profile.runtime.gate.path, '--', launch.file, ...launch.args];
      if (file !== profile.bwrap.path || canonical(args) !== canonical(expected)
        || canonical(options.stdio) !== canonical(['pipe', 'pipe', 'pipe', 'pipe'])
        || options.cwd !== profile.workspace.path) throw error('BOUNDARY_OWNER_PROFILE_CHANGED');
      const compiled = compile({ profile, launch, ownerEnv: options.env, broker }, nativeToken);
      return spawnProcess(compiled.file, compiled.args, compiled.options);
    },
  });
  owner.physicalDone.then(() => broker.close()).catch(() => {});
  // A gate can exit during proxy preflight, before sending its first hello.
  // Some lifetime-owner versions settle that process without rejecting ready.
  // Bound startup by the existing completion result; physicalDone remains the
  // sole physical-release signal and is never synthesized here.
  const ready = Promise.race([owner.ready, owner.completion.then(() => { throw error('BOUNDARY_STARTUP_UNCONFIRMED'); })]);
  ready.catch(() => {});
  return Object.freeze({ ready, completion: owner.completion, physicalDone: owner.physicalDone,
    start(...args) { if (args.length) throw error('BOUNDARY_CALLER_LAUNCH_FORBIDDEN'); return owner.start({ file: launch.file, args: launch.args, cwd: profile.workspace.path, env: {} }); },
    async allowProvider() { await ready; return owner.allowProvider(); },
    requestStop() { void broker.close().catch(() => {}); return owner.requestStop(); },
    snapshot: () => ({ ...owner.snapshot(), filesystemBoundary: { policyId: POLICY, profileHash: digest(profile), network: 'private_connect',
      sourceMounted: false, hostRootMounted: false, nativeQualified: false, adapterId: profile.adapterId } }),
  });
}
function createBoundaryOwner(options) { return buildOwner(options, null); }
// This explicit trusted-host seam permits qualification runs; it does not grant
// production eligibility. The owner journal must check its exact host/native
// qualification record before choosing this factory for ordinary dispatch.
function createClaudeBoundaryProfile({ runId, sourceRoot, evidenceRoot, workspace, home, cache, tmp, manifest }) {
  if (!manifest || manifest.adapterId !== native.ADAPTER) throw error('BOUNDARY_NATIVE_MANIFEST_INVALID');
  return { version: 1, policyId: POLICY, adapterId: native.ADAPTER, runId,
    sourceRoot: pinPath(sourceRoot, 'source_directory'), evidenceRoot: pinPath(evidenceRoot, 'directory'),
    workspace: pinPath(workspace, 'directory'), home: pinPath(home, 'directory'), cache: pinPath(cache, 'directory'), tmp: pinPath(tmp, 'directory'),
    bwrap: pinPath('/usr/bin/bwrap', 'file'), runtime: {
      node: pinPath(fs.realpathSync(process.execPath), 'file'), gate: pinPath(path.resolve(__dirname, '../tools/pid1-gate.js'), 'file'),
      entry: pinPath(path.resolve(__dirname, '../tools/boundary-pid1-entry.js'), 'file'), control: pinPath(path.resolve(__dirname, 'owner-control.js'), 'file'),
      forwarder: pinPath(path.resolve(__dirname, 'namespace-forwarder.js'), 'file'),
    }, readonlyFiles: manifest.readonlyFiles.map(item => ({ source: pinPath(item.path, 'file'), destination: item.destination })) };
}
function createClaudeBoundaryOwner({ nativeToken, prompt, ...options }) {
  return buildOwner({ ...options, launch: native.claudeLaunch(prompt) }, nativeToken);
}
module.exports = { createClaudeBoundaryProfile, createClaudeBoundaryOwner, POLICY, FIXED, pinPath, validateProfile, assertNoPrivateMounts, compileBoundaryLaunch, createBoundaryOwner };
