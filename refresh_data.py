#!/usr/bin/env python3
"""Write assets/data.js: the infection, patient-experience and PSI-90 data behind the Quality & safety charts.

    python3 build_core_tables.py         # first: builds data/core/*.csv from CMS's public archive
    python3 refresh_data.py --local      # compute everything from data/core/*.csv (no Azure needed)
    python3 refresh_data.py              # or query a Power BI semantic model built on the same tables

The semantic model route needs the workspace and model IDs, from the command line or the environment:
    python3 refresh_data.py --workspace <workspace-guid> --model <semantic-model-guid> [--workspace-name <name>]
    CMS_WORKSPACE_ID=... CMS_MODEL_ID=... CMS_WORKSPACE_NAME=... python3 refresh_data.py
publish_fabric.py --core creates that model (tables HAI, HCAHPS and PSI90, named as in build_core_tables.py). Auth uses
your Azure CLI login (`az login`); queries run through the Power BI executeQueries REST API. Both routes produce the same
file (checked against a semantic model built this way: no differences).
"""
import argparse
import csv
import datetime as dt
import json
import os
import statistics
import subprocess
import sys
import urllib.error
import urllib.request

from build_core_tables import HAI_COLS, HCAHPS_COLS, PSI_COLS

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "assets", "data.js")
CORE = os.path.join(ROOT, "data", "core")
INF = [
    ("clabsi", "CLABSI", "Central line bloodstream infection"),
    ("cauti", "CAUTI", "Catheter urinary tract infection"),
    ("ssi_colon", "SSI · Colon", "Surgical site infection — colon surgery"),
    ("ssi_hyst", "SSI · Hysterectomy", "Surgical site infection — abdominal hysterectomy"),
    ("mrsa", "MRSA", "MRSA bacteremia"),
    ("cdiff", "C. diff", "Clostridioides difficile infection"),
]
KIND_SUFFIX = {"sir": "sir", "pred": "eligcases", "obs": "numerator", "lo": "cilower", "hi": "ciupper", "exp": "dopc"}
HAI_MODEL = {c: m for c, m, _ in HAI_COLS}
HC_MODEL = {c: m for c, m, _ in HCAHPS_COLS}
PSI_MODEL = {c: m for c, m, _ in PSI_COLS}
HCAHPS_DIMS = [("clean", "h_clean_linear_score"), ("nurse", "h_comp_1_linear_score"), ("doctor", "h_comp_2_linear_score"),
               ("staff", "h_comp_3_linear_score"), ("meds", "h_comp_5_linear_score"), ("discharge", "h_comp_6_linear_score"),
               ("transition", "h_comp_7_linear_score"), ("overall", "h_hsp_rating_linear_score"), ("quiet", "h_quiet_linear_score"),
               ("recommend", "h_recmnd_linear_score")]
PSI_COMPONENTS = [("puncture", "psi_puncture"), ("pneumo", "psi_pneumo"), ("hipfx", "psi_hipfx"), ("fallfx", "psi_fallfx"),
                  ("periop_hem", "psi_periop_hem"), ("pe_dvt", "psi_pe_dvt"), ("aki", "psi_aki"), ("postop_hem", "psi_postop_hem"),
                  ("resp", "psi_resp"), ("sepsis", "psi_sepsis"), ("dehisc", "psi_dehisc"), ("ulcer", "psi_ulcer")]


def hai_col(i, kind):
    return f"hai_{i}_{KIND_SUFFIX[kind]}"


def r(v, n=6):
    return None if v is None else round(v, n)


