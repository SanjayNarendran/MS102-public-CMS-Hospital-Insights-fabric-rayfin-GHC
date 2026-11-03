/* Core: data decoding, shared helpers, palette, tooltip, narrative facts */
(function () {
  'use strict';
  const D = window.CMS_DATA;
  const App = (window.App = { charts: [] });

  App.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  App.state = { focus: '', flagsInf: 'clabsi', funnelInf: 'clabsi', funnelQuery: '', mapMetric: 'clabsi' };

  App.STATE_NAMES = {AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',DC:'District of Columbia',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',PR:'Puerto Rico',VI:'U.S. Virgin Islands',GU:'Guam',AS:'American Samoa',MP:'Northern Mariana Islands'};

  // Formatting
  App.f2 = d3.format('.2f');
  App.f1 = d3.format('.1f');
  App.f0 = d3.format(',');
  App.pct0 = d3.format('.0%');
  App.pct1 = d3.format('.1%');
  App.signPct = (v) => (v > 0.0005 ? '+' : v < -0.0005 ? '−' : '') + d3.format('.0%')(Math.abs(v));
  App.signNum = (v, p = 1) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(p);

  // Palette pulled from CSS custom properties so charts follow the active theme
  App.readColors = function () {
    const s = getComputedStyle(document.documentElement);
    const g = (n) => s.getPropertyValue(n).trim();
    App.C = {
      bg: g('--bg'), surface: g('--surface'), surface2: g('--surface-2'), surface3: g('--surface-3'),
      text: g('--text'), text2: g('--text-2'), muted: g('--muted'), faint: g('--faint'),
      border: g('--border'), borderStrong: g('--border-strong'), grid: g('--grid'),
      accent: g('--accent'), good: g('--good'), bad: g('--bad'), neutral: g('--neutral'), neutralMid: g('--neutral-mid'),
      olive: g('--olive'), kraft: g('--kraft'), sky: g('--sky'), fig: g('--fig'),
    };
    return App.C;
  };
  App.isDark = () => document.documentElement.dataset.theme === 'dark';
  // Star ratings (1 to 5): orange for the low ratings, blue for the high, each fading toward neutral as it nears 3 stars,
  // so the strength of the colour reads as how far a rating is from the middle. Every star chart uses these.
  App.starColors = function () {
    const C = App.C, mid = C.neutralMid;
    return [C.bad, d3.interpolateRgb(C.bad, mid)(0.55), mid, d3.interpolateRgb(C.good, mid)(0.55), C.good];
  };
  App.inkOn = (fill) => (d3.lab(fill).l > 60 ? '#141413' : '#FAF9F5');
  App.diverging = function (lo, mid, hi, goodLow) {
    const C = App.C;
    const cols = goodLow ? [C.good, C.neutralMid, C.bad] : [C.bad, C.neutralMid, C.good];
    return d3.scaleDiverging([lo, mid, hi], d3.interpolateRgbBasis(cols)).clamp(true);
  };

  // Infections & national trends
  // Display labels read as plain phrases: "Surgical site infection, colon surgery" rather than a dash-joined fragment
  App.INF = D.infections.map((d) => Object.assign({}, d, { label: d.label.replace(/\s+—\s+/g, ', ') }));
  App.INFK = App.INF.map((d) => d.key);
  App.infByKey = Object.fromEntries(App.INF.map((d) => [d.key, d]));
  App.T = D.haiTrend;
  App.first = App.T[0];
  App.last = App.T[App.T.length - 1];
  App.sirSeries = (k) => App.T.map((d) => ({ year: d.year, v: d[k].sir }));
  App.H = D.hcahpsTrend;
  App.P = D.psiTrend;
  App.S = D.states;
  App.meta = D.meta;
  App.extractedDate = () => new Date(App.meta.extracted.length === 10 ? App.meta.extracted + 'T00:00:00' : App.meta.extracted);

  // Facilities: decode compact rows and classify each SIR by its 95% CI vs 1.0
  App.facilities = D.facilities.map((r) => {
    const o = {};
    D.facilityFields.forEach((k, i) => (o[k] = r[i]));
    o.hai = 0; o.flagsWorse = 0; o.flagsBetter = 0;
    App.INFK.forEach((k) => {
      const a = o[k];
      if (!a) return;
      const [sir, pred, obs, lo, hi] = a;
      const cls = lo != null && lo > 1 ? 'worse' : hi != null && hi < 1 ? 'better' : 'similar';
      o[k] = { sir, pred, obs, lo, hi, cls };
      o.hai++;
      if (cls === 'worse') o.flagsWorse++;
      if (cls === 'better') o.flagsBetter++;
    });
    o.leader = o.star === 5 && o.psi90 != null && o.psi90 < 1 && o.hai > 0 && o.flagsWorse === 0;
    o._search = `${o.name} ${o.city} ${o.st} ${o.id}`.toLowerCase();
    return o;
  });
  App.CLS_LABEL = { better: 'Better than benchmark', similar: 'No different', worse: 'Worse than benchmark' };

  // Tooltip
  const tipEl = document.getElementById('tooltip');
  App.tip = {
    show(html, ev) { tipEl.innerHTML = html; tipEl.classList.add('on'); this.move(ev); },
    move(ev) {
      const pad = 14, r = tipEl.getBoundingClientRect();
      let x = ev.clientX + pad, y = ev.clientY + pad;
      if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - pad;
      if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - pad;
      tipEl.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
    },
    hide() { tipEl.classList.remove('on'); },
  };
  App.tipRows = (rows) => '<table>' + rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('') + '</table>';
  App.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // Chart scaffolding
  App.makeSvg = function (el, height, label, minW = 260) {
    const w = Math.max(minW, Math.floor(el.clientWidth));
    d3.select(el).selectAll('*').remove();
    const svg = d3.select(el).append('svg').attr('width', w).attr('height', height).attr('viewBox', `0 0 ${w} ${height}`).attr('role', 'img').attr('aria-label', label);
    return [svg, w];
  };
  App.chips = function (el, items, value, onChange) {
    el.innerHTML = '';
    items.forEach((it) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (it.value === value ? ' on' : '');
      b.setAttribute('aria-pressed', String(it.value === value));
      b.textContent = it.label;
      b.addEventListener('click', () => onChange(it.value));
      el.appendChild(b);
    });
  };
  App.register = (name, fn) => App.charts.push({ name, fn });
  // Ruled term/value rows beside a hero headline; values may contain trusted markup built from the data files
  App.heroFacts = function (el, rows) {
    if (!el) return;
    el.innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  };
  // Apply data-css declarations through the CSSOM so generated markup needs no inline style attributes (strict-CSP safe)
  App.applyCss = function (root) {
    root.querySelectorAll('[data-css]').forEach((n) => {
      n.getAttribute('data-css').split(';').forEach((decl) => {
        const i = decl.indexOf(':');
        if (i > 0) n.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
      });
      n.removeAttribute('data-css');
    });
  };

  // Narrative facts derived from the data so text stays in sync with refreshed extracts
  App.computeFacts = function () {
    const { T, first, last, H, P, facilities } = App;
    const F = {};
    const peakOf = (k) => d3.greatest(T, (d) => d[k].sir);
    const cl = peakOf('clabsi');
    F.clabsiNow = App.f2(last.clabsi.sir);
    F.clabsiPeak = App.f2(cl.clabsi.sir);
    F.clabsiPeakYear = String(cl.year);
    F.clabsiPeakDrop = App.pct0(1 - last.clabsi.sir / cl.clabsi.sir);
    const mr = peakOf('mrsa');
    F.mrsaPeak = App.f2(mr.mrsa.sir);
    F.mrsaPeakYear = String(mr.year);
    F.cdiffDrop = App.pct0(1 - last.cdiff.sir / first.cdiff.sir);
    F.hystNow = App.f2(last.ssi_hyst.sir);
    F.hystRise = App.pct0(last.ssi_hyst.sir / first.ssi_hyst.sir - 1);
    const worse = T.map((d) => ({ year: d.year, v: d3.sum(App.INFK, (k) => d[k].worse) }));
    const wp = d3.greatest(worse, (d) => d.v);
    F.worseSeries = worse;
    F.worseNow = App.f0(worse[worse.length - 1].v);
    F.worsePeak = App.f0(wp.v);
    F.worsePeakYear = String(wp.year);
    F.nHai = App.f0(facilities.filter((f) => f.hai > 0).length);
    F.nFac = App.f0(facilities.length);
    const hLow = d3.least(H, (d) => d.avgstar);
    F.starLow = App.f2(hLow.avgstar);
    F.starLowYear = String(hLow.year);
    F.starNow = App.f2(H[H.length - 1].avgstar);
    F.star19 = App.f2(H[0].avgstar);
    const dims = ['clean', 'nurse', 'doctor', 'staff', 'meds', 'discharge', 'transition', 'overall', 'quiet', 'recommend'];
    const hl = H[H.length - 1];
    const comparable = dims.filter((k) => hl[k] != null && H[0][k] != null);
    F.dimsBelow = `${comparable.filter((k) => hl[k] < H[0][k]).length} of ${comparable.length}`;
    F.medsDelta = App.signNum(hl.meds - H[0].meds, 1);
    const pl = P[P.length - 1], p0 = P[0];
    F.respChg = App.signPct(pl.resp / p0.resp - 1);
    F.dehiscChg = App.signPct(pl.dehisc / p0.dehisc - 1);
    const byStar = d3.rollup(facilities.filter((f) => f.star && f.hai > 0), (v) => ({ n: v.length, worse: v.filter((f) => f.flagsWorse > 0).length }), (f) => f.star);
    F.n5hai = App.f0(byStar.get(5)?.n || 0);
    F.star1Worse = App.pct0((byStar.get(1)?.worse || 0) / (byStar.get(1)?.n || 1));
    const medPred = (s) => d3.median(facilities.filter((f) => f.star === s && f.cdiff), (f) => f.cdiff.pred);
    F.pred5 = App.f1(medPred(5) || 0);
    F.pred3 = App.f1(medPred(3) || 0);
    F.leaders = `${App.f0(facilities.filter((f) => f.leader).length)} hospitals`;
    const ranked = Object.entries(App.S)
      .filter(([, v]) => v.clabsi != null && (v.clabsi_pred || 0) >= 10)
      .sort((a, b) => a[1].clabsi - b[1].clabsi);
    const best = ranked[0], worst = ranked[ranked.length - 1];
    F.geoSentence = `For central‑line infections, <b>${App.STATE_NAMES[best[0]] || best[0]}</b> posts the lowest pooled SIR (<b>${App.f2(best[1].clabsi)}</b>) and <b>${App.STATE_NAMES[worst[0]] || worst[0]}</b> the highest (<b>${App.f2(worst[1].clabsi)}</b>), ${Math.round(worst[1].clabsi / best[1].clabsi)} times as high.`;
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
    const atLow = ['clabsi', 'cauti', 'cdiff'].every((k) => last[k].sir <= d3.min(T, (d) => d[k].sir));
    const span = `${words[T.length] || T.length} years`;
    F.headline = (atLow ? `Most hospital infections are at their lowest in ${span}.` : `National hospital infection trends over ${span}.`) +
      (last.ssi_hyst.sir > first.ssi_hyst.sir * 1.05 ? ' One surgical infection is rising.' : '');
    App.facts = F;
    return F;
  };
})();
