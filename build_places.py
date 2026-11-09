#!/usr/bin/env python3
"""Build the hospital map's reference layers: place names (assets/places.js) and state outlines (assets/state-shapes.js,
plus the unchanged TopoJSON in assets/vendor/vega/us-states-10m.json for Ask your data's maps).

    python3 build_places.py

Place names: GeoNames "cities500" (every populated place with 500+ residents, plus seats of government) and
"admin2Codes" (county names), both CC BY 4.0, https://www.geonames.org/. Only the United States and its
territories are kept. Each row is  name|state|lat|lon|population|flag|county
  flag   c = state or national capital, x = a named section of a larger city (searchable, not labelled)
  county only where the same name occurs more than once in a state, to tell them apart in search results

State outlines: us-atlas 3 (ISC licence), the U.S. Census Bureau 1:10,000,000 cartographic boundaries as TopoJSON.
Written as each state's polygon (to outline the state you are viewing) plus the borders between states, drawn once.

Neither depends on the CMS data, so this only needs re-running to pick up GeoNames or Census corrections.
"""
import datetime as dt
import io
import json
import math
import os
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "assets", "places.js")
SHAPES_OUT = os.path.join(ROOT, "assets", "state-shapes.js")
TOPO_OUT = os.path.join(ROOT, "assets", "vendor", "vega", "us-states-10m.json")
US_ATLAS = "https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json"
FIPS = {
    "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC", "12": "FL",
    "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME",
    "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT", "31": "NE", "32": "NV", "33": "NH",
    "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI",
    "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI",
    "56": "WY", "60": "AS", "66": "GU", "69": "MP", "72": "PR", "78": "VI",
}
# GeoNames lists New York City's boroughs as places of their own; they are parts of the city, not cities
CITY_SECTIONS = {("Brooklyn", "NY"), ("Queens", "NY"), ("Manhattan", "NY"), ("The Bronx", "NY"), ("Bronx", "NY"), ("Staten Island", "NY")}
CITIES = "https://download.geonames.org/export/dump/cities500.zip"
ADMIN2 = "https://download.geonames.org/export/dump/admin2Codes.txt"
USER_AGENT = "CMS-Quality-Dashboard-places/1.0 (hospital map search)"
COUNTRIES = {"US", "PR", "GU", "VI", "AS", "MP"}
# Abandoned, historical and destroyed settlements are not places anyone searches from
SKIP_CODES = {"PPLQ", "PPLH", "PPLW", "PPLCH"}
SAME_PLACE_KM = 5


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(h))


def main():
    counties = {}
    for line in fetch(ADMIN2).decode("utf-8").splitlines():
        parts = line.split("\t")
        if len(parts) >= 2 and parts[0].split(".")[0] == "US":
            counties[parts[0]] = parts[1]

    with zipfile.ZipFile(io.BytesIO(fetch(CITIES))) as z:
        text = z.read("cities500.txt").decode("utf-8")

    places = []
    for line in text.splitlines():
        r = line.split("\t")
        cc, code = r[8], r[7]
        if cc not in COUNTRIES or code in SKIP_CODES:
            continue
        state = r[10] if cc == "US" else cc
        if cc == "US" and len(state) != 2:
            continue
        name = r[1].replace("|", " ").strip()
        places.append({
            "name": name, "st": state, "lat": float(r[4]), "lon": float(r[5]), "pop": int(r[14] or 0),
            "flag": "c" if code in ("PPLA", "PPLC") else "x" if code == "PPLX" or (name, state) in CITY_SECTIONS else "",
            "county": counties.get(f"US.{state}.{r[11]}", "") if cc == "US" else "",
        })

    # GeoNames occasionally lists one town twice; keep the larger entry
    places.sort(key=lambda p: -p["pop"])
    kept, by_key = [], {}
    for p in places:
        key = (p["name"].lower(), p["st"])
        if any(km((p["lat"], p["lon"]), (q["lat"], q["lon"])) < SAME_PLACE_KM for q in by_key.get(key, [])):
            continue
        by_key.setdefault(key, []).append(p)
        kept.append(p)

    rows = []
    for p in kept:
        repeated = len(by_key[(p["name"].lower(), p["st"])]) > 1
        rows.append("|".join([
            p["name"], p["st"], f"{p['lat']:.3f}", f"{p['lon']:.3f}", str(p["pop"]), p["flag"],
            p["county"] if repeated else "",
        ]).rstrip("|"))

    header = (
        f"/* Generated by build_places.py on {dt.date.today().isoformat()}; do not edit.\n"
        "   U.S. place names, locations and populations from GeoNames cities500 (CC BY 4.0, https://www.geonames.org/).\n"
        "   Rows: name|state|lat|lon|population|flag (c capital, x city section)|county (only where a name repeats in a state). */\n"
    )
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(header + "window.CMS_PLACES = " + json.dumps("\n".join(rows), ensure_ascii=False) + ";\n")

    states = len({p["st"] for p in kept})
    print(f"{len(rows):,} places in {states} states and territories -> {os.path.relpath(OUT, ROOT)} ({os.path.getsize(OUT) / 1024:,.0f} KB)")
    print(f"  {sum(p['pop'] >= 10000 for p in kept):,} with 10,000+ residents; {sum(1 for r in rows if r.count('|') == 6):,} carry a county to tell repeated names apart")
    build_state_shapes()


