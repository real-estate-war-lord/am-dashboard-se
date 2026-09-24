# Parity build log — v1.2

One section per phase. Each section carries the check table (what was built, from
which source, at which level, with which caveat), the `make validate / test / build`
result, every ⚠ raised and the decision taken on it.

Plan and phase checklist: `docs/PARITY_PLAN.md`.
Endpoint probe: `docs/PARITY_PROBE.md`.

## Phase 0 — Plan file + probe

Probe run 2026-09-24. `scripts/probe_parity.py` → `docs/PARITY_PROBE.md`
(35 capabilities, 33 routed). Danish UI inventory → `docs/PARITY_UI_INVENTORY.md`.

### Check table

| Capability | Route | Level | Verdict |
|---|---|---|---|
| SCB TAB6008 / TAB698 projection | PxWeb v2, `updated 2024-06-11` | 290 kommun + 21 län, 2024–2070 | ✅ both tables agree cell for cell |
| Brå anmälda brott, yearly | SOL `menyid=101` | 290 kommun + stadsdelsområden in the 3 big cities | ✅ 117 offence types, 1 362 leaf, 1996–2025 |
| Brå anmälda brott, monthly/quarterly | SOL `menyid=90` | same | ✅ 41 types, 520 periods to 2026K2 prel. |
| Brå clearance (personuppklarade) | national xlsx only | **riket** | ⚠ not per kommun — omit, see below |
| Kolada crime KPIs | `api.kolada.se/v3` | 290 kommun, 2008–2025 | ✅ fallback; per 100 000 inh., not counts |
| Polisen utsatta områden | `uso_2025_geojson.zip` | 65 polygons, EPSG:3006 | ✅ geometry **is** published |
| Skolverket year-9 results | planned-educations **v4** | 6 546 units, 4 659 with grundskola | ✅ carries `valueType` and school-year labels |
| School coordinates | planned-educations v4 **detail** | per unit | ⚠ route differs — see below |
| SALSA | — | — | ❌ blocked, no bulk export exists |
| Skolinspektionen Skolenkäten | per-school xlsx, 8/year | skolenhetskod + lägeskommun | ✅ biennial rotation |
| MCF flood extents | INSPIRE WFS, 3 layers | national multipolygons, no kommun attribute | ⚠ bbox tiling required |
| MCF coastal flood | `gis-tjanster.mcf.se` ArcGIS | 50 levels, 0.1–5.0 m RH2000 | ✅ host changed — see below |
| MCF cloudburst flag | Skyfallskartering_Oversikt | **290 kommuner, Status 1/0** | ✅ 267 have their own mapping |
| SMHI mean sea level | opendata-download | RCP 2.6/4.5/8.5 × 2050/2100 | ✅ low/average/high each |
| SGU landslide | OGC API Features | 3 collections | ✅ CC0 |
| Lantmäteriet byggnader | STAC public, files 401 | per kommun GeoPackage | ⚠ needs Geotorget |
| Trafikverket bilaga 1 | adopted plan xlsx, 347 899 B | **län**, 266 rows | ⚠ not kommun-level |
| Geofabrik Sweden extract | 818 MB pbf | national | ✅ |
| Trafiklab GTFS | 403 | — | ⚠ needs TRAFIKLAB_KEY |

### Route differences found, and the decision on each

1. **`statistik.bra.se` serves a mismatched TLS intermediate.** The leaf is issued by
   *DigiCert EV RSA CA G2*; the server presents *GeoTrust EV RSA CA 2018*, so the chain
   does not join. curl on macOS succeeds only because the keychain has the right
   certificate cached — Python fails with `CERTIFICATE_VERIFY_FAILED`.
   **Decision:** `scripts/http_util.py` fetches the correct intermediate from the CA
   Issuers URL in the leaf's own AIA extension, caches it under `data/external/raw/ca/`
   and loads it into an `SSLContext`. Verification stays **on**. Not a user-agent issue.
2. **Brå SOL's id separator is `*`, not `,`.** A comma returns HTTP 200 with all but one
   id silently dropped — the same failure mode as the SCB `valueCodes[X]` repeat already
   in CLAUDE.md. Added to the trap list.
