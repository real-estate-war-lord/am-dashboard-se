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
