#!/usr/bin/env python3
"""Build every data file the dashboard needs, from public sources, in the right order.

    python3 build_all.py              # local build: no Azure or Fabric account needed
    python3 build_all.py --from-model # take the core charts from a Power BI semantic model instead (see refresh_data.py)

Steps (each skips downloads it already has; re-run any step on its own to refresh just that part):
  1. build_places.py         place names and state outlines for the maps         -> assets/places.js, assets/state-shapes.js
  2. build_core_tables.py    infections, HCAHPS, PSI-90 from CMS's archive        -> data/core/*.csv
  3. refresh_data.py --local the infection, patient-experience and PSI-90 data    -> assets/data.js
  4. geocode_hospitals.py    hospital locations (U.S. Census geocoder) and ZIPs   -> assets/hospital-locations.js, assets/zip-centroids.js
  5. build_quality_extra.py  outcomes, ED times, penalties (CMS)                  -> assets/quality-extra.js, data/fabric/*outcomes.csv
  6. download_inputs.py      maternity inputs (CMS, Census)                      -> data/raw/
  7. build_maternity.py      maternity care access and drive-time maps           -> assets/maternity.js, assets/maternity-access.js
  8. verify_against_cms.py   re-checks Fig 1 against CMS's own files             -> assets/verification.js

Needs Python 3.10+ with numpy, Pillow and scipy (pip install -r requirements.txt). The first run downloads under 1 GB (about 2.5 GB in data/raw/
once unpacked) and takes roughly 10-30 minutes, most of it the CMS downloads and hospital geocoding.
"""
import subprocess
import sys
import time
import os

ROOT = os.path.dirname(os.path.abspath(__file__))


def run(*args):
    print(f"\n=== {' '.join(args)}", flush=True)
    t = time.time()
    code = subprocess.call([sys.executable, *args], cwd=ROOT)
    if code != 0:
        sys.exit(f"{args[0]} failed (exit {code}). Fix the error above and re-run build_all.py; finished steps are skipped quickly.")
    print(f"=== {args[0]} done in {time.time() - t:.0f}s", flush=True)


def main():
    if {"-h", "--help"} & set(sys.argv):
        print(__doc__)
        return
    missing = []
    for module in ("numpy", "PIL", "scipy"):
        try:
            __import__(module)
        except ImportError:
            missing.append(module)
    if missing:
        sys.exit(f"Missing Python packages ({', '.join(missing)}): pip install -r requirements.txt")
    run("build_places.py")
    if "--from-model" in sys.argv:
        run("refresh_data.py")
    else:
        run("build_core_tables.py")
        run("refresh_data.py", "--local")
    run("geocode_hospitals.py")
    run("build_quality_extra.py")
    run("download_inputs.py")
    run("build_maternity.py")
    run("verify_against_cms.py")
    print("\nAll data built. Serve the dashboard with:  python3 -m http.server 8000  and open http://localhost:8000/")


if __name__ == "__main__":
    main()
