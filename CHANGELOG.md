# Changelog

## v2.1.1 — one pin, and it stays put

Two bugs, both of them the same pin being thrown away, and both reported on the
live v2.1 page. No data build changed and no number moved.

**A pasted Google Maps link drops a pin on the map.** Typing a link or a
"59.31972, 18.07194" pair into the map's search box used to leave the map
altogether and open Test property — it answered a question the reader had not
asked yet and threw away the map they had just built. It now behaves the way the
Danish edition's `asrchRows()` / `tpDrop()` do: the search row reads **Drop a pin
here**, the ordinary navigation drills to the pin's own kommun with the
indicator, the year, the quarter and the layers all still selected, the pin lands
with dashed rings at 500 m, 1 km and 2 km (the chosen radius solid), and the
camera goes to it once. The rings and the marker are `interactive: false` and sit
in a pane of their own above the choropleth, so a click still reaches the polygon
underneath and the schools and services dots are not drawn over the pin. A pin
card takes the map's one free corner — bottom right on a desktop, the top lane on
a phone — and says what the pin is called, which kommun, RegSO and DeSO it
actually fell in, and offers **Open Test property ›**, which carries the pin and
the radius over. A link pasted while already on Test property still replaces the
pin there, as before.

**Test property no longer forgets the pin.** The sidebar's Test property link was
always the bare `#property`, and a bare `#property` set the pin to null — so
every trip through Data or Charts and back landed on an empty paste box with the
pin still sitting in memory. The pin is now one pin shared by the map and the
page: a link that names one (`p=` on Test property, `pin=`/`pl=`/`rad=` on the
map) sets it, a link that names none says nothing about it, and the only thing
that forgets it is the clear button. The nav items carry it, "Open on map" and
"Open Test property ›" carry it in both directions, and the last pin is kept in
`localStorage` under `se.lastPin` (every access wrapped — a private window or
blocked storage costs the pin its life beyond the tab and nothing else) so a
reload of a bare `#property` comes back to the property the reader was looking
at. Clearing clears the stored copy too.

**Two things the new checks found on the way.** The pin's camera was being
issued into `applyPendingFit()`'s animated `fitBounds` to the kommun, and a
`setView` into an animation in flight is swallowed — the map ended on the kommun
every time a pin was dropped. The pin now takes the pending fit off the kommun
before it happens rather than racing it. And two renders in the same tick
schedule two map inits, the second of which threw "Map container is already
initialized" as an uncaught page error; every init now stands down when Leaflet
has already marked the container. That one predates this release — it was on the
v2.1 page too, invisible until a check watched `pageerror` on a cold open of
`#property?p=…`.

**Under it.** `src/route_core.js` gained `pinParse()` / `pinQuery()` — the map's
spelling of the same point Test property spells `p=lat,lon:label` — and
`toInternal()` hands a map link's pin back parsed, the way it already handed back
`p=`. `rad=` is left out when it is the radius nobody chose, so the two views
agree on what no `rad=` means. Nine new cases in `tests/route.test.js`; a new P7
in `tests/ui_v2_1/spec.py` (four checks, ~60 assertions) that pastes the link,
reads the hash, counts the drawn rings and their `interactive` flag, walks
Map → Test property → Data → Test property through the sidebar and compares the
tiles before and after, reloads a bare `#property`, and clears. `tests/ui_v2/spec.py`
P2 and P7 were updated to the behaviour the search box and the pin now have.

## v2.1 — "Sweden fit"

v2.0 built one of everything. This release makes the page fit the country it is
about, and fixes the four things an audit of v2.0 found that its own 169 checks
had passed over. No data build changed a number: what changed is which figures
lead, what the page says while it is still loading, how much of it has to arrive
before anything is drawn, and how much it weighs.

**The map is the page.** At 1366×768 the map starts within 200 px of the top of
the window and takes the rest of it, on every map route including Map only. Its
height is now *measured* (`fitMapHeight()`) rather than guessed at
`100vh - 250px` in the stylesheet — the 250 px was wrong by a different amount at
every display scaling. The selected kommun's card moved onto the map as a 334 px
panel at the top left, collapsible to its own title bar, a bottom sheet on a
phone; its collapsed state travels in the URL (`card=0`) instead of
`localStorage`, so two people following one link see one map. The map's four
corners are allotted — panel, legend stack, zoom control, the "published per
kommun only" note — and the spec measures every pair of them for overlap at
three viewport sizes.

