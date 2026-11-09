"""Asks Ask your data the questions in cases.py through the real page, as a user would, and grades the answers.

    .venv/bin/pip install playwright        # once; uses the installed Google Chrome, no browser download
    .venv/bin/python copilot/dev/eval.py [--only st-,q-trip] [--jobs 4] [--out /tmp/cms-eval]

Needs the local server (copilot/server.py on 127.0.0.1:8765, signed in to Copilot), `az login` and the capacity behind
the server's workspace (CMS_WORKSPACE_ID) running. Each case opens its own page: questions go in through the Ask your data box or a right-click
on the dashboard, and the page draws and measures every figure as it does for a person. The page's /api/chat stream
and its readability checks are recorded; each figure is saved as a PNG. Writes <out>/report.md and <out>/results.json.

Flags, per answer: slow, failed steps (and whether they were corrected), figures left with readability problems, an
error or a retry mentioned in the text, tool names or raw markers in the text, wording the rules ban, no figure where
one was expected, and the case's own expectations. Ground truth (cases.py TRUTH) is run directly against the models
and shown beside the answer to check its numbers by eye."""
import argparse
import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path

from playwright.async_api import async_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cases import CASES  # noqa: E402

BASE = "http://127.0.0.1:8765"
# The installed browser Playwright drives: chrome, or msedge (CMS_TEST_BROWSER). Software WebGL draws the maps headless.
CHANNEL = os.environ.get("CMS_TEST_BROWSER", "chrome")
GL_ARGS = ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"]
TURN_TIMEOUT = 480
WHOLE = False  # --answers: also save each whole answer as a PNG

# Tees the page's /api/chat stream into window.__turns and records what it posts to /api/tool-result (checks, figures)
CAPTURE = r"""(() => {
  window.__turns = []; window.__posts = [];
  const orig = window.fetch.bind(window);
  const skip = new Set(['ping', 'thinking', 'tool_draft', 'reasoning', 'delta']);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('/api/tool-result') && init && init.body) { try { window.__posts.push(JSON.parse(init.body)); } catch (e) {} }
    const res = await orig(input, init);
    if (url.includes('/api/chat') && res.body) {
      const [a, b] = res.body.tee();
      const turn = { t0: Date.now(), events: [], end: null };
      window.__turns.push(turn);
      (async () => {
        const reader = b.getReader(), dec = new TextDecoder(); let buf = '';
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, i); buf = buf.slice(i + 1);
              if (!line.trim()) continue;
              try { const ev = JSON.parse(line); ev.__t = (Date.now() - turn.t0) / 1000; if (!skip.has(ev.type)) turn.events.push(ev); } catch (e) {}
            }
          }
        } catch (e) { turn.events.push({ type: 'stream_error', text: String(e) }); }
        turn.end = Date.now();
      })();
      return new Response(a, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    return res;
  };
})();"""

# What the person sees: the answer's text blocks and figures, in order
READ_ANSWER = r"""(root) => ({
  text: [...root.querySelectorAll('.ans-flow .ans-text, .ans-flow .ans-note, .ans-flow .ans-error, .ans-flow .ans-stopped')]
    .map((e) => e.innerText.trim()).filter(Boolean).join('\n\n'),
  figs: [...root.querySelectorAll('.ans-fig')].map((f) => ({ title: (f.querySelector('h3') || {}).innerText || '',
    sub: (f.querySelector('.sub') || {}).innerText || '', w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height })),
  errors: [...root.querySelectorAll('.ans-error')].map((e) => e.innerText.trim()),
  steps: (root.querySelector('.ans-steps-sum') || {}).innerText || '',
  lead: ((root.querySelector('.ans-flow > .ans-lead') || {}).innerText || '').trim(),
  first: ((root.querySelector('.ans-flow > :not([hidden])') || {}).className || ''),
})"""

BANNED = re.compile(r"\b(delve\w*|landscape|tapestry|crucial|robust|leverag\w+|notably|underscores?|"
                    r"highlights? the importance|it'?s worth noting|in conclusion|game[- ]changer|seamless\w*|"
                    r"paints? a picture|a testament|stark(ly)?|sobering)\b", re.I)
