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

Simplification is a DISTANCE tolerance in metres, not a share of vertices and
not a tolerance in degrees. A degree of longitude at 59°N is half a degree of
latitude, so a degree-based epsilon is twice as coarse north-south as east-west
and the result is visibly angular; everything here works in a local metric frame.

The coastline clip is cached at full precision under data/geo/raw/clipped/, so
changing the tolerance is seconds rather than another 35-minute cut.

Usage: python3 scripts/build_geo.py [--metres 40] [--reclip]
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

# One degree of latitude is 111 320 m everywhere; one degree of longitude is that
# times cos(lat), which at 59°N is about half. A tolerance expressed in degrees is
# therefore twice as coarse north-south as east-west, and a boundary simplified
# that way comes out visibly angular. Everything below works in metres.
M_PER_DEG = 111320.0


def lon_scale(lat: float) -> float:
    return math.cos(math.radians(lat))


def perpendicular(pt, a, b) -> float:
    """Distance from pt to segment a–b, in the units the points are given in."""
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


def clean_ring(ring: list, metres: float, ndigits: int = 5) -> list | None:
    """Simplify to a distance tolerance in METRES, round and close one ring.

    Simplification runs in a local metric frame — latitude scaled by 111 320 m,
    longitude by that times cos(lat) — so 40 m means 40 m in both directions.

    A tolerance chosen to hit a file-size target will still collapse the
    smallest polygons. An area with no polygon is a hole in the map, which is
    worse than an area drawn coarsely, so a ring that simplification would
    destroy keeps its rounded-but-unsimplified form. None only when the source
    ring was degenerate to begin with.
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
    if metres <= 0:
        return out
    k = lon_scale(sum(p[0] for p in out) / len(out))
    metric = [(p[0] * M_PER_DEG, p[1] * M_PER_DEG * k) for p in out]
    keep = simplify_indices(metric, metres)
    thin = [out[i] for i in keep]
    return thin if len(thin) >= 4 else out


def simplify_indices(points: list, eps: float) -> list:
    """Douglas–Peucker returning the indices kept, so the caller can map back."""
    n = len(points)
    if n < 3 or eps <= 0:
        return list(range(n))
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
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
    return [i for i, k in enumerate(keep) if k]


def ring_area_km2(ring: list) -> float:
    """Shoelace area in km², with longitude scaled for the ring's latitude."""
    if len(ring) < 4:
        return 0.0
    k = lon_scale(sum(p[0] for p in ring) / len(ring))
    a = 0.0
    for (y0, x0), (y1, x1) in zip(ring, ring[1:]):
        a += (x0 * k) * y1 - (x1 * k) * y0
    return abs(a) / 2 * (M_PER_DEG ** 2) / 1e6


# Clipping to the coastline turns the archipelago into skerries. The previous
# threshold, 5e-5 square degrees, is 0.32 km² at 60°N — large enough to delete
# real islands and leave the archipelago looking like scattered blobs. The
# threshold is now in km² and small enough that an island anyone would notice
# survives; file size is controlled by the metric tolerance instead.
MIN_RING_KM2 = 0.05
MAX_RINGS = 400


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
    """Largest ring first, skerries below MIN_RING_KM2 dropped, at most MAX_RINGS."""
    if len(rings) <= 1:
        return rings
    ranked = sorted(rings, key=ring_area_km2, reverse=True)
    kept = [ranked[0]] + [r for r in ranked[1:] if ring_area_km2(r) >= MIN_RING_KM2]
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


CACHE = RAW / "clipped"


