// The Rayfin bridge: what Ask your data needs from the Fabric app, for a page that has no bundler of its own.
// Bundled by scripts/build.mjs into dist/assets/rayfin-bridge.js and loaded before assets/js/chat/chat.js, in the
// Fabric build only. It exposes window.RayfinBridge:
//   ready     resolves true once there is a Rayfin session (inherited inside the Fabric portal, or restored)
//   signIn()  the Fabric sign-in popup, from a click
//   call()    invokes one of the app's Rayfin Functions (chatTicket, dax, chatPayload)
//   history   Ask your data's saved chats, with the same calls as the local server's store (assets/js/chat/chat.js):
//             folders, chats and questions in Rayfin Data (rayfin/data/, each user sees only their own), each answer's
//             events in the chat lakehouse through the chatPayload function
// The app's address and keys come from rayfin.config.json, which `rayfin up` writes next to index.html.
import { RayfinClient, resolveRayfinConfig } from '@microsoft/rayfin-client';
import { ensureSignedInWithFabric, initEmbeddedAuth } from '@microsoft/rayfin-auth-provider-fabric';

let client = null;
let options = null;

const usable = (session) => session && session.isAuthenticated && !session.isAnonymous;

async function start() {
  const resolved = await resolveRayfinConfig({});
  if (!resolved.baseUrl || !resolved.publishableKey) return false;
  client = new RayfinClient({ baseUrl: resolved.baseUrl, publishableKey: resolved.publishableKey, authStorage: true,
    runtimeConfig: resolved.runtimeConfig });
  const { workspaceId, itemId, portalUrl } = client.runtimeConfig || {};
  if (!workspaceId || !itemId || !portalUrl) return false;
  options = { workspaceId, projectId: itemId, fabricPortalUrl: portalUrl, returnOrigin: window.location.origin };
  if (await initEmbeddedAuth(client.auth, options)) return true;
  if (usable(client.auth.getSession())) return true;
  if (client.auth.getSession().isAnonymous) await client.auth.signOut();
  if (client.auth.hasRefreshToken()) {
    try {
      await client.auth.refreshSession();
      if (usable(client.auth.getSession())) return true;
    } catch {
      // fall through: the page offers the sign-in button
    }
  }
  return false;
}

let ready = start().catch((error) => {
  console.warn('[rayfin-bridge]', error);
  return false;
});

window.RayfinBridge = {
  get ready() {
    return ready;
  },
  async signIn() {
    await ready;
    if (!client) throw new Error('This app is not configured for Fabric sign-in.');
    await ensureSignedInWithFabric(client.auth, options);
    ready = Promise.resolve(true);
  },
  async call(name, args) {
    if (!(await ready)) throw new Error('Sign in with your Fabric account first.');
    const fn = client.functions[name];
    if (!fn) throw new Error(`The app has no function ${name}.`);
    return fn.invoke(args === undefined ? undefined : args, { timeoutMs: 240000 });
  },
};

// ---- saved chats ----------------------------------------------------------------------------------------------------
const F_FOLDER = ['id', 'parent_id', 'name', 'kind', 'created_at', 'updated_at'];
const F_CHAT = ['id', 'folder_id', 'title', 'origin', 'archived', 'archived_at', 'session_id', 'model', 'turns', 'created_at', 'updated_at'];
const F_TURN = ['id', 'chat_id', 'idx', 'question', 'about', 'preview', 'status', 'secs', 'created_at'];
const newId = () => crypto.randomUUID();
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
};
const titleFor = (q) => {
  const t = String(q || '').replace(/\s+/g, ' ').trim().replace(/[?.!]+$/, '');
  if (t.length <= 60) return t || 'New chat';
  return `${t.slice(0, 60).replace(/\s+\S*$/, '').replace(/[,;:]$/, '')}…`;
};

async function me() {
  if (!(await ready)) throw new Error('Sign in with your Fabric account first.');
  const s = client.auth.getSession();
  if (!s || !s.user) throw new Error('Sign in with your Fabric account first.');
  return s.user.id;
}
// Every page of a query (the Data API returns 100 rows a page)
async function all(query) {
  const out = [];
  let after = null;
  for (let i = 0; i < 100; i++) {
    let q = query().first(500);
    if (after) q = q.after(after);
    const page = await q.executePaginated();
    out.push(...page.items);
    if (!page.hasNextPage) break;
    after = page.endCursor;
  }
  return out;
}
async function payload(op, chatId, idx, body = '') {
  const raw = await window.RayfinBridge.call('chatPayload', { op, chatId, idx, body });
  const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!r || !r.ok) throw new Error((r && r.error) || 'Could not reach the chat lakehouse.');
  return r;
}
const listFolders = () => all(() => client.data.ChatFolder.select(F_FOLDER).orderBy({ name: 'asc' }));
const listChats = () => all(() => client.data.ChatThread.select(F_CHAT).orderBy({ updated_at: 'desc' }));
const subtree = (folders, id) => {
  const out = new Set([id]);
  let grew = true;
  while (grew) { grew = false; folders.forEach((f) => { if (f.parent_id && out.has(f.parent_id) && !out.has(f.id)) { out.add(f.id); grew = true; } }); }
  return out;
};
async function quickFolder(user) {
  const found = (await listFolders()).find((f) => f.kind === 'quick');
  if (found) return found.id;
  const now = new Date(), f = { id: newId(), user_id: user, parent_id: null, name: 'Quick chats', kind: 'quick', created_at: now, updated_at: now };
  await client.data.ChatFolder.create(f);
  return f.id;
}

