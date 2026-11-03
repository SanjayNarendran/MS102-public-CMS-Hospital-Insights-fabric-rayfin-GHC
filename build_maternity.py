#!/usr/bin/env python3
"""Maternity care access: which hospitals deliver babies, which have a NICU, and how far every U.S. ZIP code is from them
(writes assets/maternity.js and the drive-time grids assets/maternity-access.js).

    python3 build_maternity.py

Inputs (all public; downloaded into data/raw/ by build_quality_extra.py or the URLs below):
  * CMS Hospital General Information (xubh-q36u) – names, phone numbers, "birthing friendly" designation
  * CMS Maternal Health – Hospital (nrdb-3fcy) – SM_7 Maternal Morbidity Structural Measure. Every hospital that provides
    inpatient labour and delivery answers it; hospitals without L&D answer "Not Applicable (our hospital does not provide
    inpatient labor/delivery care)". This is the primary "delivers babies" signal.
  * CMS Provider of Services file, hospitals, Q2 2025 – OB_SRVC_CD (obstetric services) and NEONTL_ICU_SRVC_CD (neonatal
    intensive care) flags; used where a hospital has no SM_7 answer, and for NICU presence.
  * CMS hospital cost reports (HCRIS 2552-10), FY2024 – neonatal intensive care cost centres and their bed counts
    (Worksheet A lines 31–35 named NICU / neonatal ICU, beds from Worksheet S-3 Part I lines 8–12, column 2).
  * data/nicu_levels.csv (optional, curated) – published NICU levels with a source URL per row (e.g. Minnesota).
  * assets/hospital-locations.js – geocoded hospital locations (geocode_hospitals.py)
  * data/raw/CenPop2020_Mean_TR.txt – 2020 census tract centres of population (www2.census.gov/geo/docs/reference/cenpop2020/)
  * data/raw/acs2024_tract_women15_44.csv – women aged 15–44 per tract from the ACS 2020–2024 5-year table B01001
    (table-based summary file acsdt5y2024-b01001.dat; columns B01001_E030–E038)

Drive times for the national map are estimates from straight-line distance (see ROAD_FACTOR / speeds below); when
--calibrate is passed, a sample of routes is checked against the public OSRM router and the error is reported.
"""
import base64
import csv
import datetime as dt
import io
import json
import math
import os
import random
import re
import sys
import time
import urllib.request

import numpy as np

ROOT = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(ROOT, "data", "raw")
OUT = os.path.join(ROOT, "assets", "maternity.js")
LEVELS = os.path.join(ROOT, "data", "nicu_levels.csv")
POS_FILE = os.path.join(RAW, "POS_Hospital_and_Other_Q2_2025.csv")
POS_URL = "https://data.cms.gov/sites/default/files/2025-08/ab6b6f06-c7e6-49f1-a93d-c4564dfa394f/Hospital_and_Other_data_Q2_2025.csv"
HCRIS_DIR = os.path.join(RAW, "hcris2024")
HCRIS_URL = "https://downloads.cms.gov/FILES/HCRIS/HOSP10FY2024.ZIP"
WOMEN_TRACT = os.path.join(RAW, "acs2024_tract_women15_44.csv")
TRACT_CENTERS = os.path.join(RAW, "CenPop2020_Mean_TR.txt")
FIPS = {"01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC", "12": "FL", "13": "GA",
        "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD", "25": "MA",
        "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY",
        "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX",
        "49": "UT", "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY", "72": "PR"}

# Estimated drive time from straight-line miles; keep in sync with estMinutes() in assets/js/maternity.js
# Fitted to 160 OSRM routes between random ZIP centroids and nearby hospitals (data/raw/osrm_calibration.json)
ROAD_FACTOR = 1.33
LOCAL_MILES, LOCAL_MPH, OPEN_MPH = 4, 25, 45
CALIBRATION = os.path.join(RAW, "osrm_calibration.json")

NICU_NAME = re.compile(r"NEONAT|NICU|NEWBORN INTENSIVE|INTENSIVE CARE NURSERY|NEO-NATAL", re.I)
SM7_NONE = "Not Applicable"


def est_minutes(crow_miles):
    road = crow_miles * ROAD_FACTOR
    local = min(road, LOCAL_MILES)
    return local / LOCAL_MPH * 60 + max(0.0, road - LOCAL_MILES) / OPEN_MPH * 60


