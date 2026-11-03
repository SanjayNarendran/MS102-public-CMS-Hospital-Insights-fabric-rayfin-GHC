#!/usr/bin/env python3
"""Download the public inputs the maternity map needs into data/raw/ (skips files already there).

    python3 download_inputs.py            # about 300 MB of downloads, about 1 GB on disk once the cost reports are unzipped
    python3 download_inputs.py --refresh  # download again

  Maternal_Health-Hospital.csv      CMS Maternal Health – Hospital (Provider Data Catalog nrdb-3fcy): SM-7, which hospitals
                                    provide inpatient labor and delivery care
  POS_Hospital_and_Other_Q2_2025.csv CMS Provider of Services file, hospitals, Q2 2025: obstetric and NICU service flags
  hcris2024/HOSP10_2024_*.csv       CMS hospital cost reports (HCRIS 2552-10), FY2024: NICU cost centres and beds
  CenPop2020_Mean_TR.txt            Census Bureau 2020 census tract centres of population
  acs2024_tract_women15_44.csv      Women aged 15–44 per census tract, ACS 2020–2024 5-year table B01001 (columns E030–E038),
                                    from the Census Bureau's table-based summary file

The other CMS files (hospital directory, outcomes, ED times, penalties) are downloaded by build_quality_extra.py.
"""
import csv
import io
import json
import os
import shutil
import sys
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(ROOT, "data", "raw")
UA = {}  # data.cms.gov rejects some custom user agents; the default works

MATERNAL_ID = "nrdb-3fcy"
META_API = "https://data.cms.gov/provider-data/api/1/metastore/schemas/dataset/items/{}?show-reference-ids=false"
POS_URL = "https://data.cms.gov/sites/default/files/2025-08/ab6b6f06-c7e6-49f1-a93d-c4564dfa394f/Hospital_and_Other_data_Q2_2025.csv"
HCRIS_URL = "https://downloads.cms.gov/FILES/HCRIS/HOSP10FY2024.ZIP"
CENPOP_URL = "https://www2.census.gov/geo/docs/reference/cenpop2020/tract/CenPop2020_Mean_TR.txt"
ACS_URL = "https://www2.census.gov/programs-surveys/acs/summary_file/2024/table-based-SF/data/5YRData/acsdt5y2024-b01001.dat"
ACS_WOMEN_15_44 = [f"B01001_E{n:03d}" for n in range(30, 39)]  # female 15–17, 18–19, 20, 21, 22–24, 25–29, 30–34, 35–39, 40–44


def fetch(url, path, refresh):
    if os.path.exists(path) and not refresh:
        print(f"  have {os.path.relpath(path, ROOT)}")
        return path
    print(f"  downloading {url}", flush=True)
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as src, open(path + ".part", "wb") as dst:
        shutil.copyfileobj(src, dst, 1 << 20)
    os.replace(path + ".part", path)
    return path


def maternal(refresh):
    meta = json.load(urllib.request.urlopen(urllib.request.Request(META_API.format(MATERNAL_ID), headers=UA), timeout=60))
    fetch(meta["distribution"][0]["data"]["downloadURL"], os.path.join(RAW, "Maternal_Health-Hospital.csv"), refresh)


def hcris(refresh):
    out = os.path.join(RAW, "hcris2024")
    names = [f"HOSP10_2024_{k}.csv" for k in ("rpt", "alpha", "nmrc")]
    if all(os.path.exists(os.path.join(out, n)) for n in names) and not refresh:
        print("  have data/raw/hcris2024/")
        return
    zpath = fetch(HCRIS_URL, os.path.join(RAW, "HOSP10FY2024.ZIP"), refresh)
    os.makedirs(out, exist_ok=True)
    with zipfile.ZipFile(zpath) as z:
        for n in names:
            member = next(m for m in z.namelist() if m.upper().endswith(n.upper()))
            with z.open(member) as src, open(os.path.join(out, n), "wb") as dst:
                shutil.copyfileobj(src, dst, 1 << 20)
    print("  unzipped data/raw/hcris2024/")


def acs(refresh):
    """Stream the ACS B01001 summary file (all geographies, ~200 MB) and keep tracts only."""
    path = os.path.join(RAW, "acs2024_tract_women15_44.csv")
    if os.path.exists(path) and not refresh:
        print(f"  have {os.path.relpath(path, ROOT)}")
        return
    print(f"  streaming {ACS_URL} (tracts only)", flush=True)
    n = 0
    with urllib.request.urlopen(urllib.request.Request(ACS_URL, headers=UA), timeout=300) as src, open(path + ".part", "w", newline="") as dst:  # noqa: SIM115
        rows = csv.reader(io.TextIOWrapper(src, encoding="utf-8"), delimiter="|")
        header = next(rows)
        idx = [header.index(c) for c in ACS_WOMEN_15_44]
        w = csv.writer(dst, lineterminator="\n")
        w.writerow(["geoid", "women15_44"])
        for r in rows:
            if r[0].startswith("1400000US"):  # census tract summary level
                w.writerow([r[0][9:], sum(max(0, int(r[i] or 0)) for i in idx)])
                n += 1
    os.replace(path + ".part", path)
    print(f"  wrote {os.path.relpath(path, ROOT)} ({n:,} tracts)")


def main():
    refresh = "--refresh" in sys.argv
    os.makedirs(RAW, exist_ok=True)
    print("Maternity inputs:")
    maternal(refresh)
    fetch(POS_URL, os.path.join(RAW, "POS_Hospital_and_Other_Q2_2025.csv"), refresh)
    hcris(refresh)
    fetch(CENPOP_URL, os.path.join(RAW, "CenPop2020_Mean_TR.txt"), refresh)
    acs(refresh)


if __name__ == "__main__":
    main()
