#!/usr/bin/env python3
"""Climate-risk area shares per kommun, RegSO and DeSO.

EVERYTHING HAPPENS IN SWEREF99 TM METRES. Every figure here is a share of an
area's land, and an area computed from degrees is wrong by the cosine of the
latitude — Sweden spans 14 degrees of it, so a share for Kiruna and one for
Malmö would not be comparable. Our boundaries are moved INTO the grid; the
source layers are already there.

"NOT MAPPED" IS NOT ZERO. MCF has mapped about 80 watercourses, not every
stream in the country, and SGU's landslide survey covers part of the territory.
An area the survey never looked at gets no value at all, and the page says "Not
mapped"; an area that was surveyed and found clear gets 0 %. Conflating the two
would turn an absence of evidence into evidence of absence.

  * river flood — coverage is tested at KOMMUN level, because the coverage
    source is a line layer and buffering it by some invented distance to make an
    area would be exactly the kind of made-up number this dashboard refuses.
    A kommun with no mapped watercourse: not mapped. A mapped kommun with no
    overlap: 0 %.
  * coastal flood and mean sea level — coverage is the coastal län; an inland
    kommun is not "0 % at risk from the sea", it is not on the coast.

    python3 scripts/build_climate.py
"""
from __future__ import annotations

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from se_common import GEO, PROC, ROOT                                    # noqa: E402
from shapefile import from_zip, split_rings                                           # noqa: E402
from sweref import to_grid                                               # noqa: E402

RAW = ROOT / "data" / "raw" / "climate"
LEVELS = ("kommun", "regso", "deso")
GEOF = {"kommun": "kommuner.geojson", "regso": "regso.geojson", "deso": "deso.geojson"}

# key -> (label shown, source note)
LAYERS = {
    "flood100":  "River flood, 100-year",
    "flood200":  "River flood, 200-year",
    "floodBHF":  "River flood, highest calculated",
    "coast20":   "Coastal water level +2.0 m (RH2000)",
    "coast30":   "Coastal water level +3.0 m (RH2000)",
    "sea2100_85": "Mean sea level 2100 (RCP8.5, SMHI)",
    "sea2100_45": "Mean sea level 2100 (RCP4.5, SMHI)",
    "landslide": "Landslide caution zone (SGU)",
}
SMHI_AREAS = ["Blekinge", "Gavleborg", "Gotland", "Halland", "Kalmar", "Norrbotten",
              "Ostergotland", "Skane", "Sodermanland", "Stockholm", "Uppsala",
              "Vasterbotten", "Vasternorrland", "Vastra_Gotaland"]


# Which layers get a drawable overlay. If the whole set will not fit a sane
# download budget the build drops back to these three, which are the ones a
# reader is most likely to want to see outlined; the rest stay in the
# choropleth, and the build log says so.
# Landslide is deliberately NOT here. Its zones cannot fit either budget — 76 MB
# alone and a largest file of 4.47 MB against a 3 MB cap — because 242 000 tiny
# caution polygons have nothing to merge and so do not simplify however far the
# tolerance is raised. Generating them and then deleting them cost 40 minutes of
# a build; not generating them costs nothing. The layer is fully available as a
# number at all three levels, which is where it was always going to be read.
ZONE_LAYERS = ["flood100", "flood200", "floodBHF", "coast20", "coast30",
               "sea2100_85"]
# Everything except landslide. Landslide is the only layer that breaks either
# budget: 76 MB on its own, and a largest per-kommun file of 4.47 MB against a
# 3 MB cap, because 242 000 tiny caution polygons have nothing to merge and so
# do not simplify. The other six come to about 97 MB with no file over 1.2 MB.
ZONE_FALLBACK = ["flood100", "flood200", "floodBHF", "coast20", "coast30", "sea2100_85"]
ZONE_BUDGET = 150 * 1024 * 1024


