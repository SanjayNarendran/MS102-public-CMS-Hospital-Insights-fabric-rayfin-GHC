/* Fig 1 "Explain" panel: lineage, the exact DAX, the numbers behind the chart, and how to validate them */
(function () {
  'use strict';
  const App = window.App;
  // The CMS cross-check only vouches for the exact extract it ran against.
  const RAW_V = window.CMS_VERIFICATION || null;
  const V = RAW_V && RAW_V.dataExtracted === App.meta.extracted ? RAW_V : null;
  const V_STALE = !!RAW_V && !V;
  const esc = (s) => App.esc(s);
  const fInt = d3.format(',');
  const fPred = d3.format(',.3f');
  const f6 = d3.format('.6f');
  const f4 = d3.format('.4f');
  const pct1 = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + d3.format('.1%')(Math.abs(v));
  const TABS = [
    ['method', 'How it’s calculated'],
    ['validate', 'Try this yourself'],
  ];
  const st = { tab: 'method', inf: 'clabsi' };
  let dlg, body, opener;

  const T = () => App.T;
  const firstYear = () => App.T[0].year;
  const lastYear = () => App.T[App.T.length - 1].year;
  const isoDay = (iso) => new Date(iso + 'T00:00:00');
  const monYear = (iso) => d3.timeFormat('%b %Y')(isoDay(iso));
  const period = (y) => {
    const p = (App.meta.haiYearPeriods || {})[y];
    if (!p) return '—';
    return `${monYear(p[0])} – ${monYear(p[1])}${y === 2020 ? '<span class="xp-foot">*</span>' : ''}`;
  };
  const extracted = () => d3.utcFormat('%b %-d, %Y %H:%M UTC')(App.extractedDate());
  // A local build computes the same numbers from data/core/hai.csv (build_core_tables.py) instead of querying a semantic model
  const isLocal = () => App.meta.source === 'local';
  const workspaceName = () => (App.meta.workspace ? `<b>${esc(App.meta.workspace)}</b>` : 'the workspace you published it to');
  const verifiedYear = (y) => (V ? V.years.find((v) => v.year === y) : null);
  const infNum = (k) => App.INFK.indexOf(k) + 1;
  const sirOf = (y, k) => App.T.find((d) => d.year === y)[k].sir;

  function codeBlock(id, text, label) {
    return `<div class="xp-code"><div class="xp-code-bar"><span>${esc(label)}</span><button type="button" class="xp-copy" data-copy="${id}">Copy</button></div>` +
      `<pre id="${id}" tabindex="0"><code>${esc(text)}</code></pre></div>`;
  }

  function infChips() {
    return `<div class="chips xp-chips" role="group" aria-label="Infection">${App.INF.map((d) =>
      `<button type="button" class="chip${d.key === st.inf ? ' on' : ''}" aria-pressed="${d.key === st.inf}" data-inf="${d.key}">${esc(d.short)}</button>`).join('')}</div>`;
  }

  App.fig1ValidationDax = function (k) {
    const inf = App.infByKey[k], c = inf.columns;
    return [
      `// Fig 1 check: ${inf.label} (${inf.short})`,
      'EVALUATE',
      'SUMMARIZECOLUMNS (',
      '    HAI[REPORTYEAR],',
      `    "Observed", SUM ( HAI[${c.obs}] ),`,
      `    "Predicted", SUM ( HAI[${c.pred}] ),`,
      `    "Pooled SIR", DIVIDE ( SUM ( HAI[${c.obs}] ), SUM ( HAI[${c.pred}] ) ),`,
      `    "Hospitals in total", COUNT ( HAI[${c.obs}] ),`,
      `    "Hospitals with published SIR", COUNT ( HAI[${c.sir}] )`,
      ')',
      'ORDER BY HAI[REPORTYEAR]',
    ].join('\n');
  };

  // ---------- Tab 1: how it's calculated ----------
  const section = (id, title, html) => `<section class="xp-sec" aria-labelledby="${id}"><h3 id="${id}">${title}</h3>${html}</section>`;

  function tabMethod() {
    const R = App.FIG1, ly = lastYear(), fy = firstYear();
    const rows2025 = App.INF.map((inf) => {
      const t = App.T[App.T.length - 1][inf.key];
      return `<tr><td>${esc(inf.short)}</td><td class="r"><b>${f4(t.sir)}</b></td><td class="r">${t.avgHospSir != null ? f4(t.avgHospSir) : '—'}</td>` +
        `<td class="r">${fInt(t.reporting ?? 0)}</td><td class="r">${fInt(t.n)}</td><td class="r">${t.reporting ? App.pct0(t.n / t.reporting) : '—'}</td></tr>`;
    }).join('');
    const nYears = App.T.length;
    return `
      <p class="xp-lede">Each line is the <b>national pooled Standardized Infection Ratio (SIR)</b> for one infection:
        <b>every infection hospitals reported, divided by every infection CDC’s risk models predicted for those same hospitals</b>.
        Below 1.0 means fewer infections than predicted from the 2015 national baseline.</p>

      <ol class="xp-flow" aria-label="How the data flows">
        <li><span class="xp-n">1</span><h4>Source</h4><p>CMS Care Compare <i>Healthcare Associated Infections – Hospital</i> (CDC NHSN data). ${isLocal() ? 'Read from CMS’s archived files into <code>data/core/hai.csv</code> by <code>build_core_tables.py</code>' : `Loaded into semantic model <b>${esc(App.meta.model)}</b>, table <code>HAI</code>`}: one row per hospital per report year.</p></li>
        <li><span class="xp-n">2</span><h4>Query</h4><p>${isLocal() ? '<code>refresh_data.py --local</code> sums' : 'One DAX query sums'} observed (<code>HAI_n_NUMERATOR</code>) and predicted (<code>HAI_n_ELIGCASES</code>) cases per infection, grouped by <code>REPORTYEAR</code>. Run on ${esc(extracted())}.</p></li>
        <li><span class="xp-n">3</span><h4>Calculate</h4><p><b>Pooled SIR = Σ observed ÷ Σ predicted.</b> No weighting, filtering, smoothing or imputation. Stored unrounded (6 decimals).</p></li>
        <li><span class="xp-n">4</span><h4>Draw</h4><p>D3 plots one point per report year (${nYears} per panel). Values are rounded to 2 decimals only when displayed.</p></li>
      </ol>

      ${section('xp-h-query', 'The query', querySection())}
      ${section('xp-h-numbers', 'The numbers behind the chart', numbersSection())}

      ${section('xp-h-pooled', 'Why pooled, not an average of hospitals', `
      <p>CMS only publishes a hospital’s SIR when at least 1.0 infection is predicted, so many hospitals have <b>no published SIR</b>, but their observed and
        predicted counts are still in the totals. Averaging published SIRs would drop those hospitals and give a 10‑bed and a 900‑bed hospital equal weight.
        Pooling counts every infection once, which is how NHSN aggregates SIRs for groups of hospitals.</p>
      <div class="xp-table-wrap"><table class="xp-table">
        <caption class="xp-cap">Report year ${ly}: the pooled figure used vs. a simple average, and how many hospitals each includes</caption>
        <thead><tr><th scope="col">Infection</th><th scope="col" class="r">Pooled SIR (used)</th><th scope="col" class="r">Average of hospital SIRs (not used)</th>
          <th scope="col" class="r">Hospitals in pooled total</th><th scope="col" class="r">With a published SIR</th><th scope="col" class="r">Share</th></tr></thead>
        <tbody>${rows2025}</tbody></table></div>`)}

      ${section('xp-h-rules', 'How each part of the chart is drawn', `
      <div class="xp-table-wrap"><table class="xp-table xp-rules"><tbody>
        <tr><th scope="row">Big number (top‑right)</th><td>Pooled SIR for the latest report year (${ly}), rounded to 2 decimals.</td></tr>
        <tr><th scope="row">“±x% vs ’${String(fy).slice(2)}”</th><td>SIR ${ly} ÷ SIR ${fy} − 1, rounded to a whole percent.</td></tr>
        <tr><th scope="row">Line colour</th><td><span class="xp-sw good"></span>Blue if the SIR fell more than ${App.pct0(R.flatBand)} since ${fy}, <span class="xp-sw bad"></span>red if it rose more than ${App.pct0(R.flatBand)}, <span class="xp-sw flat"></span>grey otherwise.</td></tr>
        <tr><th scope="row">“peak x.xx” label</th><td>Shown when the highest year is neither the first nor the last and is more than ${App.pct0(R.peakLift)} above ${fy}.</td></tr>
        <tr><th scope="row">Dashed line at 1.0</th><td>The 2015 national baseline: observed = predicted.</td></tr>
        <tr><th scope="row">Shaded band</th><td>Between report years ${R.covid[0]} and ${R.covid[1]}, the COVID‑19 surge.</td></tr>
        <tr><th scope="row">Vertical scale</th><td>Shared by all six panels (0 to ${App.f2(R.yMax())}), so slopes can be compared directly.</td></tr>
        <tr><th scope="row">Hover label</th><td>The pooled SIR for that report year, 2 decimals, shown in all six panels at once.</td></tr>
      </tbody></table></div>`)}

      ${section('xp-h-caveats', 'Know before you compare', `
      <ul class="xp-list">
        <li><b>Report years are CMS release periods, not calendar years.</b> ${ly} covers ${period(ly)}, so it overlaps ${ly - 1} by nine months. Every report year’s period is listed in the table above.</li>
        <li><b>2020 excludes January–June 2020.</b> CMS dropped those quarters from public reporting under its COVID‑19 exception, so the 2020 point covers Jul–Dec 2019 plus Jul–Dec 2020.</li>
        <li><b>Every year uses the same 2015 baseline,</b> so SIRs are comparable across years even as hospital mix changes.</li>
        <li><b>National means every hospital in the file,</b> including U.S. territories. The state selector at the top of the page does not filter this chart.</li>
      </ul>`)}`;
  }

  function querySection() {
    const q = App.meta.queries || {};
    const m = App.meta;
    const legend = App.INF.map((d, i) => `<b>${i + 1}</b> ${esc(d.short)}`).join(' · ');
    if (isLocal()) {
      return `
      <p>This build was computed by <code>refresh_data.py --local</code> straight from <code>data/core/hai.csv</code>, so no query was sent to a semantic model.
        The script does exactly what the DAX would: for each report year it sums <code>hai_n_numerator</code> (observed) and <code>hai_n_eligcases</code> (predicted)
        for each infection, skipping blanks.</p>
      <dl class="xp-kv">
        <dt>Source table</dt><dd><span class="xp-mono">data/core/hai.csv</span>, built from CMS archive snapshots by <span class="xp-mono">build_core_tables.py</span></dd>
        <dt>Run</dt><dd>${esc(extracted())}</dd>
      </dl>
      <p class="xp-small">To query a semantic model instead, load the same tables with <code>publish_fabric.py --core</code> and run <code>refresh_data.py</code> against it;
        this panel then shows the exact DAX it sent. Infection key: ${legend}</p>`;
    }
    return `
      <p>These are the <b>exact query strings</b> <code>refresh_data.py</code> sent to the semantic model. They are stored in <code>assets/data.js</code> alongside the results,
        so what you see here is what ran, not a retyped copy.</p>
      <dl class="xp-kv">
        <dt>Semantic model</dt><dd><b>${esc(m.model)}</b> · <span class="xp-mono">${esc(m.modelId)}</span></dd>
        <dt>Workspace</dt><dd><b>${esc(m.workspace)}</b> · <span class="xp-mono">${esc(m.workspaceId)}</span></dd>
        <dt>API</dt><dd><span class="xp-mono">POST https://api.powerbi.com/v1.0/myorg/groups/{workspace}/datasets/{model}/executeQueries</span></dd>
        <dt>Run</dt><dd>${esc(extracted())}, signed in with the Azure CLI</dd>
      </dl>

      <h4>Query 1: totals behind every point on this chart</h4>
      ${q.haiTrend ? codeBlock('xp-q1', q.haiTrend, 'DAX · observed & predicted totals by report year') : '<p>Query text not recorded in this extract.</p>'}
      <p class="xp-small"><code>o1</code>…<code>o6</code> Σ observed infections · <code>p1</code>…<code>p6</code> Σ predicted infections · <code>d1</code>…<code>d6</code> Σ exposure (device days, procedures or patient days; extracted but not used here).<br/>
        Infection key: ${legend}</p>

      <h4>The calculation after the query</h4>
      <div class="xp-formulas">
        <div><span class="xp-flabel">Pooled SIR, per infection and year</span><span class="xp-math">SIR = o1 ÷ p1 (CLABSI) … o6 ÷ p6 (C. diff)</span></div>
        <div><span class="xp-flabel">Change shown in each panel</span><span class="xp-math">SIR<sub>${lastYear()}</sub> ÷ SIR<sub>${firstYear()}</sub> − 1</span></div>
      </div>
      <p class="xp-small">Nothing else is applied: no filters, weights, exclusions or smoothing. The six SIRs per year are written to <code>haiTrend</code> in <code>assets/data.js</code> with 6 decimals.</p>

      <details class="xp-more" id="xp-d-q2"><summary>Query 2: hospital counts (used in the table below and in Fig 3)</summary>
        <p class="xp-small"><code>n1</code>… hospitals with a published SIR · <code>c1</code>… hospitals contributing to the totals · <code>a1</code>… simple average of hospital SIRs (comparison only) · <code>b1</code>…/<code>w1</code>… hospitals flagged better/worse (Fig 3).</p>
        ${q.haiCounts ? codeBlock('xp-q2', q.haiCounts, 'DAX · hospital counts by report year') : ''}
      </details>
      <details class="xp-more" id="xp-d-q3"><summary>Query 3: data period of each report year</summary>
        ${q.haiPeriods ? codeBlock('xp-q3', q.haiPeriods, 'DAX · earliest start and latest end date per report year') : ''}
      </details>`;
  }

  function dataRows(k) {
    const base = App.T[0][k].sir;
    return App.T.map((d) => {
      const t = d[k];
      const vy = verifiedYear(d.year);
      const vi = vy && vy.infections ? vy.infections[k] : null;
      const check = vi ? (vi.match ? '<span class="xp-ok" title="Matches the CMS archived file">Match</span>' : '<span class="xp-bad">Differs</span>') : '—';
      return { d, t, check, chg: d.year === App.T[0].year ? null : t.sir / base - 1 };
    });
  }

  function numbersSection() {
    const k = st.inf, inf = App.infByKey[k];
    const rows = dataRows(k);
    const ly = lastYear(), fy = firstYear();
    const a = sirOf(fy, k), b = sirOf(ly, k), lt = App.T[App.T.length - 1][k];
    return `
      <p>Every value plotted in each panel, taken directly from the query results above. Pick an infection to see its panel’s numbers.</p>
      ${infChips()}
      <div class="xp-table-wrap"><table class="xp-table" id="xp-data-table">
        <caption class="xp-cap">${esc(inf.label)}: every value plotted in the ${esc(inf.short)} panel</caption>
        <thead><tr><th scope="col">Report year</th><th scope="col">Data period</th><th scope="col" class="r">Σ Observed</th><th scope="col" class="r">Σ Predicted</th>
          <th scope="col" class="r">Pooled SIR</th><th scope="col" class="r">On chart</th><th scope="col" class="r">vs ${fy}</th>
          <th scope="col" class="r">Hospitals<br/>in total / with SIR</th><th scope="col">CMS source</th></tr></thead>
        <tbody>${rows.map((r) => `<tr${r.d.year === ly ? ' class="hl"' : ''}><th scope="row">${r.d.year}</th><td>${period(r.d.year)}</td>
          <td class="r">${fInt(r.t.obs)}</td><td class="r">${fPred(r.t.pred)}</td><td class="r">${f6(r.t.sir)}</td><td class="r"><b>${App.f2(r.t.sir)}</b></td>
          <td class="r">${r.chg == null ? '—' : pct1(r.chg)}</td><td class="r">${fInt(r.t.reporting ?? 0)} / ${fInt(r.t.n)}</td><td>${r.check}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="xp-small"><span class="xp-foot">*</span> CMS excluded January–June 2020 under its COVID‑19 exception. Highlighted row = the big number in the panel.</p>
      <div class="xp-worked">
        <div><span class="xp-flabel">${ly} pooled SIR</span><span class="xp-math">${fInt(lt.obs)} ÷ ${fPred(lt.pred)} = ${f6(b)} → <b>${App.f2(b)}</b></span></div>
        <div><span class="xp-flabel">Change vs ${fy}</span><span class="xp-math">${f6(b)} ÷ ${f6(a)} − 1 = ${pct1(b / a - 1)} → <b>${App.signPct(b / a - 1)}</b></span></div>
      </div>
      <div class="xp-actions"><button type="button" class="btn xp-csv">Copy all six infections as CSV</button></div>`;
  }

  function csvAll() {
    const head = ['infection', 'report_year', 'period_start', 'period_end', 'observed', 'predicted', 'pooled_sir', 'shown_on_chart', 'hospitals_in_total', 'hospitals_with_sir', 'cms_snapshot', 'cms_match'];
    const lines = [head.join(',')];
    App.INF.forEach((inf) => App.T.forEach((d) => {
      const t = d[inf.key], p = (App.meta.haiYearPeriods || {})[d.year] || ['', ''];
      const vy = verifiedYear(d.year), vi = vy && vy.infections ? vy.infections[inf.key] : null;
      lines.push([inf.short, d.year, p[0], p[1], t.obs, t.pred, t.sir, App.f2(t.sir), t.reporting ?? '', t.n, vy ? vy.snapshot : '', vi ? vi.match : ''].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    }));
    return lines.join('\n');
  }

  // ---------- Tab 2: try this yourself ----------
  function tabValidate() {
    const k = st.inf, inf = App.infByKey[k], n = infNum(k);
    const ly = lastYear(), fy = firstYear();
    const lt = App.T[App.T.length - 1][k];
    const a = sirOf(fy, k), b = sirOf(ly, k);
    const expected = App.T.map((d) => `<tr${d.year === ly ? ' class="hl"' : ''}><th scope="row">${d.year}</th><td class="r">${fInt(d[k].obs)}</td><td class="r">${fPred(d[k].pred)}</td>` +
      `<td class="r">${f6(d[k].sir)}</td><td class="r">${fInt(d[k].reporting ?? 0)}</td><td class="r">${fInt(d[k].n)}</td></tr>`).join('');
    const vRows = V ? V.years.map((y) => `<tr><th scope="row">${y.year}</th><td>${period(y.year)}</td>` +
      `<td><a href="${esc(y.url)}" target="_blank" rel="noopener noreferrer">${esc(y.snapshot)}</a></td>` +
      `<td>${y.status === 'match' ? '<span class="xp-ok">All six match</span>' : '<span class="xp-bad">differences</span>'}</td></tr>`).join('') : '';
    return `
      <p class="xp-lede">You don’t have to trust this dashboard, the semantic model, or this panel. Here are four independent checks, quickest first.
        Pick an infection and every example below updates.</p>
      ${infChips()}

      <section class="xp-level">
        <div class="xp-level-head"><span class="xp-n">1</span><h3>Recalculate by hand</h3><span class="xp-time">≈ 1 minute</span></div>
        <p>Use any calculator with the totals in the table under <i>How it’s calculated</i>. For ${esc(inf.short)}:</p>
        <ul class="xp-list">
          <li>${ly}: <span class="xp-calc">${fInt(lt.obs)} ÷ ${fPred(lt.pred)} = ${f6(b)}</span> → rounds to <b>${App.f2(b)}</b>, the big number in the panel.</li>
          <li>Change: <span class="xp-calc">${f6(b)} ÷ ${f6(a)} − 1 = ${pct1(b / a - 1)}</span> → <b>${App.signPct(b / a - 1)}</b>, the label under it.</li>
        </ul>
      </section>

      <section class="xp-level">
        <div class="xp-level-head"><span class="xp-n">2</span><h3>Re‑run the query in Fabric</h3><span class="xp-time">≈ 5 minutes</span></div>
        <ol class="xp-steps">
          <li>${isLocal() ? 'If you have published the tables with <code>publish_fabric.py --core</code>, open' : 'In the Fabric portal, open'} workspace ${workspaceName()} and find semantic model <b>${esc(App.meta.model)}</b>.</li>
          <li>Choose <b>⋯ → Write DAX queries</b> (or open the model and select <b>Write DAX queries</b> at the top).</li>
          <li>Paste the query below and select <b>Run</b>.</li>
          <li>Compare with the expected results: observed, predicted and hospital counts should match <b>exactly</b>, and Pooled SIR to 6 decimals.</li>
        </ol>
        ${codeBlock('xp-vq', App.fig1ValidationDax(k), `DAX · validation query for ${inf.short}`)}
        <div class="xp-table-wrap"><table class="xp-table">
          <caption class="xp-cap">Expected results for ${esc(inf.short)}</caption>
          <thead><tr><th scope="col">REPORTYEAR</th><th scope="col" class="r">Observed</th><th scope="col" class="r">Predicted</th><th scope="col" class="r">Pooled SIR</th>
            <th scope="col" class="r">Hospitals in total</th><th scope="col" class="r">Hospitals with published SIR</th></tr></thead>
          <tbody>${expected}</tbody></table></div>
        <p class="xp-note"><b>Access:</b> <i>Write DAX queries</i> in the portal needs write permission on the model. With only Build permission, connect to the model live from
          Power BI Desktop and use <i>DAX query view</i> instead. The workspace’s Fabric capacity must be running.</p>
        <p class="xp-small"><b>See why we don’t average:</b> replace the last line inside <code>SUMMARIZECOLUMNS</code> with
          <code>"Average of hospital SIRs", AVERAGE ( HAI[${esc(inf.columns.sir)}] )</code>. For ${ly} you’ll get ${lt.avgHospSir != null ? f4(lt.avgHospSir) : 'a different value'} instead of ${f4(b)}.</p>
      </section>

      <section class="xp-level">
        <div class="xp-level-head"><span class="xp-n">3</span><h3>Trace it back to CMS’s own files</h3><span class="xp-time">≈ 15 minutes</span></div>
        <p>This bypasses Fabric entirely and checks the semantic model against the public source.</p>
        <ol class="xp-steps">
          <li>Open the <a href="${esc(V ? V.archivePage : 'https://data.cms.gov/provider-data/archived-data/hospitals')}" target="_blank" rel="noopener noreferrer">CMS hospitals data archive</a> and download the snapshot for the report year (table below).</li>
          <li>Unzip it and open <code>Healthcare_Associated_Infections-Hospital.csv</code> in Excel.</li>
          <li>Observed total: <span class="xp-mono">=SUMIFS(L:L, I:I, "HAI_${n}_NUMERATOR")</span>. Column I is <i>Measure ID</i> and column L is <i>Score</i>; text such as “Not Available” is skipped automatically.</li>
          <li>Predicted total: <span class="xp-mono">=SUMIFS(L:L, I:I, "HAI_${n}_ELIGCASES")</span>, then divide observed by predicted.</li>
          <li>Hospital counts: <span class="xp-mono">=COUNTIFS(I:I, "HAI_${n}_NUMERATOR", L:L, "&gt;=0")</span> (counts numeric scores only). Use <code>HAI_${n}_SIR</code> instead for hospitals with a published SIR.</li>
        </ol>
        <p class="xp-note">Use the archived snapshot, not today’s download. CMS’s live file is usually a newer release than this dashboard’s latest report year,
          so match the <i>Start Date</i> and <i>End Date</i> columns to the period shown here.</p>
        ${V ? `<div class="xp-table-wrap"><table class="xp-table">
          <caption class="xp-cap">Which CMS snapshot matches each report year, and the result of our automated check</caption>
          <thead><tr><th scope="col">Report year</th><th scope="col">Data period</th><th scope="col">CMS archive snapshot</th><th scope="col">Automated check</th></tr></thead>
          <tbody>${vRows}</tbody></table></div>
          <p class="xp-small"><code>verify_against_cms.py</code> repeats this for every infection and year: it reads each snapshot’s HAI file and compares observed, predicted,
          hospitals in total and hospitals with a published SIR. Last run ${esc(d3.utcFormat('%b %-d, %Y %H:%M UTC')(new Date(V.checkedAt)))}:
          <b class="${V.allMatch ? 'xp-ok' : 'xp-bad'}">${V.allMatch ? `all ${V.years.length * App.INF.length} infection‑years match exactly` : 'differences found'}</b>.</p>`
          : '<p class="xp-note">This extract hasn’t been cross‑checked against CMS yet. Run <code>python3 verify_against_cms.py</code> to compare every year and infection automatically.</p>'}
      </section>

      <section class="xp-level">
        <div class="xp-level-head"><span class="xp-n">4</span><h3>Sanity‑check against CDC</h3><span class="xp-time">optional</span></div>
        <p>CDC’s <a href="https://www.cdc.gov/nhsn/datastat/progress-report.html" target="_blank" rel="noopener noreferrer">HAI Progress Report</a> publishes national SIRs from the same NHSN system.
          Expect the <b>same direction and similar size, not identical values</b>: CDC reports calendar years and its own set of facilities, while this chart pools the hospitals CMS publishes.</p>
      </section>

      <h3>If something doesn’t match</h3>
      <ul class="xp-list">
        <li><b>Totals differ from the table under <i>How it’s calculated</i>:</b> the ${isLocal() ? 'core tables have' : 'semantic model has'} probably been rebuilt since ${esc(extracted())}. Re‑run <code>refresh_data.py${isLocal() ? ' --local' : ''}</code> and redeploy.</li>
        <li><b>Totals match but the SIR doesn’t:</b> you’re probably averaging hospital SIRs, or filtering to hospitals that have a published SIR.</li>
        <li><b>CMS file doesn’t match:</b> check the file’s <i>Start Date</i>/<i>End Date</i>. CMS sometimes revises a period in a later release, so use the snapshot listed above.</li>
      </ul>`;
  }

  // ---------- Dialog plumbing ----------
  function render() {
    const fns = { method: tabMethod, validate: tabValidate };
    body.innerHTML = fns[st.tab]();
    body.setAttribute('aria-labelledby', `xp-tab-${st.tab}`);
    dlg.querySelectorAll('.xp-tab').forEach((b) => {
      const on = b.dataset.tab === st.tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }

  function copyText(text, btn, okLabel) {
    const done = (ok) => {
      if (!btn) return;
      const prev = btn.dataset.label || btn.textContent;
      btn.dataset.label = prev;
      btn.textContent = ok ? okLabel || 'Copied' : 'Copy failed';
      dlg.querySelector('.xp-live').textContent = ok ? `${okLabel || 'Copied'} to clipboard` : 'Copy failed';
      btn.classList.toggle('done', ok);
      setTimeout(() => { btn.textContent = prev; btn.classList.remove('done'); }, 1600);
    };
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.className = 'xp-offscreen';
      dlg.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      done(ok);
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(() => done(true), fallback);
    else fallback();
  }

  function build() {
    dlg = document.createElement('dialog');
    dlg.className = 'xp';
    dlg.setAttribute('aria-labelledby', 'xp-title');
    const v = V && V.allMatch;
    dlg.innerHTML = `
      <header class="xp-head">
        <div>
          <div class="eyebrow">Fig 1</div>
          <h2 id="xp-title">How the national infection ratio chart is built</h2>
          <p class="sub">National pooled SIR for six healthcare‑associated infections, report years ${firstYear()}–${lastYear()}.</p>
        </div>
        <button type="button" class="xp-close" aria-label="Close explanation">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
      </header>
      <div class="xp-trust">
        ${V_STALE ? '<span class="xp-pill warn">Data refreshed since the last CMS check · run <code>python3 verify_against_cms.py</code></span>' : ''}
        ${v ? `<span class="xp-pill ok"><svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>Verified against CMS source files · ${V.years.length * App.INF.length}/${V.years.length * App.INF.length} infection‑years match</span>` : ''}
        ${isLocal() ? '<span class="xp-pill">Source <b>data/core/hai.csv</b> · local build</span>' : `<span class="xp-pill">Model <b>${esc(App.meta.model)}</b>${App.meta.workspace ? ` · ${esc(App.meta.workspace)}` : ''}</span>`}
        <span class="xp-pill">Table <b>HAI</b> · ${App.T.length} report years</span>
        <span class="xp-pill">Extracted ${esc(extracted())}</span>
      </div>
      <div class="xp-tabs" role="tablist" aria-label="Explanation sections">
        ${TABS.map(([id, label]) => `<button type="button" role="tab" class="xp-tab" id="xp-tab-${id}" data-tab="${id}" aria-controls="xp-body">${label}</button>`).join('')}
      </div>
      <div class="xp-body" id="xp-body" role="tabpanel" tabindex="0"></div>
      <div class="xp-live xp-offscreen" role="status" aria-live="polite"></div>`;
    document.body.appendChild(dlg);
    body = dlg.querySelector('#xp-body');

    dlg.querySelector('.xp-close').addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    // Native Esc-to-close is skipped by some browsers and embedded hosts, so handle it explicitly.
    dlg.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      dlg.close();
    });
    dlg.addEventListener('close', () => {
      document.documentElement.classList.remove('xp-open');
      if (opener) opener.focus();
    });
    const tabs = dlg.querySelector('.xp-tabs');
    tabs.addEventListener('click', (e) => {
      const b = e.target.closest('.xp-tab');
      if (!b) return;
      st.tab = b.dataset.tab;
      render();
      body.scrollTop = 0;
    });
    tabs.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const ids = TABS.map((t) => t[0]);
      let i = ids.indexOf(st.tab);
      i = e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
      st.tab = ids[i];
      render();
      dlg.querySelector(`#xp-tab-${st.tab}`).focus();
    });
    body.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-inf]');
      if (chip) {
        st.inf = chip.dataset.inf;
        const y = body.scrollTop;
        const expanded = [...body.querySelectorAll('details[open]')].map((d) => d.id);
        render();
        expanded.forEach((id) => { const d = body.querySelector('#' + id); if (d) d.open = true; });
        body.scrollTop = y;
        const again = body.querySelector(`[data-inf="${st.inf}"]`);
        if (again) again.focus();
        return;
      }
      const cp = e.target.closest('[data-copy]');
      if (cp) { copyText(body.querySelector('#' + cp.dataset.copy).textContent, cp); return; }
      const csv = e.target.closest('.xp-csv');
      if (csv) copyText(csvAll(), csv, `Copied ${App.INF.length * App.T.length} rows`);
    });
  }

  function open(btn) {
    if (!dlg) build();
    opener = btn;
    render();
    document.documentElement.classList.add('xp-open');
    dlg.showModal();
    body.scrollTop = 0;
    dlg.querySelector(`#xp-tab-${st.tab}`).focus();
  }

  App.explainFig1 = { open };
  // This script loads after the page markup, so the button already exists.
  const trigger = document.getElementById('explainFig1');
  if (trigger) trigger.addEventListener('click', () => open(trigger));
})();
