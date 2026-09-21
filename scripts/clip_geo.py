#!/usr/bin/env python3
"""Extract a Swedish land mask from the OSM land polygons.

Input   data/geo/raw/osm-land/land_polygons.shp   (1.3 GB, EPSG:4326)
        from https://osmdata.openstreetmap.de/download/land-polygons-complete-4326.zip
Output  data/geo/raw/sweden_land.geojson          the mask build_geo.py clips against

RegSO and DeSO tile the whole national territory, sea included, so a coastal
kommun drawn straight from them reaches far out into open water — Nynäshamn and
the Stockholm archipelago are the obvious cases. Clipping to the coastline fixes
that, and has to happen before simplification: clipping an already-simplified
polygon against a detailed coastline leaves ragged edges.

The shapefile is read with the standard library. Every polygon record carries
its own bounding box ahead of its points, so records outside Sweden are skipped
by seeking past them — one pass over 1.3 GB costs little more than the seeks.
Shapely is used only for the union, and only here: this script is run once and
its output is committed, so the build and CI stay dependency-free.

Licence: OSM land polygons are ODbL — attribution is required and is carried in
data/processed/makro.json's `attribution`.

Usage: python3 scripts/clip_geo.py
"""
from __future__ import annotations

import json
import pathlib
import struct
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "geo" / "raw"
def _find_shp() -> pathlib.Path:
    """The zip unpacks into a versioned subdirectory, so look one level down too."""
    base = RAW / "osm-land"
    direct = base / "land_polygons.shp"
    if direct.exists():
        return direct
    found = sorted(base.glob("*/land_polygons.shp"))
    return found[0] if found else direct


SHP = _find_shp()
OUT = RAW / "sweden_land.geojson"

# Sweden plus a margin: the mask only has to cover what the boundary files do.
LON0, LAT0, LON1, LAT1 = 10.0, 54.8, 24.8, 69.5

SHAPE_POLYGON = 5


def read_polygons(path: pathlib.Path, bbox):
    """Yield polygons (as lists of rings of (lon, lat)) that intersect bbox.

    Shapefile polygon record: 8-byte header (number, content length in 16-bit
    words), then shape type (int32 LE), the record's own box (4 doubles), the
    part and point counts, the part offsets and finally the points.
    """
    x0, y0, x1, y1 = bbox
    size = path.stat().st_size
    kept = skipped = 0
    with path.open("rb") as fh:
        fh.seek(100)                                  # file header
        while fh.tell() < size:
            head = fh.read(8)
            if len(head) < 8:
                break
            _num, words = struct.unpack(">ii", head)
            content = words * 2
            start = fh.tell()
            shape_type = struct.unpack("<i", fh.read(4))[0]
            if shape_type != SHAPE_POLYGON:
                fh.seek(start + content)
                continue
            bx0, by0, bx1, by1 = struct.unpack("<4d", fh.read(32))
            if bx1 < x0 or bx0 > x1 or by1 < y0 or by0 > y1:
                fh.seek(start + content)              # outside Sweden — skip the points
                skipped += 1
                continue
            n_parts, n_points = struct.unpack("<ii", fh.read(8))
            parts = struct.unpack(f"<{n_parts}i", fh.read(4 * n_parts))
            pts = struct.unpack(f"<{2 * n_points}d", fh.read(16 * n_points))
            rings = []
            for i, off in enumerate(parts):
                end = parts[i + 1] if i + 1 < n_parts else n_points
                ring = [(pts[2 * j], pts[2 * j + 1]) for j in range(off, end)]
                if len(ring) >= 4:
                    rings.append(ring)
            if rings:
                kept += 1
                yield rings
            fh.seek(start + content)
    print(f"  polygons kept {kept:,} · skipped by bbox {skipped:,}", file=sys.stderr)


def main() -> int:
    if not SHP.exists():
        print(f"missing {SHP}\n"
              "download land-polygons-complete-4326.zip from osmdata.openstreetmap.de "
              "and unzip it to data/geo/raw/osm-land/", file=sys.stderr)
        return 1
    try:
        from shapely.geometry import Polygon, MultiPolygon
        from shapely.ops import unary_union
    except ImportError:
        print("this script needs shapely (pip install shapely) — it is the only step that does",
              file=sys.stderr)
        return 1

    print(f"reading {SHP.name} ({SHP.stat().st_size / 1e9:.1f} GB)…")
    polys = []
    for rings in read_polygons(SHP, (LON0, LAT0, LON1, LAT1)):
        try:
            p = Polygon(rings[0], rings[1:]) if len(rings) > 1 else Polygon(rings[0])
        except Exception:                              # noqa: BLE001 — a bad ring is not worth the run
            continue
        if not p.is_valid:
            p = p.buffer(0)
        if not p.is_empty and p.area > 0:
            polys.append(p)
    print(f"  {len(polys):,} polygons in the Swedish window")
    if not polys:
        print("nothing in the window — check the bbox", file=sys.stderr)
        return 1

    print("unioning…")
    land = unary_union(polys)
    if land.geom_type == "Polygon":
        land = MultiPolygon([land])
    print(f"  {len(land.geoms)} parts · {land.area:.2f} sq deg")

    OUT.write_text(json.dumps({
        "type": "Feature",
        "properties": {"source": "OSM land polygons (osmdata.openstreetmap.de)", "licence": "ODbL"},
        "geometry": json.loads(json.dumps(land.__geo_interface__)),
    }, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
