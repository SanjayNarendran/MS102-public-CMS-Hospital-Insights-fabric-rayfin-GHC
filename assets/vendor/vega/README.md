# Vega and map shapes for Ask your data

Loaded on demand by `assets/js/chat/` when an answer contains a Vega-Lite visual or a map figure. The scripts are the
published builds from jsDelivr. `build_places.py` downloads the map data, `us-states-10m.json`, along with the rest
of the data (`build_all.py`).

| File | Package | Version | Licence |
|---|---|---|---|
| `vega.min.js` | vega | 6.2.0 | BSD-3-Clause (`LICENSE-vega.txt`) |
| `vega-lite.min.js` | vega-lite | 6.4.3 | BSD-3-Clause (`LICENSE-vega-lite.txt`) |
| `vega-embed.min.js` | vega-embed | 7.0.2 | BSD-3-Clause (`LICENSE-vega-embed.txt`) |
| `vega-interpreter.js` | vega-interpreter | 2.2.1 | BSD-3-Clause (Vega project, `LICENSE-vega.txt`) |
| `topojson-client.min.js` | topojson-client | 3.1.0 | ISC (`LICENSE-topojson-client.txt`) |
| `us-states-10m.json` | us-atlas (`states-10m.json`) | 3.0.1 | ISC (`LICENSE-us-atlas.txt`) |

- Vega and Vega-Lite match the versions bundled in `vl-convert-python` (see `copilot/requirements.txt`), which checks
  every spec on the server, so a spec that passes there draws the same way in the page. Upgrade them together and
  update `VL_VERSION` in `copilot/tools.py`.
- `vega-interpreter.js` lets Vega evaluate expressions without `eval()`, so the page needs no `unsafe-eval`.
- d3 7.9.0 is `assets/vendor/d3.min.js` (ISC, `assets/vendor/LICENSE-d3.txt`).
