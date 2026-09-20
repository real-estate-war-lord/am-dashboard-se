# AM Dashboard — Sweden edition
# Targets that exist today. `build` and `serve` tell you what is missing
# rather than failing cryptically — the build scripts land after the data pull.

.PHONY: help selftest geo discover dry fetch status build serve

help:
	@echo "make selftest   offline checks, no network (1 s)"
	@echo "make geo        boundary polygons: RegSO 3363, DeSO 6160"
	@echo "make discover   resolve table ids known only by their old API path"
	@echo "make dry        plan the pull: calls and cells, no data"
	@echo "make fetch      THE DATA PULL — 45-90 min, resumable, keeps the Mac awake"
	@echo "make status     what is on disk right now"
	@echo "make build      build the dashboard (needs the pull + the registry)"
	@echo "make serve      serve dist/ at http://localhost:8080"

selftest:
	python3 scripts/selftest.py

geo:
	python3 scripts/fetch_geo_scb.py

discover:
	python3 scripts/discover_scb.py

dry:
	python3 scripts/fetch_scb.py --dry-run

fetch:
	caffeinate -i python3 scripts/fetch_scb.py 2>&1 | tee data/raw/_console.txt

status:
	@echo "data files : $$(ls data/raw/*.jsonl.gz 2>/dev/null | wc -l | tr -d ' ') of 75 pulls"
	@echo "metadata   : $$(ls data/raw/*.meta.json 2>/dev/null | wc -l | tr -d ' ') tables"
	@echo "boundaries : $$(ls data/geo/raw/*.geojson 2>/dev/null | wc -l | tr -d ' ') layers"
	@echo "registry   : $$(test -f config/indicators.json && echo yes || echo 'not written yet')"
	@echo "dashboard  : $$(test -f dist/index.html && echo built || echo 'not built yet')"

build:
	@test -f config/indicators.json || { echo "config/indicators.json missing — the indicator registry has not been written yet."; exit 1; }
	@test -n "$$(ls data/raw/*.jsonl.gz 2>/dev/null)" || { echo "no data on disk — run 'make fetch' first (45-90 min)."; exit 1; }
	@test -f scripts/build_makro.py || { echo "scripts/build_makro.py missing — the build scripts are ported after the data pull."; exit 1; }
	python3 scripts/build_makro.py && python3 scripts/build_market.py && python3 scripts/build_dashboard.py

serve:
	@test -f dist/index.html || { echo "dist/index.html does not exist yet. Order: make fetch -> registry -> make build -> make serve."; exit 1; }
	python3 -m http.server 8080 --directory dist
