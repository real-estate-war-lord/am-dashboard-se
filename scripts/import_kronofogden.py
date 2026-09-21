#!/usr/bin/env python3
"""Import Kronofogden's executive property sales into data/external/forced_sales.csv.

Input   data/external/raw/kronofogden/forced-sales-2010-2025.xlsx
Output  data/external/forced_sales.csv   lan;year;sold;value_sek

What the file actually contains, checked before anything was built on it: sheet
"Blad1" is a tidy long table of Egendomstyp (Bostadsrätt | Fastighet) x Län x År
2010-2025, with the number sold, the total market value and the sum of purchase
prices. **Län, not kommun** — there is no municipal breakdown, so the dashboard
cannot show this as a kommun measurement and says so where it renders.

(The first sheet, "Antal sålda", is a pivot of the same data covering only
2023-2025 despite the file name; Blad1 is the one with the full history.)

Standard library only. Usage: python3 scripts/import_kronofogden.py
"""
from __future__ import annotations

import csv
import pathlib
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "data" / "external" / "raw" / "kronofogden" / "forced-sales-2010-2025.xlsx"
OUT = ROOT / "data" / "external" / "forced_sales.csv"

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}

# Kronofogden names the län in capitals; SCB keys them by their two-digit code.
LAN = {
    "STOCKHOLMS": "01", "UPPSALA": "03", "SÖDERMANLANDS": "04", "ÖSTERGÖTLANDS": "05",
    "JÖNKÖPINGS": "06", "KRONOBERGS": "07", "KALMAR": "08", "GOTLANDS": "09",
    "BLEKINGE": "10", "SKÅNE": "12", "HALLANDS": "13", "VÄSTRA GÖTALANDS": "14",
    "VÄRMLANDS": "17", "ÖREBRO": "18", "VÄSTMANLANDS": "19", "DALARNAS": "20",
    "GÄVLEBORGS": "21", "VÄSTERNORRLANDS": "22", "JÄMTLANDS": "23",
    "VÄSTERBOTTENS": "24", "NORRBOTTENS": "25",
}


def col_index(ref: str) -> int:
    m = re.match(r"([A-Z]+)", ref or "A")
    n = 0
    for ch in m.group(1):
        n = n * 26 + ord(ch) - 64
    return n - 1


def sheet(path: pathlib.Path, want: str) -> list:
    z = zipfile.ZipFile(path)
    shared = ["".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t"))
              for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS)]
    rels = {r.get("Id"): r.get("Target")
            for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    node = next((s for s in wb.find("m:sheets", NS) if s.get("name") == want), None)
    if node is None:
        raise SystemExit(f"no sheet named {want!r} in {path.name}")
    target = "xl/" + rels[node.get(f"{{{NS['r']}}}id")].lstrip("/")
    rows = []
    for row in ET.fromstring(z.read(target)).iter(f"{{{NS['m']}}}row"):
        cells = {}
        for c in row.findall("m:c", NS):
            v, t = c.find("m:v", NS), c.get("t")
            if v is None:
                val = ""
            elif t == "s":
                i = int(v.text)
                val = shared[i] if i < len(shared) else ""
            else:
                val = v.text or ""
            cells[col_index(c.get("r"))] = val
        if cells:
            rows.append([cells.get(i, "") for i in range(max(cells) + 1)])
    return rows


def num(s):
    try:
        return float(str(s).replace("\xa0", "").replace(" ", "").replace(",", "."))
    except ValueError:
        return None


def lan_code(name: str) -> str | None:
    key = re.sub(r"\s*LÄN\s*$", "", (name or "").strip().upper())
    return LAN.get(key)


def main() -> int:
    if not SRC.exists():
        print(f"missing {SRC}", file=sys.stderr)
        return 1
    rows = sheet(SRC, "Blad1")
    head = [str(c).strip().lower() for c in rows[0]]

    def col(*words):
        for j, h in enumerate(head):
            if all(w in h for w in words):
                return j
        return None

    c_lan, c_year, c_n = col("län"), col("år"), col("antal")
    c_val = col("köpeskilling") or col("marknadsvärde")
    if None in (c_lan, c_year, c_n):
        print(f"unexpected header {head}", file=sys.stderr)
        return 1

    agg: dict = {}
    unknown = set()
    for r in rows[1:]:
        if len(r) <= max(c_lan, c_year, c_n):
            continue
        code = lan_code(r[c_lan])
        if not code:
            if r[c_lan]:
                unknown.add(r[c_lan])
            continue
        year = re.sub(r"\D", "", str(r[c_year]))
        if len(year) != 4:
            continue
        n, v = num(r[c_n]) or 0, (num(r[c_val]) if c_val is not None else None) or 0
        # the two property types are summed: one forced sale is one household
        s, t = agg.get((code, year), (0.0, 0.0))
        agg[(code, year)] = (s + n, t + v)

    if unknown:
        print(f"  ⚠ unmapped län names: {sorted(unknown)}", file=sys.stderr)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh, delimiter=";")
        w.writerow(["lan", "year", "sold", "value_sek"])
        for (code, year), (n, v) in sorted(agg.items()):
            w.writerow([code, year, int(n), int(v)])

    years = sorted({y for _, y in agg})
    print(f"wrote {OUT}: {len(agg)} län-years, {len(years)} years ({years[0]}–{years[-1]}), "
          f"{len({c for c, _ in agg})} län")
    for y in years[-4:]:
        print(f"  {y}: {int(sum(n for (c, yy), (n, _) in agg.items() if yy == y))} sold nationally")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
