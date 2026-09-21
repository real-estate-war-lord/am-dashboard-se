# AM Dashboard — Sweden edition

An open-data macro and market dashboard for the Swedish housing market: 290 kommuner,
3 363 RegSO neighbourhoods and 6 160 DeSO areas on one map, with the indicators an asset
manager actually looks at — population and age structure, income, education, tenure mix,
labour status, rents, construction and prices.

Everything comes from public Swedish sources, chiefly **Statistics Sweden (SCB)**, whose
statistical database is keyless and licensed **CC0**. The pipeline is plain Python
(standard library only) and runs on your own machine; the output is a single
self-contained HTML page.

Sibling project: [am-dashboard-dk](https://github.com/real-estate-war-lord/am-dashboard-dk)
— the Danish edition, whose design this one inherits.

## Status

Built and running.

- [x] Data map and source verification
- [x] SCB API client, deep raw fetcher, boundary fetcher (`scripts/`)
- [x] Boundaries: RegSO 2025, DeSO 2025, kommun outlines dissolved from RegSO
- [x] Full data pull — 94 pulls, 43.2 M cells, 0 failures
- [x] Indicator registry — 27 mapped indicators + 8 national macro series
- [x] Dashboard build (`dist/index.html`, one self-contained file)
- [x] Boundaries clipped to the coastline; v1.0 published

## Running it

```bash
make selftest    # offline checks, one second
make geo         # download boundary polygons (once)
make land        # Swedish land mask from OSM land polygons (once; needs shapely)
make simplify    # clip to the coastline -> data/geo/*.geojson, browser-sized
make discover    # resolve table ids known only by their old API path
make fetch       # the full pull — resumable, ~70 min
make riksbank    # policy rate and 10-yr yield
make validate    # every code in the registry against the metadata on disk
make build       # -> dist/index.html
make test        # render every view headlessly and check the numbers
make serve       # http://localhost:8080
```

Requires Python 3.10+ (standard library only) and, for `make test`, Node.
No API key, no account, nothing to install.
`START_HERE.md` has the step-by-step version, `CLAUDE.md` the working conventions.

**The page must be served over http**, not opened from disk: the 6 160 DeSO areas
ship as one file per kommun (`dist/deso/<kommun>.json`) and are fetched when you open
that kommun. From a `file://` URL the DeSO toggle stays unavailable; everything else works.

## What this data can and cannot say

Stated plainly, because the gaps are real and a dashboard that hides them is worse than none:

- **No realised price per m².** SCB publishes no open price per square metre at any
  geography. The price indicator is **K/T-tal** — purchase price divided by assessed value —
  which is Sweden's own quality-adjusted measure. Price per m² per kommun exists only
  commercially (Svensk Mäklarstatistik, Valueguard) or by buying raw transactions from
  Lantmäteriet.
- **No bostadsrätt prices below county level**, and co-ops dominate urban transactions.
- **Rent is a sample survey** (~16 000 apartments). Kommun-level estimates carry a margin of
  error, which this dashboard displays rather than hides. Some kommuner are suppressed at
  source and render as `–`, never as zero.
- **No private-vs-allmännytta rent split below six national groups.**
- **No building register with floor area.** Sweden has no open equivalent of Denmark's BBR.
  The area page uses what SCB does publish below kommun level instead: the age x sex
  pyramid, the composition of income and the tenure mix.
- **Below kommun level the data is two years deep, not eleven.** SCB re-cut RegSO and DeSO
  on 2025-01-01 and publishes the new division from 2024 onwards. Kommuner have the full
  history; RegSO and DeSO are close to a snapshot, and charts there say so. Earlier years
  come back from the API as `0` rather than null for an area that did not yet exist, which
  the build drops rather than charting as a collapse to zero.
- **Building permits have no kommun level.** `TAB2534` / `TAB796` carry 30 region codes —
  riket, three metro areas, four riksområden and the 21 län. Permits are a panel, never a map.
- **Boverket's Bostadsmarknadsenkät is not wired up.** The `bme` indicator is registered and
  renders as "no data"; its files are JS-rendered and need a browser pass.

## Sources and licence

Data: Statistics Sweden (CC0), SCB geodata (CC0), Boverket (attribution required),
Riksbanken, Eurostat. Attribution is given as *Källa: SCB* even where CC0 does not require it.

Coastline: **OpenStreetMap land polygons** (osmdata.openstreetmap.de), **ODbL** — used to clip
RegSO and DeSO to land. They tile the whole national territory including water, so without the
clip a coastal kommun reaches far out to sea; Värmdö kept 15 % of its raw area, Nynäshamn 28 %,
inland Malå 100 %. © OpenStreetMap contributors.

Code: MIT.
