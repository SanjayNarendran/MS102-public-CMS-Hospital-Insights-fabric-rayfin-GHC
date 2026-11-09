"""Saved chats: the same checks against the local store (DuckDB and files) or the Fabric one (Rayfin Data and the chat
lakehouse), through the page's own Chat.store(). Copilot isn't called; everything the checks create is deleted.

    .venv/bin/python copilot/dev/history_check.py                          # the local server at 127.0.0.1:8765
    .venv/bin/python copilot/dev/history_check.py --hosted https://<app>.webapp.fabricapps.net
                                                                           # the Fabric app (its capacity running)

The hosted run keeps a Chrome profile in ~/.cache/cms-history-check. The first time, it opens a Chrome window to sign
in with a Fabric account; later runs reuse that sign-in without a window.
"""
import argparse
import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

PROFILE = Path.home() / ".cache" / "cms-history-check"
CHANNEL = os.environ.get("CMS_TEST_BROWSER", "chrome")  # or msedge

CHECKS = r"""
async () => {
  await Chat.ready;
  const H = Chat.store(), log = [], ok = (name, cond, extra) => log.push([cond ? 'ok' : 'FAIL', name, extra ?? '']);
  if (!H) return [['FAIL', 'store', 'Chat.store() is null: no chat server, or not signed in to Fabric']];
  const t0 = performance.now(), ms = () => Math.round(performance.now() - t0);
  const ids = { chats: [], folders: [] };
  try {
    const before = await H.list();
    ok('list', Array.isArray(before.folders) && Array.isArray(before.chats), `${before.folders.length} folders, ${before.chats.length} chats`);

    const top = await H.createFolder('History check ' + new Date().toISOString().slice(11, 19)); ids.folders.push(top.id);
    const sub = await H.createFolder('Inner', top.id); ids.folders.push(sub.id);
    ok('nested folder', sub.parent_id === top.id);

    // a quick chat lands in Quick chats
    const quickId = crypto.randomUUID(); ids.chats.push(quickId);
    const events = [{ type: 'message', text: 'Lead sentence.', at: 0.4 }, { type: 'done', at: 3.1 }];
    const r1 = await H.saveTurn(quickId, { origin: 'panel', title: 'Explain this · Test metric', session_id: 's-1', model: 'm' },
      { idx: 0, question: 'Explain this', about: 'Test metric', preview: 'Lead sentence.', status: 'done', secs: 3, events, context: 'ctx' });
    const l1 = await H.list(), quick = l1.folders.find((f) => f.kind === 'quick');
    ok('quick chat in Quick chats', !!quick && l1.chats.find((c) => c.id === quickId)?.folder_id === quick.id);
    ok('first turn', r1.turns === 1);

    // a large answer (about 300 KB of events) in a nested folder, then a second turn
    const askId = crypto.randomUUID(); ids.chats.push(askId);
    const big = Array.from({ length: 600 }, (_, i) => ({ type: 'chart', fig: i, ui: { spec: 'x'.repeat(480) }, at: i / 10 }));
    let t = performance.now();
    await H.saveTurn(askId, { origin: 'ask', folder_id: sub.id }, { idx: 0, question: 'How many hospitals deliver babies in Minnesota?', events: big, secs: 40 });
    ok('save 300 KB answer', true, `${Math.round(performance.now() - t)} ms`);
    await H.saveTurn(askId, { origin: 'ask' }, { idx: 1, question: 'And in Colorado?', events, secs: 12 });
    t = performance.now();
    const g = await H.getChat(askId);
    ok('reopen', g.turns.length === 2 && g.turns[0].events.length === 600 && g.turns[1].events[0].text === 'Lead sentence.',
       `${g.turns.length} turns, ${g.turns[0].events.length} events, ${Math.round(performance.now() - t)} ms`);
    ok('chat record', g.chat.title.startsWith('How many hospitals') && g.chat.folder_id === sub.id && g.chat.turns === 2 && g.chat.origin === 'ask');

    await H.saveTurn(askId, {}, { idx: 1, question: 'And in Colorado, again?', events, secs: 9 });
    const g2 = await H.getChat(askId);
    ok('re-saved turn replaces', g2.turns.length === 2 && g2.turns[1].question === 'And in Colorado, again?');

    await H.updateChat(askId, { title: 'Renamed chat' });
    await H.updateChat(askId, { folder_id: top.id });
    await H.updateChat(askId, { archived: true });
    let c = (await H.list()).chats.find((x) => x.id === askId);
    ok('rename, move, archive', c.title === 'Renamed chat' && c.folder_id === top.id && c.archived === true && !!c.archived_at);
    await H.updateChat(askId, { archived: false });
    c = (await H.list()).chats.find((x) => x.id === askId);
    ok('restore', c.archived === false && c.archived_at == null);
    await H.updateChat(askId, { folder_id: null });
    c = (await H.list()).chats.find((x) => x.id === askId);
    ok('move to the top level', c.folder_id == null);

    await H.updateChat(quickId, { archived: true });
    await H.saveTurn(quickId, {}, { idx: 1, question: 'Why?', events, secs: 2 });
    c = (await H.list()).chats.find((x) => x.id === quickId);
    ok('a new answer restores an archived chat', c.archived === false && c.turns === 2);

    await H.updateChat(askId, { folder_id: sub.id });
    await H.updateFolder(top.id, { archived: true });
    c = (await H.list()).chats.find((x) => x.id === askId);
    ok('archiving a folder archives its subtree', c.archived === true);
    await H.updateFolder(top.id, { archived: false });
    let cycle = null; try { await H.updateFolder(top.id, { parent_id: sub.id }); } catch (e) { cycle = e.message; }
    ok('a folder cannot go inside itself', !!cycle, cycle);
    await H.updateFolder(sub.id, { name: 'Inner renamed', parent_id: null });
    const f = (await H.list()).folders.find((x) => x.id === sub.id);
    ok('rename and move a folder', f.name === 'Inner renamed' && f.parent_id == null);
    await H.updateFolder(sub.id, { parent_id: top.id });
    await H.deleteFolder(sub.id); ids.folders = ids.folders.filter((x) => x !== sub.id);
    c = (await H.list()).chats.find((x) => x.id === askId);
    ok('deleting a folder moves its chats up', c.folder_id === top.id);

    for (const id of [...ids.chats]) { await H.deleteChat(id); ids.chats = ids.chats.filter((x) => x !== id); }
    let gone = null; try { await H.getChat(askId); } catch (e) { gone = e.message; }
    ok('delete a chat', !!gone, gone);
    for (const id of [...ids.folders].reverse()) await H.deleteFolder(id);
    ids.folders = [];
    const after = await H.list(), own = (l) => l.folders.filter((x) => x.kind !== 'quick').length;
    ok('nothing left behind', after.chats.length === before.chats.length && own(after) === own(before));
  } catch (e) {
    log.push(['FAIL', 'error', String(e && e.message || e)]);
  } finally {
    for (const id of ids.chats) await H.deleteChat(id).catch(() => {});
    for (const id of ids.folders.reverse()) await H.deleteFolder(id).catch(() => {});
  }
  log.push(['', 'total', `${ms()} ms`]);
  return log;
}
"""

