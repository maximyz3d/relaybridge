'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const state = require('../public/dashboard-state');

test('six unverified executions hold capacity even with no running or queued tasks', () => {
  const model = state.queueStatsModel({ active:0, queued:0, ready:0, deferred:0, blocked:0, uncertain:6, maxConcurrent:3 });
  assert.equal(model.available, 0);
  assert.match(model.summary, /0 running · 0 queued · 6 held · limit 3/);
  assert.match(model.notice, /unverified termination/);
  assert.match(model.notice, /0 slots available/);
  assert.equal('canRecover' in model, false);
});

test('missing and malformed queue evidence never become zero capacity or active conversations', () => {
  for (const stats of [{}, { active:'0', uncertain:null, maxConcurrent:-1 }, { active:NaN, maxConcurrent:3 }]) {
    const model = state.queueStatsModel(stats);
    assert.equal(model.available, null);
    assert.match(model.summary, /unknown/);
  }
  assert.equal(state.queueStatsModel({ active:1, uncertain:0, maxConcurrent:3, conversations:100 }).available, 2);
});

test('queue reasons and lifecycle evidence remain separate from terminal task status', () => {
  for (const reason of ['ready','deferred','dependency','dependency_missing','dependency_failed','admission']) {
    assert.ok(state.queueReasonModel({ status:'queued', queueReason:reason }));
  }
  for (const status of ['cancelled', 'interrupted', 'failed']) {
    const task = { status, execution:{ state:'uncertain' } };
    assert.match(state.taskRowModel(task).reason, /capacity held/);
    assert.equal(state.taskRowModel(task).canCancel, false);
  }
  assert.equal(state.taskRowModel({ status:'queued' }).canCancel, true);
  assert.equal(state.executionStateModel({ execution:{ state:'not_invoked' } }).label, 'Provider was not invoked');
  assert.equal(state.executionStateModel({}).state, 'unknown');
});

test('details retain large output and distinguish failure evidence from approval', () => {
  const output = 'evidence\n'.repeat(1000);
  const model = state.taskDetailModel({ id:'t_fixture', status:'failed', result:output,
    failureClass:'incomplete_response', receiptId:'rcpt_fixture', dependsOn:['t_dependency'],
    correlation:{ requestId:'request_fixture' } }, { explanation:'Provider stopped before a conclusion.' });
  assert.equal(model.output, output);
  assert.match(model.verdictNotice, /NO VERDICT/);
  assert.match(model.outputNotice, /all 9000 characters retained/);
  assert.equal(model.explanation, 'Provider stopped before a conclusion.');
  assert.deepEqual(model.dependsOn, ['t_dependency']);
  assert.match(state.taskDetailModel({ status:'done', result:'Approved' }).verdictNotice, /alone does not establish approval/);
  assert.match(state.taskDetailModel({ status:'done', flags:{ partial_result:true }, result:'Approved' }).verdictNotice, /NO VERDICT/);
  assert.match(state.taskDetailModel({ result:'part', resultChars:100 }).outputNotice, /truncated or is incomplete/);
});

test('panel request gate rejects late and out-of-order snapshots without pretending to fence execution', () => {
  const gate = state.createRequestGate();
  const epoch = gate.open(), first = gate.begin(), newer = gate.begin();
  assert.equal(gate.current(first), false); assert.equal(gate.current(newer), true);
  gate.close(); assert.equal(gate.current(newer), false); assert.equal(gate.isOpen(epoch), false);
  gate.open(); assert.equal(gate.current(newer), false);
  assert.equal(gate.current(gate.begin()), true);
});

