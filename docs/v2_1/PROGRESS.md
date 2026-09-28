# v2.1 "Sweden fit" — progress

One section per phase, appended at the end of the phase. What was built, what was
decided differently and why, what is still broken, and what the next phase has to
know before it touches anything.

---

## P1 — test harness + the v2.0 audit bugs

Gate green: `make validate`, `make build`, `make test` (smoke + `node --test`),
`tests/ui_v2/spec.py --upto P11` (169/169), `tests/ui_v2_1/spec.py --upto P1`
(70/70).

### Built

**The harness — `tests/ui_v2_1/spec.py`** (+ `README.md`). Same `Report`, same
gateway interception, same port 8081 as the v2.0 spec, with three additions the
next phases should use rather than reinvent:

* `@check("id", phase="P1", needs=…)` — one registered check per acceptance item.
  `needs` is `page` (shared warm page), `fresh` (new page — what a **cold open**
  has to have) or `error` (fresh page whose gateway answers HTTP 500).
* `settle(page)` — waits until nothing on the page still says "Loading" (8 s cap).
  **Call it before every content assertion.** Reading before the lazy files land
  reads the placeholder, which is how v2.0 stayed green through three broken
  sections.
* `install_gateway(page, status)` counts requests, so "at most two in ten seconds
  against a 500" is checkable at all.

`report.json` goes to `--out` every run. `--shots` captures nine views at
1440×900, 1366×768 and 390×844, scrolling to a named section first where the
interesting thing is below the fold.

**A1 — the pin sections never finished loading.** `schLoad`, `srvLoad`,
`infraLoad` and `climLoad` all re-rendered only when `S.view === "analysis"`, a
name v2.0 retired. One helper now — `afterLazyLoad()`, with `isPinView()` — used
by all four, on the success **and** the failure path, coalesced on a 120 ms timer.
`grep -n '"analysis"' src/app.js` is clean apart from `route_core.js`, which
legitimately still migrates the old `#analysis` links. While a file is in flight
the section says so: `srvWaiting()` / `schWaiting()` gate Services, Public
buildings and Schools, so a reader never sees `0` or "none within" for a fetch
that has not come back. Södermalm now reads Grocery **31**, Restaurants 343,
Transport 80 — the spec recomputes all of those from `dist/services/*.json`.

**A2 — the listings retry storm.** `LST.pinFails` (per pin+radius) and
`LST.boxFails` (per viewport box, with `tries`) are the new state. The pin waits
for the reader's Retry; a map box gets one automatic retry after a 5 s backoff and
then waits too. `lstSectionBody` checks the error **before** calling
`lstWantPin()`, so the refresh that draws the error cannot re-trigger the fetch.
Measured: 1 request in 10 s against a 500, and exactly 1 more when Retry is
pressed.

**A3 — quarterly crime periods.** `scripts/import_bra.py` normalises every SOL
header label to `YYYY` / `YYYYKn` (`norm_period`) and carries the publisher's
"prel." out as a sixth CSV column. `build_makro.py` ships `q_prel`, `q_kind:
"single"` and (for SCB tables) `prel: {geography: "all" | year}`. In the UI the
period control's "latest" rule no longer applies in quarterly mode — it was
dropping the newest quarter, which is why 2026K2 was missing — and a preliminary
period gets a small amber **prel.** badge beside the select, in the indicator line
and on the tile. All 48 quarters are offered, 2014K1…2026K2.

The headline tiles survive a quarter: `periodFor(i)` gives an indicator without a
quarterly series its own latest year, so selecting 2026K2 for Crime no longer
blanks Growth, Income, Rent, Unemployment and Rented. The "as of" label names the
selected quarter.

Everything that called these "a rolling four-quarter sum" now says **single
quarter** — the period control, the chart toggle, both chart footers (which is
what a downloaded PNG carries), `README.md`, and `CHANGELOG.md`, where the v2.0
paragraph is corrected in place with a note saying no number changed.

**A4 — Data › National formats.** Decimals come from the series' own `fmt`
(`macDec`), so "1 337 SEK / m² / yr" and "1 464 dwellings / quarter". A y/y of a
rate or of a growth rate is in **pp** (`macDeltaUnit`), so the policy rate reads
"−0,8 pp y/y". `signed()` prints no sign for a change that rounds to zero, so
"−0,0" cannot appear anywhere on the page. `macCls` leaves a series with no stated
direction uncoloured. The five headline series are tiles **or** rows, not both —
each tile now carries its period and source where the row used to — and the tile
grid is `auto-fit` over a panel background, so an unfilled cell cannot read as a
grey box.