def shp_polygons(zbytes, shape):
    """(shells, holes, record extents) from a zipped shapefile.

    A flood extent is 31 819 outer rings and 721 551 inner ones — dry islands
    inside floodplains. Attaching each hole to its containing shell would be
    721 551 containment tests against 31 819 candidates, so instead the two
    lists are kept apart and the share is computed as

        (area inside shells − area inside holes) / area

    which is exact, because a hole lies strictly inside a shell by definition,
    and needs no containment test at all.
    """
    shells, holes, extents = [], [], []
    for rings, _attrs in from_zip(zbytes):
        sh, ho = split_rings(rings)
        xs = [c[0] for r in sh for c in r]
        ys = [c[1] for r in sh for c in r]
        if xs:
            # one record is one watercourse mapping; its extent is what says
            # whether a kommun is covered by THIS product
            extents.append((min(xs), min(ys), max(xs), max(ys)))
        for dest, src in ((shells, sh), (holes, ho)):
            for r in src:
                try:
                    g = shape({"type": "Polygon", "coordinates": [list(r)]})
                    if not g.is_valid:
                        g = g.buffer(0)
                    if not g.is_empty and g.area > 0:
                        dest.append(g)
                except Exception:                                        # noqa: BLE001
                    continue
    return shells, holes, extents