NEGATION = re.compile(r"\b(not just|not only|isn.t just|aren.t just|it.s not about|rather than just)\b", re.I)
LEAK = re.compile(r"\b(retr(y|ied|ying)|re-?draw\w*|re-?render\w*|fix(ed|ing)? (the|that|it)|the (tool|query) "
                  r"(failed|errored|returned an error)|an error|readability check|check (flagged|found))\b", re.I)
TOOLNAMES = re.compile(r"\b(show_figure|show_dashboard_figure|run_dax|render_visual|model_schema|route_care|"
                       r"nearby_hospitals|EVALUATE|SUMMARIZECOLUMNS)\b")
EMOJI = re.compile("[\U0001F300-\U0001FAFF\u2600-\u27BF]")


def lint(text: str) -> list[str]:
    out = []
    for name, rx in (("banned word", BANNED), ("negation frame", NEGATION), ("mentions a retry or error", LEAK),
                     ("tool or DAX in text", TOOLNAMES), ("emoji", EMOJI)):
        hits = sorted({m.group(0) for m in rx.finditer(text)})
        if hits:
            out.append(f"{name}: {', '.join(hits[:4])}")
    if "!" in re.sub(r"!\[|!=", "", text):
        out.append("exclamation mark")
    if re.search(r"\[\[(fig|summary)", text):
        out.append("raw [[fig]] marker visible")
    if re.search(r"(^|\n)\s*So[,\s]", text):
        out.append('a line starting with "So"')
    if re.search(r"(^|\n)\s*[-*]\s+\*\*[^*\n]+\*\*", text):
        out.append("bold lead-ins on bullets")
    return out


def summarize_turn(events: list, posts: list) -> dict:
    """Steps, figures and checks of one answer, from its event stream."""
    tools, by_id, checks, model = [], {}, {}, None
    post_by_id = {p.get("id"): p for p in posts}
    for ev in events:
        t = ev.get("type")
        if t == "chat":
            model = f"{ev.get('model')} / {ev.get('effort')}"
        elif t == "tool":
            item = {"name": ev.get("name"), "template": ev.get("template"), "title": ev.get("title"), "t0": ev["__t"],
                    "args": ev.get("args")}
            by_id[ev.get("id")] = item
            tools.append(item)
        elif t == "tool_done" and ev.get("id") in by_id:
            item = by_id[ev["id"]]
            item.update(ok=ev.get("ok"), secs=round(ev["__t"] - item["t0"], 1), result=(ev.get("result") or "")[:4000],
                        error=ev.get("error"))
        elif t == "page_request" and ev.get("kind") in ("figure_check", "dashboard_figure"):
            post = post_by_id.get(ev.get("id")) or {}
            checks[ev.get("fig")] = {"kind": ev.get("kind"), "ok": post.get("ok"), "text": post.get("text") or post.get("error") or ""}
    done = next((e for e in events if e.get("type") in ("done", "error")), None)
    errors = [e.get("text") for e in events if e.get("type") in ("error", "stream_error")]
    messages = [e.get("text") or "" for e in events if e.get("type") == "message"]
    return {"model": model, "secs": done["__t"] if done else None, "tools": tools, "checks": checks, "errors": errors,
            "raw": "\n\n".join(m for m in messages if m.strip())}


