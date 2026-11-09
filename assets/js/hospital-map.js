/* Chapter 03 drill-down: street map of a state's hospitals, coloured by the selected metric, with a "near me" search.
   Rendered with MapLibre GL (GPU vector tiles) so zooming is continuous; the library loads on first drill-down. */
(function () {
  'use strict';
  const App = window.App;
  const LOC = window.CMS_LOCATIONS;
  if (!LOC) return;

  const LIB_SRC = 'assets/vendor/maplibre/maplibre-gl.js';
  // Free vector basemaps (no API key, HTTP/2, browser-cacheable). Each style has a light and a dark variant that
  // follows the dashboard theme; the reader's choice is remembered on this device.
  const OFM = 'https://tiles.openfreemap.org/styles/', VT = 'https://tiles.versatiles.org/assets/styles/';
  const MAP_STYLES = {
    modern: { label: 'Modern', light: VT + 'muted/style.json', dark: VT + 'muted-dark/style.json' },
    streets: { label: 'Streets', light: OFM + 'liberty', dark: VT + 'colorful-dark/style.json' },
    minimal: { label: 'Minimal', light: OFM + 'positron', dark: OFM + 'dark', charcoal: true },
  };
  const STYLE_KEY = 'cms-map-style-v2';
  const PLACES_SRC = 'assets/places.js';
  const SHAPES_SRC = 'assets/state-shapes.js';
  // Where each state's two-letter code sits: its visual middle (Florida's peninsula, Michigan's lower peninsula), not its centroid
  const STATE_LABEL_AT = {
    AL: [-86.8, 32.8], AK: [-152.5, 64.4], AZ: [-111.7, 34.3], AR: [-92.4, 34.9], CA: [-119.6, 37.3], CO: [-105.5, 39.0], CT: [-72.7, 41.6],
    DE: [-75.5, 39.0], FL: [-81.6, 28.4], GA: [-83.4, 32.7], HI: [-156.4, 20.5], ID: [-114.6, 44.2], IL: [-89.2, 40.0], IN: [-86.3, 39.9],
    IA: [-93.5, 42.1], KS: [-98.4, 38.5], KY: [-85.3, 37.5], LA: [-92.3, 31.0], ME: [-69.2, 45.4], MD: [-76.8, 39.1], MA: [-71.9, 42.3],
    MI: [-84.7, 43.4], MN: [-94.3, 46.3], MS: [-89.7, 32.7], MO: [-92.6, 38.2], MT: [-109.6, 47.0], NE: [-99.8, 41.5], NV: [-116.7, 39.3],
    NH: [-71.6, 43.7], NJ: [-74.6, 40.1], NM: [-106.1, 34.4], NY: [-75.5, 42.9], NC: [-79.4, 35.5], ND: [-100.5, 47.4], OH: [-82.8, 40.3],
    OK: [-97.5, 35.5], OR: [-120.6, 43.9], PA: [-77.7, 40.9], RI: [-71.5, 41.7], SC: [-80.9, 33.9], SD: [-100.2, 44.4], TN: [-86.4, 35.8],
    TX: [-99.3, 31.3], UT: [-111.7, 39.3], VT: [-72.7, 44.0], VA: [-78.7, 37.5], WA: [-120.5, 47.4], WV: [-80.6, 38.6], WI: [-89.9, 44.6],
    WY: [-107.5, 43.0], PR: [-66.5, 18.22], VI: [-64.8, 18.0], GU: [144.78, 13.45],
  };
  // Place names, the way Zillow does it: each state's two or three biggest cities (and any city of 500,000+) are bold pills
  // from the national view; every other town appears as plain text once you zoom in far enough for it to fit
  const LABEL_TIERS = [
    { major: true, z: 3.6, size: [12.5, 15] },  // each state's largest city, and cities of 1,000,000+
    { major: true, z: 4.8, size: [12, 14.5] },  // its 2nd and 3rd largest, and cities of 500,000+
    { min: 100000, z: 6.3, size: [12, 14] }, { min: 30000, z: 7.3, size: [11.5, 13.5] }, { min: 10000, z: 8.3, size: [11.5, 13] },
    { min: 3000, z: 9.3, size: [11, 12.5] }, { min: 1000, z: 10.3, size: [11, 12.5] }, { min: 0, z: 11.2, size: [11, 12] },
  ];
  const MINOR_FROM = 2;
  // Zoomed out, a big city's pill sits above the hospital dots, beside the cluster of hospitals at its centre; zoomed in to
  // street level it drops under the dots so no downtown hospital is hidden
  const PILLS_UNDER_FROM_Z = 9;
  // Basemap place labels that ours replace (so no town is named twice) or that only clutter a U.S. map, like "United States"
  // across Kansas; neighbourhood names are kept, moved up to sit just under the hospital dots
  const HIDE_LABELS = /^(label-boundary-state|label-boundary-country|label-place-(city|statecapital|capital|town|village|hamlet)|label_(state|city|town|village|country)|place_(state|city|town|village|country))/;
  const LIFT_LABELS = /^(label-place-(suburb|quarter|neighbourhood)|label_other|place_(suburb|other))/;
  // The basemaps' faint dashed state lines; ours replace them
  const HIDE_LINES = /^(boundary-state|boundary_state|boundary_3)/;
  // Motion: one easing curve (the iOS sheet curve) and duration for every map transition, so they feel related
  const EASE_CSS = 'cubic-bezier(.32,.72,0,1)';
  const DUR = 520;
  const TILE_MAX_Z = 14;
  const PREFETCH_MAX = 60, PREFETCH_PARALLEL = 4;
  const APPROX = { z: true, p: true };
  const EMPTY = { type: 'FeatureCollection', features: [] };

  const TYPES = LOC.types || {};
  const point = (f, r) => ({ f, lat: r[0], lon: r[1], address: r[2], zip: r[3], precision: r[4], type: r[5], er: r[6] });
  // Scored hospitals from the semantic model, plus every other CMS hospital (no published scores) so no nearby option is hidden
  const points = App.facilities.map((f) => (LOC.rows[f.id] ? point(f, LOC.rows[f.id]) : null)).filter(Boolean)
    .concat(Object.entries(LOC.extra || {}).map(([id, r]) => point({ id, name: r[7], city: r[8], st: r[9], hai: 0, flagsWorse: 0, flagsBetter: 0, unscored: true }, r)));

  const ui = {};
  // Location is kept in memory only: it is never stored or sent anywhere
  const st = {
    map: null, styleId: '', styleReady: false, pending: null, me: null, popup: null, tip: null, hover: null, popupOpen: false,
    dotData: EMPTY, ringData: EMPTY, ringBounds: null, tileErrors: 0, prefetchGen: 0, prefetched: new Set(), idleTimer: 0,
    shownFocus: '', pendingCenter: false, loc: null, radius: 10, sort: 'near', zips: null, HM: null, color: null,
    full: false, ranksOpen: false, nearCollapsed: false, sideCollapsed: false, viewTimer: 0, morphing: null, inlineCanvas: null,
    places: null, labelData: { states: EMPTY, cities: EMPTY }, labelLayers: [], shapes: null, hoverState: '', refit: false, sug: [], sugActive: -1, blurTimer: 0,
    care: null, careMarkers: [], popupP: null,
    mapStyle: (() => { try { const s = localStorage.getItem(STYLE_KEY); return MAP_STYLES[s] ? s : 'minimal'; } catch (e) { return 'minimal'; } })(),
  };
  const scripts = {};
  const VIEW_LIST_MAX = 150;

  const esc = (s) => App.esc(s);
  const fmtMi = (d) => (d < 10 ? d.toFixed(1) : Math.round(d)) + ' mi';

  function miles(a, b) {
    const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * 3958.8 * Math.asin(Math.sqrt(h));
  }

  // Hospital-level version of the state metric selected in the chips
  function hospMetric(M) {
    const inf = App.infByKey[M.key];
    if (inf) {
      return {
        key: M.key, label: inf.short, title: `${inf.label}: hospital SIR, report year ${App.meta.haiYear}`,
        get: (f) => (f[M.key] ? f[M.key].sir : null), detail: (f) => f[M.key] || null,
        center: M.center, centerLabel: M.centerLabel, goodLow: true, fmt: App.f2, hai: true,
      };
    }
    if (M.key === 'psi90') {
      return {
        key: 'psi90', label: 'PSI‑90', title: `PSI‑90 patient safety composite, ${App.meta.psiYear}`,
        get: (f) => f.psi90, detail: () => null, center: M.center, centerLabel: M.centerLabel, goodLow: true, fmt: App.f2,
      };
    }
    if (M.key === 'ovr' || M.key === 'ed') {
      const ovr = M.key === 'ovr';
      return {
        key: M.key, label: ovr ? 'CMS overall rating' : 'ER time', title: M.title, local: true,
        get: (f) => { const x = App.xOf(f); return x && x[M.key] != null ? x[M.key] : null; }, detail: () => null,
        center: M.center, centerLabel: M.centerLabel, goodLow: !ovr, fmt: ovr ? (v) => `${v}★` : (v) => `${Math.round(v)} min`,
      };
    }
    // Both patient-experience chips map to each hospital's own HCAHPS star rating
    const H = App.H[App.H.length - 1];
    return {
      key: 'star', label: 'Star rating', title: `HCAHPS patient‑experience star rating, ${App.meta.hcahpsYear}`,
      get: (f) => f.star, detail: () => null, center: H.avgstar, centerLabel: `National avg ${App.f1(H.avgstar)}★`, goodLow: false, fmt: (v) => `${v}★`,
    };
  }

  // Dot colours live in styles.css (--hm-*) so the map and its legend always agree. Hospitals near the national figure get a
  // mid grey that reads on light and dark basemaps alike; the charts' neutral (near-white, or near-black in dark mode) would vanish.
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const mapNeutral = () => cssVar('--hm-neutral');

  function scaleFor(HM) {
    const devs = points.map((p) => HM.get(p.f)).filter((v) => v != null).map((v) => Math.abs(v - HM.center)).sort(d3.ascending);
    const dev = d3.quantile(devs, 0.9) || 0.1;
    const C = App.C, cols = HM.goodLow ? [C.good, mapNeutral(), C.bad] : [C.bad, mapNeutral(), C.good];
    // A power scale that takes on colour quickly: most hospitals sit close to the national figure, and a linear scale would leave
    // them washed-out grey
    return d3.scaleDivergingPow([HM.center - dev, HM.center, HM.center + dev], d3.interpolateRgbBasis(cols)).exponent(0.4).clamp(true);
  }

  function say(text, isError) {
    ui.status.textContent = text || '';
    ui.status.classList.toggle('error', !!isError);
  }

  // ---------- Map scaffolding ----------
  // Lazy-loads a script once; a failed load can be retried
  function loadScript(src) {
    if (!scripts[src]) {
      scripts[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => { delete scripts[src]; s.remove(); reject(new Error(`${src} unavailable`)); };
        document.head.appendChild(s);
      });
    }
    return scripts[src];
  }

  const loadLib = () => (window.maplibregl ? Promise.resolve() : loadScript(LIB_SRC));

  // CSS cubic-bezier as a JS easing function, so camera moves share the curve used by the CSS transitions
  function bezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sx = (t) => ((ax * t + bx) * t + cx) * t, sy = (t) => ((ay * t + by) * t + cy) * t, dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
    return (x) => {
      let t = x;
      for (let i = 0; i < 8; i++) { const e = sx(t) - x, d = dx(t); if (Math.abs(e) < 1e-5 || !d) break; t -= e / d; }
      return sy(Math.min(1, Math.max(0, t)));
    };
  }
  const EASE = bezier(0.32, 0.72, 0, 1);

  const themeName = () => (App.isDark() ? 'dark' : 'light');
  const styleId = () => `${st.mapStyle}:${themeName()}`;
  const styles = {};

  // OpenFreeMap's dark style is near-black; lift it onto the dashboard's warm charcoal palette.
  // Lightness is remapped per feature type so land sits at the card colour, water a little darker and cooler,
  // roads and boundaries lighter than land, and labels bright enough to read.
  function charcoal(style) {
    const lightness = (layer, prop, l) => {
      if (prop === 'text-halo-color') return 19 + l * 0.3;
      if (layer.type === 'symbol') return 30 + l;
      if (/water/.test(layer.id)) return 16 + l * 0.3;
      if (layer.type === 'line') return 22 + l * 0.75;
      return 21 + l * 0.5;
    };
    const tone = (v, layer, prop) => {
      const c = typeof v === 'string' && d3.color(v);
      if (!c) return v;
      const lab = d3.lab(c), cool = /water/.test(layer.id);
      return d3.lab(Math.min(92, lightness(layer, prop, lab.l)), lab.a * 0.4, lab.b * 0.4 + (cool ? -6 : 1.5), c.opacity).formatRgb();
    };
    const walk = (v, layer, prop) => (Array.isArray(v) ? v.map((x) => walk(x, layer, prop))
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, layer, prop)])) : tone(v, layer, prop));
    style.layers.forEach((layer) => {
      Object.keys(layer.paint || {}).forEach((k) => { if (k.endsWith('-color')) layer.paint[k] = walk(layer.paint[k], layer, k); });
    });
    return style;
  }

  function loadStyle(id) {
    if (styles[id]) return Promise.resolve();
    const [key, theme] = id.split(':'), def = MAP_STYLES[key], url = def[theme];
    if (!(def.charcoal && theme === 'dark')) { styles[id] = url; return Promise.resolve(); }
    return fetch(url).then((r) => r.json()).then((s) => { styles[id] = charcoal(s); });
  }

  // MapLibre keeps references into style objects, so each map gets its own copy
  const styleFor = (id) => (typeof styles[id] === 'string' ? styles[id] : JSON.parse(JSON.stringify(styles[id])));

  function flushPending() {
    if (st.pending) { const [c, m] = st.pending; st.pending = null; show(c, m); }
  }

  function ensureMap() {
    if (st.map) return true;
    try {
      // Scroll-wheel and trackpad zoom work whenever the pointer is over the map, like any maps app
      st.map = new maplibregl.Map({
        container: ui.canvas, style: styleFor(styleId()), center: [-98.35, 39.5], zoom: 3,
        minZoom: 2, maxZoom: 17, renderWorldCopies: false, dragRotate: false, pitchWithRotate: false, touchPitch: false,
        attributionControl: { compact: true }, fadeDuration: 150,
      });
    } catch (e) {
      st.map = null;
      say('This browser can’t display the interactive map (WebGL is unavailable).', true);
      return false;
    }
    st.styleId = styleId();
    // The canvas fades in once the first view has drawn, instead of popping in tile by tile
    ui.canvas.classList.add('is-loading');
    st.map.once('load', () => ui.canvas.classList.remove('is-loading'));
    st.map.touchZoomRotate.disableRotation();
    st.map.keyboard.disableRotation();
    st.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
    st.tip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'hm-tip', offset: 10, maxWidth: '280px' });
    st.map.on('style.load', onStyleLoad);
    // The basemap style references a few icons its sprite lacks; supply blanks instead of logging warnings
    st.map.on('styleimagemissing', (e) => { if (!st.map.hasImage(e.id)) st.map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) }); });
    st.map.on('mousemove', 'hm-dots', (e) => {
      st.map.getCanvas().style.cursor = 'pointer';
      const p = points[e.features[0].properties.i];
      if (st.hover === p) return;
      st.hover = p;
      st.tip.setLngLat([p.lon, p.lat]).setHTML(`<b>${esc(p.f.name)}</b><br>${esc(p.f.city)}, ${esc(p.f.st)} · ${esc(valueLine(p, st.HM))}`).addTo(st.map);
    });
    st.map.on('mouseleave', 'hm-dots', () => { st.map.getCanvas().style.cursor = ''; st.hover = null; st.tip.remove(); });
    st.map.on('click', 'hm-dots', (e) => { st.tip.remove(); openPopup(points[e.features[0].properties.i]); });
    st.map.on('mousemove', 'hm-state-hit', (e) => setHoverState(e.features[0].properties.code));
    st.map.on('mouseleave', 'hm-state-hit', () => setHoverState(''));
    st.map.on('error', (e) => {
      if (e.sourceId && !e.sourceId.startsWith('hm-') && ++st.tileErrors === 4) say('Street map tiles could not load (are you offline?). Hospital dots are still accurate.', true);
    });
    st.map.on('moveend', () => {
      // In full screen without a location, the side list follows whatever area is on screen
      if (st.full && !st.loc) { clearTimeout(st.viewTimer); st.viewTimer = setTimeout(renderNear, 150); }
      clearTimeout(st.idleTimer);
      st.idleTimer = setTimeout(prefetchAround, 400);
    });
    return true;
  }

  function onStyleLoad() {
    const C = App.C, dark = App.isDark();
    const firstSymbol = (st.map.getStyle().layers.find((l) => l.type === 'symbol') || {}).id;
    st.map.addSource('hm-veil', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] } } });
    st.map.addSource('hm-ring', { type: 'geojson', data: st.ringData });
    st.map.addSource('hm-hosp', { type: 'geojson', data: st.dotData });
    // A light veil over the basemap's roads and land (under its labels) so the hospitals are the brightest thing on the map
    st.map.addLayer({ id: 'hm-veil', type: 'fill', source: 'hm-veil', paint: { 'fill-color': C.bg, 'fill-opacity': dark ? 0.42 : 0.42 } }, firstSymbol);
    addBorders(firstSymbol);
    // The radius sits under place labels; hospital dots sit above everything so they are never hidden
    st.map.addLayer({ id: 'hm-ring-fill', type: 'fill', source: 'hm-ring', paint: { 'fill-color': C.text, 'fill-opacity': 0.05 } }, firstSymbol);
    st.map.addLayer({ id: 'hm-ring-line', type: 'line', source: 'hm-ring', paint: { 'line-color': C.text, 'line-opacity': 0.55, 'line-width': 1.5, 'line-dasharray': [2, 2.5] } }, firstSymbol);
    // A Copilot answer (nearest_care): the places it kept out of, and its routes, under the hospital dots
    st.map.addSource('hm-care-zones', { type: 'geojson', data: EMPTY });
    st.map.addSource('hm-care', { type: 'geojson', data: EMPTY });
    st.map.addLayer({ id: 'hm-care-zone-fill', type: 'fill', source: 'hm-care-zones', paint: { 'fill-color': C.text, 'fill-opacity': 0.07 } }, firstSymbol);
    st.map.addLayer({ id: 'hm-care-zone-line', type: 'line', source: 'hm-care-zones', paint: { 'line-color': C.text, 'line-opacity': 0.6, 'line-width': 1.5, 'line-dasharray': [2, 2] } }, firstSymbol);
    st.map.addLayer({ id: 'hm-care-casing', type: 'line', source: 'hm-care', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': C.surface, 'line-width': 7, 'line-opacity': 0.9 } });
    st.map.addLayer({ id: 'hm-care-route', type: 'line', source: 'hm-care', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': C.text, 'line-width': 3.5, 'line-opacity': 0.9 } });
    // Dots are drawn like map pins: a soft knock-out halo that pushes the streets back, an outer ring for hospitals that are
    // statistically better or worse, then the dot itself with a light outline. They grow as you zoom in.
    const scored = ['==', ['get', 's'], 1];
    const radius = (add) => ['interpolate', ['linear'], ['zoom'],
      3, ['case', scored, 3.4 + add * 0.5, 2.4], 5, ['case', scored, 5 + add * 0.7, 3.4], 8, ['case', scored, 7.2 + add, 5],
      11, ['case', scored, 9.5 + add, 6.5], 15, ['case', scored, 12 + add, 8.5]];
    // On a dark map the halo is a dark knock-out; on a light map it is a soft shadow, since a white outline alone disappears there
    st.map.addLayer({
      id: 'hm-dot-halo', type: 'circle', source: 'hm-hosp', filter: scored,
      paint: dark
        ? { 'circle-color': C.bg, 'circle-opacity': 0.75, 'circle-radius': radius(5), 'circle-blur': 0.6 }
        : { 'circle-color': C.text, 'circle-opacity': 0.28, 'circle-radius': radius(3), 'circle-blur': 0.75 },
    });
    st.map.addLayer({
      id: 'hm-sig', type: 'circle', source: 'hm-hosp', filter: ['==', ['get', 'g'], 1],
      paint: {
        'circle-opacity': 0, 'circle-radius': radius(3.2), 'circle-stroke-color': C.text,
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 3, 1, 8, 2],
      },
    });
    st.map.addLayer({
      id: 'hm-dots', type: 'circle', source: 'hm-hosp', layout: { 'circle-sort-key': ['get', 'k'] },
      paint: {
        'circle-color': ['get', 'c'], 'circle-opacity': ['get', 'op'], 'circle-radius': radius(0),
        'circle-stroke-color': ['get', 'sc'], 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 3, 0.8, 6, 1.4, 9, 2],
      },
    });
    addLabels();
    st.styleReady = true;
    flushPending();
  }

  // ---------- Place labels ----------
  // States are marked by their two-letter code; each state's biggest cities sit in grey pills and other towns are plain text.
  // Town names sit under the hospital dots, so a hospital is never hidden by a place name.
  // Labels come from our own gazetteer so every basemap style labels places the same way.
  function labelFonts() {
    return /versatiles/.test(String(st.map.getStyle().glyphs || ''))
      ? { regular: ['noto_sans_regular'], bold: ['noto_sans_bold'] } : { regular: ['Noto Sans Regular'], bold: ['Noto Sans Bold'] };
  }

  // A stretchable label for city names: small square corners keep their shape while the middle stretches to fit the name
  function pillImage() {
    const pr = 2, size = 24 * pr, inset = pr, w = size - 2 * inset, r = 3 * pr;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.beginPath();
    ctx.moveTo(inset + r, inset);
    ctx.arcTo(inset + w, inset, inset + w, inset + w, r);
    ctx.arcTo(inset + w, inset + w, inset, inset + w, r);
    ctx.arcTo(inset, inset + w, inset, inset, r);
    ctx.arcTo(inset, inset, inset + w, inset, r);
    ctx.closePath();
    ctx.fillStyle = cssVar('--hm-pill');
    ctx.fill();
    ctx.lineWidth = pr;
    ctx.strokeStyle = cssVar('--hm-pill-line');
    ctx.stroke();
    return ctx.getImageData(0, 0, size, size);
  }

  function addLabels() {
    const C = App.C, fonts = labelFonts();
    const halo = d3.color(App.isDark() ? C.bg : C.surface).copy({ opacity: 0.92 }).formatRgb();
    // Image pixels (2x): the ends stay round, the 4px middle stretches, and the name sits inside the content box
    if (!st.map.hasImage('hm-pill')) st.map.addImage('hm-pill', pillImage(), { pixelRatio: 2, stretchX: [[22, 26]], stretchY: [[22, 26]], content: [12, 9, 36, 39] });
    st.map.getStyle().layers.forEach((l) => {
      if (l.type !== 'symbol') return;
      if (HIDE_LABELS.test(l.id)) st.map.setLayoutProperty(l.id, 'visibility', 'none');
      else if (LIFT_LABELS.test(l.id)) st.map.moveLayer(l.id, 'hm-dot-halo');
    });
    st.map.addSource('hm-states', { type: 'geojson', data: st.labelData.states });
    st.map.addSource('hm-places', { type: 'geojson', data: st.labelData.cities });
    st.map.addLayer({
      id: 'hm-state-labels', type: 'symbol', source: 'hm-states', maxzoom: 7.6,
      layout: {
        'text-field': ['get', 'code'], 'text-font': fonts.bold, 'text-size': ['interpolate', ['linear'], ['zoom'], 3, 11.5, 5, 14, 7, 17],
        'text-letter-spacing': 0.08, 'text-padding': 2, 'symbol-sort-key': ['get', 'k'],
      },
      paint: {
        'text-color': C.text2, 'text-halo-color': halo, 'text-halo-width': 1.8, 'text-halo-blur': 0.4,
        'text-opacity': ['interpolate', ['linear'], ['zoom'], 6.6, 0.9, 7.6, 0],
      },
    });
    const pill = { 'icon-image': 'hm-pill', 'icon-text-fit': 'both', 'icon-text-fit-padding': [0, 3, 0, 3] };
    const pillPaint = { 'text-color': cssVar('--hm-pill-text'), 'icon-opacity': 0.95 };
    const base = (t) => ({
      'text-field': ['get', 'n'], 'text-font': t.major ? fonts.bold : fonts.regular,
      'text-size': ['interpolate', ['linear'], ['zoom'], t.z, t.size[0], 12, t.size[1]],
      'text-max-width': 10, 'text-padding': t.major ? 4 : 2, 'symbol-sort-key': ['-', 0, ['get', 'p']],
    });
    // Under the dots, smallest towns first so each bigger tier stacks above and wins where names would overlap
    st.labelLayers = [];
    for (let i = LABEL_TIERS.length - 1; i >= 0; i--) {
      const t = LABEL_TIERS[i], id = `hm-city-${i}`;
      const layout = { ...base(t), ...(t.major ? pill : {}), ...searchedLabelOffset() };
      const paint = t.major ? pillPaint : { 'text-color': C.text2, 'text-halo-color': halo, 'text-halo-width': 1.5, 'text-halo-blur': 0.3 };
      const minzoom = t.major ? Math.max(t.z, PILLS_UNDER_FROM_Z) : t.z;
      st.map.addLayer({ id, type: 'symbol', source: 'hm-places', minzoom, filter: ['==', ['get', 't'], i], layout, paint }, 'hm-dot-halo');
      st.labelLayers.push(id);
    }
    // Above the dots when zoomed out, placed beside the city's centre (below it if there is room) rather than on top of it
    for (let i = MINOR_FROM - 1; i >= 0; i--) {
      const t = LABEL_TIERS[i];
      st.map.addLayer({
        id: `hm-city-${i}-top`, type: 'symbol', source: 'hm-places', minzoom: t.z, maxzoom: PILLS_UNDER_FROM_Z, filter: ['==', ['get', 't'], i],
        layout: { ...base(t), ...pill, 'text-variable-anchor': ['top', 'bottom', 'right', 'left'], 'text-radial-offset': 1.1, 'text-justify': 'auto' },
        paint: pillPaint,
      });
    }
  }

  // The place you searched for has the search marker on it, so its name moves just below the marker
  function searchedLabelOffset() {
    const key = st.loc && st.loc.source === 'place' ? st.loc.key : '';
    const isIt = ['==', ['get', 'k'], key];
    return { 'text-anchor': ['case', isIt, 'top', 'center'], 'text-offset': ['case', isIt, ['literal', [0, 1.25]], ['literal', [0, 0]]] };
  }

  function updateSearchedLabel() {
    if (!st.map || !st.styleReady) return;
    const o = searchedLabelOffset();
    st.labelLayers.forEach((id) => Object.entries(o).forEach(([k, v]) => st.map.setLayoutProperty(id, k, v)));
  }

  function buildLabelData(places) {
    const states = Object.entries(STATE_LABEL_AT).map(([code, at], i) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: at },
      properties: { code, k: i },
    }));
    // Rank each state's towns by population: its top three (with 15,000+ people) are its "major" cities
    const rank = new Map(), seen = {};
    places.filter((p) => p.flag !== 'x').sort((a, b) => b.pop - a.pop).forEach((p) => { seen[p.st] = (seen[p.st] || 0) + 1; rank.set(p, seen[p.st]); });
    const cities = [];
    places.forEach((p) => {
      if (p.flag === 'x') return;
      const r = rank.get(p);
      const t = r === 1 || p.pop >= 1e6 ? 0
        : (r <= 3 && p.pop >= 15000) || p.pop >= 5e5 ? 1
          : MINOR_FROM + LABEL_TIERS.slice(MINOR_FROM).findIndex((x) => p.pop >= x.min);
      cities.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: { n: p.name, p: p.pop, t, k: `${p.name}|${p.st}` } });
    });
    st.labelData = { states: { type: 'FeatureCollection', features: states }, cities: { type: 'FeatureCollection', features: cities } };
    if (st.map && st.styleReady) {
      st.map.getSource('hm-states').setData(st.labelData.states);
      st.map.getSource('hm-places').setData(st.labelData.cities);
    }
    refreshDecor();
  }

  // ---------- State borders ----------
  // Clear state lines (Census boundaries) instead of the basemap's faint dashes, and the state you are viewing outlined in
  // the accent colour, like a search boundary
  const focusFilter = () => ['==', ['get', 'code'], App.state.focus || ''];

  function addBorders(beforeId) {
    const C = App.C, dark = App.isDark();
    st.map.getStyle().layers.forEach((l) => { if (l.type === 'line' && HIDE_LINES.test(l.id)) st.map.setLayoutProperty(l.id, 'visibility', 'none'); });
    // A solid mix rather than a transparent ink, so borders read the same everywhere
    const line = d3.interpolateRgb(C.bg, C.text)(dark ? 0.52 : 0.42);
    st.map.addSource('hm-state-shapes', { type: 'geojson', data: st.shapes ? st.shapes.states : EMPTY });
    st.map.addSource('hm-borders', { type: 'geojson', data: st.shapes ? st.shapes.borders : EMPTY });
    st.map.addLayer({
      id: 'hm-borders', type: 'line', source: 'hm-borders', layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': line, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.9, 6, 1.4, 10, 2] },
    }, beforeId);
    // An invisible fill that only detects which state the pointer is over
    st.hoverState = '';
    st.map.addLayer({ id: 'hm-state-hit', type: 'fill', source: 'hm-state-shapes', paint: { 'fill-color': '#000', 'fill-opacity': 0 } }, beforeId);
    st.map.addLayer({
      id: 'hm-focus-casing', type: 'line', source: 'hm-state-shapes', filter: focusFilter(), layout: { 'line-join': 'round' },
      paint: { 'line-color': C.bg, 'line-opacity': 0.75, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 4, 6, 6, 10, 8] },
    }, beforeId);
    st.map.addLayer({
      id: 'hm-focus-line', type: 'line', source: 'hm-state-shapes', filter: focusFilter(), layout: { 'line-join': 'round' },
      paint: { 'line-color': C.text, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1.6, 6, 2.4, 10, 3] },
    }, beforeId);
    // The hovered state's blue outline sits above the ink one so its whole boundary reads, including a shared border
    const fade = { duration: 180, delay: 0 };
    st.map.addLayer({
      id: 'hm-hover-casing', type: 'line', source: 'hm-state-shapes', filter: hoverFilter(), layout: { 'line-join': 'round' },
      paint: { 'line-color': C.bg, 'line-opacity': 0, 'line-opacity-transition': fade, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 4, 6, 6, 10, 8] },
    }, beforeId);
    st.map.addLayer({
      id: 'hm-hover-line', type: 'line', source: 'hm-state-shapes', filter: hoverFilter(), layout: { 'line-join': 'round' },
      paint: { 'line-color': C.good, 'line-opacity': 0, 'line-opacity-transition': fade, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1.6, 6, 2.4, 10, 3] },
    }, beforeId);
  }

  function setFocusOutline() {
    if (!st.map || !st.styleReady) return;
    ['hm-focus-casing', 'hm-focus-line'].forEach((id) => st.map.setFilter(id, focusFilter()));
    if (st.hoverState === App.state.focus) setHoverState('');
  }

  // ---------- Hovered state ----------
  // The state under the pointer is outlined in blue; the state being viewed keeps its accent outline instead
  const hoverFilter = () => ['==', ['get', 'code'], st.hoverState || ''];

  function setHoverState(code) {
    if (code === App.state.focus) code = '';
    if (!st.map || !st.map.getLayer('hm-hover-line') || code === st.hoverState) return;
    if (!code) {
      // Fade out in place; the filter keeps the old outline until the next state is hovered
      st.hoverState = '';
      st.map.setPaintProperty('hm-hover-casing', 'line-opacity', 0);
      st.map.setPaintProperty('hm-hover-line', 'line-opacity', 0);
      return;
    }
    st.hoverState = code;
    ['hm-hover-casing', 'hm-hover-line'].forEach((id) => st.map.setFilter(id, hoverFilter()));
    st.map.setPaintProperty('hm-hover-casing', 'line-opacity', 0.75);
    st.map.setPaintProperty('hm-hover-line', 'line-opacity', 1);
  }

  function loadShapes() {
    if (st.shapes) return Promise.resolve(st.shapes);
    return loadScript(SHAPES_SRC).then(() => {
      if (!st.shapes && window.CMS_STATE_SHAPES) {
        st.shapes = window.CMS_STATE_SHAPES;
        window.CMS_STATE_SHAPES = null;
        if (st.map && st.styleReady) {
          st.map.getSource('hm-state-shapes').setData(st.shapes.states);
          st.map.getSource('hm-borders').setData(st.shapes.borders);
        }
        refreshDecor();
      }
      return st.shapes;
    });
  }

  // ---------- The same look on other maps (the maternity tab) ----------
  // State lines with a blue outline on the state under the pointer, the two-letter state codes, and city names with the
  // biggest cities in pills. Layers are named with the caller's prefix; sources refill when the gazetteer or outlines load.
  const decorated = new Map();

  function refreshDecor() {
    decorated.forEach((P, map) => {
      if (!map.getStyle || !map.getSource(`${P}state-shapes`)) return;
      if (st.shapes) {
        map.getSource(`${P}state-shapes`).setData(st.shapes.states);
        map.getSource(`${P}borders`).setData(st.shapes.borders);
      }
      if (map.getSource(`${P}states`)) {
        map.getSource(`${P}states`).setData(st.labelData.states);
        map.getSource(`${P}places`).setData(st.labelData.cities);
      }
    });
  }

  // hoverColor: outline for the state under the pointer (defaults to the theme blue, as on the hospital map)
  function decorBorders(map, P, beforeId, hoverColor) {
    const C = App.C, dark = App.isDark();
    map.getStyle().layers.forEach((l) => { if (l.type === 'line' && HIDE_LINES.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none'); });
    const line = d3.interpolateRgb(C.bg, C.text)(dark ? 0.52 : 0.42);
    map.addSource(`${P}state-shapes`, { type: 'geojson', data: st.shapes ? st.shapes.states : EMPTY });
    map.addSource(`${P}borders`, { type: 'geojson', data: st.shapes ? st.shapes.borders : EMPTY });
    map.addLayer({
      id: `${P}borders`, type: 'line', source: `${P}borders`, layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': line, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.9, 6, 1.4, 10, 2] },
    }, beforeId);
    map.addLayer({ id: `${P}state-hit`, type: 'fill', source: `${P}state-shapes`, paint: { 'fill-color': '#000', 'fill-opacity': 0 } }, beforeId);
    const fade = { duration: 180, delay: 0 }, none = ['==', ['get', 'code'], ''];
    map.addLayer({
      id: `${P}hover-casing`, type: 'line', source: `${P}state-shapes`, filter: none, layout: { 'line-join': 'round' },
      paint: { 'line-color': C.bg, 'line-opacity': 0, 'line-opacity-transition': fade, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 4, 6, 6, 10, 8] },
    }, beforeId);
    map.addLayer({
      id: `${P}hover-line`, type: 'line', source: `${P}state-shapes`, filter: none, layout: { 'line-join': 'round' },
      paint: { 'line-color': hoverColor || C.good, 'line-opacity': 0, 'line-opacity-transition': fade, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1.6, 6, 2.4, 10, 3] },
    }, beforeId);
    if (!decorated.has(map)) {
      // Registered once per map; the layers they refer to are re-added on every style change
      let hover = '';
      const set = (code) => {
        if (code === hover || !map.getLayer(`${P}hover-line`)) return;
        hover = code;
        if (code) [`${P}hover-casing`, `${P}hover-line`].forEach((id) => map.setFilter(id, ['==', ['get', 'code'], code]));
        map.setPaintProperty(`${P}hover-casing`, 'line-opacity', code ? 0.75 : 0);
        map.setPaintProperty(`${P}hover-line`, 'line-opacity', code ? 1 : 0);
      };
      map.on('mousemove', `${P}state-hit`, (e) => set(e.features[0].properties.code));
      map.on('mouseleave', `${P}state-hit`, () => set(''));
      map.on('styledata', () => { hover = ''; });
    }
    decorated.set(map, P);
  }

  // shift: show town names this many zoom levels earlier (the maternity map is usually zoomed out to show long drives)
  function decorLabels(map, P, underId, shift = 0) {
    const C = App.C;
    const fonts = /versatiles/.test(String(map.getStyle().glyphs || ''))
      ? { regular: ['noto_sans_regular'], bold: ['noto_sans_bold'] } : { regular: ['Noto Sans Regular'], bold: ['Noto Sans Bold'] };
    const halo = d3.color(App.isDark() ? C.bg : C.surface).copy({ opacity: 0.92 }).formatRgb();
    if (!map.hasImage('hm-pill')) map.addImage('hm-pill', pillImage(), { pixelRatio: 2, stretchX: [[22, 26]], stretchY: [[22, 26]], content: [12, 9, 36, 39] });
    map.getStyle().layers.forEach((l) => {
      if (l.type !== 'symbol') return;
      if (HIDE_LABELS.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none');
      else if (LIFT_LABELS.test(l.id) && underId) map.moveLayer(l.id, underId);
    });
    map.addSource(`${P}states`, { type: 'geojson', data: st.labelData.states });
    map.addSource(`${P}places`, { type: 'geojson', data: st.labelData.cities });
    map.addLayer({
      id: `${P}state-labels`, type: 'symbol', source: `${P}states`, maxzoom: 7.6,
      layout: { 'text-field': ['get', 'code'], 'text-font': fonts.bold, 'text-size': ['interpolate', ['linear'], ['zoom'], 3, 11.5, 5, 14, 7, 17], 'text-letter-spacing': 0.08, 'text-padding': 2, 'symbol-sort-key': ['get', 'k'] },
      paint: { 'text-color': C.text2, 'text-halo-color': halo, 'text-halo-width': 1.8, 'text-halo-blur': 0.4, 'text-opacity': ['interpolate', ['linear'], ['zoom'], 6.6, 0.9, 7.6, 0] },
    }, underId);
    const pill = { 'icon-image': 'hm-pill', 'icon-text-fit': 'both', 'icon-text-fit-padding': [0, 3, 0, 3] };
    const pillPaint = { 'text-color': cssVar('--hm-pill-text'), 'icon-opacity': 0.95 };
    const base = (t) => ({ 'text-field': ['get', 'n'], 'text-font': t.major ? fonts.bold : fonts.regular, 'text-size': ['interpolate', ['linear'], ['zoom'], t.z, t.size[0], 12, t.size[1]],
      'text-max-width': 10, 'text-padding': t.major ? 4 : 2, 'symbol-sort-key': ['-', 0, ['get', 'p']] });
    for (let i = LABEL_TIERS.length - 1; i >= 0; i--) {
      const t = LABEL_TIERS[i];
      map.addLayer({
        id: `${P}city-${i}`, type: 'symbol', source: `${P}places`, minzoom: t.major ? Math.max(t.z, PILLS_UNDER_FROM_Z) : Math.max(2, t.z - shift), filter: ['==', ['get', 't'], i],
        // With shift (maternity), town names sit just below their point so result pins, which stand above it, don't cover them
        layout: { ...base(t), ...(t.major ? pill : shift ? { 'text-anchor': 'top', 'text-offset': [0, 0.45] } : {}) },
        paint: t.major ? pillPaint : { 'text-color': C.text2, 'text-halo-color': halo, 'text-halo-width': 1.5, 'text-halo-blur': 0.3 },
      }, underId);
    }
    for (let i = MINOR_FROM - 1; i >= 0; i--) {
      const t = LABEL_TIERS[i];
      map.addLayer({
        id: `${P}city-${i}-top`, type: 'symbol', source: `${P}places`, minzoom: t.z, maxzoom: PILLS_UNDER_FROM_Z, filter: ['==', ['get', 't'], i],
        layout: { ...base(t), ...pill, 'text-variable-anchor': ['top', 'bottom', 'right', 'left'], 'text-radial-offset': 1.1, 'text-justify': 'auto' },
        paint: pillPaint,
      });
    }
  }

  function boundsOf(pts) {
    let w = 180, s = 90, e = -180, n = -90;
    pts.forEach((p) => { w = Math.min(w, p.lon); e = Math.max(e, p.lon); s = Math.min(s, p.lat); n = Math.max(n, p.lat); });
    return [[w, s], [e, n]];
  }

  // ---------- Camera ----------
  const isSheet = () => window.matchMedia('(max-width: 720px)').matches;

  // How much of the map the full-screen side panel covers (a left panel on desktop, a bottom sheet on phones)
  function covered() {
    if (!st.full || st.sideCollapsed) return { left: 0, bottom: 0 };
    return isSheet() ? { left: 0, bottom: ui.side.offsetHeight } : { left: ui.side.offsetWidth, bottom: 0 };
  }

  function viewPadding(base) {
    const c = covered(), legend = st.full ? ui.legend.offsetHeight + 28 : 0;
    return { top: base, right: base, bottom: base + Math.max(c.bottom, legend), left: base + c.left };
  }

  // 'enter' eases in from a little further out (arriving from the state grid); 'fly' arcs between places
  function moveCamera(cam, how) {
    if (!cam) return;
    if (how === 'jump' || App.reduceMotion) { st.map.jumpTo(cam); return; }
    if (how === 'enter') {
      st.map.jumpTo({ center: cam.center, zoom: cam.zoom - 1.2 });
      st.map.easeTo({ center: cam.center, zoom: cam.zoom, duration: 1100, easing: EASE });
      return;
    }
    st.map.flyTo({ center: cam.center, zoom: cam.zoom, speed: 1.6, curve: 1.42, maxDuration: 2200, essential: true });
  }

  function fitToState(code, how) {
    const pts = points.filter((p) => p.f.st === code);
    if (!pts.length) return;
    moveCamera(st.map.cameraForBounds(boundsOf(pts), { padding: viewPadding(36), maxZoom: 10.5 }), how);
  }

  function fitToMe(how) {
    if (st.ringBounds) moveCamera(st.map.cameraForBounds(st.ringBounds, { padding: viewPadding(24), maxZoom: 14 }), how);
  }

  // ---------- Precaching ----------
  const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const lat2y = (lat, z) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };

  // The basemap's vector tile URL template, whichever provider the current style uses
  function basemapTemplate() {
    const sources = st.map.getStyle().sources;
    for (const id of Object.keys(sources)) {
      if (sources[id].type !== 'vector' || id.startsWith('hm-')) continue;
      const src = st.map.getSource(id);
      if (src && src.tiles && src.tiles[0]) return src.tiles[0];
    }
    return null;
  }

  // Warm the browser cache with the tiles a reader is likely to need next, nearest the centre first,
  // so a later zoom renders from cache instead of the network.
  function prefetch(regions) {
    if (!st.map || (navigator.connection && navigator.connection.saveData)) return;
    const tpl = basemapTemplate();
    if (!tpl) return;
    const gen = ++st.prefetchGen, urls = [];
    regions.forEach(({ bounds: [[w, s], [e, n]], center, zFrom, zTo }) => {
      for (let z = Math.max(0, zFrom); z <= Math.min(TILE_MAX_Z, zTo); z++) {
        const cx = lon2x(center[0], z), cy = lat2y(center[1], z), lvl = [];
        for (let x = lon2x(w, z); x <= lon2x(e, z); x++) for (let y = lat2y(n, z); y <= lat2y(s, z); y++) lvl.push([x, y, (x - cx) ** 2 + (y - cy) ** 2]);
        lvl.sort((a, b) => a[2] - b[2]).forEach(([x, y]) => urls.push(tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y)));
      }
    });
    const queue = urls.filter((u) => !st.prefetched.has(u)).slice(0, PREFETCH_MAX);
    let next = 0;
    const work = () => {
      if (gen !== st.prefetchGen || next >= queue.length) return;
      const u = queue[next++];
      st.prefetched.add(u);
      fetch(u, { priority: 'low' }).then((r) => r.arrayBuffer()).catch(() => st.prefetched.delete(u)).then(work);
    };
    for (let i = 0; i < PREFETCH_PARALLEL; i++) work();
  }

  // After the map settles: the centre of the view one level deeper (zoom in), the whole view one level up (zoom out),
  // and the search radius down to street level when a location is set
  function prefetchAround() {
    if (!st.map || !st.styleReady || ui.wrap.hidden) return;
    const z = Math.floor(st.map.getZoom()), b = st.map.getBounds(), c = st.map.getCenter();
    const qw = (b.getEast() - b.getWest()) / 4, qh = (b.getNorth() - b.getSouth()) / 4;
    const regions = [
      { bounds: [[c.lng - qw, c.lat - qh], [c.lng + qw, c.lat + qh]], center: [c.lng, c.lat], zFrom: z + 1, zTo: z + 1 },
      { bounds: [[b.getWest(), b.getSouth()], [b.getEast(), b.getNorth()]], center: [c.lng, c.lat], zFrom: z - 1, zTo: z - 1 },
    ];
    if (st.ringBounds) regions.unshift({ bounds: st.ringBounds, center: [st.loc.lon, st.loc.lat], zFrom: z, zTo: 12 });
    prefetch(regions);
  }

  // ---------- Hospital dots ----------
  function valueLine(p, HM) {
    const v = HM.get(p.f);
    return v == null ? `${HM.label} not reported` : `${HM.label} ${HM.fmt(v)}`;
  }

  function drawDots(HM, color) {
    const C = App.C;
    // Light outline on every scored dot; "no score" hospitals are hollow markers whose fill blanks out the streets behind them
    const outline = cssVar('--hm-outline'), hollow = cssVar('--hm-hollow');
    st.dotData = {
      type: 'FeatureCollection',
      features: points.map((p, i) => {
        const v = HM.get(p.f), d = HM.detail(p.f), significant = d && (d.cls === 'better' || d.cls === 'worse');
        // Sort key: hospitals furthest from the national figure draw on top where dots overlap
        const props = v == null
          ? { i, c: C.bg, op: 0.92, sc: hollow, s: 0, g: 0, k: 0 }
          : { i, c: color(v), op: 1, sc: outline, s: 1, g: significant ? 1 : 0, k: 1 + Math.abs(v - HM.center) };
        return { type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] }, properties: props };
      }),
    };
    st.map.getSource('hm-hosp').setData(st.dotData);
  }

  // Space the card must keep clear of: the map buttons along the top, the side panel and, in full screen, the floating legend
  function popupInsets() {
    const c = covered();
    return { top: 56, bottom: (st.full ? ui.legend.offsetHeight + 40 : 14) + c.bottom, left: 14 + c.left, right: 14 };
  }

  function openPopup(p) {
    if (st.popup) st.popup.remove();
    const content = popup(p), inset = popupInsets();
    // Never taller than the visible map, so it can always be panned fully into view
    content.style.maxHeight = `${Math.max(180, ui.canvas.clientHeight - inset.top - inset.bottom - 40)}px`;
    st.popup = new maplibregl.Popup({ className: 'hm-pop', maxWidth: '320px', offset: 12, focusAfterOpen: false })
      .setLngLat([p.lon, p.lat]).setDOMContent(content).addTo(st.map);
    st.popupOpen = true;
    st.popupP = p;
    st.popup.on('close', () => { st.popupOpen = false; st.popupP = null; });
    requestAnimationFrame(() => keepPopupInView(st.popup));
  }

  // Pan the map just enough that the whole card sits inside the visible map, like a maps app does.
  // Re-checks once the pan settles, in case it was interrupted or the card changed size.
  function keepPopupInView(pop, retries = 1) {
    if (!pop || !pop.isOpen() || pop !== st.popup) return;
    const i = popupInsets(), box = ui.canvas.getBoundingClientRect(), r = pop.getElement().getBoundingClientRect();
    const dx = r.right > box.right - i.right ? r.right - (box.right - i.right) : r.left < box.left + i.left ? r.left - (box.left + i.left) : 0;
    const dy = r.bottom > box.bottom - i.bottom ? r.bottom - (box.bottom - i.bottom) : r.top < box.top + i.top ? r.top - (box.top + i.top) : 0;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    if (retries > 0) st.map.once('moveend', () => keepPopupInView(pop, retries - 1));
    st.map.panBy([Math.round(dx), Math.round(dy)], { duration: App.reduceMotion || !retries ? 0 : 300, easing: EASE });
  }

  function measureBlock(p, HM, color) {
    const v = HM.get(p.f);
    if (p.f.unscored && v == null) {
      return `<div class="hm-measure none"><span class="hm-m-label">CMS quality scores</span><span class="hm-m-value">None published</span>
        <span class="hm-m-note">This hospital has no published infection, patient‑experience or PSI‑90 score for the latest period. That is common for critical access, children's and psychiatric hospitals, so it says nothing about quality either way.</span></div>`;
    }
    if (v == null) {
      return `<div class="hm-measure none"><span class="hm-m-label">${esc(HM.label)}</span><span class="hm-m-value">Not reported</span>
        <span class="hm-m-note">${HM.hai ? 'CMS publishes an SIR only when at least one infection is predicted.' : 'No score was published for this period.'}</span></div>`;
    }
    let note = '';
    let tag = '';
    if (HM.hai) {
      const d = HM.detail(p.f);
      tag = `<span class="pill ${d.cls}">${App.CLS_LABEL[d.cls]}</span>`;
      note = `${App.f0(d.obs)} infections observed vs ${App.f1(d.pred)} predicted` + (d.lo != null && d.hi != null ? ` · 95% CI ${App.f2(d.lo)}–${App.f2(d.hi)}` : '');
    } else if (HM.key === 'psi90') {
      const better = v < HM.center;
      tag = `<span class="pill ${better ? 'better' : 'worse'}">${better ? 'Below' : 'Above'} national ${App.f2(HM.center)}</span>`;
      note = 'Lower is better. Composite of 10 Medicare patient‑safety indicators.';
    } else if (HM.key === 'ed') {
      const faster = v < HM.center;
      tag = `<span class="pill ${faster ? 'better' : 'worse'}">${faster ? 'Faster' : 'Slower'} than national ${Math.round(HM.center)} min</span>`;
      note = 'Median minutes from arrival to leaving the emergency department, for patients sent home (CMS OP‑18b).';
    } else if (HM.key === 'ovr') {
      tag = `<span class="pill ${v >= 4 ? 'better' : v <= 2 ? 'worse' : 'similar'}">${v} of 5 stars</span>`;
      note = 'CMS overall rating, combining mortality, safety, readmission, patient experience and timely care.';
    } else {
      tag = `<span class="pill ${v >= 4 ? 'better' : v <= 2 ? 'worse' : 'similar'}">${v} of 5 stars</span>`;
      note = `National average ${App.f2(HM.center)} stars, from patient surveys.`;
    }
    return `<div class="hm-measure"><span class="hm-m-label">${esc(HM.label)}</span>
      <span class="hm-m-value"><i class="hm-sw" data-css="background:${color(v)}"></i>${HM.fmt(v)} ${tag}</span>
      <span class="hm-m-note">${note}</span></div>`;
  }

  // "Critical access hospital · Emergency department" — what a family needs to know before driving there
  function facilityLine(p) {
    const parts = [];
    if (TYPES[p.type]) parts.push(TYPES[p.type]);
    if (p.er === 1) parts.push('Emergency department');
    else if (p.er === 0) parts.push('No emergency department');
    return parts.join(' · ');
  }

  // Outcomes, ED timeliness and penalties from the local Care Compare files, shown for every hospital that has them
  function outcomeRows(x) {
    if (!x) return '';
    const grp = (g) => (g ? (g.worse ? `${g.worse} worse than national` : g.better ? `${g.better} better than national` : 'No different from national') : null);
    const rows = [
      ['CMS overall rating', x.ovr != null ? `${x.ovr} of 5` : null],
      ['Death rates (30‑day)', grp(x.mortN)],
      ['Readmission rates', grp(x.readmN)],
      ['Median ER time', x.ed != null ? `${x.ed} min` : null],
      ['Medicare HAC penalty', x.hacCut != null ? (x.hacCut ? '1% payment cut' : 'None') : null],
    ].filter((r) => r[1] != null);
    return rows.length ? `<table class="hm-other">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${esc(v)}</td></tr>`).join('')}</table>` : '';
  }

  function popup(p) {
    const f = p.f, HM = st.HM;
    const dist = st.loc ? `<div class="hm-dist">${fmtMi(miles(st.loc, p))} from ${esc(st.loc.label)}</div>` : '';
    const approx = APPROX[p.precision] ? `<div class="hm-approx">Map position is approximate (${esc(LOC.precision[p.precision])}).</div>` : '';
    const haiLine = f.hai ? `${f.flagsWorse} worse · ${f.flagsBetter} better · ${f.hai - f.flagsWorse - f.flagsBetter} no different` : 'None reported';
    const addr = `${p.address}, ${f.city}, ${f.st} ${p.zip}`;
    const kind = facilityLine(p);
    const el = document.createElement('div');
    el.className = 'hm-card';
    el.innerHTML = `
      <div class="hm-name">${esc(f.name)}</div>
      <div class="hm-addr">${esc(addr)}</div>
      ${kind ? `<div class="hm-kind${p.er === 0 ? ' no-er' : ''}">${esc(kind)}</div>` : ''}
      ${dist}${approx}
      ${measureBlock(p, HM, st.color)}
      ${f.unscored ? '' : `<table class="hm-other">
        <tr><td>Infection measures vs benchmark</td><td>${haiLine}</td></tr>
        <tr><td>Patient star rating</td><td>${f.star != null ? `${f.star} of 5` : '—'}</td></tr>
        <tr><td>PSI‑90 safety composite</td><td>${f.psi90 != null ? App.f2(f.psi90) : '—'}</td></tr>
      </table>`}
      ${outcomeRows(App.xOf(f))}
      <div class="hm-links">
        <a href="https://www.medicare.gov/care-compare/details/hospital/${encodeURIComponent(f.id)}" target="_blank" rel="noopener noreferrer">Medicare Care Compare</a>
        <a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}" target="_blank" rel="noopener noreferrer">Directions in Google Maps</a>
      </div>`;
    App.applyCss(el);
    return el;
  }

  // ---------- Your location ----------
  function circleFeature(lat, lon, radiusMiles, steps = 96) {
    const d = radiusMiles / 3958.8, la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180, ring = [];
    for (let i = 0; i <= steps; i++) {
      const b = (2 * Math.PI * i) / steps;
      const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
      const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
      ring.push([(lo2 * 180) / Math.PI, (la2 * 180) / Math.PI]);
    }
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} };
  }

  function drawMe(fit) {
    if (!st.map || !st.styleReady) return;
    const C = App.C;
    // Neutral ink, not the accent, so "you" never reads as a worse-scoring hospital
    ['hm-ring-fill', 'hm-ring-line'].forEach((id, i) => st.map.setPaintProperty(id, i ? 'line-color' : 'fill-color', C.text));
    if (!st.loc) {
      st.ringData = EMPTY;
      st.ringBounds = null;
      if (st.me) { st.me.remove(); st.me = null; }
    } else {
      const ring = circleFeature(st.loc.lat, st.loc.lon, st.radius);
      st.ringData = { type: 'FeatureCollection', features: [ring] };
      st.ringBounds = boundsOf(ring.geometry.coordinates[0].map(([lon, lat]) => ({ lon, lat })));
      if (!st.me) {
        const el = document.createElement('div');
        el.className = 'hm-me';
        el.innerHTML = '<span></span>';
        st.me = new maplibregl.Marker({ element: el, anchor: 'center' });
      }
      st.me.getElement().title = st.loc.source === 'gps' ? 'Your location' : st.loc.label;
      st.me.setLngLat([st.loc.lon, st.loc.lat]).addTo(st.map);
    }
    st.map.getSource('hm-ring').setData(st.ringData);
    updateSearchedLabel();
    drawCare();
    if (fit) fitToMe('fly');
  }

  // ---------- A Copilot answer on this map ----------
  // nearest_care's hospitals, numbered by drive time, with their routes and the places the answer kept out of. It stays
  // until the next search, or until the location is cleared.
  function drawCare() {
    if (!st.map || !st.styleReady || !st.map.getSource('hm-care')) return;
    st.careMarkers.forEach((m) => m.remove());
    st.careMarkers = [];
    const p = st.care;
    st.map.getSource('hm-care').setData(!p ? EMPTY : { type: 'FeatureCollection', features: p.results.filter((x) => x.line && x.line.length > 1)
      .map((x) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: x.line.map(([la, lo]) => [lo, la]) } })) });
    st.map.getSource('hm-care-zones').setData(!p ? EMPTY : { type: 'FeatureCollection', features: (p.zones || []).map((z) => (z.outline
      ? { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: z.outline.map((r) => [r.map(([la, lo]) => [lo, la])]) } }
      : circleFeature(z.lat, z.lon, z.miles, 72))) });
    if (!p) return;
    const fmtMin = (m) => (m < 60 ? `${Math.max(1, Math.round(m))} min` : `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')} min`);
    p.results.filter((x) => x.role === 'top').forEach((x, i) => {
      const el = document.createElement('div');
      el.className = 'mat-pin ld';
      el.innerHTML = `<span>${i + 1}</span><em>${fmtMin(x.minutes)}${x.routed ? '' : ' est.'}</em>`;
      el.title = `${x.name} · ${fmtMin(x.minutes)}`;
      st.careMarkers.push(new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([x.lon, x.lat]).addTo(st.map));
    });
  }

  function showCare(p) {
    if (!p || !p.results || !p.results.length) return Promise.resolve(false);
    const o = p.origin, far = Math.max(...p.results.map((x) => x.straight_miles || 0));
    const radii = [...ui.radius.options].map((x) => +x.value);
    st.radius = radii.find((r) => r >= far) || radii[radii.length - 1];
    ui.radius.value = String(st.radius);
    st.care = p;
    const label = o.label || 'this spot';
    ui.search.value = label.charAt(0).toUpperCase() + label.slice(1);
    setLocation({ lat: o.lat, lon: o.lon, label, source: 'copilot' });
    return Promise.resolve(true);
  }

  // What the map shows now, for Copilot: the state and measure, the place searched and the hospitals listed, the open card
  function describe() {
    if (!st.shownFocus || ui.wrap.hidden || !st.HM) return null;
    const HM = st.HM, lines = [`Hospital street map (section 03, Fig 5): ${App.STATE_NAMES[st.shownFocus] || st.shownFocus}, hospitals coloured by ${HM.label}.`];
    const one = (x) => { const f = x.p.f, v = HM.get(f); return `${f.name} (${f.city}, ${f.st}; CCN ${f.id}; ${x.p.er === 1 ? 'emergency department' : x.p.er === 0 ? 'no emergency department' : 'ER unknown'}; ${v == null ? `${HM.label} not reported` : `${HM.label} ${HM.fmt(v)}`}) ${fmtMi(x.d)}`; };
    let suggest = [];
    if (st.loc) {
      const items = points.map((p) => ({ p, d: miles(st.loc, p) })).filter((x) => x.d <= st.radius).sort((a, b) => a.d - b.d);
      lines.push(`Searched ${st.loc.label} (lat ${st.loc.lat.toFixed(4)}, lon ${st.loc.lon.toFixed(4)}), within ${st.radius} miles: ${items.length} hospitals. Nearest: ${items.slice(0, 8).map(one).join('; ')}.`);
      const place = st.loc.source === 'gps' ? 'me' : st.loc.label;
      suggest = [`Which hospitals within ${st.radius} miles of ${place} do best on ${HM.label}?`, `Directions to the nearest emergency department from ${place}`];
    }
    if (st.care) lines.push(`It shows Copilot’s last answer: routes to ${st.care.results.filter((x) => x.role === 'top').map((x) => x.name).join(', ')}${(st.care.zones || []).length ? `, keeping out of ${st.care.zones.map((z) => z.name).join(', ')}` : ''}.`);
    if (st.popupOpen && st.popupP) {
      const f = st.popupP.f;
      lines.push(`Card open on the map: ${f.name} (${f.city}, ${f.st}; CCN ${f.id}): ${valueLine(st.popupP, HM)}.`);
      suggest.unshift(`How does ${f.name} compare with the hospitals around it?`);
    }
    const subject = st.popupOpen && st.popupP ? { title: st.popupP.f.name, detail: `${st.popupP.f.city}, ${st.popupP.f.st} · ${valueLine(st.popupP, HM)}` }
      : st.loc ? { title: `Hospitals within ${st.radius} miles of ${st.loc.source === 'gps' ? 'you' : st.loc.label}`, detail: `Coloured by ${HM.label}` } : null;
    return { text: lines.join('\n'), suggest, subject };
  }

  function setLocation(loc) {
    if (loc.source !== 'copilot') st.care = null;
    st.loc = loc;
    let best = null, bestD = Infinity;
    points.forEach((p) => { const d = miles(loc, p); if (d < bestD) { bestD = d; best = p; } });
    say('');
    st.pendingCenter = true;
    // Focus the state of the nearest hospital; neighbouring states remain on the map
    const code = best ? best.f.st : App.state.focus;
    if (code && App.state.focus !== code) App.setFocus(code);
    else App.renderOne('map');
    if (!st.full) ui.wrap.scrollIntoView({ block: 'nearest', behavior: App.reduceMotion ? 'auto' : 'smooth' });
  }

  function locate() {
    if (!navigator.geolocation || !window.isSecureContext) {
      say('This browser can’t share your location here. Search for your ZIP code or city instead.', true);
      ui.search.focus();
      return;
    }
    say('Finding your location…');
    ui.locate.disabled = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        ui.locate.disabled = false;
        setLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'you', source: 'gps' });
      },
      (err) => {
        ui.locate.disabled = false;
        say(err.code === 1 ? 'Location access is blocked for this page. Search for your ZIP code or city instead.' : 'Your location couldn’t be found. Search for your ZIP code or city instead.', true);
        ui.search.focus();
      },
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 },
    );
  }

  function loadZips() {
    if (st.zips) return Promise.resolve(st.zips);
    return loadScript('assets/zip-centroids.js').then(() => {
      if (!st.zips) {
        const m = new Map();
        String(window.CMS_ZIPS || '').split(';').forEach((r) => { const [z, a, b] = r.split(','); if (z) m.set(z, [+a, +b]); });
        window.CMS_ZIPS = null;
        st.zips = m;
      }
      return st.zips;
    }, () => { throw new Error('ZIP lookup unavailable'); });
  }

  function useZip(z) {
    say('Looking up ZIP code…');
    loadZips().then((m) => {
      const hit = m.get(z);
      if (!hit) { say(`ZIP ${z} wasn’t found. PO‑box and business‑only ZIPs aren’t mapped; try your home ZIP code or your city.`, true); return; }
      setLocation({ lat: hit[0], lon: hit[1], label: `ZIP ${z}`, source: 'zip', zip: z });
    }, () => say('The ZIP code lookup file could not be loaded.', true));
  }

  // ---------- Search: ZIP code, city or state ----------
  // Lower-case, no accents or punctuation, and the usual abbreviations spelled out ("St. Paul" = "Saint Paul").
  // Only a leading word is expanded, so a trailing state code such as "MT" stays a state code.
  const ABBR = { st: 'saint', ste: 'sainte', ft: 'fort', mt: 'mount' };
  const normName = (s) => {
    const w = String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[.'’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ');
    return w.map((x, i) => (i < w.length - 1 && ABBR[x]) || x).join(' ');
  };

  let stateList = null;
  const states = () => (stateList = stateList || Object.entries(App.STATE_NAMES).map(([code, name]) => ({ code, name, key: normName(name) })));

  function loadPlaces() {
    if (st.places) return Promise.resolve(st.places);
    return loadScript(PLACES_SRC).then(() => {
      if (!st.places) {
        st.places = String(window.CMS_PLACES || '').split('\n').filter(Boolean).map((r) => {
          const [name, stc, lat, lon, pop, flag, county] = r.split('|');
          return { name, st: stc, lat: +lat, lon: +lon, pop: +pop, flag: flag || '', county: county || '', key: normName(name) };
        });
        window.CMS_PLACES = null;
        buildLabelData(st.places);
      }
      return st.places;
    });
  }

  // "Woodbury, MN", "Woodbury MN" and "Woodbury Minnesota" narrow the search to one state
  function stateQualifier(raw) {
    const resolve = (text, allowPrefix) => {
      const k = normName(text);
      if (!k) return '';
      if (k.length === 2 && App.STATE_NAMES[k.toUpperCase()]) return k.toUpperCase();
      const exact = states().find((s) => s.key === k);
      if (exact) return exact.code;
      const pre = allowPrefix && k.length >= 3 ? states().filter((s) => s.key.startsWith(k)) : [];
      return pre.length === 1 ? pre[0].code : '';
    };
    const comma = raw.lastIndexOf(',');
    if (comma > 0) {
      const code = resolve(raw.slice(comma + 1), true);
      return code ? { rest: raw.slice(0, comma), st: code } : null;
    }
    const words = normName(raw).split(' ');
    for (let n = Math.min(3, words.length - 1); n >= 1; n--) {
      const code = resolve(words.slice(-n).join(' '), false);
      if (code) return { rest: words.slice(0, -n).join(' '), st: code };
    }
    return null;
  }

  // Best matches first: exact name, then names starting with the text, then any word starting with it;
  // states before towns, bigger towns before smaller ones
  function suggest(raw) {
    const q = raw.trim();
    if (!q) return [];
    if (/^\d+$/.test(q)) return /^\d{5}$/.test(q) ? [{ kind: 'zip', zip: q }] : [];
    const full = normName(q);
    if (!full) return [];
    const tier = (key, k) => (key === k ? 0 : key.startsWith(k) ? 1 : key.includes(` ${k}`) ? 2 : -1);
    const out = [];
    states().forEach((s) => {
      const t = full.length === 2 && s.code.toLowerCase() === full ? 0 : tier(s.key, full);
      if (t === 0 || (t > 0 && full.length >= 2)) out.push({ kind: 'state', code: s.code, name: s.name, tier: t, rank: Infinity });
    });
    const qual = stateQualifier(q);
    const variants = [{ k: full, st: '' }].concat(qual && qual.rest ? [{ k: normName(qual.rest), st: qual.st }] : []);
    (st.places || []).forEach((p) => {
      let best = -1;
      variants.forEach((v) => {
        if (v.st && p.st !== v.st) return;
        const t = tier(p.key, v.k);
        if (t >= 0 && (best < 0 || t < best)) best = t;
      });
      if (best >= 0) out.push({ kind: 'place', p, tier: best, rank: p.flag === 'x' ? p.pop / 4 : p.pop });
    });
    return out.sort((a, b) => a.tier - b.tier || b.rank - a.rank).slice(0, 8);
  }

  function nearestPlaceTo(lat, lon) {
    let best = null, bestD = Infinity;
    (st.places || []).forEach((p) => {
      if (p.pop < 1000 || p.flag === 'x') return;
      const d = (p.lat - lat) ** 2 + ((p.lon - lon) * Math.cos((lat * Math.PI) / 180)) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    });
    return best;
  }

  function sugText(s) {
    if (s.kind === 'zip') {
      const hit = st.zips && st.zips.get(s.zip), near = hit && nearestPlaceTo(hit[0], hit[1]);
      return { main: `ZIP ${s.zip}`, sub: hit ? (near ? `Near ${near.name}, ${near.st}` : 'ZIP code') : st.zips ? 'Not a mapped ZIP code' : 'ZIP code' };
    }
    if (s.kind === 'state') {
      const n = points.filter((p) => p.f.st === s.code).length;
      return { main: s.name, sub: `State · ${App.f0(n)} hospitals` };
    }
    const p = s.p, parts = [App.STATE_NAMES[p.st] || p.st];
    if (p.county) parts.push(p.county);
    if (p.pop) parts.push(`pop. ${App.f0(p.pop)}`);
    return { main: p.name, sub: parts.join(' · ') };
  }

  function renderSuggest() {
    const open = st.sug.length > 0 && document.activeElement === ui.search;
    ui.suggest.hidden = !open;
    ui.search.setAttribute('aria-expanded', String(open));
    if (!open) { ui.search.removeAttribute('aria-activedescendant'); return; }
    ui.suggest.innerHTML = st.sug.map((s, i) => {
      const t = sugText(s);
      return `<li role="option" id="hmSug${i}" class="hm-sug${i === st.sugActive ? ' active' : ''}" aria-selected="${i === st.sugActive}" data-i="${i}">
        <span class="hm-sug-main">${esc(t.main)}</span><span class="hm-sug-sub">${esc(t.sub)}</span></li>`;
    }).join('');
    if (st.sugActive >= 0) ui.search.setAttribute('aria-activedescendant', `hmSug${st.sugActive}`);
    else ui.search.removeAttribute('aria-activedescendant');
  }

  function highlight(i) {
    st.sugActive = i;
    ui.suggest.querySelectorAll('[data-i]').forEach((li) => {
      const on = +li.dataset.i === i;
      li.classList.toggle('active', on);
      li.setAttribute('aria-selected', String(on));
      if (on) li.scrollIntoView({ block: 'nearest' });
    });
    ui.search.setAttribute('aria-activedescendant', `hmSug${i}`);
  }

  function updateSuggest() {
    const q = ui.search.value;
    st.sug = suggest(q);
    st.sugActive = st.sug.length ? 0 : -1;
    renderSuggest();
    // The place list and ZIP file load on first use; refresh once they arrive
    if (!st.places && /\D/.test(q.trim())) loadPlaces().then(() => { if (ui.search.value === q) updateSuggest(); }, () => {});
    if (/^\d{5}$/.test(q.trim()) && (!st.zips || !st.places)) {
      Promise.all([loadZips(), loadPlaces()]).then(() => { if (ui.search.value === q) updateSuggest(); }, () => {});
    }
  }

  function closeSuggest() {
    st.sug = [];
    st.sugActive = -1;
    renderSuggest();
  }

  function clearLocation() {
    st.loc = null;
    st.care = null;
    if (st.map && st.styleReady) drawMe(false);
  }

  function choose(s) {
    closeSuggest();
    say('');
    if (s.kind === 'zip') { useZip(s.zip); return; }
    if (s.kind === 'state') {
      ui.search.value = s.name;
      clearLocation();
      st.refit = true;
      if (App.state.focus === s.code) App.renderOne('map');
      else App.setFocus(s.code);
      return;
    }
    const p = s.p, label = `${p.name}, ${p.st}`;
    ui.search.value = label;
    setLocation({ lat: p.lat, lon: p.lon, label, source: 'place', key: `${p.name}|${p.st}` });
  }

  function submitSearch() {
    const q = ui.search.value.trim();
    if (!q) { say('Type a ZIP code, city or state.', true); ui.search.focus(); return; }
    if (st.sugActive >= 0 && st.sug[st.sugActive]) { choose(st.sug[st.sugActive]); return; }
    if (/^\d+$/.test(q) && !/^\d{5}$/.test(q)) { say('Enter a 5‑digit ZIP code, or a city or state name.', true); return; }
    loadPlaces().catch(() => null).then(() => {
      const hit = suggest(q)[0];
      if (hit) choose(hit);
      else say(`Nothing matches “${q}”. Try a ZIP code, a city such as “Woodbury, MN”, or a state.`, true);
    });
  }

  // ---------- Legend & nearby list ----------
  function renderLegend(HM, color) {
    const [lo, , hi] = color.domain();
    const starLike = HM.key === 'star' || HM.key === 'ovr';
    const stops = d3.range(0, 1.0001, 0.1).map((t) => color(lo + t * (hi - lo))).join(',');
    const c = LOC.counts;
    const street = c.exact + c.interpolated;
    ui.legend.innerHTML = `
      <div class="hm-scale">
        <span class="hm-grad" data-css="background:linear-gradient(90deg,${stops})"></span>
        <span class="hm-ticks"><span>${HM.fmt(starLike ? Math.max(1, Math.round(lo)) : lo)}</span><b>${esc(HM.centerLabel)}</b><span>${HM.fmt(starLike ? Math.min(5, Math.round(hi)) : hi)}</span></span>
      </div>
      <div class="hm-keys">
        <span><i class="hm-k good"></i>Better</span><span><i class="hm-k mid"></i>Near national</span><span><i class="hm-k bad"></i>Worse</span>
        <span><i class="hm-k none"></i>No score for this measure</span>
        ${HM.hai ? '<span><i class="hm-k ring"></i>Statistically better/worse (95% CI)</span>' : ''}
        <span><i class="hm-k me"></i>Your location or search</span>
      </div>
      <p class="hm-foot">${esc(HM.title)}. All ${App.f0(c.hospitals + (c.extra || 0))} hospitals in CMS's directory are shown, including ${App.f0(c.extra || 0)} with no published scores. ${App.f0(street)} are placed by street address; the rest at their ZIP or town centre (marked “approximate”).</p>`;
    App.applyCss(ui.legend);
  }

  // Hospitals for the results list: within the radius of your location, or (full screen only) in the part of the map you can see
  function nearSet() {
    if (st.loc) return { mode: 'radius', ref: st.loc, items: points.map((p) => ({ p, d: miles(st.loc, p) })).filter((x) => x.d <= st.radius) };
    if (!st.full || !st.map) return null;
    const c = covered(), W = ui.canvas.clientWidth, H = ui.canvas.clientHeight;
    const nw = st.map.unproject([c.left, 0]), se = st.map.unproject([W, H - c.bottom]);
    const mid = st.map.unproject([(c.left + W) / 2, (H - c.bottom) / 2]), ref = { lat: mid.lat, lon: mid.lng };
    return {
      mode: 'view', ref,
      items: points.filter((p) => p.lon >= nw.lng && p.lon <= se.lng && p.lat <= nw.lat && p.lat >= se.lat).map((p) => ({ p, d: miles(ref, p) })),
    };
  }

  function summarize(HM, items) {
    const reporting = items.filter((x) => HM.get(x.p.f) != null);
    let summary = `${reporting.length} report ${HM.label}`;
    if (HM.hai) {
      const w = reporting.filter((x) => HM.detail(x.p.f).cls === 'worse').length;
      const b = reporting.filter((x) => HM.detail(x.p.f).cls === 'better').length;
      summary += `, ${b} better and ${w} worse than the national benchmark`;
    } else if (HM.key === 'psi90') {
      summary += `, ${reporting.filter((x) => x.p.f.psi90 < HM.center).length} below the national ${App.f2(HM.center)} (better)`;
    } else if (HM.key === 'ed') {
      summary += `, ${reporting.filter((x) => HM.get(x.p.f) < HM.center).length} faster than the national median of ${Math.round(HM.center)} min`;
    } else if (HM.key === 'ovr') {
      summary += `, ${reporting.filter((x) => HM.get(x.p.f) >= 4).length} rated 4–5 stars`;
    } else {
      summary += `, ${reporting.filter((x) => x.p.f.star >= 4).length} rated 4–5 stars`;
    }
    return `${summary}. ${items.filter((x) => x.p.er === 1).length} have an emergency department`;
  }

  function setNearCollapsed(collapsed) {
    st.nearCollapsed = collapsed;
    ui.near.classList.toggle('collapsed', collapsed);
    ui.nearToggle.setAttribute('aria-expanded', String(!collapsed));
    ui.nearToggle.title = collapsed ? 'Show list' : 'Hide list';
  }

  function renderNear() {
    const HM = st.HM, color = st.color;
    const set = HM && nearSet();
    if (!set) { ui.near.hidden = true; return; }
    ui.near.hidden = false;
    setNearCollapsed(st.nearCollapsed);
    const { mode, items } = set;
    const better = (a, b) => (HM.goodLow ? a - b : b - a);
    items.sort(st.sort === 'best'
      ? (a, b) => (HM.get(a.p.f) == null) - (HM.get(b.p.f) == null) || better(HM.get(a.p.f) ?? 0, HM.get(b.p.f) ?? 0) || a.d - b.d
      : (a, b) => a.d - b.d);
    const n = items.length, plural = n === 1 ? '' : 's';
    if (mode === 'radius') {
      const where = st.loc.source === 'gps' ? 'you' : st.loc.label;
      ui.nearTitle.textContent = `${n} hospital${plural} within ${st.radius} miles of ${where}`;
      ui.nearSub.textContent = n ? `${summarize(HM, items)}. Includes hospitals across state lines.` : 'Try a wider radius.';
    } else {
      ui.nearTitle.textContent = `${App.f0(n)} hospital${plural} in this view`;
      ui.nearSub.textContent = n ? `${summarize(HM, items)}. Pan or zoom the map to update, or search near you above.` : 'Zoom out or pan the map to find hospitals.';
    }
    App.chips(ui.sort, [{ value: 'near', label: mode === 'radius' ? 'Nearest' : 'Nearest centre' }, { value: 'best', label: `Best ${HM.label}` }], st.sort, (v) => { st.sort = v; renderNear(); });

    if (!n) {
      const next = mode === 'radius' && [...ui.radius.options].map((o) => +o.value).find((r) => r > st.radius);
      ui.list.innerHTML = next ? `<li class="hm-empty"><button type="button" class="btn" data-radius="${next}">Search within ${next} miles</button></li>` : '<li class="hm-empty">No hospitals found here.</li>';
      const b = ui.list.querySelector('[data-radius]');
      if (b) b.addEventListener('click', () => { ui.radius.value = b.dataset.radius; ui.radius.dispatchEvent(new Event('change')); });
      return;
    }
    const shown = items.slice(0, VIEW_LIST_MAX);
    ui.list.innerHTML = shown.map((x, i) => {
      const f = x.p.f, v = HM.get(f), d = HM.detail(f);
      const pill = v == null ? '<span class="pill none">—</span>' : `<span class="pill ${d ? d.cls : 'similar'}" data-css="box-shadow:inset 3px 0 0 ${color(v)}">${HM.fmt(v)}</span>`;
      const dist = mode === 'radius' ? ` · ${fmtMi(x.d)}` : '';
      const kind = (x.p.type && x.p.type !== 'a' && TYPES[x.p.type] ? ` · ${TYPES[x.p.type].replace(/ (hospital|medical center)$/i, '')}` : '') + (x.p.er === 0 ? ' · no ER' : '');
      const status = f.unscored && v == null ? ' · no published scores' : d && d.cls !== 'similar' ? ` · ${App.CLS_LABEL[d.cls].toLowerCase()}` : '';
      return `<li><button type="button" class="hm-row" data-i="${i}">
        ${v == null ? '<i class="hm-sw none"></i>' : `<i class="hm-sw" data-css="background:${color(v)}"></i>`}
        <span class="hm-row-main"><span class="hm-row-name">${esc(f.name)}</span>
          <span class="hm-row-sub">${esc(f.city)}, ${esc(f.st)}${dist}${kind}${APPROX[x.p.precision] ? ' · approx. location' : ''}${status}</span></span>
        ${pill}</button></li>`;
    }).join('') + (n > shown.length ? `<li class="hm-empty">Showing ${VIEW_LIST_MAX} of ${App.f0(n)}. Zoom in to narrow the list.</li>` : '');
    App.applyCss(ui.list);
    ui.list.querySelectorAll('.hm-row').forEach((btn) => btn.addEventListener('click', () => {
      const p = shown[+btn.dataset.i].p;
      // Park the hospital below centre so its card opens above it with room to spare, then open the card once the move ends
      let opened = false;
      const open = () => { if (!opened) { opened = true; openPopup(p); } };
      const duration = App.reduceMotion ? 0 : 700;
      st.map.once('moveend', open);
      setTimeout(open, duration + 150);
      st.map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(st.map.getZoom(), 13), offset: [Math.round(covered().left / 2), Math.round(ui.canvas.clientHeight * 0.22)], duration, easing: EASE });
      if (!st.full) ui.canvas.scrollIntoView({ block: 'nearest', behavior: App.reduceMotion ? 'auto' : 'smooth' });
    }));
  }

  // ---------- Layout: rankings panel, full screen workspace ----------
  function applyCardLayout() {
    const wide = !st.ranksOpen;
    ui.card.classList.toggle('span-12', wide);
    ui.card.classList.toggle('span-8', !wide);
    ui.ranksCard.hidden = wide;
    ui.ranksToggle.setAttribute('aria-pressed', String(!wide));
    ui.ranksToggle.querySelector('span').textContent = wide ? 'Show rankings' : 'Hide rankings';
  }

  function restoreCardLayout() {
    ui.card.classList.remove('span-12');
    ui.card.classList.add('span-8');
    ui.ranksCard.hidden = false;
  }

  function fillMetricSelect() {
    const ms = App.mapMetrics ? App.mapMetrics() : [];
    ui.metric.innerHTML = ms.map((m) => `<option value="${esc(m.key)}">${esc(m.label)}</option>`).join('');
    ui.metric.value = App.state.mapMetric;
  }

  // The state grid, the street map and the rankings card swap with the browser's View Transitions: the card grows or
  // shrinks into its new layout and the sections below slide with it, instead of everything cutting at once
  function transition(update, dir) {
    const r = ui.card.getBoundingClientRect();
    if (App.reduceMotion || !document.startViewTransition || st.full || st.morphing || r.bottom < 0 || r.top > innerHeight) { update(); return; }
    const root = document.documentElement;
    const after = [...document.querySelectorAll('main > section, footer')].filter((el) =>
      (ui.card.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) && !el.contains(ui.card) && el.getBoundingClientRect().top < innerHeight);
    after.forEach((el, i) => { el.style.viewTransitionName = `hm-after-${i}`; });
    root.dataset.hmVt = dir;
    const done = () => { delete root.dataset.hmVt; after.forEach((el) => { el.style.viewTransitionName = ''; }); };
    let vt;
    try { vt = document.startViewTransition(update); } catch (e) { done(); update(); return; }
    vt.ready.catch(() => {});
    vt.finished.finally(done);
  }

  // The panel floats over the map and slides in and out, so the map never resizes under you
  function setSideCollapsed(collapsed, focus = true) {
    st.sideCollapsed = collapsed;
    ui.wrap.classList.toggle('side-collapsed', collapsed);
    const label = collapsed ? 'Show side panel' : 'Hide side panel';
    [ui.sideToggle, ui.sideClose].forEach((b) => { b.setAttribute('aria-expanded', String(!collapsed)); });
    ui.sideToggle.setAttribute('aria-label', label);
    ui.sideToggle.title = label;
    ui.side.inert = collapsed;
    // The list follows the part of the map you can see, which changes once the slide ends
    clearTimeout(st.viewTimer);
    st.viewTimer = setTimeout(renderNear, DUR);
    if (focus) (collapsed ? ui.sideShow : ui.sideClose).focus();
  }

  // Grow the map from its place in the page to the whole window (or back), like opening a card on iOS. The map is laid
  // out at its final size straight away and a clip window grows from the old rectangle, so streets never stretch.
  function morph(rect, opening) {
    const W = ui.wrap.clientWidth, H = ui.wrap.clientHeight;
    const dx = rect.left + rect.width / 2 - W / 2, dy = rect.top + rect.height / 2 - H / 2;
    const ix = Math.max(0, (W - rect.width) / 2), iy = Math.max(0, (H - rect.height) / 2);
    const small = { transform: `translate(${dx}px, ${dy}px)`, clipPath: `inset(${iy}px ${ix}px ${iy}px ${ix}px round 4px)` };
    const big = { transform: 'translate(0px, 0px)', clipPath: 'inset(0px 0px 0px 0px round 0px)' };
    return ui.wrap.animate(opening ? [small, big] : [big, small], { duration: DUR, easing: EASE_CSS, fill: opening ? 'none' : 'forwards' }).finished;
  }

  // Full screen fills the browser window (an in-page overlay); it never switches the browser itself to full screen.
  // Spacers hold the map's place in the page meanwhile, so nothing behind the overlay moves and the map can shrink back to it.
  function enterFull() {
    if (st.full || ui.wrap.hidden || st.morphing) return;
    const from = ui.canvas.getBoundingClientRect(), box = ui.wrap.getBoundingClientRect();
    st.inlineCanvas = { dx: from.left - box.left, dy: from.top - box.top, dw: box.width - from.width, h: from.height };
    ui.barSpacer.style.height = `${Math.max(0, box.top - ui.bar.getBoundingClientRect().top)}px`;
    ui.mapSpacer.style.height = `${box.height}px`;
    ui.bar.before(ui.barSpacer);
    ui.wrap.before(ui.mapSpacer);
    st.full = true;
    if (st.popup) st.popup.remove();
    // The search bar, status and results move into the side panel, like a maps app
    ui.sideBody.append(ui.bar, ui.status, ui.near);
    const drift = ui.mapSpacer.getBoundingClientRect().top - box.top;
    if (Math.abs(drift) >= 0.5) ui.barSpacer.style.height = `${parseFloat(ui.barSpacer.style.height) - drift}px`;
    ui.wrap.classList.add('is-full', 'side-collapsed');
    ui.wrap.setAttribute('role', 'dialog');
    ui.wrap.setAttribute('aria-modal', 'true');
    ui.wrap.setAttribute('aria-label', 'Hospital map, full screen');
    document.documentElement.classList.add('hm-full-open');
    ui.fullMapBtn.setAttribute('aria-label', 'Exit full screen');
    ui.fullMapBtn.title = 'Exit full screen (Esc)';
    fillMetricSelect();
    if (st.map) st.map.resize();
    const animate = !App.reduceMotion;
    if (animate) {
      st.morphing = morph(from, true).catch(() => {}).then(() => { st.morphing = null; });
    }
    void ui.side.offsetWidth;
    // The panel slides in as the map opens, and the view shifts so what you were looking at stays in the open part of the map
    requestAnimationFrame(() => {
      setSideCollapsed(false, false);
      const c = covered();
      if (st.map && (c.left || c.bottom)) st.map.panBy([-c.left / 2, c.bottom / 2], { duration: animate ? DUR : 0, easing: EASE });
      ui.exitFull.focus();
    });
  }

  function exitFull(opts = {}) {
    if (!st.full) return Promise.resolve();
    if (st.morphing) return st.morphing;
    if (st.popup) st.popup.remove();
    const finish = () => {
      st.full = false;
      st.sideCollapsed = false;
      ui.figMap.before(ui.bar, ui.status);
      ui.stage.after(ui.near);
      ui.wrap.classList.remove('is-full', 'side-collapsed');
      ['role', 'aria-modal', 'aria-label'].forEach((a) => ui.wrap.removeAttribute(a));
      ui.side.inert = false;
      document.documentElement.classList.remove('hm-full-open');
      ui.fullMapBtn.setAttribute('aria-label', 'Full screen map');
      ui.fullMapBtn.title = 'Full screen';
      ui.barSpacer.remove();
      ui.mapSpacer.remove();
      ui.wrap.getAnimations().forEach((a) => a.cancel());
      if (st.map) st.map.resize();
      renderNear();
      st.morphing = null;
      requestAnimationFrame(() => { if (!ui.wrap.hidden) ui.fullBtn.focus(); });
    };
    if (opts.animate === false || App.reduceMotion || !ui.mapSpacer.isConnected) { finish(); return Promise.resolve(); }
    // Shrink back into the page: the panel slides away and the view re-centres on the map's place in the card
    const s = ui.mapSpacer.getBoundingClientRect(), c = st.inlineCanvas;
    const to = { left: s.left + c.dx, top: s.top + c.dy, width: s.width - c.dw, height: c.h };
    const cov = covered();
    if (st.map && (cov.left || cov.bottom)) st.map.panBy([cov.left / 2, -cov.bottom / 2], { duration: DUR, easing: EASE });
    ui.wrap.classList.add('side-collapsed');
    st.morphing = morph(to, false).then(finish, finish);
    return st.morphing;
  }

  function setMapStyle(key) {
    if (!MAP_STYLES[key] || key === st.mapStyle) return;
    st.mapStyle = key;
    ui.styleSel.value = key;
    try { localStorage.setItem(STYLE_KEY, key); } catch (e) { /* storage unavailable */ }
    if (App.state.focus) App.renderOne('map');
    // One basemap choice for every map: the maternity tab follows a change made here, and vice versa
    styleListeners.forEach((fn) => { try { fn(key); } catch (e) { console.error(e); } });
  }
  const styleListeners = [];

  // ---------- Public API used by the state map ----------
  function show(code, M) {
    const HM = hospMetric(M);
    const inState = points.filter((p) => p.f.st === code);
    const reporting = inState.filter((p) => HM.get(p.f) != null).length;
    const unscored = inState.filter((p) => p.f.unscored).length;
    const title = `${App.STATE_NAMES[code] || code}: ${App.f0(inState.length)} hospitals · ${HM.label}`;
    document.getElementById('mapEyebrow').textContent = 'Fig 5';
    document.getElementById('mapTitle').textContent = title;
    document.getElementById('mapSub').textContent = `${App.f0(reporting)} report ${HM.label}; ${App.f0(unscored)} have no published CMS scores. Blue is ${HM.goodLow ? 'lower' : 'higher'} (better) and orange worse than ${HM.centerLabel.replace(/^National/, 'the national')}; hollow dots have no score for this measure. Neighbouring states stay visible. Click a dot for details.`;
    ui.sideTitle.textContent = title;
    ui.wrap.hidden = false;
    ui.back.hidden = false;
    ui.radiusWrap.hidden = false;
    ui.tools.hidden = false;
    // Give the map the full width; the rankings can be reopened from the card header
    applyCardLayout();
    if (st.full) fillMetricSelect();
    // Place names and state outlines load alongside the map; the map never waits for them
    loadPlaces().catch(() => {});
    loadShapes().catch(() => {});
    if (!window.maplibregl) {
      st.pending = [code, M];
      say('Loading map…');
      loadLib().then(() => { say(''); flushPending(); }, () => say('The map library could not be loaded.', true));
      return;
    }
    const id = styleId();
    if (!styles[id]) {
      st.pending = [code, M];
      loadStyle(id).then(flushPending, () => say('The street map style could not be loaded (are you offline?).', true));
      return;
    }
    if (!ensureMap()) return;
    if (st.styleId !== id) {
      st.styleId = id;
      st.styleReady = false;
      st.tileErrors = 0;
      st.map.setStyle(styleFor(id), { diff: false });
    }
    // Sources and layers are (re)added when the basemap style finishes loading, then this runs again
    if (!st.styleReady) { st.pending = [code, M]; return; }
    st.map.resize();
    st.HM = HM;
    st.color = scaleFor(HM);
    drawDots(HM, st.color);
    drawMe(false);
    setFocusOutline();
    // Arriving from the state grid the camera eases in; moving between places on the map it flies
    const how = st.shownFocus ? 'fly' : 'enter';
    if (st.pendingCenter && st.loc) fitToMe(how);
    else if (code !== st.shownFocus || st.refit) fitToState(code, how);
    st.pendingCenter = false;
    st.refit = false;
    st.shownFocus = code;
    renderLegend(HM, st.color);
    renderNear();
  }

  function hide() {
    exitFull({ animate: false });
    st.pending = null;
    ui.wrap.hidden = true;
    ui.back.hidden = true;
    ui.radiusWrap.hidden = true;
    ui.tools.hidden = true;
    restoreCardLayout();
    st.shownFocus = '';
    if (st.popup) st.popup.remove();
    if (st.tip) st.tip.remove();
  }

  function init() {
    ['hmBar', 'hmBack', 'hmLocate', 'hmSearchForm', 'hmSearch', 'hmSuggest', 'hmSide', 'hmRadius', 'hmRadiusWrap', 'hmStatus', 'hospMap', 'hmCanvas', 'hmLegend', 'hmNear', 'hmNearTitle', 'hmNearSub', 'hmSort', 'hmList',
      'hmTools', 'hmRanksToggle', 'hmFullBtn', 'hmSideTitle', 'hmExitFull', 'hmMetric', 'hmSideBody', 'hmStage', 'hmFullMapBtn', 'hmSideToggle', 'hmNearToggle', 'mapCard', 'ranksCard', 'fig-map',
      'hmSideClose', 'hmSideShow', 'hmStyle']
      .forEach((id) => (ui[id] = document.getElementById(id)));
    Object.assign(ui, { bar: ui.hmBar, back: ui.hmBack, locate: ui.hmLocate, searchForm: ui.hmSearchForm, search: ui.hmSearch, suggest: ui.hmSuggest, side: ui.hmSide, radius: ui.hmRadius, radiusWrap: ui.hmRadiusWrap, status: ui.hmStatus,
      wrap: ui.hospMap, canvas: ui.hmCanvas, legend: ui.hmLegend, near: ui.hmNear, nearTitle: ui.hmNearTitle, nearSub: ui.hmNearSub, sort: ui.hmSort, list: ui.hmList,
      tools: ui.hmTools, ranksToggle: ui.hmRanksToggle, fullBtn: ui.hmFullBtn, sideTitle: ui.hmSideTitle, exitFull: ui.hmExitFull, metric: ui.hmMetric, sideBody: ui.hmSideBody,
      stage: ui.hmStage, fullMapBtn: ui.hmFullMapBtn, sideToggle: ui.hmSideToggle, nearToggle: ui.hmNearToggle, card: ui.mapCard, ranksCard: ui.ranksCard, figMap: ui['fig-map'],
      sideClose: ui.hmSideClose, sideShow: ui.hmSideShow, styleSel: ui.hmStyle });
    ui.barSpacer = Object.assign(document.createElement('div'), { className: 'hm-spacer' });
    ui.mapSpacer = Object.assign(document.createElement('div'), { className: 'hm-spacer' });
    ui.bar.hidden = false;
    ui.styleSel.innerHTML = Object.entries(MAP_STYLES).map(([k, s]) => `<option value="${k}">${s.label}</option>`).join('');
    ui.styleSel.value = st.mapStyle;
    ui.styleSel.addEventListener('change', () => setMapStyle(ui.styleSel.value));
    // From full screen, shrink back into the page first, then return to the state grid
    ui.back.addEventListener('click', () => { say(''); exitFull().then(() => App.setFocus('')); });
    ui.locate.addEventListener('click', locate);
    wireSearch();
    ui.radius.addEventListener('change', () => { st.radius = +ui.radius.value; drawMe(true); renderNear(); });
    ui.ranksToggle.addEventListener('click', () => transition(() => {
      st.ranksOpen = !st.ranksOpen;
      applyCardLayout();
      if (st.map) st.map.resize();
      renderNear();
    }, 'ranks'));
    ui.fullBtn.addEventListener('click', enterFull);
    ui.fullMapBtn.addEventListener('click', () => (st.full ? exitFull() : enterFull()));
    ui.exitFull.addEventListener('click', () => exitFull());
    ui.sideToggle.addEventListener('click', () => setSideCollapsed(!st.sideCollapsed));
    ui.sideClose.addEventListener('click', () => setSideCollapsed(true));
    ui.sideShow.addEventListener('click', () => setSideCollapsed(false));
    ui.nearToggle.addEventListener('click', () => setNearCollapsed(!st.nearCollapsed));
    ui.metric.addEventListener('change', () => App.setMapMetric(ui.metric.value));
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !st.full || st.morphing) return;
      // First Esc closes an open hospital card; the next leaves full screen
      if (st.popupOpen && st.popup) { st.popup.remove(); return; }
      exitFull();
    });
    const c = LOC.counts;
    const note = document.getElementById('locationNote');
    if (note) {
      note.textContent = `Hospital map: all ${App.f0(c.hospitals + (c.extra || 0))} hospitals in CMS Hospital General Information (${App.f0(c.extra || 0)} without published scores are drawn as hollow outlines), geocoded with the U.S. Census Bureau geocoder (${App.f0(c.exact + c.interpolated)} by street address, ${App.f0(c.zip + c.place)} at ZIP or town centre). ` +
        'Basemaps © VersaTiles, OpenFreeMap, OpenMapTiles and OpenStreetMap contributors. City and town names and populations: GeoNames (CC BY 4.0). State outlines: U.S. Census Bureau cartographic boundaries (via us-atlas). Your location stays in this browser and is never saved; as with any web map, the tile provider only sees which map area is displayed.';
    }
  }

  function wireSearch() {
    ui.searchForm.addEventListener('submit', (e) => { e.preventDefault(); submitSearch(); });
    ui.search.addEventListener('input', updateSuggest);
    ui.search.addEventListener('focus', () => { clearTimeout(st.blurTimer); loadPlaces().catch(() => {}); if (ui.search.value.trim()) updateSuggest(); });
    ui.search.addEventListener('blur', () => { st.blurTimer = setTimeout(closeSuggest, 120); });
    ui.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && st.sug.length) { e.preventDefault(); e.stopPropagation(); closeSuggest(); return; }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && st.sug.length) {
        e.preventDefault();
        highlight((st.sugActive + (e.key === 'ArrowDown' ? 1 : -1) + st.sug.length) % st.sug.length);
      }
    });
    // mousedown keeps focus in the box, so the list doesn't close before the click lands
    ui.suggest.addEventListener('mousedown', (e) => e.preventDefault());
    ui.suggest.addEventListener('click', (e) => {
      const li = e.target.closest('[data-i]');
      if (li && st.sug[+li.dataset.i]) choose(st.sug[+li.dataset.i]);
    });
    ui.suggest.addEventListener('mousemove', (e) => {
      const li = e.target.closest('[data-i]');
      if (li && +li.dataset.i !== st.sugActive) highlight(+li.dataset.i);
    });
  }

  init();
  App.hospitalMap = { show, hide, showCare, describe };
  App.transitionFocus = transition;
  // Map plumbing shared with the maternity tab: one copy of the library, basemap styles, gazetteer and ZIP lookup
  App.mapKit = {
    loadScript, loadLib, loadStyle, styleFor, styleId, loadPlaces, loadZips, loadShapes, suggest, nearestPlaceTo, miles,
    styles: MAP_STYLES, ease: EASE, easeCss: EASE_CSS, duration: DUR, hideLines: HIDE_LINES,
    getStyle: () => st.mapStyle, setStyle: setMapStyle, onStyle: (fn) => styleListeners.push(fn), shapes: () => (st.shapes ? st.shapes.borders : null), decorBorders, decorLabels,
    undecorate: (map) => decorated.delete(map),
  };
})();
