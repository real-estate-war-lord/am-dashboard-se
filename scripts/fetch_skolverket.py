#!/usr/bin/env python3
"""Every school unit with year 9, and its year-9 results, from Skolverket.

Three passes, each resumable and each cached on disk so a re-run costs nothing:

  1. the unit list (47 pages of 100), filtered to units that actually teach
     year 9 — `typeOfSchooling[].schoolYears` says so, so no extra call;
  2. one detail call per unit, for `wgs84_Lat`/`wgs84_Long` and the kommun code.
     Skolenhetsregistret does NOT carry coordinates — it is code, kommun, org nr,
     name and status only — so the brief's route does not exist and this is the
     one that does;
  3. one `/statistics/gr` call per unit.

`valueType` is kept verbatim. Skolverket suppresses and rounds:
  EXISTS · OMITTED_DUE_TO_BASED_ON_FEW_PUPILS (`..`) ·
  ROUNDED_OFF_DUE_TO_FEW_PUPILS_NOT_ELIGIBLE (`~100`)
and `totalNumberOfPupils` can be a band such as "cirka 1100". None of those are
numbers and none of them are zero.

    python3 scripts/fetch_skolverket.py             # resume
    python3 scripts/fetch_skolverket.py --limit 50  # a slice, for a smoke run
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from http_util import Throttle, get                                      # noqa: E402
from se_common import ROOT                                               # noqa: E402

API = "https://api.skolverket.se/planned-educations/v4"
OUT = ROOT / "data" / "raw" / "skolverket"
HDRS = {"Accept": "*/*"}                    # the API 406s on application/json
THR = Throttle(12, 1.0)                     # no published limit; stay polite


def jget(url: str) -> dict | None:
    status, body, _ = get(url, headers=HDRS, throttle=THR, timeout=60)
    if status != 200:
        return None
    try:
        return json.loads(body)
    except Exception:                                                    # noqa: BLE001
        return None


def has_year9(unit: dict) -> bool:
    for t in unit.get("typeOfSchooling") or []:
        if t.get("code") == "gr" and "9" in (t.get("schoolYears") or []):
            return True
    return False


def fetch_list() -> list[dict]:
    path = OUT / "units.json"
    if path.exists():
        units = json.loads(path.read_text(encoding="utf-8"))
        print(f"unit list cached: {len(units):,} units with year 9")
        return units
    units, page = [], 0
    while True:
        d = jget(f"{API}/school-units?size=100&page={page}&typeOfSchooling=gr")
        if not d:
            print(f"  page {page} failed — stopping the enumeration", file=sys.stderr)
            break
        body = d.get("body") or {}
        got = (body.get("_embedded") or {}).get("listedSchoolUnits") or []
        units += [u for u in got if has_year9(u)]
        pg = body.get("page") or {}
        if page == 0:
            print(f"  {pg.get('totalElements')} grundskola units over {pg.get('totalPages')} pages")
        page += 1
        if page >= (pg.get("totalPages") or 0):
            break
        if page % 10 == 0:
            print(f"  page {page} · {len(units):,} with year 9 so far", flush=True)
    path.write_text(json.dumps(units, ensure_ascii=False), encoding="utf-8")
    print(f"unit list: {len(units):,} units teach year 9")
    return units


def fetch_each(units: list[dict], kind: str, url: str, limit: int | None) -> int:
    """One call per unit into data/raw/skolverket/<kind>/<code>.json."""
    d = OUT / kind
    d.mkdir(parents=True, exist_ok=True)
    todo = [u for u in units if not (d / f"{u['code']}.json").exists()]
    cached = len(units) - len(todo)          # count BEFORE --limit trims the list
    if limit:
        todo = todo[:limit]
    print(f"{kind}: {cached:,} cached, {len(todo):,} to fetch")
    t0, done, failed = time.time(), 0, 0
    for i, u in enumerate(todo, 1):
        code = u["code"]
        js = jget(url.format(code=code))
        if js is None:
            # a unit with no statistics is a real answer, not an error; record it
            # so the pass does not retry it forever
            (d / f"{code}.json").write_text(json.dumps({"_missing": True}), encoding="utf-8")
            failed += 1
        else:
            (d / f"{code}.json").write_text(json.dumps(js, ensure_ascii=False), encoding="utf-8")
            done += 1
        if i % 250 == 0:
            rate = i / max(1e-9, time.time() - t0)
            print(f"  {i:,}/{len(todo):,} · {rate:.1f}/s · "
                  f"~{(len(todo) - i) / max(rate, 1e-9) / 60:.1f} min left", flush=True)
    print(f"{kind}: {done:,} fetched, {failed:,} with no data")
    return done


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int)
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)

    units = fetch_list()
    if not units:
        return 1
    fetch_each(units, "unit", API + "/school-units/{code}", a.limit)
    fetch_each(units, "gr", API + "/school-units/{code}/statistics/gr", a.limit)
    print(f"\nraw under {OUT.relative_to(ROOT)} — Källa: Skolverket")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