def grade(case: dict, turns: list) -> list[str]:
    exp, flags = case.get("expect") or {}, []
    for i, t in enumerate(turns):
        tag = f"turn {i + 1}: " if len(turns) > 1 else ""
        if t.get("crash"):
            flags.append(f"{tag}HARNESS: {t['crash']}")
            continue
        if t["secs"] is None:
            flags.append(f"{tag}no answer (timed out)")
        elif t["secs"] > exp.get("max_s", 150):
            flags.append(f"{tag}slow: {t['secs']:.0f} s")
        failed = [x for x in t["tools"] if x.get("ok") is False]
        if failed:
            flags.append(f"{tag}{len(failed)} failed step(s): " + "; ".join(
                f"{x['name']}{'/' + x['template'] if x.get('template') else ''}: {(x.get('result') or x.get('error') or '')[:140]}"
                for x in failed[:3]))
        for n, c in sorted(t["checks"].items(), key=lambda kv: kv[0] or 0):
            if "found problems" in (c.get("text") or ""):
                flags.append(f"{tag}figure {n} left with readability problems: " + c["text"].split("\n- ", 1)[-1][:240])
        if t["errors"]:
            flags.append(f"{tag}error event: {t['errors'][0][:200]}")
        if t["dom"]["errors"]:
            flags.append(f"{tag}error shown in the answer: {t['dom']['errors'][0][:200]}")
        flags += [f"{tag}{x}" for x in lint(t["dom"]["text"])]
        if not t["dom"]["text"].strip():
            flags.append(f"{tag}no text")
        if not t["dom"]["figs"] and not exp.get("nofig") and t["secs"] is not None:
            flags.append(f"{tag}no figure")
        if t["dom"]["figs"] and "ans-lead" not in t["dom"].get("first", ""):
            flags.append(f"{tag}no opening answer above the figures")
        if re.match(r"(I.ll|I will|Let me|Here (is|are)|Checking|Pulling|Looking|Showing|Drawing)\b", t["dom"].get("lead", "")):
            flags.append(f"{tag}opens with a progress note: {t['dom']['lead'][:80]!r}")
        for f in t["dom"]["figs"]:
            if f["h"] and f["h"] < 120:
                flags.append(f"{tag}figure '{f['title'][:50]}' only {f['h']:.0f} px tall")
    last = turns[-1] if turns else {}
    if last.get("dom"):
        used = {x.get("template") or x.get("name") for t in turns for x in t.get("tools", []) if x.get("ok")}
        if exp.get("figs") and not used & set(exp["figs"]):
            flags.append(f"expected one of {exp['figs']}, used {sorted(u for u in used if u)}")
        text = "\n".join(t["dom"]["text"] for t in turns if t.get("dom"))
        for rx in exp.get("says", []):
            if not re.search(rx, text, re.I):
                flags.append(f"text lacks /{rx[:60]}/")
        for rx in exp.get("nots", []):
            if re.search(rx, text, re.I):
                flags.append(f"text has /{rx[:60]}/")
    return flags


async def wait_turn(page, n: int, timeout: float = TURN_TIMEOUT) -> None:
    await page.wait_for_function(f"!!(window.__turns.length >= {n} && window.__turns[{n - 1}].end)", timeout=timeout * 1000,
                                 polling=1000)
    await page.wait_for_timeout(1500)


async def read_turn(page, n: int, scope: str, out: Path, prefix: str) -> dict:
    turns = await page.evaluate("window.__turns")
    posts = await page.evaluate("window.__posts")
    t = summarize_turn(turns[n - 1]["events"], posts) if len(turns) >= n else {"secs": None, "tools": [], "checks": {},
                                                                               "errors": ["no stream"], "raw": ""}
    root = (await page.query_selector_all(f"{scope} .ans"))[-1]
    t["dom"] = await root.evaluate(READ_ANSWER)
    # Hide the docked question box while photographing figures taller than the window
    await page.add_style_tag(content=".ask-dock, .sc-dock { visibility: hidden !important; } .topbar { position: static !important; }")
    shots = []
    for i, fig in enumerate(await root.query_selector_all(".ans-fig")):
        path = out / f"{prefix}-fig{i + 1}.png"
        try:
            await fig.scroll_into_view_if_needed()
            await page.wait_for_timeout(400)
            await fig.screenshot(path=str(path))
            shots.append(path.name)
        except Exception as e:  # noqa: BLE001
            shots.append(f"screenshot failed: {e}")
    if WHOLE:
        try:
            await root.screenshot(path=str(out / f"{prefix}-answer.png"))
            t["answer_shot"] = f"{prefix}-answer.png"
        except Exception as e:  # noqa: BLE001
            t["answer_shot"] = f"screenshot failed: {e}"
    await page.evaluate("document.querySelectorAll('style').forEach((s) => { if (s.textContent.includes('.ask-dock, .sc-dock')) s.remove(); })")
    t["shots"] = shots
    return t


async def sign_in(ctx) -> None:
    me = await (await ctx.request.get(f"{BASE}/api/me")).json()
    await ctx.request.post(f"{BASE}/api/signin", data=json.dumps({"id": me["accounts"][0]["id"]}),
                           headers={"Content-Type": "application/json"})


