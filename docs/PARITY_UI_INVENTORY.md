# Danish v2.0–v2.5.1 UI pieces — present or missing here

Surveyed 2026-09-24 against the reference repo (read-only) at
`~/Desktop/Denmark dashboard, funny project/am-dashboard-dk`, `main` = v2.5.1,
`src/app.js` 3 639 lines. This repo is v1.1.1, `src/app.js` 1 339 lines — a clean
port of the Danish **v1.9** shape, so everything v2.0 and later is missing.

Line numbers are the Danish `src/app.js` unless stated.

## What the Danish v2.x releases shipped

| Version | Shipped |
|---|---|
| v2.0 | Safety layer from DST `STRAF11`/`STRAF22`; registry fields `direction`, `note`, `chip`, `history_from`, `map_from`, `breaks`; direction-aware ranks and delta colours; Yearly \| Quarterly chart toggle; rolling-window year labels; `tests/test_safety.py` |
| v2.1 | Infrastructure overlay, 51 curated projects; four status tones; project datasheet `#project/<id>`; **Pipeline** view + its own CSV; indicators `projects_upcoming`, `stations_planned_1200m` |
| v2.2 | Public-buildings overlay (BBR 410–449) + open building cases; **legend-is-filter** (click toggles, shift-click isolates, state in the URL); building sheet `#public/<kommune>/<id>` |
| v2.3 | School quality from STIL; school datasheet `#school/<nr>`; **grade colour mode** — 5-step quintile ramp when Education is isolated |
| v2.4 | `src/testprop.js` pin from a Google Maps link; point-in-polygon on our own rings; **Analysis sheet** `#analysis`; stacked overlay legends; one canvas renderer per map |
| v2.5 | Population **Outlook** (diverging colour model, third direction `neutral`); Services overlay (44 181 points, per-kommune files, zoom floors); **verify-at-source** links + `scripts/check_source_links.py` |
| v2.5.1 | Zoom ladder removed — **zooming is a camera movement, never a selection**; quick jumps + C/D keys; canvas-renderer guard; `make links` split out of `make validate` |
| unreleased | Climate lives on branch `v2.5-climate` (8 scripts, `tests/test_climate.py`), never tagged, no CHANGELOG entry. **Phase 6 follows it as a convention source, not as a released reference.** |

## Already present here

| Piece | Location in this repo |
|---|---|
| quintile `scaleOf` / `mkShade` / `legendHtml` / `setLegend` | `src/app.js` L291–331 |
| `rankOf` — but direction-blind | L413–417 |
| breadcrumbs, `VIEWS`, `NAV_GROUPS` | L166–190 |
| area pages with tabs, `areaCompareTable` / `areaSubTable` | L651–683, `vArea` L752 |
| Charts (line/bar/distribution), PNG + CSV export | L1043–1236 |
| `exportCsv` / `downloadCsv` / `exportAll` | L517–551 |
| full-screen map | L1029 |
| `pip()` point-in-polygon + `areaAt` | L854–855 |
| lazy per-kommun files — **DeSO polygons only** | `loadDeso` L861–876 |
| two-level popups | L833–966 |
| **margins of error** (`MOE`, `moeOf`, `moeWide`, `moeSpan`) — no Danish equivalent | L110, L451–456 |
| categorical indicators (`cat` fmt, `catsOf`/`catOf`) — no Danish equivalent | L290 |
| distribution cards in the Danish Buildings slot | L687–751 |
| headless render test | `tests/smoke.js`, 387 lines |
| `make validate`, `make verify` | `scripts/validate_indicators.py`, `verify_scb.py` |

## Missing — the parity backlog

