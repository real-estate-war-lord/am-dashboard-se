# UI overhaul v2.0 — plan and running log

Branch `v2.0-ui`, cut from `main` at v1.2.1 (`6dc69df`). **Do not push, merge or tag.**

A new session continues from here: read §Status, then the phase that is `TODO`.

---

## Status

| Phase | Scope | State | Commit |
|---|---|---|---|
| P0 | This plan | done | — |
| P1 | Navigation and routes | **done** | b6c914f |
| P2 | One toolbar on the Map | **done** | 12ef3a3 |
| P3 | Layers ▾ including Rental listings | **done** | d23651a |
| P4 | Indicator picker + period control | **done** | 79dd55e |
| P5 | Map area card | **done** | f81658e |
| P6 | Area page | **done** | 94154eb |
| P7 | Test property with Listings built in | **done** | bfe1383 |
| P8 | Export ▾ | TODO | |
| P9 | Number and label consistency | TODO | |
| P10 | Responsive | TODO | |
| P11 | Tests, screenshots, wrap-up | TODO | |

Open ⚠:
- `#data/areas/regso` renders 11.6 MB of HTML (3 363 rows × 67 indicator columns).
  Pre-existing, but it is a glitch by the quality bar of this round — the fix is the
  default column set (headline + active indicator) with the rest behind `Columns ▾`.
  Scheduled into P8 with the export work, since both are about what a table is *for*.

---

## Environment facts established at the start of the run

- `make build` → `dist/index.html` 16.9 MB, 290 kommuner, 3 363 RegSO, 67 indicators,
  11 macro series, plus `dist/listings.html` 205 KB. 0.7 s + data steps, no network.
- `make validate` green (67 indicators against `data/raw/*.meta.json`).
- `make test-js` green (51 tests: `tests/listings.test.js`, `tests/testprop.test.js`).
- `make test` green (`tests/smoke.js`, headless VM render of every view).
- Playwright 1.60.0 is installed system-wide for Python 3.13; `python3 -m playwright
  install chromium` was run at the start of this branch (browsers were missing).
- Node v24.13.1, Python 3.13.9.
- Reference repo (read-only): `~/Desktop/Denmark dashboard, funny project/am-dashboard-dk`,
  branch `v3.0-ui`; spec `docs/v3/UI_SPEC_v3.md`, brief `docs/v3/ENG_BRIEF_v3.md`,
  runner `overnight.sh`.
- Gateway: `https://am-se-listings.am-se-listings-gateway.workers.dev`,
  `GET /nearby?lat=&lon=&r=` (r capped at 3 000 m) and `GET /text?src=&id=`.
  **There is no bbox endpoint.** CORS allowlist: the Pages origin plus
  `http://localhost:8080` and `:8081`.

## Decisions taken while working (append-only)

- **Internal view ids stay.** `S.view` keeps `makro`, `table`, `market`, `pipeline`,
  `charts`, `area`, `sheet`; only the hash spelling and the nav labels change, and
  `table`/`market`/`pipeline`/`sources` become tab bodies of one `data` shell. This is
  the Danish brief's R3 mitigation and it keeps `tests/smoke.js` driving the same
  functions (`vTable`, `vMarket`, `vPipeline`, `vCharts`, `vArea`, `vMakro`).
- **Compare never existed in the Swedish edition**, so "remove Compare" is: accept
  `#compare` as an alias, never emit it, and collapse the two-pin Test property
  (`#analysis?a=…&b=…`) to one pin (`b` is dropped, `a` wins).
