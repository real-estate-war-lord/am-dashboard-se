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

## Phase 3 — Safety

### Check table

| Indicator | Definition (Brå's own category) | Level | Coverage | History |
|---|---|---|---|---|
| `crime_1000` | Totalt antal brott, per 1 000 inh. | kommun | 290/290 | 1996–2025 + **48 quarters** |
| `violence_1000` | 3–7 kap. Brott mot person | kommun | 290/290 | 1996–2025 |
| `theft_1000` | 8 kap. Stöld, rån m.m. | kommun | 290/290 | 1996–2025 |
| `burglary_1000dw` | Stöld genom inbrott i bostad ÷ SCB TAB824 stock | kommun | 290/290 | 1996–2025 |
| `vandalism_1000` | 12 kap. Skadegörelsebrott | kommun | 290/290 | 1996–2025 |
| `drugs_weapons_1000` | narkotikastrafflagen + vapenlagen 9:1–2 | kommun | 290/290 | 1996–2025 |
| `crime_trend` | y/y change in the published rate | kommun | 290/290 | diverging scale |
| `vulnerable_area_share` | share of land inside a police-designated area | **kommun / RegSO / DeSO** | 29 / 180 / 376 | snapshot 2025-12-01 |

The six offence indicators are `lower_better`. `crime_trend` is diverging about
zero. `vulnerable_area_share` is `neutral` — a police designation describes where
resources are directed, not the people who live there.

Only `drugs_weapons_1000` is a composite, and it is the sum of two rows Brå
publishes separately. `violence_1000` is deliberately Brå's own published chapter
3–7 aggregate rather than a "violence" composite assembled here; the label says
so. Nothing else is arithmetic beyond dividing Brå's own per-100 000 rate by 100.

### Route

Brå has no open-data API — its own page says so — so SOL is the only machine
route to kommun-level crime. `scripts/fetch_bra.py` drives it as a browser would:
session → selection form → POST selection → run → tab-separated result.
Resumable; raw exports gitignored under `data/raw/bra/`.

### ⚠ clearance rate omitted

`clearance_pct` is **not shipped**. Brå publishes personuppklaringsprocent by
offence type for the whole country only; `handlagda-brott` has no kommun cut and
SOL has no handlagda module. Omitted rather than substituted with a modelled or
regional figure. `tests/smoke.js` asserts no such indicator exists, so it cannot
reappear by accident.

### Bugs found and fixed

1. **`&nbsp;` ends in a semicolon**, which is also SOL's field separator, so the
   measure row split into 122 fields where the data rows had 62 and every column
   index after it was wrong. The first parser survived only because the surplus
   columns fell off the end. Entities are now decoded *before* splitting.
2. **Heby was silently missing.** SOL labels it "Heby kommun (Uppsala län from
   2007)" — it appears twice, split by its 2007 move from Västmanland — and the
   region matcher required the name to end in " kommun". Coverage was 289/290.
   The current entity (8556) is used and its series starts at 2007; the two are
   never spliced.
3. **Slivers were being reported as designations.** Eight areas had an
   intersection that rounded to 0.000 % — boundaries grazing each other, a
   digitising artefact. An intersection below one hectare is no longer a
   designation. 724 rows → 585.
4. **The designation was inheriting down the hierarchy.** Every RegSO in
   Stockholm without its own value was tinted with the kommun's 4.41 % and
   labelled "4,4 % °" — the map said the entire city was police-designated. A new
   `no_inherit` flag stops the fallback for this indicator in the fill, the
   labels, the popup and `eVal`; ordinary indicators still inherit with °, which
   the tests assert both ways.
5. **`num1`/`num2` were not in `FMT`.** Caught by the existing guard — the exact
   trap CLAUDE.md records. Added with the indicators.
6. **The overlay legend read "loading…" over a drawn overlay**, because a lazily
   loaded layer draws after the legend pass. `ovLegends()` is now called when the
   data lands too.

