# v1.2 "Sweden parity" — every source, and what it can and cannot say

One row per source. If a figure is on the dashboard, its source is here, with the
licence, the geography it is really published at, and the caveat that matters.

## The rule this file exists to enforce

The dashboard shows **official published figures, or plain arithmetic on them**.
No models, no imputation, no interpolation. Three consequences run through
everything below:

- **Suppressed is not zero.** A value a publisher withheld stays blank and renders
  as `–`.
- **Not mapped is not zero.** A hazard survey that never covered an area says
  nothing about that area. It is blank, and the page says "Not mapped".
- **Not published at this level is not a licence to invent one.** Where a figure
  exists only per kommun it is shown on finer areas marked `°`, or — where
  inheriting would mislead — not shown at all.

## Sources

| Source | What | Level | Licence / attribution | Refresh | Caveat |
|---|---|---|---|---|---|
| **SCB** PxWebApi v2 | population, income, housing, rents, prices, construction | kommun / RegSO / DeSO | CC0, "Källa: SCB" | monthly–yearly | 2025 RegSO/DeSO re-cut; never join across vintages |
| **SCB** TAB698 / TAB6008 | population projection 2024–2070 | kommun | CC0 | one publication, 2024-06-11 | a projection, not a forecast of policy |
| **Riksbanken** SWEA | policy rate, 10-yr yield | national | open | daily | |
| **Kolada** (RKA) | municipal finances | kommun | open | yearly | |
| **Boverket** BME | housing-market balance | kommun | open | yearly | the kommun's own assessment |
| **Kronofogden** | forced sales | **län only** | open | yearly | repeated across each län's kommuner and labelled as such |
| **Brå** SOL | reported offences, 6 categories | kommun (+ stadsdelar in 3 cities) | free reuse, "Källa: Brå" | yearly + quarterly | reported ≠ convicted; reporting propensity differs |
| **Polismyndigheten** | designated vulnerable areas | polygons → kommun/RegSO/DeSO | public authority publication | ~2-yearly | **two** classes since 2025; a police assessment, not a rating of residents |
| **Skolverket** planned-educations v4 | year-9 results, staffing, coordinates | school → area | open, "Källa: Skolverket" | yearly | raw merit value, **not SALSA-adjusted** |
| **Skolinspektionen** Skolenkäten | trygghet, studiero | school → area | free reuse | ~2-yearly rotation | ≥5 respondents; two rounds unioned |
| **MCF** (ex-MSB) | river flood 100/200/BHF, coastal +2.0/+3.0 m, cloudburst flag | polygons → all levels | free reuse, "Källa: MCF" | irregular | the three flood products cover **different** watercourses |
| **SMHI** | mean sea level 2100, RCP4.5 / RCP8.5 | polygons → all levels | open | irregular | a projected **mean** level, not a storm surge |
| **SGU** | landslide caution zones | polygons → all levels | CC0 | irregular | a caution zone is conditions worth investigating, not a forecast |
| **OpenStreetMap** | services, public buildings, station points | points | **ODbL** — share-alike | continuous | volunteer coverage varies; points only, never a rate |
| **Trafikverket** m.fl. | 49 curated infrastructure projects | kommun | open; each row links its own source | manual | not a census of Swedish infrastructure |

## Known gaps, stated plainly

- **No price per m².** Sweden publishes no open realised price per m² at any
  geography. The price chip is **K/T-tal** (purchase price ÷ assessed value).
- **No bostadsrätt prices below län.**
- **No private-vs-allmännytta rent split below six national groups.**
- **No building-permit map.** `TAB2534`/`TAB796` carry 30 region codes only.
- **No national building register with floor area.** Sweden has no open BBR
  equivalent, so the Danish Buildings layer has no counterpart; the area page
  uses distribution cards instead.
- **No clearance rate per kommun.** Brå publishes personuppklaringsprocent for
  the whole country only. Omitted rather than substituted.
- **No SALSA.** Skolverket's socioeconomic model has no machine-readable export
  of any kind; the merit value shown is the raw one and every label says so.
- **No national permit/building-case layer**, so the Danish "open building case"
  half of the public-buildings overlay has no Swedish counterpart.

## Upgrades available when a key exists

| Key | What it would add | Fallback in use |
|---|---|---|
| `GEOTORGET_USER` / `GEOTORGET_PASS` | Lantmäteriet building footprints — climate exposure by building rather than by land area, and Byggnad *ändamål* instead of OSM for public buildings | area shares only; OSM points |
| `TRAFIKLAB_KEY` | GTFS Sverige 2 stops, authoritative and complete | OSM `public_transport` points |

The STAC catalogue at `api.lantmateriet.se/stac-vektor/v1` is public and lists
`byggnader` as CC-BY-4.0, but the files it points at return **401** without
Geotorget credentials.
