#!/usr/bin/env python3
"""Deduplicate the SGU caution zones fetched per kommun.

The fetch asks for each kommun's bounding box, and bounding boxes of
neighbouring kommuner overlap heavily — a feature near a border is returned by
every kommun whose box covers it. That is why ~150 000 distinct features
occupy 2.6 GB across 580 files, and why the first intersection run spent an
hour re-parsing the same polygons.

This pass reads each file once, keeps each `objectid` exactly once, and writes
one file per collection. `geom_area` comes from SGU and is kept so the result
can be sanity-checked against the source's own area.

    python3 -u scripts/dedup_sgu.py
"""
from __future__ import annotations

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from se_common import ROOT                                               # noqa: E402

SRC = ROOT / "data" / "raw" / "climate" / "sgu"
OUT = ROOT / "data" / "interim" / "climate" / "sgu_dedup"
COLLS = ("aktsam-efterarbetad", "aktsam-strandnara")


def main() -> int:
    if not SRC.exists():
        print("no data/raw/climate/sgu — run 'make climate' first", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    for coll in COLLS:
        files = sorted(SRC.glob(f"{coll}_*.json"))
        if not files:
            continue
        seen: set = set()
        feats = []
        dupes = 0
        for n, fp in enumerate(files, 1):
            try:
                data = json.loads(fp.read_text(encoding="utf-8"))
            except Exception as e:                                       # noqa: BLE001
                print(f"  {fp.name}: {type(e).__name__} — skipped", file=sys.stderr)
                continue
            for f in data.get("features") or []:
                oid = (f.get("properties") or {}).get("objectid")
                if oid is None:
                    oid = f.get("id")
                if oid in seen:
                    dupes += 1
                    continue
                seen.add(oid)
                # keep only what the intersection needs
                feats.append({"type": "Feature",
                              "properties": {"objectid": oid,
                                             "geom_area": (f.get("properties") or {}).get("geom_area")},
                              "geometry": f.get("geometry")})
            if n % 60 == 0:
                print(f"  {coll}: {n}/{len(files)} files · {len(feats):,} unique · "
                      f"{dupes:,} duplicates dropped", flush=True)
        p = OUT / f"{coll}.geojson"
        p.write_text(json.dumps({"type": "FeatureCollection", "features": feats},
                                separators=(",", ":")), encoding="utf-8")
        area = sum((f["properties"].get("geom_area") or 0) for f in feats)
        print(f"{coll}: {len(feats):,} unique features, {dupes:,} duplicates dropped · "
              f"{p.stat().st_size / 1e6:.0f} MB · SGU's own geom_area sum "
              f"{area / 1e6:,.0f} km²", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
