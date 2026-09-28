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
