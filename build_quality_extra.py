#!/usr/bin/env python3
"""Outcomes, emergency-department timeliness and Medicare penalties for every hospital (writes assets/quality-extra.js).

These measures are not in the Power BI semantic model yet, so they are read straight from CMS's public
Provider Data Catalog (Care Compare) files and kept locally:

    python3 build_quality_extra.py            # downloads anything missing into data/raw/, then builds
    python3 build_quality_extra.py --refresh  # re-downloads the CMS files first

Datasets (CMS Provider Data Catalog identifiers):
  xubh-q36u  Hospital General Information        overall star rating, ownership, group better/worse counts
  ynj2-r877  Complications and Deaths - Hospital 30-day mortality (heart attack, heart failure, pneumonia, COPD, stroke, CABG)
  632h-zaca  Unplanned Hospital Visits - Hospital 30-day readmissions
  yv7e-xc69  Timely and Effective Care - Hospital emergency department times, sepsis care
  9n3s-kdb3  Hospital Readmissions Reduction Program
  yq43-i98g  Hospital-Acquired Condition Reduction Program
  ypbt-wvdk  Hospital Value-Based Purchasing - Total Performance Score
"""
import csv
import datetime as dt
import json
import os
import statistics
import sys
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(ROOT, "data", "raw")
OUT = os.path.join(ROOT, "assets", "quality-extra.js")
META_API = "https://data.cms.gov/provider-data/api/1/metastore/schemas/dataset/items/{}?show-reference-ids=false"

DATASETS = {
    "general": ("xubh-q36u", "Hospital_General_Information.csv"),
    "deaths": ("ynj2-r877", "Complications_and_Deaths-Hospital.csv"),
    "visits": ("632h-zaca", "Unplanned_Hospital_Visits-Hospital.csv"),
    "timely": ("yv7e-xc69", "Timely_and_Effective_Care-Hospital.csv"),
    "hrrp": ("9n3s-kdb3", None),
    "hac": ("yq43-i98g", None),
    "vbp": ("ypbt-wvdk", "hvbp_tps.csv"),
}

# Conditions in display order; the same keys are used for mortality, readmission and HRRP
CONDITIONS = [
    ("ami", "Heart attack"), ("hf", "Heart failure"), ("pn", "Pneumonia"),
    ("copd", "COPD"), ("stk", "Stroke"), ("cabg", "Bypass surgery"),
]
MORT = {f"MORT_30_{k.upper()}": k for k, _ in CONDITIONS}
READM = {f"READM_30_{k.upper()}": k for k, _ in CONDITIONS if k != "stk"}
HRRP = {f"READM-30-{k.upper()}-HRRP": k for k, _ in CONDITIONS if k != "stk"}
HRRP["READM-30-HIP-KNEE-HRRP"] = "hip"
OWNERSHIP = {
    "Voluntary non-profit - Private": "Non-profit", "Voluntary non-profit - Church": "Non-profit (church)",
    "Voluntary non-profit - Other": "Non-profit", "Proprietary": "For-profit",
    "Government - Hospital District or Authority": "Government (district)", "Government - Local": "Government (local)",
    "Government - State": "Government (state)", "Government - Federal": "Government (federal)",
    "Veterans Health Administration": "Veterans Health Administration", "Department of Defense": "Department of Defense",
    "Physician": "Physician-owned", "Tribal": "Tribal",
}


def download(key, refresh):
    ident, name = DATASETS[key]
    meta = json.load(urllib.request.urlopen(META_API.format(ident), timeout=60))
    url = meta["distribution"][0]["data"]["downloadURL"]
    path = os.path.join(RAW, name or os.path.basename(url))
    if refresh or not os.path.exists(path):
        os.makedirs(RAW, exist_ok=True)
        print(f"  downloading {meta['title']} …", file=sys.stderr)
        urllib.request.urlretrieve(url, path)
    return path, meta["title"], meta["modified"]