**The page is 4.8 MB, down from 17.1.** Two independent changes. Every ring in
`data/processed/` is now one delta-encoded string rather than an array of
coordinate pairs — zig-zag, 5 bits per character, base64url alphabet, lossless at
the five decimals the build already rounded to, 8.9 MB of geometry into 2.0 MB
(`enc_ring()` in `build_makro.py` encodes, `src/geo_core.js` is the only decoder).
And RegSO left the page: `dist/index.html` carries the 290 kommun outlines and a
RegSO *name* index, while `dist/regso/values.json` holds all 3 363 areas' figures
and `dist/regso/<kommun>.json` their boundaries. Everything that reads a RegSO
figure asks `regsoReady()` first and says "Loading…" otherwise; everything that
draws one goes through `regsoDrawable(kommun)`. A dash in this dashboard means
the source suppressed the value, so a file still in flight may not borrow one.

**"Map only" is a mode, and it is the absence of an indicator** — not another
indicator and not another layer. It travels in the same `ind=` key (`#map?ind=none`),
so an old link keeps working and a Map only link is the same shape as any other.
The choropleth becomes clickable outlines, the legend and the period control are
not rendered, the polygon labels are names with no value beside them, and the
popups show five headline figures instead of the selected one plus four. `0`
toggles it, and is ignored while the caret is in a field. Every Layers ▾ layer
works on top; the hazard zones are the one exception, because they ride a Climate
indicator and picking one for the reader would be inventing a scenario.

**The headline row leads with what Sweden publishes below kommun.** Six tiles:
`growth`, `income_med`, hyresrätt share, `higher_ed`, `employment` — all five
published at DeSO and RegSO — and then rent, the one kommun-only figure, marked
"municipality figure" wherever it is not the area's own. The same six on the
map's area card, on every area page and on Test property.

**A kommun-only indicator is no longer painted on every sub-area.**
`#map/0180?ind=rent` draws Stockholm filled with its own figure against the
national scale and its 127 RegSO as white outlines on top, with the figure
printed once, on the kommun's own label. Three places say why: a note on the map,
the legend, and the mini-maps' own badge. The two mini-maps follow the same rule.

**Tenure vocabulary, glossed once.** `renters` reads "Hyresrätt share",
`new_rental` "New hyresrätt", and `rent_owner` names allmännytta and private —
applied once at load, so the picker, chips, tiles, popups, tables, chart titles
and the CSV export cannot drift apart. The English gloss, and the sentence that
K/T-tal is the purchase price divided by the assessed value and **not** a price
per m², are in a folded help block in the indicator picker.

**Search needs no å ä ö.** `src/search_core.js` folds diacritics, derives
"<name>s stad" and "<name> kommun" for all 290 kommuner rather than curating
them, and ranks exact › prefix › word start › anywhere. RegSO names and both
spellings of a RegSO/DeSO code are searchable. Charts opens with Stockholm,
Göteborg, Malmö and Uppsala against the Sweden median; an explicitly empty set is
still reachable (`#charts?a=-`).

**Test property answers seven questions before the reader scrolls.** A summary
strip at the top of the page: nearest transport stop, groceries within 500 m,
nearest year-9 merit, whether the pin is in a mapped hazard zone, whether it is
in a police-designated area, live listings within the radius and the median
advertised rent. One model (`stripItems()`) feeds the DOM and the Nearby export,
so they cannot disagree, and every item is a button that opens the section its
figure comes from. An input still in flight reads "…" and names what it is
waiting for — never 0. The hazard item has three answers, not two: Yes, No and
**Not mapped**, because a layer that never surveyed a spot is not a clean bill of
health. Direct and queue supply are split and never averaged: the medians are
over the direct listings only, with a caption saying so, and the queue block
carries the sources' own queued-time figures or says they are not published. The
six-line privacy paragraph is one line with the whole position a click away.

### Fixed

- **Four sections on Test property never finished loading.** `schLoad`,
  `srvLoad`, `infraLoad` and `climLoad` all re-rendered only when
  `S.view === "analysis"`, a view name v2.0 retired — so Services read "Grocery
  0" for a pin with 31 groceries within a kilometre, for months. One helper
  (`afterLazyLoad()`) now, on the success and the failure path, and while a file
  is in flight the section says so instead of printing a count off a file that
  has not arrived.
- **A failing listings gateway was asked ~90 times in 14 seconds.** The error
  render re-triggered the fetch that had just failed. A pin now waits for the
  reader's Retry; a map box gets one automatic retry after a 5 s backoff and then
  waits too. Measured: one request in ten seconds against an HTTP 500, and
  exactly one more when Retry is pressed.
