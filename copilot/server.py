"""Ask your data: GitHub Copilot answers questions about the dashboard's data with figures.

Local (default):  python3 copilot/server.py, then open http://127.0.0.1:8765
    Serves the dashboard and the chat API on one origin. Copilot runs on a sign-in from this Mac (`copilot login` or
    `gh auth login`), chosen in the page; DAX runs with the az CLI sign-in.

Relay (RELAY=1, the Azure Container App behind the Fabric-hosted dashboard):
    Serves only the API, to the Fabric app's origin. Every call carries a chat ticket signed by the app's `chatTicket`
    Rayfin Function (the Fabric user). Each user signs in to GitHub once (OAuth popup); the token stays in memory and
    their chats run on their own Copilot plan. The relay has no Fabric access: each DAX query goes to the page, which
    runs it through the app's `dax` function and posts the rows back.

Browser --POST /api/chat--> this server --Copilot SDK--> Copilot runtime --> models
   ^                            |  tools (copilot/tools.py) run here; page tools and, in the relay, DAX go to the page
   +------ NDJSON events <------+  as page_request events, answered with POST /api/tool-result

Relay environment: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, CHAT_TICKET_KEY, ALLOWED_ORIGIN (comma-separated app
origins), PUBLIC_URL (this server's address), PORT (8080), LOCAL_CORS=1 when not behind Container Apps ingress.
Both: CMS_MODEL (default model), CMS_EFFORT (thinking level), COPILOT_CLI_PATH (a Copilot CLI to run as the runtime).
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import hmac
import html
import json
import logging
import os
import re
import secrets
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlencode

import httpx
import uvicorn
from copilot import CopilotClient
from copilot.generated.rpc import AccountLoginRequest, ModelsListRequest
from copilot.generated.session_events import (AssistantReasoningData, AssistantReasoningDeltaData,
                                              AssistantStreamingDeltaData, AssistantToolCallDeltaData)
from copilot.session import PermissionHandler
from copilot.session_events import (AssistantMessageData, AssistantMessageDeltaData, SessionErrorData,
                                    SessionIdleData, ToolExecutionCompleteData, ToolExecutionStartData)
from copilot.tools import Tool, ToolInvocation, ToolResult
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import fabric  # noqa: E402
import rules  # noqa: E402
import tools  # noqa: E402

RELAY = os.environ.get("RELAY") == "1"
DEFAULT_MODEL = os.environ.get("CMS_MODEL", "claude-opus-5.5")
DEFAULT_EFFORT = os.environ.get("CMS_EFFORT", "high")
PAGE_TIMEOUT = 300        # seconds the page has to draw a figure or run a DAX query
CHECK_TIMEOUT = 30        # seconds the page has to draw a figure and measure it for the readability check
KEEPALIVE = 15            # seconds between pings on a quiet stream (proxies drop idle connections)
CHAT_IDLE = 45 * 60       # chats unused this long are closed
CONTEXT_LIMIT = 9000      # characters of [Pointing at] and [On screen] context taken from the page
SURFACES = ("ask", "panel")
WORK_DIR = Path(os.environ.get("COPILOT_WORK_DIR") or Path(tempfile.gettempdir()) / "cms-quality-chat")

client: CopilotClient | None = None


# --- chats -------------------------------------------------------------------------------------------------------------
@dataclass
class Chat:
    owner: str                # local: the Copilot account id; relay: the Fabric user's object id
    surface: str
    model: str
    effort: str | None
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    session: object = None
    queue: asyncio.Queue | None = None
    loop: asyncio.AbstractEventLoop | None = None
    pending: dict = field(default_factory=dict)     # page request id -> Future
    figs: list = field(default_factory=list)        # figures in the current answer: (title, signature)
    drafts: dict = field(default_factory=dict)      # tool calls being written: id -> progress
    last_ping: float = 0.0
    used: float = field(default_factory=time.time)
    busy: bool = False
    seed: str = ""                                  # an earlier conversation, for a session that couldn't be resumed
    last_context: str = ""                          # the page context this session was last given

    def emit(self, event: dict) -> None:
        if self.queue:
            self.queue.put_nowait(event)

    def figure_number(self, ui: dict, replace=None) -> int:
        """Numbers a figure within the answer; a correction (replace=N, the same title, or the same template, fields and
        rows) keeps the number of the figure it replaces, as the page replaces it in place."""
        sig = json.dumps([ui.get("template") or ui.get("figure"), ui.get("fields") or ui.get("params"), ui.get("rows")],
                         sort_keys=True, default=str)
        if isinstance(replace, int) and 1 <= replace <= len(self.figs):
            self.figs[replace - 1] = (ui.get("title"), sig)
            return replace
        for i, (title, s) in enumerate(self.figs):
            if (ui.get("title") and ui.get("title") == title) or sig == s:
                self.figs[i] = (ui.get("title"), sig)
                return i + 1
        self.figs.append((ui.get("title"), sig))
        return len(self.figs)

    async def page_call(self, kind: str, payload: dict, timeout: float = PAGE_TIMEOUT) -> dict:
        """Asks the page to do something (draw a dashboard figure, run DAX) and waits for its answer."""
        if not self.queue:
            raise RuntimeError("The page that asked this question is no longer open.")
        rid = uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self.pending[rid] = future
        self.emit({"type": "page_request", "id": rid, "kind": kind, **payload})
        try:
            return await asyncio.wait_for(future, timeout)
        except asyncio.TimeoutError:
            raise RuntimeError(f"The page did not answer the {kind} request in time.") from None
        finally:
            self.pending.pop(rid, None)

    def dax_via_page(self, query: str, model: str):
        """DAX runner for the relay: called from a tool's worker thread, answered by the page."""
        future = asyncio.run_coroutine_threadsafe(self.page_call("dax", {"model": model, "query": query}), self.loop)
        try:
            result = future.result(PAGE_TIMEOUT + 10)
        except Exception as e:
            raise fabric.DaxError(str(e)) from None
        if not result.get("ok"):
            raise fabric.DaxError(str(result.get("error") or "The query failed."))
        rows = result.get("rows")
        return fabric.plain_rows(rows) if isinstance(rows, list) else []


