/* Distribution & relationship figures: heatmap, scatter, funnel, distribution, stacked_bars, treemap. */
(function () {
  "use strict";
  const F = window.Figures;
  const finite = Number.isFinite;

  // Nearest-point hover/click over a set of [x, y, datum] points.
  const nearest = F.nearest;

  // ---- Heatmap: row x column matrix, semantic colour, values in cells --------------------------
  F.register("heatmap", ctx => {
    const {o, C, W} = ctx, rv = r => String(ctx.v("row")(r)), cv = ctx.v("col"), val = ctx.n("value");
    const rows = ctx.rows.filter(r => finite(val(r)));
    let colsK = o.col_order || F.xDomain(rows, cv);
    const numericCols = typeof colsK[0] === "number";
    const ck = v => (numericCols ? +v : v);
    const cell = new Map(rows.map(r => [`${rv(r)}|${ck(cv(r))}`, r]));
    let rowsK = [...new Set(rows.map(rv))];
    const mean = k => d3.mean(colsK, c => { const r = cell.get(`${k}|${c}`); return r ? val(r) : undefined; });
    const lastV = k => { for (let i = colsK.length - 1; i >= 0; i--) { const r = cell.get(`${k}|${colsK[i]}`); if (r) return val(r); } return NaN; };
    // Change mode: the baseline column shows values, every other column the change from it.
    const base = o.change_from != null ? colsK.find(c => String(c) === String(o.change_from)) : undefined, change = base !== undefined;
    if (change) colsK = [base, ...colsK.filter(c => c !== base)];
    const baseVal = k => { const r = cell.get(`${k}|${base}`); return r ? val(r) : NaN; };
    const shown = d => (!d.r ? NaN : change && d.c !== base ? val(d.r) - baseVal(d.k) : val(d.r));
    const how = o.sort_rows || (change ? "base" : "value");
    if (how === "base") rowsK.sort((a, b) => baseVal(b) - baseVal(a));
    else if (how === "value") rowsK.sort((a, b) => mean(b) - mean(a));
    else if (how === "last") rowsK.sort((a, b) => lastV(b) - lastV(a));
    else if (how === "name") rowsK.sort(d3.ascending);
    rowsK = rowsK.slice(0, o.limit || 60);
    const vals = rows.map(val), fmt = F.formatter(o, vals);
    const deltas = change ? rows.filter(r => String(ck(cv(r))) !== String(base)).map(r => val(r) - baseVal(rv(r))).filter(finite) : [];
    const dctx = {...ctx, o: {...o, benchmark: 0, benchmark_label: o.change_label || "No change"}};
    const sem = change ? F.semantic(dctx, deltas) : F.semantic(ctx, vals), dfmt = change ? F.formatter({format: o.change_format || o.format}, deltas.map(Math.abs)) : fmt;
    const labelW = Math.min(W * 0.28, d3.max(rowsK, k => F.textWidth(k, 12, 500)) + 14);
    // Few columns get wider cells; column names wrap onto up to three lines instead of being cut short
    const cw = Math.min(colsK.length <= 3 ? 240 : colsK.length <= 10 ? 140 : 84, (W - labelW - 6) / colsK.length), ch = rowsK.length > 40 ? 16 : cw >= 40 ? 26 : 20;
    const heads = colsK.map(c => F.wrap(change && c === base ? `${c} base` : colsK.length > 8 ? F.shortYear(c) : c, cw - 6, 11, 400, 3));
    const headLines = d3.max(heads, h => h.length) || 1;
    const top = 14 + headLines * 13, legendY = top + rowsK.length * ch + (change ? 30 : 16), H = legendY + 28, svg = ctx.svg(H);
    const showText = cw >= 36 && ch >= 18;
    colsK.forEach((c, j) => {
      const t = svg.append("text").attr("class", "ftick" + ((change && c === base) || ctx.hi(c) ? " strong" : "")).attr("x", labelW + j * cw + cw / 2).attr("text-anchor", "middle");
      heads[j].forEach((line, k) => t.append("tspan").attr("x", labelW + j * cw + cw / 2).attr("y", top - 9 - (heads[j].length - 1 - k) * 13).text(line));
    });
    const hid = "fh" + Math.random().toString(36).slice(2, 8), pat = svg.append("defs").append("pattern").attr("id", hid).attr("patternUnits", "userSpaceOnUse").attr("width", 6).attr("height", 6).attr("patternTransform", "rotate(45)");
    pat.append("rect").attr("width", 6).attr("height", 6).attr("fill", C.surface2);
    pat.append("line").attr("x1", 0).attr("x2", 0).attr("y1", 0).attr("y2", 6).attr("stroke", C.border).attr("stroke-width", 2);
    rowsK.forEach((k, i) => svg.append("text").attr("class", "flabel sm" + (ctx.hi(k) ? " strong" : "")).attr("x", labelW - 8).attr("y", top + i * ch + ch / 2).attr("dy", "0.32em").attr("text-anchor", "end").text(F.truncate(k, labelW - 12, 12, 500)));
    const data = rowsK.flatMap((k, i) => colsK.map((c, j) => ({k, c, i, j, r: cell.get(`${k}|${c}`)})));
    const g = svg.append("g").selectAll("g").data(data).join("g").attr("transform", d => `translate(${labelW + d.j * cw},${top + d.i * ch})`).style("cursor", d => (d.r ? "pointer" : "default"));
    const isBase = d => change && d.c === base;
    const fill = d => (!d.r || !finite(shown(d)) ? `url(#${hid})` : isBase(d) ? C.surface3 : sem.scale(shown(d)));
    // Every cell keeps the colour of its value; a highlighted row or column is outlined in ink, its label bold
    const dimmed = () => false;
    const lit = d => ctx.anyHi && (ctx.hi(d.k) || ctx.hi(d.c));
    const rect = g.append("rect").attr("width", cw - 2).attr("height", ch - 2).attr("rx", 3).attr("fill", fill)
      .attr("stroke", d => (lit(d) ? C.text : "none")).attr("stroke-width", 1.4);
    if (ctx.anim) rect.attr("opacity", 0).transition().duration(400).delay(d => d.i * 12 + d.j * 20).attr("opacity", 1);
    if (showText) g.append("text").attr("x", (cw - 2) / 2).attr("y", (ch - 2) / 2).attr("dy", "0.32em").attr("text-anchor", "middle")
      .attr("class", d => "fcell" + (isBase(d) ? " base" : "") + (!d.r || !finite(shown(d)) ? " na" : "")).attr("fill", d => (!d.r || !finite(shown(d)) ? C.faint : isBase(d) ? C.text : F.inkOn(dimmed(d) ? d3.interpolateRgb(C.surface, fill(d))(0.35) : fill(d))))
      .text(d => (!d.r || !finite(shown(d)) ? "n/a" : isBase(d) || !change ? fmt(shown(d)) : F.signed(dfmt, shown(d))));
    const toneOf = d => (d.r && finite(shown(d)) && sem.better && !isBase(d) ? sem.tone(shown(d)) : "");
    g.on("mousemove", (ev, d) => ctx.tip.show(F.tipHtml(d.k, [[String(d.c), d.r ? fmt(val(d.r)) : "—", change ? "" : toneOf(d)],
      change && !isBase(d) && d.r && [`vs ${base}`, finite(shown(d)) ? F.signed(dfmt, shown(d)) : "—", toneOf(d)],
      !change && d.r && sem.better && [o.benchmark_label || "vs benchmark", F.signed(fmt, val(d.r) - sem.center), toneOf(d)]]), ev))
      .on("mouseleave", () => ctx.tip.hide()).on("click", (ev, d) => d.r && ctx.pick(d.r));
    F.gradientLegend(change ? dctx : ctx, svg.append("g").attr("transform", `translate(${labelW},${legendY})`), sem, Math.min(260, W - labelW - 10), change ? v => F.signed(dfmt, v) : fmt,
      change ? `Change from ${base}` : undefined);
  });

  // ---- Scatter: relationship, quadrants, trend line, labelled outliers -------------------------
  F.register("scatter", ctx => {
    const {o, C, W} = ctx, xv = ctx.n("x"), yv = ctx.n("y"), lv = ctx.has("label") ? ctx.v("label") : null;
    const sz = ctx.has("size") ? ctx.n("size") : null, cv = ctx.has("color") ? ctx.v("color") : null;
    const rows = ctx.rows.filter(r => finite(xv(r)) && finite(yv(r)) && (!o.x_log || xv(r) > 0) && (!o.y_log || yv(r) > 0));
    const fx = F.formatter({format: o.x_format, unit: o.x_unit}, rows.map(xv)), fy = F.formatter(o, rows.map(yv));
    const H = o.height || Math.min(480, Math.max(320, W * 0.55)), m = {t: 18, r: 18, b: 44, l: 54};
    const xr0 = F.numOpt(o.x_ref);  // reference lines stay on the plot, so the quadrants they define are true
    const xs = (o.x_log ? d3.scaleLog() : d3.scaleLinear()).domain(d3.extent([...rows.map(xv), ...(xr0 != null ? [xr0] : [])])).nice().range([m.l, W - m.r]);
    const ys = (o.y_log ? d3.scaleLog() : d3.scaleLinear()).domain(d3.extent([...rows.map(yv), ...(F.numOpt(o.y_ref ?? o.benchmark) != null ? [+(o.y_ref ?? o.benchmark)] : [])])).nice().range([H - m.b, m.t]);
    const svg = ctx.svg(H), g = svg.append("g");
    const yt = F.uniqueTicks(ys.ticks(5), o.format ? fy : null), xt = F.uniqueTicks(xs.ticks(6), o.x_format ? fx : null), tfy = o.format ? F.tickFmt(fy, yt) : ys.tickFormat(5), tfx = o.x_format ? F.tickFmt(fx, xt) : o.x_log ? F.logTick : xs.tickFormat(6);
    yt.forEach(t => { g.append("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", ys(t)).attr("y2", ys(t)).attr("stroke", C.grid); g.append("text").attr("class", "ftick").attr("x", m.l - 8).attr("y", ys(t)).attr("dy", "0.32em").attr("text-anchor", "end").text(tfy(t)); });
    xt.forEach(t => { g.append("line").attr("y1", m.t).attr("y2", H - m.b).attr("x1", xs(t)).attr("x2", xs(t)).attr("stroke", C.grid); g.append("text").attr("class", "ftick").attr("y", H - m.b + 16).attr("x", xs(t)).attr("text-anchor", "middle").text(tfx(t)); });
    g.append("text").attr("class", "faxis-title").attr("x", (m.l + W - m.r) / 2).attr("y", H - 6).attr("text-anchor", "middle").text(ctx.name("x"));
    g.append("text").attr("class", "faxis-title").attr("transform", `translate(14,${(m.t + H - m.b) / 2}) rotate(-90)`).attr("text-anchor", "middle").text(ctx.name("y"));
    const xr = F.numOpt(o.x_ref), yr = F.numOpt(o.y_ref ?? o.benchmark);
    if (xr != null) g.append("line").attr("class", "fbench").attr("x1", xs(xr)).attr("x2", xs(xr)).attr("y1", m.t).attr("y2", H - m.b);
    if (yr != null) g.append("line").attr("class", "fbench").attr("x1", m.l).attr("x2", W - m.r).attr("y1", ys(yr)).attr("y2", ys(yr));
    if (o.diagonal) {
      const [a0, a1] = xs.domain(), [b0, b1] = ys.domain(), lo = Math.max(a0, b0), hi = Math.min(a1, b1);
      if (hi > lo) {
        g.append("line").attr("class", "fbench").attr("x1", xs(lo)).attr("y1", ys(lo)).attr("x2", xs(hi)).attr("y2", ys(hi));
        g.append("text").attr("class", "fbench-label").attr("x", xs(hi) - 6).attr("y", ys(hi) + 14).attr("text-anchor", "end").text(o.diagonal_label || `${ctx.name("y")} = ${ctx.name("x")}`);
      }
    }
    if (o.quadrants && xr != null && yr != null) {
      const q = o.quadrants, pos = {tl: [m.l + 8, m.t + 14, "start"], tr: [W - m.r - 8, m.t + 14, "end"], bl: [m.l + 8, H - m.b - 8, "start"], br: [W - m.r - 8, H - m.b - 8, "end"]};
      Object.entries(pos).forEach(([k, [x, y, a]]) => q[k] && g.append("text").attr("class", "fquad").attr("x", x).attr("y", y).attr("text-anchor", a).text(q[k]));
    }
    // colour
    let color = () => (ctx.anyHi ? C.text : C.accent), legend = null;  // highlighted points in full ink
    if (cv) {
      const numeric = rows.every(r => cv(r) == null || finite(+cv(r)));
      if (numeric) { const sem = F.semantic(ctx, rows.map(r => +cv(r))); color = r => sem.scale(+cv(r)); }
      else { const cats = [...new Set(rows.map(r => String(cv(r))))]; color = r => C.cat[cats.indexOf(String(cv(r))) % C.cat.length]; legend = cats.slice(0, 9).map((c, i) => ({label: c, color: C.cat[i % C.cat.length]})); }
    } else if (o.diagonal && (o.better === "lower" || o.better === "higher")) {
      color = r => F.toneColor(C, F.changeTone(o.better, yv(r) - xv(r), xv(r)));
      const n = d3.rollup(rows, v => v.length, r => F.changeTone(o.better, yv(r) - xv(r), xv(r)));
      legend = [{label: `Improved (${n.get("good") || 0})`, color: C.good}, {label: `Worsened (${n.get("bad") || 0})`, color: C.bad}];
    } else if (o.better && yr != null) { const sem = F.semantic({...ctx, o: {...o, benchmark: yr}}, rows.map(yv)); color = r => F.toneColor(C, sem.tone(yv(r))); }
    if (legend) ctx.legend(F.chips(legend));
    const rs = sz ? d3.scaleSqrt(d3.extent(rows, sz), [3, 16]) : () => (rows.length > 1500 ? 2.6 : 4.2);
    const dimmed = r => ctx.anyHi && !(lv && ctx.hi(lv(r)));
    if (o.trend) {
      const tx = r => (o.x_log ? Math.log(xv(r)) : xv(r)), n = rows.length, mx = d3.mean(rows, tx), my = d3.mean(rows, yv);
      const b = d3.sum(rows, r => (tx(r) - mx) * (yv(r) - my)) / (d3.sum(rows, r => (tx(r) - mx) ** 2) || 1), a = my - b * mx;
      const [x0, x1] = xs.domain(), f = x => a + b * (o.x_log ? Math.log(x) : x), pts = d3.range(0, 1.0001, 0.05).map(t => (o.x_log ? x0 * Math.pow(x1 / x0, t) : x0 + t * (x1 - x0)));
      g.append("path").attr("d", d3.line().x(xs).y(x => ys(f(x)))(pts)).attr("class", "ftrend");
      const r2 = (() => { const ssr = d3.sum(rows, r => (yv(r) - f(xv(r))) ** 2), sst = d3.sum(rows, r => (yv(r) - my) ** 2); return sst ? 1 - ssr / sst : 0; })();
      ctx.note(`Trend line: least squares${o.x_log ? " on log x" : ""}, R² = ${r2.toFixed(2)} (n = ${n}).`);
    }
    const ordered = [...rows].sort((p, q) => (dimmed(q) - dimmed(p)) || (sz ? sz(q) - sz(p) : 0));
    const dots = g.selectAll("circle.pt").data(ordered).join("circle").attr("class", "pt").attr("cx", r => xs(xv(r))).attr("cy", r => ys(yv(r)))
      .attr("fill", r => (dimmed(r) ? C.neutral : color(r))).attr("fill-opacity", r => (dimmed(r) ? 0.6 : 0.85)).attr("stroke", C.surface).attr("stroke-width", 0.8).attr("r", 0);
    ctx.transition(dots, 0, 500).delay((r, i) => (ctx.anim ? Math.min(600, i * 2) : 0)).attr("r", r => (sz ? rs(sz(r)) : rs()));
    if (lv) {
      const cx = d3.median(rows, r => xs(xv(r))), cy = d3.median(rows, r => ys(yv(r)));
      const n = o.label_top ?? 6;
      const pick = ctx.anyHi ? rows.filter(r => ctx.hi(lv(r))) : [...rows].sort((p, q) => Math.hypot(xs(xv(q)) - cx, ys(yv(q)) - cy) - Math.hypot(xs(xv(p)) - cx, ys(yv(p)) - cy)).slice(0, n);
      const skipped = F.placeLabels(g, pick.map(r => ({x: xs(xv(r)), y: ys(yv(r)), text: F.truncate(lv(r), 160, 11, 600)})), [m.l, m.t + 16, W - m.r, H - m.b]);
      if (ctx.anyHi && skipped.length) ctx.note(`Also highlighted: ${skipped.slice(0, 6).map(s => s.text).join(", ")}${skipped.length > 6 ? ` and ${skipped.length - 6} more` : ""}.`);
    }
    nearest(ctx, svg, rows.map(r => [xs(xv(r)), ys(yv(r)), r]), [m.l, m.t, W - m.l - m.r, H - m.t - m.b],
      r => F.tipHtml(lv ? lv(r) : "Point", [[ctx.name("x"), fx(xv(r))], [ctx.name("y"), fy(yv(r))], sz && [ctx.name("size"), F.formatter({}, [sz(r)])(sz(r))], cv && [ctx.name("color"), String(cv(r))]]),
      r => ctx.pick(r));
  });

  // ---- Funnel plot: ratio vs expected volume with Poisson control limits (SIR, SMR, O/E ratios) --
  function poissonQ(p, lambda) {
    if (lambda > 400) return Math.max(0, Math.round(lambda + jstatNorm(p) * Math.sqrt(lambda)));
    let k = 0, pk = Math.exp(-lambda), cum = pk;
    while (cum < p && k < 10000) { k += 1; pk *= lambda / k; cum += pk; }
    return k;
  }
  function jstatNorm(p) { // inverse normal CDF (Acklam)
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const q = Math.min(p, 1 - p);
    let x;
    if (q > 0.02425) { const r = p - 0.5, s = r * r; return (((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r / (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1); }
    const r = Math.sqrt(-2 * Math.log(q));
    x = (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1);
    return p < 0.5 ? x : -x;
  }
  F.register("funnel", ctx => {
    const {o, C, W} = ctx, ov = ctx.n("observed"), ev = ctx.n("expected"), lv = ctx.has("label") ? ctx.v("label") : null;
    const target = F.numOpt(o.benchmark) ?? 1, better = o.better || "lower";
    const valid = ctx.rows.filter(r => finite(ov(r)) && finite(ev(r)) && ev(r) > 0), minE = F.numOpt(o.min_expected);
    const rows = minE != null ? valid.filter(r => ev(r) >= minE) : valid;
    if (rows.length < valid.length) ctx.note(`${d3.format(",")(valid.length - rows.length)} with ${ctx.name("expected")} below ${minE} are left out (too small to judge).`);
    const ratio = r => ov(r) / ev(r);
    // Drawn limits use the Cornish-Fisher Poisson quantile so the curves are smooth; classification stays exact.
    const smoothQ = (p, lam) => { const z = jstatNorm(p); return Math.max(0, lam + z * Math.sqrt(lam) + (z * z - 1) / 6); };
    const lim = (E, p) => smoothQ(p, E * target) / E;
    const memo = new Map();
    const cls = r => {
      if (memo.has(r)) return memo.get(r);
      const E = ev(r), O = ov(r), hi = poissonQ(0.975, E * target), lo = poissonQ(0.025, E * target);
      const t = O > hi ? "above" : O < lo ? "below" : "within";
      const c = t === "within" ? "neutral" : (t === "below") === (better === "lower") ? "good" : "bad";
      memo.set(r, c);
      return c;
    };
    const counts = d3.rollup(rows, v => v.length, cls);
    const fmt = F.formatter(o, rows.map(ratio));
    const H = o.height || 420, m = {t: 20, r: 20, b: 46, l: 50};
    const [e0, e1] = d3.extent(rows, ev), logX = e1 / e0 > 20;
    const x = logX ? d3.scaleLog().domain([Math.max(e0, e1 / 1000) * 0.9, e1 * 1.15]).range([m.l, W - m.r]) : d3.scaleLinear().domain([0, e1]).nice().range([m.l, W - m.r]);
    const yMax = F.numOpt(o.y_max) ?? Math.max(target * 2, d3.quantile(rows.map(ratio).sort(d3.ascending), 0.99) * 1.15);
    const y = d3.scaleLinear([0, yMax], [H - m.b, m.t]);
    const svg = ctx.svg(H), g = svg.append("g");
    const yt = y.ticks(6), tfy = F.tickFmt(fmt, yt);
    yt.forEach(t => { g.append("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(t)).attr("y2", y(t)).attr("stroke", C.grid); g.append("text").attr("class", "ftick").attr("x", m.l - 8).attr("y", y(t)).attr("dy", "0.32em").attr("text-anchor", "end").text(tfy(t)); });
    x.ticks(6).forEach(t => { if (logX && !/^[125]/.test(d3.format("~e")(t))) return; g.append("line").attr("y1", m.t).attr("y2", H - m.b).attr("x1", x(t)).attr("x2", x(t)).attr("stroke", C.grid); g.append("text").attr("class", "ftick").attr("y", H - m.b + 16).attr("x", x(t)).attr("text-anchor", "middle").text(F.numTick(t)); });
    const grid = d3.range(0, 1.0001, 1 / 90).map(t => (logX ? x.domain()[0] * Math.pow(x.domain()[1] / x.domain()[0], t) : x.domain()[0] + t * (x.domain()[1] - x.domain()[0]))).filter(E => E > 0);
    const band = d3.area().x(E => x(E)).y0(E => y(Math.max(0, lim(E, 0.025)))).y1(E => y(Math.min(yMax, lim(E, 0.975)))).curve(d3.curveMonotoneX);
    g.append("path").attr("d", band(grid)).attr("class", "ffunnel-band");
    [0.001, 0.999].forEach(p => g.append("path").attr("d", d3.line().x(E => x(E)).y(E => y(Math.max(0, Math.min(yMax, lim(E, p))))).curve(d3.curveMonotoneX)(grid)).attr("class", "ffunnel-limit"));
    g.append("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(target)).attr("y2", y(target)).attr("stroke", C.text2).attr("stroke-width", 1.2);
    g.append("text").attr("class", "fbench-label").attr("x", W - m.r - 4).attr("y", y(target) - 6).attr("text-anchor", "end").text(o.benchmark_label || `Benchmark ${fmt(target)}`);
    const center = F.numOpt(o.center);
    if (center != null) { g.append("line").attr("class", "fbench accent").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(center)).attr("y2", y(center)); g.append("text").attr("class", "fbench-label accent").attr("x", W - m.r - 4).attr("y", y(center) + 14).attr("text-anchor", "end").text(o.center_label || `Overall ${fmt(center)}`); }
    g.append("text").attr("class", "faxis-title").attr("x", (m.l + W - m.r) / 2).attr("y", H - 6).attr("text-anchor", "middle").text(`${ctx.name("expected")}${logX ? " (log scale)" : ""}`);
    g.append("text").attr("class", "faxis-title").attr("transform", `translate(14,${(m.t + H - m.b) / 2}) rotate(-90)`).attr("text-anchor", "middle").text(o.ratio_label || `${ctx.name("observed")} ÷ ${ctx.name("expected")}`);
    const col = r => (ctx.anyHi && !(lv && ctx.hi(lv(r))) ? C.neutral : F.toneColor(C, cls(r)));
    const ordered = [...rows].sort((p, q) => (cls(p) === "neutral") - (cls(q) === "neutral")).reverse();
    const dots = g.selectAll("circle.pt").data(ordered).join("circle").attr("cx", r => x(Math.max(ev(r), x.domain()[0]))).attr("cy", r => y(Math.min(yMax, ratio(r))))
      .attr("r", rows.length > 2000 ? 2.4 : 3.4).attr("fill", col).attr("fill-opacity", r => (cls(r) === "neutral" ? 0.5 : 0.9));
    if (ctx.anim) dots.attr("opacity", 0).transition().duration(500).delay((r, i) => Math.min(700, i)).attr("opacity", 1);
    const px = r => x(Math.max(ev(r), x.domain()[0])), py = r => y(Math.min(yMax, ratio(r)));
    if (lv && ctx.anyHi) {
      const his = rows.filter(r => ctx.hi(lv(r))).sort((p, q) => ratio(q) - ratio(p));
      his.forEach(r => g.append("circle").attr("cx", px(r)).attr("cy", py(r)).attr("r", 7).attr("fill", "none").attr("stroke", C.text).attr("stroke-width", 2));
      const skipped = F.placeLabels(g, his.map(r => ({x: px(r), y: py(r), text: F.truncate(lv(r), 180, 11, 600)})), [m.l, m.t, W - m.r, H - m.b]);
      if (skipped.length) ctx.note(`Also circled: ${skipped.slice(0, 6).map(s => s.text).join(", ")}${skipped.length > 6 ? ` and ${skipped.length - 6} more` : ""}.`);
    }
    const clipped = rows.filter(r => ratio(r) > yMax).length, tiny = logX ? rows.filter(r => ev(r) < x.domain()[0]).length : 0;
    if (clipped) ctx.note(`${d3.format(",")(clipped)} with a ratio above ${fmt(yMax)} are drawn on the top edge.`);
    if (tiny) ctx.note(`${d3.format(",")(tiny)} with ${ctx.name("expected")} below ${d3.format(".2~f")(x.domain()[0])} are drawn on the left edge.`);
    ctx.legend(F.chips([{label: "Better than expected", color: C.good, count: d3.format(",")(counts.get("good") || 0)}, {label: "No different", color: C.neutral, count: d3.format(",")(counts.get("neutral") || 0)},
      {label: "Worse than expected", color: C.bad, count: d3.format(",")(counts.get("bad") || 0)}]));
    ctx.note("Shaded band: 95% Poisson control limits around the benchmark; dashed lines: 99.8%. Small units vary more by chance, so the funnel narrows as volume grows.");
    nearest(ctx, svg, rows.map(r => [x(Math.max(ev(r), x.domain()[0])), y(Math.min(yMax, ratio(r))), r]), [m.l, m.t, W - m.l - m.r, H - m.t - m.b],
      r => F.tipHtml(lv ? lv(r) : "Unit", [[o.ratio_label || "Ratio", fmt(ratio(r)), cls(r)], [ctx.name("observed"), d3.format(",.3~f")(ov(r))], [ctx.name("expected"), d3.format(",.3~f")(ev(r))],
        ["Classification", cls(r) === "good" ? "Better than expected" : cls(r) === "bad" ? "Worse than expected" : "No different", cls(r)]]), r => ctx.pick(r, [["Ratio", +ratio(r).toFixed(3)]]));
  });

  // ---- Distribution: histogram (one group) or strip / ridgeline per group ----------------------
  F.register("distribution", ctx => {
    const {o, C, W} = ctx, val = ctx.n("value"), gv = ctx.has("group") ? r => String(ctx.v("group")(r)) : null, lv = ctx.has("label") ? ctx.v("label") : null;
    const rows = ctx.rows.filter(r => finite(val(r)));
    const vals = rows.map(val), fmt = F.formatter(o, vals), bench = F.numOpt(o.benchmark), sem = F.semantic(ctx, vals);
    let style = o.style || o.mode || (gv ? (rows.length <= 5000 ? "strip" : "ridge") : "histogram");
    if (!gv) style = "histogram";
    const lo = F.numOpt(o.min) ?? d3.min(vals), hi = F.numOpt(o.max) ?? d3.quantile([...vals].sort(d3.ascending), 0.995);
    // Values past the axis (after rounding it) are drawn at its end, and the note says from where
    const clipNote = (top, where) => { const n = vals.filter(v => v > top).length; if (n) ctx.note(`${n} value${n > 1 ? "s" : ""} above ${fmt(top)} ${n > 1 ? "are" : "is"} ${where}.`); };
    if (style === "histogram") {
      const H = o.height || 300, m = {t: 26, r: 16, b: 34, l: 44};
      const x = d3.scaleLinear().domain([Math.min(lo, bench ?? lo), Math.max(hi, bench ?? hi)]).nice().range([m.l, W - m.r]);
      const bins = d3.bin().domain(x.domain()).thresholds(x.ticks(o.bins || 32))(vals.map(v => Math.min(v, x.domain()[1])));
      const y = d3.scaleLinear().domain([0, d3.max(bins, b => b.length)]).nice().range([H - m.b, m.t]);
      const svg = ctx.svg(H), g = svg.append("g");
      y.ticks(4).filter(Number.isInteger).forEach(t => { g.append("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(t)).attr("y2", y(t)).attr("stroke", C.grid); g.append("text").attr("class", "ftick").attr("x", m.l - 8).attr("y", y(t)).attr("dy", "0.32em").attr("text-anchor", "end").text(F.numTick(t)); });
      (xt => xt.forEach(t => g.append("text").attr("class", "ftick").attr("x", x(t)).attr("y", H - m.b + 16).attr("text-anchor", "middle").text(F.tickFmt(fmt, xt)(t))))(x.ticks(8));
      const fill = b => (sem.kind === "diverging" ? sem.scale((b.x0 + b.x1) / 2) : C.accent);
      const bars = g.selectAll("rect").data(bins).join("rect").attr("x", b => x(b.x0) + 0.5).attr("width", b => Math.max(0, x(b.x1) - x(b.x0) - 1)).attr("rx", 2)
        .attr("fill", fill).attr("opacity", 0.85).attr("y", H - m.b).attr("height", 0).style("cursor", "pointer");
      ctx.transition(bars, 0, 600).delay((b, i) => (ctx.anim ? i * 12 : 0)).attr("y", b => y(b.length)).attr("height", b => H - m.b - y(b.length));
      const med = d3.median(vals);
      g.append("line").attr("x1", x(med)).attr("x2", x(med)).attr("y1", m.t - 6).attr("y2", H - m.b).attr("stroke", C.text).attr("stroke-width", 1.4);
      g.append("text").attr("class", "fbench-label").attr("x", x(med) + 4).attr("y", m.t - 10).text(`Median ${fmt(med)}`);
      if (bench != null) { g.append("line").attr("class", "fbench").attr("x1", x(bench)).attr("x2", x(bench)).attr("y1", m.t).attr("y2", H - m.b); g.append("text").attr("class", "fbench-label").attr("x", x(bench) - 4).attr("y", m.t + 4).attr("text-anchor", "end").text(o.benchmark_label || `Benchmark ${fmt(bench)}`); }
      if (lv && ctx.anyHi) rows.filter(r => ctx.hi(lv(r))).forEach((r, i) => { const xx = x(Math.min(val(r), x.domain()[1])); g.append("line").attr("x1", xx).attr("x2", xx).attr("y1", m.t + 18 + i * 14).attr("y2", H - m.b).attr("stroke", C.accent).attr("stroke-width", 2); g.append("text").attr("class", "fpt-label").attr("x", xx + 4).attr("y", m.t + 22 + i * 14).text(`${F.truncate(lv(r), 140, 11, 600)} ${fmt(val(r))}`); });
      bars.on("mousemove", (ev, b) => ctx.tip.show(F.tipHtml(`${fmt(b.x0)} – ${fmt(b.x1)}`, [["Count", d3.format(",")(b.length)], ["Share", F.pct(b.length / vals.length)]]), ev)).on("mouseleave", () => ctx.tip.hide())
        .on("click", (ev, b) => ctx.pick({[ctx.f.value]: `${fmt(b.x0)}–${fmt(b.x1)}`}, [["Count", b.length]]));
      clipNote(x.domain()[1], "counted in the last bin");
      return;
    }
    // per-group layouts
    let groups = d3.groups(rows, gv).map(([k, rs]) => ({k, rs, med: d3.median(rs, val)}));
    groups.sort((a, b) => (o.sort === "asc" ? a.med - b.med : o.sort === "none" ? 0 : b.med - a.med));
    groups = groups.slice(0, o.limit || 16);
    const labelW = Math.min(W * 0.26, d3.max(groups, g2 => F.textWidth(g2.k, 12, 500)) + 14);
    const rowH = style === "ridge" ? 34 : 42, top = 24, H = top + groups.length * rowH + (style === "ridge" ? 40 : 30);
    const x = d3.scaleLinear().domain([Math.min(lo, bench ?? lo), Math.max(hi, bench ?? hi)]).nice().range([labelW + 8, W - 60]);
    const svg = ctx.svg(H), g = svg.append("g");
    (xt => xt.forEach(t => { g.append("line").attr("x1", x(t)).attr("x2", x(t)).attr("y1", top - 4).attr("y2", H - 22).attr("stroke", C.grid); g.append("text").attr("class", "ftick").attr("x", x(t)).attr("y", H - 6).attr("text-anchor", "middle").text(F.tickFmt(fmt, xt)(t)); }))(x.ticks(7));
    if (bench != null) { g.append("line").attr("class", "fbench").attr("x1", x(bench)).attr("x2", x(bench)).attr("y1", top - 6).attr("y2", H - 22); g.append("text").attr("class", "fbench-label").attr("x", x(bench)).attr("y", top - 10).attr("text-anchor", "middle").text(o.benchmark_label || `Benchmark ${fmt(bench)}`); }
    const pts = [];
    groups.forEach((gr, i) => {
      const cy = top + i * rowH + rowH / 2, gg = g.append("g");
      gg.append("text").attr("class", "flabel sm" + (ctx.hi(gr.k) ? " strong" : "")).attr("x", labelW - 6).attr("y", cy).attr("dy", "0.32em").attr("text-anchor", "end").text(F.truncate(gr.k, labelW - 10, 12, 500));
      const vs = gr.rs.map(val).sort(d3.ascending), q1 = d3.quantile(vs, 0.25), q3 = d3.quantile(vs, 0.75);
      const col = sem.kind === "diverging" ? sem.scale(gr.med) : C.accent;
      if (style === "ridge") {
        const bw = (d3.deviation(vs) || (x.domain()[1] - x.domain()[0]) / 30) * 1.06 * Math.pow(vs.length, -0.2);
        const kde = xx => d3.mean(vs, v => { const u = (xx - v) / bw; return Math.abs(u) <= 1 ? 0.75 * (1 - u * u) / bw : 0; });
        const xs = d3.range(x.domain()[0], x.domain()[1], (x.domain()[1] - x.domain()[0]) / 120), dens = xs.map(kde), dmax = d3.max(dens) || 1;
        const yy = d => cy + rowH / 2 - (d / dmax) * rowH * 1.25;
        gg.append("path").attr("d", d3.area().x((d, j) => x(xs[j])).y0(cy + rowH / 2).y1(d => yy(d)).curve(d3.curveBasis)(dens)).attr("fill", col).attr("fill-opacity", 0.35).attr("stroke", col).attr("stroke-width", 1.4);
        gg.append("circle").attr("cx", x(gr.med)).attr("cy", cy + rowH / 2 - 2).attr("r", 3.5).attr("fill", C.text);
      } else {
        gg.append("rect").attr("x", x(q1)).attr("width", Math.max(1, x(q3) - x(q1))).attr("y", cy - 9).attr("height", 18).attr("rx", 4).attr("fill", col).attr("fill-opacity", 0.16).attr("stroke", col).attr("stroke-opacity", 0.5);
        gr.rs.forEach((r, j) => { const h = Math.sin((j + 1) * 12.9898 + i * 78.233) * 43758.5453; const jit = ((h - Math.floor(h)) - 0.5) * 22; const px = x(Math.min(val(r), x.domain()[1])); pts.push([px, cy + jit, r]);
          gg.append("circle").attr("cx", px).attr("cy", cy + jit).attr("r", gr.rs.length > 300 ? 1.6 : 2.4).attr("fill", lv && ctx.hi(lv(r)) ? C.text : sem.kind === "diverging" ? sem.scale(val(r)) : C.accent).attr("fill-opacity", 0.55); });
        gg.append("line").attr("x1", x(gr.med)).attr("x2", x(gr.med)).attr("y1", cy - 12).attr("y2", cy + 12).attr("stroke", C.text).attr("stroke-width", 2.4);
      }
      gg.append("text").attr("class", "fval sm").attr("x", W - 4).attr("y", cy).attr("dy", "0.32em").attr("text-anchor", "end").text(fmt(gr.med));
      gg.append("rect").attr("x", 0).attr("y", cy - rowH / 2).attr("width", labelW).attr("height", rowH).attr("fill", "transparent").style("cursor", "pointer")
        .on("mousemove", ev => ctx.tip.show(F.tipHtml(gr.k, [["Median", fmt(gr.med)], ["Middle 50%", `${fmt(q1)} – ${fmt(q3)}`], ["Count", d3.format(",")(vs.length)]]), ev))
        .on("mouseleave", () => ctx.tip.hide()).on("click", () => ctx.pick({[ctx.f.group]: gr.k}, [["Median", +gr.med.toFixed(3)], ["Count", vs.length]]));
    });
    if (pts.length) nearest(ctx, svg, pts, [labelW, top, W - labelW, H - top - 22], r => F.tipHtml(lv ? lv(r) : gv(r), [[ctx.name("value"), fmt(val(r))], [ctx.name("group"), gv(r)]]), r => ctx.pick(r), 10);
    ctx.legend(F.chips(style === "ridge" ? [{label: "Density", color: C.accent}, {label: "Median", color: C.text}] : [{label: `Each dot is one ${lv ? ctx.name("label").toLowerCase() : "row"}`, color: C.accent}, {label: "Middle 50%", color: C.accent, shape: "ring"}, {label: "Median", color: C.text, shape: "line"}]));
    clipNote(x.domain()[1], "drawn at the right edge");
  });

  // ---- Stacked bars: composition per category (100% by default) --------------------------------
  F.register("stacked_bars", ctx => {
    const {o, C, W} = ctx, cv = r => String(ctx.v("category")(r)), pv = r => String(ctx.v("part")(r)), val = ctx.n("value");
    const rows = ctx.rows.filter(r => finite(val(r)));
    const parts = o.order ? o.order.map(String) : F.xDomain(rows, pv).map(String);
    const norm = o.normalize !== false;
    const cats = d3.groups(rows, cv).map(([k, rs]) => { const tot = d3.sum(rs, val); const seg = parts.map(p => ({p, v: d3.sum(rs.filter(r => pv(r) === p), val), r: rs.find(r => pv(r) === p)})); return {k, tot, seg}; });
    const sortPart = o.sort_by != null ? String(o.sort_by) : parts[parts.length - 1];
    if (o.sort !== "none") cats.sort((a, b) => { const sa = a.seg.find(s => s.p === sortPart)?.v / (norm ? a.tot || 1 : 1), sb = b.seg.find(s => s.p === sortPart)?.v / (norm ? b.tot || 1 : 1); return o.sort === "asc" ? sa - sb : sb - sa; });
    const list = cats.slice(0, o.limit || 30);
    const ordinal = o.palette === "ordinal" || (o.palette == null && parts.every(p => finite(+p)));
    const colors = ordinal ? d3.quantize(d3.interpolateRgbBasis(o.better === "lower" ? [C.good, C.neutralMid, C.bad] : o.better === "higher" ? [C.bad, C.neutralMid, C.good] : [C.neutralMid, C.kraft, C.accent]), Math.max(2, parts.length))
      : parts.map((p, i) => C.cat[i % C.cat.length]);
    const color = p => (o.colors && o.colors[p] && F.named(C, o.colors[p])) || colors[parts.indexOf(p)];
    ctx.legend(F.chips(parts.map(p => ({label: (o.part_labels && o.part_labels[p]) || p, color: color(p)}))));
    const fmt = F.formatter(o, rows.map(val));
    const labelW = Math.min(W * 0.28, d3.max(list, c => F.textWidth(c.k, 13, 500)) + 14), totW = norm ? 54 : 8;
    const x = d3.scaleLinear([0, norm ? 1 : d3.max(list, c => c.tot)], [labelW, W - totW - 4]);
    const rowH = 30, top = 6, H = top + list.length * rowH + 6, svg = ctx.svg(H);
    const g = svg.append("g").selectAll("g").data(list).join("g").attr("class", "frow").attr("transform", (c, i) => `translate(0,${top + i * rowH})`);
    g.append("text").attr("class", c => "flabel" + (ctx.hi(c.k) ? " strong" : "")).attr("x", 4).attr("y", rowH / 2).attr("dy", "0.32em").text(c => F.truncate(c.k, labelW - 12, 13, 500));
    g.each(function (c, i) {
      let acc = 0;
      const gg = d3.select(this);
      c.seg.forEach(s => {
        const w = norm ? s.v / (c.tot || 1) : s.v, x0 = x(acc), x1 = x(acc + w); acc += w;
        const rect = gg.append("rect").attr("x", x0).attr("y", 5).attr("height", rowH - 10).attr("fill", color(s.p)).attr("stroke", C.surface).attr("stroke-width", 1)
          .attr("opacity", ctx.anyHi && !ctx.hi(c.k) ? 0.35 : 1).attr("width", ctx.anim ? 0 : Math.max(0, x1 - x0)).style("cursor", "pointer");
        if (ctx.anim) rect.transition().duration(600).delay(i * 30).attr("width", Math.max(0, x1 - x0));
        if (x1 - x0 > 34) gg.append("text").attr("class", "fcell").attr("x", (x0 + x1) / 2).attr("y", rowH / 2).attr("dy", "0.32em").attr("text-anchor", "middle").attr("fill", F.inkOn(color(s.p)))
          .text(norm ? F.pct(s.v / (c.tot || 1)) : fmt(s.v));
        rect.on("mousemove", ev => ctx.tip.show(F.tipHtml(c.k, [[(o.part_labels && o.part_labels[s.p]) || s.p, `${fmt(s.v)} (${F.pct(s.v / (c.tot || 1))})`], ["Total", fmt(c.tot)]]), ev))
          .on("mouseleave", () => ctx.tip.hide()).on("click", () => s.r && ctx.pick(s.r));
      });
    });
    if (norm) g.append("text").attr("class", "fsub").attr("x", W - 4).attr("y", rowH / 2).attr("dy", "0.32em").attr("text-anchor", "end").text(c => `n ${d3.format("~s")(c.tot)}`);
  });

  // ---- Treemap: part-to-whole, sized by value, coloured by group or a semantic value ------------
  F.register("treemap", ctx => {
    const {o, C, W} = ctx, lv = ctx.v("label"), val = ctx.n("value"), gv = ctx.has("group") ? r => String(ctx.v("group")(r)) : null, cv = ctx.has("color") ? ctx.n("color") : null;
    const rows = ctx.rows.filter(r => finite(val(r)) && val(r) > 0).slice(0, o.limit || 400);
    if (!rows.length) return ctx.note(`No positive ${ctx.name("value")} values to size the tiles.`);
    const TH = o.height || Math.round(Math.min(560, Math.max(320, W * 0.6)));
    const rootData = gv ? {children: d3.groups(rows, gv).map(([k, rs]) => ({name: k, children: rs.map(r => ({r}))}))} : {children: rows.map(r => ({r}))};
    const root = d3.hierarchy(rootData).sum(d => (d.r ? val(d.r) : 0)).sort((a, b) => b.value - a.value);
    const sem0 = cv != null, H = TH + (sem0 ? 40 : 0);
    d3.treemap().size([W, TH]).paddingInner(2).paddingTop(gv ? 18 : 0).round(true)(root);
    const fmt = F.formatter(o, rows.map(val)), sem = cv ? F.semantic(ctx, rows.map(cv)) : null;
    const groups = gv ? root.children.map(c => c.data.name) : [];
    const fill = d => (ctx.anyHi && !ctx.hi(lv(d.data.r)) ? C.neutral : sem ? sem.scale(cv(d.data.r)) : gv ? C.cat[groups.indexOf(gv(d.data.r)) % C.cat.length] : C.accent);
    const svg = ctx.svg(H);
    if (gv) svg.selectAll("text.grp").data(root.children).join("text").attr("class", "fgroup").attr("x", d => d.x0 + 4).attr("y", d => d.y0 + 13).text(d => F.truncate(`${d.data.name} · ${fmt(d.value)}`, d.x1 - d.x0 - 8, 11, 700));
    const leaf = svg.selectAll("g.leaf").data(root.leaves()).join("g").attr("class", "leaf").attr("transform", d => `translate(${d.x0},${d.y0})`).style("cursor", "pointer");
    const rect = leaf.append("rect").attr("width", d => d.x1 - d.x0).attr("height", d => d.y1 - d.y0).attr("rx", 3).attr("fill", fill);
    if (ctx.anim) rect.attr("opacity", 0).transition().duration(500).delay((d, i) => Math.min(800, i * 6)).attr("opacity", 1);
    leaf.filter(d => d.x1 - d.x0 > 46 && d.y1 - d.y0 > 26).append("text").attr("x", 6).attr("y", 16).attr("class", "ftm-label").attr("fill", d => F.inkOn(fill(d))).text(d => F.truncate(lv(d.data.r), d.x1 - d.x0 - 10, 12, 600));
    leaf.filter(d => d.x1 - d.x0 > 46 && d.y1 - d.y0 > 42).append("text").attr("x", 6).attr("y", 31).attr("class", "ftm-value").attr("fill", d => F.inkOn(fill(d))).text(d => fmt(val(d.data.r)));
    leaf.on("mousemove", (ev, d) => ctx.tip.show(F.tipHtml(lv(d.data.r), [[ctx.name("value"), fmt(val(d.data.r))], ["Share", F.pct(val(d.data.r) / root.value)], gv && [ctx.name("group"), gv(d.data.r)], cv && [ctx.name("color"), F.formatter(o, [cv(d.data.r)])(cv(d.data.r)), sem && sem.better ? sem.tone(cv(d.data.r)) : ""]]), ev))
      .on("mouseleave", () => ctx.tip.hide()).on("click", (ev, d) => ctx.pick(d.data.r));
    if (sem) F.gradientLegend(ctx, svg.append("g").attr("transform", `translate(${Math.max(0, W - 270)},${TH + 18})`), sem, Math.min(260, W), F.formatter({}, rows.map(cv)), ctx.name("color"));
    if (gv && !sem) ctx.legend(F.chips(groups.slice(0, 9).map((k, i) => ({label: k, color: C.cat[i % C.cat.length]}))));
  });
})();
