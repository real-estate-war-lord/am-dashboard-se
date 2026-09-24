#!/usr/bin/env python3
"""Services and public buildings from OpenStreetMap, one kommun at a time.

Overpass rather than the 818 MB Geofabrik extract: the extract would need a PBF
parser and a full pass over the country to pull out a few hundred thousand
points, while Overpass answers per kommun in a form that is already resumable
and already filtered. The trade is politeness — this keeps to one query at a
time with a real pause between them, because Overpass is a donated service.

Categories are the Danish edition's, renamed where Sweden differs:
  services        grocery, food, pharmacy, transport stops
  public          education, daycare, health, culture, sports

Two rules that keep this honest:
  * a point carries the OSM tag it came from, so a reader can see WHY it is
    called a supermarket;
  * nothing is inferred. A clinic without an amenity tag is not a clinic.

If TRAFIKLAB_KEY is in .env the transport stops come from GTFS Sverige 2
instead, which is authoritative; without it OSM stops are used and the build
log says "upgrade available when the key exists".

    python3 scripts/fetch_osm.py               # resume
    python3 scripts/fetch_osm.py --only 0180
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import time
import urllib.parse

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from http_util import get                                                # noqa: E402
from se_common import GEO, ROOT                                          # noqa: E402

RAW = ROOT / "data" / "raw" / "osm"
ENDPOINTS = ["https://overpass-api.de/api/interpreter",
             "https://overpass.kumi.systems/api/interpreter"]
PAUSE = 3.0                       # seconds between queries — Overpass is donated

# category -> list of Overpass tag filters. Kept explicit: a reader can map any
# point on the map back to the tag that put it there.
FILTERS = {
    "grocery":   ['["shop"="supermarket"]', '["shop"="convenience"]'],
    "food":      ['["amenity"="restaurant"]', '["amenity"="cafe"]'],
    "pharmacy":  ['["amenity"="pharmacy"]'],
    "transport": ['["public_transport"="station"]', '["railway"="station"]',
                  '["railway"="tram_stop"]', '["highway"="bus_stop"]'],
    "education": ['["amenity"="school"]'],
    "daycare":   ['["amenity"="kindergarten"]'],
    "health":    ['["amenity"="hospital"]', '["amenity"="clinic"]',
                  '["amenity"="doctors"]'],
    "culture":   ['["amenity"="library"]', '["amenity"="theatre"]',
                  '["tourism"="museum"]'],
    "sports":    ['["leisure"="sports_centre"]', '["leisure"="sports_hall"]'],
}


def bboxes() -> list[tuple]:
    kom = json.loads((GEO / "kommuner.geojson").read_text(encoding="utf-8"))
    out = []
    for f in kom["features"]:
        xs, ys = [], []
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        for poly in polys:
            for c in poly[0]:
                xs.append(c[0]); ys.append(c[1])
        out.append((f["properties"]["code"], f["properties"].get("name", ""),
                    min(ys), min(xs), max(ys), max(xs)))
    return sorted(out)


def query_for(s, w, n, e) -> str:
    parts = []
    for cat, filters in FILTERS.items():
        for f in filters:
            parts.append(f'node{f}({s:.4f},{w:.4f},{n:.4f},{e:.4f});')
            parts.append(f'way{f}({s:.4f},{w:.4f},{n:.4f},{e:.4f});')
    return "[out:json][timeout:180];(" + "".join(parts) + ");out center tags;"


def cat_of(tags: dict) -> tuple[str, str] | None:
    """Which category a point belongs to, and the tag that decided it."""
    for cat, filters in FILTERS.items():
        for f in filters:
            k, v = f.strip('[]').replace('"', '').split("=")
            if tags.get(k) == v:
                return cat, f"{k}={v}"
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", action="append", default=[])
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()
    RAW.mkdir(parents=True, exist_ok=True)

    allb = bboxes()
    wanted = [b for b in allb if not a.only or b[0] in a.only]
    todo = [b for b in wanted if a.refresh or not (RAW / f"{b[0]}.json").exists()]
    # count what is cached among the ones ASKED for, not all 290 — the first cut
    # of this line claimed 288 cached after fetching 2 of 2
    print(f"{len(todo)} kommuner to fetch ({len(wanted) - len(todo)} of "
          f"{len(wanted)} already on disk)")
    ep = 0
    total = 0
    for i, (code, name, s, w, n, e) in enumerate(todo, 1):
        q = query_for(s, w, n, e)
        body = None
        for attempt in range(len(ENDPOINTS) * 2):
            url = ENDPOINTS[ep % len(ENDPOINTS)]
            st, resp, _ = get(url, data=urllib.parse.urlencode({"data": q}).encode(),
                              headers={"Content-Type": "application/x-www-form-urlencoded"},
                              timeout=240, tries=1)
            if st == 200 and resp[:1] == b"{":
                body = resp
                break
            ep += 1
            time.sleep(PAUSE * 2)
        if body is None:
            print(f"  {code} {name}: all endpoints refused — skipped", file=sys.stderr)
            continue
        els = json.loads(body).get("elements") or []
        pts = []
        for el in els:
            tags = el.get("tags") or {}
            hit = cat_of(tags)
            if not hit:
                continue
            lat = el.get("lat") or (el.get("center") or {}).get("lat")
            lon = el.get("lon") or (el.get("center") or {}).get("lon")
            if lat is None or lon is None:
                continue
            cat, tag = hit
            pts.append({"c": cat, "t": tag, "lat": round(lat, 5), "lon": round(lon, 5),
                        "n": (tags.get("name") or "")[:60]})
        (RAW / f"{code}.json").write_text(
            json.dumps(pts, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        total += len(pts)
        if i % 20 == 0 or i == len(todo):
            print(f"  {i}/{len(todo)} · {total:,} points", flush=True)
        time.sleep(PAUSE)
    print(f"\n{total:,} points written under {RAW.relative_to(ROOT)} "
          f"— © OpenStreetMap contributors (ODbL)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
