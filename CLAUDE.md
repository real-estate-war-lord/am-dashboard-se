# AM Dashboard — Sweden edition

A public, open-data macro/market dashboard for the Swedish housing market, built as a
sibling to the finished Danish one. Single self-contained HTML page, data pipeline in
plain Python (stdlib only), published on GitHub Pages.

**Reference implementation:** https://github.com/real-estate-war-lord/am-dashboard-dk
(currently v1.9). Its `src/app.js`, `src/style.css` and `scripts/build_*.py` are the
design and the calc engine to port — the UI is entirely driven by `window.DATA`, so the
port is a data-contract exercise, not a redesign. Read its `CHANGELOG.md` before porting:
v1.9 is breadcrumb navigation, quintile legend, grouped indicator picker with quick
chips, area pages with a headline row and tabs, two-level map popups, a Charts view,
full-screen map and CSV export.

## Status

Done:
- `scripts/scb.py` — SCB PxWebApi v2 client (metadata, selection planning, chunking, json-stat2 flattening). All offline logic covered by `scripts/selftest.py`.
- `scripts/fetch_scb.py` — deep raw pull driven by `config/tables_se.json`; resumable, gzip output.
- `scripts/fetch_geo_scb.py` — boundaries. **Already downloaded**: `data/geo/raw/regso_2025.geojson` (3 363 features) and `deso_2025.geojson` (6 160), both EPSG:4326, plus `kommun_lan.zip` (needs `ogr2ogr`, i.e. `brew install gdal`, or derive kommun outlines by dissolving RegSO on `kommunkod`).
- `data/raw/*.meta.json` — metadata for 65 tables **already on disk**. Every value code, label, unit and update timestamp is there; resolve indicator codes from these files, never by guessing and never by re-fetching.

Next, in order:
1. `python3 scripts/discover_scb.py` — resolves the tables known only by their old v1 path (unemployment, mortgage rates, GDP, assessed values, building permits) into v2 `TABxxxx` ids. Searches in Swedish.
2. `caffeinate -i python3 scripts/fetch_scb.py 2>&1 | tee data/raw/_console.txt` — the full pull, ~37.5 M cells, 864 calls, 45–90 min, ~450 MB gzipped. Resumable: re-running skips finished pulls and retries failed ones.
3. Build `config/indicators.json` (registry) from the metadata on disk + `docs/DATA_MAP_SE.md` §1.
4. Port `build_makro.py` / `build_market.py` / `build_dashboard.py` / `app.js` from the Danish repo.
5. `make build && make serve`, spot-check, publish.

## Geography — three levels, and the vocabulary differs from Denmark

| Denmark | Sweden | count |
|---|---|---|
| kommune | kommun | 290 |
| postnummer | **RegSO** (named neighbourhoods) | 3 363 |
| Copenhagen kvarter | **DeSO** (national, codes only) | 6 160 |
| Buildings / BBR layer | **no equivalent** — Sweden has no open building register with floor area | — |

Rename the level vocabulary throughout: `kommune`→`kommun`, `postnr`→`regso`, `kvarter`→`deso`.
Every DeSO polygon carries `regsokod`, `kommunkod` and `lanskod`, so DeSO → RegSO → kommun →
län is an attribute rollup, never a spatial join. The Danish Buildings layer has no Swedish
counterpart; the area page fills that slot with the DeSO-level age × sex pyramid, income-type
structure and tenure mix instead.

**Vintage trap:** SCB re-cut both divisions on 2025-01-01. Region codes are suffixed
(`0114A0010_DeSO2025`, `0114R001_RegSO2025`); older tables still use the unsuffixed
2018/2020 codes. Each pull records which vintage it used in its `.state.json`. Never join
across vintages silently.

## SCB API — rules learned the hard way, all verified live

Base `https://api.scb.se/OV0104/v2beta/api/v2/`, no key, licence CC0 (attribute
"Källa: SCB" anyway). Limits: 30 calls / 10 s, **150 000 cells per call**.