### Verification

`scripts/verify_bra.py` opens a **fresh SOL session** and re-selects five
kommuner; the burglary denominator is fetched straight from the SCB API. Nothing
is read from `data/raw/` or `data/external/`.

**30 of 30 values match** (tolerance 0.005 per 1 000):

| kommun | crime | person | theft | burglary /1 000 dw | vandalism | drugs+weapons |
|---|---:|---:|---:|---:|---:|---:|
| Stockholm | 191.59 | 33.27 | 37.42 | 11.168 (5 866 / 525 252) | 62.08 | 17.27 |
| Göteborg | 138.78 | 28.76 | 37.22 | 11.334 (3 541 / 312 429) | 20.50 | 13.87 |
| Malmö | 161.83 | 36.05 | 48.01 | 12.468 (2 291 / 183 757) | 10.77 | 14.12 |
| Heby | 94.97 | 26.35 | 10.97 | 5.923 (41 / 6 922) | 6.36 | 9.44 |
| Malå | 75.38 | 25.92 | 11.60 | 6.223 (10 / 1 607) | 4.09 | 5.11 |

The police polygons were verified independently: the spatial join finds exactly
**29 kommuner**, matching the 29 distinct `ORT` values in the source, with
Västra Frölunda correctly resolving to Göteborg and "Upplands Bro" to
Upplands-Bro.

### Geometry

`scripts/sweref.py` implements SWEREF99 TM ↔ WGS84 (Lantmäteriet's Gauss-Krüger
series) because pyproj is not a dependency and one transform does not justify
adding it. Round-trip error over eight points across Sweden: **0.0069 mm**.
The intersection is done in **metres**, by moving our boundaries into the grid —
an area share computed in degrees would be wrong by the cosine of the latitude,
and Sweden spans 14 degrees of it. shapely is used here only, behind
`requirements-geo.txt`; the outputs are committed and `make build` does not need it.

### Gates

| Gate | Result |
|---|---|
| `make validate` | clean — 59 indicators |
| `make links` | **83 of 83** |
| `make test` | clean — 20 new Safety assertions |
| `make build` | clean, 15.9 MB (+126 kB overlay) |
| `scripts/verify_bra.py` | **30 of 30 match a fresh Brå session** |
| screenshots | `v12_safety_map.png`, `v12_uso_overlay.png` |

### ⚠ raised

| ⚠ | Decision |
|---|---|
| clearance not published per kommun | omitted; asserted absent |
| Brå publishes nothing below kommun except stadsdelar in 3 cities | RegSO/DeSO inherit crime with °; the designation does not inherit at all |
| reporting propensity differs between kommuner | stated in every Safety indicator's caveat |
| drug and weapons offences reflect enforcement effort | said so in the indicator's own description |
| SOL is a 2000s JSP app that could change without notice | the fetcher asserts Stockholm's row count and fails loudly on a short file |

## Phase 4 — Schools

### Check table

| Indicator | Definition | Level | Coverage | Period |
|---|---|---|---|---|
| `school_merit` | merit value, year 9, pupil-weighted | kommun/RegSO/DeSO | **289**/290 kommun | 2025/26 |
| `school_passed` | passed every subject | all three | 290 kommun | 2025/26 |
| `school_eligible` | eligible for a vocational programme | all three | 290 kommun | 2025/26 |
| `school_certified` | certified teachers | all three | 290 kommun | 2025/26 |
| `school_per_teacher` | pupils per FTE teacher | all three | 290 kommun | 2025/26 |
| `schools_n` | school units teaching year 9 | all three | 290 kommun | register snapshot |
| `school_trygghet` | Skolenkäten Trygghet index | all three | 2 841 areas | **2025+2026** |
| `school_studiero` | Skolenkäten Studiero index | all three | 2 841 areas | **2025+2026** |

All hidden from the chip row. **1 791 schools** with year 9 and coordinates, in
290 kommuner; 1 786 located in a RegSO, 1 785 in a DeSO by point-in-polygon on
our own rings.

