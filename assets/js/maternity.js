/* Maternity care tab: how far is the nearest hospital that delivers babies, and the nearest NICU?
   Data (assets/maternity.js and the drive-time images assets/maternity-access-*.png) is built by build_maternity.py and loaded the first time the tab opens.
   A search turns an address (U.S. Census geocoder), ZIP code or town into a point; the nearest hospitals are ranked by real
   driving time from the public OSRM router, with a calibrated straight-line estimate as the fallback. */
(function () {
  'use strict';
  const App = window.App;
  const DATA_SRC = 'assets/maternity.js';
  const OSRM = 'https://router.project-osrm.org';
  const CENSUS = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
  const US_BOUNDS = [[-125, 24.2], [-66.6, 49.6]];
  // Drive time is shown only where care is far, so the basemap stays clear and the routes stay the focus: a faint warm
  // tint where the drive is more than 30 minutes and a fine hatch where it is more than an hour. Close to care: no colour.
  const FAR = [30, 60];
  // The theme's one orange (--accent), so the far-from-care shading matches every other orange in the app
  const FAR_INK = { light: '#B0450A', dark: '#F26419' };
  const farInk = () => FAR_INK[App.isDark() ? 'dark' : 'light'];
  // Strengths of the 30-minute tint, the extra tint under the hatch, and the hatch lines (light / dark theme)
  // (dark is lighter: the saturated orange reads heavier on a dark map)
  const FAR_TINT = { light: [0.055, 0.04], dark: [0.035, 0.025] };
  const HATCH_ALPHA = { light: 0.27, dark: 0.25 };
  const farTint = () => FAR_TINT[App.isDark() ? 'dark' : 'light'];
  const TOP = 3;
  const CANDIDATES = 10;
  const OSRM_GAP = 1100;
  const EMPTY = { type: 'FeatureCollection', features: [] };

  const ui = {};
  const st = {
    data: null, hosp: [], deliver: [], nicus: [], meta: null, map: null, styleId: '', styleReady: false,
    loc: null, res: null, resFolded: false, seq: 0, gen: 0, popCcn: null, markers: [], me: null, hover: null, sug: [], sugActive: -1, blurTimer: 0, tip: null, shown: false,
    rasters: {}, far: {},
  };
  // The map code works on a "view" (V) so a second map could share the search and results; today there is one. V is the view the map code is working on; each() runs code once per view, inView() pins a callback to one.
  const views = [];
  let V = null;
  const each = (fn) => { const prev = V; views.forEach((v) => { V = v; try { fn(v); } catch (e) { console.error(e); } }); V = prev; };
  const inView = (v, fn) => (...a) => { const prev = V; V = v; try { return fn(...a); } finally { V = prev; } };
  const fullView = () => views.find((v) => v.full);
  // The map you're looking at: the full-screen one, otherwise the map card nearest the middle of the window
  function lookView() {
    const f = fullView();
    if (f) return f;
    const mid = innerHeight / 2;
    return views.reduce((best, v) => {
      const r = v.card.getBoundingClientRect(), d = Math.abs((r.top + r.bottom) / 2 - mid);
      return !best || d < best.d ? { v, d } : best;
    }, null).v;
  }
  const kit = () => App.mapKit;
  const esc = (s) => App.esc(s);
  const fmtMi = (d) => (d < 10 ? d.toFixed(1) : Math.round(d)) + ' mi';
  const fmtMin = (m) => (m == null ? '—' : m < 60 ? `${Math.max(1, Math.round(m))} min` : `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')} min`);
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  // ---------- Data ----------
  function load() {
    if (st.data) return Promise.resolve(st.data);
    return kit().loadScript(DATA_SRC).then(() => {
      if (st.data) return st.data;
      const D = window.CMS_MATERNITY;
      const F = D.meta.fields;
      st.meta = D.meta;
      st.hosp = D.hospitals.map((r) => { const o = {}; F.forEach((k, i) => (o[k] = r[i])); o.title = titleCase(o.name); return o; });
      st.deliver = st.hosp.filter((h) => h.d > 0);
      st.nicus = st.hosp.filter((h) => h.nicu > 0);
      st.data = D;
      window.CMS_MATERNITY = null;
      return D;
    });
  }

  // Same formula as build_maternity.py, fitted to OSRM driving times
  function estMinutes(crow) {
    const e = st.meta.estimate, road = crow * e.roadFactor, local = Math.min(road, e.localMiles);
    return (local / e.localMph) * 60 + (Math.max(0, road - e.localMiles) / e.openMph) * 60;
  }

  // CMS names are upper case: "M HEALTH FAIRVIEW ST JOHN'S HOSPITAL" -> "M Health Fairview St John's Hospital"
  const KEEP = new Set(['UCLA', 'UCSF', 'UC', 'VA', 'OSF', 'SSM', 'HCA', 'UPMC', 'CHI', 'MUSC', 'UAB', 'UNC', 'UW', 'UNM', 'LDS', 'II', 'III', 'IV', 'CAH', 'MN', 'NY', 'CHRISTUS', 'HCMC']);
  const SMALL = new Set(['of', 'and', 'the', 'at', 'in', 'for', 'de', 'la']);
  function titleCase(s) {
    return String(s || '').toLowerCase().split(/(\s+|-|\/)/).map((w, i) => {
      const up = w.toUpperCase();
      if (KEEP.has(up)) return up === 'CHRISTUS' ? 'Christus' : up;
      if (i > 0 && SMALL.has(w)) return w;
      return w.replace(/^(\w)/, (c) => c.toUpperCase()).replace(/^(mc)(\w)/, (m, a, b) => a.replace('m', 'M') + b.toUpperCase()).replace(/'S\b/, "'s");
    }).join('');
  }

  function nicuText(h) {
    if (h.level) {
      const src = st.meta.levelSources[h.levelSrc[0]];
      const label = h.level === 'I' ? 'Level I well‑newborn nursery (no NICU)' : h.level === 'II' ? 'Level II special care nursery' : `Level ${h.level} NICU`;
      return { label, src: src ? src.name : '', url: src ? src.url : '', note: h.levelSrc[1] || '' };
    }
    if (!h.nicu) return null;
    return { label: h.nicuBeds ? `NICU · ${h.nicuBeds} beds` : 'NICU', src: h.nicuBeds ? 'CMS hospital cost report, FY2024' : 'CMS Provider of Services file', url: '', note: 'Level not published in this data.' };
  }
  const isHighNicu = (h) => h.level === 'III' || h.level === 'IV';
  // The blue square: N for a NICU, with its level (AAP levels II, III or IV) where it's published. The letter keeps it
  // apart from the black 1-2-3 ranks of the closest hospitals that deliver babies.
  const nicuMark = (h) => (h.nicu > 0 ? (h.level ? `N\u2009${h.level}` : 'N') : '');
  const nicuSq = (h) => { const n = nicuText(h); return `<span class="mat-rank n"${n ? ` title="${esc(n.label)}"` : ''}>${nicuMark(h) || 'N'}</span>`; };

  // ---------- Status, search and geocoding ----------
  function say(text, isError) {
    ui.status.textContent = text || '';
    ui.status.classList.toggle('error', !!isError);
  }

  const looksLikeAddress = (q) => /\d/.test(q) && /[a-z]{2,}/i.test(q) && !/^\d{5}$/.test(q.trim());

  function suggest(q) {
    const out = [];
    if (looksLikeAddress(q)) out.push({ kind: 'address', q });
    return out.concat(kit().suggest(q).filter((s) => s.kind !== 'state')).slice(0, 8);
  }

  function sugText(s) {
    if (s.kind === 'address') return { main: s.q, sub: 'Street address · look it up' };
    if (s.kind === 'zip') return { main: `ZIP ${s.zip}`, sub: 'ZIP code' };
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
      return `<li role="option" id="matSug${i}" class="hm-sug${i === st.sugActive ? ' active' : ''}" aria-selected="${i === st.sugActive}" data-i="${i}">
        <span class="hm-sug-main">${esc(t.main)}</span><span class="hm-sug-sub">${esc(t.sub)}</span></li>`;
    }).join('');
    if (st.sugActive >= 0) ui.search.setAttribute('aria-activedescendant', `matSug${st.sugActive}`);
  }

  function updateSuggest() {
    const q = ui.search.value;
    st.sug = q.trim() ? suggest(q) : [];
    st.sugActive = st.sug.length ? 0 : -1;
    renderSuggest();
    kit().loadPlaces().then(() => { if (ui.search.value === q && q.trim()) { st.sug = suggest(q); st.sugActive = st.sug.length ? 0 : -1; renderSuggest(); } }, () => {});
  }

  function closeSuggest() { st.sug = []; st.sugActive = -1; renderSuggest(); }

  // The Census geocoder has no CORS headers but supports JSONP; the address goes to census.gov and nowhere else
  function geocodeAddress(q) {
    return new Promise((resolve, reject) => {
      const cb = `matGeo${Date.now()}`;
      const s = document.createElement('script');
      const done = () => { delete window[cb]; s.remove(); clearTimeout(t); };
      const t = setTimeout(() => { done(); reject(new Error('timeout')); }, 12000);
      window[cb] = (res) => {
        done();
        const m = res && res.result && res.result.addressMatches && res.result.addressMatches[0];
        if (!m) { reject(new Error('nomatch')); return; }
        const c = m.addressComponents || {};
        resolve({ lat: m.coordinates.y, lon: m.coordinates.x, label: titleCase(m.matchedAddress.split(',')[0]) + (c.city ? `, ${titleCase(c.city)}` : ''), st: c.state, source: 'address' });
      };
      s.src = `${CENSUS}?address=${encodeURIComponent(q)}&benchmark=Public_AR_Current&format=jsonp&callback=${cb}`;
      s.onerror = () => { done(); reject(new Error('network')); };
      document.head.appendChild(s);
    });
  }

  // Fallback for addresses the Census ranges miss: OpenStreetMap Nominatim (one request per search, as its policy asks)
  function geocodeOsm(q) {
    return fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=us&limit=1&addressdetails=1&q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('network'))))
      .then((j) => {
        const m = j && j[0];
        if (!m) throw new Error('nomatch');
        const a = m.address || {}, town = a.city || a.town || a.village || a.hamlet || '';
        const code = a['ISO3166-2-lvl4'] ? a['ISO3166-2-lvl4'].split('-')[1] : '';
        const street = [a.house_number, a.road].filter(Boolean).join(' ');
        return { lat: +m.lat, lon: +m.lon, label: [street, town].filter(Boolean).join(', ') || m.display_name.split(',').slice(0, 2).join(','), st: code, source: 'address' };
      });
  }

  function choose(s) {
    closeSuggest();
    say('');
    if (s.kind === 'address') {
      say('Looking up the address…');
      const gen = st.gen;
      geocodeAddress(s.q).catch(() => geocodeOsm(s.q)).then((loc) => { if (gen !== st.gen) return; say(''); setLocation(loc); },
        (e) => gen === st.gen && say(e.message === 'nomatch' ? 'That address wasn’t found. Check the spelling, or try your ZIP code or town.' : 'The address lookup isn’t responding. Try your ZIP code or town instead.', true));
      return;
    }
    if (s.kind === 'zip') {
      kit().loadZips().then((m) => {
        const hit = m.get(s.zip);
        if (!hit) { say(`ZIP ${s.zip} wasn’t found. Try your town instead.`, true); return; }
        const near = kit().nearestPlaceTo(hit[0], hit[1]);
        ui.search.value = `ZIP ${s.zip}`;
        setLocation({ lat: hit[0], lon: hit[1], label: `ZIP ${s.zip}${near ? ` (${near.name}, ${near.st})` : ''}`, st: near && near.st, source: 'zip' });
      }, () => say('The ZIP code lookup could not be loaded.', true));
      return;
    }
    const p = s.p;
    ui.search.value = `${p.name}, ${p.st}`;
    setLocation({ lat: p.lat, lon: p.lon, label: `${p.name}, ${p.st}`, st: p.st, source: 'place' });
  }

  function submit() {
    const q = ui.search.value.trim();
    if (!q) { say('Type an address, ZIP code or town.', true); ui.search.focus(); return; }
    if (st.sugActive >= 0 && st.sug[st.sugActive]) { choose(st.sug[st.sugActive]); return; }
    kit().loadPlaces().catch(() => null).then(() => {
      const hit = suggest(q)[0];
      if (hit) choose(hit);
      else choose({ kind: 'address', q });
    });
  }

  function locate() {
    if (!navigator.geolocation || !window.isSecureContext) { say('This browser can’t share your location here. Type your address, ZIP code or town instead.', true); return; }
    say('Finding your location…');
    navigator.geolocation.getCurrentPosition((pos) => {
      say('');
      kit().loadPlaces().catch(() => null).then(() => {
        const near = kit().nearestPlaceTo(pos.coords.latitude, pos.coords.longitude);
        setLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'your location', st: near && near.st, source: 'gps' });
      });
    }, (err) => say(err.code === 1 ? 'Location access is blocked for this page. Type your address, ZIP code or town instead.' : 'Your location couldn’t be found. Type your address instead.', true),
    { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
  }

  // ---------- Finding care ----------
  function nearestBy(list, loc, n) {
    return list.map((h) => ({ h, crow: kit().miles(loc, h) })).sort((a, b) => a.crow - b.crow).slice(0, n)
      .map((x) => ({ ...x, min: estMinutes(x.crow), miles: x.crow * st.meta.estimate.roadFactor, routed: false }));
  }

  // One OSRM table request ranks every candidate by real driving time (OSRM allows browser use, about one request a second)
  function osrmTable(loc, items) {
    const coords = [[loc.lon, loc.lat]].concat(items.map((x) => [x.h.lon, x.h.lat])).map((c) => c.map((v) => v.toFixed(5)).join(',')).join(';');
    return fetch(`${OSRM}/table/v1/driving/${coords}?sources=0&annotations=duration,distance`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
      .then((j) => {
        if (j.code !== 'Ok') throw new Error(j.code);
        items.forEach((x, i) => {
          const dur = j.durations[0][i + 1], dist = j.distances && j.distances[0][i + 1];
          if (dur != null) { x.min = dur / 60; x.miles = dist / 1609.34; x.routed = true; }
        });
        return items;
      });
  }

  function osrmRoute(loc, h) {
    return fetch(`${OSRM}/route/v1/driving/${loc.lon.toFixed(5)},${loc.lat.toFixed(5)};${h.lon.toFixed(5)},${h.lat.toFixed(5)}?overview=full&geometries=geojson`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
      .then((j) => (j.code === 'Ok' && j.routes[0] ? j.routes[0] : Promise.reject(new Error(j.code))));
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function setLocation(loc) {
    const seq = ++st.seq;
    views.forEach((v) => { v.userMoved = false; });
    st.loc = loc;
    if (!loc.st) { const n = kit().nearestPlaceTo(loc.lat, loc.lon); loc.st = n && n.st; }
    const ld = nearestBy(st.deliver, loc, CANDIDATES);
    const ni = nearestBy(st.nicus, loc, 6);
    // NICU levels are published only for some states (so far Minnesota). Elsewhere the "nearest Level III+" would point at
    // a hospital in a distant state just because it's the only one with a known level, so it's left out.
    const levelStates = new Set(st.hosp.filter((h) => h.level).map((h) => h.st));
    const hi = levelStates.has(loc.st) ? nearestBy(st.nicus.filter(isHighNicu), loc, 3) : [];
    st.res = { loc, ld, ni, hi, routed: false, failed: false, routes: {} };
    st.popCcn = null;
    st.resFolded = false;
    pick();
    renderResults();
    ui.results.scrollTop = 0;
    each(() => drawResults(true));
    if (!fullView()) {
      const card = lookView().card, b = card.getBoundingClientRect();
      if (b.top > innerHeight * 0.6 || b.bottom < 0) card.scrollIntoView({ block: 'start', behavior: App.reduceMotion ? 'auto' : 'smooth' });
    }
    // Rank by real driving time, then fetch the chosen routes one at a time
    const uniq = new Map();
    [...ld, ...ni, ...hi].forEach((x) => uniq.set(x.h.ccn, x));
    const items = [...uniq.values()];
    osrmTable(loc, items).then(() => {
      if (seq !== st.seq) return null;
      items.forEach((x) => { [ld, ni, hi].forEach((arr) => arr.forEach((y) => { if (y.h.ccn === x.h.ccn) Object.assign(y, { min: x.min, miles: x.miles, routed: x.routed }); })); });
      st.res.routed = true;
      pick();
      renderResults();
      // Straight-line nearest can be across a lake or a mountain range; frame the hospitals that are nearest by road
      each(() => drawResults(!V.userMoved));
      const want = [...st.res.top, st.res.nicu, st.res.high].filter(Boolean).filter((x, i, a) => a.findIndex((y) => y.h.ccn === x.h.ccn) === i);
      return want.reduce((p, x, i) => p.then(() => (i ? wait(OSRM_GAP) : null)).then(() => {
        if (seq !== st.seq) return null;
        return osrmRoute(loc, x.h).then((r) => {
          if (seq !== st.seq) return;
          st.res.routes[x.h.ccn] = r.geometry;
          each(drawRoutes);
        }, () => {});
      }), Promise.resolve()).then(() => {
        // Once every route is drawn, frame them all, unless you've already moved the map yourself
        if (seq === st.seq) each(() => { if (!V.userMoved && V.map) fitResults(); });
      });
    }).catch(() => {
      if (seq !== st.seq) return;
      st.res.failed = true;
      renderResults();
      each(() => drawResults(false));
    });
  }

  function pick() {
    const r = st.res, by = (a, b) => a.min - b.min;
    r.ld.sort(by); r.ni.sort(by); r.hi.sort(by);
    r.top = r.ld.slice(0, TOP);
    r.nicu = r.ni[0] || null;
    r.high = r.hi[0] && (!r.nicu || r.hi[0].h.ccn !== r.nicu.h.ccn) ? r.hi[0] : null;
  }

  // ---------- Panel ----------
  function band(min) {
    if (min <= 30) return { cls: 'good', tag: 'Within 30 minutes', text: 'Most women in the U.S. live this close to a hospital that delivers babies.' };
    if (min <= 60) return { cls: 'warn', tag: '30 to 60 minutes', text: 'Longer than the 30‑minute benchmark used in perinatal research. Plan the route and timing in advance.' };
    return { cls: 'bad', tag: 'More than an hour', text: 'You live in a maternity care desert by drive time. Long drives in labour are linked to more complications; talk to your care team early about where you will deliver.' };
  }

  function stateLine(code) {
    const s = code && st.meta.states[code];
    if (!s) return '';
    const name = App.STATE_NAMES[code] || code;
    return `In ${esc(name)}, <b>${App.pct1(s.w30 / s.women)}</b> of women aged 15–44 live more than 30 minutes from a hospital that delivers babies (U.S. ${App.pct1(st.meta.women['30'] / st.meta.women.all)}).`;
  }

  function directions(h) {
    const dest = `${h.title}, ${h.address}, ${titleCase(h.city)}, ${h.st} ${h.zip}`;
    const o = st.res && st.res.loc;
    return `https://www.google.com/maps/dir/?api=1${o ? `&origin=${o.lat.toFixed(5)},${o.lon.toFixed(5)}` : ''}&destination=${encodeURIComponent(dest)}&travelmode=driving`;
  }

  function timeCell(x) {
    const est = !x.routed;
    return `<span class="mat-time${est ? ' est' : ''}" title="${est ? 'Estimated from distance; checking real roads…' : 'Driving time by road, without traffic (OSRM)'}">${fmtMin(x.min)}</span>
      <span class="mat-dist">${fmtMi(x.miles)}${est ? ' · est.' : ' by road'}</span>`;
  }

  function hospCard(x, i, kind) {
    const h = x.h, n = nicuText(h);
    const badges = [];
    if (kind !== 'ld' && h.d === 0) badges.push('<span class="mat-badge muted">Does not deliver babies</span>');
    if (h.d === 1) badges.push('<span class="mat-badge muted" title="CMS provider file lists obstetric services; the hospital has not reported maternal measures">Obstetric services listed</span>');
    if (h.bf) badges.push('<span class="mat-badge good" title="CMS Birthing‑Friendly designation: takes part in a perinatal quality collaborative and uses safety bundles">Birthing‑Friendly</span>');
    if (n && h.nicu) badges.push(`<span class="mat-badge nicu" title="${esc(n.src)}${n.note ? ' · ' + esc(n.note) : ''}">${esc(n.label)}</span>`);
    if (h.er === 0) badges.push('<span class="mat-badge muted">No emergency department</span>');
    // A hospital that delivers babies and has a NICU shows both squares, its rank and its NICU level, as its map pin does
    const marks = kind === 'ld' ? `<span class="mat-rank">${i + 1}</span>${nicuMark(h) ? nicuSq(h) : ''}` : nicuSq(h);
    return `<li class="mat-hosp" data-ccn="${h.ccn}" data-kind="${kind}">
      <span class="mat-marks">${marks}</span>
      <div class="mat-hosp-main">
        <div class="mat-hosp-name">${esc(h.title)}</div>
        <div class="mat-hosp-sub">${esc(titleCase(h.city))}, ${esc(h.st)}</div>
        ${badges.length ? `<div class="mat-badges">${badges.join('')}</div>` : ''}
        <div class="mat-actions">
          <a href="${directions(h)}" target="_blank" rel="noopener noreferrer">Directions in Google Maps</a>
          ${h.phone ? `<a href="tel:${esc(h.phone.replace(/[^\d+]/g, ''))}">Call ${esc(h.phone)}</a>` : ''}
          ${n && n.url ? `<a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">NICU source</a>` : ''}
        </div>
      </div>
      <div class="mat-hosp-time">${timeCell(x)}</div>
    </li>`;
  }

  // The floating card holds the search and, once there is one, its results; it grows and shrinks to fit them
  function renderResults() {
    sizeSide(() => { syncClear(); paintResults(); syncResBar(); });
  }

  // The results: the answer, then the closest hospitals, then the notes that qualify them
  function paintResults() {
    const r = st.res, box = ui.results;
    if (!r) { box.innerHTML = ''; return; }
    const first = r.top[0];
    if (!first) { box.innerHTML = '<p class="mat-note">No hospitals found.</p>'; return; }
    const b = band(first.min);
    // A spot clicked on the map isn't necessarily where the reader lives
    if (r.loc.source === 'map') b.text = b.text.replace('You live in', 'This spot is in').replace('talk to your care team early about where you will deliver', 'anyone expecting a baby here should plan early where to deliver');
    const routedNote = r.failed ? 'Drive times are estimates from distance (the routing service didn’t respond).'
      : r.routed ? 'Drive times by road without traffic (OpenStreetMap routing). Allow extra time at rush hour and in winter. In an emergency, call 911.' : 'Estimating from distance; checking real roads…';
    // The nearest NICU (and nearest Level III or IV NICU) get their own card only when they aren't already one of the
    // closest hospitals above, where their blue square already says so
    const inTop = (x) => r.top.some((y) => y.h.ccn === x.h.ccn);
    const nicuCards = [[r.nicu, 'nicu'], [r.high, 'high']].filter(([x]) => x && !inTop(x)).map(([x, kind]) => hospCard(x, 0, kind)).join('');
    const shown = [...r.top, r.nicu, r.high].filter(Boolean);
    const levelNote = shown.some((x) => x.h.nicu > 0 && x.h.level)
      ? '<p class="mat-note">N II is a Level II special care nursery; N III and N IV are NICUs for the smallest and sickest babies (Level IV is the highest). Levels come from the sources linked on each card.</p>'
      : r.nicu ? `<p class="mat-note">NICU levels (II, III or IV) aren’t published for ${esc(App.STATE_NAMES[r.loc.st] || 'this state')} in this data, so the blue N doesn’t show a level. Ask the hospital, or your doctor or midwife, what level of newborn care it provides.</p>` : '';
    const cp = r.copilot;
    const cpNote = cp ? `<p class="mat-copilot">${esc(copilotLine(cp))}</p>` : '';
    box.innerHTML = `<div class="mat-result mat-fade">${cpNote}
      <div class="mat-key">
        <span><span class="mat-marks"><span class="mat-rank">1</span></span>Delivers babies</span>
        <span><span class="mat-marks"><span class="mat-rank n">N</span></span>NICU</span>
        <span><span class="mat-marks"><span class="mat-rank">1</span><span class="mat-rank n">N</span></span>Both</span>
      </div>
      <div class="mat-verdict ${b.cls}">
        <div class="mat-v-row"><span class="mat-v-time${first.routed ? '' : ' est'}">${fmtMin(first.min)}</span><span class="pill ${b.cls === 'good' ? 'better' : b.cls === 'bad' ? 'worse' : 'similar'}">${b.tag}</span></div>
        <div class="mat-v-text">to the nearest hospital that delivers babies, <b>${esc(first.h.title)}</b>. ${b.text}</div>
      </div>
      <div class="mat-result-lists">
        <h4 class="mat-h"><i class="mat-h-sq" aria-hidden="true"></i>Closest hospitals that deliver babies</h4>
        <ol class="mat-list">${r.top.map((x, i) => hospCard(x, i, 'ld')).join('')}</ol>
        ${nicuCards ? `<h4 class="mat-h nicu"><i class="mat-h-sq n" aria-hidden="true"></i>Nearest newborn intensive care (NICU)</h4><ol class="mat-list">${nicuCards}</ol>` : ''}
      </div>
      <div class="mat-result-notes">
        ${levelNote}
        ${stateLine(r.loc.st) ? `<p class="mat-context">${stateLine(r.loc.st)}</p>` : ''}
        <p class="mat-note">${routedNote}</p>
      </div>
    </div>`;
    box.querySelectorAll('.mat-hosp').forEach((li) => {
      li.addEventListener('mouseenter', () => highlight(li.dataset.ccn));
      li.addEventListener('mouseleave', () => highlight(st.popCcn || null));
      li.addEventListener('click', (e) => { if (!e.target.closest('a')) inView(lookView(), focusHospital)(li.dataset.ccn); });
    });
  }

  // The bar under the search: where the results are from while they're open, and the answer itself once they're folded
  function syncResBar() {
    const r = st.res, first = r && r.top && r.top[0];
    const folded = !!first && st.resFolded;
    ui.resBar.hidden = !first;
    ui.results.hidden = folded;
    views.forEach((v) => v.wrap.classList.toggle('res-folded', folded));
    if (!first) return;
    ui.resBar.setAttribute('aria-expanded', String(!folded));
    ui.resBar.title = folded ? 'Show the results' : 'Fold the results away';
    ui.resAct.textContent = folded ? 'Show' : 'Hide';
    ui.resSum.innerHTML = folded
      ? `${first.routed ? '' : 'About '}<b>${fmtMin(first.min)}</b> <span class="mat-res-to">to ${esc(first.h.title)}</span>`
      : `From ${esc(r.loc.label)}`;
  }

  function foldResults(folded) {
    if (!st.res) return;
    sizeSide(() => { st.resFolded = folded; syncResBar(); });
    // Results that open over a hospital's card move the map so the card stays in view
    if (!folded) each(() => { if (V.map) keepPopupClear(); });
  }

  // Change what the card holds, then animate its height from the old size to the new one (measure, change, measure)
  function sizeSide(change) {
    const before = views.map((v) => v.side.getBoundingClientRect().height);
    views.forEach((v) => {
      v.side.getAnimations().forEach((a) => a.cancel());
      v.side.classList.remove('is-sizing');
      v.sizeTok++;
    });
    change();
    views.forEach((v, i) => {
      const s = v.side, h = s.getBoundingClientRect().height, tok = v.sizeTok;
      v.sideH = h;
      if (App.reduceMotion || !s.offsetParent || Math.abs(h - before[i]) < 2) return;
      s.classList.add('is-sizing');
      const done = () => { if (v.sizeTok === tok) s.classList.remove('is-sizing'); };
      s.animate([{ height: `${before[i]}px` }, { height: `${h}px` }], { duration: 480, easing: (kit() && kit().easeCss) || 'ease' }).finished.then(done, done);
    });
  }

  // Keep the map's furniture clear of the card: the legend moves over when the card reaches down to it, and on phones
  // everything along the bottom rides above the sheet
  function syncSideBox(v) {
    const s = v.side, h = s.offsetHeight;
    if (!s.classList.contains('is-sizing')) v.sideH = h;
    const over = getComputedStyle(s).position === 'absolute', sheet = over && isSheet();
    v.wrap.style.setProperty('--sheet-h', `${sheet ? h : 0}px`);
    v.wrap.classList.toggle('side-low', over && !sheet && s.offsetTop + h > v.legend.offsetTop - 10);
  }

  // ---------- Drive-time surface ----------
  // Each region's PNG holds minutes (R = delivery care, G = NICU, B = land mask); colour it for the current mode and theme
  // The drive-time grids arrive as PNG data URLs inside a script (assets/maternity-access.js), so their pixels can be read
  // even when the page is opened straight from disk
  const ACCESS_SRC = 'assets/maternity-access.js';
  function loadRasters() {
    const R = st.meta.rasters;
    return kit().loadScript(ACCESS_SRC).then(() => {
      const urls = window.CMS_MATERNITY_ACCESS || {};
      return Promise.all(Object.entries(R).map(([name, r]) => {
        if (st.rasters[name]) return st.rasters[name];
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = img.width; c.height = img.height;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);
            const [w, s0, e, n] = r.bounds;
            st.rasters[name] = { name, w, s: s0, e, n, W: img.width, H: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
            resolve(st.rasters[name]);
          };
          img.onerror = reject;
          img.src = urls[name];
        });
      }));
    });
  }

  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  // Minutes at a point, read straight from the surface (null outside the U.S.)
  function minutesAt(lng, lat) {
    const r = Object.values(st.rasters).find((x) => lng >= x.w && lng <= x.e && lat >= x.s && lat <= x.n);
    if (!r) return null;
    const x = Math.floor(((lng - r.w) / (r.e - r.w)) * r.W);
    const y = Math.floor(((mercY(r.n) - mercY(lat)) / (mercY(r.n) - mercY(r.s))) * r.H);
    const i = (Math.min(r.H - 1, Math.max(0, y)) * r.W + Math.min(r.W - 1, Math.max(0, x))) * 4;
    return r.data[i + 2] ? { ld: r.data[i], nicu: r.data[i + 1] } : null;
  }

  // Areas beyond each threshold, traced from the minutes surface with d3.contours (water and other countries count as near,
  // so shading stops at the coast and the border). Cached per mode; returns { 30: FeatureCollection, 60: FeatureCollection }.
  function farAreas(mode) {
    if (st.far[mode]) return st.far[mode];
    const ch = mode === 'nicu' ? 1 : 0, out = {};
    FAR.forEach((t) => { out[t] = { type: 'FeatureCollection', features: [] }; });
    Object.values(st.rasters).forEach((r) => {
      const f = r.W > 1500 ? 2 : 1, w2 = Math.floor(r.W / f), h2 = Math.floor(r.H / f), vals = new Float64Array(w2 * h2);
      for (let j = 0; j < h2; j++) {
        for (let i = 0; i < w2; i++) {
          const k = ((j * f) * r.W + i * f) * 4;
          vals[j * w2 + i] = r.data[k + 2] ? r.data[k + ch] : 0;
        }
      }
      const y0 = mercY(r.n), dy = y0 - mercY(r.s);
      const pt = ([x, y]) => [+(r.w + (x / w2) * (r.e - r.w)).toFixed(4), +((2 * Math.atan(Math.exp(y0 - (y / h2) * dy)) - Math.PI / 2) * 180 / Math.PI).toFixed(4)];
      d3.contours().size([w2, h2]).thresholds(FAR).smooth(true)(vals).forEach((c) => {
        const coords = c.coordinates.map((poly) => poly.map((ring) => ring.map(pt))).filter((poly) => poly[0].length > 6);
        if (coords.length) out[c.value].features.push({ type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: coords } });
      });
    });
    return (st.far[mode] = out);
  }

  // A fine diagonal hatch, drawn at screen resolution so it stays crisp at every zoom
  function hatchImage(ink) {
    const pr = 2, n = 7 * pr, c = document.createElement('canvas');
    c.width = c.height = n;
    const ctx = c.getContext('2d');
    ctx.strokeStyle = ink;
    ctx.globalAlpha = HATCH_ALPHA[App.isDark() ? 'dark' : 'light'];
    ctx.lineWidth = 0.9 * pr;
    [-n, 0, n].forEach((o) => { ctx.beginPath(); ctx.moveTo(o, n); ctx.lineTo(o + n, 0); ctx.stroke(); });
    return ctx.getImageData(0, 0, n, n);
  }

  // Called from onStyleLoad (before the style is marked ready) and whenever the mode, theme or data change
  function addRasterLayers(beforeId, styleLoading) {
    if (!V.map || (!V.styleReady && !styleLoading) || !Object.keys(st.rasters).length) return;
    const v = V, mode = V.mode;
    const apply = inView(v, () => {
      if (!V.map || V.mode !== mode || !V.map.getStyle()) return;
      const areas = farAreas(mode), ink = farInk();
      if (V.map.hasImage('mt-hatch')) V.map.removeImage('mt-hatch');
      V.map.addImage('mt-hatch', hatchImage(ink), { pixelRatio: 2 });
      if (V.map.getSource('mt-far30')) {
        V.map.getSource('mt-far30').setData(areas[30]);
        V.map.getSource('mt-far60').setData(areas[60]);
        V.map.setPaintProperty('mt-far30', 'fill-color', ink);
        V.map.setPaintProperty('mt-far60-tint', 'fill-color', ink);
        V.map.setPaintProperty('mt-far30', 'fill-opacity', farTint()[0]);
        V.map.setPaintProperty('mt-far60-tint', 'fill-opacity', farTint()[1]);
        return;
      }
      const below = beforeId || (V.map.getLayer('mt-borders') ? 'mt-borders' : undefined);
      V.map.addSource('mt-far30', { type: 'geojson', data: areas[30], tolerance: 0.6 });
      V.map.addSource('mt-far60', { type: 'geojson', data: areas[60], tolerance: 0.6 });
      V.map.addLayer({ id: 'mt-far30', type: 'fill', source: 'mt-far30', paint: { 'fill-color': ink, 'fill-opacity': farTint()[0], 'fill-antialias': false } }, below);
      V.map.addLayer({ id: 'mt-far60-tint', type: 'fill', source: 'mt-far60', paint: { 'fill-color': ink, 'fill-opacity': farTint()[1], 'fill-antialias': false } }, below);
      V.map.addLayer({ id: 'mt-far60', type: 'fill', source: 'mt-far60', paint: { 'fill-pattern': 'mt-hatch' } }, below);
    });
    // Tracing the areas takes a moment the first time for each mode, so it runs after the map has painted
    if (st.far[mode]) apply(); else setTimeout(apply, 30);
  }

  function setMode(mode) {
    if (V.mode === mode) return;
    V.mode = mode;
    renderModeChips();
    renderLegend();
    addRasterLayers();
  }

  function renderModeChips() {
    V.modeEl.innerHTML = [['ld', 'Delivery care'], ['nicu', 'NICU']].map(([k, l]) =>
      `<button type="button" class="mat-mode-btn${V.mode === k ? ' on' : ''} ${k}" data-mode="${k}" aria-pressed="${V.mode === k}">${l}</button>`).join('');
    V.modeEl.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', inView(V, () => setMode(b.dataset.mode))));
  }

  // ---------- Map ----------
  function ensureMap() {
    if (V.map) return true;
    try {
      V.map = new maplibregl.Map({
        container: V.canvas, style: kit().styleFor(kit().styleId()), bounds: US_BOUNDS, fitBoundsOptions: { padding: (() => { const c = covered(); return { top: 20 + c.top, bottom: 20 + c.bottom, right: 20, left: 20 + c.left }; })() },
        minZoom: 2, maxZoom: 16, renderWorldCopies: false, dragRotate: false, pitchWithRotate: false, touchPitch: false,
        attributionControl: { compact: true, customAttribution: 'Routing © OSRM · OpenStreetMap' }, fadeDuration: 150,
      });
    } catch (e) {
      V.map = null;
      say('This browser can’t display the interactive map (WebGL is unavailable).', true);
      return false;
    }
    // Every handler registered on this map (including the shared border/label helpers) runs with V set to this view
    const v = V, on = V.map.on.bind(V.map), once = V.map.once.bind(V.map);
    V.map.on = (...a) => { a[a.length - 1] = inView(v, a[a.length - 1]); return on(...a); };
    V.map.once = (...a) => { if (typeof a[a.length - 1] === 'function') a[a.length - 1] = inView(v, a[a.length - 1]); return once(...a); };
    V.styleId = kit().styleId();
    V.canvas.classList.add('is-loading');
    V.map.once('load', () => V.canvas.classList.remove('is-loading'));
    V.map.touchZoomRotate.disableRotation();
    // The legend rides just above the map credits while they're open, and settles back when they fold to an ⓘ
    const credits = V.canvas.querySelector('.maplibregl-ctrl-attrib'), wrap = V.wrap;
    if (credits && window.ResizeObserver) {
      new ResizeObserver(() => wrap.style.setProperty('--attrib-h', `${credits.classList.contains('maplibregl-compact-show') ? credits.offsetHeight + 6 : 0}px`)).observe(credits);
    }
    // Remember when you pan or zoom yourself, so a late route doesn't yank the view back
    ['dragstart', 'zoomstart'].forEach((ev) => V.map.on(ev, (e) => { if (e.originalEvent) V.userMoved = true; }));
    V.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    V.tip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'hm-tip', offset: 10, maxWidth: '260px' });
    V.map.on('style.load', onStyleLoad);
    V.map.on('styleimagemissing', (e) => { if (!V.map.hasImage(e.id)) V.map.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) }); });
    // Click anywhere: the estimated drive from that spot, read from the surface. It stays until the next click or ×.
    V.spot = new maplibregl.Popup({ closeButton: true, closeOnClick: false, className: 'hm-tip mat-spot', offset: 8, maxWidth: '260px' });
    V.spot.on('close', () => { if (st.popCcn) { st.popCcn = null; highlight(null); } });
    V.map.on('click', (e) => {
      if (onMarker(e)) return;
      if (V.map.queryRenderedFeatures(e.point, { layers: ['mt-hosp', 'mt-gone'].filter((l) => V.map.getLayer(l)) }).length) return;
      const v = minutesAt(e.lngLat.lng, e.lngLat.lat);
      if (!v) { V.spot.remove(); return; }
      const fmt = (m) => (m >= 254 ? 'more than 4 hours' : fmtMin(m));
      const near = kit().nearestPlaceTo(e.lngLat.lat, e.lngLat.lng);
      const el = document.createElement('div');
      el.innerHTML = `<b>About ${fmt(v.ld)}</b> to the nearest hospital that delivers babies<br><span class="mat-tip-nicu">About ${fmt(v.nicu)} to the nearest NICU</span><br><span class="mat-tip-note">Estimated drive from this spot${near ? ` · near ${esc(near.name)}, ${esc(near.st)}` : ''}</span>
        <button type="button" class="mat-spot-go">Show nearest hospitals &amp; NICU from here</button>`;
      // Treat the clicked spot like a searched address: nearest care, road routes, drive times and directions from here
      el.querySelector('.mat-spot-go').addEventListener('click', () => {
        V.spot.remove();
        const label = near ? `this spot near ${near.name}, ${near.st}` : 'this spot';
        ui.search.value = near ? `Near ${near.name}, ${near.st}` : `${e.lngLat.lat.toFixed(4)}, ${e.lngLat.lng.toFixed(4)}`;
        say('');
        setLocation({ lat: e.lngLat.lat, lon: e.lngLat.lng, label, st: near && near.st, source: 'map' });
      });
      V.spot.setOffset(8).setMaxWidth('260px').setLngLat(e.lngLat).setDOMContent(el).addTo(V.map);
      keepPopupClear();
    });
    ['mt-hosp', 'mt-gone'].forEach((layer) => {
      V.map.on('mousemove', layer, (e) => {
        V.map.getCanvas().style.cursor = 'pointer';
        const h = st.byCcn.get(e.features[0].properties.c);
        const n = nicuText(h);
        const what = h.gone ? 'Stopped delivering babies (reports no labor and delivery care to CMS)' : h.d ? 'Delivers babies' : 'Does not deliver babies';
        V.tip.setLngLat([h.lon, h.lat]).setHTML(`<b>${esc(h.title)}</b><br>${esc(titleCase(h.city))}, ${esc(h.st)} · ${what}${n && h.nicu ? `<br>${esc(n.label)}` : ''}`).addTo(V.map);
      });
      V.map.on('mouseleave', layer, () => { V.map.getCanvas().style.cursor = ''; V.tip.remove(); });
      V.map.on('click', layer, (e) => { if (!onMarker(e)) pickHospital(e.features[0].properties.c); });
    });
    return true;
  }

  function onStyleLoad() {
    const C = App.C, dark = App.isDark();
    const firstSymbol = (V.map.getStyle().layers.find((l) => l.type === 'symbol') || {}).id;
    V.map.addSource('mt-veil', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]] } } });
    V.map.addLayer({ id: 'mt-veil', type: 'fill', source: 'mt-veil', paint: { 'fill-color': C.bg, 'fill-opacity': dark ? 0.08 : 0.12 } }, firstSymbol);
    // State lines, an outline on hover, state codes and city pills: the same look as the hospital map. The hover outline is
    // ink here: blue means NICU on this map and orange means far from care
    kit().decorBorders(V.map, 'mt-', firstSymbol, C.text);
    addRasterLayers('mt-borders', true);
    V.map.addSource('mt-routes', { type: 'geojson', data: EMPTY });
    // Places a Copilot answer kept out of (nearest_care avoid): a tint and a dashed edge, in ink rather than a colour
    V.map.addSource('mt-zones', { type: 'geojson', data: zoneData() });
    V.map.addLayer({ id: 'mt-zone-fill', type: 'fill', source: 'mt-zones', paint: { 'fill-color': C.text, 'fill-opacity': 0.07 } });
    V.map.addLayer({ id: 'mt-zone-line', type: 'line', source: 'mt-zones', paint: { 'line-color': C.text, 'line-opacity': 0.6, 'line-width': 1.5, 'line-dasharray': [2, 2] } });
    V.map.addLayer({ id: 'mt-route-casing', type: 'line', source: 'mt-routes', layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'cas'], 'line-width': ['case', ['==', ['get', 'both'], 1], ['case', ['==', ['get', 'on'], 1], 11, 9], ['case', ['==', ['get', 'on'], 1], 9, 7]], 'line-opacity': ['get', 'op'] } });
    V.map.addLayer({ id: 'mt-route', type: 'line', source: 'mt-routes', layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'col'], 'line-width': ['case', ['==', ['get', 'on'], 1], 5, 3.5], 'line-opacity': ['get', 'op'],
        'line-width-transition': { duration: 200 }, 'line-opacity-transition': { duration: 200 } } });
    V.map.addSource('mt-hosp', { type: 'geojson', data: hospData() });
    V.map.addLayer({ id: 'mt-gone', type: 'circle', source: 'mt-hosp', filter: ['==', ['get', 'g'], 1], minzoom: 4,
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 2.5, 10, 6], 'circle-color': C.surface, 'circle-opacity': 0.9, 'circle-stroke-color': cssVar('--hm-hollow'), 'circle-stroke-width': 1.4 } });
    // Black = delivers babies; blue = NICU (a blue ring around a hospital that does both, and the NICU route)
    const nicu = cssVar('--nicu');
    V.map.addLayer({ id: 'mt-hosp', type: 'circle', source: 'mt-hosp', filter: ['==', ['get', 'g'], 0], layout: { 'circle-sort-key': ['get', 'n'] },
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 0.8, 3.5, 1.6, 5, ['case', ['==', ['get', 'n'], 1], 2.8, 2.4], 7, ['case', ['==', ['get', 'n'], 1], 4.6, 3.8], 10, ['case', ['==', ['get', 'n'], 1], 8, 6.5]],
        'circle-color': ['case', ['==', ['get', 'd'], 1], C.text, nicu],
        'circle-stroke-color': ['case', ['==', ['get', 'n'], 1], nicu, C.surface],
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 2, 0.3, 4, ['case', ['==', ['get', 'n'], 1], 1, 0.5], 7, ['case', ['==', ['get', 'n'], 1], 2.2, 1.1], 10, ['case', ['==', ['get', 'n'], 1], 2.6, 1.2]],
      } });
    // Place names sit under the routes and hospital dots, so a hospital is never hidden by a town name
    kit().decorLabels(V.map, 'mt-', 'mt-route-casing', 1.3);
    V.styleReady = true;
    // A map that opens after a search frames the results once
    drawResults(!!st.res && V.fittedSeq !== st.seq);
    if (st.res) drawRoutes();
  }

  function hospData() {
    return {
      type: 'FeatureCollection',
      features: st.hosp.filter((h) => h.d || h.nicu || h.gone).map((h) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [h.lon, h.lat] },
        properties: { c: h.ccn, d: h.d > 0 ? 1 : 0, n: h.nicu > 0 ? 1 : 0, g: h.gone && !h.d ? 1 : 0 } })),
    };
  }

  function showMap() {
    const id = kit().styleId();
    return kit().loadLib().then(() => kit().loadStyle(id)).then(inView(V, () => {
      if (!ensureMap()) return;
      if (V.styleId !== id) {
        V.styleId = id;
        V.styleReady = false;
        V.map.setStyle(kit().styleFor(id), { diff: false });
      }
      V.map.resize();
    }), () => say('The map could not be loaded (are you offline?).', true));
  }

  function clearMarkers() {
    V.markers.forEach((m) => m.remove());
    V.markers = [];
  }

  // Numbered pins for the results and a time label on each route
  function drawResults(fit) {
    if (!V.map || !V.styleReady) return;
    clearMarkers();
    const r = st.res;
    if (V.map.getSource('mt-zones')) V.map.getSource('mt-zones').setData(zoneData());
    if (!r) { if (V.me) { V.me.remove(); V.me = null; } V.map.getSource('mt-routes').setData(EMPTY); return; }
    if (!V.me) {
      const el = document.createElement('div');
      el.className = 'hm-me';
      el.innerHTML = '<span></span>';
      el.title = 'Where the drive times are measured from';
      const v = V;
      el.addEventListener('click', (ev) => { ev.stopPropagation(); inView(v, mePopup)(); });
      V.me = new maplibregl.Marker({ element: el, anchor: 'center' });
    }
    V.me.setLngLat([r.loc.lon, r.loc.lat]).addTo(V.map);
    // Ranked pins for the closest hospitals that deliver babies, with the blue NICU square beside the rank where they have
    // one; the nearest NICUs that aren't among them get a blue pin of their own
    const inTop = (x) => r.top.some((y) => y.h.ccn === x.h.ccn);
    const pins = r.top.map((x, i) => [x, String(i + 1), nicuMark(x.h) ? 'ld both' : 'ld']);
    if (r.nicu && !inTop(r.nicu)) pins.push([r.nicu, nicuMark(r.nicu.h) || 'N', 'nicu']);
    if (r.high && !inTop(r.high) && r.high.h.ccn !== (r.nicu && r.nicu.h.ccn)) pins.push([r.high, nicuMark(r.high.h) || 'N', 'high']);
    const v = V;
    pins.forEach(([x, label, kind]) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `mat-pin ${kind}`;
      el.dataset.ccn = x.h.ccn;
      const extra = kind === 'ld both' ? `<span class="mat-pin-n" title="${esc(nicuText(x.h).label)}">${nicuMark(x.h)}</span>` : '';
      el.innerHTML = `<span>${label}</span>${extra}<em>${fmtMin(x.min)}${x.routed ? '' : ' est.'}</em>`;
      el.title = `${x.h.title} · ${fmtMin(x.min)}`;
      el.addEventListener('mouseenter', () => highlight(x.h.ccn));
      el.addEventListener('mouseleave', () => highlight(st.popCcn || null));
      el.addEventListener('click', (ev) => { ev.stopPropagation(); inView(v, pickHospital)(x.h.ccn); });
      V.markers.push(new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([x.h.lon, x.h.lat]).addTo(V.map));
    });
    drawRoutes();
    if (fit) { V.fittedSeq = st.seq; fitResults(); }
  }

  function fitResults() {
    if (!V.map || !st.res) return;
    // Every result and its whole route (roads can bulge beyond the straight line between you and the hospital)
    const r = st.res, pts = [r.loc, ...[...r.top, r.nicu, r.high].filter(Boolean).map((x) => x.h)];
    Object.values(r.routes).forEach((g) => g.coordinates.forEach(([lon, lat]) => pts.push({ lon, lat })));
    ((r.copilot && r.copilot.zones) || []).filter((z) => !z.outline).forEach((z) => circle(z).geometry.coordinates[0].forEach(([lon, lat]) => pts.push({ lon, lat })));
    let w = 180, s = 90, e = -180, n = -90;
    pts.forEach((p) => { w = Math.min(w, p.lon); e = Math.max(e, p.lon); s = Math.min(s, p.lat); n = Math.max(n, p.lat); });
    // Keep the pins clear of the legend in the bottom-left corner, and their time labels (centred on each pin) clear of the sides
    const c = covered();
    V.map.fitBounds([[w, s], [e, n]], { padding: { top: 70 + c.top, bottom: Math.min(V.canvas.clientHeight / 3, V.legend.offsetHeight + 36) + c.bottom, left: 90 + c.left, right: 84 }, maxZoom: 12.5, duration: App.reduceMotion ? 0 : 1100, easing: kit().ease });
  }

  function routeColor(kind) { return kind === 'ld' ? App.C.text : cssVar('--nicu'); }

  // A circle on the map, `miles` around a place
  function circle(z, steps = 72) {
    const d = z.miles / 3958.8, la = (z.lat * Math.PI) / 180, lo = (z.lon * Math.PI) / 180, ring = [];
    for (let i = 0; i <= steps; i++) {
      const b = (2 * Math.PI * i) / steps;
      const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
      const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
      ring.push([(lo2 * 180) / Math.PI, (la2 * 180) / Math.PI]);
    }
    return { type: 'Feature', properties: { name: z.name }, geometry: { type: 'Polygon', coordinates: [ring] } };
  }
  // A whole state kept out of is its outline; a town, a circle around it
  const zoneFeature = (z) => (z.outline ? { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: z.outline.map((r) => [r.map(([la, lo]) => [lo, la])]) } } : circle(z));
  const zoneData = () => ({ type: 'FeatureCollection', features: ((st.res && st.res.copilot && st.res.copilot.zones) || []).map(zoneFeature) });

  function drawRoutes() {
    if (!V.map || !V.styleReady || !st.res) return;
    const r = st.res, feats = [];
    // A hospital that delivers babies and has a NICU gets one route: black, edged in NICU blue
    const add = (x, kind) => {
      const g = r.routes[x.h.ccn];
      const on = st.hover === x.h.ccn ? 1 : 0, dim = st.hover && !on;
      const both = kind === 'ld' && nicuMark(x.h) ? 1 : 0;
      feats.push({ type: 'Feature', geometry: g || { type: 'LineString', coordinates: [[r.loc.lon, r.loc.lat], [x.h.lon, x.h.lat]] },
        properties: { col: routeColor(kind), cas: both ? cssVar('--nicu') : App.C.surface, both, on, op: g ? (dim ? 0.25 : 0.9) : (dim ? 0.12 : 0.35) } });
    };
    // Draw the dimmer routes first so the hovered one sits on top
    const list = [...r.top.map((x) => [x, 'ld']), ...(r.nicu ? [[r.nicu, 'nicu']] : []), ...(r.high ? [[r.high, 'high']] : [])]
      .filter(([x], i, a) => a.findIndex(([y]) => y.h.ccn === x.h.ccn) === i);
    list.sort(([a], [b]) => (a.h.ccn === st.hover) - (b.h.ccn === st.hover)).forEach(([x, k]) => add(x, k));
    V.map.getSource('mt-routes').setData({ type: 'FeatureCollection', features: feats });
  }

  function highlight(ccn) {
    st.hover = ccn;
    ui.results.querySelectorAll('.mat-hosp').forEach((li) => li.classList.toggle('on', li.dataset.ccn === ccn));
    each(() => {
      V.markers.forEach((m) => m.getElement().classList.toggle('on', !!ccn && m.getElement().dataset.ccn === ccn));
      drawRoutes();
    });
  }

  // From a result card: bring the hospital into view and open its card on the map
  function focusHospital(ccn) {
    const h = st.byCcn.get(ccn);
    if (!h || !V.map) return;
    const c = covered();
    V.map.easeTo({ center: [h.lon, h.lat], zoom: Math.max(V.map.getZoom(), 11), offset: [Math.round(c.left / 2), Math.round((c.top - c.bottom) / 2)], duration: App.reduceMotion ? 0 : 900, easing: kit().ease });
    hospitalPopup(ccn);
  }

  // From the map (a pin or a hospital dot): open its card where it is, without moving the map. The matching result
  // scrolls into view in the floating card too, while the results are open.
  function pickHospital(ccn) {
    hospitalPopup(ccn);
    keepPopupClear();
    const li = ui.results.querySelector(`.mat-hosp[data-ccn="${ccn}"]`);
    if (!li || st.resFolded || !overlaying()) return;
    const body = ui.results, r = li.getBoundingClientRect(), b = body.getBoundingClientRect();
    if (r.top < b.top || r.bottom > b.bottom) body.scrollTo({ top: body.scrollTop + r.top - b.top - 16, behavior: App.reduceMotion ? 'auto' : 'smooth' });
  }

  // Clicks on a pin, the "you" dot or an open popup belong to them, not to the map underneath
  const onMarker = (e) => { const t = e.originalEvent && e.originalEvent.target; return !!(t && t.closest && t.closest('.maplibregl-marker, .maplibregl-popup')); };

  // A hospital's card on the map: what it offers, the drive from your search, directions and its phone number
  function hospitalPopup(ccn) {
    const h = st.byCcn.get(ccn);
    if (!h || !V.map) return;
    const r = st.res;
    let x = r && [...r.ld, ...r.ni, ...r.hi].find((y) => y.h.ccn === ccn);
    if (r && !x) { const crow = kit().miles(r.loc, h); x = { h, min: estMinutes(crow), miles: crow * st.meta.estimate.roadFactor, routed: false }; }
    const n = nicuText(h);
    const what = h.gone ? 'Stopped delivering babies' : h.d ? 'Delivers babies' : 'Does not deliver babies';
    const tags = [];
    if (h.bf) tags.push('<span class="mat-badge good">Birthing‑Friendly</span>');
    if (n && h.nicu) tags.push(`<span class="mat-badge nicu">${esc(n.label)}</span>`);
    if (h.er === 0) tags.push('<span class="mat-badge muted">No emergency department</span>');
    const time = x ? `<div class="mat-pop-time"><b>${x.routed ? '' : 'About '}${fmtMin(x.min)}</b> ${x.routed ? 'by road' : 'estimated'} · ${fmtMi(x.miles)}<span class="mat-pop-from">from ${esc(r.loc.label)}</span></div>` : '';
    const el = document.createElement('div');
    el.className = 'mat-pop';
    el.innerHTML = `<div class="mat-pop-name">${esc(h.title)}</div>
      <div class="mat-pop-sub">${esc(titleCase(h.city))}, ${esc(h.st)} · ${what}</div>${time}
      ${tags.length ? `<div class="mat-badges">${tags.join('')}</div>` : ''}
      <div class="mat-actions"><a href="${directions(h)}" target="_blank" rel="noopener noreferrer">Directions in Google Maps</a>${h.phone ? `<a href="tel:${esc(h.phone.replace(/[^\d+]/g, ''))}">Call ${esc(h.phone)}</a>` : ''}</div>`;
    V.tip.remove();
    // A result's pin stands above the hospital, so its card opens clear of the pin
    const pinned = V.markers.some((m) => m.getElement().dataset.ccn === ccn);
    V.spot.setOffset(pinned ? 34 : 10).setMaxWidth('300px').setLngLat([h.lon, h.lat]).setDOMContent(el).addTo(V.map);
    // While its card is open, a result keeps its route and list entry highlighted
    if (r && [...r.top, r.nicu, r.high].some((y) => y && y.h.ccn === ccn)) { st.popCcn = ccn; highlight(ccn); }
  }

  // The "you" dot: where the drive times are measured from, with a way to clear the search
  function mePopup() {
    if (!st.res || !V.map) return;
    const label = st.res.loc.label;
    const el = document.createElement('div');
    el.className = 'mat-pop';
    el.innerHTML = `<div class="mat-pop-name">${esc(label.charAt(0).toUpperCase() + label.slice(1))}</div>
      <div class="mat-pop-sub">Drive times on this map are measured from here.</div>
      <button type="button" class="mat-spot-go">Clear search</button>`;
    el.querySelector('.mat-spot-go').addEventListener('click', clearSearch);
    V.spot.setOffset(14).setMaxWidth('260px').setLngLat([st.res.loc.lon, st.res.loc.lat]).setDOMContent(el).addTo(V.map);
    keepPopupClear();
  }

  // A card that would open under the side panel (or the phone sheet) slides the map just enough to show it whole
  function keepPopupClear() {
    if (!V.map || !V.spot || !V.spot.isOpen() || !overlaying()) return;
    const p = V.spot.getElement().getBoundingClientRect(), s = sideBox(), pad = 12;
    if (p.right <= s.left - pad || p.left >= s.right + pad || p.bottom <= s.top - pad || p.top >= s.bottom + pad) return;
    let dx = 0, dy = 0;
    if (isSheet()) dy = (s.top - pad) - p.bottom;
    else {
      // Beside the card, or below it when the card is just the search box and that is the shorter move
      const right = s.right + pad - p.left, down = s.bottom + pad - p.top;
      if (covered().top && down < right) dy = down;
      else dx = right;
    }
    V.map.panBy([-Math.round(dx), -Math.round(dy)], { duration: App.reduceMotion ? 0 : 450, easing: kit().ease });
  }
  const whenSettled = (fn) => { if (V.map.isMoving()) V.map.once('moveend', fn); else fn(); };

  // Back to the start: no search, no routes or pins, and the state in focus framed (the whole country if there isn't one)
  function clearSearch() {
    const searchSt = st.res && st.res.loc.st;
    st.seq++;
    st.gen++;
    st.res = null;
    st.loc = null;
    st.hover = null;
    st.popCcn = null;
    ui.search.value = '';
    closeSuggest();
    say('');
    renderResults();
    each(() => {
      if (!V.map) return;
      V.spot.remove();
      V.tip.remove();
      drawResults(false);
      const code = focusState(searchSt);
      V.userMoved = false;
      fitState(code);
    });
    syncClear();
  }

  // The state in focus: the one you searched in, or, once you've moved the map yourself, the one in the middle of the view
  function focusState(searchSt) {
    const c = covered(), cv = V.canvas;
    const pt = [c.left + (cv.clientWidth - c.left) / 2, c.top + (cv.clientHeight - c.top - c.bottom) / 2];
    const hit = V.map.getLayer('mt-state-hit') && V.map.queryRenderedFeatures(pt, { layers: ['mt-state-hit'] })[0];
    const here = hit && hit.properties.code;
    return V.userMoved ? here || searchSt : searchSt || here;
  }

  // Frame a state's whole outline, clear of the search card; the whole country when there is no state
  function fitState(code) {
    const v = V;
    const fit = (box, maxZoom) => inView(v, () => {
      const c = covered();
      // Keep the state clear of the legend along the bottom edge too
      const bottom = Math.min(V.canvas.clientHeight / 3, V.legend.offsetHeight + 36) + c.bottom;
      V.map.fitBounds(box, { padding: { top: 56 + c.top, bottom, left: 40 + c.left, right: 40 }, maxZoom, duration: App.reduceMotion ? 0 : 1100, easing: kit().ease });
    })();
    if (!code) { fit(US_BOUNDS, 6); return; }
    kit().loadShapes().then((S) => {
      const f = S && S.states.features.find((x) => x.properties.code === code);
      if (!f) { fit(US_BOUNDS, 6); return; }
      let w = 180, so = 90, e = -180, n = -90;
      // Alaska's western Aleutians cross the 180th meridian; leave them out so the frame stays on the mainland
      const walk = (a) => {
        if (typeof a[0] !== 'number') { a.forEach(walk); return; }
        if (code === 'AK' && a[0] > 0) return;
        w = Math.min(w, a[0]); e = Math.max(e, a[0]); so = Math.min(so, a[1]); n = Math.max(n, a[1]);
      };
      walk(f.geometry.coordinates);
      fit([[w, so], [e, n]], 8);
    }, () => fit(US_BOUNDS, 6));
  }

  // The clear button shows only when there is something to clear; the Try examples only while the box is empty
  function syncClear() {
    if (ui.clear) ui.clear.hidden = !(st.res || ui.search.value.trim());
    if (ui.tryEl) ui.tryEl.hidden = !!st.res || !!ui.search.value.trim();
  }

  function renderLegend() {
    // One compact line: what the colour means, the scale, then the marker keys (full wording in tooltips)
    const full = V.mode === 'nicu' ? 'Estimated drive to the nearest NICU' : 'Estimated drive to the nearest hospital that delivers babies';
    const keys = `<span class="mat-legend-keys">
        <span title="Hospital that delivers babies"><i class="mat-k-ld"></i>Delivers</span>
        <span title="Delivers babies and has a NICU"><i class="mat-k-nicu"></i>+ NICU</span>
        <span title="NICU but doesn’t deliver babies: mostly children’s hospitals, which take newborns transferred from delivering hospitals"><i class="mat-k-nicuonly"></i>NICU only</span>
        <span title="Stopped delivering babies"><i class="mat-k-gone"></i>Stopped</span>
      </span>`;
    const what = V.mode === 'nicu' ? 'a NICU' : 'delivery care';
    V.legend.innerHTML = `<span class="mat-legend-title" title="${full}">Far from ${what}</span>
      <span class="mat-legend-far" title="${full}"><i class="mat-k-far30" data-css="background:${d3.color(farInk()).copy({ opacity: 0.16 })}"></i>30–60 min</span>
      <span class="mat-legend-far" title="${full}"><i class="mat-k-far60" data-css="border-color:${d3.color(farInk()).copy({ opacity: 0.38 })};background:repeating-linear-gradient(135deg,${d3.color(farInk()).copy({ opacity: 0.4 })} 0 1px,${d3.color(farInk()).copy({ opacity: 0.1 })} 1px 4px)"></i>over 1 hour</span>${keys}`;
    App.applyCss(V.legend);
    syncSideBox(V);
  }

  function renderHero() {
    const M = st.meta, W = M.women;
    const mil = (W['30'] / 1e6).toFixed(1);
    const oneIn = Math.round(W.all / W['30']);
    document.getElementById('matHeadline').innerHTML = `${mil} million women of childbearing age live more than half an hour from a hospital that delivers babies.`;
    document.getElementById('matLede').innerHTML = `That is about <b>1 in ${oneIn}</b> women aged 15–44 in the U.S., and <b>${App.f0(Math.round(W['60'] / 1000))},000</b> live more than an hour away. If you are expecting, enter where you live to see the nearest labor and delivery care and newborn intensive care unit, the usual drive time and directions.`;
    const tries = ['Bemidji, MN', 'Grand Marais, MN', 'Woodbury, MN', 'Casper, WY', 'Miles City, MT'];
    ui.tryEl.innerHTML = `Try: ${tries.map((t) => `<button type="button" class="chip" data-q="${esc(t)}">${esc(t)}</button>`).join('')}`;
    ui.tryEl.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => {
      ui.search.value = b.dataset.q;
      kit().loadPlaces().then(() => { const hit = kit().suggest(b.dataset.q).find((s) => s.kind === 'place'); if (hit) choose(hit); });
    }));
  }

  // ---------- Full screen ----------
  // The map and its panel grow out of the page into the full window (an in-page overlay, like the hospital map) and
  // shrink back into place on exit. A spacer holds their place in the page meanwhile.
  function morph(rect, opening) {
    const W = innerWidth, H = innerHeight;
    const dx = rect.left + rect.width / 2 - W / 2, dy = rect.top + rect.height / 2 - H / 2;
    const ix = Math.max(0, (W - rect.width) / 2), iy = Math.max(0, (H - rect.height) / 2);
    const small = { transform: `translate(${dx}px, ${dy}px)`, clipPath: `inset(${iy}px ${ix}px ${iy}px ${ix}px round 4px)` };
    const big = { transform: 'translate(0px, 0px)', clipPath: 'inset(0px 0px 0px 0px round 0px)' };
    return V.wrap.animate(opening ? [small, big] : [big, small], { duration: kit().duration, easing: kit().easeCss, fill: opening ? 'none' : 'forwards' }).finished;
  }

  const isSheet = () => window.matchMedia('(max-width: 720px)').matches;
  const overlaying = () => getComputedStyle(V.side).position === 'absolute';
  // Where the card sits over the map at its settled size (not part way through growing or shrinking)
  function sideBox() {
    const r = V.side.getBoundingClientRect(), h = V.sideH || r.height;
    return isSheet() ? { left: r.left, right: r.right, top: r.bottom - h, bottom: r.bottom } : { left: r.left, right: r.right, top: r.top, bottom: r.top + h };
  }
  // How much of the map the card covers, so the camera keeps results in the open part: a tall card (results open)
  // covers the left side, a short one (just the search) the top, and the phone sheet the bottom
  function covered() {
    if (!overlaying()) return { left: 0, top: 0, bottom: 0 };
    const cv = V.canvas.getBoundingClientRect(), s = sideBox();
    if (isSheet()) return { left: 0, top: 0, bottom: Math.max(0, cv.bottom - s.top) };
    if (s.bottom - cv.top > cv.height / 2) return { left: Math.max(0, s.right - cv.left), top: 0, bottom: 0 };
    return { left: 0, top: Math.max(0, s.bottom - cv.top), bottom: 0 };
  }

  function enterFull() {
    if (V.full || V.morphing || fullView()) return;
    const from = V.wrap.getBoundingClientRect();
    V.spacer.style.height = `${from.height}px`;
    V.wrap.before(V.spacer);
    V.full = true;
    closeSuggest();
    V.wrap.classList.add('is-full');
    V.wrap.setAttribute('role', 'dialog');
    V.wrap.setAttribute('aria-modal', 'true');
    V.wrap.setAttribute('aria-label', 'Maternity care map, full screen');
    document.documentElement.classList.add('mat-full-open');
    V.fullBtn.setAttribute('aria-label', 'Exit full screen');
    V.fullBtn.title = 'Exit full screen (Esc)';
    renderResults();
    if (V.map) V.map.resize();
    if (!App.reduceMotion) V.morphing = morph(from, true).catch(() => {}).then(() => { V.morphing = null; });
    if (st.res && V.map) fitResults();
    if (V.map) whenSettled(keepPopupClear);
    // Focus the search box only when there are no results yet, so it doesn't reopen the last search's suggestions
    if (!st.res) ui.search.focus({ preventScroll: true });
  }

  function exitFull(animate = true) {
    if (!V.full) return Promise.resolve();
    const restore = () => {
      V.wrap.getAnimations().forEach((a) => a.cancel());
      V.wrap.classList.remove('is-full');
      ['role', 'aria-modal', 'aria-label'].forEach((a) => V.wrap.removeAttribute(a));
      document.documentElement.classList.remove('mat-full-open');
      V.spacer.remove();
      V.full = false;
      V.morphing = null;
      V.fullBtn.setAttribute('aria-label', 'Full screen map');
      V.fullBtn.title = 'Full screen';
      renderResults();
      if (V.map) { V.map.resize(); if (st.res) fitResults(); whenSettled(keepPopupClear); }
    };
    if (!animate || App.reduceMotion || V.morphing) { restore(); return Promise.resolve(); }
    V.morphing = morph(V.spacer.getBoundingClientRect(), false).catch(() => {}).then(restore);
    return V.morphing;
  }

  // ---------- Copilot ----------
  const names = (a) => (a.length < 3 ? a.join(' and ') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
  function copilotLine(cp) {
    const zones = (cp.zones || []).map((z) => z.name.split(',')[0]);
    const out = (cp.left_out || []).map((x) => titleCase(x.name));
    return `From Copilot’s answer${zones.length ? `, keeping out of ${names(zones)}` : ''}.${out.length ? ` Left out: ${names(out)}.` : ''}`;
  }

  // A Copilot answer (copilot/tools.py nearest_care) shown as a search on this map: its start, the hospitals it ranked
  // with their drive times and routes, and the places it kept out of. A new search or Clear replaces it.
  function showCare(p) {
    if (!kit() || !p || !p.results) return Promise.resolve(false);
    if (!st.shown) show();
    return load().then(() => {
      if (!st.byCcn) st.byCcn = new Map(st.hosp.map((h) => [h.ccn, h]));
      const item = (x) => { const h = st.byCcn.get(x.ccn); return h ? { h, crow: x.straight_miles, min: x.minutes, miles: x.miles, routed: !!x.routed } : null; };
      const top = p.results.filter((x) => x.role === 'top').map(item).filter(Boolean);
      if (!top.length) return false;
      const own = (role) => p.results.filter((x) => x.role === role).map(item).filter(Boolean)[0] || null;
      const nicu = own('nicu') || top.find((x) => x.h.nicu > 0) || null;
      let high = own('high') || top.find((x) => isHighNicu(x.h)) || null;
      if (high && nicu && high.h.ccn === nicu.h.ccn) high = null;
      const routes = {};
      p.results.forEach((x) => { if (x.line && x.line.length > 1) routes[x.ccn] = { type: 'LineString', coordinates: x.line.map(([la, lo]) => [lo, la]) }; });
      const o = p.origin, near = kit().nearestPlaceTo(o.lat, o.lon);
      const loc = { lat: o.lat, lon: o.lon, label: o.label || 'this spot', st: near && near.st, source: o.source === 'coordinates' ? 'map' : 'copilot' };
      st.seq++;
      st.gen++;
      views.forEach((v) => { v.userMoved = false; if (v.spot) v.spot.remove(); });
      st.loc = loc;
      st.res = { loc, ld: top, ni: nicu ? [nicu] : [], hi: high ? [high] : [], routed: true, failed: false, routes, top, nicu, high,
        copilot: { zones: p.zones || [], left_out: p.left_out || [], title: p.title || '' } };
      st.popCcn = null;
      st.hover = null;
      st.resFolded = false;
      ui.search.value = loc.label.charAt(0).toUpperCase() + loc.label.slice(1);
      closeSuggest();
      say('');
      renderResults();
      ui.results.scrollTop = 0;
      each(() => drawResults(true));
      return true;
    });
  }

  // What the map shows now, for Copilot: the search, its hospitals and drive times, and the card open on the map
  function describe() {
    if (!st.shown || !st.data) return null;
    const r = st.res, mode = (views[0] && views[0].mode) === 'nicu' ? 'drive time to a NICU' : 'drive time to delivery care';
    if (!r || !r.top || !r.top.length) return { text: `Maternity care map (section 04): no search yet; the shading shows the estimated ${mode}.` };
    const fmt = (x) => {
      const n = x.h.nicu > 0 ? nicuText(x.h) : null;
      return `${x.h.title} (${titleCase(x.h.city)}, ${x.h.st}; CCN ${x.h.ccn}${n ? `; ${n.label}` : ''}${x.h.phone ? `; ${x.h.phone}` : ''}): ${x.routed ? '' : 'about '}${fmtMin(x.min)}, ${fmtMi(x.miles)}${x.routed ? ' by road' : ' (estimated)'}`;
    };
    const from = { map: 'a point clicked on the map', gps: 'the reader’s location', zip: 'a ZIP code', place: 'a town', address: 'an address', copilot: 'Copilot’s last answer' }[r.loc.source] || r.loc.source;
    const lines = [`Maternity care map (section 04): a search from ${r.loc.label} (lat ${r.loc.lat.toFixed(4)}, lon ${r.loc.lon.toFixed(4)}; ${from}). The shading shows the estimated ${mode}.`,
      `Closest hospitals that deliver babies, ranked by drive time: ${r.top.map((x, i) => `${i + 1}. ${fmt(x)}`).join('; ')}.`];
    const inTop = (x) => r.top.some((y) => y.h.ccn === x.h.ccn);
    if (r.nicu && !inTop(r.nicu)) lines.push(`Nearest NICU: ${fmt(r.nicu)}.`);
    if (r.high && !inTop(r.high)) lines.push(`Nearest Level III or IV NICU: ${fmt(r.high)}.`);
    lines.push('The map draws the road route from the start to each of these hospitals.');
    if (r.copilot) lines.push(copilotLine(r.copilot));
    if (st.popCcn && st.byCcn.get(st.popCcn)) lines.push(`Open on the map: ${st.byCcn.get(st.popCcn).title}.`);
    const towns = r.top.map((x) => titleCase(x.h.city));
    const common = towns.find((t, i) => towns.indexOf(t) !== i) || towns[0];
    const place = r.loc.source === 'map' ? 'this spot' : r.loc.label;
    const short = (x) => x.h.title.replace(/^M Health Fairview /, '').replace(/ (Hospital|Medical Center)$/i, '');
    const suggest = [
      `What are my options if I can’t go into ${common}?`,
      `Which other hospitals that deliver babies are within an hour of ${place}?`,
      `Compare ${names(r.top.map(short))} on safety and patient experience`,
    ];
    if (r.top.some((x) => x.h.level) || r.high) suggest.push('Which of these has the highest-level NICU, and how far is it?');
    const subject = { title: `Drive times from ${r.loc.label}`, detail: r.top.map((x, i) => `${i + 1} ${short(x)} ${fmtMin(x.min)}`).join(' · ') };
    return { text: lines.join('\n'), suggest, subject };
  }

  // ---------- Lifecycle ----------
  function show() {
    st.shown = true;
    if (!kit()) return;
    say(st.data ? '' : 'Loading maternity data…');
    load().then(() => {
      say('');
      st.byCcn = new Map(st.hosp.map((h) => [h.ccn, h]));
      renderHero();
      renderResults();
      each(() => { renderModeChips(); renderLegend(); });
      kit().loadShapes().catch(() => {});
      kit().loadPlaces().catch(() => {});
      return Promise.all([inView(views[0], showMap)(), loadRasters()]);
    }).then(() => each(() => addRasterLayers()))
      .catch(() => say('The maternity data could not be loaded.', true));
  }

  function render() {
    if (!st.shown || !st.data || ui.view.hidden) return;
    each(() => { renderLegend(); renderModeChips(); });
    renderResults();
    each(() => {
      if (V.map && V.styleId !== kit().styleId()) showMap();
      else addRasterLayers();
    });
  }

  function init() {
    ['matSearch', 'matSuggest', 'matForm', 'matLocate', 'matStatus', 'matResults', 'matTry', 'matResBar', 'matResSum', 'matResAct', 'view-quality'].forEach((id) => (ui[id] = document.getElementById(id)));
    ui.clear = document.getElementById('matClear');
    Object.assign(ui, { search: ui.matSearch, suggest: ui.matSuggest, form: ui.matForm, locateBtn: ui.matLocate, status: ui.matStatus,
      results: ui.matResults, tryEl: ui.matTry, resBar: ui.matResBar, resSum: ui.matResSum, resAct: ui.matResAct, view: ui['view-quality'] });
    if (!ui.form) return;
    const makeView = (sfx, kind) => {
      const g = (id) => document.getElementById(id + sfx);
      if (!g('matCanvas')) return null;
      return {
        kind, map: null, styleId: '', styleReady: false, markers: [], me: null, tip: null, spot: null, mode: 'ld', userMoved: false,
        full: false, morphing: null, canvases: {}, fittedSeq: 0, sideH: 0, sizeTok: 0,
        canvas: g('matCanvas'), legend: g('matLegend'), modeEl: g('matMode'), styleSel: g('matStyle'), wrap: g('matWrap'), card: g('matCard'), fullBtn: g('matFullBtn'),
        side: g('matSide'), spacer: Object.assign(document.createElement('div'), { className: 'mat-spacer' }),
      };
    };
    [makeView('', 'surface')].filter(Boolean).forEach((v) => views.push(v));
    V = views[0];
    // Modern, Streets or Minimal: the same basemap choice as the hospital map (remembered on this device)
    const syncStyle = () => views.forEach((v) => { if (v.styleSel) v.styleSel.value = kit().getStyle(); });
    views.forEach((v) => {
      if (!v.styleSel) return;
      v.styleSel.innerHTML = Object.entries(kit().styles).map(([k, x]) => `<option value="${k}">${esc(x.label)}</option>`).join('');
      v.styleSel.addEventListener('change', () => kit().setStyle(v.styleSel.value));
    });
    syncStyle();
    kit().onStyle(() => {
      syncStyle();
      each(() => { if (V.map) showMap(); });
    });
    views.forEach((v) => {
      v.fullBtn.addEventListener('click', inView(v, () => (V.full ? exitFull() : enterFull())));
      if (window.ResizeObserver) { const ro = new ResizeObserver(() => syncSideBox(v)); ro.observe(v.side); ro.observe(v.wrap); }
    });
    ui.resBar.addEventListener('click', () => foldResults(!st.resFolded));
    document.addEventListener('keydown', (e) => { const v = fullView(); if (e.key === 'Escape' && v && !st.sug.length) inView(v, exitFull)(); });
    window.addEventListener('hashchange', () => { const v = fullView(); if (v && !/^#(maternity|mat-)/.test(location.hash)) inView(v, exitFull)(false); });
    ui.form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
    ui.locateBtn.addEventListener('click', locate);
    ui.clear.addEventListener('click', () => { clearSearch(); ui.search.focus({ preventScroll: true }); });
    ui.search.addEventListener('input', updateSuggest);
    ui.search.addEventListener('input', () => sizeSide(syncClear));
    ui.search.addEventListener('focus', () => { clearTimeout(st.blurTimer); kit().loadPlaces().catch(() => {}); if (ui.search.value.trim()) updateSuggest(); });
    ui.search.addEventListener('blur', () => { st.blurTimer = setTimeout(closeSuggest, 120); });
    ui.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && st.sug.length) { e.preventDefault(); closeSuggest(); return; }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && st.sug.length) {
        e.preventDefault();
        st.sugActive = (st.sugActive + (e.key === 'ArrowDown' ? 1 : -1) + st.sug.length) % st.sug.length;
        renderSuggest();
      }
    });
    ui.suggest.addEventListener('mousedown', (e) => e.preventDefault());
    ui.suggest.addEventListener('click', (e) => { const li = e.target.closest('[data-i]'); if (li && st.sug[+li.dataset.i]) choose(st.sug[+li.dataset.i]); });
  }

  init();
  // The map and its data (about 2 MB) load once section 04 comes near the screen, or straight away if you land on it
  (function lazyStart() {
    const sec = document.getElementById('maternity');
    if (!sec) return;
    if (!('IntersectionObserver' in window)) { show(); return; }
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting) || st.shown) return;
      io.disconnect();
      show();
    }, { rootMargin: '1200px 0px' });
    io.observe(sec);
  })();
  App.maternity = { show, render, showCare, describe, card: () => document.getElementById('matCard') };
  App.register('maternity', render);
})();
