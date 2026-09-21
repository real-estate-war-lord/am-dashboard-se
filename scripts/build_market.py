#!/usr/bin/env python3
"""Build data/processed/market.json — the national macro panel.

The registry has no separate `macro` block the way the Danish one does: the
national series are ordinary indicators carrying level "none", and this script
picks them out of the same `indicators` list. Sources that are not SCB pulls
(Riksbank SWEA) are read from data/raw/riksbank_<series>.json; an indicator with
no data on disk is reported as a warning and simply does not appear, so the page
shows "no data" rather than an error.

Each indicator yields one main series plus, where a dimension holds several
codes (mortgage fixation periods, owner categories), a `breakdown` of named
sub-series.

Usage: python3 scripts/build_market.py
"""
from __future__ import annotations

import collections
import datetime as dt
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from se_common import (  # noqa: E402
    PROC, RAW, cfg, dim_labels, period_key, stream,
)

OUT = PROC / "market.json"

# Which code means "the whole country" in a table that still has a Region column.
NATIONAL = ("00", "0", "SE", "riket")

# Order of the headline tiles.
HERO = ["policy_rate", "mortgage_rate", "bond_10y", "cpi", "gdp"]


def national_region(codes: set) -> str | None:
    for c in NATIONAL:
        if c in codes:
            return c
    return None


def scb_series(ind: dict, src: dict, warn) -> tuple[dict, dict]:
    """(main series, breakdown) for one SCB-backed national indicator."""
    vars_ = dict(src.get("vars") or {})
    moe_code = (ind.get("moe") or {}).get("contents")
    contents = [c for c in (vars_.get("ContentsCode") or []) if c != moe_code]

    # A dimension with more than one selected code becomes the breakdown axis;
    # the first code is what the main line shows.
    split_dim = next((d for d, v in vars_.items()
                      if d not in ("ContentsCode", "Tid") and len(v) > 1), None)

    rows = collections.defaultdict(lambda: collections.defaultdict(list))
    regions = set()
    for r in stream(src["pull"]):
        if "Region" in r:
            regions.add(r["Region"])
        if r["value"] is None:
            continue
        cc = r.get("ContentsCode")
        if contents and cc != contents[0]:
            continue
        if not all(r.get(d) in v for d, v in vars_.items()
                   if d not in ("ContentsCode", "Tid", split_dim)):
            continue
        rows[r.get(split_dim) if split_dim else "_"][r["Tid"]].append(r)

    keep_region = national_region(regions) if regions else None
    if regions and keep_region is None:
        warn(f"{ind['key']}: no national region code in {sorted(regions)[:6]} — using the first")
        keep_region = sorted(regions)[0]

    def collapse(byt: dict) -> list:
        out = []
        for t, rs in byt.items():
            vals = [r["value"] for r in rs
                    if keep_region is None or r.get("Region") == keep_region]
            if vals:
                out.append({"t": t, "v": round(sum(vals) / len(vals), 4)})
        return sorted(out, key=lambda p: period_key(p["t"]))

    labels = dim_labels(src["table"], split_dim) if split_dim else {}
    order = vars_.get(split_dim) or []
    breakdown = {}
    for code in order:
        s = collapse(rows.get(code) or {})
        if s:
            breakdown[labels.get(code, code)] = s
    main = collapse(rows.get(order[0] if order else "_") or {})
    return main, breakdown


def riksbank_series(src: dict, warn) -> list:
    p = RAW / f"riksbank_{src['series']}.json"
    if not p.exists():
        warn(f"{src['series']}: data/raw/{p.name} not on disk — run scripts/fetch_riksbank.py")
        return []
    return json.loads(p.read_text(encoding="utf-8")).get("obs") or []


def main() -> int:
    c = cfg()
    warnings: list[str] = []

    def warn(m: str) -> None:
        warnings.append(m)

    series, breakdowns, latest, order = {}, {}, {}, []
    for ind in c["indicators"]:
        if ind.get("level") != "none":
            continue
        key = ind["key"]
        order.append(key)
        src = ind["sources"][0]
        db = src.get("db")
        try:
            if db == "scb":
                s, bd = scb_series(ind, src, warn)
            elif db == "riksbank":
                s, bd = riksbank_series(src, warn), {}
            else:
                warn(f"{key}: source '{db}' has no fetcher yet — shown as no data")
                continue
        except FileNotFoundError as exc:
            warn(f"{key}: {exc}")
            continue
        if not s:
            warn(f"{key}: no observations after selection")
            continue

        series[key] = s
        if bd:
            breakdowns[key] = bd
        last = s[-1]
        y, n = period_key(last["t"])
        prev = next((p for p in s if period_key(p["t"]) == (y - 1, n)), None)
        yoy = None
        if prev and prev["v"]:
            # Already-a-percentage series change in points, not in per cent of themselves.
            yoy = (last["v"] - prev["v"] if (ind.get("unit") or "").strip() in ("%", "% / yr")
                   else (last["v"] / prev["v"] - 1) * 100)
        latest[key] = {"t": last["t"], "v": last["v"], "yoy": None if yoy is None else round(yoy, 2),
                       "label": ind["label"], "short": ind.get("short", ind["label"]),
                       "unit": ind.get("unit", ""), "fmt": ind.get("fmt", "pct1"),
                       "desc": ind.get("desc", ""), "src": ind.get("source", ""),
                       "warn": ind.get("warn", ""), "note": ind.get("note", ""),
                       "n": len(s)}
        print(f"  {key:14s} {len(s):4d} points · {s[0]['t']}…{last['t']} = {last['v']}"
              + (f" · {len(bd)} sub-series" if bd else ""))

    out = {"series": series, "breakdown": breakdowns, "latest": latest,
           "hero": [k for k in HERO if k in series],
           "table": [k for k in order if k in series],
           "missing": [k for k in order if k not in series],
           "built": dt.date.today().isoformat(),
           "note": ("National series. y/y compares with the same period a year earlier — in "
                    "percentage points for series that are themselves rates."),
           "warnings": warnings}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"\nwrote {OUT}: {len(series)} series, {len(out['missing'])} without data")
    for w in warnings:
        print("  ⚠", w)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
