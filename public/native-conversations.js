(function(root, factory) {
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else {
    root.NativeConversations = exported;
    root.RBNative = exported.create(root, root.document.currentScript?.nonce || '');
    root.RBNative.refresh();
    root.setInterval(() => { if (!root.document.hidden) root.RBNative.refresh(); }, 3000);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const KEY = 'rb:native:selection';
  function definitions(config) {
    return Object.entries(config || {}).flatMap(([kind, provider]) => {
      const meta = provider?.workspaceConversation;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(kind) || kind.startsWith('_') || !meta || typeof meta !== 'object' || Array.isArray(meta)
        || typeof meta.title !== 'string' || !meta.title.trim() || typeof meta.cwd !== 'string' || !meta.cwd.trim()) return [];
      return [{ kind, title:meta.title.slice(0,200), cwd:meta.cwd,
        description:typeof meta.description === 'string' ? meta.description.slice(0,1000) : '',
        collabId:typeof meta.collabId === 'string' && /^c_[A-Za-z0-9_-]+$/.test(meta.collabId) ? meta.collabId : null }];
    });
  }
  // xterm creates style elements for its renderer. Give only its document
  // facade this response's nonce; never weaken CSP or patch the global DOM.
  // xterm's CoreBrowserService.mainDocument bug ignores documentOverride, so a
  // style element created against the real document can still be appended to a
  // facade-created element (e.g. the screen element). Wrapping appendChild on
  // facade-created nodes lets us nonce that style before it enters the DOM,
  // without touching Node.prototype or the global document.
  function terminalDocument(document, nonce) {
    function ownAppendChild(node) {
      const appendChild = node.appendChild.bind(node);
      node.appendChild = child => {
        if (child && child.tagName === 'STYLE') child.nonce = nonce;
        return appendChild(child);
      };
      return node;
    }
    return new Proxy(document, { get(target, key) {
      if (key === 'createElement') return (...args) => {
        const node = target.createElement(...args);
        if (String(args[0]).toLowerCase() === 'style') node.nonce = nonce;
        return ownAppendChild(node);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
  function create(env, nonce) {
    const doc = env.document, $ = id => doc.getElementById(id);
    let active = null, desired = null, entries = [], sessions = [], online = false, token = null, tokenPromise = null;
    let generation = 0, refreshPending = null, connection = null, view = 'live', navSignature = '', historyKey = null;
    const starting = new Set(), uncertain = new Set();
    try { desired = JSON.parse(env.localStorage.getItem(KEY)); } catch {}
    function node(tag, className, text) {
      const n = doc.createElement(tag); if (className) n.className = className; if (text != null) n.textContent = String(text); return n;
    }
    function entry() { return entries.find(e => e.kind === active); }
    function live(kind = active) { return sessions.find(s => s.kind === kind && !s.exited); }
    function persist() { try { if (active) env.localStorage.setItem(KEY, JSON.stringify(active)); else env.localStorage.removeItem(KEY); } catch {} }
    function selectionEvent() { env.dispatchEvent(new env.Event('relaybridge:native-selection')); }
    function notice(text) { $('native-notice').textContent = text || ''; $('native-notice').hidden = !text; }
    async function api(path, options = {}) {
      if (!token) {
        if (!tokenPromise) tokenPromise = env.fetch('/api/capability', { cache:'no-store', signal:env.AbortSignal.timeout(10000) })
          .then(async r => { if (!r.ok) throw Error('Could not connect to RelayBridge.'); return (await r.json()).token; })
          .finally(() => { tokenPromise = null; });
        token = await tokenPromise;
      }
      const r = await env.fetch(path, { ...options, cache:'no-store', signal:env.AbortSignal.timeout(15000),
        headers:{ 'Content-Type':'application/json', 'X-RelayBridge-Token':token, 'X-RelayBridge-Client':'ui' } });
      let body; try { body = await r.json(); } catch { throw Error('The bridge response was not readable.'); }
      if (!r.ok) { if (r.status === 401) token = null; const error = Error(body.error || 'The bridge request failed.'); error.status = r.status; throw error; }
      return body;
    }
    function renderNav() {
      const signature = JSON.stringify([active, entries, sessions.map(s => [s.kind,s.id,s.startedAt,s.exited]),online]);
      if (signature === navSignature) return; navSignature = signature; $('native-list').replaceChildren();
      for (const e of entries) {
        const b = node('button', `nav-item native-conversation-button${e.kind === active ? ' active' : ''}`);
        b.dataset.nativeKind = e.kind; b.setAttribute('aria-current', e.kind === active ? 'page' : 'false');
        b.title = e.title; b.append(node('span', '', '◈'), node('span', '', e.title), node('small', 'native-nav-status', online && live(e.kind) ? 'Live' : 'Saved'));
        b.onclick = () => select(e.kind); $('native-list').append(b);
      }
    }
    function closeConnection() {
      const old = connection; connection = null;
      if (!old) return;
      old.observer?.disconnect(); old.ws.onopen = old.ws.onmessage = old.ws.onclose = old.ws.onerror = null;
      old.input?.dispose(); old.resize?.dispose(); old.ws.close(); old.term.dispose();
      $('native-terminal').replaceChildren();
    }
    function fit() {
      const c = connection;
      if (!c || view !== 'live' || $('native-panel').hidden || !online) return;
      const box = $('native-terminal').getBoundingClientRect();
      if (box.width > 0 && box.height > 0) { try { c.fit.fit(); } catch {} }
    }
    function connected(c) { return c === connection && !!active && online && c.ws.readyState === 1; }
    function openTerminal(session) {
      const key = JSON.stringify([session.kind, session.id, session.startedAt]);
      if (connection?.key === key) return;
      closeConnection();
      if (!env.Terminal || !env.FitAddon || !nonce) { notice('The live conversation could not load. Reload this page to reconnect.'); return; }
      const term = new env.Terminal({ fontSize:14, fontFamily:'Consolas, ui-monospace, monospace', cursorBlink:true,
        scrollback:5000, convertEol:true, disableStdin:true, documentOverride:terminalDocument(doc,nonce),
        theme:{ background:'#171e1a', foreground:'#e6ece5', cursor:'#b9d5bc' } });
      const addon = new env.FitAddon.FitAddon(); term.loadAddon(addon); term.open($('native-terminal'));
      const url = new env.URL('/ws', env.location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('session', session.id); url.searchParams.set('token', token);
      const ws = new env.WebSocket(url.href), c = { key, term, fit:addon, ws, closed:false }; connection = c;
      ws.onopen = () => {
        if (c !== connection) return;
        term.options.disableStdin = !online; notice(null); renderStatus();
        // fit() can run before the socket is open (e.g. requestAnimationFrame below),
        // so a resize that happens pre-open never reaches the pty. Always send the
        // current dimensions here even if they already matched the last fit.
        fit();
        if (connected(c)) ws.send(JSON.stringify({ type:'resize', cols:term.cols, rows:term.rows }));
      };
      ws.onmessage = event => {
        if (c !== connection) return;
        try { const message = JSON.parse(event.data);
          if (message.type === 'data') term.write(message.data);
          if (message.type === 'exit') { session.exited = true; term.options.disableStdin = true; c.closed = true; notice('This conversation has stopped. Resume it to continue.'); renderStatus(); }
        } catch {}
      };
      const disconnected = () => { if (c !== connection) return; c.closed = true; term.options.disableStdin = true; notice('Connection lost. Reconnect to see the latest output; input is never sent again automatically.'); renderStatus(); };
      ws.onerror = ws.onclose = disconnected;
      c.input = term.onData(data => { if (connected(c) && !c.closed) ws.send(JSON.stringify({ type:'input', data })); });
      c.resize = term.onResize(size => { if (connected(c) && !c.closed) ws.send(JSON.stringify({ type:'resize', cols:size.cols, rows:size.rows })); });
      if (env.ResizeObserver) { c.observer = new env.ResizeObserver(fit); c.observer.observe($('native-terminal')); }
      env.requestAnimationFrame(fit);
    }
    function renderStatus() {
      if (!active) return;
      const e = entry(), s = live();
      $('native-status').textContent = !online ? 'Connection unavailable' : !e ? 'Not configured' : !s ? 'Ready to resume'
        : connection?.closed ? 'Disconnected' : connection?.ws.readyState === 1 ? 'Connected' : 'Connecting';
      const button = $('native-resume');
      button.hidden = !!s && !connection?.closed && !uncertain.has(active);
      button.disabled = !online || !e || starting.has(active);
      button.textContent = starting.has(active) ? 'Opening…' : uncertain.has(active) ? 'Check for session' : s ? 'Reconnect' : 'Resume conversation';
    }
    function render() {
      renderNav(); if (!active) return;
      const e = entry();
      $('native-panel').hidden = false; $('project-chat').hidden = true;
      doc.body.classList.add('native-active');
      $('native-title').textContent = e?.title || 'Conversation unavailable'; $('thread-name').textContent = e?.title || 'Conversation unavailable';
      $('project-name').textContent = 'Your conversations'; $('native-description').textContent = e?.description || '';
      $('native-history-button').disabled = !e?.collabId;
      $('native-terminal').hidden = view !== 'live'; $('native-history').hidden = view !== 'history';
      $('native-live-button').setAttribute('aria-pressed', String(view === 'live')); $('native-history-button').setAttribute('aria-pressed', String(view === 'history'));
      if (!online || !e || !live()) { closeConnection(); if (!e) notice('This conversation is no longer configured.'); }
      else openTerminal(live());
      renderStatus();
    }
    function select(kind) {
      if (!entries.some(e => e.kind === kind)) return;
      if (active !== kind) { generation++; closeConnection(); historyKey = null; $('native-history').replaceChildren(); view = 'live'; }
      active = kind; desired = null; persist(); notice(null); render(); selectionEvent(); env.requestAnimationFrame(fit);
    }
    function deactivate() {
      generation++; active = desired = null; persist(); closeConnection();
      $('native-panel').hidden = true; $('project-chat').hidden = false; doc.body.classList.remove('native-active');
      renderNav(); selectionEvent();
    }
    async function refresh() {
      if (refreshPending) return refreshPending;
      refreshPending = (async () => {
        const [configResult, sessionsResult] = await Promise.allSettled([api('/api/config'), api('/api/sessions')]);
        if (configResult.status === 'fulfilled') entries = definitions(configResult.value);
        if (sessionsResult.status === 'fulfilled' && Array.isArray(sessionsResult.value)) sessions = sessionsResult.value;
        online = configResult.status === 'fulfilled' && sessionsResult.status === 'fulfilled' && Array.isArray(sessionsResult.value);
        if (!active && desired && entries.some(e => e.kind === desired)) select(desired);
        else render();
      })().finally(() => { refreshPending = null; });
      return refreshPending;
    }
    async function resume() {
      const kind = active; if (!kind || starting.has(kind) || !online || !entry()) return;
      starting.add(kind); renderStatus();
      try {
        await refresh();
        if (active !== kind || !online || !entry()) return;
        if (uncertain.delete(kind)) { notice(live() ? null : 'No live session was found. Choose Resume conversation to try again.'); render(); return; }
        if (live()) { closeConnection(); render(); return; }
        const e = entry();
        const meta = await api('/api/sessions', { method:'POST', body:JSON.stringify({ kind, cwd:e.cwd, label:e.title, dangerous:false }) });
        sessions = [...sessions.filter(s => s.id !== meta.id), meta];
        if (active === kind) { notice(null); render(); }
      } catch (error) {
        // A network error after POST can hide an accepted launch. Never retry
        // it automatically or recycle project submission identities for PTYs.
        if (!error.status || error.status >= 500) uncertain.add(kind);
        if (active === kind) notice(error.message + ' Check for an existing session before trying again.');
      } finally { starting.delete(kind); renderStatus(); }
    }
    async function history() {
      const e = entry(); if (!e?.collabId) return;
      view = 'history'; render(); if (historyKey === e.collabId) return;
      const guard = generation, kind = active; $('native-history').replaceChildren(node('p','muted','Loading saved history…'));
      try {
        const collab = await api('/api/collabs/' + encodeURIComponent(e.collabId));
        if (guard !== generation || active !== kind || entry()?.collabId !== e.collabId) return;
        const target = $('native-history'); target.replaceChildren(node('p','native-history-note','Saved context from the original conversation. Continue in Live conversation.'));
        for (const message of Array.isArray(collab.transcript) ? collab.transcript : []) {
          const article = node('article',`message ${message.who === 'user' ? 'user' : 'assistant'}`);
          const heading = node('div','message-head'); heading.append(node('strong','',message.who === 'user' ? 'You' : message.who === 'system' ? 'Context' : 'Claude'));
          if (message.timestamp && Number.isFinite(Date.parse(message.timestamp))) heading.append(node('time','',new Date(message.timestamp).toLocaleString()));
          article.append(heading,node('div','message-body',message.text)); target.append(article);
        }
        historyKey = e.collabId;
      } catch (error) { if (guard === generation && active === kind) $('native-history').replaceChildren(node('p','form-error','Saved history could not load: '+error.message)); }
    }
    $('native-live-button').onclick = () => { view = 'live'; render(); env.requestAnimationFrame(fit); };
    $('native-history-button').onclick = history; $('native-resume').onclick = resume;
    env.addEventListener('resize',fit);
    if (typeof desired === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(desired)) {
      active = desired; desired = null; render();
    }
    return { get active() { return active; }, refresh, select, deactivate, resume, history };
  }
  return { create, definitions, terminalDocument };
});
