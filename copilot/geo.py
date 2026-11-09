"""Places, hospitals and roads for Ask your data: questions about where someone is or is going.

- locate(): a town, ZIP, address or hospital to a point, from the dashboard's own files (GeoNames places, Census ZIP
  centres, geocoded hospital addresses), then OpenStreetMap Nominatim for street addresses.
- nearby(): the nearest hospitals to a point, of any kind, or those that deliver babies or have a NICU.
- route_care(): a road route (OSRM) sampled every couple of miles, with the estimated drive to the nearest delivering
  hospital and NICU at each point, the stretches far from care, and the hospitals along the way.

Drive times to a hospital use the dashboard's maternity estimate (build_maternity.py): straight-line miles x 1.33 for
the road, the first 4 miles at 25 mph and the rest at 45 mph. Road times for a route, and from the far points of a
route to their nearest hospital, come from OSRM. Hospital facts come from the semantic model CMS V2."""
from __future__ import annotations

import difflib
import json
import math
import re
import threading
import time
from pathlib import Path

import httpx

import fabric

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
OSRM = "https://router.project-osrm.org"
NOMINATIM = "https://nominatim.openstreetmap.org/search"
UA = {"User-Agent": "cms-quality-dashboard/1.0 (Ask your data)"}
ROAD_FACTOR, LOCAL_MILES, LOCAL_MPH, OPEN_MPH = 1.33, 4, 25, 45   # as in build_maternity.py
STATES = {
    "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA", "colorado": "CO",
    "connecticut": "CT", "delaware": "DE", "district of columbia": "DC", "florida": "FL", "georgia": "GA", "hawaii": "HI",
    "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA", "kansas": "KS", "kentucky": "KY", "louisiana": "LA",
    "maine": "ME", "maryland": "MD", "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS",
    "missouri": "MO", "montana": "MT", "nebraska": "NE", "nevada": "NV", "new hampshire": "NH", "new jersey": "NJ",
    "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", "ohio": "OH", "oklahoma": "OK",
    "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
    "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT", "virginia": "VA", "washington": "WA",
    "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY", "puerto rico": "PR", "guam": "GU",
    "virgin islands": "VI", "washington dc": "DC",
}
ABBRS = set(STATES.values())
_lock = threading.Lock()
_data: dict = {}


class GeoError(Exception):
    pass


def miles(a, b) -> float:
    """Great-circle miles between (lat, lon) points."""
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 3958.8 * 2 * math.asin(min(1.0, math.sqrt(h)))


def est_minutes(crow: float) -> float:
    road = crow * ROAD_FACTOR
    return min(road, LOCAL_MILES) / LOCAL_MPH * 60 + max(0.0, road - LOCAL_MILES) / OPEN_MPH * 60


def _js(name: str, var: str):
    s = (ASSETS / name).read_text()
    i = s.index(f"window.{var} = ") + len(f"window.{var} = ")
    return json.loads(s[i:].strip().rstrip(";"))


def _norm(s: str) -> str:
    s = s.lower().replace("’", "'")
    s = re.sub(r"\bst\.?\s", "saint ", s + " ").strip()
    s = re.sub(r"\bft\.?\s", "fort ", s + " ").strip()
    s = re.sub(r"\bmt\.?\s", "mount ", s + " ").strip()
    return re.sub(r"[^a-z0-9 ]+", "", s).strip()


def _load():
    with _lock:
        if _data:
            return _data
        places = {}
        for row in _js("places.js", "CMS_PLACES").split("\n"):
            p = row.split("|")
            if len(p) < 5:
                continue
            key = (_norm(p[0]), p[1])
            if key not in places or int(p[4] or 0) > places[key][4]:
                places[key] = (p[0], p[1], float(p[2]), float(p[3]), int(p[4] or 0))
        zips = {}
        for item in _js("zip-centroids.js", "CMS_ZIPS").split(";"):
            z = item.split(",")
            if len(z) == 3:
                zips[z[0]] = (float(z[1]), float(z[2]))
        loc = _js("hospital-locations.js", "CMS_LOCATIONS")
        _data.update(places=places, zips=zips, loc=loc, types=loc.get("types", {}),
                     by_name={}, big=sorted(places.values(), key=lambda p: -p[4]))
        for (n, st), p in places.items():
            _data["by_name"].setdefault(n, []).append(p)
        return _data


# --- hospitals (CMS V2) ----------------------------------------------------------------------------------------------
def _cached(key, fn, ttl=86400):
    import tools  # the shared cache; tools imports this module, so import here
    return tools.cached(key, fn, ttl)