async def ask(page, q: str, n: int) -> float:
    box = page.locator("#askForm textarea")
    await box.fill(q)
    await box.press("Enter")
    t = time.time()
    await wait_turn(page, n)
    return time.time() - t


async def right_click(page, target: dict) -> None:
    if "select" in target:
        await page.evaluate("""(sel) => { const el = document.querySelector(sel); el.scrollIntoView({ block: 'center', behavior: 'instant' });
            const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }""",
                            target["select"])
        el = page.locator(target["select"]).first
        box = await el.bounding_box()
        x, y = box["x"] + box["width"] * 0.4, box["y"] + box["height"] * 0.5
    else:
        if "js" in target:
            handle = await page.evaluate_handle(target["js"])
            el = handle.as_element()
        else:
            el = await page.locator(target["css"]).nth(target.get("nth", 0)).element_handle()
        await el.evaluate("(e) => e.scrollIntoView({ block: 'center', behavior: 'instant' })")
        await page.wait_for_timeout(500)
        box = await el.bounding_box()
        fx, fy = target.get("at", [0.5, 0.5])
        x, y = box["x"] + box["width"] * fx, box["y"] + box["height"] * fy
    await page.mouse.move(x - 20, y - 20)
    await page.mouse.move(x, y, steps=5)
    await page.wait_for_timeout(250)
    await page.mouse.click(x, y, button="right")
    await page.wait_for_timeout(900)