chats: dict[str, Chat] = {}
by_session: dict[str, Chat] = {}


# --- tools ------------------------------------------------------------------------------------------------------------
def numbered(text: str, n: int) -> str:
    return text.replace(tools.NARRATE, "") + (
        f"\nThis is figure {n}. Write its narrative (2-4 sentences) under a line [[fig {n}]]; the app places it right "
        "under the figure, so you may show other figures first. End the answer with [[summary]] and 1-3 sentences.")


async def run_tool(inv: ToolInvocation) -> ToolResult:
    chat = by_session.get(inv.session_id)
    spec = tools.TOOL_BY_NAME.get(inv.tool_name)
    args = dict(inv.arguments or {})
    if not chat or not spec:
        return ToolResult(text_result_for_llm="This conversation is closed.", result_type="failure")
    if spec["kind"] == "page":
        return await dashboard_figure(chat, inv, args)
    replace = args.pop("replace", None)
    replace = int(replace) if str(replace).strip().isdigit() else None

    def call():
        fabric.use_runner(chat.dax_via_page if RELAY else None)
        return spec["handler"](**args)
    try:
        out = await asyncio.to_thread(call)
    except TypeError as e:  # unknown or missing arguments: tell the model so it can retry
        return ToolResult(text_result_for_llm=f"{inv.tool_name}: {e}", result_type="failure")
    except Exception as e:
        return ToolResult(text_result_for_llm=f"{inv.tool_name} failed: {type(e).__name__}: {e}", result_type="failure")
    text = out.text
    if out.ok and out.ui:
        n = chat.figure_number(out.ui, replace)
        chat.emit({"type": "chart", "call_id": inv.tool_call_id, "fig": n, "tool": inv.tool_name, "ui": out.ui})
        # The page draws the figure and measures it as the reader sees it; a figure it can't draw is a failed step
        try:
            check = await chat.page_call("figure_check", {"call_id": inv.tool_call_id, "fig": n}, timeout=CHECK_TIMEOUT)
        except RuntimeError:
            check = {"ok": True}
        if not check.get("ok"):
            return ToolResult(text_result_for_llm=f"{check.get('error') or 'The figure could not be drawn.'} Correct the call and "
                              "try again; don't mention this in your reply.", result_type="failure")
        if check.get("text"):
            text += "\n" + check["text"]
        text = numbered(text, n)
    return ToolResult(text_result_for_llm=text[:200_000], result_type="success" if out.ok else "failure")


async def dashboard_figure(chat: Chat, inv: ToolInvocation, args: dict) -> ToolResult:
    """show_dashboard_figure: the page draws the dashboard's own figure and returns what it shows."""
    replace = args.pop("replace", None)
    replace = int(replace) if str(replace).strip().isdigit() else None
    try:
        request, err = tools.check_dashboard_figure(**args)
    except TypeError as e:
        request, err = None, f"show_dashboard_figure: {e}"
    if err:
        return ToolResult(text_result_for_llm=err, result_type="failure")
    n = chat.figure_number(request, replace)
    try:
        result = await chat.page_call("dashboard_figure", {"call_id": inv.tool_call_id, "fig": n, "request": request})
    except RuntimeError as e:
        return ToolResult(text_result_for_llm=str(e), result_type="failure")
    if not result.get("ok"):
        return ToolResult(text_result_for_llm=f"The figure could not be drawn: {result.get('error')}", result_type="failure")
    text = (f"Dashboard figure '{request['figure']}' is shown to the user. What it shows (your text must agree):\n"
            f"{result.get('text', '')}")
    return ToolResult(text_result_for_llm=numbered(text, n))