3. **SOL needs a session.** `/urval?menyid=…` is a 993-byte stub until a `JSESSIONID`
   from `/action/start` is presented. The probe now carries a cookie jar.
4. **Clearance is national only.** `handlagda-brott` has no kommun cut and SOL has no
   handlagda module. **Decision:** omit `clearance_pct` from the kommun panel, as the
   phase brief allows, and say so in the README rather than substituting a modelled one.
5. **Polisen publishes three classes no longer — only two.** `KATEGORI` is
   *Utsatt område* (46) and *Särskilt utsatt område* (19); `riskområde` is gone.
   **Decision:** Phase 3 carries two classes. Verified independently against the file.
6. **Skolenhetsregistret carries no coordinates** (10 655 units: code, kommun, org nr,
   name, status only). **Decision:** take `wgs84_Lat`/`wgs84_Long` from the
   planned-educations **v4 detail** endpoint, one call per school — which also means the
   brief's "coordinates from Skolenhetsregistret" is not the route Phase 4 will use.
7. **`gis.msb.se` → `gis-tjanster.mcf.se`** after the MSB→MCF reorganisation, and
   `gis.mcf.se` does not exist at all.
8. **The flood WFS advertises `application/geo+json` but does not implement it**, and an
   untiled `json` request dies mid-stream (the layer is >40 MB in 76 features).
   `text/csv` delivers attributes; geometry needs bbox tiling. Its WKT is written
   **northing first**, which is the same axis-order trap that already cost this repo a
   release — noted for Phase 6.
9. **SCB projection pulls need `ContentsCode`.** Region, ContentsCode and Tid are all
   non-eliminable on TAB6008/TAB698; omitting it is a 400, not an empty answer.
10. **A year is not a `Tid` code on a monthly or quarterly table.** Six of the registry's
    31 tables are monthly or quarterly; the verify-at-source builder records the
    granularity and expands a year into the periods the table actually has.

### ⚠ carried forward

| ⚠ | Decision |
|---|---|
| clearance per kommun does not exist | omit the indicator, state it in the README |
| SALSA has no bulk export | ship the raw merit value, labelled "not SALSA-adjusted" |
| Lantmäteriet building files need Geotorget | area shares only; upgrade available when the key exists |
| Trafiklab needs a key | OSM stops instead; upgrade available when the key exists |
| Trafikverket plan is län-level | no kommun investment map is promised |
| Brå sub-kommun = 3 cities' stadsdelar only | no RegSO/DeSO crime; kommun value inherits with ° |
| `socio` direction unverified | left `neutral` until the metadata is checked (Phase 8) |

### Gates

`make validate` clean (44 indicators). `make test` clean. `make build` clean (14.8 MB).
No screenshots this phase — nothing visual changed.

## Phase 1 — UI foundation from DK v2.0–v2.5.1

### Check table

| Piece | Where | Note |
|---|---|---|
| `direction` on every indicator | `config/indicators.json`, written by `scripts/set_directions.py` | 4 higher_better, 4 lower_better, **36 neutral** |
| direction-aware `rankOf` | `src/app.js` | #1 counts from the best end; a neutral indicator reports a position, not a rank |
| direction-aware `cls` | `src/app.js` | a rise in unemployment is red; a neutral delta gets no colour at all |
| legend direction note | `legendHtml` | "↓ lower is better · darkest = highest" — the ramp is never inverted |
| diverging scale | `divergingScale`, `mkShade` | breaks mirrored about `center`; for Phase 2's Outlook |
| canvas-renderer guard + `lfDrop` | `lfGuardCanvas` | lands **before** the first point layer, as the port order requires |
| overlay-pill framework | `OV`, `ovTools`, `lfOverlays` | five hooks per overlay; `OV` is empty until Phase 4 |
| stacked legend column | `.maplegs` in `style.css` | `setLegend` rewrites every overlay legend each pass; `:empty` hides the off ones |
| quick jumps S / G / M / W | `MAP_JUMPS`, `mapJump` | `fitBounds` and nothing else — no selection, no hash, no popup |
| Yearly \| Quarterly toggle | `CH.fq`, `chartQ`, `chartPeriods` | appears only when `q_periods` exists **and** every selected area has quarters |
| datasheet shell | `SHEETS`, `vSheet` | routing and chrome only; Phases 4 and 7 supply content |
| verify-at-source | `indSrcLink`, `scripts/build_src_links.py` | 70 queries across all 44 indicators |
| `make links` / `make srclinks` | `Makefile` | full sweep split out of `validate` because it is the only target needing network |

