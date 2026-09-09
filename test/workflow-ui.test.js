'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const dashboard = require('../public/dashboard-state');
const phasePolicy = { version:1, ...Object.fromEntries(['planning','review','finalReview'].map(phase => [phase,{provider:'codex',model:'gpt-6-astra',effort:'ultra',maxEffortOverride:true}])), implementation:{provider:'codex',mode:'external'}, revision:{provider:'codex',mode:'external'} };

test('workflow presentation uses server actions and preserves missing ownership and final-review gates', () => {
  const revision = { workflow:{ runId:'wf_fixture', phase:'revision_ready', profile:'codex-astra-ultra', phasePolicy },
    nextActions:['start_pipeline_final_review', 'unknown_action'] };
  assert.deepEqual(dashboard.workflowDetailModel(revision).actions.map(a => a.name), ['start_pipeline_final_review']);
  assert.match(dashboard.workflowDetailModel(revision).notice, /fresh final review/);
  assert.equal(dashboard.workflowDetailModel({ workflow:{ phase:'plan_ready' } }).actions.length, 0);
  const held = dashboard.workflowDetailModel({ workflow:{ phase:'revising', writerLease:{ actor:'codex' } },
    nextActions:[], blockedActions:[{ code:'LEASE_IDENTITY_UNAVAILABLE' }] });
  assert.match(held.writer, /unknown ownership/); assert.equal(held.actions.length, 0);
  const safe = dashboard.workflowDetailModel({ workflow:{ permissionMode:'safe', profile:'codex-astra-ultra', phasePolicy }, nextActions:['claim_pipeline_revision'] });
  assert.match(safe.actions[0].blocked, /without filesystem-write acknowledgement/);
});