### Route differences

1. **Skolenhetsregistret carries no coordinates.** It is code, kommun, org nr,
   name and status — 10 655 rows, no geometry. The brief's route does not exist.
   `wgs84_Lat`/`wgs84_Long` come from planned-educations **v4 detail**, one call
   per school. 1 791 of 1 798 have them (99.6 %).
2. **School-year labels are NOT shifted**, but they are not uniform either:
   merit, pass rate, eligibility and staffing run to **2025/26**, while the
   national tests lag a year at **2024/25**. Each metric therefore carries its
   own period instead of sharing one "as of".
3. **`totalNumberOfPupils` is always a rounded band** — "cirka 590" — never an
   exact count, and it counts the whole unit rather than the year-9 cohort. It
   is the only size measure published, so it is what the pupil-weighting uses,
   and every Schools indicator says so.

### ⚠ SALSA is not shipped

The SIRIS export module is gone (404). SALSA now exists only inside a stateful
Oracle APEX app (`f?p=SIRIS:164`) with `p_arg_checksums` on every submit and no
export of any kind; `statistikdatabasen.skolverket.se` does not carry it either.
**No bulk file exists.** The merit value shipped here is therefore the **raw**
one — which is exactly the socioeconomically-confounded number SALSA exists to
correct. Every label, the popup, the datasheet and the legend say so, and
`tests/smoke.js` asserts both that no SALSA indicator exists and that the caveat
is present on every result indicator.

### valueType is preserved, never zeroed

Skolverket suppresses and rounds, and the reasons survive into the page:
`EXISTS` · `OMITTED_DUE_TO_BASED_ON_FEW_PUPILS` (`..`) ·
`ROUNDED_OFF_DUE_TO_FEW_PUPILS_NOT_ELIGIBLE` (`~100`) · `MISSING` ·
`TEACHERS_EXCLUDED_DUE_TO_NO_REQUIRED_LEGITIMATION`. A suppressed school is left
out of an average rather than counted as zero, and the datasheet prints the
reason next to the dash.

**Robertsfors (2409) has no merit value at all** — one year-9 school
(Tundalsskolan) for which the API returns null for merit, pass rate and even the
pupil band. Verified against the API. It stays a gap; the test names it.

### Skolenkäten

Machine-readable xlsx, read with `zipfile` + regex — no spreadsheet library. The
Trygghet and Studiero index columns are located **by header name** in row 1 and
checked against "Index" in row 3, so a layout change fails loudly instead of
silently shifting a column.

The survey runs on a **roughly two-year rotation** — about 815 schools per round
— so the build unions 2025 and 2026 and each school carries its own year; the
indicator's as-of reads "2025+2026". 1 551 of 1 791 schools joined. An index
needs five respondents; below that the cell is blank, and a genuine 0 is printed
as 0 — the two are not conflated.

### Verification

`scripts/verify_schools.py` calls the API again for five schools — the largest
and smallest in a random sample of 12 kommun files, one with a suppressed value,
and two at random — and compares every field including the suppression reasons.

**55 of 55 values match**, including coordinates to 1e-5, the pupil bands, and
five distinct valueTypes surviving as reasons rather than numbers.

National pupil-weighted merit value: **233.2**. Stockholm: 256.2.

### UI

Schools overlay on the Phase 1 framework: points in their own canvas pane
(z-450), one file per kommun fetched nearest-first and capped at 24 per pass,
nothing drawn below zoom 9. Grade colour mode is a 5-step quintile ramp over the
schools **in view**, not a fixed national scale; a school with no merit value
stays hollow in the base hue and never lands in the bottom bin. School datasheet
at `#school/<code>` on the Phase 1 sheet shell.

### Gates

