/* Chapter 07: outcomes, emergency-department waits and Medicare penalties (local CMS Care Compare files) */
(function () {
  'use strict';
  const App = window.App;
  if (!App.X) return;
  const X = App.X, N = X.national;
  const LOC = window.CMS_LOCATIONS || { rows: {}, extra: {} };

  // State of every hospital in the outcome files, scored or not, so a focused state's distribution is complete
  const stOf = new Map(App.facilities.map((f) => [f.id, f.st]));
  Object.entries(LOC.extra || {}).forEach(([id, r]) => stOf.set(id, r[9]));
  const ovrByState = {};
  Object.keys(X.states).forEach((c) => { ovrByState[c] = [0, 0, 0, 0, 0, 0]; });
  stOf.forEach((code, id) => {
    const x = X.get(id);
    if (!x || !ovrByState[code]) return;
    ovrByState[code][x.ovr || 0]++;
  });

  App.outcomeFacts = function () {
    const rated = d3.sum(Object.values(N.ovr));
    const top = (N.ovr['4'] || 0) + (N.ovr['5'] || 0);
    return {
      ovrRated: App.f0(rated), ovrTop: App.pct0(top / rated), ovrFive: App.f0(N.ovr['5'] || 0), ovrUnrated: App.f0(N.unrated),
      edMedian: App.fmtMin(N.ed.median), edP90: App.fmtMin(N.ed.p90),
      hacCut: App.f0(N.hacCut), hacN: App.f0(N.hacN), hacPct: App.pct0(N.hacCut / N.hacN),
      hrrpExcess: App.f0(N.hrrpAny.excess), hrrpN: App.f0(N.hrrpAny.n), hrrpPct: App.pct0(N.hrrpAny.excess / N.hrrpAny.n),
      mortWorse: App.f0(N.mortN.anyWorse), mortBetter: App.f0(N.mortN.anyBetter), mortN: App.f0(N.mortN.n),
    };
  };

  // Fig 13 · CMS overall star rating. A focus change animates the bars between the nation and the state; a resize,
  // theme change or first draw rebuilds the chart.
  App.register('ovr', function (anim) {
    const C = App.C;
    const el = document.getElementById('fig-ovr');
    const key = `${el.clientWidth}|${App.isDark()}`;
    if (!anim && el.__ovr && el.__ovr.key === key) { el.__ovr.focus(App.state.focus, 450); return; }
    const counts = [1, 2, 3, 4, 5].map((s) => ({ s, n: N.ovr[String(s)] || 0 }));
    const total = d3.sum(counts, (d) => d.n);
    const share = (d) => d.n / total;
    const H = 268, m = { t: 30, r: 10, b: 30, l: 10 };
    const [svg, w] = App.makeSvg(el, H, 'Bar chart: hospitals by CMS overall star rating');
    const x = d3.scaleBand().domain(counts.map((d) => d.s)).range([m.l, w - m.r]).padding(0.3);
    const y = d3.scaleLinear().range([H - m.b, m.t]);
    // The same graded scale as the other star charts (1★ strongest orange, 5★ strongest blue); 3★ a shade darker than
    // theirs so its bar still shows when faded behind a state's
    const sc = App.starColors();
    const col = (s) => (s === 3 ? C.neutral : sc[s - 1]);
    const lw = x.bandwidth() * 0.46;
    const caption = svg.append('text').attr('x', m.l).attr('y', 14).attr('font-size', 11);
    const g = svg.selectAll('g.st').data(counts).join('g').attr('class', 'st');
    const nat = g.append('rect').attr('x', (d) => x(d.s)).attr('width', x.bandwidth()).attr('rx', 1).attr('fill', (d) => col(d.s)).attr('y', y.range()[0]).attr('height', 0);
    const loc = g.append('rect').attr('x', (d) => x(d.s) + (x.bandwidth() - lw) / 2).attr('width', lw).attr('rx', 1).attr('fill', (d) => col(d.s)).attr('y', y.range()[0]).attr('height', 0);
    const val = g.append('text').attr('x', (d) => x(d.s) + x.bandwidth() / 2).attr('y', y.range()[0] - 7).attr('text-anchor', 'middle').attr('font-size', 11).attr('font-weight', 600).attr('class', 'tnum');
    svg.selectAll('text.xl').data(counts).join('text').attr('class', 'xl').attr('x', (d) => x(d.s) + x.bandwidth() / 2).attr('y', H - m.b + 18).attr('text-anchor', 'middle').attr('font-size', 12).attr('fill', C.text2)
      .text((d) => '★'.repeat(d.s));
    let cur = null;
    const focus = (f, dur, step = 0) => {
      const local = f && ovrByState[f] ? ovrByState[f] : null;
      const lt = local ? d3.sum(local.slice(1)) : 0;
      const ls = (d) => (local && lt ? local[d.s] / lt : 0);
      cur = local && lt ? { f, local, lt } : null;
      y.domain([0, Math.max(d3.max(counts, share), cur ? d3.max(counts, ls) : 0) * 1.12]);
      const t = (sel) => sel.transition('focus').duration(dur).delay((d, i) => i * step).ease(d3.easeCubicOut);
      t(nat).attr('y', (d) => y(share(d))).attr('height', (d) => y(0) - y(share(d))).attr('fill-opacity', cur ? 0.35 : 1);
      t(loc).attr('y', (d) => y(ls(d))).attr('height', (d) => y(0) - y(ls(d)));
      t(val).attr('y', (d) => (cur ? Math.min(y(ls(d)), y(share(d))) : y(share(d))) - 7).attr('fill', cur ? C.text : C.text2);
      val.text((d) => App.pct0(cur ? ls(d) : share(d)));
      caption.attr('fill', cur ? C.text2 : C.muted).text(cur ? `${App.STATE_NAMES[f] || f}: ${App.f0(lt)} rated (solid) vs national (faded)` : `${App.f0(total)} rated hospitals · ${App.f0(N.unrated)} not rated (too few measures)`);
    };
    g.append('rect').attr('x', (d) => x(d.s)).attr('width', x.bandwidth()).attr('y', m.t).attr('height', H - m.t - m.b).attr('fill', 'transparent')
      .on('mousemove', (ev, d) => App.tip.show(`<div class="tt-title">${d.s} star${d.s > 1 ? 's' : ''}</div>` + App.tipRows([
        ['National', `${App.f0(d.n)} hospitals (${App.pct1(share(d))})`],
        ...(cur ? [[App.STATE_NAMES[cur.f] || cur.f, `${App.f0(cur.local[d.s])} (${App.pct1(cur.local[d.s] / cur.lt)})`]] : []),
      ]), ev))
      .on('mouseleave', () => App.tip.hide());
    focus(App.state.focus, anim && !App.reduceMotion ? 700 : 0, 60);
    el.__ovr = { key, focus: (f, dur) => focus(f, App.reduceMotion ? 0 : dur) };
  });

  // Fig 14 · Median ED time by state. A focus change only restyles the bars and labels; a resize, theme change or first
  // draw rebuilds the chart.
  App.register('edStates', function (anim) {
    const C = App.C;
    const el = document.getElementById('fig-ed');
    const key = `${el.clientWidth}|${App.isDark()}`;
    if (!anim && el.__ed && el.__ed.key === key) { el.__ed.focus(App.state.focus, 250); return; }
    const data = Object.entries(X.states).filter(([c, s]) => s.ed != null && s.edN >= 5 && App.STATE_NAMES[c]).map(([c, s]) => ({ c, v: s.ed, n: s.edN }))
      .sort((a, b) => a.v - b.v);
    // Every state is named: side by side where the columns are wide enough, on two staggered rows where they aren't,
    // and upright on a very narrow chart
    const LABEL_W = 15;
    const w0 = el.clientWidth || 600, step0 = (w0 - 48) / data.length;
    const mode = step0 >= LABEL_W ? 'row' : step0 * 2 >= LABEL_W ? 'stagger' : 'upright';
    const H = 300 + (mode === 'row' ? 0 : 14), m = { t: 22, r: 8, b: mode === 'row' ? 34 : 48, l: 40 };
    const [svg, w] = App.makeSvg(el, H, 'Column chart: median emergency department time by state');
    const x = d3.scaleBand().domain(data.map((d) => d.c)).range([m.l, w - m.r]).padding(0.22);
    const y = d3.scaleLinear().domain([0, d3.max(data, (d) => d.v) * 1.08]).range([H - m.b, m.t]).nice();
    y.ticks(5).forEach((t) => {
      svg.append('line').attr('x1', m.l).attr('x2', w - m.r).attr('y1', y(t)).attr('y2', y(t)).attr('stroke', C.grid);
      svg.append('text').attr('x', m.l - 8).attr('y', y(t)).attr('dy', '0.32em').attr('text-anchor', 'end').attr('font-size', 10).attr('fill', C.muted).text(t === 0 ? '0' : `${t}m`);
    });
    // Scale to the typical spread so most states take on colour; outliers (e.g. Puerto Rico) clamp to the end colour
    const dev = d3.quantile(data.map((d) => Math.abs(d.v - N.ed.median)).sort(d3.ascending), 0.85) || 20;
    const color = App.diverging(N.ed.median - dev, N.ed.median, N.ed.median + dev, true);
    const dur = anim && !App.reduceMotion ? 700 : 0;
    const bars = svg.selectAll('rect.b').data(data).join('rect').attr('class', 'b').attr('x', (d) => x(d.c)).attr('width', x.bandwidth()).attr('rx', 1)
      .attr('fill', (d) => color(d.v)).attr('stroke', C.text).attr('stroke-width', 2).attr('stroke-opacity', 0);
    bars.attr('y', y(0)).attr('height', 0).transition().duration(dur).delay((d, i) => i * 8).attr('y', (d) => y(d.v)).attr('height', (d) => y(0) - y(d.v));
    svg.append('line').attr('x1', m.l).attr('x2', w - m.r).attr('y1', y(N.ed.median)).attr('y2', y(N.ed.median)).attr('stroke', C.text).attr('stroke-dasharray', '4 3').attr('stroke-opacity', 0.7);
    svg.append('text').attr('x', m.l + 6).attr('y', y(N.ed.median) - 6).attr('font-size', 10.5).attr('font-weight', 600).attr('fill', C.text2).text(`National hospital median ${App.fmtMin(N.ed.median)}`);
    const cx = (d) => x(d.c) + x.bandwidth() / 2, lower = (i) => mode === 'stagger' && i % 2 === 1;
    // A short tick ties each label on the lower row to its column
    if (mode === 'stagger') {
      svg.selectAll('line.xt').data(data.filter((d, i) => lower(i))).join('line').attr('class', 'xt')
        .attr('x1', cx).attr('x2', cx).attr('y1', H - m.b + 3).attr('y2', H - m.b + 15).attr('stroke', C.grid);
    }
    const labels = svg.selectAll('text.xl').data(data).join('text').attr('class', 'xl').attr('font-size', 9.5)
      .attr('text-anchor', mode === 'upright' ? 'end' : 'middle').attr('dy', mode === 'upright' ? '0.32em' : null)
      .attr('transform', (d, i) => (mode === 'upright' ? `translate(${cx(d)},${H - m.b + 6}) rotate(-90)` : `translate(${cx(d)},${H - m.b + (lower(i) ? 26 : 12)})`))
      .text((d) => d.c);
    const focus = (f, ms) => {
      const fi = data.findIndex((d) => d.c === f);
      bars.transition('focus').duration(ms).ease(d3.easeCubicOut)
        .attr('fill-opacity', (d) => (fi >= 0 && d.c !== f ? 0.55 : 1)).attr('stroke-opacity', (d) => (d.c === f ? 1 : 0));
      labels.attr('fill', (d) => (d.c === f ? C.text : C.muted)).attr('font-weight', (d) => (d.c === f ? 700 : 400));
    };
    focus(App.state.focus, 0);
    const tip = (d) => `<div class="tt-title">${App.STATE_NAMES[d.c]}</div><div class="tt-sub">Median of ${App.f0(d.n)} hospitals · ${App.state.focus === d.c ? 'click to show all states' : 'click to focus'}</div>` +
      App.tipRows([['Median ER time', App.fmtMin(d.v)], ['vs national', `${d.v >= N.ed.median ? '+' : '−'}${Math.round(Math.abs(d.v - N.ed.median))} min`]]);
    svg.selectAll('rect.hit').data(data).join('rect').attr('class', 'hit').attr('x', (d) => x(d.c) - (x.step() - x.bandwidth()) / 2).attr('width', x.step())
      .attr('y', m.t).attr('height', H - m.t - m.b).attr('fill', 'transparent').style('cursor', 'pointer')
      .on('mousemove', (ev, d) => App.tip.show(tip(d), ev))
      .on('mouseleave', () => App.tip.hide())
      // The tooltip stays and switches its hint to what a second click would do
      .on('click', (ev, d) => { App.setFocus(App.state.focus === d.c ? '' : d.c); App.tip.show(tip(d), ev); });
    el.__ed = { key, focus: (f, ms) => focus(f, App.reduceMotion ? 0 : ms) };
  });

  // Fig 15 · Death and readmission rates by condition: national median with the 10th–90th percentile range of hospitals
  App.state.outcomeKind = App.state.outcomeKind || 'mort';
  App.register('outcomeRanges', function (anim) {
    const C = App.C, kind = App.state.outcomeKind;
    App.chips(document.getElementById('chips-outcome'), [{ value: 'mort', label: '30‑day death rate' }, { value: 'readm', label: '30‑day readmission rate' }], kind,
      (v) => { App.state.outcomeKind = v; App.renderOne('outcomeRanges', true); });
    const el = document.getElementById('fig-outcome');
    const rows = X.conditions.filter((c) => N[kind][c.key]).map((c) => ({ ...c, ...N[kind][c.key] }));
    const H = 44 + rows.length * 40, m = { t: 30, r: 54, b: 10, l: 128 };
    const [svg, w] = App.makeSvg(el, H, `Range chart: hospital ${kind === 'mort' ? 'death' : 'readmission'} rates by condition`);
    const x = d3.scaleLinear().domain([0, d3.max(rows, (d) => d.p90) * 1.1]).range([m.l, w - m.r]).nice();
    x.ticks(5).forEach((t) => {
      svg.append('line').attr('x1', x(t)).attr('x2', x(t)).attr('y1', m.t - 6).attr('y2', H - m.b).attr('stroke', C.grid);
      svg.append('text').attr('x', x(t)).attr('y', m.t - 12).attr('text-anchor', 'middle').attr('font-size', 10).attr('fill', C.muted).text(`${t}%`);
    });
    const dur = anim && !App.reduceMotion ? 650 : 0;
    const g = svg.selectAll('g.r').data(rows).join('g').attr('transform', (d, i) => `translate(0,${m.t + 14 + i * 40})`);
    g.append('text').attr('x', m.l - 12).attr('dy', '0.32em').attr('text-anchor', 'end').attr('font-size', 12).attr('fill', C.text2).text((d) => d.label);
    g.append('rect').attr('y', -5).attr('height', 10).attr('rx', 1).attr('fill', C.surface3)
      .attr('x', (d) => x(d.median)).attr('width', 0).transition().duration(dur).attr('x', (d) => x(d.p10)).attr('width', (d) => Math.max(2, x(d.p90) - x(d.p10)));
    g.append('circle').attr('r', 6).attr('cy', 0).attr('fill', C.text).attr('stroke', C.surface).attr('stroke-width', 2)
      .attr('cx', x(0)).transition().duration(dur).attr('cx', (d) => x(d.median));
    g.append('text').attr('x', w - m.r + 8).attr('dy', '0.32em').attr('font-size', 11.5).attr('font-weight', 600).attr('fill', C.text).attr('class', 'tnum').text((d) => `${App.f1(d.median)}%`);
    g.append('rect').attr('x', 0).attr('width', w).attr('y', -18).attr('height', 36).attr('fill', 'transparent')
      .on('mousemove', (ev, d) => App.tip.show(`<div class="tt-title">${d.label}</div><div class="tt-sub">${kind === 'mort' ? '30‑day death rate' : '30‑day unplanned readmission rate'} · ${App.f0(d.n)} hospitals</div>` +
        App.tipRows([['Median hospital', `${App.f1(d.median)}%`], ['10th–90th percentile', `${App.f1(d.p10)}% – ${App.f1(d.p90)}%`]]), ev))
      .on('mouseleave', () => App.tip.hide());
    const grp = kind === 'mort' ? N.mortN : N.readmN;
    document.getElementById('outcomeNote').innerHTML = `Bar = middle 80% of hospitals, dot = median. Of ${App.f0(grp.n)} hospitals CMS compares, <b class="bad-ink">${App.f0(grp.anyWorse)}</b> are worse than the national rate on at least one ${kind === 'mort' ? 'death' : 'readmission'} measure and <b class="good-ink">${App.f0(grp.anyBetter)}</b> are better on at least one. Period: ${App.xPeriod(X.meta.periods[kind])}.`;
  });

  // Fig 16 · Medicare penalties
  App.register('penalties', function (anim) {
    const C = App.C;
    const el = document.getElementById('fig-pen');
    const rows = [
      { k: 'hac', label: 'Hospital‑Acquired Condition program', sub: `FY${X.meta.periods.hacFy}: worst‑performing quarter on infections and PSI‑90 lose 1% of Medicare payments`, n: N.hacCut, of: N.hacN },
      { k: 'hrrp', label: 'Readmissions Reduction program', sub: 'More readmissions than expected (ratio above 1.0) for at least one condition, which triggers a payment reduction of up to 3%', n: N.hrrpAny.excess, of: N.hrrpAny.n },
    ];
    const H = 236, m = { t: 8, r: 12, b: 8, l: 12 };
    const [svg, w] = App.makeSvg(el, H, 'Bars: share of hospitals penalised under Medicare programs');
    const x = d3.scaleLinear().domain([0, 1]).range([m.l, w - m.r]);
    const dur = anim && !App.reduceMotion ? 800 : 0;
    const g = svg.selectAll('g.p').data(rows).join('g').attr('transform', (d, i) => `translate(0,${m.t + i * 116})`);
    g.append('text').attr('x', m.l).attr('y', 14).attr('font-size', 13).attr('font-weight', 600).attr('fill', C.text).text((d) => d.label);
    g.append('text').attr('x', w - m.r).attr('y', 14).attr('text-anchor', 'end').attr('font-size', 13).attr('font-weight', 700).attr('fill', C.bad).attr('class', 'tnum').text((d) => App.pct0(d.n / d.of));
    g.append('rect').attr('x', m.l).attr('y', 26).attr('width', x(1) - m.l).attr('height', 14).attr('rx', 1).attr('fill', C.surface2);
    g.append('rect').attr('x', m.l).attr('y', 26).attr('height', 14).attr('rx', 1).attr('fill', C.bad).attr('width', 0).transition().duration(dur).attr('width', (d) => x(d.n / d.of) - m.l);
    g.append('text').attr('x', m.l).attr('y', 60).attr('font-size', 11.5).attr('fill', C.text2).text((d) => `${App.f0(d.n)} of ${App.f0(d.of)} hospitals`);
    g.each(function (d) {
      const t = d3.select(this).append('text').attr('x', m.l).attr('y', 77).attr('font-size', 11).attr('fill', C.muted);
      // Wrap the explanation to the card width
      const words = d.sub.split(' '), maxW = w - m.l - m.r;
      let line = [], tspan = t.append('tspan').attr('x', m.l), lines = 0;
      words.forEach((wd) => {
        line.push(wd);
        tspan.text(line.join(' '));
        if (tspan.node().getComputedTextLength() > maxW && line.length > 1 && lines < 1) {
          line.pop(); tspan.text(line.join(' ')); line = [wd]; lines++;
          tspan = t.append('tspan').attr('x', m.l).attr('dy', 14).text(wd);
        }
      });
    });
  });
})();
