#!/usr/bin/env python3
"""Infrastructure projects: the curated CSV into geometry the map can draw.

The rule that shapes this file: **nothing is drawn that was not found.** A
project whose stations cannot be located in OpenStreetMap gets
`"geometry": null` and appears in the Pipeline list and the datasheet but not on
the map. Sketching an alignment between two points because it "goes roughly
there" would be exactly the kind of invented figure this dashboard refuses, and
a dashed line on a map is read as a fact.

Station coordinates come from the OSM points already fetched for the Services
overlay (`data/raw/osm/<kommun>.json`), matched by name within the kommuner the
project actually runs through — so a station called "Centralen" in the wrong
city cannot be picked up.

Budgets carry their price base. A budget without one is meaningless, and the
CSV keeps the base the source stated rather than converting anything.

    python3 -u scripts/build_infra.py
"""
from __future__ import annotations

import csv
import json
import pathlib
import re
import sys
import unicodedata

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from se_common import GEO, PROC, ROOT                                    # noqa: E402

SRC = ROOT / "data" / "external" / "infra_se.csv"
OSM = ROOT / "data" / "raw" / "osm"
TYPES = {"metro", "tram", "rail", "road", "bridge_tunnel", "other"}
STATUSES = {"study", "decided", "construction", "opened"}


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", (s or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def main() -> int:
    if not SRC.exists():
        print(f"{SRC} missing", file=sys.stderr)
        return 1

    kom = json.loads((GEO / "kommuner.geojson").read_text(encoding="utf-8"))
    code_of = {norm(f["properties"].get("name", "")): f["properties"]["code"]
               for f in kom["features"]}

    # every named public-transport point we have, bucketed by kommun
    stops: dict = {}
    if OSM.exists():
        for fp in OSM.glob("*.json"):
            code = fp.stem
            lst = []
            for p in json.loads(fp.read_text(encoding="utf-8")):
                if p.get("c") == "transport" and p.get("n"):
                    lst.append((norm(p["n"]), p["lat"], p["lon"], p.get("t", "")))
            if lst:
                stops[code] = lst
    print(f"{sum(len(v) for v in stops.values()):,} named transport points in "
          f"{len(stops)} kommuner", flush=True)

    feats, index = [], []
    problems = []
    with SRC.open(encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh, delimiter=";"))

    for r in rows:
        pid = (r.get("id") or "").strip()
        if not pid:
            continue
        if r.get("type") not in TYPES:
            problems.append(f"{pid}: type '{r.get('type')}' not one of {sorted(TYPES)}")
        if r.get("status") not in STATUSES:
            problems.append(f"{pid}: status '{r.get('status')}' not one of {sorted(STATUSES)}")
        if r.get("budget_msek") and not r.get("price_base"):
            problems.append(f"{pid}: a budget with no price base is meaningless")
        if not r.get("source_url"):
            problems.append(f"{pid}: no source_url")

        names = [n for n in (r.get("kommuner") or "").split("|") if n]
        codes, unknown = [], []
        for n in names:
            c = code_of.get(norm(n))
            (codes.append(c) if c else unknown.append(n))
        if unknown:
            problems.append(f"{pid}: kommun name(s) not matched: {unknown}")

        station_names = [s for s in (r.get("stations") or "").split("|") if s]
        found = []
        pool = [s for c in codes for s in stops.get(c, [])]
        for sn in station_names:
            key = norm(sn)
            hit = next((s for s in pool if s[0] == key), None)
            if hit is None:
                hit = next((s for s in pool if key and (key in s[0] or s[0] in key)), None)
            if hit:
                found.append({"name": sn, "lat": hit[1], "lon": hit[2], "osm_tag": hit[3]})

        geom = None
        if found:
            geom = ({"type": "Point", "coordinates": [found[0]["lon"], found[0]["lat"]]}
                    if len(found) == 1 else
                    {"type": "MultiPoint",
                     "coordinates": [[s["lon"], s["lat"]] for s in found]})

        props = {
            "id": pid,
            "name": r.get("name", ""),
            "label_short": r.get("label_short", ""),
            "type": r.get("type", ""),
            "status": r.get("status", ""),
            "open_year": int(r["open_year"]) if (r.get("open_year") or "").strip().isdigit() else None,
            "open_window": r.get("open_window") or None,
            "budget_msek": float(r["budget_msek"]) if (r.get("budget_msek") or "").strip() else None,
            "price_base": r.get("price_base") or None,
            "agency": r.get("agency", ""),
            "kommuner": codes,
            "kommun_names": names,
            "stations": station_names,
            "stations_located": found,
            "geometry_source": ("osm:name match in the project's kommuner" if found
                                else "none — not drawn"),
            "source_url": r.get("source_url", ""),
            "source_doc": r.get("source_doc") or None,
            "notes": r.get("notes") or "",
        }
        feats.append({"type": "Feature", "properties": props, "geometry": geom})
        index.append({k: props[k] for k in
                      ("id", "name", "label_short", "type", "status", "open_year",
                       "open_window", "budget_msek", "price_base", "agency",
                       "kommuner", "source_url", "notes")})

    drawn = sum(1 for f in feats if f["geometry"])
    located = sum(len(f["properties"]["stations_located"]) for f in feats)
    want = sum(len(f["properties"]["stations"]) for f in feats)
    print(f"{len(feats)} projects · {drawn} with geometry · "
          f"{located} of {want} named stations located in OSM", flush=True)
    if problems:
        print(f"\n{len(problems)} problem(s):")
        for p in problems:
            print("  ⚠", p)

    gj = {"type": "FeatureCollection",
          "meta": {"source_csv": "data/external/infra_se.csv",
                   "attribution": ["Trafikverket", "Region Stockholm", "Västtrafik",
                                   "© OpenStreetMap contributors (station points, ODbL)"],
                   "note": "A project with no located station is not drawn. No "
                           "alignment is sketched between points."},
          "features": feats}
    (GEO / "infra_projects.geojson").write_text(
        json.dumps(gj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (PROC / "infra_index.json").write_text(
        json.dumps({"projects": index,
                    "built": __import__("datetime").date.today().isoformat()},
                   ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote data/geo/infra_projects.geojson "
          f"({(GEO / 'infra_projects.geojson').stat().st_size / 1024:.0f} kB) "
          f"and data/processed/infra_index.json")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
