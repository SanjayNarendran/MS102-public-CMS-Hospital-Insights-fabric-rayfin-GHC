/* Ask your data: a readability check of each figure as it is drawn in the reader's page. The findings go back to
   Copilot with the figure's facts (copilot/server.py, page request "figure_check"), so it can redraw a figure that is
   hard to read before it writes about it: too small for its space, labels too small, overlapping or cut short, or
   colours that can't be told apart at the size they're drawn. */
(function () {
  'use strict';
  const Chat = window.Chat;
  const MAPS = new Set(['dot_map', 'tile_map', 'geo_map']);
  // Templates whose shape needs height; bar, table and grid templates are as tall as their rows need
  const TALL = new Set(['trend', 'scatter', 'fan', 'small_multiples', 'area_stack', 'bump', 'slope', 'beeswarm', 'funnel', 'distribution', 'waterfall', 'pareto']);
  const lab = (c) => { try { const l = d3.lab(c); return Number.isFinite(l.l) ? l : null; } catch (e) { return null; } };
  const dE = (a, b) => Math.hypot(a.l - b.l, a.a - b.a, a.b - b.b);
  const quote = (s, n = 30) => `"${s.length > n ? `${s.slice(0, n - 1)}…` : s}"`;
  const area = (r) => r.width * r.height;
  const visible = (el) => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0.05 && +(s.fillOpacity || 1) > 0.05;
  };

  // Waits for the figure's entry animations (d3 transitions) to finish, so it is measured as the reader will see it
  Chat.settled = async function (el, limit = 2500) {
    const t0 = performance.now();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    while (performance.now() - t0 < limit && [...el.querySelectorAll('svg *')].some((n) => n.__transition)) {
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  // A custom visual measures itself inside its sandbox (chat.js MEASURE); the findings join the page's own checks
  Chat.checkCustom = async function (card) {
    const plot = card.querySelector('.fx');
    return plot && plot.__measure ? plot.__measure() : [];
  };

  Chat.checkFigure = function (card, ui, surface, inside = []) {
    const plot = card.querySelector('.fx') || card;
    const box = plot.getBoundingClientRect();
    const where = surface === 'panel' ? 'the side panel' : 'the Ask your data tab';
    if (!box.width) return 'Readability check: skipped, the figure is not on screen.';
    const svgs = [...plot.querySelectorAll('svg')].filter((s) => s.getBoundingClientRect().width > 60);
    const main = svgs.sort((a, b) => area(b.getBoundingClientRect()) - area(a.getBoundingClientRect()))[0];
    const mb = main ? main.getBoundingClientRect() : box;
    const W = Math.round(mb.width), H = Math.round(mb.height);
    const template = ui.template || (ui.mode === 'html' ? 'custom d3' : 'Vega-Lite');
    const isMap = MAPS.has(ui.template) || (!ui.template && !!plot.querySelector('.mark-geoshape, path.mark-geoshape'));
    const out = [...inside];
    if (ui.mode === 'html') {
      const fr = plot.querySelector('iframe');
      if (fr) { const r = fr.getBoundingClientRect(); if (r.height < 120) out.push(`The custom visual is only ${Math.round(r.height)} px tall.`); }
    }

    if (isMap && (W < 480 || H < 300)) {
      out.push(`The map is only ${W}×${H} px in ${where}: states and dots are too small to read. Use ranked_bars or a ` +
        'table here, or focus a dot_map on the state asked about (options.focus).');
    } else if (W && H && H < 160 && TALL.has(ui.template)) {
      out.push(`The plot is only ${H} px tall, too flat to read its shape; set options.height (e.g. 320).`);
    }

    // Labels: too small, overlapping, cut short, or past the edge
    const texts = svgs.flatMap((s) => [...s.querySelectorAll('text')])
      .filter((t) => (t.textContent || '').trim() && visible(t))
      .map((t) => ({ t, r: t.getBoundingClientRect(), s: t.textContent.trim(), px: parseFloat(getComputedStyle(t).fontSize) * ((t.getScreenCTM() || { a: 1 }).a || 1) }))
      .filter((x) => x.r.width > 0);
    const tiny = texts.filter((x) => x.px < 9.5);
    if (tiny.length) out.push(`${tiny.length} label${tiny.length > 1 ? 's are' : ' is'} drawn below 10 px (e.g. ${quote(tiny[0].s)}); use fewer, larger labels or a wider layout.`);
    const T = texts.slice(0, 400), clash = [];
    for (let i = 0; i < T.length && clash.length < 50; i++) {
      for (let j = i + 1; j < T.length; j++) {
        const a = T[i].r, b = T[j].r;
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w <= 0 || h <= 0) continue;
        if (T[i].s === T[j].s && Math.abs(a.left - b.left) < 2 && Math.abs(a.top - b.top) < 2) continue;  // a halo copy
        if (w * h > 0.3 * Math.min(area(a), area(b))) clash.push([T[i].s, T[j].s]);
      }
    }
    if (clash.length) out.push(`${clash.length} pair${clash.length > 1 ? 's' : ''} of labels overlap (e.g. ${quote(clash[0][0], 24)} and ${quote(clash[0][1], 24)}); label fewer items, shorten them or give the figure more room.`);
    const cut = texts.filter((x) => /(…|\.\.\.)$/.test(x.s) && x.s.length > 1);
    if (cut.length >= 2) out.push(`${cut.length} labels are cut short (e.g. ${quote(cut[0].s)}), so the reader can't tell what those rows are; use shorter names or fewer columns.`);
    const past = texts.filter((x) => x.r.right > mb.right + 3 || x.r.left < mb.left - 3);
    if (past.length) out.push(`${past.length} label${past.length > 1 ? 's run' : ' runs'} past the edge of the figure (e.g. ${quote(past[0].s)}).`);

    // Colours that stand for groups (the legend): can they be told apart at the size the marks are drawn?
    const swatches = [...card.querySelectorAll('.flegend .fchip')].map((c) => {
      const i = c.querySelector('i');
      if (!i || /dash|tick|line/.test(i.className)) return null;
      const cs = getComputedStyle(i), col = /ring/.test(i.className) ? cs.borderTopColor : cs.backgroundColor;
      return { label: (c.textContent || '').trim().replace(/\s*[\d,.]+%?$/, ''), col: lab(col) };
    }).concat([...plot.querySelectorAll('.role-legend-symbol path, .role-legend .mark-symbol path')].map((p, k) => ({
      label: ((plot.querySelectorAll('.role-legend-label text')[k] || {}).textContent || `group ${k + 1}`).trim(), col: lab(getComputedStyle(p).fill),
    }))).filter((x) => x && x.col);
    const groups = [];
    swatches.forEach((x) => { if (!groups.some((g) => dE(g.col, x.col) < 1)) groups.push(x); });
    const circles = main ? [...main.querySelectorAll('circle')].filter((c) => c.__data__ !== undefined && visible(c)) : [];
    const radii = circles.map((c) => c.getBoundingClientRect().width / 2).filter((r) => r > 0).sort((a, b) => a - b);
    const smallMarks = radii.length > 5 && radii[Math.floor(radii.length / 2)] < 5.5;
    const close = [];
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i].col, b = groups[j].col, d = dE(a, b), dl = Math.abs(a.l - b.l);
        if (d < (smallMarks ? 40 : 22) && dl < 25) close.push(`${quote(groups[i].label, 24)} and ${quote(groups[j].label, 24)}`);
      }
    }
    if (close.length) {
      out.push(`${close.slice(0, 3).join('; ')} are hard to tell apart${smallMarks ? ` on ${Math.round(radii[Math.floor(radii.length / 2)] * 2)} px dots` : ''}. ` +
        'Make the group the question is about stand out: a strong colour for it (orange only if it is the worse group) and ' +
        'light grey for the rest (options.category_colors on dot_map, options.colors elsewhere, e.g. {"No cut": "muted", "Cut": "worse"}).');
    }
    if (groups.length > 7) out.push(`${groups.length} colours in the legend are more than a reader can match at a glance; show the few that matter and group the rest as Other, or use small multiples.`);
    const bg = lab(getComputedStyle(document.documentElement).getPropertyValue('--surface-2').trim());
    const faint = bg ? groups.filter((g) => dE(g.col, bg) < 14) : [];
    if (faint.length && groups.length > 1) out.push(`${quote(faint[0].label)} is nearly the colour of the background.`);

    const marks = main ? main.querySelectorAll('circle, rect, path, line').length : 0;
    if (main && !marks && !plot.querySelector('table')) out.push('Nothing was drawn: the figure is empty.');

    const head = `Readability check (${template}, drawn at ${W}×${H} px in ${where})`;
    if (!out.length) return `${head}: no problems measured. Still ask whether the person who asked sees the answer to their question in the first few seconds.`;
    return `${head} found problems. Fix them by calling the tool again with replace set to this figure's number (it is ` +
      `replaced in place; the title may change) before you write about it, and don't mention the fix in your reply:\n- ${out.join('\n- ')}`;
  };
})();
