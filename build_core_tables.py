#!/usr/bin/env python3
"""Build the three core tables behind the infection, patient-experience and PSI-90 charts from CMS's public archive.

    python3 build_core_tables.py            # downloads what's missing into data/raw/cms_archive/, writes data/core/*.csv
    python3 build_core_tables.py --refresh  # re-downloads the CMS files first

Writes one row per hospital per report year:
  data/core/hai.csv     Healthcare-Associated Infections (CDC NHSN via CMS Care Compare): SIR, observed and predicted cases,
                        confidence limits and exposure for six infections
  data/core/hcahps.csv  HCAHPS patient survey: summary star rating and ten linear mean scores
  data/core/psi90.csv   CMS PSI-90 patient safety composite and its component rates

These are the tables that refresh_data.py reads, either straight from these files (--local) or from a Power BI semantic
model built on them (publish_fabric.py --core loads them into a Fabric lakehouse and a Direct Lake model named "CMS").

Source: CMS Provider Data Catalog, hospitals theme archive (https://data.cms.gov/provider-data/archived-data/hospitals).
Only the needed CSV is read out of each snapshot zip, with HTTP range requests. A report year is the year a measurement
period ends; SNAPSHOTS in cms_archive.py pins the snapshot used for each table and year. To add a newer year, list them with
  https://data.cms.gov/provider-data/api/1/archive/aggregate/theme/hospitals/relative
and add the snapshot that carries the new period to SNAPSHOTS in cms_archive.py (the latest one picks up CMS corrections).
"""
import csv
import io
import os
import shutil
import sys
import zipfile

from cms_archive import SNAPSHOTS, HttpRangeFile, snapshot_url

ROOT = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(ROOT, "data", "raw", "cms_archive")
OUT = os.path.join(ROOT, "data", "core")
FILES = {
    "hai": ("Healthcare_Associated_Infections-Hospital.csv", "77hc-ibv8.csv"),
    "hcahps": ("HCAHPS-Hospital.csv", "dgck-syfz.csv"),
    "psi90": ("CMS_PSI_6_decimal_file.csv",),
}

# Column names: the safe name in the CSV (and the lakehouse) and the name the semantic model gives it, which is what
# refresh_data.py queries. The model names follow CMS's "<Measure ID>-<Measure name>" headings.
IDENT = [("facility_id", "facility id"), ("facility_name", "facility name"), ("city", "CITY"), ("state", "STATE"),
         ("start_date", "start date"), ("end_date", "end date"), ("report_year", "REPORTYEAR")]
HAI_NAME = {
    1: "Central Line Associated Bloodstream Infection (ICU + select Wards)",
    2: "Catheter Associated Urinary Tract Infections (ICU + select Wards)",
    3: "SSI - Colon Surgery",
    4: "SSI - Abdominal Hysterectomy",
    5: "MRSA Bacteremia",
    6: "Clostridium Difficile (C.Diff)",
}
HAI_EXPOSURE = {
    1: "Central Line Associated Bloodstream Infection: Number of Device Days",
    2: "Catheter Associated Urinary Tract Infections (ICU + select Wards): Number of Urinary Catheter Days",
    3: "SSI - Colon Surgery: Number of Procedures",
    4: "SSI - Abdominal Hysterectomy: Number of Procedures",
    5: "MRSA Bacteremia: Patient Days",
    6: "Clostridium Difficile (C.Diff): Patient Days",
}
HAI_COLS = []
for _i in range(1, 7):
    HAI_COLS += [
        (f"hai_{_i}_sir", f"HAI_{_i}_SIR-{HAI_NAME[_i]}", f"HAI_{_i}_SIR"),
        (f"hai_{_i}_eligcases", f"HAI_{_i}_ELIGCASES-{HAI_NAME[_i]}: Predicted Cases", f"HAI_{_i}_ELIGCASES"),
        (f"hai_{_i}_numerator", f"HAI_{_i}_NUMERATOR-{HAI_NAME[_i]}: Observed Cases", f"HAI_{_i}_NUMERATOR"),
        (f"hai_{_i}_cilower", f"HAI_{_i}_CILOWER-{HAI_NAME[_i]}: Lower Confidence Limit", f"HAI_{_i}_CILOWER"),
        (f"hai_{_i}_ciupper", f"HAI_{_i}_CIUPPER-{HAI_NAME[_i]}: Upper Confidence Limit", f"HAI_{_i}_CIUPPER"),
        (f"hai_{_i}_dopc", f"HAI_{_i}_DOPC-{HAI_EXPOSURE[_i]}", f"HAI_{_i}_DOPC"),
    ]
HCAHPS_COLS = [("h_star_rating", "H_STAR_RATING-Summary star rating", "H_STAR_RATING")] + [
    (mid.lower(), f"{mid}-{label} - linear mean score", mid) for mid, label in (
        ("H_CLEAN_LINEAR_SCORE", "Cleanliness"),
        ("H_COMP_1_LINEAR_SCORE", "Nurse communication"),
        ("H_COMP_2_LINEAR_SCORE", "Doctor communication"),
        ("H_COMP_3_LINEAR_SCORE", "Staff responsiveness"),
        ("H_COMP_5_LINEAR_SCORE", "Communication about medicines"),
        ("H_COMP_6_LINEAR_SCORE", "Discharge information"),
        ("H_COMP_7_LINEAR_SCORE", "Care transition"),
        ("H_HSP_RATING_LINEAR_SCORE", "Overall hospital rating"),
        ("H_QUIET_LINEAR_SCORE", "Quietness"),
        ("H_RECMND_LINEAR_SCORE", "Recommend hospital"),
    )]
