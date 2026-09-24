#!/usr/bin/env python3
"""Recompute the Safety indicators for five kommuner straight from Brå.

A fresh SOL session, a fresh selection, five kommuner at a time — nothing here
reads data/raw/bra/ or data/external/. If the scraper, the cross-tab parser or
the rate arithmetic is wrong, the numbers disagree.

    python3 scripts/verify_bra.py
"""
from __future__ import annotations

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from fetch_bra import MENY_YEAR, OFFENCES, Sol                           # noqa: E402
from import_bra import clean, num                                        # noqa: E402
from se_common import PROC                                               # noqa: E402

SAMPLE = ["0180", "1480", "1280", "0331", "2418"]   # Sthlm, Gbg, Malmö, Heby, Malå
SCB = "https://api.scb.se/OV0104/v2beta/api/v2/tables/TAB824/data"
_DW_YEAR: list = []


def dwellings_from_api(code: str) -> float | None:
    """Total dwelling stock for one kommun, newest year, from SCB directly."""
    import urllib.parse
    from http_util import Throttle, get
    if not _DW_YEAR:
        st, body, _ = get("https://api.scb.se/OV0104/v2beta/api/v2/tables/TAB824"
                          "/metadata?lang=en")
        meta = json.loads(body)
        tids = list(((meta["dimension"]["Tid"].get("category") or {}).get("index") or {}))
        _DW_YEAR.append(tids[-1])
    q = [("lang", "en"), ("outputFormat", "json-stat2"),
         ("valueCodes[Region]", code), ("valueCodes[Tid]", _DW_YEAR[0]),
         ("valueCodes[ContentsCode]", "BO0104AH")]
    st, body, _ = get(SCB + "?" + urllib.parse.urlencode(q, safe=","))
    if st != 200:
        return None
    js = json.loads(body)
    return sum(v for v in (js.get("value") or []) if v is not None) or None
YEAR = "2025"
TOL = 0.005


def main() -> int:
    makro = json.loads((PROC / "makro.json").read_text(encoding="utf-8"))
    by = {k["code"]: k for k in makro["kommuner"]}
    name_of = {k["code"]: k["name"] for k in makro["kommuner"]}

    sol = Sol()
    reg = sol.regions(MENY_YEAR)
    per = {lab: pid for pid, lab in sol.periods(MENY_YEAR)}
    pid = next((v for k, v in per.items() if k == YEAR), None)
    if not pid:
        print(f"no period id for {YEAR}", file=sys.stderr)
        return 1

    checked = bad = 0
    for code in SAMPLE:
        nm = name_of.get(code)
        rid = reg.get(nm)
        if not rid:
            print(f"  {code} {nm}: no SOL region id"); bad += 1; continue
        e = by[code]
        print(f"\n{code} {nm}")
        for okey, codes in OFFENCES.items():
            body = sol.run(MENY_YEAR, codes, [rid], [pid]).decode("iso-8859-1")
            lines = [l for l in body.splitlines() if l.strip()]
            # sum the count and the rate over the rows we asked for
            want = {clean(l.split("*", 1)[1]) for l in []}   # labels resolved below
            labels = {}
            for row in sol.array(MENY_YEAR, "arrayNivaett"):
                cid, lab = row.split("*", 1)
                labels[cid] = clean(lab)
            want = {labels[c] for c in codes}
            cnt = rate = 0.0
            for l in lines:
                cells = l.replace("&nbsp;", " ").split(";")
                if clean(cells[0]) not in want:
                    continue
                vs = [num(c) for c in cells[1:]]
                if vs and vs[0] is not None:
                    cnt += vs[0]
                if len(vs) > 1 and vs[1] is not None:
                    rate += vs[1]

            ind = {"total": "crime_1000", "person": "violence_1000",
                   "theft": "theft_1000", "burglary": "burglary_1000dw",
                   "vandalism": "vandalism_1000",
                   "drugs_weapons": "drugs_weapons_1000"}[okey]
            hist = (e.get("hist") or {}).get(ind) or {}
            got = hist.get(YEAR)
            checked += 1
            if got is None:
                print(f"   ✗ {ind:20s} missing from the build"); bad += 1; continue
            if okey == "burglary":
                # per 1 000 dwellings: Brå's count over SCB's stock. Both halves
                # are recomputed here — the count from this SOL session, the
                # stock straight from the SCB API, so neither comes from our own
                # processed files.
                dw = dwellings_from_api(code)
                if not dw:
                    print(f"   ? {ind:20s} no dwelling stock from the API"); continue
                want_v = cnt / dw * 1000.0
                ok = abs(got - want_v) <= 0.01
                print(f"   {'✓' if ok else '✗'} {ind:20s} page {got:>10.3f}   "
                      f"recomputed {want_v:>10.3f}  ({cnt:,.0f} / {dw:,.0f} dwellings)")
                if not ok:
                    bad += 1
                continue
            want_v = rate / 100.0
            ok = abs(got - want_v) <= TOL
            print(f"   {'✓' if ok else '✗'} {ind:20s} page {got:>10.3f}   "
                  f"Brå {want_v:>10.3f}  (rate {rate:,.0f}/100k, count {cnt:,.0f})")
            if not ok:
                bad += 1

    print(f"\n{checked - bad} of {checked} recomputed values match Brå (tolerance {TOL})")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
