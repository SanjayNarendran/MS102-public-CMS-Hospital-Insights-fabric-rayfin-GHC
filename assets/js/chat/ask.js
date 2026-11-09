/* The Ask your data tab: a conversation with GitHub Copilot about the dashboard's data, answered with figures.
   Also the pieces the side panel shares: the sign-in and model controls, and the composer. */
(function () {
  'use strict';
  const App = window.App, Chat = window.Chat;
  const esc = App.esc;
  const $ = (id) => document.getElementById(id);

  // Starter questions by role, drawn from what the CMS and CMS V2 models can answer (copilot/QUESTIONS.md)
  const STARTERS = [
    ['Executive', [
      'How have hospital infections, patient experience and PSI‑90 moved since 2019?',
      'Which states have the largest share of hospitals losing Medicare payments for hospital-acquired conditions?',
      'Show a report card for Cleveland Clinic against hospitals nationally.',
    ]],
    ['Quality and safety', [
      'Which PSI components rose most since 2019?',
      'Which hospitals in Texas are significantly worse than expected for central-line infections, given their size?',
      'Has the spread of PSI‑90 across hospitals narrowed since 2019?',
    ]],
    ['Infection prevention', [
      'Project the national CLABSI and CAUTI ratios to 2030.',
      'Which hospitals account for most of the excess C. diff infections?',
      'How did each infection move through COVID and after?',
    ]],
    ['Nursing', [
      'Is better nurse communication linked to fewer catheter infections?',
      'Which states have the highest pressure ulcer rates?',
    ]],
    ['Patient experience', [
      'How has the HCAHPS star mix changed since 2019?',
      'Which survey questions still score below 2019, and in which states?',
    ]],
    ['Finance and penalties', [
      'Which hospitals lost payments under both the HAC and readmissions programs?',
      'Do hospitals with HAC payment cuts also have more infections flagged worse?',
    ]],
    ['Emergency care', [
      'Which states keep emergency patients longest, and how does their sepsis care compare?',
      'Do busier emergency departments keep patients longer?',
    ]],
    ['Maternity care', [
      'Where do women live more than an hour from a NICU?',
      'Which hospitals in Minnesota deliver babies, and which of them have a NICU?',
      'How many hospitals have stopped delivering babies in each state?',
    ]],
    ['Public health', [
      'Map the share of women aged 15–44 who live more than 30 minutes from a hospital that delivers babies.',
      'How do heart failure death rates vary by state?',
    ]],
  ];

  // ---- sign-in and model controls (the tab's header and the side panel) ---------------------------------------------
  // Renders who Copilot runs as, or the sign-in that's needed; resolves true when questions can be asked.
  async function renderAccount(el, { compact } = {}) {
    let me;
    try { me = await Chat.me(); } catch (e) { el.innerHTML = `<p class="chat-note bad-ink">${esc(e.message)}</p>`; return false; }
    if (me.mode === 'relay' && !me.fabric) {
      el.innerHTML = `<div class="chat-signin"><p>Sign in with your Fabric account to ask questions here.</p><button type="button" class="btn btn-ink" data-act="fabric">Sign in with Fabric</button></div>`;
      el.querySelector('[data-act="fabric"]').onclick = () => Chat.signInFabric().catch((e) => alert(e.message));
      return false;
    }
    if (me.error) { el.innerHTML = `<p class="chat-note bad-ink">${esc(me.error)}</p>`; return false; }
    if (me.github) {
      el.innerHTML = `<span class="chat-who"><span class="chat-who-k">Copilot</span><span class="chat-who-v">${esc(me.github.login)}</span>` +
        `<button type="button" class="chat-link" data-act="out">${me.mode === 'local' ? 'Change' : 'Sign out'}</button></span>`;
      el.querySelector('[data-act="out"]').onclick = () => Chat.signOut();
      return true;
    }
    if (me.mode === 'relay') {
      el.innerHTML = `<div class="chat-signin"><p>${compact ? 'Questions run on your own GitHub Copilot plan.' : 'Questions run on your own GitHub Copilot plan. Sign in to GitHub once; the sign-in lasts until the chat service restarts.'}</p>` +
        `<button type="button" class="btn btn-ink" data-act="gh">Sign in with GitHub</button></div>`;
      el.querySelector('[data-act="gh"]').onclick = () => Chat.signInGitHub().catch((e) => { const p = el.querySelector('p'); if (p) p.textContent = e.message; });
      return false;
    }
    const accounts = me.accounts || [];
    el.innerHTML = `<div class="chat-signin"><p>Choose the GitHub account Copilot should use.${accounts.length ? '' : ' None is signed in on this computer: run <code>copilot login</code> or <code>gh auth login</code>, or paste a token.'}</p>` +
      `<div class="chat-accounts">${accounts.map((a) => `<button type="button" class="btn" data-id="${esc(a.id)}">${esc(a.login)}<span class="chat-acc-src">${esc(a.source)}${a.plan ? ` · ${esc(a.plan)}` : ''}</span></button>`).join('')}` +
      `<button type="button" class="chat-link" data-act="token">Use a token</button></div>` +
      `<form class="chat-token" hidden><input type="password" class="chat-field" placeholder="GitHub token (gh auth token)" autocomplete="off" aria-label="GitHub token">` +
      `<label class="check-label"><input type="checkbox" class="check"> Remember on this computer</label><button type="submit" class="btn btn-ink">Sign in</button><p class="chat-note"></p></form></div>`;
    el.querySelectorAll('[data-id]').forEach((b) => (b.onclick = () => Chat.chooseAccount(b.dataset.id).catch((e) => alert(e.message))));
    const form = el.querySelector('.chat-token');
    el.querySelector('[data-act="token"]').onclick = () => { form.hidden = !form.hidden; if (!form.hidden) form.querySelector('input').focus(); };
    form.onsubmit = (e) => {
      e.preventDefault();
      const [tok, rem] = form.querySelectorAll('input');
      form.querySelector('.chat-note').textContent = 'Checking…';
      Chat.addToken(tok.value.trim(), rem.checked).catch((err) => { form.querySelector('.chat-note').textContent = err.message; });
    };
    return false;
  }

  // Model and thinking level, shared by the tab and the side panel
  async function renderModels(el) {
    let M;
    try { M = await Chat.loadModels(); } catch (e) { el.innerHTML = ''; return; }
    const cur = M.models.find((m) => m.id === Chat.settings.model);
    const efforts = cur ? cur.efforts : [];
    const label = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
    el.innerHTML = `<label class="chat-pick chat-pick-model"><span>Model</span><select data-k="model" title="Model">${M.models.map((m) => `<option value="${esc(m.id)}"${m.id === Chat.settings.model ? ' selected' : ''}>${esc(m.name || m.id)}</option>`).join('')}</select></label>` +
      (efforts.length ? `<label class="chat-pick chat-pick-effort"><span>Thinking</span><select data-k="effort" title="Thinking">${efforts.map((e) => `<option value="${esc(e)}"${e === Chat.settings.effort ? ' selected' : ''}>${esc(label[e] || e)}</option>`).join('')}</select></label>` : '');
    el.querySelectorAll('select').forEach((s) => s.addEventListener('change', () => {
      Chat.setSetting(s.dataset.k, s.value);
      if (s.dataset.k === 'model') { Chat.settings.effort = null; Chat.loadModels().then(() => renderModels(el)); }
    }));
  }

  // A composer: a growing text box and an Ask / Stop button
  function composer(form, { surface, onAsk }) {
    const input = form.querySelector('textarea'), btn = form.querySelector('button[type="submit"]');
    const autosize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; sync(); };
    const sync = () => {
      const busy = Chat.conversation(surface).busy;
      btn.textContent = busy ? 'Stop' : 'Ask';
      btn.classList.toggle('is-stop', busy);
      btn.disabled = !busy && !input.value.trim();
    };
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (Chat.conversation(surface).busy) { Chat.stop(surface); return; }
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      autosize();
      onAsk(text);
    });
    const box = form.matches('.chat-box') ? form : null;
    if (box) box.addEventListener('click', (e) => { if (!e.target.closest('select, button, textarea')) input.focus(); });
    Chat.onChange(sync);
    sync();
    return { input, set(text) { input.value = text; autosize(); input.focus(); }, sync };
  }

  // A suggested question: an outlined prompt that sends itself when picked
  const SEND = '<svg class="q-chip-go" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const qChip = (q) => `<button type="button" class="q-chip" data-q="${esc(q)}"><span>${esc(q)}</span>${SEND}</button>`;

  // Folds an element away (or back) by animating its row height; it stays out of the tab order while folded
  function fold(el, closed) {
    if (!el) return;
    el.classList.toggle('is-closed', closed);
    el.inert = closed;
  }

  // The reader's question, shown as their message in the conversation
  const question = (text, about) => `<div class="turn-msg"><h2 class="turn-q">${esc(text)}</h2>${about ? `<p class="turn-ctx">About: ${esc(about)}</p>` : ''}</div>`;

  // Keeps a streaming answer in view: follows the end while it grows (and briefly after, while its figures settle),
  // stops as soon as the reader scrolls up, and picks up again when they scroll back to the end. Programmatic scrolls
  // are instant: a smooth one fires scroll events part-way, which read as the reader leaving the end.
  function follower({ box, content, visible, busy }) {
    const el = box || document.scrollingElement, target = box || window;
    let on = true, ours = 0, until = 0;
    const atEnd = () => el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    const toEnd = () => { ours = performance.now(); target.scrollTo({ top: el.scrollHeight, behavior: 'instant' }); };
    target.addEventListener('scroll', () => { if (visible() && performance.now() - ours > 150) on = atEnd(); }, { passive: true });
    target.addEventListener('wheel', (e) => {
      if (e.deltaY < 0 && visible() && (box || !(e.target.closest && e.target.closest('#sideChat')))) on = false;
    }, { passive: true });
    new ResizeObserver(() => { if (on && visible() && (busy() || performance.now() < until)) toEnd(); }).observe(content);
    return {
      stop() { on = false; until = 0; },
      start() { on = true; until = 0; toEnd(); },
      settle() { until = performance.now() + 2500; if (on && visible()) toEnd(); },
    };
  }

  // "Answered 8 Nov 2026, 3:40 pm": when a saved answer was given
  const answered = (iso) => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(+d) ? `Answered ${d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}` : '';
  };
  // Draws a saved chat into a conversation log and readies the conversation to continue it: the next question resumes
  // its Copilot session, or starts one with what was asked and answered so far
  function loadChat(surface, log, data) {
    Chat.reset(surface);
    log.querySelectorAll('.turn').forEach((t) => t.remove());
    data.turns.forEach((t) => {
      const sec = document.createElement('section');
      sec.className = 'turn';
      sec.innerHTML = question(t.question, t.about || '');
      log.appendChild(sec);
      try { Chat.replay(sec, surface, t.events, answered(t.created_at)); } catch (e) { console.error(e); }
    });
    const c = Chat.conversation(surface), last = data.turns.length ? Math.max(...data.turns.map((t) => t.idx)) + 1 : 0;
    c.history = { id: data.chat.id, turns: last, origin: data.chat.origin, folder_id: data.chat.folder_id };
    c.resume = { session_id: data.chat.session_id || null, transcript: Chat.transcript(data.turns) };
    Chat.lastSurface = surface;
    Chat.historyChanged();
  }

  Chat.ui = { renderAccount, renderModels, composer, qChip, fold, question, follower, loadChat, answered };

  // ---- the tab --------------------------------------------------------------------------------------------------------
  function init() {
    const view = $('view-ask'), log = $('askLog'), acct = $('askAccount'), models = $('askModels');
    if (!view) return;
    let role = 0, pending = null;
    const hasTurns = () => !!log.querySelector('.turn');
    const roles = $('askRoles'), starters = $('askStarters');

    function renderStarters() {
      roles.innerHTML = STARTERS.map(([r], i) => `<button type="button" class="ask-role${i === role ? ' on' : ''}" aria-pressed="${i === role}" data-i="${i}">${esc(r)}</button>`).join('');
      starters.innerHTML = STARTERS[role][1].map((q) => qChip(q)).join('');
    }
    // Before the first question: the suggested questions; after it, a follow-up box
    function syncStart() {
      const started = hasTurns();
      fold($('askStart'), started);
      fold($('askRolesFold'), started);
      view.classList.toggle('has-turns', started);
      comp.input.placeholder = started ? 'Ask a follow-up question' : 'Ask a question about hospitals, states or measures';
    }
    roles.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      role = +b.dataset.i;
      renderStarters();
      const on = roles.querySelector(`[data-i="${role}"]`);
      if (on) on.focus({ preventScroll: true });
    });
    starters.addEventListener('click', (e) => { const b = e.target.closest('[data-q]'); if (b) ask(b.dataset.q); });

    async function refresh() {
      const ok = await renderAccount(acct);
      view.classList.toggle('is-signed-in', ok);
      if (ok) await renderModels(models); else models.innerHTML = '';
      $('askForm').hidden = !ok;
      if (ok && pending) { const p = pending; pending = null; ask(p.text, p.context, p.about); }
    }

    const follow = follower({ content: log, visible: () => !view.hidden, busy: () => Chat.conversation('ask').busy });
    // The dock gets a rule above it only while it sits over the conversation (its resting place is below the window)
    new IntersectionObserver(([e]) => view.classList.toggle('dock-stuck', !e.isIntersecting), { rootMargin: '0px 0px 6px 0px' }).observe($('askDockEnd'));

    // A follow-up that arrives while an answer is still coming (a right-click question, say) waits for it to finish
    async function ask(text, context, about) {
      if (!view.classList.contains('is-signed-in') || Chat.conversation('ask').busy) { pending = { text, context, about }; return; }
      const turn = document.createElement('section');
      turn.className = 'turn';
      turn.innerHTML = question(text, about);
      log.appendChild(turn);
      syncStart();
      follow.start();
      // What was right-clicked, and the live state of what the reader has open
      const sent = Chat.contextFor ? Chat.contextFor('ask', context || '') : { context };
      await Chat.ask({ surface: 'ask', text, context: sent.context, about, host: turn });
      follow.settle();
    }
    const comp = composer($('askForm'), { surface: 'ask', onAsk: (t) => ask(t) });

    $('askNew').addEventListener('click', () => {
      Chat.reset('ask');
      Chat.historyChanged();
      log.querySelectorAll('.turn').forEach((t) => t.remove());
      syncStart();
      window.scrollTo({ top: 0, behavior: App.reduceMotion ? 'instant' : 'smooth' });
      comp.input.focus({ preventScroll: true });
    });
    document.addEventListener('chat-follow-up', (e) => { if (e.detail.surface === 'ask') ask(e.detail.text, e.detail.context, e.detail.about); });

    // From the quick chat's "Open in Ask your data": its answers move here and its conversation carries on, saved
    // under the same chat
    Chat.openAsk = function ({ turns, chatId, history, sessionId } = {}) {
      if (turns && turns.length) {
        Chat.reset('ask');
        log.querySelectorAll('.turn').forEach((t) => t.remove());
        turns.forEach((n) => log.appendChild(n));
        const c = Chat.conversation('ask');
        c.id = chatId || null;
        c.adopt = !!chatId;
        c.history = history || null;
        c.sessionId = sessionId || null;
        Chat.historyChanged();
      }
      Chat.lastSurface = 'ask';
      if (location.hash !== '#ask') location.hash = '#ask';
      syncStart();
      setTimeout(() => { follow.start(); comp.input.focus({ preventScroll: true }); }, 80);
    };

    // A saved chat, opened from the history: drawn as it was answered, then continued here
    Chat.openChat = async function (id) {
      const store = Chat.store();
      if (!store) return;
      if (Chat.conversation('ask').busy) Chat.stop('ask');
      const data = await store.getChat(id);
      follow.stop();
      loadChat('ask', log, data);
      Chat.lastSurface = 'ask';
      if (location.hash !== '#ask') location.hash = '#ask';
      syncStart();
      requestAnimationFrame(() => {
        const turns = log.querySelectorAll('.turn');
        const last = turns[turns.length - 1];
        const bar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bar-h')) || 56;
        if (last) window.scrollTo({ top: last.getBoundingClientRect().top + window.scrollY - bar - 24, behavior: 'instant' });
        comp.input.focus({ preventScroll: true });
      });
    };
    Chat.newAskChat = () => $('askNew').click();

    Chat.onChange(() => {
      if (!Chat.login) refresh();
      else if (pending && !Chat.conversation('ask').busy && view.classList.contains('is-signed-in')) { const p = pending; pending = null; ask(p.text, p.context, p.about); }
    });
    renderStarters();
    syncStart();
    refresh();
  }

  Chat.ready.then((ok) => {
    const tab = $('tab-ask'), note = $('askUnavailable');
    if (!ok) { if (note) note.hidden = false; return; }
    if (tab) { tab.hidden = false; window.dispatchEvent(new Event('resize')); }
    document.querySelectorAll('[data-chat-only]').forEach((el) => { el.hidden = false; });
    if (note) note.remove();
    $('askReady').hidden = false;
    init();
  });
})();
