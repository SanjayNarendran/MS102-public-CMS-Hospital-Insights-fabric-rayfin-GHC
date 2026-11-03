#!/usr/bin/env python3
"""Publish the dashboard's tables to Microsoft Fabric as lakehouses and Direct Lake semantic models (optional; the app
itself runs from the files in assets/ and does not need these).

    python3 publish_fabric.py --workspace <workspace-guid>            # both sets below
    python3 publish_fabric.py --workspace <workspace-guid> --core     # only the core tables and the "CMS" model
    python3 publish_fabric.py --workspace <workspace-guid> --v2       # only the outcomes / maternity tables and "CMS V2"
    (or set FABRIC_WORKSPACE_ID instead of passing --workspace)

  --core  data/core/{hai,hcahps,psi90}.csv (build_core_tables.py) -> lakehouse lh_cms_core -> semantic model "CMS" with
          tables HAI, HCAHPS and PSI90. Columns are renamed to the names refresh_data.py queries, so afterwards
              python3 refresh_data.py --workspace <workspace-guid> --model <id printed below>
          rebuilds assets/data.js from the model (identical to refresh_data.py --local).
  --v2    data/fabric/*.csv (build_quality_extra.py, build_maternity.py) -> lakehouse lh_cms_v2 -> semantic model "CMS V2"
          with relationships and measures.

Needs `az login` with access to the workspace, a running Fabric capacity behind it, and pyarrow (pip install pyarrow).
Steps (all idempotent): create the lakehouse if missing; convert each CSV to Parquet with an explicit schema (so IDs such as
CCN and tract GEOID keep their leading zeros) and upload it to OneLake; load it into a Delta table (overwrite); create or
update the semantic model from a generated TMDL definition; refresh (frame) the model and run a DAX check query.
"""
import argparse
import base64
import io
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

import pyarrow as pa
import pyarrow.csv as pcsv
import pyarrow.parquet as pq

ROOT = os.path.dirname(os.path.abspath(__file__))
WORKSPACE_ID = None  # set from --workspace / FABRIC_WORKSPACE_ID in main()
FABRIC_API = "https://api.fabric.microsoft.com/v1"
PBI_API = "https://api.powerbi.com/v1.0/myorg"
ONELAKE = "https://onelake.dfs.fabric.microsoft.com"

