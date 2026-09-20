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

Work in progress.

- [x] Data map and source verification
- [x] SCB API client, deep raw fetcher, boundary fetcher (`scripts/`)
- [x] Boundaries downloaded (RegSO 2025, DeSO 2025, EPSG:4326)
- [x] Metadata for 65 tables on disk
- [ ] Full data pull
- [ ] Indicator registry
- [ ] Dashboard build and first publish

## Running it

```bash
python3 scripts/selftest.py        # offline checks, one second
python3 scripts/fetch_geo_scb.py   # boundary polygons
python3 scripts/discover_scb.py    # resolve table ids known only by their old API path
python3 scripts/fetch_scb.py       # the full pull — resumable, ~45-90 min
```

Requires Python 3.10+. No API key, no account, nothing to install.
`START_HERE.md` has the step-by-step version, `CLAUDE.md` the working conventions.

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

## Sources and licence

Data: Statistics Sweden (CC0), SCB geodata (CC0), Boverket (attribution required),
Riksbanken, Eurostat. Attribution is given as *Källa: SCB* even where CC0 does not require it.

Code: MIT.
