/* Orchestration: facts, theme toggle, state focus, scrollspy, resize, view tabs */
(function () {
  'use strict';
  const App = window.App;

  // Charts in a hidden view would measure zero width; they redraw when their view is shown again. Every chart belongs to
  // the Quality & safety view except the trend lines on the Insights view.
  const hiddenView = (name) => !!document.getElementById(name === 'insights' ? 'view-insights' : 'view-quality')?.hidden;

  App.renderOne = function (name, anim = false) {
    const c = App.charts.find((x) => x.name === name);
    if (!c || hiddenView(name)) return;
    const animate = anim && !App.reduceMotion && document.visibilityState === 'visible';
    try { c.fn(animate); } catch (e) { console.error(`[${name}]`, e); }
  };
  App.renderAll = function (anim = false) {
    App.readColors();
    stale.clear();
    if (nearIO) nearIO.disconnect();
    App.charts.forEach((c) => { if (hiddenView(c.name)) return; try { c.fn(anim); } catch (e) { console.error(`[${c.name}]`, e); } });
  };

  // The charts that follow the focused state, and the element each one draws into
  const FOCUS_CHARTS = { map: 'mapCard', ranks: 'ranksCard', funnel: 'fig-funnel', explorer: 'exTable', ovr: 'fig-ovr', edStates: 'fig-ed' };
  // A focus change redraws the charts on or near the screen straight away. The rest wait until you scroll near them,
  // above all the street map in section 03, which builds a WebGL map: picking a state never stalls the chart you clicked.
  const NEAR = 500;
  const stale = new Map();
  let nearIO = null;
  const isNear = (el) => { const r = el.getBoundingClientRect(); return r.height > 0 && r.bottom > -NEAR && r.top < innerHeight + NEAR; };
  App.renderSoon = function (name) {
    const el = document.getElementById(FOCUS_CHARTS[name]);
    if (!el || hiddenView(name) || isNear(el)) { stale.delete(name); App.renderOne(name); return; }
    if (!nearIO) {
      nearIO = new IntersectionObserver((entries) => entries.forEach((e) => {
        if (!e.isIntersecting) return;
        nearIO.unobserve(e.target);
        [...stale].filter(([, x]) => x === e.target).forEach(([n]) => { stale.delete(n); App.renderOne(n); });
      }), { rootMargin: `${NEAR}px 0px` });
    }
    stale.set(name, el);
    nearIO.observe(el);
  };

  App.setFocus = function (code) {
    const next = code || '';
    const update = () => {
      App.state.focus = next;
      const sel = document.getElementById('stateFocus');
      sel.value = App.state.focus;
      sel.closest('.state-pick').classList.toggle('has-value', !!App.state.focus);
      App.explorer.reset();
      Object.keys(FOCUS_CHARTS).forEach((n) => App.renderSoon(n));
    };
    // Opening a state's street map (or going back to all states) morphs the map card rather than cutting
    const crossing = !App.state.focus !== !next;
    if (crossing && App.transitionFocus) App.transitionFocus(update, next ? 'in' : 'out');
    else update();
  };

  function fillFacts() {
    const F = Object.assign(App.computeFacts(), App.outcomeFacts ? App.outcomeFacts() : {});
    document.querySelectorAll('[data-fact]').forEach((n) => { n.innerHTML = F[n.dataset.fact] ?? ''; });
    const m = App.meta;
    document.getElementById('lede').innerHTML =
      `Across <b>${F.nHai}</b> hospitals reporting infection data to CMS, central‑line bloodstream infections are <b>${F.clabsiPeakDrop} below</b> their ${F.clabsiPeakYear} pandemic peak and C.&nbsp;diff has fallen <b>${F.cdiffDrop}</b> since 2019. ` +
      `Patient‑experience star ratings are back to pre‑pandemic levels and the PSI‑90 safety composite has held steady. ` +
      `The exception is infections after abdominal hysterectomy, up <b>${F.hystRise}</b> to an SIR of <b>${F.hystNow}</b>, which is above the national baseline.`;
    const fmtP = (p) => (p ? ` (${p.map((d) => d3.timeFormat('%b %Y')(new Date(d + 'T00:00:00'))).join(' – ')})` : '');
    const per = m.periods || {};
    const psiYears = App.P.map((d) => d.year);
    const psiGaps = d3.range(psiYears[0], psiYears[psiYears.length - 1]).filter((y) => !psiYears.includes(y));
    document.getElementById('periodNote').innerHTML = `Latest periods: HAI report year ${m.haiYear}${fmtP(per.hai)}, HCAHPS ${m.hcahpsYear}${fmtP(per.hcahps)}, PSI‑90 ${m.psiYear}${fmtP(per.psi)}. ` +
      `Trends cover report years ${App.first.year}–${App.last.year}${psiGaps.length ? `; PSI‑90 has no ${psiGaps.join(', ')} release` : ''}. Facility rows: ${F.nFac} hospitals in the latest period.`;
    document.getElementById('headline').innerHTML = F.headline;
  }

  function initTheme() {
    const btns = [...document.querySelectorAll('#themeSeg [data-theme-set]')];
    const sync = () => {
      const t = App.isDark() ? 'dark' : 'light';
      btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === t)));
    };
    const apply = (t) => {
      document.documentElement.dataset.theme = t;
      sync();
      App.renderAll(false);
    };
    sync();
    btns.forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.themeSet === (App.isDark() ? 'dark' : 'light')) return;
      try { localStorage.setItem('cms-theme', b.dataset.themeSet); } catch (e) { /* storage unavailable */ }
      apply(b.dataset.themeSet);
    }));
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      let saved = null;
      try { saved = localStorage.getItem('cms-theme'); } catch (err) { /* ignore */ }
      if (!saved) apply(e.matches ? 'dark' : 'light');
    });
  }

  // Numbered sections fold away under their titles. What is folded is remembered, and following a link to a folded
  // section (the section bar, or a #hash) opens it again.
  function initChapters() {
    const KEY = 'cms-collapsed';
    const root = document.documentElement;
    const chapters = [...document.querySelectorAll('section.chapter')];
    let saved = [];
    try { saved = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { /* storage unavailable */ }
    const save = () => {
      try { localStorage.setItem(KEY, JSON.stringify(chapters.filter((c) => c.classList.contains('collapsed')).map((c) => c.id))); } catch (e) { /* ignore */ }
    };
    const set = (ch, collapsed) => {
      if (ch.classList.contains('collapsed') === collapsed) return;
      ch.querySelectorAll('.chapter-toggle, .chapter-act').forEach((b) => b.setAttribute('aria-expanded', String(!collapsed)));
      ch.querySelector('.chapter-act-label').textContent = collapsed ? 'Show' : 'Hide';
      // Content is clipped only while it folds, so focus rings and dropdowns are never cut off in an open section
      ch.classList.add('folding');
      clearTimeout(ch.foldTimer);
      ch.foldTimer = setTimeout(() => ch.classList.remove('folding'), 560);
      ch.classList.toggle('collapsed', collapsed);
      App.tip.hide();
    };
    // Every section rule carries a pill for each section in its view: its own is solid, the others link to theirs
    const viewOf = (ch) => chapters.filter((c) => c.closest('main') === ch.closest('main'));
    const pillsFor = (ch) => viewOf(ch).map((c) => {
      const name = App.esc(c.querySelector('.chapter-name').textContent);
      const on = c === ch;
      return `<a class="chapter-pill${on ? ' on' : ''}" href="#${c.id}"${on ? ' aria-current="location"' : ''} title="${c.dataset.num} ${name}" aria-label="Section ${c.dataset.num}: ${name}">${c.dataset.num}</a>`;
    }).join('');
    // Each section's rule carries its number and short name; the contents rail beside the sections lists them all
    chapters.forEach((ch) => {
      ch.querySelector('.chapter-stick').insertAdjacentHTML('afterbegin',
        `<div class="chapter-tag" aria-hidden="true"><span class="chapter-tag-num">${ch.dataset.num}</span>${App.esc(ch.dataset.label || '')}</div>`);
    });
    buildRail(chapters);
    root.classList.add('fold-init');
    chapters.forEach((ch) => {
      if (saved.includes(ch.id)) set(ch, true);
      ch.querySelectorAll('.chapter-toggle, .chapter-act').forEach((b) => b.addEventListener('click', () => { set(ch, !ch.classList.contains('collapsed')); save(); }));
    });
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('fold-init')));
    const openFor = (hash) => {
      const target = hash && hash.length > 1 && document.getElementById(decodeURIComponent(hash.slice(1)));
      const ch = target && target.closest('section.chapter');
      if (!ch || !ch.classList.contains('collapsed')) return;
      // The section's spacing settles at once (the content still unfolds), so the scroll lands on its final position
      ch.style.transition = 'none';
      set(ch, false);
      save();
      void ch.offsetHeight;
      requestAnimationFrame(() => { ch.style.transition = ''; });
    };
    document.addEventListener('click', (e) => { const a = e.target.closest('.chapter-pill[href], .section-bar-name, .q-toc-link'); if (a) openFor(a.getAttribute('href')); });
    window.addEventListener('hashchange', () => { openFor(location.hash); queue(); });
    openFor(location.hash);

    // Once a section's title has scrolled under the header, the section bar pins its number and title; the bar leaves
    // just before the section ends, so it never covers the next one.
    const topbar = document.querySelector('.topbar');
    const bar = document.getElementById('sectionBar');
    let pinned = null, queued = false, stickTop = -1;
    function track() {
      queued = false;
      const T = topbar.getBoundingClientRect().bottom;
      if (T !== stickTop) { stickTop = T; document.documentElement.style.setProperty('--stick-top', `${Math.round(T)}px`); }
      let pin = null;
      chapters.forEach((ch) => {
        const r = ch.getBoundingClientRect();
        if (!r.height || ch.classList.contains('collapsed')) return;
        // Beside the contents rail, the rail already shows where you are
        if (RAIL_MQ.matches) return;
        if (ch.querySelector('.chapter-title').getBoundingClientRect().bottom < T && r.bottom > T + 110) pin = ch;
      });
      if (pin === pinned) return;
      pinned = pin;
      if (pin) {
        bar.querySelector('.chapter-pills').innerHTML = pillsFor(pin);
        const name = bar.querySelector('.section-bar-name');
        name.textContent = pin.querySelector('.chapter-name').textContent;
        name.setAttribute('href', `#${pin.id}`);
      }
      bar.classList.toggle('on', !!pin);
    }
    function queue() { if (!queued) { queued = true; requestAnimationFrame(track); } }
    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', queue);
    chapters.forEach((ch) => ch.addEventListener('transitionend', (e) => { if (e.target === ch.querySelector('.chapter-body')) queue(); }));
    App.trackSections = queue;
    queue();
  }

  // The contents rail (wide screens): every section's number and short name; the section you're reading expands to its
  // title and description. Those are copies of the section's own (which stay in the section for screen readers and for
  // narrow screens, where the rail is just the numbers), kept in step as facts and the maternity headline fill in.
  // Wide enough for the rail: the page's own width (it narrows beside the quick chat), like the CSS container queries
  const RAIL_MQ = (() => {
    const page = document.getElementById('page'), fns = new Set();
    const q = { matches: false, addEventListener: (_, fn) => fns.add(fn) };
    const check = () => {
      const m = (page ? page.clientWidth : window.innerWidth) >= 1100;
      if (m !== q.matches) { q.matches = m; fns.forEach((fn) => fn()); }
    };
    check();
    if (page && window.ResizeObserver) new ResizeObserver(check).observe(page); else window.addEventListener('resize', check);
    return q;
  })();
  function buildRail(chapters) {
    const toc = document.getElementById('qToc');
    if (!toc) return;
    const copy = (from, to) => {
      const sync = () => {
        to.innerHTML = from.innerHTML;
        to.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
      };
      sync();
      new MutationObserver(sync).observe(from, { childList: true, subtree: true, characterData: true });
    };
    chapters.forEach((ch) => {
      const li = document.createElement('li');
      li.className = 'q-toc-item';
      li.innerHTML = `<a class="q-toc-link" href="#${ch.id}"><span class="chapter-pill">${ch.dataset.num}</span><span class="q-toc-name">${App.esc(ch.dataset.label || '')}</span></a>
        <div class="q-toc-detail" aria-hidden="true"><div><div class="q-toc-title"></div><div class="q-toc-desc"></div></div></div>`;
      toc.appendChild(li);
      copy(ch.querySelector('.chapter-name'), li.querySelector('.q-toc-title'));
      copy(ch.querySelector('.chapter-lede > div'), li.querySelector('.q-toc-desc'));
    });
    // Beside the rail a section's title is visually hidden (the rail shows it), so its fold button leaves the tab order;
    // the Hide/Show control on the section's rule does the same job
    const tabbable = () => chapters.forEach((ch) => ch.querySelectorAll('.chapter-toggle').forEach((b) => {
      if (RAIL_MQ.matches) b.setAttribute('tabindex', '-1'); else b.removeAttribute('tabindex');
    }));
    tabbable();
    RAIL_MQ.addEventListener('change', tabbable);
  }

  function initFocusSelect() {
    const sel = document.getElementById('stateFocus');
    Object.keys(App.S).filter((c) => App.STATE_NAMES[c]).sort((a, b) => App.STATE_NAMES[a].localeCompare(App.STATE_NAMES[b]))
      .forEach((c) => { const o = document.createElement('option'); o.value = c; o.textContent = App.STATE_NAMES[c]; sel.appendChild(o); });
    sel.addEventListener('change', () => App.setFocus(sel.value));
    let t;
    document.getElementById('funnelSearch').addEventListener('input', (e) => {
      clearTimeout(t);
      t = setTimeout(() => { App.state.funnelQuery = e.target.value; App.renderOne('funnel'); }, 150);
    });
  }

  // The rail marks and expands the section you are reading: the last section whose top has passed a line a third of the
  // way down the screen (sections such as the maternity map are taller than the screen, so edges alone don't tell)
  function initScrollspy() {
    const items = [...document.querySelectorAll('#qToc .q-toc-item')];
    const sections = items.map((li) => document.getElementById(li.querySelector('.q-toc-link').getAttribute('href').slice(1)));
    const rail = document.querySelector('.q-rail-inner');
    const topbar = document.querySelector('.topbar');
    let queued = false, current = null, settle = 0;
    // When the rail is taller than the screen, scroll it (not the page) so the expanded section shows in full
    const reveal = (li) => {
      if (!rail || rail.scrollHeight <= rail.clientHeight + 1) return;
      const r = rail.getBoundingClientRect(), b = li.getBoundingClientRect();
      let dy = 0;
      if (b.bottom > r.bottom - 8) dy = b.bottom - r.bottom + 8;
      if (b.top - dy < r.top + 4) dy = b.top - r.top - 4;
      if (dy) rail.scrollBy({ top: dy, behavior: App.reduceMotion ? 'auto' : 'smooth' });
    };
    const mark = () => {
      queued = false;
      if (document.getElementById('view-quality').hidden || !items.length) return;
      const T = topbar.getBoundingClientRect().bottom, line = T + (innerHeight - T) * 0.33;
      let cur = 0;
      sections.forEach((sec, i) => { if (sec.getBoundingClientRect().top <= line) cur = i; });
      if (cur === current) return;
      current = cur;
      items.forEach((li, i) => {
        const on = i === cur, a = li.querySelector('.q-toc-link');
        li.classList.toggle('on', on);
        li.querySelector('.chapter-pill').classList.toggle('on', on);
        if (on) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
      });
      clearTimeout(settle);
      settle = setTimeout(() => reveal(items[cur]), 520);
    };
    const queue = () => { if (!queued) { queued = true; requestAnimationFrame(mark); } };
    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', queue);
    App.scrollspy = queue;
    queue();
  }

  // Charts redraw when the page's width changes: the window resizing, or the page narrowing beside the quick chat
  function initResize() {
    const page = document.getElementById('page');
    const width = () => (page ? page.clientWidth : window.innerWidth);
    let lastW = width(), t;
    const changed = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (width() === lastW) return;
        lastW = width();
        App.renderAll(false);
      }, 160);
    };
    if (page && window.ResizeObserver) new ResizeObserver(changed).observe(page);
    else window.addEventListener('resize', changed);
  }

  // Three views share the top bar: the overview, the Quality & safety dashboard and the written insights. The URL hash
  // picks the view, so links, reloads and the back button all land on the right one; switching cross-fades and the tab
  // underline slides across.
  const SOURCE = { overview: ['CMS Care Compare', 'Public data from the CMS Provider Data Catalog'], quality: ['CMS Care Compare', 'Public data from the CMS Provider Data Catalog, plus Census and OpenStreetMap'], insights: ['CMS Care Compare', 'Public data from the CMS Provider Data Catalog'], ask: ['CMS Care Compare', 'Answers by GitHub Copilot from the CMS and CMS V2 semantic models in your Fabric workspace'] };
  function initViews() {
    const tabs = [...document.querySelectorAll('.view-tab')];
    const views = { overview: document.getElementById('view-overview'), quality: document.getElementById('view-quality'), insights: document.getElementById('view-insights'), ask: document.getElementById('view-ask') };
    const ink = document.querySelector('.view-tab-ink');
    if (!tabs.length) return;
    let current = '';
    const viewFor = (hash) => {
      if (!hash || hash === '#' || hash === '#overview' || /^#ov-/.test(hash)) return 'overview';
      if (/^#insight/.test(hash)) return 'insights';
      if (hash === '#ask') return 'ask';
      return 'quality';
    };
    // A link into the middle of a view (a section or a finding), rather than to the view itself
    const deepTarget = () => {
      let id = decodeURIComponent(location.hash.slice(1));
      if (!id || ['overview', 'quality', 'insights', 'ask'].includes(id)) return null;
      // Links saved from the old Maternity care tab open its map, now section 04
      if (/^mat-/.test(id)) id = 'maternity';
      return document.getElementById(id);
    };
    const moveInk = () => {
      const on = tabs.find((t) => t.dataset.view === current);
      if (!on || !ink) return;
      ink.style.width = `${on.offsetWidth}px`;
      ink.style.transform = `translateX(${on.offsetLeft}px)`;
    };
    const swap = (name) => {
      current = name;
      document.documentElement.dataset.view = name;
      tabs.forEach((t) => { const on = t.dataset.view === name; t.classList.toggle('on', on); t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? -1 : 0; });
      const src = document.getElementById('sourceId');
      if (src && SOURCE[name]) { src.textContent = SOURCE[name][0]; src.title = SOURCE[name][1]; }
      Object.entries(views).forEach(([k, el]) => { if (el) el.hidden = k !== name; });
      moveInk();
      App.tip.hide();
      // Charts measure their container, so a view's charts draw (or redraw at its real width) as it is shown
      if (name !== 'overview' && name !== 'ask') App.renderAll(false);
      if (App.trackSections) App.trackSections();
      if (App.scrollspy) App.scrollspy();
    };
    const apply = (name, animate) => {
      if (name === current) return;
      const go = () => {
        swap(name);
        // The browser can't scroll to an element while its view is hidden, so follow deep links once the view is shown
        // The new view replaces the old one, so jump straight there rather than scrolling through it
        const t = deepTarget();
        if (t) requestAnimationFrame(() => t.scrollIntoView({ block: 'start', behavior: 'instant' }));
        else window.scrollTo(0, 0);
      };
      if (animate && current && !App.reduceMotion && document.startViewTransition) {
        document.documentElement.dataset.viewVt = '1';
        const vt = document.startViewTransition(go);
        vt.finished.finally(() => { delete document.documentElement.dataset.viewVt; });
      } else go();
    };
    window.addEventListener('hashchange', () => apply(viewFor(location.hash), true));
    window.addEventListener('resize', moveInk);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveInk);
    apply(viewFor(location.hash), false);
    requestAnimationFrame(() => document.documentElement.classList.add('tabs-ready'));
  }

  function boot() {
    fillFacts();
    initTheme();
    initChapters();
    initFocusSelect();
    App.explorer.init();
    App.renderAll(false);
    initScrollspy();
    initResize();
    initViews();
    window.addEventListener('scroll', () => App.tip.hide(), { passive: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