### The direction rule, and why 36 of 44 are neutral

An indicator gets `higher_better` or `lower_better` only where the source itself,
or an uncontested convention, says which end is good: unemployment, at-risk-of-poverty,
forced sales and municipal debt down; income, median income, employment and equity ratio
up. Everything else is `neutral`, which switches off the green/red delta and the rank
sense. A share of flerbostadshus, a share aged 20–34 or a rent has no better end, and
colouring one green would be this dashboard editorialising rather than reporting.
`neutral` is the safe default because a wrong direction silently inverts a rank and a
colour — the same class of silent error the `fmt` fallback already cost this repo once.
`scripts/validate_indicators.py` now **requires** the field, and `tests/smoke.js` fails
if any indicator lacks a valid one.

### Bugs found and fixed while building verify-at-source

The first cut produced links that 400'd on 46 of 69 queries. Three separate causes:

1. **`0010` is a riksområde, not a kommun.** Classifying any four-digit Region code as a
   kommun made every län-published indicator ask for a kommun that table has never
   heard of. A four-digit code is a kommun only when its first two digits are one of
   the 21 län.
2. **The display level is not the publication level.** `brf_price` is drawn per kommun
   but published per län; the entry now records `code_level` and the link sends the län
   code. The smoke test asserts this specific case.
3. **The dashboard's latest year runs ahead of individual tables.** A table ending in
   2025 rejects 2026 outright, so each entry records its own `newest_period` and the
   year is clamped to it.

Plus the monthly/quarterly point from Phase 0: six of the 31 tables are not yearly, and
a bare year is not a valid `Tid` code on them.

`src_url` is implemented **twice** on purpose — once in `src/app.js` for the link and
once in `scripts/check_source_links.py` for the sweep — so drift between them shows up
as a failing sweep rather than as a reader finding a dead link.

### Gates

| Gate | Result |
|---|---|
| `make validate` | clean — 44 indicators, `direction` now required |
| `make links` | **69 of 69 queries returned cells** |
| `make test` | clean — 13 new assertions (5 direction, 5 verify-at-source, 3 existing) |
| `make build` | clean, 14.9 MB |
| screenshots | `docs/screenshots/v12_map.png`, `v12_charts.png` — temporary server on a random port, stopped |

### ⚠ raised

| ⚠ | Decision |
|---|---|
| SCB resets connections during a sustained sweep well below its stated 30/10 s | throttle to 10/10 s and retry a reset; a 400 is never retried, since a wrong query will not improve |
| `socio` direction still unverified | stays `neutral`; carried to Phase 8 |
| `OV` is empty, so the overlay pills render nothing yet | intended — the framework lands before its first consumer |

## Phase 2 — Population outlook

### Check table

| Indicator | Definition | Source | Level | Coverage |
|---|---|---|---|---|
| `fc_growth` | 2026→2040 change, % | SCB TAB698 | kommun | 290/290 |
| `fc_growth_5y` | 2026→2031 change, % | SCB TAB698 | kommun | 290/290 |
| `fc_abs` | projected inhabitants 2040 | SCB TAB698 | kommun | 290/290 |
| `fc_0_5` | 2026→2040 change, ages 0–5 summed | SCB TAB698 | kommun | 290/290 |
| `fc_6_16` | 2026→2040 change, ages 6–16 summed | SCB TAB698 | kommun | 290/290 |
| `fc_20_34` | 2026→2040 change, ages 20–34 summed | SCB TAB698 | kommun | 290/290 |
| `fc_80p` | 2026→2040 change, ages 80–100+ summed | SCB TAB698 | kommun | 290/290 |

