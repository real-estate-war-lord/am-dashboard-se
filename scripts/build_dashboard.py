#!/usr/bin/env python3
"""Assemble the self-contained dashboard: dist/index.html.

Inlines src/style.css, the vendored Leaflet, src/app.js and the processed data
(data/processed/makro.json + market.json) into src/index.html — one file that
opens from disk or from GitHub Pages.

The DeSO layer is the exception: 6 160 areas with polygons would roughly double
the page, so data/processed/deso/<kommun>.json is copied next to it and fetched
on demand. Those need http, which is what `make serve` and Pages provide; from
a file:// URL the DeSO toggle is simply unavailable.

Usage: python3 scripts/build_dashboard.py [--out dist/index.html]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
PROC = ROOT / "data" / "processed"


def load(p: pathlib.Path):
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(PROC / "makro.json"))
    ap.add_argument("--market", default=str(PROC / "market.json"))
    ap.add_argument("--out", default=str(ROOT / "dist" / "index.html"))
    args = ap.parse_args()

    makro = load(pathlib.Path(args.data))
    if not makro:
        print(f"{args.data} missing — run scripts/build_makro.py first", file=sys.stderr)
        return 1
    market = load(pathlib.Path(args.market)) or {}
    built = (makro.get("meta") or {}).get("built") or dt.date.today().isoformat()

    data = {
        "meta": makro.get("meta", {}),
        "indicators": makro.get("indicators", []),
        "kommuner": makro.get("kommuner", []),
        "regso": makro.get("regso", []),
        "deso_index": makro.get("deso_index", {}),
        "src_periods": makro.get("src_periods", {}),
        "schools_index": makro.get("schools_index", {}),
        "schools_meta": makro.get("schools_meta", {}),
        "macro": market,
    }
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</script", "<\\/script")
    html = (SRC / "index.html").read_text(encoding="utf-8")
    html = (html.replace("{{LEAFLET_CSS}}", (SRC / "vendor" / "leaflet.css").read_text(encoding="utf-8"))
                .replace("{{APP_CSS}}", (SRC / "style.css").read_text(encoding="utf-8"))
                .replace("{{LEAFLET_JS}}", (SRC / "vendor" / "leaflet.js").read_text(encoding="utf-8"))
                # testprop.js goes in FIRST: app.js calls parseLocation, and the
                # module is kept separate so `node --test` can load it without a DOM
                .replace("{{TESTPROP_JS}}", (SRC / "testprop.js").read_text(encoding="utf-8"))
                .replace("{{APP_JS}}", (SRC / "app.js").read_text(encoding="utf-8"))
                .replace("{{DATA}}", payload)
                .replace("{{BUILT}}", built))
    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")

    # the on-demand boundary rings for the dropped pin
    n_look = 0
    src_look = PROC / "lookup"
    if src_look.exists():
        dl = out.parent / "lookup"
        if dl.exists():
            shutil.rmtree(dl)
        shutil.copytree(src_look, dl)
        n_look = len(list(dl.glob("*.json")))
    for name in ("lookup_kommuner.json",):
        sp = PROC / name
        if sp.exists():
            shutil.copyfile(sp, out.parent / name)

    # the on-demand school point files travel next to the page
    src_sch = PROC / "schools"
    n_sch = 0
    if src_sch.exists():
        dsch = out.parent / "schools"
        if dsch.exists():
            shutil.rmtree(dsch)
        shutil.copytree(src_sch, dsch)
        n_sch = len(list(dsch.glob("*.json")))

    # the on-demand DeSO files travel next to the page
    src_deso = PROC / "deso"
    n_deso = 0
    if src_deso.exists():
        dst = out.parent / "deso"
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(src_deso, dst)
        n_deso = len(list(dst.glob("*.json")))

    # overlay geometry that is small enough to ship whole and fetched on demand
    n_ov = 0
    for name in ("polisen_uso.geojson",):
        src = PROC.parent / "geo" / name
        if src.exists():
            shutil.copyfile(src, out.parent / name)
            n_ov += 1

    print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB) · "
          f"{len(data['kommuner'])} kommuner · {len(data['regso'])} RegSO · "
          f"{len(data['indicators'])} indicators · {len(market.get('series') or {})} macro series")
    if n_deso:
        print(f"copied {n_deso} DeSO files → {out.parent / 'deso'}")
    if n_sch:
        print(f"copied {n_sch} school files → {out.parent / 'schools'}")
    if n_look:
        print(f"copied {n_look} lookup ring files → {out.parent / 'lookup'}")
    if n_ov:
        print(f"copied {n_ov} overlay layer(s) → {out.parent}")
    miss = market.get("missing") or []
    if miss:
        print(f"macro series without data (shown as 'no data'): {', '.join(miss)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