def _maternity_file() -> list[dict]:
    """The dashboard's own copy of the maternity hospitals (assets/maternity.js, build_maternity.py), in the model's shape."""
    d = _js("maternity.js", "CMS_MATERNITY")
    fields, out = d["meta"]["fields"], []
    for row in d["hospitals"]:
        r = dict(zip(fields, row))
        if r.get("lat") is None or r.get("lon") is None:
            continue
        out.append({"ccn": r["ccn"], "name": r["name"], "city": r.get("city"), "state": r.get("st"), "lat": float(r["lat"]),
                    "lon": float(r["lon"]), "phone": r.get("phone"), "delivers": (r.get("d") or 0) > 0,
                    "nicu": (r.get("nicu") or 0) > 0, "nicu_level": r.get("level"), "nicu_beds": r.get("nicuBeds"),
                    "stopped": bool(r.get("gone")), "type": r.get("type"), "er": r.get("er")})
    return out


def maternity() -> list[dict]:
    """Hospitals that deliver babies, have a NICU or stopped delivering, with locations (CMS V2 maternity_hospitals); the
    dashboard's copy of the same list when the model can't be reached (its capacity paused, say)."""
    try:
        return _cached("geo:maternity", _maternity_model)
    except Exception:  # noqa: BLE001 (any failure to reach the model)
        return _cached("geo:maternity-file", _maternity_file)


def _maternity_model() -> list[dict]:
    rows = fabric.dax("""EVALUATE SELECTCOLUMNS(FILTER('maternity_hospitals', NOT ISBLANK('maternity_hospitals'[latitude])),
        "ccn", 'maternity_hospitals'[ccn], "name", 'maternity_hospitals'[name], "city", 'maternity_hospitals'[city],
        "state", 'maternity_hospitals'[state], "lat", 'maternity_hospitals'[latitude], "lon", 'maternity_hospitals'[longitude],
        "phone", 'maternity_hospitals'[phone], "delivers", 'maternity_hospitals'[delivers_babies],
        "nicu", 'maternity_hospitals'[nicu_any], "nicu_level", 'maternity_hospitals'[nicu_level],
        "nicu_beds", 'maternity_hospitals'[nicu_beds], "stopped", 'maternity_hospitals'[stopped_delivering],
        "type", 'maternity_hospitals'[hospital_type], "er", 'maternity_hospitals'[emergency_dept])""", "CMS V2")
    out = []
    for r in fabric.plain_rows(rows):
        try:
            r["lat"], r["lon"] = float(r["lat"]), float(r["lon"])
        except (TypeError, ValueError):
            continue
        r["delivers"], r["nicu"], r["stopped"] = (r.get(k) in (1, "1", True) for k in ("delivers", "nicu", "stopped"))
        out.append(r)
    return out


def hospitals() -> list[dict]:
    """Every geocoded hospital (the dashboard's hospital-locations.js), named from CMS V2 hospital_outcomes."""
    def load():
        d = _load()
        try:
            names = {r["ccn"]: r for r in fabric.plain_rows(fabric.dax(
                """EVALUATE SELECTCOLUMNS('hospital_outcomes', "ccn", 'hospital_outcomes'[ccn], "name", 'hospital_outcomes'[name],
                   "city", 'hospital_outcomes'[city], "state", 'hospital_outcomes'[state])""", "CMS V2"))}
        except Exception:  # noqa: BLE001 (the model can't be reached: the dashboard's own data names them)
            d0 = _js("data.js", "CMS_DATA")
            names = {r[0]: {"ccn": r[0], "name": r[1], "city": r[2], "state": r[3]} for r in d0["facilities"]}
        out = []
        for part in ("rows", "extra"):
            for ccn, v in d["loc"][part].items():
                n = names.get(ccn) or {}
                name = n.get("name") or (v[7] if len(v) > 7 else None)
                if v[0] is None or not name:
                    continue
                out.append({"ccn": ccn, "name": name, "city": n.get("city") or (v[8] if len(v) > 8 else ""),
                            "state": n.get("state") or (v[9] if len(v) > 9 else ""), "lat": v[0], "lon": v[1],
                            "type": d["types"].get(v[5], v[5]), "er": bool(v[6]), "address": v[2]})
        return out
    return _cached("geo:hospitals", load)


