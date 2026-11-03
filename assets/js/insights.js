/* Insights and takeaways: thirteen findings for clinical and operational leaders, each with the number that moved, its
   trend (drawn from this dashboard's own data) and an executive takeaway. The text was written for a demo from an
   earlier extract of the same data, so its figures can differ from a newer build. */
(function () {
  'use strict';
  const App = window.App;

  const INSIGHTS = [
  {
    "num": "01",
    "label": "Composite",
    "value": "~1.00",
    "valueNote": "PSI 90, six-year average",
    "title": "Aggregate safety is holding at the line, not improving",
    "text": "The CMS PSI 90 composite, the all-cause patient-safety and adverse-events index, has sat within ±0.03 of its 1.00 benchmark every reporting year from 2019 to 2024 (0.993 → 0.975 → 1.002 → 0.999 → 0.997). Across ~2,900 reporting facilities, between 1,005 and 1,179 sit above the benchmark in any given year.",
    "takeaway": "Stability is not success. Recovering infections won't move this composite, because infections are only about an eighth of in-hospital harm while medication and surgical events make up the bulk. The national average also hides a persistent group of high-harm facilities, so watch the count above 1.00 as the measure that actually reflects harm reaching patients.",
    "series": "psiComposite"
  },
  {
    "num": "02",
    "label": "Infections",
    "value": "-39%",
    "valueNote": "C. difficile SIR, 2019→2025",
    "title": "Infection control won back everything the pandemic took",
    "text": "Central-line (CLABSI), urinary (CAUTI) and MRSA infections all spiked through 2020–2021 as COVID strained staffing and line care, then recovered to well below benchmark by 2025. C. difficile improved straight through the pandemic, SIR 0.58 → 0.36, a 39% reduction.",
    "takeaway": "This is the clearest proof that prevention works and recovers fast. The risk now is complacency, because these gains depend on sustaining the nurse staffing and stewardship practices that care teams used to produce them.",
    "series": "cdiff"
  },
  {
    "num": "03",
    "label": "Stewardship",
    "value": "-43%",
    "valueNote": "Observed C. diff cases",
    "title": "Antibiotic stewardship is the clearest success in the portfolio",
    "text": "Observed C. difficile infections fell from 52,648 in 2019 to 29,753 in 2025, nearly 23,000 fewer cases a year, with no pandemic reversal. The standardized ratio fell every single year, the only measure to do so.",
    "takeaway": "Treat stewardship as the template worth spreading. When anyone asks what a working safety program looks like, this is the curve to show: steady, year after year, and tied to specific clinical practice that physicians, pharmacists and nurses own at the bedside.",
    "series": "cdiffObs"
  },
  {
    "num": "04",
    "label": "Bloodstream",
    "value": "0.62",
    "valueNote": "CLABSI SIR, 2025",
    "title": "The COVID line-infection scar has fully healed",
    "text": "Central-line-associated bloodstream infection SIR rose from 0.685 (2019) to a 0.985 peak in 2021, essentially at the benchmark, as ICUs overflowed. It has since fallen to 0.615, the lowest in the series, with observed cases down from a 19,637 peak to 10,805.",
    "takeaway": "Line-care discipline is restorable, and it was restored. Lock in the recovery by making the 2022–24 practices of insertion bundles and daily line review permanent standard work for bedside teams, not a crisis-only response.",
    "series": "clabsi"
  },
  {
    "num": "05",
    "label": "Urinary",
    "value": "0.50",
    "valueNote": "CAUTI SIR, 2025",
    "title": "Catheter stewardship hit a series low",
    "text": "Catheter-associated urinary tract infection SIR declined from 0.717 (2019) to 0.502 (2025), roughly half the predicted rate, with only a mild 2020–21 bump. It is now the second-best-performing infection measure after C. diff.",
    "takeaway": "Early catheter removal protocols are compounding. This is a low-visibility win worth protecting; small process drifts here are easy to miss because the absolute numbers look good.",
    "series": "cauti"
  },
  {
    "num": "06",
    "label": "MRSA",
    "value": "0.70",
    "valueNote": "MRSA bacteremia SIR, 2025",
    "title": "MRSA recovered, but it breached the benchmark once",
    "text": "MRSA bloodstream infection was the one HAI to cross above 1.00, reaching 1.089 in 2021, before recovering to ~0.70 by 2024–25. Observed cases peaked at 11,380 in 2021.",
    "takeaway": "MRSA is sensitive to community prevalence and staffing pressure, so it is the canary for the next disruption. Keep it on the watchlist even though it currently performs well.",
    "series": "mrsa"
  },
  {
    "num": "07",
    "label": "Surgical, rising",
    "value": "1.11",
    "valueNote": "Hysterectomy SSI SIR, 2025",
    "title": "The one infection getting worse, not better",
    "text": "Surgical-site infection after abdominal hysterectomy moved against every other trend: 0.929 (2019) → crossing the benchmark in 2023 (1.047) → 1.124 (2024) → 1.108 (2025). It is now meaningfully above predicted, and CDC reported the same direction nationally with an 8% rise in the latest year.",
    "takeaway": "This is the single clearest deterioration in the infection portfolio and it is surgical, not systemic. Commission a peri-operative protocol and antibiotic-prophylaxis review for gynecologic surgery now.",
    "series": "ssiHyst"
  },
  {
    "num": "08",
    "label": "Surgical, stalled",
    "value": "0.87",
    "valueNote": "Colon SSI SIR",
    "title": "Colon surgical infections are stubbornly flat",
    "text": "Colon-surgery SSI has hovered at 0.84–0.90 for seven years with no improvement trend, neither a pandemic spike nor a recovery, just a flat line near 0.87.",
    "takeaway": "Flat is a finding. The measures that improved had a clear intervention (stewardship, line bundles); colon SSI has plateaued, signaling diminishing returns from current practice and a need for a new approach.",
    "series": "ssiColon"
  },
  {
    "num": "09",
    "label": "Post-op, rising",
    "value": "10.4",
    "valueNote": "Respiratory-failure rate, peak",
    "title": "Post-operative respiratory failure has nearly doubled",
    "text": "The PSI post-operative respiratory failure rate climbed from 5.10 per 1,000 eligible discharges (2019) to a peak of 10.40 in 2023, easing only slightly to 9.57 in 2024. It is the steepest rise of any PSI component and a heavy contributor to the composite.",
    "takeaway": "This needs a coding-versus-clinical investigation before it is treated as pure harm: documentation shifts can inflate PSI rates. Either way it is the highest-weight force pushing facilities over the PSI 90 line.",
    "series": "respFail"
  },
  {
    "num": "10",
    "label": "Post-op, drift",
    "value": "+0.3",
    "valueNote": "Sepsis rate, 2019→2024",
    "title": "Post-surgical deterioration is drifting upward",
    "text": "Post-operative sepsis rose from 4.90 to 5.31 per 1,000 (peaking 5.61 in 2023) and post-operative acute kidney injury requiring dialysis from 1.42 to 1.67. Both track the same post-2021 upward drift as respiratory failure.",
    "takeaway": "A common thread of failure-to-rescue after surgery may link these three PSI components. A single early-warning and rapid-response initiative could move all of them together.",
    "series": "sepsis"
  },
  {
    "num": "11",
    "label": "Experience",
    "value": "3.24",
    "valueNote": "HCAHPS summary star, 2025",
    "title": "Patient experience recovered to pre-pandemic levels",
    "text": "The HCAHPS summary star rating dipped to 3.079 in 2020, then recovered to 3.24 by 2025. Cleanliness (88.1 → 85.2 → 86.7) and staff responsiveness (85.7 → 82.5 → 83.5) traced the same dip-and-recovery, closely tracking staffing stabilization.",
    "takeaway": "Patient experience is a lagging indicator of workforce health. Responsiveness and cleanliness move most closely with staffing, so as agency reliance fell and care-team tenure rebuilt, scores recovered. Keeping experienced staff shows up directly in how patients rate their care.",
    "series": "star"
  },
  {
    "num": "12",
    "label": "Experience, stalled",
    "value": "~76",
    "valueNote": "Medicine-communication score",
    "title": "Two experience gaps are structural, not pandemic",
    "text": "Communication about medicines (~75–79, the lowest domain every year) and quietness of the environment (~82, flat) never moved with the pandemic and never recovered. They were simply always low.",
    "takeaway": "Because these never dipped, they won't fix themselves with recovery. They are design problems: discharge medication counseling and night-time noise reduction need dedicated operational ownership.",
    "series": "medComm"
  },
  {
    "num": "13",
    "label": "Geography",
    "value": "1.90",
    "valueNote": "Highest state PSI 90 (PR)",
    "title": "Safety is uneven by geography",
    "text": "Average PSI 90 in 2024 ranges from 0.913 (Utah) to 1.900 (Puerto Rico), with Connecticut, Indiana and Minnesota leading and Vermont, Alaska, Montana and New York lagging. New York alone has 71 facilities above the benchmark, the largest absolute concentration.",
    "takeaway": "A flat national average hides a wide regional spread. Improvement capacity and peer-mentoring should be routed to the lagging states and the named high-PSI facilities, not spread evenly.",
    "series": "psiComposite"
  }
];

  const CLOSE = "Infection control has been the network's great success and antibiotic stewardship its proof. But the all-cause safety index is flat, post-surgical signals are drifting up, and <em>the work now is the long tail of facilities, not the average</em>.";

  // Each finding's trend, from the same CMS data the dashboard charts use. up: true where higher is better.
  const SERIES = {
    psiComposite: () => ({ pts: App.P.map((d) => [d.year, d.psi90]) }),
    cdiff: () => ({ pts: App.sirSeries('cdiff').map((d) => [d.year, d.v]) }),
    cdiffObs: () => ({ pts: App.T.map((d) => [d.year, d.cdiff.obs]) }),
    clabsi: () => ({ pts: App.sirSeries('clabsi').map((d) => [d.year, d.v]) }),
    cauti: () => ({ pts: App.sirSeries('cauti').map((d) => [d.year, d.v]) }),
    mrsa: () => ({ pts: App.sirSeries('mrsa').map((d) => [d.year, d.v]) }),
    ssiHyst: () => ({ pts: App.sirSeries('ssi_hyst').map((d) => [d.year, d.v]) }),
    ssiColon: () => ({ pts: App.sirSeries('ssi_colon').map((d) => [d.year, d.v]) }),
    respFail: () => ({ pts: App.P.map((d) => [d.year, d.resp]) }),
    sepsis: () => ({ pts: App.P.map((d) => [d.year, d.sepsis]) }),
    star: () => ({ pts: App.H.map((d) => [d.year, d.avgstar]), up: true }),
    medComm: () => ({ pts: App.H.map((d) => [d.year, d.meds]).filter((p) => p[1] != null), up: true }),
  };

  const fmtV = (v) => (Math.abs(v) >= 1000 ? App.f0(Math.round(v)) : Math.abs(v) >= 10 ? App.f1(v) : App.f2(v));

  function trendHTML(f, i) {
    const s = SERIES[f.series] && SERIES[f.series]();
    if (!s || s.pts.length < 2) return '';
    const a = s.pts[0][1], b = s.pts[s.pts.length - 1][1];
    const chg = (b - a) / Math.abs(a);
    const flat = Math.abs(chg) < 0.02;
    const better = s.up ? chg > 0 : chg < 0;
    const cls = flat ? 'flat' : better ? 'good' : 'bad';
    const delta = flat ? 'No change' : `${chg > 0 ? '▲' : '▼'} ${App.pct0(Math.abs(chg))}`;
    return `<div class="ins-trend">
      <span class="ins-trend-label">${s.pts[0][0]} to ${s.pts[s.pts.length - 1][0]}</span>
      <div class="ins-spark" data-i="${i}" data-cls="${cls}"></div>
      <div class="ins-trend-meta"><span class="tnum">${fmtV(a)} → ${fmtV(b)}</span><span class="delta ${cls}">${delta}</span></div>
    </div>`;
  }

  function sparks() {
    const C = App.C;
    document.querySelectorAll('#insFindings .ins-spark').forEach((el) => {
      const f = INSIGHTS[+el.dataset.i], s = SERIES[f.series]();
      const col = el.dataset.cls === 'good' ? C.good : el.dataset.cls === 'bad' ? C.bad : C.muted;
      const h = 44, w = Math.max(120, el.clientWidth || 220), m = { t: 6, r: 5, b: 6, l: 5 };
      const x = d3.scaleLinear().domain(d3.extent(s.pts, (p) => p[0])).range([m.l, w - m.r]);
      const [lo, hi] = d3.extent(s.pts, (p) => p[1]);
      const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.05 || 0.1;
      const y = d3.scaleLinear().domain([lo - pad, hi + pad]).range([h - m.b, m.t]);
      d3.select(el).selectAll('*').remove();
      const svg = d3.select(el).append('svg').attr('width', w).attr('height', h).attr('viewBox', `0 0 ${w} ${h}`)
        .attr('role', 'img').attr('aria-label', `Trend, ${s.pts.map((p) => `${p[0]} ${fmtV(p[1])}`).join(', ')}`);
      svg.append('path').datum(s.pts).attr('fill', col).attr('fill-opacity', 0.07)
        .attr('d', d3.area().x((p) => x(p[0])).y0(h - m.b).y1((p) => y(p[1])).curve(d3.curveMonotoneX));
      svg.append('path').datum(s.pts).attr('fill', 'none').attr('stroke', col).attr('stroke-width', 1.8)
        .attr('d', d3.line().x((p) => x(p[0])).y((p) => y(p[1])).curve(d3.curveMonotoneX));
      const last = s.pts[s.pts.length - 1];
      svg.append('circle').attr('cx', x(last[0])).attr('cy', y(last[1])).attr('r', 2.8).attr('fill', col);
    });
  }

  function build() {
    const toc = document.getElementById('insToc'), list = document.getElementById('insFindings');
    if (!toc || !list) return;
    const esc = App.esc;
    toc.innerHTML = `<div class="ins-toc-inner"><span class="ins-toc-label">Findings</span><ol>${INSIGHTS.map((f, i) =>
      `<li><a class="ins-toc-item" href="#insight-${i + 1}" data-i="${i}"><span class="chapter-pill">${f.num}</span><span class="ins-toc-name">${esc(f.label)}</span></a></li>`).join('')}</ol></div>`;
    list.innerHTML = INSIGHTS.map((f, i) => `<article class="ins-finding" id="insight-${i + 1}">
        <div class="ins-rail">
          <div class="ins-tag"><span class="ins-num">${f.num}</span>${esc(f.label)}</div>
          <div class="ins-stat"><span class="ins-val tnum">${esc(f.value)}</span><span class="ins-val-note">${esc(f.valueNote)}</span></div>
          ${trendHTML(f, i)}
        </div>
        <div class="ins-main">
          <h2>${esc(f.title)}</h2>
          <p class="ins-text">${esc(f.text)}</p>
          <div class="ins-takeaway"><span class="ins-takeaway-label">Executive takeaway</span><p>${esc(f.takeaway)}</p></div>
        </div>
      </article>`).join('') + `<div class="ins-close"><span class="ins-close-label">In one line</span><p>${CLOSE}</p></div>`;
    spy();
  }

  // The contents rail marks the finding you are reading: the last one whose top has passed the reading line
  function spy() {
    const items = [...document.querySelectorAll('#insToc .ins-toc-item')];
    const findings = [...document.querySelectorAll('#insFindings .ins-finding')];
    const topbar = document.querySelector('.topbar');
    let queued = false;
    const mark = () => {
      queued = false;
      if (document.getElementById('view-insights').hidden) return;
      const T = topbar.getBoundingClientRect().bottom, line = T + (innerHeight - T) * 0.33;
      let cur = 0;
      findings.forEach((f, i) => { if (f.getBoundingClientRect().top <= line) cur = i; });
      items.forEach((a, i) => {
        a.classList.toggle('on', i === cur);
        a.querySelector('.chapter-pill').classList.toggle('on', i === cur);
        if (i === cur) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
      });
    };
    const queue = () => { if (!queued) { queued = true; requestAnimationFrame(mark); } };
    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', queue);
    App.insightsSpy = queue;
    queue();
  }

  build();
  App.insights = INSIGHTS;
  App.register('insights', () => { sparks(); if (App.insightsSpy) App.insightsSpy(); });
})();
