/* Chapter 02: funnel plot of hospital SIR vs predicted infections */
(function () {
  'use strict';
  const App = window.App;

  const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  function lgamma(x) {
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
    x -= 1;
    let a = LANCZOS[0];
    const t = x + 7.5;
    for (let i = 1; i < 9; i++) a += LANCZOS[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }
  // Poisson control limit for SIR at expected count E (Spiegelhalter 2005 interpolation)
  function poissonLimit(p, E) {
    const kmax = Math.ceil(E + 14 * Math.sqrt(E) + 20);
    let cdf = 0, prev = 0, r = kmax;
    for (let k = 0; k <= kmax; k++) {
      prev = cdf;
      cdf += Math.exp(k * Math.log(E) - E - lgamma(k + 1));
      if (cdf >= p) { r = k; break; }
    }
    const a = (cdf - p) / Math.max(cdf - prev, 1e-12);
    return Math.max(0, r - a) / E;
  }
  App.poissonLimit = poissonLimit;

  App.register('funnel', function () {
    const C = App.C, st = App.state;
    App.chips(document.getElementById('chips-funnel'), App.INF.map((d) => ({ value: d.key, label: d.short })), st.funnelInf, (v) => { st.funnelInf = v; App.renderOne('funnel'); });
    const k = st.funnelInf;
    const inf = App.infByKey[k];
    const pts = App.facilities.filter((f) => f[k] && f[k].sir != null && f[k].pred > 0);
    const counts = d3.rollup(pts, (v) => v.length, (f) => f[k].cls);
    document.getElementById('funnelLegend').innerHTML =
      `<span><i class="sw good"></i>Better <b>${App.f0(counts.get('better') || 0)}</b></span>` +
      `<span><i class="sw neutral"></i>No different <b>${App.f0(counts.get('similar') || 0)}</b></span>` +
      `<span><i class="sw bad"></i>Worse <b>${App.f0(counts.get('worse') || 0)}</b></span>`;

    const el = document.getElementById('fig-funnel');
    const H = Math.max(380, Math.min(520, el.clientWidth * 0.46));
    const [svg, w] = App.makeSvg(el, H, `Funnel plot of ${inf.label} SIR against predicted infections for ${pts.length} hospitals`);
    const m = { t: 18, r: 24, b: 44, l: 50 };
    const [pmin, pmax] = d3.extent(pts, (f) => f[k].pred);
    const x = d3.scaleLog().domain([Math.max(0.5, pmin * 0.9), pmax * 1.1]).range([m.l, w - m.r]);
    const yCap = Math.min(4, Math.max(2.2, d3.quantile(pts.map((f) => f[k].sir).sort(d3.ascending), 0.995) * 1.1));
    const y = d3.scaleLinear().domain([0, yCap]).range([H - m.b, m.t]).nice();
    const yTop = y.domain()[1];

    y.ticks(6).forEach((t) => {
      svg.append('line').attr('x1', m.l).attr('x2', w - m.r).attr('y1', y(t)).attr('y2', y(t)).attr('stroke', C.grid);
      svg.append('text').attr('x', m.l - 8).attr('y', y(t)).attr('dy', '0.32em').attr('text-anchor', 'end').attr('font-size', 10.5).attr('fill', C.muted).text(t.toFixed(1));
    });
    const xt = x.ticks(8).filter((t) => [1, 2, 5].includes(+String(t)[0]) && String(t).replace(/0|\./g, '').length === 1);
    xt.forEach((t) => {
      svg.append('line').attr('x1', x(t)).attr('x2', x(t)).attr('y1', m.t).attr('y2', H - m.b).attr('stroke', C.grid);
      svg.append('text').attr('x', x(t)).attr('y', H - m.b + 16).attr('text-anchor', 'middle').attr('font-size', 10.5).attr('fill', C.muted).text(d3.format('~s')(t));
    });
    svg.append('text').attr('x', (m.l + w - m.r) / 2).attr('y', H - 6).attr('text-anchor', 'middle').attr('font-size', 11).attr('fill', C.muted).text('Predicted infections (log scale), a proxy for hospital size and exposure');
    svg.append('text').attr('transform', `translate(13,${(m.t + H - m.b) / 2}) rotate(-90)`).attr('text-anchor', 'middle').attr('font-size', 11).attr('fill', C.muted).text('SIR');

    const grid = d3.range(0, 161).map((i) => Math.exp(Math.log(x.domain()[0]) + (i / 160) * (Math.log(x.domain()[1]) - Math.log(x.domain()[0]))));
    const lim = grid.map((E) => ({ E, l95: poissonLimit(0.025, E), u95: poissonLimit(0.975, E), l998: poissonLimit(0.001, E), u998: poissonLimit(0.999, E) }));
    const clipId = 'funnel-clip';
    svg.append('clipPath').attr('id', clipId).append('rect').attr('x', m.l).attr('y', m.t).attr('width', w - m.l - m.r).attr('height', H - m.t - m.b);
    const band = svg.append('g').attr('clip-path', `url(#${clipId})`);
    band.append('path').datum(lim).attr('fill', C.text).attr('fill-opacity', App.isDark() ? 0.07 : 0.05)
      .attr('d', d3.area().x((d) => x(d.E)).y0((d) => y(d.l95)).y1((d) => y(Math.min(d.u95, yTop * 2))).curve(d3.curveBasis));
    ['l998', 'u998'].forEach((key) => band.append('path').datum(lim).attr('fill', 'none').attr('stroke', C.muted).attr('stroke-opacity', 0.7).attr('stroke-dasharray', '4 4')
      .attr('d', d3.line().x((d) => x(d.E)).y((d) => y(Math.min(d[key], yTop * 2))).curve(d3.curveBasis)));

    svg.append('line').attr('x1', m.l).attr('x2', w - m.r).attr('y1', y(1)).attr('y2', y(1)).attr('stroke', C.text2).attr('stroke-opacity', 0.6);
    svg.append('text').attr('x', w - m.r - 4).attr('y', y(1) - 6).attr('text-anchor', 'end').attr('font-size', 10.5).attr('font-weight', 600).attr('fill', C.text2).text('Benchmark 1.0');
    const nat = App.last[k].sir;
    svg.append('line').attr('x1', m.l).attr('x2', w - m.r).attr('y1', y(nat)).attr('y2', y(nat)).attr('stroke', C.text).attr('stroke-width', 1.5).attr('stroke-dasharray', '6 4');
    svg.append('text').attr('x', w - m.r - 4).attr('y', y(nat) + 14).attr('text-anchor', 'end').attr('font-size', 10.5).attr('font-weight', 600).attr('fill', C.text).text(`National ${App.meta.haiYear} · ${App.f2(nat)}`);

    const focus = st.focus;
    const q = st.funnelQuery.trim().toLowerCase();
    const order = { similar: 0, better: 1, worse: 2 };
    const sorted = pts.slice().sort((a, b) => order[a[k].cls] - order[b[k].cls]);
    const fill = { better: C.good, similar: C.neutral, worse: C.bad };
    const isHi = (f) => (!focus || f.st === focus) && (!q || f._search.includes(q));
    const anyFilter = !!(focus || q);
    const dots = svg.append('g').selectAll('circle').data(sorted).join('circle')
      .attr('cx', (f) => x(f[k].pred))
      .attr('cy', (f) => y(Math.min(f[k].sir, yTop)))
      .attr('r', (f) => (f[k].sir > yTop ? 3.6 : 3.2))
      .attr('fill', (f) => fill[f[k].cls])
      .attr('fill-opacity', (f) => (anyFilter ? (isHi(f) ? 0.95 : 0.08) : f[k].cls === 'similar' ? 0.45 : 0.85))
      .attr('stroke', (f) => (anyFilter && isHi(f) ? C.text : 'none'))
      .attr('stroke-width', 0.8);
    if (anyFilter) dots.filter(isHi).raise();

    const hits = anyFilter ? sorted.filter(isHi) : [];
    if (q && hits.length && hits.length <= 6) {
      hits.forEach((f) => {
        const cx = x(f[k].pred), cy = y(Math.min(f[k].sir, yTop));
        svg.append('circle').attr('cx', cx).attr('cy', cy).attr('r', 8).attr('fill', 'none').attr('stroke', C.text).attr('stroke-width', 2);
        svg.append('text').attr('x', cx + 11).attr('y', cy + 4).attr('font-size', 11).attr('font-weight', 600).attr('fill', C.text).attr('paint-order', 'stroke').attr('stroke', C.surface).attr('stroke-width', 3).text(f.name.length > 34 ? f.name.slice(0, 32) + '…' : f.name);
      });
    }
    if (anyFilter) {
      const hw = d3.rollup(hits, (v) => v.length, (f) => f[k].cls);
      svg.append('text').attr('x', m.l + 8).attr('y', m.t + 14).attr('font-size', 11.5).attr('font-weight', 600).attr('fill', C.text)
        .text(`${focus ? App.STATE_NAMES[focus] || focus : 'Matches'}: ${App.f0(hits.length)} hospitals · ${hw.get('worse') || 0} worse · ${hw.get('better') || 0} better`);
    }
    const over = pts.filter((f) => f[k].sir > yTop).length;
    if (over) svg.append('text').attr('x', m.l + 8).attr('y', y(yTop) + (anyFilter ? 30 : 14)).attr('font-size', 10).attr('fill', C.muted).text(`${over} hospital${over > 1 ? 's' : ''} above ${yTop.toFixed(1)} shown at top edge`);

    const hover = svg.append('circle').attr('r', 7).attr('fill', 'none').attr('stroke', C.text).attr('stroke-width', 1.5).style('display', 'none').attr('pointer-events', 'none');
    const delaunay = d3.Delaunay.from(sorted, (f) => x(f[k].pred), (f) => y(Math.min(f[k].sir, yTop)));
    svg.append('rect').attr('x', m.l).attr('y', m.t).attr('width', w - m.l - m.r).attr('height', H - m.t - m.b).attr('fill', 'transparent')
      .on('mousemove', (ev) => {
        const [mx, my] = d3.pointer(ev);
        const i = delaunay.find(mx, my);
        const f = sorted[i];
        const cx = x(f[k].pred), cy = y(Math.min(f[k].sir, yTop));
        if (Math.hypot(cx - mx, cy - my) > 28) { hover.style('display', 'none'); App.tip.hide(); return; }
        hover.style('display', null).attr('cx', cx).attr('cy', cy);
        const v = f[k];
        App.tip.show(`<div class="tt-title">${App.esc(f.name)}</div><div class="tt-sub">${App.esc(f.city)}, ${f.st} · CCN ${f.id}</div>` +
          App.tipRows([[`${inf.short} SIR`, App.f2(v.sir)], ['Observed / predicted', `${v.obs} / ${App.f1(v.pred)}`], ['95% CI', `${v.lo != null ? App.f2(v.lo) : '—'} – ${v.hi != null ? App.f2(v.hi) : '—'}`]]) +
          `<span class="tag ${v.cls}">${App.CLS_LABEL[v.cls]}</span>`, ev);
      })
      .on('mouseleave', () => { hover.style('display', 'none'); App.tip.hide(); });
  });
})();
