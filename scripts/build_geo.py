#!/usr/bin/env python3
"""Turn SCB's raw boundary downloads into browser-sized GeoJSON.

Inputs  data/geo/raw/regso_2025.geojson  (3 363, 50.7 MB)
        data/geo/raw/deso_2025.geojson   (6 160, 62.1 MB)
Outputs data/geo/kommuner.geojson  290   kommun outlines      4.1 MB
        data/geo/regso.geojson     3 363 neighbourhoods      4.9 MB
        data/geo/deso.geojson      6 160 sub-areas          4.5 MB
                                   (split per kommun by build_makro, loaded on demand)

All three are clipped to the coastline with the mask from scripts/clip_geo.py.
RegSO and DeSO tile the whole national territory, water included, so without the
clip a coastal kommun reaches far out to sea — Värmdö keeps 15 % of its raw area,
Nynäshamn 28 %, inland Malå 100 %. Clipping has to happen before simplification;
the other way round leaves ragged edges.

Kommun outlines are dissolved out of RegSO rather than taken from SCB's own
kommun zip: the zip is SWEREF99TM shapefiles, which stdlib cannot read or
reproject, and RegSO tiles each kommun exactly. The dissolve is edge
cancellation — an edge walked by two neighbouring RegSO of the same kommun is
interior and drops out, what is left is the outline. Verified on Stockholm:
2 745 edges seen twice, 1 088 once, none three times.

Standard library only, so CI needs no geo stack.

Usage: python3 scripts/build_geo.py [--tolerance 0.0005]
"""
from __future__ import annotations

import argparse
import collections
import json
import math
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "geo" / "raw"
OUT = ROOT / "data" / "geo"

# Codes in the geometry are unsuffixed ('1961R007'); the statistics use the
# 2025-vintage suffix ('1961R007_RegSO2025'). The suffix is added here so the
# join in build_makro.py is a plain dictionary lookup and no caller has to
# remember which side it is on.
REGSO_SUFFIX = "_RegSO2025"
DESO_SUFFIX = "_DeSO2025"


# ---------------------------------------------------------------- simplify

def perpendicular(pt, a, b) -> float:
    """Distance from pt to segment a–b, in degrees (good enough to rank vertices)."""
    (y0, x0), (y1, x1), (y2, x2) = pt, a, b
    dy, dx = y2 - y1, x2 - x1
    if dy == 0 and dx == 0:
        return math.hypot(y0 - y1, x0 - x1)
    t = max(0.0, min(1.0, ((y0 - y1) * dy + (x0 - x1) * dx) / (dy * dy + dx * dx)))
    return math.hypot(y0 - (y1 + t * dy), x0 - (x1 + t * dx))


def simplify(points: list, eps: float) -> list:
    """Douglas–Peucker, iterative so a 40 000-vertex ring cannot blow the stack."""
    if len(points) < 3 or eps <= 0:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        lo, hi = stack.pop()
        if hi <= lo + 1:
            continue
        worst, wi = -1.0, lo
        for i in range(lo + 1, hi):
            d = perpendicular(points[i], points[lo], points[hi])
            if d > worst:
                worst, wi = d, i
        if worst > eps:
            keep[wi] = True
            stack.append((lo, wi))
            stack.append((wi, hi))
    return [p for p, k in zip(points, keep) if k]


def clean_ring(ring: list, eps: float, ndigits: int = 5) -> list | None:
    """Simplify, round and close one ring.

    A tolerance chosen to hit a file-size target will collapse the smallest
    polygons — two DeSO disappeared at 0.00075. An area with no polygon is a
    hole in the map, which is worse than an area drawn coarsely, so a ring
    that simplification would destroy keeps its rounded-but-unsimplified form.
    None only when the source ring was degenerate to begin with.
    """
    pts = [(round(p[1], ndigits), round(p[0], ndigits)) for p in ring]   # [lon,lat] -> (lat,lon)
    out = [pts[0]]
    for p in pts[1:]:
        if p != out[-1]:
            out.append(p)
    if len(out) < 4:
        return None
    if out[0] != out[-1]:
        out.append(out[0])
    thin = simplify(out, eps)
    return thin if len(thin) >= 4 else out


