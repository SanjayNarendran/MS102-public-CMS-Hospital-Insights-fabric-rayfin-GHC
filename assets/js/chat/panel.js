/* The side panel: right-click anything on the dashboard to ask about it.

   What was right-clicked is read in this order: the chart tooltip on screen (every chart shows one on hover, naming
   the hospital, state, year or measure under the pointer), a map popup, the row, tile or finding under the pointer, the
   d3 data on the element, selected text, then the figure and section around it. From that come the panel's
   "Pointing at" card, the suggested questions (by the dimensions found: hospital, state, year, star rating, infection
   and measure) and the context sent to Copilot with the question. Shift+right-click, and right-click in a text field,
   keep the browser's menu. */
(function () {
  'use strict';
  const App = window.App, Chat = window.Chat;
  const esc = App.esc;
  const $ = (id) => document.getElementById(id);
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
  const NAME_TO_CODE = Object.fromEntries(Object.entries(App.STATE_NAMES).map(([c, n]) => [n.toLowerCase(), c]));

  // ---- what each figure measures ------------------------------------------------------------------------------------
  const inf = (k) => App.infByKey[k] || App.INF[0];
  const mapMetric = () => (App.mapMetrics ? App.mapMetrics().find((m) => m.key === App.state.mapMetric) : null);
  const MEASURE = {
    'fig-sm': () => ({ measure: 'infection ratios', kind: 'infection', series: true }),
    'fig-db': () => ({ measure: 'infection ratios', kind: 'infection', series: true }),
    'fig-flags': (st) => ({ measure: `hospitals flagged for ${inf(st.flagsInf).short}`, short: `${inf(st.flagsInf).short} flags`, kind: 'infection', infection: st.flagsInf, series: true }),
    'fig-funnel': (st) => ({ measure: `${inf(st.funnelInf).short} infection ratio`, kind: 'infection', infection: st.funnelInf, series: true }),
    'fig-map': (st) => metricMeasure(st), 'fig-ranks': (st) => metricMeasure(st), 'mapCard': (st) => metricMeasure(st),
    'fig-stars': () => ({ measure: 'HCAHPS star rating', kind: 'experience', series: true }),
    'fig-heat': () => ({ measure: 'patient survey scores', kind: 'experience', series: true }),
    'fig-psi': () => ({ measure: 'PSI‑90 composite', kind: 'safety', series: true }),
    'fig-psicomp': () => ({ measure: 'PSI component rates', kind: 'safety', series: true }),
    'fig-starflags': () => ({ measure: 'infections flagged worse by star rating', short: 'infection flags', kind: 'experience' }),
    'fig-ridge': () => ({ measure: 'PSI‑90 by star rating', short: 'PSI‑90', kind: 'safety' }),
    'fig-ovr': () => ({ measure: 'CMS overall star rating', kind: 'outcomes' }),
    'fig-ed': () => ({ measure: 'emergency department time', short: 'ED time', kind: 'ed' }),
    'fig-outcome': (st) => ({ measure: st.outcomeKind === 'readm' ? '30-day readmission rates' : '30-day death rates', kind: 'outcomes' }),
    'fig-pen': () => ({ measure: 'Medicare payment cuts', kind: 'penalty' }),
    'matCard': () => ({ measure: 'distance to maternity care', kind: 'maternity' }),
    'hospMap': () => { const s = $('hmMetric'); return { measure: s && s.selectedOptions[0] ? s.selectedOptions[0].textContent : 'hospital measures', kind: 'hospital' }; },
    'exTable': () => ({ measure: 'hospital measures', kind: 'hospital' }),
  };
  const METRIC_SHORT = { star: 'patient experience star rating', topPct: 'share of 4–5 star hospitals', psi90: 'PSI‑90', ovr: 'CMS overall star rating', ed: 'emergency department time' };
  function metricMeasure(st) {
    const M = App.mapMetrics ? App.mapMetrics().find((m) => m.key === st.mapMetric) : null;
    if (!M) return { measure: 'state results', kind: 'state' };
    const infKey = App.infByKey[M.key] ? M.key : null;
    return { measure: M.title.replace(/,\s*\d{4}$/, ''), short: infKey ? `${M.label} ratio` : METRIC_SHORT[M.key] || M.label,
      kind: infKey ? 'infection' : M.key === 'ed' ? 'ed' : M.key === 'ovr' ? 'outcomes' : M.key === 'psi90' ? 'safety' : 'experience',
      infection: infKey, series: !M.local };
  }
  const SECTION_KIND = { infections: 'infection', benchmark: 'infection', geography: 'state', maternity: 'maternity', experience: 'experience', safety: 'safety', connections: 'experience', outcomes: 'outcomes', explorer: 'hospital' };

  // ---- reading what was right-clicked ---------------------------------------------------------------------------------
  function readTooltip(el) {
    if (!el) return null;
    const title = clean(el.querySelector('.tt-title, b') && el.querySelector('.tt-title, b').textContent);
    const sub = clean(el.querySelector('.tt-sub') && el.querySelector('.tt-sub').textContent).split(' · ').filter((x) => !/^click to /i.test(x)).join(' · ');
    const rows = [...el.querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => clean(td.textContent))).filter((r) => r.length >= 2 && r[0]);
    const tag = clean(el.querySelector('.tag') && el.querySelector('.tag').textContent);
    const text = rows.length ? '' : clean(el.textContent.replace(title, ''));
    return { title, sub, rows, tag, text };
  }
  function datumOf(el) {
    for (let n = el, i = 0; n && i < 5; n = n.parentNode, i++) {
      if (n.__data__ != null && n.__data__ !== '' && !(n instanceof HTMLHtmlElement)) return n.__data__;
    }
    return null;
  }
  function describeDatum(d) {
    if (d == null) return null;
    if (typeof d !== 'object') return { value: d };
    const out = {};
    Object.entries(d).forEach(([k, v]) => {
      if (k.startsWith('_') || v == null || typeof v === 'function') return;
      if (typeof v === 'object') { if (v && v.label) out[k] = v.label; return; }
      out[k] = typeof v === 'number' ? +v.toFixed(3) : v;
    });
    return Object.keys(out).length ? out : null;
  }

  let heldSelection = null;  // the selection when the right button went down: {text, at}

  function capture(ev) {
    const t = ev.target instanceof Element ? ev.target : ev.target.parentElement;
    const view = document.documentElement.dataset.view || 'overview';
    const ctx = { view, dims: {}, lines: [] };
    const st = App.state;
    const sel = window.getSelection();
    const live = sel && !sel.isCollapsed ? sel.toString().trim() : '';
    // Some browsers clear the selection when the right button goes down; use the one saved then
    const kept = !live && heldSelection && heldSelection.at > performance.now() - 2000 ? heldSelection.text : '';
    const selected = live || kept ? clip(clean(live || kept), 600) : '';

    // The chart tooltip or map popup under the pointer names the item
    const tipEl = $('tooltip');
    const popup = t.closest('.hmap, .mat-card, #matCard') && document.querySelector('.maplibregl-popup.hm-tip');
    const tip = tipEl && tipEl.classList.contains('on') ? readTooltip(tipEl) : popup ? readTooltip(popup.querySelector('.maplibregl-popup-content')) : null;

    // Where it is: answer figure, dashboard figure, KPI, finding, explorer row, section
    const ans = t.closest('.ans-fig');
    const article = ans || t.closest('article.card, article.fig, .mat-card');
    const chartEl = article && (article.querySelector('.chart[id], .ranks[id], #kpis') || article);
    const chartId = ans ? ((ans.querySelector('[data-dash-id^="fig-"]') || {}).dataset || {}).dashId || null
      : (t.closest('#kpis') ? 'kpis' : t.closest('#exTable') ? 'exTable' : t.closest('#hospMap') ? 'hospMap' : t.closest('#matCard') ? 'matCard' : chartEl && chartEl.id) || null;
    const toc = t.closest('.q-toc-item');
    const section = t.closest('section.chapter') || (toc && document.getElementById(toc.querySelector('.q-toc-link').getAttribute('href').slice(1)));
    const kpi = t.closest('.kpi');
    const finding = t.closest('.ins-finding');
    const exRow = t.closest('#exTable tbody tr');
    const rankLi = t.closest('li[data-c]');

    // Figure and section, for the context and the card's eyebrow
    if (article) {
      const eb = clean((article.querySelector('.eyebrow') || {}).textContent);
      const titles = [...article.querySelectorAll('.card-head h3')].map((h) => clean(h.textContent));
      const sub = clean((article.querySelector('.card-head .sub:not(.dash-orig)') || {}).textContent);
      ctx.figure = { eyebrow: eb, title: titles[0] || '', sub };
      ctx.lines.push(`Figure: ${[eb, titles.join(' · ')].filter(Boolean).join(', ')}${sub ? `. ${clip(sub, 260)}` : ''}`);
    }
    if (section) {
      ctx.section = { num: section.dataset.num, label: section.dataset.label, name: clean(section.querySelector('.chapter-name').textContent) };
      ctx.lines.unshift(`Section ${ctx.section.num} ${ctx.section.label}: ${ctx.section.name}`);
    }
    ctx.lines.unshift(`View: ${{ overview: 'Overview', quality: 'Quality & safety', insights: 'Insights and takeaways', ask: 'Ask your data' }[view] || view}`);

    // Measure and kind from the figure (live filters included)
    const m = chartId && MEASURE[chartId] ? MEASURE[chartId](st) : null;
    if (m) Object.assign(ctx, m);
    else if (section) ctx.kind = SECTION_KIND[section.id];
    if (ans && !m) { ctx.measure = (ctx.figure && ctx.figure.title) || ''; ctx.kind = guessKind(ctx.measure); ctx.series = /trend|since|20\d\d.*20\d\d|year/i.test(ctx.measure); }
    // What the figure is set to now: the chip picked, the hospital searched, the mark clicked
    if (ans) { const fs = figureState(ans); if (fs) ctx.lines.push(`Figure settings: ${fs}`); }
    // The maps and the explorer describe their own state: the search, the hospitals listed, the card open
    const liveApi = LIVE[chartId] && LIVE[chartId].api();
    const liveNow = liveApi && liveApi.describe ? liveApi.describe() : null;
    if (liveNow) { ctx.lines.push(liveNow.text); ctx.liveSuggest = liveNow.suggest || []; ctx.liveSubject = liveNow.subject || null; }
    ctx.source = LIVE[chartId] ? LIVE[chartId].key : ans ? 'answer' : chartId;

    // The item itself
    let item = null;
    if (tip && (tip.title || tip.text)) {
      item = { title: tip.title, sub: tip.sub, rows: tip.rows, tag: tip.tag, text: tip.text };
    } else if (kpi) {
      const kv = kpi.querySelector('.kpi-value'), unit = kv && kv.querySelector('.kpi-unit');
      const value = kv ? clean([...kv.childNodes].filter((n) => n !== unit).map((n) => n.textContent).join('')) + (unit ? ` ${clean(unit.textContent)}` : '') : '';
      item = { title: clean((kpi.querySelector('.kpi-label') || {}).textContent), rows: [['Value', value],
        ['Change', clean((kpi.querySelector('.delta') || {}).textContent)], ['', clean((kpi.querySelector('.kpi-sub') || {}).textContent)]].filter((r) => r[1]),
        text: clean((kpi.querySelector('.kpi-note') || {}).textContent) };
      ctx.series = true;
      ctx.measure = item.title;
      ctx.kind = guessKind(item.title) || 'infection';
      const k = App.INF.find((d) => item.title.includes(d.short));
      if (k) ctx.infection = k.key;
    } else if (finding) {
      const tag = finding.querySelector('.ins-tag'), num = clean((finding.querySelector('.ins-num') || {}).textContent);
      const label = tag ? clean([...tag.childNodes].filter((n) => !n.classList || !n.classList.contains('ins-num')).map((n) => n.textContent).join('')) : '';
      item = { title: clean((finding.querySelector('h2') || {}).textContent), sub: `Finding ${num}, ${label}`,
        rows: [[clean((finding.querySelector('.ins-val-note') || {}).textContent), clean((finding.querySelector('.ins-val') || {}).textContent)]],
        text: clip(clean((finding.querySelector('.ins-text') || {}).textContent), 500) };
      ctx.series = true;
      ctx.measure = clean((finding.querySelector('.ins-val-note') || {}).textContent) || item.title;
      ctx.kind = guessKind(`${item.title} ${ctx.measure}`);
    } else if (exRow && exRow.querySelector('.nm')) {
      const pill = t.closest('.pill[data-k]');
      item = { title: clean(exRow.querySelector('.nm').childNodes[0].textContent), sub: clean(exRow.querySelector('.loc').textContent), rows: [] };
      if (pill) { item.rows.push([`${inf(pill.dataset.k).short} SIR`, clean(pill.textContent)]); ctx.infection = pill.dataset.k; ctx.measure = `${inf(pill.dataset.k).short} infection ratio`; ctx.kind = 'infection'; ctx.series = true; }
    } else if (rankLi) {
      const code = rankLi.dataset.c;
      item = { title: App.STATE_NAMES[code] || code, rows: [[ctx.short || 'Value', clean((rankLi.querySelector('.v') || {}).textContent)], ['Rank', clean((rankLi.querySelector('.rk') || {}).textContent)]] };
    } else {
      const d = describeDatum(datumOf(t));
      if (d && !(article && t === chartEl)) {
        const code = typeof d.value === 'string' && App.STATE_NAMES[d.value] ? d.value : d.c || d.st || d.state || d.State || null;
        const named = ['label', 'name', 'title'].map((k) => d[k]).find((v) => typeof v === 'string' && v.trim());
        const shown = Object.entries(d).filter(([k]) => !['k', 'key', 'id', 'i', 'idx', 'label', 'name', 'title', 'sub'].includes(k));
        item = code && App.STATE_NAMES[code] ? { title: App.STATE_NAMES[code], rows: [] }
          : { title: named || '', sub: named && typeof d.sub === 'string' ? d.sub : '', rows: shown.slice(0, 6).map(([k, v]) => [k, String(v)]) };
        if (code) ctx.dims.state = code;
        if (d.year) ctx.dims.year = d.year;
        if (d.s >= 1 && d.s <= 5) ctx.dims.star = d.s;
      }
    }
    if (exRow && exRow.querySelector('.nm')) {
      const loc = clean(exRow.querySelector('.loc').textContent), name = clean(exRow.querySelector('.nm').childNodes[0].textContent);
      if (item && item.title !== name) { item.rows = [[item.title, ''], ...(item.rows || [])].filter((r) => r[0]); item.title = name; item.sub = loc; }
    }
    if (kpi) ctx.summary = true;
    if (item) {
      ctx.item = item;
      ctx.lines.push(`Item under the pointer: ${[item.title, item.sub].filter(Boolean).join(' — ')}${item.rows && item.rows.length ? `; ${item.rows.map(([k, v]) => (k ? `${k} ${v}` : v)).join('; ')}` : ''}${item.tag ? `; ${item.tag}` : ''}${item.text ? `. ${item.text}` : ''}`);
    }
    if (selected) { ctx.selected = selected; ctx.lines.push(`Selected text: "${selected}"`); }
    // A paragraph of the dashboard's narrative
    const para = !item && !selected && t.closest('.chapter-lede p, .q-toc-desc p, .lede, .ins-text, .ins-takeaway p, .hero-facts > div, .ov-sections li, .data-table tr');
    if (para) { ctx.text = clip(clean(para.textContent), 600); ctx.lines.push(`Text: "${ctx.text}"`); }

    detectDims(ctx, [item && item.title, item && item.sub, ...(item && item.rows ? item.rows.flat() : []), selected,
      ans && ctx.figure && ctx.figure.title].filter(Boolean).join(' | '));
    // Dashboard filters in effect
    const filters = [];
    if (st.focus) filters.push(`state ${App.STATE_NAMES[st.focus] || st.focus}`);
    if (view === 'quality') {
      if (chartId === 'fig-funnel') filters.push(`infection ${inf(st.funnelInf).short}${st.funnelQuery ? `, search "${st.funnelQuery}"` : ''}`);
      if (chartId === 'fig-flags') filters.push(`infection ${inf(st.flagsInf).short}`);
      if (chartId === 'fig-map' || chartId === 'fig-ranks' || chartId === 'mapCard') { const M = mapMetric(); if (M) filters.push(`map measure ${M.label}`); }
      if (chartId === 'fig-outcome') filters.push(st.outcomeKind === 'readm' ? '30-day readmission rate' : '30-day death rate');
    }
    if (filters.length) ctx.lines.push(`Dashboard filters: ${filters.join('; ')}`);
    if (!ctx.dims.state && st.focus && view === 'quality' && section && ['fig-funnel', 'fig-ovr', 'fig-ed', 'exTable', 'hospMap'].includes(chartId)) ctx.dims.state = st.focus;
    ctx.el = item ? (kpi || finding || exRow || rankLi || article) : (article || kpi || finding || para || section);
    ctx.subject = subject(ctx);
    ctx.text = ctx.lines.join('\n');
    if (ctx.liveSuggest && ctx.liveSuggest.length) {
      const base = suggestions(ctx);
      ctx.questions = [...new Set([base[0], ...ctx.liveSuggest, ...base.slice(1)])].slice(0, 6);
    }
    return ctx;
  }

  // ---- what the reader has open: the live state of the dashboard's visuals and of figures in answers ------------------
  const LIVE = {
    matCard: { key: 'maternity', sel: '#matCard', api: () => App.maternity },
    hospMap: { key: 'hospitals', sel: '#mapCard', api: () => App.hospitalMap },
    exTable: { key: 'explorer', sel: '#explorer', api: () => App.explorer },
  };
  const VIEW_NAMES = { overview: 'Overview', quality: 'Quality & safety', insights: 'Insights and takeaways', ask: 'Ask your data' };
  function figureState(card) {
    const bits = [];
    const pressed = [...card.querySelectorAll('[aria-pressed="true"], .chip.on')].map((b) => clean(b.textContent)).filter(Boolean);
    if (pressed.length) bits.push(`showing ${[...new Set(pressed)].join(', ')}`);
    const searched = [...card.querySelectorAll('input')].map((i) => clean(i.value)).filter(Boolean);
    if (searched.length) bits.push(`highlighting "${searched.join('", "')}"`);
    if (card.__pick && card.__pick.length) bits.push(`clicked ${card.__pick.map(([k, v]) => `${k} ${v}`).join(', ')}`);
    return bits.join('; ');
  }
  // The visual the reader used last: a click, a key or a change inside it
  let lastUsed = null;
  function usedAt(t) {
    for (const v of Object.values(LIVE)) { const el = t.closest(v.sel); if (el) return { key: v.key, el, api: v.api }; }
    const a = t.closest('.ans-fig');
    return a ? { key: 'answer', el: a } : null;
  }
  ['pointerdown', 'keydown', 'change'].forEach((type) => document.addEventListener(type, (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t || t.closest('.sc-composer, .ask-composer, .qc-pop')) return;
    const hit = usedAt(t);
    if (hit) lastUsed = { ...hit, at: Date.now() };
  }, true));
  const onScreen = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && Math.min(r.bottom, innerHeight) - Math.max(r.top, 0) > Math.min(r.height, innerHeight) * 0.35;
  };
  function describeUsed(u) {
    if (u.key === 'answer') {
      const title = clean((u.el.querySelector('.card-head h3:not(.dash-orig)') || {}).textContent);
      const fs = figureState(u.el);
      return fs ? { text: `Figure "${title}" in an answer: ${fs}.` } : null;
    }
    const api = u.api && u.api();
    return api && api.describe ? api.describe() : null;
  }
  // The [On screen] block: the visual used last (within the half hour), then the dashboard's maps and explorer in view
  function liveState() {
    const view = document.documentElement.dataset.view || 'overview';
    const parts = [], keys = [], suggest = [];
    const add = (key, d, note) => {
      if (!d || !d.text || keys.includes(key)) return;
      keys.push(key);
      parts.push(note ? `${d.text} (${note})` : d.text);
      (d.suggest || []).forEach((q) => suggest.push(q));
    };
    if (lastUsed && lastUsed.el.isConnected && Date.now() - lastUsed.at < 30 * 60000) {
      const hidden = lastUsed.key !== 'answer' && view !== 'quality';
      add(lastUsed.key === 'answer' ? 'answer' : lastUsed.key, describeUsed(lastUsed), hidden ? 'used last, on the dashboard; not on screen now' : 'used last');
    }
    if (view === 'quality') Object.values(LIVE).forEach((v) => { const el = document.querySelector(v.sel); if (onScreen(el)) add(v.key, v.api() && v.api().describe ? v.api().describe() : null); });
    if (!parts.length) return null;
    const focus = App.state.focus ? `; state in focus ${App.STATE_NAMES[App.state.focus] || App.state.focus}` : '';
    return { text: [`View: ${VIEW_NAMES[view] || view}${focus}.`, ...parts].join('\n'), keys, suggest: [...new Set(suggest)] };
  }
  // The context sent with every question: what was right-clicked and what is on screen. The server passes it on to the
  // Copilot session only when it differs from what that session was last given (copilot/server.py api_chat).
  Chat.contextFor = function (surface, pointing) {
    const live = liveState();
    const context = [pointing && `[Pointing at]\n${pointing}`, live && `[On screen]\n${live.text}`].filter(Boolean).join('\n\n');
    return { context, keys: live ? live.keys : [] };
  };
  Chat.liveSuggestions = () => { const l = liveState(); return l ? l.suggest : []; };

  function guessKind(s) {
    s = String(s || '').toLowerCase();
    if (/nicu|deliver|maternity|birth|women/.test(s)) return 'maternity';
    if (/emergency|\bed\b|er time/.test(s)) return 'ed';
    if (/penalt|payment cut|hac\b|readmissions reduction|hrrp|vbp/.test(s)) return 'penalty';
    if (/death|mortality|readmission/.test(s)) return 'outcomes';
    if (/psi|safety|sepsis|respiratory|dehiscence|ulcer|composite/.test(s)) return 'safety';
    if (/star|hcahps|survey|experience|nurse|communication|recommend/.test(s)) return 'experience';
    if (/clabsi|cauti|mrsa|c\. ?diff|infection|sir|ssi|surgical site/.test(s)) return 'infection';
    return null;
  }

  function detectDims(ctx, s) {
    const d = ctx.dims;
    const ccn = s.match(/CCN\s*(\d{6})/);
    if (ccn) { d.ccn = ccn[1]; d.hospital = ctx.item && ctx.item.title; }
    if (!d.hospital && ctx.item && ctx.item.sub && /,\s*[A-Z]{2}\b/.test(ctx.item.sub) && ctx.item.title && !App.STATE_NAMES[ctx.item.title] && !NAME_TO_CODE[ctx.item.title.toLowerCase()]) {
      d.hospital = ctx.item.title;
    }
    if (d.hospital) {
      const where = (ctx.item.sub || '').match(/,\s*([A-Z]{2})\b/);
      if (where && App.STATE_NAMES[where[1]]) d.state = where[1];
    }
    if (!d.state && ctx.item && ctx.item.title) {
      const code = NAME_TO_CODE[ctx.item.title.toLowerCase()] || (App.STATE_NAMES[ctx.item.title] ? ctx.item.title : null);
      if (code) d.state = code;
    }
    const yr = (ctx.item && ctx.item.title || '').match(/^(?:FY)?(20\d\d)\b/);
    if (yr && !d.year) d.year = +yr[1];
    const star = s.match(/\b([1-5])\s*(?:★|stars?\b)/);
    if (star && !d.star && ctx.kind !== 'outcomes') d.star = +star[1];
    if (!ctx.infection) { const k = App.INF.find((x) => s.includes(x.short) || s.includes(x.label)); if (k) { ctx.infection = k.key; if (!ctx.kind) ctx.kind = 'infection'; } }
    if (!ctx.series && ctx.infection && (d.hospital || d.state)) ctx.series = true;  // HAI has every year for every hospital
    if (ctx.kind === 'outcomes' && ctx.item && App.X) {
      const c = App.X.conditions.find((x) => (ctx.item.title || '').toLowerCase().includes(x.label.toLowerCase()));
      if (c) d.condition = c.label;
    }
  }

  function subject(ctx) {
    const it = ctx.item;
    if (ctx.selected && !it) return { eyebrow: 'Selected text', title: clip(ctx.selected, 140), detail: '' };
    const eyebrow = [ctx.figure && ctx.figure.eyebrow, ctx.section && `${ctx.section.num} ${ctx.section.label}`, ctx.summary && 'Summary'].filter(Boolean).join(' · ')
      || ({ insights: 'Insights and takeaways', overview: 'Overview', ask: 'Ask your data' }[ctx.view] || 'Dashboard');
    if (it) return { eyebrow, title: it.title || (ctx.figure && ctx.figure.title) || 'This item', detail: [it.sub, ...(it.rows || []).slice(0, 3).map(([k, v]) => (k ? `${k} ${v}` : v)), it.tag].filter(Boolean).join(' · ') };
    if (ctx.liveSubject) return { eyebrow, title: ctx.liveSubject.title, detail: ctx.liveSubject.detail || '' };
    if (ctx.figure) return { eyebrow, title: ctx.figure.title, detail: ctx.figure.sub ? clip(ctx.figure.sub, 160) : '' };
    if (ctx.text) return { eyebrow, title: clip(ctx.text, 140), detail: '' };
    if (ctx.section) return { eyebrow, title: ctx.section.name, detail: '' };
    return { eyebrow, title: clean(document.title), detail: '' };
  }

  // ---- suggested questions ---------------------------------------------------------------------------------------------
  function suggestions(ctx) {
    const d = ctx.dims, out = [];
    const add = (q) => { if (q && !out.includes(q)) out.push(q); };
    const H = d.hospital, S = d.state && (App.STATE_NAMES[d.state] || d.state);
    const lc = (s) => (/^[A-Z][a-z]/.test(s || '') ? s[0].toLowerCase() + s.slice(1) : s || '');
    // noun: "CLABSI ratio", "PSI‑90", "emergency department time"; topic: what a hospital does better or worse on
    const long = lc(ctx.short || (ctx.infection ? `${inf(ctx.infection).short} ratio` : ctx.measure));
    const noun = long.length > 36 ? (ctx.infection ? `${inf(ctx.infection).short} ratio` : '') : long;
    const topic = ctx.infection ? inf(ctx.infection).short : noun;
    const series = ctx.series && ['infection', 'safety', 'experience'].includes(ctx.kind || '');
    const poss = (name) => `${name}${name.endsWith('s') ? '’' : '’s'}`;

    add(ctx.selected && !ctx.item ? 'Explain this passage in plain terms' : 'Explain this');
    if (H) {
      if (series && noun) add(`How has ${poss(H)} ${noun} changed since 2019?`);
      else if (['infection', 'safety', 'experience', 'hospital'].includes(ctx.kind)) add(`How has ${H} done on infections, safety and patient experience since 2019?`);
      add(`Show a report card for ${H} against hospitals${S ? ` in ${S}` : ' nationally'}`);
      if (series && noun) add(`Project ${poss(H)} ${noun} to 2030`);
      if (ctx.kind === 'maternity') add(`Which hospitals near ${H} deliver babies or have a NICU?`);
      if (S && topic) add(`Which hospitals in ${S} do better than ${H} on ${topic}?`);
    } else if (S) {
      if (noun) add(`How does ${S} compare with the nation on ${noun}?`);
      if (series && noun) add(`Project ${poss(S)} ${noun} for the next five years`);
      if (noun && ctx.kind !== 'maternity') add(`Which hospitals in ${S} drive its ${noun}?`);
      if (series) add(`How has ${S} changed since 2019?`);
      if (ctx.kind === 'maternity') { add(`Where in ${S} do women live more than an hour from a NICU?`); add(`Which hospitals in ${S} stopped delivering babies?`); }
    } else {
      if (series) add('Project it for the next five years');
      if (d.year) add(`What changed between 2019 and ${d.year}?`);
      if (noun && ctx.kind !== 'penalty') add(`How ${/s$/.test(noun) ? 'do' : 'does'} ${/ /.test(noun) && !/s$/.test(noun) ? 'the ' : ''}${noun} vary by state?`);
      if (ctx.infection) add(`Which hospitals are significantly worse than expected for ${topic}?`);
      else if (ctx.kind === 'safety') add('Which hospitals have the highest PSI‑90, and what drives it?');
    }
    if (d.star) add(`What sets ${d.star}-star hospitals apart on infections and safety?`);
    if (ctx.kind === 'penalty') { add('Which hospitals lost payments under both the HAC and readmissions programs?'); add('Which states have the most hospitals with HAC payment cuts?'); }
    if (ctx.kind === 'ed') add(`Do hospitals${S ? ` in ${S}` : ''} with longer emergency stays do worse on sepsis care?`);
    if (ctx.kind === 'outcomes' && d.condition) add(`Which hospitals${S ? ` in ${S}` : ''} have ${d.condition.toLowerCase()} death rates worse than the nation?`);
    if (ctx.kind === 'maternity' && !S) add('Which states have the most women more than an hour from a hospital that delivers babies?');
    if (ctx.kind === 'experience' && !H && !S) add('Which survey questions still score below 2019?');
    // A section or its text: the questions that section raises
    if (out.length < 3) {
      const more = {
        infection: ['Which infections improved most since 2019, and which got worse?', 'Project the national infection ratios to 2030'],
        state: ['Which states improved most on infections since 2019?', 'Which states are worst on PSI‑90?'],
        experience: ['Which survey questions still score below 2019?', 'Project the share of 4–5 star hospitals to 2030'],
        safety: ['Which PSI components rose most since 2019?', 'Project the national PSI‑90 to 2029'],
        outcomes: ['Which states have the highest heart failure death rates?', 'Do hospitals with more stars have lower death rates?'],
        maternity: ['Which states have the most women more than an hour from a hospital that delivers babies?', 'How many hospitals have stopped delivering babies in each state?'],
        hospital: ['Which hospitals lead on both patient experience and safety?', 'Which large hospitals have no infection flagged worse?'],
      }[ctx.kind] || [];
      more.forEach(add);
    }
    return out.slice(0, 6);
  }

  // ---- the quick chat ---------------------------------------------------------------------------------------------------
  // Right-click opens a popup by the pointer. The first character typed, or a suggested question picked, turns the popup
  // into the panel docked on the right, and the page narrows beside it. The panel can be resized from its left edge,
  // hidden, reopened from the top bar's Quick chat button, or opened in full in Ask your data.
  const WIDTH_KEY = 'cms-qc-width';
  const narrow = () => window.innerWidth < 900;
  const saved = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } };
  const GENERAL = {
    subject: { eyebrow: 'Quick chat', title: 'Ask about anything on the dashboard', detail: 'Or right-click a chart, a number or a finding to ask about it.' },
    questions: ['Which states improved most on infections since 2019?', 'Which hospitals lost payments under both the HAC and readmissions programs?', 'Where do women live more than an hour from a NICU?'],
    text: '',
  };
  const frames = (n, fn) => (n ? requestAnimationFrame(() => frames(n - 1, fn)) : fn());
  // Quick chat opened from its button: questions about what the reader is looking at, when there is something
  const general = () => { const q = Chat.liveSuggestions(); return q.length ? { ...GENERAL, questions: q.slice(0, 4) } : GENERAL; };

  function init() {
    const panel = $('sideChat'), pop = $('qcPop'), launch = $('qcLaunch');
    if (!panel || !pop) return;
    const html = document.documentElement;
    const log = $('scLog'), card = $('scContext'), list = $('scSuggest'), body = $('scBody');
    let current = null, marked = null, opener = null, signedIn = false, popCtx = null, popTo = 'panel', morphing = false, restoreOnLeave = false, popReady = false;
    const isOpen = () => panel.classList.contains('is-open');
    const hasTurns = () => !!log.querySelector('.turn');

    // ---- width: dragged from the panel's left edge, kept between visits
    const clampW = (w) => Math.round(Math.max(360, Math.min(w, 1000, window.innerWidth * 0.7)));
    let width = clampW(+saved(WIDTH_KEY, 440) || 440);
    const setWidth = (w) => { width = clampW(w); html.style.setProperty('--dock-w', `${width}px`); };
    setWidth(width);
    // The dashboard draws charts at their container's width, so it redraws once the page has settled at its new width
    let relayout = null;
    const settle = (ms = 480) => {
      clearTimeout(relayout);
      relayout = setTimeout(() => window.dispatchEvent(new Event('resize')), ms);  // maps and the tab underline
    };

    const mark = (el) => {
      if (marked) marked.classList.remove('is-asked');
      marked = el && el.isConnected && !panel.contains(el) && !pop.contains(el) ? el : null;
      markedPath = marked ? pathOf(marked) : null;
      if (marked) marked.classList.add('is-asked');
    };
    // The dashboard redraws its charts when the page changes width or theme, replacing what was outlined: find it again
    // by where it sat
    let markedPath = null;
    const pathOf = (el) => {
      const parts = [];
      for (let e = el; e && e.parentElement && e !== document.body; e = e.parentElement) {
        if (e.id) { parts.unshift(`#${CSS.escape(e.id)}`); return parts.join(' > '); }
        const same = [...e.parentElement.children].filter((c) => c.localName === e.localName);
        parts.unshift(`${e.localName}:nth-of-type(${same.indexOf(e) + 1})`);
      }
      return null;
    };
    const find = (el, path) => (el && el.isConnected ? el : path ? document.querySelector(path) : null);
    const remark = () => {
      if (!markedPath || (marked && marked.isConnected)) return;
      const el = document.querySelector(markedPath);
      marked = el && !panel.contains(el) ? el : null;
      if (marked) marked.classList.add('is-asked');
    };
    const renderAll = App.renderAll;
    App.renderAll = function (...args) { const r = renderAll.apply(this, args); remark(); requestAnimationFrame(remark); return r; };
    // What the panel is about, outlined again when a popup about something else is dismissed
    let subjectPath = null;
    const markSubject = () => mark(current ? find(current.el, subjectPath) : null);
    const subjectHtml = (s) => `<div class="sc-ctx-eyebrow">${esc(s.eyebrow)}</div><div class="sc-ctx-title">${esc(s.title)}</div>${s.detail ? `<div class="sc-ctx-detail">${esc(s.detail)}</div>` : ''}`;
    function show(ctx) {
      current = ctx;
      card.classList.remove('is-in');
      void card.offsetWidth;
      card.innerHTML = subjectHtml(ctx.subject);
      card.classList.add('is-in');
      list.innerHTML = (ctx.questions || suggestions(ctx)).map((q) => Chat.ui.qChip(q)).join('');
      list.hidden = false;
      $('scAbout').hidden = false;
      comp.input.placeholder = 'Ask about this, or anything else';
      mark(ctx.el);
      subjectPath = markedPath;
      scrollEnd();
    }
    const scrollEnd = () => requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });

    // While the page reflows to its new width (and its charts redraw), keep what the reader was looking at where it was;
    // let go as soon as they scroll themselves: wheel, touch, a scrolling key, or a click on the page or its scrollbar
    let holding = 0;
    const SCROLL_KEYS = new Set(['PageDown', 'PageUp', 'Home', 'End', 'ArrowDown', 'ArrowUp', ' ']);
    function holdScroll(ms = 2600) {
      if (narrow()) return;
      const page = $('page');
      const x = Math.min(window.innerWidth * 0.4, window.innerWidth - (isOpen() ? width : 0) - 60);
      let el = marked && document.contains(marked) ? marked : document.elementFromPoint(Math.max(20, x), window.innerHeight * 0.45);
      if (!el || !page || !page.contains(el)) return;
      el = el.closest('.card, .kpi, .ins-finding, .doc-sec, .chapter-head, .turn, tr') || el;
      const top0 = el.getBoundingClientRect().top, id = ++holding, until = performance.now() + ms;
      const ac = new AbortController(), on = { passive: true, signal: ac.signal };
      const stop = () => { holding++; ac.abort(); };
      window.addEventListener('wheel', stop, on);
      window.addEventListener('touchstart', stop, on);
      window.addEventListener('pointerdown', (e) => { if (!panel.contains(e.target) && !pop.contains(e.target)) stop(); }, on);
      window.addEventListener('keydown', (e) => {
        const t = e.target.closest ? e.target : null;
        if (!SCROLL_KEYS.has(e.key) || (t && t.closest('input, textarea, select, [contenteditable="true"]')) || (e.key === ' ' && t && t.closest('button'))) return;
        stop();
      }, on);
      const step = () => {
        if (id !== holding || !document.contains(el)) { ac.abort(); return; }
        const d = el.getBoundingClientRect().top - top0;
        if (Math.abs(d) > 1) window.scrollBy({ top: d, behavior: 'instant' });
        if (performance.now() < until) requestAnimationFrame(step); else ac.abort();
      };
      requestAnimationFrame(step);
    }

    // ---- docking
    function dock(open, { landing = false } = {}) {
      if (open === isOpen()) return;
      holdScroll();
      if (launch) launch.setAttribute('aria-expanded', String(open));
      if (open) {
        opener = document.activeElement;
        panel.hidden = false;
        panel.classList.toggle('is-landing', landing && !App.reduceMotion);
        html.classList.add('has-dock');
        frames(2, () => panel.classList.add('is-open'));
        if (landing) setTimeout(() => panel.classList.remove('is-landing'), 900);
        refresh();
      } else {
        panel.classList.remove('is-open', 'is-landing');
        html.classList.remove('has-dock');
        mark(null);
        App.tip.hide();
        setTimeout(() => { if (!isOpen()) panel.hidden = true; }, App.reduceMotion ? 0 : 460);
        if (opener && opener.focus && document.contains(opener) && panel.contains(document.activeElement)) opener.focus({ preventScroll: true });
      }
      settle();
    }
    // Opens the panel about something (the API other scripts use)
    Chat.openPanel = (ctx) => { closePopup(false); if (ctx) show(ctx); dock(true); };

    async function refresh() {
      signedIn = await Chat.ui.renderAccount($('scAccount'), { compact: true });
      panel.classList.toggle('is-signed-in', signedIn);
      if (signedIn) await Chat.ui.renderModels($('scModels')); else $('scModels').innerHTML = '';
      $('scForm').hidden = !signedIn;
    }

    // The visuals the last question came from (the one right-clicked, the one used last): an answer that redraws one of
    // the dashboard's maps puts its search on that map too, since it sits beside the panel
    let askedFrom = new Set();
    document.addEventListener('chat-care-map', (e) => {
      if (e.detail.surface !== 'panel' || !App.careMap) return;
      if (!App.careMap.target(e.detail.ui) || !askedFrom.has((e.detail.ui.options || {}).sync)) return;
      App.careMap.apply(e.detail.ui, { scroll: !narrow() });
    });
    async function ask(text) {
      if (!signedIn) await refresh();
      if (!signedIn) return;
      const ctx = current;
      const turn = document.createElement('section');
      turn.className = 'turn';
      const about = ctx && ctx.text ? ctx.subject.title : '';
      turn.innerHTML = Chat.ui.question(text, about);
      log.appendChild(turn);
      list.hidden = true;
      $('scAbout').hidden = true;
      comp.input.placeholder = 'Ask a follow-up question';
      follow.start();
      const { context, keys } = Chat.contextFor('panel', ctx ? ctx.text : '');
      askedFrom = new Set([ctx && ctx.source, keys[0]].filter(Boolean));
      await Chat.ask({ surface: 'panel', text, context, about, host: turn });
      follow.settle();
    }
    list.addEventListener('click', (e) => { const b = e.target.closest('[data-q]'); if (b) ask(b.dataset.q); });
    const comp = Chat.ui.composer($('scForm'), { surface: 'panel', onAsk: ask });
    document.addEventListener('chat-follow-up', (e) => { if (e.detail.surface === 'panel') ask(e.detail.text); });
    const follow = Chat.ui.follower({ box: body, content: log, visible: isOpen, busy: () => Chat.conversation('panel').busy });

    function newChat() {
      Chat.reset('panel');
      log.innerHTML = '';
      show(current || general());
      Chat.historyChanged();
    }
    // A saved chat, from the recent chats menu: drawn as it was answered, then continued in the panel. It opens at its
    // last question, as Ask your data does, with the box ready for a follow-up.
    Chat.openInPanel = async (id) => {
      const store = Chat.store();
      if (!store) return;
      if (Chat.conversation('panel').busy) Chat.stop('panel');
      const data = await store.getChat(id);
      Chat.ui.loadChat('panel', log, data);
      current = null;
      subjectPath = null;
      mark(null);
      list.hidden = true;
      $('scAbout').hidden = true;
      comp.input.placeholder = 'Ask a follow-up question';
      closePopup(false);
      dock(true);
      follow.stop();
      toLastQuestion();
      setTimeout(() => { if (isOpen()) comp.input.focus({ preventScroll: true }); }, App.reduceMotion ? 0 : 480);
    };
    // Replayed figures take a moment to reach their height, so the place is set again until they have, unless the
    // reader scrolls first
    function toLastQuestion() {
      const turns = log.querySelectorAll('.turn'), last = turns[turns.length - 1];
      if (!last) return;
      const ac = new AbortController(), on = { passive: true, signal: ac.signal };
      ['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach((t) => body.addEventListener(t, () => ac.abort(), on));
      const place = () => { if (!ac.signal.aborted && last.isConnected) body.scrollTop += last.getBoundingClientRect().top - body.getBoundingClientRect().top - 16; };
      requestAnimationFrame(place);
      [250, 700, 1400].forEach((ms) => setTimeout(place, ms));
      setTimeout(() => ac.abort(), 1500);
    }

    // ---- the popup
    // In Ask your data the popup belongs to the chat on screen: what is asked there is a follow-up in it, with what was
    // right-clicked as its context, and the quick chat stays closed
    const forAsk = () => popTo === 'ask';
    function askHere(question) {
      const ctx = popCtx;
      if (!ctx || !question) return;
      closePopup();
      mark(null);
      Chat.followUp('ask', question, { context: ctx.text, about: ctx.subject.title });
    }
    const pc = Chat.ui.composer($('qcForm'), { surface: 'popup', onAsk: (t) => (forAsk() ? askHere(t) : morph(t)) });
    pc.input.addEventListener('input', () => { if (!forAsk() && pc.input.value.trim()) morph(null); });
    $('qcSuggest').addEventListener('click', (e) => { const b = e.target.closest('[data-q]'); if (b) (forAsk() ? askHere : morph)(b.dataset.q); });
    $('qcPopClose').addEventListener('click', () => closePopup());
    // Tabbing out of the popup closes it, as a click outside does
    pop.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') setTimeout(() => { if (!morphing && !pop.contains(document.activeElement)) closePopup(); }, 0);
    });

    function placePop(x, y) {
      const m = 12, w = pop.offsetWidth, h = pop.offsetHeight, W = window.innerWidth, H = window.innerHeight;
      let left = x + 14, top = y + 8;
      if (left + w > W - m) left = Math.max(m, x - w - 14);
      if (top + h > H - m) top = Math.max(m, H - h - m);
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
      pop.style.setProperty('--qc-ox', `${Math.round(x - left)}px`);
      pop.style.setProperty('--qc-oy', `${Math.round(y - top)}px`);
    }
    async function openPopup(ctx, x, y, to = 'panel') {
      popCtx = ctx;
      popTo = to;
      const q = $('qcContext');
      q.classList.remove('is-in'); void q.offsetWidth;
      q.innerHTML = subjectHtml(ctx.subject);
      q.classList.add('is-in');
      $('qcSuggest').innerHTML = (ctx.questions || suggestions(ctx)).map((t) => Chat.ui.qChip(t)).join('');
      pc.input.value = '';
      pop.removeAttribute('style');
      pop.classList.remove('is-out', 'is-morphing', 'is-in');
      pop.hidden = false;
      placePop(x, y);
      void pop.offsetWidth;
      pop.classList.add('is-in');
      mark(ctx.el);
      App.tip.hide();
      pc.input.focus({ preventScroll: true });
      // Sign-in, only when it's needed
      const acct = $('qcAccount');
      const ok = await Chat.ui.renderAccount(acct, { compact: true });
      if (ok) acct.innerHTML = '';
      $('qcForm').hidden = !ok;
      popReady = ok;
      if (!pop.hidden && popCtx === ctx) placePop(x, y);
    }
    function closePopup(animate = true) {
      if (pop.hidden || morphing) return;
      popCtx = null;
      if (isOpen()) markSubject(); else mark(null);
      if (animate && !App.reduceMotion) {
        pop.classList.add('is-out');
        setTimeout(() => { if (pop.classList.contains('is-out')) { pop.hidden = true; pop.classList.remove('is-out'); } }, 160);
      } else pop.hidden = true;
    }
    // The popup travels to the panel's place and size while the page opens a margin for it; the question (typed so far,
    // or picked) goes to the panel, in a new quick chat. A question sent while it travels (Enter pressed straight after
    // typing) waits for it to land.
    let queued = null;
    function morph(question) {
      if (morphing) { if (question) queued = question; return; }
      if (!popCtx || forAsk()) return;
      morphing = true;
      const ctx = popCtx, r0 = pop.getBoundingClientRect(), wasOpen = isOpen();
      if (hasTurns() || Chat.conversation('panel').busy) newChat();
      show(ctx);
      dock(true, { landing: !wasOpen });
      const W = narrow() ? Math.min(window.innerWidth, 460) : width;
      // The popup already knows the reader is signed in, so the panel's box is shown now, ready to take the text
      if (popReady) { signedIn = true; $('scForm').hidden = false; }
      // Keystrokes keep going to the popup's (faded) box until the panel has landed and can take focus; then the text
      // and the caret move across, and only then does the popup go
      const finish = () => {
        const q = question || queued;
        queued = null;
        if (!q) {
          comp.set(pc.input.value);
          const n = comp.input.value.length;
          comp.input.setSelectionRange(n, n);
        } else comp.input.focus({ preventScroll: true });
        pc.input.value = '';
        pop.hidden = true;
        pop.classList.remove('is-morphing', 'is-in');
        pop.removeAttribute('style');
        popCtx = null;
        morphing = false;
        if (q) ask(q);
      };
      if (App.reduceMotion) { frames(3, finish); return; }
      Object.assign(pop.style, { left: `${r0.left}px`, top: `${r0.top}px`, width: `${r0.width}px`, height: `${r0.height}px` });
      pop.classList.remove('is-in');
      pop.classList.add('is-morphing');
      frames(1, () => Object.assign(pop.style, { left: `${window.innerWidth - W}px`, top: '0px', width: `${W}px`, height: `${window.innerHeight}px` }));
      setTimeout(finish, 470);
    }

    // ---- the panel's controls
    $('scClose').addEventListener('click', () => dock(false));
    $('scNew').addEventListener('click', () => { newChat(); comp.input.focus(); });
    // Ask your data opens the quick chat in full, and the conversation carries on there
    function moveToAsk() {
      const c = Chat.conversation('panel');
      if (c.busy) return false;
      const turns = [...log.querySelectorAll('.turn')], id = c.id, history = c.history, sessionId = c.sessionId;
      Object.assign(c, { id: null, history: null, sessionId: null, resume: null });
      restoreOnLeave = false;
      dock(false);
      log.innerHTML = '';
      current = null;
      Chat.openAsk({ turns, chatId: id, history, sessionId });
      return true;
    }
    $('scExpand').addEventListener('click', () => { if (!moveToAsk()) return; });
    if (launch) launch.addEventListener('click', () => {
      if (isOpen()) { dock(false); return; }
      closePopup(false);
      if (!hasTurns()) show(current || general());
      dock(true);
      setTimeout(() => comp.input.focus({ preventScroll: true }), App.reduceMotion ? 0 : 480);
    });

    const handle = $('scResize');
    handle.addEventListener('pointerdown', (e) => {
      if (narrow() || e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      html.classList.add('dock-resizing');
      const move = (ev) => setWidth(window.innerWidth - ev.clientX);
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        html.classList.remove('dock-resizing');
        save(WIDTH_KEY, width);
        settle(60);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
    handle.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      setWidth(width + (e.key === 'ArrowLeft' ? 32 : -32));
      save(WIDTH_KEY, width);
      settle(250);
    });
    handle.addEventListener('dblclick', () => { setWidth(440); save(WIDTH_KEY, width); settle(60); });
    window.addEventListener('resize', () => setWidth(width));

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (!pop.hidden) { e.preventDefault(); closePopup(); return; }
      if (isOpen() && narrow()) dock(false);
      else if (isOpen() && panel.contains(document.activeElement)) dock(false);
    });
    document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !morphing && e.button === 0 && !pop.contains(e.target)) closePopup(); }, true);
    window.addEventListener('scroll', () => { if (!pop.hidden && !morphing) closePopup(); }, { passive: true });
    document.addEventListener('dash-show', () => { if (narrow()) dock(false); });
    Chat.onChange(() => { if (!Chat.login && isOpen()) refresh(); });

    // The Ask your data tab is the full chat: the quick chat steps aside there, and its chat follows if it was used last
    function onView() {
      const ask = location.hash === '#ask';
      if (launch) launch.hidden = ask;
      if (ask) {
        closePopup(false);
        if (Chat.lastSurface === 'panel' && hasTurns() && moveToAsk()) return;
        if (isOpen()) { restoreOnLeave = true; dock(false); }
      } else if (restoreOnLeave) {
        restoreOnLeave = false;
        dock(true);
      }
    }
    window.addEventListener('hashchange', onView);
    onView();

    // Right-click anywhere on the page opens the popup about what's under the pointer
    document.addEventListener('mousedown', (e) => {
      if (e.button !== 2) return;
      const s = window.getSelection(), text = s && !s.isCollapsed ? s.toString().trim() : '';
      heldSelection = text ? { text, at: performance.now() } : null;
    }, true);
    document.addEventListener('contextmenu', (e) => {
      if (e.shiftKey || e.altKey) return;
      const t = e.target instanceof Element ? e.target : e.target.parentElement;
      if (!t || t.closest('input, textarea, select, [contenteditable="true"], .sc-composer, .ask-composer, .qc-pop, a[href^="http"]')) return;
      // Ask your data is the full chat already: a figure in its answers is asked about there, as a follow-up; elsewhere
      // on the tab the browser keeps its menu
      if (html.dataset.view === 'ask') {
        if (!t.closest('#view-ask .ans-fig')) return;
        e.preventDefault();
        openPopup(capture(e), e.clientX, e.clientY, 'ask');
        return;
      }
      if (t.closest('#sideChat') && !t.closest('.ans-fig')) return;
      e.preventDefault();
      openPopup(capture(e), e.clientX, e.clientY);
    });
  }

  Chat.ready.then((ok) => { if (ok) init(); });
})();