S, I, D, T = "string", "int64", "double", "date"
TABLES = {
    "hospital_outcomes": {
        "desc": "CMS Care Compare outcomes, ED timeliness and Medicare penalty programs, one row per hospital (CCN).",
        "cols": [("ccn", S), ("name", S), ("city", S), ("state", S), ("overall_star", I), ("ownership", S), ("birthing_friendly", I),
                 ("mort_better", I), ("mort_same", I), ("mort_worse", I), ("safety_better", I), ("safety_same", I), ("safety_worse", I),
                 ("readm_better", I), ("readm_same", I), ("readm_worse", I)]
                + [(f"mort_rate_{k}", D) for k in ("ami", "hf", "pn", "copd", "stk", "cabg")]
                + [(f"readm_rate_{k}", D) for k in ("ami", "hf", "pn", "copd", "cabg")]
                + [("ed_median_min", I), ("ed_left_without_seen_pct", I), ("ed_volume", S), ("sepsis_care_pct", I)]
                + [(f"hrrp_err_{k}", D) for k in ("ami", "hf", "pn", "copd", "cabg", "hip")]
                + [("hac_total_score", D), ("hac_payment_cut", I), ("vbp_total_score", D)],
    },
    "state_outcomes": {
        "desc": "State summaries of the hospital outcomes table.",
        "cols": [("state", S), ("hospitals", I), ("ed_median_min", D), ("ed_reporting", I), ("overall_star_avg", D), ("rated", I),
                 ("five_star", I), ("hac_payment_cut", I), ("hac_scored", I)],
    },
    "maternity_hospitals": {
        "desc": "Hospitals that deliver babies, have a NICU, or stopped delivering (CMS SM-7, Provider of Services, HCRIS; curated NICU levels).",
        "cols": [("ccn", S), ("name", S), ("city", S), ("state", S), ("latitude", D), ("longitude", D), ("address", S), ("zip", S),
                 ("location_precision", S), ("hospital_type", S), ("emergency_dept", I), ("phone", S), ("delivers_code", I),
                 ("delivers_babies", I), ("delivers_label", S), ("birthing_friendly", I), ("nicu_in_provider_file", I),
                 ("nicu_in_cost_report", I), ("nicu_any", I), ("nicu_beds", I), ("nicu_level", S), ("nicu_level_source", S),
                 ("nicu_level_url", S), ("nicu_level_note", S), ("stopped_delivering", I)],
    },
    "maternity_tracts": {
        "desc": "Census tracts (2020 centres of population): women aged 15-44 and estimated drive to the nearest delivering hospital / NICU.",
        "cols": [("tract_geoid", S), ("state", S), ("latitude", D), ("longitude", D), ("women_15_44", I), ("miles_to_delivery", D),
                 ("est_minutes_to_delivery", D), ("miles_to_nicu", D), ("est_minutes_to_nicu", D), ("delivery_band", S)],
    },
    "state_maternity": {
        "desc": "State summaries of maternity care access.",
        "cols": [("state", S), ("women_15_44", I), ("women_over_30_min", I), ("women_over_60_min", I), ("women_nicu_over_60_min", I),
                 ("delivering_hospitals", I), ("nicu_hospitals", I), ("stopped_delivering", I)],
    },
}
RELATIONSHIPS = [
    ("hospital_outcomes", "state", "state_outcomes", "state"),
    ("maternity_hospitals", "state", "state_maternity", "state"),
    ("maternity_tracts", "state", "state_maternity", "state"),
    ("maternity_hospitals", "ccn", "hospital_outcomes", "ccn"),
]
MEASURES = {
    "hospital_outcomes": [
        ("Hospitals rated", "COUNT(hospital_outcomes[overall_star])", "#,0"),
        ("Avg overall star rating", "AVERAGE(hospital_outcomes[overall_star])", "0.00"),
        ("Hospitals 4-5 stars %", "DIVIDE(CALCULATE([Hospitals rated], hospital_outcomes[overall_star] >= 4), [Hospitals rated])", "0.0%"),
        ("Median ED minutes", "MEDIAN(hospital_outcomes[ed_median_min])", "#,0"),
        ("HAC payment cuts", "SUM(hospital_outcomes[hac_payment_cut])", "#,0"),
        ("HAC payment cut %", "DIVIDE([HAC payment cuts], COUNT(hospital_outcomes[hac_payment_cut]))", "0.0%"),
        ("Hospitals worse on mortality", "CALCULATE(COUNTROWS(hospital_outcomes), hospital_outcomes[mort_worse] > 0)", "#,0"),
    ],
    "maternity_tracts": [
        ("Women 15-44", "SUM(maternity_tracts[women_15_44])", "#,0"),
        ("Women over 30 min from delivery", "CALCULATE([Women 15-44], maternity_tracts[est_minutes_to_delivery] > 30)", "#,0"),
        ("Women over 60 min from delivery", "CALCULATE([Women 15-44], maternity_tracts[est_minutes_to_delivery] > 60)", "#,0"),
        ("Share over 30 min from delivery", "DIVIDE([Women over 30 min from delivery], [Women 15-44])", "0.0%"),
        ("Share over 60 min from delivery", "DIVIDE([Women over 60 min from delivery], [Women 15-44])", "0.0%"),
        ("Women over 60 min from NICU", "CALCULATE([Women 15-44], maternity_tracts[est_minutes_to_nicu] > 60)", "#,0"),
    ],
    "maternity_hospitals": [
        ("Delivering hospitals", "CALCULATE(COUNTROWS(maternity_hospitals), maternity_hospitals[delivers_babies] = 1)", "#,0"),
        ("Hospitals with NICU", "CALCULATE(COUNTROWS(maternity_hospitals), maternity_hospitals[nicu_any] = 1)", "#,0"),
        ("Stopped delivering", "SUM(maternity_hospitals[stopped_delivering])", "#,0"),
    ],
}
ARROW = {S: pa.string(), I: pa.int64(), D: pa.float64(), T: pa.date32()}
TMDL_TYPE = {S: "string", I: "int64", D: "double", T: "dateTime"}