# --- places ------------------------------------------------------------------------------------------------------------
def locate(text: str) -> dict:
    """A town ("Cottage Grove, MN"), ZIP, "lat, lon", CCN or hospital name, or street address, to a point."""
    t = (text or "").strip()
    if not t:
        raise GeoError("No place given.")
    d = _load()
    if m := re.fullmatch(r"\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*", t):
        return {"name": t, "lat": float(m[1]), "lon": float(m[2]), "source": "coordinates"}
    if m := re.search(r"\b(\d{5})\b", t):
        if m[1] in d["zips"] and len(t) <= 12:
            la, lo = d["zips"][m[1]]
            return {"name": f"ZIP {m[1]}", "lat": la, "lon": lo, "source": "Census ZIP centre"}
    if re.fullmatch(r"\d{6}", t) or re.fullmatch(r"\d{2}[A-Z]\d{3}", t):
        h = next((h for h in hospitals() if h["ccn"] == t), None)
        if h:
            return {"name": f"{h['name']}, {h['city']} {h['state']}", "lat": h["lat"], "lon": h["lon"], "source": "hospital address"}
    # "City, ST", "City ST", "City, State"
    st = None
    parts = [p.strip() for p in re.split(r",", t) if p.strip()]
    city = parts[0]
    tail = " ".join(parts[1:]).strip()
    if tail:
        tl = tail.lower().strip(". ")
        st = tail.upper() if tail.upper() in ABBRS else STATES.get(tl) or next((STATES[k] for k in STATES if tl.startswith(k)), None)
    else:
        words = city.split()
        if len(words) > 1 and words[-1].upper() in ABBRS and len(words[-1]) == 2:
            st, city = words[-1].upper(), " ".join(words[:-1])
        else:
            for k in sorted(STATES, key=len, reverse=True):
                if city.lower().endswith(" " + k):
                    st, city = STATES[k], city[: -len(k)].strip()
                    break
    n = _norm(city)
    hit = d["places"].get((n, st)) if st else None
    if not hit and not st and n in d["by_name"]:
        hit = max(d["by_name"][n], key=lambda p: p[4])
    if not hit:
        pool = [k for k in d["places"] if not st or k[1] == st]
        close = difflib.get_close_matches(n, [k[0] for k in pool], n=1, cutoff=0.82)
        if close:
            cands = [d["places"][k] for k in pool if k[0] == close[0]]
            hit = max(cands, key=lambda p: p[4])
    if hit:
        return {"name": f"{hit[0]}, {hit[1]}", "lat": hit[2], "lon": hit[3], "source": "GeoNames place", "pop": hit[4]}
    # A hospital by name
    hn = _norm(t)
    hs = [h for h in hospitals() if hn and hn in _norm(h["name"])]
    if len(hs) == 1:
        h = hs[0]
        return {"name": f"{h['name']}, {h['city']} {h['state']}", "lat": h["lat"], "lon": h["lon"], "source": "hospital address"}
    # A street address or anything else: OpenStreetMap
    try:
        r = httpx.get(NOMINATIM, params={"format": "jsonv2", "countrycodes": "us", "limit": 1, "q": t}, headers=UA, timeout=10)
        js = r.json() if r.status_code == 200 else []
    except (httpx.HTTPError, ValueError):
        js = []
    if js:
        return {"name": js[0].get("display_name", t).split(", United States")[0], "lat": float(js[0]["lat"]),
                "lon": float(js[0]["lon"]), "source": "OpenStreetMap"}
    if hs:
        raise GeoError(f"'{t}' matches {len(hs)} hospitals, e.g. " + "; ".join(f"{h['name']} ({h['city']} {h['state']}, CCN {h['ccn']})" for h in hs[:5]) + ". Give the CCN.")
    raise GeoError(f"Couldn't find '{t}'. Give a town and state (e.g. 'Cottage Grove, MN'), a ZIP code or a street address.")


def nearest_town(pt, within=25, min_pop=1500) -> str:
    """The largest-ish town near a point, for naming where something is ("near Julesburg, CO"); in empty country, any
    town within 45 miles."""
    d = _load()
    name = _town(d, pt, within, min_pop)
    return name or _town(d, pt, 45, 150)


def _town(d, pt, within, min_pop) -> str:
    best, score = None, -1
    for p in d["big"]:
        if p[4] < min_pop:
            break
        if abs(p[2] - pt[0]) > within / 69 or abs(p[3] - pt[1]) > within / 48:
            continue
        dist = miles(pt, (p[2], p[3]))
        if dist <= within:
            s = math.log(p[4]) - dist / 6
            if s > score:
                best, score = p, s
    return f"{best[0]}, {best[1]}" if best else ""


# --- roads (OSRM) ------------------------------------------------------------------------------------------------------
def osrm_route(points: list[tuple[float, float]], full=True) -> dict:
    coords = ";".join(f"{lo:.5f},{la:.5f}" for la, lo in points)
    try:
        r = httpx.get(f"{OSRM}/route/v1/driving/{coords}", params={"overview": "full" if full else "false", "geometries": "geojson"},
                      headers=UA, timeout=20)
        js = r.json()
    except (httpx.HTTPError, ValueError) as e:
        raise GeoError(f"The road router didn't answer ({e}).") from None
    if js.get("code") != "Ok" or not js.get("routes"):
        raise GeoError(f"No road route found ({js.get('message') or js.get('code')}).")
    rt = js["routes"][0]
    return {"miles": rt["distance"] / 1609.344, "minutes": rt["duration"] / 60,
            "line": [(la, lo) for lo, la in rt["geometry"]["coordinates"]] if full else []}