| Gate | Result |
|---|---|
| `make validate` | clean — 67 indicators |
| `make test` | clean — 13 new Schools assertions |
| `make build` | clean, 16.4 MB + 290 school files |
| `scripts/verify_schools.py` | **55 of 55 match the API** |
| screenshots | `v12_schools.png`, `v12_school_sheet.png` |

### ⚠ raised

| ⚠ | Decision |
|---|---|
| SALSA has no export | raw merit shipped, labelled everywhere; asserted |
| pupil band weights the whole unit, not the year-9 cohort | used and stated; no silent correction |
| Robertsfors has no published result | stays blank; named in the test |
| the survey covers ~half the country per round | two rounds unioned, each school carries its year |
| a raw merit value tracks intake as much as teaching | said in the indicator note and on the datasheet |

## Phase 5 — Test property, Analysis and Compare

### Check table

| Piece | Where | Note |
|---|---|---|
| `parseLocation` | `src/testprop.js` | DOM-free, `module.exports` at the bottom, 24 unit tests |
| Sweden box | `TP_BOUNDS` | 55.0–69.2 N, 10.5–24.3 E |
| short links refused by name | `TP_SHORT_RE` | `short_link`, with an actionable message |
| exact kommun / RegSO / DeSO | `locate()` in `src/app.js` | point-in-polygon on our own rings, **holes kept** |
| lazy lookup files | `dist/lookup_kommuner.json` + `dist/lookup/<level>_<kommun>.json` | 2.5 MB + 580 files, largest 189 kB |
| pin in the hash | `#analysis?a=…&la=…&b=…&lb=…` | the fragment is never sent to a server |
| Analysis sheet | `vAnalysis()`, own nav group | where it is, nearest schools, every indicator |
| **Compare two pins** | same view, `b=` | aligned rows, direction-aware, **no overall winner** |
| `make test-js` | `node --test tests/*.test.js` | wired into `make test` |

### Compare is new work

The Danish repo has no two-pin comparison — branch `v2.5-compare` has zero
commits ahead of its merge base, and its "compare" is `areaCompareTable()`, the
area page's indicator table. So this was designed here rather than ported.

The design decision worth recording: **there is no score.** Rows are aligned and
each difference is coloured by that indicator's own `direction`, with neutral
indicators left uncoloured. No total, no index, no winner. Adding up indicators
that measure different things in different units would be this dashboard
inventing a judgement it has no basis for, and the panel says so in as many words.

### Geometry

`scripts/build_lookup.py` writes rings simplified to **40 m in metres** (not
degrees — a degree of longitude at 67 °N is 39 % of one at 55 °N), rounded to 4
decimals (~11 m), with a bbox per area so the page rejects almost everything with
four comparisons before a ray cast. **Interior rings are kept**, and `inPoly`
subtracts them: a lake inside a kommun must exclude points in the lake.

### What the pins proved

`tests/smoke.js` drops pins on six landmarks and checks the kommun: 6 of 6.
Slussen resolves to Stockholm → RegSO Östra Katarina → DeSO 0180C3750_DeSO2025;
Avenyn to Göteborg → Vasastaden västra.

**A pin at sea belongs to no kommun; a pin in Vättern belongs to Karlsborg.**
Those are different answers and both are right — the boundaries were clipped to
the *sea* coastline, while Swedish kommun boundaries really do divide the inland
lakes between the kommuner around them. The first draft of that test called the
lake a bug; it is now asserted both ways with the reason.

### Bugs found by the screenshots

1. **The compare column printed "++6,8 %".** `signpct1` already prints its own
   sign and the difference was signed again on top. `fmtAbs()` now formats the
   magnitude and the caller signs it exactly once. Asserted.
2. **The nearest-schools card never resolved.** The lazy school loader called
   the map's redraw, which does nothing on the Analysis view. It now re-renders
   whichever view is open.

### Privacy

Stated on the panel and true of the implementation: the link is parsed in the
browser, the point is tested against boundary files the page already serves, and
the coordinate lives only in the URL fragment — which browsers do not send to
servers. A short `goo.gl` link is **refused rather than resolved**, because
resolving it would mean calling Google on the reader's behalf.