# PSI columns are keyed by CMS's measure name (names changed over the years, so a renamed measure is a new column)
PSI_COLS = [(key, name, name.lower()) for key, name in (
    ("psi_90", "CMS Medicare PSI 90: Patient safety and adverse events composite"),
    ("psi_puncture", "Abdominopelvic accidental puncture or laceration rate"),
    ("psi_pneumo", "Iatrogenic pneumothorax rate"),
    ("psi_hipfx", "In-hospital fall with hip fracture rate"),
    ("psi_fallfx", "In-hospital fall-associated fracture rate"),
    ("psi_periop_hem", "Perioperative hemorrhage or hematoma rate"),
    ("psi_pe_dvt", "Perioperative pulmonary embolism or deep vein thrombosis rate"),
    ("psi_aki", "Postoperative acute kidney injury requiring dialysis rate"),
    ("psi_postop_hem", "Postoperative hemorrhage or hematoma rate"),
    ("psi_resp", "Postoperative respiratory failure rate"),
    ("psi_sepsis", "Postoperative sepsis rate"),
    ("psi_dehisc", "Postoperative wound dehiscence rate"),
    ("psi_ulcer", "Pressure ulcer rate"),
)]
TABLES = {"hai": HAI_COLS, "hcahps": HCAHPS_COLS, "psi90": PSI_COLS}
# The semantic model's table names
MODEL_TABLE = {"hai": "HAI", "hcahps": "HCAHPS", "psi90": "PSI90"}


def column_names(table):
    """[(csv/lakehouse name, semantic model name)] for a table, identity columns first."""
    return IDENT + [(c, m) for c, m, _ in TABLES[table]]


def fetch(table, snapshot, refresh):
    """Copy one table's CSV out of a CMS snapshot zip into data/raw/cms_archive/ (once)."""
    os.makedirs(RAW, exist_ok=True)
    path = os.path.join(RAW, f"hospitals_{snapshot}__{FILES[table][0]}")
    if os.path.exists(path) and not refresh:
        return path
    url = snapshot_url(snapshot)
    print(f"  reading {FILES[table][0]} from {url}", flush=True)
    archive = zipfile.ZipFile(io.BufferedReader(HttpRangeFile(url), buffer_size=1 << 20))
    member = next((n for n in archive.namelist() if n.endswith(FILES[table])), None)
    if not member:
        sys.exit(f"{url} has no {FILES[table][0]}")
    with archive.open(member) as src, open(path + ".part", "wb") as dst:
        shutil.copyfileobj(src, dst, 1 << 20)
    os.replace(path + ".part", path)
    return path


def number(v):
    try:
        return float(v)
    except (TypeError, ValueError):  # "Not Available", "Not Applicable", "N/A", blank
        return None


def iso(d):
    """CMS dates are MM/DD/YYYY."""
    if not d or d.count("/") != 2:
        return ""
    m, day, y = d.split("/")
    return f"{y}-{int(m):02d}-{int(day):02d}"


def pick(row, *names):
    for n in names:
        if n in row and row[n] is not None:
            return row[n]
    return ""


def read(table, path, year):
    """Pivot a long CMS file (one row per hospital and measure) to one row per hospital."""
    cols = TABLES[table]
    by_measure = {}
    for safe, _model, source in cols:
        by_measure.setdefault(source, []).append(safe)
    rows = {}
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for r in csv.DictReader(fh):
            if table == "psi90":
                key, value = r["Measure Name"].strip().lower(), r.get("Rate")
            elif table == "hcahps":
                key = r["HCAHPS Measure ID"]
                value = r["Patient Survey Star Rating"] if key == "H_STAR_RATING" else r["HCAHPS Linear Mean Value"]
            else:
                key, value = r["Measure ID"], r["Score"]
            targets = by_measure.get(key)
            if not targets:
                continue
            fid = r["Facility ID"].strip()
            out = rows.get(fid)
            if out is None:
                out = rows[fid] = {"facility_id": fid, "facility_name": r["Facility Name"].strip(), "city": pick(r, "City/Town", "City").strip(),
                                   "state": r["State"].strip(), "start_date": "", "end_date": "", "report_year": year}
            start, end = iso(pick(r, "Start Date", "Measure Start Date")), iso(pick(r, "End Date", "Measure End Date"))
            if start and (not out["start_date"] or start < out["start_date"]):
                out["start_date"] = start
            if end and end > out["end_date"]:
                out["end_date"] = end
            v = number(value)
            if v is not None:
                for safe in targets:
                    out[safe] = v
    measures = [c for c, _, _ in cols]
    # HCAHPS lists every hospital, including those with no survey results; keep only hospitals with at least one score
    keep = (lambda o: any(o.get(c) is not None for c in measures)) if table == "hcahps" else (lambda o: True)
    return [o for o in rows.values() if keep(o)]


def fmt(v):
    if v is None:
        return ""
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else repr(v)
    return str(v)


def main():
    refresh = "--refresh" in sys.argv
    os.makedirs(OUT, exist_ok=True)
    for table, years in SNAPSHOTS.items():
        print(f"{MODEL_TABLE[table]}:")
        rows = []
        for year, snapshot in sorted(years.items()):
            part = read(table, fetch(table, snapshot, refresh), year)
            print(f"  {year}: {len(part):,} hospitals (snapshot {snapshot})")
            rows += part
        names = [c for c, _ in column_names(table)]
        path = os.path.join(OUT, f"{table}.csv")
        with open(path, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(names)
            for o in rows:
                w.writerow([fmt(o.get(c)) for c in names])
        print(f"  wrote {os.path.relpath(path, ROOT)} ({len(rows):,} rows)")


if __name__ == "__main__":
    main()
