# Changelog

## v1.1.1 — 2026-09-21
- **Fixed: RegSO and DeSO polygons were drawn in the wrong place.** v1.0's size-reduction pass fed already-swapped coordinates to a function that swaps them itself, so the two files were stored [lat,lon] and `build_makro` swapped them once more. Every sub-municipal polygon has been rendering off the Somali coast since v1.0 — the map looked empty below kommun level. Found by taking a screenshot; the smoke test only checked generated HTML. It now asserts that every ring is inside Sweden and that a kommun's sub-areas are inside that kommun.
- **Fixed: zooming threw on every step.** A variable removed in v1.0's level rewrite was still referenced in the `zoomend` handler, so labels stopped being rebuilt as you zoomed.
- **Simplification is now a distance tolerance in metres**, in a local metric frame, instead of an epsilon in degrees — a degree of longitude at 59°N is half a degree of latitude, so the old tolerances were twice as coarse north-south as east-west and left boundaries visibly angular. Kommun 60 m, RegSO 45 m, DeSO 40 m: kommuner 2.9 MB, RegSO 6.6 MB, DeSO 8.8 MB.
- **The archipelago is back.** The skerry filter was 0.32 km², large enough to delete real islands; it is now 0.05 km² and expressed in km² rather than square degrees. Värmdö went from 60 parts to 345, and its bounding box moved 29 km — the outer archipelago had been cut off entirely. Stockholm's outline is unchanged in extent but carries 291 vertices instead of 394; Göteborg 1 375 instead of 1 903, across 63 islands instead of 36.
- **Crisper rendering**: retina basemap tiles (`detectRetina`), stroke weight by level (1.5 px national, 0.8 kommun, 0.4 RegSO/DeSO) instead of thicker the further in you go, and `smoothFactor` down from 1 to 0.25 so Leaflet stops discarding the detail the geometry was built to carry. Polygons were already SVG — `preferCanvas` was never set, so there was no canvas to scale.
- The coastline clip is cached at full precision, so re-tuning a tolerance takes 36 seconds instead of 35 minutes.

## v1.1 — 2026-09-21
- **Boverket's Bostadsmarknadsenkät**, 2020–2026: each kommun's own assessment of its housing market — shortage, balance or surplus — as a categorical map with three fixed colours and its own legend, plus a time series on the area page. `scripts/import_bme.py` reads the workbooks with the standard library and finds the answer column by its header text. The 2020 and 2021 surveys worded the answers differently ("Obalans - underskott på bostäder"), which is normalised; taken at face value those two years read as 100 % balance. The trend is real: kommuner reporting a shortage fell from 212 to 102 while surplus rose from 8 to 55.
- **Kronofogden forced sales**, 2010–2025, per 10 000 dwellings. The file was checked before anything was built on it: it is **län-level, with no kommun breakdown**, so the map shows 21 values across 290 kommuner and the indicator's warning leads on that.
- **Municipal finances from Kolada (RKA)** — a new indicator group with the tax rate, net operating cost, long-term debt and equity ratio for all 290 kommuner, 2015 onwards. Kolada v2 is gone (HTTP 410); everything uses v3. Net cost arrives with the income statement's sign and is flipped so it reads as a cost. Gotland's 33.6 % tax rate is left alone — it is both a kommun and a region and levies both rates. Kolada has no population forecast (`?title=prognos` returns nothing), which is recorded rather than left open.
- **Five tables already on disk put to work**, with no new fetch: employment by industry (TAB6681) and self-sufficiency by region of birth (TAB6766) as area-page cards; new-build rents by rent-setting model (TAB6417) and vacancy (TAB5602) as Market panels; bostadsrätt prices (TAB1151) in Charts. The industry mix is published for RegSO and DeSO only, so the kommun figure is summed from its RegSO.
- **Vacancy is labelled *Stale* on the card itself** — triennial, ending 2024, no next publication announced.
- **Independent recomputation**: `make verify` asks SCB for one kommun at a time with an explicit selection, recomputes rent, population growth and post-secondary education itself and compares with the built page. Five kommuner × three indicators, **15 of 15 match**. Table in `docs/DATA_MAP_SE.md` §4b.

## v1.0 — 2026-09-21
- First release: 290 kommuner, 3 363 RegSO and 6 160 DeSO on one map, 27 mapped indicators and 9 national macro series, in one self-contained HTML page.
- **Boundaries clipped to the coastline** with the OSM land polygons (ODbL). RegSO and DeSO tile the whole national territory including water, so a coastal kommun was one blob reaching into open sea; Värmdö is now the 60 islands it actually is, and kept 15 % of its raw area.
- **Three levels, one drawn at a time**: the 290 kommuner nationally, a drilled kommun's RegSO, or its DeSO. Zoom no longer changes the level — drilling does. DeSO ships as one file per kommun and is fetched on demand.
- **Margins of error are rendered, not just carried**: the ± sits beside the value in the table, the tiles, the headline row and the popups, and a value whose margin is too wide for its indicator is greyed and flagged.
- **Area pages** carry the age × sex pyramid, the composition of income and the tenure mix — what SCB publishes below kommun level, in the slot the Danish edition gave to its building register, which Sweden has no equivalent of.
- Market panel: CPI rent index, the FASTPI property price index, and an interest-rate card with the policy rate, the 10-year yield and the mortgage rate on shared axes.
- Riksbank SWEA (policy rate, 10-year yield) wired in; `make verify`, `make test` and a monthly refresh workflow.

## v0.2 — 2026-09-20
- SCB pipeline: API client, resumable deep fetcher, boundary fetcher, 94 pulls and 43.2 M cells with no failures.
- Indicator registry with a validator that re-checks every table, dimension, value code, level, vintage and margin-of-error code against the metadata on disk.
- The last five table ids resolved from their old v1 paths; building permits found to have no kommun level at all.

## v0.1 — 2026-09-18
- Data map and source verification: SCB PxWebApi v2, RegSO/DeSO boundaries, rents, prices, construction, macro sources; key endpoints checked live.
