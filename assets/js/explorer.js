/* Chapter 07: hospital explorer table */
(function () {
  'use strict';
  const App = window.App;
  const ex = { q: '', star: 0, leaders: false, sort: 'star', dir: -1, page: 0, size: 15 };

  const COLS = [
    { key: 'name', label: 'Hospital', cls: '' },
    ...(App.X ? [{ key: 'ovr', label: 'CMS ★', cls: 'c', title: 'CMS overall hospital star rating' }] : []),
    { key: 'star', label: 'HCAHPS', cls: 'c' },
    { key: 'recommend', label: 'Recommend', cls: 'r' },
    { key: 'psi90', label: 'PSI‑90', cls: 'r' },
    ...App.INF.map((inf) => ({ key: inf.key, label: inf.short.replace('SSI · ', 'SSI ').replace('Hysterectomy', 'Hyst.'), cls: 'c', inf: true })),
    { key: 'flagsWorse', label: 'Flags', cls: 'c' },
    ...(App.X ? [{ key: 'ed', label: 'ER time', cls: 'r', title: 'Median minutes in the emergency department, arrival to departure' }] : []),
  ];
  const val = (f, k) => (App.infByKey[k] ? (f[k] ? f[k].sir : null) : f[k]);

  function rows() {
    const focus = App.state.focus;
    const q = ex.q.trim().toLowerCase();
    let r = App.facilities.filter((f) => (!focus || f.st === focus) && (!q || f._search.includes(q)) && (!ex.star || f.star === ex.star) && (!ex.leaders || f.leader));
    const k = ex.sort, dir = ex.dir;
    r = r.slice().sort((a, b) => {
      const va = val(a, k), vb = val(b, k);
      if (va == null && vb == null) return a.name.localeCompare(b.name);
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'string') return dir * va.localeCompare(vb);
      if (va !== vb) return dir * (va - vb);
      if (k === 'star') return b.hai - a.hai || a.flagsWorse - b.flagsWorse || (a.psi90 ?? 9) - (b.psi90 ?? 9);
      return a.name.localeCompare(b.name);
    });
    return r;
  }

  function psiCell(v) {
    if (v == null) return '<span class="pill none">—</span>';
    const C = App.C;
    const col = v < 0.9 ? C.good : v > 1.1 ? C.bad : C.muted;
    const pos = Math.max(0, Math.min(100, ((v - 0.6) / 0.8) * 100));
    return `<span class="psi"><span class="tnum" data-css="color:${col};font-weight:600">${App.f2(v)}</span><span class="bullet"><i data-css="left:${pos}%;background:${col}"></i></span></span>`;
  }

  function render() {
    const table = document.getElementById('exTable');
    const thead = table.querySelector('thead');
    thead.innerHTML = '<tr>' + COLS.map((c) => {
      const sort = ex.sort === c.key ? (ex.dir > 0 ? 'ascending' : 'descending') : 'none';
      return `<th class="${c.cls}" aria-sort="${sort}"><button type="button" data-k="${c.key}"${c.title ? ` title="${c.title}"` : ''}>${c.label}</button></th>`;
    }).join('') + '</tr>';
    thead.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.k;
      if (ex.sort === k) ex.dir = -ex.dir;
      else { ex.sort = k; ex.dir = k === 'name' || App.infByKey[k] || k === 'psi90' || k === 'flagsWorse' || k === 'ed' ? 1 : -1; }
      ex.page = 0;
      render();
    }));

    const all = rows();
    const pages = Math.max(1, Math.ceil(all.length / ex.size));
    ex.page = Math.min(ex.page, pages - 1);
    const view = all.slice(ex.page * ex.size, (ex.page + 1) * ex.size);
    const tbody = table.querySelector('tbody');
    if (!view.length) {
      tbody.innerHTML = `<tr><td class="ex-empty" colspan="${COLS.length}">No hospitals match these filters.</td></tr>`;
    } else {
      tbody.innerHTML = view.map((f) => {
        const starCell = (n) => (n ? `<span class="stars" aria-label="${n} stars">${'★'.repeat(n)}<span class="off">${'★'.repeat(5 - n)}</span></span>` : '<span class="pill none">—</span>');
        const stars = starCell(f.star);
        const hai = App.INFK.map((k) => {
          const v = f[k];
          return `<td class="c">${v ? `<span class="pill ${v.cls}" data-id="${f.id}" data-k="${k}">${App.f2(v.sir)}</span>` : '<span class="pill none">—</span>'}</td>`;
        }).join('');
        const flags = f.hai ? (f.flagsWorse ? `<span class="pill worse">${f.flagsWorse}</span>` : '<span class="pill similar">0</span>') : '<span class="pill none">—</span>';
        return `<tr>
          <td><div class="nm">${App.esc(f.name)}${f.leader ? '<span class="leader-tag" title="Five-star patient experience, PSI-90 below 1.0 and no infection worse than benchmark">Leader</span>' : ''}</div><div class="loc">${App.esc(f.city)}, ${f.st} · CCN ${f.id}${f.hacCut ? ' · <span class="hac-tag" title="Medicare cut payments by 1% under the Hospital-Acquired Condition Reduction Program">HAC penalty</span>' : ''}</div></td>
          ${App.X ? `<td class="c">${starCell(f.ovr)}</td>` : ''}
          <td class="c">${stars}</td>
          <td class="r tnum">${f.recommend != null ? f.recommend : '—'}</td>
          <td class="r">${psiCell(f.psi90)}</td>
          ${hai}
          <td class="c">${flags}</td>
          ${App.X ? `<td class="r tnum">${f.ed != null ? `${f.ed}<span class="unit"> min</span>` : '—'}</td>` : ''}
        </tr>`;
      }).join('');
    }
    App.applyCss(tbody);
    const start = all.length ? ex.page * ex.size + 1 : 0;
    document.getElementById('exCount').textContent = `${App.f0(all.length)} hospitals${App.state.focus ? ' in ' + (App.STATE_NAMES[App.state.focus] || App.state.focus) : ''}`;
    document.getElementById('exPage').textContent = `${App.f0(start)}–${App.f0(Math.min(all.length, (ex.page + 1) * ex.size))} of ${App.f0(all.length)}`;
    document.getElementById('exPrev').disabled = ex.page === 0;
    document.getElementById('exNext').disabled = ex.page >= pages - 1;
  }

  function init() {
    const byId = new Map(App.facilities.map((f) => [f.id, f]));
    let t;
    document.getElementById('exSearch').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { ex.q = e.target.value; ex.page = 0; render(); }, 120); });
    document.getElementById('exLeaders').addEventListener('change', (e) => { ex.leaders = e.target.checked; ex.page = 0; render(); });
    document.getElementById('exPrev').addEventListener('click', () => { ex.page = Math.max(0, ex.page - 1); render(); });
    document.getElementById('exNext').addEventListener('click', () => { ex.page += 1; render(); });
    const starChips = () => App.chips(document.getElementById('chips-star'), [{ value: 0, label: 'All' }, 5, 4, 3, 2, 1].map((s) => (typeof s === 'number' ? { value: s, label: '★'.repeat(s) } : s)), ex.star, (v) => { ex.star = v; ex.page = 0; starChips(); render(); });
    starChips();
    const tbody = document.querySelector('#exTable tbody');
    tbody.addEventListener('mousemove', (ev) => {
      const p = ev.target.closest('.pill[data-k]');
      if (!p) { App.tip.hide(); return; }
      const f = byId.get(p.dataset.id), v = f[p.dataset.k], inf = App.infByKey[p.dataset.k];
      App.tip.show(`<div class="tt-title">${inf.label}</div><div class="tt-sub">${App.esc(f.name)}</div>` + App.tipRows([['SIR', App.f2(v.sir)], ['Observed / predicted', `${v.obs} / ${App.f1(v.pred)}`], ['95% CI', `${v.lo != null ? App.f2(v.lo) : '—'} – ${v.hi != null ? App.f2(v.hi) : '—'}`]]) + `<span class="tag ${v.cls}">${App.CLS_LABEL[v.cls]}</span>`, ev);
    });
    tbody.addEventListener('mouseleave', () => App.tip.hide());
  }

  App.explorer = { init, render, reset: () => { ex.page = 0; } };
  App.register('explorer', render);
})();