- **The newest quarter was missing from the crime period control.** The "latest"
  rule was a year rule applied to quarters. All 48 are offered, 2014K1…2026K2,
  and a preliminary period is badged **prel.** from the table's own metadata.
  Switching to Quarterly also left the period at a *year*, so the select showed
  the oldest quarter while the map drew the yearly figure.
- **Data › National printed every series to the same precision and called every
  change a per cent.** Decimals come from the series' own format, a change in a
  rate is in pp, and `signed()` prints no sign for a change that rounds to zero,
  so "−0,0" cannot appear anywhere on the page.
- **The RegSO/DeSO level buttons were missing a class** and rendered as native
  grey buttons beside the segmented controls they belong to.
- **A blank project budget rendered as a dash**, which in this dashboard means a
  suppressed value. It reads "programme only" or "not published" now, from a
  curated `data/external/infra_budget_state.csv`, with the caption explaining
  both.
- **`eVal()` inherited the kommun's figure for a RegSO and not for a DeSO**, so
  rent was a dash on a DeSO area page while the map painted that same DeSO with
  the kommun's rent. `subKommun(e)` is the one predicate now, and `no_inherit`
  still wins over it.
- **The kommun page's mini-map drew all 3 363 RegSO tinted with their kommun's
  value** for a kommun-level indicator — 290 figures repeated over twelve times
  as many polygons. It draws the 290 kommuner.
- **On a kommun's area page the "this is the page's area" stroke was given to
  every sub-area at once**, so Stockholm's mini-map read as a black mesh.
- **Boverket's BME exported as a bare code.** The long schema gained a
  `value_label` column after `value`, and a coded indicator gets no y/y and no
  "Δ since" anywhere: "Shortage → Balance" is not +1 pp.
- **The Pipeline table's status dot wrapped onto the line above its word**, so
  the colour belonged to nothing.
- **The map toolbar clipped the indicator's name** to "Rent, … S… municipality ▾"
  while 180 px of the row sat empty.
- **The kommun-only note was drawn on top of the mini-maps' legend.** P4 centred
  it along the bottom of the map, and the rule matched the mini-maps too, which
  have no free bottom-centre lane.

### Tests

`tests/ui_v2_1/spec.py` is the acceptance spec for this release — every check
asserts what the page **says** after its lazy loads settle, because v2.0's 169
checks asserted that elements exist and three broken sections stayed green for
months behind that. `settle()` is called before every content assertion, the
gateway is answered from `tests/fixtures/listings_stockholm.json` **and** from an
explicit HTTP 500 error mode that counts the requests, and where a number can be
recomputed from the files in `dist/` the spec recomputes it and compares — the
service counts, the export's 556 185 rows, the direct/queue medians, the seven
strip answers. P4's checks drive the loading states on purpose by holding
`regso/values.json` open, because with the prefetch in place a check that merely
waited would never see them. P6 adds the release regression: eleven routes at
1366×768, 1440×900, 1536×864 and 390×844, each settled, each asserted for zero
page errors and no horizontal overflow, plus the mini-maps' four corners measured
against each other. `tests/ui_v2/spec.py`'s 169 v2.0 checks all still run; five
were **updated, never deleted**, each logged in `docs/v2_1/DECISIONS.md`.
`make test-js` is 122 unit tests across seven modules, including
`tests/geo.test.js`, which checks the ring codec's round trip and decodes the
real build output. Every judgement call an unattended phase made is one line in
`docs/v2_1/DECISIONS.md`; what each phase built is in `docs/v2_1/PROGRESS.md`.


## v2.0 — "one of everything" (draft, not released)

A UI round. No data build script changed, no indicator moved, no number is
computed differently — except where the old UI was computing one wrongly, which
is listed under *Fixed*. What changed is that there is now one of each thing.

**Four destinations instead of seven.** Map · Data · Charts · Test property, with
Export ▾ in the sidebar footer. Market, Pipeline and the folded Sources list are
the three non-default tabs of Data. The old Market view's four large charts are
one National series table with a sparkline and a source on every row; the two
breakdowns that carry the actual point — new-build rent by rent-setting model,
vacancy by owner category — stay as folds.

