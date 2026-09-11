'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawnSync } = require('node:child_process'), { Duplex } = require('node:stream');
const { POLICY, FIXED, pinPath, validateProfile, assertNoPrivateMounts, compileBoundaryLaunch, createBoundaryOwner } = require('../lib/linux-filesystem-boundary');
const { createConnectBroker } = require('../lib/connect-broker');
const linuxTest = process.platform === 'linux' ? test : test.skip;
const ROOT = path.resolve(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const helper = String.raw`
'use strict';
const fs=require('node:fs'),net=require('node:net'),assert=require('node:assert/strict'),{spawnSync,spawn}=require('node:child_process');
(async()=>{
 const [source,evidence,hostSocket,hostPort,mode]=process.argv.slice(2);
 fs.writeFileSync('/work/started','yes');
 const denied=fn=>{try{fn();return false;}catch{return true;}};
 assert.ok(denied(()=>fs.writeFileSync(source+'/dirty.txt','BROKEN')));
 assert.ok(denied(()=>fs.readFileSync(evidence+'/private.txt')));
 assert.ok(denied(()=>fs.writeFileSync('/relaybridge/node','BROKEN')));
 assert.ok(denied(()=>fs.readFileSync('/init')));
 assert.ok(denied(()=>fs.readFileSync('/mnt/c/Windows/System32/cmd.exe')));
 fs.symlinkSync(source+'/dirty.txt','/work/escape');
 assert.ok(denied(()=>fs.writeFileSync('/work/escape','BROKEN')));
 assert.ok(denied(()=>fs.linkSync(source+'/dirty.txt','/work/hardlink')));
 assert.ok(denied(()=>fs.readFileSync('/proc/1/root'+source+'/dirty.txt')));
 for(const dir of ['/work',process.env.HOME,process.env.XDG_CACHE_HOME,process.env.TMPDIR])fs.writeFileSync(dir+'/writable','private');
 for(const name of ['RELAYBRIDGE_OWNER_NONCE','RELAYBRIDGE_OWNER_SOCKET','RELAYBRIDGE_OWNER_RUN_ID','RELAYBRIDGE_TOKEN','WSL_INTEROP','NODE_OPTIONS'])assert.equal(process.env[name],undefined,name);
 assert.equal(process.env.NO_PROXY,'');assert.equal(process.env.no_proxy,'');
 const child=spawnSync(process.execPath,['-e','try{require("fs").writeFileSync(process.argv[1],"BROKEN");process.exit(9)}catch{}',source+'/dirty.txt']);assert.equal(child.status,0);
 const nested=spawnSync('/runtime/bin/unshare',['--user',process.execPath,'-e','process.exit(0)']);assert.notEqual(nested.status,0);
 const externalFds=fs.readdirSync('/proc/self/fd').some(fd=>{try{return fs.readlinkSync('/proc/self/fd/'+fd).includes(source)}catch{return false;}});assert.equal(externalFds,false);
 async function blocked(options){return new Promise(resolve=>{const s=net.createConnection(options);s.on('error',()=>resolve(true));s.once('connect',()=>{s.destroy();resolve(false)});s.setTimeout(1000,()=>{s.destroy();resolve(true)});});}
 assert.equal(await blocked({host:'127.0.0.2',port:Number(hostPort)}),true);
 assert.equal(await blocked({path:hostSocket}),true);
 const url=new URL(process.env.HTTPS_PROXY);
 const answer=await new Promise((resolve,reject)=>{const s=net.createConnection(Number(url.port),url.hostname);let text='',sent=false;s.on('error',reject);s.on('connect',()=>s.write('CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n\r\n'));s.on('data',b=>{text+=b;if(!sent&&text.includes('200 Connection Established')){sent=true;s.end('fixture')}});s.on('end',()=>resolve(text));});
 assert.ok(answer.endsWith('echo:fixture'));
 const descendant=spawn(process.execPath,['-e','const fs=require("fs");fs.writeFileSync("/work/descendant","started");setInterval(()=>fs.appendFileSync("/work/ticks","x"),5)'],{detached:true,stdio:'ignore'});descendant.unref();
 for(let i=0;i<100&&!fs.existsSync('/work/descendant');i++)await new Promise(r=>setTimeout(r,5));assert.ok(fs.existsSync('/work/descendant'));
 console.log(JSON.stringify({filesystem:true,privateDirectories:true,directNetworkDenied:true,hostSocketDenied:true,proxy:true,nestedUsernsDenied:true,providerInheritedControl:false}));
 if(mode==='hang')setInterval(()=>{},1000);
})().catch(()=>{process.stderr.write('BOUNDARY_FIXTURE_FAILED\n');process.exit(9)});
`;
function dependencies(executable) {
  const result = spawnSync('ldd', [executable], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(result.status, 0, 'trusted fixture executable dependencies must be readable');
  return result.stdout.split('\n').flatMap(line => {
    const found = /=>\s+(\/\S+)/.exec(line)?.[1] || /^\s*(\/\S+)/.exec(line)?.[1];
    return found ? [{ source: pinPath(fs.realpathSync(found), 'file'), destination: found }] : [];
  });
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-boundary-test-')); fs.chmodSync(root, 0o700);
  const dirs = {};
  for (const name of ['source', 'evidence', 'workspace', 'home', 'cache', 'tmp', 'broker']) { dirs[name] = path.join(root, name); fs.mkdirSync(dirs[name], { mode: 0o700 }); }
  fs.writeFileSync(path.join(dirs.source, 'dirty.txt'), 'authoritative dirty bytes');
  fs.writeFileSync(path.join(dirs.evidence, 'private.txt'), 'private evidence marker');
  const helperFile = path.join(root, 'helper.js'); fs.writeFileSync(helperFile, helper, { mode: 0o600 });
  const unshare = fs.realpathSync('/usr/bin/unshare');
  const mounts = [...dependencies(process.execPath), ...dependencies(unshare), { source: pinPath(unshare, 'file'), destination: '/runtime/bin/unshare' },
    { source: pinPath(helperFile, 'file'), destination: '/runtime/helper.js' }];
  const profile = { version: 1, policyId: POLICY, adapterId: 'node_fixture_v1', runId: 'run_boundary_fixture',
    sourceRoot: pinPath(dirs.source, 'source_directory'), evidenceRoot: pinPath(dirs.evidence, 'directory'),
    ...Object.fromEntries(['workspace', 'home', 'cache', 'tmp'].map(name => [name, pinPath(dirs[name], 'directory')])),
    bwrap: pinPath('/usr/bin/bwrap', 'file'), runtime: {
      node: pinPath(fs.realpathSync(process.execPath), 'file'), gate: pinPath(path.join(ROOT, 'tools/pid1-gate.js'), 'file'),
      entry: pinPath(path.join(ROOT, 'tools/boundary-pid1-entry.js'), 'file'), control: pinPath(path.join(ROOT, 'lib/owner-control.js'), 'file'),
      forwarder: pinPath(path.join(ROOT, 'lib/namespace-forwarder.js'), 'file'),
    }, readonlyFiles: [...new Map(mounts.map(x => [x.destination, x])).values()] };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dirs, profile };
}
async function listen(server, options) { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options, () => { server.removeListener('error', reject); resolve(); }); }); }
class Echo extends Duplex {
  constructor(options) { super({ allowHalfOpen: true }); this.remoteAddress = options.host; this.remotePort = 443; queueMicrotask(() => this.emit('connect')); }
  _read() {} _write(chunk, encoding, done) { this.push('echo:' + chunk); done(); } _final(done) { this.push(null); done(); }
}
async function brokerAt(directory) {
  return createConnectBroker({ directory, policyId: 'codex_subscription_candidate_v1', lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    networkInterfaces: () => ({}), connectLiteral: options => new Echo(options) });
}
async function runFixture(t, { mode = 'once' } = {}) {
  const f = fixture(t); let hostHits = 0;
  const host = net.createServer(socket => { hostHits++; socket.destroy(); }); await listen(host, { host: '127.0.0.2', port: 0 });
  const hostSocketPath = path.join(f.root, 'host-service.sock');
  const hostSocket = net.createServer(socket => { hostHits++; socket.destroy(); }); await listen(hostSocket, hostSocketPath);
  const broker = await brokerAt(f.dirs.broker);
  const launch = { file: FIXED.node, args: ['/runtime/helper.js', f.dirs.source, f.dirs.evidence, hostSocketPath, String(host.address().port), mode] };
  const owner = createBoundaryOwner({ profile: f.profile, launch, broker });
  t.after(async () => { owner.requestStop(); await broker.close(); await new Promise(resolve => host.close(resolve)); await new Promise(resolve => hostSocket.close(resolve)); });
  const inherited = fs.openSync(path.join(f.dirs.source, 'dirty.txt'), 'r+'); t.after(() => fs.closeSync(inherited));
  const keepAlive = setInterval(() => {}, 1000); t.after(() => clearInterval(keepAlive));
  const proc = await owner.start(); let stdout = '', stderr = '';
  if (proc) { proc.stdout.on('data', b => { stdout += b; }); proc.stderr.on('data', b => { stderr += b; }); proc.stdin.end(); }
  await owner.ready;
  assert.equal(fs.existsSync(path.join(f.dirs.workspace, 'started')), false, 'gate must withhold all provider code');
  assert.equal(await owner.allowProvider(), true);
  if (mode === 'hang') {
    for (let i = 0; i < 200 && !fs.existsSync(path.join(f.dirs.workspace, 'descendant')); i++) await wait(5);
    assert.equal(fs.existsSync(path.join(f.dirs.workspace, 'descendant')), true, stderr);
    owner.requestStop();
  }
  const physical = await owner.physicalDone;
  assert.equal(physical.evidence, 'process_tree_settled', stderr);
  assert.equal(fs.readFileSync(path.join(f.dirs.source, 'dirty.txt'), 'utf8'), 'authoritative dirty bytes');
  assert.equal(fs.readFileSync(path.join(f.dirs.evidence, 'private.txt'), 'utf8'), 'private evidence marker');
  assert.equal(hostHits, 0);
  assert.equal(stderr, '');
  const report = JSON.parse(stdout.trim()); assert.equal(report.proxy, true); assert.equal(report.filesystem, true);
  const tickFile = path.join(f.dirs.workspace, 'ticks'), before = fs.existsSync(tickFile) ? fs.readFileSync(tickFile) : Buffer.alloc(0);
  await wait(30); assert.deepEqual(fs.existsSync(tickFile) ? fs.readFileSync(tickFile) : Buffer.alloc(0), before);
  assert.equal(owner.snapshot().filesystemBoundary.nativeQualified, false);
  await broker.close();
}

