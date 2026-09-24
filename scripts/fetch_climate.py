#!/usr/bin/env python3
"""Climate-risk source layers: flood, coast, sea level, landslide, cloudburst.

Everything is pulled in SWEREF99 TM (EPSG:3006) and kept there, because every
figure derived from these layers is an AREA SHARE and an area computed from
degrees is wrong by the cosine of the latitude. Sweden spans 14 degrees of it.

Sources, all open, all verified live:
  * MCF (ex-MSB) INSPIRE WFS — river flood extents, 100-year, 200-year and BHF
    (beräknat högsta flöde). The layer is tens of megabytes in fewer than 80
    features, so it comes as SHAPE-ZIP rather than as GeoJSON, which dies
    mid-stream.
  * MCF ArcGIS — coastal inundation at a given water level in RH2000, one layer
    per 0.1 m. We take 2.0 m (layer 19) and 3.0 m (layer 29).
  * MCF ArcGIS — Skyfallskartering_Oversikt: which kommuner have made their own
    cloudburst mapping. 290 rows, one per kommun, joins on KOM_KOD.
  * SMHI — projected mean sea level, RCP4.5 and RCP8.5 at 2100, 14 coastal
    areas each, zipped shapefiles.
  * SGU — aktsamhetsområden for landslide in fine-grained soils, plus the
    COVERAGE layer, which is what makes "not mapped" a different answer from
    "no risk found".

Raw files are cached under data/raw/climate/ and gitignored.

    python3 scripts/fetch_climate.py            # resume
    python3 scripts/fetch_climate.py --only sgu
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import urllib.parse

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from http_util import Throttle, get                                      # noqa: E402
from se_common import ROOT                                               # noqa: E402

RAW = ROOT / "data" / "raw" / "climate"
THR = Throttle(6, 1.0)

WFS = "https://inspire.mcf.se/oversvamning/ows"
ARC = "https://gis-tjanster.mcf.se/arcgis/rest/services/Oversvamningskarteringar"
SGU = "https://api.sgu.se/oppnadata/forutsattningar-skred-finkornig-jordart/ogc/features/v1"
SMHI = "https://opendata-download.smhi.se/framtida_medelvattenstand/baserat-pa-ipcc-ar6-srocc-2019"

FLOOD_LAYERS = {"flood100": "NZ_Oversvamning_100",
                "flood200": "NZ_Oversvamning_200",
                "floodBHF": "NZ_Oversvamning_BHF"}
COAST_LAYERS = {"coast20": 19, "coast30": 29}          # 2,0 m and 3,0 m in RH2000
SMHI_SETS = {"sea2100_85": "average_85_2100", "sea2100_45": "average_45_2100"}
SMHI_AREAS = ["Blekinge", "Gavleborg", "Gotland", "Halland", "Kalmar", "Norrbotten",
              "Ostergotland", "Skane", "Sodermanland", "Stockholm", "Uppsala",
              "Vasterbotten", "Vasternorrland", "Vastra_Gotaland"]   # SMHI spells this one with an underscore


def save(name: str, body: bytes) -> pathlib.Path:
    RAW.mkdir(parents=True, exist_ok=True)
    p = RAW / name
    p.write_bytes(body)
    return p


def have(name: str) -> bool:
    p = RAW / name
    return p.exists() and p.stat().st_size > 0


def fetch_flood(refresh: bool) -> None:
    for key, layer in FLOOD_LAYERS.items():
        name = f"{key}.zip"
        if have(name) and not refresh:
            print(f"  {key:10s} cached ({(RAW / name).stat().st_size / 1e6:.1f} MB)")
            continue
        q = {"service": "WFS", "version": "2.0.0", "request": "GetFeature",
             "typeNames": f"oversvamning:{layer}", "outputFormat": "SHAPE-ZIP",
             "srsName": "EPSG:3006"}
        url = WFS + "?" + urllib.parse.urlencode(q)
        st, body, _ = get(url, timeout=600, throttle=THR)
        if st != 200 or len(body) < 1000:
            print(f"  {key:10s} HTTP {st}, {len(body)} bytes — SKIPPED", file=sys.stderr)
            continue
        save(name, body)
        print(f"  {key:10s} {len(body) / 1e6:.1f} MB")


def fetch_coast(refresh: bool) -> None:
    for key, lid in COAST_LAYERS.items():
        name = f"{key}.geojson"
        if have(name) and not refresh:
            print(f"  {key:10s} cached ({(RAW / name).stat().st_size / 1e6:.1f} MB)")
            continue
        q = {"where": "1=1", "outFields": "lankod,lannamn", "returnGeometry": "true",
             "outSR": "3006", "maxAllowableOffset": "30", "f": "geojson"}
        url = f"{ARC}/kustoversvamning/MapServer/{lid}/query?" + urllib.parse.urlencode(q)
        st, body, _ = get(url, timeout=600, throttle=THR)
        if st != 200 or len(body) < 1000:
            print(f"  {key:10s} HTTP {st}, {len(body)} bytes — SKIPPED", file=sys.stderr)
            continue
        save(name, body)
        n = len((json.loads(body).get("features") or []))
        print(f"  {key:10s} {len(body) / 1e6:.1f} MB · {n} features")


def fetch_skyfall(refresh: bool) -> None:
    name = "skyfall_kommuner.geojson"
    if have(name) and not refresh:
        print(f"  {'skyfall':10s} cached")
        return
    q = {"where": "1=1", "outFields": "KOM_KOD,KOMMUNNAMN,Status,FMEDatum",
         "returnGeometry": "false", "f": "geojson"}
    url = f"{ARC}/Skyfallskartering_Oversikt/FeatureServer/0/query?" + urllib.parse.urlencode(q)
    st, body, _ = get(url, timeout=120, throttle=THR)
    if st != 200:
        print(f"  skyfall HTTP {st} — SKIPPED", file=sys.stderr)
        return
    save(name, body)
    feats = json.loads(body).get("features") or []
    yes = sum(1 for f in feats if (f.get("properties") or {}).get("Status") == 1)
    print(f"  {'skyfall':10s} {len(feats)} kommuner · {yes} with their own mapping")


def sgu_page(url: str) -> tuple[list, str | None]:
    """One page, and the server's own `next` link.

    SGU pages with `startIndex` — CAPITAL I. `startindex` and `offset` are both
    accepted and both SILENTLY IGNORED, so a loop that constructs either one
    refetches page 1 for ever: the first cut of this fetcher "downloaded"
    201 000 features that were 201 copies of the same thousand, and 3.2 GB of
    them. Following the server's own next link cannot make that mistake.
    (The same capitalisation trap as SCB's codelist/valueCodes, already in
    CLAUDE.md.)
    """
    st, body, _ = get(url, timeout=300, throttle=THR)
    if st != 200:
        return [], None
    j = json.loads(body)
    nxt = next((l.get("href") for l in (j.get("links") or [])
                if l.get("rel") == "next"), None)
    return (j.get("features") or []), nxt


def fetch_coverage(refresh: bool) -> None:
    """The 80 watercourses MCF has actually mapped.

    This is what makes "not mapped" a different answer from "no flood risk
    found". It is a LINE layer, so it cannot define a coverage area without
    buffering it by some invented distance; instead the build tests which
    kommuner a mapped watercourse runs through, which is a well-defined
    line-in-polygon question, and treats every area in a kommun with no mapped
    watercourse as not mapped.
    """
    name = "flood_coverage.geojson"
    if have(name) and not refresh:
        print(f"  {'coverage':10s} cached")
        return
    q = {"where": "1=1", "outFields": "Namn,KarteradAr,Metod,Typ",
         "returnGeometry": "true", "outSR": "3006", "f": "geojson"}
    url = ("https://gis-tjanster.mcf.se/arcgis/rest/services/Oversvamningskarteringar/"
           "karteringar/MapServer/0/query?" + urllib.parse.urlencode(q))
    st, body, _ = get(url, timeout=300, throttle=THR)
    if st != 200:
        print(f"  coverage HTTP {st} — SKIPPED", file=sys.stderr)
        return
    save(name, body)
    n = len(json.loads(body).get("features") or [])
    print(f"  {'coverage':10s} {n} mapped watercourses")


def fetch_sgu(refresh: bool) -> None:
    """Caution zones per kommun, by bounding box.

    242 000 + 50 000 features nationally is too much to hold or to keep as one
    file, so this fetches a kommun at a time — small, resumable, and each file
    is discarded by the build once it has been intersected.
    """
    import csv as _csv
    kom = json.loads((ROOT / "data" / "geo" / "kommuner.geojson").read_text(encoding="utf-8"))
    boxes = []
    for f in kom["features"]:
        xs, ys = [], []
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        for poly in polys:
            for c in poly[0]:
                xs.append(c[0]); ys.append(c[1])
        boxes.append((f["properties"]["code"], min(xs), min(ys), max(xs), max(ys)))

    d = RAW / "sgu"
    d.mkdir(parents=True, exist_ok=True)
    for coll in ("aktsam-efterarbetad", "aktsam-strandnara"):
        todo = [b for b in boxes if refresh or not (d / f"{coll}_{b[0]}.json").exists()]
        print(f"  {coll:22s} {len(boxes) - len(todo)} cached, {len(todo)} to fetch")
        tot = 0
        for i, (code, x0, y0, x1, y1) in enumerate(todo, 1):
            url = (f"{SGU}/collections/{coll}/items?f=json&limit=1000"
                   f"&bbox={x0:.4f},{y0:.4f},{x1:.4f},{y1:.4f}"
                   f"&crs=http://www.opengis.net/def/crs/EPSG/0/3006")
            feats = []
            while url and len(feats) < 60000:
                got, url = sgu_page(url)
                feats += got
                if not got:
                    break
            (d / f"{coll}_{code}.json").write_text(
                json.dumps({"type": "FeatureCollection", "features": feats},
                           separators=(",", ":")), encoding="utf-8")
            tot += len(feats)
            if i % 40 == 0:
                print(f"    {i}/{len(todo)} kommuner · {tot:,} features", flush=True)
        if todo:
            print(f"  {coll:22s} {tot:,} features over {len(todo)} kommuner")

    # the coverage layer is small and national: 780 features, and it is what makes
    # "not mapped" a different answer from "no risk found"
    name = "sgu_tackning.geojson"
    if have(name) and not refresh:
        print(f"  {'tackning':22s} cached")
        return
    feats, url = [], (f"{SGU}/collections/tackning-karttyp/items?f=json&limit=500"
                      f"&crs=http://www.opengis.net/def/crs/EPSG/0/3006")
    while url:
        got, url = sgu_page(url)
        feats += got
        if not got:
            break
    save(name, json.dumps({"type": "FeatureCollection", "features": feats},
                          separators=(",", ":")).encode("utf-8"))
    print(f"  {'tackning':22s} {len(feats):,} features "
          f"({(RAW / name).stat().st_size / 1e6:.1f} MB)")


def fetch_smhi(refresh: bool) -> None:
    for key, folder in SMHI_SETS.items():
        got = 0
        for area in SMHI_AREAS:
            name = f"{key}_{area}.zip"
            if have(name) and not refresh:
                got += 1
                continue
            url = f"{SMHI}/{folder}/{area}_{folder}.zip"
            st, body, _ = get(url, timeout=300, throttle=THR)
            if st != 200 or len(body) < 500:
                print(f"    {area} {key}: HTTP {st}", file=sys.stderr)
                continue
            save(name, body)
            got += 1
        tot = sum((RAW / f"{key}_{a}.zip").stat().st_size
                  for a in SMHI_AREAS if have(f"{key}_{a}.zip"))
        print(f"  {key:10s} {got}/{len(SMHI_AREAS)} areas · {tot / 1e6:.1f} MB")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", action="append", default=[])
    ap.add_argument("--refresh", action="store_true")
    a = ap.parse_args()
    steps = {"skyfall": fetch_skyfall, "coverage": fetch_coverage,
             "sgu": fetch_sgu, "coast": fetch_coast,
             "smhi": fetch_smhi, "flood": fetch_flood}
    for name, fn in steps.items():
        if a.only and name not in a.only:
            continue
        print(f"{name}:")
        fn(a.refresh)
    print(f"\nraw under {RAW.relative_to(ROOT)} — Källa: MCF, SMHI, SGU")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