def core_tables():
    """The core tables, with each column's safe (lakehouse) name, the semantic model name and type."""
    from build_core_tables import MODEL_TABLE, column_names

    types = {"facility_id": S, "facility_name": S, "city": S, "state": S, "start_date": T, "end_date": T, "report_year": I}
    desc = {"hai": "CMS Healthcare-Associated Infections (CDC NHSN): SIR, observed and predicted cases, confidence limits and exposure, one row per hospital per report year.",
            "hcahps": "CMS HCAHPS patient survey: summary star rating and linear mean scores, one row per hospital per report year.",
            "psi90": "CMS PSI-90 patient safety composite and component rates, one row per hospital per report year."}
    return {t: {"desc": desc[t], "model": MODEL_TABLE[t], "cols": [(c, types.get(c, D)) for c, _ in column_names(t)],
                "names": dict(column_names(t))} for t in ("hai", "hcahps", "psi90")}


SETS = {
    "core": {"dir": os.path.join(ROOT, "data", "core"), "lakehouse": "lh_cms_core", "model": "CMS", "tables": core_tables, "relationships": [], "measures": {},
             "lh_desc": "CMS hospital quality core tables: infections (HAI), patient survey (HCAHPS) and PSI-90, from CMS's public archive.",
             "model_desc": "CMS hospital quality: infections, patient experience and PSI-90 by hospital and report year (public CMS data).",
             "check": 'EVALUATE ROW("hai", COUNTROWS(HAI), "hcahps", COUNTROWS(HCAHPS), "psi90", COUNTROWS(PSI90), "latest", MAX(HAI[REPORTYEAR]))'},
    "v2": {"dir": os.path.join(ROOT, "data", "fabric"), "lakehouse": "lh_cms_v2", "model": "CMS V2", "tables": lambda: TABLES, "relationships": RELATIONSHIPS,
           "measures": MEASURES,
           "lh_desc": "CMS dashboard V2: outcomes, ED timeliness, penalties and maternity care access (public CMS + Census data).",
           "model_desc": "CMS dashboard V2: outcomes, ED times, penalties and maternity care access.",
           "check": 'EVALUATE ROW("women", [Women 15-44], "over30", [Women over 30 min from delivery], "share30", [Share over 30 min from delivery], '
                    '"delivering", [Delivering hospitals], "nicu", [Hospitals with NICU], "hacCut", [HAC payment cuts], "edMedian", [Median ED minutes])'},
}


def q(name):
    """A TMDL object name, quoted when it isn't a plain identifier."""
    return name if name.replace("_", "").isalnum() else "'" + name.replace("'", "''") + "'"


def token(resource):
    return subprocess.check_output(["az", "account", "get-access-token", "--resource", resource, "--query", "accessToken", "-o", "tsv"], text=True).strip()


def call(method, url, tok, body=None, raw=None, headers=None, ok=(200, 201, 202)):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    h = {"Authorization": f"Bearer {tok}"}
    if body is not None:
        h["Content-Type"] = "application/json"
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            text = r.read().decode() if r.status != 204 else ""
            return r.status, dict(r.headers), (json.loads(text) if text.strip().startswith(("{", "[")) else text)
    except urllib.error.HTTPError as e:
        msg = e.read().decode()
        if e.code in ok:
            return e.code, dict(e.headers), msg
        raise SystemExit(f"{method} {url} -> {e.code}: {msg[:800]}")


