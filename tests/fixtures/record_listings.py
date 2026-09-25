#!/usr/bin/env python3
"""Record tests/fixtures/listings_stockholm.json from the live listings gateway.

    python3 tests/fixtures/record_listings.py                 # rewrite the fixture
    python3 tests/fixtures/record_listings.py --raw out.json   # keep the raw answer (git-ignored)

Why the fixture is sanitised
----------------------------
`docs/LISTINGS.md` says, in as many words, that **no third-party listing data is
committed to this repository**, and that promise is not worth breaking for a test
file. So this script records a real answer and then replaces everything that is
somebody else's content — the address, the landlord and area names, the listing
and image URLs, the description excerpt, the source's own id — with synthetic
stand-ins, while keeping every field the UI reads and every number the checks
depend on:

  * the source mix (which adapters answered, with what counts, `ok` and `fetchedAt`)
  * `allocation`, `audience`, `offer`, `queue_years_q1/q3`, `geo_source`
  * `rooms`, `size_m2`, `rent_sek_mo`, `floor`, `available_from`, `dist_m`
  * the coordinates, rounded to 4 decimals (~10 m) so the markers still cluster
    and fan out the way real ones do

That leaves the fixture able to exercise exactly what the spec asserts — the
group legend, the n ≥ 3 median rule, the reserved-audience filter, the queue
badge, the card, the table and the CSV — without publishing anyone's advert.

Where it is recorded, and why that is not where it is anchored
--------------------------------------------------------------
The spec drives one fixed pin (Södermalm, Stockholm — it is in the task's route
list). Live supply around that exact point is thin: the recording made there had
ten adverts, none of them within a kilometre, so the section's summary, its
medians and its markers all had nothing to work with and the checks proved
nothing.

So the recording is taken where supply is dense and then **re-anchored**: every
listing keeps its real offset from the centre it was recorded around, and that
whole constellation is moved onto the spec's pin. The distances and the density
are a real neighbourhood's; the location is the one the spec asks about. That is
the same kind of synthesis as the street names — and it is stated here rather
than left for someone to discover from a map.

Two centres are recorded, not one: Västerås has dense HomeQ and landlord-portal
supply, and central Stockholm is where the municipal queue (Bostadsförmedlingen)
publishes — and a fixture with no queue listing could not exercise the queue
badge, the allocation filter or the reserved-audience rule at all. Both are
anchored on the same pin.

`--from` takes one or more centres, separated by `;`; `--at` anchors elsewhere.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import urllib.request

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "listings_stockholm.json"
GATEWAY = "https://am-se-listings.am-se-listings-gateway.workers.dev"
# where the fixture is anchored: the pin the spec drives
LAT, LON = 59.31972, 18.07194
# where it is recorded: dense general supply, then the municipal queue
ORIGINS = [(59.6099, 16.5448), (59.3293, 18.0686)]
R = 2000
# per centre, so one dense neighbourhood cannot crowd the other out
MAX_PER_ORIGIN = 25
ORIGIN = "http://localhost:8081"

STREETS = ["Provgatan", "Testvägen", "Fixturgränd", "Exempelgatan", "Mätargatan",
           "Referensvägen", "Attrappgatan", "Skissgränd", "Utkastvägen", "Modellgatan"]
AREAS = ["Provområdet", "Testkvarteret", "Fixturhöjden", "Exempelstaden"]
LANDLORDS = ["Provbolaget AB", "Testfastigheter AB", "Fixturhem AB", "Exempelbostäder AB"]


def merge(bodies: list, origins: list, anchor: tuple[float, float]) -> dict:
    """One answer out of several recordings, each re-anchored on the same pin."""
    listings, seen, sources = [], set(), {}
    for body, origin in zip(bodies, origins):
        dlat, dlon = anchor[0] - origin[0], anchor[1] - origin[1]
        for s in body.get("sources") or []:
            cur = sources.get(s["src"])
            # a source that answered anywhere counts as having answered
            if cur is None or (s.get("ok") and not cur.get("ok")):
                sources[s["src"]] = dict(s)
            elif s.get("ok") and cur.get("ok"):
                cur["count"] = (cur.get("count") or 0) + (s.get("count") or 0)
        for l in (body.get("listings") or [])[:MAX_PER_ORIGIN]:
            key = f"{l['src']}:{l['id']}"
            if key in seen:
                continue
            seen.add(key)
            m = dict(l)
            if m.get("lat") is not None:
                m["lat"] += dlat
                m["lon"] += dlon
            listings.append(m)
    base = bodies[0]
    return {"radius": base.get("radius"), "deduped": sum(b.get("deduped", 0) for b in bodies),
            "sources": list(sources.values()), "listings": listings}


def sanitise(body: dict) -> dict:
    out = {
        "fetchedAt": "2026-09-25T06:00:00.000Z",
        "radius": body.get("radius"),
        "sources": [],
        "deduped": body.get("deduped", 0),
        "listings": [],
        "_fixture": ("Synthetic stand-ins for every third-party string. The source mix, the "
                     "allocation, the audience, the rooms, the size and the rent are as recorded; "
                     "the coordinates keep their real offsets from the recorded centre but the "
                     "whole constellation is anchored on the pin the spec drives. Regenerate "
                     "with tests/fixtures/record_listings.py."),
    }
    for s in body.get("sources") or []:
        row = {"src": s["src"], "ok": s.get("ok", True), "count": s.get("count", 0)}
        if s.get("fetchedAt"):
            row["fetchedAt"] = "2026-09-25T05:30:00.000Z"
        if s.get("error"):
            row["error"] = s["error"]
        out["sources"].append(row)
    for n, l in enumerate(body.get("listings") or []):
        street = STREETS[n % len(STREETS)]
        keep = {
            "src": l["src"],
            "src_label": l.get("src_label"),
            "id": f"fx{n + 1:03d}",
            "url": f"https://example.invalid/listing/fx{n + 1:03d}",
            "address": f"{street} {1 + (n * 3) % 40}",
            "area_name": AREAS[n % len(AREAS)] if l.get("area_name") is not None else None,
            "landlord": LANDLORDS[n % len(LANDLORDS)] if l.get("landlord") is not None else None,
            "lat": round(l["lat"], 5) if l.get("lat") is not None else None,
            "lon": round(l["lon"], 5) if l.get("lon") is not None else None,
            "rent_sek_mo": l.get("rent_sek_mo"),
            "size_m2": l.get("size_m2"),
            "rooms": l.get("rooms"),
            "floor": l.get("floor"),
            "available_from": l.get("available_from"),
            "dist_m": l.get("dist_m"),
            "allocation": l.get("allocation"),
            "audience": l.get("audience"),
            "geo_source": l.get("geo_source"),
        }
        if l.get("image") is not None:
            keep["image"] = f"https://example.invalid/photo/fx{n + 1:03d}.jpg"
        if l.get("offer"):
            keep["offer"] = {"flag": bool(l["offer"].get("flag")), "snippet": "Kampanj: provtext"}
        for k in ("queue_years_q1", "queue_years_q3"):
            if l.get(k) is not None:
                keep[k] = l[k]
        if l.get("also_on"):
            keep["also_on"] = l["also_on"]
        if l.get("text_start") is not None:
            keep["text_start"] = "Fixturtext: en beskrivning som inte kommer från en riktig annons."
        out["listings"].append(keep)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", help="also write the unsanitised answer here (never commit it)")
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--from", dest="origin", default=";".join(f"{a},{b}" for a, b in ORIGINS),
                    help="where to record: 'lat,lon' or several separated by ';'")
    ap.add_argument("--at", dest="anchor", default=f"{LAT},{LON}",
                    help="where to anchor the result, 'lat,lon'")
    args = ap.parse_args()

    origins = [tuple(float(x) for x in o.split(",")) for o in args.origin.split(";") if o.strip()]
    anchor = tuple(float(x) for x in args.anchor.split(","))
    bodies = []
    for lat, lon in origins:
        url = f"{GATEWAY}/nearby?lat={lat}&lon={lon}&r={R}"
        # Cloudflare answers 403 to urllib's default User-Agent, so say who this is.
        req = urllib.request.Request(url, headers={
            "Origin": ORIGIN, "Accept": "application/json",
            "User-Agent": "am-dashboard-se/record_listings (fixture recorder)",
        })
        with urllib.request.urlopen(req, timeout=30) as resp:
            bodies.append(json.loads(resp.read().decode("utf-8")))
    if args.raw:
        pathlib.Path(args.raw).write_text(json.dumps(bodies, ensure_ascii=False, indent=1), encoding="utf-8")

    fx = sanitise(merge(bodies, origins, anchor))
    pathlib.Path(args.out).write_text(json.dumps(fx, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    rooms = {}
    for l in fx["listings"]:
        b = l.get("rooms")
        rooms[b] = rooms.get(b, 0) + 1
    ok = sum(1 for s in fx["sources"] if s["ok"])
    import math
    def hav(a, b, c, d):
        r = math.pi / 180
        x = (math.sin((c - a) * r / 2) ** 2
             + math.cos(a * r) * math.cos(c * r) * math.sin((d - b) * r / 2) ** 2)
        return 2 * 6371008.8 * math.asin(min(1, math.sqrt(x)))
    within = {rr: sum(1 for l in fx["listings"] if hav(anchor[0], anchor[1], l["lat"], l["lon"]) <= rr)
              for rr in (500, 1000, 2000)}
    print(f"wrote {args.out}: {len(fx['listings'])} listings recorded at {origins}, anchored on {anchor}, "
          f"{ok}/{len(fx['sources'])} sources ok, rooms {rooms}, within {within}")
    if not any(v >= 3 for v in rooms.values()):
        print("warning: no room bucket reaches n=3, so the median rule cannot be exercised")


if __name__ == "__main__":
    main()
