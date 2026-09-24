#!/usr/bin/env python3
"""Assemble the standalone Listings page: dist/listings.html.

Inlines the vendored Leaflet, the design tokens from src/style.css and the
three files under src/listings/, exactly the way build_dashboard.py assembles
dist/index.html — one self-contained file, no build tooling, no network at
build time.

This is a separate entry point on purpose. It reads src/style.css and
src/vendor/* but writes only dist/listings.html, so it cannot change what
`make build` produces, and it shares no code with build_dashboard.py that
either could break for the other.

    python3 scripts/build_listings.py [--out dist/listings.html]

Then serve dist/ and open http://localhost:8080/listings.html — that origin is
one the gateway's CORS allowlist already permits.
"""
import argparse
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
LST = SRC / "listings"


def read(path: pathlib.Path) -> str:
    if not path.exists():
        sys.exit(f"missing: {path.relative_to(ROOT)}")
    return path.read_text(encoding="utf-8")


def tokens_only(css: str) -> str:
    """The dashboard's stylesheet, minus the rules that lay out the dashboard.

    Only the :root blocks are wanted — the palette, radii and font stacks. The
    rest of style.css positions a sidebar and a grid this page does not have,
    and pulling it in wholesale would fight listings.css. Taking the tokens
    keeps the two pages the same colour without coupling their layouts.
    """
    out, depth, buf, keep = [], 0, [], False
    i = 0
    while i < len(css):
        ch = css[i]
        if ch == "{":
            if depth == 0:
                sel = "".join(buf).strip()
                keep = sel.startswith(":root")
                if keep:
                    out.append(sel + "{")
                buf = []
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                if keep:
                    out.append("".join(buf) + "}")
                buf, keep = [], False
            else:
                buf.append(ch)
        else:
            buf.append(ch)
        i += 1
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(ROOT / "dist" / "listings.html"))
    args = ap.parse_args()

    html = read(LST / "index.html")
    parts = {
        "LEAFLET_CSS": read(SRC / "vendor" / "leaflet.css"),
        "LEAFLET_JS": read(SRC / "vendor" / "leaflet.js"),
        "TOKENS_CSS": tokens_only(read(SRC / "style.css")),
        "LISTINGS_CSS": read(LST / "listings.css"),
        "PARSE_JS": read(LST / "parse.js"),
        "VIEW_JS": read(LST / "view.js"),
        "LISTINGS_JS": read(LST / "listings.js"),
    }
    for key, value in parts.items():
        token = "{{" + key + "}}"
        if token not in html:
            sys.exit(f"src/listings/index.html has no {token} placeholder")
        html = html.replace(token, value)

    left = [t for t in ("{{",) if t in html]
    if left:
        sys.exit("unreplaced placeholder left in the page")

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    kb = out.stat().st_size / 1024
    print(f"wrote {out.relative_to(ROOT)}  ({kb:.0f} KB)")
    print("serve with:  python3 -m http.server 8080 --directory dist")
    print("then open :  http://localhost:8080/listings.html")


if __name__ == "__main__":
    main()
