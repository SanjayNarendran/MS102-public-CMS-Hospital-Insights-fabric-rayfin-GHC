# Who asks what of CMS and CMS V2

The questions people across a health system ask of the dashboard's two semantic models, CMS and CMS V2 (outcomes,
penalties, emergency care and maternity care), and the figures that answer them, the dashboard's own among them.

It drives:

- the starter questions on the Ask your data tab (`STARTERS` in `assets/js/chat/ask.js`);
- the questions the right-click panel suggests (`suggestions()` in `assets/js/chat/panel.js`);
- the model's choice of figure (`rules.py` and the tool descriptions in `tools.py`).

## What the models can answer

**CMS**: hospital × report year, 2019–2025. Tables relate on facility-year.

| Table | What's in it | Direction |
| --- | --- | --- |
| `HAI` | Six infections (CLABSI, CAUTI, SSI after colon surgery, SSI after abdominal hysterectomy, MRSA, C. diff), each with its SIR, observed and predicted infections, 95% CI and device days or procedures | Lower is better; 1.0 = as predicted |
| `HCAHPS` | Summary star rating and ten survey dimensions, as star ratings and linear mean scores | Higher is better |
| `PSI90` | PSI‑90 composite and its component rates per 1,000 eligible discharges. 2019 and 2021–2024; CMS published no 2020 release | Lower is better; 1.0 = expected |

**CMS V2** (Direct Lake on `lh_cms_v2`): the latest CMS release only, with no years.

| Table | What's in it |
| --- | --- |
| `hospital_outcomes` | One row per hospital: overall star rating, ownership, 30-day death and readmission rates by condition, ED median minutes and volume, sepsis care (SEP‑1), the HRRP excess readmission ratios, HAC score and payment cut, VBP score, and counts of measures better or worse than the nation |
| `state_outcomes` | One row per state: hospitals, ED median minutes, average star rating, five-star hospitals, HAC payment cuts |
| `maternity_hospitals` | Every hospital that delivers babies, has a NICU or stopped delivering: location, NICU beds and level, birthing-friendly designation, hospital type |
| `maternity_tracts` | 84,000 census tracts with women aged 15–44 and estimated drive minutes to the nearest delivering hospital and NICU. Always aggregated by state or band |
| `state_maternity` | One row per state: women 15–44, women more than 30 and 60 minutes from delivery care or a NICU, delivering and NICU hospitals |

The two models share the CCN (`'HAI'[facility id]` in CMS, `[ccn]` in CMS V2). A question that needs both, such as
"Do hospitals with HAC payment cuts have more infections flagged worse?", runs one query on each and matches on CCN.

Copilot says so, and offers the nearest answer, when a question needs something the models don't hold:

- bed size, teaching status or system membership (city, state, ownership or hospital type can stand in);
- cost, payments in dollars, or monthly, unit or patient-level data;
- outcomes or penalties over time (CMS V2 has one period);
- road travel times (the maternity drive times are estimates from straight-line distance).

## Questions by role

Figures in the first column of answers are the dashboard's own (`show_dashboard_figure`, redrawn in the answer with
the question's infection, state or measure); the rest are templates (`show_figure`). Copilot chooses for itself; these
are the intended defaults.

### Executive leadership

| Question | Figures |
| --- | --- |
| How have infections, patient experience and PSI‑90 moved since 2019? | Fig 2 `infection_change`, Fig 7 `star_mix`, Fig 9 `psi_spread` |
| How is our hospital doing against hospitals nationally or in our state? | `report_card` (every measure against its peer spread, with significance) |
| Which states have the largest share of hospitals losing Medicare payments? | Fig 16 `penalties`, `tile_map` |
| How many of our state's hospitals have four or five stars? | Fig 13 `overall_stars` for the state |

### Quality and patient safety

| Question | Figures |
| --- | --- |
| Which hospitals are significantly worse than expected for an infection, given their size? | Fig 4 `funnel`, then `forest` for the outliers |
| Which PSI components rose most since 2019? | Fig 10 `psi_components`, `lollipop` |
| Has the spread of PSI‑90 across hospitals narrowed? | Fig 9 `psi_spread`, `fan` |
| Where does our hospital sit on PSI‑90 among all hospitals? | `beeswarm` with quartiles and a highlight |