SIGNED_IN = "async () => !!(window.Chat && window.RayfinBridge && await window.RayfinBridge.ready)"


def hosted_page(p, url):
    """A page on the Fabric app with a Rayfin session, signing in through a visible window the first time."""
    for headless in (True, False):
        ctx = p.chromium.launch_persistent_context(str(PROFILE), channel=CHANNEL, headless=headless,
                                                   viewport={"width": 1440, "height": 960})
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.goto(url + "#ask")
        if not headless:
            print("Sign in with your Fabric account in the Chrome window (10 minutes).", flush=True)
        deadline = time.time() + (20 if headless else 600)
        while time.time() < deadline:
            try:
                if page.evaluate(SIGNED_IN):
                    return ctx, page
            except Exception:  # the page is navigating through sign-in
                pass
            time.sleep(2)
        ctx.close()
    sys.exit("Not signed in to Fabric.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--local", default="http://127.0.0.1:8765", help="the local server (default %(default)s)")
    ap.add_argument("--hosted", help="the Fabric app's URL instead of the local server")
    a = ap.parse_args()
    with sync_playwright() as p:
        if a.hosted:
            ctx, page = hosted_page(p, a.hosted.rstrip("/") + "/")
        else:
            b = p.chromium.launch(channel=CHANNEL, headless=True)
            ctx = b.new_context()
            page = ctx.new_page()
            page.goto(a.local.rstrip("/") + "/#ask")
        rows = page.evaluate(CHECKS)
        ctx.close()
    for state, name, extra in rows:
        print(f"{state:5} {name}{'  ' + str(extra) if extra else ''}")
    failed = sum(1 for r in rows if r[0] == "FAIL")
    print(f"{len(rows) - 1 - failed} passed, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