- **Listings bbox endpoint: added and deployed in P3.** `GET /bbox?s=&w=&n=&e=` is live
  (version 8bc4fb4f). 16 new tests; `/nearby` is byte-for-byte unchanged and a test asserts it. `npx wrangler whoami` is
  authenticated (OAuth token, this account), so the task's condition is met. A viewport
  is a rectangle and a radius around its centre either misses the corners or over-fetches
  by 50 %, and HomeQ upstream already takes a bounding box — so `GET /bbox?s=&w=&n=&e=`
  is clearly better for the map layer. It is a **new route**; `/nearby` is untouched, so
  the deployed Listings behaviour cannot regress. Deploy only after `gateway/` tests pass.
  The radius fallback stays in the client for the case where `/bbox` answers 404 (an older
  deployment), radius = half the viewport diagonal capped at 2 000 m.
- **Two bugs found by the browser, not by the unit tests.** `dropMaps()` called `map.stop()`
  before `map.off()`; Leaflet's `stop()` completes a pan animation, completing one fires
  `moveend`, and that handler writes the camera into `LF` — so a fresh `#map/0180?c=…&z=14`
  landed at the zoom of the map it had just replaced. And the area page's mini-map built its
  colour scale from the areas' own values while filling the polygons from the inherited ones,
  so a RegSO page showing a kommun-level indicator drew one flat colour under a legend that
  said "no data".
- **The fixture is recorded around two dense centres and re-anchored on the task's pin.**
  Live supply at 59.31972, 18.07194 was ten adverts, none within a kilometre, so the median
  rule, the group split and the markers all had nothing to act on. Recording around Västerås
  (general supply) and central Stockholm (the municipal queue) and moving each listing by the
  same offset gives 12 within 1 km, a 1-room bucket of nine and a 2-room bucket of two.
  `tests/fixtures/record_listings.py` states this at the top of the file.
- **dist/ and the `built` stamps are committed once, at the end.** `dist/index.html`
  is 17 MB and is tracked; committing it in each of eleven phase commits would roughly
  double a repository that is already 263 MB. The phase commits carry source, tests and
  docs; `dist/`, `dist/listings.html` and the three `built` dates in `data/processed`
  go in with the final commit.
- **`src/listings/view.js` is now an IIFE.** It declared `median` at top level and so
  does `app.js`; inlining both as classic scripts in one global scope blanked the page
  with `Identifier 'median' has already been declared` — the Danish brief's risk R1,
  hit on the first build. `build_dashboard.py` now runs `node --check` over all four
  inlined files.
- **The Playwright fixture is sanitised.** `docs/LISTINGS.md` promises that no
  third-party listing data is committed here. `tests/fixtures/record_listings.py`
  records a real gateway answer and replaces every third-party string (address,
  landlord, area, listing and image URL, description, source id) with a synthetic
  stand-in, keeping the source mix, allocation, audience, rooms, size, rent and
  coordinates. The recorded set is 10 listings — 6 HomeQ direct, 4 municipal-queue —
  with 7 one-room, 2 two-room and 1 three-room, which is exactly what the n ≥ 3
  median rule and the reserved-audience filter need to be exercised.
- **New pure modules** (IIFE, one `window.X`, `node --test`-able, inlined by
  `build_dashboard.py`): `src/route_core.js` (hash alias table + codecs),
  `src/export_core.js` (long-schema row builders + unit assertions). The listings
  logic already lives DOM-free in `src/listings/view.js` and is inlined into the
  dashboard rather than copied.

---

## The task, verbatim

MASTER TASK — UI overhaul v2.0 of the Sweden Macro Dashboard + full Listings integration, one unattended overnight run. Branch v2.0-ui (from main = live v1.2.1). Do not push, merge or tag.