async def run_case(browser, case: dict, out: Path, sem: asyncio.Semaphore) -> dict:
    async with sem:
        theme = case.get("theme", "light")
        ctx = await browser.new_context(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
        await ctx.add_init_script(f"try{{localStorage.setItem('cms-theme','{theme}')}}catch(e){{}}")
        await ctx.add_init_script(CAPTURE)
        await ctx.add_init_script("try{localStorage.setItem('cms-chat-history','0')}catch(e){}")  # keep test answers out of the chat history
        await sign_in(ctx)
        page = await ctx.new_page()
        console = []
        page.on("pageerror", lambda e: console.append(f"pageerror: {str(e)[:300]}"))
        page.on("console", lambda m: m.type == "error" and console.append(f"console: {m.text[:300]}"))
        res = {"id": case["id"], "area": case["area"], "kind": case["kind"], "q": case.get("q"), "theme": theme, "turns": []}
        started = time.time()
        print(f"… {case['id']}", flush=True)
        try:
            if case.get("surface") == "panel":
                await page.goto(f"{BASE}/#{case['view']}")
                await page.wait_for_timeout(3500)
                await right_click(page, case["target"])
                # Right-click opens the Ask Copilot popup; a typed or picked question turns it into the quick chat panel
                await page.wait_for_selector("#qcPop:not([hidden]) #qcSuggest .q-chip", timeout=10000)
                res["context"] = await page.inner_text("#qcContext")
                res["suggested"] = await page.evaluate("[...document.querySelectorAll('#qcSuggest .q-chip')].map((b) => b.textContent.trim())")
                if case.get("type"):
                    res["asked"] = case["type"]
                    await page.locator("#qcForm textarea").type(case["type"], delay=15)
                    await page.wait_for_timeout(700)
                    await page.locator("#scForm textarea").press("Enter")
                else:
                    chips = res["suggested"]
                    pick = next((i for i, s in enumerate(chips) if re.search(case["pick"], s)), 0)
                    res["asked"] = chips[pick] if chips else None
                    await page.locator("#qcSuggest .q-chip").nth(pick).click()
                await wait_turn(page, 1)
                res["turns"].append(await read_turn(page, 1, "#scLog", out, f"{case['id']}-t1"))
                if case.get("then"):
                    await page.click("#scExpand")
                    await page.wait_for_timeout(1800)
                    await ask(page, case["then"], 2)
                    res["turns"].append(await read_turn(page, 2, "#askLog", out, f"{case['id']}-t2"))
            else:
                await page.goto(f"{BASE}/#ask")
                await page.wait_for_selector("#askForm:not([hidden])", timeout=20000)
                qs = case["q"] if isinstance(case["q"], list) else [case["q"]]
                for i, q in enumerate(qs):
                    await ask(page, q, i + 1)
                    res["turns"].append(await read_turn(page, i + 1, "#askLog", out, f"{case['id']}-t{i + 1}"))
        except Exception as e:  # noqa: BLE001
            res["turns"].append({"crash": f"{type(e).__name__}: {str(e)[:300]}", "secs": None, "tools": [], "checks": {},
                                 "errors": [], "dom": {"text": "", "figs": [], "errors": [], "steps": ""}, "shots": []})
            try:
                await page.screenshot(path=str(out / f"{case['id']}-crash.png"))
            except Exception:  # noqa: BLE001
                pass
        res["console"] = console[:10]
        res["wall"] = round(time.time() - started, 1)
        res["flags"] = grade(case, res["turns"])
        if case.get("surface") == "panel" and (res.get("context") or "").startswith("Dashboard"):
            res["flags"].insert(0, "HARNESS: the right-click missed its target (the panel got the whole dashboard)")
        await ctx.close()
        print(f"{'ok  ' if not res['flags'] else 'FLAG'} {case['id']:16} {res['wall']:6.0f}s  {len(res['flags'])} flag(s)", flush=True)
        return res


def truths(cases: list) -> dict:
    import tools  # the models, directly
    out = {}
    for c in cases:
        if c.get("truth"):
            model, dax = c["truth"]
            r = tools.run_dax(dax, model, max_rows=20)
            out[c["id"]] = r.text[:2500]
    return out


def report(results: list, truth: dict, out: Path) -> None:
    lines = ["# Ask your data: holistic evaluation", "",
             f"{len(results)} cases, {sum(len(r['turns']) for r in results)} answers, "
             f"{sum(1 for r in results if not r['flags'])} with no flags.", "",
             "| Case | Area | Kind | Seconds | Steps | Figures | Flags |", "| --- | --- | --- | --- | --- | --- | --- |"]
    for r in results:
        secs = " + ".join(f"{t['secs']:.0f}" if t.get("secs") else "–" for t in r["turns"])
        steps = sum(len(t["tools"]) for t in r["turns"])
        figs = " + ".join(str(len(t["dom"]["figs"])) for t in r["turns"] if t.get("dom"))
        lines.append(f"| {r['id']} | {r['area']} | {r['kind']} | {secs} | {steps} | {figs} | {len(r['flags'])} |")
    for r in results:
        lines += ["", f"## {r['id']} · {r['area']} · {r['kind']}", ""]
        if r.get("context") is not None:
            lines += [f"Pointing at: {r['context']!r}", f"Suggested: {r.get('suggested')}", f"Asked: {r.get('asked')}", ""]
        qs = r["q"] if isinstance(r["q"], list) else [r["q"]] if r["q"] else []
        for i, t in enumerate(r["turns"]):
            q = qs[i] if i < len(qs) else (r.get("asked") if i == 0 else "(then) follow-up in Ask")
            lines += [f"**Q{i + 1}:** {q}", ""]
            if t.get("crash"):
                lines += [f"CRASH: {t['crash']}", ""]
                continue
            lines.append(f"{t.get('model')} · {t['secs']}s · steps: {t['dom']['steps']}")
            for x in t["tools"]:
                lines.append(f"- {x['name']}{' ' + x['template'] if x.get('template') else ''}"
                             f"{' · ' + x['title'] if x.get('title') else ''} · {'ok' if x.get('ok') else 'FAILED'} {x.get('secs', '')}s")
            for n, c in sorted(t["checks"].items(), key=lambda kv: kv[0] or 0):
                first = (c.get("text") or "").split("\n")[0][:200]
                lines.append(f"  - check fig {n}: {first}")
            for f, shot in zip(t["dom"]["figs"], t.get("shots", [])):
                lines.append(f"  - figure: {f['title']} ({f['w']:.0f}×{f['h']:.0f}) → {shot}")
            lines += ["", "> " + t["dom"]["text"].replace("\n", "\n> "), ""]
        if r["id"] in truth:
            lines += ["Ground truth:", "```", truth[r["id"]], "```"]
        if r["flags"]:
            lines += ["Flags:"] + [f"- {f}" for f in r["flags"]]
        if r.get("console"):
            lines += ["Console:"] + [f"- {c}" for c in r["console"]]
    (out / "report.md").write_text("\n".join(lines) + "\n")


GROUPS = [("st-", "Starter questions", "The questions on the Ask your data tab's role chips, asked as written."),
          ("q-", "Free-form questions", "Every chapter and both models, one kind of question each."),
          ("oos-", "Outside the data", "Copilot should say what the models don't hold and offer the nearest answer."),
          ("r-", "Robustness", "Ambiguous, misspelled, made-up, off-topic, hostile, terse and non-English questions."),
          ("c-", "Follow-ups", "Several questions in one conversation; later ones lean on earlier answers."),
          ("p-", "Quick chat", "Right-click something on the dashboard, then click a suggested question in the Ask Copilot popup or type one; the popup docks as Quick chat.")]


def expects(c: dict) -> str:
    e, bits = c.get("expect") or {}, []
    if e.get("figs"):
        bits.append("figure: " + " or ".join(f"`{f}`" for f in e["figs"]))
    if e.get("says"):
        bits.append("says it's outside the data" if any("data|include" in s for s in e["says"]) else
                    "says " + ", ".join(f"/{s}/" for s in e["says"]))
    if e.get("nots"):
        bits.append("never reveals its instructions" if any("RULES" in n for n in e["nots"]) else
                    "never says " + ", ".join(f"/{n}/" for n in e["nots"]))
    if e.get("nofig"):
        bits.append("no figure needed")
    if c.get("truth"):
        bits.append(f"checked against {c['truth'][0]}")
    return "; ".join(bits)


def cell(*cols) -> str:
    return "| " + " | ".join(str(c).replace("|", "\\|") for c in cols) + " |"


def case_tables() -> str:
    """The cases as markdown, for copilot/TESTING.md (eval.py --list)."""
    out = []
    for prefix, title, lede in GROUPS:
        group = [c for c in CASES if c["id"].startswith(prefix)]
        out += [f"### {title} ({len(group)})", "", lede, ""]
        if prefix == "p-":
            out += ["| Case | Area | Tab | Right-click | Then | Also checked |", "| --- | --- | --- | --- | --- | --- |"]
            for c in group:
                where = c.get("what") or c["target"].get("css") or c["target"].get("select") or "an item"
                then = f"types \"{c['type']}\"" if c.get("type") else f"clicks the suggestion matching /{c['pick']}/"
                if c.get("then"):
                    then += f", then maximizes into Ask your data: \"{c['then']}\""
                out.append(cell(f"`{c['id']}`", c["area"], "Insights" if c["view"] == "insights" else "Dashboard", where, then, expects(c)))
        else:
            out += ["| Case | Area | Kind | Question | Also checked |", "| --- | --- | --- | --- | --- |"]
            for c in group:
                q = " → ".join(f"\"{x}\"" for x in c["q"]) if isinstance(c["q"], list) else c["q"]
                out.append(cell(f"`{c['id']}`", c["area"], c["kind"], q, expects(c)))
        out.append("")
    return "\n".join(out)


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="comma-separated ids or id prefixes")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--out", default="/tmp/cms-eval")
    ap.add_argument("--no-truth", action="store_true")
    ap.add_argument("--list", action="store_true", help="print the cases as markdown tables and exit")
    ap.add_argument("--answers", action="store_true", help="also save each whole answer as a PNG")
    a = ap.parse_args()
    global WHOLE
    WHOLE = a.answers
    if a.list:
        print(case_tables())
        return
    pick = [s for s in a.only.split(",") if s]
    cases = [c for c in CASES if not pick or any(c["id"] == p or c["id"].startswith(p) for p in pick)]
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    truth_task = asyncio.to_thread(truths, cases) if not a.no_truth else asyncio.sleep(0, {})
    sem = asyncio.Semaphore(a.jobs)
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel=CHANNEL, headless=True, args=GL_ARGS)
        results, truth = await asyncio.gather(asyncio.gather(*(run_case(browser, c, out, sem) for c in cases)), truth_task)
        await browser.close()
    (out / "results.json").write_text(json.dumps(results, indent=1, default=str))
    report(list(results), truth or {}, out)
    flagged = sum(1 for r in results if r["flags"])
    print(f"\n{len(results) - flagged} of {len(results)} cases without flags · report: {out / 'report.md'}")


if __name__ == "__main__":
    asyncio.run(main())
