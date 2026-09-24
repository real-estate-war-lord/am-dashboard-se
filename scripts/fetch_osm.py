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
import threading
import time
import urllib.parse

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from http_util import get                                                # noqa: E402
from se_common import GEO, ROOT                                          # noqa: E402

RAW = ROOT / "data" / "raw" / "osm"
# overpass-api.de answers these queries in about 2.5 s each. The kumi mirror
# was in this list and timed out on most of them, and because a failure moved to
# the next endpoint it dragged every kommun to 89 s. It stays out until it is
# needed: one endpoint, retried, is faster than two when one of them is down.
ENDPOINTS = ["https://overpass-api.de/api/interpreter"]
PAUSE = 6.0                       # seconds between kommuner — Overpass is donated

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


# Tags that are genuinely mapped as areas as well as points — a school or a
# hospital is usually a building polygon. Everything else (a bus stop, a café)
# is a node, and asking Overpass for ways with those tags is cost with no return.
AREA_TAGS = {'["amenity"="school"]', '["amenity"="kindergarten"]',
             '["amenity"="hospital"]', '["amenity"="clinic"]',
             '["amenity"="library"]', '["amenity"="theatre"]',
             '["tourism"="museum"]', '["leisure"="sports_centre"]',
             '["leisure"="sports_hall"]', '["shop"="supermarket"]'}


def queries_for(s, w, n, e) -> list[str]:
    """TWO queries per kommun, not one.

    Overpass limits a query's complexity, not just its area: the node
    statements alone answer in 2.5 s and the way statements alone in 2.4 s, but
    both together return 504 Gateway Timeout every time. The first version of
    this fetcher sent them together, got a 504 for every kommun, and spent 75
    seconds per kommun retrying across both endpoints — six hours for the
    country. Split, it is about eight seconds each.
    """
    bb = f"({s:.4f},{w:.4f},{n:.4f},{e:.4f})"
    nodes, ways = [], []
    for _cat, filters in FILTERS.items():
        for f in filters:
            nodes.append(f"node{f}{bb};")
            if f in AREA_TAGS:
                ways.append(f"way{f}{bb};")
    out = ["[out:json][timeout:120];(" + "".join(nodes) + ");out center tags;"]
    if ways:
        out.append("[out:json][timeout:120];(" + "".join(ways) + ");out center tags;")
    return out


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
    # Overpass publishes a rate limit of 4 concurrent slots per client; using 3
    # is inside it and is how the service is meant to be used. One at a time
    # took about a minute per kommun, which is five hours for the country.
    # ONE worker by default. Three was inside Overpass's published 4-slot limit
    # but it still started refusing every request after a few dozen kommuner —
    # a donated public service sheds load however it likes, and the right answer
    # is to ask more slowly rather than to argue with it. The fetch is resumable,
    # so a partial run costs nothing but time.
    ap.add_argument("--workers", type=int, default=1)
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
    lock = threading.Lock()
    done = [0]

    def work(item):
        nonlocal total
        i_unused, (code, name, s, w, n, e) = item
        els = []
        failed = False
        for q in queries_for(s, w, n, e):
            body = None
            for _attempt in range(6):
                url = ENDPOINTS[_attempt % len(ENDPOINTS)]
                try:
                    st, resp, _ = get(url, data=urllib.parse.urlencode({"data": q}).encode(),
                                      headers={"Content-Type": "application/x-www-form-urlencoded"},
                                      timeout=200, tries=1)
                except Exception:                                        # noqa: BLE001
                    # a read timeout is a normal answer from a busy public
                    # instance, not a reason to end the run — move to the other
                    # endpoint and try again
                    st, resp = 0, b""
                if st == 200 and resp[:1] == b"{":
                    body = resp
                    break
                # Overpass sheds load by refusing; back off rather than hammer
                time.sleep(PAUSE * (2 ** min(_attempt, 4)))
            if body is None:
                failed = True
                break
            els += json.loads(body).get("elements") or []
            time.sleep(0.5)
        if failed:
            print(f"  {code} {name}: Overpass refused — skipped", file=sys.stderr)
            return
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
        with lock:
            total += len(pts)
            done[0] += 1
            if done[0] % 10 == 0 or done[0] == len(todo):
                print(f"  {done[0]}/{len(todo)} · {total:,} points", flush=True)
        time.sleep(PAUSE)

    items = list(enumerate(todo, 1))
    threads = []
    idx = [0]

    def runner():
        while True:
            with lock:
                if idx[0] >= len(items):
                    return
                item = items[idx[0]]
                idx[0] += 1
            try:
                work(item)
            except Exception as exc:                                     # noqa: BLE001
                print(f"  {item[1][0]}: {type(exc).__name__}: {exc}", file=sys.stderr)

    for _ in range(max(1, a.workers)):
        t = threading.Thread(target=runner, daemon=True)
        t.start()
        threads.append(t)
    for t in threads:
        t.join()

    print(f"\n{total:,} points written under {RAW.relative_to(ROOT)} "
          f"— © OpenStreetMap contributors (ODbL)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