# ---------- Source 1: the core tables on disk ----------
class Local:
    """The same aggregations as the DAX queries below, over data/core/*.csv. Blanks behave as in DAX: SUM, AVERAGE and
    COUNT skip them, and an aggregate over nothing is blank (None)."""

    label = "local"

    def __init__(self):
        self.t = {name: self._load(name) for name in ("hai", "hcahps", "psi90")}

    @staticmethod
    def _load(name):
        path = os.path.join(CORE, f"{name}.csv")
        if not os.path.exists(path):
            sys.exit(f"Missing {os.path.relpath(path, ROOT)}. Run `python3 build_core_tables.py` first.")
        rows = []
        with open(path, encoding="utf-8", newline="") as fh:
            for row in csv.DictReader(fh):
                for k, v in row.items():
                    if k not in ("facility_id", "facility_name", "city", "state", "start_date", "end_date"):
                        row[k] = float(v) if v != "" else None
                row["report_year"] = int(row["report_year"])
                rows.append(row)
        return rows

    def rows(self, table, year=None):
        return [x for x in self.t[table] if year is None or x["report_year"] == year]

    @staticmethod
    def vals(rows, col):
        return [x[col] for x in rows if x[col] is not None]

    @staticmethod
    def sum(rows, col):
        v = Local.vals(rows, col)
        return sum(v) if v else None

    @staticmethod
    def avg(rows, col):
        v = Local.vals(rows, col)
        return sum(v) / len(v) if v else None

    @staticmethod
    def count(rows, col):
        return len(Local.vals(rows, col)) or None

    @staticmethod
    def pct(values, p):
        """PERCENTILE.INC"""
        v = sorted(values)
        k = (len(v) - 1) * p
        lo = int(k)
        return v[lo] + (v[min(lo + 1, len(v) - 1)] - v[lo]) * (k - lo)

    def years(self, table):
        return sorted({x["report_year"] for x in self.t[table]})

    def summary(self):
        y = {k: max(self.years(k)) for k in self.t}
        ids = lambda k: len({x["facility_id"] for x in self.t[k]})
        return y["hai"], y["hcahps"], y["psi90"], {"haiFacilities": ids("hai"), "hcahpsFacilities": ids("hcahps"), "psiFacilities": ids("psi90"),
                                                   "states": len({x["state"] for x in self.t["hai"]})}

    def period(self, table, year):
        rows = self.rows(table, year)
        return [min(x["start_date"] for x in rows if x["start_date"]), max(x["end_date"] for x in rows if x["end_date"])]

    def hai_trend(self):
        out = []
        for y in self.years("hai"):
            rows = self.rows("hai", y)
            d = {"REPORTYEAR": y}
            for i in range(1, 7):
                d.update({f"o{i}": self.sum(rows, hai_col(i, "obs")), f"p{i}": self.sum(rows, hai_col(i, "pred")), f"d{i}": self.sum(rows, hai_col(i, "exp")),
                          f"n{i}": self.count(rows, hai_col(i, "sir")), f"c{i}": self.count(rows, hai_col(i, "obs")), f"a{i}": self.avg(rows, hai_col(i, "sir")),
                          f"b{i}": sum(1 for x in rows if x[hai_col(i, "hi")] is not None and x[hai_col(i, "hi")] < 1) or None,
                          f"w{i}": sum(1 for x in rows if x[hai_col(i, "lo")] is not None and x[hai_col(i, "lo")] > 1) or None})
            out.append(d)
        return out

    def hcahps_trend(self):
        out = []
        for y in self.years("hcahps"):
            rows = self.rows("hcahps", y)
            d = {"REPORTYEAR": y, **{k: self.avg(rows, c) for k, c in HCAHPS_DIMS}}
            d.update({f"s{s}": sum(1 for x in rows if x["h_star_rating"] == s) or None for s in range(1, 6)})
            d["avgstar"] = self.avg(rows, "h_star_rating")
            out.append(d)
        return out

    def psi_trend(self):
        out = []
        for y in self.years("psi90"):
            rows = self.rows("psi90", y)
            v = self.vals(rows, "psi_90")
            d = {"REPORTYEAR": y, "psi90": statistics.fmean(v), "psi90_med": statistics.median(v), "psi90_p10": self.pct(v, 0.1),
                 "psi90_p90": self.pct(v, 0.9), "n": len(v), **{k: self.avg(rows, c) for k, c in PSI_COMPONENTS}}
            out.append(d)
        return out

    def by_state(self, table, year):
        groups = {}
        for x in self.rows(table, year):
            groups.setdefault(x["state"], []).append(x)
        return groups

    def hai_states(self, year):
        out = []
        for st, rows in self.by_state("hai", year).items():
            d = {"STATE": st, "hosp": len({x["facility_id"] for x in rows})}
            for i in range(1, 7):
                d[f"o{i}"], d[f"p{i}"] = self.sum(rows, hai_col(i, "obs")), self.sum(rows, hai_col(i, "pred"))
            out.append(d)
        return out

    def hcahps_states(self, year):
        out = []
        for st, rows in self.by_state("hcahps", year).items():
            d = {"STATE": st, "avgstar": self.avg(rows, "h_star_rating"), "rated": self.count(rows, "h_star_rating"),
                 "top": sum(1 for x in rows if (x["h_star_rating"] or 0) >= 4) or None, "recommend": self.avg(rows, "h_recmnd_linear_score")}
            if any(v is not None for k, v in d.items() if k != "STATE"):
                out.append(d)
        return out

    def hcahps_first_states(self, year):
        return [{"STATE": st, "s": a} for st, rows in self.by_state("hcahps", year).items() if (a := self.avg(rows, "h_star_rating")) is not None]

    def psi_states(self, year):
        return [{"STATE": st, "psi90": self.avg(rows, "psi_90"), "n": self.count(rows, "psi_90")}
                for st, rows in self.by_state("psi90", year).items() if self.count(rows, "psi_90")]

    @staticmethod
    def ident(x):
        return {"id": x["facility_id"], "name": x["facility_name"], "city": x["city"], "st": x["state"]}

    def hai_facilities(self, year):
        out = []
        for x in self.rows("hai", year):
            if any(x[hai_col(i, "sir")] is not None for i in range(1, 7)):
                d = self.ident(x)
                for i in range(1, 7):
                    d.update({f"s{i}": x[hai_col(i, "sir")], f"p{i}": x[hai_col(i, "pred")], f"o{i}": x[hai_col(i, "obs")],
                              f"l{i}": x[hai_col(i, "lo")], f"u{i}": x[hai_col(i, "hi")]})
                out.append(d)
        return out

    def hcahps_facilities(self, year):
        return [{**self.ident(x), "star": x["h_star_rating"], "recommend": x["h_recmnd_linear_score"]}
                for x in self.rows("hcahps", year) if x["h_star_rating"] is not None]

    def psi_facilities(self, year):
        return [{**self.ident(x), "psi90": x["psi_90"]} for x in self.rows("psi90", year) if x["psi_90"] is not None]


