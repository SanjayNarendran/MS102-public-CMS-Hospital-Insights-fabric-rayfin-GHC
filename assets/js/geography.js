/* Chapter 03: state tile-grid map + rankings */
(function () {
  'use strict';
  const App = window.App;

  const TILES = {AK:[0,0],ME:[11,0],WI:[6,1],VT:[10,1],NH:[11,1],WA:[1,2],ID:[2,2],MT:[3,2],ND:[4,2],MN:[5,2],IL:[6,2],MI:[7,2],NY:[9,2],MA:[10,2],OR:[1,3],NV:[2,3],WY:[3,3],SD:[4,3],IA:[5,3],IN:[6,3],OH:[7,3],PA:[8,3],NJ:[9,3],CT:[10,3],RI:[11,3],CA:[1,4],UT:[2,4],CO:[3,4],NE:[4,4],MO:[5,4],KY:[6,4],WV:[7,4],VA:[8,4],MD:[9,4],DE:[10,4],AZ:[2,5],NM:[3,5],KS:[4,5],AR:[5,5],TN:[6,5],NC:[7,5],SC:[8,5],DC:[9,5],OK:[4,6],LA:[5,6],MS:[6,6],AL:[7,6],GA:[8,6],HI:[0,7],TX:[4,7],FL:[9,7],GU:[0,8.35],MP:[1,8.35],AS:[2,8.35],PR:[10,8.35],VI:[11,8.35]};

  function metrics() {
    const nat = App.last;
    const hai = App.INF.map((inf) => ({
      key: inf.key, label: inf.short, title: `${inf.label}, pooled SIR, ${App.meta.haiYear}`,
      get: (s) => s[inf.key], vol: (s) => s[inf.key + '_pred'] || 0, minVol: 10, volLabel: '≥10 predicted infections',
      center: nat[inf.key].sir, centerLabel: `National ${App.f2(nat[inf.key].sir)}`, goodLow: true, fmt: App.f2,
    }));
    const H = App.H[App.H.length - 1];
    return hai.concat([
      { key: 'star', label: 'Patient experience', title: `Average HCAHPS summary star rating, ${App.meta.hcahpsYear}`, get: (s) => s.star, vol: (s) => s.rated || 0, minVol: 5, volLabel: '≥5 rated hospitals', center: H.avgstar, centerLabel: `National ${App.f2(H.avgstar)}`, goodLow: false, fmt: App.f2 },
      { key: 'topPct', label: '% 4–5★ hospitals', title: `Share of rated hospitals with 4 or 5 stars, ${App.meta.hcahpsYear}`, get: (s) => (s.topPct != null ? s.topPct / 100 : null), vol: (s) => s.rated || 0, minVol: 5, volLabel: '≥5 rated hospitals', center: (H.s4 + H.s5) / (H.s1 + H.s2 + H.s3 + H.s4 + H.s5), centerLabel: 'National', goodLow: false, fmt: App.pct0 },
      { key: 'psi90', label: 'PSI‑90 safety', title: `Average PSI‑90 composite across hospitals, ${App.meta.psiYear}`, get: (s) => s.psi90, vol: (s) => s.psiN || 0, minVol: 5, volLabel: '≥5 scored hospitals', center: App.P[App.P.length - 1].psi90, centerLabel: `National ${App.f2(App.P[App.P.length - 1].psi90)}`, goodLow: true, fmt: App.f2 },
    ]).concat(App.X ? extraMetrics() : []);
  }

  // Measures read locally from CMS Care Compare files (assets/quality-extra.js) rather than the semantic model
  function extraMetrics() {
    const N = App.X.national, rated = Object.entries(N.ovr);
    const natOvr = d3.sum(rated, ([s, n]) => s * n) / d3.sum(rated, ([, n]) => n);
    return [
      { key: 'ovr', label: '★ CMS overall', title: 'Average CMS overall hospital star rating', get: (s) => s.ovr, vol: (s) => s.ovrN || 0, minVol: 5, volLabel: '≥5 rated hospitals', center: natOvr, centerLabel: `National ${App.f2(natOvr)}`, goodLow: false, fmt: App.f2, local: true },
      { key: 'ed', label: 'ER time', title: `Median time in the emergency department, arrival to departure (${App.xPeriod(App.X.meta.periods.ed)})`, get: (s) => s.ed, vol: (s) => s.edN || 0, minVol: 5, volLabel: '≥5 reporting hospitals', center: N.ed.median, centerLabel: `National ${N.ed.median} min`, goodLow: true, fmt: (v) => `${Math.round(v)} min`, local: true },
    ];
  }

  function scaleFor(M) {
    const vals = Object.values(App.S).filter((s) => M.get(s) != null && M.vol(s) >= M.minVol).map(M.get);
    const dev = d3.quantile(vals.map((v) => Math.abs(v - M.center)).sort(d3.ascending), 0.95) || 0.1;
    return App.diverging(M.center - dev, M.center, M.center + dev, M.goodLow);
  }

  App.mapMetrics = metrics;
  App.setMapMetric = function (key) {
    App.state.mapMetric = key;
    App.renderOne('map', true);
    App.renderOne('ranks');
  };

  function setFocus(code) {
    App.setFocus(App.state.focus === code ? '' : code);
  }

  function stateTip(code) {
    const s = App.S[code] || {};
    const rows = App.INF.map((inf) => [inf.short, s[inf.key] != null ? App.f2(s[inf.key]) : '—']);
    rows.push(['HCAHPS avg ★', s.star != null ? App.f2(s.star) : '—'], ['PSI‑90 avg', s.psi90 != null ? App.f2(s.psi90) : '—']);
    if (App.X) rows.push(['CMS overall avg ★', s.ovr != null ? App.f2(s.ovr) : '—'], ['Median ER time', s.ed != null ? `${Math.round(s.ed)} min` : '—']);
    return `<div class="tt-title">${App.STATE_NAMES[code] || code}</div><div class="tt-sub">${App.f0(s.hospHai || 0)} hospitals in HAI data · click to map its hospitals</div>` + App.tipRows(rows);
  }

  App.register('map', function (anim) {
    const C = App.C, st = App.state;
    const ms = metrics();
    App.chips(document.getElementById('chips-map'), ms.map((m) => ({ value: m.key, label: m.label })), st.mapMetric, App.setMapMetric);
    const M = ms.find((m) => m.key === st.mapMetric) || ms[0];
    const el = document.getElementById('fig-map');
    // A focused state drills down in place to the street map of its hospitals
    if (st.focus && App.hospitalMap) {
      App.tip.hide();
      el.hidden = true;
      App.hospitalMap.show(st.focus, M);
      return;
    }
    if (App.hospitalMap) App.hospitalMap.hide();
    el.hidden = false;
    document.getElementById('mapEyebrow').textContent = 'Fig 5';
    document.getElementById('mapTitle').textContent = M.title;
    document.getElementById('mapSub').textContent = `Blue is ${M.goodLow ? 'lower' : 'higher'} (better) and orange ${M.goodLow ? 'higher' : 'lower'} (worse) than the national figure. Hatched tiles have low volume. Click a state to map its hospitals.`;
    const color = scaleFor(M);
    const w0 = el.clientWidth;
    const gap = w0 < 520 ? 3 : 5;
    const size = Math.floor(Math.min(64, (w0 - gap * 11) / 12));
    const H = Math.ceil(9.35 * (size + gap)) + 6;
    const [svg, w] = App.makeSvg(el, H, `Tile grid map of ${M.title}`);
    const ox = (w - (12 * size + 11 * gap)) / 2;
    svg.append('defs').append('pattern').attr('id', 'hatch').attr('patternUnits', 'userSpaceOnUse').attr('width', 6).attr('height', 6).attr('patternTransform', 'rotate(45)')
      .append('line').attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 6).attr('stroke', C.text).attr('stroke-opacity', 0.18).attr('stroke-width', 2);

    const codes = Object.keys(TILES);
    const g = svg.selectAll('g.tile').data(codes).join('g').attr('class', 'tile').style('cursor', 'pointer')
      .attr('transform', (c) => `translate(${ox + TILES[c][0] * (size + gap)},${TILES[c][1] * (size + gap)})`);
    const fillOf = (c) => { const s = App.S[c]; const v = s && M.get(s); return v != null ? color(v) : C.surface2; };
    const lowVol = (c) => { const s = App.S[c]; return !s || M.get(s) == null || M.vol(s) < M.minVol; };
    const rect = g.append('rect').attr('width', size).attr('height', size).attr('rx', 2)
      .attr('fill', fillOf)
      .attr('stroke', (c) => (c === st.focus ? C.text : 'none')).attr('stroke-width', 2.5);
    if (anim && !App.reduceMotion) rect.attr('opacity', 0).transition().duration(500).delay((c) => (TILES[c][0] + TILES[c][1]) * 28).attr('opacity', 1);
    g.filter(lowVol).append('rect').attr('width', size).attr('height', size).attr('rx', 2).attr('fill', 'url(#hatch)').attr('pointer-events', 'none');
    const fs = Math.max(9, Math.min(12.5, size * 0.21));
    g.append('text').attr('x', size * 0.13).attr('y', size * 0.13 + fs).attr('font-size', fs).attr('font-weight', 700).attr('fill', (c) => App.inkOn(fillOf(c))).text((c) => c);
    if (size >= 34) {
      g.append('text').attr('x', size * 0.13).attr('y', size - size * 0.14).attr('font-size', fs * 0.92).attr('fill', (c) => App.inkOn(fillOf(c))).attr('fill-opacity', 0.85).attr('font-variant-numeric', 'tabular-nums')
        .text((c) => { const s = App.S[c]; const v = s && M.get(s); return v != null ? M.fmt(v) : '—'; });
    }
    g.on('mousemove', (ev, c) => App.tip.show(stateTip(c), ev)).on('mouseleave', () => App.tip.hide()).on('click', (ev, c) => setFocus(c));

    // Legend
    const lw = Math.min(220, 4 * (size + gap) - gap), lx = ox + 4 * (size + gap), ly = 8.35 * (size + gap) + size * 0.35;
    const lg = svg.append('g').attr('transform', `translate(${lx},${ly})`);
    const gid = 'map-legend-grad';
    const grad = svg.select('defs').append('linearGradient').attr('id', gid);
    const [d0, , d2] = color.domain();
    d3.range(0, 1.0001, 0.1).forEach((t) => grad.append('stop').attr('offset', `${t * 100}%`).attr('stop-color', color(d0 + t * (d2 - d0))));
    lg.append('rect').attr('width', lw).attr('height', 8).attr('rx', 1).attr('fill', `url(#${gid})`);
    lg.append('line').attr('x1', lw / 2).attr('x2', lw / 2).attr('y1', -3).attr('y2', 11).attr('stroke', C.text);
    lg.append('text').attr('y', 23).attr('font-size', 10).attr('fill', C.muted).text(M.fmt(d0));
    lg.append('text').attr('x', lw / 2).attr('y', 23).attr('text-anchor', 'middle').attr('font-size', 10).attr('font-weight', 600).attr('fill', C.text2).text(M.centerLabel);
    lg.append('text').attr('x', lw).attr('y', 23).attr('text-anchor', 'end').attr('font-size', 10).attr('fill', C.muted).text(M.fmt(d2));
  });

  App.register('ranks', function () {
    const C = App.C, st = App.state;
    const M = metrics().find((m) => m.key === st.mapMetric);
    const color = scaleFor(M);
    const list = Object.entries(App.S).filter(([, s]) => M.get(s) != null && M.vol(s) >= M.minVol).map(([c, s]) => ({ c, v: M.get(s) }));
    list.sort((a, b) => (M.goodLow ? a.v - b.v : b.v - a.v));
    document.getElementById('rankSub').textContent = `${list.length} states and territories with ${M.volLabel}. Click one to map its hospitals.`;
    const n = 7;
    const best = list.slice(0, n), worst = list.slice(-n).reverse();
    const [lo, , hi] = color.domain();
    const xs = d3.scaleLinear().domain([lo, hi]).range([0, 100]).clamp(true);
    const row = (d, i) => {
      const a = xs(Math.min(d.v, M.center)), b = xs(Math.max(d.v, M.center));
      return `<li data-c="${d.c}" class="${d.c === st.focus ? 'focus' : ''}"><span class="rk">${i}</span><span class="nm">${App.STATE_NAMES[d.c] || d.c}</span>
        <span class="bar"><i data-css="left:${a}%;width:${Math.max(2, b - a)}%;background:${color(d.v)}"></i><i data-css="left:${xs(M.center)}%;width:1px;background:${C.text};opacity:.5"></i></span>
        <span class="v">${M.fmt(d.v)}</span></li>`;
    };
    const el = document.getElementById('fig-ranks');
    el.innerHTML = `
      <div class="rank-group"><h4><i data-css="background:${C.good}"></i>Best ${n}</h4><ol>${best.map((d, i) => row(d, i + 1)).join('')}</ol></div>
      <div class="rank-group"><h4><i data-css="background:${C.bad}"></i>Needs attention</h4><ol>${worst.map((d, i) => row(d, list.length - i)).join('')}</ol></div>`;
    App.applyCss(el);
    el.querySelectorAll('li').forEach((li) => {
      li.addEventListener('click', () => setFocus(li.dataset.c));
      li.addEventListener('mousemove', (ev) => App.tip.show(stateTip(li.dataset.c), ev));
      li.addEventListener('mouseleave', () => App.tip.hide());
    });
  });
})();