**Every old link still works.** `src/route_core.js` owns the hash spelling: the
canonical paths, the alias table and the codecs, unit-tested offline (25 tests).
`toV2()` is idempotent, which is what makes it safe to run on every hashchange,
and an old link is rewritten with `replaceState` so Back still goes where the
reader came from rather than bouncing off the redirect. `#table/*`, `#pipeline`,
`#market`, `#sources`, `#analysis?a=`, `#compare?a=`, the five overlay flags,
`?t=`/`?g=` and `listings.html#at=` all land where they should.

**One indicator picker** on the Map, the Area page, Data › Areas, Charts and Test
property, with search, every group, the unit, a ↓ for lower-is-better and an
availability tag. On a RegSO or DeSO page the indicators that would be showing
the kommun's figure are listed under *From the municipality*, because those are
two different claims about the same number.

**One period control**, in whichever of four modes the active indicator needs —
a year select, a Yearly | Quarterly segment where the source publishes quarters,
a static badge for a projection, a static badge naming a climate scenario — and
labelled with that indicator's own latest period rather than the dashboard's. The
quarterly toggle is real rather than decorative: reported offences are published
per quarter, `V()` reads that series when the period is a quarter, and one key
carries both kinds (`y=2025` or `y=2025K4`).

> **Corrected in v2.1 P1.** This paragraph originally said the quarters were a
> *rolling four-quarter sum*. They are not, and never were: Brå publishes single
> quarters, and Stockholm reads ~41–50 per 1 000 per quarter against 191,6 for the
> year. The figures were always right; the description was wrong, and it was
> repeated in the period control's tooltip and on every exported chart. No number
> changed when it was fixed.

**Climate is an indicator family, not an overlay button.** Choosing a Climate
indicator draws its hazard zones from zoom 10 with a hide toggle; choosing
anything else removes them. `zones=0` overrides.

**One Layers ▾ menu** instead of six toolbar buttons, with the sub-filters that
used to live inside each floating legend. The legends on the map are keys and
nothing else, each collapsible, stacked so two of them cannot cover each other.

**The area page is a study row.** The 13-group KEY FIGURES block is gone; in its
place five clickable headline tiles, the picker and period, then the chart panel
beside a draggable mini-map at the same height, then four toggles whose open
state is in the URL. The panel renders whichever of four shapes the indicator
needs and never mixes them: a solid green observed line, a dashed purple
projection (every point of it projected, with the one observed figure marked
separately rather than spliced on), a climate share under its own scenario, or a
distribution strip where the publisher has issued the figure once.

**Test property reads every layer at one pin**, built from the area page's own
components rather than a second set, anchored on the pin's finest area — DeSO,
else RegSO, else the kommun, with the level on the page. Nine sections: rental
listings nearby, services and public buildings within the radius, schools,
infrastructure, safety, climate, the area profile and the sources.

**The Listings page is now a section of it.** It was a second application at a
second address; `listings.html` is a four-line redirect built from the same
codec. A reader compares what is advertised today against what SCB publishes for
the same ground without changing pages — and the caveat that keeps those two
apart sits on the same screen as both of them. Rental listings are also a map
layer, grouped HomeQ / landlord portals / municipal queues, from zoom 13, one
request per viewport debounced 600 ms, and no box fetched twice in a session.

**The gateway gained `GET /bbox?s=&w=&n=&e=`** (deployed). A viewport is a
rectangle: answering one with a radius around its centre either misses the
corners — the inscribed circle leaves 21 % of the box out — or over-fetches,
since the circumscribed circle is 27 % larger in area. `/bbox` covers the box,
runs the *same* per-source fan-out as `/nearby` so "a failing source is never an
empty success" cannot drift between the two, and trims the answer back to the
rectangle. `/nearby` is byte-for-byte unchanged and a test asserts it.

**One export model.** Seven items in one menu, one long schema across This view,
All area data, National series and Test property, projects and nearby in their
own columns. Every row carries its source, table id, verify URL, the publisher's
as-of and this build's fetch date; `value_type` separates an observation from a
projection from an inherited figure; a suppressed value is an empty cell and
never a zero. A unit check runs before the file is written and says so, loudly,
without refusing — refusing would hide the problem and writing silently would
publish it. "All area data" fetches the lazy DeSO files first, so it means all
of it.

**Responsive as a layout.** No horizontal overflow at 1366×768, 1440×900,
1536×864 or 390×844 on any route; at 1024 and below the sidebar is a 52 px top
bar with a drawer (Esc closes it and returns the focus), the study row stacks,
tables scroll inside their cards and the legend stack folds behind one pill.