### Infection prevention

| Question | Figures |
| --- | --- |
| How did each infection move through COVID and after? | Fig 1 `infection_trends`, Fig 2 `infection_change` |
| Project the national CLABSI and CAUTI ratios to 2030 | `trend` with `options.project` |
| Which hospitals account for most of the excess C. diff infections? | `pareto` |
| Has the share of hospitals flagged worse for CAUTI changed? | Fig 3 `infection_flags` |
| Is our hospital better or worse than expected on each infection? | `forest` |

### Nursing

| Question | Figures |
| --- | --- |
| Is better nurse communication linked to fewer catheter infections? | `scatter` with a trend line |
| Which states have the highest pressure ulcer rates? | `tile_map`, `ranked_bars` |
| How has nurse communication changed since 2019? | Fig 8 `survey_change`, `heatmap` with `change_from` |

### Patient experience

| Question | Figures |
| --- | --- |
| How has the HCAHPS star mix changed since 2019? | Fig 7 `star_mix`, `likert` |
| Which survey questions still score below 2019, and in which states? | Fig 8 `survey_change`, `heatmap` |
| Are five-star hospitals also safer? | Fig 11 `star_flags`, Fig 12 `psi_by_star` |
| How many hospitals moved up or down a star? | `alluvial` |

### Finance and penalties

| Question | Figures |
| --- | --- |
| Which hospitals lost payments under both the HAC and readmissions programs? | Fig 16 `penalties`, `scorecard` |
| Do hospitals with HAC payment cuts also have more infections flagged worse? | `columns` (share flagged, cut or not), two queries matched on CCN |
| Which conditions push our readmission ratios above 1? | `diverging_bars` on the HRRP excess readmission ratios |
| Which states have the most hospitals with HAC payment cuts? | `tile_map`, `ranked_bars` |

### Emergency care

| Question | Figures |
| --- | --- |
| Which states keep emergency patients longest? | Fig 14 `ed_by_state` |
| Do busier emergency departments keep patients longer? | `distribution` grouped by ED volume |
| Do hospitals with longer emergency stays do worse on sepsis care? | `scatter` |

### Outcomes

| Question | Figures |
| --- | --- |
| How much do heart failure death rates vary between hospitals? | Fig 15 `outcome_ranges` |
| Which hospitals in our state have death rates worse than the nation? | `scorecard`, `forest` |
| Do hospitals with more stars have lower death rates? | `distribution` grouped by star rating |

### Maternity care

| Question | Figures |
| --- | --- |
| Where do women live more than an hour from a NICU? | `tile_map` or `geo_map` of the share, from `state_maternity` |
| Which hospitals in a state deliver babies, and which have a NICU? | `dot_map`, then `scorecard` |
| How many hospitals have stopped delivering babies in each state? | `ranked_bars`, `dot_map` |
| How many women in each state live more than 30 minutes from delivery care? | `stacked_bars` by drive-time band |

### Families and travel (places and roads)

Questions about where someone is or is going. `nearby_hospitals` and `route_care` (`copilot/geo.py`) locate the place
(GeoNames towns, Census ZIP centres, geocoded hospital addresses, then OpenStreetMap) and route by road (OSRM).

