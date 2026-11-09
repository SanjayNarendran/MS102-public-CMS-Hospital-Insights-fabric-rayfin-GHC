/* Your chats: every conversation is saved with its answers (assets/js/chat/chat.js, Chat.store()), and listed here,
   beside the Ask your data conversation, in folders that nest. Chats move by drag and drop or a menu's "Move to", get
   renamed, archived (the Archive shows the same folders) and deleted. Opening one draws it as it was answered and the
   next question continues it. The quick chat's recent-chats menu is here too. */
(function () {
  'use strict';
  const App = window.App, Chat = window.Chat;
  if (!App || !Chat) return;
  const esc = App.esc;
  const $ = (id) => document.getElementById(id);
  const store = { get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };

  const ICON = {
    chev: '<svg class="hs-chev" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    folder: '<svg class="hs-ico" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-10Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    quick: '<svg class="hs-ico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M7.998 15.035c-4.562 0-7.873-2.914-7.998-3.749V9.338c.085-.628.677-1.686 1.588-2.065.013-.07.024-.143.036-.218.029-.183.06-.384.126-.612-.201-.508-.254-1.084-.254-1.656 0-.87.128-1.769.693-2.484.579-.733 1.494-1.124 2.724-1.261 1.206-.134 2.262.034 2.944.765.05.053.096.108.139.165.044-.057.094-.112.143-.165.682-.731 1.738-.899 2.944-.765 1.23.137 2.145.528 2.724 1.261.566.715.693 1.614.693 2.484 0 .572-.053 1.148-.254 1.656.066.228.098.429.126.612.012.076.024.148.037.218.924.385 1.522 1.471 1.591 2.095v1.872c0 .766-3.351 3.795-8.002 3.795Zm0-1.485c2.28 0 4.584-1.11 5.002-1.433V7.862l-.023-.116c-.49.21-1.075.291-1.727.291-1.146 0-2.059-.327-2.71-.991A3.222 3.222 0 0 1 8 6.303a3.24 3.24 0 0 1-.544.743c-.65.664-1.563.991-2.71.991-.652 0-1.236-.081-1.727-.291l-.023.116v4.255c.419.323 2.722 1.433 5.002 1.433Z"/></svg>',
    more: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="6" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="18" cy="12" r="1.6" fill="currentColor"/></svg>',
  };

  let data = { folders: [], chats: [] }, loaded = false, failed = '', query = '';
  const opened = new Set(JSON.parse(store.get('cms-hs-open', '[]') || '[]'));
  const saveOpen = () => store.set('cms-hs-open', JSON.stringify([...opened]));

  // "2 h", "Yesterday", "Tue", "8 Nov", "8 Nov 2025"
  function when(iso) {
    const d = new Date(iso), now = new Date();
    if (Number.isNaN(+d)) return '';
    const mins = (now - d) / 60000;
    if (mins < 1) return 'Now';
    if (mins < 60) return `${Math.floor(mins)} min`;
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
    const days = Math.round((day(now) - day(d)) / 86400000);
    if (days === 0) return `${Math.floor(mins / 60)} h`;
    if (days === 1) return 'Yesterday';
    if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
    return d.toLocaleDateString(undefined, d.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
  }
  const currentId = () => {
    const c = Chat.conversation('ask');
    return c.history ? c.history.id : null;
  };
  const folderById = (id) => data.folders.find((f) => f.id === id);
  const kidsOf = (id) => data.folders.filter((f) => (f.parent_id || null) === (id || null))
    .sort((a, b) => (a.kind === 'quick') - (b.kind === 'quick') || a.name.localeCompare(b.name));
  const descendants = (id) => { const out = new Set(), todo = [id]; while (todo.length) { const c = todo.pop(); kidsOf(c).forEach((f) => { if (!out.has(f.id)) { out.add(f.id); todo.push(f.id); } }); } return out; };
  const matches = (c) => !query || (c.title || '').toLowerCase().includes(query);

  // ---- loading -----------------------------------------------------------------------------------------------------------
  let pending = null;
  async function load() {
    const s = Chat.store();
    if (!s) return;
    try { data = await s.list(); failed = ''; } catch (e) { failed = e.message || String(e); }
    loaded = true;
    render();
    renderRecent();
  }
  const reload = () => { clearTimeout(pending); pending = setTimeout(load, 120); };
  document.addEventListener('chat-history', reload);

  // ---- the tree ----------------------------------------------------------------------------------------------------------
  function render() {
    const tree = $('hsTree'), arch = $('hsArchive');
    if (!tree) return;
    if (failed) { tree.innerHTML = `<p class="hs-empty">Couldn't load your chats: ${esc(failed)}</p>`; return; }
    const cur = currentId(), reveal = openAbove(cur);
    tree.innerHTML = branch(null, false, 0) || `<p class="hs-empty">${query ? 'No chats match.' : loaded ? 'Your chats appear here as you ask questions.' : 'Loading…'}</p>`;
    arch.innerHTML = branch(null, true, 0) || `<p class="hs-empty">${query ? 'No archived chats match.' : 'Archived chats appear here, in their folders.'}</p>`;
    const n = data.chats.filter((c) => c.archived).length;
    $('hsArchCount').textContent = n ? String(n) : '';
    document.querySelectorAll('.hs-chat').forEach((el) => el.setAttribute('aria-current', String(el.dataset.cid === cur)));
    if (reveal) scrollToRow(cur);
  }
  // The current chat is always in sight: when a chat becomes current (maximized from Quick chat, opened from the panel's
  // recent chats or from the list), the folders above it open, and the archive if it's archived. Once per chat, so a
  // folder folded by hand afterwards stays folded. A chat whose first answer is still saving is found on the next load.
  let revealed = null;
  function openAbove(cur) {
    if (!cur) { revealed = null; return false; }
    const c = cur !== revealed && data.chats.find((x) => x.id === cur);
    if (!c) return false;
    revealed = cur;
    const pre = c.archived ? 'a' : '', seen = new Set();
    for (let f = folderById(c.folder_id); f && !seen.has(f.id); f = folderById(f.parent_id)) { seen.add(f.id); opened.add(pre + f.id); }
    if (seen.size) saveOpen();
    if (c.archived) { $('hsArchive').hidden = false; $('hsArchToggle').setAttribute('aria-expanded', 'true'); }
    return true;
  }
  // Scrolls the list, not the page, so the row is in view
  function scrollToRow(id) {
    const row = [...document.querySelectorAll('.hs-chat')].find((el) => el.dataset.cid === id);
    const list = row && row.closest('.hs-tree');
    if (!list || !list.clientHeight) return;
    const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    if (top >= list.scrollTop && top + row.offsetHeight <= list.scrollTop + list.clientHeight) return;
    list.scrollTo({ top: Math.max(0, top - (list.clientHeight - row.offsetHeight) / 2), behavior: App.reduceMotion ? 'instant' : 'smooth' });
  }
  // A folder level: its folders (the archive shows only those holding archived chats), then its chats, newest first
  function branch(parent, archived, depth) {
    const chats = data.chats.filter((c) => !!c.archived === archived && (c.folder_id || null) === parent && matches(c));
    const folders = kidsOf(parent).map((f) => folderHtml(f, archived, depth)).filter(Boolean).join('');
    return folders + chats.map((c) => chatHtml(c, archived, depth)).join('');
  }
  function count(fid, archived) {
    const ids = new Set([fid, ...descendants(fid)]);
    return data.chats.filter((c) => !!c.archived === archived && ids.has(c.folder_id) && matches(c)).length;
  }
  function folderHtml(f, archived, depth) {
    const n = count(f.id, archived);
    if ((archived || query) && !n) return '';
    const open = query ? true : opened.has(`${archived ? 'a' : ''}${f.id}`);
    return `<div class="hs-folder${open ? ' is-open' : ''}" data-fid="${esc(f.id)}" data-arch="${archived ? 1 : 0}" role="treeitem" aria-expanded="${open}">
      <div class="hs-row hs-frow" draggable="${archived ? 'false' : 'true'}" style="--d:${depth}" tabindex="0">
        <span class="hs-twist">${ICON.chev}</span>${f.kind === 'quick' ? ICON.quick : ICON.folder}<span class="hs-name">${esc(f.name)}</span>
        <span class="hs-n">${n || ''}</span><button type="button" class="hs-more" aria-label="Actions for ${esc(f.name)}" aria-haspopup="menu">${ICON.more}</button>
      </div>
      <div class="hs-kids" role="group">${open ? branch(f.id, archived, depth + 1) : ''}</div>
    </div>`;
  }
  function chatHtml(c, archived, depth) {
    return `<div class="hs-row hs-chat" data-cid="${esc(c.id)}" data-arch="${archived ? 1 : 0}" role="treeitem" draggable="true" style="--d:${depth}" tabindex="0"
      title="${esc(c.title)}"><span class="hs-title">${esc(c.title)}</span><span class="hs-when">${esc(when(c.updated_at))}</span>
      <button type="button" class="hs-more" aria-label="Actions for this chat" aria-haspopup="menu">${ICON.more}</button></div>`;
  }

  // ---- what you can do with a chat or a folder -------------------------------------------------------------------------
  const S = () => Chat.store();
  async function act(fn) {
    try { await fn(); } catch (e) { flash(e.message || String(e)); }
    closeMenu();
    load();
  }
  function flash(text) {
    const el = $('hsTree');
    if (!el) return;
    const p = document.createElement('p');
    p.className = 'hs-flash';
    p.textContent = text;
    el.parentNode.insertBefore(p, el);
    setTimeout(() => p.remove(), 4000);
  }
  async function openChat(id) {
    closeMenu();
    try { await Chat.openChat(id); } catch (e) { flash(e.message || String(e)); }
    render();
    foldAway();
  }
  function rename(row, kind, id, current, { onCancel } = {}) {
    const label = row.querySelector(kind === 'chat' ? '.hs-title' : '.hs-name');
    if (!label) return;
    const input = document.createElement('input');
    input.className = 'hs-edit';
    input.value = current;
    input.setAttribute('aria-label', kind === 'chat' ? 'Chat title' : 'Folder name');
    label.replaceWith(input);
    row.draggable = false;
    input.focus();
    input.select();
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (!keep && onCancel) act(onCancel);
      else if (keep && v && v !== current) act(() => (kind === 'chat' ? S().updateChat(id, { title: v }) : S().updateFolder(id, { name: v })));
      else render();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  }
  async function newFolder(parentId) {
    try {
      const f = await S().createFolder('New folder', parentId || null);
      if (parentId) { opened.add(parentId); saveOpen(); }
      await load();
      const row = document.querySelector(`.hs-folder[data-fid="${f.id}"][data-arch="0"] > .hs-frow`);
      // Esc while naming it takes the new folder away again
      if (row) { row.scrollIntoView({ block: 'nearest' }); rename(row, 'folder', f.id, f.name, { onCancel: () => S().deleteFolder(f.id) }); }
    } catch (e) { flash(e.message || String(e)); }
  }

  // ---- the menu ----------------------------------------------------------------------------------------------------------
  let menu = null, menuBtn = null, menuPlace = null;
  function closeMenu() { if (menu) { menu.remove(); menu = menuBtn = menuPlace = null; } }
  // When the list or the page scrolls, an open menu moves with its row, and closes once the list has scrolled the row
  // out of sight
  function followMenu() {
    if (!menu) return;
    const r = menuBtn.getBoundingClientRect(), list = menuBtn.closest('.hs-tree'), lr = list && list.getBoundingClientRect();
    if (!menuBtn.isConnected || (lr && (r.bottom < lr.top || r.top > lr.bottom))) closeMenu();
    else menuPlace();
  }
  function openMenu(btn, items) {
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'hs-menu';
    menu.setAttribute('role', 'menu');
    document.body.appendChild(menu);
    const draw = (list) => {
      menu.innerHTML = list.map((it, i) => (it.sep ? '<div class="hs-menu-sep" role="separator"></div>'
        : it.note ? `<p class="hs-menu-note">${esc(it.note)}</p>`
          : `<button type="button" role="menuitem" class="hs-mi${it.danger ? ' is-danger' : ''}${it.depth ? ' is-indent' : ''}" style="--d:${it.depth || 0}" data-i="${i}"${it.disabled ? ' disabled' : ''}>${esc(it.label)}</button>`)).join('');
      menu.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation();
        const it = list[+b.dataset.i];
        if (it.sub) draw(it.sub()); else if (it.run) it.run();
      }));
      const first = menu.querySelector('.hs-mi:not([disabled])');
      if (first) first.focus({ preventScroll: true });
      place();
    };
    const place = () => {
      const r = btn.getBoundingClientRect(), w = menu.offsetWidth, h = menu.offsetHeight;
      let left = r.right - w, top = r.bottom + 4;
      if (left < 8) left = Math.min(window.innerWidth - w - 8, r.left);
      if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    };
    menuBtn = btn;
    menuPlace = place;
    draw(items);
    menu.addEventListener('keydown', (e) => {
      const btns = [...menu.querySelectorAll('.hs-mi:not([disabled])')], i = btns.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); (btns[i + 1] || btns[0]).focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); (btns[i - 1] || btns[btns.length - 1]).focus(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); btn.focus(); }
    });
  }
  // Every folder, indented, as places to move to; a folder can't go inside itself
  function moveTargets(onPick, exclude) {
    const out = [{ label: 'Top level (no folder)', run: () => onPick(null) }];
    const walk = (parent, depth) => kidsOf(parent).forEach((f) => {
      if (exclude && exclude.has(f.id)) return;
      out.push({ label: f.name, depth, run: () => onPick(f.id) });
      walk(f.id, depth + 1);
    });
    walk(null, 0);
    return out;
  }
  function chatMenu(btn, c) {
    const archived = !!c.archived;
    const confirm = () => [{ note: 'Delete this chat and its answers? This can’t be undone.' },
      { label: 'Delete', danger: true, run: () => act(async () => { await S().deleteChat(c.id); if (currentId() === c.id) Chat.newAskChat(); }) },
      { label: 'Cancel', run: closeMenu }];
    openMenu(btn, [
      { label: 'Open', run: () => openChat(c.id) },
      { label: 'Rename', run: () => { closeMenu(); rename(btn.closest('.hs-chat'), 'chat', c.id, c.title); } },
      { label: 'Move to…', sub: () => moveTargets((fid) => act(() => S().updateChat(c.id, { folder_id: fid })), null) },
      archived ? { label: 'Restore from archive', run: () => act(() => S().updateChat(c.id, { archived: false })) }
        : { label: 'Archive', run: () => act(() => S().updateChat(c.id, { archived: true })) },
      { sep: true },
      { label: 'Delete…', danger: true, sub: confirm },
    ]);
  }
  function folderMenu(btn, f, archived) {
    const confirm = () => [{ note: `Delete “${f.name}”? Its chats and folders move up a level.` },
      { label: 'Delete folder', danger: true, run: () => act(() => S().deleteFolder(f.id)) },
      { label: 'Cancel', run: closeMenu }];
    openMenu(btn, archived ? [
      { label: 'Restore all its chats', run: () => act(() => S().updateFolder(f.id, { archived: false })) },
    ] : [
      { label: 'New folder inside', run: () => { closeMenu(); newFolder(f.id); } },
      { label: 'Rename', run: () => { closeMenu(); rename(btn.closest('.hs-frow'), 'folder', f.id, f.name); } },
      { label: 'Move to…', sub: () => moveTargets((pid) => act(() => S().updateFolder(f.id, { parent_id: pid })), new Set([f.id, ...descendants(f.id)])) },
      { label: 'Archive all its chats', run: () => act(() => S().updateFolder(f.id, { archived: true })) },
      { sep: true },
      { label: 'Delete folder…', danger: true, sub: confirm },
    ]);
  }

  // ---- clicks, keys and drag and drop -----------------------------------------------------------------------------------
  function wireTree(el) {
    el.addEventListener('click', (e) => {
      const more = e.target.closest('.hs-more');
      const frow = e.target.closest('.hs-frow'), chat = e.target.closest('.hs-chat');
      if (e.target.closest('.hs-edit')) return;
      if (more) {
        e.stopPropagation();
        if (chat) chatMenu(more, data.chats.find((c) => c.id === chat.dataset.cid));
        else if (frow) { const fe = frow.parentNode; folderMenu(more, folderById(fe.dataset.fid), fe.dataset.arch === '1'); }
        return;
      }
      if (chat) openChat(chat.dataset.cid);
      else if (frow) toggleFolder(frow.parentNode);
    });
    el.addEventListener('keydown', (e) => {
      const row = e.target.closest('.hs-row');
      // keys on a row's … button belong to the button, which opens its menu
      if (!row || e.target.closest('.hs-edit, .hs-more')) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.classList.contains('hs-chat') ? openChat(row.dataset.cid) : toggleFolder(row.parentNode); }
      if (e.key === 'F2') { e.preventDefault(); row.querySelector('.hs-more').click(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const rows = [...document.querySelectorAll('#askSide .hs-row')].filter((r) => r.offsetParent);
        const i = rows.indexOf(row), next = rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
        if (next) next.focus();
      }
    });
    // Drag a chat or a folder onto a folder, or onto the top of the list to take it out of its folder
    el.addEventListener('dragstart', (e) => {
      const chat = e.target.closest('.hs-chat'), frow = e.target.closest('.hs-frow');
      if (chat) { e.dataTransfer.setData('text/x-cms-chat', chat.dataset.cid); dragging = { kind: 'chat', id: chat.dataset.cid, archived: chat.dataset.arch === '1' }; }
      else if (frow) { e.dataTransfer.setData('text/x-cms-folder', frow.parentNode.dataset.fid); dragging = { kind: 'folder', id: frow.parentNode.dataset.fid }; }
      else return;
      e.dataTransfer.effectAllowed = 'move';
      document.documentElement.classList.add('hs-dragging');
    });
    el.addEventListener('dragend', () => { dragging = null; document.documentElement.classList.remove('hs-dragging'); clearDrop(); });
    el.addEventListener('scroll', followMenu, { passive: true });
  }
  // What is being dragged (the drag's data can't be read until the drop)
  let dragging = null;
  const clearDrop = () => document.querySelectorAll('.is-drop').forEach((n) => n.classList.remove('is-drop'));
  const dragKind = (e) => (e.dataTransfer.types.includes('text/x-cms-chat') ? 'chat' : e.dataTransfer.types.includes('text/x-cms-folder') ? 'folder' : null);
  // A folder can't go into itself or a folder inside it
  const refused = (t) => !!(dragging && dragging.kind === 'folder' && t && t.fid && (t.fid === dragging.id || descendants(dragging.id).has(t.fid)));
  function dropZone(el, target) {
    el.addEventListener('dragover', (e) => {
      const kind = dragKind(e), t = target(e);
      if (!kind || t === undefined || (t && t.archive && kind === 'folder') || refused(t)) { if (refused(t)) clearDrop(); return; }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearDrop();
      (t ? t.el : el).classList.add('is-drop');
    });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) clearDrop(); });
    el.addEventListener('drop', (e) => {
      const kind = dragKind(e), t = target(e);
      if (!kind || t === undefined || refused(t)) return;
      e.preventDefault();
      clearDrop();
      const chatId = e.dataTransfer.getData('text/x-cms-chat'), folderId = e.dataTransfer.getData('text/x-cms-folder');
      if (t && t.archive) { if (chatId) act(() => S().updateChat(chatId, { archived: true })); return; }
      const fid = t ? t.fid : null;
      // An archived chat dragged into your chats comes out of the archive, into that folder
      const restore = !!(dragging && dragging.kind === 'chat' && dragging.archived);
      if (chatId) act(() => S().updateChat(chatId, restore ? { folder_id: fid, archived: false } : { folder_id: fid }));
      else if (folderId && folderId !== fid) act(() => S().updateFolder(folderId, { parent_id: fid }));
    });
  }
  function toggleFolder(fe) {
    const key = `${fe.dataset.arch === '1' ? 'a' : ''}${fe.dataset.fid}`;
    if (opened.has(key)) opened.delete(key); else opened.add(key);
    saveOpen();
    render();
    const row = document.querySelector(`.hs-folder[data-fid="${fe.dataset.fid}"][data-arch="${fe.dataset.arch}"] > .hs-frow`);
    if (row) row.focus({ preventScroll: true });
  }

  // ---- the quick chat's recent chats --------------------------------------------------------------------------------------
  function renderRecent() {
    const el = $('scRecent');
    if (!el || el.hidden) return;
    const recent = data.chats.filter((c) => !c.archived).slice(0, 8);
    el.innerHTML = `<div class="sc-recent-head">Recent chats</div>${recent.length ? recent.map((c) => `<button type="button" role="menuitem" class="sc-recent-item" data-cid="${esc(c.id)}"><span>${esc(c.title)}</span><span class="hs-when">${esc(when(c.updated_at))}</span></button>`).join('')
      : '<p class="hs-empty">Your chats appear here as you ask questions.</p>'}<button type="button" role="menuitem" class="sc-recent-all" data-all="1">All chats, folders and the archive</button>`;
  }
  function initRecent() {
    const btn = $('scHistory'), el = $('scRecent');
    if (!btn || !el) return;
    btn.hidden = false;
    const close = () => { el.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', () => {
      if (!el.hidden) { close(); return; }
      el.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      renderRecent();
      load();
    });
    el.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      close();
      if (b.dataset.all) { location.hash = '#ask'; return; }
      try { await Chat.openInPanel(b.dataset.cid); } catch (err) { console.warn(err); }
    });
    document.addEventListener('pointerdown', (e) => { if (!el.hidden && !el.contains(e.target) && !btn.contains(e.target)) close(); }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.hidden) { e.preventDefault(); close(); btn.focus(); } });
  }

  // ---- the sidebar ------------------------------------------------------------------------------------------------------
  // Wide pages: the list beside the conversation, shown or hidden as last chosen. Narrow pages (the same 980 px as the
  // layout): it folds open above the conversation from the button by the title, and folds away once a chat is picked.
  const page = $('page');
  const narrow = () => !!page && page.clientWidth <= 980;
  let wideShown = store.get('cms-hs-shown', '1') === '1', foldOpen = false, wasNarrow = null;
  function applyShown() {
    const shell = $('askShell'), side = $('askSide'), on = narrow() ? foldOpen : wideShown;
    shell.classList.toggle('hs-hidden', !on);
    side.inert = !on;
    ['hsShow', 'hsOpen', 'hsCollapse'].forEach((id) => $(id).setAttribute('aria-expanded', String(on)));
  }
  function setShown(on) {
    if (narrow()) foldOpen = on;
    else { wideShown = on; store.set('cms-hs-shown', on ? '1' : '0'); }
    applyShown();
  }
  const foldAway = () => { if (narrow() && foldOpen) setShown(false); };

  function init() {
    const side = $('askSide');
    if (!side || !Chat.store()) return;
    side.hidden = false;
    $('hsRail').hidden = false;
    $('view-ask').classList.add('has-history');
    wasNarrow = narrow();
    applyShown();
    if (page && window.ResizeObserver) new ResizeObserver(() => { if (narrow() !== wasNarrow) { wasNarrow = narrow(); applyShown(); } }).observe(page);
    $('hsCollapse').addEventListener('click', () => { setShown(false); (narrow() ? $('hsOpen') : $('hsShow')).focus({ preventScroll: true }); });
    $('hsShow').addEventListener('click', () => { setShown(true); $('hsNew').focus({ preventScroll: true }); });
    $('hsOpen').addEventListener('click', () => { setShown(!foldOpen); if (foldOpen) $('hsNew').focus({ preventScroll: true }); });
    $('hsNew').addEventListener('click', () => { Chat.newAskChat(); render(); foldAway(); });
    $('hsRailNew').addEventListener('click', () => { Chat.newAskChat(); render(); });
    $('hsFolderNew').addEventListener('click', () => newFolder(null));
    $('hsSearch').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); render(); });
    $('hsArchToggle').addEventListener('click', () => {
      const open = $('hsArchive').hidden;
      $('hsArchive').hidden = !open;
      $('hsArchToggle').setAttribute('aria-expanded', String(open));
    });
    wireTree($('hsTree'));
    wireTree($('hsArchive'));
    // Drop targets: a folder row (into it), the empty part of the list or its head (out of any folder), Archive (archive it)
    dropZone($('hsTree'), (e) => {
      const fe = e.target.closest('.hs-folder[data-arch="0"]');
      return fe ? { fid: fe.dataset.fid, el: fe.querySelector('.hs-frow') } : null;
    });
    dropZone($('hsArchToggle'), () => ({ archive: true, el: $('hsArchToggle') }));
    document.addEventListener('pointerdown', (e) => { if (menu && !menu.contains(e.target)) closeMenu(); }, true);
    window.addEventListener('scroll', followMenu, { passive: true });
    window.addEventListener('hashchange', () => { if (location.hash === '#ask') load(); });
    initRecent();
    load();
  }

  Chat.ready.then((ok) => { if (ok) init(); });
})();
