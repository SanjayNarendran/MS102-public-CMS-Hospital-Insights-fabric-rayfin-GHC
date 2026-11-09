/* Figures: generic, data-driven analytic figures drawn with d3 (show_figure), drawn straight into Ask your data answers.
   Adapted from the author's earlier figure library for conversational analytics on Fabric, re-themed for the
   dashboard: its tokens and fonts, ink for neutral data, orange only for worse, the dashboard's tooltip.
   A template gets a context: the rows, a role -> column map (fields) and options, and draws into ctx.el.
   This file holds what every template shares: theme colours, number formats, semantic better/worse colour
   scales centred on a benchmark, tooltip, drill-down picking, highlights, legends, a time stepper and
   responsive re-rendering. Templates live in the other figures/*.js files and call Figures.register(). */
(function () {
  "use strict";
  const F = (window.Figures = {templates: {}});
  F.register = (name, draw) => { F.templates[name] = draw; };

  const esc = (F.esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c])));
  F.reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Colours come from the dashboard's CSS custom properties, so figures follow the light/dark theme. The templates'
  // "accent" (emphasis for data with no direction) is ink here: in the dashboard, orange only ever means worse.
  F.palette = function () {
    const s = getComputedStyle(document.documentElement), g = n => s.getPropertyValue(n).trim();
    const C = {
      bg: g("--bg"), surface: g("--surface"), surface2: g("--surface-2"), surface3: g("--surface-3"),
      text: g("--text"), text2: g("--text-2"), muted: g("--muted"), faint: g("--faint"), border: g("--border"),
      grid: g("--grid"), accent: g("--text-2"), accentStrong: g("--text"), good: g("--good"), bad: g("--bad"),
      neutral: g("--neutral"), neutralMid: g("--neutral-mid"), olive: g("--olive"), kraft: g("--kraft"),
      sky: g("--sky"), fig: g("--fig"), orange: g("--accent"),
    };
    C.cat = [C.text2, C.olive, C.kraft, C.fig, C.sky, C.muted];  // blue means better here, so categories start with ink
    return C;
  };
  // Colours the model may name in options.colors / category_colors: the dashboard's meanings, or any CSS colour
  F.named = (C, v) => {
    const k = String(v ?? "").trim().toLowerCase();
    return {worse: C.bad, bad: C.bad, orange: C.bad, better: C.good, good: C.good, blue: C.good, strong: C.text, ink: C.text,
      dark: C.text, black: C.text, muted: C.neutral, grey: C.neutral, gray: C.neutral, neutral: C.neutral, light: C.neutral}[k] || v;
  };
  F.inkOn = fill => { try { return d3.lab(fill).l > 62 ? "#141413" : "#FAF9F5"; } catch (e) { return "#141413"; } };

  // Text measurement (for label columns and collision avoidance).
  const canvas = document.createElement("canvas").getContext("2d");
  const fontFamily = () => getComputedStyle(document.documentElement).getPropertyValue("--font") || "sans-serif";
  F.textWidth = (s, size = 12, weight = 400) => {
    canvas.font = `${weight} ${size}px ${fontFamily()}`;
    return canvas.measureText(String(s ?? "")).width;
  };
  // Words into lines no wider than px (at most `max` lines; the last is truncated if the text still doesn't fit)
  F.wrap = (s, px, size = 11, weight = 400, max = 3) => {
    const words = String(s ?? "").split(/\s+/).filter(Boolean), lines = [];
    let cur = "";
    words.forEach(w => {
      const next = cur ? `${cur} ${w}` : w;
      if (!cur || F.textWidth(next, size, weight) <= px) cur = next;
      else { lines.push(cur); cur = w; }
    });
    if (cur) lines.push(cur);
    if (lines.length > max) lines.splice(max - 1, lines.length, lines.slice(max - 1).join(" "));
    return lines.map(l => F.truncate(l, px, size, weight));
  };
  // CMS publishes names in capitals ("MARSHFIELD MEDICAL CENTER - EAU CLAIRE"): drawn in title case, as the dashboard
  // shows them. Abbreviations, state codes and tokens with digits or dots keep their capitals; data values don't change.
  const KEEP = new Set(["UCLA", "UCSF", "UC", "VA", "OSF", "SSM", "HCA", "UPMC", "CHI", "MUSC", "UAB", "UNC", "UW", "UNM", "LDS",
    "II", "III", "IV", "CAH", "HCMC", "NYU", "AMC", "LLC", "MD", "PSI", "SSI", "HAI", "ED", "ICU", "NICU", "CLABSI", "CAUTI", "MRSA", "USA", "US"]);
  const SMALL = new Set(["of", "and", "the", "at", "in", "for", "de", "la", "del", "on"]);
  F.nameCase = s => {
    s = String(s ?? "");
    if (/[a-z]/.test(s) || !/[A-Z]{3}/.test(s) || s.trim().split(/\s+/).length < 2) return s;
    return s.split(/(\s+|-|\/)/).map((w, i) => {
      const core = w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
      if (!core || KEEP.has(core) || /\d|[A-Za-z]\.[A-Za-z]/.test(w) || (core.length === 2 && /^\(.*\)$/.test(w))) return w;
      const lw = w.toLowerCase();
      if (i > 0 && SMALL.has(lw)) return lw;
      return lw.replace(/[a-z]/, c => c.toUpperCase()).replace(/^(\W*)Mc([a-z])/, (m, a, b) => `${a}Mc${b.toUpperCase()}`);
    }).join("");
  };
  F.truncate = (s, px, size = 12, weight = 400) => {
    s = F.nameCase(s);
    if (F.textWidth(s, size, weight) <= px) return s;
    while (s.length > 1 && F.textWidth(s + "…", size, weight) > px) s = s.slice(0, -1);
    return s + "…";
  };

  // Number formats: options.format (d3-format) + options.unit, else chosen from the values' magnitude.
  F.formatter = function (o, values) {
    const unit = o.unit || "";
    if (o.format) {
      const f = d3.format(o.format);
      return v => (v == null || !Number.isFinite(+v) ? "—" : f(+v) + unit);
    }
    const vals = values.filter(Number.isFinite);
    const m = d3.median(vals.map(Math.abs)) ?? 0;
    const allInt = vals.length > 0 && vals.every(v => Number.isInteger(v));
    const spec = allInt ? (m >= 1e6 ? ".3~s" : ",.0f") : m < 10 ? ",.2f" : m < 100 ? ",.1f" : m < 1e6 ? ",.0f" : ".3~s";
    const f = d3.format(spec);
    return v => (v == null || !Number.isFinite(+v) ? "—" : f(+v) + unit);
  };
  F.signed = (fmt, v) => (v > 0 ? "+" : v < 0 ? "−" : "±") + fmt(Math.abs(v));
  F.pct = d3.format(".0%");
  F.signedPct = v => (v > 0.0005 ? "+" : v < -0.0005 ? "−" : "±") + F.pct(Math.abs(v));

  // Semantic colour: options.better = "lower" | "higher" gives a diverging good/bad scale centred on
  // options.benchmark (or options.center, else the median). Without a direction it's a sequential ramp.
  const numOpt = v => (v === null || v === undefined || v === "" || !Number.isFinite(+v) ? null : +v);
  F.semantic = function (ctx, values) {
    const {o, C} = ctx, vals = values.filter(Number.isFinite);
    const better = o.better === "lower" || o.better === "higher" ? o.better : null;
    const center = numOpt(o.benchmark) ?? numOpt(o.center) ?? d3.median(vals) ?? 0;
    if (!better) {
      const [lo, hi] = vals.length ? d3.extent(vals) : [0, 1];
      const scale = d3.scaleSequential([lo, hi === lo ? lo + 1 : hi], d3.interpolateRgb(C.neutralMid, C.text2)).clamp(true);
      return {kind: "sequential", scale, center, better, lo, hi: hi === lo ? lo + 1 : hi, tone: () => "neutral"};
    }
    const devs = vals.map(v => Math.abs(v - center)).sort(d3.ascending);
    const dev = d3.quantile(devs, 0.95) || Math.abs(center) * 0.1 || 1;
    const cols = better === "lower" ? [C.good, C.neutralMid, C.bad] : [C.bad, C.neutralMid, C.good];
    // Shares, counts and rates can't go below zero, so neither does their legend
    const floor = vals.length && d3.min(vals) >= 0 ? 0 : -Infinity;
    const lo = Math.max(center - dev, floor), hi = center + dev;
    const scale = d3.scaleDiverging([lo, center, hi], d3.interpolateRgbBasis(cols)).clamp(true);
    const tol = dev * 0.04;
    const tone = v => (!Number.isFinite(v) || Math.abs(v - center) <= tol ? "neutral" : (v < center) === (better === "lower") ? "good" : "bad");
    return {kind: "diverging", scale, center, better, lo, hi, tone, min: d3.min(vals), max: d3.max(vals)};
  };
  F.numOpt = numOpt;
  // Tone of a change (to − from) given the direction that's better; a change within 2% of `base` reads as no change.
  F.changeTone = (better, delta, base) => (!better || !delta || (Number.isFinite(base) && base && Math.abs(delta) < Math.abs(base) * 0.02) ? "neutral"
    : (delta < 0) === (better === "lower") ? "good" : "bad");
  F.toneColor = (C, tone) => (tone === "good" ? C.good : tone === "bad" ? C.bad : C.neutral);
  // Tone of a value against a centre, given the direction that's better.
  F.toneVs = (better, v, center, tol = 0) => (!better || !Number.isFinite(v) || center == null || Math.abs(v - center) <= tol ? "neutral"
    : (v < center) === (better === "lower") ? "good" : "bad");
  // Direction for one measure in multi-measure figures: a `better` column on the row, then options.better_by
  // {measure: "lower"|"higher"}, then options.better.
  F.betterFor = (ctx, key, row) => {
    const b = String((ctx.has("better") && row ? ctx.v("better")(row) : null) ?? (ctx.o.better_by || {})[key] ?? ctx.o.better ?? "").toLowerCase();
    return b === "lower" || b === "higher" ? b : null;
  };
  // Ordered categories (star ratings, quartiles): a ramp from bad to good through neutral.
  F.ordinalColors = (C, n, better = "higher") => {
    const cols = d3.quantize(d3.interpolateRgbBasis([C.bad, C.neutralMid, C.good]), Math.max(2, n));
    return better === "lower" ? cols.reverse() : cols;
  };
  F.stars = (n, max = 5) => "★".repeat(Math.max(0, Math.round(n))) + (max ? "☆".repeat(Math.max(0, max - Math.round(n))) : "");
  F.isStarScale = vals => vals.length > 1 && vals.every(v => Number.isInteger(+v) && +v >= 1 && +v <= 5);

  // Row-chart helpers shared by the template files.
  // The label column fits the longest label, and the longest sublabel under it (11 px) when there is one
  F.labelWidth = (ctx, rows, label, max = 0.36, sub = null) => Math.min(ctx.W * max, ctx.W > 900 ? 380 : 280,
    d3.max(rows, r => Math.max(F.textWidth(F.nameCase(label(r)), 13, 500), sub ? F.textWidth(sub(r), 11) : 0)) + 16 || 80);
  F.rowHover = (ctx, sel, tipFor) => {
    sel.on("mousemove", (ev, r) => ctx.tip.show(tipFor(r), ev)).on("mouseleave", () => ctx.tip.hide()).on("click", (ev, r) => ctx.pick(r));
  };
  F.sortRows = (rows, how, key, dir = "desc") => {
    if (how === "none") return rows;
    const s = how === "asc" || (how == null && dir === "asc") ? 1 : -1;
    return rows.sort((a, b) => s * (key(a) - key(b)));
  };
  // Hover/click the nearest point (Delaunay) inside rect [x, y, w, h].
  F.nearest = function (ctx, svg, pts, rect, onTip, onPick, radius = 28) {
    const del = d3.Delaunay.from(pts, p => p[0], p => p[1]);
    const ring = svg.append("circle").attr("r", 7).attr("fill", "none").attr("stroke", ctx.C.text).attr("stroke-width", 1.6).style("opacity", 0).style("pointer-events", "none");
    const find = ev => { const [mx, my] = d3.pointer(ev, svg.node()); const i = del.find(mx, my); const p = pts[i]; return p && Math.hypot(p[0] - mx, p[1] - my) < radius ? p : null; };
    svg.append("rect").attr("x", rect[0]).attr("y", rect[1]).attr("width", rect[2]).attr("height", rect[3]).attr("fill", "transparent")
      .on("mousemove", ev => { const p = find(ev); if (!p) { ring.style("opacity", 0); ctx.tip.hide(); return; } ring.attr("cx", p[0]).attr("cy", p[1]).style("opacity", 1); ctx.tip.show(onTip(p[2]), ev); })
      .on("mouseleave", () => { ring.style("opacity", 0); ctx.tip.hide(); })
      .on("click", ev => { const p = find(ev); if (p) onPick(p[2]); })
      .style("cursor", "crosshair");
  };
  // Share of units a value beats (0-1), given the direction that's better; ties count half.
  F.beats = (vals, v, better) => {
    if (!vals.length || !Number.isFinite(v)) return NaN;
    let worse = 0, tie = 0;
    for (const u of vals) { if (u === v) tie++; else if ((better === "higher") === (u < v)) worse++; }
    return (worse + (tie - 1) / 2) / Math.max(1, vals.length - 1);
  };
  F.ordinal = n => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

  // Tooltip: the dashboard's own (App.tip), so figures in answers look and right-click like the dashboard's charts.
  F.tooltip = function (card) {
    if (window.App && window.App.tip) return {show: (html, ev) => App.tip.show(html, ev), move: ev => App.tip.move(ev), hide: () => App.tip.hide()};
    let el = card.querySelector(".ftip");
    if (!el) { el = document.createElement("div"); el.className = "ftip"; card.append(el); }
    return {
      show(html, ev) { el.innerHTML = html; el.classList.add("on"); this.move(ev); },
      move(ev) {
        const r = card.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
        let x = ev.clientX - r.left + 14, y = ev.clientY - r.top + 14;
        if (x + w > r.width - 6) x = ev.clientX - r.left - w - 14;
        if (y + h > r.height - 6) y = ev.clientY - r.top - h - 14;
        el.style.left = Math.max(6, x) + "px"; el.style.top = Math.max(6, y) + "px";
      },
      hide() { el.classList.remove("on"); },
    };
  };
  F.tipHtml = (title, rows, sub) => `<div class="tt-title">${esc(title)}</div>${sub ? `<div class="tt-sub">${esc(sub)}</div>` : ""}` +
    `<table>${rows.filter(Boolean).map(([k, v, cls]) => `<tr><td>${esc(k)}</td><td class="${cls || ""}">${esc(v)}</td></tr>`).join("")}</table>`;

  // HTML legend chips: [{label, color, shape: sw|ring|line|dash, count}]
  F.chips = items => `<div class="flegend">${items.map(i => `<span class="fchip"><i class="${i.shape || "sw"}" data-css="${
    i.shape === "ring" ? `border-color:${i.color}` : i.shape === "dash" ? `border-color:${i.color}` : `background:${i.color}`}"></i>${esc(i.label)}${
    i.count != null ? ` <b>${esc(i.count)}</b>` : ""}</span>`).join("")}</div>`;

  // Gradient legend for a semantic scale, drawn into an svg group.
  F.gradientLegend = function (ctx, g, sem, width, fmt, title) {
    const {C, o} = ctx, id = "fg" + Math.random().toString(36).slice(2, 8);
    const grad = g.append("defs").append("linearGradient").attr("id", id);
    d3.range(0, 1.0001, 0.1).forEach(t => grad.append("stop").attr("offset", t).attr("stop-color", sem.scale(sem.lo + t * (sem.hi - sem.lo))));
    if (title) g.append("text").attr("y", -8).attr("class", "fl-title").text(title);
    g.append("rect").attr("width", width).attr("height", 8).attr("rx", 4).attr("fill", `url(#${id})`);
    const x = d3.scaleLinear([sem.lo, sem.hi], [0, width]);
    const midLabel = o.benchmark_label || (F.numOpt(o.benchmark) != null ? "Benchmark" : F.numOpt(o.center) != null ? "Center" : "Median");
    const ticks = sem.kind === "diverging" ? [sem.lo, sem.center, sem.hi] : [sem.lo, sem.hi];
    // Values beyond the colour scale take its end colour: say so at that end
    const beyond = (t, i) => (i === 0 && sem.min < t - 1e-9 ? "≤ " : i === ticks.length - 1 && sem.max > t + 1e-9 ? "≥ " : "");
    ticks.forEach((t, i) => {
      const mid = sem.kind === "diverging" && i === 1;
      g.append("text").attr("x", x(t)).attr("y", 22).attr("class", "fl-tick" + (mid ? " mid" : ""))
        .attr("text-anchor", i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle")
        .text(mid ? (o.benchmark_label && F.numOpt(o.benchmark) != null ? o.benchmark_label : `${midLabel} ${fmt(t)}`) : beyond(t, i) + fmt(t));
    });
    if (sem.kind === "diverging") g.append("line").attr("x1", x(sem.center)).attr("x2", x(sem.center)).attr("y1", -3).attr("y2", 11).attr("stroke", C.text).attr("stroke-width", 1.5);
  };

  // Axis labels from a value formatter, dropping decimals that are zero on every tick ("2.00, 4.00" -> "2, 4").
  F.tickFmt = (fmt, ticks) => {
    const re = /(\d)\.(\d+)/, labels = ticks.map(t => String(fmt(t)));
    const keep = d3.max(labels, s => { const mm = s.match(re); return mm ? mm[2].replace(/0+$/, "").length : 0; }) || 0;
    const out = new Map(ticks.map((t, i) => [t, labels[i].replace(re, (a, d0, dec) => (keep ? `${d0}.${dec.slice(0, keep)}` : d0))]));
    return t => (out.has(t) ? out.get(t) : fmt(t));
  };

  // Plain number for axis ticks: 0.2, 5, 50, 1k (d3's "~s" would print 0.2 as "200m").
  F.numTick = t => (Math.abs(t) >= 1000 ? d3.format("~s")(t) : d3.format("~g")(t));
  // Log axes: label only the 1-2-5 ticks.
  F.logTick = t => (/^[125]/.test(d3.format("~e")(t)) ? F.numTick(t) : "");

  // Light gridlines with tick labels.
  // Ticks whose labels would repeat ("4, 4" for 3.5 and 4 at no decimals) keep only the whole numbers
  F.uniqueTicks = (t, fmt) => {
    if (!fmt) return t;
    const labels = t.map(v => String(fmt(v)));
    if (new Set(labels).size === labels.length) return t;
    const whole = t.filter(v => Number.isInteger(+v.toFixed(9)));
    return whole.length >= 2 ? whole : t.filter((v, i) => labels.indexOf(labels[i]) === i);
  };
  F.gridY = (g, y, width, C, ticks = 5, fmt) => {
    const t = F.uniqueTicks(y.ticks ? y.ticks(ticks) : y.domain(), fmt);
    g.selectAll("line.gy").data(t).join("line").attr("class", "gy").attr("x1", 0).attr("x2", width).attr("y1", y).attr("y2", y).attr("stroke", C.grid);
    g.selectAll("text.gy").data(t).join("text").attr("class", "gy ftick").attr("x", -8).attr("y", d => y(d)).attr("dy", "0.32em").attr("text-anchor", "end").text(fmt ? F.tickFmt(fmt, t) : y.tickFormat(ticks));
  };
  F.gridX = (g, x, height, C, ticks = 5, fmt, top) => {
    const t = F.uniqueTicks(x.ticks(ticks), fmt);
    g.selectAll("line.gx").data(t).join("line").attr("class", "gx").attr("y1", 0).attr("y2", height).attr("x1", x).attr("x2", x).attr("stroke", C.grid);
    g.selectAll("text.gx").data(t).join("text").attr("class", "gx ftick").attr("y", top ? -8 : height + 16).attr("x", d => x(d)).attr("text-anchor", "middle").text(fmt ? F.tickFmt(fmt, t) : x.tickFormat(ticks));
  };

  // Point labels: try positions around each point and skip any that would collide or leave the plot.
  // items: [{x, y, text}] in priority order; bounds: [x0, y0, x1, y1]. Returns the items that didn't fit.
  // A position closer to another labelled point than to its own is skipped, so labels never swap places.
  F.placeLabels = (g, items, bounds, size = 11) => {
    const placed = [], skipped = [], h = size + 4;
    const hit = b => placed.some(p => !(b[0] > p[0] + p[2] || b[0] + b[2] < p[0] || b[1] > p[1] + p[3] || b[1] + b[3] < p[1]));
    const near = (b, px, py) => Math.hypot(Math.max(b[0] - px, 0, px - b[0] - b[2]), Math.max(b[1] - py, 0, py - b[1] - b[3]));
    const cands = [[10, -7, "start"], [-10, -7, "end"], [10, 15, "start"], [-10, 15, "end"], [0, -13, "middle"], [0, 24, "middle"],
      [12, -24, "start"], [-12, -24, "end"], [12, 32, "start"], [-12, 32, "end"], [14, -40, "start"], [-14, -40, "end"], [14, 48, "start"], [-14, 48, "end"]];
    items.forEach(it => {
      const w = F.textWidth(it.text, size, 650);
      for (const [dx, dy, anchor] of cands) {
        const tx = it.x + dx, ty = it.y + dy, bx = anchor === "start" ? tx : anchor === "end" ? tx - w : tx - w / 2;
        const box = [bx - 2, ty - size, w + 4, h];
        if (box[0] < bounds[0] || box[0] + box[2] > bounds[2] || box[1] < bounds[1] - 8 || box[1] + box[3] > bounds[3] + 4 || hit(box)) continue;
        const own = near(box, it.x, it.y);
        if (items.some(o => o !== it && near(box, o.x, o.y) < own - 1)) continue;
        placed.push(box);
        if (Math.abs(dy) > 20) g.append("line").attr("class", "fleader").attr("x1", it.x).attr("y1", it.y + (dy < 0 ? -5 : 5))
          .attr("x2", anchor === "middle" ? tx : tx - Math.sign(dx) * 3).attr("y2", ty - (dy < 0 ? -2 : size - 2));
        g.append("text").attr("class", "fpt-label").attr("x", tx).attr("y", ty).attr("text-anchor", anchor).text(it.text);
        return;
      }
      skipped.push(it);
    });
    return skipped;
  };

  // Keep label y positions at least `gap` apart (for end-of-line labels).
  F.dodge = (items, gap, lo, hi) => {
    items.sort((a, b) => a.y - b.y);
    for (let i = 1; i < items.length; i++) if (items[i].y - items[i - 1].y < gap) items[i].y = items[i - 1].y + gap;
    const over = items.length ? items[items.length - 1].y - hi : 0;
    if (over > 0) {
      items.forEach(it => (it.y -= over));
      for (let i = items.length - 2; i >= 0; i--) if (items[i + 1].y - items[i].y < gap) items[i].y = items[i + 1].y - gap;
    }
    items.forEach(it => (it.y = Math.max(lo, it.y)));
    return items;
  };

  // Distinct x values (years, dates or categories), numeric-sorted when they're numbers.
  F.xDomain = (rows, get) => {
    const vals = [...new Set(rows.map(get).filter(v => v != null && v !== ""))];
    const numeric = vals.length > 0 && vals.every(v => Number.isFinite(+v));
    return numeric ? [...new Set(vals.map(Number))].sort(d3.ascending) : vals;
  };
  // Natural order for labels like "1★".."5★" or "Q1".."Q4".
  F.natural = (a, b) => String(a).localeCompare(String(b), undefined, {numeric: true});
  F.shortYear = v => (/^\d{4}$/.test(String(v)) ? "’" + String(v).slice(2) : String(v));

  // Time stepper (chips + play) in the figure's control row; calls onChange(value).
  F.stepper = function (ctx, values, current, onChange) {
    const wrap = document.createElement("div");
    wrap.className = "fstep";
    wrap.innerHTML = `<button class="fplay" title="Play through" aria-label="Play">▶</button>` +
      values.map(v => `<button class="fchipbtn" data-v="${esc(v)}" aria-pressed="${String(v) === String(current)}">${esc(v)}</button>`).join("");
    ctx.controls.append(wrap);
    let timer = null;
    const set = v => {
      wrap.querySelectorAll(".fchipbtn").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === String(v))));
      onChange(values.find(x => String(x) === String(v)));
    };
    const play = wrap.querySelector(".fplay");
    const stop = () => { clearInterval(timer); timer = null; play.textContent = "▶"; };
    wrap.querySelectorAll(".fchipbtn").forEach(b => (b.onclick = () => { stop(); set(b.dataset.v); }));
    play.onclick = () => {
      if (timer) return stop();
      play.textContent = "❚❚";
      let i = values.findIndex(v => String(v) === wrap.querySelector('[aria-pressed="true"]')?.dataset.v);
      if (i >= values.length - 1) i = -1;
      timer = setInterval(() => { i += 1; set(values[i]); if (i >= values.length - 1) stop(); }, 1100);
    };
    ctx.cleanup(stop);
  };

  // Segmented choice in the control row.
  F.segmented = function (ctx, items, current, onChange) {
    const wrap = document.createElement("div");
    wrap.className = "fseg";
    wrap.innerHTML = items.map(([v, label]) => `<button data-v="${esc(v)}" aria-pressed="${String(v) === String(current)}">${esc(label)}</button>`).join("");
    wrap.querySelectorAll("button").forEach(b => (b.onclick = () => {
      wrap.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
      onChange(b.dataset.v);
    }));
    ctx.controls.append(wrap);
  };

  // Inline styles are written as data-css and applied through the CSSOM, as the dashboard does (App.applyCss), so
  // figures draw the same under a strict Content Security Policy. Tables that re-render (sorting, paging) are caught too.
  F.applyCss = root => root.querySelectorAll("[data-css]").forEach(n => {
    n.getAttribute("data-css").split(";").forEach(decl => {
      const i = decl.indexOf(":");
      if (i > 0) n.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
    });
    n.removeAttribute("data-css");
  });

  // Render a figure into `el`. `card` hosts the tooltip; `opts.onPick(row, pairs)` handles drill-down.
  F.render = function (el, card, d, opts = {}) {
    if (!el.__css) { el.__css = new MutationObserver(() => F.applyCss(el)); el.__css.observe(el, {childList: true, subtree: true}); }
    const draw = F.templates[d.template];
    if (!draw) throw new Error(`Unknown figure template "${d.template}"`);
    (el.__cleanups || []).forEach(fn => { try { fn(); } catch (e) { /* ignore */ } });
    el.__cleanups = [];
    el.innerHTML = "";
    const controls = document.createElement("div"); controls.className = "fcontrols"; el.append(controls);
    const body = document.createElement("div"); body.className = "fbody"; el.append(body);
    const notes = document.createElement("div"); notes.className = "fnotes"; el.append(notes);
    const C = F.palette(), f = d.fields || {}, state = (el.__state ||= {});
    let o = {...(d.options || {})}, rows = d.rows || [];
    const rerender = () => F.render(el, card, d, {...opts, anim: false});
    const top = document.createElement("div"); top.className = "ftop"; el.prepend(top);
    // options.select: one chip per value of a column; the figure shows one value at a time (e.g. one infection).
    if (typeof o.select === "string" && rows.some(r => o.select in r)) {
      const col = o.select, vals = [...new Set(rows.map(r => r[col]).filter(v => v != null && v !== ""))];
      const cur = vals.find(v => String(v) === String(state.select ?? o.select_default)) ?? vals[0];
      state.select = cur;
      rows = rows.filter(r => String(r[col]) === String(cur));
      const seg = document.createElement("div"); seg.className = "fseg fselect";
      seg.innerHTML = vals.map(v => `<button data-v="${esc(v)}" aria-pressed="${String(v) === String(cur)}">${esc(v)}</button>`).join("");
      seg.querySelectorAll("button").forEach(b => (b.onclick = () => { state.select = b.dataset.v; rerender(); }));
      top.append(seg);
    }
    // options.benchmark can name a column (e.g. the national value per infection): use the first row's value.
    if (typeof o.benchmark === "string" && rows.length && o.benchmark in rows[0]) o.benchmark = rows[0][o.benchmark];
    if (typeof o.benchmark_label === "string" && o.benchmark_label.includes("{value}") && numOpt(o.benchmark) != null)
      o.benchmark_label = o.benchmark_label.replace("{value}", F.formatter(o, [+o.benchmark])(+o.benchmark));
    // options.search: a box that highlights a unit by name (label-like column, or the column given).
    const searchCol = o.search === true ? f.label || f.series || f.state || f.row || f.facet || f.category : typeof o.search === "string" ? o.search : null;
    if (searchCol && rows.some(r => searchCol in r)) {
      const names = [...new Set(rows.map(r => r[searchCol]).filter(v => v != null && v !== "").map(String))].sort(F.natural);
      const id = "fs" + Math.random().toString(36).slice(2, 8), box = document.createElement("label"); box.className = "fsearch";
      box.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="5"/><path d="M11 11l3.5 3.5"/></svg>` +
        `<input list="${id}" placeholder="${esc(o.search_placeholder || "Highlight…")}" value="${esc(state.search || "")}" aria-label="Highlight">` +
        `${state.search ? `<button title="Clear" aria-label="Clear">×</button>` : ""}<datalist id="${id}">${names.slice(0, 6000).map(n => `<option value="${esc(n)}">`).join("")}</datalist>`;
      const input = box.querySelector("input");
      const apply = () => {
        const q = input.value.trim().toLowerCase(); if (!q) return;
        const hit = names.find(n => n.toLowerCase() === q) || (names.filter(n => n.toLowerCase().includes(q)).length === 1 ? names.find(n => n.toLowerCase().includes(q)) : null);
        if (hit && hit !== state.search) { state.search = hit; rerender(); }
      };
      input.addEventListener("change", apply);
      input.addEventListener("keydown", e => { if (e.key === "Enter") apply(); });
      box.querySelector("button")?.addEventListener("click", e => { e.preventDefault(); state.search = null; rerender(); });
      top.append(box);
    }
    // Offscreen frames can report 0 widths before layout; the frame's own width is always known.
    const W = Math.max(280, Math.floor(el.clientWidth || (card.clientWidth && card.clientWidth - 46) || window.innerWidth - 50 || 640));
    el.__drawnWidth = W;
    const highlight = new Set([].concat(o.highlight ?? [], state.search ? [state.search] : []).map(String));
    const ctx = {
      el: body, controls, notesEl: notes, card, W, rows, f, o, C, d, state, rerender,
      anim: !!opts.anim && !F.reduceMotion,
      tip: F.tooltip(card),
      has: role => !!f[role],
      v: role => r => r[f[role]],
      n: role => r => { const v = r[f[role]]; return v == null || v === "" ? NaN : +v; },
      name: role => (o.labels && o.labels[role]) || f[role] || role,
      hi: key => highlight.has(String(key)),
      anyHi: highlight.size > 0,
      cleanup: fn => el.__cleanups.push(fn),
      note: text => notes.insertAdjacentHTML("beforeend", `<div>${esc(text)}</div>`),
      legend: html => controls.insertAdjacentHTML("beforeend", html),
      svg(h, label) {
        return d3.select(body).append("svg").attr("class", "fsvg").attr("viewBox", `0 0 ${W} ${h}`).attr("width", W).attr("height", h)
          .attr("role", "img").attr("aria-label", label || d.title || "Figure");
      },
      transition(sel, delay = 0, dur = 700) {
        if (ctx.anim) return sel.transition().duration(dur).delay(delay).ease(d3.easeCubicOut);
        // Not animating: apply attrs now (a 0ms transition waits for a frame, which never comes in a hidden tab),
        // but still accept the transition-only calls templates chain on.
        const now = Object.create(sel), self = function () { return this; };
        return Object.assign(now, {delay: self, duration: self, ease: self});
      },
      // Drill-down: describe the clicked row by its mapped fields and hand it to the host.
      pick(row, extra) {
        if (!opts.onPick || !row) return;
        const pairs = [];
        for (const [role, col] of Object.entries(f)) {
          if (typeof col !== "string" || row[col] == null || pairs.some(p => p[2] === col)) continue;
          const v = row[col];
          pairs.push([ctx.name(role), typeof v === "number" ? +(+v).toFixed(3) : v, col]);
        }
        (extra || []).forEach(p => pairs.push(p));
        opts.onPick(row, pairs.slice(0, 7).map(p => [p[0], p[1]]));
      },
    };
    draw(ctx);
    F.applyCss(el);
    if (!notes.childElementCount) notes.remove();
    if (!controls.childElementCount) controls.remove();
    if (!top.childElementCount) top.remove();
  };
})();