def wait_lro(headers, tok, what):
    loc = headers.get("Location") or headers.get("location")
    if not loc:
        return None
    for _ in range(120):
        time.sleep(int(headers.get("Retry-After", 3) or 3))
        st, h, body = call("GET", loc, tok)
        state = body.get("status") if isinstance(body, dict) else None
        if state in ("Succeeded", "Completed") or st == 200 and state is None:
            if state == "Succeeded" and (h.get("Location") or h.get("location")):
                try:
                    return call("GET", h.get("Location") or h.get("location"), tok)[2]
                except SystemExit:
                    return body
            return body
        if state in ("Failed", "Cancelled"):
            raise SystemExit(f"{what} failed: {json.dumps(body)[:800]}")
    raise SystemExit(f"{what} timed out")


def ensure_lakehouse(tok, name, desc):
    _, _, items = call("GET", f"{FABRIC_API}/workspaces/{WORKSPACE_ID}/lakehouses", tok)
    lh = next((x for x in items.get("value", []) if x["displayName"] == name), None)
    if not lh:
        print(f"creating lakehouse {name} …")
        st, h, lh = call("POST", f"{FABRIC_API}/workspaces/{WORKSPACE_ID}/lakehouses", tok, {"displayName": name, "description": desc})
        if st == 202:
            lh = wait_lro(h, tok, "create lakehouse")
    for _ in range(60):
        _, _, lh = call("GET", f"{FABRIC_API}/workspaces/{WORKSPACE_ID}/lakehouses/{lh['id']}", tok)
        sql = (lh.get("properties") or {}).get("sqlEndpointProperties") or {}
        if sql.get("provisioningStatus") == "Success" and sql.get("connectionString"):
            return lh
        time.sleep(5)
    raise SystemExit("lakehouse SQL endpoint not ready")


def upload(lh_id, folder, name, data, stok):
    path = f"{ONELAKE}/{WORKSPACE_ID}/{lh_id}/Files/{folder}/{name}"
    call("PUT", f"{path}?resource=file", stok, raw=b"", headers={"Content-Length": "0"}, ok=(201,))
    call("PATCH", f"{path}?action=append&position=0", stok, raw=data, headers={"Content-Type": "application/octet-stream"}, ok=(202,))
    call("PATCH", f"{path}?action=flush&position={len(data)}", stok, raw=b"", headers={"Content-Length": "0"}, ok=(200,))


def to_parquet(folder, table, spec):
    cols = spec["cols"]
    path = os.path.join(folder, f"{table}.csv")
    if not os.path.exists(path):
        raise SystemExit(f"Missing {os.path.relpath(path, ROOT)}; build it first (see AGENTS.md).")
    t = pcsv.read_csv(path,
                      convert_options=pcsv.ConvertOptions(column_types={c: ARROW[k] for c, k in cols}, strings_can_be_null=False,
                                                          null_values=[""], include_columns=[c for c, _ in cols]))
    buf = io.BytesIO()
    pq.write_table(t, buf, compression="snappy")
    return buf.getvalue(), t.num_rows


