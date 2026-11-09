"""Chat history for the local server: folders, chats and their questions in DuckDB (data/chats/history.duckdb), and
each answer's events in a JSON file (data/chats/turns/<chat>/<n>.json), so a saved answer can be drawn again exactly as
it was. The Fabric app keeps the same records in Rayfin Data and its answer files in a lakehouse (fabric-app/).

Folders nest (parent_id). A chat sits in a folder or at the top (folder_id NULL); archived chats keep their folder,
and the Archive shows the same folders. Chats started in the side panel go to the "Quick chats" folder (kind 'quick')
unless they name another. Everything here belongs to the one person using this computer."""
from __future__ import annotations

import json
import re
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[1] / "data" / "chats"
DB = ROOT / "history.duckdb"
TURNS = ROOT / "turns"
QUICK = "Quick chats"
_lock = threading.Lock()
_con: duckdb.DuckDBPyConnection | None = None
_ID = re.compile(r"^[0-9a-f-]{32,36}$")

SCHEMA = """
CREATE TABLE IF NOT EXISTS folders (id VARCHAR PRIMARY KEY, parent_id VARCHAR, name VARCHAR NOT NULL,
  kind VARCHAR NOT NULL DEFAULT 'user', created_at TIMESTAMP NOT NULL, updated_at TIMESTAMP NOT NULL);
CREATE TABLE IF NOT EXISTS chats (id VARCHAR PRIMARY KEY, folder_id VARCHAR, title VARCHAR NOT NULL,
  origin VARCHAR NOT NULL DEFAULT 'ask', archived BOOLEAN NOT NULL DEFAULT false, archived_at TIMESTAMP,
  session_id VARCHAR, model VARCHAR, turns INTEGER NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL);
CREATE TABLE IF NOT EXISTS turns (chat_id VARCHAR NOT NULL, idx INTEGER NOT NULL, question VARCHAR NOT NULL,
  context VARCHAR, about VARCHAR, preview VARCHAR, status VARCHAR, secs DOUBLE, created_at TIMESTAMP NOT NULL,
  PRIMARY KEY (chat_id, idx));
"""


class HistoryError(ValueError):
    """A request the store can't do (unknown id, a folder moved into itself); the message is for the person."""


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)  # stored as UTC


def _db() -> duckdb.DuckDBPyConnection:
    global _con
    if _con is None:
        TURNS.mkdir(parents=True, exist_ok=True)
        _con = duckdb.connect(str(DB))
        _con.execute(SCHEMA)
    return _con


def _rows(sql: str, params=()) -> list[dict]:
    cur = _db().execute(sql, params)
    cols = [d[0] for d in cur.description]
    return [{c: (v.isoformat() + "Z" if isinstance(v, datetime) else v) for c, v in zip(cols, r)} for r in cur.fetchall()]


def _check_id(value, what="id") -> str:
    value = str(value or "")
    if not _ID.match(value):
        raise HistoryError(f"Not a valid {what}.")
    return value


def _clip(text, n):
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def title_for(question: str) -> str:
    """A chat's first title: its first question, up to about 60 characters at a word boundary."""
    q = re.sub(r"\s+", " ", question or "").strip().rstrip("?.!")
    if len(q) <= 60:
        return q or "New chat"
    cut = q[:60].rsplit(" ", 1)[0]
    return cut.rstrip(",;:") + "…"


def _folder(fid):
    if fid is None:
        return None
    rows = _rows("SELECT * FROM folders WHERE id = ?", [_check_id(fid, "folder")])
    if not rows:
        raise HistoryError("That folder no longer exists.")
    return rows[0]


def _quick_folder() -> str:
    rows = _rows("SELECT id FROM folders WHERE kind = 'quick' ORDER BY created_at LIMIT 1")
    if rows:
        return rows[0]["id"]
    fid, now = uuid.uuid4().hex, _now()
    _db().execute("INSERT INTO folders VALUES (?, NULL, ?, 'quick', ?, ?)", [fid, QUICK, now, now])
    return fid


def _descendants(fid: str) -> set[str]:
    out, todo = set(), [fid]
    while todo:
        cur = todo.pop()
        for r in _rows("SELECT id FROM folders WHERE parent_id = ?", [cur]):
            if r["id"] not in out:
                out.add(r["id"])
                todo.append(r["id"])
    return out


# --- what the sidebar lists ---------------------------------------------------------------------------------------------
def listing() -> dict:
    with _lock:
        return {"folders": _rows("SELECT * FROM folders ORDER BY lower(name)"),
                "chats": _rows("SELECT * FROM chats ORDER BY updated_at DESC")}


# --- folders ------------------------------------------------------------------------------------------------------------
def create_folder(name: str, parent_id=None) -> dict:
    name = _clip(name, 120)
    if not name:
        raise HistoryError("Give the folder a name.")
    with _lock:
        _folder(parent_id)
        fid, now = uuid.uuid4().hex, _now()
        _db().execute("INSERT INTO folders VALUES (?, ?, ?, 'user', ?, ?)", [fid, parent_id, name, now, now])
        return _rows("SELECT * FROM folders WHERE id = ?", [fid])[0]


