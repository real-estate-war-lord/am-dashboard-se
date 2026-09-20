#!/usr/bin/env python3
"""Resolve the tables we only know by their old PxWeb path.

Searches in Swedish: the catalogue matches the label in the requested language,
and SCB's table titles are Swedish natively — an English search for a Swedish
term returns nothing at all, which is exactly what happened on the first run.

The macro and labour tables (unemployment, mortgage rates, GDP, wages, assessed
values, building permits) were verified under the v1 API, which uses paths like
`AM/AM0210/AM0210A/ArbStatusM` rather than v2's `TABxxxx` ids. Rather than guess,
this searches the v2 table catalogue and writes every candidate to a file, so the
right ids can be picked offline.

Writes data/raw/_discovery.json and prints a readable summary.

Usage: python3 scripts/discover_scb.py
"""
from __future__ import annotations

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import scb  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "raw" / "_discovery.json"

WANTED = [
    ("unemployment_kommun", "arbetsmarknadsstatus", "monthly labour market status, 290 kommuner"),
    ("mortgage_rates", "utlåningsränta", "lending rates by fixation period"),
    ("mortgage_volumes", "utlåning bostadsändamål", "housing lending volumes"),
    ("ltv", "belåningsgrad", "loan-to-value bands"),
    ("gdp", "bruttonationalprodukt", "quarterly GDP"),
    ("wages", "löneindex", "wage index"),
    ("assessed_smahus", "taxeringsvärde småhus", "assessed values, småhus, by kommun"),
    ("assessed_other", "taxeringsvärde hyreshus", "assessed values incl. hyreshus"),
    ("building_permits", "bygglov", "building permits"),
    ("conversions", "ombyggnad", "conversions"),
    ("regional_gdp", "bruttoregionprodukt", "regional GDP per län"),
    ("rent_check", "hyra", "sanity check — must return hits or the search is broken"),
]


def main() -> int:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    results = {}
    for key, query, why in WANTED:
        print(f"→ {key}: “{query}”", flush=True)
        try:
            hits = scb.search(query, page_size=15, lang="sv")
        except scb.ScbError as exc:
            print(f"  FAILED: {exc}", file=sys.stderr)
            results[key] = {"query": query, "why": why, "error": str(exc), "hits": []}
            continue
        results[key] = {"query": query, "why": why, "hits": hits}
        if not hits:
            # Keep one raw catalogue response so the envelope shape can be read
            # offline if the search returns nothing at all.
            try:
                results.setdefault("_raw_sample", scb._request(
                    f"{scb.API}/tables?lang=sv&query=hyra&pageSize=3"))
            except scb.ScbError:
                pass
        for hit in hits[:6]:
            mark = " [discontinued]" if hit.get("discontinued") else ""
            print(f"  {hit['id']:10s} {str(hit.get('label'))[:78]}{mark}")
        if not hits:
            print("  (no hits — we will try other search terms)")
        print()

    OUT.write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    print("=" * 60)
    print(f"wrote {OUT}")
    print("Paste the printed list into the chat, or just send the file — "
          "the ids get pinned into the config tomorrow.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