TOOLS = [Tool(name=t["name"], description=t["description"], parameters=t["parameters"], handler=run_tool,
              skip_permission=True) for t in tools.TOOLS]


TRANSCRIPT_LIMIT = 20000   # characters of an earlier conversation sent with the first question after reopening it


async def new_chat(owner: str, surface: str, model: str, effort: str | None, auth: dict, resume: dict | None = None) -> Chat:
    """A Copilot session for a conversation. A reopened chat (resume = {session_id, transcript}) resumes its saved
    session when the runtime still has it; otherwise a new session starts with the transcript of the chat so far."""
    chat = Chat(owner, surface, model, effort, loop=asyncio.get_running_loop())
    config = dict(
        model=model, reasoning_effort=effort, streaming=True, tools=TOOLS,
        available_tools=[f"custom:{t.name}" for t in TOOLS], on_permission_request=PermissionHandler.approve_all,
        working_directory=str(WORK_DIR), skip_custom_instructions=True, enable_skills=False,
        system_message={"mode": "customize", "sections": {
            "code_change_rules": {"action": "remove"},
            "environment_context": {"action": "remove"},
            "guidelines": {"action": "append", "content": "\n" + rules.instructions(surface)}}},
        **auth)
    sid = str((resume or {}).get("session_id") or "")
    if sid:
        sdk_log = logging.getLogger("copilot")  # a session that's gone is expected here, not worth a traceback
        level, sdk_log.level = sdk_log.level, logging.CRITICAL
        try:
            chat.session = await client.resume_session(sid, **config)
            print(f"Reopened chat: resumed Copilot session {sid[:8]}", flush=True)
        except Exception as e:  # gone (the relay restarted, or another account): start again from the transcript
            print(f"Reopened chat: session {sid[:8]} is gone ({type(e).__name__}); starting from its transcript", flush=True)
            chat.session = None
        finally:
            sdk_log.level = level
    if chat.session is None:
        chat.session = await client.create_session(**config)
        chat.seed = str((resume or {}).get("transcript") or "")[-TRANSCRIPT_LIMIT:] if resume else ""
    chat.session.on(lambda e: chat.loop.call_soon_threadsafe(forward, chat, e))
    chats[chat.id] = chat
    by_session[chat.session.session_id] = chat
    return chat


def _unquote(s):
    try:
        return json.loads(f'"{s}"')
    except ValueError:
        return s


# The steps of an answer, for the page's "how Copilot answered" trace: each tool's arguments and what it returned
TRACE_LIMIT = 6000


def _clip(s: str) -> str:
    return s if len(s) <= TRACE_LIMIT else s[:TRACE_LIMIT] + "\n…"


def trace_args(args: dict) -> dict:
    out = {}
    for k, v in args.items():
        if k == "rows" and isinstance(v, list):
            out[k] = f"{len(v):,} rows written by Copilot"
        else:
            out[k] = _clip(v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, indent=1))
    return out


def trace_result(result) -> str:
    text = getattr(result, "content", None) or ""
    return _clip(text.split("\nThis is figure ")[0].strip())


def forward(chat: Chat, event) -> None:
    """Copilot session event -> NDJSON event for the page."""
    match event.data:
        case AssistantMessageDeltaData() as d if not d.parent_tool_call_id:
            chat.emit({"type": "delta", "id": d.message_id, "text": d.delta_content})
        case AssistantMessageData() as d if not d.parent_tool_call_id:
            chat.emit({"type": "message", "id": d.message_id, "text": d.content})
        # While the model writes a tool call (a long DAX query can take a minute), show what is being built.
        case AssistantToolCallDeltaData() as d:
            dr = chat.drafts.setdefault(d.tool_call_id, {"n": 0, "head": "", "t": 0.0})
            dr["n"] += len(d.input_delta or "")
            if len(dr["head"]) < 4000:
                dr["head"] += d.input_delta or ""
            now = time.monotonic()
            if now - dr["t"] >= 0.4:
                dr["t"] = now
                head = dr["head"]
                tpl = re.search(r'"(?:template|figure)"\s*:\s*"([a-z_]+)"', head)
                title = re.search(r'"title"\s*:\s*"((?:[^"\\]|\\.)*)"', head)
                chat.emit({"type": "tool_draft", "id": d.tool_call_id, "name": d.tool_name, "bytes": dr["n"],
                           "template": tpl and tpl.group(1), "title": title and _unquote(title.group(1))})
        case AssistantReasoningDeltaData() as d:
            if d.delta_content:
                chat.emit({"type": "reasoning", "id": d.reasoning_id, "text": d.delta_content})
        case AssistantReasoningData() as d:
            chat.emit({"type": "reasoning_done", "id": d.reasoning_id, "text": d.content or ""})
        case AssistantStreamingDeltaData():
            now = time.monotonic()
            if now - chat.last_ping >= 1.0:
                chat.last_ping = now
                chat.emit({"type": "thinking"})
        case ToolExecutionStartData() as d:
            chat.drafts.pop(d.tool_call_id, None)
            args = d.arguments if isinstance(d.arguments, dict) else {}
            chat.emit({"type": "tool", "id": d.tool_call_id, "name": d.tool_name,
                       "model": args.get("model"), "template": args.get("template") or args.get("figure"),
                       "title": args.get("title"), "dax": args.get("dax") or args.get("query"), "args": trace_args(args)})
        case ToolExecutionCompleteData() as d:
            chat.emit({"type": "tool_done", "id": d.tool_call_id, "ok": d.success,
                       "error": d.error.message if d.error else None, "result": trace_result(d.result)})
        case SessionErrorData() as d:
            chat.emit({"type": "error", "text": d.message})
        case SessionIdleData():
            chat.emit({"type": "done"})


