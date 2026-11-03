#!/usr/bin/env python3
"""Place every CMS hospital on the dashboard map (writes assets/hospital-locations.js and assets/zip-centroids.js).

Run after refresh_data.py whenever the hospital list changes:

    python3 geocode_hospitals.py

The map shows two groups:
  * rows  – the scored hospitals in assets/data.js (they have at least one published infection, star or PSI-90 score)
  * extra – every other hospital in CMS's Hospital General Information directory (critical access, children's,
            psychiatric, rural emergency, …), drawn as "no published score" so nearby options are never hidden

1. Addresses, hospital type and emergency services come from CMS's public Hospital General Information file
   (joined on CMS facility ID), read straight out of the CMS archive snapshots with HTTP range requests.
2. Street addresses are geocoded with the U.S. Census Bureau batch geocoder (public addresses only).
3. Unmatched addresses fall back to the Census ZIP Code Tabulation Area centroid, then to OpenStreetMap
   Nominatim for the few territories the Census files do not cover.

Results are cached in .geocode-cache.json so later runs only geocode new or changed addresses.
The same Census ZIP centroids are written to assets/zip-centroids.js so the dashboard can turn a ZIP code
into a location entirely in the browser.
"""
import csv
import datetime as dt
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import uuid
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "assets", "data.js")
OUT = os.path.join(ROOT, "assets", "hospital-locations.js")
ZIP_OUT = os.path.join(ROOT, "assets", "zip-centroids.js")
CACHE = os.path.join(ROOT, ".geocode-cache.json")

ARCHIVE = "https://data.cms.gov/provider-data/sites/default/files/dataset-archives/theme/hospitals/"
# Newest first; older snapshots only fill in hospitals that have since closed or changed ID.
SNAPSHOTS = ["hospitals_2026-02-25.zip", "hospitals_2025-11-26.zip", "hospitals_2024-10-30.zip"]
ADDRESS_FILES = ("Hospital_General_Information.csv", "xubh-q36u.csv", "Healthcare_Associated_Infections-Hospital.csv", "77hc-ibv8.csv")
GENERAL_FILES = ADDRESS_FILES[:2]
TYPE_CODES = {
    "Acute Care Hospitals": "a", "Critical Access Hospitals": "c", "Childrens": "k", "Psychiatric": "p",
    "Acute Care - Veterans Administration": "v", "Acute Care - Department of Defense": "d",
    "Rural Emergency Hospital": "r", "Long-term": "l",
}
TYPE_LABELS = {
    "a": "Acute care hospital", "c": "Critical access hospital", "k": "Children's hospital", "p": "Psychiatric hospital",
    "v": "VA medical center", "d": "Military hospital", "r": "Rural emergency hospital", "l": "Long-term care hospital",
}
CENSUS_BATCH = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch"
GAZETTEER = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_zcta_national.zip"
NOMINATIM = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "CMS-Quality-Dashboard-geocoder/1.0 (hospital map; public CMS addresses)"
BATCH_SIZE = 1000

# Precision codes stored with each hospital and explained in the dashboard
EXACT, INTERPOLATED, ZIP_CENTROID, PLACE = "a", "n", "z", "p"


class HttpRangeFile(io.RawIOBase):
    """Seekable read-only file over HTTP range requests, so zipfile can read one member without downloading the archive."""

    def __init__(self, url):
        self.url, self.pos = url, 0
        head = urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=60)
        self.size = int(head.headers["Content-Length"])

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        return self.pos

    def readinto(self, buf):
        if self.pos >= self.size:
            return 0
        end = min(self.size, self.pos + len(buf)) - 1
        req = urllib.request.Request(self.url, headers={"Range": f"bytes={self.pos}-{end}"})
        data = urllib.request.urlopen(req, timeout=120).read()
        buf[: len(data)] = data
        self.pos += len(data)
        return len(data)


def load_facilities():
    s = open(DATA, encoding="utf-8").read()
    d = json.loads(s[s.index("{"): s.rstrip().rindex(";")])
    fields = d["facilityFields"]
    return [dict(zip(fields, row)) for row in d["facilities"]]


def zip5(z):
    digits = "".join(ch for ch in str(z or "") if ch.isdigit())
    return digits[:5].zfill(5) if digits else ""


