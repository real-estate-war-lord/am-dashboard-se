# Parity build log — v1.2

One section per phase. Each section carries the check table (what was built, from
which source, at which level, with which caveat), the `make validate / test / build`
result, every ⚠ raised and the decision taken on it.

Plan and phase checklist: `docs/PARITY_PLAN.md`.
Endpoint probe: `docs/PARITY_PROBE.md`.

## Phase 0 — Plan file + probe

Probe run 2026-09-24. `scripts/probe_parity.py` → `docs/PARITY_PROBE.md`
(35 capabilities, 33 routed). Danish UI inventory → `docs/PARITY_UI_INVENTORY.md`.

### Check table

| Capability | Route | Level | Verdict |
|---|---|---|---|
| SCB TAB6008 / TAB698 projection | PxWeb v2, `updated 2024-06-11` | 290 kommun + 21 län, 2024–2070 | ✅ both tables agree cell for cell |
| Brå anmälda brott, yearly | SOL `menyid=101` | 290 kommun + stadsdelsområden in the 3 big cities | ✅ 117 offence types, 1 362 leaf, 1996–2025 |
| Brå anmälda brott, monthly/quarterly | SOL `menyid=90` | same | ✅ 41 types, 520 periods to 2026K2 prel. |
| Brå clearance (personuppklarade) | national xlsx only | **riket** | ⚠ not per kommun — omit, see below |
| Kolada crime KPIs | `api.kolada.se/v3` | 290 kommun, 2008–2025 | ✅ fallback; per 100 000 inh., not counts |
| Polisen utsatta områden | `uso_2025_geojson.zip` | 65 polygons, EPSG:3006 | ✅ geometry **is** published |
| Skolverket year-9 results | planned-educations **v4** | 6 546 units, 4 659 with grundskola | ✅ carries `valueType` and school-year labels |
| School coordinates | planned-educations v4 **detail** | per unit | ⚠ route differs — see below |
| SALSA | — | — | ❌ blocked, no bulk export exists |
| Skolinspektionen Skolenkäten | per-school xlsx, 8/year | skolenhetskod + lägeskommun | ✅ biennial rotation |
| MCF flood extents | INSPIRE WFS, 3 layers | national multipolygons, no kommun attribute | ⚠ bbox tiling required |
| MCF coastal flood | `gis-tjanster.mcf.se` ArcGIS | 50 levels, 0.1–5.0 m RH2000 | ✅ host changed — see below |
| MCF cloudburst flag | Skyfallskartering_Oversikt | **290 kommuner, Status 1/0** | ✅ 267 have their own mapping |
| SMHI mean sea level | opendata-download | RCP 2.6/4.5/8.5 × 2050/2100 | ✅ low/average/high each |
| SGU landslide | OGC API Features | 3 collections | ✅ CC0 |
| Lantmäteriet byggnader | STAC public, files 401 | per kommun GeoPackage | ⚠ needs Geotorget |
| Trafikverket bilaga 1 | adopted plan xlsx, 347 899 B | **län**, 266 rows | ⚠ not kommun-level |
| Geofabrik Sweden extract | 818 MB pbf | national | ✅ |
| Trafiklab GTFS | 403 | — | ⚠ needs TRAFIKLAB_KEY |

### Route differences found, and the decision on each

1. **`statistik.bra.se` serves a mismatched TLS intermediate.** The leaf is issued by
   *DigiCert EV RSA CA G2*; the server presents *GeoTrust EV RSA CA 2018*, so the chain
   does not join. curl on macOS succeeds only because the keychain has the right
   certificate cached — Python fails with `CERTIFICATE_VERIFY_FAILED`.
   **Decision:** `scripts/http_util.py` fetches the correct intermediate from the CA
   Issuers URL in the leaf's own AIA extension, caches it under `data/external/raw/ca/`
   and loads it into an `SSLContext`. Verification stays **on**. Not a user-agent issue.
2. **Brå SOL's id separator is `*`, not `,`.** A comma returns HTTP 200 with all but one
   id silently dropped — the same failure mode as the SCB `valueCodes[X]` repeat already
   in CLAUDE.md. Added to the trap list.
3. **SOL needs a session.** `/urval?menyid=…` is a 993-byte stub until a `JSESSIONID`
   from `/action/start` is presented. The probe now carries a cookie jar.
4. **Clearance is national only.** `handlagda-brott` has no kommun cut and SOL has no
   handlagda module. **Decision:** omit `clearance_pct` from the kommun panel, as the
   phase brief allows, and say so in the README rather than substituting a modelled one.
5. **Polisen publishes three classes no longer — only two.** `KATEGORI` is
   *Utsatt område* (46) and *Särskilt utsatt område* (19); `riskområde` is gone.
   **Decision:** Phase 3 carries two classes. Verified independently against the file.
6. **Skolenhetsregistret carries no coordinates** (10 655 units: code, kommun, org nr,
   name, status only). **Decision:** take `wgs84_Lat`/`wgs84_Long` from the
   planned-educations **v4 detail** endpoint, one call per school — which also means the
   brief's "coordinates from Skolenhetsregistret" is not the route Phase 4 will use.
7. **`gis.msb.se` → `gis-tjanster.mcf.se`** after the MSB→MCF reorganisation, and
   `gis.mcf.se` does not exist at all.
8. **The flood WFS advertises `application/geo+json` but does not implement it**, and an
   untiled `json` request dies mid-stream (the layer is >40 MB in 76 features).
   `text/csv` delivers attributes; geometry needs bbox tiling. Its WKT is written
   **northing first**, which is the same axis-order trap that already cost this repo a
   release — noted for Phase 6.
9. **SCB projection pulls need `ContentsCode`.** Region, ContentsCode and Tid are all
   non-eliminable on TAB6008/TAB698; omitting it is a 400, not an empty answer.
10. **A year is not a `Tid` code on a monthly or quarterly table.** Six of the registry's
    31 tables are monthly or quarterly; the verify-at-source builder records the
    granularity and expands a year into the periods the table actually has.

### ⚠ carried forward

| ⚠ | Decision |
|---|---|
| clearance per kommun does not exist | omit the indicator, state it in the README |
| SALSA has no bulk export | ship the raw merit value, labelled "not SALSA-adjusted" |
| Lantmäteriet building files need Geotorget | area shares only; upgrade available when the key exists |
| Trafiklab needs a key | OSM stops instead; upgrade available when the key exists |
| Trafikverket plan is län-level | no kommun investment map is promised |
| Brå sub-kommun = 3 cities' stadsdelar only | no RegSO/DeSO crime; kommun value inherits with ° |
| `socio` direction unverified | left `neutral` until the metadata is checked (Phase 8) |

### Gates

`make validate` clean (44 indicators). `make test` clean. `make build` clean (14.8 MB).
No screenshots this phase — nothing visual changed.

