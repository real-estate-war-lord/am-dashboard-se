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

RAW = ROOT / "data" / "raw" / "osm"
OUT = PROC / "services"

SERVICES = {"grocery", "food", "pharmacy", "transport"}
PUBLIC = {"education", "daycare", "health", "culture", "sports"}


def main() -> int:
    if not RAW.exists():
        print("no data/raw/osm — run scripts/fetch_osm.py", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    for p in OUT.glob("*.json"):
        p.unlink()

    index, counts = {}, collections.Counter()
    files = sorted(RAW.glob("*.json"))
    for fp in files:
        code = fp.stem
        try:
            pts = json.loads(fp.read_text(encoding="utf-8"))
        except Exception:                                                # noqa: BLE001
            continue
        rows, lats, lons = [], [], []
        for q in pts:
            c = q.get("c")
            if c not in SERVICES and c not in PUBLIC:
                continue
            # compact rows: [category, lat, lon, name, tag]
            rows.append([c, q["lat"], q["lon"], q.get("n") or "", q.get("t") or ""])
            lats.append(q["lat"]); lons.append(q["lon"])
            counts[c] += 1
        if not rows:
            continue
        (OUT / f"{code}.json").write_text(
            json.dumps(rows, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        index[code] = {"n": len(rows),
                       "bbox": [round(min(lats), 4), round(min(lons), 4),
                                round(max(lats), 4), round(max(lons), 4)]}

    meta = {"source": "OpenStreetMap contributors (ODbL)",
            "kommuner": len(index),
            "counts": dict(sorted(counts.items())),
            "note": "Points only. A count per inhabitant would measure mapping "
                    "effort as much as provision, so none is published.",
            "services": sorted(SERVICES), "public": sorted(PUBLIC)}
    (PROC / "services.json").write_text(
        json.dumps({"meta": meta, "index": index}, ensure_ascii=False,
                   separators=(",", ":")), encoding="utf-8")
    biggest = max((p.stat().st_size for p in OUT.glob("*.json")), default=0)
    print(f"{sum(counts.values()):,} points across {len(index)} kommuner "
          f"(of {len(files)} fetched)")
    for c, n in sorted(counts.items()):
        print(f"  {c:10s} {n:7,}")
    print(f"largest per-kommun file: {biggest / 1024:.0f} kB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
