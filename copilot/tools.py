"""The tools Copilot answers with: figures from the template library, bespoke Vega-Lite or d3 visuals, DAX, the
schema of the two models, and the dashboard's own figures.

Adapted from the author's earlier MCP server for conversational analytics on Fabric, changed for this dashboard: no MCP
layer, two semantic models (CMS and CMS V2), the dashboard's colours, server-side
projections, the dot_map template and show_dashboard_figure.

Each tool is a plain function that returns an Out: the text for the model, whether it worked, and the payload the page
draws (ui). Tools run in a worker thread; DAX goes through fabric.dax(), whose runner the server sets per chat."""
import copy
import csv
import io
import json
import math
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from statistics import NormalDist
from typing import Any

import vl_convert as vlc

import fabric
import geo

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
VENDOR = ROOT / "assets" / "vendor" / "vega"

# Appended to every figure tool's result: the narrative goes right under its figure, the summary at the end.
NARRATE = ("Next, write 2-4 sentences on what it shows, so they appear right under it, before you show any other "
           "figure. After the last figure, end with a short summary (1-3 sentences).")


@dataclass
class Out:
    text: str
    ok: bool = True
    ui: dict | None = None


def error(text: str) -> Out:
    return Out(text, ok=False)


_cache = {}


def cached(key, fn, ttl=1800):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    value = fn()
    _cache[key] = (time.time(), value)
    return value


# --- render_visual: any chart, built on the fly ------------------------------------------
STATE_FIPS = {
    "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC",
    "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
    "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT",
    "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
    "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT",
    "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY", "60": "AS", "66": "GU", "69": "MP",
    "72": "PR", "78": "VI"}
GEO_URLS = {"us-states", "us-states.json", "us-10m.json", "data/us-10m.json", "states-10m.json"}
# The dashboard's named colour schemes (registered in the page from the light/dark tokens); validation swaps them for
# the light theme's colours. Orange only ever means worse: "worse" grades it, "palette" leaves it out.
APP_SCHEMES = {"diverging": ["#4F86BD", "#E6E3D9", "#B0450A"],
               "worse": ["#E6E3D9", "#B0450A"],
               "better": ["#E6E3D9", "#4F86BD"],
               "magnitude": ["#E6E3D9", "#57564F"],
               "olive": ["#E6E3D9", "#788C5D"],
               "palette": ["#57564F", "#788C5D", "#D4A27F", "#C46686", "#6A9BCC", "#6F6D64"]}
APP_SCHEMES["clay"] = APP_SCHEMES["worse"]  # the conversational repo's name for the sequential scheme
MAX_ROWS = 30000
VL_VERSION = "6.4"  # matches the bundled vega-lite 6.4.3, so a spec that validates here renders the same in the chat


def _us_states():
    topo = json.loads((VENDOR / "us-states-10m.json").read_text())
    for g in topo["objects"]["states"]["geometries"]:
        g["properties"]["abbr"] = STATE_FIPS.get(g["id"], "")
    return topo


US_STATES = _us_states()


def _clean(v):
    if isinstance(v, float):
        return int(v) if v.is_integer() else round(v, 4)
    return v


def to_csv(rows, max_rows):
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=list(dict.fromkeys(k for r in rows for k in r)), restval="")
    w.writeheader()
    for r in rows[:max_rows]:
        w.writerow({k: _clean(v) for k, v in r.items()})
    return buf.getvalue()


def _with_geo(node):
    """Copy of a spec for validation: the us-states URL becomes the bundled shapes and app scheme names
    become their colours (the validator's Vega doesn't know them)."""
    if isinstance(node, list):
        return [_with_geo(n) for n in node]
    if not isinstance(node, dict):
        return node
    out = {k: _with_geo(v) for k, v in node.items()}
    url = out.get("url")
    if isinstance(url, str) and (url in GEO_URLS or url.rsplit("/", 1)[-1] in GEO_URLS):
        del out["url"]
        out["values"] = US_STATES
        out["format"] = {"type": "topojson", "feature": "states", **(out.get("format") or {})}
    scheme = out.get("scheme")
    name = scheme.get("name") if isinstance(scheme, dict) else scheme
    if isinstance(name, str) and name in APP_SCHEMES:
        del out["scheme"]
        out["range"] = APP_SCHEMES[name]
    return out


VISUAL_DOC = """Render a bespoke visual when no show_figure template fits the question (try show_figure first).
Use it for combined/layered charts, unusual encodings, custom interactions, or a visual the user describes.

spec (preferred): a Vega-Lite v6 JSON spec. Bind data with `dax`: the query's rows become the dataset
"rows", referenced as "data": {"name": "rows"} (added automatically if the spec has no data). `queries`
adds more named datasets ({"name": "DAX"}), e.g. for lookups or layers. Alias every DAX output column
("Year", 'HAI'[REPORTYEAR]) and use those exact names as fields. Do not type numbers into the spec.
Everything Vega-Lite supports works: bar, line, area, point, rect heatmap, boxplot, arc/pie, text, rule,
layer, facet/concat/repeat, transforms (filter, calculate, fold, window, aggregate, bin, lookup, ...),
params with sliders/dropdowns ("bind") and click/brush selections, tooltips.
Style guide (the app theme is applied; leave out width and config unless needed):
- Title states the finding; the spec itself needs no title (the card shows title and subtitle).
- Annotate the answer: layer a rule for the benchmark/national value and text marks labelling the key
  points (peak, outliers, the items the question is about); label lines directly instead of a legend.
- Colour by meaning, as the dashboard does: orange only ever means worse, blue better, ink for neutral amounts.
  For "lower is better" measures use "scale": {"scheme": "diverging", "domainMid": <benchmark or national value>}
  (blue = low, orange = high); add "reverse": true when higher is better. Sequential: "worse" (neutral to orange, for
  how much worse), "better" (neutral to blue), "magnitude" (neutral to ink, for counts and populations). Categories:
  "palette" (no orange). Don't use orange, or a single-colour ramp of it, for anything that isn't worse.
US maps: state shapes are built in. Use {"url": "us-states", "format": {"type": "topojson", "feature": "states"}};
each feature has properties.abbr (2-letter code, matches the CMS STATE column) and properties.name.
Choropleth from rows: start from "rows", add the transform
  {"lookup": "State", "from": {"data": {"url": "us-states", "format": {"type": "topojson", "feature": "states"}},
   "key": "properties.abbr"}, "as": "geo"}
then "mark": "geoshape", "projection": {"type": "albersUsa"}, "encoding": {"shape": {"field": "geo", "type":
"geojson"}, "color": {...}}. In a facet, mark/encoding/projection go inside "spec"; set "columns": 3.
Expressions in filter/calculate use the Vega expression language, not JavaScript: no method calls. Write
indexof(['GU','VI'], datum.State) < 0, format(datum.SIR, '.2f'), test(/^A/, datum.State).
To filter rows, prefer doing it in DAX.

html (last resort, for what neither show_figure nor Vega-Lite can express: sankey, network, bespoke
infographic): a plain HTML snippet (no CDATA, no <html>/<head>) with inline <script>, run in a sandbox with no
network. Available: d3 v7, topojson, window.DATA (dataset name -> rows, from dax/queries: read numbers from it,
don't hard-code), window.US_STATES (topojson, as above), window.PALETTE (theme colours: text, muted, grid, accent,
good, bad, neutral, surface...), window.THEME ("light"/"dark") and window.askCopilot(text) for drill-down.
Size the content to its container width. Colour only from window.PALETTE (orange = PALETTE.bad, only for worse), text
at 11 px or more, and bars from zero. After drawing, the page measures the visual's labels and reports problems.

The spec is validated before it is shown; on an error you get the message back: fix it and call again."""


def render_visual(title: str, spec: dict | str | None = None, html: str | None = None, dax: str | None = None,
                  queries: dict | None = None, model: str = "CMS", subtitle: str | None = None,
                  kicker: str | None = None, source: str | None = None) -> Out:
    if isinstance(spec, str):
        try:
            spec = json.loads(spec)
        except json.JSONDecodeError as e:
            return error(f"spec is not valid JSON: {e}")
    if (spec is None) == (html is None):
        return error("Pass exactly one of spec (Vega-Lite, preferred) or html.")
    if html is not None:  # models sometimes wrap HTML in an XML CDATA section; browsers would eat the first tag
        html = re.sub(r"^\s*<!\[CDATA\[|\]\]>\s*$", "", html)

    data = {}
    for name, query in (({"rows": dax} if dax else {}) | (queries or {})).items():
        q, m = (query.get("dax"), query.get("model", model)) if isinstance(query, dict) else (query, model)
        try:
            rows = fabric.dax(q, m)
        except fabric.DaxError as e:
            return error(f"DAX error in dataset '{name}': {e}")
        if len(rows) > MAX_ROWS:
            return error(f"Dataset '{name}' has {len(rows):,} rows (max {MAX_ROWS:,}). Aggregate in DAX and try again.")
        data[name] = [{k: _clean(v) for k, v in r.items()} for r in rows]

    out = {"view": "visual", "title": title, "subtitle": subtitle, "kicker": kicker,
           "source": source or source_of(model)}
    if spec is not None:
        spec = copy.deepcopy(spec)
        spec.setdefault("$schema", "https://vega.github.io/schema/vega-lite/v6.json")
        if data:
            spec["datasets"] = {**(spec.get("datasets") or {}), **data}
            if "data" not in spec:  # layer/concat/repeat children inherit it; a child's own data still wins
                spec["data"] = {"name": "rows" if "rows" in data else next(iter(data))}
        try:
            vlc.vegalite_to_svg(_with_geo(spec), vl_version=VL_VERSION)
        except Exception as e:
            msg = "\n".join(ln for ln in str(e).splitlines() if not ln.strip().startswith("at "))
            msg = re.sub(r"Vega-Lite to SVG conversion failed:\s*(Error:\s*)?", "", msg).strip()
            msg = re.sub(r"Invalid specification (\{.*\})\.", lambda m: "Invalid specification " +
                         (m[1][:240] + " …" if len(m[1]) > 240 else m[1]) + ".", msg, flags=re.S)
            if "callee" in msg or "MemberExpression" in msg:
                msg += ("\nHint: Vega expressions are not JavaScript, so method calls like x.indexOf() or x.toFixed() "
                        "fail. Use Vega functions: indexof(array, value), format(x, '.2f'), test(/re/, s), toString(x).")
            return error(f"Vega-Lite error: {msg}\nFix the spec and call render_visual again.")
        out.update(mode="vega", spec=spec)
    else:
        out.update(mode="html", html=html, data=data)

    lines = [f"Visual '{title}' ({'Vega-Lite' if spec is not None else 'custom HTML'}) is shown to the user. {NARRATE}"]
    for name, rows in data.items():
        if rows:
            lines.append(f"\nDataset '{name}': {len(rows):,} rows; columns: {', '.join(rows[0])}. First rows:\n" +
                         to_csv(rows, 15))
        else:
            lines.append(f"\nDataset '{name}': 0 rows. The visual is empty: check the DAX.")
    return Out("\n".join(lines), ui=out)