def ring_area(ring: list) -> float:
    """Shoelace area in square degrees — only ever used to rank and threshold."""
    a = 0.0
    for (y0, x0), (y1, x1) in zip(ring, ring[1:]):
        a += x0 * y1 - x1 * y0
    return abs(a) / 2


# Clipping to the coastline turns the archipelago into thousands of skerries.
# They are invisible at every zoom the dashboard offers and cost megabytes, so
# rings below this are dropped — except the largest of a feature, which is kept
# whatever its size so no area can vanish. 1 sq deg is ~6 100 km² at 60°N, so
# 2e-5 is about 0.12 km².
MIN_RING_AREA = 5e-5
MAX_RINGS = 60


def rings_of(geom: dict, eps: float, land: bool = False) -> list:
    """Outer rings only, as [[lat,lon],…] — holes are dropped; at this scale they
    are lakes and enclaves that cost bytes and change nothing on screen."""
    if land and _LAND["tree"] is not None:
        geom = clip_to_land(geom)
        if geom is None:
            return []
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    out = []
    for poly in polys:
        if not poly:
            continue
        r = clean_ring(poly[0], eps)
        if r:
            out.append([[a, b] for a, b in r])
    return prune(out)


def prune(rings: list) -> list:
    """Largest ring first, skerries below MIN_RING_AREA dropped, at most MAX_RINGS."""
    if len(rings) <= 1:
        return rings
    ranked = sorted(rings, key=ring_area, reverse=True)
    kept = [ranked[0]] + [r for r in ranked[1:] if ring_area(r) >= MIN_RING_AREA]
    return kept[:MAX_RINGS]


# ---------------------------------------------------------------- land mask

_LAND = {"tree": None, "parts": None}


def load_land(path: pathlib.Path):
    """Index the Swedish land mask from scripts/clip_geo.py.

    Shapely is imported here and nowhere else: without --land the whole build
    stays standard library, which is what CI runs.
    """
    from shapely.geometry import shape          # noqa: PLC0415
    from shapely.strtree import STRtree         # noqa: PLC0415
    geom = shape(json.loads(path.read_text(encoding="utf-8"))["geometry"])
    parts = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
    _LAND["parts"] = parts
    _LAND["tree"] = STRtree(parts)
    return len(parts)


def clip_to_land(geom: dict) -> dict | None:
    """One feature's geometry intersected with the coastline, or None if it is
    entirely at sea. RegSO and DeSO tile the territory including water, so a
    coastal area otherwise reaches far out into it."""
    from shapely.geometry import shape, mapping  # noqa: PLC0415
    from shapely.ops import unary_union          # noqa: PLC0415
    g = shape(geom)
    if not g.is_valid:
        g = g.buffer(0)
    idx = _LAND["tree"].query(g)
    if len(idx) == 0:
        return None
    # Clip each land part first and union the pieces, rather than unioning the
    # mask and clipping once: a northern kommun overlaps tens of thousands of
    # land polygons, and unioning those before the cut is what made this step
    # take hours. The pieces that survive the cut are small.
    parts = _LAND["parts"]
    pieces = []
    for i in idx:
        piece = parts[i].intersection(g)
        if not piece.is_empty and piece.area > 0:
            pieces.append(piece)
    if not pieces:
        return None
    out = pieces[0] if len(pieces) == 1 else unary_union(pieces)
    if out.is_empty or out.area <= 0:
        return None
    return mapping(out)


# ---------------------------------------------------------------- dissolve

