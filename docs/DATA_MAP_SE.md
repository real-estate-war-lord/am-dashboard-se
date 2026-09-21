# AM Dashboard — Sweden Edition: Open Data Map

**Status:** v0.4 · 2026-09-21 · v1.1 — Boverket BME, Kronofogden, Kolada and the unused-on-disk tables wired in
**Scope:** the *Macro / Market* layer, same as the Danish edition. Portfolio data stays out of scope.
**Principle:** same design as the Danish edition (v1.9), every number from **Swedish open sources**.

**Operational truth lives in `CLAUDE.md`, `START_HERE.md` and the `Makefile`.** This file is the *what* — which source carries which indicator, at which geography, with which caveat. Table IDs are PxWebApi v2 `TABxxxx` ids. The raw pull list that implements this is `config/tables_se.json`.

---

## 0. TL;DR — Sweden vs Denmark

| | Denmark (built) | Sweden |
|---|---|---|
| Core statistics API | DST StatBank, keyless | **SCB PxWebApi v2, keyless, CC0** |
| Sub-municipal geography | postnummer (471 with price data) | **RegSO 3 363 / DeSO 6 160**, CC0 polygons from SCB's WFS in EPSG:4326 |
| Sub-municipal indicators | population, age, price/m², DOM only | **population, age, households, education, income, tenure, labour status, socio-economic index** |
| Postal-code polygons | free | **not open** (PostNord→Geposit, ~6–17 kSEK) — replaced by RegSO |
| Realised price per m² | free, per postal code, quarterly | **does not exist for free at any geography** |
| Days on market, supply | free | commercial licence needed |
| Rent per municipality | scrape boligstat.dk yearly | **API, all 290 kommuner, CC0**, with margin of error — but **no private/public split below 6 groups** |
| Construction pipeline | quarterly, kommune | **quarterly, kommun, started and completed, plus by tenure** |
| Monthly unemployment | kommune | **kommun and DeSO/RegSO** (SCB BAS) |
| Central-bank rates | DST mirror | **Riksbank SWEA API, keyless, daily** |
| Building register | BBR, free key, area + year + use | **no equivalent**; floor area only in paid products |

Everything in the Danish chip row can be reproduced in Sweden, most of it at a finer geography. The one thing that cannot be reproduced on open data is the Finans Danmark price layer.

---

## 1. Indicator map — Danish `makro` view → Swedish equivalent

