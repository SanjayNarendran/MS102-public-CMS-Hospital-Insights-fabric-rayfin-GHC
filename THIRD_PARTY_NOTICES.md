# Third-party notices

The MIT licence in `LICENSE` covers this repository's own code. The components and services below keep their own terms.

## Bundled in this repository

| Component | Where | Licence |
| --- | --- | --- |
| D3 v7 | `assets/vendor/d3.min.js` | ISC, Copyright 2010–2023 Mike Bostock (`assets/vendor/LICENSE-d3.txt`) |
| MapLibre GL JS v5 | `assets/vendor/maplibre/` | BSD 3-Clause (`assets/vendor/maplibre/LICENSE.txt`) |
| Fira Sans, Fira Sans Condensed, Fira Mono | `assets/fonts/`, embedded in `assets/fonts.css` | SIL Open Font License 1.1 (`assets/fonts/FiraSans-OFL.txt`) |
| Vega 6, Vega-Lite 6, vega-embed 7, vega-interpreter 2 | `assets/vendor/vega/` (Ask your data) | BSD 3-Clause (`assets/vendor/vega/LICENSE-vega*.txt`) |
| topojson-client 3 | `assets/vendor/vega/topojson-client.min.js` (Ask your data) | ISC (`assets/vendor/vega/LICENSE-topojson-client.txt`) |

## Packages installed during setup (not stored in this repository)

| Package | Used for | Licence |
| --- | --- | --- |
| numpy, SciPy | Data build | BSD 3-Clause |
| Pillow | Data build | MIT-CMU |
| pyarrow | `publish_fabric.py` | Apache 2.0 |
| github-copilot-sdk (and the GitHub Copilot CLI runtime it downloads) | Ask your data (`copilot/`) | MIT for the SDK; the runtime and the Copilot service are under GitHub's terms |
| Starlette, Uvicorn, HTTPX | Ask your data server | BSD 3-Clause |
| vl-convert-python | Checks Vega-Lite answers on the server | BSD 3-Clause |
| DuckDB | Saved chats on the local server | MIT |
| Playwright | Optional chat tests (`copilot/dev/`) | Apache 2.0 |
| @microsoft/rayfin-cli, rayfin-client, rayfin-auth-provider-fabric, fabric-user-data-functions; esbuild | The Fabric App and its functions (`fabric-app/`) | MIT |

## Data downloaded by the build scripts (not stored in this repository)

| Source | Used for | Terms |
| --- | --- | --- |
| CMS Provider Data Catalog (Care Compare) and its hospital archive | Infections, HCAHPS, PSI-90, star ratings, outcomes, ED times, penalties, maternal health | U.S. government public data |
| CMS Provider of Services file; CMS hospital cost reports (HCRIS) | Obstetric and NICU services, NICU beds | U.S. government public data |
| U.S. Census Bureau: ACS 5-year table B01001, 2020 tract centres of population, ZCTA gazetteer, geocoder | Women aged 15–44 by tract, ZIP lookup, hospital locations | U.S. government public data |
| GeoNames `cities500` and `admin2Codes` | Place names on the maps | CC BY 4.0, https://www.geonames.org/ |
| us-atlas 3 (Census cartographic boundaries) | State outlines, and the state shapes for Ask your data's maps | ISC |
| OSRM demo server (OpenStreetMap data) | Optional drive-time calibration (`build_maternity.py --calibrate`) | ODbL data; the demo server allows light use only |

## Live services the dashboard calls in the browser

| Service | Used for | Terms |
| --- | --- | --- |
| OpenFreeMap and VersaTiles basemaps (OpenStreetMap data) | Map tiles | ODbL data, attribution shown on the map |
| OSRM demo server | Road routes and drive times | Light use only; see https://github.com/Project-OSRM/osrm-backend/wiki/Demo-server |
| U.S. Census Bureau geocoder; OpenStreetMap Nominatim | Address search | Nominatim allows at most one request per second |

## Services Ask your data uses (optional)

| Service | Used for | Terms |
| --- | --- | --- |
| GitHub Copilot | Answers questions; each person uses their own Copilot plan | GitHub's terms for Copilot |
| Microsoft Fabric (Power BI executeQueries API) | DAX queries on the CMS and CMS V2 semantic models | Your Microsoft agreement |
| Azure Container Apps and Container Registry | The chat relay for the Fabric-hosted app | Your Azure agreement |
| OSRM demo server; OpenStreetMap Nominatim | Routes and place lookups for trip and "nearest" questions (`copilot/geo.py`) | As above: light use only |

`data/nicu_levels.csv` lists NICU levels gathered by hand from the public pages linked on each row. It is included for
representation only, may be out of date and may change without notice; validate it before relying on it.
