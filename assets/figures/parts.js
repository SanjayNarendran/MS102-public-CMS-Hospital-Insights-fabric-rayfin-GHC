/* Parts figures: how a whole splits up.
   likert (an ordered scale per category as a diverging stacked bar, centred on the neutral level), columns
   (vertical bars for ordered or few categories, optionally mirrored: e.g. share better above, share worse below)
   and pareto (the "vital few": sorted contributions with the cumulative share). */
(function () {
  "use strict";
  const F = window.Figures, finite = Number.isFinite;
  const dirOf = b => (b === "lower" || b === "higher" ? b : null);

  // ---- Likert: ordered levels per category, centred on the neutral level -----------------------------
  F.register("likert", ctx => {
    const {o, C, W} = ctx, cv = r => String(ctx.v("category")(r)), lv = r => String(ctx.v("level")(r)), wv = ctx.has("value") ? ctx.n("value") : () => 1;
    const rows = ctx.rows.filter(r => finite(wv(r)) && ctx.v("level")(r) != null);
    if (!rows.length) return ctx.note("No values to plot.");
    const rawLv = [...new Set(rows.map(lv))], numeric = rawLv.every(v => finite(+v));
    const levels = o.order ? o.order.map(String) : numeric ? rawLv.sort((a, b) => +a - +b) : rawLv;
    const better = dirOf(o.better) || "higher";  // the last levels are the good ones unless better = "lower"
    const stars = numeric && F.isStarScale(levels.map(Number));
    const lvLabel = v => (stars ? `${v}★` : v);
    const given = o.neutral != null ? levels.indexOf(String(o.neutral)) : -1;
    const nIdx = given >= 0 ? given : levels.length % 2 ? (levels.length - 1) / 2 : -1;  // -1: even count, split down the middle
    const cats = o.category_order || F.xDomain(rows, cv).map(String);
    const colors = F.ordinalColors(C, levels.length, better);
    const data = cats.map(c => {
      const rs = rows.filter(r => cv(r) === c), tot = d3.sum(rs, wv) || 1;
      const share = levels.map(l => d3.sum(rs.filter(r => lv(r) === l), wv) / tot);
      const low = d3.sum(share.slice(0, nIdx < 0 ? levels.length / 2 : nIdx)), high = d3.sum(share.slice(nIdx < 0 ? levels.length / 2 : nIdx + 1));
      return {c, rs, tot, share, neutral: nIdx < 0 ? 0 : share[nIdx], low, high};
    });
    const good = better === "higher" ? "high" : "low";
    const maxSide = d3.max(data, d => Math.max(d.low, d.high) + d.neutral / 2) || 0.5;
    const labelW = Math.min(W * 0.28, d3.max(cats, c => F.textWidth(c, 13, 600)) + 14), pctW = 46;
    const x = d3.scaleLinear().domain([-maxSide, maxSide]).nice().range([labelW + pctW, W - pctW]);
    const rowH = 34, top = 30, H = top + data.length * rowH + 30, svg = ctx.svg(H), g = svg.append("g");
    const ticks = x.ticks(6);
    ticks.forEach(t => {
      g.append("line").attr("x1", x(t)).attr("x2", x(t)).attr("y1", top - 4).attr("y2", top + data.length * rowH).attr("stroke", t === 0 ? C.text2 : C.grid).attr("stroke-width", t === 0 ? 1.2 : 1);
      g.append("text").attr("class", "ftick").attr("x", x(t)).attr("y", top + data.length * rowH + 18).attr("text-anchor", "middle").text(F.pct(Math.abs(t)));
    });
    const lowTxt = o.low_label || `${lvLabel(levels[0])}${nIdx > 1 || (nIdx < 0 && levels.length > 2) ? "–" + lvLabel(levels[(nIdx < 0 ? levels.length / 2 : nIdx) - 1]) : ""}`;
    const highTxt = o.high_label || `${lvLabel(levels[nIdx < 0 ? levels.length / 2 : nIdx + 1])}${levels.length - (nIdx < 0 ? levels.length / 2 : nIdx + 1) > 1 ? "–" + lvLabel(levels[levels.length - 1]) : ""}`;
    g.append("text").attr("class", "fhead-r " + (good === "low" ? "good" : "bad")).attr("x", labelW + 4).attr("y", top - 12).text(lowTxt);
    g.append("text").attr("class", "fhead-r " + (good === "high" ? "good" : "bad")).attr("x", W - 4).attr("y", top - 12).attr("text-anchor", "end").text(highTxt);
    const row = g.selectAll("g.frow").data(data).join("g").attr("class", "frow").attr("transform", (d, i) => `translate(0,${top + i * rowH})`)
      .style("opacity", d => (ctx.anyHi && !ctx.hi(d.c) ? 0.45 : 1));
    row.append("rect").attr("class", "fhit").attr("width", W).attr("height", rowH).attr("rx", 6);
    row.append("text").attr("class", d => "flabel" + (ctx.hi(d.c) ? " strong" : "")).attr("x", labelW - 10).attr("y", rowH / 2).attr("dy", "0.32em").attr("text-anchor", "end").style("font-weight", 600).text(d => F.truncate(d.c, labelW - 12, 13, 600));
    const bh = 22;
    row.each(function (d) {
      const sel = d3.select(this), segs = [];
      let left = -d.neutral / 2;
      for (let i = (nIdx < 0 ? levels.length / 2 : nIdx) - 1; i >= 0; i--) { segs.push({i, x0: left - d.share[i], x1: left}); left -= d.share[i]; }
      if (nIdx >= 0) segs.push({i: nIdx, x0: -d.neutral / 2, x1: d.neutral / 2});
      let right = d.neutral / 2;
      for (let i = nIdx < 0 ? levels.length / 2 : nIdx + 1; i < levels.length; i++) { segs.push({i, x0: right, x1: right + d.share[i]}); right += d.share[i]; }
      const rects = sel.selectAll("rect.seg").data(segs).join("rect").attr("class", "seg").attr("y", (rowH - bh) / 2).attr("height", bh).attr("rx", 3)
        .attr("x", s => x(s.x0) + 0.5).attr("width", s => Math.max(0, x(s.x1) - x(s.x0) - 1)).attr("fill", s => colors[s.i]);
      if (ctx.anim) rects.attr("x", x(0)).attr("width", 0).transition().duration(650).delay(s => s.i * 40).ease(d3.easeCubicOut).attr("x", s => x(s.x0) + 0.5).attr("width", s => Math.max(0, x(s.x1) - x(s.x0) - 1));
      rects.on("mousemove", (ev, s) => ctx.tip.show(F.tipHtml(`${d.c} · ${lvLabel(levels[s.i])}`, [["Share", d3.format(".1%")(d.share[s.i])], ctx.has("value") && ["Count", d3.format(",.0f")(d.share[s.i] * d.tot)],
        [lowTxt, F.pct(d.low), good === "low" ? "good" : "bad"], [highTxt, F.pct(d.high), good === "high" ? "good" : "bad"]]), ev))
        .on("mouseleave", () => ctx.tip.hide()).on("click", (ev, s) => { ev.stopPropagation(); ctx.pick(d.rs.find(r => lv(r) === levels[s.i]) || d.rs[0], [["Level", lvLabel(levels[s.i])], ["Share", +d.share[s.i].toFixed(3)]]); });
      sel.append("text").attr("class", "flk-pct " + (good === "low" ? "good" : "bad")).attr("x", x(-d.low - d.neutral / 2) - 6).attr("y", rowH / 2).attr("dy", "0.32em").attr("text-anchor", "end").text(F.pct(d.low));
      sel.append("text").attr("class", "flk-pct " + (good === "high" ? "good" : "bad")).attr("x", x(d.high + d.neutral / 2) + 6).attr("y", rowH / 2).attr("dy", "0.32em").text(F.pct(d.high));
    });
    ctx.legend(F.chips(levels.map((l, i) => ({label: lvLabel(l), color: colors[i]}))));
  });

  // ---- Columns: vertical bars for ordered or few categories, optionally mirrored below the axis ------
  F.register("columns", ctx => {
    const {o, C, W} = ctx, xv = ctx.v("x"), val = ctx.n("value"), mir = ctx.has("mirror") ? ctx.n("mirror") : null, nv = ctx.has("n") ? ctx.n("n") : null;
    const rows = ctx.rows.filter(r => finite(val(r)) || (mir && finite(mir(r))));
    if (!rows.length) return ctx.note("No values to plot.");
    const xs = o.order ? o.order : F.xDomain(rows, xv), key = v => String(v), at = new Map(rows.map(r => [key(xv(r)), r]));
    const better = dirOf(o.better), bench = F.numOpt(o.benchmark);
    const stars = o.stars ?? (F.isStarScale(xs.map(Number)) && /star/i.test(String(ctx.f.x) + (o.labels?.x || "")));
    const fmt = F.formatter(o, rows.flatMap(r => [val(r), mir ? mir(r) : NaN]).filter(finite));
    const ordCols = F.ordinalColors(C, xs.length, o.reverse_palette ? "lower" : "higher");  // categories run worst -> best
    const palette = o.palette || (stars ? "ordinal" : better && bench != null ? "semantic" : "accent");
    const colorOf = (v, i) => palette === "ordinal" ? ordCols[i] : palette === "semantic" ? F.toneColor(C, F.toneVs(better, val(at.get(key(v))), bench)) : mir ? C.good : C.accent;
    const maxUp = Math.max(0, d3.max(rows, val) || 0, bench ?? 0), maxDown = mir ? d3.max(rows, r => (finite(mir(r)) ? Math.abs(mir(r)) : 0)) || 0 : Math.max(0, -(d3.min(rows, val) || 0));
    const H = o.height || 320, m = {t: 26, r: 10, b: (nv ? 44 : 28) + (stars ? 4 : 0), l: 46};
    const y = d3.scaleLinear().domain([-maxDown * 1.12, maxUp * 1.12]).nice().range([H - m.b - (mir ? 16 : 0), m.t]);
    const x = d3.scaleBand(xs.map(key), [m.l, W - m.r]).paddingInner(0.32).paddingOuter(0.2), bw = Math.min(x.bandwidth(), 96), off = (x.bandwidth() - bw) / 2;
    const svg = ctx.svg(H), g = svg.append("g");
    const yt = F.uniqueTicks(y.ticks(5), fmt), tf = F.tickFmt(fmt, [...new Set(yt.map(Math.abs))]);
    yt.forEach(t => {
      g.append("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(t)).attr("y2", y(t)).attr("stroke", t === 0 ? C.text2 : C.grid).attr("stroke-width", t === 0 ? 1.2 : 1);
      g.append("text").attr("class", "ftick").attr("x", m.l - 8).attr("y", y(t)).attr("dy", "0.32em").attr("text-anchor", "end").text(tf(Math.abs(t)));
    });
    const col = (r, v, i) => (ctx.anyHi && !ctx.hi(v) ? C.neutral : colorOf(v, i));
    const roundTop = (x0, w, y0, y1, rad) => {  // bar from y0 (baseline) to y1 with rounded far corners
      const up = y1 < y0, h = Math.abs(y1 - y0), rr = Math.min(rad, w / 2, h);
      return up ? `M${x0},${y0} V${y1 + rr} Q${x0},${y1} ${x0 + rr},${y1} H${x0 + w - rr} Q${x0 + w},${y1} ${x0 + w},${y1 + rr} V${y0} Z`
        : `M${x0},${y0} V${y1 - rr} Q${x0},${y1} ${x0 + rr},${y1} H${x0 + w - rr} Q${x0 + w},${y1} ${x0 + w},${y1 - rr} V${y0} Z`;
    };
    xs.forEach((v, i) => {
      const r = at.get(key(v)), bx = x(key(v)) + off;
      const gg = g.append("g").attr("class", "frow").datum(r || null).style("opacity", ctx.anyHi && !ctx.hi(v) ? 0.5 : 1);
      gg.append("rect").attr("class", "fhit").attr("x", x(key(v)) - 4).attr("width", x.bandwidth() + 8).attr("y", m.t - 6).attr("height", H - m.t - m.b + 10).attr("rx", 8);
      if (r && finite(val(r))) {
        const v1 = val(r), y0 = y(0), y1 = y(v1);
        if (Math.abs(y1 - y0) < 1) gg.append("rect").attr("x", bx).attr("width", bw).attr("y", y0 - 4).attr("height", 4).attr("rx", 2).attr("class", "fzero");
        else {
          const p = gg.append("path").attr("d", roundTop(bx, bw, y0, y1, 7)).attr("fill", col(r, v, i));
          if (ctx.anim) p.attr("d", roundTop(bx, bw, y0, y0 - (v1 >= 0 ? 0.01 : -0.01), 7)).transition().duration(700).delay(i * 60).ease(d3.easeCubicOut).attr("d", roundTop(bx, bw, y0, y1, 7));
        }
        gg.append("text").attr("class", "fcol-v").attr("x", bx + bw / 2).attr("y", v1 >= 0 ? y1 - 8 : y1 + 16).attr("text-anchor", "middle").text(fmt(v1));
      }
      if (r && mir && finite(mir(r))) {
        const v2 = Math.abs(mir(r)), y0 = y(0), y1 = y(-v2);
        if (y1 - y0 >= 1) gg.append("path").attr("d", roundTop(bx, bw, y0, y1, 6)).attr("fill", C.bad).attr("fill-opacity", ctx.anyHi && !ctx.hi(v) ? 0.4 : 0.9);
        gg.append("text").attr("class", "fcol-v bad").attr("x", bx + bw / 2).attr("y", y1 + 16).attr("text-anchor", "middle").text(fmt(v2));
      }
      const lt = gg.append("text").attr("class", stars ? "fcol-x stars" : "fcol-x").attr("x", bx + bw / 2).attr("y", H - m.b + (stars ? 20 : 18)).attr("text-anchor", "middle")
        .text(stars ? "★".repeat(+v) : F.truncate(v, x.bandwidth() + 10, 12, 600));
      if (stars) lt.attr("fill", C.text2);  // star glyphs are ink, as on the dashboard
      if (nv && r && finite(nv(r))) gg.append("text").attr("class", "fsub").attr("x", bx + bw / 2).attr("y", H - m.b + 36).attr("text-anchor", "middle").text(`n=${d3.format(",")(nv(r))}`);
    });
    if (bench != null) {
      g.append("line").attr("class", "fbench").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(bench)).attr("y2", y(bench));
      g.append("text").attr("class", "fbench-label").attr("x", W - m.r).attr("y", y(bench) - 6).attr("text-anchor", "end").text(o.benchmark_label || `Benchmark ${fmt(bench)}`);
    }
    if (mir) ctx.legend(F.chips([{label: `▲ ${o.value_label || ctx.name("value")}`, color: C.good}, {label: `▼ ${o.mirror_label || ctx.name("mirror")}`, color: C.bad}]));
    F.rowHover(ctx, g.selectAll(".frow").filter(r => r), r => F.tipHtml(stars ? `${xv(r)} stars` : String(xv(r)), [[o.value_label || ctx.name("value"), fmt(val(r))],
      mir && [o.mirror_label || ctx.name("mirror"), fmt(Math.abs(mir(r)))], nv && ["n", d3.format(",")(nv(r))], bench != null && ["vs " + (o.benchmark_label || "benchmark"), F.signed(fmt, val(r) - bench), F.toneVs(better, val(r), bench)]]));
  });

  // ---- Pareto: sorted contributions with the cumulative share and the "vital few" -------------------
  F.register("pareto", ctx => {
    const {o, C, W} = ctx, label = ctx.v("label"), val = ctx.n("value");
    const pos = ctx.rows.filter(r => finite(val(r)) && val(r) > 0).sort((a, b) => val(b) - val(a));
    if (!pos.length) return ctx.note("Pareto needs positive values.");
    const total = d3.sum(pos, val), thr = F.numOpt(o.threshold) ?? 0.8, fmt = F.formatter(o, pos.map(val));
    let cum = 0;
    const data = pos.map((r, i) => { cum += val(r); return {r, i, v: val(r), cum: cum / total}; });
    const k = data.findIndex(d => d.cum >= thr - 1e-9) + 1;
    const n = Math.min(data.length, Math.max(o.limit || 25, Math.min(k + 3, 500))), shown = data.slice(0, n);  // always past the threshold
    const showLabels = (W - 100) / n >= 16;
    const labH = showLabels ? Math.min(110, d3.max(shown, d => F.textWidth(F.truncate(label(d.r), 130, 11, 500), 11, 500)) * 0.72 + 14) : 14;
    const H = o.height || 300 + labH, m = {t: 40, r: 46, b: labH + 10, l: 50};
    const x = d3.scaleBand(shown.map(d => d.i), [m.l, W - m.r]).paddingInner(n > 30 ? 0.12 : 0.22).paddingOuter(0.1);
    const y = d3.scaleLinear().domain([0, shown[0].v]).nice().range([H - m.b, m.t]), yc = d3.scaleLinear([0, 1], [H - m.b, m.t]);
    const svg = ctx.svg(H), g = svg.append("g");
    const yt = F.uniqueTicks(y.ticks(5), fmt), tf = F.tickFmt(fmt, yt);
    yt.forEach(t => {
      g.append("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(t)).attr("y2", y(t)).attr("stroke", C.grid);
      g.append("text").attr("class", "ftick").attr("x", m.l - 8).attr("y", y(t)).attr("dy", "0.32em").attr("text-anchor", "end").text(tf(t));
    });
    [0, 0.25, 0.5, 0.75, 1].forEach(t => g.append("text").attr("class", "ftick").attr("x", W - m.r + 8).attr("y", yc(t)).attr("dy", "0.32em").text(F.pct(t)));
    g.append("text").attr("class", "faxis-title").attr("x", 0).attr("y", m.t - 16).text(o.value_label || ctx.name("value"));
    g.append("text").attr("class", "faxis-title").attr("x", W).attr("y", m.t - 16).attr("text-anchor", "end").text("Cumulative");
    const vital = d => d.i < k;
    const bars = g.selectAll("rect.bar").data(shown).join("rect").attr("class", "bar").attr("x", d => x(d.i)).attr("width", x.bandwidth()).attr("rx", Math.min(3, x.bandwidth() / 3))
      .attr("fill", d => (vital(d) ? C.accent : C.neutral)).attr("stroke", d => (ctx.anyHi && ctx.hi(label(d.r)) ? C.text : "none")).attr("stroke-width", 1.4)
      .attr("y", H - m.b).attr("height", 0);
    ctx.transition(bars, 0, 600).delay(d => (ctx.anim ? d.i * 12 : 0)).attr("y", d => y(d.v)).attr("height", d => H - m.b - y(d.v));
    if (k <= n) {
      const kx = x(k - 1) + x.bandwidth() + (x.step() - x.bandwidth()) / 2;
      g.append("line").attr("class", "fbench accent").attr("x1", m.l).attr("x2", W - m.r).attr("y1", yc(thr)).attr("y2", yc(thr));
      g.append("line").attr("class", "fbench accent").attr("x1", kx).attr("x2", kx).attr("y1", m.t - 6).attr("y2", H - m.b);
      const txt = `${d3.format(",")(k)} of ${d3.format(",")(data.length)} (${d3.format(".1~%")(k / data.length)}) = ${F.pct(thr)} of the total`;
      g.append("text").attr("class", "fpareto-callout").attr("x", kx + (kx > W * 0.6 ? -8 : 8)).attr("y", m.t - 14).attr("text-anchor", kx > W * 0.6 ? "end" : "start").text(txt);
    }
    const line = d3.line().x(d => x(d.i) + x.bandwidth() / 2).y(d => yc(d.cum)).curve(d3.curveMonotoneX);
    const cl = g.append("path").attr("d", line(shown)).attr("fill", "none").attr("stroke", C.text).attr("stroke-width", 2);
    if (ctx.anim) { const L = cl.node().getTotalLength(); cl.attr("stroke-dasharray", `${L} ${L}`).attr("stroke-dashoffset", L).transition().delay(300).duration(900).attr("stroke-dashoffset", 0); }
    if (n <= 40) g.selectAll("circle.cum").data(shown).join("circle").attr("class", "cum").attr("cx", d => x(d.i) + x.bandwidth() / 2).attr("cy", d => yc(d.cum)).attr("r", 2.8).attr("fill", C.surface).attr("stroke", C.text).attr("stroke-width", 1.4);
    if (showLabels) shown.forEach(d => g.append("text").attr("class", "fsub" + (ctx.hi(label(d.r)) ? " strong" : "")).attr("transform", `translate(${x(d.i) + x.bandwidth() / 2},${H - m.b + 10}) rotate(-40)`).attr("text-anchor", "end").attr("dy", "0.32em").text(F.truncate(label(d.r), 130, 11, 500)));
    const hit = g.selectAll("rect.hit").data(shown).join("rect").attr("class", "hit").attr("x", d => x(d.i) - (x.step() - x.bandwidth()) / 2).attr("width", x.step()).attr("y", m.t).attr("height", H - m.b - m.t).attr("fill", "transparent").style("cursor", "pointer");
    hit.on("mousemove", (ev, d) => ctx.tip.show(F.tipHtml(label(d.r), [[o.value_label || ctx.name("value"), fmt(d.v)], ["Share of total", d3.format(".1%")(d.v / total)], ["Cumulative", d3.format(".1%")(d.cum)], ["Rank", `${d.i + 1} of ${d3.format(",")(data.length)}`]]), ev))
      .on("mouseleave", () => ctx.tip.hide()).on("click", (ev, d) => ctx.pick(d.r, [["Cumulative", F.pct(d.cum)]]));
    ctx.legend(F.chips([{label: `Top ${d3.format(",")(k)}: ${F.pct(thr)} of the total`, color: C.accent}, {label: "The rest", color: C.neutral}, {label: "Cumulative share", color: C.text, shape: "line"}]));
    const excluded = ctx.rows.length - pos.length;
    if (n < data.length) ctx.note(`Showing the top ${n} of ${d3.format(",")(data.length)}; the other ${d3.format(",")(data.length - n)} add ${d3.format(".1%")(1 - shown[n - 1].cum)}.`);
    if (excluded) ctx.note(`${d3.format(",")(excluded)} with zero, negative or missing ${ctx.name("value")} are left out.`);
  });
})();
