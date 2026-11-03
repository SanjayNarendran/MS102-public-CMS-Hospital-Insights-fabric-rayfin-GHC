# Instructions for AI coding agents

You are working in a repository that **contains code but no data**. Your job is usually one of:

1. Build the data and run the dashboard locally (sections 1–4).
2. Optionally publish the data and/or the app to Microsoft Fabric (section 5).

Work through the steps in order, run the checks, and report what you did. Do not commit generated data (see "Rules").

## 0. What this is

A static dashboard (`index.html`, `assets/js/*.js`, `assets/styles.css`) of U.S. hospital quality and maternity care
access. It loads its data from JavaScript files in `assets/` that **the Python scripts generate from public sources**:
the CMS Provider Data Catalog (Care Compare and its archive), the CMS Provider of Services file and hospital cost reports,
the U.S. Census Bureau (ACS, tract centres, geocoder, ZIP centroids) and GeoNames. It is for demonstration only; its
numbers depend entirely on those sources.

## 1. Check prerequisites

```sh
python3 --version          # 3.10 or newer
python3 -c "import numpy, PIL, scipy"  # if this fails: pip install -r requirements.txt
```

- Internet access to `data.cms.gov`, `downloads.cms.gov`, `www2.census.gov`, `geocoding.geo.census.gov`, `download.geonames.org` and `cdn.jsdelivr.net`.
- About 3 GB of free disk space (downloads go to `data/raw/`, about 2.5 GB once unpacked; it is git-ignored).
- No cloud account is needed for the local build.

## 2. Build the data

```sh
python3 build_all.py
```

This runs, in order: `build_places.py`, `build_core_tables.py`, `refresh_data.py --local`, `geocode_hospitals.py`,
`build_quality_extra.py`, `download_inputs.py`, `build_maternity.py`, `verify_against_cms.py`. The first run takes roughly
10–30 minutes (mostly downloads and the Census batch geocoder); later runs reuse `data/raw/` and `.geocode-cache.json`.

If a step fails, read its error, fix the cause (usually a network hiccup or a moved URL), and re-run `build_all.py`, or
just that step's script. Every step can be run on its own.

**Expected outputs** (all git-ignored):

| File | Built by |
| --- | --- |
| `assets/places.js`, `assets/state-shapes.js` | `build_places.py` |
| `data/core/hai.csv`, `hcahps.csv`, `psi90.csv` | `build_core_tables.py` |
| `assets/data.js` | `refresh_data.py --local` |
| `assets/hospital-locations.js`, `assets/zip-centroids.js` | `geocode_hospitals.py` |
| `assets/quality-extra.js`, `data/fabric/hospital_outcomes.csv`, `state_outcomes.csv` | `build_quality_extra.py` |
| `assets/maternity.js`, `assets/maternity-access.js`, `data/fabric/maternity_*.csv`, `state_maternity.csv` | `build_maternity.py` |
| `assets/verification.js` | `verify_against_cms.py` |

## 3. Check the build

```sh
ls -la assets/*.js data/core data/fabric
python3 verify_against_cms.py   # re-derives Fig 1 from CMS's own files; exits 0 and prints "ALL MATCH" when consistent
```

`refresh_data.py` prints a summary such as `Wrote assets/data.js: 3,493 hospitals · HAI 2025 · HCAHPS 2025 · PSI-90 2024`.
The counts change when CMS publishes newer data or when `cms_archive.py` is updated.

## 4. Run the dashboard

```sh
python3 -m http.server 8000     # from the repository root
```

Open http://localhost:8000/. Check, ideally in a browser you can drive:

- The **Overview** tab shows hospital counts and the data-source table.
- **Quality & safety** draws all nine sections without console errors; picking a state in the left rail updates the charts.
- Section 04 (Maternity): the map loads and searching a town (for example "Bemidji, MN") shows the nearest hospitals and routes.
- **Insights and takeaways** lists thirteen findings.

Map tiles, road routing and address search are live web services (OpenFreeMap/VersaTiles, the OSRM demo server, the
Census geocoder and Nominatim); they need internet access and have usage limits.

Opening `index.html` straight from disk (`file://`) also works in most browsers, because every data file is a script.

