# AM Dashboard — Sweden edition
# Targets that exist today. `build` and `serve` tell you what is missing
# rather than failing cryptically — the build scripts land after the data pull.

.PHONY: help selftest test geo simplify riksbank discover dry fetch status validate build serve

help:
	@echo "make selftest   offline checks, no network (1 s)"
	@echo "make geo        boundary polygons: RegSO 3363, DeSO 6160"
	@echo "make simplify   raw boundaries -> browser-sized data/geo/*.geojson"
	@echo "make riksbank   policy rate and 10-yr yield from the SWEA API"
	@echo "make discover   resolve table ids known only by their old API path"
	@echo "make dry        plan the pull: calls and cells, no data"
	@echo "make fetch      THE DATA PULL — 45-90 min, resumable, keeps the Mac awake"
	@echo "make status     what is on disk right now"
	@echo "make validate   check config/indicators.json against the metadata on disk"
	@echo "make test       render every view headlessly against the built page"
	@echo "make build      build the dashboard (needs the pull + the registry)"
	@echo "make serve      serve dist/ at http://localhost:8080"

selftest:
	python3 scripts/selftest.py

geo:
	python3 scripts/fetch_geo_scb.py

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

test:
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
