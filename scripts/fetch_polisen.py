#!/usr/bin/env python3
"""Police-designated vulnerable areas -> area shares per RegSO, DeSO and kommun.

Polisen publishes the designated areas as geometry, not only as a PDF list:
`uso_2025_geojson.zip`, 65 polygons in EPSG:3006, current from 2025-12-01.

TWO CLASSES, NOT THREE. `KATEGORI` is `Utsatt område` (46) and
`Särskilt utsatt område` (19). The middle tier `riskområde` no longer exists.

The polygons carry no kommun code — only `ORT`, a place name — so attaching
them to our geography is a real spatial operation, not an attribute rollup.
Everything is done in SWEREF99 TM metres: our boundaries are reprojected INTO
the grid rather than the police polygons out of it, because an area share
computed from degrees would be wrong by the cosine of the latitude, and Sweden
spans 14 degrees of it.

Needs shapely (see requirements-geo.txt). `make build` does not: the output CSV
and the reprojected overlay are committed.

    python3 scripts/fetch_polisen.py
"""
from __future__ import annotations

import csv
import io
import json
import pathlib
import sys
import urllib.request
import zipfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from http_util import UA, get                                            # noqa: E402
from se_common import GEO, ROOT                                          # noqa: E402
from sweref import to_wgs84, to_grid                                     # noqa: E402

URL = ("https://polisen.se/33a4eb398c9ca7879ac47049931a252f/contentassets/"
       "1f86e17354294629b5b66559eef35972/uso_2025_geojson.zip")
RAW = ROOT / "data" / "raw" / "polisen"
EXT = ROOT / "data" / "external"

CLASSES = {"Utsatt område": "utsatt", "Särskilt utsatt område": "sarskilt"}

# Where two boundaries merely graze each other the intersection is a sliver of a
# few square metres — a digitising artefact, not an overlap. Flagging a DeSO as
# police-designated because of one is worse than saying nothing, so an
# intersection below one hectare is not a designation. Stated rather than tuned:
# the smallest designated area in the file is many hectares across.
MIN_OVERLAP_M2 = 10_000.0


def download() -> dict:
    RAW.mkdir(parents=True, exist_ok=True)
    zpath = RAW / "uso_2025_geojson.zip"
    if not zpath.exists():
        status, body, _ = get(URL)
        if status != 200:
            raise SystemExit(f"polisen: HTTP {status}")
        zpath.write_bytes(body)
        print(f"downloaded {len(body):,} bytes")
    else:
        print(f"cached {zpath.stat().st_size:,} bytes")
    with zipfile.ZipFile(zpath) as z:
        name = next(n for n in z.namelist() if n.endswith(".geojson"))
        return json.loads(z.read(name))


def main() -> int:
    try:
        from shapely.geometry import shape, mapping
        from shapely.ops import unary_union, transform as sh_transform
        from shapely.strtree import STRtree
    except ImportError:
        print("shapely is needed for this step — see requirements-geo.txt\n"
              "  python3 -m venv .venv && .venv/bin/pip install -r requirements-geo.txt",
              file=sys.stderr)
        return 1

    gj = download()
    feats = gj["features"]
    counts: dict[str, int] = {}
    for f in feats:
        k = f["properties"].get("KATEGORI", "?")
        counts[k] = counts.get(k, 0) + 1
    print(f"{len(feats)} areas: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())))
    unknown = set(counts) - set(CLASSES)
    if unknown:
        print(f"ERROR: unrecognised KATEGORI {sorted(unknown)} — the classes changed, "
              "do not guess", file=sys.stderr)
        return 1

    # the police polygons are already in the grid; keep them there
    by_class: dict[str, list] = {v: [] for v in CLASSES.values()}
    for f in feats:
        g = shape(f["geometry"])
        if not g.is_valid:
            g = g.buffer(0)
        by_class[CLASSES[f["properties"]["KATEGORI"]]].append(g)
    merged = {k: unary_union(v) for k, v in by_class.items() if v}
    any_uso = unary_union(list(merged.values()))
    print("  merged area: " + ", ".join(
        f"{k} {m.area / 1e6:.1f} km²" for k, m in merged.items()))

    rows = []
    for level in ("kommun", "regso", "deso"):
        path = GEO / f"{level if level != 'kommun' else 'kommuner'}.geojson"
        data = json.loads(path.read_text(encoding="utf-8"))
        n_hit = 0
        # our boundaries are WGS84; move them INTO the grid so the areas are metres
        grid = []
        for f in data["features"]:
            g = sh_transform(lambda x, y, z=None: to_grid(x, y), shape(f["geometry"]))
            if not g.is_valid:
                g = g.buffer(0)
            grid.append((f["properties"], g))

        tree = STRtree([g for _, g in grid])
        for props, g in grid:
            if g.area <= 0:
                continue
            idx = tree.query(g)
            if len(idx) == 0:
                pass
            shares = {}
            for cls, m in merged.items():
                if not g.intersects(m):
                    continue
                inter = g.intersection(m)
                if inter.is_empty or inter.area < MIN_OVERLAP_M2:
                    continue
                shares[cls] = inter.area / g.area
            if not shares:
                continue
            n_hit += 1
            total_a = g.intersection(any_uso).area
            if total_a < MIN_OVERLAP_M2:
                continue
            total = total_a / g.area
            # the class to name is the more serious one present
            cls = "sarskilt" if shares.get("sarskilt", 0) > 0 else "utsatt"
            rows.append([props["code"], level, cls,
                         round(total * 100, 3),
                         round(shares.get("utsatt", 0) * 100, 3),
                         round(shares.get("sarskilt", 0) * 100, 3)])
        print(f"  {level:7s} {n_hit} of {len(grid)} areas touch a designated area")

    EXT.mkdir(parents=True, exist_ok=True)
    out = EXT / "polisen_uso.csv"
    with out.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, delimiter=";")
        w.writerow(["code", "level", "class", "share_pct", "utsatt_pct", "sarskilt_pct"])
        w.writerows(sorted(rows, key=lambda r: (r[1], r[0])))
    print(f"wrote {out.relative_to(ROOT)} · {len(rows):,} rows")

    # the overlay, reprojected to WGS84 and thinned of the fields we do not use
    ov = {"type": "FeatureCollection",
          "meta": {"source": "Polismyndigheten, utsatta områden 2025",
                   "url": URL, "crs_source": "EPSG:3006", "areas": len(feats)},
          "features": []}
    for f in feats:
        g = sh_transform(lambda x, y, z=None: to_wgs84(x, y), shape(f["geometry"]))
        p = f["properties"]
        ov["features"].append({
            "type": "Feature",
            "properties": {"name": p.get("NAMN"), "class": CLASSES[p["KATEGORI"]],
                           "kategori": p.get("KATEGORI"), "ort": p.get("ORT"),
                           "region": p.get("REGION"), "since": p.get("AKTUALITET_START")},
            "geometry": mapping(g)})
    gpath = GEO / "polisen_uso.geojson"
    gpath.write_text(json.dumps(ov, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {gpath.relative_to(ROOT)} · {gpath.stat().st_size / 1024:.0f} kB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
