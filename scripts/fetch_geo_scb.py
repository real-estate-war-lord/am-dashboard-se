#!/usr/bin/env python3
"""Boundary layers for the Swedish edition, from SCB — no API key, licence CC0.

RegSO and DeSO come off SCB's GeoServer, which reprojects to WGS84 on request,
so the files are Leaflet-ready with no reprojection step. Kommun and län are not
on that WFS; they come as a generalised shapefile zip, converted with ogr2ogr if
it is installed (otherwise the zip is left in place and converted later).

Writes:
  data/geo/raw/regso_2025.geojson      full precision, not committed
  data/geo/raw/deso_2025.geojson       full precision, not committed
  data/geo/raw/kommun_lan.zip          SCB shapefile, if the vintage URL still resolves
  data/geo/raw/kommuner.geojson        if ogr2ogr is available
  data/geo/ATTRIBUTION.txt

Simplification for the browser is a separate, later step — tonight is about
having the real geometry on disk.

Usage: python3 scripts/fetch_geo_scb.py
"""
from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
GEO = ROOT / "data" / "geo"
RAWGEO = GEO / "raw"

WFS = "https://geodata.scb.se/geoserver/stat/wfs"
UA = {"User-Agent": "am-dashboard-se/0.1 (+https://github.com/real-estate-war-lord)"}

LAYERS = [
    ("stat:RegSO_2025", "regso_2025.geojson", 3363),
    ("stat:DeSO_2025", "deso_2025.geojson", 6160),
]

# The filename encodes the vintage and changes roughly once a year; a 404 here is
# expected eventually and is not fatal.
KOMMUN_ZIP = ("https://www.scb.se/contentassets/3443fea3fa6640f7a57ea15d9a372d33/"
              "shape_svenska_260225.zip")

ATTRIBUTION = """Boundary data: Statistiska centralbyrån (SCB).
RegSO 2025 and DeSO 2025 via SCB GeoServer WFS (https://geodata.scb.se/geoserver/stat/wfs).
Kommun and län via SCB's generalised boundary files.
Licence: CC0 1.0 — free use, redistribution and modification, attribution not required.
Attribution given voluntarily as "Källa: SCB".
Note: SCB states the kommun/län boundaries are generalised for thematic mapping
and not suitable for spatial analysis.
"""


def wfs_url(layer: str) -> str:
    return (f"{WFS}?service=WFS&version=2.0.0&request=GetFeature"
            f"&typeNames={layer}&outputFormat=application/json&srsName=EPSG:4326")


def download(url: str, dest: pathlib.Path) -> int:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=1800) as resp, tmp.open("wb") as fh:
        shutil.copyfileobj(resp, fh, length=1024 * 512)
    tmp.replace(dest)
    return dest.stat().st_size


def main() -> int:
    GEO.mkdir(parents=True, exist_ok=True)
    RAWGEO.mkdir(parents=True, exist_ok=True)
    failures = []

    for layer, name, expected in LAYERS:
        dest = RAWGEO / name
        if dest.exists() and dest.stat().st_size > 0:
            print(f"→ {name} already downloaded ({dest.stat().st_size / 1e6:.1f} MB) — skipping")
            continue
        print(f"→ {layer} … (this is the slow one, several minutes is normal)", flush=True)
        try:
            size = download(wfs_url(layer), dest)
        except (urllib.error.HTTPError, urllib.error.URLError, OSError) as exc:
            print(f"  FAILED: {exc}", file=sys.stderr)
            failures.append((layer, str(exc)))
            continue
        try:
            data = json.loads(dest.read_text(encoding="utf-8"))
            count = len(data.get("features") or [])
            first = (data["features"][0]["properties"] if count else {})
            flag = "ok" if count == expected else f"EXPECTED {expected}"
            print(f"  {count} features · {size / 1e6:.1f} MB · {flag}")
            print(f"  attributes: {', '.join(sorted(first))}")
        except (json.JSONDecodeError, KeyError, UnicodeDecodeError) as exc:
            print(f"  downloaded but could not be parsed: {exc}", file=sys.stderr)
            failures.append((layer, f"parse: {exc}"))

    zip_dest = RAWGEO / "kommun_lan.zip"
    if not zip_dest.exists():
        print("→ kommun + län shapefile …", flush=True)
        try:
            size = download(KOMMUN_ZIP, zip_dest)
            print(f"  {size / 1e6:.1f} MB")
        except (urllib.error.HTTPError, urllib.error.URLError, OSError) as exc:
            print(f"  FAILED: {exc} — the vintage in the URL has probably rolled over; "
                  "we will find the current link tomorrow", file=sys.stderr)
            failures.append(("kommun_lan.zip", str(exc)))

    if zip_dest.exists() and shutil.which("ogr2ogr"):
        out = RAWGEO / "kommuner.geojson"
        if not out.exists():
            print("→ converting kommun/län to GeoJSON (ogr2ogr) …", flush=True)
            try:
                subprocess.run(
                    ["ogr2ogr", "-t_srs", "EPSG:4326", "-f", "GeoJSON",
                     str(out), f"/vsizip/{zip_dest}"],
                    check=True, capture_output=True, timeout=900)
                print(f"  wrote {out.name} ({out.stat().st_size / 1e6:.1f} MB)")
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
                stderr = getattr(exc, "stderr", b"") or b""
                print(f"  ogr2ogr failed: {stderr.decode('utf-8', 'replace')[:300]}", file=sys.stderr)
    elif zip_dest.exists():
        print("→ ogr2ogr not installed — the zip is saved and will be converted later "
              "(`brew install gdal`, or we derive kommun boundaries from RegSO)")

    (GEO / "ATTRIBUTION.txt").write_text(ATTRIBUTION, encoding="utf-8")

    print("\n" + "=" * 60)
    if failures:
        print("FAILED layers (paste into the chat):")
        for layer, why in failures:
            print(f"  {layer}: {why[:200]}")
    else:
        print("all layers downloaded")
    print(f"files in {RAWGEO}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
