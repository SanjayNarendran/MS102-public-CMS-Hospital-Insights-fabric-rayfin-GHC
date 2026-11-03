/* Chapter 05: PSI-90 patient safety */
(function () {
  'use strict';
  const App = window.App;

  App.register('psiTrend', function (anim) {
    const C = App.C, P = App.P;
    const el = document.getElementById('fig-psi');
    const H = 300, m = { t: 20, r: 74, b: 30, l: 40 };
    const [svg, w] = App.makeSvg(el, H, 'PSI-90 median and 10th to 90th percentile band by year');
    const x = d3.scaleLinear().domain(d3.extent(P, (d) => d.year)).range([m.l, w - m.r]);
    const y = d3.scaleLinear().domain([0.75, 1.25]).range([H - m.b, m.t]);
    y.ticks(5).forEach((t) => {
      svg.append('line').attr('x1', m.l).attr('x2', w - m.r).attr('y1', y(t)).attr('y2', y(t)).attr('stroke', t === 1 ? C.faint : C.grid).attr('stroke-dasharray', t === 1 ? '4 3' : null);
      svg.append('text').attr('x', m.l - 8).attr('y', y(t)).attr('dy', '0.32em').attr('text-anchor', 'end').attr('font-size', 10).attr('fill', C.muted).text(t.toFixed(2));
    });
    d3.range(P[0].year, P[P.length - 1].year + 1).forEach((yr) => {
      const has = P.some((d) => d.year === yr);
      svg.append('text').attr('x', x(yr)).attr('y', H - m.b + 17).attr('text-anchor', 'middle').attr('font-size', 10.5).attr('fill', has ? C.muted : C.faint).text(has ? yr : `${yr}*`);
      if (!has) {
        svg.append('rect').attr('x', x(yr - 0.5)).attr('width', x(yr + 0.5) - x(yr - 0.5)).attr('y', m.t).attr('height', H - m.t - m.b).attr('fill', C.surface2).attr('fill-opacity', 0.6);
        svg.append('text').attr('x', x(yr)).attr('y', m.t + 12).attr('text-anchor', 'middle').attr('font-size', 9.5).attr('fill', C.muted).text('no release');
      }
    });
    svg.append('path').datum(P).attr('fill', C.neutral).attr('fill-opacity', App.isDark() ? 0.3 : 0.28).attr('d', d3.area().x((d) => x(d.year)).y0((d) => y(d.psi90_p10)).y1((d) => y(d.psi90_p90)).curve(d3.curveMonotoneX));
    ['psi90_p10', 'psi90_p90'].forEach((k) => svg.append('path').datum(P).attr('fill', 'none').attr('stroke', C.faint).attr('stroke-width', 1).attr('d', d3.line().x((d) => x(d.year)).y((d) => y(d[k])).curve(d3.curveMonotoneX)));
    const med = svg.append('path').datum(P).attr('fill', 'none').attr('stroke', C.text).attr('stroke-width', 2.6).attr('stroke-linecap', 'round').attr('d', d3.line().x((d) => x(d.year)).y((d) => y(d.psi90_med)).curve(d3.curveMonotoneX));
    if (anim && !App.reduceMotion) {
      const L = med.node().getTotalLength();
      med.attr('stroke-dasharray', `${L} ${L}`).attr('stroke-dashoffset', L).transition().duration(1000).attr('stroke-dashoffset', 0);
    }
    svg.selectAll('circle.mean').data(P).join('circle').attr('class', 'mean').attr('cx', (d) => x(d.year)).attr('cy', (d) => y(d.psi90)).attr('r', 3.2).attr('fill', C.surface).attr('stroke', C.text2).attr('stroke-width', 1.4);
    const L = P[P.length - 1];
    [['90th pct', L.psi90_p90, C.muted], ['Median', L.psi90_med, C.text], ['10th pct', L.psi90_p10, C.muted]].forEach(([t, v, c]) => {
      svg.append('text').attr('x', w - m.r + 8).attr('y', y(v)).attr('dy', '0.32em').attr('font-size', 10.5).attr('font-weight', 600).attr('fill', c).text(`${t} ${App.f2(v)}`);
    });
    svg.append('text').attr('x', m.l + 4).attr('y', H - m.b - 6).attr('font-size', 9.5).attr('fill', C.muted).text('○ mean');
    svg.selectAll('rect.hit').data(P).join('rect').attr('class', 'hit').attr('x', (d) => x(d.year) - 18).attr('width', 36).attr('y', m.t).attr('height', H - m.t - m.b).attr('fill', 'transparent')
      .on('mousemove', (ev, d) => App.tip.show(`<div class="tt-title">PSI‑90 · ${d.year}</div><div class="tt-sub">${App.f0(d.n)} hospitals scored</div>` + App.tipRows([['90th percentile', App.f2(d.psi90_p90)], ['Median', App.f2(d.psi90_med)], ['Mean', App.f2(d.psi90)], ['10th percentile', App.f2(d.psi90_p10)]]), ev))
      .on('mouseleave', () => App.tip.hide());
  });

  App.register('psiComponents', function (anim) {
    const C = App.C, P = App.P;
    const el = document.getElementById('fig-psicomp');
    const p0 = P[0], p1 = P[P.length - 1];
    const comps = [
      ['resp', 'Postoperative respiratory failure', 'PSI 11'], ['dehisc', 'Postoperative wound dehiscence', 'PSI 14'], ['aki', 'Post‑op kidney injury requiring dialysis', 'PSI 10'],
      ['sepsis', 'Postoperative sepsis', 'PSI 13'], ['ulcer', 'Pressure ulcer', 'PSI 03'], ['pe_dvt', 'Peri‑op PE / DVT', 'PSI 12'],
      ['pneumo', 'Iatrogenic pneumothorax', 'PSI 06'], ['puncture', 'Abdominopelvic puncture / laceration', 'PSI 15'],
    ].filter(([k]) => p0[k] != null && p1[k] != null).map(([k, label, code]) => ({ k, label, code, a: p0[k], b: p1[k], chg: p1[k] / p0[k] - 1 }))
      .sort((a, b) => b.chg - a.chg);
    const narrow = el.clientWidth < 560;
    const rowH = 34, m = { t: 26, r: narrow ? 50 : 118, b: 28, l: narrow ? 150 : 236 };
    const H = m.t + rowH * comps.length + m.b;
    const [svg, w] = App.makeSvg(el, H, 'Lollipop chart of percent change in PSI component rates 2019 to 2024');
    const ext = d3.max(comps, (d) => Math.abs(d.chg));
    const x = d3.scaleLinear().domain([-Math.max(0.25, ext * 0.3), ext * 1.08]).range([m.l, w - m.r]).nice();
    x.ticks(Math.max(3, Math.floor((w - m.l - m.r) / 90))).forEach((t) => {
      svg.append('line').attr('x1', x(t)).attr('x2', x(t)).attr('y1', m.t - 6).attr('y2', H - m.b).attr('stroke', t === 0 ? C.text2 : C.grid).attr('stroke-opacity', t === 0 ? 0.5 : 1);
      svg.append('text').attr('x', x(t)).attr('y', H - m.b + 16).attr('text-anchor', 'middle').attr('font-size', 10).attr('fill', C.muted).text(App.signPct(t));
    });
    if (!narrow) svg.append('text').attr('x', w - 4).attr('y', m.t - 10).attr('text-anchor', 'end').attr('font-size', 10).attr('font-weight', 600).attr('fill', C.muted).text(`${p0.year} → ${p1.year} rate`);
    const dur = anim && !App.reduceMotion ? 800 : 0;
    comps.forEach((d, i) => {
      const cy = m.t + i * rowH + rowH / 2;
      const col = Math.abs(d.chg) < 0.03 ? C.muted : d.chg > 0 ? C.bad : C.good;
      svg.append('text').attr('x', m.l - 12).attr('y', cy).attr('dy', '0.32em').attr('text-anchor', 'end').attr('font-size', 12).attr('fill', C.text).text(narrow ? d.code : d.label);
      svg.append('line').attr('x1', x(0)).attr('x2', x(0)).attr('y1', cy).attr('y2', cy).attr('stroke', col).attr('stroke-width', 3).attr('stroke-linecap', 'round').attr('stroke-opacity', 0.5)
        .transition().duration(dur).delay(i * 60).attr('x2', x(d.chg));
      svg.append('circle').attr('cx', x(0)).attr('cy', cy).attr('r', 6.5).attr('fill', col).transition().duration(dur).delay(i * 60).attr('cx', x(d.chg));
      const lx = d.chg >= 0 ? x(d.chg) + 12 : x(d.chg) - 12;
      svg.append('text').attr('x', lx).attr('y', cy).attr('dy', '0.32em').attr('text-anchor', d.chg >= 0 ? 'start' : 'end').attr('font-size', 11.5).attr('font-weight', 700).attr('fill', col).attr('opacity', 0)
        .text(App.signPct(d.chg)).transition().duration(dur).delay(i * 60 + dur * 0.6).attr('opacity', 1);
      if (!narrow) svg.append('text').attr('x', w - 4).attr('y', cy).attr('dy', '0.32em').attr('text-anchor', 'end').attr('font-size', 11).attr('fill', C.muted).attr('font-variant-numeric', 'tabular-nums').text(`${App.f2(d.a)} → ${App.f2(d.b)}`);
      svg.append('rect').attr('x', 0).attr('width', w).attr('y', cy - rowH / 2).attr('height', rowH).attr('fill', 'transparent')
        .on('mousemove', (ev) => App.tip.show(`<div class="tt-title">${d.label}</div><div class="tt-sub">${d.code} · mean hospital rate per 1,000</div>` + App.tipRows([[String(p0.year), App.f2(d.a)], [String(p1.year), App.f2(d.b)], ['Change', App.signPct(d.chg)]]), ev))
        .on('mouseleave', () => App.tip.hide());
    });
  });
})();
