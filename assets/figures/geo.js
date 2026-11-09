/* Geography figures: tile_map (equal-size US state tiles) and geo_map (US choropleth). Both take a state
   column (2-letter codes or full names), a value, and optionally a time column (stepper with play) and a
   volume column (low-volume states are hatched). */
(function () {
  "use strict";
  const F = window.Figures;
  const finite = Number.isFinite;

  F.STATE_NAMES = {AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware",
    DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas",
    KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
    MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
    NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island",
    SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
    WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", PR: "Puerto Rico", VI: "U.S. Virgin Islands", GU: "Guam", AS: "American Samoa",
    MP: "Northern Mariana Islands"};
  const BY_NAME = Object.fromEntries(Object.entries(F.STATE_NAMES).map(([k, v]) => [v.toLowerCase(), k]));
  F.stateCode = v => { const s = String(v ?? "").trim(); return s.length === 2 ? s.toUpperCase() : BY_NAME[s.toLowerCase()] || s.toUpperCase(); };

  // Tile-grid layout: [column, row].
  const TILES = {AK: [0, 0], ME: [11, 0], WI: [6, 1], VT: [10, 1], NH: [11, 1], WA: [1, 2], ID: [2, 2], MT: [3, 2], ND: [4, 2], MN: [5, 2],
    IL: [6, 2], MI: [7, 2], NY: [9, 2], MA: [10, 2], OR: [1, 3], NV: [2, 3], WY: [3, 3], SD: [4, 3], IA: [5, 3], IN: [6, 3], OH: [7, 3],
    PA: [8, 3], NJ: [9, 3], CT: [10, 3], RI: [11, 3], CA: [1, 4], UT: [2, 4], CO: [3, 4], NE: [4, 4], MO: [5, 4], KY: [6, 4], WV: [7, 4],
    VA: [8, 4], MD: [9, 4], DE: [10, 4], AZ: [2, 5], NM: [3, 5], KS: [4, 5], AR: [5, 5], TN: [6, 5], NC: [7, 5], SC: [8, 5], DC: [9, 5],
    OK: [4, 6], LA: [5, 6], MS: [6, 6], AL: [7, 6], GA: [8, 6], HI: [0, 7], TX: [4, 7], FL: [9, 7], GU: [0, 8.4], MP: [1, 8.4], AS: [2, 8.4],
    PR: [10, 8.4], VI: [11, 8.4]};

  // Shared data prep: rows per (state, time), semantic scale over all times so years are comparable.
  function prep(ctx) {
    const {o} = ctx, sv = r => F.stateCode(ctx.v("state")(r)), val = ctx.n("value");
    const tv = ctx.has("time") ? ctx.v("time") : null, vol = ctx.has("volume") ? ctx.n("volume") : null;
    const rows = ctx.rows.filter(r => sv(r));
    const times = tv ? F.xDomain(rows, tv) : [null];
    const key = (s, t) => `${s}|${t}`;
    const byKey = new Map(rows.map(r => [key(sv(r), tv ? (typeof times[0] === "number" ? +tv(r) : tv(r)) : null), r]));
    const vals = rows.map(val).filter(finite);
    const sem = F.semantic(ctx, vals), fmt = F.formatter(o, vals);
    const start = o.time != null ? times.find(t => String(t) === String(o.time)) : undefined;
    const minVol = F.numOpt(o.min_volume);
    const lowVol = r => !r || !finite(val(r)) || (vol && minVol != null && !(vol(r) >= minVol));
    const tip = (code, r, t) => {
      const series = tv ? times.map(tt => [String(tt), fmt(val(byKey.get(key(code, tt)) || {}))]).filter(p => p[1] !== "—") : [];
      return F.tipHtml(F.STATE_NAMES[code] || code, [
        [ctx.name("value") + (t != null ? ` · ${t}` : ""), r ? fmt(val(r)) : "—", r && sem.better ? sem.tone(val(r)) : ""],
        vol && r && [ctx.name("volume"), F.formatter({}, [vol(r)])(vol(r))],
        r && sem.better && [o.benchmark_label || "vs benchmark", F.signed(fmt, val(r) - sem.center), sem.tone(val(r))],
        ...(series.length > 1 && series.length <= 10 ? series.map(([a, b]) => [a, b]) : []),
      ], lowVol(r) && r ? "Low volume: interpret with care" : "Click to drill in");
    };
    return {sv, val, tv, vol, rows, times, key, byKey, sem, fmt, start: start ?? times[times.length - 1], lowVol, tip};
  }

  function hatch(svg, C) {
    const id = "hatch" + Math.random().toString(36).slice(2, 7);
    svg.append("defs").append("pattern").attr("id", id).attr("patternUnits", "userSpaceOnUse").attr("width", 6).attr("height", 6).attr("patternTransform", "rotate(45)")
      .append("line").attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 6).attr("stroke", C.text).attr("stroke-opacity", 0.2).attr("stroke-width", 2);
    return id;
  }

  // ---- Tile map ---------------------------------------------------------------------------------
  F.register("tile_map", ctx => {
    const {o, C, W} = ctx, P = prep(ctx);
    const present = new Set(P.rows.map(P.sv));
    const showTerr = ["PR", "VI", "GU", "AS", "MP"].some(s => present.has(s));
    const codes = Object.keys(TILES).filter(c => showTerr || TILES[c][1] < 8);
    const gap = W < 520 ? 3 : 5, size = Math.floor(Math.min(64, (W - gap * 11) / 12));
    const gridH = (showTerr ? 9.4 : 8) * (size + gap), H = Math.ceil(gridH) + 46;
    const svg = ctx.svg(H), hid = hatch(svg, C), ox = (W - (12 * size + 11 * gap)) / 2;
    let cur = P.start;
    const g = svg.selectAll("g.tile").data(codes).join("g").attr("class", "tile").style("cursor", "pointer")
      .attr("transform", c => `translate(${ox + TILES[c][0] * (size + gap)},${TILES[c][1] * (size + gap)})`);
    const rowOf = c => P.byKey.get(P.key(c, cur));
    const fillOf = c => { const r = rowOf(c); return r && finite(P.val(r)) ? P.sem.scale(P.val(r)) : C.surface2; };
    const rx = Math.max(6, size * 0.16);
    const rect = g.append("rect").attr("width", size).attr("height", size).attr("rx", rx).attr("fill", fillOf)
      .attr("stroke", c => (ctx.hi(c) ? C.text : "none")).attr("stroke-width", 2.5);
    if (ctx.anim) rect.attr("opacity", 0).transition().duration(500).delay(c => (TILES[c][0] + TILES[c][1]) * 26).attr("opacity", 1);
    const hatchRect = g.append("rect").attr("width", size).attr("height", size).attr("rx", rx).attr("fill", `url(#${hid})`).attr("pointer-events", "none")
      .attr("display", c => (P.lowVol(rowOf(c)) ? null : "none"));
    const fs = Math.max(9, Math.min(12.5, size * 0.21));
    const code = g.append("text").attr("x", size * 0.13).attr("y", size * 0.13 + fs).attr("font-size", fs).attr("font-weight", 600).text(c => c);
    const value = size >= 34 ? g.append("text").attr("x", size * 0.13).attr("y", size - size * 0.14).attr("font-size", fs * 0.92).attr("font-variant-numeric", "tabular-nums").attr("fill-opacity", 0.85) : null;
    const paint = (animate) => {
      const t = animate && !F.reduceMotion ? d3.transition().duration(450) : null;
      (t ? rect.transition(t) : rect).attr("fill", fillOf);
      hatchRect.attr("display", c => (P.lowVol(rowOf(c)) ? null : "none"));
      code.attr("fill", c => F.inkOn(fillOf(c)));
      if (value) value.attr("fill", c => F.inkOn(fillOf(c))).text(c => { const r = rowOf(c); return r ? P.fmt(P.val(r)) : "—"; });
    };
    paint(false);
    g.on("mousemove", (ev, c) => ctx.tip.show(P.tip(c, rowOf(c), cur), ev)).on("mouseleave", () => ctx.tip.hide()).on("click", (ev, c) => rowOf(c) && ctx.pick(rowOf(c)));
    const lw = Math.min(260, 4 * (size + gap)), lg = svg.append("g").attr("transform", `translate(${ox + 4 * (size + gap)},${gridH + 14})`);
    F.gradientLegend(ctx, lg, P.sem, lw, P.fmt);
    if (P.times.length > 1) F.stepper(ctx, P.times, cur, t => { cur = t; paint(true); });
    if (P.vol && F.numOpt(o.min_volume) != null) ctx.note(`Hatched: ${ctx.name("volume")} below ${o.min_volume}, so the value is unstable.`);
  });

  // ---- Geographic map ---------------------------------------------------------------------------
  F.register("geo_map", ctx => {
    const {o, C, W} = ctx, P = prep(ctx);
    if (!window.US_STATES || !window.topojson) throw new Error("US state shapes are not available");
    const fc = topojson.feature(window.US_STATES, window.US_STATES.objects.states);
    const H = Math.round(Math.min(560, W * 0.62)) + 40;
    const proj = d3.geoAlbersUsa().fitSize([W, H - 50], fc), path = d3.geoPath(proj);
    const svg = ctx.svg(H), hid = hatch(svg, C);
    let cur = P.start;
    const feats = fc.features.filter(f => path(f));
    const rowOf = f => P.byKey.get(P.key(f.properties.abbr, cur));
    const fillOf = f => { const r = rowOf(f); return r && finite(P.val(r)) ? P.sem.scale(P.val(r)) : C.surface2; };
    const g = svg.append("g");
    const shapes = g.selectAll("path.st").data(feats).join("path").attr("class", "st").attr("d", path).attr("fill", fillOf)
      .attr("stroke", f => (ctx.hi(f.properties.abbr) ? C.text : C.surface)).attr("stroke-width", f => (ctx.hi(f.properties.abbr) ? 2.2 : 0.8)).style("cursor", "pointer");
    if (ctx.anim) shapes.attr("opacity", 0).transition().duration(600).delay((f, i) => i * 8).attr("opacity", 1);
    const hatches = g.selectAll("path.h").data(feats).join("path").attr("class", "h").attr("d", path).attr("fill", `url(#${hid})`).attr("pointer-events", "none");
    const labels = g.selectAll("text.vl").data(feats.filter(f => path.area(f) > 1800)).join("text").attr("class", "vl").attr("text-anchor", "middle")
      .attr("x", f => path.centroid(f)[0]).attr("y", f => path.centroid(f)[1]).attr("dy", "0.32em").attr("font-size", 10.5).attr("font-weight", 600).attr("pointer-events", "none");
    const paint = animate => {
      (animate && !F.reduceMotion ? shapes.transition().duration(450) : shapes).attr("fill", fillOf);
      hatches.attr("display", f => (P.lowVol(rowOf(f)) && rowOf(f) ? null : "none"));
      labels.attr("fill", f => F.inkOn(fillOf(f))).text(f => { const r = rowOf(f); return r ? P.fmt(P.val(r)) : ""; });
    };
    paint(false);
    shapes.on("mousemove", (ev, f) => ctx.tip.show(P.tip(f.properties.abbr, rowOf(f), cur), ev)).on("mouseleave", () => ctx.tip.hide())
      .on("click", (ev, f) => rowOf(f) && ctx.pick(rowOf(f)));
    F.gradientLegend(ctx, svg.append("g").attr("transform", `translate(${W / 2 - 130},${H - 30})`), P.sem, 260, P.fmt);
    if (P.times.length > 1) F.stepper(ctx, P.times, cur, t => { cur = t; paint(true); });
    const offMap = ["PR", "VI", "GU", "AS", "MP"].filter(s => P.byKey.has(P.key(s, cur)));
    if (offMap.length) ctx.note(`Not on the map: ${offMap.map(s => `${s} ${P.fmt(P.val(P.byKey.get(P.key(s, cur))))}`).join(" · ")}`);
  });
})();