# --- show_figure: the figure template library (figures/*.js) ----------------------------------
# name: (required roles, optional roles, numeric roles, template options, when to use it)
FIGURES = {
    "kpis": (["label", "value"], ["compare", "time"], ["value", "compare"], ["compare_label", "compare", "delta"],
             "headline numbers with change vs a comparison; with time (long rows label/time/value) each card gets a "
             "sparkline and compares latest vs first. Lead an answer with it."),
    "ranked_bars": (["label", "value"], ["sublabel", "compare"], ["value", "compare"], ["compare_label"],
                    "rank items by a measure; compare = earlier value (ring + change column)."),
    "diverging_bars": (["label", "value"], [], ["value"], [],
                       "how far each item sits above/below the benchmark (or median): better vs worse than expected."),
    "dumbbell": (["label", "from", "to"], ["peak"], ["from", "to", "peak"], ["from_label", "to_label", "delta", "order", "peak_label"],
                 "change between two periods or conditions per item; peak marks an in-between high with a diamond (e.g. the "
                 "pandemic peak); sort='change' orders by improvement."),
    "slope": (["label", "from", "to"], [], ["from", "to"], ["from_label", "to_label", "emphasis"],
              "rank shifts between two periods; the biggest movers are labelled (≤24 items)."),
    "bullet": (["label", "value"], ["target"], ["value", "target"], ["target_label", "min", "max", "ranges"],
               "actual vs target per item (target column or options.benchmark)."),
    "waterfall": (["label", "value"], [], ["value"], ["start", "start_label", "total_label"],
                  "how signed contributions add up from a start to a total (decompose a change)."),
    "waffle": (["label", "value"], ["total"], ["value", "total"], ["total"],
               "a share of a whole as 100 squares per item ('x of N')."),
    "gauge": (["value"], ["label"], ["value"], ["min", "max"],
              "one headline value (or a few) against a benchmark with good/bad zones."),
    "table": ([], ["bar", "color", "value"], ["bar", "color", "value"], ["columns", "sort_by"],
              "exact numbers to look up: sortable, inline bars (bar) and good/bad marks (color + better)."),
    "trend": (["x", "y"], ["series", "lower", "upper"], ["y", "lower", "upper"], ["bands", "peak", "area", "zero", "forecast_from", "forecast_label", "project"],
              "change over time for one or a few series; direct labels, peak callout, bands, annotations. Projections: "
              "set options.project and the server fits the series and adds the projected years with a range (see below)."),
    "small_multiples": (["facet", "x", "y"], [], ["y"], ["bands", "peak", "shared_y", "columns", "order", "zero"],
                        "the same trend for many categories side by side with headline value, change and a "
                        "synchronised crosshair."),
    "area_stack": (["x", "y", "series"], [], ["y"], ["normalize", "order", "palette"],
                   "composition over time (absolute, or 100% with normalize)."),
    "tile_map": (["state", "value"], ["time", "volume"], ["value", "volume"], ["time", "min_volume"],
                 "US states compared on one measure, equal-size tiles with values; time adds a year stepper; "
                 "volume + min_volume hatch unstable states."),
    "geo_map": (["state", "value"], ["time", "volume"], ["value", "volume"], ["time", "min_volume"],
                "US geographic choropleth; same data shape as tile_map."),
    "heatmap": (["row", "col", "value"], [], ["value"], ["sort_rows", "col_order", "change_from", "change_label", "change_format"],
                "a measure across two dimensions (state x year, hospital x measure); values in cells. change_from=<a col "
                "value, e.g. 2019> makes it a baseline + change table: that column shows values, the others the change from it."),
    "scatter": (["x", "y"], ["size", "color", "label"], ["x", "y", "size"],
                ["x_log", "y_log", "x_ref", "y_ref", "quadrants", "trend", "label_top", "x_format", "x_unit", "diagonal", "diagonal_label"],
                "relationship between two measures; reference lines + quadrant labels ({tl,tr,bl,br}), regression, labelled "
                "outliers; diagonal draws y = x (then vs now on both axes; driver/priority matrices with quadrants)."),
    "funnel": (["observed", "expected"], ["label"], ["observed", "expected"], ["y_max", "ratio_label", "center_label", "min_expected"],
               "fair comparison of observed/expected ratios (SIR, SMR, readmission O/E) with Poisson control limits: "
               "who is significantly better or worse given their volume. min_expected leaves out units too small to judge "
               "(CMS doesn't publish an SIR when predicted < 1)."),
    "distribution": (["value"], ["group", "label"], ["value"], ["style", "bins", "min", "max"],
                     "spread of a measure: histogram, or per group as strip (dots + box) or ridge (density)."),
    "stacked_bars": (["category", "part", "value"], [], ["value"], ["normalize", "palette", "part_labels", "sort_by", "order"],
                     "composition of each category (100% by default), e.g. star-rating mix by state; "
                     "palette='ordinal' for ordered parts."),
    "treemap": (["label", "value"], ["group", "color"], ["value", "color"], [],
                "part-to-whole by size, coloured by a group or a measure (color + better)."),
    "beeswarm": (["value"], ["label", "group"], ["value"], ["quartiles", "best_label", "worst_label", "min", "max", "radius", "order", "axis_label"],
                 "where units stand among all their peers: every unit is a dot (thousands are fine), optionally one swarm per "
                 "group (state, star rating, year); quartiles=true shades the best and worst 25% and names each with its "
                 "cut-off (e.g. a penalty zone); a single swarm also draws and names its median, and benchmark draws a named "
                 "dashed line, so the subtitle needn't explain the lines. "
                 "highlight = 'you are here' with the unit's percentile. Add search=true so users can find any unit."),
    "forest": (["label", "value"], ["lower", "upper", "group", "sublabel", "weight"], ["value", "lower", "upper", "weight"],
               ["summary", "log", "ci_label", "order", "min", "max"],
               "estimates with confidence intervals vs a benchmark (SIR with its CI lower/upper): who is significantly "
               "better or worse; summary=[label] draws a pooled row as a diamond; weight sizes the marker (e.g. predicted)."),
    "report_card": (["measure", "value"], ["group", "benchmark", "lower", "upper", "x", "better", "p10", "p25", "p50", "p75", "p90", "sublabel"],
                    ["value", "benchmark", "lower", "upper", "p10", "p25", "p50", "p75", "p90"],
                    ["better_by", "benchmarks", "formats", "units", "order", "strip_label", "value_label"],
                    "one unit (a hospital, a state) across many measures, grouped by domain: value, gap to benchmark, position in "
                    "the peer spread (p10-p90 with the middle half, oriented so right = better), sparkline over x and a badge "
                    "(significance from lower/upper, else quartile). Long rows: one per measure (per measure and x for sparklines). "
                    "Mixed directions: a better column ('lower'/'higher') or better_by {measure: dir}."),
    "scorecard": (["label"], ["sublabel", "badge"], [], ["columns", "filter", "sort_by", "page_size", "search_placeholder", "label_title", "unit_label", "formats"],
                  "interactive table to find and compare units on several measures: search box, filter chips (filter=<column>), "
                  "sortable columns, pages, highlighted rows pinned on top. columns=[{\"col\", \"label\", \"better\", \"benchmark\", "
                  "\"format\", \"type\": num|stars|strip|text}]; cells are tinted best/worst quartile, or vs benchmark when given. "
                  "badge = a short tag column (e.g. 'Leader'). For 'find a hospital', peer and market lists (thousands of rows are fine)."),
    "fan": (["x", "median"], ["p10", "p25", "p75", "p90", "mean", "focus"], ["median", "p10", "p25", "p75", "p90", "mean", "focus"],
            ["missing", "missing_label", "missing_note", "focus_label", "median_label", "upper_label", "lower_label"],
            "how the whole distribution moves over time: median with 25th-75th and 10th-90th percentile bands, mean as rings; "
            "focus = one unit's values against the spread; missing=[x values] marks periods with no data."),
    "lollipop": (["label", "from", "to"], [], ["from", "to"], ["mode", "from_label", "to_label"],
                 "change per item from a baseline (% by default, mode='abs' for points), sorted, with 'from → to' values: "
                 "which components or measures rose or fell most."),
    "bump": (["x", "series"], ["rank", "value"], ["rank", "value"], ["movers"],
             "rank over time (states, hospitals): pass rank, or value + better to rank each period; the biggest movers are emphasised."),
    "alluvial": (["from", "to"], ["value"], ["value"], ["order", "from_label", "to_label"],
                 "units moving between categories from one period to another (star rating 2019 -> 2025, quartile changes). "
                 "Rows are units, or from/to pairs with a count in value; with better, ribbons show improved, same and worsened. "
                 "order lists categories best first."),
    "likert": (["category", "level"], ["value"], ["value"], ["order", "neutral", "category_order", "low_label", "high_label"],
               "an ordered scale (1-5 stars, survey levels) per category as a diverging bar centred on the neutral level, with "
               "the low and high shares: star mix by year, state or dimension. value = count (or share) per level."),
    "columns": (["x", "value"], ["mirror", "n"], ["value", "mirror", "n"], ["palette", "stars", "order", "value_label", "mirror_label", "reverse_palette"],
                "vertical bars for few or ordered categories (years, star ratings) with value labels; mirror draws a second "
                "measure below the axis (share better above, share worse below); n labels each count; star categories show ★."),
    "pareto": (["label", "value"], [], ["value"], ["threshold", "value_label"],
               "concentration, the 'vital few': sorted contributions with the cumulative share and 'the top k of N make up "
               "80%' (excess infections, adverse events). Positive values only; threshold defaults to 0.8."),
    "dot_map": ([], ["id", "lat", "lon", "value", "category", "label", "sublabel", "state", "size"], ["value", "lat", "lon", "size"],
                ["focus", "radius", "category_order", "category_colors"],
                "hospitals as dots on a map of the US (or one state with options.focus='MN'): colour by a measure (value + "
                "better/benchmark) or a category (e.g. NICU level, delivers babies, star rating). Give id = the CCN and the "
                "page places each hospital from the dashboard's geocoded addresses, or lat + lon. Thousands of dots are fine. "
                "For a category, colour the group the question is about strongly and the rest light grey: category_colors "
                "= {\"Cut\": \"worse\", \"No cut\": \"muted\"} (names: worse, better, strong, muted, or any CSS colour); "
                "with no colours, two groups get ink for the smaller and grey for the other. options.radius makes dots "
                "bigger (default about 5 for one state's hospitals)."),
}
OPTION_ALIASES = {"regression": "trend", "trendline": "trend", "x_reference": "x_ref", "y_reference": "y_ref",
                  "reference": "benchmark", "target": "benchmark", "highlights": "highlight", "sort_order": "sort",
                  "drill_prompt": "drill", "selector": "select", "searchable": "search"}
COMMON_OPTIONS = {"better", "benchmark", "benchmark_label", "center", "format", "unit", "highlight", "annotations", "labels",
                  "drill", "limit", "sort", "colors", "height", "select", "select_default", "search", "search_placeholder", "better_by"}

FIGURE_DOC = """Show an analytic figure from a library of polished, interactive templates. This is the default way to
answer: be visual-first. Pick the template that best explains the specific point you are making, tailor it to the
answer (title = the finding, highlight the items asked about, annotate what matters, set the benchmark), and use
several figures when the answer has several parts (e.g. kpis, then a map, then a drill into the outliers).
Vary templates: don't default to bars. Every figure has hover details and click-to-drill.

How: `dax` returns tidy rows (alias every column: "State", 'T'[STATE]); `model` picks the semantic model it runs on
("CMS", the default: HAI, HCAHPS, PSI90; or "CMS V2": outcomes, penalties, ED and maternity); `fields` maps the
template's roles to those column names; `options` tailor it. Templates — roles (optional in []) — when to use:
""" + "\n".join(f"- {k} ({', '.join(v[0] + [f'[{r}]' for r in v[1]]) or 'any columns'}): {v[4]}" for k, v in FIGURES.items()) + """
Options (all optional):
- better: "lower" | "higher": colours good (blue) vs bad (orange) relative to the benchmark. Set it for any
  measure with a direction (infection ratios, PSI 90, mortality: lower; star ratings, compliance: higher).
- benchmark (+ benchmark_label): reference value (1.0 = expected, a target, the national value); colour scales
  and reference lines centre on it. center: colour centre when there's no benchmark (default: median).
- highlight: [values of the label/state/series/facet/row column] to emphasise the items the question is about.
- annotations: trend [{"x": <x value>, "text": "...", "series": <optional>}]; bars [{"label": <item>, "text": "..."}].
- bands (trend, small_multiples): [{"from": x0, "to": x1, "label": "COVID-19"}] to shade a period.
- drill: the follow-up question sent when the user clicks a mark and asks Copilot, with {Column} placeholders
  filled from the clicked row, e.g. "Which hospitals in {State} drive its {Year} infection ratio?".
  Always set it to the natural next question for this figure.
- select: a column (e.g. "Infection") whose values become chips above the figure; it shows one value at a time, so
  one figure covers every measure. Put all measures' rows in the data; select_default picks the first chip.
- search: true (or a column) adds a "Highlight…" box so the user can find any unit (hospital, state) in the figure.
- benchmark may name a column (e.g. "National") so it follows the selected chip; benchmark_label can use {value}.
- better_by: {measure or column: "lower"|"higher"} for figures that mix directions (report_card, scorecard).
- format (d3-format: ".2f", ".0%", ",.0f") and unit (suffix); labels: {"role": "Display name"} for axes/tooltips.
- project (trend only), for "where is this heading" / "project it to 2030": {"periods": 5, "from": 2021, "method":
  "log"|"linear", "level": 0.8}. Pass only the actual years; the server fits each series (log-linear by default for
  ratios and rates, which stay positive), adds the projected years dashed with a shaded prediction range, and returns
  the projected values. Use "from" to leave out years that would distort the fit (for infections "from": 2022,
  after the 2020-2021 COVID peak). x must be numeric years. Never type projected numbers yourself.
report_card shortcut (use it; it's much faster than writing the query): pass profile instead of dax and fields:
  {"unit": {"column": "facility id", "value": "240010"}, "time": "REPORTYEAR",
   "measures": [{"name": "PSI 90", "column": "'PSI90'[CMS Medicare PSI 90: ...]", "group": "Safety", "better": "lower",
                 "benchmark": 1}, {"name": "CLABSI", "column": "'HAI'[HAI_1_SIR-...]", "group": "Infections", "better": "lower",
                 "benchmark": 1, "lower": "'HAI'[HAI_1_CILOWER-...]", "upper": "'HAI'[HAI_1_CIUPPER-...]"}, ...]}
  The server builds the query: the unit's value per year (sparklines), the peer 10th-90th percentiles and the CIs.
  Peers are every unit by default; "peers": {"column": "STATE", "value": "MN"} compares with one state's units.
  Bare unit/time/peer column names apply to each measure's own table. All measures must come from the one model you pass
  (CMS has years; CMS V2's hospital_outcomes has one period, so use unit column "ccn" and no time).
- limit, sort ("desc"|"asc"|"none"); template options are listed in the error message if you use an unknown one.
The figure is validated before it is shown (template, roles, columns, numeric values); errors come back to you."""


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _poisson_q(p, lam):
    if lam > 400:
        return max(0, round(lam + NormalDist().inv_cdf(p) * math.sqrt(lam)))
    k, pk = 0, math.exp(-lam)
    cum = pk
    while cum < p and k < 10000:
        k += 1
        pk *= lam / k
        cum += pk
    return k