**One number format.** Every signed change goes through one path, so a format
that prints its own sign can no longer produce "++6,8 %"; percentage points for a
change in a share and per cent for a change in a level; "vs median" is a
difference and never a percentage *of* a median; rank is "#n of N" everywhere,
with N counting the peers that have a figure; an inherited value reads `muni`
rather than a bare degree sign.

### Fixed

- `dropMaps()` called `map.stop()` before `map.off()`. Leaflet's `stop()`
  completes a pan animation, completing one fires `moveend`, and that handler
  writes the camera into `LF` — so loading `#map/0180?c=…&z=14` landed at the
  zoom of the map it had just replaced.
- The area page's mini-map built its colour scale from the areas' own values
  while filling the polygons from the inherited ones, so a RegSO page showing a
  kommun-level indicator drew one flat colour under a legend that read "no data".
- The app grid used `1fr`, which is `minmax(auto, 1fr)`: a wide table stretched
  the column and the whole page scrolled sideways instead of the table. Every
  route overflowed at 390 px, one of them by 2 090 px.
- `exportPipelineCsv()` had its arguments the wrong way round and passed arrays
  where strings were wanted, so it wrote a file named after a JavaScript array
  with comma-separated cells.
- A DeSO file arriving after a pin was resolved did not re-render, so Test
  property went on reading the pin at RegSO level after the finer figures landed.
- `src/listings/view.js` declared `median` at top level and so does `app.js`;
  inlining both as classic scripts in one global scope was a SyntaxError that
  blanked the page. It is an IIFE now, and `build_dashboard.py` runs
  `node --check` over all five inlined files.
- The Areas table drew every indicator at every level — 3 363 RegSO × 67
  indicators is 225 000 cells and 11 MB of DOM. It draws the headline set by
  default, with the full set one click away; the export is unaffected.

### Tests

`tests/ui_v2/spec.py` is the acceptance spec: 169 checks in headless Chromium,
runnable per phase (`--upto P4`), plus one separate `--live` check against the
real gateway. The listings gateway is otherwise answered from
`tests/fixtures/listings_stockholm.json` — a real recording with every
third-party string replaced by a synthetic stand-in, because `docs/LISTINGS.md`
promises that no third-party listing data is committed here and a test file is
not a reason to break that. `make test-js` is 96 tests across five modules;
`make test` renders every view headlessly and asserts the documented numbers.


## v1.2.1 — the three known limitations, closed

v1.2 shipped with three things incomplete. All three are done, and none of them
needed a third-party service to be talked into cooperating.

**Services and public buildings: 16 of 290 kommuner → 290 of 290.** Overpass is
a donated public service and it rate-limited this client; the answer was not to
ask it harder. `scripts/extract_osm_pbf.py` reads the 818 MB Geofabrik country
extract with pyosmium in a single pass — 115 473 535 objects — and pulls out
**100 632 points** across the nine categories. Splitting them per kommun is done
by point-in-polygon on our own rings rather than by bounding box, because
neighbouring boxes overlap and a café would otherwise land in two kommuner:
**99 750 placed, 882 outside every boundary** and left out rather than forced
into the nearest one. The services legend's partial-coverage note disappears on
its own, because it was computed from the data rather than written by hand.

**Infrastructure: 7 of 49 drawn → 25 of 49.** The same extract carries 637
`railway=construction|proposed` alignments. A project gets a line only where OSM
tags one whose name matches it or one of its stations; failing that it keeps its
station points, and failing that it is still not drawn. **Nothing is sketched
between two points.** Of the 24 that remain undrawn, 15 are road projects, which
this pass deliberately did not cover — an alignment is taken from
railway/subway/light_rail/tram tagging only. Named stations located rose from
19 of 65 to 57 of 65.

**Climate zones: three layers → six.** Everything except landslide, about 97 MB,
every per-kommun file under the 3 MB cap, still lazy-loaded from zoom 10.
Landslide stays choropleth-only: 76 MB on its own, largest file 4.47 MB, because
242 000 tiny caution polygons have nothing to merge and so do not simplify.

Also: `scripts/selftest.py` did not know about the `years(A..B)` time spec added
in v1.2, and **CI is the only place selftest runs**, so the Pages deploy had been
failing at "Offline checks" since v1.2 was tagged — the live site was still the
v1.1 build until this was found. selftest now also checks that every spec in
`config/tables_se.json` actually resolves.

## v1.2 — "Sweden parity"

Six new indicator groups, four overlays, a droppable pin and a project pipeline.
Every phase is logged in `docs/PARITY_BUILD_LOG.md` with its check table, its
gates and the ⚠ it raised; every source is in `docs/PARITY.md`.