def build_state_shapes():
    raw = fetch(US_ATLAS)
    os.makedirs(os.path.dirname(TOPO_OUT), exist_ok=True)
    with open(TOPO_OUT, "wb") as f:
        f.write(raw)
    topo = json.loads(raw)
    (sx, sy), (tx, ty) = topo["transform"]["scale"], topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x, y = x + dx, y + dy
            pt = [round(x * sx + tx, 3), round(y * sy + ty, 3)]
            if not pts or pts[-1] != pt:
                pts.append(pt)
        arcs.append(pts)

    def ring(indexes):
        pts = []
        for i in indexes:
            a = arcs[i] if i >= 0 else arcs[~i][::-1]
            pts.extend(a if not pts else a[1:])
        return pts

    states, used_by = [], {}
    for g in topo["objects"]["states"]["geometries"]:
        code = FIPS.get(g["id"])
        if not code:
            continue
        polys = [g["arcs"]] if g["type"] == "Polygon" else g["arcs"]
        rings = [[ring(r) for r in poly] for poly in polys]
        rings = [[r for r in poly if len(r) >= 4] for poly in rings]
        rings = [poly for poly in rings if poly]
        states.append({"type": "Feature", "properties": {"code": code}, "geometry": {"type": "MultiPolygon", "coordinates": rings}})
        for poly in polys:
            for r in poly:
                for i in r:
                    used_by.setdefault(i if i >= 0 else ~i, set()).add(code)
    # An arc shared by two states is a border between them; coastlines come from the basemap
    borders = [arcs[i] for i, owners in sorted(used_by.items()) if len(owners) > 1 and len(arcs[i]) > 1]
    payload = {
        "states": {"type": "FeatureCollection", "features": states},
        "borders": {"type": "Feature", "properties": {}, "geometry": {"type": "MultiLineString", "coordinates": borders}},
    }
    header = (
        f"/* Generated by build_places.py on {dt.date.today().isoformat()}; do not edit.\n"
        "   State outlines from us-atlas 3 (ISC licence): U.S. Census Bureau 1:10,000,000 cartographic boundaries. */\n"
    )
    with open(SHAPES_OUT, "w", encoding="utf-8") as f:
        f.write(header + "window.CMS_STATE_SHAPES = " + json.dumps(payload, separators=(",", ":")) + ";\n")
    print(f"{len(states)} state outlines and {len(borders)} border lines -> {os.path.relpath(SHAPES_OUT, ROOT)} ({os.path.getsize(SHAPES_OUT) / 1024:,.0f} KB)")


if __name__ == "__main__":
    main()