def _num_like(v):
    try:
        return math.isfinite(float(v))
    except (TypeError, ValueError):
        return False

def _beats(vals, v, better):
    """Share of the other units that v is better than (ties count half)."""
    if len(vals) < 2:
        return float("nan")
    worse = sum((u < v) if better == "higher" else (u > v) for u in vals)
    tie = sum(u == v for u in vals) - 1
    return (worse + tie / 2) / (len(vals) - 1)


def _quantile(sorted_vals, p):
    if not sorted_vals:
        return float("nan")
    i = (len(sorted_vals) - 1) * p
    lo = math.floor(i)
    return sorted_vals[lo] + (sorted_vals[min(lo + 1, len(sorted_vals) - 1)] - sorted_vals[lo]) * (i - lo)


def _facts_more(template, rows, f, o, fmt, bench):
    """Facts for the position / change / parts templates; None when the template isn't one of them."""
    better = o.get("better") if o.get("better") in ("lower", "higher") else None
    hi = {str(h) for h in (o.get("highlight") or [])}
    num = lambda r, role: r.get(f[role]) if role in f and _num(r.get(f[role])) else None  # noqa: E731
    if template == "heatmap" and o.get("change_from") is not None:
        cols = list(dict.fromkeys(r.get(f["col"]) for r in rows))
        base = next((c for c in cols if str(c) == str(o["change_from"])), None)
        if base is None:
            return [f"change_from {o['change_from']!r} is not a value of '{f['col']}' ({cols[:10]}); the figure shows plain values."]
        last = max((c for c in cols if c != base), key=lambda c: float(c) if _num_like(c) else cols.index(c), default=None)
        cell = {(r.get(f["row"]), r.get(f["col"])): r.get(f["value"]) for r in rows if _num(r.get(f["value"]))}
        d = sorted(((k, cell[(k, last)] - cell[(k, base)]) for k in {r.get(f["row"]) for r in rows}
                    if (k, last) in cell and (k, base) in cell), key=lambda kv: kv[1])
        if not d:
            return []
        below = sum(v < 0 for _, v in d)
        return [f"{last} vs {base}: {below} of {len(d)} rows below the baseline, {sum(v > 0 for _, v in d)} above; "
                f"largest drop {d[0][0]} {d[0][1]:+.3g}, largest rise {d[-1][0]} {d[-1][1]:+.3g}."]
    if template == "beeswarm":
        out, vals = [], sorted(r[f["value"]] for r in rows if _num(r.get(f["value"])))
        if not vals:
            return out
        q1, q2, q3 = (_quantile(vals, p) for p in (0.25, 0.5, 0.75))
        out.append(f"{len(vals):,} units; median {fmt(q2)}, quartiles {fmt(q1)} and {fmt(q3)}.")
        for r in rows:
            if "label" in f and str(r.get(f["label"])) in hi and _num(r.get(f["value"])):
                grp = [x[f["value"]] for x in rows if _num(x.get(f["value"])) and ("group" not in f or x.get(f["group"]) == r.get(f["group"]))]
                b = _beats(grp, r[f["value"]], better or "higher")
                quart = ("best" if (b >= 0.75) else "worst" if b <= 0.25 else "middle") if better else None
                out.append(f"{r[f['label']]}{' (' + str(r.get(f['group'])) + ')' if 'group' in f else ''}: {fmt(r[f['value']])}, "
                           f"{'better' if better else 'higher'} than {b:.0%} of {len(grp):,}{f'; {quart} quartile' if quart else ''}.")
        return out
    if template == "forest":
        if bench is None or not ("lower" in f and "upper" in f):
            return []
        good, bad, same, low, high = [], [], 0, 0, 0
        for r in rows:
            lo_, up_ = num(r, "lower"), num(r, "upper")
            if lo_ is None or up_ is None or str(r.get(f["label"])) in {str(s) for s in ([o.get("summary")] if isinstance(o.get("summary"), str) else o.get("summary") or [])}:
                continue
            side = "below" if up_ < bench else "above" if lo_ > bench else None
            if side is None:
                same += 1
            elif not better:
                low, high = low + (side == "below"), high + (side == "above")
            elif (side == "below") == (better == "lower"):
                good.append(r[f["label"]])
            else:
                bad.append(r[f["label"]])
        if not better:
            return [f"Whole 95% interval below {bench:g}: {low:,}; above: {high:,}; crossing it: {same:,}. No direction is set, "
                    "so the figure doesn't call them better or worse."]
        return [f"Whole 95% interval better than {bench:g}: {len(good):,}; worse: {len(bad):,}; crossing it (no different): {same:,}."
                + (f" Worse: {', '.join(map(str, bad[:6]))}{'…' if len(bad) > 6 else ''}." if bad else "")]
    if template == "report_card":
        latest = {}
        xs = list(dict.fromkeys(r.get(f["x"]) for r in rows)) if "x" in f else None
        if xs and all(_num_like(x) for x in xs):
            xs.sort(key=float)  # same order as the chart (numeric when every x is a number)
        for r in rows:
            m = r.get(f["measure"])
            if _num(r.get(f["value"])) and (m not in latest or (xs and xs.index(r.get(f["x"])) >= xs.index(latest[m].get(f["x"])))):
                latest[m] = r
        good, bad = [], []
        for m, r in latest.items():
            b = str(r.get(f["better"]) or "").lower() if "better" in f else ""
            b = b if b in ("lower", "higher") else (o.get("better_by") or {}).get(m, better)
            per = (o.get("benchmarks") or {}).get(m)
            bm = num(r, "benchmark") if num(r, "benchmark") is not None else per if _num(per) else bench
            lo_, up_, v = num(r, "lower"), num(r, "upper"), r[f["value"]]
            if not b:
                continue
            if lo_ is not None and up_ is not None and bm is not None:
                t = "good" if (up_ < bm) == (b == "lower") and (up_ < bm or lo_ > bm) else "bad" if (up_ < bm or lo_ > bm) else None
            elif num(r, "p25") is not None and num(r, "p75") is not None:
                p25, p75 = num(r, "p25"), num(r, "p75")
                t = "good" if (v <= p25 if b == "lower" else v >= p75) else "bad" if (v >= p75 if b == "lower" else v <= p25) else None
            elif bm is not None:  # within 2% of the benchmark counts as at the benchmark, as on the card
                t = None if abs(v - bm) <= abs(bm) * 0.02 else "good" if (v < bm) == (b == "lower") else "bad"
            else:
                t = None
            (good if t == "good" else bad if t == "bad" else []).append(f"{m} {fmt(v)}")
        return [f"{len(latest)} measures; better: {len(good)}{' (' + '; '.join(good[:8]) + ')' if good else ''}; "
                f"worse: {len(bad)}{' (' + '; '.join(bad[:8]) + ')' if bad else ''}; the rest are no different / middle."]
    if template == "scorecard":
        return [f"{len(rows):,} rows, searchable and sortable; the user can find any of them."]
    if template == "fan":
        pts = [r for r in rows if _num(r.get(f["median"]))]
        if not pts:
            return []
        if all(_num_like(r.get(f["x"])) for r in pts):
            pts.sort(key=lambda r: float(r[f["x"]]))
        a, z = pts[0], pts[-1]
        s = f"Median {a[f['x']]} {fmt(a[f['median']])} → {z[f['x']]} {fmt(z[f['median']])}"
        if num(z, "p10") is not None and num(z, "p90") is not None:
            s += f"; {z[f['x']]} 10th–90th percentile {fmt(z[f['p10']])}–{fmt(z[f['p90']])}"
        out = [s + "."]
        if "focus" in f:
            pos = []
            for r in pts:
                v = num(r, "focus")
                if v is None:
                    continue
                where = ("above the 90th percentile" if num(r, "p90") is not None and v > r[f["p90"]] else
                         "below the 10th percentile" if num(r, "p10") is not None and v < r[f["p10"]] else
                         "above the median" if v > r[f["median"]] else "below the median")
                pos.append(f"{r[f['x']]} {fmt(v)} ({where})")
            out.append(f"{o.get('focus_label') or f['focus']}: " + "; ".join(pos) + ".")
        return out
    if template == "lollipop":
        ch = [(r.get(f["label"]), r[f["from"]], r[f["to"]]) for r in rows if _num(r.get(f["from"])) and _num(r.get(f["to"]))]
        pct = o.get("mode") != "abs" and all(c[1] > 0 for c in ch)
        d = lambda c: (c[2] - c[1]) / abs(c[1]) if pct else c[2] - c[1]  # noqa: E731
        ch.sort(key=d, reverse=True)
        show = lambda c: f"{c[0]} {d(c):+.0%}" if pct else f"{c[0]} {d(c):+.3g}"  # noqa: E731
        return [f"Largest rises: {', '.join(map(show, ch[:3]))}; largest falls: {', '.join(map(show, ch[::-1][:3]))}."] if ch else []
    if template == "bump":
        xs = list(dict.fromkeys(r.get(f["x"]) for r in rows))
        if len(xs) < 2:
            return []
        def ranks(x):
            rs = [r for r in rows if r.get(f["x"]) == x]
            if "rank" in f:
                return {r.get(f["series"]): r.get(f["rank"]) for r in rs if _num(r.get(f["rank"]))}
            rs = sorted((r for r in rs if _num(r.get(f["value"]))), key=lambda r: r[f["value"]], reverse=(better or "higher") == "higher")
            return {r.get(f["series"]): i + 1 for i, r in enumerate(rs)}
        first, last = ranks(min(xs, key=lambda v: float(v) if _num_like(v) else 0) if all(_num_like(x) for x in xs) else xs[0]), ranks(max(xs, key=float) if all(_num_like(x) for x in xs) else xs[-1])
        moves = sorted(((s, first[s] - last[s]) for s in last if s in first), key=lambda m: m[1])
        bits = [f"Biggest climb: {moves[-1][0]} up {moves[-1][1]:g}", f"biggest fall: {moves[0][0]} down {-moves[0][1]:g}"] if moves else []
        bits += [f"{s}: #{first.get(s, '?')} → #{last.get(s, '?')}" for s in last if str(s) in hi]
        return ["; ".join(bits) + "."] if bits else []
    if template == "alluvial":
        w = lambda r: r[f["value"]] if "value" in f and _num(r.get(f["value"])) else 1  # noqa: E731
        pairs = {}
        for r in rows:
            if r.get(f["from"]) not in (None, "") and r.get(f["to"]) not in (None, ""):
                k = (r[f["from"]], r[f["to"]])
                pairs[k] = pairs.get(k, 0) + w(r)
        total = sum(pairs.values()) or 1
        cats = {c for k in pairs for c in k}
        if better and (o.get("order") or all(_num_like(c) for c in cats)):
            order = [str(c) for c in o["order"]] if o.get("order") else None
            # higher = better; categories missing from order sit after the listed ones (as in the chart)
            pos = (lambda c: -(order.index(str(c)) if str(c) in order else len(order))) if order else (lambda c: float(c) if better == "higher" else -float(c))
            up = sum(n for (a, b), n in pairs.items() if pos(b) > pos(a))
            down = sum(n for (a, b), n in pairs.items() if pos(b) < pos(a))
            return [f"{total:,.0f} units: improved {up:,.0f} ({up / total:.0%}), same {total - up - down:,.0f} ({(total - up - down) / total:.0%}), "
                    f"worsened {down:,.0f} ({down / total:.0%})."]
        top = sorted(pairs.items(), key=lambda kv: -kv[1])[:4]
        return [f"{total:,.0f} units; largest flows: " + "; ".join(f"{a} → {b} {n:,.0f}" for (a, b), n in top) + "."]
    if template == "likert":
        w = lambda r: r[f["value"]] if "value" in f and _num(r.get(f["value"])) else 1  # noqa: E731
        lv = list(dict.fromkeys(str(r.get(f["level"])) for r in rows if r.get(f["level"]) not in (None, "")))
        lv = [str(x) for x in o["order"]] if o.get("order") else sorted(lv, key=float) if all(_num_like(x) for x in lv) else lv
        mid = lv.index(str(o["neutral"])) if o.get("neutral") is not None and str(o["neutral"]) in lv else (len(lv) - 1) / 2 if len(lv) % 2 else len(lv) / 2 - 0.5  # same fallback as the chart
        cats = list(dict.fromkeys(r.get(f["category"]) for r in rows))
        bits = []
        for c in [cats[0], cats[-1]] if len(cats) > 1 else cats:
            rs = [r for r in rows if r.get(f["category"]) == c]
            tot = sum(w(r) for r in rs) or 1
            low = sum(w(r) for r in rs if str(r.get(f["level"])) in lv and lv.index(str(r.get(f["level"]))) < mid) / tot
            high = sum(w(r) for r in rs if str(r.get(f["level"])) in lv and lv.index(str(r.get(f["level"]))) > mid) / tot
            bits.append(f"{c}: bottom levels {low:.0%}, top levels {high:.0%}")
        return ["; ".join(bits) + "."]
    if template == "pareto":
        vals = sorted((r[f["value"]] for r in rows if _num(r.get(f["value"])) and r[f["value"]] > 0), reverse=True)
        if not vals:
            return []
        thr, total, cum, k = float(o.get("threshold") or 0.8), sum(vals), 0, 0
        for v in vals:
            cum += v
            k += 1
            if cum >= thr * total - 1e-9:
                break
        return [f"The top {k:,} of {len(vals):,} ({k / len(vals):.1%}) make up {thr:.0%} of the total {fmt(total)}; the largest is {fmt(vals[0])} ({vals[0] / total:.0%})."]
    return None


