#!/usr/bin/env python3
"""Services, public buildings and rail alignments from the Geofabrik extract.

Replaces the Overpass crawl. Overpass is a donated public service and it
rate-limited this client after a few dozen kommuner; the country extract is
780 MB, downloaded once, and reading it needs nobody's goodwill.

**Dependency: pyosmium** (`pip install osmium`), which is the same libosmium
the `osmium` CLI wraps. The CLI would work equally well —
`osmium tags-filter … && osmium export …` — but pyosmium is already installed
here and does the whole job in one pass instead of writing an intermediate
GeoJSON of the whole country. Documented in the README under geo requirements.

Two passes over the file:
  1. nodes and ways carrying one of the POI tags -> points (a way's point is
     the centroid of its nodes);
  2. railway=construction|proposed ways of the right kind -> alignments for the
     infrastructure overlay.

Everything is written in WGS84 [lon, lat]; the per-kommun split happens in
build_services.py using our own point-in-polygon, not a bounding box.

    python3 -u scripts/extract_osm_pbf.py
"""
from __future__ import annotations

import collections
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from se_common import ROOT                                               # noqa: E402

PBF = ROOT / "data" / "raw" / "osm_pbf" / "sweden-latest.osm.pbf"
OUT = ROOT / "data" / "interim" / "osm"

# category -> {key: {values}}. The same vocabulary the Overpass fetcher used, so
# the overlay's categories do not change under the reader's feet.
POI = {
    "grocery":   {"shop": {"supermarket", "convenience"}},
    "food":      {"amenity": {"restaurant", "cafe"}},
    "pharmacy":  {"amenity": {"pharmacy"}},
    "transport": {"public_transport": {"station"},
                  "railway": {"station", "tram_stop"},
                  "highway": {"bus_stop"}},
    "education": {"amenity": {"school"}},
    "daycare":   {"amenity": {"kindergarten"}},
    "health":    {"amenity": {"hospital", "clinic", "doctors"}},
    "culture":   {"amenity": {"library", "theatre"}, "tourism": {"museum"}},
    "sports":    {"leisure": {"sports_centre", "sports_hall"}},
}
# railway lines that are being built or planned — the infrastructure alignments
RAIL_STATUS = {"construction", "proposed"}
RAIL_KINDS = {"rail", "subway", "light_rail", "tram", "monorail"}


def cat_of(tags) -> tuple[str, str] | None:
    for cat, keys in POI.items():
        for k, vals in keys.items():
            v = tags.get(k)
            if v in vals:
                return cat, f"{k}={v}"
    return None


def main() -> int:
    if not PBF.exists():
        print(f"missing {PBF.relative_to(ROOT)} — download the Geofabrik extract:\n"
              "  curl -L -o data/raw/osm_pbf/sweden-latest.osm.pbf \\\n"
              "    https://download.geofabrik.de/europe/sweden-latest.osm.pbf",
              file=sys.stderr)
        return 1
    try:
        import osmium
    except ImportError:
        print("pyosmium is needed: pip install osmium (see README, geo requirements)",
              file=sys.stderr)
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    counts: collections.Counter = collections.Counter()
    points: list = []
    lines: list = []

    print(f"reading {PBF.name} ({PBF.stat().st_size / 1e6:.0f} MB) — one pass, "
          "nodes then ways", flush=True)

    # locations_on_ways lets a way carry its nodes' coordinates without a second
    # index pass; it costs memory but the alternative is holding every node id
    fp = osmium.FileProcessor(str(PBF)).with_locations().with_filter(
        osmium.filter.EntityFilter(osmium.osm.NODE | osmium.osm.WAY))

    n_seen = 0
    for obj in fp:
        n_seen += 1
        if n_seen % 20_000_000 == 0:
            print(f"  {n_seen/1e6:.0f} M objects · {len(points):,} points · "
                  f"{len(lines):,} lines", flush=True)
        tags = obj.tags
        if not tags:
            continue

        if obj.is_node():
            hit = cat_of(tags)
            if hit:
                cat, tag = hit
                points.append([cat, round(obj.location.lat, 5),
                               round(obj.location.lon, 5),
                               (tags.get("name") or "")[:60], tag])
                counts[cat] += 1
            continue

        # ---- ways ----
        rw = tags.get("railway")
        if rw in RAIL_STATUS or (rw in RAIL_KINDS and
                                 tags.get("construction") in RAIL_KINDS):
            kind = (tags.get("construction:railway") or tags.get("construction")
                    or tags.get("proposed:railway") or tags.get("proposed") or rw)
            if kind in RAIL_KINDS or rw in RAIL_STATUS:
                try:
                    coords = [[round(n.lon, 5), round(n.lat, 5)] for n in obj.nodes
                              if n.location.valid()]
                except Exception:                                        # noqa: BLE001
                    coords = []
                if len(coords) >= 2:
                    lines.append({"kind": kind, "status": rw if rw in RAIL_STATUS else "construction",
                                  "name": (tags.get("name") or "")[:80],
                                  "coords": coords})
                    counts["_rail_lines"] += 1

        hit = cat_of(tags)
        if hit:
            try:
                lats = [n.lat for n in obj.nodes if n.location.valid()]
                lons = [n.lon for n in obj.nodes if n.location.valid()]
            except Exception:                                            # noqa: BLE001
                lats = lons = []
            if lats:
                cat, tag = hit
                points.append([cat, round(sum(lats) / len(lats), 5),
                               round(sum(lons) / len(lons), 5),
                               (tags.get("name") or "")[:60], tag])
                counts[cat] += 1

    (OUT / "points.json").write_text(
        json.dumps(points, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT / "rail_lines.json").write_text(
        json.dumps(lines, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print(f"\n{n_seen:,} objects read")
    for c in sorted(POI):
        print(f"  {c:10s} {counts[c]:8,}")
    print(f"  {'rail lines':10s} {counts['_rail_lines']:8,} "
          f"(railway=construction|proposed)")
    print(f"wrote {(OUT / 'points.json').stat().st_size / 1e6:.0f} MB of points and "
          f"{(OUT / 'rail_lines.json').stat().st_size / 1e6:.0f} MB of lines "
          f"→ {OUT.relative_to(ROOT)}")
    print("© OpenStreetMap contributors (ODbL)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
