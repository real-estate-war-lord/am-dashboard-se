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
- **P2** — `ind=none` is **dropped from the hash** on every path that has no map
  (`data/*`, `charts`, the sheet views) rather than carried and ignored:
  `route_core.js` `stripNone()` does it, and the view falls back to its first
  indicator. A Data table's highlighted column and a chart axis cannot be "no
  indicator", and a shared link that said `ind=none` there would name a column
  that cannot exist. Dropping a key is idempotent, so `toV2()` is still safe to
  run on every hashchange.
- **P2** — in Map only the polygons keep a **transparent fill** (`fill-opacity: 0`)
  rather than `fill: false`. Leaflet only hit-tests the interior of a path whose
  `fill` attribute is not `none`, so `fill: false` would have left a 1 px stroke as
  the only click target on 3 363 RegSO. The spec asserts fill-opacity, never the
  presence of the attribute.
- **P2** — the hover highlight in Map only is the **stroke only** (darker, ~2.5×
  thicker), never a wash of fill. That keeps "in Map only nothing is filled" true at
  every moment, including while the cursor is on an area, so the check does not
  depend on where the mouse is.
- **P2** — on the area page and Test property, Map only **removes the chart panel**
  and gives the row to the mini-map. A chart panel about no indicator is a card of
  dashes; the brief asks for the mini-map, and the headline tiles above it keep the
  figures on the page.
- **P2** — the **hazard zones are not offered in Map only.** They are the one layer
  that rides an indicator (`climOn()` needs a Climate indicator to know which
  layer), so with no indicator selected there is nothing to draw; picking one for
  the reader would be inventing a scenario. This is what the brief's "climate zones
  **where applicable**" resolves to. Every other Layers ▾ layer works unchanged.
- **P2** — the map popups in Map only show **five** headline figures instead of the
  big selected figure plus four. There is no selected indicator to lead with, and
  an empty big row would read as a missing value rather than as no question asked.
- **P2** — a Chart link out of Map only (`↗ Chart`, the area card, the popups) names
  the first available headline indicator rather than passing `none` to an axis.
- **P3** — the headline row is **five figures published below kommun plus one
  kommun-only figure**, six tiles, not five. The brief's "five … plus at most one
  kommun-only figure (rent)" reads as six, and rent is the question a housing
  dashboard is opened with. The final set: `growth`, `income_med`, `renters`
  (hyresrätt share), `higher_ed`, `employment`, then `rent`. `HL_SPARE`
  (`unemp`, `young`, `flats`, `single`, `income`) only fills a slot where one of the
  five has no value for that particular area — it is not a seventh headline. Two v2.0
  checks were **updated, not deleted**, from `== 5` to `5 <= n <= 6` (P5 "five
  headline figures in one row", P7 "always five headline tiles"), and so was P1's
  "the five headline tiles survive a quarter".
- **P3** — `eVal()` now inherits the kommun's figure for a **DeSO** as well as a
  RegSO. It did not, which is why rent was blank on a DeSO area page and on a pin
  that landed in one — while the map had always tinted that same DeSO with the
  kommun's value. One of the two had to be wrong, and the map was right: the figure
  does describe the ground the DeSO is on. `subKommun(e)` is the single predicate
  now, used by `eVal`, `eYears` and the chart series, and it still respects
  `no_inherit` (the police designation is never inherited anywhere).
- **P3** — a kommun-only indicator drilled into RegSO/DeSO draws the **kommun polygon
  filled** under **white sub-area outlines** (`.ko-fill` / `.ko-outline`), not a flat
  wash. White rather than Map only's dark green: these sit on a filled kommun that can
  be any shade of the ramp, and a mid-grey line vanishes on the dark end of it — white
  is also what every other choropleth boundary here uses. The kommun polygon is
  `interactive: false`, so the outlines over it keep every click, and a sub-area popup
  still carries the kommun's figure marked `muni`.
- **P3** — the same rule is applied to the **area page and Test property mini-maps**,
  which the brief did not name. It had to be: the new rent tile puts a kommun-only
  indicator one click away on every RegSO and DeSO page, and a mini-map answering it
  with a flat wash would undo on the small map exactly what the big one stopped doing.
  `areaKomOnly()` and `komFillPoly()` are shared by all three.
- **P3** — the brief's route `#map/0180?ind=rent&lvl=regso` does not exist as written:
  v2.0 put the level in the **path** (`map/0180` is RegSO, `map/0180/deso` is DeSO) and
  `route_core.js` owns that spelling, so inventing an `lvl=` key would be a second way
  to say one thing. The spec checks the path form **and** the brief's literal link,
  which must draw the same map with the unknown key ignored.
- **P3** — the tenure wording is overridden in `app.js` (`TENURE_WORDS`), not in
  `config/indicators.json`: the registry is generated from and validated against SCB's
  table metadata, and `config/` is forbidden to this phase anyway. `renters` becomes
  "Hyresrätt share" / "Hyresrätt", `new_rental`'s short becomes "New hyresrätt", and
  `rent_owner` names allmännytta and private. One override table, applied once at load,
  so the picker, chips, tiles, popups, tables, chart titles and the CSV export cannot
  drift apart.
- **P3** — the English gloss is a **folded help block in the indicator picker**, not a
  tooltip on every tile. Glossing hyresrätt on each of six tiles would say the page is
  apologising for the word; the picker is where a reader who does not know it is already
  looking things up. It carries the K/T-tal sentence too.
- **P3** — Charts' default set is written into `CH.areas` at load, and an emptied set is
  spelled `a=-` in the hash. `buildHash()` drops an empty value, so `a=` could not
  survive a reload and `clear` would silently come back as the default four; `a=` typed
  by hand still means the same thing. A plain `#charts` link is **not** rewritten with
  the default on arrival — freezing today's default into every shared link is not what
  "opens with" means.
- **P3** — the RegSO literally named "Södermalm" is in **Umeå** (2481R006), not
  Stockholm, whose Södermalm is cut into RegSO with other names. The brief's
  "sodermalm → Södermalm RegSO" is satisfied and the search test asserts the Umeå one;
  nothing is wrong, but the next reader of that test should not be surprised.
- **P3** — the unit and the ± sit on **their own line under the figure** on a tile, and
  inline only in the area page's hero. Inline on a 180 px tile the line broke between
  the number and its own unit — "1 710" over "SEK/m²/yr" — which reads as two figures.
  `tileUnit()` prints only the part `fmtOf` does not ("1 710 SEK" + "/m²/yr", never
  "1 710 SEK SEK/m²/yr").
- **P3** — `mapLevelKey()` is now used on **both** sides of the zoomend rebuild test. It
  was spelled out inline there without the mode suffix, so every zoom step in Map only
  rebuilt the polygon layer and closed any open popup. Not in the brief; found while
  adding the `:ko` suffix.
