# AM Dashboard — Sweden edition
# Targets that exist today. `build` and `serve` tell you what is missing
# rather than failing cryptically — the build scripts land after the data pull.

.PHONY: help selftest test verify geo land simplify riksbank kolada external discover dry fetch status validate links srclinks bra polisen schools climate infra services lookup test-js build serve

help:
	@echo "make selftest   offline checks, no network (1 s)"
	@echo "make geo        boundary polygons: RegSO 3363, DeSO 6160"
	@echo "make land       Swedish land mask from the OSM land polygons (once, needs shapely)"
	@echo "make simplify   raw boundaries -> clipped, browser-sized data/geo/*.geojson"
	@echo "make riksbank   policy rate and 10-yr yield from the SWEA API"
	@echo "make discover   resolve table ids known only by their old API path"
	@echo "make dry        plan the pull: calls and cells, no data"
	@echo "make fetch      THE DATA PULL — 45-90 min, resumable, keeps the Mac awake"
	@echo "make status     what is on disk right now"
	@echo "make validate   check config/indicators.json against the metadata on disk"
	@echo "make links      re-fetch every verify-at-source link (network, ~2 min)"
	@echo "make srclinks   rebuild the verify-at-source queries from the metadata"
	@echo "make test       render every view headlessly + the offline unit tests"
	@echo "make test-js    the offline unit tests only (testprop parser)"
	@echo "make lookup     boundary rings for the dropped pin"
	@echo "make verify     recompute 5 kommuner x 3 indicators straight from the API"
	@echo "make external   Boverket BME, Kronofogden and Kolada -> data/external/"
	@echo "make bra        reported offences per kommun from Bra SOL (resumable)"
	@echo "make polisen    police-designated vulnerable areas -> area shares"
	@echo "make schools    every school with year 9 from Skolverket (resumable)"
	@echo "make climate    flood, coast, sea level, landslide, cloudburst (slow)"
	@echo "make infra      curated project list -> map geometry and Pipeline"
	@echo "make services   OSM points for the Services and Public overlays"
	@echo "make build      build the dashboard (needs the pull + the registry)"
	@echo "make serve      serve dist/ at http://localhost:8080"

selftest:
	python3 scripts/selftest.py

geo:
	python3 scripts/fetch_geo_scb.py

land:
	@test -d data/geo/raw/osm-land || { echo "download land-polygons-complete-4326.zip from osmdata.openstreetmap.de and unzip it to data/geo/raw/osm-land/"; exit 1; }
	python3 scripts/clip_geo.py

simplify:
	python3 scripts/build_geo.py

riksbank:
	python3 scripts/fetch_riksbank.py

discover:
	python3 scripts/discover_scb.py

dry:
	python3 scripts/fetch_scb.py --dry-run

fetch:
	caffeinate -i python3 scripts/fetch_scb.py 2>&1 | tee data/raw/_console.txt

status:
	@echo "data files : $$(ls data/raw/*.jsonl.gz 2>/dev/null | wc -l | tr -d ' ') of $$(python3 -c 'import json;c=json.load(open("config/tables_se.json"));print(sum(len(t.get("levels") or ["all"]) for t in c["tables"]))') pulls"
	@echo "metadata   : $$(ls data/raw/*.meta.json 2>/dev/null | wc -l | tr -d ' ') tables"
	@echo "boundaries : $$(ls data/geo/raw/*.geojson 2>/dev/null | wc -l | tr -d ' ') layers"
	@echo "registry   : $$(test -f config/indicators.json && python3 -c 'import json;print(len(json.load(open("config/indicators.json"))["indicators"]),"indicators")' || echo 'not written yet')"
	@echo "geometry   : $$(ls data/geo/*.geojson 2>/dev/null | wc -l | tr -d ' ') simplified layers"
	@echo "dashboard  : $$(test -f dist/index.html && echo "built ($$(du -h dist/index.html | cut -f1))" || echo 'not built yet')"

validate:
	python3 scripts/validate_indicators.py

# Rebuild the per-indicator "Verify at source" queries from the metadata on disk.
# Run after editing config/indicators.json, then `make build`.
srclinks:
	python3 scripts/build_src_links.py

# The full sweep: fetch every verify-at-source link and check it returns cells.
# Split out of `make validate` because it is the only target that needs network.
links:
	python3 scripts/check_source_links.py

verify:
	python3 scripts/verify_scb.py

external:
	python3 scripts/import_bme.py && python3 scripts/import_kronofogden.py && python3 scripts/fetch_kolada.py

# Bra has no open-data API; SOL is the only machine route to kommun-level crime.
# Resumable: a file already in data/raw/bra/ is not fetched again.
bra:
	python3 scripts/fetch_bra.py --quarters && python3 scripts/import_bra.py

polisen:
	python3 scripts/fetch_polisen.py

# ~3 600 API calls, throttled and resumable; a cached unit is not fetched again.
# flood, coast, sea level, landslide and cloudburst. The fetch is ~3 GB of raw
# GIS and is cached; the build intersects it all in SWEREF99 TM metres.
climate:
	python3 -u scripts/fetch_climate.py && python3 -u scripts/dedup_sgu.py && python3 -u scripts/build_climate.py

infra:
	python3 -u scripts/build_infra.py

services:
	python3 -u scripts/fetch_osm.py && python3 -u scripts/build_services.py

# boundary rings for the dropped pin, one file per kommun
lookup:
	python3 scripts/build_lookup.py

test-js:
	node --test tests/*.test.js

schools:
	python3 scripts/fetch_skolverket.py && python3 scripts/import_skolenkaten.py && python3 scripts/build_schools.py

test: test-js
	@test -f dist/index.html || { echo "dist/index.html missing — run 'make build' first."; exit 1; }
	node tests/smoke.js

build:
	@test -f config/indicators.json || { echo "config/indicators.json missing — the indicator registry has not been written yet."; exit 1; }
	@test -n "$$(ls data/raw/*.jsonl.gz 2>/dev/null)" || { echo "no data on disk — run 'make fetch' first (45-90 min)."; exit 1; }
	@test -f data/geo/kommuner.geojson || { echo "data/geo/*.geojson missing — run 'make simplify' first."; exit 1; }
	python3 scripts/build_makro.py && python3 scripts/build_market.py && python3 scripts/build_dashboard.py

serve:
	@test -f dist/index.html || { echo "dist/index.html does not exist yet. Order: make fetch -> registry -> make build -> make serve."; exit 1; }
	python3 -m http.server 8080 --directory dist
