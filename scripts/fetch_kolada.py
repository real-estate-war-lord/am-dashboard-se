#!/usr/bin/env python3
"""Pull municipal finances from Kolada (RKA) into data/external/kolada_*.csv.

https://api.kolada.se/v3 — keyless. v2 is gone and answers 410, so every path
here is v3: /v3/kpi?title=… to find a KPI, /v3/data/kpi/{kpi}/year/{year} to
read one indicator for every unit in one call (~3 500 units, of which the 290
four-digit codes are the kommuner).

KPI ids were resolved by searching, not guessed:
  N00901  Skattesats till kommun (%)                                  tax rate
  N03011  Verksamhetens nettokostnader, resultaträkningen kommun, kr/inv
  N03046  Långfristiga skulder kommunen, kr/inv                       debt
  N03002  Soliditet inkl pensionsåtagande, kommun (%)                 equity ratio

There is no population forecast in Kolada: /v3/kpi?title=prognos and
?title=folkmängd both return count 0. That part of the brief has no source here.

Writes one file per indicator, kommun;year;value, so each lands in the registry
the same way the Boverket and Kronofogden imports do.

Standard library only. Usage: python3 scripts/fetch_kolada.py [--years 11]
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request

API = "https://api.kolada.se/v3"
UA = {"User-Agent": "am-dashboard-se/1.1 (+https://github.com/real-estate-war-lord)"}

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "external"

KPIS = [
    ("kolada_tax", "N00901", "Skattesats till kommun (%)"),
    ("kolada_netcost", "N03011", "Verksamhetens nettokostnader kommun, kr/inv"),
    ("kolada_debt", "N03046", "Långfristiga skulder kommunen, kr/inv"),
    ("kolada_equity", "N03002", "Soliditet inkl pensionsåtagande, kommun (%)"),
]

RE_KOMMUN = re.compile(r"^\d{4}$")


def get(url: str, tries: int = 3):
    last = ""
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                return json.loads(r.read().decode("utf-8-sig"))
        except urllib.error.HTTPError as exc:
            last = f"HTTP {exc.code}"
            if exc.code in (429, 500, 502, 503, 504) and attempt < tries - 1:
                time.sleep(3 * (attempt + 1))
                continue
            raise RuntimeError(f"{last} for {url}") from None
        except (urllib.error.URLError, OSError) as exc:
            last = f"{type(exc).__name__}: {exc}"
            if attempt < tries - 1:
                time.sleep(3 * (attempt + 1))
                continue
            raise RuntimeError(last) from None
    raise RuntimeError(last)


def value_of(entry: dict):
    """The total-gender observation, or None when the unit has no figure."""
    for v in entry.get("values") or []:
        if v.get("gender") in ("T", None) and not v.get("isdeleted"):
            return v.get("value")
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--years", type=int, default=11)
    args = ap.parse_args()

    this_year = dt.date.today().year
    years = list(range(this_year - args.years, this_year + 1))
    OUT.mkdir(parents=True, exist_ok=True)
    failed = 0

    for name, kpi, label in KPIS:
        rows, got_years = [], []
        for year in years:
            try:
                payload = get(f"{API}/data/kpi/{kpi}/year/{year}")
            except RuntimeError as exc:
                print(f"  ⚠ {kpi} {year}: {exc}", file=sys.stderr)
                continue
            n = 0
            for e in payload.get("values") or []:
                code = str(e.get("municipality") or "")
                if not RE_KOMMUN.match(code) or code == "0000":
                    continue                      # regions, and 0000 = Riket
                v = value_of(e)
                if v is None:
                    continue                      # no figure — stays absent, never 0
                rows.append((code, year, v))
                n += 1
            if n:
                got_years.append((year, n))
        if not rows:
            print(f"  ⚠ {name} ({kpi}): nothing returned", file=sys.stderr)
            failed += 1
            continue
        path = OUT / f"{name}.csv"
        with path.open("w", encoding="utf-8", newline="") as fh:
            w = csv.writer(fh, delimiter=";")
            w.writerow(["kommun", "year", "value"])
            w.writerows(sorted(rows))
        span = f"{got_years[0][0]}–{got_years[-1][0]}"
        print(f"  {name:16s} {kpi}  {len(rows):5d} rows · {span} · "
              f"{got_years[-1][1]} kommuner in {got_years[-1][0]} · {label}")

    print(f"\nwrote {len(KPIS) - failed} of {len(KPIS)} files to {OUT}")
    return 1 if failed == len(KPIS) else 0


if __name__ == "__main__":
    raise SystemExit(main())