**Direction awareness.** Every indicator now declares `higher_better`,
`lower_better` or `neutral`. Before this, `rankOf` was `1 + vals.filter(x => x > v).length`
and `cls` was `d > 0 ? "up" : "dn"`, so the kommun with the *worst* unemployment
ranked #1 and a rise in it was painted green. 36 of the original 44 indicators are
`neutral`: a share of flerbostadshus has no better end, and colouring one green
would be editorialising rather than reporting.

**Outlook** — SCB TAB698, kommun level, seven indicators. A projection is one
published statement, so it never enters `hist` and never reaches the year selector;
Charts draws it dashed and says "projected, not observed". TAB6008 is pulled purely
as an independent recomputation and agrees on all 4 350 cells. `verify_outlook.py`
asks SCB a third time: **35 of 35 match**.

**Safety** — Brå SOL, 1996–2025 plus 48 quarters, six offence categories, and
Polisen's designated areas intersected into RegSO and DeSO. `verify_bra.py` opens a
fresh SOL session: **30 of 30 match**. Clearance rate is *not* shipped — Brå
publishes it nationally only, and a test asserts it cannot reappear.

**Schools** — 1 791 units with year 9, a lazily loaded point overlay with a
5-step merit ramp, and a page per school. `verify_schools.py`: **55 of 55 match**,
including five distinct suppression reasons surviving as reasons rather than zeros.
SALSA has no machine-readable export anywhere, so the merit value is the raw one and
every label says so.

**Test property** — `src/testprop.js` with 24 unit tests behind `make test-js`,
exact point-in-polygon on our own rings with holes kept, and a two-pin comparison
that is new work: the Danish repo has none. It deliberately has no overall winner.

**Climate risk** — MCF river flood and coastal levels, SMHI mean sea level 2100,
SGU landslide caution zones, and MCF's cloudburst flag. All computed as land-area
shares in SWEREF99 TM metres.

### Traps found and fixed

- **`&nbsp;` ends in a semicolon**, which is also Brå's field separator: the measure
  row split into 122 fields where the data rows had 62.
- **SGU pages with `startIndex` — capital I.** `startindex` and `offset` are both
  accepted and both silently ignored; the first fetcher "downloaded" 201 000 features
  that were 201 copies of the same thousand.
- **A shapefile record's parts are not one polygon with many holes.** Treating them
  that way built a polygon with 721 551 holes and ran for an hour without finishing.
- **MCF's three flood products cover different watercourses** — 76, 71 and 78. A
  shared coverage test gave Östersund 7.4 % for the 100-year flood and 0.0 % for the
  200-year one. Coverage is now per layer, and the answer is "Not mapped".
- **The police designation was inheriting down the hierarchy**, so every RegSO in
  Stockholm read "4,4 % °" and the map claimed the whole city was designated.
- **`100+` must be percent-encoded**; `0010` is a riksområde, not a kommun; a
  display level is not a publication level; the dashboard's latest year runs ahead
  of individual tables.

### Known limitations

Three things ship incomplete in v1.2 and are the whole content of **v1.2.1**. None of
them is a wrong number — each is a smaller number of areas than intended, and in every
case the page says so itself rather than letting a gap pass for a value.

1. **Services and public buildings cover 16 of 290 kommuner.** The public Overpass
   instance rate-limited this client and the fetch was stopped rather than kept
   hammering a donated service. The overlay works on what is there and **its legend
   states its own coverage**, so a sparse map cannot be mistaken for a sparse city.
   `make services` is resumable. v1.2.1 rebuilds this from the Geofabrik extract
   instead, which needs no third-party service at all.
2. **42 of 49 infrastructure projects are not drawn on the map.** Their stations could
   not be located, because station matching reads the same 16 kommuner of OSM data.
   They are fully present in **Pipeline** and on their own project pages, with budgets,
   opening years and sources. Nothing is sketched between points — a line on a map is
   read as a fact. v1.2.1 takes the alignments from the extract.
3. **Climate zone outlines ship for three of seven layers** — flood 100-year, coastal
   +2.0 m and mean sea level 2100. All seven came to 170 MB, over budget, and
   landslide's largest per-kommun file was 4.47 MB, over the 3 MB cap: 242 000 tiny
   caution polygons do not simplify because there is nothing to merge. **The other four
   layers are fully available as numbers** in the choropleth, at all three levels.
   v1.2.1 raises the set to six, everything except landslide.

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