// Optional real-browser acceptance, using the actual page and CSP with wholly
// synthetic API responses. No bridge process, provider or capability file is
// opened. Point the module variable at an existing Playwright installation.
test('task UI preserves focus, rejects late refreshes, and submits the previewed tuple', {
  skip: !process.env.RELAYBRIDGE_BROWSER_MODULE, timeout:60000,
}, async t => {
  const fs = require('node:fs'), path = require('node:path');
  const { chromium } = require(process.env.RELAYBRIDGE_BROWSER_MODULE);
  const browser = await chromium.launch({ headless:true,
    ...(process.env.RELAYBRIDGE_BROWSER_EXECUTABLE ? { executablePath:process.env.RELAYBRIDGE_BROWSER_EXECUTABLE } : {}) });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport:{ width:1280, height:900 } });
  const page = await context.newPage();
  await page.clock.install();
  const errors = [], unexpected = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => unexpected.push('WebSocket: ' + socket.url()));
  const root = path.resolve(__dirname, '..'), origin = 'http://relaybridge.test';
  const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8')
    .replace('__ONE_SHOT_DEFAULT_TIMEOUT_MS__', '1200000').replace('<script>', '<script nonce="fixture">');
  const files = { '/dashboard-state.js':'public/dashboard-state.js',
    '/vendor/xterm/lib/xterm.js':'node_modules/@xterm/xterm/lib/xterm.js',
    '/vendor/xterm/css/xterm.css':'node_modules/@xterm/xterm/css/xterm.css',
    '/vendor/xterm-addon-fit/lib/addon-fit.js':'node_modules/@xterm/addon-fit/lib/addon-fit.js' };
  const task = { id:'t_fixture_uncertain', title:'Investigate retained execution evidence', status:'interrupted',
    kind:'claude', createdAt:1788840000000, execution:{ state:'uncertain' }, result:'retained evidence\n'.repeat(500),
    failureClass:'incomplete_response', receiptId:'rcpt_fixture', correlation:{ requestId:'fixture:request' } };
  let listCalls = 0, failList = false, delayAgents = false, releaseAgents = null;
  let delayedList = null, releaseList = null;
  let extraRows = [], delaySubmit = false, releaseSubmit = null, failPlan = false;
  const execution = { version:1, provider:'claude', authorityMode:'safe', model:'fixture-model',
    requestedTaskTier:'standard', resolvedTaskTier:'standard', requestedModelTier:'standard', resolvedModelTier:'standard',
    requestedEffort:null, targetEffort:'medium', appliedEffort:'medium', effortSource:'task_tier',
    effortMethod:'flag', effortControl:'--effort', effortFallbackReason:null, configFingerprint:'fixture' };
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    const json = body => route.fulfill({ status:200, contentType:'application/json', body:JSON.stringify(body) });
    if (url.origin !== origin) { unexpected.push(req.url()); return route.abort(); }
    if (url.pathname === '/') return route.fulfill({ status:200, contentType:'text/html', body:html,
      headers:{ 'Content-Security-Policy':"default-src 'self'; script-src 'self' 'nonce-fixture'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'" } });
    if (files[url.pathname]) return route.fulfill({ status:200,
      contentType:url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
      body:fs.readFileSync(path.join(root, files[url.pathname])) });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status:204 });
    if (req.method() === 'POST') {
      const body = req.postDataJSON(); writes.push({ path:url.pathname, body });
      if (url.pathname === '/api/plan') return failPlan
        ? route.fulfill({ status:409, contentType:'application/json', body:'{"error":"provider no longer available"}' })
        : json({ tier:'standard', primary:{ kind:'claude', ready:true, execution } });
      if (url.pathname === '/api/tasks') {
        if (delaySubmit) await new Promise(resolve => { releaseSubmit = resolve; });
        return json({ id:'t_fixture_submitted', status:'queued' });
      }
      unexpected.push(req.method() + ' ' + url.pathname); return route.fulfill({ status:405 });
    }
    if (url.pathname === '/api/capability') return json({ token:'1'.repeat(64) });
    if (url.pathname === '/api/config') return json({ claude:{ label:'Claude fixture', color:'#4ea1ff' } });
    if (url.pathname === '/api/permissions') return json({ fullPermissions:false });
    if (url.pathname === '/api/workspace') return json({ defaultCwd:'/fixture', allowedRoots:['/fixture'] });
    if (url.pathname === '/api/sessions') return json([]);
    if (url.pathname === '/api/health') return json({ version:'fixture', capabilityAuth:true, ptyMode:'none', activeOneShotCount:0 });
    if (url.pathname === '/api/telemetry') return json({ totals:{ ui:0, mcp:0 } });
    if (url.pathname === '/api/diag') return json({ results:{} });
    if (url.pathname === '/api/agents') {
      if (delayAgents) await new Promise(resolve => { releaseAgents = resolve; });
      return json({ agents:[{ id:'claude', label:'Claude fixture' }] });
    }
    if (url.pathname === '/api/tasks') {
      listCalls++;
      if (failList) return route.fulfill({ status:503, contentType:'application/json', body:'{"error":"fixture offline"}' });
      const response = { tasks:[{ ...task, result:undefined, resultChars:task.result.length }, ...extraRows],
        stats:{ active:0, queued:0, ready:0, deferred:0, blocked:0, uncertain:6, maxConcurrent:3 } };
      if (delayedList) { response.tasks[0].title = delayedList; delayedList = null; await new Promise(resolve => { releaseList = resolve; }); }
      return json(response);
    }
    if (url.pathname === '/api/tasks/' + task.id) return json(task);
    unexpected.push(req.method() + ' ' + url.pathname); return route.fulfill({ status:404 });
  });
  await page.goto(origin);
  await page.locator('#status-version').filter({ hasText:'fixture' }).waitFor();
  await page.locator('#tasks-btn').click();
  await page.locator('#tasks-stats').filter({ hasText:'6 held' }).waitFor();
  const screenshotDir = process.env.RELAYBRIDGE_UI_SCREENSHOT_DIR;
  if (screenshotDir) { fs.mkdirSync(screenshotDir, { recursive:true }); await page.screenshot({ path:path.join(screenshotDir, 'tasks-desktop.png') }); }
  assert.equal(await page.locator('[data-task-cancel]:visible').count(), 0);
  const view = page.locator('[data-task-open]');
  await view.focus(); await page.evaluate(() => refreshTasks());
  assert.equal(await view.evaluate(el => el === document.activeElement), true);
  failList = true; await page.evaluate(() => refreshTasks());
  assert.equal(await view.evaluate(el => el === document.activeElement), true);
  assert.match(await page.locator('#tasks-refresh-status').innerText(), /stale/); failList = false;
  delayedList = 'STALE RESPONSE MUST NOT WIN';
  await page.evaluate(() => { void refreshTasks(); });
  await page.waitForFunction(() => true); // let the routed request enter its bounded hold
  for (let i = 0; i < 20 && !releaseList; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(releaseList); await page.evaluate(() => refreshTasks()); releaseList();
  await page.evaluate(() => refreshTasks());
  assert.doesNotMatch(await page.locator('#tasks-rows').innerText(), /STALE RESPONSE/);
  await view.click();
  await page.locator('#task-detail-output').filter({ hasText:'retained evidence' }).waitFor();
  assert.equal(await page.locator('#task-detail-output').textContent(), task.result);
  assert.match(await page.locator('#task-detail-verdict').innerText(), /NO VERDICT/);
  assert.equal(await page.locator('#task-detail-heading').evaluate(el => el === document.activeElement), true);
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.querySelector('#task-detail-dialog').contains(document.activeElement)), true);
  }
  if (screenshotDir) await page.screenshot({ path:path.join(screenshotDir, 'task-details.png') });
  await page.keyboard.press('Escape');
  assert.equal(await view.evaluate(el => el === document.activeElement), true);
  await page.locator('#task-prompt').fill('Explain the bounded fixture result.');
  await page.locator('#task-preview').click(); await page.locator('#task-plan').waitFor({ state:'visible' });
  assert.equal(writes.filter(item => item.path === '/api/tasks').length, 0);
  failPlan = true; await page.locator('#task-preview').click();
  await page.locator('#task-submit-status').filter({ hasText:'Preview failed' }).waitFor();
  assert.equal(await page.locator('#task-plan').isVisible(), false);
  assert.equal(await page.locator('#task-submit').innerText(), 'Submit task');
  failPlan = false; await page.locator('#task-preview').click(); await page.locator('#task-plan').waitFor({ state:'visible' });
  await page.locator('#task-submit').click();
  await page.locator('#task-submit-status').filter({ hasText:'Submitted t_fixture' }).waitFor();
  assert.deepEqual(writes.find(item => item.path === '/api/tasks').body.execution, execution);
  assert.equal(writes.find(item => item.path === '/api/tasks').body.dangerous, false);
  // A prior submission must not clear a new draft with the same prompt text.
  delaySubmit = true; await page.locator('#task-prompt').fill('Retain this new draft.');
  await page.locator('#task-submit').click();
  for (let i = 0; i < 20 && !releaseSubmit; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(releaseSubmit); await page.locator('#task-collab').fill('a-different-conversation');
  await page.locator('#task-preview').click(); await page.locator('#task-plan').waitFor({ state:'visible' });
  releaseSubmit(); await page.waitForFunction(() => !document.querySelector('#task-submit').disabled);
  assert.equal(await page.locator('#task-prompt').inputValue(), 'Retain this new draft.');
  assert.equal(await page.locator('#task-plan').isVisible(), true);
  extraRows = ['A','B'].map(id => ({ ...task, id:'t_fixture_' + id, title:id, status:'queued', execution:{ state:'never_started' } }));
  await page.evaluate(() => refreshTasks()); await page.locator('#task-filter').selectOption('queued');
  const focusedB = page.locator('[data-task-open="t_fixture_B"]'); await focusedB.focus();
  extraRows[0].status = 'done'; await page.evaluate(() => refreshTasks());
  assert.equal(await focusedB.evaluate(el => el === document.activeElement), true);
  await page.locator('#task-filter').selectOption('');
  for (const width of [390, 640]) {
    await page.setViewportSize({ width, height:844 });
    for (const selector of ['#task-prompt', '#task-preview', '#task-submit', '#tasks-close-btn']) {
      const bounds = await page.locator(selector).boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `${selector} fits ${width}px`);
    }
    if (screenshotDir) await page.screenshot({ path:path.join(screenshotDir, `tasks-${width}.png`) });
  }
  await page.locator('#tasks-close-btn').click();
  const callsBeforeOpen = listCalls;
  delayAgents = true; await page.locator('#tasks-btn').click();
  for (let i = 0; i < 20 && !releaseAgents; i++) await new Promise(resolve => setTimeout(resolve, 10));
  for (let i = 0; i < 20 && listCalls === callsBeforeOpen; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(listCalls > callsBeforeOpen);
  assert.ok(releaseAgents); await page.locator('#tasks-close-btn').click(); releaseAgents();
  await page.evaluate(() => Promise.resolve());
  const callsAfterClose = listCalls; await page.clock.runFor(4100);
  assert.equal(listCalls, callsAfterClose, 'late agent response must not leave a task poller after close');
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  assert.ok(writes.every(item => ['/api/plan','/api/tasks'].includes(item.path)));
});