def rows(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        yield from csv.DictReader(f)


def num(v):
    try:
        return float(str(v).replace(",", "").strip())
    except ValueError:
        return None


def rnd(v, p=1):
    return None if v is None else round(v, p)


def period(r):
    return [r.get("Start Date", ""), r.get("End Date", "")]


FABRIC = os.path.join(ROOT, "data", "fabric")


def write_fabric_tables(H, states, own_list):
    """Flat CSVs for the Fabric semantic model CMS V2 (publish_fabric.py); one row per hospital / state."""
    os.makedirs(FABRIC, exist_ok=True)
    cond = [k for k, _ in CONDITIONS]
    cols = (["ccn", "name", "city", "state", "overall_star", "ownership", "birthing_friendly", "mort_better", "mort_same", "mort_worse", "safety_better", "safety_same",
             "safety_worse", "readm_better", "readm_same", "readm_worse"] + [f"mort_rate_{k}" for k in cond] + [f"readm_rate_{k}" for k in cond if k != "stk"]
            + ["ed_median_min", "ed_left_without_seen_pct", "ed_volume", "sepsis_care_pct"] + [f"hrrp_err_{k}" for k in cond if k != "stk"] + ["hrrp_err_hip",
               "hac_total_score", "hac_payment_cut", "vbp_total_score"])
    with open(os.path.join(FABRIC, "hospital_outcomes.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for ccn, o in sorted(H.items()):
            g = lambda k, i: (o.get(k) or [None, None, None])[i]
            row = [ccn, o.get("name"), o.get("city"), o.get("state"), o.get("ovr"), o.get("own"), o.get("bf"), g("mortN", 0), g("mortN", 1), g("mortN", 2), g("safeN", 0), g("safeN", 1), g("safeN", 2),
                   g("readmN", 0), g("readmN", 1), g("readmN", 2)]
            row += [o.get("mort", {}).get(k) for k in cond] + [o.get("readm", {}).get(k) for k in cond if k != "stk"]
            row += [o.get("ed"), o.get("lwbs"), o.get("edv"), o.get("sep")] + [o.get("hrrp", {}).get(k) for k in cond if k != "stk"] + [o.get("hrrp", {}).get("hip")]
            row += [o.get("hac"), o.get("hacCut"), o.get("vbp")]
            w.writerow(["" if v is None else v for v in row])
    with open(os.path.join(FABRIC, "state_outcomes.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["state", "hospitals", "ed_median_min", "ed_reporting", "overall_star_avg", "rated", "five_star", "hac_payment_cut", "hac_scored"])
        for code, v in sorted(states.items()):
            w.writerow([code, v["n"], v["ed"], v["edN"], v["ovr"], v["rated"], v["five"], v["hacCut"], v["hacN"]])


def main():
    refresh = "--refresh" in sys.argv
    files, sources = {}, []
    for key, (ident, _) in DATASETS.items():
        path, title, modified = download(key, refresh)
        files[key] = path
        sources.append({"id": ident, "title": title, "modified": modified})

    H, periods = {}, {}

    def h(ccn):
        return H.setdefault(ccn, {})

    for r in rows(files["general"]):
        o = h(r["Facility ID"])
        star = r["Hospital overall rating"]
        o["ovr"] = int(star) if star.isdigit() else None
        o["name"], o["city"], o["state"] = r["Facility Name"], r["City/Town"], r["State"]
        o["own"] = OWNERSHIP.get(r["Hospital Ownership"], r["Hospital Ownership"] or None)
        o["bf"] = 1 if r["Meets criteria for birthing friendly designation"] == "Y" else 0
        for grp, k in (("MORT", "mortN"), ("Safety", "safeN"), ("READM", "readmN")):
            vals = [num(r[f"Count of {grp} Measures {w}"]) for w in ("Better", "No Different", "Worse")]
            o[k] = [int(v) if v is not None else None for v in vals]

    for r in rows(files["deaths"]):
        k = MORT.get(r["Measure ID"])
        if not k:
            continue
        periods.setdefault("mort", period(r))
        s = num(r["Score"])
        if s is not None:
            h(r["Facility ID"]).setdefault("mort", {})[k] = rnd(s)

    for r in rows(files["visits"]):
        k = READM.get(r["Measure ID"])
        if not k:
            continue
        periods.setdefault("readm", period(r))
        s = num(r["Score"])
        if s is not None:
            h(r["Facility ID"]).setdefault("readm", {})[k] = rnd(s)

    for r in rows(files["timely"]):
        m, s = r["Measure ID"], num(r["Score"])
        o = h(r["Facility ID"])
        if m == "OP_18b":
            periods.setdefault("ed", period(r))
            if s is not None:
                o["ed"] = int(s)
        elif m == "OP_22" and s is not None:
            o["lwbs"] = int(s)
        elif m == "EDV" and r["Score"] not in ("", "Not Available"):
            o["edv"] = r["Score"]
        elif m == "SEP_1" and s is not None:
            periods.setdefault("sep", period(r))
            o["sep"] = int(s)

    for r in rows(files["hrrp"]):
        k, err = HRRP.get(r["Measure Name"]), num(r["Excess Readmission Ratio"])
        periods.setdefault("hrrp", period(r))
        if k and err is not None:
            h(r["Facility ID"]).setdefault("hrrp", {})[k] = round(err, 4)

    for r in rows(files["hac"]):
        o = h(r["Facility ID"])
        periods.setdefault("hacFy", r["Fiscal Year"])
        score = num(r["Total HAC Score"])
        if score is not None:
            o["hac"] = round(score, 4)
        if r["Payment Reduction"] in ("Yes", "No"):
            o["hacCut"] = 1 if r["Payment Reduction"] == "Yes" else 0

    for r in rows(files["vbp"]):
        periods.setdefault("vbpFy", r["Fiscal Year"])
        tps = num(r["Total Performance Score"])
        if tps is not None:
            h(r["Facility ID"])["vbp"] = round(tps, 1)

    # National and state summaries for the outcome charts
    def vals(key):
        return [o[key] for o in H.values() if o.get(key) is not None]

    states = {}
    for r in rows(files["general"]):
        o = H[r["Facility ID"]]
        o["st"] = r["State"]
    by_state = {}
    for o in H.values():
        if o.get("st"):
            by_state.setdefault(o["st"], []).append(o)
    for code, hs in by_state.items():
        ed = [o["ed"] for o in hs if o.get("ed") is not None]
        rated = [o["ovr"] for o in hs if o.get("ovr")]
        hac = [o["hacCut"] for o in hs if o.get("hacCut") is not None]
        states[code] = {
            "n": len(hs), "ed": statistics.median(ed) if ed else None, "edN": len(ed),
            "ovr": round(statistics.mean(rated), 2) if rated else None, "rated": len(rated),
            "five": sum(1 for s in rated if s == 5), "hacCut": sum(hac), "hacN": len(hac),
        }

    nat = {
        "ovr": {str(s): sum(1 for v in vals("ovr") if v == s) for s in range(1, 6)},
        "unrated": sum(1 for o in H.values() if "ovr" in o and o["ovr"] is None),
        "ed": {"median": statistics.median(vals("ed")), "n": len(vals("ed")),
               "p10": statistics.quantiles(vals("ed"), n=10)[0], "p90": statistics.quantiles(vals("ed"), n=10)[-1]},
        "hacCut": sum(vals("hacCut")), "hacN": len(vals("hacCut")),
        "mort": {}, "readm": {}, "hrrp": {},
    }
    # Per-condition "compared to national" is not published in this release, so better/worse comes from each hospital's
    # group counts in Hospital General Information; per-condition rates are shown as national medians
    for k, _ in CONDITIONS:
        m = [o["mort"][k] for o in H.values() if k in o.get("mort", {})]
        if m:
            nat["mort"][k] = {"n": len(m), "median": statistics.median(m), "p10": statistics.quantiles(m, n=10)[0], "p90": statistics.quantiles(m, n=10)[-1]}
        rr = [o["readm"][k] for o in H.values() if k in o.get("readm", {})]
        if rr:
            nat["readm"][k] = {"n": len(rr), "median": statistics.median(rr), "p10": statistics.quantiles(rr, n=10)[0], "p90": statistics.quantiles(rr, n=10)[-1]}
        e = [o["hrrp"][k] for o in H.values() if k in o.get("hrrp", {})]
        if e:
            nat["hrrp"][k] = {"n": len(e), "excess": sum(1 for v in e if v > 1)}
    for grp in ("mortN", "safeN", "readmN"):
        g = [o[grp] for o in H.values() if o.get(grp) and None not in o[grp]]
        nat[grp] = {"n": len(g), "anyWorse": sum(1 for b, s, w in g if w > 0), "anyBetter": sum(1 for b, s, w in g if b > 0)}
    hr = [o for o in H.values() if o.get("hrrp")]
    nat["hrrpAny"] = {"n": len(hr), "excess": sum(1 for o in hr if any(v > 1 for v in o["hrrp"].values()))}

    # Compact rows: one array per hospital in FIELDS order; per-condition values follow meta.conditions order
    own_list = sorted({o["own"] for o in H.values() if o.get("own")})
    edv_list = ["low", "medium", "high", "very high"]
    cond = [k for k, _ in CONDITIONS] + ["hip"]
    FIELDS = ["ovr", "own", "bf", "mortN", "safeN", "readmN", "mort", "readm", "ed", "lwbs", "edv", "sep", "hrrp", "hac", "hacCut", "vbp"]

    def pack(o):
        row = [
            o.get("ovr"), own_list.index(o["own"]) if o.get("own") else None, o.get("bf"),
            o.get("mortN"), o.get("safeN"), o.get("readmN"),
            [o.get("mort", {}).get(k) for k in cond[:6]] if o.get("mort") else None,
            [o.get("readm", {}).get(k) for k in cond[:6]] if o.get("readm") else None,
            o.get("ed"), o.get("lwbs"), edv_list.index(o["edv"]) if o.get("edv") in edv_list else None, o.get("sep"),
            [o.get("hrrp", {}).get(k) for k in cond] if o.get("hrrp") else None,
            o.get("hac"), o.get("hacCut"), o.get("vbp"),
        ]
        while row and row[-1] is None:
            row.pop()
        return row

    packed = {ccn: pack(o) for ccn, o in H.items()}
    packed = {k: v for k, v in packed.items() if any(x is not None for x in v)}

    write_fabric_tables(H, states, own_list)

    payload = {
        "meta": {"built": dt.date.today().isoformat(), "sources": sources, "periods": periods, "fields": FIELDS,
                 "ownership": own_list, "edVolume": edv_list,
                 "conditions": [{"key": k, "label": l} for k, l in CONDITIONS] + [{"key": "hip", "label": "Hip/knee replacement"}]},
        "national": nat, "states": states, "hospitals": packed,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("// Generated by build_quality_extra.py from public CMS Care Compare files. Regenerate rather than edit by hand.\n")
        f.write("window.CMS_EXTRA = ")
        json.dump(payload, f, separators=(",", ":"))
        f.write(";\n")
    print(f"wrote {OUT}: {len(packed)} hospitals, {os.path.getsize(OUT) // 1024} KB", file=sys.stderr)
    print(json.dumps({k: v for k, v in nat.items()}, indent=1)[:2500], file=sys.stderr)


if __name__ == "__main__":
    main()