async def close_chat(chat: Chat) -> None:
    chats.pop(chat.id, None)
    by_session.pop(getattr(chat.session, "session_id", ""), None)
    for future in chat.pending.values():
        future.cancel()
    with contextlib.suppress(Exception):
        await chat.session.disconnect()


# --- who is asking: a Copilot sign-in on this Mac (local) or a chat ticket and a GitHub sign-in (relay) --------------
COOKIE = "cms_account"
SOURCE = {"user": "Copilot CLI", "gh-cli": "GitHub CLI", "token": "Pasted token"}
pasted: dict[str, dict] = {}  # local tokens pasted without "remember": kept in memory until the server stops


def account_entry(id, info, token, source):
    cu = info.get("copilotUser") or {}
    return {"id": id, "login": info.get("login") or cu.get("login"), "host": info.get("host") or "https://github.com",
            "source": SOURCE.get(source, source), "plan": cu.get("copilot_plan"), "token": token}


async def local_accounts():
    """Copilot sign-ins on this Mac (`copilot login`, `gh auth login`) plus pasted tokens; one entry per user."""
    out = {}
    for u in await client.rpc.account.get_all_users():
        info = u.get("authInfo") or {}
        a = account_entry(u.get("selectionId"), info, u.get("token") or info.get("token"), info.get("type"))
        if a["id"] and a["token"] and a["login"]:
            out.setdefault((a["host"], a["login"].lower()), a)
    return [*out.values(), *pasted.values()]


async def local_account(req: Request):
    id = req.cookies.get(COOKIE)
    return next((a for a in await local_accounts() if a["id"] == id), None) if id else None


public = lambda a: {k: v for k, v in a.items() if k != "token"}  # noqa: E731

