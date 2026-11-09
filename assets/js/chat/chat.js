/* Ask your data, shared by the tab and the right-click side panel: how the page reaches GitHub Copilot, and how an answer
   is drawn as it streams in.

   Transport. Opened from copilot/server.py (local), the page and the chat API share an origin. In the Fabric app, the
   page talks to the chat relay (an Azure Container App) with a chat ticket from the app's `chatTicket` function, and
   runs each DAX query the relay sends back through the app's `dax` function (window.RayfinBridge, Fabric build only).
   Anywhere else (file://, a plain static server) there is no chat and Chat.available is false.

   Answers stream as NDJSON events: text deltas, tool steps, figures (`chart`), and `page_request`s that the page
   answers (drawing a dashboard figure, or running DAX in the Fabric app). Figures draw straight into the answer with
   the template library (assets/figures), Vega-Lite (loaded on first use) or, for custom HTML, a sandboxed iframe. */
(function () {
  'use strict';
  const App = window.App;
  const esc = App.esc;

  const Chat = (window.Chat = { available: false, mode: null, settings: {}, listeners: new Set() });
  const store_ = {
    get: (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } },
    set: (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
  };
  Chat.settings = { model: store_.get('cms-chat-model', null), effort: store_.get('cms-chat-effort', null) };
  Chat.setSetting = (k, v) => { Chat.settings[k] = v; store_.set(`cms-chat-${k}`, v); emitChange(); };
  const emitChange = () => Chat.listeners.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
  Chat.onChange = (fn) => { Chat.listeners.add(fn); return () => Chat.listeners.delete(fn); };

  // ---- transport ------------------------------------------------------------------------------------------------
  const Bridge = () => window.RayfinBridge || null;
  let ticket = null;
  async function getTicket(force) {
    if (!force && ticket && ticket.expiresAt * 1000 - Date.now() > 120000) return ticket;
    const t = await Bridge().call('chatTicket');
    ticket = typeof t === 'string' ? JSON.parse(t) : t;
    return ticket;
  }
  const base = () => (Chat.mode === 'relay' ? ticket.chatUrl : '');
  async function request(path, init = {}, retry = true) {
    const headers = { ...(init.headers || {}) };
    if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (Chat.mode === 'relay') headers['X-Chat-Ticket'] = (await getTicket()).ticket;
    const res = await fetch(base() + path, { ...init, headers, credentials: Chat.mode === 'relay' ? 'omit' : 'same-origin' });
    if (res.status === 401 && retry && Chat.mode === 'relay') {
      const body = await res.clone().json().catch(() => ({}));
      if (body.code === 'ticket') { await getTicket(true); return request(path, init, false); }
    }
    return res;
  }
  async function json(path, body) {
    const res = await request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || res.statusText); e.code = data.code; e.status = res.status; throw e; }
    return data;
  }
  Chat.json = json;

  Chat.ready = (async () => {
    if (Bridge()) { Chat.mode = 'relay'; Chat.available = true; return true; }
    if (!/^https?:$/.test(location.protocol)) return false;
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      const h = r.ok ? await r.json() : null;
      if (h && h.mode === 'local') { Chat.mode = 'local'; Chat.available = true; return true; }
    } catch (e) { /* no chat server here */ }
    return false;
  })();

  // Who is signed in: {mode, github: {login} | null, accounts (local), user (relay), fabric}
  Chat.me = async function () {
    if (Chat.mode === 'relay') {
      if (!(await Bridge().ready)) return { mode: 'relay', fabric: false, github: null };
      try { await getTicket(); } catch (e) { return { mode: 'relay', fabric: true, github: null, error: e.message }; }
    }
    const me = await json('/api/me');
    Chat.login = me.github ? me.github.login : null;
    return { ...me, fabric: true };
  };
  Chat.signInFabric = async () => { await Bridge().signIn(); emitChange(); };
  Chat.chooseAccount = async (id) => { await json('/api/signin', { id }); Chat.models = null; emitChange(); };
  Chat.addToken = async (token, remember) => { await json('/api/accounts/add', { token, remember }); Chat.models = null; emitChange(); };
  Chat.signOut = async () => { await json('/api/signout', {}); Chat.login = null; Chat.models = null; Object.values(chats).forEach((c) => (c.id = null)); emitChange(); };
  // Relay: GitHub sign-in in a popup. The window opens straight away (inside the click), then goes to the relay.
  Chat.signInGitHub = function () {
    const w = window.open('about:blank', 'cms-github', 'width=520,height=720');
    return new Promise((resolve, reject) => {
      let poll = 0;
      const done = (ok, err) => { window.removeEventListener('message', onMsg); clearInterval(poll); emitChange(); if (ok) resolve(); else reject(new Error(err || 'GitHub sign-in did not finish.')); };
      const onMsg = (e) => {
        if (!ticket || e.origin !== new URL(ticket.chatUrl).origin || !e.data || e.data.type !== 'cms-github') return;
        Chat.models = null;
        done(e.data.ok, 'GitHub sign-in was cancelled.');
      };
      window.addEventListener('message', onMsg);
      poll = setInterval(() => { if (!w || w.closed) done(false, 'The sign-in window was closed.'); }, 800);
      getTicket(true).then((t) => {
        if (w) w.location.href = `${t.chatUrl}/auth/github/start?origin=${encodeURIComponent(location.origin)}&ticket=${encodeURIComponent(t.ticket)}`;
      }).catch((e) => { if (w) w.close(); done(false, e.message); });
    });
  };
  Chat.loadModels = async function () {
    if (!Chat.models) Chat.models = await json('/api/models');
    const M = Chat.models;
    if (!Chat.settings.model || !M.models.some((m) => m.id === Chat.settings.model)) Chat.settings.model = M.default;
    const cur = M.models.find((m) => m.id === Chat.settings.model);
    if (cur && cur.efforts.length && !cur.efforts.includes(Chat.settings.effort)) Chat.settings.effort = cur.efforts.includes(M.default_effort) ? M.default_effort : cur.default_effort;
    if (cur && !cur.efforts.length) Chat.settings.effort = null;
    return M;
  };

  // ---- libraries, loaded when an answer first needs them ------------------------------------------------------------
  const loaded = new Map();
  function script(src) {
    if (!loaded.has(src)) {
      loaded.set(src, new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src; s.async = false;
        s.onload = resolve; s.onerror = () => reject(new Error(`Could not load ${src}`));
        document.head.appendChild(s);
      }));
    }
    return loaded.get(src);
  }
  // Two-letter codes on the US state shapes (us-atlas uses FIPS ids), as copilot/tools.py does for the validator
  const FIPS = { '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY', '60': 'AS', '66': 'GU', '69': 'MP', '72': 'PR', '78': 'VI' };
  let shapes = null;
  function usStates() {
    if (!shapes) {
      shapes = Promise.all([script('assets/vendor/vega/topojson-client.min.js'), fetch('assets/vendor/vega/us-states-10m.json').then((r) => r.json())])
        .then(([, topo]) => {
          topo.objects.states.geometries.forEach((g) => { g.properties.abbr = FIPS[g.id] || ''; });
          window.US_STATES = topo;
          return topo;
        });
    }
    return shapes;
  }
  Chat.figures = () => Promise.all([
    script('assets/figures/core.js'), script('assets/figures/compare.js'), script('assets/figures/time.js'), script('assets/figures/geo.js'),
    script('assets/figures/dist.js'), script('assets/figures/position.js'), script('assets/figures/change.js'), script('assets/figures/parts.js'),
    script('assets/figures/maps.js'), script('assets/js/chat/caremap.js'), usStates(),
  ]);
  const vegaLibs = () => Promise.all([script('assets/vendor/vega/vega.min.js'), script('assets/vendor/vega/vega-lite.min.js'),
    script('assets/vendor/vega/vega-embed.min.js'), script('assets/vendor/vega/vega-interpreter.js'), usStates()]);
  // The hospital locations ship with the dashboard (the street map uses them); dot_map places hospitals with them
  const locations = () => (window.CMS_LOCATIONS ? Promise.resolve() : script('assets/hospital-locations.js'));

  // ---- markdown (headings, lists, tables, code, bold, italic, links) ------------------------------------------------
  function inline(s) {
    return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((#[\w-]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  function md(src) {
    const lines = String(src || '').replace(/\r/g, '').split('\n'), out = [];
    for (let i = 0; i < lines.length;) {
      const l = lines[i];
      if (/^```/.test(l)) {
        const buf = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++; out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`); continue;
      }
      let m;
      if ((m = l.match(/^(#{1,4})\s+(.*)/))) { out.push(`<h4>${inline(m[2])}</h4>`); i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] || '')) {
        const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = cells(l); i += 2; const body = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) body.push(cells(lines[i++]));
        out.push(`<div class="table-wrap"><table class="data-table"><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${
          body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
        const ordered = /^\s*\d+\./.test(l), items = [];
        while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
        continue;
      }
      if (!l.trim()) { i++; continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s|\s*\|)/.test(lines[i])) para.push(lines[i++]);
      if (!para.length) para.push(lines[i++]);
      out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    }
    return out.join('');
  }
  Chat.md = md;

  // ---- one conversation per surface (the tab, the side panel) -------------------------------------------------------
  // Each also carries its saved chat (history: {id, turns, origin, folder_id}), its Copilot session, and, for a chat
  // reopened from history, what the server needs to pick it up again (resume: {session_id, transcript}).
  const chats = {};
  Chat.conversation = function (surface) {
    if (!chats[surface]) chats[surface] = { surface, id: null, busy: false, adopt: false, history: null, sessionId: null, resume: null, model: null };
    return chats[surface];
  };
  Chat.reset = function (surface) {
    const c = Chat.conversation(surface);
    if (c.busy) Chat.stop(surface);
    Object.assign(c, { id: null, history: null, sessionId: null, resume: null });
  };

  // ---- saved chats --------------------------------------------------------------------------------------------------
  // The local server keeps them in DuckDB (copilot/history.py, /api/history); the Fabric app in Rayfin Data and a
  // lakehouse (window.RayfinBridge.history). Both offer the same calls.
  async function call(method, path, body) {
    const res = await request(path, body === undefined ? { method } : { method, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }
  const LocalStore = {
    list: () => call('GET', '/api/history'),
    createFolder: (name, parentId) => call('POST', '/api/history/folders', { name, parent_id: parentId || null }),
    updateFolder: (id, patch) => call('PATCH', `/api/history/folders/${id}`, patch),
    deleteFolder: (id) => call('DELETE', `/api/history/folders/${id}`),
    getChat: (id) => call('GET', `/api/history/chats/${id}`),
    updateChat: (id, patch) => call('PATCH', `/api/history/chats/${id}`, patch),
    deleteChat: (id) => call('DELETE', `/api/history/chats/${id}`),
    saveTurn: (id, chat, turn) => call('POST', `/api/history/chats/${id}/turns`, { chat, turn }),
  };
  Chat.store = () => (Chat.mode === 'local' ? LocalStore : (Bridge() && Bridge().history) || null);
  Chat.historyChanged = () => document.dispatchEvent(new CustomEvent('chat-history'));
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(32, '0').slice(0, 32));
  const MARKS = /^[ \t]*\[\[[^\]\n]*\]\][ \t]*$/gm;
  // The answer's own text: its last message, without the figure markers
  const answerText = (events) => {
    const msgs = events.filter((e) => e.type === 'message' && e.text);
    return msgs.length ? msgs[msgs.length - 1].text.replace(MARKS, '').replace(/\n{3,}/g, '\n\n').trim() : '';
  };
  // What the server is told when a saved chat continues in a new Copilot session
  Chat.transcript = (turns) => turns.map((t) => {
    const figs = (t.events || []).filter((e) => e.type === 'chart' || e.type === 'dashboard')
      .map((e) => (e.ui && e.ui.title) || (e.request && (e.request.title || e.request.figure))).filter(Boolean);
    return `Q${t.idx + 1}: ${t.question}\nA${t.idx + 1}: ${answerText(t.events || []).slice(0, 2500)}${figs.length ? `\n(Figures shown: ${figs.join('; ')})` : ''}`;
  }).join('\n\n').slice(-18000);
  // A saved answer drawn again: its events through the same renderer, at the times they happened
  Chat.replay = function (host, surface, events, when) {
    let at = 0;
    const turn = Turn(host, surface, { replay: true, clock: () => at });
    (events || []).forEach((ev) => {
      at = (ev.at || 0) * 1000;
      if (ev.type === 'dashboard') turn.dashboard(ev);
      else if (ev.type !== 'done' && ev.type !== 'error' && turn[ev.type]) turn[ev.type](ev);
    });
    const end = (events || []).find((e) => e.type === 'done');
    turn.done(end || {});
    if (when) turn.stamp(when);
  };
  Chat.stop = function (surface) {
    const c = Chat.conversation(surface);
    if (c.id) json('/api/stop', { chat_id: c.id }).catch(() => {});
  };

  const TOOL_LABEL = {
    model_schema: (ev) => `Read the ${ev.model || 'CMS and CMS V2'} model`,
    run_dax: (ev) => `Queried ${ev.model || 'CMS'}`,
    show_figure: (ev) => `Drew a ${ev.template ? ev.template.replace(/_/g, ' ') : 'figure'}${ev.model === 'CMS V2' ? ' from CMS V2' : ''}`,
    render_visual: () => 'Drew a custom visual',
    show_dashboard_figure: (ev) => `Redrew ${(App.DashFigs && App.DashFigs.label(ev.template)) || 'a dashboard figure'}`,
    route_care: (ev) => `Mapped the drive${ev.args && ev.args.origin ? ` from ${ev.args.origin} to ${ev.args.destination}` : ''} and the care along it`,
    nearby_hospitals: (ev) => `Found ${({ delivers: 'hospitals that deliver babies', nicu: 'NICUs', emergency: 'emergency departments', acute: 'hospitals', stopped: 'hospitals that stopped delivering' })[ev.args && ev.args.kind] || 'hospitals'} near ${(ev.args && ev.args.place) || 'the place asked about'}`,
  };
  const FIG_TOOLS = new Set(['show_figure', 'render_visual', 'show_dashboard_figure', 'route_care']);

  // Ask a question on a surface. `host` is the element the answer goes into; `context` the [Pointing at] text.
  // What a saved answer keeps of the stream: enough to draw it again (texts, steps, figures), each with its time
  const KEEP = new Set(['message', 'reasoning_done', 'tool', 'tool_done', 'chart', 'error', 'done']);
  Chat.ask = async function ({ surface, text, context, about, host }) {
    const c = Chat.conversation(surface);
    if (c.busy || !text.trim()) return;
    c.busy = true; Chat.lastSurface = surface; emitChange();
    const turn = Turn(host, surface), rec = [], t0 = performance.now(), stamp = (ev) => ({ ...ev, at: +((performance.now() - t0) / 1000).toFixed(2) });
    try {
      const res = await request('/api/chat', { method: 'POST', body: JSON.stringify({
        message: text, context: context || undefined, chat_id: c.id, surface, adopt: c.adopt || undefined,
        resume: !c.id && c.resume ? c.resume : undefined,
        model: Chat.settings.model || undefined, effort: Chat.settings.effort || undefined }) });
      c.adopt = false;
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        turn.fail(body.error || res.statusText);
        if (body.code) { Chat.models = null; Chat.login = null; }
        return;
      }
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === 'chat') { c.id = ev.chat_id; c.sessionId = ev.session_id || c.sessionId; c.model = ev.model; c.resume = null; }
          else if (ev.type === 'page_request') {
            if (ev.kind === 'dashboard_figure') rec.push(stamp({ type: 'dashboard', call_id: ev.call_id, fig: ev.fig, request: ev.request }));
            pageRequest(c, ev, turn);
          } else if (turn[ev.type]) turn[ev.type](ev);
          if (KEEP.has(ev.type)) rec.push(stamp(ev));
        }
      }
    } catch (e) {
      turn.fail(`The connection to Copilot dropped (${e.message}).`);
    } finally {
      turn.done();
      c.busy = false; emitChange();
      save(c, surface, text, context, about, rec, (performance.now() - t0) / 1000);
    }
  };

  // Saves an answered question: the first one creates the chat (a panel chat lands in Quick chats)
  function save(c, surface, text, context, about, rec, secs) {
    const store = store_.get('cms-chat-history', '1') === '0' ? null : Chat.store();  // '0': don't keep (copilot/dev/eval.py)
    if (!store || !rec.some((e) => e.type === 'message' || e.type === 'chart' || e.type === 'dashboard')) return;
    if (!c.history) c.history = { id: newId(), turns: 0, origin: surface };
    const idx = c.history.turns++;
    const done = rec.find((e) => e.type === 'done');
    const status = done && done.aborted ? 'stopped' : rec.some((e) => e.type === 'message') ? 'done' : 'error';
    const q = text.trim().replace(/[?.!]+$/, ''), title = idx === 0 && about && !q.toLowerCase().includes(about.toLowerCase()) ? `${q} · ${about}`.slice(0, 120) : undefined;
    store.saveTurn(c.history.id, { origin: c.history.origin, session_id: c.sessionId, model: c.model, folder_id: c.history.folder_id || null, title },
      { idx, question: text, context: context || '', about: about || '', events: rec, secs: +secs.toFixed(1), status, preview: answerText(rec).slice(0, 300) })
      .then((chat) => { if (chat && chat.folder_id !== undefined) c.history.folder_id = chat.folder_id; Chat.historyChanged(); })
      .catch((e) => console.warn('Could not save the chat:', e.message || e));
  }

  // A page_request: draw a dashboard figure, or (Fabric app) run DAX through the app's function
  async function pageRequest(c, ev, turn) {
    let reply;
    try {
      if (ev.kind === 'dashboard_figure') {
        reply = { ok: true, text: await turn.dashboard(ev) };
      } else if (ev.kind === 'figure_check') {
        reply = await turn.check(ev);
      } else if (ev.kind === 'dax') {
        const raw = await Bridge().call('dax', { model: ev.model, query: ev.query });
        const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
        reply = r.ok ? { ok: true, rows: r.rows } : { ok: false, error: r.error };
      } else reply = { ok: false, error: `Unknown request ${ev.kind}` };
    } catch (e) {
      reply = { ok: false, error: e.message || String(e) };
    }
    json('/api/tool-result', { chat_id: c.id, id: ev.id, ...reply }).catch(() => {});
  }

  // ---- an answer, drawn as it streams -------------------------------------------------------------------------------
  const CHEV = '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // ---- how Copilot answered: its reasoning, each query and figure with what it returned ------------------------------
  // Folded under the answer's byline; the reader's choice to show it carries over to later answers.
  Chat.traceOpen = store_.get('cms-chat-trace', '0') === '1';
  const secs = (ms) => (ms < 1000 ? 'under 1 s' : ms < 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
  const sentence = (s) => { const t = s.replace(/\s+/g, ' ').trim(), m = t.match(/^.{20,140}?[.!?](\s|$)/); return m ? m[0].trim() : t.slice(0, 140); };
  function Trace(root, grew, clock = () => performance.now()) {
    const list = root.querySelector('.ans-trace'), toggle = root.querySelector('.ans-steps-toggle'), sum = root.querySelector('.ans-steps-sum');
    const items = new Map(), start = clock();
    let nSteps = 0, nQueries = 0, nFixed = 0, thinking = null, touched = false;
    const setOpen = (open) => { list.hidden = !open; toggle.setAttribute('aria-expanded', String(open)); grew(); };
    toggle.addEventListener('click', () => {
      touched = true;
      const open = list.hidden;
      setOpen(open);
      Chat.traceOpen = open;
      store_.set('cms-chat-trace', open ? '1' : '0');
    });
    const summarize = (total) => {
      const bits = nSteps ? [`${nSteps} step${nSteps > 1 ? 's' : ''}`] : ['Reasoning'];
      if (nQueries) bits.push(`${nQueries} ${nQueries > 1 ? 'queries' : 'query'}`);
      if (nFixed) bits.push(`${nFixed} corrected`);
      if (total != null) bits.push(secs(total));
      sum.textContent = bits.join(' · ');
    };
    const sec = (k, v, pre) => (v ? `<div class="tr-sec"><div class="tr-k">${esc(k)}</div>${pre ? `<pre class="tr-pre">${esc(v)}</pre>` : `<p class="tr-v">${esc(v)}</p>`}</div>` : '');
    function item(id, kind) {
      if (items.has(id)) return items.get(id);
      const li = document.createElement('li');
      li.className = `tr-item tr-${kind} is-running`;
      li.innerHTML = `<button type="button" class="tr-row" aria-expanded="false"><span class="tr-dot" aria-hidden="true"></span><span class="tr-l"></span>` +
        `<span class="tr-t"></span><span class="tr-time"></span>${CHEV}</button><div class="tr-body" hidden></div>`;
      const row = li.querySelector('.tr-row'), body = li.querySelector('.tr-body');
      row.addEventListener('click', () => { const open = body.hidden; body.hidden = !open; row.setAttribute('aria-expanded', String(open)); grew(); });
      list.appendChild(li);
      const it = { li, body, start: clock(), l: li.querySelector('.tr-l'), t: li.querySelector('.tr-t'), time: li.querySelector('.tr-time') };
      items.set(id, it);
      toggle.hidden = false;
      if (Chat.traceOpen && list.hidden && !touched) setOpen(true);
      summarize();
      return it;
    }
    const finish = (it, ok) => {
      if (!it.li.classList.contains('is-running')) return;
      it.li.classList.remove('is-running');
      it.li.classList.add(ok ? 'ok' : 'fail');
      it.time.textContent = secs(clock() - it.start);
    };
    const showReason = (it) => { it.body.innerHTML = `<div class="tr-reason md">${md(it.text)}</div>`; it.t.textContent = sentence(it.text); };
    // What each tool was asked to do, in the reader's terms
    function args(ev) {
      const A = ev.args || {}, m = A.model || 'CMS';
      switch (ev.name) {
        case 'run_dax': return sec(`DAX query on ${m}`, A.query, true);
        case 'model_schema': return sec('Model', A.model || 'CMS and CMS V2');
        case 'show_dashboard_figure': {
          const { figure, title, ...settings } = A;
          return sec('Dashboard figure', (App.DashFigs && App.DashFigs.label(figure)) || figure) + sec('Title', title) +
            sec('Settings', Object.keys(settings).length ? Object.entries(settings).map(([k, v]) => `${k}: ${v}`).join('\n') : '', true);
        }
        case 'show_figure':
          return sec('Figure', [A.template && A.template.replace(/_/g, ' '), A.model && `model ${A.model}`].filter(Boolean).join(' · ')) +
            sec('Title', A.title) + sec('Subtitle', A.subtitle) + sec('Fields', A.fields, true) + sec('Options', A.options, true) +
            sec(`DAX query on ${m}`, A.dax, true) + sec('Data', A.rows) + sec('Report card profile', A.profile, true);
        case 'render_visual':
          return sec('Title', A.title) + sec('Subtitle', A.subtitle) + sec(`DAX query on ${m}`, A.dax, true) + sec('Queries', A.queries, true) +
            sec(A.html ? 'Custom D3 page' : 'Vega-Lite specification', A.html || A.spec, true);
        default: return Object.entries(A).map(([k, v]) => sec(k, v, true)).join('');
      }
    }
    return {
      reasoning(ev) {
        const it = item(`r:${ev.id}`, 'think');
        thinking = it;
        it.l.textContent = 'Thinking';
        it.text = (it.text || '') + ev.text;
        showReason(it);
        grew();
      },
      reasoningDone(ev) {
        const it = items.get(`r:${ev.id}`) || (ev.text ? item(`r:${ev.id}`, 'think') : null);
        if (!it) return;
        if (ev.text) { it.text = ev.text; showReason(it); }
        it.l.textContent = 'Thought';
        finish(it, true);
        if (thinking === it) thinking = null;
        grew();
      },
      endThinking() {
        if (!thinking) return;
        thinking.l.textContent = 'Thought';
        finish(thinking, true);
        thinking = null;
      },
      tool(ev) {
        this.endThinking();
        const it = item(ev.id, 'tool');
        if (!it.counted) { it.counted = true; nSteps++; if (ev.dax) nQueries++; summarize(); }
        it.name = ev.name;
        it.l.textContent = (TOOL_LABEL[ev.name] || (() => ev.name))(ev);
        it.t.textContent = ev.title || '';
        it.body.innerHTML = args(ev);
        grew();
      },
      toolDone(ev) {
        const it = items.get(ev.id);
        if (!it) return;
        finish(it, ev.ok);
        it.name = it.name || ev.name;
        // A failed step that Copilot then got right with the same tool reads as corrected, not as a failure
        if (ev.ok) items.forEach((o) => { if (o !== it && o.name === it.name && o.li.classList.contains('fail') && !o.li.classList.contains('fixed')) { o.li.classList.add('fixed'); nFixed++; summarize(); } });
        const back = ev.ok ? ev.result : ev.error || ev.result;
        if (back) it.body.insertAdjacentHTML('beforeend', sec(ev.ok ? 'Returned to Copilot' : 'Failed; Copilot was told', back, true));
        grew();
      },
      note(label, text) {
        const it = item(`n:${performance.now()}`, 'note');
        it.l.textContent = label;
        it.body.innerHTML = sec('Message', text, true);
        finish(it, false);
        grew();
      },
      // A progress note Copilot wrote between steps; returns a setter, as the note may still be arriving
      said(text) {
        const it = item(`s:${performance.now()}`, 'said');
        it.l.textContent = 'Wrote';
        const set = (t) => { it.t.textContent = sentence(t); it.body.innerHTML = `<div class="tr-reason md">${md(t)}</div>`; };
        set(text);
        finish(it, true);
        grew();
        return set;
      },
      done() {
        this.endThinking();
        items.forEach((it) => finish(it, true));
        if (items.size) summarize(clock() - start);
      },
    };
  }

  // opts.replay: a saved answer drawn again from its events; opts.clock gives each event's time as it was answered
  function Turn(host, surface, opts = {}) {
    const replay = !!opts.replay, clock = opts.clock || (() => performance.now());
    const root = document.createElement('div');
    root.className = 'ans' + (replay ? ' is-replay' : '');
    root.innerHTML = '<div class="ans-head"><span class="ans-by">GitHub Copilot</span>' +
      '<button type="button" class="ans-steps-toggle" aria-expanded="false" title="How Copilot answered: its reasoning, queries and figures" hidden><span class="ans-steps-sum"></span>' + CHEV + '</button></div>' +
      '<ol class="ans-trace" hidden></ol><div class="ans-flow"></div>' +
      '<div class="ans-status" role="status"><span class="ans-dot" aria-hidden="true"></span><span class="ans-status-text">Thinking</span></div>';
    host.appendChild(root);
    const flow = root.querySelector('.ans-flow'), status = root.querySelector('.ans-status'), statusText = root.querySelector('.ans-status-text');
    const texts = new Map(), slots = new Map(), figs = new Map(), notes = new Map(), drawn = new Map();
    let lastError = null;
    let phase = 'Thinking', since = Date.now(), finished = false;
    const setPhase = (p) => { if (p !== phase) { phase = p; since = Date.now(); } };
    const tick = setInterval(() => {
      const s = Math.round((Date.now() - since) / 1000);
      statusText.textContent = s >= 2 ? `${phase} · ${s}s` : phase;
    }, 500);
    const grew = () => root.dispatchEvent(new CustomEvent('ans-grow', { bubbles: true }));
    const trace = Trace(root, grew, clock);
    const block = (id) => {
      if (!texts.has(id)) { const el = document.createElement('div'); el.className = 'ans-text md'; flow.appendChild(el); texts.set(id, { el, text: '', lead: null, interim: false }); }
      return texts.get(id);
    };
    // The model writes each figure's narrative under a line [[fig N]] and closes with [[summary]]; each section goes
    // right under its figure, the summary stays at the end. What its last message says before the first marker is
    // the answer itself, shown above the figures. Text written before a further step is a progress note: muted while
    // Copilot works, then folded into the steps.
    const MARK = /^[ \t]*\[\[\s*(fig(?:ure)?\s*(\d+)|summary)\s*\]\][ \t]*$/gim;
    const note = (n) => {
      if (!notes.has(n)) {
        const el = document.createElement('div'); el.className = 'ans-note md';
        figs.get(n).after(el);
        notes.set(n, { el, parts: new Map() });
      }
      return notes.get(n);
    };
    const render = (b) => {
      const text = b.text.replace(/\n?[ \t]*\[\[[^\]\n]*$/, '');
      let lead = '', main = '', cur = null, last = 0, m, summary = false, inSummary = false, marked = false;
      const put = (seg, n) => {
        if (n != null && figs.has(n)) { note(n).parts.set(b, seg); return; }
        if (!marked && !b.interim) { lead = seg; return; }
        main += (main && seg.trim() ? '\n\n' : '') + seg;
        if (inSummary && seg.trim()) summary = true;
      };
      MARK.lastIndex = 0;
      while ((m = MARK.exec(text))) {
        put(text.slice(last, m.index), cur);
        marked = true;
        cur = m[2] ? +m[2] : null; inSummary = !m[2];
        last = MARK.lastIndex;
      }
      put(text.slice(last), cur);
      if (lead.trim()) {
        if (!b.lead) {
          b.lead = document.createElement('div');
          b.lead.className = 'ans-text ans-lead md';
          flow.insertBefore(b.lead, flow.querySelector(':scope > .ans-slot') || b.el);
        }
        b.lead.innerHTML = md(lead.trim());
      } else if (b.lead) { b.lead.remove(); b.lead = null; }
      b.el.innerHTML = md(main.trim());
      b.el.hidden = !main.trim();
      b.el.classList.toggle('ans-summary', summary && figs.size > 0);
      if (b.said) b.said(main.trim());
      notes.forEach((nt) => { nt.el.innerHTML = md([...nt.parts.values()].map((s) => s.trim()).filter(Boolean).join('\n\n')); });
      grew();
    };
    // A further step began: what Copilot has written so far was a progress note
    const interim = () => texts.forEach((b) => {
      if (b.interim || !b.text.trim()) return;
      b.interim = true;
      b.el.classList.add('ans-interim');
      b.said = trace.said('');
      render(b);
    });
    const fold = (el) => {
      if (replay || matchMedia('(prefers-reduced-motion: reduce)').matches || !el.offsetHeight) { el.remove(); return; }
      el.style.height = `${el.offsetHeight}px`;
      el.classList.add('is-folding');
      requestAnimationFrame(() => requestAnimationFrame(() => { el.style.height = '0px'; }));
      const gone = () => { if (el.isConnected) { el.remove(); grew(); } };
      el.addEventListener('transitionend', (e) => { if (e.propertyName === 'height') gone(); });
      setTimeout(gone, 700);
    };
    const slotFor = (id) => {
      if (!slots.has(id)) { const s = document.createElement('div'); s.className = 'ans-slot'; flow.appendChild(s); slots.set(id, s); }
      return slots.get(id);
    };
    // A corrected figure keeps its number (and the narrative already written for it) and replaces the earlier one
    const placeFigure = (n, slot) => {
      const old = figs.get(n), prev = notes.get(n);
      if (old && old !== slot) old.remove();
      figs.set(n, slot);
      if (prev) slot.after(prev.el);
    };

    return {
      // A saved answer: when it was answered, beside the byline
      stamp(when) {
        const el = document.createElement('span');
        el.className = 'ans-when';
        el.textContent = when;
        root.querySelector('.ans-head').insertBefore(el, root.querySelector('.ans-steps-toggle'));
      },
      delta(ev) { trace.endThinking(); setPhase('Writing'); const b = block(ev.id); b.text += ev.text; render(b); },
      message(ev) { if (!ev.text && !texts.has(ev.id)) return; const b = block(ev.id); b.text = ev.text; render(b); },
      thinking() { setPhase('Thinking'); },
      reasoning(ev) { setPhase('Thinking'); trace.reasoning(ev); },
      reasoning_done(ev) { trace.reasoningDone(ev); },
      tool_draft(ev) {
        trace.endThinking();
        interim();
        setPhase(ev.template ? `Writing the ${ev.template.replace(/_/g, ' ')}` : 'Writing a query');
        if (FIG_TOOLS.has(ev.name)) slotFor(ev.id);
      },
      tool(ev) {
        interim();
        trace.tool(ev);
        setPhase(ev.dax ? `Querying ${ev.model || 'CMS'}` : ev.name === 'model_schema' ? 'Reading the model' : ev.name === 'route_care' ? 'Routing the drive'
          : ev.name === 'nearby_hospitals' ? 'Finding hospitals nearby' : 'Drawing');
        if (FIG_TOOLS.has(ev.name)) slotFor(ev.id);
      },
      tool_done(ev) {
        setPhase('Thinking');
        trace.toolDone(ev);
        const slot = slots.get(ev.id);
        if (slot && !slot.childElementCount && !ev.ok) slot.remove();
      },
      // A figure is drawn here; Copilot then asks for its readability check (check below). One that can't be drawn
      // leaves the answer and goes back to Copilot as a failed step, which it corrects.
      chart(ev) {
        const slot = slotFor(ev.call_id);
        slot.innerHTML = '';
        const card = figureCard(ev.ui, surface);
        slot.appendChild(card.el);
        placeFigure(ev.fig, slot);
        const done = card.draw().then(() => ({ ok: true, el: card.el, ui: ev.ui }), (e) => {
          console.error(e);
          slot.remove();
          if (figs.get(ev.fig) === slot) figs.delete(ev.fig);
          return { ok: false, error: e.message || String(e) };
        });
        drawn.set(ev.call_id, done);
        // A care map answers a search on one of the dashboard's maps; Quick chat may put it there too (panel.js)
        if (!replay && ev.ui && ev.ui.template === 'care_map') {
          done.then((d) => { if (d.ok) document.dispatchEvent(new CustomEvent('chat-care-map', { detail: { surface, ui: ev.ui } })); });
        }
        return done.then(grew);
      },
      async check(ev) {
        for (let i = 0; i < 50 && !drawn.has(ev.call_id); i++) await new Promise((r) => setTimeout(r, 100));
        const d = await drawn.get(ev.call_id);
        if (!d) return { ok: true, text: '' };
        if (!d.ok) return { ok: false, error: `The figure could not be drawn in the page: ${d.error}` };
        await Chat.settled(d.el);
        if (d.ui.mode === 'html') await new Promise((r) => setTimeout(r, 600));  // the sandbox draws after its scripts load
        try {
          const inside = d.ui.mode === 'html' && Chat.checkCustom ? await Chat.checkCustom(d.el) : [];
          return { ok: true, text: Chat.checkFigure ? Chat.checkFigure(d.el, d.ui, surface, inside) : '' };
        } catch (e) { return { ok: true, text: '' }; }
      },
      dashboard(ev) {
        const slot = slotFor(ev.call_id);
        slot.innerHTML = '';
        placeFigure(ev.fig, slot);
        const facts = App.DashFigs.draw(slot, ev.request, surface);
        grew();
        return facts;
      },
      // An error Copilot reported mid-answer: it usually recovers, so it goes to the steps; shown only if the answer
      // ends with nothing else to show
      error(ev) {
        lastError = ev.text || 'Copilot reported an error.';
        trace.note('Copilot reported an error', lastError);
      },
      fail(text) {
        const p = document.createElement('p');
        p.className = 'ans-error';
        p.textContent = text;
        flow.appendChild(p);
        grew();
      },
      done(ev) {
        if (finished) return;
        finished = true;
        clearInterval(tick);
        status.remove();
        trace.done();
        if (lastError && ![...texts.values()].some((b) => b.text.trim()) && !figs.size) this.fail(lastError);
        slots.forEach((s) => { if (!s.childElementCount) s.remove(); });
        // The progress notes go once the answer has its own text; if it has none, they are the answer
        const answered = notes.size || [...texts.values()].some((b) => !b.interim && b.text.trim());
        texts.forEach((b) => {
          if (!b.interim) return;
          if (answered) { fold(b.el); return; }
          b.interim = false; b.el.classList.remove('ans-interim'); render(b);
        });
        if (ev && ev.aborted) {
          const p = document.createElement('p'); p.className = 'ans-stopped'; p.textContent = 'Stopped.'; flow.appendChild(p);
        }
        grew();
      },
    };
  }

  // ---- a figure in an answer: template, Vega-Lite or custom HTML -----------------------------------------------------
  function figureCard(d, surface) {
    const el = document.createElement('article');
    el.className = 'ans-fig';
    el.innerHTML = `<div class="card-head"><div>${d.kicker ? `<div class="eyebrow">${esc(d.kicker)}</div>` : ''}<h3>${esc(d.title || '')}</h3>${d.subtitle ? `<p class="sub">${esc(d.subtitle)}</p>` : ''}</div></div>` +
      `<div class="fx"></div><div class="ans-pick" hidden></div><p class="ans-src">${esc(d.source || 'CMS Care Compare')}</p>`;
    const plot = el.querySelector('.fx'), pick = el.querySelector('.ans-pick');
    let view = null, lastW = 0;
    const onPick = (row, pairs) => {
      el.__pick = pairs && pairs.length ? pairs : null;
      if (!pairs || !pairs.length) { pick.hidden = true; return; }
      pick.innerHTML = `<span class="ans-pick-what">${pairs.map(([k, v]) => `${esc(k)} <b>${esc(v)}</b>`).join(' · ')}</span>` +
        '<button type="button" class="btn btn-ink">Ask about this</button><button type="button" class="btn">Clear</button>';
      pick.hidden = false;
      const tpl = d.options && d.options.drill;
      let q = tpl ? String(tpl).replace(/\{([^{}]+)\}/g, (m, k) => (row && row[k] != null ? row[k] : m)) : '';
      if (!q || /\{[^{}]+\}/.test(q)) q = `In "${d.title}", tell me more about ${pairs.map(([k, v]) => `${k} ${v}`).join(', ')}.`;
      const [ask, clear] = pick.querySelectorAll('.btn');
      ask.onclick = () => { pick.hidden = true; Chat.followUp(surface, q); };
      clear.onclick = () => { pick.hidden = true; el.__pick = null; };
    };
    const drawFigure = (anim) => {
      Figures.render(plot, el, d, { anim, onPick });
      lastW = plot.clientWidth;
    };
    async function draw() {
      if (d.view === 'figure') {
        await Chat.figures();
        if (d.template === 'dot_map') await locations();
        drawFigure(!App.reduceMotion);
        Chat.track(el, () => drawFigure(false), () => Math.abs(plot.clientWidth - lastW) > 4);
      } else if (d.mode === 'html') {
        await Chat.figures();
        drawCustom(plot, d, surface);
      } else {
        await vegaLibs();
        await Chat.figures();
        view = await drawVega(plot, d, onPick);
        Chat.track(el, async () => { if (view) view.finalize(); plot.innerHTML = ''; view = await drawVega(plot, d, onPick); }, null);
      }
    }
    return { el, draw };
  }
  Chat.followUp = (surface, text, { context, about } = {}) => document.dispatchEvent(new CustomEvent('chat-follow-up', { detail: { surface, text, context, about } }));

  // Figures in answers redraw when the theme changes, and when their width changes
  const live = new Set();
  Chat.track = function (el, redraw, resized) {
    const entry = { el, redraw };
    live.add(entry);
    if (resized) {
      let t;
      const ro = new ResizeObserver(() => {
        clearTimeout(t);
        t = setTimeout(() => {
          if (!el.isConnected) { ro.disconnect(); live.delete(entry); return; }
          if (el.offsetParent !== null && resized()) redraw();
        }, 140);
      });
      ro.observe(el);
    }
  };
  const renderAll = App.renderAll;
  App.renderAll = function (anim) {
    renderAll(anim);
    live.forEach((e) => { if (!e.el.isConnected) { live.delete(e); return; } try { e.redraw(); } catch (err) { console.error(err); } });
  };

  // Vega-Lite, themed from the dashboard's tokens (orange only for worse)
  function vegaTheme() {
    const C = Figures.palette(), font = getComputedStyle(document.documentElement).getPropertyValue('--font').trim();
    vega.scheme('diverging', [C.good, C.neutralMid, C.bad]);
    vega.scheme('worse', [C.neutralMid, C.bad]);
    vega.scheme('clay', [C.neutralMid, C.bad]);
    vega.scheme('better', [C.neutralMid, C.good]);
    vega.scheme('magnitude', [C.neutralMid, C.text2]);
    vega.scheme('olive', [C.neutralMid, C.olive]);
    vega.scheme('palette', C.cat);
    return {
      background: null, font, padding: 4, view: { stroke: null },
      title: { font, fontSize: 14, fontWeight: 500, color: C.text, anchor: 'start', subtitleColor: C.muted, subtitleFont: font },
      axis: { labelColor: C.muted, titleColor: C.muted, domainColor: C.border, tickColor: C.border, gridColor: C.grid, labelFontSize: 10.5, titleFontSize: 11, titleFontWeight: 400, labelFont: font, titleFont: font },
      legend: { labelColor: C.muted, titleColor: C.muted, labelFontSize: 11, titleFontSize: 11, titleFontWeight: 400, labelFont: font, titleFont: font },
      header: { labelColor: C.text2, titleColor: C.text2, labelFontSize: 12, labelFontWeight: 500, titleFontSize: 12, labelFont: font, titleFont: font },
      range: { category: C.cat, ramp: [C.neutralMid, C.text2], heatmap: [C.neutralMid, C.text2], diverging: [C.good, C.neutralMid, C.bad] },
      mark: { color: C.text2, tooltip: true }, bar: { color: C.text2 }, line: { color: C.text2, strokeWidth: 2 },
      point: { color: C.text2, filled: true, size: 40 }, area: { color: C.text2, opacity: 0.2 }, rule: { color: C.muted },
      geoshape: { stroke: C.surface, strokeWidth: 0.7 }, text: { color: C.text, font },
    };
  }
  const GEO = new Set(['us-states', 'us-states.json', 'us-10m.json', 'data/us-10m.json', 'states-10m.json']);
  function resolveGeo(node) {
    if (Array.isArray(node)) return node.map(resolveGeo);
    if (!node || typeof node !== 'object') return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = resolveGeo(v);
    if (typeof out.url === 'string' && (GEO.has(out.url) || GEO.has(out.url.split('/').pop()))) {
      delete out.url;
      out.values = window.US_STATES;
      out.format = { type: 'topojson', feature: 'states', ...(out.format || {}) };
    }
    // Nothing in a spec may fetch data or open links
    delete out.href;
    if (typeof out.url === 'string') delete out.url;
    return out;
  }
  const merge = (a, b) => {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return b ?? a;
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = a && typeof a[k] === 'object' && !Array.isArray(a[k]) ? merge(a[k], v) : v;
    return out;
  };
  async function drawVega(el, d, onPick) {
    const spec = resolveGeo(d.spec);
    spec.config = merge(vegaTheme(), spec.config || {});
    const composite = ['facet', 'repeat', 'concat', 'hconcat', 'vconcat'].some((k) => k in spec) || (spec.encoding && ['facet', 'row', 'column'].some((k) => k in spec.encoding));
    // A single view always fills the answer's width (a fixed width from the spec leaves it small); maps get the height
    // a U.S. map needs at that width
    if (!composite && (spec.width == null || typeof spec.width === 'number')) { spec.width = 'container'; spec.autosize = spec.autosize || { type: 'fit-x', contains: 'padding' }; }
    const isMap = (s) => s && (s.mark === 'geoshape' || (s.mark && s.mark.type === 'geoshape') || (s.layer || []).some(isMap));
    if (!composite && isMap(spec)) spec.height = Math.max(typeof spec.height === 'number' ? spec.height : 0, Math.round(Math.min(560, (el.clientWidth || 600) * 0.62)));
    const res = await vegaEmbed(el, spec, {
      actions: false, renderer: 'svg', mode: 'vega-lite', ast: true, expr: vegaInterpreter.expressionInterpreter,
      tooltip: { theme: 'custom', sanitize: (v) => esc(v) },
    });
    res.view.addEventListener('click', (ev, item) => {
      const datum = item && item.datum;
      if (!datum) return onPick(null, []);
      const pairs = Object.entries(datum.properties ? { State: datum.properties.name, ...datum } : datum)
        .filter(([k, v]) => v != null && typeof v !== 'object' && !/^(type|id|geo|_|Symbol)/.test(k)).slice(0, 6)
        .map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(3) : v]);
      return onPick(datum, pairs);
    });
    return res.view;
  }

  // Runs inside a custom visual's sandbox: labels too small, overlapping or past the edge, and nothing drawn
  const MEASURE = String(function () {
    const out = [], q = (s) => `"${s.length > 28 ? `${s.slice(0, 27)}…` : s}"`;
    const W = document.documentElement.clientWidth;
    const t = [...document.querySelectorAll('svg text, svg tspan')].filter((n) => !n.querySelector('tspan') && (n.textContent || '').trim())
      .map((n) => ({ s: n.textContent.trim(), r: n.getBoundingClientRect(), px: parseFloat(getComputedStyle(n).fontSize) * ((n.getScreenCTM && n.getScreenCTM() || { a: 1 }).a || 1) }))
      .filter((x) => x.r.width > 0);
    const tiny = t.filter((x) => x.px < 9.5);
    if (tiny.length) out.push(`${tiny.length} labels are drawn below 10 px (e.g. ${q(tiny[0].s)}).`);
    let clash = 0, ex = null;
    for (let i = 0; i < Math.min(t.length, 300); i++) for (let j = i + 1; j < Math.min(t.length, 300); j++) {
      const a = t[i].r, b = t[j].r, w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 0 && h > 0 && w * h > 0.3 * Math.min(a.width * a.height, b.width * b.height) && !(t[i].s === t[j].s && Math.abs(a.left - b.left) < 2)) { clash++; ex = ex || [t[i].s, t[j].s]; }
    }
    if (clash) out.push(`${clash} pairs of labels overlap (e.g. ${q(ex[0])} and ${q(ex[1])}).`);
    const past = t.filter((x) => x.r.right > W + 2 || x.r.left < -2);
    if (past.length) out.push(`${past.length} labels run past the edge of the visual (e.g. ${q(past[0].s)}).`);
    if (!document.querySelector('svg *, canvas, table')) out.push('Nothing was drawn.');
    return out;
  });

  // Custom HTML/d3 in a sandbox with no network: d3, topojson, the data and the theme passed in
  function drawCustom(el, d, surface) {
    const lib = (src) => fetch(src).then((r) => r.text());
    const cs = getComputedStyle(document.documentElement);
    const vars = ['--font', '--bg', '--surface', '--surface-2', '--text', '--text-2', '--muted', '--border', '--grid', '--good', '--bad', '--neutral', '--neutral-mid']
      .map((v) => `${v}:${cs.getPropertyValue(v)}`).join(';');
    const J = (v) => JSON.stringify(v ?? null).replace(/</g, '\\u003c');
    const tag = (src) => `<script>${src.replace(/<\/script/gi, '<\\/script')}<\/script>`;
    return Promise.all([lib('assets/vendor/d3.min.js'), lib('assets/vendor/vega/topojson-client.min.js')]).then(([d3src, topo]) => {
      const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:";
      const frame = document.createElement('iframe');
      frame.className = 'fx-custom'; frame.sandbox = 'allow-scripts'; frame.title = d.title || 'Custom visual';
      frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">` +
        `<style>:root{${vars};color-scheme:${App.isDark() ? 'dark' : 'light'}} html,body{margin:0;background:transparent;font:13px/1.45 var(--font);color:var(--text)} svg{overflow:visible}</style>` +
        tag(d3src) + tag(topo) +
        tag(`window.DATA=${J(d.data)};window.US_STATES=${J(window.US_STATES)};window.PALETTE=${J(Figures.palette())};window.THEME=${J(App.isDark() ? 'dark' : 'light')};` +
          'window.askCopilot=t=>parent.postMessage({__fx:"ask",text:String(t)},"*");' +
          'addEventListener("error",e=>parent.postMessage({__fx:"error",message:e.message},"*"));' +
          `addEventListener("message",e=>{if(e.data&&e.data.__fx==="measure")parent.postMessage({__fx:"measured",items:(${MEASURE})()},"*");});` +
          'const __size=()=>parent.postMessage({__fx:"size",h:Math.ceil(document.documentElement.getBoundingClientRect().height)},"*");' +
          'addEventListener("load",()=>{__size();new ResizeObserver(__size).observe(document.documentElement);});') +
        `</head><body>${d.html}</body></html>`;
      const onMsg = (e) => {
        if (e.source !== frame.contentWindow || !e.data || !e.data.__fx) return;
        if (e.data.__fx === 'size') frame.style.height = Math.min(Math.max(e.data.h, 60), 2400) + 'px';
        else if (e.data.__fx === 'ask') Chat.followUp(surface, e.data.text);
        else if (e.data.__fx === 'error') (frame.__errors = frame.__errors || []).push(e.data.message);
        else if (e.data.__fx === 'measured' && frame.__measured) frame.__measured(e.data.items || []);
      };
      // The readability check asks the visual to measure itself (it can't see into the sandbox)
      el.__measure = () => new Promise((resolve) => {
        const done = (items) => { frame.__measured = null; resolve([...(frame.__errors || []).map((m) => `The visual threw an error: ${m}`), ...items]); };
        frame.__measured = done;
        try { frame.contentWindow.postMessage({ __fx: 'measure' }, '*'); } catch (e) { done([]); }
        setTimeout(() => frame.__measured && done(['The visual did not answer the readability check.']), 2500);
      });
      window.addEventListener('message', onMsg);
      el.appendChild(frame);
    });
  }
})();