## 5. Optional: publish to Microsoft Fabric

Only do this when asked. It needs:
- the Azure CLI, signed in with `az login` to the tenant that owns the Fabric workspace;
- a Fabric workspace on a **running** capacity (F SKU or trial), where the signed-in user is a Member or Admin;
- `pip install pyarrow`; for the app, Node.js 20, 22 or 24.

Ask the user for the **workspace ID** (the GUID in the workspace URL `https://app.fabric.microsoft.com/groups/<id>/...`).
Never write it into a committed file; pass it on the command line or in an environment variable.

### 5a. Data: lakehouses and semantic models

Run after section 2 (it reads `data/core/` and `data/fabric/`):

```sh
python3 publish_fabric.py --workspace <workspace-id>          # both models
python3 publish_fabric.py --workspace <workspace-id> --core    # only "CMS"
python3 publish_fabric.py --workspace <workspace-id> --v2     # only "CMS V2"
python3 publish_fabric.py --print-tmdl core                   # show the model definition without calling Azure
```

This creates (or updates) the lakehouses `lh_cms_core` and `lh_cms_v2` and the Direct Lake semantic models **CMS**
(tables `HAI`, `HCAHPS`, `PSI90`) and **CMS V2** (outcomes and maternity tables with measures), refreshes them and runs
a DAX check. It prints the **CMS** model's ID. To build the dashboard's core data from that model instead of the local
files:

```sh
python3 refresh_data.py --workspace <workspace-id> --model <cms-model-id> --workspace-name "<workspace name>"
```

The result must be identical to `refresh_data.py --local` (same tables, same arithmetic); when it is, the Fig 1 Explain
panel shows the exact DAX that ran.

### 5b. App: host the dashboard as a Fabric App (Rayfin)

Run after section 2 (the build refuses to package an app without its data):

```sh
cd fabric-app
npm ci
npm run preview                                   # optional: serves the packaged dist/ at http://127.0.0.1:5173
npx rayfin login
npx rayfin up --workspace-id <workspace-id>       # first deploy: creates the Fabric App and uploads the site
```

The deploy prints a hosting URL (`https://<name>.webapp.fabricapps.net`). Add it under `allowedRedirectUris` in
`fabric-app/rayfin/rayfin.yml` and deploy again with `npx rayfin up staticapp deploy` so viewers can sign in. Later
updates only need `npx rayfin up staticapp deploy`. The app is private (`assetAccess: protected`): viewers sign in with
their Fabric account. Rayfin keeps the deployment target in `fabric-app/rayfin/.env` and `.deployments.json`, which are
git-ignored; leave them that way.

## 6. Updating to newer CMS data

`cms_archive.py` pins the CMS archive snapshot used for each table and report year (a report year is the year a
measurement period ends). To add a year:

1. List the snapshots: `curl -s https://data.cms.gov/provider-data/api/1/archive/aggregate/theme/hospitals/relative`.
2. Pick the snapshot whose HAI/HCAHPS/PSI-90 file covers the new period (check the files' Start Date and End Date).
3. Add it to `SNAPSHOTS` in `cms_archive.py`, then run `build_all.py` (or steps 2–3 and 8).

The other scripts read CMS's current files (`build_quality_extra.py --refresh`, `download_inputs.py --refresh`). The
Provider of Services and cost-report URLs in `download_inputs.py` and `build_maternity.py` are for specific releases;
update them when CMS publishes newer ones.

## Rules

- **Never commit data.** `.gitignore` excludes every generated file (`data/raw/`, `data/core/`, `data/fabric/`,
  `.geocode-cache.json` and the generated `assets/*.js`). If `git status` shows any of them, do not add them.
- **Never commit identifiers or secrets**: no tenant, subscription, workspace, model or item IDs, hosting URLs, tokens or
  `.env` files.
- `data/nicu_levels.csv` is a hand-curated list of NICU levels with a source link per row. It is representative only and
  may be out of date; don't present it as authoritative, and keep the source URL when editing a row.
- Keep the README's demo disclaimer.
- Respect the public services' limits: the OSRM demo server and Nominatim allow about one request per second.
  `build_maternity.py --calibrate` makes 160 routing calls; run it only when asked.