| # | key | DK indicator | SE indicator | SE source & selection | geo | cadence |
|---|---|---|---|---|---|---|
| 1 | `growth` | Population growth %/yr | Population growth %/yr | `TAB6574` population by region/age/sex, ContentsCode `000007Y7`, Alder `totalt`, Kon `1+2`; `TAB6473` monthly | **DeSO**, RegSO, kommun | annual · 2025 |
| 2 | `income` | Disposable income avg/person | Net income, mean (tkr) | `TAB6683` ContentsCode `000008A4` (mean), Kon `1+2`, pick the total income component | **DeSO**, RegSO | annual · 2024 |
| 2b | `income_med` | — | Median disposable income | **`TAB6684`** ContentsCode `000008AB` — kSEK, **all three levels**, RegSO2025 vintage, to 2024. Supersedes `TAB5750` (RegSO only, price base amounts, frozen 2023, RegSO2020 vintage) | **DeSO**, RegSO, kommun | annual · 2024 |
| 3 | `young` | Share aged 20–34 | Share aged 20–34 | `TAB6574` age bands `20-24`+`25-29`+`30-34` ÷ `totalt` | **DeSO**, RegSO, kommun | annual · 2025 |
| 4 | `yks` | Single-person households % | One-person households % | `TAB6568` `ESUB` (ensamstående utan barn) ÷ `TOTALT`. `ESMB` is single *with* children — not one-person | **DeSO**, RegSO, kommun | annual · 2025 |
| 5 | `kela` | Housing-benefit households % | **Substitute:** share with low economic standard | `TAB6685` — Försäkringskassan has no verified kommun breakdown | **DeSO**, RegSO | annual · 2024 |
| 6 | `rent` | Private rent DKK/m²/yr | Rent SEK/m²/yr, all tenures | `TAB4590` Hyresuppg `Ah_kvm`, ContentsCode `000000J4` median (± `000000J3`), `000000RZ` mean (± `000000MQ`) | **kommun (290)** | annual, Oct · 2025 |
| 6b | `rent_priv` | — | allmännyttiga vs privata | `TAB4618` / `TAB4610` — 6 aggregate groups only, **panel not map** | 6 groups | annual |
| 7 | `vuok` | Renter households % | hyresrätt share of dwellings | `TAB6638` Upplatelseform `1` ÷ all (DeSO/RegSO); `TAB824` at kommun (`1` hyresrätt, `2` bostadsrätt, `3` äganderätt, `ÖVRIGT`) | **DeSO**, RegSO, kommun | annual · 2025 |
| 8 | `tyott` | Unemployment % | Unemployment, register-based | `TAB6680` `0000089W` unemployed ÷ `0000089V` labour force, Alder `20-64` (DeSO/RegSO, annual); kommun monthly from **`TAB6260`** (`000006II` unemployment %, `000006IK` employment rate) | **DeSO/RegSO** annual, kommun monthly | 2024 / 2026M06 |
| 9 | `kork` | Tertiary education % | Post-secondary share of 25–65 | `TAB6534` levels `5` + `6` ÷ total excl. `US` | **DeSO**, RegSO, kommun | annual · 2025 |
| 10 | `kt` | Multi-dwelling share | Flerbostadshus share | `TAB824` Hustyp `FLERBOST` ÷ all (kommun); `TAB6065` persons by building type (RegSO) | kommun; RegSO | annual · 2025 |
| 11 | `vk` | Immigrants + descendants % | Foreign background % | `TAB6571` | **DeSO**, RegSO | annual · 2025 |
| 12 | `avg_m2` | Average dwelling size | Floor space per person | **`TAB1541`** `HE0111DJ`, Hushallstyp `SAMTLH`, Boendeform `TOT` — **kommun verified 290**. `TAB826` (floor-space bands, kommun) supports a weighted mean dwelling size; `TAB5291` is **3 regions only**, unusable | kommun | annual · 2025 |

### 1b. Sweden-only indicators

| key | indicator | source | geo | cadence |
|---|---|---|---|---|
| `bme` | Housing-market balance: shortage / balance / surplus | Boverket Bostadsmarknadsenkäten (xlsx, browser pass needed) | kommun | annual, May |
| `socio` | Socio-economic index | `TAB6586` | RegSO | annual · 2024 |
| `kt_tal` | **K/T-tal** — purchase price ÷ assessed value, småhus. The only free price normalisation | `TAB1169` | kommun | annual · 2025 |
| `price_avg` | Mean purchase price, småhus (tkr) + sales count | `TAB1169` | kommun | annual · 2025 |
| `starts` / `completions` | Dwellings started / completed per 1 000 dwellings | `TAB4572` (quarterly), `TAB6925` | kommun | quarterly · 2026K2 |
| `new_rental` | Share of completions that are hyresrätt | `TAB4193` by upplåtelseform | kommun | annual · 2025 |
| `labour` | Employment rate | `TAB6680` `0000089X` ÷ `0000089Y` | DeSO/RegSO | annual |
| `capital_inc` | Share of persons with capital income (wealth proxy) | `TAB6683` component `230`, ContentsCode `000008A2` | DeSO, RegSO | annual |
| `kommun_tax` | Municipal tax rate | Kolada `N00901` | kommun | annual · 2026 |
| `kommun_netcost` | Net operating cost per inhabitant | Kolada `N03011` (sign flipped) | kommun | annual · 2025 |
| `kommun_debt` | Long-term debt per inhabitant | Kolada `N03046` — the kommun, not the koncern | kommun | annual · 2025 |
| `kommun_equity` | Equity ratio incl. pension liability | Kolada `N03002` | kommun | annual · 2025 |
| `forced_sales` | Forced sales per 10 000 dwellings | Kronofogden xlsx — **län only** | län → kommuner | annual · 2025 |
| `taxv` | Assessed value, land/building split, all typkod incl. hyreshus | **`TAB3797`** `BO0601B1` land, `BO0601B2` building, `BO0601B3` total, `BO0601S1` units | kommun (290) | annual · 2025 |
| `taxv_smahus` | Average assessed value per småhus unit | **`TAB5149`** `000002X0`, Typkod `220` | kommun (290) | annual · 2025 |
| `permits` | Building permits, dwellings | **`TAB2534`** `BO0701A1` (area in `TAB796`) | **riket / 3 metro / 4 riksområden / 21 län — NO kommun level** | quarterly · 2026K2 |
| `mortgage_rate` | Mortgage rate by fixation period | **`TAB5783`** `000004ZW` (wider series `TAB5780`) | national | monthly · 2026M07 |
| `gdp` | GDP, volume change | **`TAB3100`** `NR0103A!` y/y, `NR0103A¤` sa q/q | national | quarterly · 2026K2 |

