/* care_map: the nearest care from a place or a point on a map (copilot/tools.py nearest_care), drawn in an answer the
   way the dashboard's maternity and hospital maps draw a search: the same basemap and place labels, the start point,
   pins numbered by drive time, the road route to each hospital and the places the answer kept out of, then the list
   with directions and phone numbers.

   Show on the map puts the same search on the dashboard's own map (App.maternity / App.hospitalMap .showCare); in
   Quick chat that happens on its own when the question came from that map (panel.js). The map is made only while the
   figure is near the screen, so a long conversation never holds more WebGL maps than the browser allows. */
(function () {
  'use strict';
  const App = window.App, F = window.Figures;
  if (!F || !App.mapKit) return;
  const kit = () => App.mapKit;
  const esc = App.esc;
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const fmtMi = (d) => (d < 10 ? d.toFixed(1) : Math.round(d)) + ' mi';
  const fmtMin = (m) => (m == null ? '—' : m < 60 ? `${Math.max(1, Math.round(m))} min` : `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')} min`);
  const nicuMark = (x) => (x.nicu ? (x.nicu_level ? `N\u2009${x.nicu_level}` : 'N') : '');
  const nicuLabel = (x) => (!x.nicu ? '' : x.nicu_level === 'II' ? 'Level II special care nursery' : x.nicu_level ? `Level ${x.nicu_level} NICU` : 'NICU');
  const names = (a) => (a.length < 3 ? a.join(' and ') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

  function circle(z, steps = 72) {
    const d = z.miles / 3958.8, la = (z.lat * Math.PI) / 180, lo = (z.lon * Math.PI) / 180, ring = [];
    for (let i = 0; i <= steps; i++) {
      const b = (2 * Math.PI * i) / steps;
      const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
      const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
      ring.push([(lo2 * 180) / Math.PI, (la2 * 180) / Math.PI]);
    }
    return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
  }

  // A place kept out of: a whole state's outline, or a circle around a town
  function zoneFeature(z) {
    if (z.outline) return { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: z.outline.map((r) => [r.map(([la, lo]) => [lo, la])]) } };
    return circle(z);
  }

  // ---- the dashboard's map -----------------------------------------------------------------------------------------
  const TARGET = {
    maternity: { api: () => App.maternity, section: 'maternity', card: 'matCard', label: 'maternity map' },
    hospitals: { api: () => App.hospitalMap, section: 'geography', card: 'hospMap', label: 'hospital map' },
  };
  function payload(d) {
    const o = d.options || {};
    return { origin: o.origin, kind: o.kind, zones: o.zones || [], left_out: o.left_out || [], results: d.rows || [], title: d.title };
  }
  // Puts an answer's search on the dashboard's map. scroll: bring the map into view if it isn't
  function apply(d, { scroll = true } = {}) {
    const t = TARGET[(d.options || {}).sync];
    if (!t || !t.api() || !t.api().showCare) return Promise.resolve(false);
    const run = () => t.api().showCare(payload(d)).then((ok) => {
      const card = document.getElementById(t.card);
      if (ok && scroll && card) {
        const r = card.getBoundingClientRect();
        if (r.top > innerHeight * 0.5 || r.bottom < innerHeight * 0.3) card.scrollIntoView({ block: 'start', behavior: App.reduceMotion ? 'auto' : 'smooth' });
      }
      return ok;
    });
    const view = document.getElementById('view-quality');
    if (view && view.hidden) {
      location.hash = `#${t.section}`;
      return new Promise((r) => setTimeout(r, 120)).then(run);
    }
    return run();
  }
  App.careMap = { apply, payload, target: (d) => TARGET[(d.options || {}).sync] || null };

  // ---- the figure --------------------------------------------------------------------------------------------------
  F.register('care_map', (ctx) => {
    const { o, W, rows, C } = ctx;
    const origin = o.origin || {};
    const maternity = o.sync === 'maternity';
    const nicuCol = cssVar('--nicu') || C.text;
    const top = rows.filter((x) => x.role === 'top');
    const zones = o.zones || [];
    const H = Math.round(Math.max(280, Math.min(460, W * 0.7)));

    const box = document.createElement('div');
    box.className = 'cm-map';
    box.style.height = `${H}px`;
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', `Map: routes from ${origin.label || 'the start'} to ${names(top.map((x) => x.name))}`);
    ctx.el.append(box);

    const rank = (x) => (x.role === 'top' ? top.indexOf(x) + 1 : null);
    const row = (x) => {
      const marks = x.role === 'top'
        ? `<span class="mat-rank">${rank(x)}</span>${x.nicu ? `<span class="mat-rank n">${nicuMark(x)}</span>` : ''}`
        : `<span class="mat-rank n">${nicuMark(x) || 'N'}</span>`;
      const tags = [];
      if (x.role === 'nicu') tags.push(['nicu', 'Nearest NICU']);
      if (x.role === 'high') tags.push(['nicu', 'Nearest Level III or IV NICU']);
      if (x.nicu && x.role === 'top') tags.push(['nicu', nicuLabel(x)]);
      if (x.detour) tags.push(['muted', `Route goes around ${names(zones.map((z) => z.name.split(',')[0]))}`]);
      if (x.through && x.through.length) tags.push(['muted', `Route passes through ${names(x.through.map((z) => z.split(',')[0]))}`]);
      if (x.unchecked) tags.push(['muted', 'Route not checked against the places kept out of']);
      if (x.er === false || x.er === 0) tags.push(['muted', 'No emergency department']);
      const dir = `https://www.google.com/maps/dir/?api=1&origin=${(+origin.lat).toFixed(5)},${(+origin.lon).toFixed(5)}` +
        `&destination=${encodeURIComponent(`${x.name}, ${x.city}, ${x.state}`)}&travelmode=driving`;
      return `<li class="mat-hosp cm-row" data-ccn="${esc(x.ccn)}" data-kind="${x.role === 'top' ? 'ld' : x.role}">
        <span class="mat-marks">${marks}</span>
        <div class="mat-hosp-main">
          <div class="mat-hosp-name">${esc(x.name)}</div>
          <div class="mat-hosp-sub">${esc(x.city)}, ${esc(x.state)}</div>
          ${tags.length ? `<div class="mat-badges">${tags.map(([k, t]) => `<span class="mat-badge ${k}">${esc(t)}</span>`).join('')}</div>` : ''}
          <div class="mat-actions"><a href="${esc(dir)}" target="_blank" rel="noopener noreferrer">Directions in Google Maps</a>${x.phone ? `<a href="tel:${esc(String(x.phone).replace(/[^\d+]/g, ''))}">Call ${esc(x.phone)}</a>` : ''}</div>
        </div>
        <div class="mat-hosp-time"><span class="mat-time${x.routed ? '' : ' est'}">${fmtMin(x.minutes)}</span><span class="mat-dist">${fmtMi(x.miles)}${x.routed ? ' by road' : ' · est.'}</span></div>
      </li>`;
    };
    const list = document.createElement('ol');
    list.className = 'mat-list cm-list';
    list.innerHTML = rows.map(row).join('');
    ctx.el.append(list);

    const t = TARGET[o.sync];
    if (t) {
      const foot = document.createElement('div');
      foot.className = 'cm-foot';
      foot.innerHTML = `<span class="cm-from">From ${esc(origin.label || 'the start')}</span><button type="button" class="btn cm-go">Show on the ${t.label}</button>`;
      foot.querySelector('.cm-go').addEventListener('click', (e) => {
        e.stopPropagation();
        apply(ctx.d);
        document.dispatchEvent(new CustomEvent('dash-show', { detail: { section: t.section } }));
      });
      ctx.el.append(foot);
    }
    const out = (o.left_out || []).map((x) => x.name);
    if (out.length) ctx.note(`Left out: ${names(out)}.`);
    ctx.note('Drive times by road without traffic (OpenStreetMap routing). The router can’t see closures; a route that goes around a place is an estimate. In an emergency, call 911.');
    ctx.legend(F.chips([
      { label: maternity ? 'Delivers babies' : 'Hospital', color: C.text },
      ...(maternity ? [{ label: 'NICU', color: nicuCol }] : []),
      ...(zones.length ? [{ label: 'Kept out of', color: C.text, shape: 'dash' }] : []),
    ]));

    // The map: made when the figure comes near the screen, removed when it is far away
    let map = null, markers = [];
    const pins = new Map();
    const stop = () => {
      markers.forEach((m) => m.remove());
      markers = [];
      pins.clear();
      if (map) { kit().undecorate(map); map.remove(); map = null; }
    };
    const start = () => {
      if (map) return;
      const id = kit().styleId();
      Promise.all([kit().loadLib(), kit().loadStyle(id)]).then(() => {
        if (map || !box.isConnected || !near) return;
        kit().loadPlaces().catch(() => {});
        kit().loadShapes().catch(() => {});
        const pts = [origin, ...rows];
        rows.forEach((x) => (x.line || []).forEach(([la, lo]) => pts.push({ lat: la, lon: lo })));
        // A town kept out of is framed with the routes; a whole state would zoom the map out too far
        zones.filter((z) => !z.outline).forEach((z) => circle(z).geometry.coordinates[0].forEach(([lo, la]) => pts.push({ lat: la, lon: lo })));
        let w = 180, s = 90, e = -180, n = -90;
        pts.forEach((p) => { w = Math.min(w, +p.lon); e = Math.max(e, +p.lon); s = Math.min(s, +p.lat); n = Math.max(n, +p.lat); });
        try {
          map = new maplibregl.Map({
            container: box, style: kit().styleFor(id), bounds: [[w, s], [e, n]],
            fitBoundsOptions: { padding: { top: 44, bottom: 40, left: 56, right: 56 }, maxZoom: 12.5 },
            minZoom: 2, maxZoom: 16, renderWorldCopies: false, dragRotate: false, pitchWithRotate: false, touchPitch: false,
            attributionControl: { compact: true, customAttribution: 'Routing © OSRM · OpenStreetMap' }, fadeDuration: 150,
          });
        } catch (err) {
          map = null;
          box.innerHTML = '<p class="cm-nomap">This browser can’t display the map (WebGL is unavailable). The hospitals are listed below.</p>';
          return;
        }
        // The wheel scrolls the conversation; zoom with the buttons, a pinch or a double-click
        map.scrollZoom.disable();
        map.touchZoomRotate.disableRotation();
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
        map.on('styleimagemissing', (ev) => { if (!map.hasImage(ev.id)) map.addImage(ev.id, { width: 1, height: 1, data: new Uint8Array(4) }); });
        map.on('style.load', () => {
          const dark = App.isDark(), firstSymbol = (map.getStyle().layers.find((l) => l.type === 'symbol') || {}).id;
          map.addSource('cm-veil', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] } } });
          map.addLayer({ id: 'cm-veil', type: 'fill', source: 'cm-veil', paint: { 'fill-color': C.bg, 'fill-opacity': dark ? 0.08 : 0.12 } }, firstSymbol);
          kit().decorBorders(map, 'cm-', firstSymbol, C.text);
          map.addSource('cm-zones', { type: 'geojson', data: { type: 'FeatureCollection', features: zones.map(zoneFeature) } });
          map.addLayer({ id: 'cm-zone-fill', type: 'fill', source: 'cm-zones', paint: { 'fill-color': C.text, 'fill-opacity': 0.07 } });
          map.addLayer({ id: 'cm-zone-line', type: 'line', source: 'cm-zones', paint: { 'line-color': C.text, 'line-opacity': 0.6, 'line-width': 1.5, 'line-dasharray': [2, 2] } });
          // As on the maternity map: black routes to hospitals that deliver babies (edged in blue where they have a NICU),
          // blue routes to the nearest NICUs; a faint straight line where the router gave no route
          const feats = rows.slice().reverse().map((x) => {
            const both = x.role === 'top' && x.nicu && maternity;
            const line = x.line && x.line.length > 1 ? x.line.map(([la, lo]) => [lo, la]) : [[+origin.lon, +origin.lat], [x.lon, x.lat]];
            return { type: 'Feature', geometry: { type: 'LineString', coordinates: line },
              properties: { col: x.role === 'top' ? C.text : nicuCol, cas: both ? nicuCol : C.surface, both: both ? 1 : 0, op: x.line ? 0.9 : 0.35, c: x.ccn } };
          });
          map.addSource('cm-routes', { type: 'geojson', data: { type: 'FeatureCollection', features: feats } });
          map.addLayer({ id: 'cm-route-casing', type: 'line', source: 'cm-routes', layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': ['get', 'cas'], 'line-width': ['case', ['==', ['get', 'both'], 1], 9, 7], 'line-opacity': ['get', 'op'] } });
          map.addLayer({ id: 'cm-route', type: 'line', source: 'cm-routes', layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': ['get', 'col'], 'line-width': 3.5, 'line-opacity': ['get', 'op'] } });
          kit().decorLabels(map, 'cm-', 'cm-route-casing', 1.3);
        });
        // The start, the numbered pins and the names of the places kept out of
        const me = document.createElement('div');
        me.className = 'hm-me';
        me.innerHTML = '<span></span>';
        me.title = origin.label || 'Start';
        markers.push(new maplibregl.Marker({ element: me, anchor: 'center' }).setLngLat([+origin.lon, +origin.lat]).addTo(map));
        zones.filter((z) => !z.outline).forEach((z) => {
          const el = document.createElement('div');
          el.className = 'cm-zone-tag';
          el.textContent = `Kept out: ${z.name.split(',')[0]}`;
          markers.push(new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([z.lon, z.lat]).addTo(map));
        });
        rows.forEach((x) => {
          const el = document.createElement('div');
          const kind = x.role === 'top' ? (x.nicu && maternity ? 'ld both' : 'ld') : x.role;
          el.className = `mat-pin ${kind}`;
          const label = x.role === 'top' ? String(rank(x)) : nicuMark(x) || 'N';
          el.innerHTML = `<span>${label}</span>${kind === 'ld both' ? `<span class="mat-pin-n">${nicuMark(x)}</span>` : ''}<em>${fmtMin(x.minutes)}${x.routed ? '' : ' est.'}</em>`;
          el.title = `${x.name} · ${fmtMin(x.minutes)}`;
          pins.set(x.ccn, el);
          markers.push(new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([x.lon, x.lat]).addTo(map));
        });
      }, () => { box.innerHTML = '<p class="cm-nomap">The map could not be loaded. The hospitals are listed below.</p>'; });
    };
    let near = false;
    const io = new IntersectionObserver(([en]) => { near = en.isIntersecting; if (near) start(); else stop(); }, { rootMargin: '600px 0px' });
    io.observe(box);
    // Hovering a hospital in the list marks its pin
    list.addEventListener('mouseover', (e) => { const li = e.target.closest('.cm-row'); pins.forEach((el, c) => el.classList.toggle('on', !!li && li.dataset.ccn === c)); });
    list.addEventListener('mouseleave', () => pins.forEach((el) => el.classList.remove('on')));
    ctx.cleanup(() => { io.disconnect(); stop(); });
  });
})();