1. **Never repeat a `valueCodes[X]` parameter.** Two of the same key returns HTTP 200 with
   all but the first value silently dropped — data loss with no error. Multiple values go in
   one comma-separated parameter. `scb.py` builds queries so this cannot happen; keep it that way.
2. `range(a,b)` and `top(n,offset)` are **unusable over GET** — the comma is the value
   separator, so both 400 even percent-encoded. Selections are resolved to explicit codes
   from metadata instead.
3. `top(N)` on the **time** dimension means the *newest* N periods (inverted versus every
   other dimension).
4. Level masks: `valueCodes[Region]=????` → exactly 290 kommuner; `*_RegSO2025` → 3 363;
   `codelist[Region]=vs_RegionKommun07EjAggr` where a table offers it (lowercase `l` in
   `codelist`, capital `C` in `valueCodes` — both spellings matter).
5. A 400 on a wildcard call usually means the **cell limit**, not bad syntax.
6. `+` must be `%2B`; non-ASCII codes (`SMÅHUS`, `ÖVRIGT`) must be UTF-8 percent-encoded.
7. Parse **json-stat2**, not CSV: it carries `size` (exact row count for validation),
   `updated` (provenance), `category.unit` and `extension.discontinued`.
8. URLs are capped near 2 100 characters; longer selections go over POST (untested — `scb.py`
   falls back to GET batches automatically if POST fails).

## Conventions

- English everywhere in code, docs and UI. Swedish source terms kept verbatim where they are
  the precise ones: kommun, hyresrätt, bostadsrätt, allmännytta, bruksvärde, K/T-tal, RegSO, DeSO.
- One indicator = one entry in `config/indicators.json`; no numbers hard-coded in `app.js`.
- Every processed number carries its period and the source's `updated` stamp.
- **Margins of error are first-class.** `TAB4590` (rent) is a ~16 000-apartment sample survey and
  ships `± Felmarginal` as its own ContentsCode; SCB also perturbs small-area values for disclosure
  control. Render the ±, and grey or suppress kommuner whose margin is too wide. False precision is
  the easy mistake here.
- Suppressed values (`..` / null) stay null and render as `–`. **Never imputed, never 0.**
  Sanity check: Malå (2418) is fully suppressed in TAB4590; Stockholm (0180) 2025 is median
  1 710 SEK/m²/yr ±28, mean 1 734 ±19.
- **The price chip is labelled K/T-tal** (purchase price ÷ assessed value), never "price per m²".
  Sweden publishes no open realised price per m² at any geography; claiming otherwise would be wrong.
  Known gaps to state plainly in the README: no price/m², no bostadsrätt prices below län, no
  private-vs-allmännytta rent split below six national groups.
- Commit messages: `feat:`, `data:`, `fix:`, `docs:`.

## Don'ts

- Don't re-fetch what is on disk. Metadata and geometry are already downloaded; the fetcher is
  resumable and skips finished pulls.
- Don't narrow a breakdown to save bandwidth. Age and sex splits are deliberately pulled in full —
  they are what makes a RegSO/DeSO area page worth opening. `pin` in `config/tables_se.json` is used
  only where a dimension holds alternative definitions of the same measure (TAB6680's seven
  overlapping age spans) or bookkeeping series (CPI weights).
- Don't invent indicator codes. They are all in `data/raw/*.meta.json`.
- Don't commit `data/raw/*.jsonl.gz` (regenerable and large). Metadata, geometry and
  `data/processed/*.json` do get committed.

## Reference docs

`docs/DATA_MAP_SE.md` (what data exists, indicator-by-indicator), `docs/BUILD_PLAN_SE.md`
(architecture and phases), `docs/RUNBOOK_SE.md` (step-by-step with commands). If those files are
not in `docs/` yet, they live in the Claude project "AM dashboard - Danish version".
