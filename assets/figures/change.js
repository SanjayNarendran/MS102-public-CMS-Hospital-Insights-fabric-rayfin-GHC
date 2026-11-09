/* Change figures: how a distribution, a rank or a category moves over time.
   fan (median with percentile bands over time, one unit against the spread), lollipop (change per item from a
   baseline), bump (rank over time) and alluvial (units moving between categories from one period to the next). */
(function () {
  "use strict";
  const F = window.Figures, finite = Number.isFinite;
  const dirOf = b => (b === "lower" || b === "higher" ? b : null);

  // ---- Fan chart: percentile bands over time, median, mean and an optional focus unit -------------
  F.register("fan", ctx => {
    const {o, C, W} = ctx, xv = ctx.v("x"), med = ctx.n("median");
    const opt = role => (ctx.has(role) ? ctx.n(role) : () => NaN);
    const p10 = opt("p10"), p25 = opt("p25"), p75 = opt("p75"), p90 = opt("p90"), mean = opt("mean"), focus = opt("focus");
    const rows = ctx.rows.filter(r => finite(med(r)) && xv(r) != null && xv(r) !== "");
    if (!rows.length) return ctx.note("No values to plot.");
    let xs = F.xDomain(rows, xv);
    const numeric = typeof xs[0] === "number", key = v => (numeric ? +v : String(v));
    const missing = [].concat(o.missing ?? []).map(key);
    if (missing.length) { xs = [...new Set([...xs, ...missing])]; if (numeric) xs.sort(d3.ascending); }
    const at = new Map(rows.map(r => [key(xv(r)), r]));
    const data = xs.filter(v => at.has(v)).map(v => ({x: v, r: at.get(v)}));
    const better = dirOf(o.better), bench = F.numOpt(o.benchmark);
    const all = rows.flatMap(r => [med(r), p10(r), p25(r), p75(r), p90(r), mean(r), focus(r)]).filter(finite).concat(bench != null ? [bench] : []);
    const fmt = F.formatter(o, all), last = data[data.length - 1].r;
    const outer = ctx.has("p10") && ctx.has("p90"), inner = ctx.has("p25") && ctx.has("p75");
    const ends = [
      outer && {y: p90(last), t: `${o.upper_label || "90th pct"} ${fmt(p90(last))}`, cls: "fend-m"},
      inner && !outer && {y: p75(last), t: `75th pct ${fmt(p75(last))}`, cls: "fend-m"},
      {y: med(last), t: `${o.median_label || "Median"} ${fmt(med(last))}`, cls: "fend-a"},
      inner && !outer && {y: p25(last), t: `25th pct ${fmt(p25(last))}`, cls: "fend-m"},
      outer && {y: p10(last), t: `${o.lower_label || "10th pct"} ${fmt(p10(last))}`, cls: "fend-m"},
      ctx.has("focus") && finite(focus(last)) && {y: focus(last), t: `${o.focus_label || ctx.name("focus")} ${fmt(focus(last))}`, cls: "fend-f"},
    ].filter(Boolean);
    const endW = Math.min(W * 0.3, d3.max(ends, e => F.textWidth(e.t, 12, 650)) + 14);
    const H = o.height || 340, m = {t: 26, r: endW + 8, b: 30, l: 46};
    const x = d3.scalePoint(xs, [m.l, W - m.r]).padding(0.3);
    let [lo, hi] = d3.extent(all);
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.08;
    const y = d3.scaleLinear().domain([lo - pad, hi + pad]).nice().range([H - m.b, m.t]);
    const svg = ctx.svg(H), g = svg.append("g");
    F.gridY(g, y, W - m.r, C, 5, fmt);
    g.selectAll("line.gy").attr("x1", m.l); g.selectAll("text.gy").attr("x", m.l - 8);
    missing.forEach(v => {
      const cxm = x(v), w = x.step() * 0.82;
      g.append("rect").attr("x", cxm - w / 2).attr("y", m.t).attr("width", w).attr("height", H - m.b - m.t).attr("class", "fgap");
      g.append("text").attr("class", "fgap-label").attr("x", cxm).attr("y", m.t + 13).attr("text-anchor", "middle").text(o.missing_label || "no data");
    });
    xs.forEach(v => g.append("text").attr("class", "ftick" + (missing.includes(v) ? " faint" : "")).attr("x", x(v)).attr("y", H - m.b + 18).attr("text-anchor", "middle")
      .text(`${xs.length > 9 ? F.shortYear(v) : v}${missing.includes(v) ? "*" : ""}`));
    // Flat ink bands, as in the dashboard's PSI-90 spread (Fig 9)
    const area = (a, b) => d3.area().x(d => x(d.x)).y0(d => y(a(d.r))).y1(d => y(b(d.r))).curve(d3.curveMonotoneX).defined(d => finite(a(d.r)) && finite(b(d.r)));
    if (outer) g.append("path").attr("d", area(p10, p90)(data)).attr("fill", C.text).attr("fill-opacity", 0.06);
    if (inner) g.append("path").attr("d", area(p25, p75)(data)).attr("fill", C.text).attr("fill-opacity", 0.09);
    if (outer) [p10, p90].forEach(fn => g.append("path").attr("d", d3.line().x(d => x(d.x)).y(d => y(fn(d.r))).curve(d3.curveMonotoneX).defined(d => finite(fn(d.r)))(data)).attr("class", "ffan-edge"));
    if (bench != null) {
      g.append("line").attr("class", "fbench").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(bench)).attr("y2", y(bench));
      const gapX = missing.length ? x(missing[0]) : null;  // an empty no-data band is the clearest place for the label
      g.append("text").attr("class", "fbench-label halo").attr("x", gapX ?? m.l + 4).attr("y", y(bench) - 6).attr("text-anchor", gapX != null ? "middle" : "start").text(o.benchmark_label || `Benchmark ${fmt(bench)}`);
    }
    const mline = g.append("path").attr("d", d3.line().x(d => x(d.x)).y(d => y(med(d.r))).curve(d3.curveMonotoneX)(data)).attr("fill", "none").attr("stroke", C.accent).attr("stroke-width", 2.8).attr("stroke-linecap", "round");
    if (ctx.anim) { const L = mline.node().getTotalLength(); mline.attr("stroke-dasharray", `${L} ${L}`).attr("stroke-dashoffset", L).transition().duration(1000).ease(d3.easeCubicOut).attr("stroke-dashoffset", 0); }
    if (ctx.has("mean")) g.selectAll(null).data(data.filter(d => finite(mean(d.r)))).join("circle").attr("cx", d => x(d.x)).attr("cy", d => y(mean(d.r))).attr("r", 4.2).attr("fill", C.surface).attr("stroke", C.text2).attr("stroke-width", 1.6);
    if (ctx.has("focus")) {
      const fd = data.filter(d => finite(focus(d.r)));
      g.append("path").attr("d", d3.line().x(d => x(d.x)).y(d => y(focus(d.r))).curve(d3.curveMonotoneX)(fd)).attr("fill", "none").attr("stroke", C.text).attr("stroke-width", 2.2);
      g.selectAll(null).data(fd).join("circle").attr("cx", d => x(d.x)).attr("cy", d => y(focus(d.r))).attr("r", 3.6).attr("fill", d => (better && finite(med(d.r)) ? F.toneColor(C, F.toneVs(better, focus(d.r), med(d.r))) : C.text)).attr("stroke", C.surface).attr("stroke-width", 1.5);
    }
    F.dodge(ends.map(e => ({...e, y: y(e.y)})), 15, m.t, H - m.b).forEach(e =>
      g.append("text").attr("class", "fend " + e.cls).attr("x", W - m.r + 8).attr("y", e.y).attr("dy", "0.32em").text(e.t));
    const legend = [{label: o.median_label || "Median", color: C.accent, shape: "line"}];
    if (inner) legend.push({label: "25th–75th", color: C.neutral});
    if (outer) legend.push({label: "10th–90th", color: C.neutralMid});
    if (ctx.has("mean")) legend.push({label: "Mean", color: C.text2, shape: "ring"});
    if (ctx.has("focus")) legend.push({label: o.focus_label || ctx.name("focus"), color: C.text, shape: "line"});
    ctx.legend(F.chips(legend));
    const rule = g.append("line").attr("class", "frule").attr("y1", m.t).attr("y2", H - m.b).style("opacity", 0);
    const nearestX = mx => data.reduce((b, d) => (Math.abs(x(d.x) - mx) < Math.abs(x(b.x) - mx) ? d : b), data[0]);
    svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", W - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent").style("cursor", "crosshair")
      .on("mousemove", ev => {
        const d = nearestX(d3.pointer(ev)[0]), r = d.r;
        rule.attr("x1", x(d.x)).attr("x2", x(d.x)).style("opacity", 1);
        ctx.tip.show(F.tipHtml(String(d.x), [outer && ["90th percentile", fmt(p90(r))], inner && ["75th percentile", fmt(p75(r))], [o.median_label || "Median", fmt(med(r))],
          inner && ["25th percentile", fmt(p25(r))], outer && ["10th percentile", fmt(p10(r))], ctx.has("mean") && ["Mean", fmt(mean(r))],
          ctx.has("focus") && finite(focus(r)) && [o.focus_label || ctx.name("focus"), fmt(focus(r)), better ? F.toneVs(better, focus(r), med(r)) : ""]]), ev);
      })
      .on("mouseleave", () => { rule.style("opacity", 0); ctx.tip.hide(); })
      .on("click", ev => ctx.pick(nearestX(d3.pointer(ev)[0]).r));
    if (missing.length) ctx.note(`* ${o.missing_note || "No data for " + missing.join(", ")}.`);
  });

  // ---- Lollipop: change per item from a baseline, % or absolute, with the from → to values ------
  F.register("lollipop", ctx => {
    const {o, C, W} = ctx, label = ctx.v("label"), a = ctx.n("from"), b = ctx.n("to");
    let rows = ctx.rows.filter(r => finite(a(r)) && finite(b(r)));
    if (!rows.length) return ctx.note("No values to plot.");
    const pct = o.mode === "pct" || (o.mode !== "abs" && rows.every(r => a(r) > 0));
    const chg = r => (pct ? (b(r) - a(r)) / Math.abs(a(r)) : b(r) - a(r)), better = dirOf(o.better);
    rows = F.sortRows(rows, o.sort, chg).slice(0, o.limit || 30);
    const fmt = F.formatter(o, rows.flatMap(r => [a(r), b(r)]));
    const cfmt = pct ? v => F.signedPct(v) : v => F.signed(fmt, v);
    const pairTxt = r => `${fmt(a(r))} → ${fmt(b(r))}`;
    const labelW = F.labelWidth(ctx, rows, label, 0.34), rightW = d3.max(rows, r => F.textWidth(pairTxt(r), 12, 500)) + 18;
    const cw = d3.max(rows, r => F.textWidth(cfmt(chg(r)), 12.5, 700)) + 14;
    const [c0, c1] = d3.extent([0, ...rows.map(chg)]);
    const x = d3.scaleLinear().domain([c0, c1]).nice().range([labelW + 10 + (c0 < 0 ? cw : 0), W - rightW - cw - 6]);
    const rowH = 34, top = 30, H = top + rows.length * rowH + 30, svg = ctx.svg(H), g = svg.append("g");
    const ticks = x.ticks(Math.max(2, Math.floor((x.range()[1] - x.range()[0]) / 80)));
    ticks.forEach(t => {
      g.append("line").attr("x1", x(t)).attr("x2", x(t)).attr("y1", top - 4).attr("y2", top + rows.length * rowH).attr("stroke", t === 0 ? C.text2 : C.grid).attr("stroke-width", t === 0 ? 1.4 : 1);
      g.append("text").attr("class", "ftick").attr("x", x(t)).attr("y", top + rows.length * rowH + 18).attr("text-anchor", "middle").text(pct ? (t > 0 ? "+" : "") + F.pct(t) : F.tickFmt(fmt, ticks)(t));
    });
    g.append("text").attr("class", "fhead-r").attr("x", W - 4).attr("y", top - 12).attr("text-anchor", "end").text(`${o.from_label || ctx.name("from")} → ${o.to_label || ctx.name("to")}`);
    const row = g.selectAll("g.frow").data(rows).join("g").attr("class", "frow").attr("transform", (r, i) => `translate(0,${top + i * rowH})`)
      .style("opacity", r => (ctx.anyHi && !ctx.hi(label(r)) ? 0.45 : 1));
    row.append("rect").attr("class", "fhit").attr("width", W).attr("height", rowH).attr("rx", 6);
    row.append("text").attr("class", r => "flabel" + (ctx.hi(label(r)) ? " strong" : "")).attr("x", labelW).attr("y", rowH / 2).attr("dy", "0.32em").attr("text-anchor", "end").text(r => F.truncate(label(r), labelW - 8, 13, 500));
    const tone = r => F.changeTone(better, b(r) - a(r), a(r)), col = r => (better ? F.toneColor(C, tone(r)) : C.accent);
    const stick = row.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", rowH / 2).attr("y2", rowH / 2).attr("stroke", col).attr("stroke-width", 3).attr("stroke-opacity", 0.6).attr("stroke-linecap", "round");
    const dot = row.append("circle").attr("cx", x(0)).attr("cy", rowH / 2).attr("r", 7.5).attr("fill", col).attr("stroke", C.surface).attr("stroke-width", 2);
    ctx.transition(stick, 0, 700).delay((r, i) => (ctx.anim ? i * 40 : 0)).attr("x2", r => x(chg(r)));
    ctx.transition(dot, 0, 700).delay((r, i) => (ctx.anim ? i * 40 : 0)).attr("cx", r => x(chg(r)));
    row.append("text").attr("class", r => "fchg " + (better ? tone(r) : "")).attr("x", r => x(chg(r)) + (chg(r) < 0 ? -14 : 14)).attr("y", rowH / 2).attr("dy", "0.32em")
      .attr("text-anchor", r => (chg(r) < 0 ? "end" : "start")).text(r => cfmt(chg(r)));
    row.append("text").attr("class", "fpair").attr("x", W - 4).attr("y", rowH / 2).attr("dy", "0.32em").attr("text-anchor", "end").text(pairTxt);
    F.rowHover(ctx, row, r => F.tipHtml(label(r), [[o.from_label || ctx.name("from"), fmt(a(r))], [o.to_label || ctx.name("to"), fmt(b(r))], ["Change", cfmt(chg(r)), better ? tone(r) : ""],
      pct && ["Absolute", F.signed(fmt, b(r) - a(r))]]));
  });

  // ---- Bump chart: rank over time ------------------------------------------------------------------
  F.register("bump", ctx => {
    const {o, C, W} = ctx, xv = ctx.v("x"), sv = r => String(ctx.v("series")(r));
    const hasRank = ctx.has("rank"), rk = hasRank ? ctx.n("rank") : null, val = ctx.has("value") ? ctx.n("value") : null;
    const better = dirOf(o.better) || "higher";
    const rows = ctx.rows.filter(r => (hasRank ? finite(rk(r)) : val && finite(val(r))) && xv(r) != null);
    if (!rows.length) return ctx.note("Map either rank or value.");
    const xs = F.xDomain(rows, xv), numeric = typeof xs[0] === "number", key = v => (numeric ? +v : String(v));
    const rank = new Map();
    xs.forEach(t => {
      const rs = rows.filter(r => key(xv(r)) === t);
      const ranked = hasRank ? rs.map(r => [r, rk(r)]) : [...rs].sort((p, q) => (better === "lower" ? val(p) - val(q) : val(q) - val(p))).map((r, i) => [r, i + 1]);
      ranked.forEach(([r, n]) => rank.set(r, n));
    });
    const series = d3.groups(rows, sv).map(([name, rs]) => ({name, pts: rs.map(r => ({x: key(xv(r)), rank: rank.get(r), r})).sort((p, q) => xs.indexOf(p.x) - xs.indexOf(q.x))}));
    const nMax = d3.max(series, s => d3.max(s.pts, p => p.rank));
    const fmt = val ? F.formatter(o, rows.map(val)) : null;
    series.forEach(s => { s.first = s.pts[0]; s.last = s.pts[s.pts.length - 1]; s.gain = s.first.rank - s.last.rank; });
    const movers = new Set([...series].sort((p, q) => Math.abs(q.gain) - Math.abs(p.gain)).slice(0, o.movers ?? 4).filter(s => s.gain).map(s => s.name));
    const fs = nMax > 30 ? 10.5 : 12, lab = s => `${s}`;
    const labelW = Math.min(W * 0.24, d3.max(series, s => F.textWidth(`${nMax}  ${lab(s.name)}`, fs, 600)) + 12);
    const rowStep = Math.max(nMax > 30 ? 13 : 20, Math.min(30, 420 / nMax)), H = o.height || nMax * rowStep + 50;
    const m = {t: 26, b: 22, l: labelW + 10, r: labelW + 10};
    const x = d3.scalePoint(xs, [m.l, W - m.r]), y = d3.scaleLinear([1, Math.max(2, nMax)], [m.t, H - m.b]);
    const svg = ctx.svg(H), g = svg.append("g");
    xs.forEach(t => {
      g.append("line").attr("x1", x(t)).attr("x2", x(t)).attr("y1", m.t - 8).attr("y2", H - m.b + 4).attr("stroke", C.grid);
      g.append("text").attr("class", "ftick strong").attr("x", x(t)).attr("y", m.t - 12).attr("text-anchor", "middle").text(t);
    });
    const emph = s => ctx.hi(s.name) || (!ctx.anyHi && movers.has(s.name));
    const hiNames = series.filter(s => ctx.hi(s.name)).map(s => s.name);
    const colorOf = s => (ctx.hi(s.name) ? C.cat[hiNames.indexOf(s.name) % C.cat.length] : ctx.anyHi ? C.neutral : s.gain ? F.toneColor(C, s.gain > 0 ? "good" : "bad") : C.neutral);
    const line = d3.line().x(p => x(p.x)).y(p => y(p.rank)).curve(d3.curveBumpX);
    const order = [...series].sort((p, q) => emph(p) - emph(q));
    const lines = g.append("g").selectAll("g").data(order).join("g").attr("class", "fbump").style("cursor", "pointer");
    lines.append("path").attr("d", s => line(s.pts)).attr("fill", "none").attr("stroke", colorOf).attr("stroke-width", s => (emph(s) ? 3 : 1.4))
      .attr("stroke-opacity", s => (emph(s) ? 1 : ctx.anyHi ? 0.3 : 0.45)).attr("class", "fbump-line");
    lines.append("path").attr("d", s => line(s.pts)).attr("fill", "none").attr("stroke", "transparent").attr("stroke-width", 12);
    lines.each(function (s) {
      const sel = d3.select(this), e = emph(s), rr = e && rowStep >= 18 ? 9 : e ? 4 : 2.4;
      sel.selectAll("circle").data(s.pts).join("circle").attr("cx", p => x(p.x)).attr("cy", p => y(p.rank)).attr("r", rr).attr("fill", e ? colorOf(s) : C.surface).attr("stroke", colorOf(s)).attr("stroke-width", e ? 0 : 1.2)
        .attr("opacity", e ? 1 : ctx.anyHi ? 0.4 : 0.7);
      if (e && rr >= 9) sel.selectAll("text.fbump-n").data(s.pts).join("text").attr("class", "fbump-n").attr("x", p => x(p.x)).attr("y", p => y(p.rank)).attr("dy", "0.34em").attr("text-anchor", "middle").attr("fill", F.inkOn(colorOf(s))).text(p => p.rank);
    });
    const endLabel = (side, s) => {
      const p = side === "l" ? s.first : s.last, e = emph(s);
      if (side === "l" && p.x !== xs[0]) return;
      if (side === "r" && p.x !== xs[xs.length - 1]) return;
      g.append("text").attr("class", "fbump-l" + (e ? " strong" : "")).attr("x", side === "l" ? m.l - 10 : W - m.r + 10).attr("y", y(p.rank)).attr("dy", "0.32em")
        .attr("text-anchor", side === "l" ? "end" : "start").attr("fill", e ? colorOf(s) : null).style("font-size", fs + "px")
        .text(side === "l" ? `${F.truncate(lab(s.name), labelW - 30, fs, 600)}  ${p.rank}` : `${p.rank}  ${F.truncate(lab(s.name), labelW - 30, fs, 600)}`);
    };
    series.forEach(s => { endLabel("l", s); endLabel("r", s); });
    lines.on("mousemove", (ev, s) => {
      lines.select(".fbump-line").attr("stroke-opacity", q => (q === s ? 1 : 0.15));
      ctx.tip.show(F.tipHtml(s.name, s.pts.map(p => [String(p.x), `#${p.rank}${fmt ? ` · ${fmt(val(p.r))}` : ""}`]).concat([["Change", s.gain > 0 ? `up ${s.gain}` : s.gain < 0 ? `down ${-s.gain}` : "no change", s.gain > 0 ? "good" : s.gain < 0 ? "bad" : ""]])), ev);
    }).on("mouseleave", () => { lines.select(".fbump-line").attr("stroke-opacity", s => (emph(s) ? 1 : ctx.anyHi ? 0.3 : 0.45)); ctx.tip.hide(); })
      .on("click", (ev, s) => ctx.pick(s.last.r, [["Rank", s.last.rank]]));
    if (!ctx.anyHi && movers.size) ctx.legend(F.chips([{label: "Climbed", color: C.good, shape: "line"}, {label: "Fell", color: C.bad, shape: "line"}]));
    ctx.note(`Rank 1 = ${hasRank ? "first" : better === "lower" ? "lowest" : "highest"} ${hasRank ? "" : ctx.name("value")}. ${ctx.anyHi ? "" : "The biggest movers are emphasised."}`.trim());
  });

  // ---- Alluvial: units moving between categories from one period to another ------------------------
  F.register("alluvial", ctx => {
    const {o, C, W} = ctx, fv = r => r[ctx.f.from], tv = r => r[ctx.f.to], wv = ctx.has("value") ? ctx.n("value") : () => 1;
    const rows = ctx.rows.filter(r => fv(r) != null && fv(r) !== "" && tv(r) != null && tv(r) !== "" && finite(wv(r)));
    if (!rows.length) return ctx.note("No transitions to show.");
    const better = dirOf(o.better);
    const raw = [...new Set(rows.flatMap(r => [fv(r), tv(r)]).map(String))];
    const numericCats = raw.every(v => finite(+v));
    // Display order is best first (top): options.order lists categories best first; numbers sort by direction.
    let cats = o.order ? o.order.map(String) : numericCats ? raw.sort((a, b) => +a - +b) : raw.sort(F.natural);
    const ordinal = !!o.order || numericCats;
    if (numericCats && !o.order && better === "higher") cats = cats.reverse();
    cats = [...cats, ...raw.filter(c => !cats.includes(c))];
    const idx = c => cats.indexOf(String(c)), stars = numericCats && F.isStarScale(cats.map(Number)) && /star/i.test(ctx.f.from + ctx.f.to + (o.from_label || ""));
    const catLabel = c => (stars ? "★".repeat(+c) : String(c));
    const flows = d3.rollups(rows, v => ({n: d3.sum(v, wv), r: v[0]}), r => String(fv(r)), r => String(tv(r))).flatMap(([a, ts]) => ts.map(([b, s]) => ({a, b, n: s.n, r: s.r})));
    const total = d3.sum(flows, f => f.n), tot = side => new Map(cats.map(c => [c, d3.sum(flows.filter(f => f[side] === c), f => f.n)]));
    const L = tot("a"), R = tot("b");
    const change = f => (ordinal ? idx(f.b) - idx(f.a) : 0);
    const toneOf = f => { const d = change(f); return !ordinal || !better || !d ? "neutral" : d < 0 ? "good" : "bad"; };
    const colors = ordinal && better ? F.ordinalColors(C, cats.length, "higher").reverse() : cats.map((c, i) => C.cat[i % C.cat.length]);
    const colorOf = c => colors[idx(c)];
    const fmtN = d3.format(o.format || ",.0f"), labW = Math.min(W * 0.22, d3.max(cats, c => F.textWidth(`${catLabel(c)}  ${fmtN(Math.max(L.get(c), R.get(c)))}`, 12.5, 650)) + 16);
    const nodeW = 14, gap = 10, top = 34, plotH = Math.max(240, Math.min(480, cats.length * 52)), H = top + plotH + 12;
    const kL = (plotH - gap * (cats.filter(c => L.get(c)).length - 1)) / total, kR = (plotH - gap * (cats.filter(c => R.get(c)).length - 1)) / total;
    const pos = (T, k) => { let y = top; const out = new Map(); cats.forEach(c => { if (!T.get(c)) return; out.set(c, {y, h: T.get(c) * k}); y += T.get(c) * k + gap; }); return out; };
    const PL = pos(L, kL), PR = pos(R, kR), xl = labW, xr = W - labW - nodeW;
    const svg = ctx.svg(H), g = svg.append("g");
    g.append("text").attr("class", "fhead-r").attr("x", xl + nodeW / 2).attr("y", 16).attr("text-anchor", "middle").text(o.from_label || ctx.name("from"));
    g.append("text").attr("class", "fhead-r").attr("x", xr + nodeW / 2).attr("y", 16).attr("text-anchor", "middle").text(o.to_label || ctx.name("to"));
    // Stack flows inside each node in the other side's order, so ribbons don't cross needlessly.
    const offL = new Map(), offR = new Map();
    const sorted = [...flows].sort((p, q) => idx(p.a) - idx(q.a) || idx(p.b) - idx(q.b));
    sorted.forEach(f => { const o0 = offL.get(f.a) || 0; f.y0 = PL.get(f.a).y + o0; offL.set(f.a, o0 + f.n * kL); f.h0 = f.n * kL; });
    [...flows].sort((p, q) => idx(p.b) - idx(q.b) || idx(p.a) - idx(q.a)).forEach(f => { const o1 = offR.get(f.b) || 0; f.y1 = PR.get(f.b).y + o1; offR.set(f.b, o1 + f.n * kR); f.h1 = f.n * kR; });
    const band = f => {
      const x0 = xl + nodeW, x1 = xr, mx = (x0 + x1) / 2;
      return `M${x0},${f.y0} C${mx},${f.y0} ${mx},${f.y1} ${x1},${f.y1} L${x1},${f.y1 + f.h1} C${mx},${f.y1 + f.h1} ${mx},${f.y0 + f.h0} ${x0},${f.y0 + f.h0} Z`;
    };
    const fcol = f => (ordinal && better ? F.toneColor(C, toneOf(f)) : colorOf(f.a));
    const dim = f => ctx.anyHi && !(ctx.hi(f.a) || ctx.hi(f.b));
    const ribbons = g.append("g").selectAll("path").data(sorted).join("path").attr("d", band).attr("fill", fcol).attr("fill-opacity", f => (dim(f) ? 0.08 : toneOf(f) === "neutral" && ordinal && better ? 0.22 : 0.42))
      .style("cursor", "pointer");
    if (ctx.anim) ribbons.attr("opacity", 0).transition().duration(600).delay((f, i) => i * 15).attr("opacity", 1);
    const node = (P, T, x, side) => cats.forEach(c => {
      if (!P.get(c)) return;
      const p = P.get(c);
      g.append("rect").attr("x", x).attr("y", p.y).attr("width", nodeW).attr("height", Math.max(1, p.h)).attr("rx", 3).attr("fill", colorOf(c));
      const tx = side === "l" ? x - 8 : x + nodeW + 8, anchor = side === "l" ? "end" : "start", cy = p.y + p.h / 2;
      const t = g.append("text").attr("x", tx).attr("y", cy - (p.h > 26 ? 6 : 0)).attr("dy", "0.32em").attr("text-anchor", anchor).attr("class", "falv-l" + (stars ? " stars" : "")).text(catLabel(c));
      if (stars) t.style("fill", colorOf(c));
      if (p.h > 26) g.append("text").attr("x", tx).attr("y", cy + 9).attr("dy", "0.32em").attr("text-anchor", anchor).attr("class", "fsub").text(`${fmtN(T.get(c))} · ${F.pct(T.get(c) / total)}`);
    });
    node(PL, L, xl, "l"); node(PR, R, xr, "r");
    ribbons.on("mousemove", (ev, f) => {
      ribbons.attr("fill-opacity", q => (q === f ? 0.8 : 0.12));
      ctx.tip.show(F.tipHtml(`${catLabel(f.a)} → ${catLabel(f.b)}`, [["Count", fmtN(f.n)], [`Share of ${catLabel(f.a)}`, F.pct(f.n / L.get(f.a))], ordinal && better && ["Change", toneOf(f) === "good" ? "improved" : toneOf(f) === "bad" ? "worsened" : "same", toneOf(f)]]), ev);
    }).on("mouseleave", () => { ribbons.attr("fill-opacity", f => (dim(f) ? 0.08 : toneOf(f) === "neutral" && ordinal && better ? 0.22 : 0.42)); ctx.tip.hide(); })
      .on("click", (ev, f) => ctx.pick(f.r, [["From", catLabel(f.a)], ["To", catLabel(f.b)], ["Count", f.n]]));
    if (ordinal && better) {
      const s = d3.rollup(flows, v => d3.sum(v, f => f.n), toneOf);
      ctx.legend(F.chips([{label: "Improved", color: C.good, count: `${fmtN(s.get("good") || 0)} (${F.pct((s.get("good") || 0) / total)})`},
        {label: "Same", color: C.neutral, count: `${fmtN(s.get("neutral") || 0)} (${F.pct((s.get("neutral") || 0) / total)})`},
        {label: "Worsened", color: C.bad, count: `${fmtN(s.get("bad") || 0)} (${F.pct((s.get("bad") || 0) / total)})`}]));
    }
  });
})();