def osrm_routes(points: list[tuple[float, float]], alternatives: int = 0) -> list[dict]:
    """The router's route between points, and up to `alternatives` others (only for two points): [{miles, minutes, line}]."""
    coords = ";".join(f"{lo:.5f},{la:.5f}" for la, lo in points)
    params = {"overview": "full", "geometries": "geojson"}
    if alternatives and len(points) == 2:
        params["alternatives"] = str(alternatives)
    try:
        js = httpx.get(f"{OSRM}/route/v1/driving/{coords}", params=params, headers=UA, timeout=20).json()
    except (httpx.HTTPError, ValueError) as e:
        raise GeoError(f"The road router didn't answer ({e}).") from None
    if js.get("code") != "Ok" or not js.get("routes"):
        raise GeoError(f"No road route found ({js.get('message') or js.get('code')}).")
    return [{"miles": rt["distance"] / 1609.344, "minutes": rt["duration"] / 60,
             "line": [(la, lo) for lo, la in rt["geometry"]["coordinates"]]} for rt in js["routes"]]


def osrm_table(sources: list, dests: list) -> list[list[float | None]]:
    """Road minutes from each source to each destination (OSRM table, at most 100 points per call)."""
    coords = ";".join(f"{lo:.5f},{la:.5f}" for la, lo in list(sources) + list(dests))
    n = len(sources)
    r = httpx.get(f"{OSRM}/table/v1/driving/{coords}", headers=UA, timeout=30, params={
        "sources": ";".join(map(str, range(n))), "destinations": ";".join(map(str, range(n, n + len(dests)))), "annotations": "duration"})
    js = r.json()
    if js.get("code") != "Ok":
        raise GeoError(js.get("message") or js.get("code"))
    return [[d / 60 if d is not None else None for d in row] for row in js["durations"]]


def road_minutes(a, b) -> float | None:
    try:
        return osrm_route([a, b], full=False)["minutes"]
    except GeoError:
        return None


def _resample(line, step=2.0):
    """Points every `step` miles along a polyline, with their mile."""
    out, carry, total = [(line[0], 0.0)], 0.0, 0.0
    for a, b in zip(line, line[1:]):
        seg = miles(a, b)
        while carry + seg >= step:
            f = (step - carry) / seg if seg else 0
            a = (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)
            seg -= step - carry
            total += step - carry
            carry = 0.0
            out.append((a, total))
        carry += seg
        total += seg
    if out[-1][1] < total - 0.2:
        out.append((line[-1], total))
    return out


def _nearest(pt, pool, k=1, max_deg=3.0):
    near = [(miles(pt, (h["lat"], h["lon"])), h) for h in pool
            if abs(h["lat"] - pt[0]) < max_deg and abs(h["lon"] - pt[1]) < max_deg * 1.4]
    if not near and max_deg < 12:
        return _nearest(pt, pool, k, max_deg * 2)
    near.sort(key=lambda x: x[0])
    return near[:k]


def _hosp(h, dist):
    return {"ccn": h["ccn"], "name": h["name"], "city": h.get("city"), "state": h.get("state"), "miles": round(dist, 1),
            "est_minutes": round(est_minutes(dist)), "nicu": h.get("nicu"), "nicu_level": h.get("nicu_level"), "phone": h.get("phone")}


# --- nearby ------------------------------------------------------------------------------------------------------------
def nearby(place: str, kind: str = "any", n: int = 8, within_miles: float | None = None) -> dict:
    where = locate(place)
    pt = (where["lat"], where["lon"])
    if kind in ("delivers", "nicu", "stopped"):
        pool = [h for h in maternity() if (h["delivers"] if kind == "delivers" else h["nicu"] if kind == "nicu" else h["stopped"])]
    else:
        pool = hospitals()
        if kind == "emergency":
            pool = [h for h in pool if h.get("er")]
        elif kind == "acute":
            pool = [h for h in pool if h.get("type") in ("Acute care hospital", "Critical access hospital")]
    near = _nearest(pt, pool, k=max(1, min(int(n or 8), 40)))
    if within_miles:
        near = [x for x in near if x[0] <= within_miles]
    rows = []
    for i, (dist, h) in enumerate(near):
        r = _hosp(h, dist) if kind in ("delivers", "nicu", "stopped") else {
            "ccn": h["ccn"], "name": h["name"], "city": h["city"], "state": h["state"], "type": h["type"],
            "emergency_dept": h["er"], "miles": round(dist, 1), "est_minutes": round(est_minutes(dist))}
        r["lat"], r["lon"] = h["lat"], h["lon"]
        if i < 3 and dist > 0.5:
            rm = road_minutes(pt, (h["lat"], h["lon"]))
            if rm is not None:
                r["road_minutes"] = round(rm)
        rows.append(r)
    return {"place": where, "kind": kind, "hospitals": rows}