# ---------- Source 2: a Power BI semantic model ----------
def dax_col(table, col):
    model = {"HAI": HAI_MODEL, "HCAHPS": HC_MODEL, "PSI90": PSI_MODEL}[table]
    return f"{table}[{model[col]}]"


def dax_hai(i, kind):
    return dax_col("HAI", hai_col(i, kind))


STAR = dax_col("HCAHPS", "h_star_rating")
PSI = dax_col("PSI90", "psi_90")


def summarize(group, cols, filt=None):
    body = "SUMMARIZECOLUMNS (\n    " + group + ",\n    " + ",\n    ".join(f'"{k}", {v}' for k, v in cols) + "\n)"
    return f"EVALUATE\n{body}" if not filt else f"EVALUATE\nCALCULATETABLE (\n{body},\n    {filt}\n)"


class PowerBI:
    label = "powerbi"

    def __init__(self, workspace, model):
        self.workspace, self.model = workspace, model
        try:
            self.tok = subprocess.check_output(
                ["az", "account", "get-access-token", "--resource", "https://analysis.windows.net/powerbi/api", "--query", "accessToken", "-o", "tsv"],
                text=True).strip()
        except (OSError, subprocess.CalledProcessError) as e:
            sys.exit(f"Could not get a Power BI token from the Azure CLI. Run `az login` first. ({e})")
        self.queries = {}

    def run(self, dax, name=None):
        if name:
            self.queries[name] = dax
        url = f"https://api.powerbi.com/v1.0/myorg/groups/{self.workspace}/datasets/{self.model}/executeQueries"
        body = json.dumps({"queries": [{"query": dax}], "serializerSettings": {"includeNulls": True}}).encode()
        req = urllib.request.Request(url, data=body, headers={"Authorization": "Bearer " + self.tok, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                res = json.load(resp)
        except urllib.error.HTTPError as e:
            sys.exit(f"Query failed ({e.code}): {e.read().decode()[:600]}\n--- DAX ---\n{dax[:400]}")
        rows = res["results"][0]["tables"][0].get("rows", [])
        # Keys come back as "Table[Column]" or "[alias]"; keep only the column/alias name
        return [{k[k.index("[") + 1:-1]: v for k, v in row.items()} for row in rows]

    def summary(self):
        y = self.run(f'EVALUATE ROW("hai", MAX(HAI[REPORTYEAR]), "hc", MAX(HCAHPS[REPORTYEAR]), "psi", MAX(PSI90[REPORTYEAR]), '
                     f'"haiF", DISTINCTCOUNT(HAI[facility id]), "hcF", DISTINCTCOUNT(HCAHPS[facility id]), "psiF", DISTINCTCOUNT(PSI90[facility id]), '
                     f'"states", DISTINCTCOUNT(HAI[STATE]))')[0]
        return int(y["hai"]), int(y["hc"]), int(y["psi"]), {"haiFacilities": y["haiF"], "hcahpsFacilities": y["hcF"], "psiFacilities": y["psiF"], "states": y["states"]}

    def period(self, table, year):
        t = {"hai": "HAI", "hcahps": "HCAHPS", "psi90": "PSI90"}[table]
        p = self.run(f'EVALUATE CALCULATETABLE(ROW("s", MIN({t}[start date]), "e", MAX({t}[end date])), {t}[REPORTYEAR] = {year})')[0]
        return [p["s"][:10], p["e"][:10]]

    def hai_periods(self):
        rows = self.run(summarize("HAI[REPORTYEAR]", [("start", "MIN ( HAI[start date] )"), ("end", "MAX ( HAI[end date] )")]), "haiPeriods")
        return {int(x["REPORTYEAR"]): [x["start"][:10], x["end"][:10]] for x in rows}

    def hai_trend(self):
        sums = [(f"{a}{i}", f"SUM ( {dax_hai(i, k)} )") for i in range(1, 7) for a, k in (("o", "obs"), ("p", "pred"), ("d", "exp"))]
        counts = []
        for i in range(1, 7):
            counts += [(f"n{i}", f"COUNT ( {dax_hai(i, 'sir')} )"), (f"c{i}", f"COUNT ( {dax_hai(i, 'obs')} )"), (f"a{i}", f"AVERAGE ( {dax_hai(i, 'sir')} )"),
                       (f"b{i}", f"CALCULATE ( COUNTROWS ( HAI ), {dax_hai(i, 'hi')} < 1, NOT ISBLANK ( {dax_hai(i, 'hi')} ) )"),
                       (f"w{i}", f"CALCULATE ( COUNTROWS ( HAI ), {dax_hai(i, 'lo')} > 1 )")]
        a = {x["REPORTYEAR"]: x for x in self.run(summarize("HAI[REPORTYEAR]", sums), "haiTrend")}
        b = {x["REPORTYEAR"]: x for x in self.run(summarize("HAI[REPORTYEAR]", counts), "haiCounts")}
        return [{**a[y], **b.get(y, {})} for y in sorted(a)]

    def hcahps_trend(self):
        cols = [(k, f"AVERAGE ( {dax_col('HCAHPS', c)} )") for k, c in HCAHPS_DIMS]
        cols += [(f"s{s}", f"CALCULATE ( COUNTROWS ( HCAHPS ), {STAR} = {s} )") for s in range(1, 6)] + [("avgstar", f"AVERAGE ( {STAR} )")]
        return sorted(self.run(summarize("HCAHPS[REPORTYEAR]", cols)), key=lambda d: d["REPORTYEAR"])

    def psi_trend(self):
        cols = [("psi90", f"AVERAGE ( {PSI} )"), ("psi90_med", f"MEDIAN ( {PSI} )"), ("psi90_p10", f"PERCENTILE.INC ( {PSI}, 0.1 )"),
                ("psi90_p90", f"PERCENTILE.INC ( {PSI}, 0.9 )"), ("n", f"COUNT ( {PSI} )")] + [(k, f"AVERAGE ( {dax_col('PSI90', c)} )") for k, c in PSI_COMPONENTS]
        return sorted(self.run(summarize("PSI90[REPORTYEAR]", cols)), key=lambda d: d["REPORTYEAR"])

    def hai_states(self, year):
        cols = [("hosp", "DISTINCTCOUNT ( HAI[facility id] )")] + [(f"{a}{i}", f"SUM ( {dax_hai(i, k)} )") for i in range(1, 7) for a, k in (("o", "obs"), ("p", "pred"))]
        return self.run(summarize("HAI[STATE]", cols, f"HAI[REPORTYEAR] = {year}"))

    def hcahps_states(self, year):
        cols = [("avgstar", f"AVERAGE ( {STAR} )"), ("rated", f"COUNT ( {STAR} )"), ("top", f"CALCULATE ( COUNTROWS ( HCAHPS ), {STAR} >= 4 )"),
                ("recommend", f"AVERAGE ( {dax_col('HCAHPS', 'h_recmnd_linear_score')} )")]
        return self.run(summarize("HCAHPS[STATE]", cols, f"HCAHPS[REPORTYEAR] = {year}"))

    def hcahps_first_states(self, year):
        return self.run(summarize("HCAHPS[STATE]", [("s", f"AVERAGE ( {STAR} )")], f"HCAHPS[REPORTYEAR] = {year}"))

    def psi_states(self, year):
        return self.run(summarize("PSI90[STATE]", [("psi90", f"AVERAGE ( {PSI} )"), ("n", f"COUNT ( {PSI} )")], f"PSI90[REPORTYEAR] = {year}"))

    @staticmethod
    def ident(t):
        return f'"id", {t}[facility id], "name", {t}[facility name], "city", {t}[CITY], "st", {t}[STATE]'

    def hai_facilities(self, year):
        any_sir = " || ".join(f"NOT ISBLANK({dax_hai(i, 'sir')})" for i in range(1, 7))
        cols = ", ".join(f'"{x}{i}", {dax_hai(i, kind)}' for i in range(1, 7) for x, kind in (("s", "sir"), ("p", "pred"), ("o", "obs"), ("l", "lo"), ("u", "hi")))
        return self.run(f"EVALUATE SELECTCOLUMNS(FILTER(HAI, HAI[REPORTYEAR] = {year} && ({any_sir})), {self.ident('HAI')}, {cols})")

    def hcahps_facilities(self, year):
        return self.run(f'EVALUATE SELECTCOLUMNS(FILTER(HCAHPS, HCAHPS[REPORTYEAR] = {year} && NOT ISBLANK({STAR})), {self.ident("HCAHPS")}, '
                        f'"star", {STAR}, "recommend", {dax_col("HCAHPS", "h_recmnd_linear_score")})')

    def psi_facilities(self, year):
        return self.run(f'EVALUATE SELECTCOLUMNS(FILTER(PSI90, PSI90[REPORTYEAR] = {year} && NOT ISBLANK({PSI})), {self.ident("PSI90")}, "psi90", {PSI})')


# ---------- The data file ----------
def extract(src):
    yh, yc, yp, counts = src.summary()
    periods = {"hai": src.period("hai", yh), "hcahps": src.period("hcahps", yc), "psi": src.period("psi90", yp)}
    hai_periods = src.hai_periods() if isinstance(src, PowerBI) else {y: src.period("hai", y) for y in src.years("hai")}

    trend = []
    for row in src.hai_trend():
        out = {"year": int(row["REPORTYEAR"])}
        for i, (k, *_) in enumerate(INF, 1):
            out[k] = {"sir": r(row[f"o{i}"] / row[f"p{i}"]), "obs": int(row[f"o{i}"]), "pred": r(row[f"p{i}"], 3), "exposure": int(row[f"d{i}"] or 0),
                      "n": row[f"n{i}"] or 0, "reporting": row[f"c{i}"] or 0, "avgHospSir": r(row[f"a{i}"]), "better": row[f"b{i}"] or 0, "worse": row[f"w{i}"] or 0}
        trend.append(out)
    hc_trend = [{**{k: (r(v) if k not in ("s1", "s2", "s3", "s4", "s5") else v or 0) for k, v in d.items() if k != "REPORTYEAR"}, "year": int(d["REPORTYEAR"])}
                for d in src.hcahps_trend()]
    psi_trend = [{**{k: r(v) for k, v in d.items() if k != "REPORTYEAR"}, "year": int(d["REPORTYEAR"])} for d in src.psi_trend()]

    states = {}
    for row in src.hai_states(yh):
        s = states.setdefault(row["STATE"], {})
        s["hospHai"] = row["hosp"]
        for i, (k, *_) in enumerate(INF, 1):
            p = row[f"p{i}"]
            s[k] = r((row[f"o{i}"] or 0) / p) if p else None
            s[k + "_pred"] = r(p, 3) if p else None
    for row in src.hcahps_states(yc):
        rated = row["rated"] or 0
        states.setdefault(row["STATE"], {}).update(star=r(row["avgstar"]), rated=rated, topPct=r((row["top"] or 0) / rated * 100) if rated else None,
                                                   recommend=r(row["recommend"]))
    first_hc = hc_trend[0]["year"]
    for row in src.hcahps_first_states(first_hc):
        states.setdefault(row["STATE"], {})["star19"] = r(row["s"])
    for row in src.psi_states(yp):
        states.setdefault(row["STATE"], {}).update(psi90=r(row["psi90"]), psiN=row["n"])

    fac = {}

    def base(row):
        title = lambda v: (v or "").title()
        return fac.setdefault(row["id"], {"id": row["id"], "name": title(row["name"]), "city": title(row["city"]), "st": row["st"]})

    for row in src.hai_facilities(yh):
        f = base(row)
        for i, (k, *_) in enumerate(INF, 1):
            if row[f"s{i}"] is not None:
                f[k] = [r(row[f"s{i}"], 3), r(row[f"p{i}"], 3), int(row[f"o{i}"] or 0), r(row[f"l{i}"], 3), r(row[f"u{i}"], 3)]
    for row in src.hcahps_facilities(yc):
        f = base(row)
        f["star"] = int(row["star"])
        f["recommend"] = None if row["recommend"] is None else int(round(row["recommend"]))
    for row in src.psi_facilities(yp):
        base(row)["psi90"] = r(row["psi90"], 4)
    F = list(fac.values())
    keys = [k for k, *_ in INF]
    return {
        "haiYear": yh, "hcahpsYear": yc, "psiYear": yp, "periods": periods, "haiYearPeriods": {str(k): v for k, v in sorted(hai_periods.items())},
        "counts": counts, "trend": trend, "hc_trend": hc_trend, "psi_trend": psi_trend, "states": states, "facilities": F, "keys": keys,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--local", action="store_true", help="read data/core/*.csv instead of a semantic model")
    ap.add_argument("--workspace", default=os.environ.get("CMS_WORKSPACE_ID"), help="Fabric workspace ID (or CMS_WORKSPACE_ID)")
    ap.add_argument("--model", default=os.environ.get("CMS_MODEL_ID"), help="semantic model ID (or CMS_MODEL_ID)")
    ap.add_argument("--workspace-name", default=os.environ.get("CMS_WORKSPACE_NAME", ""), help="workspace name shown in the Explain panel")
    args = ap.parse_args()
    if args.local:
        src = Local()
        print("Reading data/core/*.csv …")
    else:
        if not (args.workspace and args.model):
            sys.exit("Set the semantic model with --workspace/--model (or CMS_WORKSPACE_ID/CMS_MODEL_ID), or use --local.")
        src = PowerBI(args.workspace, args.model)
        print("Connected; querying semantic model …")
    x = extract(src)
    keys = x["keys"]
    meta = {"source": src.label, "model": "CMS", "workspace": args.workspace_name if src.label == "powerbi" else "",
            "haiYear": x["haiYear"], "hcahpsYear": x["hcahpsYear"], "psiYear": x["psiYear"], "periods": x["periods"],
            "haiYearPeriods": x["haiYearPeriods"], "extracted": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "counts": x["counts"]}
    if src.label == "powerbi":
        meta.update(queries=src.queries, modelId=args.model, workspaceId=args.workspace)
    infections = [{"key": k, "short": s, "label": l, "columns": {kind: HAI_MODEL[hai_col(i, kind)] for kind in KIND_SUFFIX}}
                  for i, (k, s, l) in enumerate(INF, 1)]
    data = {
        "meta": meta, "infections": infections,
        "haiTrend": x["trend"], "hcahpsTrend": x["hc_trend"], "psiTrend": x["psi_trend"], "states": x["states"],
        "facilityFields": ["id", "name", "city", "st", "star", "recommend", "psi90"] + keys,
        "facilities": [[f["id"], f["name"], f["city"], f["st"], f.get("star"), f.get("recommend"), f.get("psi90")] + [f.get(k) for k in keys] for f in x["facilities"]],
    }
    origin = "data/core/*.csv (public CMS archive files) by refresh_data.py --local" if src.label == "local" else 'Power BI semantic model "CMS" by refresh_data.py'
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(f"// Generated from {origin}. Regenerate rather than edit by hand.\n")
        fh.write("window.CMS_DATA = " + json.dumps(data, separators=(",", ":"), ensure_ascii=False) + ";\n")
    F = x["facilities"]
    print(f"Wrote {os.path.relpath(OUT, ROOT)}: {len(F):,} hospitals · HAI {x['haiYear']} · HCAHPS {x['hcahpsYear']} · PSI-90 {x['psiYear']} · "
          f"median PSI-90 {statistics.median(f['psi90'] for f in F if f.get('psi90')):.3f}")


if __name__ == "__main__":
    main()
