#!/usr/bin/env python3
"""Skolinspektionen's Skolenkäten — the trygghet and studiero indices per school.

Machine-readable xlsx, read with zipfile + regex rather than a spreadsheet
library: the file is a flat cross-tab and the two numbers we want sit in known
columns under known headers, which are matched by NAME here so a layout change
fails loudly instead of silently shifting a column.

Two things the source demands:

  * **The survey runs on a rotation, not every year.** "Skolenkäten genomförs på
    huvudmannanivå" — a kommun and the independent schools in it take part
    together, roughly every other year. One year alone covers about half the
    country, so this unions the two most recent rounds and records which year
    each school's figure comes from. Nothing is carried forward beyond that.
  * **At least five respondents are needed for an index**, and a genuine zero is
    printed as 0 while a masked cell is blank. They must not be conflated — the
    same trap as the RegSO `0`-vs-null issue in CLAUDE.md.

    python3 scripts/import_skolenkaten.py
"""
from __future__ import annotations

import csv
import pathlib
import re
import sys
import zipfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from http_util import get                                                # noqa: E402
from se_common import ROOT                                               # noqa: E402

BASE = ("https://www.skolinspektionen.se/globalassets/02-beslut-rapporter-stat/"
        "statistik/statistik-skolenkaten/{year}/skolenkaten-elever-grundskola-"
        "ak-8-{year}.xlsx")
RAW = ROOT / "data" / "raw" / "skolenkaten"
EXT = ROOT / "data" / "external"
YEARS = ["2026", "2025"]                 # newest first; the union covers the rotation

# the frågeområde headers we want, matched by name in row 1
WANT = {"9. Trygghet": "trygghet", "8. Studiero": "studiero"}


def col_num(ref: str) -> int:
    n = 0
    for ch in ref:
        n = n * 26 + (ord(ch) - 64)
    return n


def read_sheet(data: bytes):
    z = zipfile.ZipFile(pathlib.Path(RAW / "tmp.xlsx")) if False else zipfile.ZipFile(
        __import__("io").BytesIO(data))
    shared = ["".join(re.findall(r"<t[^>]*>(.*?)</t>", si, re.S))
              for si in re.findall(r"<si>(.*?)</si>",
                                   z.read("xl/sharedStrings.xml").decode("utf-8"), re.S)]
    sheet = z.read("xl/worksheets/sheet1.xml").decode("utf-8")
    rows = {}
    for rn, body in re.findall(r"<row[^>]*r=\"(\d+)\"[^>]*>(.*?)</row>", sheet, re.S):
        cells = {}
        for ref, t, v in re.findall(
                r'<c r="([A-Z]+)\d+"(?:[^>]*t="(\w+)")?[^>]*>(?:<v>(.*?)</v>)?', body):
            cells[ref] = shared[int(v)] if (t == "s" and v) else v
        rows[int(rn)] = cells
    return rows


def main() -> int:
    RAW.mkdir(parents=True, exist_ok=True)
    EXT.mkdir(parents=True, exist_ok=True)
    out: dict[str, dict] = {}
    covered = []

    for year in YEARS:
        path = RAW / f"ak8_{year}.xlsx"
        if not path.exists():
            st, body, _ = get(BASE.format(year=year), timeout=120)
            if st != 200:
                print(f"  {year}: HTTP {st} — skipped", file=sys.stderr)
                continue
            path.write_bytes(body)
        data = path.read_bytes()
        rows = read_sheet(data)

        head = rows.get(1) or {}
        sub = rows.get(3) or {}
        # locate each wanted frågeområde by NAME, then its Index column
        cols = {}
        for ref, val in head.items():
            name = (val or "").strip()
            if name in WANT:
                if (sub.get(ref) or "").strip() != "Index":
                    print(f"  {year}: '{name}' at {ref} is not an Index column "
                          f"(row 3 says {sub.get(ref)!r}) — layout changed, skipping",
                          file=sys.stderr)
                    continue
                cols[WANT[name]] = ref
        if not cols:
            print(f"  {year}: no Trygghet/Studiero index columns found — skipped",
                  file=sys.stderr)
            continue

        n = 0
        for rn in sorted(rows):
            if rn < 5:
                continue
            c = rows[rn]
            code = (c.get("D") or "").strip()
            if not code or not code.isdigit():
                continue
            rec = {"code": code, "year": year,
                   "kommun": (c.get("C") or "").strip(),
                   "respondents": c.get("G"), "response_rate": c.get("H")}
            got = False
            for key, ref in cols.items():
                v = c.get(ref)
                # blank = masked (under five respondents); "0" would be a real zero
                if v is None or v == "":
                    continue
                try:
                    rec[key] = round(float(v), 2)
                    got = True
                except ValueError:
                    continue
            if not got:
                continue
            # newest year wins; an older round only fills a school the new one missed
            if code not in out:
                out[code] = rec
                n += 1
        covered.append((year, n))
        print(f"  {year}: {n:,} schools with an index "
              f"({', '.join(f'{k}={v}' for k, v in cols.items())})")

    if not out:
        print("no Skolenkäten data — nothing written", file=sys.stderr)
        return 1

    p = EXT / "skolenkaten.csv"
    with p.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, delimiter=";")
        w.writerow(["skolenhetskod", "year", "trygghet", "studiero",
                    "respondents", "response_rate"])
        for code in sorted(out):
            r = out[code]
            w.writerow([code, r["year"], r.get("trygghet", ""), r.get("studiero", ""),
                        r.get("respondents", ""), r.get("response_rate", "")])
    print(f"wrote {p.relative_to(ROOT)} · {len(out):,} schools "
          f"({' + '.join(f'{y}: {n}' for y, n in covered)}) — Källa: Skolinspektionen")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