def dissolve(features: list) -> list:
    """Union a set of polygons by cancelling the edges they share.

    Every ring is walked as directed edges. An edge interior to the union is
    walked once in each direction by the two polygons that meet along it, so
    the two cancel; boundary edges survive. The survivors are then stitched
    head-to-tail into closed rings.
    """
    edges: collections.Counter = collections.Counter()
    for f in features:
        geom = f["geometry"]
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        for poly in polys:
            for ring in poly:
                pts = [(round(p[1], 7), round(p[0], 7)) for p in ring]
                for a, b in zip(pts, pts[1:]):
                    if a == b:
                        continue
                    # count undirected: orientation differs between neighbours
                    edges[(a, b) if a < b else (b, a)] += 1

    nxt: dict = collections.defaultdict(list)
    for (a, b), n in edges.items():
        if n % 2:                      # survives: walked an odd number of times
            nxt[a].append(b)
            nxt[b].append(a)

    rings, seen = [], set()
    for start in list(nxt):
        if not nxt[start] or start in seen:
            continue
        ring, cur, prev = [start], start, None
        seen.add(start)
        while True:
            opts = [p for p in nxt[cur] if p != prev]
            if not opts:
                break
            step = next((p for p in opts if p not in seen), opts[0])
            if step == start:
                ring.append(start)
                break
            if step in seen:
                break
            seen.add(step)
            ring.append(step)
            prev, cur = cur, step
        if len(ring) >= 4:
            rings.append(ring)
    return rings


# ---------------------------------------------------------------- names

def kommun_names() -> dict:
    """kommunkod -> name, out of any table metadata that has a Region dimension."""
    for table in ("TAB6574", "TAB824", "TAB4590", "TAB1169"):
        p = ROOT / "data" / "raw" / f"scb_{table}.meta.json"
        if not p.exists():
            continue
        meta = json.loads(p.read_text(encoding="utf-8"))
        for dim in ("Region", "region"):
            d = (meta.get("dimension") or {}).get(dim)
            if not d:
                continue
            lab = (d.get("category") or {}).get("label") or {}
            # SCB labels read "0180 Stockholm" — the code is already the key
            out = {k: re.sub(r"^\d{4}\s+", "", v) for k, v in lab.items()
                   if len(k) == 4 and k.isdigit()}
            if len(out) >= 280:
                return out
    return {}


# ---------------------------------------------------------------- main

def progress(i: int, n: int, what: str) -> None:
    if i % 500 == 0 or i == n:
        print(f"    {what} {i}/{n}", flush=True)