def read_js(path, var):
    text = open(path, encoding="utf-8").read()
    body = text[text.index(f"window.{var} = ") + len(f"window.{var} = "):].rstrip().rstrip(";")
    return json.loads(body)


def csv_rows(path, encoding="utf-8-sig"):
    with open(path, encoding=encoding, newline="") as f:
        yield from csv.DictReader(f)


def hcris_nicu():
    """CCN -> NICU beds (0 when a NICU cost centre exists but no beds are reported) from the latest FY2024 report."""
    rpt_ccn, rpt_end = {}, {}
    with open(os.path.join(HCRIS_DIR, "HOSP10_2024_rpt.csv"), newline="") as f:
        for row in csv.reader(f):
            rpt_ccn[row[0]] = row[2]
            m, d, y = row[6].split("/")
            rpt_end[row[0]] = f"{y}{m}{d}"
    s3_lines = {}
    with open(os.path.join(HCRIS_DIR, "HOSP10_2024_alpha.csv"), newline="") as f:
        for rpt, w, line, col, txt in csv.reader(f):
            if w == "A000000" and col == "00000" and NICU_NAME.search(txt) and "NEURO" not in txt.upper():
                a = int(line[:3])
                if 31 <= a <= 35:
                    # Worksheet A line 31.xx–35.xx (special care units) ↔ Worksheet S-3 Part I line 8.xx–12.xx
                    s3_lines.setdefault(rpt, set()).add(f"{a - 23:03d}{line[3:]}")
    beds = {}
    with open(os.path.join(HCRIS_DIR, "HOSP10_2024_nmrc.csv"), newline="") as f:
        for rpt, w, line, col, val in csv.reader(f):
            if w == "S300001" and col == "00200" and line in s3_lines.get(rpt, ()):
                beds[rpt] = beds.get(rpt, 0) + float(val)
    best = {}
    for rpt in s3_lines:
        ccn = rpt_ccn.get(rpt)
        if ccn and (ccn not in best or rpt_end[rpt] > rpt_end[best[ccn]]):
            best[ccn] = rpt
    return {ccn: int(round(beds.get(rpt, 0))) for ccn, rpt in best.items()}


def osrm_routes(pairs):
    """[straight-line miles, road miles, minutes] from the public OSRM router for (from_lat, from_lon, to_lat, to_lon, crow)."""
    out = []
    for la1, lo1, la2, lo2, crow in pairs:
        url = f"https://router.project-osrm.org/route/v1/driving/{lo1},{la1};{lo2},{la2}?overview=false"
        try:
            r = json.load(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "maternity-access-calibration"}), timeout=20))
            out.append([round(float(crow), 2), round(r["routes"][0]["distance"] / 1609.34, 2), round(r["routes"][0]["duration"] / 60, 2)])
        except Exception as e:  # noqa: BLE001 - calibration is best-effort
            print("  osrm:", e, file=sys.stderr)
        time.sleep(1)  # the public demo server allows about one request per second
    return out


# Drive-time surfaces for the map, one PNG per region in Web Mercator (rows evenly spaced in Mercator y, so MapLibre can
# place the image by its four corners). Pixels hold minutes, not colours: R = est. minutes to the nearest delivering
# hospital, G = to the nearest NICU (both capped at 254), B = 255 on U.S. land and 0 elsewhere. The browser colours them.
ACCESS_OUT = os.path.join(ROOT, "assets", "maternity-access.js")
RASTER_REGIONS = {
    "conus": ([-125.0, 24.3, -66.8, 49.5], 2000, None),
    "ak": ([-170.0, 51.2, -129.9, 71.5], 900, {"AK"}),
    "hi": ([-160.6, 18.8, -154.6, 22.4], 600, {"HI"}),
    "pr": ([-67.35, 17.85, -65.2, 18.6], 500, {"PR"}),
}


def merc_y(lat):
    return np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))