test('browser workflow panel is lazy, pins Astra, retains late claims and requires final review', {
  skip:!process.env.RELAYBRIDGE_BROWSER_MODULE, timeout:60000,
}, async t => {
  const fs = require('node:fs'), path = require('node:path');
  const { chromium } = require(process.env.RELAYBRIDGE_BROWSER_MODULE);
  const browser = await chromium.launch({ headless:true,
    ...(process.env.RELAYBRIDGE_BROWSER_EXECUTABLE ? { executablePath:process.env.RELAYBRIDGE_BROWSER_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport:{ width:1280, height:900 } });
  const page = await context.newPage(), root = path.resolve(__dirname, '..'), origin = 'http://relaybridge.test';
  const errors = [], unexpected = [], writes = [], reads = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install();
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8')
    .replace('__ONE_SHOT_DEFAULT_TIMEOUT_MS__', '1200000').replace('<script>', '<script nonce="fixture">');
  const assets = { '/dashboard-state.js':'public/dashboard-state.js', '/workflow-panel.js':'public/workflow-panel.js',
    '/vendor/xterm/lib/xterm.js':'node_modules/@xterm/xterm/lib/xterm.js', '/vendor/xterm/css/xterm.css':'node_modules/@xterm/xterm/css/xterm.css',
    '/vendor/xterm-addon-fit/lib/addon-fit.js':'node_modules/@xterm/addon-fit/lib/addon-fit.js' };
  let exists = false, releaseClaim, delayClaim = false, releaseRead, delayRead = false, delayList = false, releaseList;
  let omitSelected = false, delayRenew = false, releaseRenew;
  const workflow = { runId:'wf_fixture', phase:'scoping', profile:'codex-astra-ultra', phasePolicy, cwd:'/fixture', permissionMode:'full', writerLease:null };
  let actions = ['submit_pipeline_research'], blockedActions = [];
  const projection = () => ({ workflow:structuredClone(workflow), nextActions:[...actions], blockedActions,
    artifactContents:{ objective:'Fixture objective', plan:'Fixture saved plan', acceptance:'Fixture criteria', review:'Fixture saved review. REVIEW_VERDICT: REVISE' } });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    const json = value => route.fulfill({ status:200, contentType:'application/json', body:JSON.stringify(value) });
    if (url.origin !== origin) { unexpected.push(req.url()); return route.abort(); }
    if (url.pathname === '/') return route.fulfill({ status:200, contentType:'text/html', body:html,
      headers:{ 'Content-Security-Policy':"default-src 'self'; script-src 'self' 'nonce-fixture'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'" } });
    if (assets[url.pathname]) return route.fulfill({ status:200, contentType:url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body:fs.readFileSync(path.join(root, assets[url.pathname])) });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status:204 });
    if (req.method() === 'POST') {
      const body = req.postDataJSON(); writes.push({ path:url.pathname, body });
      if (url.pathname === '/api/workflows') { exists = true; return json(projection()); }
      if (url.pathname === '/api/workflows/wf_fixture/revision/claim') {
        if (delayClaim) await new Promise(resolve => { releaseClaim = resolve; });
        workflow.phase = 'revising'; workflow.writerLease = { actor:'codex', mode:'external', expiresAt:Date.now() + 14400000 };
        actions = ['complete_pipeline_revision', 'renew_pipeline_writer_lease'];
        return json({ workflow, lease:{ actor:'codex', leaseToken:'fixture-private-lease-token' } });
      }
      if (url.pathname.endsWith('/lease/renew')) {
        if (delayRenew) await new Promise(resolve => { releaseRenew = resolve; });
        return json({ workflow, lease:{ actor:'codex', leaseToken:'fixture-private-lease-token' } });
      }
      if (url.pathname.endsWith('/revision/complete') && body.leaseToken !== 'fixture-private-lease-token') return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Lease token rejected'})});
      if (url.pathname.endsWith('/revision/complete')) { workflow.phase = 'revision_ready'; workflow.writerLease = null; actions = ['start_pipeline_final_review']; return json(projection()); }
      if (url.pathname.endsWith('/final-review/start')) { workflow.phase = 'final_reviewing'; actions = ['reconcile_pipeline']; return json(projection()); }
      unexpected.push('POST ' + url.pathname); return route.fulfill({ status:405 });
    }
    reads.push(url.pathname);
    if (url.pathname === '/api/workflows') {
      const response = { workflows:exists ? [structuredClone(workflow), {...workflow,runId:'wf_other',phase:'complete'}] : [] };
      if (omitSelected) response.workflows = Array.from({length:40}, (_,index) =>
        ({...workflow, runId:index ? 'wf_newer_' + index : 'wf_other', phase:'complete'}));
      if (delayList) { delayList=false; await new Promise(resolve => { releaseList=resolve; }); }
      return json(response);
    }
    if (url.pathname === '/api/workflows/wf_other') return json({workflow:{...workflow,runId:'wf_other',phase:'complete'},nextActions:[]});
    if (url.pathname === '/api/workflows/wf_fixture') {
      const response = projection();
      if (delayRead) { delayRead = false; await new Promise(resolve => { releaseRead = resolve; }); }
      return json(response);
    }
    const boot = {
      '/api/capability':{ token:'1'.repeat(64) }, '/api/config':{ codex:{ label:'Codex fixture' } }, '/api/permissions':{ fullPermissions:false },
      '/api/workspace':{ defaultCwd:'/fixture', allowedRoots:['/fixture'] }, '/api/sessions':[],
      '/api/health':{ version:'fixture', capabilityAuth:true, ptyMode:'none', activeOneShotCount:0 }, '/api/telemetry':{ totals:{ui:0,mcp:0} },
      '/api/diag':{results:{}}, '/api/agents':{ agents:[{id:'codex',label:'Codex fixture'}] },
      '/api/tasks':{tasks:[],stats:{active:0,queued:0,uncertain:6,maxConcurrent:3}},
      '/api/output-profiles':require('../lib/output-profiles').listOutputProfiles(), '/api/workflow-library':require('../lib/workflow-library').listWorkflowLibrary(),
    };
    if (Object.hasOwn(boot, url.pathname)) return json(boot[url.pathname]);
    unexpected.push('GET ' + url.pathname); return route.fulfill({ status:404 });
  });
  await page.goto(origin); await page.locator('#status-version').filter({ hasText:'fixture' }).waitFor();
  await page.locator('#tasks-btn').click(); await page.locator('#tasks-stats').filter({ hasText:'6 held' }).waitFor();
  assert.equal(reads.includes('/api/workflows'), false);
  await page.locator('#staged-workflows > summary').click();
  await page.locator('#workflow-status').filter({ hasText:'Select a workflow' }).waitFor();
  assert.equal(writes.length, 0);
  await page.locator('#staged-workflows .task-composer > details > summary').click();
  await page.locator('#workflow-cwd').fill('/fixture'); await page.locator('#workflow-objective').fill('Fixture objective');
  await page.locator('#workflow-acceptance').fill('Fixture criteria'); await page.locator('#workflow-write-consent').check();
  await page.locator('#workflow-create').click(); await page.locator('#workflow-phase').filter({ hasText:'scoping' }).waitFor();
  assert.deepEqual(writes[0].body, { cwd:'/fixture', objective:'Fixture objective', acceptance:'Fixture criteria',
    profile:'codex-astra-ultra', permissionMode:'full', acknowledgeFilesystemWrites:true });
  await page.locator('#staged-workflows .task-composer > details > summary').click();
  workflow.phase = 'review_ready'; actions = ['claim_pipeline_revision'];
  await page.locator('#workflow-refresh').click(); await page.locator('[data-workflow-action="claim_pipeline_revision"]').waitFor();
  assert.equal(await page.locator('#workflow-plan').textContent(),'Fixture saved plan');
  assert.equal(await page.locator('#workflow-criteria').textContent(),'Fixture criteria');
  const writesBeforeRefresh = writes.length;
  await page.locator('#workflow-evidence').fill('Keep this selected workflow draft.');
  omitSelected = true;
  const recentReads = reads.length;
  await page.locator('#workflow-refresh').click();
  await page.waitForFunction(() => document.querySelector('#workflow-select').options.length === 42);
  assert.equal(await page.locator('#workflow-select').inputValue(), 'wf_fixture');
  assert.equal(await page.locator('#workflow-evidence').inputValue(), 'Keep this selected workflow draft.');
  assert.ok(reads.slice(recentReads).includes('/api/workflows/wf_fixture'));
  assert.equal(writes.length, writesBeforeRefresh);
  omitSelected = false;
  await page.locator('#workflow-refresh').click();
  await page.waitForFunction(() => document.querySelector('#workflow-select').options.length === 3);
  delayList=true; await page.locator('#workflow-refresh').click();
  for(let i=0;i<100&&!releaseList;i++) await new Promise(r=>setTimeout(r,10));
  assert.ok(releaseList); await page.locator('#workflow-select').selectOption('wf_other');
  await page.locator('#workflow-phase').filter({hasText:'complete'}).waitFor(); releaseList();
  assert.equal(await page.locator('#workflow-evidence').inputValue(), '', 'explicit selection clears the prior draft');
  await page.evaluate(()=>Promise.resolve());
  assert.equal(await page.locator('#workflow-select').inputValue(),'wf_other');
  await page.locator('#workflow-select').selectOption('wf_fixture');
  await page.locator('[data-workflow-action="claim_pipeline_revision"]').waitFor();
  delayRead = true; await page.locator('#workflow-refresh').click();
  for (let i=0;i<100&&!releaseRead;i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(releaseRead);
  delayClaim = true;
  await page.locator('[data-workflow-action="claim_pipeline_revision"]').focus();
  await page.keyboard.press('Enter');
  for (let i=0;i<100&&!releaseClaim;i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(releaseClaim);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'workflow-status', 'pending action keeps keyboard focus in context');
  await page.locator('#tasks-close-btn').click(); releaseClaim();
  for (let i=0;i<100&&workflow.phase!=='revising';i++) await new Promise(r => setTimeout(r, 10));
  await page.locator('#tasks-btn').click();
  await page.locator('#workflow-phase').filter({ hasText:'revising' }).waitFor();
  releaseRead(); await page.evaluate(() => Promise.resolve());
  assert.match(await page.locator('#workflow-phase').innerText(), /revising/);
  const complete = page.locator('[data-workflow-action="complete_pipeline_revision"]');
  assert.equal(await complete.isEnabled(), true, 'late claim token remains in memory across panel close');
  assert.equal(await page.locator('#workflow-token').inputValue(), '');
  assert.doesNotMatch(await page.locator('#staged-workflows').innerText(), /fixture-private-lease-token/);
  assert.equal(await page.evaluate(() => Object.values(localStorage).some(v => v.includes('fixture-private-lease-token'))), false);
  delayRenew = true;
  await page.locator('[data-workflow-action="renew_pipeline_writer_lease"]').focus();
  await page.keyboard.press('Enter');
  for (let i=0;i<100&&!releaseRenew;i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(releaseRenew);
  await page.locator('#workflow-evidence').fill('Keep editing while the renewal completes.');
  releaseRenew();
  await page.locator('#workflow-status').filter({ hasText:'refreshed' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'workflow-evidence', 'response does not steal editor focus');
  assert.equal(await page.locator('#workflow-evidence').inputValue(), 'Keep editing while the renewal completes.');
  assert.equal(writes.at(-1).body.leaseMs, 14400000);
  await page.locator('#workflow-evidence').fill('Fixture corrective evidence.');
  await page.locator('#workflow-token').fill('wrong-token'); await complete.focus(); await page.keyboard.press('Enter');
  await page.locator('#workflow-status').filter({hasText:'Lease token rejected'}).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'workflow-status', 'rejected action retains keyboard context');
  await page.locator('#workflow-token').fill('fixture-private-lease-token');
  assert.equal(await complete.isEnabled(),true,'confirmed rejection permits correcting the token');
  await complete.focus(); await page.keyboard.press('Enter');
  await page.locator('#workflow-phase').filter({ hasText:'revision_ready' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'workflow-status', 'removed completed action leaves a stable focus target');
  assert.equal(writes.at(-1).body.leaseToken, 'fixture-private-lease-token');
  assert.match(await page.locator('#workflow-notice').innerText(), /fresh final review/);
  assert.equal(await page.locator('#workflow-copy-token').isEnabled(), false);
  const finalReview = page.locator('[data-workflow-action="start_pipeline_final_review"]');
  assert.equal(await finalReview.isEnabled(), true);
  await finalReview.click(); await page.locator('#workflow-phase').filter({hasText:'final_reviewing'}).waitFor();
  workflow.phase = 'revising'; actions = []; blockedActions = [{ code:'LEASE_EXPIRED' }];
  await page.locator('#workflow-refresh').click(); await page.locator('#workflow-notice').filter({hasText:'LEASE_EXPIRED'}).waitFor();
  assert.equal(await page.locator('[data-workflow-action]').count(), 0);
  for (const width of [390,640]) {
    await page.setViewportSize({ width, height:844 });
    for (const selector of ['#workflow-select','#workflow-token','#workflow-evidence']) {
      const bounds = await page.locator(selector).boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `${selector} fits ${width}px`);
    }
  }
  if (process.env.RELAYBRIDGE_UI_SCREENSHOT_DIR) {
    fs.mkdirSync(process.env.RELAYBRIDGE_UI_SCREENSHOT_DIR, {recursive:true});
    await page.screenshot({path:path.join(process.env.RELAYBRIDGE_UI_SCREENSHOT_DIR,'staged-workflow.png')});
  }
  await page.locator('#workflow-evidence').fill('Evidence from the prior run');
  await page.locator('#workflow-token').fill('Token from the prior run');
  workflow.profile='codex-claude'; workflow.phasePolicy=null; actions=['submit_pipeline_research'];
  await page.locator('#staged-workflows .task-composer > details > summary').click();
  await page.locator('#workflow-create').click();
  await page.locator('#workflow-status').filter({hasText:'did not confirm'}).waitFor();
  assert.equal(await page.locator('#workflow-evidence').inputValue(),'');
  assert.equal(await page.locator('#workflow-token').inputValue(),'');
  assert.equal(await page.locator('[data-workflow-action]:visible').count(),0);
  await page.locator('#workflow-refresh').click();
  await page.locator('#workflow-notice').filter({hasText:'verified Astra'}).waitFor();
  assert.equal(await page.locator('[data-workflow-action]').count(),0);
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
});
