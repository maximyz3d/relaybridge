(function (root) {
  'use strict';
  root.createRelayBridgeWorkflowPanel = function ({ api, dashboard, document }) {
    const $ = selector => document.querySelector(selector);
    const panel = $('#staged-workflows'), list = $('#workflow-select');
    const listGate = dashboard.createRequestGate(), detailGate = dashboard.createRequestGate();
    const leases = new Map(), uncertainActions = new Set();
    let selected = '', snapshot = null, busy = false, creating = false;
    const visible = () => panel.open && $('#tasks-dialog').open && detailGate.isOpen();
    const status = message => { if (visible()) $('#workflow-status').textContent = message; };
    const setText = (id, text) => { $(id).textContent = text; };
    function render() {
      if (!visible()) return;
      const model = dashboard.workflowDetailModel(snapshot || {});
      $('#workflow-detail').hidden = !snapshot;
      $('#workflow-create').disabled = creating || busy;
      list.disabled = creating || busy;
      $('#workflow-refresh').disabled = creating || busy;
      if (!snapshot) return;
      setText('#workflow-phase', `${model.phase} · ${model.profile} · ${model.permissionMode || 'unknown permissions'}`);
      setText('#workflow-workspace', model.cwd);
      setText('#workflow-objective-view', model.objective);
      setText('#workflow-writer', model.writer + (model.expiresAt === null ? '' : ' · expires ' + new Date(model.expiresAt).toLocaleString()));
      setText('#workflow-notice', model.notice + (model.blocked.length ? ' Ownership held: ' + model.blocked.join(', ') + '. Independent recovery evidence is required.' : '')
        + (model.unsupportedActions.length ? ' Continue through the existing client: ' + model.unsupportedActions.join(', ') + '.' : ''));
      setText('#workflow-review', model.review || 'No saved review verdict.');
      const actions = $('#workflow-actions');
      const focused = document.activeElement?.dataset?.workflowAction;
      actions.replaceChildren();
      for (const action of model.actions) {
        const button = document.createElement('button'); button.className = 'btn';
        button.textContent = action.label; button.dataset.workflowAction = action.name;
        const reason = action.blocked || (action.token && !leases.get(selected)?.leaseToken ? 'Enter the matching writer lease token.' : '')
          || (uncertainActions.has(selected + ':' + action.name) ? 'The last response was uncertain; inspect the saved workflow before any replacement.' : '');
        button.disabled = busy || creating || !!reason; button.title = reason;
        button.addEventListener('click', () => void act(action)); actions.append(button);
      }
      if (focused) [...actions.children].find(button => button.dataset.workflowAction === focused && !button.disabled)?.focus({ preventScroll:true });
      $('#workflow-token').placeholder = leases.has(selected) ? 'Writer token retained in this page' : 'Paste the token returned by your lease claim';
      $('#workflow-copy-token').disabled = !leases.has(selected);
    }
    async function select(runId) {
      listGate.begin(); detailGate.begin();
      selected = runId; snapshot = null;
      $('#workflow-token').value = ''; $('#workflow-evidence').value = '';
      render();
      if (!runId || !visible()) return;
      return refreshDetail();
    }
    async function refreshDetail() {
      if (!selected || !visible() || busy) return;
      const runId = selected, ticket = detailGate.begin();
      try {
        const data = await api('/api/workflows/' + encodeURIComponent(runId));
        if (!detailGate.current(ticket) || selected !== runId) return;
        if (data.workflow?.runId !== runId) throw new Error('Workflow identity mismatch');
        snapshot = data; render(); status('Saved state refreshed. No task was dispatched.');
      } catch (error) {
        if (detailGate.current(ticket) && selected === runId) { snapshot = null; render(); status('Workflow unavailable: ' + error.message); }
      }
    }
    async function refreshList(preferred = selected) {
      if (!visible() || busy) return;
      const ticket = listGate.begin();
      try {
        const data = await api('/api/workflows?limit=40');
        if (!listGate.current(ticket)) return;
        if (!Array.isArray(data.workflows)) throw new Error('Incomplete workflow list');
        list.replaceChildren(new Option('Select a saved workflow', ''));
        for (const item of data.workflows.slice(0, 40)) {
          if (typeof item.runId !== 'string') continue;
          list.append(new Option(`${item.phase} · ${item.runId}`, item.runId));
        }
        if ([...list.options].some(option => option.value === preferred)) list.value = preferred;
        else list.value = '';
        if (selected !== list.value) await select(list.value);
        else await refreshDetail();
        if (!list.value) status('Select a workflow or create one. Loading does not dispatch work.');
      } catch (error) { if (listGate.current(ticket)) status('Workflow list unavailable: ' + error.message); }
    }
    async function act(action) {
      const current = dashboard.workflowDetailModel(snapshot || {}).actions.find(item => item.name === action.name);
      if (!current || current.blocked || snapshot?.workflow?.runId !== selected || busy || creating || !visible() || uncertainActions.has(selected + ':' + action.name)) return;
      const runId = selected, lease = leases.get(runId);
      if (action.token && !lease?.leaseToken) return;
      const markdown = $('#workflow-evidence').value;
      if (action.evidence && !markdown.trim()) { status('Add the bounded evidence for this stage first.'); return; }
      const body = { ...(action.evidence ? { markdown } : {}),
        ...(action.token ? { actor:lease.actor || snapshot.workflow.writerLease?.actor || 'codex', leaseToken:lease.leaseToken } : {}),
        ...(action.claim || action.renew ? { leaseMs:14400000 } : {}) };
      busy = true; listGate.begin(); detailGate.begin(); render(); status(action.label + '…');
      let succeeded = false;
      try {
        const data = await api('/api/workflows/' + encodeURIComponent(runId) + '/' + action.path, { method:'POST', body:JSON.stringify(body) });
        // Retain ownership even if the panel closed or selected another run
        // while the claim was in flight. Rendering has a separate identity gate.
        if (typeof data.lease?.leaseToken === 'string') leases.set(runId, { actor:data.lease.actor, leaseToken:data.lease.leaseToken });
        if (action.token && !action.renew) leases.delete(runId);
        succeeded = true;
      } catch (error) {
        if (!Number.isInteger(error.status) || error.status >= 500) uncertainActions.add(runId + ':' + action.name);
        if (selected === runId) status('Action response unavailable: ' + error.message + '. Refresh saved state; the action will not be repeated automatically.');
      } finally {
        busy = false;
        if (visible()) {
          if (succeeded) { if (selected === runId) $('#workflow-token').value = ''; await refreshDetail(); }
          else render();
        }
      }
    }
    async function create() {
      if (creating || busy || !visible()) return;
      const cwd = $('#workflow-cwd').value.trim(), objective = $('#workflow-objective').value.trim(), acceptance = $('#workflow-acceptance').value.trim();
      if (!cwd || !objective || !acceptance) { status('Workspace, objective and acceptance criteria are required.'); return; }
      const full = $('#workflow-write-consent').checked;
      const body = { cwd, objective, acceptance, profile:$('#workflow-profile').value,
        permissionMode:full ? 'full' : 'safe', acknowledgeFilesystemWrites:full };
      creating = true; render(); status('Creating the workflow record…');
      try {
        const data = await api('/api/workflows', { method:'POST', body:JSON.stringify(body) });
        const runId = data.workflow?.runId;
        if (typeof runId !== 'string') throw new Error('No workflow identity returned');
        selected = runId; snapshot = null; detailGate.begin();
        if (data.workflow.profile !== body.profile || !dashboard.workflowDetailModel(data).astraPolicy) throw new Error('The server did not confirm the requested Astra/ultra policy; no advisor action is enabled');
        if (visible()) { await refreshList(runId); status('Created ' + runId + '. Submit research when it is ready.'); }
      } catch (error) { status('Creation response unavailable: ' + error.message + '. Refresh the list before trying again.'); }
      finally { creating = false; render(); }
    }
    function open() { listGate.open(); detailGate.open(); snapshot = null; render(); void refreshList(); }
    function close() { listGate.close(); detailGate.close(); snapshot = null; }
    panel.addEventListener('toggle', () => panel.open && $('#tasks-dialog').open ? open() : close());
    list.addEventListener('change', () => void select(list.value));
    $('#workflow-refresh').addEventListener('click', () => void refreshList());
    $('#workflow-create').addEventListener('click', () => void create());
    $('#workflow-copy-token').addEventListener('click', async () => {
      const lease = leases.get(selected);
      if (!lease?.leaseToken) return;
      try { await root.navigator.clipboard.writeText(lease.leaseToken); status('Writer token copied. Share it only with the authorized writer.'); }
      catch { status('Clipboard unavailable. Continue from this page or the client that claimed the lease.'); }
    });
    $('#workflow-token').addEventListener('input', () => {
      const token = $('#workflow-token').value.trim();
      if (selected && token) leases.set(selected, { actor:snapshot?.workflow?.writerLease?.actor || 'codex', leaseToken:token });
      else if (selected) leases.delete(selected);
      render();
    });
    return { close, reopen() { if (panel.open) open(); } };
  };
})(typeof globalThis === 'object' ? globalThis : this);