def access_rasters(deliver, nicus):
    from PIL import Image, ImageDraw
    from scipy.spatial import cKDTree

    shapes = read_js(os.path.join(ROOT, "assets", "state-shapes.js"), "CMS_STATE_SHAPES")["states"]["features"]

    def unit(lat, lon):
        la, lo = np.radians(lat), np.radians(lon)
        return np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], axis=-1)

    trees = [cKDTree(unit(np.array([h[4] for h in hs]), np.array([h[5] for h in hs]))) for hs in (deliver, nicus)]
    out, pngs = {}, {}
    for name, (bbox, width, only) in RASTER_REGIONS.items():
        w, s0, e, n = bbox
        y0, y1 = merc_y(n), merc_y(s0)
        height = int(round(width * (y0 - y1) / np.radians(e - w)))
        xs = w + (np.arange(width) + 0.5) / width * (e - w)
        ys = y0 - (np.arange(height) + 0.5) / height * (y0 - y1)
        lats = np.degrees(2 * np.arctan(np.exp(ys)) - np.pi / 2)
        LON, LAT = np.meshgrid(xs, lats)
        pts = unit(LAT.ravel(), LON.ravel())
        mask = Image.new("L", (width, height), 0)
        draw = ImageDraw.Draw(mask)
        px = lambda lon, lat: ((lon - w) / (e - w) * width, (y0 - merc_y(lat)) / (y0 - y1) * height)
        for f in shapes:
            if only and f["properties"]["code"] not in only:
                continue
            g = f["geometry"]
            for poly in (g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]):
                ring = poly[0]
                if not any(w - 1 <= x <= e + 1 and s0 - 1 <= y <= n + 1 for x, y in ring):
                    continue
                draw.polygon([px(x, y) for x, y in ring], fill=255)
                for hole in poly[1:]:
                    draw.polygon([px(x, y) for x, y in hole], fill=0)
        rgb = np.zeros((height, width, 3), dtype=np.uint8)
        for ch, tree in enumerate(trees):
            chord, _ = tree.query(pts, k=1)
            miles = 2 * 3958.8 * np.arcsin(np.clip(chord / 2, 0, 1))
            road = miles * ROAD_FACTOR
            mins = np.minimum(road, LOCAL_MILES) / LOCAL_MPH * 60 + np.maximum(0, road - LOCAL_MILES) / OPEN_MPH * 60
            rgb[..., ch] = np.minimum(np.round(mins), 254).reshape(height, width).astype(np.uint8)
        rgb[..., 2] = np.array(mask)
        buf = io.BytesIO()
        Image.fromarray(rgb, "RGB").save(buf, "PNG", optimize=True)
        pngs[name] = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
        out[name] = {"bounds": bbox, "size": [width, height]}
        print(f"  raster {name}: {width}×{height}, {len(buf.getvalue()) // 1024} KB", file=sys.stderr)
    # The PNGs travel inside a script as data URLs: a page opened straight from disk (file://) may read a script, but
    # Chrome blocks reading the pixels of a separate image file there, which the map needs
    with open(ACCESS_OUT, "w", encoding="utf-8") as f:
        f.write("// Generated by build_maternity.py. Drive-time grids as PNG data URLs: R = est. minutes to the nearest delivering hospital,\n"
                "// G = to the nearest NICU (capped at 254), B = 255 on U.S. land. Rows are evenly spaced in Web Mercator.\n")
        f.write("window.CMS_MATERNITY_ACCESS = ")
        json.dump(pngs, f, separators=(",", ":"))
        f.write(";\n")
    print(f"  wrote {ACCESS_OUT} ({os.path.getsize(ACCESS_OUT) // 1024} KB)", file=sys.stderr)
    return out


FABRIC = os.path.join(ROOT, "data", "fabric")
DELIVERS = {2: "Reports labor & delivery to CMS (SM-7)", 1: "Obstetric services listed (provider file)", 0: "No inpatient labor & delivery"}