def cache_path(level: str) -> pathlib.Path:
    return CACHE / f"{level}.geojson"


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
    budget = {"kommuner.geojson": 3.0, "regso.geojson": 8.0, "deso.geojson": 12.0}.get(path.name, 5.0)
    flag = "" if mb < budget else f"   ⚠ over its {budget:g} MB budget"
    print(f"  {path.name:20s} {len(features):5d} features · {mb:5.2f} MB{flag}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--metres", type=float, default=45.0,
                    help="simplification tolerance for RegSO, in metres")
    # Kommun outlines carry the whole coastline, so they are the heaviest file;
    # 60 m keeps Göteborg at ~1 375 vertices and Stockholm at ~291, which is
    # every bend either has, and lands the file under 3 MB.
    ap.add_argument("--kommun-metres", type=float, default=60.0)
    ap.add_argument("--deso-metres", type=float, default=40.0)
    ap.add_argument("--reclip", action="store_true",
                    help="redo the coastline clip instead of using data/geo/raw/clipped/")
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

    # Clipping 9 523 polygons against the coastline takes ~35 minutes; the
    # result is cached at full precision so trying a different tolerance is
    # seconds, not another half hour. The cache lives under data/geo/raw/,
    # which is git-ignored.
    use_cache = not args.reclip and all(cache_path(l).exists() for l in ("kommun", "regso", "deso"))
    if use_cache:
        print(f"using the clipped cache in {CACHE}")
    else:
        CACHE.mkdir(parents=True, exist_ok=True)

    print("reading RegSO…")
    regso = json.loads(regso_raw.read_text(encoding="utf-8"))["features"]

    def cached(level: str, build):
        """Clipped geometry at full precision, from the cache or freshly cut."""
        path = cache_path(level)
        if use_cache and path.exists():
            feats = json.loads(path.read_text(encoding="utf-8"))["features"]
            print(f"  {level}: {len(feats)} clipped features from cache")
            return feats
        feats = build()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                                   ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"  {level}: {len(feats)} clipped features cached to {path.name}")
        return feats

    def emit(level: str, feats: list, metres: float, out_name: str):
        """Simplify cached geometry to a metric tolerance and write it out."""
        out = []
        for i, f in enumerate(feats, 1):
            progress(i, len(feats), level)
            rings = []
            geom = f["geometry"]
            polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
            for poly in polys:
                if not poly:
                    continue
                r = clean_ring(poly[0], metres)
                if r:
                    rings.append([[a, b] for a, b in r])
            rings = prune(rings)
            if not rings:
                continue
            out.append({"type": "Feature", "properties": f["properties"],
                        "geometry": {"type": "MultiPolygon",
                                     "coordinates": [[[[q[1], q[0]] for q in r]] for r in rings]}})
        write(OUT / out_name, out)
        return out

    # --- kommun outlines, dissolved out of RegSO then clipped
    def build_kommun():
        print("dissolving kommun outlines…")
        by_kommun: dict = collections.defaultdict(list)
        for f in regso:
            by_kommun[f["properties"]["kommunkod"]].append(f)
        feats = []
        for n_i, kod in enumerate(sorted(by_kommun), 1):
            progress(n_i, len(by_kommun), "kommun clip")
            rings = dissolve(by_kommun[kod])
            # Dissolve first, clip second: cancelling shared edges needs the exact
            # vertices of the source, which clipping would move.
            geom = {"type": "MultiPolygon",
                    "coordinates": [[[[p[1], p[0]] for p in r]] for r in rings]}
            if _LAND["tree"] is not None and rings:
                clipped = clip_to_land(geom)
                if clipped:
                    geom = clipped
            feats.append({"type": "Feature", "geometry": geom,
                          "properties": {"code": kod, "name": names.get(kod, kod),
                                         "lan": by_kommun[kod][0]["properties"]["lanskod"]}})
        return feats

    def build_level(raw_feats, props):
        feats = []
        for i, f in enumerate(raw_feats, 1):
            progress(i, len(raw_feats), "clip")
            geom = f["geometry"]
            if _LAND["tree"] is not None:
                geom = clip_to_land(geom)
                if geom is None:
                    continue
            feats.append({"type": "Feature", "geometry": geom, "properties": props(f["properties"])})
        return feats

    kom = cached("kommun", build_kommun)
    emit("kommun", kom, args.kommun_metres, "kommuner.geojson")

    print("clipping RegSO…")
    rs = cached("regso", lambda: build_level(regso, lambda pr: {
        "code": pr["regsokod"] + REGSO_SUFFIX, "plain": pr["regsokod"],
        "name": pr["regsonamn"], "kommun": pr["kommunkod"], "lan": pr["lanskod"]}))
    emit("regso", rs, args.metres, "regso.geojson")
    del regso, rs

    print("clipping DeSO…")
    deso_raw_feats = None
    if not (use_cache and cache_path("deso").exists()):
        deso_raw_feats = json.loads(deso_raw.read_text(encoding="utf-8"))["features"]
    ds = cached("deso", lambda: build_level(deso_raw_feats, lambda pr: {
        "code": pr["desokod"] + DESO_SUFFIX, "plain": pr["desokod"],
        "regso": pr["regsokod"] + REGSO_SUFFIX,
        "kommun": pr["kommunkod"], "lan": pr["lanskod"]}))
    emit("deso", ds, args.deso_metres, "deso.geojson")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