def tmdl(lh, cfg, tables):
    sql = lh["properties"]["sqlEndpointProperties"]
    tag = lambda *parts: str(uuid.uuid5(uuid.NAMESPACE_URL, f"{cfg['lakehouse']}/" + "/".join(parts)))
    shown = lambda t: tables[t].get("model", t)
    parts = {
        "definition.pbism": json.dumps({"version": "4.0", "settings": {}}),
        "definition/database.tmdl": "database\n\tcompatibilityLevel: 1604\n",
        "definition/expressions.tmdl": (
            "expression DatabaseQuery =\n\t\tlet\n"
            f"\t\t    database = Sql.Database(\"{sql['connectionString']}\", \"{sql['id']}\")\n"
            "\t\tin\n\t\t    database\n"
            f"\tlineageTag: {tag('expr')}\n\n\tannotation PBI_IncludeFutureArtifacts = False\n"),
    }
    model = ["model Model", "\tculture: en-US", "\tdefaultPowerBIDataSourceVersion: powerBI_V3", "\tsourceQueryCulture: en-US",
             "\tdataAccessOptions", "\t\tlegacyRedirects", "\t\treturnErrorValuesAsNull", ""]
    model += [f"ref table {q(shown(t))}" for t in tables] + [""]
    parts["definition/model.tmdl"] = "\n".join(model)
    for t, spec in tables.items():
        names = spec.get("names", {})
        lines = [f"/// {spec['desc']}", f"table {q(shown(t))}", f"\tlineageTag: {tag(t)}", f"\tsourceLineageTag: [dbo].[{t}]", ""]
        for name, expr, fmt in cfg["measures"].get(t, []):
            lines += [f"\tmeasure '{name}' = {expr}", f"\t\tformatString: {fmt}", f"\t\tlineageTag: {tag(t, 'm', name)}", ""]
        for c, k in spec["cols"]:
            numeric_id = c in ("latitude", "longitude") or c.startswith(("hrrp_err", "mort_rate", "readm_rate")) or k == S
            plain_sum = not names and not numeric_id and c not in ("overall_star", "delivers_code", "emergency_dept")
            lines += [f"\tcolumn {q(names.get(c, c))}", f"\t\tdataType: {TMDL_TYPE[k]}", f"\t\tlineageTag: {tag(t, c)}", f"\t\tsourceLineageTag: {c}",
                      f"\t\tsummarizeBy: {'sum' if plain_sum else 'none'}",
                      f"\t\tsourceColumn: {c}", ""]
            if c in ("latitude", "longitude"):
                lines.insert(len(lines) - 1, f"\t\tdataCategory: {'Latitude' if c == 'latitude' else 'Longitude'}")
        lines += [f"\tpartition {q(shown(t))} = entity", "\t\tmode: directLake", "\t\tsource", f"\t\t\tentityName: {t}", "\t\t\tschemaName: dbo",
                  "\t\t\texpressionSource: DatabaseQuery", ""]
        parts[f"definition/tables/{t}.tmdl"] = "\n".join(lines)
    rel = []
    for ft, fc, tt, tc in cfg["relationships"]:
        rel += [f"relationship {tag('rel', ft, fc, tt)}", f"\tfromColumn: {ft}.{fc}", f"\ttoColumn: {tt}.{tc}", ""]
    parts["definition/relationships.tmdl"] = "\n".join(rel)
    return {"parts": [{"path": p, "payload": base64.b64encode(v.encode()).decode(), "payloadType": "InlineBase64"} for p, v in parts.items()]}