def load_addresses(ids):
    """CMS facility ID -> {street, city, st, zip, county, name, type, er} for the scored hospitals in data.js and for
    every hospital in the newest Hospital General Information directory. Returns (addresses, directory IDs)."""
    found, directory = {}, set()
    for n, snapshot in enumerate(SNAPSHOTS):
        if n and not (ids - found.keys()):
            break
        archive = zipfile.ZipFile(io.BufferedReader(HttpRangeFile(ARCHIVE + snapshot), buffer_size=1 << 20))
        names = archive.namelist()
        for wanted in ADDRESS_FILES:
            member = next((x for x in names if x.endswith(wanted)), None)
            take_all = n == 0 and wanted in GENERAL_FILES and not directory
            if not member or not (take_all or ids - found.keys()):
                continue
            print(f"  {snapshot}: reading {member} …", flush=True)
            with archive.open(member) as fh:
                for row in csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8-sig", newline="")):
                    fid = row.get("Facility ID", "").strip()
                    if take_all and fid:
                        directory.add(fid)
                    if fid in found or not row.get("Address") or not (take_all or fid in ids):
                        continue
                    found[fid] = {
                        "street": row["Address"].strip(),
                        "city": (row.get("City/Town") or row.get("City") or "").strip(),
                        "st": row.get("State", "").strip(),
                        "zip": zip5(row.get("ZIP Code")),
                        "county": (row.get("County/Parish") or row.get("County Name") or "").strip(),
                        "name": (row.get("Facility Name") or "").strip(),
                        "type": TYPE_CODES.get((row.get("Hospital Type") or "").strip()),
                        "er": {"Yes": 1, "No": 0}.get((row.get("Emergency Services") or "").strip()),
                    }
    return found, directory


def address_key(a):
    return "|".join([a["street"].upper(), a["city"].upper(), a["st"], a["zip"]])


def census_batch(rows):
    """rows: [(id, street, city, state, zip)] -> {id: (lat, lon, precision)} for matched addresses."""
    buf = io.StringIO()
    csv.writer(buf).writerows(rows)
    boundary = uuid.uuid4().hex
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"benchmark\"\r\n\r\nPublic_AR_Current\r\n"
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"addressFile\"; filename=\"addresses.csv\"\r\n"
        f"Content-Type: text/csv\r\n\r\n{buf.getvalue()}\r\n--{boundary}--\r\n"
    ).encode("utf-8")
    req = urllib.request.Request(CENSUS_BATCH, data=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "User-Agent": USER_AGENT})
    for attempt in range(4):
        try:
            text = urllib.request.urlopen(req, timeout=600).read().decode("utf-8", "replace")
            break
        except Exception as e:  # The Census service intermittently times out on large batches
            if attempt == 3:
                raise
            print(f"    Census geocoder error ({e}); retrying …", flush=True)
            time.sleep(10 * (attempt + 1))
    out = {}
    for rec in csv.reader(io.StringIO(text)):
        if len(rec) >= 6 and rec[2] == "Match" and rec[5]:
            lon, lat = (float(v) for v in rec[5].split(","))
            out[rec[0]] = (round(lat, 5), round(lon, 5), EXACT if rec[3] == "Exact" else INTERPOLATED)
    return out


def load_zip_centroids():
    print("  Census ZCTA gazetteer …", flush=True)
    raw = urllib.request.urlopen(urllib.request.Request(GAZETTEER, headers={"User-Agent": USER_AGENT}), timeout=300).read()
    archive = zipfile.ZipFile(io.BytesIO(raw))
    member = next(n for n in archive.namelist() if n.endswith(".txt"))
    zips = {}
    with archive.open(member) as fh:
        reader = csv.reader(io.TextIOWrapper(fh, encoding="utf-8"), delimiter="\t")
        head = [h.strip() for h in next(reader)]
        iz, ila, ilo = head.index("GEOID"), head.index("INTPTLAT"), head.index("INTPTLONG")
        for row in reader:
            zips[row[iz].strip()] = (float(row[ila]), float(row[ilo]))
    return zips


