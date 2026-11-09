/* Time figures: trend, small_multiples, area_stack. */
(function () {
  "use strict";
  const F = window.Figures;
  const finite = Number.isFinite;

  function xScale(xs, range) {
    const numeric = typeof xs[0] === "number";
    return numeric ? d3.scaleLinear(d3.extent(xs), range) : d3.scalePoint(xs, range).padding(0.15);
  }
  function xTicks(x, xs, width) {
    const max = Math.max(2, Math.floor(width / 54));
    if (xs.length <= max) return xs;
    const step = Math.ceil(xs.length / max);
    return xs.filter((v, i) => i % step === 0 || i === xs.length - 1);
  }
  const xLabel = (v, n) => (n > 8 ? F.shortYear(v) : String(v));
  function bands(ctx, g, x, top, bottom) {
    (ctx.o.bands || []).forEach(b => {
      const x0 = x(typeof x.domain()[0] === "number" ? +b.from : b.from), x1 = x(typeof x.domain()[0] === "number" ? +b.to : b.to);
      if (!finite(x0) || !finite(x1)) return;
      g.append("rect").attr("x", Math.min(x0, x1)).attr("width", Math.max(2, Math.abs(x1 - x0))).attr("y", top).attr("height", bottom - top).attr("class", "fband");
      if (b.label) g.append("text").attr("class", "fband-label").attr("x", (x0 + x1) / 2).attr("y", bottom - 6).attr("text-anchor", "middle").text(b.label);
    });
  }

  // ---- Trend: lines over time, direct labels, peak callout, benchmark, bands, annotations -------
  F.register("trend", ctx => {
    const {o, C, W} = ctx, xv = ctx.v("x"), yv = ctx.n("y"), sv = ctx.has("series") ? ctx.v("series") : () => ctx.name("y");
    const lov = ctx.has("lower") ? ctx.n("lower") : () => NaN, upv = ctx.has("upper") ? ctx.n("upper") : () => NaN;
    const rows = ctx.rows.filter(r => finite(yv(r)) && xv(r) != null && xv(r) !== "");
    const xs = F.xDomain(rows, xv), numeric = typeof xs[0] === "number", xi = v => (numeric ? +v : v);
    let series = d3.groups(rows, sv).map(([name, rs]) => ({name: String(name), pts: rs.map(r => ({x: xi(xv(r)), y: yv(r), lo: lov(r), up: upv(r), r}))
      .sort((p, q) => xs.indexOf(p.x) - xs.indexOf(q.x))}));
    // Projections: points after forecast_from are dashed; lower/upper draw a shaded range.
    const fc = o.forecast_from != null && xs.some(v => String(v) === String(o.forecast_from)) ? xi(o.forecast_from) : null;
    const isProj = p => fc != null && xs.indexOf(p.x) > xs.indexOf(fc);
    const limit = o.limit || 8;
    if (series.length > limit) {
      const last = s => s.pts[s.pts.length - 1].y;
      series = [...series.filter(s => ctx.hi(s.name)), ...series.filter(s => !ctx.hi(s.name)).sort((p, q) => last(q) - last(p))].slice(0, limit);
      ctx.note(`Showing ${limit} of the series (highlighted first, then the highest latest values).`);
    }
    const ys = series.flatMap(s => s.pts.flatMap(p => [p.y, p.lo, p.up].filter(finite))), fmt = F.formatter(o, ys), bench = F.numOpt(o.benchmark);
    const single = series.length === 1;
    const endW = Math.min(Math.max(150, W * 0.24), d3.max(series, s => F.textWidth(`${s.name}  ${fmt(s.pts[s.pts.length - 1].y)}`, 12, 600)) + 14);
    const m = {t: (o.annotations || []).length ? 52 : 26, r: single ? 56 : endW + 8, b: 28, l: 46}, H = o.height || 340;
    const x = xScale(xs, [m.l, W - m.r]);
    let [lo, hi] = d3.extent([...ys, ...(bench != null ? [bench] : []), ...(o.zero ? [0] : [])]);
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.1;
    const y = d3.scaleLinear().domain([o.zero ? Math.min(0, lo) : lo - pad, hi + pad]).nice().range([H - m.b, m.t]);
    const svg = ctx.svg(H), g = svg.append("g");
    bands(ctx, g, x, m.t, H - m.b);
    if (fc != null) {
      g.append("rect").attr("class", "fband").attr("x", x(fc)).attr("y", m.t).attr("width", Math.max(0, W - m.r - x(fc))).attr("height", H - m.b - m.t);
      g.append("line").attr("class", "fbench").attr("x1", x(fc)).attr("x2", x(fc)).attr("y1", m.t).attr("y2", H - m.b);
      g.append("text").attr("class", "fband-label").attr("x", x(fc) + 8).attr("y", m.t + 12).text(o.forecast_label || "Projected →");
    }
    const gy = g.append("g").attr("transform", `translate(${m.l},0)`);
    F.gridY(gy.attr("transform", "translate(0,0)"), y, W - m.r, C, 5, o.format ? fmt : null);
    gy.selectAll("line.gy").attr("x1", m.l);
    gy.selectAll("text.gy").attr("x", m.l - 8);
    const tx = xTicks(x, xs, W - m.l - m.r);
    g.selectAll("text.xt").data(tx).join("text").attr("class", "ftick").attr("x", v => x(v)).attr("y", H - m.b + 18).attr("text-anchor", "middle").text(v => xLabel(v, xs.length));
    if (bench != null) {
      g.append("line").attr("class", "fbench").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(bench)).attr("y2", y(bench));
      g.append("text").attr("class", "fbench-label").attr("x", W - m.r).attr("y", y(bench) - 6).attr("text-anchor", "end").text(o.benchmark_label || `Benchmark ${fmt(bench)}`);
    }
    const toneOf = s => F.changeTone(o.better, s.pts[s.pts.length - 1].y - s.pts[0].y, s.pts[0].y);
    const colorOf = (s, i) => {
      if (ctx.anyHi && !ctx.hi(s.name)) return C.neutral;
      if (o.colors && o.colors[s.name]) return F.named(C, o.colors[s.name]);
      if (single) return toneOf(s) === "neutral" ? C.accent : F.toneColor(C, toneOf(s));
      return C.cat[i % C.cat.length];
    };
    // Ratings in whole steps (stars) are drawn as straight segments: a curve would suggest values in between
    const stepped = F.isStarScale(series.flatMap(s => s.pts.map(p => p.y)).filter(finite));
    const line = d3.line().x(p => x(p.x)).y(p => y(p.y)).curve(stepped ? d3.curveLinear : d3.curveMonotoneX);
    series.forEach((s, i) => {
      const col = colorOf(s, i), dim = ctx.anyHi && !ctx.hi(s.name);
      const rng = s.pts.filter(p => finite(p.lo) && finite(p.up));
      if (rng.length > 1) g.append("path").attr("d", d3.area().x(p => x(p.x)).y0(p => y(p.lo)).y1(p => y(p.up)).curve(d3.curveMonotoneX)(rng))
        .attr("fill", col).attr("fill-opacity", dim ? 0.06 : 0.16);
      if (o.area) g.append("path").attr("d", d3.area().x(p => x(p.x)).y0(H - m.b).y1(p => y(p.y)).curve(d3.curveMonotoneX)(s.pts)).attr("fill", col).attr("fill-opacity", 0.08);
      const actual = s.pts.filter(p => !isProj(p)), proj = s.pts.filter(isProj);
      const path = g.append("path").attr("d", line(actual)).attr("fill", "none").attr("stroke", col).attr("stroke-width", dim ? 1.5 : 2.6).attr("stroke-linecap", "round");
      if (ctx.anim && actual.length > 1) { const L = path.node().getTotalLength(); path.attr("stroke-dasharray", `${L} ${L}`).attr("stroke-dashoffset", L).transition().duration(1000).delay(i * 80).ease(d3.easeCubicOut).attr("stroke-dashoffset", 0); }
      if (proj.length) {
        const pp = g.append("path").attr("d", line([...actual.slice(-1), ...proj])).attr("fill", "none").attr("stroke", col).attr("stroke-width", dim ? 1.4 : 2.2).attr("stroke-dasharray", "6 5").attr("stroke-linecap", "round");
        if (ctx.anim) pp.attr("opacity", 0).transition().delay(900 + i * 80).duration(500).attr("opacity", 1);
      }
      if (single || s.pts.length <= 14) g.selectAll(null).data(s.pts).join("circle").attr("cx", p => x(p.x)).attr("cy", p => y(p.y)).attr("r", p => (dim ? 2 : isProj(p) ? 2.6 : 3.2))
        .attr("fill", C.surface).attr("stroke", col).attr("stroke-width", 1.8).attr("stroke-dasharray", p => (isProj(p) ? "2 2" : null));
    });
    // Peak callout for a single series (or o.peak = true).
    if ((single && o.peak !== false) || o.peak === true) {
      series.forEach((s, i) => {
        const p = (o.better === "higher" ? d3.least : d3.greatest)(s.pts.filter(q => !isProj(q)), q => q.y);
        if (!p || p === s.pts[s.pts.length - 1]) return;
        if ((o.annotations || []).some(a => String(a.x) === String(p.x) && (a.series == null || String(a.series) === s.name))) return;
        g.append("text").attr("class", "fpeak").attr("x", x(p.x)).attr("y", y(p.y) - 10).attr("text-anchor", "middle").text(`${o.better === "higher" ? "low" : "peak"} ${fmt(p.y)}`);
      });
    }
    // End labels.
    const ends = F.dodge(series.map((s, i) => ({s, i, y: y(s.pts[s.pts.length - 1].y)})), 15, m.t, H - m.b);
    ends.forEach(({s, i, y: yy}) => {
      const last = s.pts[s.pts.length - 1], col = colorOf(s, i);
      g.append("text").attr("class", "fend").attr("x", x(last.x) + 8).attr("y", yy).attr("dy", "0.32em").attr("fill", col)
        .text(single ? fmt(last.y) : `${F.truncate(s.name, endW - F.textWidth(`  ${fmt(last.y)}`, 12, 600) - 10, 12, 600)}  ${fmt(last.y)}`);
    });
    // Annotations: [{x, text, series?}]
    (o.annotations || []).forEach(a => {
      const s = series.find(q => a.series == null || String(q.name) === String(a.series)) || series[0];
      const p = s && s.pts.find(q => String(q.x) === String(a.x));
      if (!p) return;
      const ax = x(p.x), ay = y(p.y), up = ay - 40 > 6;
      g.append("line").attr("x1", ax).attr("x2", ax).attr("y1", ay + (up ? -6 : 6)).attr("y2", ay + (up ? -30 : 30)).attr("class", "fannot-line");
      g.append("circle").attr("cx", ax).attr("cy", ay).attr("r", 5).attr("fill", "none").attr("stroke", C.text).attr("stroke-width", 1.5);
      g.append("text").attr("class", "fannot").attr("x", ax).attr("y", ay + (up ? -36 : 44)).attr("text-anchor", ax > W * 0.75 ? "end" : ax < W * 0.25 ? "start" : "middle").text(a.text);
    });
    // Crosshair hover + click to drill.
    const rule = g.append("line").attr("class", "frule").attr("y1", m.t).attr("y2", H - m.b).style("opacity", 0);
    const dots = g.append("g");
    const nearestX = mx => (numeric ? xs.reduce((b, v) => (Math.abs(x(v) - mx) < Math.abs(x(b) - mx) ? v : b), xs[0]) : xs.reduce((b, v) => (Math.abs(x(v) - mx) < Math.abs(x(b) - mx) ? v : b), xs[0]));
    svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", W - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent").style("cursor", "crosshair")
      .on("mousemove", ev => {
        const [mx] = d3.pointer(ev), xv0 = nearestX(mx), at = series.map((s, i) => ({s, i, p: s.pts.find(p => p.x === xv0)})).filter(d => d.p);
        rule.attr("x1", x(xv0)).attr("x2", x(xv0)).style("opacity", 1);
        dots.selectAll("circle").data(at).join("circle").attr("cx", x(xv0)).attr("cy", d => y(d.p.y)).attr("r", 4.5).attr("fill", d => colorOf(d.s, d.i)).attr("stroke", C.surface).attr("stroke-width", 2);
        const val = p => `${fmt(p.y)}${finite(p.lo) && finite(p.up) ? ` (${fmt(p.lo)}–${fmt(p.up)})` : ""}`;
        ctx.tip.show(F.tipHtml(`${xv0}${at.some(d => isProj(d.p)) ? " · projected" : ""}`, at.sort((p, q) => q.p.y - p.p.y).map(d => [d.s.name, val(d.p)])), ev);
      })
      .on("mouseleave", () => { rule.style("opacity", 0); dots.selectAll("*").remove(); ctx.tip.hide(); })
      .on("click", ev => {
        const [mx, my] = d3.pointer(ev), xv0 = nearestX(mx);
        const best = d3.least(series.map(s => s.pts.find(p => p.x === xv0)).filter(Boolean), p => Math.abs(y(p.y) - my));
        if (best) ctx.pick(best.r);
      });
    if (!single && series.length > 1 && !ctx.anyHi && series.length <= 9) ctx.legend(F.chips(series.map((s, i) => ({label: s.name, color: colorOf(s, i), shape: "line"}))));
  });

  // ---- Small multiples: one panel per facet with headline value, change, synced crosshair -----
  F.register("small_multiples", ctx => {
    const {o, C, W} = ctx, fv = ctx.v("facet"), xv = ctx.v("x"), yv = ctx.n("y");
    const rows = ctx.rows.filter(r => finite(yv(r)) && xv(r) != null && xv(r) !== "");
    const xs = F.xDomain(rows, xv), numeric = typeof xs[0] === "number", xi = v => (numeric ? +v : v);
    let panels = d3.groups(rows, fv).map(([name, rs]) => ({name: String(name), pts: rs.map(r => ({x: xi(xv(r)), y: yv(r), r})).sort((p, q) => xs.indexOf(p.x) - xs.indexOf(q.x))}));
    if (o.order) panels.sort((p, q) => o.order.indexOf(p.name) - o.order.indexOf(q.name));
    panels = panels.slice(0, o.limit || 24);
    const ys = panels.flatMap(p => p.pts.map(q => q.y)), fmt = F.formatter(o, ys), bench = F.numOpt(o.benchmark), better = o.better;
    const cols = Math.max(1, Math.min(panels.length, o.columns || Math.floor(W / 250), 4)), gap = 12;
    const pw = (W - gap * (cols - 1)) / cols, ph = o.height || 200;
    const rowsN = Math.ceil(panels.length / cols), H = rowsN * ph + (rowsN - 1) * gap, svg = ctx.svg(H);
    const shared = o.shared_y !== false;
    const domainOf = vals => { const [a, b] = d3.extent([...vals, ...(bench != null ? [bench] : [])]); const pad = (b - a || Math.abs(b) || 1) * 0.12; return [o.zero ? Math.min(0, a) : a - pad, b + pad]; };
    const sharedDom = domainOf(ys);
    const m = {t: 62, r: 14, b: 24, l: 34};
    const inner = [];
    panels.forEach((p, i) => {
      const px = (i % cols) * (pw + gap), py = Math.floor(i / cols) * (ph + gap);
      const g = svg.append("g").attr("transform", `translate(${px},${py})`);
      const dim = ctx.anyHi && !ctx.hi(p.name);
      g.append("rect").attr("class", "fpanel" + (ctx.hi(p.name) ? " hi" : "")).attr("width", pw).attr("height", ph).attr("rx", 12);
      const first = p.pts[0], last = p.pts[p.pts.length - 1], delta = last.y - first.y, tone = F.changeTone(better, delta, first.y);
      const col = dim ? C.neutral : tone === "neutral" ? C.accent : F.toneColor(C, tone);
      g.append("text").attr("class", "fp-title").attr("x", 14).attr("y", 22).text(F.truncate(p.name, pw * 0.6, 13, 600));
      g.append("text").attr("class", "fp-value").attr("x", pw - 14).attr("y", 25).attr("text-anchor", "end").attr("fill", col).text(fmt(last.y));
      if (p.pts.length > 1) g.append("text").attr("class", "fp-delta " + tone).attr("x", pw - 14).attr("y", 41).attr("text-anchor", "end")
        .text(`${first.y ? F.signedPct(delta / Math.abs(first.y)) : F.signed(fmt, delta)} vs ${F.shortYear(first.x)}`);
      const x = xScale(xs, [m.l, pw - m.r]), y = d3.scaleLinear().domain(shared ? sharedDom : domainOf(p.pts.map(q => q.y))).nice(4).range([ph - m.b, m.t]);
      bands(ctx, g, x, m.t, ph - m.b);
      const yt = y.ticks(3), tfy = o.format ? F.tickFmt(fmt, yt) : y.tickFormat(3);
      yt.forEach(t => {
        g.append("line").attr("x1", m.l).attr("x2", pw - m.r).attr("y1", y(t)).attr("y2", y(t)).attr("stroke", C.grid);
        g.append("text").attr("class", "ftick").attr("x", m.l - 6).attr("y", y(t)).attr("dy", "0.32em").attr("text-anchor", "end").text(tfy(t));
      });
      xTicks(x, xs, pw - m.l - m.r).forEach(v => g.append("text").attr("class", "ftick").attr("x", x(v)).attr("y", ph - 7).attr("text-anchor", "middle").text(F.shortYear(v)));
      if (bench != null) g.append("line").attr("class", "fbench").attr("x1", m.l).attr("x2", pw - m.r).attr("y1", y(bench)).attr("y2", y(bench));
      const path = g.append("path").attr("d", d3.line().x(q => x(q.x)).y(q => y(q.y)).curve(d3.curveMonotoneX)(p.pts)).attr("fill", "none").attr("stroke", col).attr("stroke-width", 2.2);
      if (ctx.anim) { const L = path.node().getTotalLength(); path.attr("stroke-dasharray", `${L} ${L}`).attr("stroke-dashoffset", L).transition().duration(900).delay(i * 70).attr("stroke-dashoffset", 0); }
      g.selectAll(null).data(p.pts).join("circle").attr("cx", q => x(q.x)).attr("cy", q => y(q.y)).attr("r", 2.6).attr("fill", C.surface).attr("stroke", col).attr("stroke-width", 1.5);
      const pk = (better === "higher" ? d3.least : d3.greatest)(p.pts, q => q.y);
      const pki = p.pts.indexOf(pk);
      if (o.peak !== false && pk && pki > 0 && pki < p.pts.length - 2 && p.pts.length > 3) g.append("text").attr("class", "fpeak").attr("x", x(pk.x)).attr("y", y(pk.y) - 8).attr("text-anchor", "middle").text(`${better === "higher" ? "low" : "peak"} ${fmt(pk.y)}`);
      const hover = g.append("g").style("pointer-events", "none");
      inner.push({p, x, y, hover, col});
      g.append("rect").attr("x", m.l).attr("y", m.t).attr("width", pw - m.l - m.r).attr("height", ph - m.t - m.b).attr("fill", "transparent").style("cursor", "crosshair")
        .on("mousemove", ev => { const [mx] = d3.pointer(ev); const v = xs.reduce((b, q) => (Math.abs(x(q) - mx) < Math.abs(x(b) - mx) ? q : b), xs[0]); syncAt(v, ev, p.name); })
        .on("mouseleave", () => { inner.forEach(it => it.hover.selectAll("*").remove()); ctx.tip.hide(); })
        .on("click", ev => { const [mx] = d3.pointer(ev); const v = xs.reduce((b, q) => (Math.abs(x(q) - mx) < Math.abs(x(b) - mx) ? q : b), xs[0]); const q = p.pts.find(z => z.x === v); if (q) ctx.pick(q.r); });
    });
    function syncAt(v, ev, name) {
      inner.forEach(({p, x, y, hover, col}) => {
        hover.selectAll("*").remove();
        const q = p.pts.find(z => z.x === v);
        hover.append("line").attr("class", "frule").attr("x1", x(v)).attr("x2", x(v)).attr("y1", m.t).attr("y2", ph - m.b);
        if (!q) return;
        hover.append("circle").attr("cx", x(q.x)).attr("cy", y(q.y)).attr("r", 4.2).attr("fill", col).attr("stroke", C.surface).attr("stroke-width", 2);
        hover.append("text").attr("class", "fsync").attr("x", x(q.x)).attr("y", y(q.y) - 9).attr("text-anchor", "middle").text(fmt(q.y));
      });
      const here = panels.find(p => p.name === name).pts.find(z => z.x === v);
      ctx.tip.show(F.tipHtml(`${name} · ${v}`, [[ctx.name("y"), here ? fmt(here.y) : "—"]], "Hover moves the marker in every panel"), ev);
    }
    if (bench != null) ctx.legend(F.chips([{label: o.benchmark_label || `Benchmark ${fmt(bench)}`, color: C.muted, shape: "dash"},
      ...(better ? [{label: `Improved vs ${F.shortYear(xs[0])}`, color: C.good, shape: "line"}, {label: `Worse vs ${F.shortYear(xs[0])}`, color: C.bad, shape: "line"}] : [])]));
  });

  // ---- Stacked area: composition over time, absolute or 100% ----------------------------------
  F.register("area_stack", ctx => {
    const {o, C, W} = ctx, xv = ctx.v("x"), yv = ctx.n("y"), sv = ctx.v("series");
    const rows = ctx.rows.filter(r => finite(yv(r)));
    const xs = F.xDomain(rows, xv), numeric = typeof xs[0] === "number", keys = o.order || [...new Set(rows.map(r => String(sv(r))))].sort(F.natural);
    const ordinal = o.palette === "ordinal" || (o.palette == null && keys.every(k => /^\s*\d/.test(k)));
    const ordCols = d3.quantize(d3.interpolateRgbBasis(o.better === "lower" ? [C.good, C.neutralMid, C.bad] : o.better === "higher" ? [C.bad, C.neutralMid, C.good] : [C.neutralMid, C.muted, C.text2]), Math.max(2, keys.length));
    const table = xs.map(xx => { const o2 = {x: xx}; keys.forEach(k => (o2[k] = 0)); rows.filter(r => String(numeric ? +xv(r) : xv(r)) === String(xx)).forEach(r => (o2[String(sv(r))] += yv(r))); return o2; });
    const stack = d3.stack().keys(keys).offset(o.normalize ? d3.stackOffsetExpand : d3.stackOffsetNone)(table);
    const fmt = o.normalize ? F.pct : F.formatter(o, rows.map(yv));
    const H = o.height || 320, m = {t: 16, r: 120, b: 28, l: 46};
    const x = xScale(xs, [m.l, W - m.r]), y = d3.scaleLinear().domain([0, d3.max(stack, s => d3.max(s, d => d[1])) || 1]).nice().range([H - m.b, m.t]);
    const svg = ctx.svg(H), g = svg.append("g");
    F.gridY(g, y, W - m.r, C, 5, o.normalize ? F.pct : o.format ? fmt : null);
    g.selectAll("line.gy").attr("x1", m.l); g.selectAll("text.gy").attr("x", m.l - 8);
    xTicks(x, xs, W - m.l - m.r).forEach(v => g.append("text").attr("class", "ftick").attr("x", x(v)).attr("y", H - m.b + 18).attr("text-anchor", "middle").text(xLabel(v, xs.length)));
    const color = k => (ctx.anyHi && !ctx.hi(k) ? C.neutral : (o.colors && o.colors[k] && F.named(C, o.colors[k])) || (ordinal ? ordCols[keys.indexOf(k)] : C.cat[keys.indexOf(k) % C.cat.length]));
    const area = d3.area().x(d => x(d.data.x)).y0(d => y(d[0])).y1(d => y(d[1])).curve(d3.curveMonotoneX);
    const layers = g.selectAll("path.layer").data(stack).join("path").attr("class", "layer").attr("d", area).attr("fill", s => color(s.key)).attr("opacity", 0.88).attr("stroke", C.surface).attr("stroke-width", 1);
    if (ctx.anim) layers.attr("opacity", 0).transition().duration(600).delay((s, i) => i * 90).attr("opacity", 0.88);
    stack.forEach(s => {
      const d = s[s.length - 1];
      if (y(d[0]) - y(d[1]) >= 13) g.append("text").attr("class", "fend").attr("x", W - m.r + 8).attr("y", (y(d[0]) + y(d[1])) / 2).attr("dy", "0.32em").attr("fill", color(s.key)).text(F.truncate(s.key, m.r - 12, 12, 600));
    });
    if (stack.some(s => { const d = s[s.length - 1]; return y(d[0]) - y(d[1]) < 13; })) ctx.legend(F.chips(keys.map(k => ({label: k, color: color(k)}))));
    const rule = g.append("line").attr("class", "frule").attr("y1", m.t).attr("y2", H - m.b).style("opacity", 0);
    svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", W - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
      .on("mousemove", ev => {
        const [mx] = d3.pointer(ev), v = xs.reduce((b, q) => (Math.abs(x(q) - mx) < Math.abs(x(b) - mx) ? q : b), xs[0]), rowAt = table.find(t => t.x === v), tot = d3.sum(keys, k => rowAt[k]);
        rule.attr("x1", x(v)).attr("x2", x(v)).style("opacity", 1);
        ctx.tip.show(F.tipHtml(String(v), [...keys].reverse().map(k => [k, o.normalize ? F.pct(rowAt[k] / (tot || 1)) : `${fmt(rowAt[k])} (${F.pct(rowAt[k] / (tot || 1))})`]).concat([["Total", o.normalize ? "100%" : fmt(tot)]])), ev);
      })
      .on("mouseleave", () => { rule.style("opacity", 0); ctx.tip.hide(); })
      .on("click", ev => {
        const [mx, my] = d3.pointer(ev), v = xs.reduce((b, q) => (Math.abs(x(q) - mx) < Math.abs(x(b) - mx) ? q : b), xs[0]), i = xs.indexOf(v);
        const s = stack.find(s2 => y(s2[i][1]) <= my && my <= y(s2[i][0])), row = s && rows.find(r => String(sv(r)) === s.key && String(numeric ? +xv(r) : xv(r)) === String(v));
        if (row) ctx.pick(row);
      });
  });
})();