def publish(name):
    cfg = SETS[name]
    tables = cfg["tables"]()
    ftok, stok = token("https://api.fabric.microsoft.com"), token("https://storage.azure.com")
    lh = ensure_lakehouse(ftok, cfg["lakehouse"], cfg["lh_desc"])
    print(f"lakehouse {cfg['lakehouse']}: {lh['id']}")
    for t, spec in tables.items():
        data, n = to_parquet(cfg["dir"], t, spec)
        upload(lh["id"], cfg["lakehouse"], f"{t}.parquet", data, stok)
        st, h, _ = call("POST", f"{FABRIC_API}/workspaces/{WORKSPACE_ID}/lakehouses/{lh['id']}/tables/{t}/load", ftok,
                        {"relativePath": f"Files/{cfg['lakehouse']}/{t}.parquet", "pathType": "File", "mode": "Overwrite", "formatOptions": {"format": "Parquet"}})
        if st == 202:
            wait_lro(h, ftok, f"load {t}")
        print(f"  table {t}: {n:,} rows")

    definition = tmdl(lh, cfg, tables)
    model = cfg["model"]
    _, _, models = call("GET", f"{FABRIC_API}/workspaces/{WORKSPACE_ID}/semanticModels", ftok)
    sm = next((x for x in models.get("value", []) if x["displayName"] == model), None)
    if sm:
        print(f"updating semantic model {model} …")
        st, h, _ = call("POST", f"{FABRIC_API}/workspaces/{WORKSPACE_ID}/semanticModels/{sm['id']}/updateDefinition", ftok, {"definition": definition})
        if st == 202:
            wait_lro(h, ftok, "update model")
    else:
        print(f"creating semantic model {model} …")
        st, h, sm = call("POST", f"{FABRIC_API}/workspaces/{WORKSPACE_ID}/semanticModels", ftok,
                         {"displayName": model, "description": cfg["model_desc"], "definition": definition})
        if st == 202:
            wait_lro(h, ftok, "create model")
        _, _, models = call("GET", f"{FABRIC_API}/workspaces/{WORKSPACE_ID}/semanticModels", ftok)
        sm = next(x for x in models["value"] if x["displayName"] == model)
    print(f"semantic model {model}: {sm['id']}")

    ptok = token("https://analysis.windows.net/powerbi/api")
    call("POST", f"{PBI_API}/groups/{WORKSPACE_ID}/datasets/{sm['id']}/refreshes", ptok, {"type": "full"})
    for _ in range(60):
        time.sleep(5)
        _, _, r = call("GET", f"{PBI_API}/groups/{WORKSPACE_ID}/datasets/{sm['id']}/refreshes?$top=1", ptok)
        last = r["value"][0]
        if last["status"] in ("Completed", "Failed", "Disabled", "Cancelled"):
            print(f"refresh: {last['status']}" + (f" · {last.get('serviceExceptionJson', '')[:400]}" if last["status"] != "Completed" else ""))
            break
    _, _, res = call("POST", f"{PBI_API}/groups/{WORKSPACE_ID}/datasets/{sm['id']}/executeQueries", ptok, {"queries": [{"query": cfg["check"]}]})
    print("check:", json.dumps(res["results"][0]["tables"][0]["rows"][0]))
    return sm["id"]


def main():
    global WORKSPACE_ID
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--workspace", default=os.environ.get("FABRIC_WORKSPACE_ID"), help="Fabric workspace ID (or FABRIC_WORKSPACE_ID)")
    ap.add_argument("--core", action="store_true", help="publish only the core tables and the CMS model")
    ap.add_argument("--v2", action="store_true", help="publish only the outcomes / maternity tables and the CMS V2 model")
    ap.add_argument("--print-tmdl", metavar="SET", choices=sorted(SETS), help="print the generated model definition (no Azure calls) and exit")
    args = ap.parse_args()
    if args.print_tmdl:
        fake = {"id": "00000000-0000-0000-0000-000000000000", "properties": {"sqlEndpointProperties": {"connectionString": "<sql-endpoint>", "id": "<sql-endpoint-id>"}}}
        cfg = SETS[args.print_tmdl]
        for part in tmdl(fake, cfg, cfg["tables"]())["parts"]:
            print(f"--- {part['path']}\n{base64.b64decode(part['payload']).decode()}")
        return
    if not args.workspace:
        sys.exit("Pass --workspace <workspace-guid> or set FABRIC_WORKSPACE_ID.")
    WORKSPACE_ID = args.workspace
    sets = [n for n, on in (("core", args.core), ("v2", args.v2)) if on] or ["core", "v2"]
    ids = {n: publish(n) for n in sets}
    if "core" in ids:
        print(f"\nNext: python3 refresh_data.py --workspace {WORKSPACE_ID} --model {ids['core']}")


if __name__ == "__main__":
    main()
