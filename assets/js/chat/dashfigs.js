/* The dashboard's own figures, redrawn inside Ask your data answers (show_dashboard_figure).

   A figure is copied from its card on the dashboard (title, subtitle, legend and chips included) and drawn by the
   dashboard's own chart code, with element lookups pointed at the copy and its own copy of the filters (infection,
   state, metric, hospital). Clicks on the copy never reach the dashboard; its chips and search redraw the copy only.
   Each figure also reports what it shows, from the same data, so Copilot's text matches the drawing.
   "Show on the dashboard" applies the same settings to the real figure and scrolls to it. */
(function () {
  'use strict';
  const App = window.App;
  const esc = App.esc, f2 = App.f2, f0 = App.f0, pct = App.pct0, pct1 = App.pct1;

  // id: dashboard chart, its element, section, chips (chips element -> state key), parameters (param -> state key)
  const FIGS = {
    infection_trends: { chart: 'smallMultiples', el: 'fig-sm', section: 'infections', label: 'Fig 1, infection trends' },
    infection_change: { chart: 'dumbbell', el: 'fig-db', section: 'infections', label: 'Fig 2, change since 2019' },
    infection_flags: { chart: 'flags', el: 'fig-flags', section: 'infections', label: 'Fig 3, hospitals flagged',
      chips: { 'chips-flags': 'flagsInf' }, params: { infection: 'flagsInf' } },
    funnel: { chart: 'funnel', el: 'fig-funnel', section: 'benchmark', label: 'Fig 4, the funnel plot',
      chips: { 'chips-funnel': 'funnelInf' }, params: { infection: 'funnelInf', state: 'focus', hospital: 'funnelQuery' } },
    state_map: { chart: 'map', el: 'fig-map', section: 'geography', label: 'Fig 5, the state map', extra: ['chips-map'],
      prune: '#hmTools, #hmBar, #hmStatus, #hospMap', chips: { 'chips-map': 'mapMetric' }, params: { metric: 'mapMetric', state: 'mark' } },
    state_ranks: { chart: 'ranks', el: 'fig-ranks', section: 'geography', label: 'Fig 6, states ranked', params: { metric: 'mapMetric', state: 'focus' } },
    star_mix: { chart: 'stars', el: 'fig-stars', section: 'experience', label: 'Fig 7, the star mix' },
    survey_change: { chart: 'heatmap', el: 'fig-heat', section: 'experience', label: 'Fig 8, survey questions' },
    psi_spread: { chart: 'psiTrend', el: 'fig-psi', section: 'safety', label: 'Fig 9, PSI‑90 spread' },
    psi_components: { chart: 'psiComponents', el: 'fig-psicomp', section: 'safety', label: 'Fig 10, PSI components' },
    star_flags: { chart: 'starFlags', el: 'fig-starflags', section: 'connections', label: 'Fig 11, stars and infections' },
    psi_by_star: { chart: 'ridge', el: 'fig-ridge', section: 'connections', label: 'Fig 12, PSI‑90 by star rating' },
    overall_stars: { chart: 'ovr', el: 'fig-ovr', section: 'outcomes', label: 'Fig 13, overall star rating', params: { state: 'focus' } },
    ed_by_state: { chart: 'edStates', el: 'fig-ed', section: 'outcomes', label: 'Fig 14, emergency department time', params: { state: 'focus' } },
    outcome_ranges: { chart: 'outcomeRanges', el: 'fig-outcome', section: 'outcomes', label: 'Fig 15, death and readmission rates',
      chips: { 'chips-outcome': 'outcomeKind' }, params: { outcome: 'outcomeKind' } },
    penalties: { chart: 'penalties', el: 'fig-pen', section: 'outcomes', label: 'Fig 16, Medicare payment cuts' },
  };

  const stateName = (c) => App.STATE_NAMES[c] || c;

  // ---- what each figure shows, from the dashboard's data ---------------------------------------------------------------
  const sirSeries = (k) => App.T.map((d) => ({ y: d.year, v: d[k].sir }));
  const peak = (s) => s.reduce((a, b) => (b.v > a.v ? b : a));
  const FACTS = {
    infection_trends: () => 'National pooled SIR by report year (below 1.0 is better than the 2015 baseline): ' + App.INF.map((inf) => {
      const s = sirSeries(inf.key), a = s[0], z = s[s.length - 1], p = peak(s);
      return `${inf.short} ${a.y} ${f2(a.v)} → ${z.y} ${f2(z.v)} (peak ${f2(p.v)} in ${p.y})`;
    }).join('; ') + '. The COVID-19 years 2020-2021 are shaded.',
    infection_change: () => `National SIR ${App.first.year} → ${App.last.year} and the pandemic-era peak: ` + App.INF.map((inf) => {
      const s = sirSeries(inf.key), a = s[0], z = s[s.length - 1], p = peak(s);
      return `${inf.short} ${a.y} ${f2(a.v)} → ${z.y} ${f2(z.v)} (${App.signPct(z.v / a.v - 1)}; peak ${f2(p.v)} in ${p.y})`;
    }).join('; ') + '.',
    infection_flags: (st) => {
      const k = st.flagsInf, inf = App.infByKey[k];
      return `${inf.label}: share of reporting hospitals whose 95% CI is wholly below 1.0 (better) or above it (worse), by report year: ` +
        App.T.map((d) => `${d.year} ${pct1(d[k].better / d[k].n)} better (${f0(d[k].better)}), ${pct1(d[k].worse / d[k].n)} worse (${f0(d[k].worse)}) of ${f0(d[k].n)}`).join('; ') + '.';
    },
    funnel: (st) => {
      const k = st.funnelInf, inf = App.infByKey[k];
      const pts = App.facilities.filter((f) => f[k] && f[k].sir != null && f[k].pred > 0);
      const count = (list) => { const c = d3.rollup(list, (v) => v.length, (f) => f[k].cls); return `${f0(list.length)} hospitals: ${f0(c.get('worse') || 0)} worse than benchmark, ${f0(c.get('better') || 0)} better, ${f0(c.get('similar') || 0)} no different`; };
      const out = [`${inf.label}, ${App.meta.haiYear} report. Every hospital's SIR against its predicted infections with 95% and 99.8% Poisson limits around 1.0; colour is CMS's classification from each hospital's own 95% CI. National pooled SIR ${f2(App.last[k].sir)}. Nationally ${count(pts)}.`];
      if (st.focus) out.push(`Highlighted: ${stateName(st.focus)}, ${count(pts.filter((f) => f.st === st.focus))}.`);
      const q = (st.funnelQuery || '').trim().toLowerCase();
      if (q) {
        const hits = pts.filter((f) => (!st.focus || f.st === st.focus) && f._search.includes(q));
        if (!hits.length) out.push(`No hospital with ${inf.short} data matches "${st.funnelQuery}".`);
        hits.slice(0, 6).forEach((f) => { const v = f[k]; out.push(`${f.name} (${f.city}, ${f.st}, CCN ${f.id}): SIR ${f2(v.sir)}, observed ${v.obs} vs predicted ${App.f1(v.pred)}, 95% CI ${v.lo != null ? f2(v.lo) : '—'}–${v.hi != null ? f2(v.hi) : '—'}, ${App.CLS_LABEL[v.cls].toLowerCase()}.`); });
        if (hits.length > 6) out.push(`${hits.length} hospitals match "${st.funnelQuery}"; the figure labels none of them, so name one exactly to single it out.`);
      }
      return out.join(' ');
    },
    state_map: (st) => stateFacts(st, 'Tile map of states coloured against the national figure'),
    state_ranks: (st) => stateFacts(st, 'States ranked, best and worst seven shown'),
    star_mix: () => {
      const rows = App.H.map((d) => { const c = [d.s1, d.s2, d.s3, d.s4, d.s5], n = d3.sum(c); return { y: d.year, n, lo: (c[0] + c[1]) / n, hi: (c[3] + c[4]) / n }; });
      return 'HCAHPS summary star mix of rated hospitals by year: ' + rows.map((r) => `${r.y} 4-5 stars ${pct(r.hi)}, 1-2 stars ${pct(r.lo)} (${f0(r.n)} rated)`).join('; ') + '.';
    },
    survey_change: () => {
      const H = App.H, base = H[0];
      const dims = [['nurse', 'Nurse communication'], ['doctor', 'Doctor communication'], ['staff', 'Staff responsiveness'], ['meds', 'Communication about medicines'],
        ['discharge', 'Discharge information'], ['transition', 'Care transition'], ['clean', 'Cleanliness'], ['quiet', 'Quietness'], ['overall', 'Overall hospital rating'], ['recommend', 'Would recommend']];
      return `HCAHPS linear mean scores, ${base.year} and the change since: ` + dims.map(([k, label]) => {
        const last = [...H].reverse().find((d) => d[k] != null);
        return base[k] == null ? `${label} no ${base.year} value` : `${label} ${App.f1(base[k])} → ${App.f1(last[k])} in ${last.year} (${App.signNum(last[k] - base[k], 1)})`;
      }).join('; ') + '.';
    },
    psi_spread: () => 'PSI-90 composite across hospitals (1.0 = expected; lower is safer), median and 10th-90th percentile by report year (no 2020 release): ' +
      App.P.map((d) => `${d.year} median ${f2(d.psi90_med)} (${f2(d.psi90_p10)}–${f2(d.psi90_p90)}), mean ${f2(d.psi90)}, ${f0(d.n)} hospitals`).join('; ') + '.',
    psi_components: () => {
      const p0 = App.P[0], p1 = App.P[App.P.length - 1];
      const comps = [['resp', 'Postoperative respiratory failure'], ['dehisc', 'Postoperative wound dehiscence'], ['aki', 'Post-op kidney injury requiring dialysis'],
        ['sepsis', 'Postoperative sepsis'], ['ulcer', 'Pressure ulcer'], ['pe_dvt', 'Peri-op PE / DVT'], ['pneumo', 'Iatrogenic pneumothorax'], ['puncture', 'Abdominopelvic puncture / laceration']]
        .filter(([k]) => p0[k] != null && p1[k] != null).map(([k, label]) => ({ label, a: p0[k], b: p1[k], chg: p1[k] / p0[k] - 1 })).sort((a, b) => b.chg - a.chg);
      return `PSI component mean rates per 1,000 eligible discharges, ${p0.year} → ${p1.year}: ` + comps.map((c) => `${c.label} ${f2(c.a)} → ${f2(c.b)} (${App.signPct(c.chg)})`).join('; ') + '.';
    },
    star_flags: () => 'Share of hospitals with at least one infection flagged worse than benchmark, by HCAHPS summary star rating: ' + [1, 2, 3, 4, 5].map((s) => {
      const g = App.facilities.filter((f) => f.star === s && f.hai > 0), w = g.filter((f) => f.flagsWorse > 0).length;
      return `${s} star${s > 1 ? 's' : ''} ${pct(w / (g.length || 1))} (${w} of ${f0(g.length)})`;
    }).join('; ') + '. An association, not a cause.',
    psi_by_star: () => 'PSI-90 composite by HCAHPS summary star rating: ' + [1, 2, 3, 4, 5].map((s) => {
      const v = App.facilities.filter((f) => f.star === s && f.psi90 != null).map((f) => f.psi90);
      return `${s} star${s > 1 ? 's' : ''} median ${f2(d3.median(v))} (${f0(v.length)} hospitals)`;
    }).join('; ') + '.',
    overall_stars: (st) => {
      if (!App.X) return 'Outcome data is not loaded.';
      const N = App.X.national, total = d3.sum([1, 2, 3, 4, 5], (s) => N.ovr[s] || 0);
      const mix = (c) => [1, 2, 3, 4, 5].map((s) => `${s} star${s > 1 ? 's' : ''} ${pct(c[s] / (d3.sum([1, 2, 3, 4, 5], (x) => c[x]) || 1))}`).join(', ');
      let out = `CMS overall star rating, share of ${f0(total)} rated hospitals: ${mix(N.ovr)}; ${f0(N.unrated)} hospitals not rated.`;
      if (st.focus) {
        const c = ovrCounts(st.focus), n = d3.sum([1, 2, 3, 4, 5], (s) => c[s]);
        out += ` ${stateName(st.focus)} (${f0(n)} rated): ${n ? mix(c) : 'none rated'}.`;
      }
      return out;
    },
    ed_by_state: (st) => {
      if (!App.X) return 'Outcome data is not loaded.';
      const X = App.X, data = Object.entries(X.states).filter(([c, s]) => s.ed != null && s.edN >= 5 && App.STATE_NAMES[c]).map(([c, s]) => ({ c, v: s.ed, n: s.edN })).sort((a, b) => a.v - b.v);
      const fmt = (d) => `${stateName(d.c)} ${App.fmtMin(d.v)}`;
      let out = `Median minutes in the emergency department for patients sent home (OP-18b), median of each state's hospitals; national median ${App.fmtMin(X.national.ed.median)}. Fastest: ${data.slice(0, 3).map(fmt).join(', ')}. Slowest: ${data.slice(-3).reverse().map(fmt).join(', ')}.`;
      const i = data.findIndex((d) => d.c === st.focus);
      if (st.focus) out += i < 0 ? ` ${stateName(st.focus)} has too few reporting hospitals.` : ` ${fmt(data[i])}, ${i + 1} of ${data.length} from fastest, across ${data[i].n} hospitals.`;
      return out;
    },
    outcome_ranges: (st) => {
      if (!App.X) return 'Outcome data is not loaded.';
      const N = App.X.national, kind = st.outcomeKind || 'mort';
      return `Risk-standardized 30-day ${kind === 'mort' ? 'death' : 'readmission'} rates for Medicare patients across hospitals, 10th percentile – median – 90th percentile: ` +
        App.X.conditions.filter((c) => N[kind][c.key]).map((c) => { const r = N[kind][c.key]; return `${c.label} ${r.p10}% – ${r.median}% – ${r.p90}% (${f0(r.n)} hospitals)`; }).join('; ') + '.';
    },
    penalties: () => {
      if (!App.X) return 'Outcome data is not loaded.';
      const N = App.X.national, X = App.X;
      return `Hospital-Acquired Condition Reduction Program FY${X.meta.periods.hacFy}: ${f0(N.hacCut)} of ${f0(N.hacN)} scored hospitals (${pct(N.hacCut / N.hacN)}) lose 1% of Medicare payments. ` +
        `Hospital Readmissions Reduction Program: ${f0(N.hrrpAny.excess)} of ${f0(N.hrrpAny.n)} hospitals (${pct(N.hrrpAny.excess / N.hrrpAny.n)}) had more readmissions than expected for at least one condition, which brings a cut of up to 3%.`;
    },
  };
  function stateFacts(st, what) {
    const M = App.mapMetrics().find((m) => m.key === st.mapMetric) || App.mapMetrics()[0];
    const list = Object.entries(App.S).filter(([, s]) => M.get(s) != null && M.vol(s) >= M.minVol).map(([c, s]) => ({ c, v: M.get(s) }))
      .sort((a, b) => (M.goodLow ? a.v - b.v : b.v - a.v));
    const fmt = (d) => `${stateName(d.c)} ${M.fmt(d.v)}`;
    let out = `${what}: ${M.title}; ${M.centerLabel}; ${list.length} states and territories with ${M.volLabel}. Best: ${list.slice(0, 3).map(fmt).join(', ')}. Worst: ${list.slice(-3).reverse().map(fmt).join(', ')}.`;
    const code = st.mark || st.focus;
    if (code) {
      const i = list.findIndex((d) => d.c === code), s = App.S[code];
      out += i >= 0 ? ` ${fmt(list[i])}, ranked ${i + 1} of ${list.length} (1 = best).` : ` ${stateName(code)}: ${s && M.get(s) != null ? M.fmt(M.get(s)) + ', too little volume to rank' : 'no value'}.`;
    }
    return out;
  }
  // The overall star mix of one state's hospitals, counted as Fig 13 counts them
  function ovrCounts(code) {
    const c = [0, 0, 0, 0, 0, 0], seen = new Set(), LOC = window.CMS_LOCATIONS || { extra: {} };
    App.facilities.forEach((f) => { seen.add(f.id); if (f.st === code) { const x = App.X.get(f.id); if (x) c[x.ovr || 0]++; } });
    Object.entries(LOC.extra || {}).forEach(([id, r]) => { if (!seen.has(id) && r[9] === code) { const x = App.X.get(id); if (x) c[x.ovr || 0]++; } });
    return c;
  }

  // ---- drawing a copy ---------------------------------------------------------------------------------------------------
  let copies = 0;
  // Ids inside a drawn copy (clip paths, gradients, patterns) are renamed so they don't clash with the dashboard's
  function uniquify(root) {
    const n = ++copies, map = new Map();
    root.querySelectorAll('svg [id]').forEach((el) => { const id = `${el.id}--c${n}`; map.set(el.id, id); el.id = id; });
    if (!map.size) return;
    root.querySelectorAll('svg *').forEach((el) => {
      for (const a of ['clip-path', 'fill', 'stroke', 'mask', 'href', 'xlink:href', 'filter']) {
        const v = el.getAttribute(a);
        if (v && v.includes('#')) el.setAttribute(a, v.replace(/#([\w-]+)/g, (m, id) => (map.has(id) ? `#${map.get(id)}` : m)));
      }
    });
  }

  function makeCopy(spec) {
    const src = document.getElementById(spec.el);
    const article = src && src.closest('article');
    if (!article) throw new Error(`The dashboard has no ${spec.el}`);
    const copy = article.cloneNode(true);
    if (spec.prune) copy.querySelectorAll(spec.prune).forEach((n) => n.remove());
    (spec.extra || []).forEach((id) => {
      const x = document.getElementById(id);
      if (x) copy.querySelector('.card-head').insertAdjacentElement('afterend', x.cloneNode(true));
    });
    copy.querySelectorAll('.explain-btn, .hm-tools').forEach((n) => n.remove());
    [copy, ...copy.querySelectorAll('[id]')].forEach((n) => { if (n.id) { n.dataset.dashId = n.id; n.removeAttribute('id'); } });
    copy.querySelectorAll('[aria-controls], [aria-labelledby], label[for]').forEach((n) => { n.removeAttribute('aria-controls'); n.removeAttribute('aria-labelledby'); n.removeAttribute('for'); });
    copy.querySelectorAll('[hidden]').forEach((n) => { if (n.dataset.dashId === spec.el) n.hidden = false; });
    copy.className = 'ans-fig dash-copy';
    return copy;
  }

  function drawCopy(spec, copy, state, anim) {
    const realGet = document.getElementById, saved = { state: App.state, hospitalMap: App.hospitalMap, setMapMetric: App.setMapMetric };
    document.getElementById = function (id) {
      return copy.querySelector(`[data-dash-id="${id}"]`) || document.createElement('div');
    };
    App.state = state;
    App.hospitalMap = null;
    App.setMapMetric = (k) => { state.mapMetric = k; };
    try {
      const c = App.charts.find((x) => x.name === spec.chart);
      c.fn(anim && !App.reduceMotion);
    } finally {
      document.getElementById = realGet;
      Object.assign(App, saved);
    }
    const eb = copy.querySelector('.eyebrow');
    if (eb && !/on the dashboard$/.test(eb.textContent)) eb.textContent = `${eb.textContent.trim()} on the dashboard`;
    // The map copy marks its state with an outline, as a focus would, without opening the street map
    if (state.mark) copy.querySelectorAll('g.tile').forEach((g) => { if (g.__data__ === state.mark) d3.select(g).raise().select('rect').attr('stroke', App.C.text).attr('stroke-width', 2.5); });
    uniquify(copy);
  }

  function draw(slot, request, surface) {
    const spec = FIGS[request.figure];
    if (!spec) throw new Error(`Unknown dashboard figure ${request.figure}`);
    const state = Object.assign({}, App.state, { focus: '', funnelQuery: '', mark: '' });
    Object.entries(request.params || {}).forEach(([k, v]) => { if (spec.params && spec.params[k]) state[spec.params[k]] = v; });
    const copy = makeCopy(spec);
    // Copilot's finding becomes the title; the figure's own title stays under it (charts that retitle still can)
    const head = copy.querySelector('.card-head > div');
    if (request.title) {
      const h3 = head.querySelector('h3');
      h3.classList.add('dash-orig');
      h3.insertAdjacentHTML('beforebegin', `<h3>${esc(request.title)}</h3>`);
    }
    copy.insertAdjacentHTML('beforeend', '<div class="ans-fig-foot"><span class="ans-src">From the dashboard’s latest extract of CMS Care Compare</span>' +
      '<button type="button" class="btn dash-go">Show on the dashboard</button></div>');
    slot.appendChild(copy);
    const redraw = (anim) => { try { drawCopy(spec, copy, state, anim); } catch (e) { console.error(`[dash:${spec.chart}]`, e); } };
    // Chips and search change the copy; clicks on marks stop here, so the dashboard's filters stay as they are
    copy.addEventListener('click', (e) => {
      if (e.target.closest('.dash-go')) { e.stopPropagation(); show(spec, state); return; }
      const chip = e.target.closest('.chip');
      const group = chip && chip.closest('[data-dash-id]');
      if (chip && group && spec.chips && spec.chips[group.dataset.dashId]) {
        e.stopPropagation();
        state[spec.chips[group.dataset.dashId]] = chip.dataset.value;
        redraw(true);
        return;
      }
      if (e.target.closest('input, select, label')) return;
      e.stopPropagation();
    }, true);
    const search = copy.querySelector('[data-dash-id="funnelSearch"]');
    if (search) {
      search.value = state.funnelQuery || '';
      let t;
      search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { state.funnelQuery = search.value; redraw(false); }, 150); });
    }
    const chart = copy.querySelector(`[data-dash-id="${spec.el}"]`);
    let lastW = 0;
    requestAnimationFrame(() => { redraw(true); lastW = chart.clientWidth; });
    window.Chat.track(copy, () => { redraw(false); lastW = chart.clientWidth; }, () => Math.abs(chart.clientWidth - lastW) > 4);
    return FACTS[request.figure](state);
  }

  // Apply the copy's settings to the real figure and go to it
  function show(spec, st) {
    const S = App.state;
    if (spec.params) {
      if ('infection' in spec.params) S[spec.params.infection] = st[spec.params.infection];
      if ('metric' in spec.params) S.mapMetric = st.mapMetric;
      if ('outcome' in spec.params) S.outcomeKind = st.outcomeKind;
      if (spec.chart === 'funnel') {
        S.funnelQuery = st.funnelQuery || '';
        const input = document.getElementById('funnelSearch');
        if (input) input.value = S.funnelQuery;
      }
    }
    if (spec.chips) Object.values(spec.chips).forEach((k) => { S[k] = st[k]; });
    const focus = st.focus || '';
    if (focus !== S.focus && spec.params && spec.params.state === 'focus') App.setFocus(focus);
    const target = document.getElementById(spec.el).closest('article');
    const go = () => {
      App.renderOne(spec.chart);
      if (spec.chart === 'map' || spec.chart === 'ranks') { App.renderOne('map'); App.renderOne('ranks'); }
      target.scrollIntoView({ block: 'start', behavior: App.reduceMotion ? 'auto' : 'smooth' });
    };
    if (document.getElementById('view-quality').hidden) {
      location.hash = `#${spec.section}`;
      setTimeout(go, 60);
    } else go();
    document.dispatchEvent(new CustomEvent('dash-show', { detail: { section: spec.section } }));
  }

  App.DashFigs = {
    draw,
    label: (id) => (FIGS[id] ? FIGS[id].label : null),
    list: FIGS,
  };
})();