def update_folder(fid: str, name=None, parent_id="", archived=None) -> dict:
    """Rename, move (parent_id None = the top level; "" = leave it), or archive / restore every chat inside it."""
    fid = _check_id(fid, "folder")
    with _lock:
        _folder(fid)
        if name is not None:
            name = _clip(name, 120)
            if not name:
                raise HistoryError("Give the folder a name.")
            _db().execute("UPDATE folders SET name = ?, updated_at = ? WHERE id = ?", [name, _now(), fid])
        if parent_id != "":
            if parent_id is not None:
                _folder(parent_id)
                if parent_id == fid or parent_id in _descendants(fid):
                    raise HistoryError("A folder can't go inside itself.")
            _db().execute("UPDATE folders SET parent_id = ?, updated_at = ? WHERE id = ?", [parent_id, _now(), fid])
        if archived is not None:
            ids = [fid, *_descendants(fid)]
            marks = ",".join("?" * len(ids))
            _db().execute(f"UPDATE chats SET archived = ?, archived_at = ? WHERE folder_id IN ({marks})",
                          [bool(archived), _now() if archived else None, *ids])
        return _rows("SELECT * FROM folders WHERE id = ?", [fid])[0]


def delete_folder(fid: str) -> dict:
    """Removes the folder; its chats and folders move up to its parent, so nothing is lost."""
    fid = _check_id(fid, "folder")
    with _lock:
        f = _folder(fid)
        _db().execute("UPDATE chats SET folder_id = ? WHERE folder_id = ?", [f["parent_id"], fid])
        _db().execute("UPDATE folders SET parent_id = ? WHERE parent_id = ?", [f["parent_id"], fid])
        _db().execute("DELETE FROM folders WHERE id = ?", [fid])
        return {"ok": True, "moved_to": f["parent_id"]}


# --- chats --------------------------------------------------------------------------------------------------------------
def get_chat(cid: str) -> dict:
    cid = _check_id(cid, "chat")
    with _lock:
        chat = _rows("SELECT * FROM chats WHERE id = ?", [cid])
        if not chat:
            raise HistoryError("That chat no longer exists.")
        turns = _rows("SELECT * FROM turns WHERE chat_id = ? ORDER BY idx", [cid])
    for t in turns:
        f = TURNS / cid / f"{t['idx']}.json"
        t["events"] = json.loads(f.read_text()) if f.exists() else []
    return {"chat": chat[0], "turns": turns}


def update_chat(cid: str, title=None, folder_id="", archived=None) -> dict:
    cid = _check_id(cid, "chat")
    with _lock:
        if not _rows("SELECT id FROM chats WHERE id = ?", [cid]):
            raise HistoryError("That chat no longer exists.")
        if title is not None:
            title = _clip(title, 200)
            if not title:
                raise HistoryError("Give the chat a title.")
            _db().execute("UPDATE chats SET title = ? WHERE id = ?", [title, cid])
        if folder_id != "":
            _folder(folder_id)
            _db().execute("UPDATE chats SET folder_id = ? WHERE id = ?", [folder_id, cid])
        if archived is not None:
            _db().execute("UPDATE chats SET archived = ?, archived_at = ? WHERE id = ?",
                          [bool(archived), _now() if archived else None, cid])
        return _rows("SELECT * FROM chats WHERE id = ?", [cid])[0]


def delete_chat(cid: str) -> dict:
    cid = _check_id(cid, "chat")
    with _lock:
        _db().execute("DELETE FROM turns WHERE chat_id = ?", [cid])
        _db().execute("DELETE FROM chats WHERE id = ?", [cid])
    shutil.rmtree(TURNS / cid, ignore_errors=True)
    return {"ok": True}


def save_turn(cid: str, chat: dict, turn: dict) -> dict:
    """Saves one answered question: creates the chat with the first (titled by the question; panel chats go to Quick
    chats), writes the answer's events to its file and moves the chat to the top. A new answer in an archived chat
    restores it."""
    cid = _check_id(cid, "chat")
    idx = int(turn.get("idx", 0))
    question = str(turn.get("question") or "").strip()
    if not question:
        raise HistoryError("The turn has no question.")
    events = turn.get("events") or []
    (TURNS / cid).mkdir(parents=True, exist_ok=True)
    (TURNS / cid / f"{idx}.json").write_text(json.dumps(events, ensure_ascii=False, default=str))
    now = _now()
    with _lock:
        _db()
        existing = _rows("SELECT * FROM chats WHERE id = ?", [cid])
        if not existing:
            folder = chat.get("folder_id")
            if folder:
                _folder(folder)
            elif chat.get("origin") == "panel":
                folder = _quick_folder()
            _db().execute("INSERT INTO chats VALUES (?, ?, ?, ?, false, NULL, ?, ?, 0, ?, ?)",
                          [cid, folder, _clip(chat.get("title") or title_for(question), 200),
                           "panel" if chat.get("origin") == "panel" else "ask", chat.get("session_id"),
                           chat.get("model"), now, now])
        _db().execute("INSERT OR REPLACE INTO turns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                      [cid, idx, _clip(question, 4000), str(turn.get("context") or "")[:6000] or None,
                       _clip(turn.get("about"), 300) or None, _clip(turn.get("preview"), 600) or None, turn.get("status") or "done",
                       float(turn.get("secs") or 0), now])
        _db().execute("""UPDATE chats SET turns = (SELECT count(*) FROM turns WHERE chat_id = ?), updated_at = ?,
                         session_id = coalesce(?, session_id), model = coalesce(?, model), archived = false,
                         archived_at = NULL WHERE id = ?""",
                      [cid, now, chat.get("session_id"), chat.get("model"), cid])
        return _rows("SELECT * FROM chats WHERE id = ?", [cid])[0]
