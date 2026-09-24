#!/usr/bin/env python3
"""Recompute five schools one by one straight from Skolverket's API.

Nothing here reads data/raw/skolverket/ or data/processed/: it calls the API
again for each school and compares with what the built page carries, including
the suppression reasons, which must survive as reasons and not become zeros.

    python3 scripts/verify_schools.py
"""
from __future__ import annotations

import json
import pathlib
import random
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from build_schools import METRICS, PUPILS, newest, num, pupils_of        # noqa: E402
from http_util import Throttle, get                                     # noqa: E402
from se_common import PROC                                              # noqa: E402

API = "https://api.skolverket.se/planned-educations/v4"
HDRS = {"Accept": "*/*"}
THR = Throttle(8, 1.0)
TOL = 0.05


def jget(url):
    st, body, _ = get(url, headers=HDRS, throttle=THR, timeout=60)
    return json.loads(body) if st == 200 else None


def main() -> int:
    sj = json.loads((PROC / "schools.json").read_text(encoding="utf-8"))
    files = sorted((PROC / "schools").glob("*.json"))
    random.seed(7)
    pool = []
    for f in random.sample(files, 12):
        pool += json.loads(f.read_text(encoding="utf-8"))
    # one big, one tiny, one suppressed, plus two at random
    pool.sort(key=lambda s: -(s.get("pupils") or 0))
    picks = [pool[0], pool[-1]]
    supp = next((s for s in pool if s.get("merit") is None), None)
    if supp:
        picks.append(supp)
    picks += random.sample([s for s in pool if s not in picks], 2)

    checked = bad = 0
    for s in picks:
        d = jget(f"{API}/school-units/{s['code']}")
        g = jget(f"{API}/school-units/{s['code']}/statistics/gr")
        if d is None:
            print(f"  {s['code']}: detail call failed"); bad += 1; continue
        det = d.get("body") or {}
        b = (g or {}).get("body") or {}
        print(f"\n{s['code']} {s['name']}  ({det.get('geographicalAreaCode')})")

        for what, page, api in (("lat", s["lat"], num(det.get("wgs84_Lat"))),
                                ("lon", s["lon"], num(det.get("wgs84_Long")))):
            checked += 1
            ok = api is not None and abs(page - api) < 1e-5
            print(f"   {'✓' if ok else '✗'} {what:12s} page {page}   API {api}")
            if not ok:
                bad += 1

        checked += 1
        api_p = pupils_of((b.get(PUPILS) or [{}])[0].get("value")) if b.get(PUPILS) else None
        ok = s.get("pupils") == api_p
        print(f"   {'✓' if ok else '✗'} {'pupils':12s} page {s.get('pupils')}   API {api_p} "
              f"(band, whole unit)")
        if not ok:
            bad += 1

        for field, (short, dec) in METRICS.items():
            v, per, vt = newest(b.get(field))
            want = round(v, dec) if v is not None else None
            got = s.get(short)
            checked += 1
            ok = (want is None and got is None) or (
                want is not None and got is not None and abs(got - want) <= TOL)
            note = "" if want is not None else f"  [{vt}]"
            print(f"   {'✓' if ok else '✗'} {short:12s} page {got}   API {want} "
                  f"({per}){note}")
            if not ok:
                bad += 1
            if want is None and got is None:
                # the reason must survive, not be replaced by a number
                if s.get(short + "_why") != vt:
                    print(f"      ! reason drifted: page says {s.get(short + '_why')}, API {vt}")
                    bad += 1
                    checked += 1

    print(f"\n{checked - bad} of {checked} values match the API")
    nm = (sj.get("meta") or {}).get("national_merit")
    print(f"national pupil-weighted merit value: {nm}")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
