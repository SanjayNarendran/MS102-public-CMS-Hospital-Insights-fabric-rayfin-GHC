/* Overview KPIs + Chapter 01 (infection trends) */
(function () {
  'use strict';
  const App = window.App;

  function sparkline(el, series, opts) {
    const C = App.C;
    const h = 46;
    const [svg, w] = App.makeSvg(el, h, opts.label, 60);
    const m = { t: 6, r: 6, b: 6, l: 6 };
    const x = d3.scaleLinear().domain(d3.extent(series, (d) => d.year)).range([m.l, w - m.r]);
    const [lo, hi] = d3.extent(series, (d) => d.v);
    const pad = (hi - lo) * 0.18 || 0.1;
    const y = d3.scaleLinear().domain([lo - pad, hi + pad]).range([h - m.b, m.t]);
    const col = opts.color;
    const area = d3.area().x((d) => x(d.year)).y0(h - m.b).y1((d) => y(d.v)).curve(d3.curveMonotoneX);
    const line = d3.line().x((d) => x(d.year)).y((d) => y(d.v)).curve(d3.curveMonotoneX);
    svg.append('path').datum(series).attr('d', area).attr('fill', col).attr('fill-opacity', 0.06);
    svg.append('path').datum(series).attr('d', line).attr('fill', 'none').attr('stroke', col).attr('stroke-width', 2).attr('stroke-linecap', 'round');
    const end = series[series.length - 1];
    svg.append('circle').attr('cx', x(end.year)).attr('cy', y(end.v)).attr('r', 3.5).attr('fill', col).attr('stroke', C.surface).attr('stroke-width', 2);
    if (opts.mark) {
      const p = series.find((d) => d.year === opts.mark);
      if (p) svg.append('circle').attr('cx', x(p.year)).attr('cy', y(p.v)).attr('r', 2.8).attr('fill', C.surface).attr('stroke', col).attr('stroke-width', 1.5);
    }
    const hover = svg.append('g').style('display', 'none');
    hover.append('line').attr('y1', m.t).attr('y2', h - m.b).attr('stroke', C.faint).attr('stroke-dasharray', '2 2');
    hover.append('circle').attr('r', 3.5).attr('fill', col);
    svg.append('rect').attr('width', w).attr('height', h).attr('fill', 'transparent')
      .on('mousemove', (ev) => {
        const [mx] = d3.pointer(ev);
        const yr = Math.round(x.invert(mx));
        const p = series.reduce((a, b) => (Math.abs(b.year - yr) < Math.abs(a.year - yr) ? b : a));
        hover.style('display', null);
        hover.select('line').attr('x1', x(p.year)).attr('x2', x(p.year));
        hover.select('circle').attr('cx', x(p.year)).attr('cy', y(p.v));
        App.tip.show(`<div class="tt-title">${p.year}</div>${opts.label}: <b>${opts.fmt(p.v)}</b>`, ev);
      })
      .on('mouseleave', () => { hover.style('display', 'none'); App.tip.hide(); });
  }

  App.register('kpis', function () {
    const { last, first, H, P, facts: F, C } = App;
    const el = document.getElementById('kpis');
    el.innerHTML = '';
    const cl = App.sirSeries('clabsi');
    const clPeak = d3.greatest(cl, (d) => d.v);
    const worse = F.worseSeries;
    const wPeak = d3.greatest(worse, (d) => d.v);
    const cards = [
      { id: 'clabsi', label: 'Central‑line bloodstream infections (CLABSI)', value: App.f2(last.clabsi.sir), unit: 'SIR', delta: last.clabsi.sir / clPeak.v - 1, ctx: `from the ${clPeak.year} peak of ${App.f2(clPeak.v)}`, series: cl, mark: clPeak.year, fmt: App.f2, note: 'Below 1.0 means fewer than predicted' },
      { id: 'cdiff', label: 'C. diff infections', value: App.f2(last.cdiff.sir), unit: 'SIR', delta: last.cdiff.sir / first.cdiff.sir - 1, ctx: `since ${first.year} (${App.f2(first.cdiff.sir)})`, series: App.sirSeries('cdiff'), fmt: App.f2, note: 'Lower every year' },
      { id: 'hyst', label: 'Surgical‑site infection after abdominal hysterectomy', value: App.f2(last.ssi_hyst.sir), unit: 'SIR', delta: last.ssi_hyst.sir / first.ssi_hyst.sir - 1, ctx: `since ${first.year} (${App.f2(first.ssi_hyst.sir)})`, series: App.sirSeries('ssi_hyst'), fmt: App.f2, note: 'Now above the national baseline', alert: true },
      { id: 'flags', label: 'Hospital‑infection pairs flagged worse than benchmark', value: App.f0(worse[worse.length - 1].v), unit: 'flags', delta: worse[worse.length - 1].v / wPeak.v - 1, ctx: `from the ${wPeak.year} peak of ${App.f0(wPeak.v)}`, series: worse, mark: wPeak.year, fmt: App.f0, note: '95% CI entirely above SIR 1.0' },
      { id: 'star', label: 'Average HCAHPS summary star (patient experience)', value: App.f2(H[H.length - 1].avgstar), unit: '★', delta: H[H.length - 1].avgstar / H[0].avgstar - 1, higherBetter: true, ctx: `since ${H[0].year} (${App.f2(H[0].avgstar)})`, series: H.map((d) => ({ year: d.year, v: d.avgstar })), mark: +F.starLowYear, fmt: App.f2, note: `Recovered from ${F.starLow} in ${F.starLowYear}` },
      { id: 'psi', label: 'PSI‑90 patient‑safety composite, hospital mean', value: App.f2(P[P.length - 1].psi90), unit: 'index', delta: P[P.length - 1].psi90 / P[0].psi90 - 1, ctx: `since ${P[0].year} (${App.f2(P[0].psi90)})`, series: P.map((d) => ({ year: d.year, v: d.psi90 })), fmt: App.f2, note: `Median ${App.f2(P[P.length - 1].psi90_med)}; 1.0 is expected` },
    ];
    cards.forEach((c) => {
      const flat = Math.abs(c.delta) < 0.02;
      const good = c.higherBetter ? c.delta > 0 : c.delta < 0;
      const cls = flat ? 'flat' : good ? 'good' : 'bad';
      const arrow = flat ? '' : c.delta < 0 ? '▼ ' : '▲ ';
      const color = flat ? C.muted : good ? C.good : C.bad;
      const card = document.createElement('div');
      card.className = 'kpi' + (c.alert ? ' alert' : '');
      card.innerHTML = `
        <div class="kpi-label">${c.label}</div>
        <div class="kpi-value">${c.value}<span class="kpi-unit">${c.unit}</span></div>
        <div class="kpi-row"><span class="delta ${cls}">${flat ? 'No change' : arrow + App.pct0(Math.abs(c.delta))}</span><span class="kpi-sub">${c.ctx}</span></div>
        <div class="spark"></div>
        <div class="kpi-note">${c.note}</div>`;
      el.appendChild(card);
      sparkline(card.querySelector('.spark'), c.series, { id: c.id, color, label: c.label.split('·')[0].trim(), fmt: c.fmt, mark: c.mark });
    });
  });

  // Fig 1 drawing rules, shared with the Explain panel so its description always matches the chart
  App.FIG1 = {
    flatBand: 0.02,
    peakLift: 0.10,
    covid: [2020, 2021],
    yMax: () => Math.max(1.2, d3.max(App.T, (d) => d3.max(App.INFK, (k) => d[k].sir))) * 1.06,
  };

  App.register('smallMultiples', function (anim) {
    const C = App.C, T = App.T;
    const el = document.getElementById('fig-sm');
    const w0 = el.clientWidth;
    const cols = w0 > 860 ? 3 : w0 > 540 ? 2 : 1;
    const rows = Math.ceil(App.INF.length / cols);
    const gapX = 28, gapY = 24, ph = 204;
    const pw = (w0 - gapX * (cols - 1)) / cols;
    const [svg] = App.makeSvg(el, rows * ph + (rows - 1) * gapY, 'Small multiples: national SIR by infection, 2019 to 2025');
    const m = { t: 70, r: 4, b: 26, l: 26 };
    const years = T.map((d) => d.year);
    for (let c = 1; c < cols; c++) svg.append('line').attr('x1', c * (pw + gapX) - gapX / 2).attr('x2', c * (pw + gapX) - gapX / 2).attr('y1', 0).attr('y2', rows * ph + (rows - 1) * gapY).attr('stroke', C.border);
    for (let r = 1; r < rows; r++) svg.append('line').attr('x1', 0).attr('x2', w0).attr('y1', r * (ph + gapY) - gapY / 2).attr('y2', r * (ph + gapY) - gapY / 2).attr('stroke', C.border);
    const x = d3.scaleLinear().domain(d3.extent(years)).range([m.l, pw - m.r]);
    const yMax = App.FIG1.yMax();
    const y = d3.scaleLinear().domain([0, yMax]).range([ph - m.b, m.t]);
    const panels = [];

    App.INF.forEach((inf, i) => {
      const g = svg.append('g').attr('transform', `translate(${(i % cols) * (pw + gapX)},${Math.floor(i / cols) * (ph + gapY)})`);
      const s = App.sirSeries(inf.key);
      const v0 = s[0].v, v1 = s[s.length - 1].v;
      const chg = v1 / v0 - 1;
      const col = Math.abs(chg) < App.FIG1.flatBand ? C.muted : chg < 0 ? C.good : C.bad;

      const [cv0, cv1] = App.FIG1.covid;
      g.append('rect').attr('x', x(cv0)).attr('width', x(cv1) - x(cv0)).attr('y', m.t - 14).attr('height', ph - m.b - m.t + 14).attr('fill', C.text).attr('fill-opacity', App.isDark() ? 0.07 : 0.05);
      if (i === 0) g.append('text').attr('x', (x(cv0) + x(cv1)) / 2).attr('y', m.t - 18).attr('text-anchor', 'middle').attr('font-size', 10).attr('font-weight', 500).attr('fill', C.muted).text('COVID‑19');

      [0.5, 1].forEach((t) => {
        g.append('line').attr('x1', m.l).attr('x2', pw - m.r).attr('y1', y(t)).attr('y2', y(t))
          .attr('stroke', t === 1 ? C.faint : C.grid).attr('stroke-dasharray', t === 1 ? '4 3' : null);
        g.append('text').attr('x', m.l - 6).attr('y', y(t)).attr('dy', '0.32em').attr('text-anchor', 'end').attr('font-size', 10).attr('fill', C.muted).text(t.toFixed(1));
      });
      if (i === 0) g.append('text').attr('x', pw - m.r).attr('y', y(1) - 5).attr('text-anchor', 'end').attr('font-size', 9.5).attr('fill', C.muted).text('2015 baseline');
      years.forEach((yr) => g.append('text').attr('x', x(yr)).attr('y', ph - 9).attr('text-anchor', 'middle').attr('font-size', 10).attr('fill', C.muted).text(`’${String(yr).slice(2)}`));

      g.append('text').attr('x', 0).attr('y', 22).attr('font-size', 13).attr('font-weight', 600).attr('fill', C.text).text(inf.short);
      g.append('text').attr('x', 0).attr('y', 38).attr('font-size', 11).attr('fill', C.muted).text(inf.label.length > 38 && pw < 330 ? inf.label.slice(0, 36) + '…' : inf.label);
      g.append('text').attr('x', pw).attr('y', 24).attr('text-anchor', 'end').attr('font-size', 22).attr('font-weight', 500).attr('font-family', 'var(--font-display)').attr('fill', col).text(App.f2(v1));
      g.append('text').attr('x', pw).attr('y', 39).attr('text-anchor', 'end').attr('font-size', 10.5).attr('font-weight', 600).attr('fill', col).text(`${App.signPct(chg)} vs ’19`);

      g.append('path').datum(s).attr('fill', col).attr('fill-opacity', 0.07)
        .attr('d', d3.area().x((d) => x(d.year)).y0(y(0)).y1((d) => y(d.v)).curve(d3.curveMonotoneX));
      const path = g.append('path').datum(s).attr('fill', 'none').attr('stroke', col).attr('stroke-width', 2.4).attr('stroke-linecap', 'round')
        .attr('d', d3.line().x((d) => x(d.year)).y((d) => y(d.v)).curve(d3.curveMonotoneX));
      if (anim && !App.reduceMotion) {
        const L = path.node().getTotalLength();
        path.attr('stroke-dasharray', `${L} ${L}`).attr('stroke-dashoffset', L).transition().duration(1100).delay(i * 90).ease(d3.easeCubicOut).attr('stroke-dashoffset', 0);
      }
      g.selectAll('circle.pt').data(s).join('circle').attr('class', 'pt').attr('cx', (d) => x(d.year)).attr('cy', (d) => y(d.v)).attr('r', 2.6).attr('fill', C.surface).attr('stroke', col).attr('stroke-width', 1.5);

      const peak = d3.greatest(s, (d) => d.v);
      if (peak.year !== s[0].year && peak.year !== s[s.length - 1].year && peak.v > v0 * (1 + App.FIG1.peakLift)) {
        g.append('text').attr('x', x(peak.year)).attr('y', y(peak.v) - 9).attr('text-anchor', 'middle').attr('font-size', 10).attr('font-weight', 600).attr('fill', C.text2).text(`peak ${App.f2(peak.v)}`);
      }

      const hov = g.append('g').style('display', 'none').attr('pointer-events', 'none');
      hov.append('line').attr('y1', m.t - 4).attr('y2', ph - m.b).attr('stroke', C.text2).attr('stroke-opacity', 0.35);
      hov.append('circle').attr('r', 4.5).attr('fill', col).attr('stroke', C.surface).attr('stroke-width', 2);
      const lbl = hov.append('g');
      lbl.append('rect').attr('rx', 2).attr('height', 20).attr('fill', C.text);
      lbl.append('text').attr('font-size', 11).attr('font-weight', 600).attr('fill', C.bg).attr('dy', 14);
      panels.push({ hov, lbl, s });

      g.append('rect').attr('width', pw).attr('height', ph).attr('fill', 'transparent')
        .on('mousemove', (ev) => {
          const [mx] = d3.pointer(ev);
          const yr = Math.max(years[0], Math.min(years[years.length - 1], Math.round(x.invert(mx))));
          panels.forEach((p) => {
            const d = p.s.find((q) => q.year === yr);
            p.hov.style('display', null);
            p.hov.select('line').attr('x1', x(yr)).attr('x2', x(yr));
            p.hov.select('circle').attr('cx', x(yr)).attr('cy', y(d.v));
            const t = `${yr} · ${App.f2(d.v)}`;
            p.lbl.select('text').text(t).attr('x', 7);
            const tw = p.lbl.select('text').node().getComputedTextLength() + 14;
            p.lbl.select('rect').attr('width', tw);
            let lx = x(yr) - tw / 2;
            lx = Math.max(m.l - 4, Math.min(pw - m.r - tw + 4, lx));
            const ly = y(d.v) - 30 < m.t - 6 ? y(d.v) + 10 : y(d.v) - 30;
            p.lbl.attr('transform', `translate(${lx},${ly})`);
          });
        })
        .on('mouseleave', () => panels.forEach((p) => p.hov.style('display', 'none')));
    });
  });

  App.register('dumbbell', function (anim) {
    const C = App.C, T = App.T;
    const el = document.getElementById('fig-db');
    const rows = App.INF.map((inf) => {
      const a = App.first[inf.key].sir, b = App.last[inf.key].sir;
      const pk = d3.greatest(T, (d) => d[inf.key].sir);
      return { inf, a, b, chg: b / a - 1, peak: pk[inf.key].sir, peakYear: pk.year };
    }).sort((p, q) => p.chg - q.chg);
    const rowH = 46, m = { t: 30, r: 58, b: 30, l: 128 };
    const H = m.t + rowH * rows.length + m.b;
    const [svg, w] = App.makeSvg(el, H, 'Dumbbell chart: SIR 2019 versus 2025 by infection');
    const x = d3.scaleLinear().domain([0, Math.max(1.25, d3.max(rows, (r) => Math.max(r.a, r.b, r.peak)) * 1.05)]).range([m.l, w - m.r]);
    x.ticks(5).forEach((t) => {
      svg.append('line').attr('x1', x(t)).attr('x2', x(t)).attr('y1', m.t - 6).attr('y2', H - m.b).attr('stroke', t === 1 ? C.faint : C.grid).attr('stroke-dasharray', t === 1 ? '4 3' : null);
      svg.append('text').attr('x', x(t)).attr('y', H - m.b + 18).attr('text-anchor', 'middle').attr('font-size', 10.5).attr('fill', C.muted).text(t === 0 ? '0' : d3.format('.1f')(t));
    });
    svg.append('text').attr('x', x(1) + 5).attr('y', m.t - 12).attr('font-size', 10).attr('fill', C.muted).text('baseline 1.0');
    const lg = svg.append('g').attr('transform', `translate(${m.l},${m.t - 16})`).attr('font-size', 10.5).attr('fill', C.muted);
    lg.append('circle').attr('cx', 0).attr('cy', 0).attr('r', 4.5).attr('fill', C.surface).attr('stroke', C.muted).attr('stroke-width', 1.5);
    lg.append('text').attr('x', 9).attr('dy', '0.35em').text('2019');
    lg.append('circle').attr('cx', 52).attr('cy', 0).attr('r', 5).attr('fill', C.text2);
    lg.append('text').attr('x', 61).attr('dy', '0.35em').text('2025');
    lg.append('path').attr('d', d3.symbol(d3.symbolDiamond, 34)()).attr('transform', 'translate(104,0)').attr('fill', C.faint);
    lg.append('text').attr('x', 112).attr('dy', '0.35em').text('peak');

    rows.forEach((r, i) => {
      const cy = m.t + i * rowH + rowH / 2;
      const col = Math.abs(r.chg) < 0.02 ? C.muted : r.chg < 0 ? C.good : C.bad;
      const g = svg.append('g');
      g.append('text').attr('x', m.l - 14).attr('y', cy).attr('dy', '0.32em').attr('text-anchor', 'end').attr('font-size', 12.5).attr('font-weight', 500).attr('fill', C.text).text(r.inf.short);
      if (r.peak > Math.max(r.a, r.b) + 0.03) {
        g.append('line').attr('x1', x(Math.max(r.a, r.b))).attr('x2', x(r.peak)).attr('y1', cy).attr('y2', cy).attr('stroke', C.faint).attr('stroke-dasharray', '2 3');
        g.append('path').attr('d', d3.symbol(d3.symbolDiamond, 40)()).attr('transform', `translate(${x(r.peak)},${cy})`).attr('fill', C.faint);
      }
      const ln = g.append('line').attr('x1', x(r.a)).attr('x2', x(r.a)).attr('y1', cy).attr('y2', cy).attr('stroke', col).attr('stroke-width', 4).attr('stroke-linecap', 'round').attr('stroke-opacity', 0.55);
      const dot = g.append('circle').attr('cx', x(r.a)).attr('cy', cy).attr('r', 6.5).attr('fill', col);
      g.append('circle').attr('cx', x(r.a)).attr('cy', cy).attr('r', 5.5).attr('fill', C.surface).attr('stroke', C.muted).attr('stroke-width', 1.6);
      const dur = anim && !App.reduceMotion ? 900 : 0;
      ln.transition().duration(dur).delay(i * 70).attr('x2', x(r.b));
      dot.transition().duration(dur).delay(i * 70).attr('cx', x(r.b));
      g.append('text').attr('x', w - m.r + 10).attr('y', cy).attr('dy', '0.32em').attr('font-size', 12).attr('font-weight', 600).attr('fill', col).text(App.signPct(r.chg));
      g.append('rect').attr('x', 0).attr('y', cy - rowH / 2).attr('width', w).attr('height', rowH).attr('fill', 'transparent')
        .on('mousemove', (ev) => App.tip.show(`<div class="tt-title">${r.inf.label}</div>` + App.tipRows([['2019 SIR', App.f2(r.a)], [`Peak (${r.peakYear})`, App.f2(r.peak)], ['2025 SIR', App.f2(r.b)], ['Change', App.signPct(r.chg)]]), ev))
        .on('mouseleave', () => App.tip.hide());
    });
  });

  App.register('flags', function (anim) {
    const C = App.C, T = App.T, st = App.state;
    App.chips(document.getElementById('chips-flags'), App.INF.map((d) => ({ value: d.key, label: d.short })), st.flagsInf, (v) => { st.flagsInf = v; App.renderOne('flags', true); });
    const el = document.getElementById('fig-flags');
    const k = st.flagsInf;
    const data = T.map((d) => ({ year: d.year, n: d[k].n, b: d[k].better, w: d[k].worse, better: d[k].better / d[k].n, worse: d[k].worse / d[k].n }));
    const H = 288, m = { t: 26, r: 12, b: 26, l: 42 };
    const [svg, w] = App.makeSvg(el, H, 'Diverging bars: share of hospitals better and worse than benchmark by year');
    const x = d3.scaleBand().domain(data.map((d) => d.year)).range([m.l, w - m.r]).padding(0.38);
    const maxB = d3.max(data, (d) => d.better), maxW = d3.max(data, (d) => d.worse);
    const y = d3.scaleLinear().domain([-Math.max(maxW, maxB * 0.25), maxB]).range([H - m.b, m.t]).nice();
    y.ticks(5).forEach((t) => {
      svg.append('line').attr('x1', m.l).attr('x2', w - m.r).attr('y1', y(t)).attr('y2', y(t)).attr('stroke', t === 0 ? C.borderStrong : C.grid);
      svg.append('text').attr('x', m.l - 8).attr('y', y(t)).attr('dy', '0.32em').attr('text-anchor', 'end').attr('font-size', 10).attr('fill', C.muted).text(App.pct0(Math.abs(t)));
    });
    const lg = svg.append('g').attr('transform', `translate(${m.l},${m.t - 10})`).attr('font-size', 10.5).attr('font-weight', 600);
    lg.append('text').attr('fill', C.good).text('▲ Better than benchmark');
    lg.append('text').attr('x', 150).attr('fill', C.bad).text('▼ Worse than benchmark');
    const dur = anim && !App.reduceMotion ? 700 : 0;
    const g = svg.selectAll('g.yr').data(data).join('g').attr('class', 'yr');
    g.append('rect').attr('x', (d) => x(d.year)).attr('width', x.bandwidth()).attr('rx', 1).attr('fill', C.good)
      .attr('y', y(0)).attr('height', 0).transition().duration(dur).attr('y', (d) => y(d.better)).attr('height', (d) => y(0) - y(d.better));
    g.append('rect').attr('x', (d) => x(d.year)).attr('width', x.bandwidth()).attr('rx', 1).attr('fill', C.bad)
      .attr('y', y(0)).attr('height', 0).transition().duration(dur).attr('height', (d) => y(-d.worse) - y(0));
    g.append('text').attr('x', (d) => x(d.year) + x.bandwidth() / 2).attr('y', (d) => y(d.better) - 5).attr('text-anchor', 'middle').attr('font-size', 10.5).attr('font-weight', 600).attr('fill', C.text2).text((d) => App.pct0(d.better));
    g.append('text').attr('x', (d) => x(d.year) + x.bandwidth() / 2).attr('y', (d) => y(-d.worse) + 13).attr('text-anchor', 'middle').attr('font-size', 10.5).attr('font-weight', 600).attr('fill', C.bad).text((d) => App.pct1(d.worse));
    svg.selectAll('text.yl').data(data).join('text').attr('class', 'yl').attr('x', (d) => x(d.year) + x.bandwidth() / 2).attr('y', H - m.b + 16).attr('text-anchor', 'middle').attr('font-size', 10.5).attr('fill', C.muted).text((d) => d.year);
    g.append('rect').attr('x', (d) => x(d.year) - x.step() * x.paddingInner() / 2).attr('width', x.step()).attr('y', m.t).attr('height', H - m.t - m.b).attr('fill', 'transparent')
      .on('mousemove', (ev, d) => App.tip.show(`<div class="tt-title">${App.infByKey[k].short} · ${d.year}</div><div class="tt-sub">${App.f0(d.n)} hospitals with an SIR</div>` + App.tipRows([['Better than benchmark', `${App.f0(d.b)} (${App.pct1(d.better)})`], ['Worse than benchmark', `${App.f0(d.w)} (${App.pct1(d.worse)})`]]), ev))
      .on('mouseleave', () => App.tip.hide());
  });
})();