### 1c. What Denmark has and Sweden does not

| DK indicator | Swedish situation | Decision |
|---|---|---|
| `price_m2` realised per postal code | No free equivalent. Mäklarstatistik (ToS bars redistribution), Valueguard (paid), Lantmäteriet raw transactions (750 kr + 1.89 kr/transfer, 90 % off history from yr 3) | Ship K/T-tal, label it plainly |
| `dom` days on market | Nothing free | Drop from v1.0 |
| `supply` homes for sale | Hemnet CSV export, no stated licence | Ask in writing first |
| bostadsrätt prices | `TAB1151` län-level, annual | State the gap in README |
| `forced` forced sales | **Checked 2026-09-21: län only, no kommun column.** `Exekutivt sålda fastigheter och bostadsrätter 2010-2025.xlsx`, sheet `Blad1` = Egendomstyp (Bostadsrätt/Fastighet) × Län × År 2010–2025, with count, market value and purchase price. (Sheet 1 is a pivot covering only 2023–2025 despite the file name.) | Shipped as `forced_sales` per 10 000 dwellings, the län rate repeated over its kommuner and labelled as such — 21 values on a 290-kommun map |
| BBR building register | None. Byggnad Inspire: free but purpose-vetted, no floor area | Area page uses DeSO age×sex, income structure, tenure mix instead |
| Net price index | Dead since 2013M12. Leases index on **KPI for October** | Port as "KPI October", not NPI |

---

## 2. Geography

| level | count | polygon source | indicators here |
|---|---|---|---|
| Län | 21 | SCB boundary zip | quarterly prices, AKU, BRP |
| **Kommun** | 290 | SCB zip (`data/geo/raw/kommun_lan.zip`, convert with ogr2ogr, or dissolve RegSO on `kommunkod`) | everything |
| **RegSO** | 3 363 | SCB WFS `stat:RegSO_2025` — **downloaded** | population, age, households, education, income (mean + median), tenure, background, labour, socio index. Named (`regsonamn`) |
| **DeSO** | 6 160 | SCB WFS `stat:DeSO_2025` — **downloaded** | same minus median income and socio index. Codes only |

Every DeSO feature carries `regsokod`, `kommunkod`, `lanskod` → attribute rollup, never a spatial join.

**Vintage trap:** re-cut 2025-01-01. Suffixed codes (`0114A0010_DeSO2025`) vs unsuffixed 2018/2020 codes. `TAB5750`, `TAB5956`, `TAB6258` are on the old vintage — each pull's `.state.json` records which. Never join across vintages silently.

**Codes:** DeSO `0180C1010` = kommunkod + letter (A outside urban areas, B urban outside central town, C central town) + serial. RegSO `1961R007` = kommunkod + R + serial.

---

## 3. Sources

### 3.1 SCB — backbone
`https://api.scb.se/OV0104/v2beta/api/v2/`, no key, CC0, 30 calls/10 s, 150 000 cells/call. Rules and traps: see `CLAUDE.md`. Old v1 API retires at the turn of 2026/2027.

### 3.2 Rents — BO0406 "Hyror i bostadslägenheter"
Sample survey (~16 000 apartments). Three tiers: all 290 kommuner get only total rent SEK/m² with margins (`TAB4590`); 17 large kommuner get rooms and construction year (`TAB4603`, `TAB4611`); 6 aggregate groups get the ownership split and rent change (`TAB4618`, `TAB4610`, `TAB4620–4623`). Rent incl. heating and water. Next publication 2026-10-02. **Reference values 2025:** Stockholm 0180 median 1 710 ±28, mean 1 734 ±19; Kiruna 2584 1 136 ±77; Malå 2418 suppressed.