def write(path: pathlib.Path, features: list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"type": "FeatureCollection", "features": features}
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    mb = path.stat().st_size / 1e6
    flag = "" if mb < 5 else "   ⚠ over the 5 MB target"
    print(f"  {path.name:20s} {len(features):5d} features · {mb:5.2f} MB{flag}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tolerance", type=float, default=0.0008,
                    help="Douglas-Peucker epsilon in degrees for RegSO (0.0008 ~ 60 m)")
    ap.add_argument("--kommun-tolerance", type=float, default=0.0004)
    # DeSO polygons are small and numerous; the master file only lives in the
    # repo (the page loads one kommun at a time), but keep it under the 5 MB
    # target so nobody has to think about it.
    ap.add_argument("--deso-tolerance", type=float, default=0.0015)
    ap.add_argument("--land", default=str(RAW / "sweden_land.geojson"),
                    help="land mask from scripts/clip_geo.py; pass '' to skip clipping")
    args = ap.parse_args()

    regso_raw = RAW / "regso_2025.geojson"
    deso_raw = RAW / "deso_2025.geojson"
    for p in (regso_raw, deso_raw):
        if not p.exists():
            print(f"missing {p} — run scripts/fetch_geo_scb.py", file=sys.stderr)
            return 1

    names = kommun_names()
    print(f"kommun names from metadata: {len(names)}")

    land_path = pathlib.Path(args.land) if args.land else None
    if land_path and land_path.exists():
        print(f"loading land mask {land_path.name} ({land_path.stat().st_size / 1e6:.0f} MB)…")
        print(f"  {load_land(land_path):,} land parts indexed")
    elif args.land:
        print(f"  no land mask at {land_path} — boundaries will include open water "
              "(run scripts/clip_geo.py)", file=sys.stderr)

    print("reading RegSO…")
    regso = json.loads(regso_raw.read_text(encoding="utf-8"))["features"]

    # --- kommun outlines, dissolved out of RegSO
    print("dissolving kommun outlines…")
    by_kommun: dict = collections.defaultdict(list)
    for f in regso:
        by_kommun[f["properties"]["kommunkod"]].append(f)
    kom_features = []
    for n_i, kod in enumerate(sorted(by_kommun), 1):
        progress(n_i, len(by_kommun), "kommun")
        rings = dissolve(by_kommun[kod])
        # Dissolve first, clip second: cancelling shared edges needs the exact
        # vertices of the source, which clipping would move.
        if _LAND["tree"] is not None and rings:
            geom = {"type": "MultiPolygon",
                    "coordinates": [[[[p[1], p[0]] for p in r]] for r in rings]}
            clipped = clip_to_land(geom)
            if clipped:
                polys = (clipped["coordinates"] if clipped["type"] == "MultiPolygon"
                         else [clipped["coordinates"]])
                rings = [[(pt[1], pt[0]) for pt in poly[0]] for poly in polys if poly]
        rings = [r for r in (clean_ring([[p[1], p[0]] for p in ring], args.kommun_tolerance) for ring in rings) if r]
        if not rings:
            print(f"  ! kommun {kod} dissolved to nothing", file=sys.stderr)
            continue
        rings = prune([[list(p) for p in r] for r in rings])
        kom_features.append({
            "type": "Feature",
            "properties": {"code": kod, "name": names.get(kod, kod),
                           "lan": by_kommun[kod][0]["properties"]["lanskod"]},
            "geometry": {"type": "MultiPolygon",
                         "coordinates": [[[[p[1], p[0]] for p in r]] for r in rings]},
        })
    write(OUT / "kommuner.geojson", kom_features)

    # --- RegSO
    print("simplifying RegSO…")
    regso_features = []
    for n_i, f in enumerate(regso, 1):
        progress(n_i, len(regso), "RegSO")
        pr = f["properties"]
        rings = rings_of(f["geometry"], args.tolerance, land=True)
        if not rings:
            continue
        regso_features.append({
            "type": "Feature",
            "properties": {"code": pr["regsokod"] + REGSO_SUFFIX, "plain": pr["regsokod"],
                           "name": pr["regsonamn"], "kommun": pr["kommunkod"], "lan": pr["lanskod"]},
            "geometry": {"type": "MultiPolygon",
                         "coordinates": [[[[p[1], p[0]] for p in r]] for r in rings]},
        })
    write(OUT / "regso.geojson", regso_features)
    del regso

    # --- DeSO
    print("reading and simplifying DeSO…")
    deso = json.loads(deso_raw.read_text(encoding="utf-8"))["features"]
    deso_features = []
    for n_i, f in enumerate(deso, 1):
        progress(n_i, len(deso), "DeSO")
        pr = f["properties"]
        rings = rings_of(f["geometry"], args.deso_tolerance, land=True)
        if not rings:
            continue
        deso_features.append({
            "type": "Feature",
            "properties": {"code": pr["desokod"] + DESO_SUFFIX, "plain": pr["desokod"],
                           "regso": pr["regsokod"] + REGSO_SUFFIX,
                           "kommun": pr["kommunkod"], "lan": pr["lanskod"]},
            "geometry": {"type": "MultiPolygon",
                         "coordinates": [[[[p[1], p[0]] for p in r]] for r in rings]},
        })
    write(OUT / "deso.geojson", deso_features)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
