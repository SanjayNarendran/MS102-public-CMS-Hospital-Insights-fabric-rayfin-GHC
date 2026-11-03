# Third-party notices

The MIT licence in `LICENSE` covers this repository's own code. The components and services below keep their own terms.

## Bundled in this repository

| Component | Where | Licence |
| --- | --- | --- |
| D3 v7 | `assets/vendor/d3.min.js` | ISC, Copyright 2010–2023 Mike Bostock (`assets/vendor/LICENSE-d3.txt`) |
| MapLibre GL JS v5 | `assets/vendor/maplibre/` | BSD 3-Clause (`assets/vendor/maplibre/LICENSE.txt`) |
| Fira Sans, Fira Sans Condensed, Fira Mono | `assets/fonts/`, embedded in `assets/fonts.css` | SIL Open Font License 1.1 (`assets/fonts/FiraSans-OFL.txt`) |

## Data downloaded by the build scripts (not stored in this repository)

| Source | Used for | Terms |
| --- | --- | --- |
| CMS Provider Data Catalog (Care Compare) and its hospital archive | Infections, HCAHPS, PSI-90, star ratings, outcomes, ED times, penalties, maternal health | U.S. government public data |
| CMS Provider of Services file; CMS hospital cost reports (HCRIS) | Obstetric and NICU services, NICU beds | U.S. government public data |
| U.S. Census Bureau: ACS 5-year table B01001, 2020 tract centres of population, ZCTA gazetteer, geocoder | Women aged 15–44 by tract, ZIP lookup, hospital locations | U.S. government public data |
| GeoNames `cities500` and `admin2Codes` | Place names on the maps | CC BY 4.0, https://www.geonames.org/ |
| us-atlas 3 (Census cartographic boundaries) | State outlines | ISC |
| OSRM demo server (OpenStreetMap data) | Optional drive-time calibration (`build_maternity.py --calibrate`) | ODbL data; the demo server allows light use only |

## Live services the dashboard calls in the browser

| Service | Used for | Terms |
| --- | --- | --- |
| OpenFreeMap and VersaTiles basemaps (OpenStreetMap data) | Map tiles | ODbL data, attribution shown on the map |
| OSRM demo server | Road routes and drive times | Light use only; see https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server |
| U.S. Census Bureau geocoder; OpenStreetMap Nominatim | Address search | Nominatim allows at most one request per second |

`data/nicu_levels.csv` lists NICU levels gathered by hand from the public pages linked on each row. It is included for
representation only, may be out of date and may change without notice; validate it before relying on it.