def main() -> int:
    try:
        from shapely.geometry import shape
        from shapely.ops import unary_union, transform as sh_transform
        from shapely.strtree import STRtree
        from shapely.prepared import prep
    except ImportError:
        print("shapely is needed — see requirements-geo.txt", file=sys.stderr)
        return 1

    # ---- our boundaries, in the grid ----
    areas: dict = {}
    for lvl in LEVELS:
        data = json.loads((GEO / GEOF[lvl]).read_text(encoding="utf-8"))
        lst = []
        for f in data["features"]:
            g = sh_transform(lambda x, y, z=None: to_grid(x, y), shape(f["geometry"]))
            if not g.is_valid:
                g = g.buffer(0)
            if g.area <= 0:
                continue
            lst.append((f["properties"], g))
        areas[lvl] = lst
        print(f"{lvl}: {len(lst):,} areas in the grid", flush=True)

    out: dict = {lvl: {} for lvl in LEVELS}
    layer_cache: dict = {}          # key -> [shapely polygons], for the zone files
    layer_covered: dict = {}        # key -> {kommun codes this layer actually maps}

    from sweref import to_wgs84

    def to_wgs84_geojson(geom):
        """Back to [lon, lat] for the map, rounded to ~1 m."""
        try:
            g = sh_transform(lambda x, y, z=None: to_wgs84(x, y), geom)
        except Exception:                                                # noqa: BLE001
            return None
        def rnd(o):
            if isinstance(o, (list, tuple)):
                if o and isinstance(o[0], (int, float)):
                    return [round(o[0], 5), round(o[1], 5)]
                return [rnd(x) for x in o]
            return o
        from shapely.geometry import mapping as _map
        m = _map(g)
        return {"type": m["type"], "coordinates": rnd(m["coordinates"])}

    def put(lvl, code, key, val):
        out[lvl].setdefault(code, {})[key] = val

    def share_against(geoms, key, only_kommun=None, holes=None, skip_zero=False):
        """Intersect one layer with every area and record the share.

        `holes` are subtracted: the flood layers carry their dry islands as
        separate inner rings, and counting them as flooded would overstate every
        floodplain kommun.
        """
        if not geoms:
            return
        tree = STRtree(geoms)
        htree = STRtree(holes) if holes else None
        for lvl in LEVELS:
            n = 0
            for props, g in areas[lvl]:
                if only_kommun is not None:
                    k = props.get("kommun") or props.get("code")
                    if k not in only_kommun:
                        continue
                inter = 0.0
                for i in tree.query(g):
                    gi = geoms[i]
                    if g.intersects(gi):
                        inter += g.intersection(gi).area
                if htree is not None and inter > 0:
                    for i in htree.query(g):
                        hg = holes[i]
                        if g.intersects(hg):
                            inter -= g.intersection(hg).area
                inter = max(0.0, inter)
                if skip_zero and inter <= 0:
                    # Not mapped, rather than mapped and dry. MCF maps a
                    # watercourse BY producing its flood extent, so for a layer
                    # that reaches an area at all the share is > 0; an area no
                    # polygon of this layer reaches was not covered by this
                    # product. The 100-year, 200-year and BHF products cover 76,
                    # 71 and 78 watercourses and not the same ones, which is how
                    # Östersund ended up reading 0.0 % for the 200-year flood
                    # while showing 7.4 % for the 100-year one. A blank says
                    # "nobody looked"; a 0 would have said "nothing to worry
                    # about", and only one of those is true.
                    continue
                put(lvl, props["code"], key, round(min(inter, g.area) / g.area * 100, 4))
                n += 1
            print(f"    {key} · {lvl}: {n:,} areas scored", flush=True)

    # ---- river flood ----
    cov_path = RAW / "flood_coverage.geojson"
    mapped_kommuner: set = set()
    if cov_path.exists():
        lines = [shape(f["geometry"]) for f in
                 json.loads(cov_path.read_text(encoding="utf-8"))["features"]]
        ltree = STRtree(lines)
        for props, g in areas["kommun"]:
            for i in ltree.query(g):
                if g.intersects(lines[i]):
                    mapped_kommuner.add(props["code"])
                    break
        print(f"flood coverage: {len(mapped_kommuner)} of 290 kommuner have a "
              f"mapped watercourse")

    for key in ("flood100", "flood200", "floodBHF"):
        zp = RAW / f"{key}.zip"
        if not zp.exists():
            print(f"  {key}: not fetched — skipped")
            continue
        polys, holes, extents = shp_polygons(zp.read_bytes(), shape)
        # COVERAGE IS PER LAYER, not per product family. The 100-year mapping
        # covers 76 watercourses, the 200-year one 71: Östersund is in the first
        # and not the second, so its 200-year figure came out as 0.0 % — which
        # reads as "no risk" when it means "not in this product". A kommun is
        # scored for a layer only if one of THAT layer's record extents reaches
        # it; otherwise it stays blank and the page says Not mapped.
        print(f"  {key}: {len(polys):,} shells, {len(holes):,} holes · "
              f"{len(extents)} mapped watercourses", flush=True)
        layer_cache[key] = polys
        share_against(polys, key, holes=holes, skip_zero=True)
        layer_covered[key] = sorted(c for c, r in out["kommun"].items()
                                    if r.get(key) is not None)

    # ---- coastal flood ----
    for key in ("coast20", "coast30"):
        p = RAW / f"{key}.geojson"
        if not p.exists():
            continue
        feats = json.loads(p.read_text(encoding="utf-8"))["features"]
        polys = []
        for f in feats:
            g = shape(f["geometry"])
            if not g.is_valid:
                g = g.buffer(0)
            if g.area > 0:
                polys.append(g)
        # the coastal layer is already a clean GeoJSON MultiPolygon per län —
        # its holes travel inside the geometry, so there is nothing to subtract
        print(f"  {key}: {len(polys):,} polygons", flush=True)
        layer_cache[key] = polys
        share_against(polys, key)

    # ---- projected mean sea level ----
    for key in ("sea2100_85", "sea2100_45"):
        polys, sea_holes = [], []
        for a in SMHI_AREAS:
            zp = RAW / f"{key}_{a}.zip"
            if not zp.exists():
                continue
            sh, ho, _ext = shp_polygons(zp.read_bytes(), shape)
            polys += sh
            sea_holes += ho
        print(f"  {key}: {len(polys):,} shells, {len(sea_holes):,} holes", flush=True)
        layer_cache[key] = polys
        share_against(polys, key, holes=sea_holes)

    # ---- landslide ----
    # Read from the DEDUPLICATED files, not the per-kommun fetch: neighbouring
    # bounding boxes overlap, so the raw fetch holds 265 000 duplicate copies of
    # features near a border. Deduplicating first turned 2.6 GB into 1.1 GB and
    # is why this step is minutes rather than the hour the first run spent
    # re-parsing the same polygons.
    sgu_dir = ROOT / "data" / "interim" / "climate" / "sgu_dedup"
    cover_path = RAW / "sgu_tackning.geojson"
    sgu_cov = []
    if cover_path.exists():
        for f in json.loads(cover_path.read_text(encoding="utf-8"))["features"]:
            g = shape(f["geometry"])
            if not g.is_valid:
                g = g.buffer(0)
            if g.area > 0:
                sgu_cov.append(g)
    cov_tree = STRtree(sgu_cov) if sgu_cov else None
    print(f"  SGU coverage: {len(sgu_cov):,} polygons")

    by_kommun: dict = {lvl: {} for lvl in LEVELS}
    for lvl in LEVELS:
        for props, g in areas[lvl]:
            k = props.get("kommun") or props.get("code")
            by_kommun[lvl].setdefault(k, []).append((props, g))

    if sgu_dir.exists():
        slide = []
        for coll in ("aktsam-efterarbetad", "aktsam-strandnara"):
            fp = sgu_dir / f"{coll}.geojson"
            if not fp.exists():
                print(f"    {coll}: not deduplicated — run scripts/dedup_sgu.py",
                      file=sys.stderr)
                continue
            n_bad = 0
            for f in json.loads(fp.read_text(encoding="utf-8"))["features"]:
                try:
                    g = shape(f["geometry"])
                    if not g.is_valid:
                        g = g.buffer(0)
                    if g.area > 0:
                        slide.append(g)
                except Exception:                                        # noqa: BLE001
                    n_bad += 1
            print(f"    {coll}: {len(slide):,} polygons so far"
                  + (f" ({n_bad} unreadable)" if n_bad else ""), flush=True)
        stree = STRtree(slide) if slide else None
        print(f"  landslide: {len(slide):,} polygons in one national index", flush=True)
        layer_cache["landslide"] = slide

        kom_codes = sorted(by_kommun["kommun"])
        for n, kcode in enumerate(kom_codes, 1):
            for lvl in LEVELS:
                for props, g in by_kommun[lvl].get(kcode, []):
                    # Surveyed at all? SGU's coverage layer is what separates
                    # "looked at and clear" from "never looked at".
                    surveyed = False
                    if cov_tree is not None:
                        for i in cov_tree.query(g):
                            if g.intersects(sgu_cov[i]):
                                surveyed = True
                                break
                    if not surveyed:
                        continue                      # not mapped: no value at all
                    inter = 0.0
                    if stree is not None:
                        for i in stree.query(g):
                            if g.intersects(slide[i]):
                                inter += g.intersection(slide[i]).area
                    put(lvl, props["code"], "landslide",
                        round(min(inter, g.area) / g.area * 100, 4))
            print(f"    landslide {n}/{len(kom_codes)} {kcode}", flush=True)

    # ---- the cloudburst flag ----
    sky = {}
    sp = RAW / "skyfall_kommuner.geojson"
    if sp.exists():
        for f in json.loads(sp.read_text(encoding="utf-8"))["features"]:
            pr = f.get("properties") or {}
            code = str(pr.get("KOM_KOD") or "").zfill(4)
            if code and code != "0000":
                sky[code] = 1 if pr.get("Status") == 1 else 0
        for code, v in sky.items():
            put("kommun", code, "cloudburst_mapped", v)
        print(f"  cloudburst: {sum(sky.values())} of {len(sky)} kommuner have their own mapping")

    # ---- zone files for the overlay ----
    # Per kommun, per layer, simplified IN METRES. The national layers are
    # 83-98 MB apiece, far past what a page can ship, so the overlay is
    # lazy-loaded for the viewport and the national view shows nothing but the
    # choropleth. Tolerance starts at 10 m and is raised per layer until every
    # file fits the 3 MB budget; slivers below a hectare are dropped, because at
    # a zoom where the overlay is visible they are a pixel of noise.
    ZONE_DIR = PROC / "climate"
    if ZONE_DIR.exists():
        import shutil as _sh
        _sh.rmtree(ZONE_DIR)
    zone_index: dict = {}
    zone_total = 0

    def write_zones(key, polys):
        nonlocal zone_total
        if not polys:
            return
        tree = STRtree(polys)
        d = ZONE_DIR / key
        d.mkdir(parents=True, exist_ok=True)
        tol = 10.0
        while True:
            biggest = 0
            written = {}
            for props, g in areas["kommun"]:
                parts = []
                for i in tree.query(g):
                    gi = polys[i]
                    if not g.intersects(gi):
                        continue
                    clipped = g.intersection(gi)
                    if clipped.is_empty or clipped.area < 10_000:
                        continue
                    sm = clipped.simplify(tol, preserve_topology=True)
                    if sm.is_empty or sm.area <= 0:
                        continue
                    parts.append(sm)
                if not parts:
                    continue
                u = unary_union(parts)
                gj = to_wgs84_geojson(u)
                if gj is None:
                    continue
                blob = json.dumps(gj, separators=(",", ":"))
                written[props["code"]] = blob
                biggest = max(biggest, len(blob))
            if biggest <= 3_000_000 or tol >= 160:
                for code, blob in written.items():
                    (d / f"{code}.json").write_text(blob, encoding="utf-8")
                    zone_total += len(blob)
                zone_index[key] = {"kommuner": sorted(written), "tolerance_m": tol}
                print(f"  zones {key}: {len(written)} kommuner · tol {tol:.0f} m · "
                      f"largest {biggest / 1e6:.2f} MB", flush=True)
                return
            tol *= 2
            print(f"    zones {key}: largest {biggest / 1e6:.2f} MB at {tol / 2:.0f} m — "
                  f"retrying at {tol:.0f} m", flush=True)

    for key in ZONE_LAYERS:
        polys = layer_cache.get(key)
        if polys:
            write_zones(key, polys)

    # The budget. Zones are an extra download on top of a 16 MB page, so if the
    # whole set is too heavy the overlay falls back to the three layers a reader
    # is most likely to want outlined and the rest stay in the choropleth, where
    # they are still fully available as numbers.
    #
    # As built: landslide alone is 76 MB and its largest file is 4.25 MB, past
    # the 3 MB per-file cap, because 242 000 tiny caution polygons do not
    # simplify — there is nothing to merge. Dropping only landslide would leave
    # six layers at 97 MB, which also fits; the three-layer fallback is the
    # narrower, agreed rule and is what runs.
    if zone_total > ZONE_BUDGET or any(
            (ZONE_DIR / k).exists() and max((f.stat().st_size for f in (ZONE_DIR / k).glob("*.json")),
                                            default=0) > 3_000_000
            for k in list(zone_index)):
        import shutil as _sh2
        dropped = [k for k in list(zone_index) if k not in ZONE_FALLBACK]
        for k in dropped:
            _sh2.rmtree(ZONE_DIR / k, ignore_errors=True)
            zone_index.pop(k, None)
        zone_total = sum(f.stat().st_size for f in ZONE_DIR.glob("*/*.json"))
        print(f"  zones: over budget — dropped {', '.join(dropped)}; "
              f"{', '.join(sorted(zone_index))} kept at {zone_total / 1e6:.0f} MB. "
              f"The dropped layers remain in the choropleth.", flush=True)

    meta = {
        "layers": LAYERS,
        "zones": zone_index,
        "zones_bytes": zone_total,
        "zones_note": "Only some layers ship drawable zones; the rest are in the "
                      "choropleth only. A layer with no zone file is still fully "
                      "available as a number for every area.",
        "flood_mapped_kommuner": sorted(mapped_kommuner),
        "layer_coverage": {k: sorted(v) for k, v in layer_covered.items()},
        "note": "Screening indicators for comparing areas, not a property-level "
                "risk assessment.",
        "coverage": {
            "flood": "MCF has mapped about 80 watercourses, and the 100-year, "
                     "200-year and BHF products do not cover the same ones — 76, "
                     "71 and 78 respectively. Coverage is therefore tested per "
                     "layer: a kommun no record of THAT layer reaches is Not "
                     "mapped for it, and a covered kommun with no overlap is 0 %.",
            "landslide": "SGU's survey covers part of the territory. An area "
                         "outside the surveyed extent is Not mapped.",
        },
        "sources": ["MCF (ex-MSB), översvämningskarteringar och kustöversvämning",
                    "SMHI, framtida medelvattenstånd (IPCC AR6/SROCC)",
                    "SGU, förutsättningar för skred i finkornig jordart (CC0)"],
    }
    (PROC / "climate.json").write_text(
        json.dumps({"meta": meta, "areas": out}, ensure_ascii=False,
                   separators=(",", ":")), encoding="utf-8")
    sz = (PROC / "climate.json").stat().st_size
    print(f"\nwrote {(PROC / 'climate.json').relative_to(ROOT)} ({sz / 1024 / 1024:.1f} MB)")
    for lvl in LEVELS:
        print(f"  {lvl}: {len(out[lvl]):,} areas with at least one value")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