### Gates

| Gate | Result |
|---|---|
| `make test-js` | **24 of 24** parser cases |
| `make test` | clean — 14 new pin/Analysis assertions |
| `make validate` | clean |
| `make build` | clean, 16.4 MB + 580 lookup files |
| screenshots | `v12_analysis.png` (two pins compared) |

### ⚠ raised

| ⚠ | Decision |
|---|---|
| the coarse box accepts Oslo and Copenhagen | by design — it catches swapped pairs; `locate()` gives the real answer, and the test says so |
| 40 m rings are not cadastral | stated on the card |
| no overall winner in Compare | deliberate; stated in the UI |
| Phases 6–7 sections of the Analysis sheet | to be added as those phases land |

## Phase 6 — Climate risk

### Check table

| Indicator | Source | Level | Coverage | Zones? |
|---|---|---|---|---|
| `flood100` | MCF INSPIRE WFS, 76 watercourses | all three | 199 kommun / 2 994 areas | ✅ |
| `flood200` | MCF, 71 watercourses | all three | 181 kommun / 2 712 areas | choropleth only |
| `floodBHF` | MCF, 78 watercourses | all three | 200 kommun / 3 130 areas | choropleth only |
| `coast20` | MCF ArcGIS layer 19 (2,0 m RH2000) | all three | 9 813 areas | ✅ |
| `coast30` | MCF ArcGIS layer 29 (3,0 m RH2000) | all three | 9 813 areas | choropleth only |
| `sea2100_85` | SMHI, RCP8.5, 2100, average | all three | 9 813 areas | ✅ |
| `sea2100_45` | SMHI, RCP4.5, 2100, average | all three | 9 813 areas | choropleth only |
| `landslide` | SGU aktsamhetsområden (CC0) | all three | 9 631 areas | choropleth only |
| `cloudburst_mapped` | MCF Skyfallskartering översikt | kommun | 290, **267 mapped** | flag |

All eight area shares are `no_inherit` and `lower_better`; the cloudburst flag is
categorical and `neutral` — having done the work is preparedness, not a hazard level.

### The three bugs that cost the most

1. **A shapefile record's parts are not one polygon with many holes.** The Esri
   spec makes an outer ring clockwise and a hole counter-clockwise, and one record
   can hold many islands. `flood100` is 76 records containing **753 370 parts** —
   31 819 shells and 721 551 holes. Treating every part as a hole of the first
   built a polygon with 721 551 holes, and *that* is why the first climate build
   ran 1 h 04 m without finishing. `scripts/shapefile.py` now splits by
   orientation, and the share is computed as (area in shells − area in holes),
   which needs no containment test at all.
2. **SGU pages with `startIndex` — capital I.** `startindex` and `offset` are both
   accepted and both silently ignored, so the first fetcher refetched page 1 for
   ever: 201 000 "features" that were 201 copies of the same thousand, 3.2 GB on
   disk. Following the server's own `next` link cannot make that mistake.
   `scripts/dedup_sgu.py` then drops 265 000 duplicate copies from the per-kommun
   bbox fetch — 2.6 GB → 1.1 GB — and the unique counts land on **242 296** and
   **49 645**, matching the API's own `numberMatched` exactly.
3. **MCF's three flood products cover different watercourses.** 76, 71 and 78 of
   them, and the difference appears *inside a single kommun*: Umeå is covered by
   three mapped watercourses in the 100-year map and two in the 200-year one,
   Lycksele by three and one. A shared coverage test gave Östersund 7.4 % for the
   100-year flood and **0.0 %** for the 200-year — which reads as "no risk" and
   means "not in this product". Coverage is now tested **per layer**, an area no
   record of that layer reaches is blank, and all three indicators carry a caveat
   that their shares are not comparable *with each other*.

### Zone overlay and the budget