Glossary: **bruksvärdessystemet** — rents negotiated collectively, capped by use-value of comparable dwellings. **Presumtionshyra** (2006) — new builds exempt for 15 years. `TAB6417`/`TAB6421` quantify the split, 6 groups, 2022–2024.

### 3.3 Prices
`TAB1169` (kommun, annual: sales, mean price, mean assessed value, K/T-tal); `TAB3655`/`TAB3656` monthly barometer (riket/län); `TAB1167` quarterly län; `TAB1151` bostadsrätt (län, annual); `TAB1149`/`TAB1150` price index. No price per m² anywhere.

### 3.4 Construction
`TAB4572` started + completed by building type, all kommuner, quarterly; `TAB6925` with specialbostäder; `TAB4193`/`TAB4194`/`TAB4195` completed by tenure / owner / dwelling type, annual. Boverket BME: shortage/balance/surplus per kommun, annual, attribution required, files JS-rendered (browser pass).

### 3.5 Vacancy
`TAB5602–5605` 6 groups, triennial, no next publication planned. `TAB3208` allmännytta, regional. Panel only, never a map.

### 3.6 Macro
Riksbank SWEA `https://api.riksbank.se/swea/v1/Observations/{series}/{from}/{to}` — `SECBREPOEFF` policy rate (1.75 verified 2026-08), `SEGVB10YC` 10-yr (3.15 at 2026-09-09), FX `SEKEURPMI`. STIBOR series closed 2020. SCB: `TAB6598` CPI COICOP (`04.1` = actual rents), `TAB6602` KPIF, `TAB6612` detailed CPI; mortgage rates **`TAB5783`** (FM5001, bolåneräntor by fixation period; `TAB5780` back to 1987M03) and GDP **`TAB3100`** (NR0103, quarterly volume change). Eurostat `nama_10r_3gdp` geo `SE110…SE332` for regional GDP. **KPI rebased to 2020=100 in Jan 2026** — store the base year.

### 3.7 Registers
No BBR. Lantmäteriet Byggnad Inspire: year built, use, footprint — free but purpose-vetted, no floor area. Lägenhetsregistret not public. Boverket EPC API: key required, not enumerable (kommun + address mandatory, 1 500 calls/day), `byggnadsar` always null. SCB **`TAB3797`** (BO0601): assessed values per kommun with land/building split, all 108 typkod incl. the hyreshus classes; **`TAB5149`** adds the average per småhus unit.

---

## 4. Verification log