All seven are `direction: neutral` — a projection is not a score. All five
percentage indicators use the diverging scale centred on 0, so above and below
flat read as different colours rather than two shades of one.
RegSO and DeSO inherit the kommun figure marked `°`; SCB does not publish the
projection below kommun.

### Data

`config/tables_se.json` gained TAB698 and TAB6008, both `years(2026..2040)`, kommun
level, age and sex in full. 878 700 rows each, 1.9 min, 30 calls.
A new time spec `years(A..B)` was needed: the projection runs 2024–2070 and the window
we want is neither the newest N nor the whole table, so `top(N)` could not express it.

**TAB6008 is pulled as an independent recomputation, not as extra detail.** Pinned to
`InrikesUtrikes=83` (total), it reproduces TAB698 exactly: 4 350 kommun×year cells,
**0 differing by more than 0.01**.

### Verification

`scripts/verify_outlook.py` recomputes all seven indicators for five kommuner by asking
SCB again and summing the cells itself — it never reads `data/raw/` or `data/processed/`
for the expected value.

**35 of 35 values match**, to 0.05 pp (1 inhabitant on the count):

| kommun | 2026 | 2040 | growth | 0–5 | 6–16 | 20–34 | 80+ |
|---|---:|---:|---:|---:|---:|---:|---:|
| 0180 Stockholm | 992 730 | 1 041 998 | +4.96 % | +7.74 | −19.93 | +7.09 | +46.03 |
| 1480 Göteborg | 612 220 | 659 015 | +7.64 % | +10.70 | −12.36 | +6.77 | +39.21 |
| 1280 Malmö | 367 915 | 402 322 | +9.35 % | +12.83 | −13.30 | +9.94 | +37.11 |
| 2418 Malå | 2 896 | 2 618 | −9.59 % | −2.60 | −20.66 | −4.57 | +22.81 |
| 0760 Uppvidinge | 9 121 | 8 768 | −3.87 % | +1.62 | −12.22 | −0.15 | +15.31 |

### Bugs found by the verification and the screenshots

1. **`100+` must be percent-encoded.** `urlencode(..., safe=",+")` left the plus raw,
   SCB read it as a space and returned 400. This is the trap CLAUDE.md already records;
   the verifier hit it on its first run, which is what a verifier is for.
2. **The chart drew a single bar labelled "no history".** `chartMode()` asked
   `chartYears()`, which is empty for a projection, instead of `chartPeriods()`.
3. **The y-axis reached −80 532 on a population count.** Padding below the smallest
   value, with Malå and Stockholm three orders of magnitude apart. A series whose
   values are all ≥ 0 now keeps its axis at 0 or above.
4. **The line chart has its own footer** and did not call `chFoot`, so the
   "dashed = projected" note was missing from the PNG. Added, and the source string
   capped the way `chFoot` already caps it.
5. **A test assertion of mine was wrong, not the data.** "80+ rises in every kommun"
   failed on Hällefors (−1.38 %). Checked against the API: Hällefors is projected to
   shrink 8.2 % overall and its 80+ cohort with it. The assertion now says
   289 of 290 and names the exception.

### Gates

| Gate | Result |
|---|---|
| `make validate` | clean — 51 indicators |
| `make test` | clean — 15 new Outlook assertions |
| `make build` | clean, 15.3 MB |
| `scripts/verify_outlook.py` | **35 of 35 match the API** |
| screenshots | `v12_outlook_map.png`, `v12_outlook_chart.png`, `v12_outlook_area.png` |

### ⚠ raised

| ⚠ | Decision |
|---|---|
| projected years must not reach the year selector | the series lives in `fc`, never `hist`; asserted in `tests/smoke.js` |
| a projection has no median across kommuner | the median band is suppressed on Outlook charts — SCB published no such figure |
| TAB6008's born-in-Sweden / foreign-born split is pulled but unused | kept as the cross-check; no indicator claims it |