def _figure_facts(template, rows, fields, options):
    """A few facts about what the figure shows, so the narrative matches it."""
    f, o, out = fields, options, []
    fmt = lambda v: f"{v:,.3g}" if abs(v) < 1000 else f"{v:,.0f}"  # noqa: E731
    key = next((f[r] for r in ("label", "state", "row", "facet", "category", "series", "x", "measure") if r in f), None)
    name = lambda r: r.get(key) if key else "?"  # noqa: E731
    bench = o.get("benchmark") if _num(o.get("benchmark")) else None
    if (more := _facts_more(template, rows, f, o, fmt, bench)) is not None:
        return more
    if template == "funnel":
        target, better = (bench if bench is not None else 1.0), o.get("better", "lower")
        min_e = o.get("min_expected") if _num(o.get("min_expected")) else None
        good = bad = n = 0
        for r in rows:
            O, E = r.get(f["observed"]), r.get(f["expected"])
            if not (_num(O) and _num(E)) or E <= 0 or (min_e is not None and E < min_e):
                continue
            n += 1
            hi, lo = _poisson_q(0.975, E * target), _poisson_q(0.025, E * target)
            if O > hi or O < lo:
                if (O < lo) == (better == "lower"):
                    good += 1
                else:
                    bad += 1
        return [f"{n:,} units plotted; significantly better than expected: {good:,}; worse: {bad:,}; "
                f"the rest are within 95% Poisson limits of {target:g}."]
    if "from" in f and "to" in f:
        ch = [(name(r), r[f["from"]], r[f["to"]]) for r in rows if _num(r.get(f["from"])) and _num(r.get(f["to"]))]
        if ch:
            up, down = max(ch, key=lambda c: c[2] - c[1]), min(ch, key=lambda c: c[2] - c[1])
            out.append(f"Biggest increase: {up[0]} {fmt(up[1])} → {fmt(up[2])}; biggest decrease: {down[0]} {fmt(down[1])} → {fmt(down[2])}.")
    if template in ("trend", "small_multiples", "area_stack") and "x" in f and "y" in f:
        grp = f.get("series") or f.get("facet")
        series = {}
        for r in rows:
            if _num(r.get(f["y"])):
                series.setdefault(r.get(grp) if grp else f["y"], []).append((r.get(f["x"]), r[f["y"]]))
        # Same x order as the chart (F.xDomain): numeric when every x is a number, else first appearance.
        xs = list(dict.fromkeys(r.get(f["x"]) for r in rows if r.get(f["x"]) not in (None, "")))
        numeric_x = all(_num_like(x) for x in xs)
        rank = {x: (float(x) if numeric_x else i) for i, x in enumerate(xs)}
        bits = []
        for s, pts in list(series.items())[:8]:
            pts = sorted((p for p in pts if p[0] in rank), key=lambda p: rank[p[0]])
            if not pts:
                continue
            peak = max(pts, key=lambda p: p[1])
            bits.append(f"{s}: {pts[0][0]} {fmt(pts[0][1])} → {pts[-1][0]} {fmt(pts[-1][1])} (peak {fmt(peak[1])} in {peak[0]})")
        if bits:
            out.append("; ".join(bits) + ("; …" if len(series) > 8 else "") + ".")
        return out
    vcol = next((f[r] for r in ("value", "y", "to") if r in f), None)
    if vcol:
        pts = [(name(r), r[vcol]) for r in rows if _num(r.get(vcol))]
        if pts:
            lo, hi = min(pts, key=lambda p: p[1]), max(pts, key=lambda p: p[1])
            vals = sorted(p[1] for p in pts)
            out.append(f"{len(pts):,} values; lowest {lo[0]} {fmt(lo[1])}, highest {hi[0]} {fmt(hi[1])}, median {fmt(vals[len(vals) // 2])}.")
            if bench is not None:
                above = sum(v > bench for v in vals)
                out.append(f"{above:,} above and {len(vals) - above:,} at or below the benchmark {bench:g}.")
    return out



_COLREF = re.compile(r"^'([^']+)'\[([^\]]+)\]$")