linuxTest('closed profile refuses broad mounts, protected-root aliases and native qualification shortcuts', t => {
  const f = fixture(t);
  assert.equal(validateProfile(f.profile).adapterId, 'node_fixture_v1');
  for (const extra of [{ bwrapArgs: ['--ro-bind', '/', '/'] }, { environment: { NODE_OPTIONS: '--require /tmp/x' } }, { nativeQualified: true }]) {
    assert.throws(() => validateProfile({ ...f.profile, ...extra }), { code: 'BOUNDARY_SCHEMA_INVALID' });
  }
  assert.throws(() => validateProfile({ ...f.profile, adapterId: 'claude' }), { code: 'BOUNDARY_NATIVE_UNSUPPORTED' });
  assert.throws(() => validateProfile({ ...f.profile, workspace: f.profile.sourceRoot }), { code: 'BOUNDARY_PROTECTED_ROOT' });
  assert.throws(() => validateProfile({ ...f.profile, readonlyFiles: [{ source: f.profile.runtime.node, destination: '/proc/self/node' }] }), { code: 'BOUNDARY_MOUNT_INVALID' });
  assert.throws(() => validateProfile({ ...f.profile, runtime: { ...f.profile.runtime, gate: f.profile.runtime.entry } }), { code: 'BOUNDARY_FIXTURE_RUNTIME_UNSUPPORTED' });
});
linuxTest('identity changes and special files are rejected before any launch', t => {
  const f = fixture(t), old = f.profile.workspace.path + '-old';
  fs.renameSync(f.profile.workspace.path, old); fs.mkdirSync(f.profile.workspace.path, { mode: 0o700 });
  assert.throws(() => validateProfile(f.profile), { code: 'BOUNDARY_IDENTITY_CHANGED' });
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.dirs.source, alias);
  assert.throws(() => pinPath(alias, 'directory'), { code: 'BOUNDARY_PATH_UNTRUSTED' });
});
linuxTest('one real bwrap composes minimal mounts, proxy readiness and existing PID1 gate', { timeout: 10000 }, async t => {
  await runFixture(t);
});
linuxTest('private stop kills detached namespace descendants and closes run proxy tunnels', { timeout: 10000 }, async t => {
  await runFixture(t, { mode: 'hang' });
});
linuxTest('forged host-service brokers and closed genuine brokers refuse before launch', async t => {
  const f = fixture(t), launch = { file: FIXED.node, args: ['-e', 'process.exit(99)'] };
  assert.throws(() => createBoundaryOwner({ profile: f.profile, launch, broker: { address: '/tmp/host.sock', close: async () => {} } }), { code: 'CONNECT_BROKER_UNTRUSTED' });
  const broker = await brokerAt(f.dirs.broker); await broker.close();
  assert.throws(() => createBoundaryOwner({ profile: f.profile, launch, broker }), { code: 'CONNECT_BROKER_UNAVAILABLE' });
  assert.equal(fs.readdirSync(f.dirs.workspace).length, 0);
});
test('private writable roots refuse nested file/directory mount aliases', () => {
  const root = '/private/work';
  const line = target => `1 0 8:1 / ${target} rw - ext4 /dev/sda rw\n`;
  assert.doesNotThrow(() => assertNoPrivateMounts([root], line('/')));
  for (const target of [root, root + '/alias', root + '/dir']) {
    assert.throws(() => assertNoPrivateMounts([root], line(target)), { code: 'BOUNDARY_PRIVATE_MOUNT_PRESENT' });
  }
  assert.throws(() => assertNoPrivateMounts([root], 'truncated'), { code: 'BOUNDARY_MOUNT_CENSUS_INVALID' });
});

linuxTest('existing host sockets, links and reused mutable profiles cannot enter writable mounts', async t => {
  const f = fixture(t), address = path.join(f.dirs.workspace, 'host.sock');
  const server = net.createServer(); await listen(server, address);
  try { assert.throws(() => validateProfile(f.profile), { code: 'BOUNDARY_TREE_UNTRUSTED' }); }
  finally { await new Promise(resolve => server.close(resolve)); }
  fs.symlinkSync(f.dirs.source, path.join(f.dirs.workspace, 'alias'));
  assert.throws(() => validateProfile(f.profile), { code: 'BOUNDARY_TREE_UNTRUSTED' });
  fs.unlinkSync(path.join(f.dirs.workspace, 'alias'));
  fs.writeFileSync(path.join(f.dirs.home, 'reused-profile'), 'old mutable profile');
  assert.throws(() => validateProfile(f.profile), { code: 'BOUNDARY_PROFILE_NOT_EMPTY' });
});
