# Sweden parity — v1.2 build plan

Branch: `v1.2-parity`. Started 2026-09-24. Do not push, merge or tag.

Resume instruction for a fresh session: **"Continue from docs/PARITY_PLAN.md"** — read
the phase checklist below, pick the first unticked phase, and read
`docs/PARITY_BUILD_LOG.md` for the check tables of the phases already done.

---

## Phase checklist

- [x] **Phase 0** — Plan file + probe
- [x] **Phase 1** — UI foundation from DK v2.0–v2.5.1
- [x] **Phase 2** — Population outlook (demographics)
- [x] **Phase 3** — Safety (crime)
- [x] **Phase 4** — Schools
- [x] **Phase 5** — Test property + Analysis + Compare
- [ ] **Phase 6** — Climate risk
- [ ] **Phase 7** — Overlays: Services, Public buildings, Infra
- [ ] **Phase 8** — Docs, verification, wrap-up

### Status log

**Phase 0** (commit `95f7376`) — 35 capabilities probed, 33 routed; the 2 unrouted are
key-gated with a documented fallback. Ten routes differ from the brief; all logged.
Brå needed a TLS-intermediate fix (`scripts/http_util.py`), not a user-agent change.
Clearance per kommun and SALSA bulk export do not exist — both omitted, not modelled.
Polisen publishes polygons and **two** classes, not three.

**Phase 1** — direction awareness, diverging scale, canvas guard, overlay framework,
stacked legends, quick jumps S/G/M/W, Yearly|Quarterly toggle, datasheet shell and
verify-at-source (70 queries, `make links` 69/69). 36 of 44 indicators are `neutral`
by the stated rule. Three real bugs found and fixed in the link builder.
Gates: validate / links / test / build all clean.

**Phase 2** — seven Outlook indicators from SCB TAB698, all 290 kommuner, diverging
scale centred on flat, RegSO/DeSO inherit with °. TAB6008 pulled as an independent
recomputation and agrees on all 4 350 cells. verify_outlook.py: **35 of 35 values
match the API**. Five real bugs found by the verifier and the screenshots, including
the `100+` percent-encoding trap and a chart axis reaching -80 532 on a population.

**Phase 3** — eight Safety indicators from Brå SOL (1996-2025 + 48 quarters) and
Polisen's designated areas intersected into kommun/RegSO/DeSO. verify_bra.py: **30
of 30 match a fresh SOL session**, burglary denominators from the SCB API. Clearance
omitted — not published per kommun. Six bugs found, the worst being the designation
inheriting down so the whole of Stockholm read as 4.4 % police-designated.

**Phase 4** — 1 791 schools with year 9 from Skolverket v4 (~3 600 throttled calls),
eight indicators, Schools overlay with a grade quintile ramp and a datasheet.
verify_schools.py: **55 of 55 match the API**, suppression reasons intact.
SALSA has no bulk export anywhere — raw merit shipped and labelled as such.
Skolenkäten joined for 1 551 schools by unioning the 2025 and 2026 rounds.

**Phase 5** — testprop.js ported with the Sweden box, 24 unit tests, `make test-js`.
locate() does exact point-in-polygon with holes on lazily fetched rings; 6 of 6
landmark pins land in the right kommun. Analysis sheet plus a two-pin Compare that
is NEW work — the Danish repo has none — deliberately with no overall winner.
Screenshots caught a doubled sign and a card that never resolved.

_(each phase appends a 5-line status here when it is ticked)_

---

## The task, verbatim

MASTER TASK — "Sweden parity": bring the Danish edition's features to this Swedish dashboard in one long, unattended run. Branch: v1.2-parity (already checked out). Work phase by phase without stopping for me unless something truly blocks everything. Do not push.

GROUND RULES (apply to every phase)
1. Data principle: the UI shows official published figures or plain arithmetic on them only — no own models, assumptions or imputations. Suppressed ≠ 0, not covered = "Not covered yet", not mapped = "Not mapped", never 0. Every figure carries source, period, fetch date and a verify-at-source link.
2. Reference implementation: the Danish repo at ~/Desktop/"Denmark dashboard, funny project"/am-dashboard-dk (v2.5.1). READ-ONLY — never edit, build, checkout or run git commands that change anything there. Reuse its patterns, UI code and naming (overlay pills, lazy per-kommun files, stacked legends, datasheets, Analysis sheet, testprop.js, verify-at-source links, make links). Levels here: kommun / regso / deso.
3. Keep this repo's conventions: English everywhere; scripts stdlib-first like the existing ones (if geometry work truly needs shapely/pyproj, add requirements-geo.txt + a .venv, document it in the README, and keep `make build` working without it for the non-geo steps); one indicator = one entry in config/indicators.json; margins of error and geography vintages kept; 4-digit kommun codes with leading zeros.
4. Secrets: read keys from .env only, never print or commit them. If a source needs a login/key that is missing (Lantmäteriet Geotorget, Trafiklab), use the documented fallback and log "upgrade available when key exists" — do not stop.
5. Size: no processed/dist file > 3 MB; lazy-load per kommun for point layers and zones; raw downloads gitignored under data/raw/<source>/.
6. Every phase ends with: make validate && make test && make build clean (log every ⚠ with a decision), a check table appended to docs/PARITY_BUILD_LOG.md, headless screenshots (temporary server on a random free port, stopped straight away — never leave a server running), one or more commits (feat:/data:/fix:/docs:), and the phase ticked in docs/PARITY_PLAN.md with a 5-line status.
7. If a source route differs from what is written here, find the working official route, log the difference and continue. Never invent a figure, ID or URL. If a whole feature has no workable open source, skip it, log why, and move on.
8. Context: use subagents for research-heavy or bulk steps to keep this session small. If you are running low on context, commit, update docs/PARITY_PLAN.md with exactly where to resume, and tell me to start a new session with "Continue from docs/PARITY_PLAN.md".