def write_fabric_tables(hospitals, fields, tracts, ld_d, nicu_d, by_state, src_list):
    """Flat CSVs for the Fabric semantic model CMS V2 (publish_fabric.py)."""
    os.makedirs(FABRIC, exist_ok=True)
    with open(os.path.join(FABRIC, "maternity_hospitals.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["ccn", "name", "city", "state", "latitude", "longitude", "address", "zip", "location_precision", "hospital_type", "emergency_dept",
                    "phone", "delivers_code", "delivers_babies", "delivers_label", "birthing_friendly", "nicu_in_provider_file", "nicu_in_cost_report",
                    "nicu_any", "nicu_beds", "nicu_level", "nicu_level_source", "nicu_level_url", "nicu_level_note", "stopped_delivering"])
        for h in hospitals:
            o = dict(zip(fields, h))
            src = src_list[o["levelSrc"][0]] if o["levelSrc"] else ("", "")
            w.writerow([o["ccn"], o["name"], o["city"], o["st"], o["lat"], o["lon"], o["address"], o["zip"], o["precision"], o["type"],
                        "" if o["er"] is None else o["er"], o["phone"] or "", o["d"], 1 if o["d"] else 0, DELIVERS[o["d"]], o["bf"],
                        1 if o["nicu"] & 1 else 0, 1 if o["nicu"] & 2 else 0, 1 if o["nicu"] else 0, o["nicuBeds"] or "", o["level"] or "",
                        src[0], src[1], o["levelSrc"][1] if o["levelSrc"] else "", o["gone"]])
    with open(os.path.join(FABRIC, "maternity_tracts.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["tract_geoid", "state", "latitude", "longitude", "women_15_44", "miles_to_delivery", "est_minutes_to_delivery",
                    "miles_to_nicu", "est_minutes_to_nicu", "delivery_band"])
        for i, (geoid, la, lo, wn, sc) in enumerate(tracts):
            m = est_minutes(ld_d[i])
            band = "15 min or less" if m <= 15 else "15-30 min" if m <= 30 else "30-60 min" if m <= 60 else "Over 1 hour"
            w.writerow([geoid, sc, round(la, 5), round(lo, 5), wn, round(ld_d[i], 3), round(m, 3), round(nicu_d[i], 3), round(est_minutes(nicu_d[i]), 3), band])
    with open(os.path.join(FABRIC, "state_maternity.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["state", "women_15_44", "women_over_30_min", "women_over_60_min", "women_nicu_over_60_min", "delivering_hospitals", "nicu_hospitals", "stopped_delivering"])
        for sc, b in sorted(by_state.items()):
            w.writerow([sc, b["women"], b["w30"], b["w60"], b["nicu60"], b["deliver"], b["nicu"], b["gone"]])


def main():
    for path, url in ((POS_FILE, POS_URL), (os.path.join(HCRIS_DIR, "HOSP10_2024_rpt.csv"), HCRIS_URL)):
        if not os.path.exists(path):
            sys.exit(f"Missing {path}. Download {url} into data/raw/ (unzip the HCRIS archive into data/raw/hcris2024/).")

    gen = {r["Facility ID"]: r for r in csv_rows(os.path.join(RAW, "Hospital_General_Information.csv"))}
    sm7 = {r["Facility ID"]: r["Score"] for r in csv_rows(os.path.join(RAW, "Maternal_Health-Hospital.csv")) if r["Measure ID"] == "SM_7"}
    pos = {r["PRVDR_NUM"]: r for r in csv_rows(POS_FILE, "latin-1") if r["PRVDR_CTGRY_CD"] == "01" and r["PGM_TRMNTN_CD"] == "00"}
    nicu_beds = hcris_nicu()
    levels = {}
    if os.path.exists(LEVELS):
        for r in csv_rows(LEVELS):
            levels[r["ccn"].strip()] = r
    LOC = read_js(os.path.join(ROOT, "assets", "hospital-locations.js"), "CMS_LOCATIONS")
    loc = {}
    for ccn, r in LOC["rows"].items():
        loc[ccn] = {"lat": r[0], "lon": r[1], "address": r[2], "zip": r[3], "precision": r[4], "type": r[5], "er": r[6]}
    for ccn, r in LOC.get("extra", {}).items():
        loc[ccn] = {"lat": r[0], "lon": r[1], "address": r[2], "zip": r[3], "precision": r[4], "type": r[5], "er": r[6], "name": r[7], "city": r[8], "st": r[9]}

    # Who delivers babies. d: 2 = reports labour & delivery care to CMS (SM_7 answered), 1 = CMS provider file lists
    # obstetric services but no SM_7 answer, 0 = no inpatient labour & delivery (or no evidence of it)
    hospitals, stats = [], {"sm7": 0, "pos": 0, "attestNone": 0, "posButNone": 0}
    src_list = []
    for ccn in sorted(set(gen) | set(pos)):
        g, p, ans = gen.get(ccn), pos.get(ccn, {}), sm7.get(ccn, "")
        ob = p.get("OB_SRVC_CD") in ("1", "2", "3")
        gone = 0
        if ans in ("Yes", "No"):
            d = 2
            stats["sm7"] += 1
        elif ans.startswith(SM7_NONE):
            d = 0
            stats["attestNone"] += 1
            stats["posButNone"] += ob
            # Reports no inpatient labour & delivery for 2024 although the 2025 provider file still lists obstetric
            # services: in Minnesota these match known unit closures (New Prague, Cambridge, Park Rapids, Madison)
            gone = 1 if ob else 0
        elif ob:
            d = 1
            stats["pos"] += 1
        else:
            d = 0
        beds = nicu_beds.get(ccn)
        pos_nicu = p.get("NEONTL_ICU_SRVC_CD") in ("1", "2", "3")
        lv = levels.get(ccn)
        # A published Level I (well-newborn nursery only) overrides older CMS NICU flags
        nicu = 0 if lv and lv["level"].strip() == "I" else (1 if pos_nicu else 0) | (2 if beds is not None else 0) | (4 if lv else 0)
        if not d and not nicu and not lv and not gone:
            continue
        L = loc.get(ccn)
        if not L:
            continue
        name = (g["Facility Name"] if g else p.get("FAC_NAME", "")).strip()
        city = (g["City/Town"] if g else p.get("CITY_NAME", "")).strip()
        stc = (g["State"] if g else p.get("STATE_CD", "")).strip()
        lvl_src = None
        if lv:
            key = (lv["source"], lv["source_url"])
            if key not in src_list:
                src_list.append(key)
            lvl_src = [src_list.index(key), lv.get("note") or ""]
        hospitals.append([
            ccn, name, city, stc, round(L["lat"], 5), round(L["lon"], 5), L["address"], L["zip"], L["precision"], L["type"], L["er"],
            (g["Telephone Number"] if g else "") or None, d, 1 if g and g["Meets criteria for birthing friendly designation"] == "Y" else 0,
            nicu, beds if beds else None, lv["level"].strip() if lv else None, lvl_src, gone,
        ])
    fields = ["ccn", "name", "city", "st", "lat", "lon", "address", "zip", "precision", "type", "er", "phone", "d", "bf", "nicu", "nicuBeds", "level", "levelSrc", "gone"]
    deliver = [h for h in hospitals if h[12] > 0]
    nicus = [h for h in hospitals if h[14]]
    print(f"delivering hospitals: {len(deliver)} (SM_7 {stats['sm7']}, provider file only {stats['pos']}); "
          f"NICUs: {len(nicus)}; {stats['posButNone']} hospitals attest no L&D although the provider file lists OB", file=sys.stderr)

    # Where women live: Census 2020 tract centres of population, weighted by women aged 15–44 (ACS 2020–2024).
    # Population centres, not geographic centroids, so a large rural tract is measured from its town, not its empty middle.
    women = {r["geoid"]: int(r["women15_44"]) for r in csv_rows(WOMEN_TRACT)}
    # Connecticut's ACS tracts use the 2022 planning-region county codes while the 2020 population centres use the old
    # counties; the six-digit tract codes carry over, so match CT on those (splitting the two that repeat)
    ct = {}
    for g, w in women.items():
        if g.startswith("09"):
            ct.setdefault(g[5:], []).append(w)
    ct_old = {}
    for r in csv_rows(TRACT_CENTERS):
        if r["STATEFP"] == "09":
            ct_old[r["TRACTCE"]] = ct_old.get(r["TRACTCE"], 0) + 1
    tracts = []
    for r in csv_rows(TRACT_CENTERS):
        geoid = r["STATEFP"] + r["COUNTYFP"] + r["TRACTCE"]
        w = women.get(geoid, 0)
        if r["STATEFP"] == "09" and not w and r["TRACTCE"] in ct:
            w = round(sum(ct[r["TRACTCE"]]) / ct_old[r["TRACTCE"]])
        if w > 0 and r["STATEFP"] in FIPS:
            tracts.append((geoid, float(r["LATITUDE"]), float(r["LONGITUDE"]), w, FIPS[r["STATEFP"]]))
    tlat = np.radians([t[1] for t in tracts])
    tlon = np.radians([t[2] for t in tracts])

    def nearest(hs):
        hlat, hlon = np.radians([h[4] for h in hs]), np.radians([h[5] for h in hs])
        best_d = np.full(len(tracts), np.inf)
        best_i = np.zeros(len(tracts), dtype=int)
        for s0 in range(0, len(tracts), 2000):
            la, lo = tlat[s0:s0 + 2000, None], tlon[s0:s0 + 2000, None]
            h = np.sin((hlat - la) / 2) ** 2 + np.cos(la) * np.cos(hlat) * np.sin((hlon - lo) / 2) ** 2
            d = 2 * 3958.8 * np.arcsin(np.sqrt(h))
            best_i[s0:s0 + 2000] = d.argmin(axis=1)
            best_d[s0:s0 + 2000] = d.min(axis=1)
        return best_d, best_i

    ld_d, ld_i = nearest(deliver)
    nicu_d, _ = nearest(nicus)
    bands, by_state = {"30": 0, "60": 0, "all": 0, "nicu60": 0}, {}
    for i, (geoid, la, lo, w, sc) in enumerate(tracts):
        m, mn = est_minutes(ld_d[i]), est_minutes(nicu_d[i])
        bands["all"] += w
        bands["30"] += w if m > 30 else 0
        bands["60"] += w if m > 60 else 0
        bands["nicu60"] += w if mn > 60 else 0
        b = by_state.setdefault(sc, {"women": 0, "w30": 0, "w60": 0, "nicu60": 0, "deliver": 0, "nicu": 0, "gone": 0})
        b["women"] += w
        b["w30"] += w if m > 30 else 0
        b["w60"] += w if m > 60 else 0
        b["nicu60"] += w if mn > 60 else 0
    for h in hospitals:
        b = by_state.get(h[3])
        if b is not None:
            b["deliver"] += 1 if h[12] else 0
            b["nicu"] += 1 if h[14] else 0
            b["gone"] += h[18]
    print(f"women 15–44 beyond ~30 min of a delivering hospital: {bands['30']:,} of {bands['all']:,}; beyond ~60 min: {bands['60']:,}; "
          f"beyond ~60 min of a NICU: {bands['nicu60']:,}", file=sys.stderr)

    # Calibration: routes are (straight-line miles, road miles, OSRM minutes); --calibrate re-samples them from OSRM
    if "--calibrate" in sys.argv:
        random.seed(11)
        sample = random.sample(range(len(tracts)), 300)
        pairs = [(tracts[i][1], tracts[i][2], deliver[ld_i[i]][4], deliver[ld_i[i]][5], ld_d[i]) for i in sample if 1 < ld_d[i] < 150]
        json.dump(osrm_routes(pairs[:160]), open(CALIBRATION, "w"))
    calib = None
    if os.path.exists(CALIBRATION):
        routes = json.load(open(CALIBRATION))
        errs = sorted((est_minutes(c) - m) / m for c, _, m in routes)
        calib = {"n": len(errs), "medianAbsErr": round(float(np.median(np.abs(errs))), 3), "bias": round(float(np.median(errs)), 3),
                 "source": "OSRM (router.project-osrm.org, OpenStreetMap data)"}
        print("estimate vs OSRM routes:", calib, file=sys.stderr)

    write_fabric_tables(hospitals, fields, tracts, ld_d, nicu_d, by_state, src_list)
    rasters = access_rasters(deliver, nicus)

    meta = {
        "built": dt.date.today().isoformat(),
        "fields": fields,
        "levelSources": [{"name": n, "url": u} for n, u in src_list],
        "estimate": {"roadFactor": ROAD_FACTOR, "localMiles": LOCAL_MILES, "localMph": LOCAL_MPH, "openMph": OPEN_MPH, "calibration": calib},
        "rasters": rasters,
        "women": bands,
        "states": by_state,
        "counts": {"deliver": len(deliver), "deliverSm7": stats["sm7"], "deliverPos": stats["pos"], "attestNone": stats["attestNone"],
                   "posButNone": stats["posButNone"], "nicu": len(nicus), "nicuBeds": sum(1 for h in nicus if h[15]),
                   "levels": sum(1 for h in hospitals if h[16]), "gone": sum(h[18] for h in hospitals)},
        "sources": {
            "sm7": "CMS Care Compare · Maternal Health – Hospital (SM_7, CY2024)",
            "pos": "CMS Provider of Services file · hospitals, Q2 2025",
            "hcris": "CMS hospital cost reports (HCRIS 2552-10), FY2024",
            "acs": "U.S. Census Bureau · ACS 2020–2024 5-year, table B01001 (women aged 15–44), census tracts",
            "tracts": "U.S. Census Bureau · 2020 census tract centers of population",
        },
    }
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("// Generated by build_maternity.py from public CMS and Census data. Regenerate rather than edit by hand.\n")
        f.write("window.CMS_MATERNITY = ")
        json.dump({"meta": meta, "hospitals": hospitals}, f, separators=(",", ":"))
        f.write(";\n")
    print(f"wrote {OUT} ({os.path.getsize(OUT) // 1024} KB, {len(hospitals)} hospitals)", file=sys.stderr)


if __name__ == "__main__":
    main()