# USPS 3-digit ZIP prefixes by state (first match wins), used to reject ZIP centroids in the wrong state
ZIP3_STATE = [
    (5, 5, "NY"), (6, 7, "PR"), (8, 8, "VI"), (9, 9, "PR"), (10, 27, "MA"), (28, 29, "RI"), (30, 38, "NH"), (39, 49, "ME"),
    (50, 59, "VT"), (60, 69, "CT"), (70, 89, "NJ"), (100, 149, "NY"), (150, 196, "PA"), (197, 199, "DE"), (200, 200, "DC"),
    (201, 201, "VA"), (202, 205, "DC"), (206, 219, "MD"), (220, 246, "VA"), (247, 268, "WV"), (270, 289, "NC"), (290, 299, "SC"),
    (300, 319, "GA"), (320, 349, "FL"), (350, 369, "AL"), (370, 385, "TN"), (386, 397, "MS"), (398, 399, "GA"), (400, 427, "KY"),
    (430, 459, "OH"), (460, 479, "IN"), (480, 499, "MI"), (500, 528, "IA"), (530, 549, "WI"), (550, 567, "MN"), (569, 569, "DC"),
    (570, 577, "SD"), (580, 588, "ND"), (590, 599, "MT"), (600, 629, "IL"), (630, 658, "MO"), (660, 679, "KS"), (680, 693, "NE"),
    (700, 714, "LA"), (716, 729, "AR"), (733, 733, "TX"), (730, 749, "OK"), (750, 799, "TX"), (800, 816, "CO"), (820, 831, "WY"),
    (832, 838, "ID"), (840, 847, "UT"), (850, 865, "AZ"), (870, 884, "NM"), (885, 885, "TX"), (889, 898, "NV"), (900, 961, "CA"),
    (967, 968, "HI"), (970, 979, "OR"), (980, 994, "WA"), (995, 999, "AK"),
]


def zip_state(z):
    if len(z) != 5:
        return None
    p = int(z[:3])
    if p == 969:
        return "MP" if z.startswith("9695") else "GU"
    if z == "96799":
        return "AS"
    return next((st for lo, hi, st in ZIP3_STATE if lo <= p <= hi), None)


def nominatim(a):
    """OpenStreetMap lookup, accepted only when OSM reports the hospital's own state or territory (e.g. US-TN, US-PR)."""
    queries = [
        {"street": a["street"], "city": a["city"], "postalcode": a["zip"]},
        {"q": f"{a['street']}, {a['city']}, {a['st']} {a['zip']}"},
        {"city": a["city"], "postalcode": a["zip"]},
        {"q": f"{a['city']}, {a['st']}"},
    ]
    for params in queries:
        time.sleep(1.1)  # Nominatim usage policy: at most one request per second
        query = urllib.parse.urlencode({**params, "countrycodes": "us", "addressdetails": 1, "format": "json", "limit": 5})
        try:
            res = json.load(urllib.request.urlopen(urllib.request.Request(f"{NOMINATIM}?{query}", headers={"User-Agent": USER_AGENT}), timeout=60))
        except Exception:
            continue
        for hit in res:
            if hit.get("address", {}).get("ISO3166-2-lvl4") == f"US-{a['st']}":
                return round(float(hit["lat"]), 5), round(float(hit["lon"]), 5), PLACE
    return None