| Piece | Note | Phase |
|---|---|---|
| `direction` / `lowerBetter` / `neutralDir` | **0 of 44 indicators carry `direction`.** `rankOf` is `1 + vals.filter(x => x > v).length` — always "highest is #1". `cls` at L607 is `d > 0 ? "up" : "dn"`, sign-blind. | 1 |
| diverging scale (`scale`/`center`/`hue_neg`/`hue_pos`) | `scaleOf` is quintiles only. Needed by Outlook. | 1 |
| Yearly \| Quarterly toggle | No `CH.fq`, no `q_periods`, no `data-chfq`. | 1 |
| overlay-pill framework | No `mkTools()`; the toolbar is inline in `vMakro` L437. Each overlay is five hooks: a state flag, a `data-*` button, a `lf*Layers()` builder, a legend, a hash part. | 1 |
| stacked `.maplegs` legend column | One `<div class="maplegend">` at L440; no `.maplegs` in `style.css`. `.maplegend:empty{display:none}` is what stops a stale white bar. | 1 |
| canvas-renderer guard + `lfDrop` | This map is SVG-only today so nothing crashes — but the guard must land **before** any point layer. 12 lines. | 1 |
| verify-at-source + `make links` | Indicators carry `sources[{db,table,geo,vars,vintage,pull}]` — enough raw material; the URL builder and the checker do not exist. SCB PxWeb v2 GET is the analogue of the Danish CSV query. | 1 |
| quick jumps + keyboard | No `MAP_JUMPS`, no camera-only handler. Here: S / G / M / W. | 1 |
| datasheet pattern | No `#project`, `#public`, `#school` routes. | 4, 7 |
| lazy per-kommun **point** layers | `loadDeso` loads polygons; no bbox manifest, no `*_MAX_FILES` cap, no zoom floor, no viewport-gated fetch. | 4, 7 |
| `testprop.js` + pin + rings | Nothing. `pip()` exists; `inPoly` (shell+holes), `komLoad`, `locate`, `havM`, `featDistM` do not. No `make test-js`. | 5 |
| Analysis sheet | No `analysis` view, no second `NAV_GROUPS` entry. | 5 |
| **Compare two pins** | **Missing in _both_ repos.** Branch `v2.5-compare` has zero commits ahead of its merge base; the Danish "compare" is `areaCompareTable()`, the area page's indicator table, not a two-pin comparison. Phase 5 is therefore new work with no reference to port. | 5 |
| Pipeline view + infra CSV + infra geojson | No infra data at all. | 7 |
| grade colour mode / school layer | | 4 |
| climate overlay | Danish reference is the unreleased branch only. | 6 |

## Porting order

Three are prerequisites for the rest and cost little — Phase 1 does them first:

1. **`direction` on every indicator** + `lowerBetter`/`neutralDir`/`cls`/`rankOf`. A registry
   field plus ~10 lines. `scripts/validate_indicators.py` should then *require* it, and
   `tests/smoke.js` already has the "every indicator's `fmt` exists" pattern to copy.
2. **The canvas guard + `lfDrop`** — must precede any point layer.
3. **`.maplegs` + `setLegend` calling every overlay legend** — the container has to exist
   before the second legend does.

Then `testprop.js` (self-contained and testable offline), then the overlay-pill framework,
then the Analysis sheet, which consumes all of them.

## Danish file paths worth quoting exactly

- infra geometry: `data/geo/infra_projects.geojson` (→ `dist/`), built by `scripts/build_infra.py`
  from `data/external/infra_projects.csv`. Feature properties, identical on all 51 features:
  `id, name, label_short, type, status, open_year, open_window, open_year_original,
  budget_mdkk, agency, kommuner, parent_id, schematic, map, source_url, source_doc,
  geometry_source, updated, notes`. A row whose source yields nothing keeps
  `"geometry": null` — nothing is invented.
- `geometry_source` grammar: `fingerplan:<layer>:…` · `osm:<Overpass QL>` · `manual:<lon>,<lat>` ·
  `manual:wkt:<WKT>` · `stations` · empty.
- Pipeline CSV header (`;`-separated, BOM-prefixed):
  `id;name;type;status;open_year;open_window;open_year_original;budget_mdkk;agency;kommuner;schematic;source_url;source_doc;updated;notes`
- lazy per-kommune convention: `<layer>/<4-digit zero-padded code>.json` under `dist/`, with the
  manifest inlined in `window.DATA`; every loader guarded by `if (cache[k] || cache["_loading_"+k]) return`.
- `MAP_JUMPS` / `mapJump()` does `fitBounds` and **nothing else** — no selection, no `syncHash`, no popup.
