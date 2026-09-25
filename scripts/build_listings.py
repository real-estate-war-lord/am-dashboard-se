#!/usr/bin/env python3
"""Assemble dist/listings.html — a redirect page, nothing more.

The Listings page used to be a second application: its own map, its own state,
its own stylesheet. In v2.0 its logic (src/listings/view.js) is inlined into the
dashboard and its UI is a section of Test property, so the only thing left to
publish at the old address is a redirect that keeps shared links working.

src/route_core.js is inlined so this page and the app resolve
"#at=lat,lon&r=1000" with exactly the same code — a link cannot land on a
different pin than the one it was copied from.

    python3 scripts/build_listings.py [--out dist/listings.html]
"""
import argparse
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"


def read(path: pathlib.Path) -> str:
    if not path.exists():
        sys.exit(f"missing: {path.relative_to(ROOT)}")
    return path.read_text(encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(ROOT / "dist" / "listings.html"))
    args = ap.parse_args()

    html = read(SRC / "listings" / "redirect.html")
    token = "{{ROUTE_JS}}"
    if token not in html:
        sys.exit(f"src/listings/redirect.html has no {token} placeholder")
    html = html.replace(token, read(SRC / "route_core.js"))
    if "{{" in html:
        sys.exit("unreplaced placeholder left in the page")

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print(f"wrote {out.relative_to(ROOT)}  ({out.stat().st_size / 1024:.0f} KB, redirect only)")


if __name__ == "__main__":
    main()