# --- along a route -----------------------------------------------------------------------------------------------------
def route_care(origin: str, destination: str, via: list[str] | None = None, step: float | None = None) -> dict:
    stops = [locate(origin)] + [locate(v) for v in (via or [])] + [locate(destination)]
    route = osrm_route([(s["lat"], s["lon"]) for s in stops])
    samples = _resample(route["line"], step or max(2.0, route["miles"] / 300))
    mat = maternity()
    deliver = [h for h in mat if h["delivers"]]
    nicu = [h for h in mat if h["nicu"] and h["delivers"]] or [h for h in mat if h["nicu"]]
    stopped = [h for h in mat if h["stopped"] and not h["delivers"]]
    scale = route["miles"] / (samples[-1][1] or 1)   # sampled miles to the router's road miles
    # Candidates by straight line (the two nearest delivering hospitals, the nearest NICU), then the drive by road to
    # each (OSRM table, in batches of up to 100 points); a batch the router can't answer keeps the estimate
    cands = []
    for (pt, mi) in samples:
        dl = _nearest(pt, deliver, k=4)
        # The nearest by road is usually one of the two nearest in a straight line; in empty country, look further
        cands.append((pt, mi, dl[:4] if dl and dl[0][0] > 35 else dl[:2], _nearest(pt, nicu, k=3 if dl and dl[0][0] > 35 else 2)))
    road, by_road = {}, 0
    i = 0
    while i < len(cands):
        src, dst, j = [], {}, i
        while j < len(cands):
            need = {h["ccn"]: h for _, h in cands[j][2] + cands[j][3]}
            if len(src) + 1 + len(set(dst) | set(need)) > 100:
                break
            src.append(cands[j][0])
            dst.update(need)
            j += 1
        keys = list(dst)
        try:
            table = osrm_table(src, [(dst[k]["lat"], dst[k]["lon"]) for k in keys])
            for a, row in zip(range(i, j), table):
                road[a] = dict(zip(keys, row))
            by_road += j - i
        except (GeoError, httpx.HTTPError, ValueError):
            pass
        i = j
    rows = []
    for a, (pt, mi, dl, nl) in enumerate(cands):
        rd = road.get(a, {})
        opts = [(rd.get(h["ccn"]) if rd.get(h["ccn"]) is not None else est_minutes(dist), dist, h) for dist, h in dl]
        dmin, dd, dh = min(opts, key=lambda x: x[0])
        nmin, nd, nh = min(((rd.get(h["ccn"]) if rd.get(h["ccn"]) is not None else est_minutes(dist), dist, h) for dist, h in nl),
                           key=lambda x: x[0])
        rows.append({"mile": round(mi * scale, 1), "lat": round(pt[0], 5), "lon": round(pt[1], 5),
                     "deliver_min": round(dmin, 1), "deliver_mi": round(dd, 1), "deliver": dh["ccn"],
                     "nicu_min": round(nmin, 1), "nicu_mi": round(nd, 1), "nicu_h": nh["ccn"]})

    half = (route["miles"] / max(1, len(samples) - 1)) / 2   # each sample stands for the road either side of it

    def stretches(key, limit):
        out, cur = [], None
        for r in rows:
            if r[key] > limit:
                if not cur:
                    cur = {"from": round(max(0, r["mile"] - half), 1), "to": r["mile"], "max": r}
                cur["to"] = round(min(route["miles"], r["mile"] + half), 1)
                if r[key] > cur["max"][key]:
                    cur["max"] = r
            elif cur:
                out.append(cur)
                cur = None
        if cur:
            out.append(cur)
        return out

    by_ccn = {h["ccn"]: h for h in mat}

    def worst(key, ccn_key):
        r = max(rows, key=lambda x: x[key])
        h = by_ccn[r[ccn_key]]
        return {"mile": r["mile"], "near": nearest_town((r["lat"], r["lon"])), "minutes": round(r[key]),
                "straight_miles": r[key.replace("_min", "_mi")], "hospital": _hosp(h, r[key.replace("_min", "_mi")])}

    # Hospitals near the road, in order along it
    def along(pool, within):
        out = []
        for h in pool:
            if not (min(r["lat"] for r in rows) - 0.6 < h["lat"] < max(r["lat"] for r in rows) + 0.6 and
                    min(r["lon"] for r in rows) - 0.8 < h["lon"] < max(r["lon"] for r in rows) + 0.8):
                continue
            dist, r = min(((miles((h["lat"], h["lon"]), (r["lat"], r["lon"])), r) for r in rows), key=lambda x: x[0])
            if dist <= within:
                out.append({**_hosp(h, dist), "mile": r["mile"], "off_route_miles": round(dist, 1), "lat": h["lat"], "lon": h["lon"],
                            "delivers": h["delivers"], "stopped": h["stopped"]})
        return sorted(out, key=lambda x: x["mile"])

    near_route = along(deliver + stopped, 20)
    # Towns to label the profile: the biggest ones near the road, spread out
    towns, d = [], _load()
    for p in d["big"]:
        if p[4] < 8000 or len(towns) >= 40:
            break
        if not (min(r["lat"] for r in rows) - 0.3 < p[2] < max(r["lat"] for r in rows) + 0.3):
            continue
        dist, r = min(((miles((p[2], p[3]), (r["lat"], r["lon"])), r) for r in rows), key=lambda x: x[0])
        if dist <= 6:
            towns.append({"name": p[0], "state": p[1], "mile": r["mile"], "pop": p[4]})
    picked = []
    for t in sorted(towns, key=lambda t: -t["pop"]):
        if all(abs(t["mile"] - q["mile"]) > route["miles"] / 11 for q in picked) and 25 < t["mile"] < route["miles"] - 25:
            picked.append(t)
    return {
        "stops": stops, "road_miles": round(route["miles"]), "road_minutes": round(route["minutes"]),
        "by_road": by_road / max(1, len(cands)),
        "line": [(round(la, 4), round(lo, 4)) for la, lo in route["line"][:: max(1, len(route["line"]) // 900)]],
        "samples": rows, "deliver_30": stretches("deliver_min", 30), "deliver_60": stretches("deliver_min", 60),
        "nicu_60": stretches("nicu_min", 60), "worst_deliver": worst("deliver_min", "deliver"), "worst_nicu": worst("nicu_min", "nicu_h"),
        "near_route": near_route, "towns": sorted(picked[:9], key=lambda t: t["mile"]),
        "states": list(dict.fromkeys(h["state"] for h in (by_ccn[r["deliver"]] for r in rows))),
    }


# --- nearest care from a place or a point on a map, with routes ------------------------------------------------------
CARE_KINDS = {"delivers": "hospitals that deliver babies", "nicu": "hospitals with a NICU",
              "emergency": "hospitals with an emergency department",
              "acute": "acute-care and critical access hospitals", "any": "hospitals"}
CANDIDATES = 10        # as the dashboard's maternity map: the 10 nearest in a straight line, ranked by road
ROUTE_GAP = 1.0        # seconds between calls to the public router, about as the dashboard spaces them
_last_call = [0.0]
_route_lock = threading.Lock()


def _routes(points, alternatives=0):
    with _route_lock:
        wait = _last_call[0] + ROUTE_GAP - time.time()
        if wait > 0:
            time.sleep(wait)
        _last_call[0] = time.time()
    return osrm_routes(points, alternatives)


def _xy(p, ref):
    """Miles east and north of ref (a flat projection, close enough within a hundred miles)."""
    return ((p[1] - ref[1]) * 69.17 * math.cos(math.radians(ref[0])), (p[0] - ref[0]) * 69.0)


def _seg_miles(c, a, b):
    ax, ay = _xy(a, c)
    bx, by = _xy(b, c)
    dx, dy = bx - ax, by - ay
    t = 0.0 if not (dx or dy) else max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
    return math.hypot(ax + t * dx, ay + t * dy)


_shapes: dict = {}


def state_shapes() -> dict:
    """Each state's outline, {code: [rings of (lat, lon)]}, from the dashboard's U.S. states TopoJSON (the relay image
    has it for render_visual)."""
    with _lock:
        if _shapes:
            return _shapes
        t = json.loads((ASSETS / "vendor" / "vega" / "us-states-10m.json").read_text())
        (sx, sy), (tx, ty) = t["transform"]["scale"], t["transform"]["translate"]
        arcs = []
        for arc in t["arcs"]:  # quantized and delta-encoded
            x = y = 0
            pts = []
            for dx, dy in arc:
                x, y = x + dx, y + dy
                pts.append((y * sy + ty, x * sx + tx))
            arcs.append(pts)

        def ring(ids):
            out = []
            for i in ids:
                pts = arcs[i] if i >= 0 else arcs[~i][::-1]
                out.extend(pts if not out else pts[1:])
            return out
        for g in t["objects"]["states"]["geometries"]:
            code = STATES.get(str((g.get("properties") or {}).get("name", "")).lower())
            if code:
                polys = g["arcs"] if g["type"] == "MultiPolygon" else [g["arcs"]]
                _shapes[code] = [ring(r) for poly in polys for r in poly]
        return _shapes


def _in_rings(pt, rings) -> bool:
    la, lo, inside = pt[0], pt[1], False
    for r in rings:
        for (a1, o1), (a2, o2) in zip(r, r[1:] + r[:1]):
            if (a1 > la) != (a2 > la) and lo < (o2 - o1) * (la - a1) / (a2 - a1) + o1:
                inside = not inside
    return inside


def in_zone(pt, z) -> bool:
    if z.get("kind") == "state":
        b = z["bbox"]
        return b[0] <= pt[0] <= b[2] and b[1] <= pt[1] <= b[3] and _in_rings(pt, state_shapes()[z["state"]])
    return miles(pt, (z["lat"], z["lon"])) < z["miles"]


def passes(line, zones) -> list[str]:
    """The zones a route goes through (any stretch of road inside one)."""
    out = []
    for z in zones:
        if z.get("kind") == "state":
            hit = any(in_zone(p, z) for p in line[::2] + line[-1:])
        else:
            hit = any(_seg_miles((z["lat"], z["lon"]), a, b) < z["miles"] for a, b in zip(line, line[1:]))
        if hit:
            out.append(z["name"])
    return out


def zone(place: str, radius: float | None = None) -> dict:
    """A place to keep away from. A state ("Texas", "TX") is its outline: its hospitals are left out and routes are
    checked against it. Anything else is a circle around the place, sized by its population unless a radius is given
    (St Paul about 5 miles, a town of 20,000 about 2)."""
    text = str(place).strip()
    key = re.sub(r"^(the )?state of ", "", text.lower()).strip(" .")
    code = text if re.fullmatch(r"[A-Z]{2}", text) and text in ABBRS else STATES.get(key)
    if code and code in state_shapes():
        rings = state_shapes()[code]
        lats, lons = [p[0] for r in rings for p in r], [p[1] for r in rings for p in r]
        name = next(k for k, v in STATES.items() if v == code).title().replace(" Of ", " of ")
        # A light copy of the outline for the maps that draw the answer
        outline = [[(round(a, 3), round(o, 3)) for a, o in r[:: max(1, len(r) // 250)]] for r in rings if len(r) > 12]
        return {"name": name, "state": code, "kind": "state", "lat": (min(lats) + max(lats)) / 2,
                "lon": (min(lons) + max(lons)) / 2, "miles": 0, "bbox": (min(lats), min(lons), max(lats), max(lons)),
                "outline": outline}
    p = locate(place)
    r = float(radius) if radius else max(1.5, min(8.0, 1.0 + math.sqrt(p.get("pop") or 20000) / 140))
    return {"name": p["name"], "lat": p["lat"], "lon": p["lon"], "miles": round(r, 1)}


def _vias(a, b, z):
    """Two points beside a zone, left and right of the line from a to b, to route around it."""
    c = (z["lat"], z["lon"])
    ax, ay = _xy(a, c)
    bx, by = _xy(b, c)
    n = math.hypot(bx - ax, by - ay) or 1.0
    px, py, r = -(by - ay) / n, (bx - ax) / n, z["miles"] + 3
    return [(c[0] + s * py * r / 69.0, c[1] + s * px * r / (69.17 * math.cos(math.radians(c[0])))) for s in (1, -1)]


def route_around(a, b, zones):
    """The fastest route from a to b that keeps out of the zones: the router's own, one of its alternatives, or one
    forced around a zone through a point beside it. The public router can't close roads, so this approximates a detour.
    Returns (route, zones it still passes through, whether it is a detour)."""
    alts = _routes([a, b], alternatives=2 if zones else 0)
    if not zones:
        return alts[0], [], False
    clean = [r for r in alts if not passes(r["line"], zones)]
    if clean:
        best = min(clean, key=lambda r: r["minutes"])
        return best, [], best is not alts[0]
    through = passes(alts[0]["line"], zones)
    tries = []
    for z in (z for z in zones if z["name"] in through and z.get("kind") != "state"):
        for v in _vias(a, b, z):
            try:
                r = _routes([a, v, b])[0]
            except GeoError:
                continue
            if not passes(r["line"], zones):
                tries.append(r)
        if tries:
            break
    if tries:
        return min(tries, key=lambda r: r["minutes"]), [], True
    return alts[0], through, False


def _thin(line, n=320):
    step = max(1, len(line) // n)
    out = line[::step]
    if out[-1] != line[-1]:
        out.append(line[-1])
    return [(round(la, 5), round(lo, 5)) for la, lo in out]


def nearest_care(origin: str, kind: str = "delivers", count: int = 3, avoid: list | None = None,
                 avoid_miles: float | None = None, exclude: list | None = None) -> dict:
    """The nearest hospitals of a kind to a place or a point ("44.73, -92.85"), ranked by road, with the route to each.
    For "delivers" it is the dashboard's maternity search: the closest hospitals that deliver babies, the nearest NICU and
    the nearest Level III+ NICU (where levels are published). `avoid` names places to keep away from: hospitals inside
    them are left out and routes go around them where the router can; `exclude` names hospitals (or CCNs) to leave out."""
    kind = kind if kind in CARE_KINDS else "delivers"
    count = max(1, min(int(count or 3), 8))
    where = locate(origin)
    pt = (where["lat"], where["lon"])
    town = nearest_town(pt)
    st_code = town.rsplit(", ", 1)[-1] if town else None
    zones = [zone(z, avoid_miles) for z in (avoid or []) if str(z).strip()]
    inside = [z["name"] for z in zones if in_zone(pt, z)]
    route_zones = [z for z in zones if z["name"] not in inside]
    excl = [str(x).strip() for x in (exclude or []) if str(x).strip()]
    left_out: dict[str, dict] = {}

    def reason(h):
        for x in excl:
            if x == h["ccn"] or (len(_norm(x)) > 2 and _norm(x) in _norm(h["name"])):
                return f"excluded ({x})"
        for z in zones:
            if (z.get("kind") == "state" and h.get("state") == z["state"]) or in_zone((h["lat"], h["lon"]), z):
                return f"in {z['name']}"
        return None

    def nearest_kept(pool, k):
        # A whole state kept out can hold most of the nearest hospitals: look further
        raw = _nearest(pt, pool, k=k + (250 if any(z.get("kind") == "state" for z in zones) else 25))
        out = []
        for d, h in raw:
            why = reason(h)
            if why:
                if d <= raw[min(len(raw), k) - 1][0] and h["ccn"] not in left_out:
                    left_out[h["ccn"]] = {"name": h["name"], "city": h.get("city"), "state": h.get("state"),
                                          "miles": round(d, 1), "why": why}
                continue
            out.append((d, h))
            if len(out) == k:
                break
        return out

    lists = {}
    if kind in ("delivers", "nicu"):
        mat = maternity()
        nicus = [h for h in mat if h["nicu"]]
        if kind == "delivers":
            lists["top"] = nearest_kept([h for h in mat if h["delivers"]], CANDIDATES)
            lists["nicu"] = nearest_kept(nicus, 6)
            # NICU levels are published only for some states; elsewhere the nearest Level III+ would be far away
            level_states = {h["state"] for h in mat if h.get("nicu_level")}
            if st_code in level_states:
                lists["high"] = nearest_kept([h for h in nicus if str(h.get("nicu_level") or "") in ("III", "IV", "3", "4")], 3)
        else:
            lists["top"] = nearest_kept(nicus, CANDIDATES)
    else:
        pool = hospitals()
        if kind == "emergency":
            pool = [h for h in pool if h.get("er")]
        elif kind == "acute":
            pool = [h for h in pool if h.get("type") in ("Acute care hospital", "Critical access hospital")]
        lists["top"] = nearest_kept(pool, max(CANDIDATES, count + 4))
    if not lists["top"]:
        raise GeoError(f"No {CARE_KINDS[kind]} found near {where['name']} outside the places to avoid.")

    # Rank every candidate by road (one table call), then route the ones that will be shown
    uniq = {h["ccn"]: (d, h) for lst in lists.values() for d, h in lst}
    keys = list(uniq)
    try:
        row = osrm_table([pt], [(uniq[k][1]["lat"], uniq[k][1]["lon"]) for k in keys])[0]
        road = dict(zip(keys, row))
    except (GeoError, httpx.HTTPError, ValueError):
        road = {}
    info = {k: {"minutes": road.get(k) if road.get(k) is not None else est_minutes(d), "routed": road.get(k) is not None,
                "miles": d * ROAD_FACTOR, "straight": d} for k, (d, h) in uniq.items()}
    def resort():
        for name in lists:
            lists[name].sort(key=lambda x: info[x[1]["ccn"]]["minutes"])

    def shown():
        return lists["top"][:count] + lists.get("nicu", [])[:1] + lists.get("high", [])[:1]

    # Route the hospitals that will be shown. A route around an avoided place can be slower than the table's, which
    # reorders the list, so keep routing until every hospital shown has its own route (or the budget runs out)
    resort()
    routed: set[str] = set()
    budget = count + (8 if route_zones else 3)
    while budget > 0:
        todo = [h for _, h in shown() if h["ccn"] not in routed]
        if not todo:
            break
        h = todo[0]
        routed.add(h["ccn"])
        budget -= 1
        try:
            r, through, detour = route_around(pt, (h["lat"], h["lon"]), route_zones)
        except GeoError:
            continue
        info[h["ccn"]].update(minutes=r["minutes"], miles=r["miles"], routed=True, line=_thin(r["line"]),
                              through=through, detour=detour, checked=True)
        resort()

    by_ccn = {h["ccn"]: h for h in (maternity() if kind in ("delivers", "nicu") else [])}
    results, seen = [], set()

    def add(d, h, role, rank):
        m = by_ccn.get(h["ccn"], h)
        i = info[h["ccn"]]
        results.append({
            "role": role, "rank": rank, "ccn": h["ccn"], "name": h["name"], "city": h.get("city"), "state": h.get("state"),
            "lat": h["lat"], "lon": h["lon"], "minutes": round(i["minutes"], 1), "miles": round(i["miles"], 1),
            "straight_miles": round(d, 1), "routed": i["routed"], "line": i.get("line"), "through": i.get("through", []),
            "detour": i.get("detour", False), "unchecked": bool(route_zones) and not i.get("checked"),
            "delivers": m.get("delivers"), "nicu": m.get("nicu"),
            "nicu_level": m.get("nicu_level"), "phone": m.get("phone"), "er": m.get("er"), "type": m.get("type")})
        seen.add(h["ccn"])

    for i, (d, h) in enumerate(lists["top"][:count]):
        add(d, h, "top", i + 1)
    for role in ("nicu", "high"):
        lst = lists.get(role) or []
        if lst and lst[0][1]["ccn"] not in seen and (role != "high" or not any(r["role"] == "nicu" and r["ccn"] == lst[0][1]["ccn"] for r in results)):
            add(lst[0][0], lst[0][1], role, None)
    return {"origin": {**where, "near": town, "st": st_code}, "kind": kind, "zones": zones, "inside": inside,
            "excluded": excl, "left_out": list(left_out.values())[:12], "results": results}
