# Instructions for AI coding agents

You are working in a repository that **contains code but no data**. Setting it up touches several systems (public data
downloads, and optionally Microsoft Fabric, Azure, GitHub Copilot and a GitHub OAuth App), so the README asks people to
have an agent do it rather than follow the steps by hand. Work through the sections in order, run the checks, and report
what you did. Do not commit generated data or identifiers (see "Rules").

## Start here: ask what the user wants

Before running anything, ask the user, in one message, which of these they want. Explain what each one needs so they
can decide, and wait for the answer.

1. **The dashboard on this computer** (always). Needs Python 3.10+, internet access, about 3 GB of disk and 10–30
   minutes for the first data build. No accounts. Sections 1–4.
2. **Microsoft Fabric** (optional). Loads the data into lakehouses and two semantic models (**CMS** and **CMS V2**),
   and/or hosts the dashboard as a Fabric App that viewers open with their Fabric sign-in. Needs a Fabric workspace on a
   running capacity (F SKU or trial) where they are Member or Admin, the Azure CLI signed in (`az login`), and for the
   app Node.js 20, 22 or 24. Section 5. Ask for the **workspace ID** (the GUID in
   `https://app.fabric.microsoft.com/groups/<id>/...`).
3. **Ask your data, the GitHub Copilot chat** (optional). Ask: "Do you also want the chat experience?" and list what it
   involves:
   - **On this computer** (section 6), the chat runs beside the dashboard at http://127.0.0.1:8765:
     - a GitHub account with a GitHub Copilot plan (each question uses that plan's requests), signed in with
       `copilot login` (GitHub Copilot CLI) or `gh auth login` (GitHub CLI), or a token pasted into the page;
     - the **CMS** and **CMS V2** semantic models in Fabric (item 2, data part), on a capacity that is running while
       the chat is used, and `az login` with access to that workspace, because the chat answers with DAX queries;
     - Python 3.11+.
   - **In the Fabric-hosted app** (section 7), in addition:
     - the Fabric App deployed (item 2, app part);
     - an Azure subscription where they can create a resource group, a Container Apps environment, a container
       registry (Basic tier, a small monthly charge) and a Container App that runs the chat relay (it scales to zero
       when idle);
     - a GitHub OAuth App that **the user** registers on github.com, and its client secret, which **the user** stores
       in Azure with a command you give them; you never see or handle the secret;
     - every viewer signs in with GitHub and needs their own Copilot plan;
     - the app gains Rayfin Functions, a Rayfin Data database for saved chats and a lakehouse `lh_cms_chats` in the
       app's workspace.

Skip the sections the user doesn't want. If they want the chat in Fabric, do sections 5a, 5b, 6 and 7 in that order.

## 0. What this is

A static dashboard (`index.html`, `assets/js/*.js`, `assets/styles.css`) of U.S. hospital quality and maternity care
access. It loads its data from JavaScript files in `assets/` that **the Python scripts generate from public sources**:
the CMS Provider Data Catalog (Care Compare and its archive), the CMS Provider of Services file and hospital cost reports,
the U.S. Census Bureau (ACS, tract centres, geocoder, ZIP centroids) and GeoNames. It is for demonstration only; its
numbers depend entirely on those sources.

Optionally, **Ask your data** adds a GitHub Copilot chat that answers questions from the semantic models with figures
drawn like the dashboard's (`copilot/` on the server, `assets/js/chat/`, `assets/figures/` and `assets/chat.css` in the
page), opened from its own tab or by right-clicking any chart (Quick chat). It appears only when a chat server is
reachable, so the plain dashboard works without it.

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
| `assets/places.js`, `assets/state-shapes.js`, `assets/vendor/vega/us-states-10m.json` | `build_places.py` |
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
(tables `HAI`, `HCAHPS`, `PSI90`, related on `FACILITYYEARKEY`) and **CMS V2** (outcomes and maternity tables with
relationships and measures), refreshes them and runs a DAX check. Ask your data finds the two models by these names. It prints the **CMS** model's ID. To build the dashboard's core data from that model instead of the local
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
npx rayfin up --workspace-id <workspace-id>       # first deploy: creates the Fabric App
```

If the first deploy stops at "Deploying static content" with `fetch failed`, the new item wasn't ready yet; run the
same command again. The deploy prints a hosting URL (`https://<name>.webapp.fabricapps.net`) and adds it under
`allowedRedirectUris` in `fabric-app/rayfin/rayfin.yml` (add it there if it is missing). Deploy again the same way so
viewers can sign in. That line is specific to the user's deployment: leave it out of commits to a shared repository.
Later updates only need `npx rayfin up staticapp deploy`.

The committed `rayfin.yml` deploys the dashboard alone: Rayfin Data and Rayfin Functions, which only the chat uses, are
switched off, and the build leaves the chat out of the page. Section 7 (`copilot/deploy.py app`) switches them on.

The app is private (`assetAccess: protected`): viewers sign in with their Fabric account. Rayfin keeps the deployment
target in `fabric-app/rayfin/.env` and `.deployments.json`, which are git-ignored; leave them that way.

## 6. Optional: Ask your data on this computer

Only when the user wants the chat. Needs section 5a (the **CMS** and **CMS V2** models) and the prerequisites listed in
"Start here". Check them:

```sh
python3 --version                  # 3.11 or newer for the chat
az account show                    # signed in to the tenant with the Fabric workspace
copilot --version || gh --version  # one of them, signed in (copilot login / gh auth login)
```

