#!/usr/bin/env python3
"""Pull the two Riksbank series the macro panel needs, from the SWEA API.

  SECBREPOEFF  policy rate (styrränta), daily
  SEGVB10YC    10-year government bond yield, daily

https://api.riksbank.se/swea/v1/Observations/{series}/{from}/{to} — keyless,
JSON, one object per observation {date, value}. Non-trading days are simply
absent rather than null.

Writes data/raw/riksbank_<series>.json:
  {"series": ..., "label": ..., "unit": "%", "fetched": ..., "from": ..., "to": ...,
   "obs": [{"t": "2026-09-19", "v": 1.75}, ...]}

Daily observations are thinned to month-end before writing: the dashboard
charts monthly, and 24 months of daily data is ~500 points per series for no
visible gain. `--daily` keeps every observation.

Standard library only. Usage: python3 scripts/fetch_riksbank.py [--months 24] [--daily]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import sys
import urllib.error
import urllib.request

API = "https://api.riksbank.se/swea/v1/Observations"
UA = {"User-Agent": "am-dashboard-se/1.0 (+https://github.com/real-estate-war-lord)"}

ROOT = pathlib.Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"

SERIES = [
    ("SECBREPOEFF", "Policy rate (styrränta)"),
    ("SEGVB10YC", "Government bond, 10 yr"),
]


def get(url: str, tries: int = 3):
    last = ""
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=120) as resp:
                return json.loads(resp.read().decode("utf-8-sig"))
        except urllib.error.HTTPError as exc:
            last = f"HTTP {exc.code} {exc.read().decode('utf-8', 'replace')[:200]}"
            if exc.code in (429, 500, 502, 503, 504) and attempt < tries - 1:
                continue
            raise RuntimeError(last) from None
        except (urllib.error.URLError, OSError) as exc:
            last = f"{type(exc).__name__}: {exc}"
            if attempt < tries - 1:
                continue
            raise RuntimeError(last) from None
    raise RuntimeError(last or "unknown error")


def month_end(obs: list) -> list:
    """Last observation of each calendar month, in order."""
    by: dict = {}
    for o in obs:
        by[o["t"][:7]] = o          # obs arrive oldest-first; last write wins
    return [by[k] for k in sorted(by)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--months", type=int, default=24)
    ap.add_argument("--daily", action="store_true", help="keep every observation")
    args = ap.parse_args()

    today = dt.date.today()
    start = (today.replace(day=1) - dt.timedelta(days=31 * args.months)).replace(day=1)
    RAW.mkdir(parents=True, exist_ok=True)

    failed = 0
    for series, label in SERIES:
        url = f"{API}/{series}/{start.isoformat()}/{today.isoformat()}"
        print(f"→ {series}  {start} … {today}", flush=True)
        try:
            payload = get(url)
        except RuntimeError as exc:
            print(f"  FAILED: {exc}", file=sys.stderr)
            failed += 1
            continue
        obs = [{"t": o["date"], "v": o["value"]}
               for o in payload if o.get("value") is not None]
        obs.sort(key=lambda o: o["t"])
        if not obs:
            print("  no observations returned", file=sys.stderr)
            failed += 1
            continue
        kept = obs if args.daily else month_end(obs)
        out = {"series": series, "label": label, "unit": "%",
               "fetched": today.isoformat(), "from": start.isoformat(), "to": today.isoformat(),
               "granularity": "daily" if args.daily else "month-end",
               "obs": kept}
        path = RAW / f"riksbank_{series}.json"
        path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"  ok · {len(obs)} observations → {len(kept)} kept · latest {kept[-1]['t']} = {kept[-1]['v']} %")

    if failed:
        print(f"\n{failed} series failed — policy_rate / bond_10y will show 'no data'", file=sys.stderr)
    return 1 if failed == len(SERIES) else 0


if __name__ == "__main__":
    raise SystemExit(main())