PHASE 0 — Plan file + probe
a) Status (last commits, git status, other branches, .env key names only).
b) Write docs/PARITY_PLAN.md containing this whole task verbatim plus a checklist of phases 0–8, and create docs/PARITY_BUILD_LOG.md.
c) scripts/probe_parity.py → docs/PARITY_PROBE.md, table name | HTTP | s | bytes | result for: SCB TAB6008/TAB698 metadata + a 0180/1480/1280 pull for 2026/2031/2040; Brå anmälda brott per kommun (statistik.bra.se SOL and any export/API behind it: offence codes, years, frequency, clearance per kommun?) and Kolada v3 KPIs matching brott/anmälda/trygg/uppklar; Polisen utsatta områden download (polisen.se/om-polisen/polisens-arbete/utsatta-omraden/); Skolverket planned-educations v4 school-units + /statistics/gr for 99648792 (check whether school-year labels are shifted), Skolenhetsregistret v2 for coordinates, SALSA export route, Skolinspektionen Skolenkäten per-school files; MCF WFS https://inspire.mcf.se/oversvamning/ows (NZ_Oversvamning_100/_200/_BHF), MCF kustöversvämning download, SMHI https://opendata-download.smhi.se/framtida_medelvattenstand/baserat-pa-ipcc-ar6-srocc-2019/, SGU https://api.sgu.se/oppnadata/forutsattningar-skred-finkornig-jordart/ogc/features/v1, MCF Skyfallskartering_Oversikt FeatureServer/0; Lantmäteriet STAC https://api.lantmateriet.se/stac-vektor/v1/collections; Geofabrik sweden-latest.osm.pbf; Trafikverket Nationell plan 2026–2037 bilaga 1 xlsx. Also list which Danish v2.0–v2.5.1 UI pieces are present/missing here. Commit: chore: parity endpoint probe.

PHASE 1 — UI foundation from DK v2.0–v2.5.1
Port what later phases need: Safety-style lower_better handling with direction-aware ranks and colours; Yearly | Quarterly chart toggle for rolling series; overlay-pill framework + stacked, collapsible legend column + canvas-renderer guard; datasheet panel pattern; verify-at-source links on every indicator and `make links`; quick jumps (camera only, never selection): Stockholm, Göteborg, Malmö, Sweden — keys S, G, M, W, ignored while typing or with modifiers. Zoom must never change the selection. Commit: feat: UI foundation ported from the Danish v2.5.1.

PHASE 2 — Population outlook (demographics)
SCB TAB6008 (+TAB698) → group "Outlook", kommun level: fc_growth (2026→2040 %), fc_growth_5y (2026→2031 %), fc_abs, fc_0_5, fc_6_16, fc_20_34, fc_80p (2040 counts and change vs 2026, single years summed). RegSO/DeSO inherit with °. Label: "SCB trend projection, published 2024-06-11". Outlook line in popups and area pages, projected segment dashed in Charts (as DK v2.5). Verify: recompute 5 kommuner straight from the API. Commit.

PHASE 3 — Safety (crime)
Best official route from the probe (Brå direct preferred; Kolada fallback). Group "Safety", lower_better: crime_1000, violence_1000, theft_1000, burglary_1000dw (per 1 000 dwellings from the SCB dwelling stock already on disk), vandalism_1000, drugs_weapons_1000, crime_trend, clearance_pct (only if published per kommun, else omit and log). Quarterly series if the source gives quarters; full history available. Crime chip after the existing chips. Polisen utsatta områden → vulnerable_area_share per DeSO/RegSO (area share inside utsatt / särskilt utsatt) + class, popup line "Police-designated vulnerable area (Dec 2025)", optional outline overlay. Verify 5 kommuner from source; tests like DK tests/test_safety.py. Commit.