Install and start the server, with the workspace that holds the two models:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt -r copilot/requirements.txt
export CMS_WORKSPACE_ID=<workspace-id>        # never write it into a committed file
.venv/bin/python copilot/dev/smoke.py         # calls every chat tool against the models; expect "19 of 19 passed"
.venv/bin/python copilot/server.py            # serves the dashboard and the chat at http://127.0.0.1:8765
```

Open http://127.0.0.1:8765/#ask. The **Ask your data** tab appears in the top bar and lists the GitHub accounts signed
in on the computer; the user picks one (or pastes a token from `gh auth token`). Check:

- A question such as "How have hospital infections, patient experience and PSI-90 moved since 2019?" streams an
  answer with a figure, and its steps show the DAX that ran.
- Right-clicking a state on the infection map opens **Ask Copilot**; picking a question docks Quick chat on the right.
- The chat is listed under saved chats after a reload. Saved chats are kept in `data/chats/` (git-ignored).

If answers say the capacity is paused, resume the Fabric capacity. The server finds the models by name;
`CMS_DATASET_ID` and `CMS_V2_DATASET_ID` override that. `COPILOT_CLI_PATH="$(which copilot)"` runs an installed Copilot
CLI instead of the runtime the SDK downloads. `copilot/TESTING.md` describes the full evaluation (81 questions asked
through the page) and the saved-chats check.

## 7. Optional: Ask your data in the Fabric app

Only when the user wants the chat in Fabric. Needs sections 5a, 5b and 6, the Azure CLI signed in to the subscription
for the relay, and the Fabric capacities behind the app and the models running.

```
Fabric App ──question + ticket──▶ chat relay (copilot/server.py, RELAY=1, Azure Container App) ──▶ the viewer's Copilot plan
  │  ▲                                     │
  │  └──── DAX query / figure request ◀────┘  answered by the page
  ├── Rayfin Functions: chatTicket (signs who the Fabric user is), dax (runs the query on CMS or CMS V2),
  │                     chatPayload (reads and writes saved answers in the lakehouse lh_cms_chats)
  └── Rayfin Data: ChatFolder, ChatThread, ChatTurn (saved chats, each viewer's own)
```

- Every call to the relay carries a ticket from the app's `chatTicket` function, signed with a key the app and the
  relay share (`CHAT_TICKET_KEY`, generated by `deploy.py` and never printed).
- Each viewer signs in to GitHub once with **Sign in with GitHub** (an OAuth popup), so their questions run on their
  own Copilot plan. The token stays in the relay's memory and is lost when the relay restarts or scales to zero.
- The relay has no access to Fabric. It sends each DAX query to the page, which runs it through the app's `dax`
  function and posts the rows back. That function runs as the app's identity (the person who deployed it), which needs
  access to the models' workspace.

Steps (`CMS_WORKSPACE_ID` set as in section 6; every name has a default, see the top of `copilot/deploy.py`):

```sh
python3 copilot/deploy.py create      # resource group, Container Apps environment, registry and Container App
                                      # (each created only if missing) and the chat ticket key; prints the next step
```

`create` prints the values for a **GitHub OAuth App**. Ask the user to register it themselves on github.com (Settings →
Developer settings → OAuth Apps → New OAuth App) with the printed homepage URL and callback URL, then to generate a
client secret and store it by running the printed `read -rs GH_SECRET` and `az containerapp secret set ...` commands in
their own terminal. Never ask for the secret or put it in a command yourself. Then, with the client ID they give you:

```sh
python3 copilot/deploy.py configure <client-id>   # the relay's settings and CORS for the app's address
python3 copilot/deploy.py relay                   # builds the relay image in Azure and rolls the Container App
python3 copilot/deploy.py app                     # chat lakehouse, the functions' settings and dependencies, Rayfin
                                                  # Data and Functions switched on in rayfin.yml, the CHAT_TICKET_KEY
                                                  # secret, then a full `npx rayfin up` (page, functions, data)
python3 copilot/deploy.py status
```

`relay` builds with ACR Tasks; where a subscription doesn't allow them, it uses the local Docker if there is one.
`app` writes `fabric-app/rayfin/functions/src/config.generated.ts` (git-ignored) with the workspace and model IDs and
the relay's address, and runs `npm ci` in `fabric-app/rayfin/functions/` (the functions have their own `package.json`);
from then on the Fabric build includes the chat. Its switches in `rayfin.yml`, like the hosting URL, belong to the
user's deployment. Check: open the app's hosting URL, sign in to Fabric, open **Ask your data**, sign in with GitHub and
ask a question.

After a change to the dashboard or the chat's page code, run `npx rayfin up` in `fabric-app/`; after a change to
`copilot/`, run `python3 copilot/deploy.py relay`. To stop costs, pause the Fabric capacities; the Container App
already scales to zero, and deleting the resource group removes the relay.

## 8. Updating to newer CMS data

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
- **Never commit identifiers or secrets**: no tenant, subscription, workspace, model or item IDs, hosting URLs, tokens,
  `.env` files or `fabric-app/rayfin/functions/src/config.generated.ts`. Keep `data/chats/` (local saved chats) out too.
- **Never handle the GitHub OAuth App's client secret.** The user stores it in Azure themselves (section 7).
- `data/nicu_levels.csv` is a hand-curated list of NICU levels with a source link per row. It is representative only and
  may be out of date; don't present it as authoritative, and keep the source URL when editing a row.
- Keep the README's demo disclaimer.
- Respect the public services' limits: the OSRM demo server and Nominatim allow about one request per second.
  `build_maternity.py --calibrate` makes 160 routing calls; run it only when asked.
