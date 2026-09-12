'use strict';
// Deployment-owned capability, never an HTTP body or environment assertion.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createLinuxPhysicalOwner } = require('./linux-physical-owner');
const { openLinuxDurableDirectory } = require('./linux-durable-file');
const { controllerLock } = require('./execution-owner');
const capabilities = new WeakSet();
const LOCAL_FILESYSTEMS = new Set([0xef53n, 0x58465342n, 0x9123683en]);
const TMPFS = 0x01021994n;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = (value) => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const fault = (code) => Object.assign(new Error(code), { code });
function pinFile(file, { executable = false, maxBytes = 256 * 1024 } = {}) {
  const real = fs.realpathSync(file);
  if (!path.isAbsolute(real) || /^\/mnt\/[a-z](?:\/|$)/i.test(real) || /\.exe$/i.test(real)) throw fault('OWNER_NATIVE_PATH_REQUIRED');
  const fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || ![0n, BigInt(process.getuid())].includes(stat.uid)
      || (stat.mode & 0o022n) !== 0n || stat.size < 1n || stat.size > BigInt(maxBytes)) throw fault('OWNER_HELPER_UNTRUSTED');
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(65536); let offset = 0, magic = null;
    while (offset < Number(stat.size)) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, Number(stat.size) - offset), offset);
      if (count <= 0) throw fault('OWNER_HELPER_CHANGED');
      if (!magic) magic = Buffer.from(buffer.subarray(0, Math.min(count, 4)));
      hash.update(buffer.subarray(0, count)); offset += count;
    }
    if (executable && (!magic.equals(Buffer.from([127, 69, 76, 70])) || !(stat.mode & 0o111n))) throw fault('OWNER_NATIVE_EXECUTABLE_REQUIRED');
    const identity = { path: real, dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size),
      mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), sha256: hash.digest('hex') };
    return Object.freeze(identity);
  } finally { fs.closeSync(fd); }
}
function assertPin(pin) {
  const stat = fs.statSync(pin.path, { bigint: true });
  if (!stat.isFile() || fs.realpathSync(pin.path) !== pin.path || String(stat.dev) !== pin.dev
    || String(stat.ino) !== pin.ino || String(stat.size) !== pin.size || String(stat.mtimeNs) !== pin.mtimeNs
    || String(stat.ctimeNs) !== pin.ctimeNs || (stat.mode & 0o022n)) throw fault('OWNER_HELPER_CHANGED');
}
function pinDirectory(directory, { privateMode = false, fixture = false } = {}) {
  const real = fs.realpathSync(directory), stat = fs.statSync(real, { bigint: true });
  if (!stat.isDirectory() || real !== path.resolve(directory) || /^\/mnt\/[a-z](?:\/|$)/i.test(real)
    || stat.uid !== BigInt(process.getuid()) || (privateMode ? (stat.mode & 0o7777n) !== 0o700n : (stat.mode & 0o022n) !== 0n)) throw fault('OWNER_DIRECTORY_UNTRUSTED');
  const filesystem = fs.statfsSync(real, { bigint: true }).type;
  if (!LOCAL_FILESYSTEMS.has(filesystem) && !(fixture && filesystem === TMPFS)) throw fault('OWNER_FILESYSTEM_UNQUALIFIED');
  for (let current = path.dirname(real); ; current = path.dirname(current)) {
    const ancestor = fs.lstatSync(current, { bigint: true });
    if (!ancestor.isDirectory() || ancestor.isSymbolicLink()
      || ![0n, BigInt(process.getuid())].includes(ancestor.uid)
      || (ancestor.mode & 0o022n) !== 0n && !(fixture && (ancestor.mode & 0o1000n) !== 0n)) throw fault('OWNER_ANCESTRY_UNTRUSTED');
    if (current === path.dirname(current)) break;
  }
  return Object.freeze({ path: real, dev: String(stat.dev), ino: String(stat.ino), filesystem: filesystem.toString(16) });
}
function assertDirectory(pin, { privateMode = false } = {}) {
  const stat = fs.lstatSync(pin.path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || String(stat.dev) !== pin.dev || String(stat.ino) !== pin.ino
    || stat.uid !== BigInt(process.getuid()) || (privateMode ? (stat.mode & 0o7777n) !== 0o700n : (stat.mode & 0o022n) !== 0n)) throw fault('OWNER_DIRECTORY_CHANGED');
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function timeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(fault('OWNER_QUALIFICATION_TIMEOUT')), ms); })])
    .finally(() => clearTimeout(timer));
}
async function qualify({ dataDir, directory = path.join(dataDir, 'execution-owners'), fixtureLaunch = null,
  bwrapPath = '/usr/bin/bwrap', flockPath = '/usr/bin/flock', nodePath = process.execPath,
  gatePath = path.resolve(__dirname, '../tools/pid1-gate.js') }, fixture) {
  if (process.platform !== 'linux') throw fault('OWNER_PLATFORM_UNQUALIFIED');
  const data = pinDirectory(dataDir, { fixture });
  if (path.dirname(path.resolve(directory)) !== data.path) throw fault('OWNER_DIRECTORY_UNTRUSTED');
  try { fs.mkdirSync(directory, { mode: 0o700 }); syncDirectory(data.path); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const store = pinDirectory(directory, { privateMode: true, fixture }); syncDirectory(directory); syncDirectory(data.path);
  const files = {
    node: pinFile(nodePath, { executable: true, maxBytes: 256 * 1024 * 1024 }),
    bwrap: pinFile(bwrapPath, { executable: true, maxBytes: 8 * 1024 * 1024 }),
    flock: pinFile(flockPath, { executable: true, maxBytes: 8 * 1024 * 1024 }),
    gate: pinFile(gatePath), control: pinFile(path.resolve(path.dirname(gatePath), '../lib/owner-control.js')),
    physicalOwner: pinFile(path.resolve(path.dirname(gatePath), '../lib/linux-physical-owner.js')),
    identity: pinFile(path.resolve(path.dirname(gatePath), '../lib/linux-owner-identity.js')),
  };
  const machine = fs.readFileSync('/etc/machine-id', 'utf8').trim();
  if (!/^[a-f0-9]{32}$/.test(machine)) throw fault('OWNER_HOST_IDENTITY_UNAVAILABLE');
  const hostIdentity = sha(canonical({ machine, uid: process.getuid(), architecture: process.arch }));
  const probeDirectory = fs.mkdtempSync(path.join(data.path, '.owner-qualification-'));
  let controller = null, durable = null;
  try {
    durable = openLinuxDurableDirectory({ directory: probeDirectory });
    const marker = crypto.randomBytes(32).toString('hex'); durable.createExclusive('durability-probe', marker);
    if (fs.readFileSync(path.join(probeDirectory, 'durability-probe'), 'utf8') !== marker) throw fault('OWNER_DURABILITY_UNCONFIRMED');
    durable.close(); durable = null;
    controller = controllerLock(probeDirectory, { flockPath: files.flock.path });
    const contender = spawnSync(files.flock.path, ['-n', '-E', '73', path.join(probeDirectory, 'controller.lock'), files.node.path, '-e', ''],
      { timeout: 3000, maxBuffer: 1024, env: { PATH: '/usr/bin:/bin' } });
    if (contender.error || contender.signal || contender.status !== 73) throw fault('OWNER_FLOCK_UNQUALIFIED');
    controller.close(); controller = null;
  } finally {
    if (durable) durable.close(); if (controller) controller.close();
    fs.rmSync(probeDirectory, { recursive: true, force: true }); syncDirectory(data.path);
  }
  const owner = createLinuxPhysicalOwner({ runId: 'run_qualification_' + crypto.randomBytes(12).toString('hex'),
    nodePath: files.node.path, bwrapPath: files.bwrap.path, gatePath: files.gate.path });
  try {
    const child = await owner.start({ file: files.node.path, args: ['-e', "process.stdout.write('owner-qualified-v1')"],
      cwd: data.path, env: { PATH: '/usr/bin:/bin' } });
    let output = ''; child.stdout.on('data', (bytes) => { output = (output + bytes).slice(0, 256); }); child.stderr.resume();
    await timeout(owner.ready, 5000);
    if (owner.snapshot().providerState !== 'not_released' || owner.snapshot().pin?.namespacePid !== 1) throw fault('OWNER_GATE_UNQUALIFIED');
    await owner.allowProvider(); child.stdin.end();
    const done = await timeout(owner.physicalDone, 8000);
    if (done.evidence !== 'process_tree_settled' || output !== 'owner-qualified-v1') throw fault('OWNER_GATE_UNQUALIFIED');
  } finally { owner.requestStop(); await timeout(owner.completion, 7000); }
  let fixtureProfile = null;
  if (fixture) {
    if (!fixtureLaunch || fixtureLaunch.file !== files.node.path || !Array.isArray(fixtureLaunch.args)
      || fixtureLaunch.args.length !== 1 || typeof fixtureLaunch.args[0] !== 'string') throw fault('OWNER_FIXTURE_PROFILE_INVALID');
    const program = pinFile(fixtureLaunch.args[0]), cwd = pinDirectory(fixtureLaunch.cwd, { fixture: true });
    if (Object.keys(fixtureLaunch.env || {}).some((key) => !['PATH', 'HOME', 'TMPDIR'].includes(key))) throw fault('OWNER_FIXTURE_PROFILE_INVALID');
    fixtureProfile = { launchHash: sha(canonical(fixtureLaunch)), program, cwd };
  }
  function assertStorage() {
    assertDirectory(data); assertDirectory(store, { privateMode: true });
    return true;
  }
  function assertLaunchFiles() {
    for (const value of Object.values(files)) assertPin(value);
    if (fixtureProfile) { assertPin(fixtureProfile.program); assertDirectory(fixtureProfile.cwd); }
  }
  const capability = Object.freeze({ hostIdentity, directory: store.path, scope: fixture ? 'fixture_only' : 'storage_only',
    profileId: fixture ? 'fixture_node_v1' : null,
    storage: Object.freeze({ filesystem: store.filesystem, persistent: LOCAL_FILESYSTEMS.has(BigInt('0x' + store.filesystem)) }),
    assertStorage,
    assertRevision({ provider, cwd }) {
      assertStorage(); assertLaunchFiles();
      // No native provider/auth profile has been qualified in this change.
      if (!fixtureProfile || provider !== 'fixture_node' || fs.realpathSync(cwd) !== fixtureProfile.cwd.path) throw fault('OWNER_PROVIDER_PROFILE_UNQUALIFIED');
    },
    assertLaunch({ binding, launch, profile }) {
      this.assertRevision({ provider: binding.provider, cwd: launch.cwd });
      if (sha(canonical(launch)) !== fixtureProfile.launchHash || profile.kind !== 'linux_pid1_owner'
        || profile.writeRoots?.length !== 0 || profile.cwdIdentityHash !== binding.cwdIdentityHash
        || profile.executionHash !== binding.executionHash || profile.policyId !== binding.cwdPolicyId) throw fault('OWNER_LAUNCH_PROFILE_UNQUALIFIED');
    },
    createPhysicalOwner({ runId, launchProfile }) {
      assertStorage(); assertLaunchFiles(); if (launchProfile.kind !== 'linux_pid1_owner' || launchProfile.writeRoots?.length !== 0) throw fault('OWNER_LAUNCH_PROFILE_UNQUALIFIED');
      return createLinuxPhysicalOwner({ runId, nodePath: files.node.path, bwrapPath: files.bwrap.path, gatePath: files.gate.path });
    },
  });
  capabilities.add(capability); return capability;
}
function qualifyOwnedHost(options) { return qualify(options, false); }
// Explicit test-only provider kind and exact Node/script/env/cwd tuple. This
// never qualifies claude/codex/auth, and tmpfs never becomes persistent storage.
function qualifyOwnedFixtureHost(options) { return qualify(options, true); }
function isOwnedHostQualification(value) { return capabilities.has(value); }
module.exports = { qualifyOwnedHost, qualifyOwnedFixtureHost, isOwnedHostQualification };
