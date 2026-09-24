#!/usr/bin/env python3
"""Rings for point-in-polygon, at every level, small enough to fetch on demand.

The dropped pin has to answer "which kommun, which RegSO, which DeSO is this?"
exactly, and the only honest way is to test the point against the same rings the
map draws. Three things this file gets right that a naive export would not:

  * **Holes are kept.** A polygon with a lake or an enclave in it must exclude
    points inside the hole. Dropping interior rings would put a pin in Vänern
    inside the kommun that surrounds it.
  * **Coordinates stay [lon, lat]**, the GeoJSON order, and the page swaps once
    when it loads them. CLAUDE.md records what three swaps did to this repo.
  * **A bbox per area**, so the page rejects almost everything with four
    comparisons before it runs a ray cast.

Simplified harder than the map layer — a boundary good to ~40 m is plenty to say
which RegSO a building is in, and it keeps the files small enough to load one
kommun at a time.

    python3 scripts/build_lookup.py
"""
from __future__ import annotations

import json
import math
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from se_common import GEO, PROC, ROOT                                    # noqa: E402

OUT = PROC / "lookup"
TOL_M = 40.0                      # simplification tolerance, in METRES


def to_m(lon, lat, lat0):
    """Local equirectangular metres. Degrees are not a distance: a degree of
    longitude at 67 °N is 39 % of one at 55 °N, and simplifying in degrees would
    be that much coarser east-west in the north."""
    return (lon * math.cos(math.radians(lat0)) * 111320.0, lat * 110540.0)


def simplify(ring, tol_m, lat0):
    """Douglas-Peucker in metres."""
    if len(ring) < 4:
        return ring
    pts = [to_m(p[0], p[1], lat0) for p in ring]

    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        ax, ay = pts[a]; bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        den = math.hypot(dx, dy) or 1e-12
        worst, wi = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            d = abs(dy * px - dx * py + bx * ay - by * ax) / den
            if d > worst:
                worst, wi = d, i
        if worst > tol_m:
            keep[wi] = True
            stack += [(a, wi), (wi, b)]
    out = [ring[i] for i, k in enumerate(keep) if k]
    return out if len(out) >= 4 else ring


def rings_of(geom, lat0):
    """[[shell, hole, …], …] — holes kept, each simplified."""
    t = geom.get("type")
    polys = []
    if t == "Polygon":
        polys = [geom["coordinates"]]
    elif t == "MultiPolygon":
        polys = geom["coordinates"]
    out = []
    for poly in polys:
        keep = []
        for k, ring in enumerate(poly):
            # 4 decimals is ~11 m of longitude at 59 °N — finer than the 40 m
            # simplification tolerance, so rounding harder costs nothing real and
            # keeps the kommun file comfortably inside the 3 MB budget
            r = simplify([[round(c[0], 4), round(c[1], 4)] for c in ring], TOL_M, lat0)
            # an interior ring that simplifies away is dropped; a shell never is
            if k == 0 or len(r) >= 4:
                keep.append(r)
        if keep and len(keep[0]) >= 4:
            out.append(keep)
    return out


def bbox_of(polys):
    xs = [c[0] for poly in polys for ring in poly for c in ring]
    ys = [c[1] for poly in polys for ring in poly for c in ring]
    return [round(min(ys), 4), round(min(xs), 4), round(max(ys), 4), round(max(xs), 4)]


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for p in OUT.glob("*.json"):
        p.unlink()

    # kommun rings inline (290, the first question every pin asks)
    kom = json.loads((GEO / "kommuner.geojson").read_text(encoding="utf-8"))
    kommuner = []
    for f in kom["features"]:
        pr = f["properties"]
        lat0 = (f["geometry"]["coordinates"][0][0][0][1]
                if f["geometry"]["type"] == "MultiPolygon"
                else f["geometry"]["coordinates"][0][0][1])
        polys = rings_of(f["geometry"], lat0)
        if not polys:
            continue
        kommuner.append({"code": pr["code"], "name": pr.get("name", ""),
                         "bbox": bbox_of(polys), "p": polys})
    kp = PROC / "lookup_kommuner.json"
    kp.write_text(json.dumps(kommuner, separators=(",", ":")), encoding="utf-8")
    print(f"kommuner: {len(kommuner)} · {kp.stat().st_size / 1024:.0f} kB")

    # RegSO and DeSO one file per kommun, fetched when a pin lands in it
    index: dict = {}
    for level, fname in (("regso", "regso.geojson"), ("deso", "deso.geojson")):
        data = json.loads((GEO / fname).read_text(encoding="utf-8"))
        by_k: dict = {}
        for f in data["features"]:
            pr = f["properties"]
            k = pr.get("kommun")
            if not k:
                continue
            lat0 = (f["geometry"]["coordinates"][0][0][0][1]
                    if f["geometry"]["type"] == "MultiPolygon"
                    else f["geometry"]["coordinates"][0][0][1])
            polys = rings_of(f["geometry"], lat0)
            if not polys:
                continue
            by_k.setdefault(k, []).append(
                {"code": pr["code"], "name": pr.get("name", ""),
                 "bbox": bbox_of(polys), "p": polys})
        tot = 0
        for k, lst in by_k.items():
            path = OUT / f"{level}_{k}.json"
            path.write_text(json.dumps(lst, separators=(",", ":")), encoding="utf-8")
            tot += path.stat().st_size
            index.setdefault(k, {})[level] = len(lst)
        print(f"{level}: {sum(len(v) for v in by_k.values()):,} areas in "
              f"{len(by_k)} files · {tot / 1024 / 1024:.1f} MB total")

    (PROC / "lookup_index.json").write_text(json.dumps(index, separators=(",", ":")),
                                            encoding="utf-8")
    biggest = max((p.stat().st_size for p in OUT.glob("*.json")), default=0)
    print(f"largest per-kommun lookup file: {biggest / 1024:.0f} kB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