**A5/A6 — level controls.** The RegSO/DeSO buttons were missing the `sg` class
and rendered as native grey buttons; they are segments now, checked against
another segment's computed font, size, border and per-state background rather
than against a colour written into the test. The level badge names the level
actually on screen (`drawnLevel()`), with two honest special cases — see
DECISIONS.

**A7 — pipeline budgets.** No figure invented. A blank budget reads "programme
only" or "not published", each with the source's own note on hover, and the
caption explains both. The classification is curated in the new
`data/external/infra_budget_state.csv` and merged in `build_makro.py`.

**The small ones.** Boverket BME exports as the number **and** the word
(`value_label`, new column after `value`); it already rendered as words in the UI
through `fmtOf`, and a coded indicator now gets no y/y and no "Δ since" anywhere.
Preliminary SCB periods are badged from the table metadata. `src_periods` is kept
(the verify-at-source links read it) but trimmed to selectable years: 13.5 kB →
5.2 kB.

**Found in the screenshot review, not in the brief:** switching to Quarterly left
`MK.year` at `LATEST` — a year — so the select showed the *oldest* quarter while
the map kept drawing the yearly figure. `newestPeriod()` replaces every
`MK.year = LATEST` fallback.

### Deviations

All in `docs/v2_1/DECISIONS.md`. The two worth reading before touching anything:
`value_label` (not `label`) in the export schema, and the budget classification
living in its own curated CSV rather than in a regex over project prose.

Two v2.0 checks were **updated**, never deleted, both for the export schema
change: `tests/ui_v2/spec.py` P8's `LONG` constant and `tests/smoke.js`. The
smoke checks now index the long schema **by column name**, so the next insertion
cannot silently move them.

### Known issues, not fixed here

* `indExplain`'s "as of" at RegSO/DeSO still falls back to the *kommun* stamp
  (`src.kommun || src.regso || src.deso`) when the level has its own. Wrong-ish
  but pre-existing and out of P1's scope; the prel. badge already reads the right
  level, so the two can disagree on a RegSO table.
* The indicator picker's button truncates its label on the map toolbar
  ("Reported … per 1 000 in… ▾"). Cosmetic, pre-existing.
* Map polygon labels still mark an inherited value with a lone `°`. v2.0 removed
  that from tiles and tables and deliberately kept it on the map; left alone.
* Brå's quarterly export has no 2014K3/2014K4 — that is the source file, not the
  parser. Every other quarter from 2014K1 to 2026K2 is present.

### What the next phase must know

* **Run `./overnight.sh gate P<n>`**, not the specs by hand — it rebuilds first,
  and `dist/index.html` is generated, so an edit to `src/*.js` is invisible until
  `make build` has run.
* `tests/ui_v2_1/spec.py` is the place for your acceptance items. Register them
  with your own phase id and **call `settle(page)` before reading content**.
* New state on the listings module: `LST.pinFails`, `LST.boxFails`. If you add a
  path that fetches listings, respect them or the storm comes back.
* `afterLazyLoad()` is the only correct thing to call when a fetched file lands.
  Do not write a fresh `S.view === "…"` check.
* `periodFor(i)` / `newestPeriod()` / `drawnLevel()` / `isPrel(i, t)` are the new
  shared helpers. `drawnLevel()` is the one to extend if you add a view.
* The long export schema gained `value_label`. Any new row builder must set it
  (empty string for an ordinary indicator) or the column shifts.
* `data/external/infra_budget_state.csv` is curated by hand. If a source starts
  publishing a per-project budget, the figure goes into `infra_se.csv` and the row
  here is deleted — `build_makro.py` warns if it names a project that no longer
  exists.

---

## P2 — "Map only" mode