GROUND RULES
1. Data principle unchanged: official figures or plain arithmetic only; suppressed ≠ 0; not covered = "Not covered yet"; every figure keeps source, period, fetch date, verify link. UI round: do not change data build scripts except where a bug below says so.
2. Reference (READ-ONLY, never edit/build/checkout there): ~/Desktop/"Denmark dashboard, funny project"/am-dashboard-dk. First read its overnight.sh and, on any local branch (git -C <dk> branch -a), docs/UI_SPEC_v3.md, docs/ENG_BRIEF_v3.md and the v3.0 code in src/app.js + src/style.css. That is the detailed spec and implementation of the same overhaul — port its components (IndicatorPicker, PeriodControl, Layers menu, study row, MiniMap with teardown registry, Export model, responsive shell, Playwright spec) rather than re-inventing them, adapted to Sweden: kommun / RegSO / DeSO, SEK, sv-SE number format on screen (space thousands, comma decimal), quick jumps Stockholm / Göteborg / Malmö / Sweden (keys S/G/M/W, camera only). Where this prompt and the Danish spec conflict, this prompt wins. Owner amendments that apply here too: Compare is removed entirely; Test property is ONE property at a time (URL codec list-capable for later).
3. Listings rules (unchanged, from docs/LISTINGS.md): area level only, never any own-rent field; count ≠ vacancy; advertised rent ≠ contract rent and never one series with SCB rents; medians by rooms only at n ≥ 3, labelled "advertised"; every card links to the original listing; queue listings are allocated by queue time and say so; polite use of the gateway (debounce, cache per session, no polling loops).
4. Quality bar: consistency and zero glitches beat extra features — one picker, one period control, one study row, one export schema, one number format, no overlapping legends, no horizontal overflow, zero JS errors.
5. Never stop or ask; decide, log in docs/UI_PLAN.md, continue. Write docs/UI_PLAN.md first (this task verbatim + phase checklist) and keep it current after every commit so a new session can "Continue from docs/UI_PLAN.md". Use subagents for bulk work. Commit per phase (feat:/fix:/docs:). Before each commit: make validate && make test && make test-js && make build clean + the Playwright spec for the phases done so far. Temporary servers on port 8081 (the gateway's CORS allows 8080/8081 only), always stopped. Playwright tests must not depend on the live gateway: intercept gateway calls with page.route and a recorded fixture (tests/fixtures/listings_stockholm.json, recorded once from the live gateway); plus one separate live smoke check.

PHASE 1 — Navigation and routes
Sidebar: exactly 4 items Map · Data · Charts · Test property, plus Export ▾ in the footer. Data tabs: Areas (old Table) · Projects (old Pipeline) · National series (old Market panels as a table) · Sources. Remove Compare entirely (no button anywhere; #compare… redirects to #property of pin a, or #map). Redirects so old links never break: #table/* → #data/areas/*, #pipeline → #data/projects, #market → #data/national, #sources → #data/sources, #analysis?a=… → #property?p=lat,lon[:label], listings.html#at=lat,lon&r=… → index.html#property?p=lat,lon&rad=…&show=listings (listings.html becomes a tiny redirect page; its code moves into the app as a module). Leaflet teardown registry: every map registered and removed before a view is replaced; window.__maps exposes live instances for tests.

PHASE 2 — One toolbar on the Map
Row 1 only: [unified search ▾] [Layers ▾] [Indicator ▾] [Period]; when drilled into a kommun one segmented level switch [RegSO | DeSO] on the same row. Unified search: kommun / RegSO / DeSO names and codes, Google Maps links and "lat, lon" (coordinate result → #property?p=…); quick jumps Stockholm · Göteborg · Malmö · Sweden at the top of the dropdown (S/G/M/W kept, camera only; zooming never changes the selection). Privacy sentence leaves the map (tooltip on search + Test property page). Row 2: indicator chips. REMOVE the separate overlay buttons (Schools, Infra, Public buildings, Services, Climate risk, vulnerable areas) → Layers ▾, with their sub-filters inside the menu; floating legends become keys only (no ONLY/filter buttons), stacked, collapsible, never overlapping. Full screen → top bar right. At 1366×768 the map top ≤ 200 px.

PHASE 3 — Layers ▾ including Rental listings
Feature layers in the menu: Infra projects · Public buildings (education / daycare / health / culture) · Services (groceries / food / transport) · Schools (merit colour mode) · Police-designated areas · Rental listings (live). Context section: climate zones (only when a Climate indicator is active, own hide toggle, zones=0).
Rental listings layer: markers from the am-se-listings gateway, grouped HomeQ / landlord portals / municipal queues with the same colours and toggles as the Listings page; zoom-gated (≥ 13, legend says "zoom in to see listings" below that); fetch for the viewport — if the gateway has a bbox endpoint use it, otherwise query the viewport centre with a radius covering the view capped at 2 km; debounce 600 ms on moveend, cache per tile/centre for the session, never refetch the same area. Marker click → the same listing card as the Listings module (image, address, landlord/area, rent, m², rooms, SEK/m²/yr, text start, Kampanj / Kö q1–q3 badges, "Open listing ›"). Legend: counts per group + gateway status (ok/stale/error, age). URL: lay=…,listings plus the group filter. If the gateway fails: legend line "Listings unavailable — gateway error, retry" and nothing else breaks. If a bbox endpoint would be clearly better, add it to the Worker with tests and deploy with wrangler ONLY if wrangler is already authenticated on this machine; otherwise log it as a follow-up and use the radius fallback.

PHASE 4 — Indicator picker + period control (shared everywhere)
One IndicatorPicker (button + popover: search, all groups, unit, ↓ lower-is-better, availability tag, "From the municipality" group on RegSO/DeSO pages) on Map, Area page, Data › Areas, Charts, Test property. One PeriodControl with modes: Year ▾ (history), Quarterly toggle where the series is quarterly (Safety), static badge for Outlook ("Projection 2026→2040 · SCB 2024") and for Climate (the indicator's own scenario, e.g. "Mean sea level 2100 · RCP8.5 · SMHI"). Choosing a Climate indicator draws its zones automatically (zoom ≥ 10, in the legend with hide toggle); any other indicator removes them. Projections purple + dashed, climate blue, observed green; never mixed in one legend.

PHASE 5 — Map area card
When a kommun is selected: name · län · inhabitants · level count, the 5 headline figures in one row (clickable = select indicator), actions [Open <kommun> page ›] [↗ Chart]. Everything else folds into toggles, closed by default, state in the URL: "Outlook 2040 ▸", "Upcoming projects (n) ▸". Card collapsible (–), remembers its state. Nothing else on the card.

PHASE 6 — Area page (kommun / RegSO / DeSO)
Header → 5 clickable headline tiles → picker + period + chips → study row: chart panel left (~60 %) | draggable mini-map right (~40 %, scroll zoom, ⤢ full screen, Esc closes, legend inside), equal height → toggles (<details>, show=): Population outlook (open by default on kommun pages), All figures, Sub-areas (RegSO / DeSO). Remove the KEY FIGURES block. RegSO/DeSO pages: kommun-level values dimmed with "municipality figure" (tiles) / "muni" tag (tables), never a lone °. Margins of error stay visible (±) everywhere a value has one. Chart panel modes: history line (area, parent, peer median, Sweden), snapshot → distribution strip, outlook → observed solid + projected dashed purple, climate → value with scenario caption and peer ticks.

PHASE 7 — Test property (#property?p=lat,lon[:label], one pin) with Listings built in
Same study-row component as the area page, anchored on the pin's finest area (DeSO > RegSO > kommun, level tag shown). Header: kommun · RegSO · DeSO · coordinates + [Open on map] [area ›] [OpenStreetMap ↗] [Copy link]. Always 5 headline tiles (pin's level where published, else kommun value labelled "municipality figure", never a grey filler). Radius select 500 m / 1 km / 2 km (rad=) drives rings, all "within radius" counts and the listings query. Mini-map draggable, ⤢, Layers ▾ (same menu as the map, including Rental listings).
Sections as <details> (state in show=):
- Rental listings nearby — summary line first: "n live listings within 1 km · HomeQ a · portals b · queues c" + medians by rooms (n ≥ 3, "advertised") + gateway status; a button [Show listings (n)] opens the full Listings module in place: cards, filters (allocation, audience, offer, rooms), sortable table, CSV export (semicolon), group toggles; the same listings appear as markers on the mini-map while the section is open. Caveats in one mono line: advertised rent ≠ contract rent; count ≠ vacancy.
- Services within radius (counts by category + nearest of each, markers on the mini-map).
- Public buildings within radius (grouped identical name+use+distance ±20 m with a count).
- Schools (nearest year-9 schools with merit value vs kommun vs Sweden).
- Infrastructure nearby (open by default).
- Safety (kommun crime figures + police-designated area flag for the pin's DeSO).
- Climate (pin tested against the zones for every climate layer).
- Area profile (all figures), Sources & as-of.
Empty state (no p=): input focused + one example link. Delete the separate Listings nav/page code paths once the module lives here (keep listings.html only as the redirect).
Export ▾ adds "Test property (CSV)" (property_label, lat, lon + long schema) and "Nearby (CSV)" (kind = infra|public|school|service|listing, name, type, status, distance_m, rent, m2, rooms, source, source_url — listings with their advertised rent, never an own rent).

PHASE 8 — Export ▾ (one menu, sidebar footer + Data header)
Items: This view (CSV) · All area data (long) · Projects · National series · Test property · Nearby · Sources catalogue. Long schema: level, code, name, parent_code, parent_name, lan, population, indicator, label, unit, period, period_type, value, margin_of_error, value_type (actual|projection|inherited|derived), inherited_from, direction, source, table_id, source_url, as_of, fetched, licence. Projects in their own file. CSV UTF-8 BOM, ";" separator, "." decimal, no grouping. Assert unit/magnitude agreement at export (SEK vs kSEK fields).

PHASE 9 — Number and label consistency
One fmt() path: sv-SE on screen, signed changes always signed, pp for share changes; "vs median" never as a percent of a median (pp for shares/rates, absolute difference in the unit for levels and per-1 000); one rank format "#n of N" (N = areas with a value, title explains); period select shows the active indicator's own latest period; K/T-tal never labelled "price per m²"; rent units SEK/m²/yr everywhere.

PHASE 10 — Responsive
≤ 1024 px: sidebar → 52 px top bar with ☰ drawer (Esc closes, focus returns); controls stack; chart and mini-map stack; listing cards one column; tables scroll inside their card; legends collapse to a "Legend ▾" pill on mobile. No horizontal overflow at 1366×768, 1440×900, 1536×864 and 390×844 on #map, #map/0180, #area/kommun/0180, a RegSO and a DeSO page, #data/areas/kommun, #data/projects, #charts, #property?p=59.31972,18.07194&show=listings.

PHASE 11 — Tests, screenshots, wrap-up
tests/ui_v2 Playwright spec (headless Chromium, gateway via fixture): 4-item sidebar; all redirects incl. #analysis, #compare, listings.html; no text "Compare", "Climate risk", "KEY FIGURES" outside allowed places; picker exactly once per view; climate indicator → zones legend, other → none; Layers menu has a Rental listings item and ticking it at zoom 14 on Stockholm adds lay=listings and draws ≥ 1 marker from the fixture; Test property: 5 tiles, no filler, mini-map drags (window.__maps), ⤢ works, "Show listings" renders cards + table + medians only where n ≥ 3, CSV header matches, no own-rent field anywhere; legends pairwise non-overlapping; export headers match the schema; zero pageerror on every route at every width; scrollWidth ≤ innerWidth. Live smoke (port 8081): Test property in Stockholm returns listings from the real gateway. Capture docs/ui_v2/*.png of every route at 1440 and 390. Update README screenshots, CHANGELOG v2.0 draft, docs/LISTINGS.md (now integrated), docs/UI_PLAN.md final. Print ≤ 40 lines: what shipped per phase, what was skipped and why, open ⚠, and a 10-point localhost review checklist. STOP — do not merge, tag or push.