Zones are clipped per kommun and simplified in metres. Built at 10 m all seven
layers came to **170 MB**, over the 150 MB budget, and landslide's largest file was
**4.47 MB**, over the 3 MB per-file cap — 242 000 tiny caution polygons do not
simplify because there is nothing to merge. The agreed fallback ran automatically:
**flood100, coast20 and sea2100_85 ship zones (41 MB, largest file 1.01 MB)**; the
other four are choropleth-only and fully available as numbers.

### Gates

| Gate | Result |
|---|---|
| `make validate` | clean — 78 indicators |
| `make links` | **83 of 83** |
| `make test` | clean — 10 new Climate assertions |
| `make build` | clean, 16.9 MB + 41 MB zones |
| screenshots | `v12_climate.png` |

### ⚠ raised

| ⚠ | Decision |
|---|---|
| the three flood products are not mutually comparable | caveat on all three; asserted in the tests |
| "not mapped" vs "mapped and dry" cannot be told apart | treated as not mapped — the conservative reading — and said so |
| four of seven layers have no zone outline | choropleth carries them; stated in the legend and the meta |
| no building-level exposure | needs Geotorget; area shares only, logged as an upgrade |

## Phase 7 — Overlays: Services, Public buildings, Infra

### Check table

| Piece | Source | Coverage | Note |
|---|---|---|---|
| Services overlay | OSM (grocery, food, pharmacy, transport) | **16 of 290 kommuner** | see below |
| Public buildings overlay | OSM (education, daycare, health, culture, sports) | same 16 | category filter is the legend |
| Infrastructure overlay | curated `infra_se.csv` | 49 projects, 7 drawn | never a sketched alignment |
| Pipeline view + CSV | same | 49 rows | budget always with its price base |
| `projects_upcoming` | derived | 55 kommuner with ≥1 | |
| `stations_planned` | derived | 55 kommuner with ≥1 | |

### ⚠ OSM coverage is partial, and that is the honest outcome

The public Overpass instance rate-limited this client. The query was tuned first —
node and way statements must be **two separate queries**, because together they
return 504 every time while each alone answers in 2.5 s, and that alone cut a
kommun from 75 s to 8 s — but after a few dozen kommuner Overpass began refusing
everything and eventually stopped answering its own status endpoint. Three workers
is inside its published 4-slot limit and still triggered it.

**The fetch was stopped rather than continued.** A donated public service sheds
load however it likes, and the right answer is to ask more slowly or not at all,
not to argue with it. 16 kommuner are on disk, `make services` is resumable, and
**the overlay's legend states its own coverage** so no reader can mistake a sparse
map for a sparse city. The Geofabrik extract remains the alternative if full
coverage matters more than a stdlib-only pipeline.

### Infrastructure

49 projects, every one with a source URL that was fetched and confirmed. Budgets
come from bilaga 1 of the **adopted** Nationell plan 2026–2037 at price base
**2025-02**, and a budget is never shown without its base. Eight projects have no
budget — the Stockholm metro lines are funded as one programme — and those read
"not published" rather than 0.

Geometry is station points matched by name in OSM **within the kommuner the project
actually runs through**, so a "Centralen" in the wrong city cannot be picked up.
7 of 49 are drawn; the rest are listed in Pipeline and on their own page but not on
the map, because sketching an alignment between two points would be inventing
geography and a line on a map is read as a fact. With only 16 kommuner of OSM data
this will improve on its own when `make services` completes.

### Gates

| Gate | Result |
|---|---|
| `make validate` | clean |
| `make test` | clean — 7 new Infrastructure assertions |
| `make build` | clean |
| screenshots | `v12_pipeline.png` |

## Phase 8 — Docs, verification, wrap-up