PHASE 4 — Schools
Skolverket: every school unit with year 9 nationwide (resumable, throttled, cached raw) → merit value åk 9, share passing all subjects, share eligible for gymnasium, national-test averages, pupils, certified-teacher share, pupils per teacher, with valueType kept (OMITTED/ROUNDED ≠ 0) and correct school-year labels. Coordinates from Skolenhetsregistret. SALSA (actual − model) joined if the export route works, else logged. Skolenkäten safety/"trygghet" index if machine-readable, else logged. Group "Schools" at kommun/RegSO/DeSO (pupil-weighted means of published values; counts), hidden from the chip row. Map: Schools overlay (points, lazy per kommun), popup with value vs kommun vs Sweden, grade colour mode (5-step quintile ramp) as in DK v2.3, school datasheet. Attribution "Källa: Skolverket" + fetch date. Verify 5 schools one by one from the API. Commit.

PHASE 5 — Test property + Analysis + Compare
Port DK v2.4 testprop.js (Google Maps link / coordinates parser, short links refused with a named error), Sweden box 55.0–69.2 N / 10.5–24.3 E, exact kommun/RegSO/DeSO by point-in-polygon on our own rings (holes kept, lazy lookup file), pin in the hash, privacy line. Analysis sheet (left nav "Analysis") reading everything the dashboard carries for the pin's DeSO/RegSO/kommun: headline row, demographics, outlook, safety + vulnerable-area flag, nearest schools with results (computed distances, neighbouring kommuner included), and — once phases 6–7 exist — climate, services, public buildings, infra. Compare two pins, aligned rows, direction-aware, no overall winner. Tests (make test-js equivalent) with Swedish link cases. Commit.

PHASE 6 — Climate risk (official data only)
Group "Climate" + "Climate risk" overlay, horizon/scenario always in the label. v1: river flood share of land area per kommun/RegSO/DeSO inside MCF 100-yr, 200-yr and BHF polygons (areas without a mapped watercourse = "Not mapped"); coastal flood share below MCF kust levels +2.0 m and +3.0 m (label "Coastal water level +2.0 m (RH2000)"); mean sea level 2100 RCP8.5 (and RCP4.5 if cheap) share from SMHI, label "Mean sea level 2100 (RCP8.5, SMHI)"; SGU landslide caution-zone share (CC0); per-kommun flag "has own cloudburst mapping" from MCF. If GEOTORGET credentials exist in .env, add building-footprint shares from Lantmäteriet Byggnad; otherwise area shares only, logged. Follow the Danish v2.6 UI conventions if present on its branch (read-only), else DK v2.2 overlay conventions; disclaimer "Screening indicators for comparing areas, not a property-level risk assessment." Add a Climate section to the Analysis sheet (pin tested against the zones). Commit.

PHASE 7 — Overlays: Services, Public buildings, Infra
Services: OSM (Geofabrik Sweden or Overpass per kommun) grocery (supermarket/convenience), restaurants/cafés, and public-transport stops; if TRAFIKLAB_KEY exists use GTFS Sverige 2 stops instead of OSM stops. Points only, no area indicators (as in DK).
Public buildings: schools + förskolor from Skolverket, health (hospital/clinic/doctors), culture (library/theatre/museum), sports halls from OSM, category filter education / daycare / health / culture as in DK v2.2; source shown per point; if GEOTORGET credentials exist, use Lantmäteriet Byggnad ändamål (Samhällsfunktion) instead of OSM for buildings. No "open building case" part (Sweden has no national permit register — say so in docs).
Infra: hand-curated data/external/infra_se.geojson of 30–50 projects with source URL each — Trafikverket Nationell plan 2026–2037 named investments, Nya tunnelbanan (stations + opening years), Västlänken, Ostlänken, Lund and Uppsala trams, other major rail/metro/tram — fields as in the Danish infra file (status, opening year or window, budget + price base, stations); alignments from OSM railway=construction/proposed where tagged, otherwise stations only (never drawn guesses). Overlay pill, datasheet, Pipeline view with CSV, upcoming-projects line on area cards, growth-signal indicators projects_upcoming and stations_planned_1200m. Verify 5 projects against their sources. Commit(s).

PHASE 8 — Docs, verification, wrap-up
docs/PARITY.md (every source, URL, licence/attribution, level, caveats, refresh); DATA_MAP_SE.md sections updated; verification export docs/verification/parity_v1_2.csv (all 290 kommuner × new indicators + 30 sampled schools + 10 projects); README section + screenshots; monthly refresh workflow extended for the cheap sources; CHANGELOG entry drafted as v1.2 (not tagged). Final make validate / test / build / links clean. Then print a ≤ 40-line summary: what shipped per phase, what was skipped and why, every open ⚠, and the exact localhost review checklist. STOP — do not merge, tag or push.