const history = {
  async list() {
    await me();
    const [folders, chats] = await Promise.all([listFolders(), listChats()]);
    return { folders, chats };
  },
  async createFolder(name, parentId) {
    const user = await me(), now = new Date();
    const f = { id: newId(), user_id: user, parent_id: parentId || null, name: clip(name, 120) || 'New folder', kind: 'user', created_at: now, updated_at: now };
    await client.data.ChatFolder.create(f);
    return f;
  },
  // patch: name; parent_id (null = the top level, '' or absent = unchanged); archived (every chat inside)
  async updateFolder(id, patch = {}) {
    await me();
    const now = new Date();
    if (patch.name != null) await client.data.ChatFolder.update({ id }, { name: clip(patch.name, 120), updated_at: now });
    if ('parent_id' in patch && patch.parent_id !== '') {
      if (patch.parent_id && subtree(await listFolders(), id).has(patch.parent_id)) throw new Error('A folder can’t go inside itself.');
      await client.data.ChatFolder.update({ id }, { parent_id: patch.parent_id || null, updated_at: now });
    }
    if (patch.archived != null) {
      const [folders, chats] = await Promise.all([listFolders(), listChats()]);
      const ids = subtree(folders, id);
      await Promise.all(chats.filter((c) => ids.has(c.folder_id)).map((c) =>
        client.data.ChatThread.update({ id: c.id }, { archived: !!patch.archived, archived_at: patch.archived ? now : null })));
    }
    return { id };
  },
  // Its chats and folders move up to its parent, so nothing is lost
  async deleteFolder(id) {
    await me();
    const [folders, chats] = await Promise.all([listFolders(), listChats()]);
    const f = folders.find((x) => x.id === id);
    if (!f) return { ok: true };
    const up = f.parent_id || null;
    await Promise.all([
      ...chats.filter((c) => c.folder_id === id).map((c) => client.data.ChatThread.update({ id: c.id }, { folder_id: up })),
      ...folders.filter((x) => x.parent_id === id).map((x) => client.data.ChatFolder.update({ id: x.id }, { parent_id: up })),
    ]);
    await client.data.ChatFolder.delete({ id });
    return { ok: true, moved_to: up };
  },
  async getChat(id) {
    await me();
    const chat = (await client.data.ChatThread.select(F_CHAT).where({ id: { eq: id } }).execute())[0];
    if (!chat) throw new Error('That chat no longer exists.');
    const turns = await all(() => client.data.ChatTurn.select(F_TURN).where({ chat_id: { eq: id } }).orderBy({ idx: 'asc' }));
    await Promise.all(turns.map(async (t) => {
      const r = await payload('get', id, t.idx).catch(() => ({ body: '' }));
      const body = r.body ? JSON.parse(r.body) : {};
      t.events = body.events || [];
      t.context = body.context || '';
    }));
    return { chat, turns };
  },
  // patch: title; folder_id (null = the top level, '' or absent = unchanged); archived
  async updateChat(id, patch = {}) {
    await me();
    const v = {};
    if (patch.title != null) v.title = clip(patch.title, 200);
    if ('folder_id' in patch && patch.folder_id !== '') v.folder_id = patch.folder_id || null;
    if (patch.archived != null) { v.archived = !!patch.archived; v.archived_at = patch.archived ? new Date() : null; }
    if (Object.keys(v).length) await client.data.ChatThread.update({ id }, v);
    return { id, ...v };
  },
  async deleteChat(id) {
    await me();
    const turns = await all(() => client.data.ChatTurn.select(['id']).where({ chat_id: { eq: id } }));
    await Promise.all(turns.map((t) => client.data.ChatTurn.delete({ id: t.id })));
    await client.data.ChatThread.delete({ id });
    await payload('delete', id, 0).catch(() => {});
    return { ok: true };
  },
  // One answered question: the first creates the chat (a quick chat goes to Quick chats); a new answer in an archived
  // chat restores it
  async saveTurn(id, chat = {}, turn = {}) {
    const user = await me(), now = new Date(), idx = Number(turn.idx) || 0;
    const put = payload('put', id, idx, JSON.stringify({ events: turn.events || [], context: turn.context || '' }));
    let thread = (await client.data.ChatThread.select(F_CHAT).where({ id: { eq: id } }).execute())[0];
    if (!thread) {
      let folder = chat.folder_id || null;
      if (!folder && chat.origin === 'panel') folder = await quickFolder(user);
      thread = { id, user_id: user, folder_id: folder, title: clip(chat.title || titleFor(turn.question), 200), origin: chat.origin === 'panel' ? 'panel' : 'ask',
        archived: false, archived_at: null, session_id: chat.session_id || null, model: chat.model || null, turns: 0, created_at: now, updated_at: now };
      await client.data.ChatThread.create(thread);
    }
    const existing = await all(() => client.data.ChatTurn.select(['id', 'idx']).where({ chat_id: { eq: id } }));
    await Promise.all(existing.filter((t) => t.idx === idx).map((t) => client.data.ChatTurn.delete({ id: t.id })));
    await client.data.ChatTurn.create({ id: newId(), user_id: user, chat_id: id, idx, question: clip(turn.question, 4000) || '…',
      about: clip(turn.about, 300) || null, preview: clip(turn.preview, 600) || null, status: clip(turn.status || 'done', 20),
      secs: Math.round(Number(turn.secs) || 0), created_at: now });
    const v = { turns: existing.filter((t) => t.idx !== idx).length + 1, updated_at: now, archived: false, archived_at: null };
    if (chat.session_id) v.session_id = chat.session_id;
    if (chat.model) v.model = chat.model;
    await client.data.ChatThread.update({ id }, v);
    await put;
    return { ...thread, ...v };
  },
};
window.RayfinBridge.history = history;
