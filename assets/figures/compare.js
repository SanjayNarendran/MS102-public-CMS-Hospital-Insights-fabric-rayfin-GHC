/* Comparison figures: kpis, ranked_bars, diverging_bars, dumbbell, slope, bullet, waterfall, waffle, gauge, table. */
(function () {
  "use strict";
  const F = window.Figures, esc = F.esc;
  const finite = Number.isFinite;

  const {labelWidth, rowHover, sortRows} = F;
  function annotationFor(ctx, labelValue) {
    return (ctx.o.annotations || []).find(a => String(a.label ?? a.x) === String(labelValue))?.text;
  }

  // ---- KPI cards: big numbers with change vs a comparison and an optional sparkline -----------
  F.register("kpis", ctx => {
    const {o, C, W} = ctx, label = ctx.v("label"), val = ctx.n("value");
    let items;
    if (ctx.has("time")) {
      const t = ctx.v("time"), order = F.xDomain(ctx.rows, t), idx = v => order.findIndex(x => String(x) === String(v));
      items = d3.groups(ctx.rows, label).map(([name, rs]) => {
        rs = rs.filter(r => finite(val(r))).sort((a, b) => idx(t(a)) - idx(t(b)));
        const last = rs[rs.length - 1], ref = o.compare === "previous" ? rs[rs.length - 2] : rs[0];
        return {name, row: last, value: last ? val(last) : NaN, compare: ref && ref !== last ? val(ref) : NaN,
                cmpLabel: ref ? String(t(ref)) : "", series: rs.map(r => [t(r), val(r)])};
      });
    } else {
      const cmp = ctx.has("compare") ? ctx.n("compare") : () => NaN;
      items = ctx.rows.map(r => ({name: label(r), row: r, value: val(r), compare: cmp(r), cmpLabel: o.compare_label || ctx.name("compare"), series: null}));
    }
    // Cards can hold different measures (minutes, shares, star ratings): each is formatted and judged on its own
    const fmtOf = it => (o.format ? F.formatter(o, []) : F.formatter(o, [it.value, it.compare].filter(finite)));
    const pctFmt = /%/.test(o.format || ""), pctUnit = (o.unit || "").trim() === "%";
    const maxCols = Math.max(1, Math.min(items.length, Math.floor(W / 190)));
    const cols = Math.ceil(items.length / Math.ceil(items.length / maxCols));
    const grid = document.createElement("div");
    grid.className = "fkpis";
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    ctx.el.append(grid);
    items.forEach((it, i) => {
      const card = document.createElement("div");
      card.className = "fkpi" + (ctx.anyHi && !ctx.hi(it.name) ? " dim" : "");
      const fmt = fmtOf(it), better = F.betterFor(ctx, it.name, it.row);
      const delta = it.value - it.compare, rel = it.compare ? delta / Math.abs(it.compare) : NaN;
      const tone = F.changeTone(better, delta, it.compare);
      // A relative change only for positive amounts; shares, scores near zero and star ratings change in points
      const pctLabel = /%|percent/i.test(`${it.name} ${ctx.name("value")}`) && it.value <= 100 && it.compare <= 100;
      const ratioScale = it.compare > 0 && it.value >= 0 && !pctFmt && !pctUnit && !pctLabel && !F.isStarScale([it.value, it.compare].filter(finite));
      const usePct = o.delta === "pct" || (o.delta !== "diff" && finite(rel) && ratioScale);
      const pts = v => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${d3.format(".1~f")(Math.abs(v) * (pctFmt ? 100 : 1))} pts`;
      const dTxt = finite(delta) ? (usePct ? F.signedPct(rel) : pctFmt || pctUnit || pctLabel ? pts(delta) : F.signed(fmt, delta)) : "";
      card.innerHTML = `<div class="k-label">${esc(it.name)}</div><div class="k-value">${esc(fmt(it.value))}</div>` +
        (dTxt ? `<div class="k-delta ${tone}">${esc(dTxt)} <span>vs ${esc(o.compare_label || it.cmpLabel)}</span></div>` : "") +
        (it.series && it.series.length > 1 ? `<svg class="k-spark" viewBox="0 0 100 34" preserveAspectRatio="none"></svg>` : "");
      grid.append(card);
      if (it.series && it.series.length > 1) {
        const s = d3.select(card).select("svg"), ys = it.series.map(p => p[1]);
        const x = d3.scaleLinear([0, it.series.length - 1], [3, 97]), y = d3.scaleLinear(d3.extent(ys), [30, 4]);
        const line = d3.line().x((p, j) => x(j)).y(p => y(p[1])).curve(d3.curveMonotoneX);
        const col = tone === "neutral" ? C.accent : F.toneColor(C, tone);
        s.append("path").attr("d", d3.area().x((p, j) => x(j)).y0(34).y1(p => y(p[1])).curve(d3.curveMonotoneX)(it.series)).attr("fill", col).attr("opacity", 0.12);
        const p = s.append("path").attr("d", line(it.series)).attr("fill", "none").attr("stroke", col).attr("stroke-width", 2).attr("vector-effect", "non-scaling-stroke");
        if (ctx.anim) { const L = 300; p.attr("stroke-dasharray", L).attr("stroke-dashoffset", L).transition().duration(900).delay(i * 80).attr("stroke-dashoffset", 0); }
      }
      card.onmousemove = ev => ctx.tip.show(F.tipHtml(it.name, [[ctx.name("value"), fmt(it.value)], finite(it.compare) && [`${o.compare_label || it.cmpLabel}`, fmt(it.compare)],
        dTxt && ["Change", dTxt, tone]]), ev);
      card.onmouseleave = () => ctx.tip.hide();
      card.onclick = () => ctx.pick(it.row);
    });
  });

  // ---- Ranked bars: sorted horizontal bars, compare markers, benchmark line ------------------
  F.register("ranked_bars", ctx => {
    const {o, C, W} = ctx, label = ctx.v("label"), val = ctx.n("value");
    const cmp = ctx.has("compare") ? ctx.n("compare") : null, sub = ctx.has("sublabel") ? ctx.v("sublabel") : null;
    const ranked = sortRows(ctx.rows.filter(r => finite(val(r))), o.sort, val), lim = o.limit || 30;
    // A highlighted row past the limit is still shown, after the others, so the row the question is about is there
    const kept = ranked.filter((r, i) => i >= lim && ctx.hi(label(r)));
    let rows = [...ranked.slice(0, lim), ...kept];
    if (ranked.length > lim) ctx.note(`Showing ${lim} of ${ranked.length}${kept.length ? `, plus ${kept.map(r => F.nameCase(label(r))).join(", ")} (rank ${kept.map(r => ranked.indexOf(r) + 1).join(", ")})` : ""}.`);
    const all = rows.flatMap(r => [val(r), cmp ? cmp(r) : NaN]).filter(finite);
    const fmt = F.formatter(o, rows.map(val)), sem = F.semantic(ctx, rows.map(val)), bench = F.numOpt(o.benchmark);
    const twoLine = !!sub;
    const rowH = twoLine ? 40 : 30, top = 24, bottom = 6;
    const labelW = labelWidth(ctx, rows, label, 0.36, sub);
    const valW = d3.max(rows, r => F.textWidth(fmt(val(r)), 13, 700)) + 16, dW = cmp ? 62 : 0;
    const lo = Math.min(0, d3.min(all), bench ?? Infinity), hi = Math.max(d3.max(all), bench ?? -Infinity);
    const x = d3.scaleLinear().domain([lo, hi]).nice().range([labelW + 6, W - valW - dW - 6]);
    const base = x(Math.max(x.domain()[0], Math.min(0, x.domain()[1])));
    const H = top + rows.length * rowH + bottom, svg = ctx.svg(H);
    const legend = [];
    if (cmp) legend.push({label: ctx.name("value"), color: C.accent}, {label: o.compare_label || ctx.name("compare"), color: C.text, shape: "ring"});
    if (bench != null) legend.push({label: o.benchmark_label || `Benchmark ${fmt(bench)}`, color: C.muted, shape: "dash"});
    if (legend.length) ctx.legend(F.chips(legend));
    const ticks = F.uniqueTicks(x.ticks(Math.max(2, Math.floor((x.range()[1] - x.range()[0]) / 90))), o.format ? fmt : null);
    const tf = o.format ? F.tickFmt(fmt, ticks) : x.tickFormat(ticks.length);
    svg.append("g").selectAll("line").data(ticks).join("line").attr("x1", x).attr("x2", x).attr("y1", top - 4).attr("y2", H - bottom).attr("stroke", C.grid);
    svg.append("g").selectAll("text").data(ticks).join("text").attr("class", "ftick").attr("x", x).attr("y", top - 10).attr("text-anchor", "middle").text(tf);
    // Colour carries meaning: with a direction, every bar is graded better (blue) to worse (orange) by its distance
    // from the benchmark; highlighted bars get an ink outline and the rest fade. Without one, bars are grey and
    // highlighted bars dark.
    const semantic = sem.kind === "diverging";
    const fillOf = r => (semantic ? sem.scale(val(r)) : ctx.anyHi && !ctx.hi(label(r)) ? C.neutral : C.text2);
    const faded = r => semantic && ctx.anyHi && !ctx.hi(label(r));
    const g = svg.append("g").selectAll("g").data(rows).join("g").attr("class", "frow").attr("transform", (r, i) => `translate(0,${top + i * rowH})`);
    g.append("rect").attr("class", "fhit").attr("width", W).attr("height", rowH).attr("rx", 6);
    const ly = twoLine ? rowH / 2 - 7 : rowH / 2;
    g.append("text").attr("class", r => "flabel" + (ctx.hi(label(r)) ? " strong" : "")).attr("x", 4).attr("y", ly).attr("dy", "0.32em").text(r => F.truncate(label(r), labelW - 14, 13, 500));
    if (sub) g.append("text").attr("class", "fsub").attr("x", 4).attr("y", rowH / 2 + 9).attr("dy", "0.32em").text(r => F.truncate(sub(r), labelW - 14, 11));
    const bh = Math.min(14, rowH * 0.42);
    const bar = g.append("rect").attr("y", (rowH - bh) / 2).attr("height", bh).attr("rx", 3).attr("fill", fillOf)
      .attr("fill-opacity", r => (faded(r) ? 0.4 : 1)).attr("stroke", r => (semantic && ctx.anyHi && ctx.hi(label(r)) ? C.text : "none")).attr("stroke-width", 1.3)
      .attr("x", base).attr("width", 0);
    ctx.transition(bar, 0, 700).delay((r, i) => (ctx.anim ? i * 25 : 0))
      .attr("x", r => Math.min(base, x(val(r)))).attr("width", r => Math.max(1, Math.abs(x(val(r)) - base)));
    if (cmp) {
      g.filter(r => finite(cmp(r))).append("circle").attr("cx", r => x(cmp(r))).attr("cy", rowH / 2).attr("r", 4.5)
        .attr("fill", C.surface).attr("stroke", C.text).attr("stroke-width", 1.6);
      g.append("text").attr("class", r => "fdelta " + F.changeTone(sem.better, val(r) - cmp(r), cmp(r))).attr("x", W - 4).attr("y", ly).attr("dy", "0.32em").attr("text-anchor", "end")
        .text(r => (finite(cmp(r)) ? F.signed(fmt, val(r) - cmp(r)) : ""));
    }
    g.append("text").attr("class", "fval").attr("x", W - dW - 4).attr("y", ly).attr("dy", "0.32em").attr("text-anchor", "end").text(r => fmt(val(r)));
    if (bench != null) svg.append("line").attr("x1", x(bench)).attr("x2", x(bench)).attr("y1", top - 4).attr("y2", H - bottom).attr("class", "fbench");
    g.filter(r => annotationFor(ctx, label(r))).each(function (r) {
      const t = annotationFor(ctx, label(r)), w = F.textWidth(t, 11, 650), end = Math.max(base, x(val(r)));
      const inside = end + 10 + w > x.range()[1];
      if (inside && end - base < w + 16) return ctx.note(`${label(r)}: ${t}`);
      d3.select(this).append("text").attr("class", "fnote-inline").attr("y", rowH / 2).attr("dy", "0.32em")
        .attr("x", inside ? end - 8 : end + 10).attr("text-anchor", inside ? "end" : "start")
        .style("fill", inside ? F.inkOn(fillOf(r)) : null).text(t);
    });
    rowHover(ctx, g, r => F.tipHtml(label(r), [[ctx.name("value"), fmt(val(r))], cmp && finite(cmp(r)) && [o.compare_label || ctx.name("compare"), fmt(cmp(r))],
      cmp && finite(cmp(r)) && ["Change", F.signed(fmt, val(r) - cmp(r)), F.changeTone(sem.better, val(r) - cmp(r), cmp(r))],
      bench != null && ["vs benchmark", F.signed(fmt, val(r) - bench), sem.tone(val(r))]], sub ? sub(r) : ""));
  });

  // ---- Diverging bars: deviation from a benchmark (or the median), good one way, bad the other --
  F.register("diverging_bars", ctx => {
    const {o, C, W} = ctx, label = ctx.v("label"), val = ctx.n("value");
    let rows = sortRows(ctx.rows.filter(r => finite(val(r))), o.sort, val).slice(0, o.limit || 30);
    const fmt = F.formatter(o, rows.map(val)), sem = F.semantic(ctx, rows.map(val)), c = sem.center;
    const rowH = 28, top = 26, bottom = 6, labelW = labelWidth(ctx, rows, label, 0.3);
    const valW = d3.max(rows, r => F.textWidth(fmt(val(r)), 12, 700)) + 12;
    const dev = d3.max(rows, r => Math.abs(val(r) - c)) * 1.04 || 1;
    const x = d3.scaleLinear([c - dev, c + dev], [labelW + valW, W - valW]);
    const H = top + rows.length * rowH + bottom, svg = ctx.svg(H);
    const centerLbl = o.benchmark_label && F.numOpt(o.benchmark) != null ? o.benchmark_label : `${F.numOpt(o.benchmark) != null ? "Benchmark" : "Median"} ${fmt(c)}`;
    svg.append("text").attr("class", "ftick strong").attr("x", x(c)).attr("y", top - 12).attr("text-anchor", "middle").text(centerLbl);
    if (sem.better) {
      svg.append("text").attr("class", "ftick good").attr("x", sem.better === "lower" ? x.range()[0] : x.range()[1]).attr("y", top - 12)
        .attr("text-anchor", sem.better === "lower" ? "start" : "end").text(sem.better === "lower" ? "← better" : "better →");
      svg.append("text").attr("class", "ftick bad").attr("x", sem.better === "lower" ? x.range()[1] : x.range()[0]).attr("y", top - 12)
        .attr("text-anchor", sem.better === "lower" ? "end" : "start").text(sem.better === "lower" ? "worse →" : "← worse");
    }
    const g = svg.append("g").selectAll("g").data(rows).join("g").attr("class", "frow").attr("transform", (r, i) => `translate(0,${top + i * rowH})`);
    g.append("rect").attr("class", "fhit").attr("width", W).attr("height", rowH).attr("rx", 6);
    g.append("text").attr("class", r => "flabel" + (ctx.hi(label(r)) ? " strong" : "")).attr("x", 4).attr("y", rowH / 2).attr("dy", "0.32em").text(r => F.truncate(label(r), labelW - 12, 13, 500));
    const col = r => { const t = sem.better ? sem.tone(val(r)) : val(r) >= c ? "bad" : "good"; const k = sem.better ? F.toneColor(C, t) : val(r) >= c ? C.accent : C.sky; return ctx.anyHi && !ctx.hi(label(r)) ? C.neutral : k; };
    const bar = g.append("rect").attr("y", 7).attr("height", rowH - 14).attr("rx", 3).attr("fill", col).attr("x", x(c)).attr("width", 0);
    ctx.transition(bar, 0, 650).delay((r, i) => (ctx.anim ? i * 22 : 0)).attr("x", r => Math.min(x(c), x(val(r)))).attr("width", r => Math.max(1, Math.abs(x(val(r)) - x(c))));
    g.append("text").attr("class", "fval sm").attr("y", rowH / 2).attr("dy", "0.32em")
      .attr("x", r => (val(r) >= c ? x(val(r)) + 6 : x(val(r)) - 6)).attr("text-anchor", r => (val(r) >= c ? "start" : "end")).text(r => fmt(val(r)));
    svg.append("line").attr("x1", x(c)).attr("x2", x(c)).attr("y1", top - 4).attr("y2", H - bottom).attr("stroke", C.text).attr("stroke-width", 1.2);
    rowHover(ctx, g, r => F.tipHtml(label(r), [[ctx.name("value"), fmt(val(r))], ["vs " + (o.benchmark_label || "center"), F.signed(fmt, val(r) - c), sem.tone(val(r))]]));
  });

  // ---- Dumbbell: from -> to per item, sorted, coloured by whether the change is good ----------
  F.register("dumbbell", ctx => {
    const {o, C, W} = ctx, label = ctx.v("label"), a = ctx.n("from"), b = ctx.n("to");
    const key = o.sort === "from" ? a : o.sort === "change" ? (r => b(r) - a(r)) : b;
    let rows = sortRows(ctx.rows.filter(r => finite(a(r)) && finite(b(r))), o.sort === "change" ? (o.better === "lower" ? "asc" : "desc") : o.sort === "none" ? "none" : o.sort === "asc" || o.sort === "desc" ? o.sort : (o.order || "desc"), key).slice(0, o.limit || 30);
    const pk = ctx.has("peak") ? ctx.n("peak") : () => NaN;
    const all = rows.flatMap(r => [a(r), b(r), pk(r)]).filter(finite), fmt = F.formatter(o, all), bench = F.numOpt(o.benchmark), better = o.better;
    const usePct = o.delta === "pct" || (o.delta == null && d3.min(rows.flatMap(r => [a(r), b(r)])) > 0);
    const rowH = 30, top = 28, bottom = 6, labelW = labelWidth(ctx, rows, label);
    const dW = 64, x = d3.scaleLinear().domain([Math.min(d3.min(all), bench ?? Infinity), Math.max(d3.max(all), bench ?? -Infinity)]).nice().range([labelW + 10, W - dW - 14]);
    const H = top + rows.length * rowH + bottom, svg = ctx.svg(H);
    ctx.legend(F.chips([{label: o.from_label || ctx.name("from"), color: C.muted, shape: "ring"}, {label: o.to_label || ctx.name("to"), color: C.text},
      ...(ctx.has("peak") ? [{label: o.peak_label || ctx.name("peak"), color: C.muted, shape: "diamond"}] : []),
      ...(bench != null ? [{label: o.benchmark_label || `Benchmark ${fmt(bench)}`, color: C.muted, shape: "dash"}] : [])]));
    const ticks = F.uniqueTicks(x.ticks(Math.max(2, Math.floor((x.range()[1] - x.range()[0]) / 90))), o.format ? fmt : null);
    svg.append("g").selectAll("line").data(ticks).join("line").attr("x1", x).attr("x2", x).attr("y1", top - 4).attr("y2", H - bottom).attr("stroke", C.grid);
    svg.append("g").selectAll("text").data(ticks).join("text").attr("class", "ftick").attr("x", x).attr("y", top - 10).attr("text-anchor", "middle").text(o.format ? F.tickFmt(fmt, ticks) : x.tickFormat(ticks.length));
    if (bench != null) svg.append("line").attr("class", "fbench").attr("x1", x(bench)).attr("x2", x(bench)).attr("y1", top - 4).attr("y2", H - bottom);
    const g = svg.append("g").selectAll("g").data(rows).join("g").attr("class", "frow").attr("transform", (r, i) => `translate(0,${top + i * rowH})`);
    g.append("rect").attr("class", "fhit").attr("width", W).attr("height", rowH).attr("rx", 6);
    g.append("text").attr("class", r => "flabel" + (ctx.hi(label(r)) ? " strong" : "")).attr("x", 4).attr("y", rowH / 2).attr("dy", "0.32em").text(r => F.truncate(label(r), labelW - 14, 13, 500));
    const tone = r => F.changeTone(better, b(r) - a(r), a(r)), col = r => (ctx.anyHi && !ctx.hi(label(r)) ? C.neutral : tone(r) === "neutral" ? C.accent : F.toneColor(C, tone(r)));
    // Peak (e.g. the pandemic-era high) outside the from-to range: dotted extension to a diamond.
    g.filter(r => finite(pk(r)) && (pk(r) > Math.max(a(r), b(r)) || pk(r) < Math.min(a(r), b(r)))).each(function (r) {
      const p = pk(r), edge = p > Math.max(a(r), b(r)) ? Math.max(a(r), b(r)) : Math.min(a(r), b(r)), sel = d3.select(this);
      sel.append("line").attr("x1", x(edge)).attr("x2", x(p)).attr("y1", rowH / 2).attr("y2", rowH / 2).attr("stroke", C.muted).attr("stroke-width", 1.4).attr("stroke-dasharray", "2 3");
      sel.append("path").attr("d", `M${x(p)},${rowH / 2 - 6} L${x(p) + 5},${rowH / 2} L${x(p)},${rowH / 2 + 6} L${x(p) - 5},${rowH / 2} Z`).attr("fill", C.muted);
    });
    const line = g.append("line").attr("y1", rowH / 2).attr("y2", rowH / 2).attr("x1", r => x(a(r))).attr("x2", r => x(a(r))).attr("stroke", col).attr("stroke-width", 3).attr("stroke-linecap", "round").attr("opacity", 0.85);
    ctx.transition(line, 0, 700).delay((r, i) => (ctx.anim ? 150 + i * 20 : 0)).attr("x2", r => x(b(r)));
    g.append("circle").attr("cx", r => x(a(r))).attr("cy", rowH / 2).attr("r", 5).attr("fill", C.surface).attr("stroke", C.muted).attr("stroke-width", 1.8);
    const dot = g.append("circle").attr("cy", rowH / 2).attr("r", 5.5).attr("fill", col).attr("cx", r => x(a(r)));
    ctx.transition(dot, 0, 700).delay((r, i) => (ctx.anim ? 150 + i * 20 : 0)).attr("cx", r => x(b(r)));
    g.append("text").attr("class", r => "fdelta " + tone(r)).attr("x", W - 4).attr("y", rowH / 2).attr("dy", "0.32em").attr("text-anchor", "end")
      .text(r => (usePct && a(r) ? F.signedPct((b(r) - a(r)) / Math.abs(a(r))) : F.signed(fmt, b(r) - a(r))));
    rowHover(ctx, g, r => F.tipHtml(label(r), [[o.from_label || ctx.name("from"), fmt(a(r))], [o.to_label || ctx.name("to"), fmt(b(r))],
      ["Change", `${F.signed(fmt, b(r) - a(r))}${a(r) ? ` (${F.signedPct((b(r) - a(r)) / Math.abs(a(r)))})` : ""}`, tone(r)],
      finite(pk(r)) && [o.peak_label || ctx.name("peak"), fmt(pk(r))]]));
  });

  // ---- Slope: two periods, one line per item, biggest movers emphasised ------------------------
  F.register("slope", ctx => {
    const {o, C, W} = ctx, label = ctx.v("label"), a = ctx.n("from"), b = ctx.n("to");
    let rows = ctx.rows.filter(r => finite(a(r)) && finite(b(r)));
    rows = rows.sort((p, q) => Math.abs(b(q) - a(q)) - Math.abs(b(p) - a(p))).slice(0, o.limit || 24);
    const all = rows.flatMap(r => [a(r), b(r)]), fmt = F.formatter(o, all), better = o.better;
    const focus = new Set(ctx.anyHi ? rows.filter(r => ctx.hi(label(r))).map(label) : rows.slice(0, o.emphasis ?? 5).map(label));
    const valW = d3.max(rows, r => Math.max(F.textWidth(fmt(a(r)), 12, 500), F.textWidth(fmt(b(r)), 12, 500)));
    const lw = Math.max(70, Math.min(W * 0.28, d3.max(rows, r => F.textWidth(label(r), 12, 500)) + valW + 18));
    const nameW = lw - valW - 14;
    const xL = lw + 8, xR = W - lw - 8, top = 46, H = Math.max(280, Math.min(560, rows.length * 22 + 90));
    const y = d3.scaleLinear().domain(d3.extent(all)).nice().range([H - 20, top]);
    const svg = ctx.svg(H);
    [[xL, o.from_label || ctx.name("from"), "end"], [xR, o.to_label || ctx.name("to"), "start"]].forEach(([x, t, anchor]) => {
      svg.append("line").attr("x1", x).attr("x2", x).attr("y1", top - 6).attr("y2", H - 14).attr("stroke", C.border);
      svg.append("text").attr("class", "fhead").attr("x", x).attr("y", top - 22).attr("text-anchor", "middle").text(t);
    });
    const bench = F.numOpt(o.benchmark);
    if (bench != null) svg.append("line").attr("class", "fbench").attr("x1", xL).attr("x2", xR).attr("y1", y(bench)).attr("y2", y(bench));
    const ordered = [...rows].sort((p, q) => focus.has(label(p)) - focus.has(label(q)));
    const tone = r => F.changeTone(better, b(r) - a(r), a(r));
    const col = r => (focus.has(label(r)) ? (tone(r) === "neutral" ? C.accent : F.toneColor(C, tone(r))) : C.neutral);
    const g = svg.append("g").selectAll("g").data(ordered).join("g").attr("class", "fslope").style("cursor", "pointer");
    const ln = g.append("line").attr("x1", xL).attr("x2", xL).attr("y1", r => y(a(r))).attr("y2", r => y(a(r))).attr("stroke", col)
      .attr("stroke-width", r => (focus.has(label(r)) ? 2.6 : 1.4)).attr("opacity", r => (focus.has(label(r)) ? 1 : 0.55));
    ctx.transition(ln, 0, 800).attr("x2", xR).attr("y2", r => y(b(r)));
    g.append("circle").attr("cx", xL).attr("cy", r => y(a(r))).attr("r", 3.5).attr("fill", col);
    g.append("circle").attr("cx", xR).attr("cy", r => y(b(r))).attr("r", 3.5).attr("fill", col);
    const lab = (side) => F.dodge(rows.filter(r => focus.has(label(r)) || rows.length <= 12).map(r => ({r, y: y(side === "L" ? a(r) : b(r))})), 14, top, H - 18);
    lab("L").forEach(({r, y: yy}) => svg.append("text").attr("class", "fslabel").attr("x", xL - 8).attr("y", yy).attr("dy", "0.32em").attr("text-anchor", "end")
      .text(`${F.truncate(label(r), nameW, 12, 500)}  ${fmt(a(r))}`));
    lab("R").forEach(({r, y: yy}) => svg.append("text").attr("class", "fslabel").attr("x", xR + 8).attr("y", yy).attr("dy", "0.32em")
      .text(`${fmt(b(r))}  ${F.truncate(label(r), nameW, 12, 500)}`).attr("fill", col(r)));
    g.on("mousemove", (ev, r) => ctx.tip.show(F.tipHtml(label(r), [[o.from_label || ctx.name("from"), fmt(a(r))], [o.to_label || ctx.name("to"), fmt(b(r))],
      ["Change", F.signed(fmt, b(r) - a(r)), tone(r)]]), ev)).on("mouseleave", () => ctx.tip.hide()).on("click", (ev, r) => ctx.pick(r));
    if (!ctx.anyHi && rows.length > 12) ctx.note(`Labelled: the ${focus.size} biggest movers. Hover any line for its values.`);
  });

  // ---- Bullet: actual vs target with qualitative bands ----------------------------------------
  F.register("bullet", ctx => {
    const {o, C, W} = ctx, label = ctx.v("label"), val = ctx.n("value"), tgt = ctx.has("target") ? ctx.n("target") : () => F.numOpt(o.benchmark) ?? NaN;
    const rows = sortRows(ctx.rows.filter(r => finite(val(r))), o.sort, val).slice(0, o.limit || 30);
    const all = rows.flatMap(r => [val(r), tgt(r)]).filter(finite), fmt = F.formatter(o, all);
    const max = F.numOpt(o.max) ?? d3.max(all) * 1.12, min = F.numOpt(o.min) ?? Math.min(0, d3.min(all));
    const rowH = 34, top = 22, labelW = labelWidth(ctx, rows, label), valW = 70;
    const x = d3.scaleLinear([min, max], [labelW + 6, W - valW]);
    const H = top + rows.length * rowH + 6, svg = ctx.svg(H);
    ctx.legend(F.chips([{label: ctx.name("value"), color: C.text}, {label: o.target_label || ctx.name("target") || "Target", color: C.accent, shape: "line"}]));
    const bands = o.ranges || [min + (max - min) / 3, min + (2 * (max - min)) / 3];
    const g = svg.append("g").selectAll("g").data(rows).join("g").attr("class", "frow").attr("transform", (r, i) => `translate(0,${top + i * rowH})`);
    g.append("rect").attr("class", "fhit").attr("width", W).attr("height", rowH).attr("rx", 6);
    g.append("text").attr("class", "flabel").attr("x", 4).attr("y", rowH / 2).attr("dy", "0.32em").text(r => F.truncate(label(r), labelW - 12, 13, 500));
    [[min, bands[0], C.surface3], [bands[0], bands[1], C.surface2], [bands[1], max, C.bg]].forEach(([p, q, fill]) =>
      g.append("rect").attr("x", x(p)).attr("width", Math.max(0, x(q) - x(p))).attr("y", 6).attr("height", rowH - 12).attr("fill", fill).attr("stroke", C.border).attr("stroke-width", 0.5));
    const tone = r => (finite(tgt(r)) && o.better ? ((val(r) <= tgt(r)) === (o.better === "lower") ? "good" : "bad") : "neutral");
    const bar = g.append("rect").attr("x", x(min)).attr("y", rowH / 2 - 4).attr("height", 8).attr("rx", 2).attr("width", 0)
      .attr("fill", r => (tone(r) === "neutral" ? C.text : F.toneColor(C, tone(r))));
    ctx.transition(bar, 0, 700).delay((r, i) => (ctx.anim ? i * 25 : 0)).attr("width", r => Math.max(1, x(val(r)) - x(min)));
    g.filter(r => finite(tgt(r))).append("line").attr("x1", r => x(tgt(r))).attr("x2", r => x(tgt(r))).attr("y1", 6).attr("y2", rowH - 6).attr("stroke", C.accent).attr("stroke-width", 3);
    g.append("text").attr("class", "fval").attr("x", W - 4).attr("y", rowH / 2).attr("dy", "0.32em").attr("text-anchor", "end").text(r => fmt(val(r)));
    rowHover(ctx, g, r => F.tipHtml(label(r), [[ctx.name("value"), fmt(val(r))], finite(tgt(r)) && [o.target_label || "Target", fmt(tgt(r))],
      finite(tgt(r)) && ["Gap", F.signed(fmt, val(r) - tgt(r)), tone(r)]]));
  });

  // ---- Waterfall: how contributions add up from a start to a total ----------------------------
  F.register("waterfall", ctx => {
    const {o, C, W} = ctx, label = ctx.v("label"), val = ctx.n("value");
    const steps = ctx.rows.filter(r => finite(val(r)));
    const start = F.numOpt(o.start) ?? 0;
    let run = start;
    const items = [];
    if (o.start_label) items.push({name: o.start_label, a: 0, b: start, kind: "total"});
    steps.forEach(r => { items.push({name: label(r), a: run, b: run + val(r), kind: val(r) >= 0 ? "up" : "down", row: r, v: val(r)}); run += val(r); });
    items.push({name: o.total_label || "Total", a: 0, b: run, kind: "total"});
    const fmt = F.formatter(o, items.map(i => i.b - i.a));
    const H = 330, m = {t: 26, r: 8, b: 56, l: 48};
    const x = d3.scaleBand(items.map((d, i) => i), [m.l, W - m.r]).padding(0.28);
    const y = d3.scaleLinear().domain([Math.min(0, d3.min(items, d => Math.min(d.a, d.b))), d3.max(items, d => Math.max(d.a, d.b))]).nice().range([H - m.b, m.t]);
    const svg = ctx.svg(H), gg = svg.append("g").attr("transform", `translate(${m.l},0)`);
    F.gridY(gg, y, W - m.l - m.r, C, 5, o.format ? fmt : null);
    const toneOf = d => (d.kind === "total" ? "neutral" : F.changeTone(o.better, d.b - d.a, d.a));
    const fill = d => (d.kind === "total" ? C.text2 : toneOf(d) === "neutral" ? (d.kind === "up" ? C.accent : C.sky) : F.toneColor(C, toneOf(d)));
    const g = svg.append("g").selectAll("g").data(items).join("g").attr("class", "fcol").style("cursor", d => (d.row ? "pointer" : "default"));
    const bar = g.append("rect").attr("x", (d, i) => x(i)).attr("width", x.bandwidth()).attr("rx", 3).attr("fill", fill)
      .attr("y", d => y(Math.max(d.a, d.b))).attr("height", d => Math.max(1, Math.abs(y(d.a) - y(d.b))));
    if (ctx.anim) bar.attr("opacity", 0).transition().duration(400).delay((d, i) => i * 90).attr("opacity", 1);
    items.slice(0, -1).forEach((d, i) => svg.append("line").attr("x1", x(i) + x.bandwidth()).attr("x2", x(i + 1)).attr("y1", y(d.b)).attr("y2", y(d.b)).attr("stroke", C.faint).attr("stroke-dasharray", "2 2"));
    g.append("text").attr("class", "fval sm").attr("x", (d, i) => x(i) + x.bandwidth() / 2).attr("y", d => y(Math.max(d.a, d.b)) - 6).attr("text-anchor", "middle")
      .text(d => (d.kind === "total" ? fmt(d.b) : F.signed(fmt, d.b - d.a)));
    g.append("text").attr("class", "ftick").attr("transform", (d, i) => `translate(${x(i) + x.bandwidth() / 2},${H - m.b + 14}) rotate(${x.bandwidth() < 60 ? -28 : 0})`)
      .attr("text-anchor", x.bandwidth() < 60 ? "end" : "middle").text(d => F.truncate(d.name, x.bandwidth() < 60 ? 90 : x.bandwidth() + 10, 11));
    g.on("mousemove", (ev, d) => ctx.tip.show(F.tipHtml(d.name, [[d.kind === "total" ? "Total" : "Contribution", d.kind === "total" ? fmt(d.b) : F.signed(fmt, d.b - d.a), toneOf(d)], d.kind !== "total" && ["Running total", fmt(d.b)]]), ev))
      .on("mouseleave", () => ctx.tip.hide()).on("click", (ev, d) => d.row && ctx.pick(d.row));
  });

  // ---- Waffle: share of a whole as 100 squares, one per item ----------------------------------
  F.register("waffle", ctx => {
    const {o, C, W} = ctx, label = ctx.v("label"), val = ctx.n("value");
    const rows = ctx.rows.filter(r => finite(val(r))).slice(0, o.limit || 12);
    const total = ctx.has("total") ? ctx.n("total") : () => F.numOpt(o.total) ?? d3.sum(rows, val);
    const fmtN = F.formatter({...o, unit: o.unit}, rows.map(val));
    const n = rows.length, cols = Math.max(1, Math.min(n, Math.floor(W / 170))), pw = W / cols, cell = Math.min(15, (pw - 34) / 10);
    const ph = cell * 10 + 70, H = Math.ceil(n / cols) * ph, svg = ctx.svg(H);
    rows.forEach((r, i) => {
      const share = Math.max(0, Math.min(1, val(r) / (total(r) || 1))), filled = Math.round(share * 100);
      const color = ctx.anyHi && !ctx.hi(label(r)) ? C.neutral : (o.colors && F.named(C, o.colors[i])) || C.cat[i % C.cat.length];
      const g = svg.append("g").attr("transform", `translate(${(i % cols) * pw + (pw - cell * 10) / 2},${Math.floor(i / cols) * ph})`).style("cursor", "pointer");
      g.append("text").attr("class", "fwaffle-pct").attr("y", 22).attr("fill", color).text(F.pct(share));
      g.append("text").attr("class", "fsub").attr("x", cell * 10).attr("y", 22).attr("text-anchor", "end").text(`${fmtN(val(r))} of ${fmtN(total(r))}`);
      const sq = g.append("g").attr("transform", "translate(0,32)").selectAll("rect").data(d3.range(100)).join("rect")
        .attr("x", k => (k % 10) * cell).attr("y", k => (9 - Math.floor(k / 10)) * cell).attr("width", cell - 2).attr("height", cell - 2).attr("rx", 2)
        .attr("fill", k => (k < filled ? color : C.surface3));
      if (ctx.anim) sq.attr("opacity", 0).transition().duration(300).delay(k => k * 6 + i * 60).attr("opacity", 1);
      g.append("text").attr("class", "flabel").attr("y", 32 + cell * 10 + 18).text(F.truncate(label(r), cell * 10, 13, 500));
      g.on("mousemove", ev => ctx.tip.show(F.tipHtml(label(r), [["Share", F.pct(share)], [ctx.name("value"), fmtN(val(r))], ["Of", fmtN(total(r))]]), ev))
        .on("mouseleave", () => ctx.tip.hide()).on("click", () => ctx.pick(r));
    });
  });

  // ---- Gauge: one dial per item, with good/bad zones around the benchmark ----------------------
  F.register("gauge", ctx => {
    const {o, C, W} = ctx, val = ctx.n("value"), label = ctx.has("label") ? ctx.v("label") : () => ctx.name("value");
    const rows = ctx.rows.filter(r => finite(val(r))).slice(0, o.limit || 6);
    const fmt = F.formatter(o, rows.map(val)), bench = F.numOpt(o.benchmark);
    const lo = F.numOpt(o.min) ?? Math.min(0, d3.min(rows, val));
    const hi = F.numOpt(o.max) ?? d3.nice(lo, Math.max(d3.max(rows, val), bench ?? -Infinity) * 1.3, 5)[1];
    const cols = Math.min(rows.length, Math.max(1, Math.floor(W / 260))), pw = W / cols, r0 = Math.min(pw * 0.38, 150), ph = r0 + 92;
    const H = Math.ceil(rows.length / cols) * ph, svg = ctx.svg(H);
    const ang = d3.scaleLinear([lo, hi], [-Math.PI / 2, Math.PI / 2]).clamp(true), arc = d3.arc().innerRadius(r0 * 0.74).outerRadius(r0).cornerRadius(3);
    rows.forEach((r, i) => {
      const cx = (i % cols) * pw + pw / 2, cy = Math.floor(i / cols) * ph + r0 + 22, g = svg.append("g").attr("transform", `translate(${cx},${cy})`).style("cursor", "pointer");
      if (bench != null && o.better) {
        const goodLow = o.better === "lower";
        g.append("path").attr("d", arc({startAngle: ang(lo), endAngle: ang(bench)})).attr("fill", goodLow ? C.good : C.bad).attr("opacity", 0.85);
        g.append("path").attr("d", arc({startAngle: ang(bench), endAngle: ang(hi)})).attr("fill", goodLow ? C.bad : C.good).attr("opacity", 0.85);
      } else {
        g.append("path").attr("d", arc({startAngle: ang(lo), endAngle: ang(hi)})).attr("fill", C.surface3);
        g.append("path").attr("d", arc({startAngle: ang(lo), endAngle: ang(val(r))})).attr("fill", C.accent);
      }
      [lo, ...(bench != null ? [bench] : []), hi].forEach(t => {
        const a = ang(t) - Math.PI / 2;
        g.append("text").attr("class", "ftick" + (t === bench ? " strong" : "")).attr("x", Math.cos(a) * (r0 + 14)).attr("y", Math.sin(a) * (r0 + 14))
          .attr("text-anchor", Math.abs(Math.cos(a)) < 0.2 ? "middle" : Math.cos(a) < 0 ? "end" : "start").attr("dy", "0.32em").text(fmt(t));
      });
      const needle = g.append("line").attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", -r0 * 0.9).attr("stroke", C.text).attr("stroke-width", 3).attr("stroke-linecap", "round");
      const deg = v => (ang(v) * 180) / Math.PI;
      needle.attr("transform", `rotate(${ctx.anim ? deg(lo) : deg(val(r))})`);
      if (ctx.anim) needle.transition().duration(1100).ease(d3.easeElasticOut.amplitude(1).period(0.5)).attr("transform", `rotate(${deg(val(r))})`);
      g.append("circle").attr("r", 6).attr("fill", C.text);
      const tone = bench != null && o.better ? ((val(r) <= bench) === (o.better === "lower") ? "good" : "bad") : "neutral";
      g.append("text").attr("class", "fgauge-val " + tone).attr("y", 34).attr("text-anchor", "middle").text(fmt(val(r)));
      g.append("text").attr("class", "flabel").attr("y", 56).attr("text-anchor", "middle").text(F.truncate(label(r), pw - 20, 13, 500));
      g.on("mousemove", ev => ctx.tip.show(F.tipHtml(label(r), [[ctx.name("value"), fmt(val(r))], bench != null && [o.benchmark_label || "Benchmark", fmt(bench)]]), ev))
        .on("mouseleave", () => ctx.tip.hide()).on("click", () => ctx.pick(r));
    });
  });

  // ---- Table: sortable, with inline bars and semantic cell colour -----------------------------
  F.register("table", ctx => {
    const {o, C} = ctx, rows = ctx.rows.slice(0, o.limit || 200);
    const cols = o.columns || Object.keys(rows[0] || {});
    const numeric = new Set(cols.filter(c => rows.some(r => typeof r[c] === "number") && rows.every(r => r[c] == null || typeof r[c] === "number")));
    const fmts = Object.fromEntries([...numeric].map(c => [c, F.formatter(c === ctx.f.value || c === ctx.f.bar ? o : {}, rows.map(r => r[c]))]));
    const barCol = ctx.f.bar || null, colorCol = ctx.f.color || ctx.f.value || null;
    const barMax = barCol ? d3.max(rows, r => Math.abs(r[barCol])) || 1 : 1;
    const sem = colorCol && o.better ? F.semantic(ctx, rows.map(r => +r[colorCol])) : null;
    let sortCol = o.sort_by || null, dir = o.sort === "asc" ? 1 : -1;
    const wrap = document.createElement("div"); wrap.className = "ftable"; ctx.el.append(wrap);
    const draw = () => {
      const data = [...rows];
      if (sortCol) data.sort((p, q) => (numeric.has(sortCol) ? (p[sortCol] ?? -Infinity) - (q[sortCol] ?? -Infinity) : String(p[sortCol]).localeCompare(String(q[sortCol]))) * dir);
      wrap.innerHTML = `<table><thead><tr>${cols.map(c => `<th class="${numeric.has(c) ? "num" : ""}" data-c="${esc(c)}">${esc((o.labels && o.labels[c]) || c)}${c === sortCol ? (dir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead><tbody>${
        data.map((r, i) => `<tr data-i="${rows.indexOf(r)}" class="${ctx.anyHi && cols.some(c => ctx.hi(r[c])) ? "hi" : ""}">${cols.map(c => {
          if (!numeric.has(c)) return `<td>${esc(r[c])}</td>`;
          const v = r[c], txt = fmts[c](v);
          const tint = sem && c === colorCol && v != null ? ` data-css="box-shadow: inset 3px 0 0 ${F.toneColor(C, sem.tone(v))}"` : "";
          const bar = c === barCol && v != null ? `<span class="tbar" data-css="width:${(Math.abs(v) / barMax) * 100}%"></span>` : "";
          return `<td class="num${c === barCol ? " hasbar" : ""}"${tint}>${bar}<span>${esc(txt)}</span></td>`;
        }).join("")}</tr>`).join("")}</tbody></table>` + (ctx.rows.length > rows.length ? `<div class="fsub tmore">Showing ${rows.length} of ${ctx.rows.length} rows</div>` : "");
      wrap.querySelectorAll("th").forEach(th => (th.onclick = () => { const c = th.dataset.c; dir = sortCol === c ? -dir : numeric.has(c) ? -1 : 1; sortCol = c; draw(); }));
      wrap.querySelectorAll("tbody tr").forEach(tr => (tr.onclick = () => ctx.pick(rows[+tr.dataset.i])));
    };
    draw();
  });
})();
