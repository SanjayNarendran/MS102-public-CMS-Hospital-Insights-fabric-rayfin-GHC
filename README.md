# CMS Hospital Insights on Microsoft Fabric

> **For demonstration purposes only.** This project shows how public hospital data can be turned into an interactive
> dashboard and hosted on Microsoft Fabric. It is not medical, clinical or financial advice. Every number it shows depends
> entirely on the public data sources it downloads (CMS, CDC via CMS, U.S. Census Bureau, OpenStreetMap and others), on
> when they were downloaded, and on how this code processes them. Those sources can be revised, delayed or incomplete.
> Check anything important against the original source. In a medical emergency, call 911.

A static web dashboard of U.S. hospital quality and access to maternity care, in three tabs:

- **Overview**: what the dashboard covers and where each dataset comes from.
- **Quality & safety**: nine sections on healthcare-associated infections, benchmarking, a state map that drills down to a street map of every hospital, maternity care access (drive time to the nearest hospital that delivers babies or has a NICU, with an address search, road routes and directions), patient experience, PSI‑90 patient safety, how these relate, outcomes and Medicare penalties, and a hospital explorer.
- **Insights and takeaways**: thirteen written findings with their trends. The text was written from an earlier build of the same data, so its figures can differ slightly from a newer build.

It is plain HTML, CSS and JavaScript (D3 and MapLibre, included in `assets/vendor/`) with Python scripts that build the data. **The repository contains no data**: the scripts download it from public sources and build it locally. Optionally, the tables can be loaded into Microsoft Fabric (a lakehouse and Direct Lake semantic models) and the dashboard hosted as a Fabric App.

## Screenshots

These were taken from a build of the public data and show the layout; your build will show the data as of when you run it.

### Summary

![Quality & safety summary: headline, description and six KPI tiles with trends](docs/screenshots/00-summary.png)

### Infection trends, with the story beside them

![Section 01: national infection ratio by type of infection, 2019 to 2025, with the section's narrative open in the contents rail](docs/screenshots/01-infection-trends.png)

### PSI‑90 by state, and every hospital in a state

![Section 03: average PSI-90 composite by state](docs/screenshots/02-psi90-state-map.png)

![Section 03: street map of one state's hospitals coloured by PSI-90](docs/screenshots/03-psi90-hospital-map.png)

### Maternity care: how far is the nearest hospital that delivers babies, or the nearest NICU?

![Section 04: map of the U.S. showing areas more than 30 minutes and more than an hour from a NICU](docs/screenshots/04-maternity-nicu-map.png)

![Section 04: routes from a searched town to the three nearest delivering hospitals, with NICU levels](docs/screenshots/05-maternity-nearest-care.png)

### Insights and data sources

![Insights tab: findings with trends and executive takeaways](docs/screenshots/06-insights-and-takeaways.png)

![Overview tab: table of data sources](docs/screenshots/07-data-sources.png)

## Quick start (local, no cloud account needed)

Needs Python 3.10+ (with numpy, Pillow and scipy from `requirements.txt`), an internet connection and about 3 GB of free disk space. The first build downloads under 1 GB (kept as about 2.5 GB in `data/raw/`) and takes roughly 10–30 minutes.

```sh
pip install -r requirements.txt
python3 build_all.py                 # downloads the public data and builds every file the dashboard loads
python3 -m http.server 8000          # then open http://localhost:8000/
```

Using an AI coding agent (GitHub Copilot, Claude, Codex and similar)? Point it at **[AGENTS.md](AGENTS.md)**: it has step-by-step instructions to build the data, run the app, check it, and optionally publish to Fabric.

## Optional: Microsoft Fabric

- **Data in Fabric.** `publish_fabric.py --workspace <id>` loads the tables into two lakehouses and creates two Direct Lake semantic models: **CMS** (infections, HCAHPS, PSI‑90) and **CMS V2** (outcomes, penalties, maternity). `refresh_data.py` can then build the dashboard's core data by querying the **CMS** model with DAX instead of reading the local files; both routes give identical numbers.
- **App hosted on Fabric.** `fabric-app/` packages the dashboard and deploys it as a Fabric App with the Rayfin CLI. Viewers sign in with their Fabric account.

Both need a Fabric workspace on a running capacity and the Azure CLI (`az login`); see [AGENTS.md](AGENTS.md#5-optional-publish-to-microsoft-fabric).

## How the data is built

| Step | Script | Source | Output |
| --- | --- | --- | --- |
| Place names, state outlines | `build_places.py` | GeoNames, us-atlas (Census) | `assets/places.js`, `assets/state-shapes.js` |
| Infections, HCAHPS, PSI‑90 tables | `build_core_tables.py` | CMS hospitals archive (one snapshot per table and report year, pinned in `cms_archive.py`) | `data/core/*.csv` |
| Core chart data | `refresh_data.py --local` (or from a semantic model) | `data/core/*.csv` | `assets/data.js` |
| Hospital locations | `geocode_hospitals.py` | CMS hospital directory, U.S. Census geocoder and ZIP centroids | `assets/hospital-locations.js`, `assets/zip-centroids.js` |
| Outcomes, ED times, penalties | `build_quality_extra.py` | CMS Care Compare | `assets/quality-extra.js`, `data/fabric/` |
| Maternity inputs | `download_inputs.py` | CMS Maternal Health, Provider of Services, cost reports; Census ACS and tract centres | `data/raw/` |
| Maternity care access | `build_maternity.py` | the above, plus `data/nicu_levels.csv` | `assets/maternity.js`, `assets/maternity-access.js`, `data/fabric/` |
| Independent check of Fig 1 | `verify_against_cms.py` | CMS hospitals archive | `assets/verification.js` |

`build_all.py` runs them in this order.

## About the NICU levels

`data/nicu_levels.csv` lists newborn intensive care (NICU) levels gathered by hand from public pages (mainly in Minnesota), with a source link on every row. **It is included for representation only. The information may be out of date and may change at any time without notice.** Validate and update it before relying on it, and confirm a hospital's level of newborn care with the hospital itself. Hospitals not in the file still show whether they have a NICU (from CMS files), just without a level.

## Limitations

- CMS publishes each measure for a different period, and revises past periods; see `cms_archive.py` for the exact snapshots used.
- Drive times on the national map are estimates from straight-line distance; routes in the address search come from the public OSRM demo server and ignore traffic.
- The hospital map places most hospitals by street address (U.S. Census geocoder) and the rest at their ZIP code's centre.
- The public map tile, routing and geocoding services have usage limits; for heavy use, run your own or use a paid provider.

## Licence

MIT for this repository's code (see [LICENSE](LICENSE)). Bundled libraries, fonts and the downloaded data keep their own terms: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
