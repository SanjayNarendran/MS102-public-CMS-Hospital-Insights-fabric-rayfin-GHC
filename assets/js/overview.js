/* Overview tab: key facts beside the headline and the list of dashboard sections (built from the sections themselves,
   so numbers and titles always match the Quality & safety tab) */
(function () {
  'use strict';
  const App = window.App;

  // One line on what each section shows, keyed by section id
  const ABOUT = {
    infections: 'National infection ratios for six infections from 2019 to 2025, and how many hospitals are flagged better or worse than benchmark.',
    benchmark: 'A funnel plot that separates hospitals with genuinely high infection rates from small-hospital noise.',
    geography: 'State results, and a street map of every hospital with a search for the ones nearest you.',
    maternity: 'Drive time to the nearest hospital that delivers babies or has a NICU, with an address search, road routes and directions.',
    experience: 'HCAHPS star ratings over time, and the survey questions that have not recovered.',
    safety: 'The PSI‑90 safety composite and the surgical complications that are rising beneath it.',
    connections: 'How patient ratings relate to infections and safety, matched hospital by hospital.',
    outcomes: 'CMS overall star rating, emergency department times, death and readmission rates, and Medicare penalties.',
    explorer: 'Search, filter and sort every hospital across all of these measures.',
  };

  function render() {
    const F = App.facts || {}, m = App.meta;
    const chapters = [...document.querySelectorAll('#view-quality section.chapter')];
    const list = document.getElementById('ovSections');
    if (list) {
      list.innerHTML = chapters.map((c) => {
        const name = App.esc(c.querySelector('.chapter-name').textContent);
        return `<li><a class="ov-row" href="#${c.id}"><span class="chapter-pill">${c.dataset.num}</span>` +
          `<span class="ov-row-name">${name}</span><span class="ov-row-about">${App.esc(ABOUT[c.id] || '')}</span></a></li>`;
      }).join('');
    }
    const n = App.insights ? App.insights.length : 13;
    const words = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen'];
    const count = document.getElementById('ovInsightCount');
    if (count) count.textContent = words[n] || String(n);
    App.heroFacts(document.getElementById('ovFacts'), [
      ['Hospitals', `${F.nFac || App.f0(App.facilities.length)} <span class="note">(${F.nHai} report infections)</span>`],
      ['Years covered', `Report years ${App.first.year} to ${App.last.year}`],
      ['Dashboard', `${chapters.length} sections`],
      ['Insights', `${n} findings with takeaways`],
      ['Built from', m.source === 'powerbi' ? `Semantic model <span class="mono">CMS</span>${m.workspace ? ` in workspace <span class="mono">${App.esc(m.workspace)}</span>` : ''}` : 'Public CMS, CDC and Census files (local build)'],
      ['Extracted', d3.timeFormat('%B %-d, %Y')(App.extractedDate())],
    ]);
  }

  // Runs after main.js has computed the facts; the section titles are already in the page
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(render));
  else setTimeout(render);
  App.overview = { render };
})();
