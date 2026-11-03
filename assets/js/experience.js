/* Chapter 04 (patient experience) + Chapter 06 (cross-domain connections) */
(function () {
  'use strict';
  const App = window.App;

  const starColors = () => App.starColors();

  App.register('stars', function (anim) {
    const C = App.C;
    const el = document.getElementById('fig-stars');
    const cols = starColors();
    const data = App.H.map((d) => {
      const c = [d.s1, d.s2, d.s3, d.s4, d.s5];
      const n = d3.sum(c);
      return { year: d.year, n, c, p: c.map((v) => v / n) };
    });
    const rowH = 34, m = { t: 46, r: 56, b: 26, l: 46 };
    const H = m.t + rowH * data.length + m.b;
    const [svg, w] = App.makeSvg(el, H, 'Diverging stacked bars of HCAHPS star rating distribution by year');
    const left = (d) => d.p[0] + d.p[1] + d.p[2] / 2;
    const right = (d) => d.p[4] + d.p[3] + d.p[2] / 2;
    const ext = Math.max(d3.max(data, left), d3.max(data, right)) * 1.04;
    const x = d3.scaleLinear().domain([-ext, ext]).range([m.l, w - m.r]);
    [-0.4, -0.2, 0, 0.2, 0.4].filter((t) => Math.abs(t) <= ext).forEach((t) => {
      svg.append('line').attr('x1', x(t)).attr('x2', x(t)).attr('y1', m.t - 4).attr('y2', H - m.b).attr('stroke', t === 0 ? C.text2 : C.grid).attr('stroke-opacity', t === 0 ? 0.5 : 1);
      svg.append('text').attr('x', x(t)).attr('y', H - m.b + 16).attr('text-anchor', 'middle').attr('font-size', 10).attr('fill', C.muted).text(App.pct0(Math.abs(t)));
    });
    const lg = svg.append('g').attr('transform', `translate(${m.l},10)`);
    let lx = 0;
    ['1★', '2★', '3★', '4★', '5★'].forEach((t, i) => {
      lg.append('rect').attr('x', lx).attr('y', 0).attr('width', 12).attr('height', 12).attr('rx', 1).attr('fill', cols[i]);
      lg.append('text').attr('x', lx + 16).attr('y', 10).attr('font-size', 11).attr('fill', C.muted).text(t);
      lx += 46;
    });
    const dur = anim && !App.reduceMotion ? 700 : 0;
    data.forEach((d, i) => {
      const y0 = m.t + i * rowH + 5, bh = rowH - 10;
      let start = -left(d);
      svg.append('text').attr('x', m.l - 10).attr('y', y0 + bh / 2).attr('dy', '0.32em').attr('text-anchor', 'end').attr('font-size', 11.5).attr('font-weight', 500).attr('fill', C.text).text(d.year);
      d.p.forEach((p, j) => {
        const sx = start;
        svg.append('rect').attr('y', y0).attr('height', bh).attr('fill', cols[j]).attr('rx', 2)
          .attr('x', x(0)).attr('width', 0)
          .on('mousemove', (ev) => App.tip.show(`<div class="tt-title">${d.year} · ${j + 1}★</div>` + App.tipRows([['Hospitals', App.f0(d.c[j])], ['Share of rated', App.pct1(p)], ['Rated hospitals', App.f0(d.n)]]), ev))
          .on('mouseleave', () => App.tip.hide())
          .transition().duration(dur).delay(i * 50).attr('x', x(sx)).attr('width', Math.max(0, x(sx + p) - x(sx) - 1));
        start += p;
      });
      svg.append('text').attr('x', x(-left(d)) - 6).attr('y', y0 + bh / 2).attr('dy', '0.32em').attr('text-anchor', 'end').attr('font-size', 10.5).attr('font-weight', 600).attr('fill', C.bad).text(App.pct0(d.p[0] + d.p[1]));
      svg.append('text').attr('x', x(right(d)) + 6).attr('y', y0 + bh / 2).attr('dy', '0.32em').attr('font-size', 10.5).attr('font-weight', 600).attr('fill', C.good).text(App.pct0(d.p[3] + d.p[4]));
    });
    svg.append('text').attr('x', w - m.r + 6).attr('y', m.t - 6).attr('font-size', 9.5).attr('fill', C.muted).text('4–5★');
    svg.append('text').attr('x', m.l - 6).attr('y', m.t - 6).attr('text-anchor', 'end').attr('font-size', 9.5).attr('fill', C.muted).text('1–2★');
  });

  App.register('heatmap', function () {
    const C = App.C, H = App.H;
    const el = document.getElementById('fig-heat');
    const dims = [
      ['nurse', 'Nurse communication'], ['doctor', 'Doctor communication'], ['staff', 'Staff responsiveness'], ['meds', 'Communication about medicines'],
      ['discharge', 'Discharge information'], ['transition', 'Care transition'], ['clean', 'Cleanliness'], ['quiet', 'Quietness'],
      ['overall', 'Overall hospital rating'], ['recommend', 'Would recommend'],
    ].map(([k, label]) => {
      const lastVal = [...H].reverse().find((d) => d[k] != null);
      return { k, label, latest: lastVal[k], latestYear: lastVal.year };
    }).sort((a, b) => b.latest - a.latest);
    const narrow = el.clientWidth < 520;
    const m = { t: 26, r: 8, b: 8, l: narrow ? 128 : 186 };
    const cellH = 30;
    const H0 = m.t + dims.length * cellH + m.b;
    const [svg, w] = App.makeSvg(el, H0, 'Heatmap of HCAHPS dimension change versus 2019');
    const years = H.map((d) => d.year);
    const cw = (w - m.l - m.r) / years.length;
    const color = App.diverging(-3, 0, 3, false);
    svg.append('defs').append('pattern').attr('id', 'hatch2').attr('patternUnits', 'userSpaceOnUse').attr('width', 6).attr('height', 6).attr('patternTransform', 'rotate(45)')
      .append('line').attr('y2', 6).attr('stroke', C.faint).attr('stroke-width', 1.5);
    years.forEach((y, j) => svg.append('text').attr('x', m.l + j * cw + cw / 2).attr('y', m.t - 9).attr('text-anchor', 'middle').attr('font-size', 10.5).attr('font-weight', j === 0 ? 600 : 400).attr('fill', j === 0 ? C.text : C.muted).text(j === 0 ? `${y} base` : y));
    dims.forEach((d, i) => {
      const y0 = m.t + i * cellH;
      const label = narrow ? d.label.replace('Communication about medicines', 'Medicines comm.').replace('communication', 'comm.') : d.label;
      svg.append('text').attr('x', m.l - 10).attr('y', y0 + cellH / 2).attr('dy', '0.32em').attr('text-anchor', 'end').attr('font-size', 11.5).attr('fill', C.text).text(label);
      const base = H[0][d.k];
      H.forEach((row, j) => {
        const v = row[d.k];
        const x0 = m.l + j * cw;
        const g = svg.append('g');
        if (v == null) {
          g.append('rect').attr('x', x0 + 1.5).attr('y', y0 + 1.5).attr('width', cw - 3).attr('height', cellH - 3).attr('rx', 2).attr('fill', 'url(#hatch2)');
          g.append('text').attr('x', x0 + cw / 2).attr('y', y0 + cellH / 2).attr('dy', '0.32em').attr('text-anchor', 'middle').attr('font-size', 10).attr('fill', C.muted).text('n/a');
          return;
        }
        const delta = v - base;
        const fill = j === 0 ? C.surface2 : color(delta);
        g.append('rect').attr('x', x0 + 1.5).attr('y', y0 + 1.5).attr('width', cw - 3).attr('height', cellH - 3).attr('rx', 2).attr('fill', fill);
        g.append('text').attr('x', x0 + cw / 2).attr('y', y0 + cellH / 2).attr('dy', '0.32em').attr('text-anchor', 'middle').attr('font-size', 10.5).attr('font-weight', j === 0 ? 600 : 500)
          .attr('fill', j === 0 ? C.text : App.inkOn(fill)).attr('font-variant-numeric', 'tabular-nums').text(j === 0 ? App.f1(v) : App.signNum(delta, 1));
        g.on('mousemove', (ev) => App.tip.show(`<div class="tt-title">${d.label}</div><div class="tt-sub">${row.year}</div>` + App.tipRows([['Linear mean score', App.f1(v)], ['vs 2019', App.signNum(delta, 2) + ' pts']]), ev)).on('mouseleave', () => App.tip.hide());
      });
    });
  });

  App.register('starFlags', function (anim) {
    const C = App.C;
    const el = document.getElementById('fig-starflags');
    const cols = starColors();
    const data = [1, 2, 3, 4, 5].map((s) => {
      const g = App.facilities.filter((f) => f.star === s && f.hai > 0);
      const wv = g.filter((f) => f.flagsWorse > 0).length;
      return { s, n: g.length, w: wv, p: wv / (g.length || 1) };
    });
    const H = 300, m = { t: 30, r: 10, b: 44, l: 40 };
    const [svg, w] = App.makeSvg(el, H, 'Bar chart: share of hospitals with an infection flagged worse, by star rating');
    const x = d3.scaleBand().domain(data.map((d) => d.s)).range([m.l, w - m.r]).padding(0.3);
    const y = d3.scaleLinear().domain([0, d3.max(data, (d) => d.p) * 1.2]).range([H - m.b, m.t]).nice();
    y.ticks(4).forEach((t) => {
      svg.append('line').attr('x1', m.l).attr('x2', w - m.r).attr('y1', y(t)).attr('y2', y(t)).attr('stroke', t === 0 ? C.borderStrong : C.grid);
      svg.append('text').attr('x', m.l - 8).attr('y', y(t)).attr('dy', '0.32em').attr('text-anchor', 'end').attr('font-size', 10).attr('fill', C.muted).text(App.pct0(t));
    });
    const dur = anim && !App.reduceMotion ? 700 : 0;
    data.forEach((d, i) => {
      const bx = x(d.s), bw = x.bandwidth();
      svg.append('rect').attr('x', bx).attr('width', bw).attr('rx', 1).attr('fill', d.p === 0 ? 'none' : cols[i]).attr('stroke', d.p === 0 ? C.good : 'none').attr('stroke-dasharray', '3 3')
        .attr('y', y(0)).attr('height', 0).transition().duration(dur).delay(i * 80).attr('y', y(d.p) - (d.p === 0 ? 3 : 0)).attr('height', Math.max(3, y(0) - y(d.p)));
      svg.append('text').attr('x', bx + bw / 2).attr('y', y(d.p) - 8).attr('text-anchor', 'middle').attr('font-size', d.s === 5 ? 15 : 12).attr('font-weight', 700).attr('fill', d.s === 5 ? C.good : C.text).text(App.pct1(d.p).replace('.0%', '%'));
      svg.append('text').attr('x', bx + bw / 2).attr('y', H - m.b + 17).attr('text-anchor', 'middle').attr('font-size', 12).attr('font-weight', 600).attr('fill', C.text2).text('★'.repeat(d.s));
      svg.append('text').attr('x', bx + bw / 2).attr('y', H - m.b + 32).attr('text-anchor', 'middle').attr('font-size', 10).attr('fill', C.muted).text(`n=${App.f0(d.n)}`);
      svg.append('rect').attr('x', bx).attr('width', bw).attr('y', m.t).attr('height', H - m.t - m.b).attr('fill', 'transparent')
        .on('mousemove', (ev) => App.tip.show(`<div class="tt-title">${d.s}★ hospitals</div>` + App.tipRows([['With infection data', App.f0(d.n)], ['≥1 infection worse', App.f0(d.w)], ['Share', App.pct1(d.p)]]), ev))
        .on('mouseleave', () => App.tip.hide());
    });
  });

  App.register('ridge', function (anim) {
    const C = App.C;
    const el = document.getElementById('fig-ridge');
    const cols = starColors();
    const lo = 0.7, hi = 1.45;
    const groups = [1, 2, 3, 4, 5].map((s) => {
      const v = App.facilities.filter((f) => f.star === s && f.psi90 != null).map((f) => f.psi90).sort(d3.ascending);
      return { s, v, med: d3.median(v), n: v.length };
    });
    const rowH = 46, overlap = 1.7;
    const m = { t: 22, r: 64, b: 34, l: 58 };
    const H = m.t + rowH * groups.length + m.b;
    const [svg, w] = App.makeSvg(el, H, 'Ridgeline plot of PSI-90 distributions by HCAHPS star rating');
    const x = d3.scaleLinear().domain([lo, hi]).range([m.l, w - m.r]);
    const xs = d3.range(lo, hi + 0.0001, 0.005);
    const bw = 0.028;
    const kde = (vals) => xs.map((t) => [t, d3.mean(vals, (v) => { const u = (t - v) / bw; return Math.abs(u) <= 1 ? 0.75 * (1 - u * u) / bw : 0; }) || 0]);
    const dens = groups.map((g) => kde(g.v));
    const maxD = d3.max(dens, (d) => d3.max(d, (p) => p[1]));
    const yD = d3.scaleLinear().domain([0, maxD]).range([0, rowH * overlap]);
    x.ticks(6).forEach((t) => {
      svg.append('line').attr('x1', x(t)).attr('x2', x(t)).attr('y1', m.t - 10).attr('y2', H - m.b).attr('stroke', t === 1 ? C.faint : C.grid).attr('stroke-dasharray', t === 1 ? '4 3' : null);
      svg.append('text').attr('x', x(t)).attr('y', H - m.b + 16).attr('text-anchor', 'middle').attr('font-size', 10.5).attr('fill', C.muted).text(t.toFixed(1));
    });
    svg.append('text').attr('x', x(1) + 5).attr('y', m.t - 4).attr('font-size', 10).attr('fill', C.muted).text('1.0 = expected');
    svg.append('text').attr('x', (m.l + w - m.r) / 2).attr('y', H - 4).attr('text-anchor', 'middle').attr('font-size', 10.5).attr('fill', C.muted).text('← safer        PSI‑90 composite (2024)        less safe →');
    groups.forEach((g, i) => {
      const base = m.t + (i + 1) * rowH;
      const area = d3.area().x((p) => x(p[0])).y0(base).y1((p) => base - yD(p[1])).curve(d3.curveBasis);
      const path = svg.append('path').datum(dens[i]).attr('fill', cols[i]).attr('fill-opacity', 0.62).attr('stroke', d3.color(cols[i]).darker(App.isDark() ? -0.4 : 0.6)).attr('stroke-width', 1.2).attr('d', area);
      if (anim && !App.reduceMotion) path.attr('transform', `translate(0,${rowH * 0.5}) scale(1,1)`).attr('opacity', 0).transition().duration(700).delay(i * 90).attr('transform', 'translate(0,0) scale(1,1)').attr('opacity', 1);
      const dm = dens[i].reduce((a, b) => (Math.abs(b[0] - g.med) < Math.abs(a[0] - g.med) ? b : a));
      svg.append('line').attr('x1', x(g.med)).attr('x2', x(g.med)).attr('y1', base).attr('y2', base - yD(dm[1])).attr('stroke', C.text).attr('stroke-width', 1.6);
      svg.append('text').attr('x', m.l - 10).attr('y', base - 4).attr('text-anchor', 'end').attr('font-size', 12).attr('font-weight', 600).attr('fill', C.text2).text('★'.repeat(g.s));
      svg.append('text').attr('x', w - m.r + 8).attr('y', base - 16).attr('font-size', 11).attr('font-weight', 600).attr('fill', C.text).text(App.f2(g.med));
      svg.append('text').attr('x', w - m.r + 8).attr('y', base - 3).attr('font-size', 9.5).attr('fill', C.muted).text(`n=${App.f0(g.n)}`);
      svg.append('rect').attr('x', m.l).attr('width', w - m.l - m.r).attr('y', base - rowH).attr('height', rowH).attr('fill', 'transparent')
        .on('mousemove', (ev) => App.tip.show(`<div class="tt-title">${g.s}★ hospitals · PSI‑90</div>` + App.tipRows([['Hospitals', App.f0(g.n)], ['Median', App.f2(g.med)], ['25th–75th pct', `${App.f2(d3.quantile(g.v, 0.25))} – ${App.f2(d3.quantile(g.v, 0.75))}`], ['Share below 1.0', App.pct0(g.v.filter((v) => v < 1).length / g.n)]]), ev))
        .on('mouseleave', () => App.tip.hide());
    });
    svg.append('text').attr('x', w - m.r + 8).attr('y', m.t - 4).attr('font-size', 9.5).attr('font-weight', 600).attr('fill', C.muted).text('median');
  });
})();
