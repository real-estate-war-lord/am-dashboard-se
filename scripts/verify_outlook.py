#!/usr/bin/env python3
"""Recompute the Outlook indicators for five kommuner straight from the SCB API.

Nothing here reads data/raw/ or data/processed/ for the expected value: it asks
SCB again, sums the cells itself, and compares with what the built page shows.
A bug in the pull, the aggregation, the age-band selection or the percentage
arithmetic shows up as a mismatch rather than as a plausible-looking number.

    python3 scripts/verify_outlook.py            # five kommuner
    python3 scripts/verify_outlook.py --all      # all 290 (slow)
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import urllib.parse

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from http_util import Throttle, get                                      # noqa: E402
from se_common import PROC                                               # noqa: E402

API = "https://api.scb.se/OV0104/v2beta/api/v2/tables/TAB698/data"
POP = "000004LG"
THR = Throttle(10, 10.0)

# Stockholm, Göteborg, Malmö, and two small ones with opposite trends.
SAMPLE = ["0180", "1480", "1280", "2418", "0760"]

BANDS = {
    "fc_0_5":   [str(a) for a in range(0, 6)],
    "fc_6_16":  [str(a) for a in range(6, 17)],
    "fc_20_34": [str(a) for a in range(20, 35)],
    "fc_80p":   [str(a) for a in range(80, 100)] + ["100+"],
}
TOL = 0.05          # percentage points / inhabitants


def fetch_sum(region: str, years: list[str], ages: list[str] | None) -> dict[str, float]:
    """Total over sex (and over the given ages) per year, from the API."""
    q = [("lang", "en"), ("outputFormat", "json-stat2"),
         ("valueCodes[Region]", region),
         ("valueCodes[Tid]", ",".join(years)),
         ("valueCodes[ContentsCode]", POP)]
    if ages:
        q.append(("valueCodes[Alder]", ",".join(ages)))
    # `+` must go as %2B: safe="," keeps the value separator readable and lets
    # urlencode escape the plus in the `100+` age code, which SCB otherwise
    # reads as a space and rejects with 400.
    url = API + "?" + urllib.parse.urlencode(q, safe=",")
    status, body, _ = get(url, throttle=THR)
    if status != 200:
        raise RuntimeError(f"{region}: HTTP {status}")
    js = json.loads(body)
    dims = js["id"]
    sizes = js["size"]
    tidx = dims.index("Tid")
    tid = js["dimension"]["Tid"]["category"]["index"]
    order = sorted(tid, key=lambda k: tid[k])
    # stride of the Tid dimension in the flat value array
    stride = 1
    for k in range(tidx + 1, len(sizes)):
        stride *= sizes[k]
    out = {t: 0.0 for t in order}
    vals = js["value"]
    for i, v in enumerate(vals):
        if v is None:
            continue
        out[order[(i // stride) % sizes[tidx]]] += v
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true")
    a = ap.parse_args()

    makro = json.loads((PROC / "makro.json").read_text(encoding="utf-8"))
    by = {k["code"]: k for k in makro["kommuner"]}
    codes = sorted(by) if a.all else SAMPLE

    checked = bad = 0
    for code in codes:
        e = by.get(code)
        if not e:
            print(f"  {code}: not in the build"); bad += 1; continue
        tot = fetch_sum(code, ["2026", "2031", "2040"], None)
        exp = {
            "fc_abs": tot["2040"],
            "fc_growth": (tot["2040"] / tot["2026"] - 1) * 100,
            "fc_growth_5y": (tot["2031"] / tot["2026"] - 1) * 100,
        }
        for key, ages in BANDS.items():
            b = fetch_sum(code, ["2026", "2040"], ages)
            exp[key] = (b["2040"] / b["2026"] - 1) * 100

        print(f"\n{code} {e.get('name', '')} — API 2026={tot['2026']:,.1f} 2040={tot['2040']:,.1f}")
        for key, want in exp.items():
            got = e.get(key)
            checked += 1
            if got is None:
                print(f"   ✗ {key:14s} missing from the build"); bad += 1; continue
            ok = abs(got - want) <= (TOL if key != "fc_abs" else 1.0)
            print(f"   {'✓' if ok else '✗'} {key:14s} page {got:>12,.3f}   API {want:>12,.3f}")
            if not ok:
                bad += 1

    print(f"\n{checked - bad} of {checked} recomputed values match the API"
          f" (tolerance {TOL} pp, 1 inhabitant on the count)")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