def main():
    started = dt.datetime.now(dt.timezone.utc)
    facilities = load_facilities()
    ids = {f["id"] for f in facilities}
    print(f"{len(ids):,} hospitals in assets/data.js")

    print("Reading CMS addresses:")
    addresses, directory = load_addresses(ids)
    extra_ids = directory - ids
    print(f"  addresses found for {len(addresses.keys() & ids):,} of {len(ids):,} scored hospitals; "
          f"{len(extra_ids):,} more hospitals in the CMS directory have no published score")

    cache = json.load(open(CACHE)) if os.path.exists(CACHE) else {}
    todo = {fid: a for fid, a in addresses.items() if address_key(a) not in cache}
    print(f"Census batch geocoder: {len(todo):,} new addresses ({len(addresses) - len(todo):,} cached)")
    items = list(todo.items())
    for i in range(0, len(items), BATCH_SIZE):
        chunk = items[i: i + BATCH_SIZE]
        print(f"  batch {i // BATCH_SIZE + 1}/{(len(items) - 1) // BATCH_SIZE + 1} ({len(chunk)} addresses) …", flush=True)
        hits = census_batch([(fid, a["street"], a["city"], a["st"], a["zip"]) for fid, a in chunk])
        for fid, a in chunk:
            if fid in hits:
                cache[address_key(a)] = list(hits[fid])
        json.dump(cache, open(CACHE, "w"))

    zips = load_zip_centroids()
    # ZIP centroids are only trusted when the ZIP belongs to the hospital's own state
    for a in addresses.values():
        hit = cache.get(address_key(a))
        if hit and hit[2] == ZIP_CENTROID and zip_state(a["zip"]) != a["st"]:
            del cache[address_key(a)]
    unresolved = [fid for fid, a in addresses.items() if address_key(a) not in cache]
    for fid in unresolved:
        a = addresses[fid]
        if a["zip"] in zips and zip_state(a["zip"]) == a["st"]:
            lat, lon = zips[a["zip"]]
            cache[address_key(a)] = [round(lat, 5), round(lon, 5), ZIP_CENTROID]
    leftover = [fid for fid, a in addresses.items() if address_key(a) not in cache]
    if leftover:
        print(f"OpenStreetMap Nominatim: {len(leftover)} addresses outside Census coverage …", flush=True)
        for fid in leftover:
            hit = nominatim(addresses[fid])
            if hit:
                cache[address_key(addresses[fid])] = list(hit)
    json.dump(cache, open(CACHE, "w"))

    rows, extra, counts = {}, {}, {EXACT: 0, INTERPOLATED: 0, ZIP_CENTROID: 0, PLACE: 0}
    for fid in sorted(ids | extra_ids):
        a = addresses.get(fid)
        hit = cache.get(address_key(a)) if a else None
        if not hit:
            continue
        lat, lon, prec = hit
        counts[prec] += 1
        row = [lat, lon, a["street"].title(), a["zip"], prec, a.get("type"), a.get("er")]
        if fid in ids:
            rows[fid] = row
        else:
            extra[fid] = row + [a["name"].title(), a["city"].title(), a["st"]]
    missing = sorted(ids - rows.keys())
    extra_missing = sorted(extra_ids - extra.keys())

    payload = {
        "fields": ["lat", "lon", "address", "zip", "precision", "type", "er"],
        "extraFields": ["lat", "lon", "address", "zip", "precision", "type", "er", "name", "city", "st"],
        "types": TYPE_LABELS,
        "precision": {EXACT: "Street address", INTERPOLATED: "Street address (interpolated)", ZIP_CENTROID: "ZIP code centre (approximate)", PLACE: "Town centre (approximate)"},
        "geocoded": started.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sources": {
            "addresses": "CMS Hospital General Information, " + ", ".join(SNAPSHOTS),
            "geocoder": "U.S. Census Bureau Geocoder (Public_AR_Current), Census 2024 ZCTA centroids, OpenStreetMap Nominatim",
        },
        "counts": {"hospitals": len(ids), "placed": len(rows), "extra": len(extra_ids), "extraPlaced": len(extra),
                   "exact": counts[EXACT], "interpolated": counts[INTERPOLATED], "zip": counts[ZIP_CENTROID], "place": counts[PLACE],
                   "missing": len(missing) + len(extra_missing)},
        "rows": rows,
        "extra": extra,
    }
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write("// Generated by geocode_hospitals.py from public CMS hospital addresses. Regenerate rather than edit by hand.\n")
        fh.write("window.CMS_LOCATIONS = " + json.dumps(payload, separators=(",", ":")) + ";\n")

    # Compact ZIP lookup ("zip,lat,lon;…"), loaded by the dashboard only when someone types a ZIP code
    packed = ";".join(f"{z},{lat:.3f},{lon:.3f}" for z, (lat, lon) in sorted(zips.items()))
    with open(ZIP_OUT, "w", encoding="utf-8") as fh:
        fh.write("// Generated by geocode_hospitals.py from the U.S. Census 2024 ZCTA gazetteer. ZIP lookups run in the browser only.\n")
        fh.write(f'window.CMS_ZIPS = "{packed}";\n')

    print(f"Wrote {OUT}: {len(rows):,}/{len(ids):,} scored and {len(extra):,}/{len(extra_ids):,} unscored hospitals placed "
          f"(street {counts[EXACT] + counts[INTERPOLATED]:,} · ZIP {counts[ZIP_CENTROID]:,} · town {counts[PLACE]:,} · missing {len(missing) + len(extra_missing)})")
    if missing or extra_missing:
        print("  not placed:", ", ".join((missing + extra_missing)[:25]) + (" …" if len(missing) + len(extra_missing) > 25 else ""))
    print(f"Wrote {ZIP_OUT}: {len(zips):,} ZIP codes")


if __name__ == "__main__":
    sys.exit(main())