TICKET_KEY = os.environ.get("CHAT_TICKET_KEY", "").encode()
CLIENT_ID = os.environ.get("GITHUB_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("GITHUB_CLIENT_SECRET", "")
ORIGINS = [o.strip().rstrip("/") for o in os.environ.get("ALLOWED_ORIGIN", "").split(",") if o.strip()]
PUBLIC_URL = os.environ.get("PUBLIC_URL", "").rstrip("/")


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def verify_ticket(raw: str | None) -> dict | None:
    """{'oid', 'upn', 'exp'} of a valid ticket, else None. A ticket is base64url(JSON) + '.' + base64url(HMAC)."""
    if not raw or not TICKET_KEY or raw.count(".") != 1:
        return None
    body, sig = raw.split(".")
    if not hmac.compare_digest(sig, _b64(hmac.new(TICKET_KEY, body.encode(), hashlib.sha256).digest())):
        return None
    try:
        data = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    except ValueError:
        return None
    now = time.time()
    if not isinstance(data, dict) or not (now < float(data.get("exp", 0)) <= now + 3700):
        return None
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", str(data.get("oid", ""))):
        return None
    return data


@dataclass
class GitHubUser:
    login: str
    token: str
    refresh_token: str | None
    expires_at: float | None
    refresh_expires_at: float | None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


github_users: dict[str, GitHubUser] = {}   # relay: by Fabric object id
oauth_pending: dict[str, dict] = {}        # OAuth state -> {oid, origin, at}


def _expiry(payload: dict, key: str) -> float | None:
    return time.time() + int(payload[key]) if payload.get(key) else None


async def github_user(oid: str) -> GitHubUser | None:
    """The user's GitHub sign-in, refreshed when the access token is about to expire."""
    user = github_users.get(oid)
    if not user or not user.expires_at or user.expires_at - 300 > time.time():
        return user
    async with user.lock:
        if user.expires_at and user.expires_at - 300 > time.time():
            return user
        if not user.refresh_token or (user.refresh_expires_at and user.refresh_expires_at < time.time()):
            github_users.pop(oid, None)
            return None
        async with httpx.AsyncClient(timeout=30) as http:
            r = await http.post("https://github.com/login/oauth/access_token", headers={"Accept": "application/json"},
                                data={"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
                                      "grant_type": "refresh_token", "refresh_token": user.refresh_token})
        payload = r.json() if r.status_code == 200 else {}
        if "access_token" not in payload:
            github_users.pop(oid, None)
            return None
        user.token, user.refresh_token = payload["access_token"], payload.get("refresh_token", user.refresh_token)
        user.expires_at = _expiry(payload, "expires_in")
        user.refresh_expires_at = _expiry(payload, "refresh_token_expires_in") or user.refresh_expires_at
        return user


def token_provider(oid: str):
    async def provide(_args):
        user = await github_user(oid)
        if not user:
            return {"kind": "cancelled"}
        return {"kind": "token", "accessToken": user.token,
                "expiresIn": max(60, int((user.expires_at or time.time() + 8 * 3600) - time.time()))}
    return provide


def fail(text: str, status: int, code: str | None = None) -> JSONResponse:
    return JSONResponse({"error": text, **({"code": code} if code else {})}, status_code=status)


@dataclass
class Who:
    owner: str
    auth: dict           # create_session arguments: github_token or github_token_provider
    models: object       # ModelsListRequest for this user
    login: str | None
    user: str | None = None


async def who(req: Request) -> Who | JSONResponse:
    """The caller, signed in to Copilot; or the error response to send instead."""
    if RELAY:
        ticket = verify_ticket(req.headers.get("x-chat-ticket"))
        if not ticket:
            return fail("The chat ticket is missing or has expired; reload the page.", 401, "ticket")
        user = await github_user(ticket["oid"])
        if not user:
            return fail("Sign in to GitHub first.", 401, "github")
        return Who(ticket["oid"], {"github_token_provider": token_provider(ticket["oid"])},
                   ModelsListRequest(git_hub_token=user.token), user.login, ticket.get("upn"))
    account = await local_account(req)
    if not account:
        return fail("Choose the GitHub account that Copilot should use.", 401, "account")
    pick = ModelsListRequest(git_hub_token=account["token"]) if account["id"].startswith("pasted-") \
        else ModelsListRequest(selection_id=account["id"])
    return Who(account["id"], {"github_token": account["token"]}, pick, account["login"])


# --- API -------------------------------------------------------------------------------------------------------------
async def api_health(_):
    return JSONResponse({"ok": True, "mode": "relay" if RELAY else "local", "chats": len(chats)})


async def api_me(req: Request):
    if RELAY:
        ticket = verify_ticket(req.headers.get("x-chat-ticket"))
        if not ticket:
            return fail("The chat ticket is missing or has expired; reload the page.", 401, "ticket")
        user = await github_user(ticket["oid"])
        return JSONResponse({"mode": "relay", "user": ticket.get("upn"), "github": {"login": user.login} if user else None})
    accounts = await local_accounts()
    current = await local_account(req)
    return JSONResponse({"mode": "local", "accounts": [public(a) for a in accounts],
                         "github": {"login": current["login"], "id": current["id"]} if current else None})


def signed_in(resp, account):
    resp.set_cookie(COOKIE, account["id"], max_age=30 * 86400, httponly=True, samesite="strict")
    return resp


async def api_signin(req: Request):
    """Local: choose one of the Copilot sign-ins on this Mac."""
    if RELAY:
        return fail("Not available here.", 404)
    id = (await req.json()).get("id")
    a = next((a for a in await local_accounts() if a["id"] == id), None)
    if not a:
        return fail("That account is no longer signed in to Copilot on this Mac.", 404)
    return signed_in(JSONResponse({"ok": True, "login": a["login"]}), a)


async def api_add_account(req: Request):
    """Local: sign in with a GitHub token (`gh auth token`, or a fine-grained PAT with the Copilot Requests permission)."""
    if RELAY:
        return fail("Not available here.", 404)
    body = await req.json()
    token, remember = (body.get("token") or "").strip(), bool(body.get("remember"))
    if not token:
        return fail("Paste a GitHub token.", 400)
    try:
        async with httpx.AsyncClient(timeout=15) as http:
            r = await http.get("https://api.github.com/user", headers={"Authorization": f"Bearer {token}"})
        if r.status_code != 200:
            return fail("GitHub didn't accept that token.", 400)
        login = r.json()["login"]
        await client.rpc.models.list(ModelsListRequest(git_hub_token=token))  # proves the token can use Copilot
    except Exception as e:
        return fail(f"This token can't use Copilot: {e}", 400)
    a = None
    if remember:  # stored in the macOS keychain alongside `copilot login` accounts
        await client.rpc.account.login(AccountLoginRequest(host="https://github.com", token=token, login=login))
        a = next((a for a in await local_accounts() if a["token"] == token), None)
    if a is None:
        a = account_entry("pasted-" + uuid.uuid4().hex, {"login": login}, token, "token")
        pasted[a["id"]] = a
    return signed_in(JSONResponse({"ok": True, "login": login}), a)


async def api_signout(req: Request):
    if RELAY:
        ticket = verify_ticket(req.headers.get("x-chat-ticket"))
        if not ticket:
            return fail("The chat ticket is missing or has expired; reload the page.", 401, "ticket")
        github_users.pop(ticket["oid"], None)
        owner = ticket["oid"]
    else:
        owner = req.cookies.get(COOKIE)
    for chat in [c for c in chats.values() if c.owner == owner]:
        await close_chat(chat)
    resp = JSONResponse({"ok": True})
    if not RELAY:
        resp.delete_cookie(COOKIE)
    return resp


async def api_models(req: Request):
    caller = await who(req)
    if isinstance(caller, JSONResponse):
        return caller
    seen, out = set(), []
    for m in (await client.rpc.models.list(caller.models)).models:
        if m.id not in seen:
            seen.add(m.id)
            out.append({"id": m.id, "name": m.name, "efforts": m.supported_reasoning_efforts or [],
                        "default_effort": m.default_reasoning_effort})
    default = DEFAULT_MODEL if DEFAULT_MODEL in seen else next((m["id"] for m in out if "opus" in m["id"]),
                                                               out[0]["id"] if out else None)
    return JSONResponse({"models": out, "default": default, "default_effort": DEFAULT_EFFORT, "login": caller.login})


async def api_chat(req: Request):
    caller = await who(req)
    if isinstance(caller, JSONResponse):
        return caller
    body = await req.json()
    prompt = (body.get("message") or "").strip()
    if not prompt:
        return fail("Ask a question.", 400)
    surface = body.get("surface") if body.get("surface") in SURFACES else "ask"
    model, effort = body.get("model") or DEFAULT_MODEL, body.get("effort") or None
    context = str(body.get("context") or "").strip()[:CONTEXT_LIMIT]
    chat = chats.get(body.get("chat_id") or "")
    if chat and chat.owner == caller.owner and chat.surface != surface and body.get("adopt"):
        chat.surface = surface  # the side panel's conversation, continued in the tab
        prompt = ("(This conversation has moved from the side panel to the full-width Ask your data tab: figures can be "
                  "wider and there can be more of them.)\n\n" + prompt)
    if chat and (chat.owner != caller.owner or chat.surface != surface):
        chat = None
    if chat and chat.busy:
        return fail("Copilot is still answering the last question; stop it first.", 409)

    async def stream():
        nonlocal chat
        finished = False
        try:
            resume = body.get("resume") if isinstance(body.get("resume"), dict) else None
            if chat is None and resume and resume.get("session_id"):  # reopened, but its session is still live here
                chat = next((c for c in chats.values() if c.owner == caller.owner and not c.busy
                             and getattr(c.session, "session_id", None) == resume["session_id"]), None)
                if chat:
                    chat.surface = surface
            if chat is None or (chat.model, chat.effort) != (model, effort):
                if chat:
                    await close_chat(chat)
                chat = await new_chat(caller.owner, surface, model, effort, caller.auth, resume)
            chat.queue, chat.figs, chat.used, chat.busy = asyncio.Queue(), [], time.time(), True
            yield json.dumps({"type": "chat", "chat_id": chat.id, "session_id": chat.session.session_id, "model": model,
                              "effort": effort}) + "\n"
            # The page sends what was right-clicked and what is on screen with every question; this session is given
            # it only when it differs from what it was given last (a new session, after a model change or a timeout,
            # gets it again). The page labels its blocks; older pages send the right-click context alone.
            ask = prompt
            if context and context != chat.last_context:
                ask = f"{context if context.startswith('[') else '[Pointing at]' + chr(10) + context}\n\n{prompt}"
            send = ask
            if chat.seed:
                send = ("(This conversation was saved and reopened. What was asked and answered before:)\n"
                        f"{chat.seed}\n\n(The conversation continues with this question.)\n\n{ask}")
                chat.seed = ""
            await chat.session.send(send)
            if context:
                chat.last_context = context
            while True:
                try:
                    ev = await asyncio.wait_for(chat.queue.get(), KEEPALIVE)
                except asyncio.TimeoutError:
                    yield '{"type": "ping"}\n'
                    continue
                yield json.dumps(ev, default=str) + "\n"
                if ev["type"] in ("done", "error"):
                    finished = True
                    break
        except Exception as e:  # SDK or sign-in problems, shown in the chat
            finished = True
            yield json.dumps({"type": "error", "text": f"{type(e).__name__}: {e}"}) + "\n"
        finally:
            if chat:
                chat.used, chat.busy = time.time(), False
                if not finished:  # the page went away mid-answer
                    for future in chat.pending.values():
                        future.cancel()
                    with contextlib.suppress(Exception):
                        await chat.session.abort()

    return StreamingResponse(stream(), media_type="application/x-ndjson",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


async def api_tool_result(req: Request):
    """The page's answer to a page_request: {chat_id, id, ok, text | rows | error}."""
    caller = await who(req)
    if isinstance(caller, JSONResponse):
        return caller
    body = await req.json()
    chat = chats.get(body.get("chat_id") or "")
    if not chat or chat.owner != caller.owner:
        return fail("Unknown chat.", 404)
    future = chat.pending.get(body.get("id") or "")
    if future and not future.done():
        future.set_result({k: body.get(k) for k in ("ok", "text", "rows", "error")})
    return JSONResponse({"ok": True})


async def api_stop(req: Request):
    caller = await who(req)
    if isinstance(caller, JSONResponse):
        return caller
    chat = chats.get((await req.json()).get("chat_id") or "")
    if chat and chat.owner == caller.owner:
        for future in chat.pending.values():
            future.cancel()
        with contextlib.suppress(Exception):
            await chat.session.abort()
        chat.emit({"type": "done", "aborted": True})
    return JSONResponse({"ok": True})


# --- chat history (local server: copilot/history.py; the Fabric app keeps its own in Rayfin Data) --------------------
async def _history(fn, *args, **kwargs):
    import history  # noqa: PLC0415 (DuckDB, only for the local server)
    try:
        return JSONResponse(await asyncio.to_thread(fn(history), *args, **kwargs))
    except history.HistoryError as e:
        return fail(str(e), 400)


async def api_history(_req: Request):
    return await _history(lambda h: h.listing)


async def api_history_folders(req: Request):
    body = await req.json()
    return await _history(lambda h: h.create_folder, body.get("name"), body.get("parent_id"))


async def api_history_folder(req: Request):
    fid = req.path_params["fid"]
    if req.method == "DELETE":
        return await _history(lambda h: h.delete_folder, fid)
    body = await req.json()
    return await _history(lambda h: h.update_folder, fid, body.get("name"), body.get("parent_id", ""), body.get("archived"))


async def api_history_chat(req: Request):
    cid = req.path_params["cid"]
    if req.method == "GET":
        return await _history(lambda h: h.get_chat, cid)
    if req.method == "DELETE":
        return await _history(lambda h: h.delete_chat, cid)
    body = await req.json()
    return await _history(lambda h: h.update_chat, cid, body.get("title"), body.get("folder_id", ""), body.get("archived"))


async def api_history_turn(req: Request):
    body = await req.json()
    return await _history(lambda h: h.save_turn, req.path_params["cid"], body.get("chat") or {}, body.get("turn") or {})


# --- relay: GitHub sign-in (OAuth web flow, in a popup) ----------------------------------------------------------------
def public_url(req: Request) -> str:
    return PUBLIC_URL or str(req.base_url).rstrip("/")


def allowed_origin(origin: str | None) -> str | None:
    origin = (origin or "").rstrip("/")
    return origin if origin in ORIGINS else (ORIGINS[0] if ORIGINS else None)


async def auth_start(req: Request):
    ticket = verify_ticket(req.query_params.get("ticket"))
    if not ticket:
        return popup_page("This sign-in link has expired. Close this window and choose Sign in with GitHub again.")
    state = secrets.token_urlsafe(24)
    oauth_pending[state] = {"oid": ticket["oid"], "origin": allowed_origin(req.query_params.get("origin")), "at": time.time()}
    query = urlencode({"client_id": CLIENT_ID, "redirect_uri": f"{public_url(req)}/auth/github/callback",
                       "state": state, "scope": "read:user", "allow_signup": "false", "prompt": "select_account"})
    return RedirectResponse(f"https://github.com/login/oauth/authorize?{query}", status_code=302)


async def auth_callback(req: Request):
    started = oauth_pending.pop(req.query_params.get("state", ""), None)
    if not started or time.time() - started["at"] > 600:
        return popup_page("This sign-in has expired. Close this window and try again.")
    if req.query_params.get("error"):
        return popup_page(f"GitHub sign-in was cancelled ({req.query_params['error']}).", origin=started["origin"])
    async with httpx.AsyncClient(timeout=30) as http:
        r = await http.post("https://github.com/login/oauth/access_token", headers={"Accept": "application/json"},
                            data={"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET,
                                  "code": req.query_params.get("code", ""),
                                  "redirect_uri": f"{public_url(req)}/auth/github/callback"})
        payload = r.json() if r.status_code == 200 else {}
        if "access_token" not in payload:
            return popup_page(f"GitHub didn't issue a token ({payload.get('error_description') or r.status_code}).",
                              origin=started["origin"])
        me = await http.get("https://api.github.com/user", headers={
            "Authorization": f"Bearer {payload['access_token']}", "Accept": "application/vnd.github+json"})
    login = me.json().get("login", "?") if me.status_code == 200 else "?"
    github_users[started["oid"]] = GitHubUser(login, payload["access_token"], payload.get("refresh_token"),
                                              _expiry(payload, "expires_in"), _expiry(payload, "refresh_token_expires_in"))
    return popup_page(f"Signed in to GitHub as {login}. You can close this window.", ok=True,
                      origin=started["origin"], login=login)


def popup_page(text: str, ok: bool = False, origin: str | None = None, login: str | None = None) -> HTMLResponse:
    message = json.dumps({"type": "cms-github", "ok": ok, "login": login})
    script = (f"<script>try{{window.opener&&window.opener.postMessage({message},{json.dumps(origin)});}}catch(e){{}}"
              f"{'setTimeout(function(){window.close()},700);' if ok else ''}</script>") if origin else ""
    return HTMLResponse(
        "<!doctype html><meta charset=utf-8><title>GitHub sign-in</title>"
        "<body style=\"font:15px/1.5 'Fira Sans',system-ui,sans-serif;color:#141413;background:#FAF9F5;margin:0;"
        "display:grid;place-items:center;height:100vh\"><p style=\"max-width:380px;padding:0 24px\">"
        f"{html.escape(text)}</p>{script}</body>", headers={"Cache-Control": "no-store"})


# --- app -------------------------------------------------------------------------------------------------------------
async def janitor() -> None:
    while True:
        await asyncio.sleep(300)
        now = time.time()
        for chat in [c for c in chats.values() if now - c.used > CHAT_IDLE and not c.busy]:
            await close_chat(chat)
        for state in [s for s, p in oauth_pending.items() if now - p["at"] > 600]:
            oauth_pending.pop(state, None)


@contextlib.asynccontextmanager
async def lifespan(_):
    global client
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    if RELAY:
        client = CopilotClient(mode="empty", base_directory=str(WORK_DIR / "home"), use_logged_in_user=False,
                               session_idle_timeout_seconds=CHAT_IDLE)
    else:  # the default mode, so the Copilot sign-ins in ~/.copilot are there to choose from; sessions get our tools only
        client = CopilotClient()
    await client.start()
    task = asyncio.create_task(janitor())
    yield
    task.cancel()
    for chat in list(chats.values()):
        await close_chat(chat)
    await client.stop()


async def index(_):
    return FileResponse(ROOT / "index.html", headers={"Cache-Control": "no-cache"})


class Assets(StaticFiles):
    """The dashboard's assets, revalidated on every load (a cheap 304 when unchanged). Without a Cache-Control header
    browsers may reuse a stale script heuristically and run it against a newer index.html."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


routes = [
    Route("/api/health", api_health), Route("/healthz", api_health), Route("/api/me", api_me),
    Route("/api/signin", api_signin, methods=["POST"]), Route("/api/accounts/add", api_add_account, methods=["POST"]),
    Route("/api/signout", api_signout, methods=["POST"]), Route("/api/models", api_models),
    Route("/api/chat", api_chat, methods=["POST"]), Route("/api/tool-result", api_tool_result, methods=["POST"]),
    Route("/api/stop", api_stop, methods=["POST"]),
]
if RELAY:
    routes += [Route("/auth/github/start", auth_start), Route("/auth/github/callback", auth_callback)]
else:  # the dashboard itself, from the repository (index.html and assets/ only), and the local chat history
    routes += [Route("/", index), Mount("/assets", app=Assets(directory=ROOT / "assets"), name="assets"),
               Route("/api/history", api_history), Route("/api/history/folders", api_history_folders, methods=["POST"]),
               Route("/api/history/folders/{fid}", api_history_folder, methods=["PATCH", "DELETE"]),
               Route("/api/history/chats/{cid}", api_history_chat, methods=["GET", "PATCH", "DELETE"]),
               Route("/api/history/chats/{cid}/turns", api_history_turn, methods=["POST"])]

middleware = [Middleware(CORSMiddleware, allow_origins=ORIGINS, allow_methods=["GET", "POST", "OPTIONS"],
                         allow_headers=["content-type", "x-chat-ticket"], max_age=3600)] \
    if RELAY and os.environ.get("LOCAL_CORS") == "1" else []

app = Starlette(lifespan=lifespan, middleware=middleware, routes=routes)

if __name__ == "__main__":
    if RELAY:
        for name in ("GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "CHAT_TICKET_KEY", "ALLOWED_ORIGIN"):
            if not os.environ.get(name):
                raise SystemExit(f"Set {name}.")
        uvicorn.run(app, host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", 8080)),
                    log_level="warning", access_log=False, proxy_headers=True, forwarded_allow_ips="*")
    else:
        port = int(os.environ.get("PORT", 8765))
        print(f"Ask your data: http://127.0.0.1:{port}", flush=True)
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