| date | check | result |
|---|---|---|
| 2026-09-14 | SCB v2 `/config` | ✅ 2.3.2, 30/10 s, 150 000 cells, CC0 |
| 2026-09-14 | `TAB6534` DeSO+RegSO+kommun in one call | ✅ |
| 2026-09-14 | `TAB3655` 2026M08 | ✅ 2 736 sales, 4 405 tkr, K/T 1.39 |
| 2026-09-14 | SCB WFS RegSO/DeSO 2025, EPSG:4326 | ✅ 3 363 / 6 160 |
| 2026-09-14 | Riksbank SWEA, Eurostat, Kolada v3 | ✅ |
| 2026-09-18 | `valueCodes[Region]=????` → 290; `*_RegSO2025` → 3 363 | ✅ |
| 2026-09-18 | repeated `valueCodes[X]` silently drops values | ✅ confirmed — never do it |
| 2026-09-18 | `range()` / `top(n,offset)` over GET | ❌ 400 — comma collision |
| 2026-09-18 | `top(N)` on Tid = newest N | ✅ |
| 2026-09-18 | `TAB4590` Stockholm 1 710 ±28 / 1 734 ±19; Malå `..` | ✅ |
| 2026-09-18 | geometry downloaded: RegSO 50.7 MB, DeSO 62.1 MB | ✅ |
| 2026-09-18 | metadata for 65 tables | ✅ on disk |
| 2026-09-20 | `discover_scb.py` resolved all five outstanding ids | ✅ TAB6260, TAB5783, TAB3100, TAB3797, TAB5149 |
| 2026-09-20 | `TAB6260` Region dimension | ✅ 290 kommuner, monthly to 2026M06 |
| 2026-09-20 | `TAB2534`/`TAB796` Region dimension | ❌ **30 codes, no kommun** — building permits are regional only |
| 2026-09-20 | `TAB6684` carries a median at kommun + RegSO + DeSO, 2025 vintage | ✅ replaces `TAB5750` for `income_med` |
| 2026-09-20 | `TAB6683`/`TAB6685`/`TAB6571`/`TAB6065`/`TAB6253`/`TAB6766`/`TAB5956`/`TAB6684` carry kommun too | ✅ kommun level added to the pull list |
| 2026-09-20 | `TAB1541` floor space per person at kommun; `TAB5291` only 3 regions | ✅ / ❌ |
| 2026-09-20 | `config/indicators.json`, 35 indicators, every code checked against metadata | ✅ `make validate` |
| 2026-09-21 | Boverket BME open data 2020–2026 | ✅ 283–289 kommuner/yr; wording changed in 2022 (`Obalans - underskott` → `Underskott`) |
| 2026-09-21 | Kronofogden forced sales | ⚠️ **län only, no kommun breakdown** — 21 values, 2010–2025 |
| 2026-09-21 | Kolada v2 | ❌ HTTP 410 — dead, v3 only |
| 2026-09-21 | Kolada v3 `/data/kpi/{kpi}/year/{y}` | ✅ all units in one call; N00901, N03011, N03046, N03002 for 290 kommuner 2015–2026 |
| 2026-09-21 | Kolada population forecast | ❌ `?title=prognos` and `?title=folkmängd` both return count 0 — no such KPI |
| — | `*_DeSO2025` mask live, POST fallback | not yet — first real pull proves them |
| — | Boverket BME files, Försäkringskassan kommun level, Kronofogden kommun column | browser pass pending |

### 4b. Independent recomputation — 2026-09-21

Five kommuner × three indicators, fetched **one kommun at a time with an explicit
selection** and recomputed here, then compared with `data/processed/makro.json`.
A different query and a different code path from the pipeline, which pulls a whole
level at a time and aggregates offline — so a fault in the fetcher, the cache or
`build_makro.py` cannot pass by agreeing with itself.

Reproduce with `make verify` (`scripts/verify_scb.py`).

| Indicator | Kommun | API (independent query) | Dashboard | ± | Verdict |
|---|---|---|---|---|---|
| Rent, median SEK/m²/yr | Stockholm | 1710 | 1710 | ±28 | ✅ match |
| Rent, median SEK/m²/yr | Göteborg | 1492 | 1492 | ±25 | ✅ match |
| Rent, median SEK/m²/yr | Malmö | 1667 | 1667 | ±48 | ✅ match |
| Rent, median SEK/m²/yr | Umeå | 1389 | 1389 | ±46 | ✅ match |
| Rent, median SEK/m²/yr | Kiruna | 1136 | 1136 | ±77 | ✅ match |
| Population growth %/yr | Stockholm | 0.37 | 0.37 |  | ✅ match |
| Population growth %/yr | Göteborg | 0.7 | 0.7 |  | ✅ match |
| Population growth %/yr | Malmö | 0.62 | 0.62 |  | ✅ match |
| Population growth %/yr | Umeå | 0.76 | 0.76 |  | ✅ match |
| Population growth %/yr | Kiruna | -0.11 | -0.11 |  | ✅ match |
| Post-secondary % of 25–65 | Stockholm | 66.57 | 66.57 |  | ✅ match |
| Post-secondary % of 25–65 | Göteborg | 60.16 | 60.16 |  | ✅ match |
| Post-secondary % of 25–65 | Malmö | 58.55 | 58.55 |  | ✅ match |
| Post-secondary % of 25–65 | Umeå | 60.39 | 60.39 |  | ✅ match |
| Post-secondary % of 25–65 | Kiruna | 34.36 | 34.36 |  | ✅ match |

**15 of 15 match**, rents to the krona and their margins, growth and education to
two decimals. Tolerances allowed 0.5 SEK, 0.006 pp and 0.06 pp respectively; every
difference was below the printing precision.
