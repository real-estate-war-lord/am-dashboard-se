# v2.1 — decisions taken without asking

One line per judgement call an unattended phase had to make, with the phase id in
front. A reader should be able to reverse any of them from this file alone.

- **P1** — `value_label` is inserted into the long export schema after `value`
  rather than reusing `label`: `label` is already the *indicator's* label, and the
  phase brief's "a `label` column gets the word" cannot mean overloading it.
  `tests/ui_v2/spec.py` P8 and `tests/smoke.js` are updated to the new order
  (never deleted), and `tests/export.test.js` asserts the position.
- **P1** — the "prel." flag is recorded **per geography** (`prel: {kommun: "all"}`)
  rather than per indicator. Unemployment is preliminary at kommun (SCB TAB6260,
  "Preliminary statistics") and final at RegSO/DeSO (TAB6680); one flag for the
  whole indicator would badge a figure that is not preliminary.
- **P1** — `src_periods` is **kept** in the payload, not dropped: `srcPeriods()`
  in `app.js` reads it to build every verify-at-source link on a monthly or
  quarterly table. It is trimmed instead to the years the reader can actually
  select (2014 onwards), which is what the brief's "if nothing reads them" was
  aiming at. 13.5 kB → 5.2 kB; CPI's list ran back to 1980M01.
- **P1** — which blank budget is "programme only" and which is "not published" is
  **curated data**, in the new `data/external/infra_budget_state.csv`, not a regex
  over the projects' prose. Only one of the four nya tunnelbanan rows happens to
  mention the programme in its notes, so a regex would have called the other three
  "not published" while the caption said otherwise. `scripts/build_infra.py` needs
  the OSM extract to run, so the merge happens in `build_makro.py`, which already
  loads `infra_index.json` into the payload.
- **P1** — the level badge distinguishes three cases rather than two: `<level>
  level`, `<level> rows · <published level> figures` (finer than the publisher
  goes — rent and reported offences below kommun), and `not published at <level>`
  (coarser, e.g. the socio-economic index at kommun). The decision uses the
  indicator's `level` (finest level actually published), not `levels` (where it
  may be *shown*, inheritance included).
- **P1** — `signed()` prints no sign for a change that rounds to zero at the
  precision shown, so "−0,0" cannot appear anywhere. This is the one signed path,
  so it also affects tiles, tables and charts, not just Data › National.
- **P1** — the five headline National series are tiles **or** table rows, not
  both. The table's hint line says so and each tile now carries its period and
  source where the row used to.
- **P1** — a re-render triggered by a lazily loaded file is coalesced on a 120 ms
  timer (`afterLazyLoad`). A pin near a kommun boundary pulls up to a dozen files
  and each one would otherwise rebuild the whole page.
- **P1** — switching to Quarterly, or opening a `fq=q` link with no `y=`, now
  selects the **newest quarter**. Falling back to `LATEST` (a year) left the
  select showing the oldest quarter while the map went on drawing the yearly
  figure. Not in the brief; found in the P1 screenshot review.
- **P1** — a coded indicator (Boverket BME, cloudburst mapping) gets no y/y and no
  "Δ since" anywhere: "Shortage → Balance" is not +1 pp.
