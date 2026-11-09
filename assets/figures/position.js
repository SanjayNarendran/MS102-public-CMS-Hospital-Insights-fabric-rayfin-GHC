/* Position figures: where units stand among their peers.
   beeswarm (every unit as a dot, quartile zones, "you are here"), forest (estimates with confidence intervals vs a
   benchmark), report_card (one unit across many measures, each against its benchmark and the peer spread) and
   scorecard (an interactive multi-measure table to search, filter and sort units). */
(function () {
  "use strict";
  const F = window.Figures, esc = F.esc, finite = Number.isFinite;
  const dirOf = b => (b === "lower" || b === "higher" ? b : null);

  // Symmetric beeswarm (after Bostock's dodge): circles of diameter d along x, no overlap, as close to y=0 as possible.
  function swarm(xs, d) {
    const d2 = d * d, items = xs.map((x, i) => ({x, i, y: 0})).sort((a, b) => a.x - b.x), out = new Array(xs.length);
    let head = null, tail = null;
    const hits = (x, y) => { for (let a = head; a; a = a.next) if (d2 - 1e-3 > (a.x - x) ** 2 + (a.y - y) ** 2) return true; return false; };
    for (const b of items) {
      while (head && head.x < b.x - d) head = head.next;
      if (hits(b.x, 0)) {
        let best = Infinity;
        for (let a = head; a; a = a.next) {
          const dy = Math.sqrt(Math.max(0, d2 - (a.x - b.x) ** 2));
          for (const y of [a.y + dy, a.y - dy]) if (Math.abs(y) < Math.abs(best) && !hits(b.x, y)) best = y;
        }
        b.y = finite(best) ? best : 0;
      }
      b.next = null;
      if (!head) head = tail = b; else tail = tail.next = b;
      out[b.i] = b.y;
    }
    return out;
  }
  // "← better · worse →" under an axis.
  F.dirHint = (g, x0, x1, y, better) => {
    if (!better) return;
    const low = better === "lower";
    g.append("text").attr("class", "fdir " + (low ? "good" : "bad")).attr("x", x0).attr("y", y).text(low ? "← better" : "← worse");
    g.append("text").attr("class", "fdir " + (low ? "bad" : "good")).attr("x", x1).attr("y", y).attr("text-anchor", "end").text(low ? "worse →" : "better →");
  };
  const dirHint = F.dirHint;

  // ---- Beeswarm: every unit as a dot on one measure, by group; quartile zones; highlighted units with percentile --
  F.register("beeswarm", ctx => {
    const {o, C, W} = ctx, val = ctx.n("value"), lv = ctx.has("label") ? ctx.v("label") : null;
    const grouped = ctx.has("group"), gv = grouped ? r => String(ctx.v("group")(r) ?? "") : () => "";
    const rows = ctx.rows.filter(r => finite(val(r)));
    if (!rows.length) return ctx.note("No values to plot.");
    const better = dirOf(o.better), bench = F.numOpt(o.benchmark), vals = rows.map(val), fmt = F.formatter(o, vals);
    const groups = grouped ? (o.order ? [...o.order.map(String), ...[...new Set(rows.map(gv))].filter(g => !o.order.map(String).includes(g))] : [...new Set(rows.map(gv))]) : [""];
    const sorted = [...vals].sort(d3.ascending);
    let lo = F.numOpt(o.min) ?? d3.quantile(sorted, sorted.length > 200 ? 0.01 : 0), hi = F.numOpt(o.max) ?? d3.quantile(sorted, sorted.length > 200 ? 0.99 : 1);
    if (bench != null) { lo = Math.min(lo, bench); hi = Math.max(hi, bench); }
    if (!(hi > lo)) { lo -= 1; hi += 1; }
    const labelW = grouped ? Math.min(W * 0.26, 210, d3.max(groups, g => Math.max(F.textWidth(g, 12.5, 650), 104)) + 20) : 0;
    const m = {l: 10 + labelW, r: 20, t: 26, b: 44};
    const x = d3.scaleLinear().domain([lo, hi]).nice().range([m.l, W - m.r]), [d0, d1] = x.domain();
    const px = v => x(Math.max(d0, Math.min(d1, v)));
    const byGroup = groups.map(g => ({g, rs: rows.filter(r => gv(r) === g)})).filter(G => G.rs.length);
    // Radius: start from an area estimate, shrink until the tallest swarm fits its band.
    const half = o.height ? o.height / 2 : grouped ? Math.max(30, Math.min(64, 260 / byGroup.length)) : 92;
    const nMax = d3.max(byGroup, G => G.rs.length), plotW = W - m.l - m.r;
    let r = F.numOpt(o.radius) ?? Math.max(1.4, Math.min(6, Math.sqrt((plotW * half * 2) / (nMax * 4.6)) * 1.25)), lay;
    for (let i = 0; i < 7; i++) {
      lay = byGroup.map(G => swarm(G.rs.map(rw => px(val(rw))), 2 * r + 0.7));
      const tall = d3.max(lay, ys => d3.max(ys, Math.abs)) || 0;
      if (tall <= half - r || r <= 1.4 || F.numOpt(o.radius) != null) break;
      r = Math.max(1.4, r * 0.84);
    }
    // Many units on one value (whole-number scores, SIRs of 0) still stack past the band: squeeze those stacks
    const cap = half * 1.5;
    if (lay.some(ys => (d3.max(ys, Math.abs) || 0) > cap)) {
      lay = lay.map(ys => { const t = d3.max(ys, Math.abs) || 0; return t > cap ? ys.map(y => (y * cap) / t) : ys; });
      ctx.note("Where many share one value, the dots overlap to keep the figure compact.");
    }
    // Dot colours: diverging around the benchmark (or median) through a mid grey that stays visible on the card.
    const sem0 = better ? F.semantic(ctx, vals) : null;
    const sem = sem0 && {...sem0, scale: d3.scaleDiverging([sem0.lo, sem0.center, sem0.hi], d3.interpolateRgbBasis(better === "lower" ? [C.good, C.neutral, C.bad] : [C.bad, C.neutral, C.good])).clamp(true)};
    const quart = o.quartiles ? [0.25, 0.5, 0.75].map(p => d3.quantile(sorted, p)) : null;
    // Band per group: room for highlight labels above.
    const his = G => (lv ? G.rs.filter(rw => ctx.hi(lv(rw))) : []);
    let yCur = m.t + (quart ? 28 : 6);
    const bands = byGroup.map((G, i) => {
      const extent = d3.max(lay[i], Math.abs) || 0, hh = Math.max(extent + r, 12), labelRoom = Math.min(his(G).length, 3) * 26;
      const top = yCur + labelRoom, cy = top + hh;
      yCur = cy + hh + (grouped ? 18 : 8);
      return {...G, cy, hh, top: top - labelRoom, ys: lay[i]};
    });
    // `over` holds the text drawn on top of everything (zone names, off-axis counts), haloed so lines don't cut through it
    const H = yCur + m.b, svg = ctx.svg(H), g = svg.append("g"), over = svg.append("g");
    // Quartile zones, named with their cut-offs next to the cut: best and worst 25% shaded by direction (the middle half
    // stays plain); with no direction, the middle half is shaded. No cut lines: the shading edges are the cuts.
    const zoneLabels = [];
    if (quart) {
      const [q1, , q3] = quart, worstHigh = better !== "higher";
      const zone = (a, b, tone, names, anchor) => {
        const xa = px(a), xb = px(b), x0 = Math.min(xa, xb), w = Math.abs(xb - xa);
        g.append("rect").attr("x", x0).attr("y", m.t).attr("width", w).attr("height", yCur - m.t).attr("class", "fzone " + tone);
        const text = names.find(t => F.textWidth(t, 10.5, 500) <= w - 12) || names[names.length - 1];
        zoneLabels.push({tone, text, anchor, x: anchor === "end" ? x0 + w - 6 : anchor === "start" ? x0 + 6 : x0 + w / 2});
      };
      const below = v => `below ${fmt(v)}`, above = v => `above ${fmt(v)}`;
      const best = o.best_label || "Best 25%", worst = o.worst_label || "Worst 25%";
      if (better) {
        zone(worstHigh ? d0 : q3, worstHigh ? q1 : d1, "good", [`${best} · ${worstHigh ? below(q1) : above(q3)}`, best], worstHigh ? "end" : "start");
        zone(worstHigh ? q3 : d0, worstHigh ? d1 : q1, "bad", [`${worst} · ${worstHigh ? above(q3) : below(q1)}`, worst], worstHigh ? "start" : "end");
      } else {
        zone(q1, q3, "mid", [`Middle 50% · ${fmt(q1)}–${fmt(q3)}`, "Middle 50%"], "middle");
      }
    }
    const ticks = x.ticks(Math.max(3, Math.floor(plotW / 80))), tf = F.tickFmt(fmt, ticks);
    ticks.forEach(t => {
      g.append("line").attr("x1", x(t)).attr("x2", x(t)).attr("y1", m.t).attr("y2", yCur).attr("stroke", C.grid);
      g.append("text").attr("class", "ftick").attr("x", x(t)).attr("y", yCur + 16).attr("text-anchor", "middle").text(tf(t));
    });
    dirHint(g, m.l, W - m.r, yCur + 34, better);
    if (o.axis_label || !better) g.append("text").attr("class", "faxis-title").attr("x", (m.l + W - m.r) / 2).attr("y", yCur + 34).attr("text-anchor", "middle").text(o.axis_label || ctx.name("value"));
    // Reference lines across the plot, each named above it: the benchmark (dashed) and, for a single swarm, the median
    // (solid). When the two names would collide they open away from each other.
    const refs = [];
    if (bench != null) refs.push({v: bench, cls: "fbench", text: o.benchmark_label || `Benchmark ${fmt(bench)}`});
    if (!grouped) { const med = d3.median(vals); refs.push({v: med, cls: "fmed", text: `Median ${fmt(med)}`}); }
    refs.sort((a, b) => a.v - b.v).forEach(rf => { rf.x = px(rf.v); rf.w = F.textWidth(rf.text, 10.5, 600); rf.anchor = "middle"; });
    const span = rf => (rf.anchor === "end" ? [rf.x - 4 - rf.w, rf.x - 4] : rf.anchor === "start" ? [rf.x + 4, rf.x + 4 + rf.w] : [rf.x - rf.w / 2, rf.x + rf.w / 2]);
    if (refs.length === 2 && span(refs[0])[1] + 10 > span(refs[1])[0]) { refs[0].anchor = "end"; refs[1].anchor = "start"; }
    refs.forEach(rf => {
      const [a, b] = span(rf);
      if (b > W - 2) rf.anchor = "end"; else if (a < 2) rf.anchor = "start";
      g.append("line").attr("class", rf.cls).attr("x1", rf.x).attr("x2", rf.x).attr("y1", m.t - 4).attr("y2", yCur);
      g.append("text").attr("class", "fbench-label").attr("x", rf.anchor === "end" ? rf.x - 4 : rf.anchor === "start" ? rf.x + 4 : rf.x).attr("y", m.t - 8)
        .attr("text-anchor", rf.anchor).text(rf.text);
    });
    zoneLabels.forEach(z => over.append("text").attr("class", "fzone-label halo " + z.tone).attr("x", z.x).attr("y", m.t + 15).attr("text-anchor", z.anchor).text(z.text));
    const pts = [];
    bands.forEach((B, bi) => {
      const gvals = B.rs.map(val), med = d3.median(gvals);
      if (grouped) {
        const lg = g.append("g").attr("transform", `translate(4,${B.cy})`);
        lg.append("text").attr("class", "fgl" + (ctx.hi(B.g) ? " strong" : "")).attr("y", -3).text(F.truncate(B.g, labelW - 14, 12.5, 650));
        lg.append("text").attr("class", "fsub").attr("y", 12).text(`n ${d3.format(",")(B.rs.length)} · median ${fmt(med)}`);
        if (bi) g.append("line").attr("x1", 4).attr("x2", W - m.r).attr("y1", B.top - 9).attr("y2", B.top - 9).attr("stroke", C.border);
      }
      if (grouped) g.append("line").attr("class", "fmed").attr("x1", px(med)).attr("x2", px(med)).attr("y1", B.cy - B.hh - 3).attr("y2", B.cy + B.hh + 3);
      const dots = g.append("g").selectAll("circle").data(B.rs).join("circle")
        .attr("cx", rw => px(val(rw))).attr("cy", (rw, i) => B.cy + B.ys[i]).attr("r", r)
        .attr("fill", rw => (sem ? sem.scale(val(rw)) : C.accent))
        .attr("fill-opacity", rw => (ctx.anyHi && !(lv && ctx.hi(lv(rw))) ? 0.5 : 0.9));
      if (ctx.anim) dots.attr("cx", px(med)).attr("opacity", 0).transition().duration(700).delay((rw, i) => Math.min(500, i * 0.4)).ease(d3.easeCubicOut)
        .attr("cx", rw => px(val(rw))).attr("opacity", 1);
      B.rs.forEach((rw, i) => pts.push([px(val(rw)), B.cy + B.ys[i], rw, gvals]));
      // Values beyond the axis pile up at its edge; their count sits right above the pile
      [[v => v > d1, x(d1), "end", n => `${n} above ${fmt(d1)}`], [v => v < d0, x(d0), "start", n => `${n} below ${fmt(d0)}`]].forEach(([out, ex, anchor, text]) => {
        const ys = B.rs.map((rw, i) => (out(val(rw)) ? B.ys[i] : null)).filter(v => v != null);
        if (ys.length) over.append("text").attr("class", "fsub halo").attr("x", ex + (anchor === "end" ? -2 : 2)).attr("y", B.cy + d3.min(ys) - r - 6)
          .attr("text-anchor", anchor).text(text(d3.format(",")(ys.length)));
      });
      // Highlighted units: ring + label with their percentile among the group.
      const placed = [];
      his(B).sort((a, b) => val(a) - val(b)).forEach(rw => {
        const i = B.rs.indexOf(rw), cx = px(val(rw)), cy = B.cy + B.ys[i], beat = F.beats(gvals, val(rw), better || "higher");
        g.append("circle").attr("cx", cx).attr("cy", cy).attr("r", r + 6.5).attr("fill", C.surface).attr("fill-opacity", 0.6).attr("stroke", C.text).attr("stroke-width", 2.2);
        g.append("circle").attr("cx", cx).attr("cy", cy).attr("r", r + 2.5).attr("fill", sem ? sem.scale(val(rw)) : C.accent).attr("stroke", C.surface).attr("stroke-width", 1.2);
        const pctTxt = !better ? `higher than ${F.pct(beat)}` : beat >= 0.5 ? `better than ${F.pct(beat)} of ${d3.format(",")(gvals.length)}` : `worse than ${F.pct(1 - beat)} of ${d3.format(",")(gvals.length)}`;
        const t1 = `${F.truncate(lv(rw), 210, 12, 700)}  ${fmt(val(rw))}`, w = Math.max(F.textWidth(t1, 12, 700), F.textWidth(pctTxt, 11, 600));
        let level = 0;
        while (level < 2 && placed.some(p => p.level === level && Math.abs(p.x - cx) < (p.w + w) / 2 + 10)) level++;
        placed.push({x: cx, w, level});
        const ly = B.cy - B.hh - 10 - level * 26, anchor = cx + w / 2 > W - 6 ? "end" : cx - w / 2 < m.l - labelW + 4 ? "start" : "middle";
        g.append("line").attr("class", "fleader").attr("x1", cx).attr("x2", cx).attr("y1", cy - r - 5).attr("y2", ly + 4);
        const lt = g.append("text").attr("class", "fhl").attr("x", cx).attr("y", ly - 12).attr("text-anchor", anchor);
        lt.append("tspan").text(t1);
        lt.append("tspan").attr("x", cx).attr("dy", 13).attr("class", "fhl-sub " + (better ? (beat >= 0.5 ? "good" : "bad") : "")).text(pctTxt);
      });
    });
    const clipped = vals.filter(v => v < d0 || v > d1).length;
    if (clipped) ctx.note(`${d3.format(",")(clipped)} outside ${fmt(d0)}–${fmt(d1)} are stacked at the edges of the axis.`);
    if (grouped) ctx.legend(F.chips([{label: `Median of each ${ctx.name("group").toLowerCase()}`, color: C.text2, shape: "tick"}]));
    F.nearest(ctx, svg, pts, [m.l, m.t, plotW, yCur - m.t], p => {
      const rw = p, gvals = pts.find(q => q[2] === rw)[3], v = val(rw), beat = F.beats(gvals, v, better || "higher");
      return F.tipHtml(lv ? lv(rw) : fmt(v), [[ctx.name("value"), fmt(v), sem ? sem.tone(v) : ""], grouped && [ctx.name("group"), gv(rw)],
        [better ? "Better than" : "Higher than", `${F.pct(beat)} of ${d3.format(",")(gvals.length)}`], bench != null && ["vs " + (o.benchmark_label || "benchmark"), F.signed(fmt, v - bench), sem ? sem.tone(v) : ""]]);
    }, rw => ctx.pick(rw, [["Percentile", F.pct(F.beats(pts.find(q => q[2] === rw)[3], val(rw), better || "higher"))]]), Math.max(10, r * 3));
  });

  // ---- Forest: estimate with confidence interval per unit, classified against the benchmark --------
  F.register("forest", ctx => {
    const {o, C, W} = ctx, label = ctx.v("label"), val = ctx.n("value"), lov = ctx.has("lower") ? ctx.n("lower") : () => NaN, upv = ctx.has("upper") ? ctx.n("upper") : () => NaN;
    const sub = ctx.has("sublabel") ? ctx.v("sublabel") : null, gv = ctx.has("group") ? r => String(ctx.v("group")(r) ?? "") : null, wv = ctx.has("weight") ? ctx.n("weight") : null;
    const better = dirOf(o.better), bench = F.numOpt(o.benchmark);
    const summaries = new Set([].concat(o.summary ?? []).map(String)), isSum = r => summaries.has(String(label(r)));
    const all = ctx.rows.filter(r => finite(val(r)));
    const cls = r => {
      if (bench == null) return "neutral";
      const l = lov(r), u = upv(r);
      const side = finite(u) && u < bench ? "below" : finite(l) && l > bench ? "above" : "within";
      return side === "within" ? "neutral" : !better ? side : (side === "below") === (better === "lower") ? "good" : "bad";
    };
    const tone = c => (c === "good" || c === "bad" ? c : "neutral");
    const statusText = c => ({good: "Better than benchmark", bad: "Worse than benchmark", neutral: "No different", below: "Significantly lower", above: "Significantly higher"}[c]);
    const dir = o.sort === "asc" || o.sort === "desc" || o.sort === "none" ? o.sort : better === "higher" ? "asc" : "desc";
    let main = all.filter(r => !isSum(r)), sums = all.filter(isSum);
    const limit = o.limit || 40;
    if (main.length > limit) {
      const keep = new Set(main.filter(r => ctx.hi(label(r))));
      F.sortRows([...main], dir, val).forEach(r => keep.size < limit && keep.add(r));
      ctx.note(`Showing ${limit} of ${d3.format(",")(main.length)} (highlighted first, then the most extreme).`);
      main = main.filter(r => keep.has(r));
    }
    const groups = gv ? (o.order ? [...o.order.map(String), ...[...new Set(main.map(gv))].filter(g => !o.order.map(String).includes(g))] : [...new Set(main.map(gv))]) : [null];
    const ordered = groups.flatMap(gk => {
      const rs = F.sortRows(main.filter(r => !gv || gv(r) === gk), dir, val);
      return gk == null ? rs.map(r => ({r})) : [{header: gk, n: rs.length}, ...rs.map(r => ({r}))];
    });
    if (sums.length) ordered.push({rule: true}, ...sums.map(r => ({r, sum: true})));
    const shown = ordered.filter(e => e.r).map(e => e.r);
    const fmt = F.formatter(o, shown.flatMap(r => [val(r), lov(r), upv(r)]).filter(finite));
    const ciTxt = r => (finite(lov(r)) && finite(upv(r)) ? `${fmt(lov(r))}–${fmt(upv(r))}` : "");
    const rightW = d3.max(shown, r => F.textWidth(fmt(val(r)), 12.5, 700) + F.textWidth(ciTxt(r), 11.5, 500)) + 26;
    const labelW = F.labelWidth(ctx, shown, label, 0.34, sub), rowH = sub ? 36 : 27, headH = 28, ruleH = 12;
    const ext = shown.flatMap(r => [val(r), lov(r), upv(r)]).filter(finite).concat(bench != null ? [bench] : []);
    const ups = shown.map(upv).filter(finite).sort(d3.ascending);
    let lo = F.numOpt(o.min) ?? d3.min(ext), hi = F.numOpt(o.max) ?? d3.max(ext);
    if (F.numOpt(o.max) == null && ups.length > 4 && hi > 2.5 * d3.quantile(ups, 0.85)) hi = Math.max(d3.quantile(ups, 0.85) * 1.35, d3.max(shown, val) * 1.05, bench ?? -Infinity);
    const logX = !!o.log;
    if (logX) lo = Math.max(lo, (d3.min(ext.filter(v => v > 0)) || 0.01) * 0.8);
    const x = (logX ? d3.scaleLog() : d3.scaleLinear()).domain([logX ? lo : Math.min(0, lo), hi]).range([labelW + 14, W - rightW - 8]);
    if (!logX) x.nice();
    const [d0, d1] = x.domain(), cx = v => x(Math.max(d0, Math.min(d1, v)));
    const top = 30;
    let y = top;
    const pos = ordered.map(e => { const p = y; y += e.header ? headH : e.rule ? ruleH : rowH; return p; });
    const H = y + 46, svg = ctx.svg(H), g = svg.append("g");
    const ticks = logX ? x.ticks(6).filter(t => /^[125]/.test(d3.format("~e")(t))) : x.ticks(Math.max(3, Math.floor((x.range()[1] - x.range()[0]) / 80)));
    const tf = F.tickFmt(fmt, ticks);
    ticks.forEach(t => {
      g.append("line").attr("x1", x(t)).attr("x2", x(t)).attr("y1", top - 6).attr("y2", y).attr("stroke", C.grid);
      g.append("text").attr("class", "ftick").attr("x", x(t)).attr("y", y + 16).attr("text-anchor", "middle").text(tf(t));
    });
    dirHint(g, x.range()[0], x.range()[1], y + 34, better);
    g.append("text").attr("class", "fhead-r").attr("x", W - 4).attr("y", top - 12).attr("text-anchor", "end").text(o.ci_label || `${ctx.name("value")} [95% CI]`);
    if (bench != null) {
      g.append("line").attr("class", "fbench solid").attr("x1", x(bench)).attr("x2", x(bench)).attr("y1", top - 6).attr("y2", y);
      g.append("text").attr("class", "fbench-label").attr("x", x(bench)).attr("y", top - 12).attr("text-anchor", "middle").text(o.benchmark_label || `Benchmark ${fmt(bench)}`);
    }
    const wScale = wv ? d3.scaleSqrt(d3.extent(shown, wv).map(v => (finite(v) ? v : 0)), [4.5, 11]) : null;
    ordered.forEach((e, i) => {
      const yy = pos[i];
      if (e.header) {
        g.append("text").attr("class", "fgroup-h").attr("x", 4).attr("y", yy + 18).text(e.header.toUpperCase());
        g.append("line").attr("x1", 4).attr("x2", W).attr("y1", yy + 24).attr("y2", yy + 24).attr("stroke", C.border);
        return;
      }
      if (e.rule) { g.append("line").attr("x1", 4).attr("x2", W).attr("y1", yy + ruleH / 2).attr("y2", yy + ruleH / 2).attr("stroke", C.border_strong || C.border).attr("stroke-width", 1.4); return; }
      const r = e.r, c = cls(r), col = e.sum ? C.text : F.toneColor(C, tone(c));
      const row = g.append("g").attr("class", "frow" + (ctx.hi(label(r)) ? " hi" : "")).attr("transform", `translate(0,${yy})`).datum(r);
      row.append("rect").attr("class", "fhit").attr("x", 0).attr("width", W).attr("height", rowH).attr("rx", 6);
      const my = rowH / 2, ly = sub ? my - 7 : my;
      row.append("text").attr("class", "flabel" + (ctx.hi(label(r)) || e.sum ? " strong" : "")).attr("x", 6).attr("y", ly).attr("dy", "0.32em").text(F.truncate(label(r), labelW - 12, 13, 500));
      if (sub) row.append("text").attr("class", "fsub").attr("x", 6).attr("y", my + 9).attr("dy", "0.32em").text(F.truncate(sub(r), labelW - 12, 11));
      const l = lov(r), u = upv(r), v = val(r);
      if (finite(l) && finite(u)) {
        if (e.sum) {
          row.append("path").attr("d", `M${cx(l)},${my} L${cx(v)},${my - 7} L${cx(u)},${my} L${cx(v)},${my + 7} Z`).attr("fill", col);
        } else {
          row.append("line").attr("x1", cx(l)).attr("x2", cx(u)).attr("y1", my).attr("y2", my).attr("stroke", col).attr("stroke-width", 2).attr("stroke-linecap", "round");
          [[l, d0], [u, d1]].forEach(([b, edge]) => {
            if ((b < d0 || b > d1)) row.append("path").attr("d", b > d1 ? `M${cx(b) - 6},${my - 4} L${cx(b)},${my} L${cx(b) - 6},${my + 4}` : `M${cx(b) + 6},${my - 4} L${cx(b)},${my} L${cx(b) + 6},${my + 4}`).attr("fill", "none").attr("stroke", col).attr("stroke-width", 1.8);
            else row.append("line").attr("x1", cx(b)).attr("x2", cx(b)).attr("y1", my - 4).attr("y2", my + 4).attr("stroke", col).attr("stroke-width", 1.6);
          });
        }
      }
      if (!e.sum || !(finite(l) && finite(u))) {
        const s = wScale && finite(wv(r)) ? wScale(wv(r)) : 5.2;
        const mk = row.append("rect").attr("x", cx(v) - s).attr("y", my - s).attr("width", 2 * s).attr("height", 2 * s).attr("rx", 2).attr("fill", col).attr("stroke", C.surface).attr("stroke-width", 1.2);
        if (ctx.anim) mk.attr("opacity", 0).transition().delay(Math.min(600, i * 18)).duration(300).attr("opacity", 1);
      }
      if (ctx.hi(label(r))) row.append("rect").attr("x", cx(v) - 10).attr("y", my - 10).attr("width", 20).attr("height", 20).attr("rx", 4).attr("fill", "none").attr("stroke", C.text).attr("stroke-width", 1.6);
      const vt = row.append("text").attr("x", W - 4).attr("y", my).attr("dy", "0.32em").attr("text-anchor", "end");
      vt.append("tspan").attr("class", "fval sm " + (e.sum ? "" : tone(c))).text(fmt(v));
      if (ciTxt(r)) vt.append("tspan").attr("class", "fci").text(`  ${ciTxt(r)}`);
    });
    F.rowHover(ctx, g.selectAll(".frow"), r => F.tipHtml(label(r), [[ctx.name("value"), fmt(val(r)), tone(cls(r))], ciTxt(r) && ["95% CI", ciTxt(r)],
      bench != null && ["Status", statusText(cls(r)), tone(cls(r))], wv && finite(wv(r)) && [ctx.name("weight"), d3.format(",.4~r")(wv(r))]], sub ? sub(r) : ""));
    if (bench != null && better && ctx.has("lower")) {
      const c = d3.rollup(all.filter(r => !isSum(r)), v => v.length, r => tone(cls(r)));
      ctx.legend(F.chips([{label: "Better", color: C.good, count: c.get("good") || 0}, {label: "No different", color: C.neutral, count: c.get("neutral") || 0}, {label: "Worse", color: C.bad, count: c.get("bad") || 0}]));
      ctx.note("Coloured when the whole 95% interval is on one side of the benchmark; an interval that crosses it is no different.");
    }
  });

  // ---- Report card: one unit across many measures, grouped by domain --------------------------------
  // Each measure: value vs its benchmark, where it sits in the peer spread (p10-p90, oriented so right = better),
  // a sparkline over time and a status badge (significance from a CI, else quartile from the peer spread).
  F.register("report_card", ctx => {
    const {o, C, W} = ctx, mv = r => String(ctx.v("measure")(r)), val = ctx.n("value");
    const opt = role => (ctx.has(role) ? ctx.n(role) : () => NaN), bv = opt("benchmark"), lov = opt("lower"), upv = opt("upper");
    const qRoles = ["p10", "p25", "p50", "p75", "p90"].filter(q => ctx.has(q)), qv = Object.fromEntries(qRoles.map(q => [q, ctx.n(q)]));
    const gv = ctx.has("group") ? r => String(ctx.v("group")(r) ?? "") : () => "", sub = ctx.has("sublabel") ? ctx.v("sublabel") : null;
    const xv = ctx.has("x") ? ctx.v("x") : null, xs = xv ? F.xDomain(ctx.rows, xv) : null, xi = v => xs.findIndex(t => String(t) === String(v));
    const items = d3.groups(ctx.rows.filter(r => finite(val(r))), mv).map(([name, rs]) => {
      if (xv) rs = rs.sort((a, b) => xi(xv(a)) - xi(xv(b)));
      const row = rs[rs.length - 1], better = F.betterFor(ctx, name, row);
      const bench = finite(bv(row)) ? bv(row) : F.numOpt((o.benchmarks || {})[name]) ?? F.numOpt(o.benchmark);
      const q = Object.fromEntries(qRoles.map(k => [k, qv[k](row)]).filter(([, v]) => finite(v)));
      const all = [val(row), bench, lov(row), upv(row), ...Object.values(q)].filter(finite);
      const fmt = F.formatter({format: (o.formats || {})[name] ?? o.format, unit: (o.units || {})[name] ?? o.unit}, all);
      let status = null;
      if (finite(lov(row)) && finite(upv(row)) && bench != null && better) {
        status = upv(row) < bench ? (better === "lower" ? "good" : "bad") : lov(row) > bench ? (better === "lower" ? "bad" : "good") : "neutral";
        status = {tone: status, text: status === "good" ? "Better" : status === "bad" ? "Worse" : "No different"};
      } else if (q.p25 != null && q.p75 != null && better) {
        const v = val(row), top = better === "lower" ? v <= q.p25 : v >= q.p75, bottom = better === "lower" ? v >= q.p75 : v <= q.p25;
        status = {tone: top ? "good" : bottom ? "bad" : "neutral", text: top ? "Top quartile" : bottom ? "Bottom quartile" : "Middle half"};
      } else if (bench != null && better) {
        const t = F.toneVs(better, val(row), bench, Math.abs(bench) * 0.02);
        status = {tone: t, text: t === "good" ? "Better" : t === "bad" ? "Worse" : "At benchmark"};
      }
      // Approximate percentile from the peer quantiles: share of peers this unit beats.
      let beat = NaN;
      const knots = [[0.1, q.p10], [0.25, q.p25], [0.5, q.p50], [0.75, q.p75], [0.9, q.p90]].filter(k => finite(k[1]));
      if (knots.length >= 3 && better) {
        const v = val(row), cdf = v <= knots[0][1] ? knots[0][0] * (v < knots[0][1] ? 0.6 : 1) : v >= knots[knots.length - 1][1] ? 1 - (1 - knots[knots.length - 1][0]) * (v > knots[knots.length - 1][1] ? 0.6 : 1)
          : (() => { for (let i = 1; i < knots.length; i++) if (v <= knots[i][1]) { const [p0, v0] = knots[i - 1], [p1, v1] = knots[i]; return p0 + (p1 - p0) * (v1 === v0 ? 0.5 : (v - v0) / (v1 - v0)); } return 0.5; })();
        beat = Math.max(0.01, Math.min(0.99, better === "lower" ? 1 - cdf : cdf));
      }
      return {name, group: gv(row), row, rs, value: val(row), bench, q, better, fmt, status, beat, series: xv ? rs.map(r => [xv(r), val(r)]) : null};
    });
    if (!items.length) return ctx.note("No measures to show.");
    // order sorts the groups (domains) when there is a group role, otherwise the measures.
    const ord = (o.order || []).map(String), at = k => (ord.includes(k) ? ord.indexOf(k) : ord.length);
    if (!ctx.has("group") && ord.length) items.sort((a, b) => at(a.name) - at(b.name));
    const seen = [...new Set(items.map(i => i.group))];
    const groups = ctx.has("group") && ord.length ? [...ord.filter(g => seen.includes(g)), ...seen.filter(g => !ord.includes(g))] : seen;
    const narrow = W < 620, tiny = W < 470, hasSpark = !!xv && !narrow && items.some(i => i.series && i.series.length > 1);
    const nameW = Math.min(tiny ? W * 0.5 : W * 0.32, 270), valW = 112, badgeW = items.some(i => i.status) ? 104 : 0, sparkW = hasSpark ? 92 : 0;
    const stripW = tiny ? 0 : W - nameW - valW - badgeW - sparkW - 22;
    const rowH = 46, headH = 34, top = 30;
    const counts = d3.rollup(items.filter(i => i.status), v => v.length, i => i.status.tone);
    if (counts.size) ctx.legend(F.chips([{label: "Better", color: C.good, count: counts.get("good") || 0}, {label: "No different / middle", color: C.neutral, count: counts.get("neutral") || 0}, {label: "Worse", color: C.bad, count: counts.get("bad") || 0}]));
    let y = top;
    const layout = [];
    groups.forEach(gk => {
      const its = items.filter(i => i.group === gk);
      if (!its.length) return;
      if (gk) { layout.push({head: gk, y, its}); y += headH; }
      its.forEach(it => { layout.push({it, y}); y += rowH; });
    });
    const H = y + 8, svg = ctx.svg(H), g = svg.append("g");
    const x0 = nameW + valW + 8;
    if (stripW > 60) {
      const full = o.strip_label || (qRoles.length ? "Peers 10th–90th · box = middle half · right = better" : "vs benchmark · right = better");
      const fits = t => F.textWidth(t, 10.5, 700) * 1.1 < stripW;  // uppercase + letter-spacing run ~10% wider
      const label = [full, qRoles.length ? "Peer spread · right = better" : null, "Right = better"].find(t => t && fits(t)) || "Better →";
      g.append("text").attr("class", "fhead-r").attr("x", x0).attr("y", 14).text(label);
    }
    if (hasSpark) g.append("text").attr("class", "fhead-r").attr("x", x0 + stripW + 10 + sparkW / 2).attr("y", 14).attr("text-anchor", "middle").text(`${xs[0]}–${xs[xs.length - 1]}`);
    layout.forEach(L => {
      if (L.head) {
        const c = d3.rollup(L.its.filter(i => i.status), v => v.length, i => i.status.tone);
        g.append("text").attr("class", "fgroup-h").attr("x", 4).attr("y", L.y + 22).text(L.head.toUpperCase());
        const parts = [["good", "better"], ["bad", "worse"]].filter(([k]) => c.get(k)).map(([k, t]) => `${c.get(k)} ${t}`);
        if (parts.length) g.append("text").attr("class", "fsub").attr("x", W - 4).attr("y", L.y + 22).attr("text-anchor", "end").text(parts.join(" · "));
        g.append("line").attr("x1", 4).attr("x2", W).attr("y1", L.y + 29).attr("y2", L.y + 29).attr("stroke", C.border);
        return;
      }
      const it = L.it, tone = it.status ? it.status.tone : "neutral", col = F.toneColor(C, tone);
      const row = g.append("g").attr("class", "frow").attr("transform", `translate(0,${L.y})`).datum(it.row).style("opacity", ctx.anyHi && !ctx.hi(it.name) ? 0.45 : 1);
      row.append("rect").attr("class", "fhit").attr("width", W).attr("height", rowH - 2).attr("rx", 8);
      row.append("text").attr("class", "flabel" + (ctx.hi(it.name) ? " strong" : "")).attr("x", 8).attr("y", sub ? 17 : rowH / 2 - 1).attr("dy", "0.32em").text(F.truncate(it.name, nameW - 14, 13, 550));
      if (sub && sub(it.row)) row.append("text").attr("class", "fsub").attr("x", 8).attr("y", 33).text(F.truncate(sub(it.row), nameW - 14, 11));
      const vx = nameW + 4;
      row.append("text").attr("class", "frc-val " + tone).attr("x", vx).attr("y", 20).text(it.fmt(it.value));
      if (it.bench != null) {
        const dlt = it.value - it.bench;
        row.append("text").attr("class", "fsub").attr("x", vx).attr("y", 36).text(`${F.signed(it.fmt, dlt)} vs ${o.benchmark_label || "benchmark"}`);
      } else if (it.series && it.series.length > 1) {
        const first = it.series[0][1], dlt = it.value - first;
        row.append("text").attr("class", "fsub " + F.changeTone(it.better, dlt, it.series[0][1])).attr("x", vx).attr("y", 36).text(`${F.signed(it.fmt, dlt)} vs ${it.series[0][0]}`);
      }
      // Peer strip, oriented so right = better.
      if (stripW > 60) {
        const ext = [it.value, it.bench, ...Object.values(it.q)].filter(finite);
        let [a, b] = d3.extent(ext);
        const pad = (b - a || Math.abs(a) || 1) * 0.12;
        a -= pad; b += pad;
        const sx = d3.scaleLinear([a, b], it.better === "lower" ? [x0 + stripW, x0] : [x0, x0 + stripW]), my = rowH / 2 - 1;
        row.append("line").attr("x1", x0).attr("x2", x0 + stripW).attr("y1", my).attr("y2", my).attr("class", "frc-track");
        const q = it.q;
        if (q.p10 != null && q.p90 != null) row.append("line").attr("x1", sx(q.p10)).attr("x2", sx(q.p90)).attr("y1", my).attr("y2", my).attr("class", "frc-whisk");
        if (q.p25 != null && q.p75 != null) row.append("rect").attr("x", Math.min(sx(q.p25), sx(q.p75))).attr("width", Math.abs(sx(q.p75) - sx(q.p25))).attr("y", my - 6).attr("height", 12).attr("rx", 4).attr("class", "frc-box");
        if (q.p50 != null) row.append("line").attr("x1", sx(q.p50)).attr("x2", sx(q.p50)).attr("y1", my - 8).attr("y2", my + 8).attr("class", "fmed");
        if (it.bench != null) row.append("line").attr("x1", sx(it.bench)).attr("x2", sx(it.bench)).attr("y1", my - 12).attr("y2", my + 12).attr("class", "fbench");
        if (finite(lov(it.row)) && finite(upv(it.row))) row.append("line").attr("x1", sx(Math.max(a, lov(it.row)))).attr("x2", sx(Math.min(b, upv(it.row)))).attr("y1", my).attr("y2", my).attr("stroke", col).attr("stroke-width", 3).attr("stroke-linecap", "round").attr("opacity", 0.55);
        const dot = row.append("circle").attr("cx", sx(it.value)).attr("cy", my).attr("r", 6).attr("fill", tone === "neutral" ? C.text2 : col).attr("stroke", C.surface).attr("stroke-width", 2);
        if (ctx.anim) dot.attr("cx", sx(q.p50 ?? it.bench ?? it.value)).transition().duration(700).ease(d3.easeCubicOut).attr("cx", sx(it.value));
      }
      if (hasSpark && it.series && it.series.length > 1) {
        const sx0 = x0 + stripW + 10, s = it.series.map(p => p[1]), ext = d3.extent(s);
        const sy = d3.scaleLinear(ext[0] === ext[1] ? [ext[0] - 1, ext[1] + 1] : ext, [rowH - 12, 10]), sxx = d3.scaleLinear([0, s.length - 1], [sx0, sx0 + sparkW - 6]);
        const ct = F.changeTone(it.better, s[s.length - 1] - s[0], s[0]), sc = ct === "neutral" ? C.muted : F.toneColor(C, ct);
        row.append("path").attr("d", d3.line().x((p, j) => sxx(j)).y(p => sy(p)).curve(d3.curveMonotoneX)(s)).attr("fill", "none").attr("stroke", sc).attr("stroke-width", 1.8);
        row.append("circle").attr("cx", sxx(s.length - 1)).attr("cy", sy(s[s.length - 1])).attr("r", 2.6).attr("fill", sc);
      }
      if (it.status) {
        const bw = Math.min(badgeW - 8, F.textWidth(it.status.text, 11, 650) + 18), bx = W - 4 - bw;
        row.append("rect").attr("x", bx).attr("y", rowH / 2 - 12).attr("width", bw).attr("height", 22).attr("rx", 11).attr("class", "fbadge " + tone);
        row.append("text").attr("class", "fbadge-t " + tone).attr("x", bx + bw / 2).attr("y", rowH / 2 - 1).attr("dy", "0.32em").attr("text-anchor", "middle").text(it.status.text);
      }
    });
    const byRow = new Map(items.map(i => [i.row, i]));
    F.rowHover(ctx, g.selectAll(".frow"), r => {
      const it = byRow.get(r), l = lov(r), u = upv(r);
      return F.tipHtml(it.name, [[o.value_label || "Value", it.fmt(it.value), it.status ? it.status.tone : ""], it.bench != null && [o.benchmark_label || "Benchmark", it.fmt(it.bench)],
        finite(l) && finite(u) && ["95% CI", `${it.fmt(l)}–${it.fmt(u)}`], it.q.p50 != null && ["Peer median", it.fmt(it.q.p50)],
        finite(it.beat) && ["Better than", `≈${F.pct(it.beat)} of peers`], it.series && it.series.length > 1 && [`Since ${it.series[0][0]}`, F.signed(it.fmt, it.value - it.series[0][1]), F.changeTone(it.better, it.value - it.series[0][1])],
        it.better && ["Better is", it.better]], it.group || "");
    });
  });

  // ---- Scorecard: interactive multi-measure table (search, filter chips, sort, pages) -------------
  F.register("scorecard", ctx => {
    const {o, C} = ctx, label = ctx.v("label"), sub = ctx.has("sublabel") ? ctx.v("sublabel") : null, badge = ctx.has("badge") ? ctx.v("badge") : null;
    const st = ctx.state, mapped = new Set(Object.values(ctx.f));
    const numeric = k => ctx.rows.some(r => r[k] != null && r[k] !== "" && finite(+r[k]));
    let cols = [].concat(o.columns || []).map(c => (typeof c === "string" ? {col: c} : c)).filter(c => c && c.col && ctx.rows.some(r => c.col in r));
    if (!cols.length) cols = Object.keys(ctx.rows[0] || {}).filter(k => !mapped.has(k) && k !== o.filter).map(col => ({col}));
    cols = cols.map(c => {
      const isNum = numeric(c.col), vals = isNum ? ctx.rows.map(r => +r[c.col]).filter((v, i) => ctx.rows[i][c.col] != null && ctx.rows[i][c.col] !== "" && finite(v)) : [];
      const better = dirOf(c.better ?? (o.better_by || {})[c.col] ?? o.better);
      const type = c.type || (!isNum ? "text" : F.isStarScale(vals) && /star/i.test(c.col + (c.label || "")) ? "stars" : "num");
      const s = [...vals].sort(d3.ascending), q1 = d3.quantile(s, 0.25), q3 = d3.quantile(s, 0.75);
      const bench = F.numOpt(c.benchmark);
      const tone = v => !finite(v) || !better || type === "stars" ? "neutral" : bench != null ? F.toneVs(better, v, bench, c.tolerance ?? 0)
        : (better === "lower" ? (v <= q1 ? "good" : v >= q3 ? "bad" : "neutral") : (v >= q3 ? "good" : v <= q1 ? "bad" : "neutral"));
      return {...c, isNum, type, better, bench, tone, fmt: F.formatter({format: c.format ?? (o.formats || {})[c.col], unit: c.unit}, vals),
        lo: d3.quantile(s, 0.03), hi: d3.quantile(s, 0.97), label: c.label || c.col};
    });
    const get = (r, c) => (c.isNum ? (r[c.col] == null || r[c.col] === "" ? NaN : +r[c.col]) : r[c.col]);
    const filterVals = o.filter && ctx.rows.some(r => o.filter in r) ? (vs => (F.isStarScale(vs) ? vs.sort((a, b) => b - a) : vs.sort(F.natural)))([...new Set(ctx.rows.map(r => r[o.filter]).filter(v => v != null && v !== ""))]) : null;
    st.sc ||= {q: "", filter: null, page: 0, sort: o.sort_by || cols.find(c => c.isNum)?.col, dir: null};
    const S = st.sc;
    const sortCol = cols.find(c => c.col === S.sort);
    if (S.dir == null && sortCol) S.dir = sortCol.better === "lower" ? "asc" : "desc";
    const wrap = document.createElement("div"); wrap.className = "fsc"; ctx.el.append(wrap);
    const bar = document.createElement("div"); bar.className = "fsc-bar"; wrap.append(bar);
    const table = document.createElement("div"); table.className = "ftable fsc-table"; wrap.append(table);
    const foot = document.createElement("div"); foot.className = "fsc-foot"; wrap.append(foot);
    const starHtml = v => (finite(v) ? `<span class="fstars">${"★".repeat(Math.round(v))}<i>${"★".repeat(Math.max(0, 5 - Math.round(v)))}</i></span>` : "—");
    const filterLabel = v => (F.isStarScale(filterVals) ? "★".repeat(+v) : String(v));
    bar.innerHTML = `<label class="fsearch wide"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5"/><path d="M11 11l3.5 3.5"/></svg><input placeholder="${esc(o.search_placeholder || "Search…")}" aria-label="Search"></label>` +
      (filterVals ? `<div class="fseg">${[["", "All"], ...filterVals.map(v => [v, filterLabel(v)])].map(([v, t]) => `<button data-v="${esc(v)}" aria-pressed="${String(S.filter ?? "") === String(v)}">${esc(t)}</button>`).join("")}</div>` : "") +
      `<span class="fsc-count"></span>`;
    const input = bar.querySelector("input");
    input.value = S.q;
    const pageSize = o.page_size || 12;
    function rowsNow() {
      const q = S.q.trim().toLowerCase();
      let rs = ctx.rows.filter(r => (!q || [label(r), sub && sub(r), badge && badge(r)].some(t => t != null && String(t).toLowerCase().includes(q))) && (S.filter == null || S.filter === "" || String(r[o.filter]) === String(S.filter)));
      const c = cols.find(k => k.col === S.sort);
      if (c) {
        const s = S.dir === "asc" ? 1 : -1;
        rs = [...rs].sort((a, b) => { const va = get(a, c), vb = get(b, c); return c.isNum ? ((finite(va) ? 0 : 1) - (finite(vb) ? 0 : 1)) || s * (va - vb) : s * F.natural(va ?? "", vb ?? ""); });
      }
      if (ctx.anyHi) rs = [...rs.filter(r => ctx.hi(label(r))), ...rs.filter(r => !ctx.hi(label(r)))];
      return rs;
    }
    function cell(r, c) {
      const v = get(r, c);
      if (c.type === "text") return `<td>${esc(v ?? "—")}</td>`;
      if (c.type === "stars") return `<td class="num">${starHtml(v)}</td>`;
      if (!finite(v)) return `<td class="num"><span class="fmuted">—</span></td>`;
      const t = c.tone(v);
      if (c.type === "strip") {
        const a = c.lo, b = c.hi > c.lo ? c.hi : c.lo + 1, p = v => Math.max(0, Math.min(1, (v - a) / (b - a))) * 100;
        const bm = c.bench != null ? `<b data-css="left:${p(c.bench)}%"></b>` : "";
        return `<td class="num"><span class="fsc-strip"><span class="fsc-v ${t}">${esc(c.fmt(v))}</span><span class="fsc-track">${bm}<i class="${t}" data-css="left:${p(v)}%"></i></span></span></td>`;
      }
      return `<td class="num"><span class="fpill ${t}">${esc(c.fmt(v))}</span></td>`;
    }
    function draw() {
      const rs = rowsNow(), pages = Math.max(1, Math.ceil(rs.length / pageSize));
      S.page = Math.min(S.page, pages - 1);
      const view = rs.slice(S.page * pageSize, (S.page + 1) * pageSize);
      bar.querySelector(".fsc-count").textContent = `${d3.format(",")(rs.length)} ${o.unit_label || "rows"}`;
      table.innerHTML = `<table><thead><tr><th class="fsc-name">${esc(o.label_title || ctx.name("label"))}</th>${cols.map(c => `<th class="${c.type === "text" ? "" : "num"}" data-c="${esc(c.col)}" title="${esc(c.label)}${c.better ? ` · ${c.better} is better` : ""}">${esc(c.label)}${S.sort === c.col ? (S.dir === "asc" ? " ↑" : " ↓") : ""}</th>`).join("")}</tr></thead><tbody>${
        view.map((r, i) => `<tr data-i="${i}" class="${ctx.hi(label(r)) ? "hi" : ""}"><td class="fsc-name"><div class="fsc-l">${esc(label(r))}${badge && badge(r) ? ` <span class="fbadge-h">${esc(badge(r))}</span>` : ""}</div>${sub ? `<div class="fsc-s">${esc(sub(r) ?? "")}</div>` : ""}</td>${cols.map(c => cell(r, c)).join("")}</tr>`).join("")}</tbody></table>`;
      if (!view.length) table.insertAdjacentHTML("beforeend", `<div class="tmore fmuted">No matches.</div>`);
      foot.innerHTML = pages > 1 ? `<button class="btn ghost" data-p="-1" ${S.page ? "" : "disabled"}>← Previous</button><span>${d3.format(",")(S.page * pageSize + 1)}–${d3.format(",")(Math.min(rs.length, (S.page + 1) * pageSize))} of ${d3.format(",")(rs.length)}</span><button class="btn ghost" data-p="1" ${S.page < pages - 1 ? "" : "disabled"}>Next →</button>` : "";
      table.querySelectorAll("th[data-c]").forEach(th => (th.onclick = () => {
        const c = cols.find(k => k.col === th.dataset.c);
        if (S.sort === c.col) S.dir = S.dir === "asc" ? "desc" : "asc"; else { S.sort = c.col; S.dir = c.better === "lower" ? "asc" : c.isNum ? "desc" : "asc"; }
        S.page = 0; draw();
      }));
      table.querySelectorAll("tbody tr").forEach(tr => {
        const r = view[+tr.dataset.i];
        tr.onclick = () => ctx.pick(r);
        tr.onmousemove = ev => {
          const td = ev.target.closest("td"), j = td ? [...tr.children].indexOf(td) - 1 : -1, c = cols[j];
          if (!c || c.type === "text") return ctx.tip.hide();
          const v = get(r, c);
          ctx.tip.show(F.tipHtml(label(r), [[c.label, c.type === "stars" ? (finite(v) ? `${v} stars` : "—") : c.fmt(v), c.tone(v)], c.bench != null && finite(v) && ["vs " + (c.benchmark_label || "benchmark"), F.signed(c.fmt, v - c.bench), c.tone(v)],
            c.better && c.type !== "stars" && finite(v) && ["Peers", c.tone(v) === "good" ? (c.bench != null ? "better than benchmark" : "best quartile") : c.tone(v) === "bad" ? (c.bench != null ? "worse than benchmark" : "worst quartile") : "middle"]], sub ? sub(r) : ""), ev);
        };
        tr.onmouseleave = () => ctx.tip.hide();
      });
      foot.querySelectorAll("button").forEach(b => (b.onclick = () => { S.page += +b.dataset.p; draw(); }));
    }
    let t = null;
    input.oninput = () => { clearTimeout(t); t = setTimeout(() => { S.q = input.value; S.page = 0; draw(); }, 120); };
    bar.querySelectorAll(".fseg button").forEach(b => (b.onclick = () => {
      bar.querySelectorAll(".fseg button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
      S.filter = b.dataset.v === "" ? null : b.dataset.v; S.page = 0; draw();
    }));
    const tinted = cols.filter(c => c.better && c.type !== "stars" && c.type !== "text");
    if (tinted.length) ctx.legend(F.chips([{label: tinted.some(c => c.bench == null) ? "Best quartile / better than benchmark" : "Better than benchmark", color: C.good}, {label: tinted.some(c => c.bench == null) ? "Worst quartile / worse" : "Worse than benchmark", color: C.bad}]));
    draw();
  });
})();
