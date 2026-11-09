/* Hospital dot map (dot_map): hospitals as dots over the U.S. state outlines, or one state with options.focus. Each
   hospital is placed by its CCN from the dashboard's geocoded addresses (window.CMS_LOCATIONS, geocode_hospitals.py)
   or by lat/lon columns, and coloured by a measure (value + better/benchmark) or a category. */
(function () {
  "use strict";
  const F = window.Figures;
  const finite = Number.isFinite;

  F.register("dot_map", ctx => {
    const {o, C, W} = ctx;
    if (!window.US_STATES || !window.topojson) throw new Error("US state shapes are not available");
    const L = window.CMS_LOCATIONS || {rows: {}, extra: {}};
    const idOf = ctx.has("id") ? r => String(ctx.v("id")(r) ?? "").trim().padStart(6, "0") : null;
    const locOf = r => (idOf ? L.rows[idOf(r)] || (L.extra || {})[idOf(r)] : null);
    const where = r => {
      if (ctx.has("lat") && ctx.has("lon")) {
        const la = ctx.n("lat")(r), lo = ctx.n("lon")(r);
        if (finite(la) && finite(lo)) return [lo, la];
      }
      const loc = locOf(r);
      return loc ? [loc[1], loc[0]] : null;
    };
    const labelOf = r => (ctx.has("label") ? ctx.v("label")(r) : (locOf(r) || [])[7]) || (idOf ? `CCN ${idOf(r)}` : "Hospital");
    const keyOf = r => String(ctx.has("label") ? ctx.v("label")(r) : idOf ? idOf(r) : "");
    const focus = typeof o.focus === "string" && /^[A-Za-z]{2}$/.test(o.focus) ? o.focus.toUpperCase() : null;

    const all = topojson.feature(window.US_STATES, window.US_STATES.objects.states).features;
    // options.zoom = "points": frame the hospitals shown (with options.center, the place they're near) instead of a state
    const center = o.center && finite(+o.center.lat) && finite(+o.center.lon) ? o.center : null;
    const zoomPts = o.zoom === "points" ? ctx.rows.map(where).filter(Boolean).concat(center ? [[+center.lon, +center.lat]] : []) : [];
    const zoomed = zoomPts.length > 0;
    const shapes = focus && !zoomed ? all.filter(f => f.properties.abbr === focus) : all;
    if (!shapes.length) throw new Error(`No state outline for ${focus}`);
    const H = Math.round(Math.min(focus || zoomed ? 520 : 560, W * (focus || zoomed ? 0.72 : 0.62))) + 46;
    let fc = {type: "FeatureCollection", features: shapes};
    if (zoomed) {
      const xs = zoomPts.map(p => p[0]), ys = zoomPts.map(p => p[1]);
      const padX = Math.max(0.25, (d3.max(xs) - d3.min(xs)) * 0.18), padY = Math.max(0.18, (d3.max(ys) - d3.min(ys)) * 0.18);
      fc = {type: "MultiPoint", coordinates: [[d3.min(xs) - padX, d3.min(ys) - padY], [d3.max(xs) + padX, d3.max(ys) + padY]]};
    }
    const proj = (focus || zoomed ? d3.geoMercator() : d3.geoAlbersUsa()).fitExtent([[8, 8], [W - 8, H - 54]], fc);
    const path = d3.geoPath(proj);

    let pts = ctx.rows.map(r => ({r, p: where(r)})).filter(d => d.p).map(d => ({...d, xy: proj(d.p)}))
      .filter(d => d.xy && d.xy[0] >= 0 && d.xy[0] <= W && d.xy[1] >= 0 && d.xy[1] <= H - 46);
    const unplaced = ctx.rows.length - pts.length;

    // Colour: a measure on the dashboard's semantic scale, or categories (never orange unless the category is worse)
    const val = ctx.has("value") ? ctx.n("value") : null;
    const sem = val ? F.semantic(ctx, pts.map(d => val(d.r))) : null;
    const fmt = val ? F.formatter(o, pts.map(d => val(d.r))) : null;
    const catOf = ctx.has("category") ? r => String(ctx.v("category")(r) ?? "—") : null;
    const cats = catOf ? (o.category_order || [...new Set(pts.map(d => catOf(d.r)))].sort(F.natural)).map(String) : [];
    // Two groups and no colours given: the smaller group (usually what the question is about) in ink, the other light
    // grey, so they read apart at a glance even on small dots
    const count = c => pts.filter(d => catOf(d.r) === c).length;
    const minor = cats.length === 2 && !o.category_colors ? (count(cats[0]) <= count(cats[1]) ? cats[0] : cats[1]) : null;
    const catColor = c => (o.category_colors && o.category_colors[c] && F.named(C, o.category_colors[c]))
      || (minor ? (c === minor ? C.text : C.neutral) : C.cat[cats.indexOf(c) % C.cat.length]) || C.muted;
    const quiet = c => { const col = d3.lab(catColor(c)); return Number.isFinite(col.l) && Math.abs(col.l - d3.lab(C.neutral).l) < 4; };
    const fillOf = r => (val && finite(val(r)) ? sem.scale(val(r)) : catOf ? catColor(catOf(r)) : C.text2);
    const size = ctx.has("size") ? ctx.n("size") : null;
    const base = finite(+o.radius) ? +o.radius : pts.length > 1500 ? 2.2 : pts.length > 400 ? 3 : focus ? (pts.length < 150 ? 5.6 : 4.6) : pts.length < 150 ? 4.4 : 3.6;
    const rScale = size ? d3.scaleSqrt([0, d3.max(pts, d => size(d.r)) || 1], [base * 0.6, base * 2.6]) : null;
    const radius = r => (rScale && finite(size(r)) ? rScale(size(r)) : base);

    // Neighbouring states are drawn too, so the map must clip to its own box
    const svg = ctx.svg(H).style("overflow", "hidden"), g = svg.append("g");
    g.selectAll("path.st").data(focus || zoomed ? all : shapes).join("path").attr("d", path)
      .attr("fill", f => (!focus || zoomed || f.properties.abbr === focus ? C.surface2 : C.bg)).attr("stroke", C.border).attr("stroke-width", 0.8);
    // Worse values on top, highlighted hospitals last
    const rank = d => (ctx.hi(keyOf(d.r)) ? 3 : sem && sem.tone(val(d.r)) === "bad" ? 2 : catOf && !quiet(catOf(d.r)) ? 2 : 1);
    pts = pts.sort((a, b) => rank(a) - rank(b));
    const dots = g.selectAll("circle.hd").data(pts).join("circle").attr("class", "hd")
      .attr("cx", d => d.xy[0]).attr("cy", d => d.xy[1]).attr("r", d => (ctx.hi(keyOf(d.r)) ? radius(d.r) + 2 : radius(d.r)))
      .attr("fill", d => fillOf(d.r)).attr("fill-opacity", d => (ctx.anyHi && !ctx.hi(keyOf(d.r)) ? 0.35 : 0.9))
      .attr("stroke", d => (ctx.hi(keyOf(d.r)) ? C.text : C.surface)).attr("stroke-width", d => (ctx.hi(keyOf(d.r)) ? 1.6 : 0.6));
    if (ctx.anim) dots.attr("r", 0).transition().duration(500).delay((d, i) => Math.min(600, i * 0.4)).attr("r", d => radius(d.r));
    // Highlighted hospitals are named; on a map of a few hospitals around a place, every one is
    const named = zoomed && pts.length <= 14 && !ctx.anyHi ? pts : pts.filter(d => ctx.hi(keyOf(d.r))).slice(0, 8);
    const labels = named.map(d => ({x: d.xy[0], y: d.xy[1], text: F.truncate(labelOf(d.r), 180, 11)}));
    if (center) {
      const c = proj([+center.lon, +center.lat]);
      if (c) {
        g.append("rect").attr("x", c[0] - 5).attr("y", c[1] - 5).attr("width", 10).attr("height", 10).attr("fill", C.text).attr("stroke", C.surface).attr("stroke-width", 1.5);
        labels.unshift({x: c[0], y: c[1], text: center.label || "You are here"});
      }
    }
    F.placeLabels(g, labels, [0, 0, W, H - 46]);

    const tip = r => {
      const loc = locOf(r);
      const sub = ctx.has("sublabel") ? ctx.v("sublabel")(r) : loc && loc[8] ? `${loc[8]}, ${loc[9]}` : idOf ? `CCN ${idOf(r)}` : "";
      const rows = [];
      if (val && finite(val(r))) rows.push([ctx.name("value"), fmt(val(r)), sem.tone(val(r))]);
      if (catOf) rows.push([ctx.name("category"), catOf(r)]);
      if (size && finite(size(r))) rows.push([ctx.name("size"), F.formatter({}, [size(r)])(size(r))]);
      return F.tipHtml(labelOf(r), rows, sub);
    };
    F.nearest(ctx, svg, pts.map(d => [d.xy[0], d.xy[1], d.r]), [0, 0, W, H - 46], tip, r => ctx.pick(r), 18);

    if (sem) F.gradientLegend(ctx, svg.append("g").attr("transform", `translate(${W / 2 - 130},${H - 26})`), sem, 260, fmt);
    else if (catOf) ctx.legend(F.chips(cats.map(c => ({label: c, color: catColor(c), count: pts.filter(d => catOf(d.r) === c).length.toLocaleString()}))));
    if (unplaced > 0) ctx.note(`${unplaced.toLocaleString()} of ${ctx.rows.length.toLocaleString()} hospitals have no map location${focus ? ` in ${focus}` : ""} and aren't shown.`);
  });

  /* route_care: a drive and the maternity care along it (copilot/geo.py route_care). The map shows the road, coloured
     where the nearest hospital that delivers babies is more than 30 or 60 minutes away, and the hospitals near it; the
     profile below shows that drive time mile by mile. Hovering either one marks the same place on both.
     rows: samples {mile, lat, lon, deliver_min, nicu_min, deliver, nicu_h}; options: line, stops, hospitals, towns, worst. */
  F.register("route_care", ctx => {
    const {o, C, W} = ctx;
    if (!window.US_STATES || !window.topojson) throw new Error("US state shapes are not available");
    const rows = ctx.rows, line = o.line || rows.map(r => [r.lat, r.lon]), hs = o.hospitals || [], stops = o.stops || [];
    const byCcn = new Map(hs.map(h => [h.ccn, h]).concat((o.nicu_hospitals || []).map(h => [h.ccn, h])));
    const narrow = W < 560, worse = C.bad;
    const tone = m => (m > 60 ? worse : m > 30 ? d3.interpolateRgb(C.neutral, worse)(0.45) : C.text2);
    // Map
    const all = topojson.feature(window.US_STATES, window.US_STATES.objects.states).features;
    const lonlat = line.map(p => [p[1], p[0]]);
    const xs = lonlat.map(p => p[0]), ys = lonlat.map(p => p[1]);
    const px = Math.max(0.4, (d3.max(xs) - d3.min(xs)) * 0.08), py = Math.max(0.3, (d3.max(ys) - d3.min(ys)) * 0.12);
    const box = {type: "MultiPoint", coordinates: [[d3.min(xs) - px, d3.min(ys) - py], [d3.max(xs) + px, d3.max(ys) + py]]};
    // As tall as the route needs at this width, within limits
    const fitW = d3.geoMercator().fitWidth(W - 20, box), bh = d3.geoPath(fitW).bounds(box);
    const Hm = Math.round(Math.max(narrow ? 260 : 320, Math.min(narrow ? 420 : 560, bh[1][1] - bh[0][1] + 20)));
    const proj = d3.geoMercator().fitExtent([[10, 10], [W - 10, Hm - 10]], box);
    const path = d3.geoPath(proj);
    const svg = ctx.svg(Hm, "Map of the route and the hospitals that deliver babies near it").style("overflow", "hidden");
    const g = svg.append("g");
    g.selectAll("path.st").data(all).join("path").attr("d", path).attr("fill", C.surface2).attr("stroke", C.border).attr("stroke-width", 0.8);
    // The road: one segment per sample, coloured by the drive to the nearest delivering hospital
    const seg = rows.slice(1).map((r, i) => ({a: rows[i], b: r, m: Math.max(rows[i].deliver_min, r.deliver_min)}));
    g.append("path").attr("d", d3.line()(lonlat.map(p => proj(p)))).attr("fill", "none").attr("stroke", C.surface).attr("stroke-width", 7).attr("stroke-linecap", "round");
    g.selectAll("line.rt").data(seg).join("line").attr("x1", d => proj([d.a.lon, d.a.lat])[0]).attr("y1", d => proj([d.a.lon, d.a.lat])[1])
      .attr("x2", d => proj([d.b.lon, d.b.lat])[0]).attr("y2", d => proj([d.b.lon, d.b.lat])[1])
      .attr("stroke", d => tone(d.m)).attr("stroke-width", d => (d.m > 30 ? 4.5 : 3)).attr("stroke-linecap", "round");
    // Hospitals near the road
    const hp = hs.map(h => ({h, xy: proj([h.lon, h.lat])})).filter(d => d.xy && d.xy[0] > 0 && d.xy[0] < W && d.xy[1] > 0 && d.xy[1] < Hm);
    const order = d => (d.h.stopped ? 0 : d.h.nicu ? 2 : 1);
    hp.sort((a, b) => order(a) - order(b)).forEach(d => {
      const s = g.append("circle").attr("cx", d.xy[0]).attr("cy", d.xy[1]);
      if (d.h.stopped) s.attr("r", 3.6).attr("fill", C.surface).attr("stroke", C.neutral).attr("stroke-width", 1.4);
      else if (d.h.nicu) s.attr("r", 5).attr("fill", C.text).attr("stroke", C.surface).attr("stroke-width", 1.2);
      else s.attr("r", 3.8).attr("fill", C.neutral).attr("stroke", C.surface).attr("stroke-width", 1);
    });
    // Start, end and the farthest point from delivery care
    const labels = [];
    stops.forEach((s, i) => {
      const xy = proj([s.lon, s.lat]);
      if (!xy) return;
      g.append("rect").attr("x", xy[0] - 5).attr("y", xy[1] - 5).attr("width", 10).attr("height", 10).attr("fill", C.text).attr("stroke", C.surface).attr("stroke-width", 1.5);
      labels.push({x: xy[0], y: xy[1], text: s.label || s.name});
    });
    const worst = o.worst ? rows.reduce((a, b) => (b.deliver_min > a.deliver_min ? b : a), rows[0]) : null;
    if (worst && worst.deliver_min > 30) {
      const xy = proj([worst.lon, worst.lat]);
      g.append("circle").attr("cx", xy[0]).attr("cy", xy[1]).attr("r", 8).attr("fill", "none").attr("stroke", C.text).attr("stroke-width", 1.8);
      labels.push({x: xy[0], y: xy[1], text: o.worst});
    }
    F.placeLabels(g, labels, [0, 0, W, Hm]);
    const marker = svg.append("circle").attr("r", 6).attr("fill", C.surface).attr("stroke", C.text).attr("stroke-width", 2).style("opacity", 0).style("pointer-events", "none");

    // Profile: drive to the nearest delivering hospital (and NICU) along the way
    const m = {l: 44, r: narrow ? 12 : 120, t: 22, b: 42}, Hp = narrow ? 190 : 210;
    const total = rows[rows.length - 1].mile;
    const capNicu = 150, yMax = Math.max(75, Math.min(capNicu, d3.max(rows, r => Math.max(r.deliver_min, o.show_nicu === false ? 0 : r.nicu_min))) * 1.08);
    const x = d3.scaleLinear([0, total], [m.l, W - m.r]), y = d3.scaleLinear([0, yMax], [Hp - m.b, m.t]).nice();
    const ps = ctx.svg(Hp, "Estimated drive to the nearest hospital that delivers babies, along the route"), pg = ps.append("g");
    [30, 60].forEach(t => {
      if (t > y.domain()[1]) return;
      pg.append("rect").attr("x", m.l).attr("width", W - m.l - m.r).attr("y", y(t === 30 ? Math.min(60, y.domain()[1]) : y.domain()[1])).attr("height", t === 30 ? y(30) - y(Math.min(60, y.domain()[1])) : y(60) - y(y.domain()[1]))
        .attr("fill", worse).attr("fill-opacity", t === 30 ? 0.04 : 0.07);
      pg.append("line").attr("class", "fbench").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y(t)).attr("y2", y(t));
      pg.append("text").attr("class", "fbench-label").attr("x", m.l + 4).attr("y", y(t) - 5).text(`${t === 60 ? "1 hour" : "30 min"}`);
    });
    const gy = pg.append("g").attr("transform", `translate(${m.l},0)`);
    gy.selectAll("text").data(y.ticks(4)).join("text").attr("class", "ftick").attr("x", -6).attr("y", d => y(d)).attr("dy", "0.32em").attr("text-anchor", "end").text(d => (d ? `${d} min` : "0"));
    // Places on the axis: start and end first, then towns in between that have room
    const tick = (mile, name) => {
      const w = F.textWidth(name, 10.5) + 12, anchor = mile === 0 ? "start" : mile === total ? "end" : "middle";
      const x0 = anchor === "start" ? x(mile) : anchor === "end" ? x(mile) - w : x(mile) - w / 2;
      return {mile, name, anchor, span: [x0, x0 + w]};
    };
    const kept = [tick(0, (stops[0] || {}).short || "Start"), tick(total, (stops[stops.length - 1] || {}).short || "End")];
    (o.towns || []).forEach(t => { const k = tick(t.mile, t.name); if (kept.every(q => k.span[1] < q.span[0] || k.span[0] > q.span[1])) kept.push(k); });
    kept.forEach(t => {
      pg.append("line").attr("x1", x(t.mile)).attr("x2", x(t.mile)).attr("y1", Hp - m.b).attr("y2", Hp - m.b + 4).attr("stroke", C.muted);
      pg.append("text").attr("class", "ftick").attr("x", x(t.mile)).attr("y", Hp - m.b + 16).attr("text-anchor", t.anchor).text(t.name);
    });
    pg.append("text").attr("class", "ftick").attr("x", W - m.r).attr("y", Hp - 4).attr("text-anchor", "end").text(`${Math.round(total)} road miles`);
    const curve = d3.curveMonotoneX;
    if (o.show_nicu !== false) {
      const nl = d3.line().x(r => x(r.mile)).y(r => y(Math.min(r.nicu_min, y.domain()[1]))).curve(curve);
      pg.append("path").attr("d", nl(rows)).attr("fill", "none").attr("stroke", C.neutral).attr("stroke-width", 1.6).attr("stroke-dasharray", "4 3");
    }
    pg.append("path").attr("d", d3.area().x(r => x(r.mile)).y0(y(0)).y1(r => y(Math.min(r.deliver_min, y.domain()[1]))).curve(curve)(rows)).attr("fill", C.text).attr("fill-opacity", 0.06);
    pg.append("path").attr("d", d3.line().x(r => x(r.mile)).y(r => y(Math.min(r.deliver_min, y.domain()[1]))).curve(curve)(rows)).attr("fill", "none").attr("stroke", C.text).attr("stroke-width", 2);
    if (!narrow) {
      const last = rows[rows.length - 1];
      pg.append("text").attr("class", "fend").attr("x", W - m.r + 8).attr("y", y(Math.min(last.deliver_min, y.domain()[1]))).attr("dy", "0.32em").attr("fill", C.text).text("Delivers babies");
      if (o.show_nicu !== false) pg.append("text").attr("class", "fend fend-m").attr("x", W - m.r + 8).attr("y", y(Math.min(last.nicu_min, y.domain()[1])) + (Math.abs(last.nicu_min - last.deliver_min) < 12 ? 14 : 0)).attr("dy", "0.32em").text("NICU");
    }
    if (worst && worst.deliver_min > 30) {
      pg.append("circle").attr("cx", x(worst.mile)).attr("cy", y(Math.min(worst.deliver_min, y.domain()[1]))).attr("r", 4.5).attr("fill", C.surface).attr("stroke", C.text).attr("stroke-width", 1.8);
      const tx = x(worst.mile), anchor = tx > W - m.r - 120 ? "end" : tx < m.l + 120 ? "start" : "middle";
      pg.append("text").attr("class", "fpeak halo").attr("x", tx).attr("y", y(Math.min(worst.deliver_min, y.domain()[1])) - 9).attr("text-anchor", anchor).text(`${Math.round(worst.deliver_min)} min`);
    }
    // Hover: a rule on the profile and a marker on the map at the same mile
    const rule = pg.append("line").attr("y1", m.t).attr("y2", Hp - m.b).attr("stroke", C.text).attr("stroke-width", 1).style("opacity", 0);
    const nameOf = id => { const h = byCcn.get(id); return h ? `${h.name}${h.city ? `, ${h.city}` : ""}` : ""; };
    const show = (r, ev) => {
      const xy = proj([r.lon, r.lat]);
      marker.attr("cx", xy[0]).attr("cy", xy[1]).style("opacity", 1);
      rule.attr("x1", x(r.mile)).attr("x2", x(r.mile)).style("opacity", 1);
      ctx.tip.show(F.tipHtml(`Mile ${Math.round(r.mile)}${r.near ? ` · near ${r.near}` : ""}`, [
        ["Delivers babies", `${Math.round(r.deliver_min)} min`, r.deliver_min > 60 ? "bad" : ""], nameOf(r.deliver) && ["", nameOf(r.deliver)],
        o.show_nicu !== false && ["NICU", `${Math.round(r.nicu_min)} min`], o.show_nicu !== false && nameOf(r.nicu_h) && ["", nameOf(r.nicu_h)]].filter(Boolean),
        o.estimated ? "Drive from the road (estimated where the router didn't answer)" : "Drive by road from this point"), ev);
    };
    const hide = () => { marker.style("opacity", 0); rule.style("opacity", 0); ctx.tip.hide(); };
    const bis = d3.bisector(r => r.mile).center;
    ps.append("rect").attr("x", m.l).attr("y", m.t).attr("width", W - m.l - m.r).attr("height", Hp - m.t - m.b).attr("fill", "transparent").style("cursor", "crosshair")
      .on("mousemove", ev => show(rows[bis(rows, x.invert(d3.pointer(ev)[0]))], ev)).on("mouseleave", hide);
    const dl = d3.Delaunay.from(rows, r => proj([r.lon, r.lat])[0], r => proj([r.lon, r.lat])[1]);
    svg.append("rect").attr("width", W).attr("height", Hm).attr("fill", "transparent")
      .on("mousemove", ev => { const [mx, my] = d3.pointer(ev), r = rows[dl.find(mx, my)], xy = proj([r.lon, r.lat]); if (Math.hypot(xy[0] - mx, xy[1] - my) < 24) show(r, ev); else hide(); })
      .on("mouseleave", hide);

    ctx.legend(F.chips([
      {label: "Delivery care within 30 min", color: C.text2, shape: "line"},
      {label: "30–60 min", color: tone(45), shape: "line"},
      {label: "over 1 hour", color: worse, shape: "line"},
      {label: "Delivers babies", color: C.neutral},
      {label: "Delivers, with NICU", color: C.text},
      ...(hs.some(h => h.stopped) ? [{label: "Stopped delivering", color: C.neutral, shape: "ring"}] : []),
      ...(o.show_nicu !== false ? [{label: "Drive to a NICU", color: C.neutral, shape: "dash"}] : []),
    ]));
    ctx.note(o.estimated ? "Drive times are by road (OpenStreetMap) where the router answered and estimated from straight-line distance elsewhere."
      : "Drive times are by road without traffic (OpenStreetMap), to the nearest hospital from each point on the route.");
  });
})();
