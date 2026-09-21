#!/usr/bin/env python3
"""Independent check: five kommuner x three indicators, straight from the API.

The pipeline pulls a whole level at a time, caches it and aggregates offline.
This asks SCB for one kommun at a time, with an explicit selection, and does the
arithmetic here — a different query and a different code path, so a mistake in
the fetcher, the cache or build_makro cannot hide behind the same bug twice.

  rent        TAB4590  median annual rent SEK/m², Ah_kvm, with its margin
  growth      TAB6574  population 31 Dec, this year against last
  higher_ed   TAB6534  post-secondary (levels 5+6) over those with a known level

Compares against data/processed/makro.json and prints a table for
docs/DATA_MAP_SE.md §4. A mismatch is reported, never corrected.

Usage: python3 scripts/verify_scb.py [--json out.json]
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import scb  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
MAKRO = ROOT / "data" / "processed" / "makro.json"

KOMMUNER = [("0180", "Stockholm"), ("1480", "Göteborg"), ("1280", "Malmö"),
            ("2480", "Umeå"), ("2584", "Kiruna")]

TOL = {"rent": 0.51, "growth": 0.006, "higher_ed": 0.06}   # units of the indicator


def one(table: str, sel: dict) -> list:
    """One small GET, flattened — deliberately not scb.fetch_rows' chunking path."""
    return scb.flatten(scb._request(scb._url(table, sel, "json-stat2")))


def rent(code: str):
    rows = one("TAB4590", {"Region": [code], "Hyresuppg": ["Ah_kvm"],
                           "ContentsCode": ["000000J4", "000000J3"], "Tid": ["2025"]})
    v = {r["ContentsCode"]: r["value"] for r in rows}
    med, moe = v.get("000000J4"), v.get("000000J3")
    return (None if med is None else float(med)), (None if moe is None else float(moe))


def growth(code: str):
    rows = one("TAB6574", {"Region": [code], "Alder": ["totalt"], "Kon": ["1+2"],
                           "ContentsCode": ["000007Y7"], "Tid": ["2024", "2025"]})
    v = {r["Tid"]: r["value"] for r in rows}
    a, b = v.get("2024"), v.get("2025")
    return (None if not a or b is None else (b / a - 1) * 100), None


def higher_ed(code: str):
    rows = one("TAB6534", {"Region": [code],
                           "UtbildningsNiva": ["21", "3+4", "5", "6", "US"],
                           "ContentsCode": ["000007Z6"], "Tid": ["2025"]})
    v = {r["UtbildningsNiva"]: (r["value"] or 0) for r in rows}
    known = v.get("21", 0) + v.get("3+4", 0) + v.get("5", 0) + v.get("6", 0)
    return (None if not known else (v.get("5", 0) + v.get("6", 0)) / known * 100), None


CHECKS = [("rent", "Rent, median SEK/m²/yr", rent),
          ("growth", "Population growth %/yr", growth),
          ("higher_ed", "Post-secondary % of 25–65", higher_ed)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", default="")
    args = ap.parse_args()

    if not MAKRO.exists():
        print("data/processed/makro.json missing — run 'make build'", file=sys.stderr)
        return 1
    built = {k["code"]: k for k in json.loads(MAKRO.read_text(encoding="utf-8"))["kommuner"]}

    rows, bad = [], 0
    for key, label, fn in CHECKS:
        for code, name in KOMMUNER:
            try:
                api, api_moe = fn(code)
            except scb.ScbError as exc:
                rows.append((label, name, None, None, None, f"API error: {exc}"))
                bad += 1
                continue
            dash = (built.get(code) or {}).get(key)
            dash_moe = (built.get(code) or {}).get(key + "_moe")
            if api is None and dash is None:
                verdict = "match (both suppressed)"
            elif api is None or dash is None:
                verdict = "MISMATCH — one side has no value"
                bad += 1
            else:
                d = abs(api - dash)
                ok = d <= TOL[key]
                verdict = "match" if ok else f"MISMATCH Δ={d:.3f}"
                if not ok:
                    bad += 1
                if api_moe is not None and dash_moe is not None and abs(api_moe - dash_moe) > 0.51:
                    verdict += f" · margin differs ({api_moe} vs {dash_moe})"
                    bad += 1
            rows.append((label, name, api, dash, api_moe if api_moe is not None else dash_moe, verdict))
            print(f"  {label:28s} {name:10s} api={_f(api):>10s} dash={_f(dash):>10s}  {verdict}")

    print(f"\n{len(rows)} checks · {bad} problem(s)")
    print("\n| Indicator | Kommun | API (independent query) | Dashboard | ± | Verdict |")
    print("|---|---|---|---|---|---|")
    for label, name, api, dash, moe, verdict in rows:
        mark = "✅" if verdict.startswith("match") else "❌"
        print(f"| {label} | {name} | {_f(api)} | {_f(dash)} | {'' if moe is None else f'±{moe:g}'} "
              f"| {mark} {verdict} |")
    if args.json:
        pathlib.Path(args.json).write_text(json.dumps(
            [{"indicator": l, "kommun": n, "api": a, "dashboard": d, "moe": m, "verdict": v}
             for l, n, a, d, m, v in rows], ensure_ascii=False, indent=1), encoding="utf-8")
    return 1 if bad else 0


def _f(v):
    return "–" if v is None else f"{v:.2f}".rstrip("0").rstrip(".")


if __name__ == "__main__":
    raise SystemExit(main())