def _profile_dax(profile):
    """report_card shortcut: build the long per-measure query on the server, so the model only lists measures.
    profile = {"unit": {"column": "facility id", "value": "240010"}, "time": "REPORTYEAR",
               "peers": {"column": "STATE", "value": "MN"},   # optional: the spread among these units, not all
               "measures": [{"name", "column": "'T'[col]", "group", "better", "benchmark", "lower", "upper"}]}
    Bare unit/time/peer column names are qualified with each measure's table. Returns (dax, fields) or raises ValueError."""
    if not isinstance(profile, dict) or not isinstance(profile.get("measures"), list) or not profile["measures"]:
        raise ValueError("profile needs a non-empty measures list.")
    if unknown := sorted(set(profile) - {"unit", "time", "peers", "measures"}):
        raise ValueError(f"profile has unknown keys {unknown}; it takes unit, time, peers and measures.")
    unit, time_col, peers = profile.get("unit") or {}, profile.get("time"), profile.get("peers")
    if not isinstance(unit, dict) or not unit.get("column") or unit.get("value") is None:
        raise ValueError('profile.unit needs {"column": <key column>, "value": <the unit\'s key>}.')
    if peers is not None and (not isinstance(peers, dict) or not peers.get("column") or peers.get("value") is None):
        raise ValueError('profile.peers needs {"column": <column>, "value": <value>}, e.g. {"column": "STATE", "value": "MN"}.')
    lit = lambda v: str(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else '"' + str(v).replace('"', '""') + '"'  # noqa: E731
    qual = lambda name, table: name if _COLREF.match(name) else f"'{table}'[{name}]"  # noqa: E731
    parts = []
    for i, m in enumerate(profile["measures"]):
        if not isinstance(m, dict) or not _COLREF.match(str(m.get("column", ""))):
            raise ValueError(f"profile.measures[{i}].column must be a column reference like 'Table'[column].")
        col, table = m["column"], _COLREF.match(m["column"]).group(1)
        for k in ("lower", "upper"):
            if m.get(k) and not _COLREF.match(str(m[k])):
                raise ValueError(f"profile.measures[{i}].{k} must be a column reference like 'Table'[column].")
        if m.get("better") not in (None, "lower", "higher"):
            raise ValueError(f'profile.measures[{i}].better must be "lower" or "higher".')
        ucol = qual(unit["column"], table)
        at_unit = lambda c: f"CALCULATE(MAX({c}), {ucol} = {lit(unit['value'])})"  # noqa: E731
        cols = [f'"Measure", {lit(m.get("name") or _COLREF.match(col).group(2))}', f'"Group", {lit(m.get("group") or "")}',
                f'"Better", {lit(m.get("better") or "")}',
                f'"Benchmark", {m["benchmark"] if _num(m.get("benchmark")) else "BLANK()"}',
                f'"Lower", {at_unit(m["lower"]) if m.get("lower") else "BLANK()"}',
                f'"Upper", {at_unit(m["upper"]) if m.get("upper") else "BLANK()"}']
        among = f", {qual(peers['column'], table)} = {lit(peers['value'])}" if peers else ""
        cols += [f'"P{int(p * 100)}", CALCULATE(PERCENTILE.INC({col}, {p}){among})' for p in (0.1, 0.25, 0.5, 0.75, 0.9)]
        if time_col:
            tcol = qual(time_col, table)
            parts.append(f"""SELECTCOLUMNS(FILTER(ADDCOLUMNS(VALUES({tcol}), "@v", {at_unit(col)}), NOT ISBLANK([@v]) && NOT ISBLANK({tcol})),
  "Year", {tcol}, "Value", [@v], {", ".join(cols)})""")
        else:
            parts.append(f'ROW("Value", {at_unit(col)}, {", ".join(cols)})')
    dax = "EVALUATE " + (parts[0] if len(parts) == 1 else "UNION(\n" + ",\n".join(parts) + ")")
    fields = {"measure": "Measure", "value": "Value", "group": "Group", "better": "Better", "benchmark": "Benchmark",
              "lower": "Lower", "upper": "Upper", "p10": "P10", "p25": "P25", "p50": "P50", "p75": "P75", "p90": "P90"}
    for k in ("lower", "upper", "benchmark"):  # no measure has one: no such role
        if not any(isinstance(m, dict) and m.get(k) not in (None, "") for m in profile["measures"]):
            fields.pop(k)
    if time_col:
        fields["x"] = "Year"
    return dax, fields

def _t_two_tail(p, n):
    """t with P(|T| > t) = p for Student's t with n degrees of freedom (Hill 1970, ACM Algorithm 396)."""
    if n == 1:
        return math.tan(math.pi * (1 - p) / 2)
    if n == 2:
        return math.sqrt(2 / (p * (2 - p)) - 2)
    a = 1 / (n - 0.5)
    b = 48 / (a * a)
    c = ((20700 * a / b - 98) * a - 16) * a + 96.36
    d = ((94.5 / (b + c) - 3) / b + 1) * math.sqrt(a * math.pi / 2) * n
    y = (d * p) ** (2 / n)
    if y > 0.05 + a:
        x = NormalDist().inv_cdf(p * 0.5)
        y = x * x
        if n < 5:
            c += 0.3 * (n - 4.5) * (x + 0.6)
        c = (((0.05 * d * x - 5) * x - 7) * x - 2) * x + b + c
        y = (((((0.4 * y + 6.3) * y + 36) * y + 94.5) / c - y - 3) / b + 1) * x
        y = a * y * y
        y = math.expm1(y) if y > 0.002 else 0.5 * y * y + y
    else:
        y = ((1 / (((n + 6) / (n * y) - 0.089 * d - 0.822) * (n + 2) * 3) + 0.5 / (n + 4)) * y - 1) * (n + 1) / (n + 2) + 1 / y
    return math.sqrt(n * y)


def _project(rows, fields, options):
    """options.project on a trend: fits each series by least squares (on the log of the values for "log"), appends
    the projected periods with a prediction range in the lower/upper columns, and returns facts about the fit."""
    p = options.pop("project")
    if p is True:
        p = {}
    elif _num(p):
        p = {"periods": p}
    if not isinstance(p, dict):
        raise ValueError('options.project must be {"periods": 5, "from": <first year to fit>, "method": "log"|"linear"}.')
    periods, level, start, method = p.get("periods", 5), p.get("level", 0.8), p.get("from"), p.get("method")
    if not _num(periods) or not 1 <= periods <= 15:
        raise ValueError("options.project.periods must be between 1 and 15.")
    if not _num(level) or not 0.5 <= level < 1:
        raise ValueError("options.project.level must be between 0.5 and 0.99 (0.8 = an 80% range).")
    if start is not None and not _num_like(start):
        raise ValueError("options.project.from must be a year (the first x to fit).")
    if method not in (None, "log", "linear"):
        raise ValueError('options.project.method must be "log" or "linear".')
    xcol, ycol, scol = fields["x"], fields["y"], fields.get("series")
    if any(not _num_like(r.get(xcol)) for r in rows if r.get(xcol) not in (None, "")):
        raise ValueError(f"project needs numeric x values (years); '{xcol}' has others.")
    lcol, ucol = fields.get("lower", "Lower"), fields.get("upper", "Upper")
    groups = {}
    for r in rows:
        r[xcol] = _clean(float(r[xcol])) if _num_like(r.get(xcol)) else r.get(xcol)
        if _num_like(r.get(xcol)) and _num(r.get(ycol)):
            groups.setdefault(r.get(scol) if scol else None, []).append(r)
    added, facts, ends = [], [], []
    fmt = lambda v: f"{v:,.3g}" if abs(v) < 1000 else f"{v:,.0f}"  # noqa: E731
    for key, pts in groups.items():
        pts.sort(key=lambda r: r[xcol])
        name = key if key is not None else ycol
        fit = [r for r in pts if start is None or r[xcol] >= float(start)]
        if len(fit) < 3:
            raise ValueError(f"Too few points to project {name}: {len(fit)} from {start or 'the start'} (needs 3 or more).")
        m = method or ("log" if all(r[ycol] > 0 for r in fit) else "linear")
        if m == "log" and any(r[ycol] <= 0 for r in fit):
            raise ValueError(f"{name} has zero or negative values, so it can't be fitted on a log scale: use method linear.")
        tf, inv = (math.log, math.exp) if m == "log" else ((lambda v: v), (lambda v: v))
        xs, ys = [float(r[xcol]) for r in fit], [tf(r[ycol]) for r in fit]
        n, xbar, ybar = len(xs), sum(xs) / len(xs), sum(ys) / len(ys)
        sxx = sum((x - xbar) ** 2 for x in xs)
        if sxx == 0:
            raise ValueError(f"{name}: every point has the same x, so there is no trend to project.")
        b1 = sum((x - xbar) * (y - ybar) for x, y in zip(xs, ys)) / sxx
        b0 = ybar - b1 * xbar
        sse = sum((y - b0 - b1 * x) ** 2 for x, y in zip(xs, ys))
        sst = sum((y - ybar) ** 2 for y in ys)
        df = n - 2
        se_fit = math.sqrt(sse / df) if df > 0 else 0.0
        tq = _t_two_tail(1 - level, df) if df > 0 else 0.0
        gaps = sorted(b - a for a, b in zip([r[xcol] for r in pts], [r[xcol] for r in pts][1:]) if b > a)
        step = gaps[len(gaps) // 2] if gaps else 1
        last = pts[-1]
        last.setdefault(lcol, last[ycol])
        last.setdefault(ucol, last[ycol])
        for h in range(1, int(periods) + 1):
            xn = last[xcol] + h * step
            yh = b0 + b1 * xn
            half = tq * se_fit * math.sqrt(1 + 1 / n + (xn - xbar) ** 2 / sxx)
            row = {xcol: _clean(float(xn)), ycol: round(inv(yh), 6), lcol: round(inv(yh - half), 6),
                   ucol: round(inv(yh + half), 6), "Projected": True}
            if scol:
                row[scol] = key
            added.append(row)
        end = added[-1]
        rate = f"{math.expm1(b1 / 1):+.1%} a year" if m == "log" else f"{b1:+.3g} a year"
        facts.append(f"{name}: {m} fit on {_clean(xs[0])}–{_clean(xs[-1])} ({n} points, R² {1 - sse / sst if sst else 1:.2f}), "
                     f"{rate}; {end[xcol]} projected {fmt(end[ycol])}, {level:.0%} range {fmt(end[lcol])}–{fmt(end[ucol])} "
                     f"(actual {last[xcol]}: {fmt(last[ycol])}).")
        ends.append(last[xcol])
    if not added:
        raise ValueError("Nothing to project: no numeric x and y values.")
    fields["lower"], fields["upper"] = lcol, ucol
    options["forecast_from"] = max(ends)
    options.setdefault("forecast_label", "Projected →")
    facts.append("A straight-line trend through a handful of annual points: say so, and treat the range as the "
                 "minimum uncertainty (it assumes the past trend continues).")
    return rows + added, fields, options, facts


def _resolve_column(name, columns):
    """A field named as the model column ('T'[col] or T[col]) or in another case, when the query returned it as col."""
    if not isinstance(name, str) or name in columns:
        return name
    m = re.match(r"^'?[^'\[\]]*'?\[([^\]]+)\]$", name.strip())
    bare = (m.group(1) if m else name).strip()
    hits = [c for c in columns if c == bare] or [c for c in columns if c.lower() == bare.lower()]
    return hits[0] if len(hits) == 1 else name


def show_figure(template: str, title: str, fields: dict | None = None, dax: str | None = None,
                options: dict | None = None, subtitle: str | None = None, kicker: str | None = None,
                source: str | None = None, rows: list | None = None, profile: dict | None = None,
                model: str = "CMS") -> Out:
    if template not in FIGURES:
        return error(f"Unknown template {template!r}. Templates: {', '.join(FIGURES)}.")
    required, optional, numeric, extra, _ = FIGURES[template]
    fields, options = dict(fields or {}), dict(options or {})
    if profile is not None:
        if template != "report_card":
            return error("profile only works with template report_card.")
        try:
            dax, fields = _profile_dax(profile)
        except ValueError as e:
            return error(f"{e} Example: profile={{\"unit\": {{\"column\": \"facility id\", \"value\": \"240010\"}}, \"time\": "
                         f"\"REPORTYEAR\", \"measures\": [{{\"name\": \"PSI 90\", \"column\": \"'PSI90'[...]\", \"group\": "
                         f"\"Safety\", \"better\": \"lower\", \"benchmark\": 1}}]}}")
        rows = None
    roles = f"{template} roles: required {required or 'none'}, optional {optional}"
    if unknown := [r for r in fields if r not in required + optional]:
        return error(f"Unknown role(s) {unknown} for {template}. {roles}.")
    if missing := [r for r in required if r not in fields]:
        return error(f"Missing role(s) {missing} for {template}. {roles}.")
    if template == "dot_map" and "id" not in fields and not {"lat", "lon"} <= set(fields):
        return error("dot_map needs id (the CCN, placed from the dashboard's geocoded addresses) or both lat and lon.")
    if dax:
        try:
            rows = fabric.dax(dax, model)
        except fabric.DaxError as e:
            return error(f"DAX error: {e}")
    if not rows:
        return error("The query returned no rows (or no dax/rows were given). Check the filters and try again.")
    if len(rows) > MAX_ROWS:
        return error(f"{len(rows):,} rows (max {MAX_ROWS:,}). Aggregate or filter in DAX and try again.")
    rows = [{k: _clean(v) for k, v in r.items()} for r in rows]
    columns = list(dict.fromkeys(k for r in rows for k in r))  # union: e.g. only projected rows carry a range
    fields = {r: _resolve_column(c, columns) for r, c in fields.items()}
    if bad := {r: c for r, c in fields.items() if c not in columns}:
        return error(f"Column(s) not in the data: {bad}. Available columns: {columns}.")
    for role in numeric:
        if role in fields and not any(_num(r.get(fields[role])) for r in rows):
            return error(f"Role '{role}' maps to column '{fields[role]}', which has no numeric values.")
    for alias, real in OPTION_ALIASES.items():  # common slips, so a figure needn't be redrawn to fix them
        if alias in options and real not in options:
            options[real] = options.pop(alias)
    if template == "distribution" and "mode" in options and "style" not in options:
        options["style"] = options.pop("mode")
    if isinstance(options.get("highlight"), (str, int, float)):
        options["highlight"] = [options["highlight"]]
    for key in ("annotations", "bands"):
        if isinstance(options.get(key), dict):
            options[key] = [options[key]]
        if options.get(key) is not None and not isinstance(options[key], list):
            return error(f"options.{key} must be a list of objects.")
    for key in ("select", "search", "filter"):
        if isinstance(options.get(key), str) and options[key] not in columns:
            return error(f"options.{key} must be a column name; available columns: {columns}.")
    if isinstance(options.get("benchmark"), str) and options["benchmark"] not in columns:
        return error(f"options.benchmark must be a number or a column name; available columns: {columns}.")
    if template == "bump" and not ({"rank", "value"} & set(fields)):
        return error("bump needs rank, or value (ranked each period using better).")
    if template == "scorecard" and options.get("columns") is not None:
        cols = options["columns"] if isinstance(options["columns"], list) else [options["columns"]]
        names = [c if isinstance(c, str) else c.get("col") if isinstance(c, dict) else None for c in cols]
        if bad_cols := [n for n in names if n not in columns]:
            return error(f"options.columns entries must be column names or {{\"col\": <column>, ...}}; not in the data: {bad_cols}. "
                         f"Available columns: {columns}.")
        options["columns"] = cols
    if template == "treemap" and not any(_num(r.get(fields["value"])) and r[fields["value"]] > 0 for r in rows):
        return error(f"treemap needs positive values in '{fields['value']}'.")
    if options.get("better") not in (None, "lower", "higher"):
        return error('options.better must be "lower" or "higher".')
    actual, projection = rows, []
    if "project" in options:
        if template != "trend":
            return error("options.project works with template trend only.")
        try:
            rows, fields, options, projection = _project([dict(r) for r in rows], fields, options)
        except ValueError as e:
            return error(str(e))
        actual = [r for r in rows if not r.get("Projected")]
        columns = list(dict.fromkeys(k for r in rows for k in r))
    ignored = sorted(k for k in options if k not in COMMON_OPTIONS and k not in extra and k not in ("bands", "columns"))
    out = {"view": "figure", "template": template, "title": title, "subtitle": subtitle, "kicker": kicker,
           "source": source or source_of(model), "fields": fields, "options": options, "rows": rows}
    lines = [f"Figure '{title}' ({template}, {len(rows):,} rows) is shown to the user. {NARRATE} Don't repeat its "
             "data as a table."]
    if template in ("ranked_bars", "diverging_bars", "bullet", "lollipop", "dumbbell"):
        lim = options.get("limit") or 30
        if len(rows) > lim:
            lines.append(f"Only the first {lim} of {len(rows):,} rows are drawn (by options.sort; desc unless set)"
                         f"{'; highlighted rows past that are added at the end' if template == 'ranked_bars' else ''}. "
                         "The subtitle and text must describe the rows shown, or raise limit.")
    if template == "distribution":  # what the page draws, so the subtitle describes marks that are there
        style = options.get("style") if "group" in fields else "histogram"
        style = style or ("strip" if len(rows) <= 5000 else "ridge")
        lines.append({"histogram": "Drawn as a histogram with a line at the median.",
                      "strip": "Drawn per group as dots (one per row), a box over the middle 50% and a line at the median.",
                      "ridge": "Drawn per group as a density curve with a dot at the median (no dots, no box)."}.get(style, ""))
    codey = [c for r, c in fields.items() if r not in ("label", "id", "lat", "lon", "state", "observed", "expected")
             and r not in (options.get("labels") or {}) and isinstance(c, str)
             and re.fullmatch(r"[A-Za-z]+\d{2,}|[A-Za-z0-9]+(_[A-Za-z0-9]+)+|[a-z]+[A-Z]\w*", c)]
    if codey:
        lines.append(f"Column names {codey} show on the figure as labels and read like code: alias them in the query as a "
                     "reader would say them (\"2019\", \"HAC score\") or set options.labels.")
    fact_rows, fact_opts = actual, dict(options)
    if isinstance(options.get("select"), str):
        sel = options["select"]
        vals = list(dict.fromkeys(r.get(sel) for r in rows if r.get(sel) not in (None, "")))
        default = next((v for v in vals if str(v) == str(options.get("select_default"))), vals[0] if vals else None)
        fact_rows = [r for r in rows if str(r.get(sel)) == str(default)]
        lines.append(f"Chips let the user switch '{sel}' between {vals[:12]}{'…' if len(vals) > 12 else ''}; it opens on '{default}'. "
                     "The facts below are for that one.")
    if isinstance(options.get("benchmark"), str) and fact_rows and _num(fact_rows[0].get(options["benchmark"])):
        fact_opts["benchmark"] = fact_rows[0][options["benchmark"]]
    if facts := _figure_facts(template, fact_rows, fields, fact_opts):
        lines.append("What the figure shows (the title and your text must agree with this; if the title doesn't, "
                     "call show_figure again with a corrected one):")
        lines += facts
    if projection:
        lines.append("Projection:")
        lines += projection
    if ignored:
        lines.append(f"Ignored options {ignored}; {template} supports {sorted(COMMON_OPTIONS | set(extra))}.")
    lines.append(f"Columns: {', '.join(columns)}. First rows:\n" + to_csv(rows, 8))
    return Out("\n".join(lines), ui=out)


# --- the two models ------------------------------------------------------------------------------------------------
def source_of(model):
    try:
        return f"CMS Care Compare · semantic model {fabric.model_name(model)} in Fabric"
    except fabric.DaxError:
        return "CMS Care Compare"


MODEL_NOTES = {
    "CMS": """Semantic model CMS: hospital x report year, 2019-2025 (PSI90 has 2019 and 2021-2024; no 2020 release).
Tables relate on facility-year. Join and group hospitals by 'T'[facility id] (6-digit CCN text), never by name.
- HAI: one row per hospital and year. Per infection n = 1..6 (1 CLABSI, 2 CAUTI, 3 SSI colon surgery, 4 SSI abdominal
  hysterectomy, 5 MRSA bacteremia, 6 C. diff): HAI_n_SIR (standardized infection ratio), HAI_n_NUMERATOR (observed),
  HAI_n_ELIGCASES (predicted), HAI_n_CILOWER / HAI_n_CIUPPER (95% CI), HAI_n_DOPC (device days or procedures).
  Better or worse than benchmark: the whole CI below 1 (better) or above 1 (worse). Pool states or the nation as
  SUM(observed) / SUM(predicted).
- HCAHPS: summary star rating (H_STAR_RATING) and ten survey dimensions as linear mean scores.
- PSI90: the PSI 90 composite (1.0 = expected; lower is better) and its component rates per 1,000 eligible discharges.""",
    "CMS V2": """Semantic model CMS V2 (Direct Lake on lakehouse lh_cms_v2): the latest CMS release, one period, no years.
- hospital_outcomes, one row per hospital (ccn = 6-digit CCN text; name, city, state):
  overall_star (CMS overall star rating 1-5, blank = not rated: too few measures); ownership; birthing_friendly (0/1);
  mort_better / mort_same / mort_worse, safety_*, readm_*: how many of the hospital's measures in each group CMS rates
  better than, no different from or worse than the national rate;
  mort_rate_{ami,hf,pn,copd,stk,cabg}: risk-standardized 30-day death rates, % (lower is better);
  readm_rate_{ami,hf,pn,copd,cabg}: 30-day readmission rates, % (lower is better);
  ed_median_min: median minutes from arrival to leaving the emergency department for patients sent home (OP-18b,
  lower is better); ed_left_without_seen_pct (OP-22, %); ed_volume (low, medium, high, very high);
  sepsis_care_pct (SEP-1, % of patients given the recommended sepsis care; higher is better);
  hrrp_err_{ami,hf,pn,copd,cabg,hip}: Hospital Readmissions Reduction Program excess readmission ratios (above 1 =
  more readmissions than expected, counts toward the penalty);
  hac_total_score (HAC Reduction Program score, higher is worse) and hac_payment_cut (1 = Medicare cut its payments
  1% this fiscal year: the worst-scoring quarter); vbp_total_score (Value-Based Purchasing, higher is better).
- state_outcomes, one row per state: hospitals, ed_median_min (median of the state's hospitals), ed_reporting,
  overall_star_avg, rated, five_star, hac_payment_cut, hac_scored.
- maternity_hospitals, one row per hospital that delivers babies, has a NICU, or stopped delivering: ccn, name, city,
  state, latitude, longitude, address, zip; delivers_babies (1/0) and delivers_label; birthing_friendly; nicu_any
  (1 = NICU in the provider file or the cost report), nicu_beds, nicu_level (published levels, a few states only);
  stopped_delivering (1 = obstetric services listed before but no longer); hospital_type (a acute, c critical
  access, k children's, p psychiatric, r rehabilitation, l long-term); emergency_dept (0/1).
- maternity_tracts, one row per 2020 census tract (84k): state, women_15_44 (ACS 2020-2024), est_minutes_to_delivery
  and est_minutes_to_nicu (estimated drive minutes to the nearest delivering hospital / NICU, from straight-line
  distance), miles_to_*, delivery_band ('15 min or less', '15-30 min', '30-60 min', 'Over 1 hour'). Aggregate it:
  never return tract rows to a figure, sum women by state or band.
- state_maternity, one row per state: women_15_44, women_over_30_min, women_over_60_min, women_nicu_over_60_min,
  delivering_hospitals, nicu_hospitals, stopped_delivering.
- Measures: [Hospitals rated], [Avg overall star rating], [Hospitals 4-5 stars %], [Median ED minutes],
  [HAC payment cuts], [HAC payment cut %], [Hospitals worse on mortality], [Women 15-44],
  [Women over 30 min from delivery], [Women over 60 min from delivery], [Share over 30 min from delivery],
  [Share over 60 min from delivery], [Women over 60 min from NICU], [Delivering hospitals], [Hospitals with NICU],
  [Stopped delivering].
- Relationships: hospital_outcomes[state] -> state_outcomes, maternity_hospitals[state] and maternity_tracts[state]
  -> state_maternity, maternity_hospitals[ccn] -> hospital_outcomes[ccn].
To combine with CMS (infections, safety, experience), query each model separately and match on CCN
('HAI'[facility id] = hospital_outcomes[ccn]).""",
}
SCHEMA_TABLES = {"CMS": ("PSI90", "HAI", "HCAHPS"),
                 "CMS V2": ("hospital_outcomes", "state_outcomes", "maternity_hospitals", "maternity_tracts", "state_maternity")}


def model_schema(model: str | None = None) -> Out:
    """Tables, columns and notes for one model, or both."""
    try:
        names = [fabric.model_name(model)] if model else list(SCHEMA_TABLES)
    except fabric.DaxError as e:
        return error(str(e))
    parts = []
    for name in names:
        def load(name=name):
            rows = fabric.dax('EVALUATE SELECTCOLUMNS(INFO.VIEW.COLUMNS(), "t", [Table], "c", [Name], "dt", [DataType])', name)
            out = {}
            for r in rows:
                if r["t"] in SCHEMA_TABLES[name] and not r["c"].startswith("RowNumber"):
                    out.setdefault(r["t"], []).append(f"{r['c']} ({r['dt']})")
            return "\n\n".join(f"'{t}' columns:\n" + "\n".join(f"- {c}" for c in cols) for t, cols in out.items())
        try:
            columns = cached(f"schema:{name}", load, ttl=86400)
        except fabric.DaxError as e:
            return error(f"Could not read the {name} model: {e}")
        parts.append(f"## {name}\n{MODEL_NOTES[name]}\n\n{columns}")
    return Out("\n\n".join(parts))


def run_dax(query: str, model: str = "CMS", max_rows: int = 200) -> Out:
    try:
        rows = fabric.dax(query, model)
    except fabric.DaxError as e:
        return error(f"DAX error: {e}")
    if not rows:
        return Out("0 rows.")
    head = f"{len(rows)} rows" + (f" (showing first {max_rows})" if len(rows) > max_rows else "")
    return Out(head + "\n" + to_csv(rows, max_rows))


# --- the dashboard's own figures, redrawn by the page for the question -------------------------------------------------
INFECTIONS = {"clabsi": "CLABSI", "cauti": "CAUTI", "ssi_colon": "SSI colon surgery", "ssi_hyst": "SSI abdominal hysterectomy",
              "mrsa": "MRSA bacteremia", "cdiff": "C. diff"}
MAP_METRICS = {**{k: v + " pooled SIR" for k, v in INFECTIONS.items()}, "star": "average HCAHPS star rating",
               "topPct": "share of hospitals with 4-5 HCAHPS stars", "psi90": "average PSI-90",
               "ovr": "average CMS overall star rating", "ed": "median ED minutes"}
# id: (dashboard figure, what it shows, parameters it takes)
DASHBOARD_FIGURES = {
    "infection_trends": ("Fig 1", "national pooled SIR of the six infections, 2019-2025, with the COVID years shaded", []),
    "infection_change": ("Fig 2", "national SIR of each infection in 2019 and 2025 with the pandemic peak", []),
    "infection_flags": ("Fig 3", "share of hospitals flagged better or worse than benchmark by year, for one infection", ["infection"]),
    "funnel": ("Fig 4", "every hospital's SIR against predicted infections with 95% and 99.8% Poisson limits, latest "
                        "report; highlights a state's hospitals or a hospital found by name or CCN", ["infection", "state", "hospital"]),
    "state_map": ("Fig 5", "states coloured by a measure against the national value (tile map)", ["metric", "state"]),
    "state_ranks": ("Fig 6", "states ranked by a measure", ["metric", "state"]),
    "star_mix": ("Fig 7", "HCAHPS summary star mix by year, centred on 3 stars", []),
    "survey_change": ("Fig 8", "HCAHPS survey dimensions in 2019 and their change since", []),
    "psi_spread": ("Fig 9", "PSI-90 median and 10th-90th percentile band by year", []),
    "psi_components": ("Fig 10", "PSI component rates in 2019 and 2024", []),
    "star_flags": ("Fig 11", "share of hospitals with an infection flagged worse, by HCAHPS star rating", []),
    "psi_by_star": ("Fig 12", "PSI-90 distribution by HCAHPS star rating", []),
    "overall_stars": ("Fig 13", "CMS overall star rating mix, nation or a state against the nation", ["state"]),
    "ed_by_state": ("Fig 14", "median ED minutes by state against the national median", ["state"]),
    "outcome_ranges": ("Fig 15", "the spread of 30-day death or readmission rates between hospitals, by condition", ["outcome"]),
    "penalties": ("Fig 16", "hospitals with Medicare payment cuts (HAC and readmissions programs)", []),
}
DASHBOARD_DOC = """Show one of the dashboard's own figures in the answer, redrawn for the question. Prefer it whenever
one of them answers the point: the user knows these figures, and Show on the dashboard opens the real one with the
same settings. The page draws it from the dashboard's data (the latest extract) and returns what it shows.
Figures (id: what it shows [parameters]):
""" + "\n".join(f"- {k} ({v[0]}): {v[1]}" + (f" [{', '.join(v[2])}]" if v[2] else "") for k, v in DASHBOARD_FIGURES.items()) + f"""
Parameters: infection one of {list(INFECTIONS)}; metric one of {list(MAP_METRICS)}; state a 2-letter code;
hospital a name or CCN to highlight; outcome "mort" or "readm". The street map of a state's hospitals and the
maternity access map aren't redrawn here: for a search on either (nearest care from a place or a point, with
routes), call nearest_care, which draws a street map like theirs; otherwise link to them as [the hospital map](#geography)
or [the maternity map](#maternity)."""


def check_dashboard_figure(figure: str, infection=None, metric=None, state=None, hospital=None, outcome=None,
                           title=None) -> tuple[dict | None, str | None]:
    """The page's arguments for show_dashboard_figure, or an error for the model."""
    if figure not in DASHBOARD_FIGURES:
        return None, f"Unknown dashboard figure {figure!r}. Figures: {', '.join(DASHBOARD_FIGURES)}."
    takes = DASHBOARD_FIGURES[figure][2]
    given = {k: v for k, v in dict(infection=infection, metric=metric, state=state, hospital=hospital, outcome=outcome).items()
             if v not in (None, "")}
    if extra := [k for k in given if k not in takes]:
        return None, f"{figure} takes {takes or 'no parameters'}, not {extra}."
    if "infection" in given:
        key = str(given["infection"]).lower().replace(" ", "_").replace(".", "")
        key = {"c_diff": "cdiff", "cdi": "cdiff", "ssi_colon_surgery": "ssi_colon", "ssi_hysterectomy": "ssi_hyst"}.get(key, key)
        if key not in INFECTIONS:
            return None, f"infection must be one of {list(INFECTIONS)}."
        given["infection"] = key
    if "metric" in given and given["metric"] not in MAP_METRICS:
        return None, f"metric must be one of {list(MAP_METRICS)}."
    if "state" in given:
        given["state"] = str(given["state"]).upper()
        if not re.fullmatch(r"[A-Z]{2}", given["state"]):
            return None, "state must be a 2-letter code such as TX."
    if "outcome" in given and given["outcome"] not in ("mort", "readm"):
        return None, 'outcome must be "mort" or "readm".'
    return {"figure": figure, "params": given, "title": title}, None


# --- tool definitions for the Copilot session ------------------------------------------------------------------------
# --- places and routes (copilot/geo.py) ---------------------------------------------------------------------------------
def _hm(minutes):
    m = int(round(minutes))
    return f"{m // 60} h {m % 60:02d} min" if m >= 60 else f"{m} min"


def _about(minutes):
    m = int(round(minutes))
    return f"{m} minutes" if m < 58 else "about an hour" if m <= 65 else _hm(m)


_SMALL = {"of", "and", "the", "at", "in", "for", "on"}
_UPPER = {"MN", "VA", "UCSF", "UCLA", "UC", "NYU", "OSF", "CHI", "HCA", "SSM", "UNC", "UPMC", "LDS", "II", "III", "IV", "MD",
          "USD", "UAB", "UVA", "UW", "OHSU", "MUSC", "HSHS", "WVU", "LSU", "UNMC", "UT", "UCHEALTH"}


def _name(s):
    """CMS's capitals as a name: 'M HEALTH FAIRVIEW ST JOHN'S HOSPITAL' -> 'M Health Fairview St John's Hospital'."""
    words = []
    for i, w in enumerate(str(s or "").split()):
        core = w.strip(".,()-").upper()
        if core in _UPPER or (len(core) <= 3 and not re.search(r"[AEIOUY]", core) and core not in {"ST", "MT", "FT", "DR"}):
            words.append(w.upper())
        elif i and w.lower() in _SMALL:
            words.append(w.lower())
        else:
            low = w.lower()
            j = next((k for k, ch in enumerate(low) if ch.isalpha()), None)
            words.append(low if j is None else low[:j] + low[j].upper() + low[j + 1:])
    return " ".join(words)


def _who(h):
    city = f"{_name(h.get('city'))}, {h.get('state') or ''}".strip(", ")
    nicu = f", NICU{' level ' + str(h['nicu_level']) if h.get('nicu_level') else ''}" if h.get("nicu") else ""
    phone = f", {h['phone']}" if h.get("phone") else ""
    return f"{_name(h['name'])} ({city}{nicu}{phone})"


def route_care(origin: str, destination: str, via: list | None = None, title: str | None = None,
               show_nicu: bool = True, subtitle: str | None = None) -> Out:
    """A drive and the maternity care along it: one figure (map + profile) and the facts behind it."""
    try:
        r = cached(f"route:{origin}|{destination}|{via}", lambda: geo.route_care(origin, destination, via), ttl=3600)
    except geo.GeoError as e:
        return error(str(e))
    rows, a, b = r["samples"], r["stops"][0], r["stops"][-1]
    short = lambda s: s["name"].split(",")[0]
    mat = {h["ccn"]: h for h in geo.maternity()}
    for st in r["deliver_30"]:
        st["near"] = geo.nearest_town((st["max"]["lat"], st["max"]["lon"]))
    for row in rows:
        if row["deliver_min"] > 30 or row["nicu_min"] > 60:
            row["near"] = geo.nearest_town((row["lat"], row["lon"]))
    wd, wn = r["worst_deliver"], r["worst_nicu"]
    within30 = sum(1 for x in rows if x["deliver_min"] <= 30) / len(rows)
    over30 = sum(st["to"] - st["from"] for st in r["deliver_30"])
    over60 = sum(st["to"] - st["from"] for st in r["deliver_60"])
    nicu60 = sum(st["to"] - st["from"] for st in r["nicu_60"])
    road_worst = wd["minutes"]
    how = "by road" if r["by_road"] > 0.95 else "by road where the router answered, estimated elsewhere"
    auto = (f"A hospital that delivers babies is within {_about(road_worst)} {how.split(' where')[0]} of every point on the drive"
            if road_worst <= 75 else
            f"Near {wd['near'].split(',')[0] or 'one stretch'}, the nearest hospital that delivers babies is {_hm(road_worst)} away")
    hosp = [h for h in r["near_route"] if h["off_route_miles"] <= 15]
    worst_label = f"Farthest: {_hm(wd['minutes'])} to {_name(wd['hospital']['city'])}" if wd["minutes"] > 30 else None
    ui = {"view": "figure", "template": "route_care", "kicker": f"Maternity care · {short(a)} to {short(b)}",
          "title": title or auto,
          "subtitle": subtitle or ("The road is orange where the nearest hospital that delivers babies is more than 30 minutes "
                                   "away by road; the profile below shows that drive, and the drive to a NICU, mile by mile."),
          "source": "CMS Care Compare and provider files · semantic model CMS V2; roads and drive times © OpenStreetMap contributors (OSRM)",
          "fields": {}, "rows": rows,
          "options": {"line": r["line"], "stops": [{**s, "short": short(s), "label": short(s)} for s in r["stops"]],
                      "hospitals": [{k: h[k] for k in ("ccn", "name", "city", "lat", "lon", "nicu", "stopped", "delivers")} for h in hosp],
                      "nicu_hospitals": [{"ccn": h["ccn"], "name": _name(h["name"]), "city": _name(h["city"])} for h in
                                         (mat[c] for c in {x["nicu_h"] for x in rows} | {x["deliver"] for x in rows})],
                      "towns": r["towns"], "worst": worst_label, "show_nicu": bool(show_nicu), "estimated": r["by_road"] < 0.95}}
    lines = [
        f"Figure '{ui['title']}' (route_care) is shown: a map of the road with the hospitals near it, and a profile of the drive "
        "to care along the way. Don't repeat its data as a table.",
        f"Route by road (OpenStreetMap/OSRM): {a['name']} to {b['name']}{' via ' + ', '.join(v['name'] for v in r['stops'][1:-1]) if len(r['stops']) > 2 else ''}: "
        f"{r['road_miles']:,} miles, about {_hm(r['road_minutes'])} of driving without stops.",
        f"Drive {how} from points every {round(r['road_miles'] / len(rows), 1)} miles along the route to the nearest hospital "
        "that delivers babies (the faster of the two closest):",
        f"- {within30:.0%} of the route is within 30 minutes. Median {round(sorted(x['deliver_min'] for x in rows)[len(rows) // 2])} min.",
        f"- Farthest point: mile {round(wd['mile'])}{' near ' + wd['near'] if wd['near'] else ''}: {_hm(wd['minutes'])} to "
        f"{_who(wd['hospital'])} ({wd['straight_miles']} miles in a straight line).",
        (f"- More than 30 minutes away: {len(r['deliver_30'])} stretches, {round(over30)} miles in all ({over30 / r['road_miles']:.0%} of the "
         "route). Longest: " + "; ".join(
            f"miles {round(st['from'])}-{round(st['to'])}{' near ' + st['near'] if st.get('near') else ''}, at worst {_hm(st['max']['deliver_min'])} "
            f"to {_name(mat[st['max']['deliver']]['name'])}" for st in sorted(r["deliver_30"], key=lambda x: -(x["to"] - x["from"]))[:4])
         if r["deliver_30"] else "- No point on the route is more than 30 minutes from a delivering hospital."),
        (f"- More than an hour away: {round(over60)} miles (" + "; ".join(f"miles {round(st['from'])}-{round(st['to'])}" for st in r["deliver_60"]) + ")."
         if r["deliver_60"] else "- No point is more than an hour away."),
        "Nearest hospital with a NICU:",
        f"- Farthest point: mile {round(wn['mile'])}{' near ' + wn['near'] if wn['near'] else ''}: {_hm(wn['minutes'])} to {_who(wn['hospital'])}.",
        f"- More than an hour from a NICU: {len(r['nicu_60'])} stretches, {round(nicu60)} miles in all"
        + (". Longest: " + "; ".join(f"miles {round(st['from'])}-{round(st['to'])}{' near ' + geo.nearest_town((st['max']['lat'], st['max']['lon'])) if geo.nearest_town((st['max']['lat'], st['max']['lon'])) else ''}"
                               f" (at worst {_hm(st['max']['nicu_min'])})" for st in sorted(r["nicu_60"], key=lambda x: -(x["to"] - x["from"]))[:4])
           if r["nicu_60"] else "") + ".",
        "Hospitals that deliver babies within 10 miles of the road, in order (mile: hospital):",
    ]
    lines += [f"- {round(h['mile'])}: {_who(h)}" for h in hosp if h["delivers"] and h["off_route_miles"] <= 10][:40]
    stopped = [h for h in hosp if h["stopped"]]
    if stopped:
        lines.append("Near the road but no longer delivering: " + "; ".join(f"{_name(h['name'])} ({_name(h['city'])}, mile {round(h['mile'])})" for h in stopped[:10]) + ".")
    lines.append("Answer the person first, in a sentence or two with these numbers: whether they're ever far from delivery care, "
                 "where, and how far by road. Then suggest what helps (e.g. note the hospitals before the long stretches, plan "
                 "overnight stops near a NICU). In an emergency call 911; any hospital emergency department must evaluate and "
                 "stabilize a woman in labor. Say drive times are typical road times without traffic, and suggest checking with her obstetrician before "
                 "a long trip late in pregnancy. Call show_figure only for something this figure doesn't show; call route_care "
                 "again with title to retitle it.")
    return Out("\n".join(lines), ui=ui)


def _str_list(v):
    """A list of strings from a list, a JSON-encoded list (as the model sometimes sends one) or a single string."""
    if isinstance(v, str):
        t = v.strip()
        if t.startswith("["):
            try:
                v = json.loads(t)
            except ValueError:
                v = [x.strip(" '\"") for x in t.strip("[]").split(",")]
        else:
            v = [t] if t else []
    return [str(x).strip() for x in (v or []) if str(x).strip()]


def _care_label(o, origin_label=None):
    if origin_label:
        return str(origin_label)
    if o.get("source") == "coordinates":
        return f"this spot near {o['near']}" if o.get("near") else o["name"]
    return o["name"]


def nearest_care(origin: str, kind: str = "delivers", count: int = 3, avoid: list | None = None,
                 avoid_miles: float | None = None, exclude: list | None = None, origin_label: str | None = None,
                 title: str | None = None, subtitle: str | None = None) -> Out:
    """The nearest care from a place or a point on a map, by road, drawn as the dashboard's map draws a search."""
    avoid, exclude = _str_list(avoid), _str_list(exclude)
    try:
        r = cached(f"care:{origin}|{kind}|{count}|{avoid}|{avoid_miles}|{exclude}",
                   lambda: geo.nearest_care(origin, kind, count, avoid, avoid_miles, exclude), ttl=3600)
    except geo.GeoError as e:
        return error(str(e))
    o, res, zones = r["origin"], r["results"], r["zones"]
    noun = geo.CARE_KINDS[r["kind"]]
    one = {"delivers": "hospital that delivers babies", "nicu": "hospital with a NICU", "emergency": "emergency department",
           "acute": "acute-care hospital", "any": "hospital"}[r["kind"]]
    label = _care_label(o, origin_label)
    top = [x for x in res if x["role"] == "top"]
    rows = [{**x, "name": _name(x["name"]), "city": _name(x["city"])} for x in res]
    first = rows[0]
    keep_out = " and ".join(z["name"].split(",")[0] for z in zones)
    auto = f"{first['name']} is the nearest {one}{', avoiding ' + keep_out if keep_out else ''}: {_hm(first['minutes'])} by road"
    maternity = r["kind"] in ("delivers", "nicu")
    ui = {"view": "figure", "template": "care_map",
          "kicker": f"{'Maternity care' if maternity else 'Hospitals'} · from {label.replace('this spot ', '')}",
          "title": title or auto,
          "subtitle": subtitle or ("Numbered by drive time by road without traffic (OpenStreetMap routing)"
                                   + ("; the shaded area is kept out of" if zones else "")
                                   + ("; blue marks a NICU" if maternity else "") + "."),
          "source": ("CMS Care Compare and provider files · semantic model CMS V2; roads and drive times © OpenStreetMap "
                     "contributors (OSRM)"),
          "fields": {}, "rows": rows,
          "options": {"origin": {"lat": o["lat"], "lon": o["lon"], "label": label, "source": o.get("source")},
                      "kind": r["kind"], "what": noun, "zones": zones, "sync": "maternity" if maternity else "hospitals",
                      "left_out": [{"name": _name(x["name"]), "city": _name(x["city"]), "why": x["why"]} for x in r["left_out"]]}}

    def who(x):
        bits = [f"{x['city']}, {x['state']}", f"CCN {x['ccn']}"]
        if x.get("nicu"):
            bits.append(f"NICU{' level ' + str(x['nicu_level']) if x.get('nicu_level') else ''}")
        if x.get("phone"):
            bits.append(x["phone"])
        how = "by road" if x["routed"] else "estimated from distance"
        extra = (f"; the route goes around {keep_out}" if x.get("detour") else
                 f"; this route still passes through {', '.join(x['through'])}" if x.get("through") else
                 f"; its route couldn't be checked against {keep_out}, so it may pass through it" if x.get("unchecked") else "")
        return f"{x['name']} ({'; '.join(bits)}): {_hm(x['minutes'])} {how}, {x['miles']:.0f} road miles{extra}"

    lines = [
        f"Figure '{ui['title']}' (care_map) is shown: a street map like the dashboard's "
        f"{'maternity care map' if maternity else 'hospital map'}, with the start point, the hospitals numbered by drive "
        "time and the road route to each. Don't repeat its data as a table, and don't redraw it as bars or a dot map.",
        f"From: {label} (lat {o['lat']:.4f}, lon {o['lon']:.4f}; located from {o.get('source')}"
        f"{'; nearest town ' + o['near'] if o.get('near') else ''}).",
    ]
    if zones:
        lines.append("Kept out of: " + "; ".join(f"{z['name']} (the whole state: its hospitals are left out and routes are checked against its border)"
                                                 if z.get("kind") == "state" else f"{z['name']} (within {z['miles']} miles of its centre)" for z in zones)
                     + ". Hospitals inside are left out, and routes avoid it where the router offers a way around or "
                       "a detour works. The router can't see closures, so detour times are estimates.")
    if r["inside"]:
        lines.append(f"The start point is inside {', '.join(r['inside'])}, so routes can't avoid it there; only its hospitals are left out.")
    if r["left_out"]:
        lines.append("Left out (would otherwise be among the nearest): " + "; ".join(
            f"{_name(x['name'])}, {_name(x['city'])} ({x['why']})" for x in r["left_out"]) + ".")
    lines.append(f"Nearest {noun}, by drive time:")
    lines += [f"{i + 1}. {who(x)}" for i, x in enumerate(y for y in rows if y["role"] == "top")]
    for x in rows:
        if x["role"] == "nicu":
            lines.append(f"Nearest NICU: {who(x)}")
        elif x["role"] == "high":
            lines.append(f"Nearest Level III or IV NICU: {who(x)}")
    lines.append(
        "Answer the person first with the nearest option and its drive time, in plain words. Say drive times are typical "
        "road times without traffic. In an emergency call 911; any hospital emergency department must evaluate and "
        "stabilize a woman in labor." if maternity else
        "Answer the person first with the nearest option and its drive time, in plain words. Say drive times are typical "
        "road times without traffic, and that in an emergency they should call 911.")
    lines.append(f"The figure has a Show on the map button for the dashboard's {'maternity map' if maternity else 'hospital map'}, and in "
                 "the side panel that map updates by itself when the question came from it: don't mention either. Call "
                 "nearest_care again with title to retitle the figure.")
    return Out("\n".join(lines), ui=ui)


def nearby_hospitals(place: str, kind: str = "any", count: int = 8, within_miles: float | None = None) -> Out:
    """The hospitals nearest a town, ZIP, address or hospital (by CCN or name)."""
    try:
        r = geo.nearby(place, kind, count, within_miles)
    except geo.GeoError as e:
        return error(str(e))
    p, hs = r["place"], r["hospitals"]
    if not hs:
        return Out(f"No {kind} hospitals within {within_miles} miles of {p['name']}.")
    what = {"any": "hospitals", "acute": "acute-care and critical access hospitals", "emergency": "hospitals with an emergency department",
            "delivers": "hospitals that deliver babies", "nicu": "hospitals with a NICU", "stopped": "hospitals that stopped delivering babies"}[kind]
    lines = [f"Nearest {what} to {p['name']} (located from {p['source']}; lat {p['lat']:.4f}, lon {p['lon']:.4f}). Miles are straight-line; "
             "'est' is the dashboard's drive-time estimate; 'road' is OSRM driving time, for the closest three."]
    for h in hs:
        extra = f", {h['type']}" if h.get("type") else (", NICU" + (f" level {h['nicu_level']}" if h.get("nicu_level") else "") if h.get("nicu") else "")
        lines.append(f"- {_name(h['name'])} ({_name(h.get('city'))}, {h.get('state')}; CCN {h['ccn']}{extra}): {h['miles']} mi, "
                     f"est {h['est_minutes']} min{', road ' + str(h['road_minutes']) + ' min' if h.get('road_minutes') is not None else ''}"
                     f"{', ' + h['phone'] if h.get('phone') else ''}")
    ccns = ", ".join(f'"{h["ccn"]}"' for h in hs)
    lines.append(f"CCNs: {{{ccns}}}. Filter DAX with 'hospital_outcomes'[ccn] IN {{{ccns}}} (CMS V2) or 'HAI'[facility id] IN {{...}} (CMS). "
                 f"To map them: dot_map with id = the CCN, options.zoom = \"points\" and options.center = "
                 f"{{\"lat\": {p['lat']:.4f}, \"lon\": {p['lon']:.4f}, \"label\": \"{p['name'].split(',')[0]}\"}}.")
    return Out("\n".join(lines))


_MODEL = {"type": "string", "enum": ["CMS", "CMS V2"],
          "description": "Semantic model: CMS (HAI, HCAHPS, PSI90; default) or CMS V2 (outcomes, penalties, ED, maternity)."}
TOOLS = [
    {"name": "show_figure", "kind": "figure", "description": FIGURE_DOC, "handler": show_figure, "parameters": {
        "type": "object", "required": ["template", "title"], "properties": {
            "template": {"type": "string", "enum": list(FIGURES)},
            "title": {"type": "string", "description": "The finding, e.g. 'Infection ratios fell in 44 states since 2019'"},
            "replace": {"type": "integer", "description": "The number of a figure in this answer to replace in place (a "
                        "correction after its readability check, which may change the title)"},
            "fields": {"type": "object", "additionalProperties": {"type": "string"},
                       "description": "role -> column name, e.g. {\"state\": \"State\", \"value\": \"SIR\"}"},
            "dax": {"type": "string", "description": "DAX query returning the rows (alias every column)"},
            "model": _MODEL,
            "options": {"type": "object", "description": "better, benchmark, highlight, annotations, drill, format, project, ..."},
            "subtitle": {"type": "string", "description": "How to read it: measure, encoding, benchmark"},
            "kicker": {"type": "string", "description": "Short overline, e.g. 'Infections · by state'"},
            "source": {"type": "string"},
            "rows": {"type": "array", "items": {"type": "object"}, "description": "Inline rows, only for derived data; prefer dax"},
            "profile": {"type": "object", "description": "report_card only, instead of dax and fields: {unit: {column, value}, "
                        "time, measures: [{name, column, group, better, benchmark, lower, upper}]}"}}}},
    {"name": "show_dashboard_figure", "kind": "page", "description": DASHBOARD_DOC, "handler": check_dashboard_figure,
     "parameters": {"type": "object", "required": ["figure"], "properties": {
         "figure": {"type": "string", "enum": list(DASHBOARD_FIGURES)},
         "replace": {"type": "integer", "description": "The number of a figure in this answer to replace in place"},
         "infection": {"type": "string", "enum": list(INFECTIONS)},
         "metric": {"type": "string", "enum": list(MAP_METRICS)},
         "state": {"type": "string", "description": "2-letter state code"},
         "hospital": {"type": "string", "description": "hospital name or CCN to highlight (funnel)"},
         "outcome": {"type": "string", "enum": ["mort", "readm"]},
         "title": {"type": "string", "description": "Optional: the finding, shown as the figure's title in the answer"}}}},
    {"name": "render_visual", "kind": "figure", "description": VISUAL_DOC, "handler": render_visual, "parameters": {
        "type": "object", "required": ["title"], "properties": {
            "title": {"type": "string"},
            "spec": {"type": "object", "description": "Vega-Lite v6 spec (JSON object)"},
            "replace": {"type": "integer", "description": "The number of a figure in this answer to replace in place (a "
                        "correction after its readability check, which may change the title)"},
            "html": {"type": "string", "description": "Custom HTML/JS, only when Vega-Lite can't do it"},
            "dax": {"type": "string", "description": "DAX query whose rows become the dataset 'rows'"},
            "model": _MODEL,
            "queries": {"type": "object", "description": "More named datasets: {name: DAX} or {name: {dax, model}}"},
            "subtitle": {"type": "string"}, "kicker": {"type": "string"}, "source": {"type": "string"}}}},
    {"name": "route_care", "kind": "figure", "handler": route_care,
     "description": "A trip and the maternity care along it: for anyone travelling while pregnant, or asking how far a drive "
                    "takes them from a hospital that delivers babies or has a NICU. Routes by road (OpenStreetMap), checks the "
                    "nearest delivering hospital and NICU every 2 miles, and shows one figure (a map of the road coloured by "
                    "distance from care, with the hospitals near it, and a mile-by-mile profile) plus the facts: the farthest "
                    "point and its nearest hospital by road, the stretches more than 30 and 60 minutes away, and every "
                    "delivering hospital along the way with its phone number. Takes a minute at most; use it instead of "
                    "working out a route or distances yourself.",
     "parameters": {"type": "object", "required": ["origin", "destination"], "properties": {
         "origin": {"type": "string", "description": "Town and state ('Cottage Grove, MN'), ZIP, or street address"},
         "destination": {"type": "string", "description": "Town and state, ZIP, or street address"},
         "via": {"type": "array", "items": {"type": "string"}, "description": "Places the drive must pass through, in order"},
         "title": {"type": "string", "description": "Only to retitle the figure after you've seen the facts"},
         "subtitle": {"type": "string"},
         "show_nicu": {"type": "boolean", "description": "Also draw the drive to a NICU (default true)"}}}},
    {"name": "nearest_care", "kind": "figure", "handler": nearest_care,
     "description": "The nearest hospitals from a place or a point on the map, ranked by drive time by road, with the "
                    "route to each, drawn as a street map like the dashboard's maternity and hospital maps. Use it for "
                    "'nearest', 'closest', 'directions to', 'my options' and 'from here' questions, and when the person "
                    "can't go somewhere: avoid keeps out of places (their hospitals are left out and routes go around "
                    "them), exclude leaves out named hospitals. kind delivers (the maternity map's search: the closest "
                    "hospitals that deliver babies plus the nearest NICU and Level III+ NICU), nicu, emergency, acute or any. "
                    "When the [On screen] block gives a map search, pass its lat, lon as origin and its label as "
                    "origin_label. Takes up to half a minute.",
     "parameters": {"type": "object", "required": ["origin"], "properties": {
         "origin": {"type": "string", "description": "Town and state, ZIP, street address, hospital, or 'lat, lon' of a map point"},
         "origin_label": {"type": "string", "description": "How to name the start, e.g. the map's 'this spot near Hastings, MN'"},
         "kind": {"type": "string", "enum": list(geo.CARE_KINDS)},
         "count": {"type": "integer", "description": "How many to rank (default 3, at most 8)"},
         "avoid": {"type": "array", "items": {"type": "string"}, "description": "Places to keep out of: towns ('St Paul, MN') or whole states ('Texas')"},
         "avoid_miles": {"type": "number", "description": "Radius kept out of around each avoided place (default by its size; St Paul about 5)"},
         "exclude": {"type": "array", "items": {"type": "string"}, "description": "Hospitals to leave out, by name or CCN"},
         "title": {"type": "string", "description": "Only to retitle the figure after you've seen the facts"},
         "subtitle": {"type": "string"}}}},
    {"name": "nearby_hospitals", "kind": "text", "handler": nearby_hospitals,
     "description": "The hospitals nearest a place: a town and state, ZIP, street address, or a hospital (CCN or name). "
                    "kind: any, acute (acute care and critical access), emergency, delivers (delivers babies), nicu, stopped "
                    "(stopped delivering). Returns each hospital's CCN, miles, estimated and (closest three) road drive times "
                    "and phone where known, ready to filter DAX by CCN. Use it to list or compare the hospitals around a place "
                    "('compare X with the hospitals around it', 'within 20 miles of'); for nearest care, directions or "
                    "options from a place, use nearest_care, which also draws the map and routes.",
     "parameters": {"type": "object", "required": ["place"], "properties": {
         "place": {"type": "string"},
         "kind": {"type": "string", "enum": ["any", "acute", "emergency", "delivers", "nicu", "stopped"]},
         "count": {"type": "integer", "description": "How many (default 8, at most 40)"},
         "within_miles": {"type": "number", "description": "Only those within this many straight-line miles"}}}},
    {"name": "model_schema", "kind": "text", "handler": model_schema,
     "description": "Tables, columns and notes of the CMS and CMS V2 semantic models. Call before writing DAX.",
     "parameters": {"type": "object", "properties": {"model": _MODEL}}},
    {"name": "run_dax", "kind": "text", "handler": run_dax,
     "description": "Run a DAX query (EVALUATE ...) on CMS or CMS V2 and return CSV, to look something up before you "
                    "draw it. Aggregate or use TOPN in DAX: at most max_rows rows come back.",
     "parameters": {"type": "object", "required": ["query"], "properties": {
         "query": {"type": "string"}, "model": _MODEL, "max_rows": {"type": "integer", "default": 200}}}},
]
TOOL_BY_NAME = {t["name"]: t for t in TOOLS}
