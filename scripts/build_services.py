#!/usr/bin/env python3
"""OSM points into per-kommun files for the Services and Public buildings overlays.

Points only, no area indicators. The Danish edition made the same call and the
reason holds here: a count of cafés per 1 000 inhabitants looks like a statistic
but measures how thoroughly a place has been mapped by volunteers as much as how
many cafés it has. Showing the points lets a reader see the coverage for
themselves; turning them into a rate would hide it.

Each point keeps the OSM tag that put it in its category, so a reader can always
ask why something is called a supermarket.

    python3 -u scripts/build_services.py
"""
from __future__ import annotations

import collections
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from se_common import PROC, ROOT                                         # noqa: E402

RAW = ROOT / "data" / "raw" / "osm"            # the old Overpass cache, if any
PBF_POINTS = ROOT / "data" / "interim" / "osm" / "points.json"
OUT = PROC / "services"

SERVICES = {"grocery", "food", "pharmacy", "transport"}
PUBLIC = {"education", "daycare", "health", "culture", "sports"}


def main() -> int:
    if not PBF_POINTS.exists() and not RAW.exists():
        print("no points: run scripts/extract_osm_pbf.py (preferred) or "
              "scripts/fetch_osm.py", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    for p in OUT.glob("*.json"):
        p.unlink()

    index, counts = {}, collections.Counter()
    by_kommun: dict = collections.defaultdict(list)

    if PBF_POINTS.exists():
        # The whole country in one file, straight from the Geofabrik extract.
        # Split by POINT-IN-POLYGON on our own kommun rings, not by bounding
        # box: a kommun's box overlaps its neighbours', and a café would land in
        # two of them.
        try:
            from shapely.geometry import shape, Point
            from shapely.strtree import STRtree
        except ImportError:
            print("shapely is needed to split the extract — see requirements-geo.txt",
                  file=sys.stderr)
            return 1
        pts = json.loads(PBF_POINTS.read_text(encoding="utf-8"))
        kom = json.loads((ROOT / "data" / "geo" / "kommuner.geojson").read_text(encoding="utf-8"))
        geoms, codes = [], []
        for f in kom["features"]:
            g = shape(f["geometry"])
            if not g.is_valid:
                g = g.buffer(0)
            geoms.append(g)
            codes.append(f["properties"]["code"])
        tree = STRtree(geoms)
        print(f"{len(pts):,} points from the extract → {len(codes)} kommuner", flush=True)
        placed = outside = 0
        for n, (cat, lat, lon, name, tag) in enumerate(pts, 1):
            if cat not in SERVICES and cat not in PUBLIC:
                continue
            pt = Point(lon, lat)
            hit = None
            for i in tree.query(pt):
                if geoms[i].contains(pt):
                    hit = codes[i]
                    break
            if hit is None:
                # at sea, or just outside the coastline clip — not forced into
                # the nearest kommun, because "nearly in" is not "in"
                outside += 1
                continue
            by_kommun[hit].append([cat, lat, lon, name, tag])
            counts[cat] += 1
            placed += 1
            if n % 25000 == 0:
                print(f"  {n:,}/{len(pts):,} · {placed:,} placed", flush=True)
        print(f"  {placed:,} placed, {outside:,} outside every kommun boundary", flush=True)
    else:
        # the old per-kommun Overpass cache, if the extract is not there
        for fp in sorted(RAW.glob("*.json")):
            try:
                pts = json.loads(fp.read_text(encoding="utf-8"))
            except Exception:                                            # noqa: BLE001
                continue
            for q in pts:
                c = q.get("c")
                if c in SERVICES or c in PUBLIC:
                    by_kommun[fp.stem].append(
                        [c, q["lat"], q["lon"], q.get("n") or "", q.get("t") or ""])
                    counts[c] += 1

    for code, rows in sorted(by_kommun.items()):
        lats = [r[1] for r in rows]; lons = [r[2] for r in rows]
        (OUT / f"{code}.json").write_text(
            json.dumps(rows, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        index[code] = {"n": len(rows),
                       "bbox": [round(min(lats), 4), round(min(lons), 4),
                                round(max(lats), 4), round(max(lons), 4)]}

    meta = {"source": "OpenStreetMap contributors (ODbL)",
            "route": ("Geofabrik sweden-latest.osm.pbf, read with pyosmium"
                      if PBF_POINTS.exists() else "Overpass API, partial"),
            "kommuner": len(index),
            "counts": dict(sorted(counts.items())),
            "note": "Points only. A count per inhabitant would measure mapping "
                    "effort as much as provision, so none is published.",
            "services": sorted(SERVICES), "public": sorted(PUBLIC)}
    (PROC / "services.json").write_text(
        json.dumps({"meta": meta, "index": index}, ensure_ascii=False,
                   separators=(",", ":")), encoding="utf-8")
    biggest = max((p.stat().st_size for p in OUT.glob("*.json")), default=0)
    print(f"{sum(counts.values()):,} points across {len(index)} of 290 kommuner")
    for c, n in sorted(counts.items()):
        print(f"  {c:10s} {n:7,}")
    print(f"largest per-kommun file: {biggest / 1024:.0f} kB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
