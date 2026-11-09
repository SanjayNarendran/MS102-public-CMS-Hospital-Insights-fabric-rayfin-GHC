"""Calls every tool in copilot/tools.py against the live semantic models, without Copilot, and checks the results.

    .venv/bin/python copilot/dev/smoke.py

Needs `az login`, CMS_WORKSPACE_ID and the capacity behind that workspace running. Each line prints ok or FAIL with the first line of
the tool's text; deliberate mistakes must come back as errors (ok=False) with a message the model can act on."""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import tools  # noqa: E402



def dash(figure, **params):
    """show_dashboard_figure's server-side check, as an Out."""
    request, err = tools.check_dashboard_figure(figure, **params)
    return tools.Out(err or str(request), ok=err is None)


CASES = [
    ("schema CMS", lambda: tools.model_schema("CMS"), True),
    ("schema CMS V2", lambda: tools.model_schema("CMS V2"), True),
    ("run_dax CMS V2 measures", lambda: tools.run_dax(
        'EVALUATE ROW("Delivering", [Delivering hospitals], "NICU", [Hospitals with NICU], "Over60", [Women over 60 min from delivery])',
        "CMS V2"), True),
    ("show_figure tile_map CMS V2", lambda: tools.show_figure(
        "tile_map", "Median ED minutes by state", fields={"state": "State", "value": "Minutes"}, model="CMS V2",
        dax="EVALUATE SELECTCOLUMNS(FILTER(state_outcomes, NOT ISBLANK(state_outcomes[ed_median_min])), "
            "\"State\", state_outcomes[state], \"Minutes\", state_outcomes[ed_median_min])",
        options={"better": "lower"}), True),
    ("show_figure trend + project", lambda: tools.show_figure(
        "trend", "National CLABSI ratio, projected to 2030", fields={"x": "Year", "y": "SIR"},
        dax=f"EVALUATE ADDCOLUMNS(VALUES('HAI'[REPORTYEAR]), \"Year\", 'HAI'[REPORTYEAR], \"SIR\", "
            f"DIVIDE(CALCULATE(SUM('HAI'[HAI_1_NUMERATOR-Central Line Associated Bloodstream Infection (ICU + select Wards): Observed Cases])), "
            f"CALCULATE(SUM('HAI'[HAI_1_ELIGCASES-Central Line Associated Bloodstream Infection (ICU + select Wards): Predicted Cases]))))",
        options={"better": "lower", "benchmark": 1, "project": {"periods": 5, "from": 2021}}), True),
    ("show_figure dot_map CMS V2", lambda: tools.show_figure(
        "dot_map", "Minnesota hospitals that deliver babies", model="CMS V2",
        fields={"lat": "Lat", "lon": "Lon", "label": "Hospital", "category": "NICU"},
        dax="EVALUATE SELECTCOLUMNS(FILTER(maternity_hospitals, maternity_hospitals[state] = \"MN\" && maternity_hospitals[delivers_babies] = 1), "
            "\"Hospital\", maternity_hospitals[name], \"Lat\", maternity_hospitals[latitude], \"Lon\", maternity_hospitals[longitude], "
            "\"NICU\", IF(maternity_hospitals[nicu_any] = 1, \"NICU\", \"No NICU\"))",
        options={"focus": "MN"}), True),
    ("render_visual vega", lambda: tools.render_visual(
        "Women 15-44 by drive band", model="CMS V2",
        dax="EVALUATE SUMMARIZECOLUMNS(maternity_tracts[delivery_band], \"Women\", [Women 15-44])",
        spec={"mark": "bar", "encoding": {"x": {"field": "Women", "type": "quantitative"},
                                         "y": {"field": "delivery_band", "type": "nominal", "sort": "-x"}}}), True),
    ("dashboard figure check", lambda: dash("funnel", infection="cauti", state="tx", hospital="baylor"), True),
    # deliberate mistakes
    ("unknown model", lambda: tools.run_dax("EVALUATE ROW(\"x\", 1)", "CMS V3"), False),
    ("bad DAX", lambda: tools.run_dax("EVALUATE 'Nope'", "CMS"), False),
    ("project on bars", lambda: tools.show_figure("ranked_bars", "x", fields={"label": "a", "value": "b"},
                                                  rows=[{"a": "x", "b": 1}], options={"project": 3}), False),
    ("dashboard figure bad param", lambda: dash("star_mix", state="TX"), False),
    ("nearby_hospitals NICU near Ely", lambda: tools.nearby_hospitals("Ely, MN", "nicu", 3), True),
    ("nearby_hospitals unknown place", lambda: tools.nearby_hospitals("Zzyzxqq, ZZ", "any", 3), False),
    ("route_care Minneapolis-Duluth", lambda: tools.route_care("Minneapolis, MN", "Duluth, MN"), True),
    ("nearest_care from a map point, avoiding St Paul", lambda: tools.nearest_care("44.7266, -92.9695", "delivers", 3, avoid=["St Paul, MN"]), True),
    ("nearest_care ER near Rochester, not Mayo", lambda: tools.nearest_care("Rochester, MN", "emergency", 3, exclude='["Mayo"]'), True),
    ("nearest_care unknown place", lambda: tools.nearest_care("Zzyzxqq, ZZ"), False),
    ("nearest_care avoiding a whole state", lambda: tools.nearest_care("37.1608, -102.9697", "delivers", 3, avoid=["Texas"]), True),
]

failed = 0
for name, call, expect_ok in CASES:
    t = time.time()
    try:
        out = call()
        ok = out.ok == expect_ok
        first = out.text.strip().splitlines()[0][:150] if out.text.strip() else ""
    except Exception as e:  # a crash is always a failure
        ok, first = False, f"{type(e).__name__}: {e}"
    failed += not ok
    print(f"{'ok  ' if ok else 'FAIL'} {name:32} {time.time() - t:5.1f}s  {first}")
print(f"\n{len(CASES) - failed} of {len(CASES)} passed")
sys.exit(1 if failed else 0)
