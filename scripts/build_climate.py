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
from shapefile import from_zip                                           # noqa: E402
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
        print(f"{lvl}: {len(lst):,} areas in the grid")

    out: dict = {lvl: {} for lvl in LEVELS}

    def put(lvl, code, key, val):
        out[lvl].setdefault(code, {})[key] = val

    def share_against(geoms, key, only_kommun=None):
        """Intersect one layer with every area and record the share."""
        if not geoms:
            return
        tree = STRtree(geoms)
        for lvl in LEVELS:
            n = 0
            for props, g in areas[lvl]:
                if only_kommun is not None:
                    k = props.get("kommun") or props.get("code")
                    if k not in only_kommun:
                        continue
                idx = tree.query(g)
                if len(idx) == 0:
                    put(lvl, props["code"], key, 0.0)
                    continue
                inter = 0.0
                for i in idx:
                    gi = geoms[i]
                    if g.intersects(gi):
                        inter += g.intersection(gi).area
                put(lvl, props["code"], key, round(min(inter, g.area) / g.area * 100, 4))
                n += 1
            print(f"    {key} · {lvl}: {n:,} areas scored")

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
        polys = []
        for rings, _a in from_zip(zp.read_bytes()):
            try:
                g = shape({"type": "Polygon", "coordinates": [list(r) for r in rings]})
                if not g.is_valid:
                    g = g.buffer(0)
                if g.area > 0:
                    polys.append(g)
            except Exception:                                            # noqa: BLE001
                continue
        print(f"  {key}: {len(polys):,} polygons")
        share_against(polys, key, only_kommun=mapped_kommuner or None)

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
        print(f"  {key}: {len(polys):,} polygons")
        share_against(polys, key)

    # ---- projected mean sea level ----
    for key in ("sea2100_85", "sea2100_45"):
        polys = []
        for a in SMHI_AREAS:
            zp = RAW / f"{key}_{a}.zip"
            if not zp.exists():
                continue
            for rings, _at in from_zip(zp.read_bytes()):
                try:
                    g = shape({"type": "Polygon", "coordinates": [list(r) for r in rings]})
                    if not g.is_valid:
                        g = g.buffer(0)
                    if g.area > 0:
                        polys.append(g)
                except Exception:                                        # noqa: BLE001
                    continue
        print(f"  {key}: {len(polys):,} polygons")
        share_against(polys, key)

    # ---- landslide, streamed per kommun ----
    sgu_dir = RAW / "sgu"
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
        kom_codes = sorted(by_kommun["kommun"])
        for n, kcode in enumerate(kom_codes, 1):
            polys = []
            for coll in ("aktsam-efterarbetad", "aktsam-strandnara"):
                fp = sgu_dir / f"{coll}_{kcode}.json"
                if not fp.exists():
                    continue
                for f in json.loads(fp.read_text(encoding="utf-8"))["features"]:
                    try:
                        g = shape(f["geometry"])
                        if not g.is_valid:
                            g = g.buffer(0)
                        if g.area > 0:
                            polys.append(g)
                    except Exception:                                    # noqa: BLE001
                        continue
            tree = STRtree(polys) if polys else None
            for lvl in LEVELS:
                for props, g in by_kommun[lvl].get(kcode, []):
                    # surveyed at all?
                    surveyed = False
                    if cov_tree is not None:
                        for i in cov_tree.query(g):
                            if g.intersects(sgu_cov[i]):
                                surveyed = True
                                break
                    if not surveyed:
                        continue                      # not mapped: no value at all
                    inter = 0.0
                    if tree is not None:
                        for i in tree.query(g):
                            if g.intersects(polys[i]):
                                inter += g.intersection(polys[i]).area
                    put(lvl, props["code"], "landslide",
                        round(min(inter, g.area) / g.area * 100, 4))
            if n % 50 == 0:
                print(f"    landslide {n}/{len(kom_codes)} kommuner", flush=True)

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

    meta = {
        "layers": LAYERS,
        "flood_mapped_kommuner": sorted(mapped_kommuner),
        "note": "Screening indicators for comparing areas, not a property-level "
                "risk assessment.",
        "coverage": {
            "flood": "MCF has mapped about 80 watercourses. A kommun none of them "
                     "runs through is Not mapped; a mapped kommun with no overlap "
                     "is 0 %.",
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