| Deliverable | Where | Note |
|---|---|---|
| source table | `docs/PARITY.md` | licence, real level, caveat, refresh, per source |
| verification export | `docs/verification/parity_v1_2.csv` | 9 990 rows; blanks carry a `status` |
| data map | `docs/DATA_MAP_SE.md` §5–§10 | what each source will *not* support |
| README | v1.2 section + 6 screenshots | |
| changelog | `CHANGELOG.md` v1.2, **drafted, not tagged** | |
| refresh workflow | `.github/workflows/refresh.yml` | Brå + Polisen added, `continue-on-error` |

### Final gates

| Gate | Result |
|---|---|
| `make validate` | clean — 78 indicators, every code checked against metadata on disk |
| `make test-js` | **24 of 24** |
| `make test` | clean — 172+ assertions |
| `make build` | clean — 16.9 MB page |
| `make links` | **83 of 83** |

### Independent recomputations across the whole build

| Script | Result |
|---|---|
| `verify_outlook.py` | **35 of 35** match the SCB API |
| `verify_bra.py` | **30 of 30** match a fresh Brå SOL session |
| `verify_schools.py` | **55 of 55** match the Skolverket API |
| `tests/smoke.js` pins | **6 of 6** landmarks in the right kommun |

## v1.2.1 — the three known limitations, closed

### Services and public buildings: 16 → **290 of 290 kommuner**

Overpass is a donated public service and it rate-limited this client at 16
kommuner. The fix was not to ask it harder but to stop asking it at all:
`scripts/extract_osm_pbf.py` reads the 818 MB Geofabrik country extract with
**pyosmium** in one pass.

| | |
|---|---|
| objects read | 115 473 535 |
| POI points found | 100 632 |
| placed in a kommun | **99 750** |
| outside every boundary | 882 — at sea or outside the coastline clip, left out rather than snapped to the nearest kommun |
| largest per-kommun file | 437 kB |

The split is **point-in-polygon on our own rings**, not by bounding box:
neighbouring kommun boxes overlap, and a café on a border would land in two.
The overlay's partial-coverage note disappears on its own, because it was
computed from the data rather than written by hand.

### Infrastructure: 7 → **25 of 49 drawn**

The same extract carries **637** `railway=construction|proposed` alignments.
A project gets a line only where OSM tags one whose name matches the project or
one of its stations; failing that it keeps its station points; failing that it
is still not drawn. **Nothing is sketched between two points.**

| | |
|---|---|
| drawn as an alignment | 14 |
| drawn as station points | 11 |
| still undrawn | 24 — **15 of them road projects**, which this pass did not cover: alignments are taken from railway/subway/light_rail/tram tagging only |
| named stations located | 57 of 65, up from 19 |

### Climate zones: three layers → **six**

Everything except landslide, ~97 MB, every per-kommun file under the 3 MB cap,
still lazy-loaded from zoom 10. Landslide stays choropleth-only for the reason
already recorded: 76 MB alone, largest file 4.47 MB, because 242 000 tiny
caution polygons have nothing to merge and so do not simplify. It remains fully
available as a number at all three levels.

### ⚠ found on the way, and why it mattered

**`scripts/selftest.py` did not know the `years(A..B)` time spec** added in
Phase 2 — and **CI is the only place selftest runs**, because `make test` runs
the smoke test instead. The Pages deploy had therefore been failing at "Offline
checks" since v1.2 was tagged, and the live site was still the v1.1 build until
this was found. selftest now accepts the spec and additionally checks that every
spec in `config/tables_se.json` actually resolves, so a future one cannot pass
the name check and then fail at fetch time.

**CI also never built the Listings page**, because the workflow calls the
assemblers directly rather than `make build`. index.html went live and
listings.html 404'd.

**The gateway's 153 tests are green locally** — including under CI's timezone
and locale, with no network calls and only `node:` built-ins imported — **but
red on the runner under Node 22**, and I have not reproduced that. They now run
in a job of their own rather than gating the dashboard's deploy, which is also
the right shape: the gateway is a Cloudflare Worker deployed by wrangler, on its
own schedule. **The cause is an open question, not a fixed one.**