| Question | Tools and figures |
| --- | --- |
| I'm driving from Cottage Grove, MN to Colorado Springs with my pregnant wife. Will we be far from a hospital that delivers babies? | `route_care`: the road coloured where delivery care is more than 30 or 60 minutes away, the hospitals near it, and a mile-by-mile profile; facts include every delivering hospital along the way with its phone number |
| Is Chicago to Nashville or Chicago to Kansas City the safer drive at 34 weeks? | `route_care` twice, compared |
| We live in Ely, MN and are expecting twins. How far is the nearest NICU? | `nearest_care` (kind nicu): a street map with the routes, drive times and phone numbers |
| (On the maternity map, after a search from a spot near Hastings) I can't go near St Paul because of roadblocks. What else is near? | `nearest_care` from the search's point (its lat, lon from the [On screen] block), avoid St Paul: its hospitals are left out and the routes go around it; the dashboard's map shows the same search |
| What's the nearest emergency department to Rochester, MN that isn't a Mayo Clinic hospital? | `nearest_care` (kind emergency, exclude Mayo) |
| (After a map search near Springfield, CO) I can't go to Texas. What are my next best options? | `nearest_care` avoiding Texas: a whole state is its outline, so its hospitals are left out and routes are checked against its border |
| Which hospitals within 30 miles of 60614 have the best patient experience? | `nearby_hospitals`, then DAX filtered to their CCNs, `scatter` or `scorecard` |
| Compare Mayo Clinic Rochester with the five nearest hospitals | `nearby_hospitals` (kind acute), then `heatmap`, `forest`, `trend` |

### Public health

| Question | Figures |
| --- | --- |
| How has each state's infection ratio changed since 2019? | Fig 5 `state_map`, `dumbbell`, `slope` |
| How did state rankings change? | Fig 6 `state_ranks`, `bump` |
| How much do hospitals vary within each state? | `beeswarm` or `distribution` grouped by state |

## Right-click suggestions

The panel reads what was right-clicked (a tooltip, a KPI, a map feature, a table row, a finding, selected text), finds
its dimensions and offers up to six questions. "Explain this" always comes first. The maternity map, the hospital
street map and the explorer describe their own state (`describe()` in `maternity.js`, `hospital-map.js`, `explorer.js`):
a search on a map adds questions about it ("What are my options if I can't go into Saint Paul?", "Which other
hospitals that deliver babies are within an hour of this spot?"), and Quick chat opened from its button suggests the
same about the visual used last.

| What was pointed at | Suggestions |
| --- | --- |
| A hospital on a time series | How it changed since 2019, its report card, a projection to 2030, hospitals in its state that do better |
| A hospital elsewhere | Infections, safety and experience since 2019, its report card; nearby delivering hospitals on the maternity maps |
| A state | How it compares with the nation, a five-year projection, the hospitals that drive it, change since 2019 |
| A national series or KPI | A five-year projection, change between 2019 and the year pointed at, variation by state, hospitals worse than expected |
| A star rating | What sets those hospitals apart on infections and safety |
| Penalties, ED, outcomes, maternity | The questions of that role above, for the state if one is in view |

## Figures, in order of preference

1. **The dashboard's figures** (Figs 1–16), redrawn in the answer with **Show on the dashboard**. A search on the
   street map or the maternity map is redrawn by `nearest_care` (`care_map`, `assets/js/chat/caremap.js`), with
   **Show on the map**.
2. **Templates** in `assets/figures/`:

   | Intent | Templates |
   | --- | --- |
   | Headline | `kpis`, `gauge` |
   | One hospital across many measures | `report_card` |
   | Position among peers | `beeswarm`, `distribution` |
   | Significance against a benchmark | `forest`, `funnel` |
   | Ranking and lookup | `ranked_bars`, `diverging_bars`, `bullet`, `scorecard`, `table` |
   | Change between two periods | `dumbbell`, `slope`, `lollipop` |
   | Over time | `trend` (with projections), `small_multiples`, `fan`, `bump`, `area_stack` |
   | Movement between categories | `alluvial` |
   | Geography | `tile_map`, `geo_map`, `dot_map` (options.zoom = "points", options.center) |
   | A drive and the care along it | `route_care` (its own tool and figure) |
   | Nearest care from a place or a map point, routes, places to avoid | `nearest_care` (its own tool and figure) |
   | Two dimensions | `heatmap` |
   | Relationships | `scatter` |
   | Composition | `likert`, `columns`, `stacked_bars`, `treemap`, `waffle` |
   | Contribution and concentration | `waterfall`, `pareto` |

3. **Vega-Lite** (`render_visual`), checked on the server with vl-convert and themed like the dashboard.
4. **Custom d3** in a sandboxed frame with no network, for what Vega-Lite can't draw.
