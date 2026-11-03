/* Outcomes, ED timeliness and Medicare penalties (assets/quality-extra.js, built locally from CMS Care Compare files):
   decoded once and attached to every hospital and state so the existing charts, map and explorer can use them */
(function () {
  'use strict';
  const App = window.App;
  const X = window.CMS_EXTRA;
  App.X = null;
  if (!X) return;

  const F = X.meta.fields;
  const byId = new Map();
  Object.entries(X.hospitals).forEach(([id, row]) => {
    const o = {};
    F.forEach((k, i) => { if (row[i] != null) o[k] = row[i]; });
    if (o.own != null) o.own = X.meta.ownership[o.own];
    if (o.edv != null) o.edv = X.meta.edVolume[o.edv];
    // Group counts are [better, no different, worse]
    ['mortN', 'safeN', 'readmN'].forEach((k) => { if (o[k]) o[k] = { better: o[k][0], same: o[k][1], worse: o[k][2] }; });
    byId.set(id, o);
  });

  App.X = { meta: X.meta, national: X.national, states: X.states, get: (id) => byId.get(id) || null, conditions: X.meta.conditions };
  App.xOf = (f) => (f && byId.get(f.id)) || null;

  // Hospital-level fields used across charts and the explorer
  App.facilities.forEach((f) => {
    const o = byId.get(f.id);
    f.ovr = o && o.ovr != null ? o.ovr : null;
    f.ed = o && o.ed != null ? o.ed : null;
    f.hacCut = o && o.hacCut != null ? o.hacCut : null;
    f.mortWorse = o && o.mortN ? o.mortN.worse : null;
  });
  // State-level summaries for the tile map and rankings
  Object.entries(X.states).forEach(([code, s]) => {
    const S = App.S[code] || (App.S[code] = {});
    S.ovr = s.ovr; S.ovrN = s.rated; S.ed = s.ed; S.edN = s.edN;
  });

  // "07/01/2022" -> "Jul 2022"
  App.xPeriod = (p) => {
    if (!p) return '';
    const fmt = (s) => { const [m, , y] = s.split('/'); return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1]} ${y}`; };
    return `${fmt(p[0])} – ${fmt(p[1])}`;
  };
  App.fmtMin = (m) => (m == null ? '—' : m >= 60 ? `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, '0')} min` : `${Math.round(m)} min`);
})();