Gate green: `make validate`, `make build`, `make test` (smoke + `node --test`,
now 30 route tests), `tests/ui_v2/spec.py --upto P11` (169/169),
`tests/ui_v2_1/spec.py --upto P2` (135/135 — P1's 70 plus 65 new).

### Built

**`ind=none` is the mode, and it is the absence of an indicator — not another
indicator and not another layer.** It travels in the same `ind=` key, so an old
link keeps working, a Map only link is the same shape as any other, and the three
places that name the active indicator name it: the first chip, the first row of
the picker, and the key `0`.

`src/route_core.js` owns the spelling (`IND_NONE`, `stripNone()`): `ind=none`
survives on `map/*`, `area/*` and `property`, and is **dropped** from every path
that has no map. `tests/route.test.js` covers the codec in five new tests,
including idempotence on six more hashes.

`src/app.js` gained one predicate and one setter rather than a flag per view:
`mapOnly()` (the key *and* a view with a map), `setMapInd()` (what `0` comes back
to, and the period fix-up that four click handlers used to repeat each), and
`NONE_IND`, a synthetic indicator so `curInd()` still returns an object with a
label and an `fmt`. The outline style is three helpers next to the colour model —
`moStyle`/`moHover`/`moWeight` — used by all three maps, so the big map, the area
mini-map and the pin mini-map cannot drift apart.

In the mode: the choropleth is replaced by `#5C6B5F` outlines (1.1 px kommun,
0.7 RegSO, 0.5 DeSO) that stay clickable and highlight on hover; the indicator
legend is emptied (`.maplegend:empty` hides the box, and the Legend pill is not
rendered when there is nothing in the stack); the period control is not rendered;
the info strip reads **"Map only — pick an indicator to colour the areas"**; the
polygon labels are names with no value beside them. The popups keep every figure —
five headline rows instead of the big selected figure plus four — and the map's
area card, the area page tiles and Test property's tiles are untouched.

Every Layers ▾ layer works on top; the spec toggles the police-designated areas on
and off against a Map only map and checks the paths, the key and the hash.

`0` toggles, on the map, the area page and Test property, and is ignored while the
caret is in a field — both halves are checked.

**The screenshot review caught one thing the tests did not:** on a kommun's area
page `own` is *every* sub-area, so the "this is the page's area" 2.6 px stroke was
being given to all 127 Stockholm RegSO at once and the mini-map read as a black
mesh. The heavy stroke is now only for the page of one area.

### Deviations

Eight, all in `docs/v2_1/DECISIONS.md`. The three to know before touching this:
`ind=none` is stripped from non-map paths rather than ignored; the polygons keep a
**transparent fill** (`fill-opacity: 0`) because Leaflet will not hit-test the
interior of `fill: none`; and the hazard zones are the one layer Map only cannot
offer, because they ride a Climate indicator.

No v2.0 check was changed — the 169 still pass as written.

### Known issues, not fixed here

* The Charts picker has no Map only row and should not: a chart axis cannot be
  nothing. Its scope (`"chart"`) is excluded explicitly.
* At the national zoom the kommun labels are still suppressed by the polygon-size
  rule, so a Map only national map shows the basemap's names and not the
  dashboard's. Same rule as with an indicator; not a regression.
* `CHANGELOG.md` has no v2.1 section yet — P1 did not open one either. Whichever
  phase writes the release notes should cover P1 and P2 together.

### What the next phase must know

* **`mapOnly()` is the predicate, not `MK.ind === "none"`** — it also asks whether
  the view has a map. If you add a view with a map, add it to `MAP_ONLY_VIEWS`;
  if you add one without, do nothing and the mode will fall back for you.
* **Set the map indicator through `setMapInd(key)`.** It remembers `MK.indPrev`
  for `0` and fixes the period; assigning `MK.ind` directly loses both.
* A new map layer needs no Map only branch — the layers draw over the outlines
  unchanged. A new *choropleth* path does: look at `moStyle()` before inventing
  a second grey.
* `tests/ui_v2_1/spec.py` has `paths(page, "map"|"area"|"prop")` and
  `legend_state(page, sel)`, and `open_area_popup(page, name)` opens a polygon's
  popup through Leaflet instead of clicking a pixel. Reuse them.
* Three screenshot routes were added (`maponly`, `maponly-kommun`,
  `maponly-area`), so `--shots` now writes 36 files per run.

---

## P3 — Sweden fit: levels, vocabulary, defaults, search

Gate green: `make validate`, `make build`, `make test` (smoke + `node --test`, now
113 unit tests), `tests/ui_v2/spec.py --upto P11` (169/169), `tests/ui_v2_1/spec.py
--upto P3` (206/206 — P1+P2's 135 plus 71 new).

### Built

**The headline row leads with what exists below kommun.** `HL_LOCAL` is
`growth`, `income_med`, `renters`, `higher_ed`, `employment` — five figures SCB
publishes at DeSO and RegSO — and `rent` follows as the one kommun-only figure,
marked "municipality figure" wherever it is not the area's own. Six tiles, the same
six on the map's area card, on every area page and on Test property. `HL_SPARE`
only backfills a slot where one of the five is missing for that area.

Making that true on Test property meant fixing `eVal()`: it inherited the kommun's
figure for a RegSO and **not** for a DeSO, so rent was a dash on a DeSO page while
the map painted that same DeSO with the kommun's rent. `subKommun(e)` is the one
predicate now — `eVal`, `eYears` and the chart series read it, and `no_inherit`
still wins over all of it.

**A kommun-only indicator is no longer painted on every sub-area.** `#map/0180?ind=rent`
draws Stockholm filled with its own value against the national scale and its 127
RegSO as white outlines on top; `#map/0180/deso?ind=rent` does the same with 569
DeSO. The kommun polygon is `interactive: false`, so every click still belongs to
the sub-area under the cursor, and its popup still shows the kommun's rent marked
`muni`. The figure is printed **once**, on the kommun's own label. Three places say
why: an amber strip under the indicator line (`[data-testid=kommun-only-note]`), the
legend note, and the mini-map's own badge. The area page and Test property mini-maps
follow the same rule through `areaKomOnly()` / `komFillPoly()`.

**Tenure vocabulary.** `TENURE_WORDS` in `app.js` renames `renters` to "Hyresrätt
share" / "Hyresrätt", `new_rental`'s short to "New hyresrätt", and `rent_owner` to
name allmännytta and private — once, at load, so every surface including the CSV
export reads the same words. The English gloss is given exactly once, in a folded
help block in the indicator picker, together with the sentence that K/T-tal is the
purchase price divided by the assessed value and **not** a price per m².

**Charts opens with a chart.** Stockholm, Göteborg, Malmö and Uppsala against the
Sweden median, from `CH_DEFAULT_AREAS`. An explicit empty set is still reachable —
`clear`, or `#charts?a=-` — and the empty state now offers "+ the default four"
back. A plain `#charts` link is left plain rather than rewritten with today's
default.

**Search needs no å ä ö.** `src/search_core.js` (IIFE, `window.SEARCH_CORE`, 12 node
tests) folds diacritics through NFD plus a hand table for ø æ œ ß đ ð ł þ, derives
"<name>s stad" / "<name> kommun" for all 290 kommuner rather than curating them, and
ranks exact › prefix › word start › anywhere with the pool's order inside a rank.
The hand-written alias table is nine entries (sthlm, gbg, gothenburg, malmoe, lkpg,
nkpg, jkpg, hbg, vsts). RegSO names and both spellings of a RegSO/DeSO code are
searchable. The chart's "add an area" box goes through the same matcher.

**Units and the ±.** A tile prints the part of the unit `fmtOf` does not — "1 710
SEK" over "/m²/yr", "385 kSEK" over "/yr", "81,1 %" over "of population 20–64" — on
its own line, because inline it broke between a number and its own unit. The margin
of error's hover now reads "±28 = SCB margin of error (SEK/m²/yr)" instead of
nothing at all.

### Deviations

Fourteen, all in `docs/v2_1/DECISIONS.md`. The four to read before touching this:
the row is **six** tiles and three older checks were updated to say so; `eVal` now
inherits for DeSO; the mini-maps got the kommun-only treatment the brief only asked
of the big map; and `lvl=regso` is not a real key — the level is in the path.

Three checks were **updated, never deleted** — `tests/ui_v2/spec.py` P5 and P7, and
this spec's own P1 quarter check — all three from "exactly five tiles" to "five plus
at most one kommun-only".

### Known issues, not fixed here

* The **Data › Areas** table still shows a kommun-only indicator on RegSO/DeSO rows
  as the kommun's value with a `muni` tag, one row per area. That is the same
  one-figure-many-rows shape the map just stopped doing, but a table row is a row
  about an area and the tag is on every one of them, so it is honest as it stands.
  Worth revisiting if a later phase touches that table.
* The area mini-map fits to the page's own area, so on a kommun-only indicator most
  of the frame is one fill with faint outlines. Pre-existing fit behaviour.
* `indExplain`'s "as of" at RegSO/DeSO still falls back to the kommun stamp (P1's
  known issue, untouched).
* `CHANGELOG.md` still has no v2.1 section. P1, P2 and P3 all skipped it; whoever
  writes the release notes now has three phases to cover.

### What the next phase must know

* **The headline row is six tiles, and `headlineInds()` is where the set lives.** It
  is `HL_LOCAL` + `HL_SPARE` (backfill only) + `HL_MUNI`. Adding a seventh headline
  means changing the grid too — `.hl.n6` is an explicit six-column rule.
* **`subKommun(e)` is the inheritance predicate.** Do not write a fresh
  `e.type === "regso"` test; DeSO inherits now as well.
* **Three maps, one kommun-only rule.** `kommunOnlyMap()` for the big map,
  `arKomOnly()` / `propKomOnly()` for the mini-maps, both through `areaKomOnly()`.
  A new choropleth path needs one of them, or it will paint a kommun figure across
  every sub-area again.
* **`mapLevelKey()` is the zoomend rebuild key.** A new map mode that changes which
  polygons are drawn must be part of it.
* **Indicator wording is `TENURE_WORDS` in `app.js`, not `config/`.** Add to that
  table; `make validate` checks codes against SCB metadata and will not see labels.
* `src/search_core.js` is inlined between `route_core.js` and `listings/view.js`
  (`scripts/build_dashboard.py` `JS_FILES`, `src/index.html`, and `tests/smoke.js`'s
  sandbox — all three have to agree, and smoke.js fails loudly if they do not).
* `CH_EMPTY` is `"-"`. Any other view that wants a linkable empty collection should
  copy the pattern rather than rely on an empty value surviving `buildHash()`.
* Four screenshot routes were added (`komonly-regso`, `komonly-deso`, `area-regso`,
  `charts-default`), so `--shots` now writes 48 files per run.

---

## P4 — map-first layout and page weight

Gate green: `make validate`, `make build`, `make test` (smoke + `node --test`, now
122 unit tests), `tests/ui_v2/spec.py --upto P11` (169/169), `tests/ui_v2_1/spec.py
--upto P4`.

### Built

**The map is the page.** At 1366×768 `#map`, `#map/0180`, `#map/0180/deso` and
`#map?ind=none` all start the map within 200 px of the top of the window and it
takes the rest of it. Two changes got there:

* `#lfmap`'s height is **measured**, not guessed. The stylesheet said
  `clamp(380px, 100vh - 250px, 760px)`; 250 px was an estimate of everything above
  the map and was wrong by a different amount at every display scaling.
  `fitMapHeight()` reads the container's real top and fills the window, on first
  paint, on resize and on both sides of the full-screen toggle. The CSS rule
  stays as the pre-script fallback.
* **The kommun's card is a panel over the map**, not a block above it — 334 px at
  the top left on a desktop, a bottom sheet on a phone, collapsible to its own
  title bar. It is the whole card: name, the six headline tiles, Open page, Chart,
  Outlook 2040 and Upcoming projects. Collapsed state is in the URL (`card=0`);
  `localStorage` is gone, so two people following one link see one map.

The map's four corners are now allotted, and the spec measures every pair for
overlap: the panel top left, the legend stack top right, Leaflet's zoom control
bottom left (moved out from under the panel), and the "published per kommun only"
note along the bottom. That note used to be three lines of amber prose above the
map costing 79 px — the whole reason `#map/0180?ind=rent` missed the budget. It is
one line on the map now, with the full sentence on its hover, the same treatment
the two mini-maps have always had. On a phone every one of those has a lane of its
own in the map's top half, because the sheet owns the bottom half.

**Page weight: 17.1 MB → 4.8 MB.** Two independent changes.

* **Rings are strings.** Every ring in `data/processed/` is delta-encoded against
  the previous point, zig-zag, 5 bits per character, base64url alphabet —
  Google's polyline algorithm with a different alphabet, because polyline's 0x3F
  offset puts `\` in the range and JSON doubles every one of them. Lossless at the
  5 decimals `rings_of()` already rounded to: 8.9 MB of geometry became 2.0 MB, and
  `data/processed/deso/` fell from 15 MB to 8.9 MB with it. `enc_ring()` in
  `build_makro.py` is the encoder, `src/geo_core.js` the only decoder, and
  `tests/geo.test.js` (9 tests) checks the round trip, the corrupt-input path, the
  idempotence of `decodeRings()` and the real build output's coordinate order.
* **RegSO left the page.** `dist/index.html` carries the 290 kommun outlines and a
  RegSO name index — `code`, `name`, `kommun`, 0.25 MB — and nothing else below
  kommun level. `dist/regso/values.json` holds every figure for all 3 363,
  `dist/regso/<kommun>.json` one kommun's rings. The figures are merged **into**
  the objects the page was built with, so `byRegso`, `AREA_OPTS` and every
  reference taken before the fetch stay valid.

Every surface that reads a RegSO figure asks first and says "Loading…" otherwise —
the Data table, a RegSO area page, a kommun page's sub-area table, a RegSO chart,
the map. Every surface that *draws* RegSO goes through `regsoDrawable(kommun)`,
which is empty until the ring file is in; the counts beside them ("127 RegSO") come
from the index, so nothing ever reads 0. The map draws the kommun's own outline —
which is in the page — while its areas are on the way, so a drill-down moves the
camera immediately.

`tests/ui_v2_1/spec.py` P4 drives that state on purpose: `window.fetch` is wrapped
before the page loads and `regso/values.json` is held open, so the checks read what
the page says with the file missing, and then read it again after releasing it.

**The export fetches what it needs.** "All area data" awaits the RegSO figures and
every DeSO file before it writes; the spec recomputes the row count from the
processed files — 556 185 — and compares. `window.AM` gained `RG`, `regsoReady()`,
`loadAreas()`, `exportRowCount()` and `injectRegso()`, the last of which is how
`tests/smoke.js` (which has no `fetch`) puts the pool in place from disk, so every
existing smoke assertion about RegSO figures and rings still runs — through the
real decoder.

### Deviations

Eleven, all in `docs/v2_1/DECISIONS.md`. The four to read before touching this:
quantised strings rather than TopoJSON and why; RegSO leaves in **two** files, not
one per kommun; `regso/values.json` is fetched on the first paint's timer rather
than on first use; and a kommun page's mini-map showing a kommun-level indicator
draws the 290 kommuner rather than 3 363 RegSO tinted with their kommun's value.

No v2.0 check was changed — the 169 still pass as written.

### Known issues, not fixed here

* `data/processed/` grew a `regso/` directory (5.9 MB) that is committed like the
  DeSO one. `makro.json` itself fell from 16 MB to 4.0 MB, so the repository is
  smaller overall, but the two directories are now 14.8 MB of committed JSON.
* A phone that opens a kommun-only indicator loses the note when it opens the
  legend stack — they want the same lane. The legend carries the same sentence,
  which is why the note stands down rather than being drawn under it.
* The area mini-map still fits to the page's own area (P3's known issue), and
  `indExplain`'s "as of" at RegSO/DeSO still falls back to the kommun stamp (P1's).
* `CHANGELOG.md` still has no v2.1 section. P1–P4 have all skipped it; whoever
  writes the release notes now has four phases to cover.

### What the next phase must know

* **`dist/index.html` has a 5 MB budget.** `build_dashboard.py` prints how much of
  it is used and warns past it; the spec's `page-weight` check is what fails the
  gate. Anything you are about to inline, weigh first.
* **`window.DATA.regso` is a name index, not the data.** `code`, `name`, `kommun`
  and nothing else until the fetches land. Read a figure only behind
  `regsoReady()`; draw a polygon only from `regsoDrawable(kommun)`; count areas
  from `RG_IDX[kommun].n` or `regsoAll(kommun)`, never from what is drawn.
* **Rings are encoded strings everywhere in `data/processed/`.** `src/geo_core.js`
  decodes, and it is the only thing that may. [lat, lon] in, [lat, lon] out — the
  one swap in the pipeline is `rings_of()` in `build_makro.py`. See CLAUDE.md.
* **`fitMapHeight()` owns `#lfmap`'s height.** If you add anything above the map,
  re-measure at 1366×768: the budget is 200 px and `#map` currently sits at ~176.
  A new overlay on the map needs a corner nobody else has — the spec measures
  panel × legend × zoom × note for overlap at three viewport sizes.
* **`MC.fold` is the panel's collapsed state and it lives in the hash** (`card=0`),
  written only when collapsed. `mcFolded()` is the reader.
* `periodPool()`, not `curPool()`, is what the period controls read — it falls back
  to the kommuner while a sub-level pool has no history yet, so a shared `y=2020`
  link survives the load.
* Four screenshot routes were added (`mapfirst`, `mapfirst-kommun`,
  `mapfirst-folded`, `mapfirst-deso`), so `--shots` now writes 60 files per run.
