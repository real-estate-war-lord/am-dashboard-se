#!/usr/bin/env python3
"""Import Boverket's Bostadsmarknadsenkät into data/external/bme.csv.

Input   data/external/raw/bme/bme-<year>.zip   (2020–2025, one workbook per theme)
        data/external/raw/bme/bme-2026.xlsx    (the current year, a single sheet)
Output  data/external/bme.csv                  kommun;year;status

One question out of the ~60 in the survey: "Hur bedömer ni för närvarande
kommunens bostadsmarknadsläge? [I kommunen som helhet]" — the kommun's own
assessment of whether it has a shortage, a balance or a surplus of housing.

Columns move between years, so the header is matched on its text rather than
its position: the answer column is the one asking about the situation now
(not "om tre år") for the kommun as a whole (not the central town or the rest
of it). If that column cannot be found the year is skipped with a warning
rather than guessed at.

xlsx is read with the standard library — it is a zip of XML.

Licence: Boverket require attribution. Every row carries
"Boverket, Bostadsmarknadsenkäten" through to the page.

Usage: python3 scripts/import_bme.py
"""
from __future__ import annotations

import csv
import io
import pathlib
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "external" / "raw" / "bme"
OUT = ROOT / "data" / "external" / "bme.csv"

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}

def classify(answer: str) -> str | None:
    """Shortage / balance / surplus, whatever the year's wording.

    2022 onwards says "Underskott på bostadsmarknaden"; 2020 and 2021 said
    "Obalans - underskott på bostäder". Taking the first word therefore read
    "obalans" and silently dropped every shortage and surplus row, leaving
    those two years looking like 100 % balance. Match on content, and test
    under/över before balans — "obalans" contains "balans".
    """
    a = norm(answer)
    if not a:
        return None
    if "underskott" in a:
        return "shortage"
    if "överskott" in a:
        return "surplus"
    if "balans" in a and "obalans" not in a:
        return "balance"
    return None


# ---------------------------------------------------------------- xlsx

def _col_index(ref: str) -> int:
    m = re.match(r"([A-Z]+)", ref or "A")
    n = 0
    for ch in m.group(1):
        n = n * 26 + ord(ch) - 64
    return n - 1


def sheet_rows(data) -> list:
    """First worksheet of an xlsx, as a list of row-lists of strings."""
    z = zipfile.ZipFile(data)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            shared.append("".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t")))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = {r.get("Id"): r.get("Target")
            for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    first = wb.find("m:sheets", NS)[0]
    target = rels.get(first.get(f"{{{NS['r']}}}id")) or "worksheets/sheet1.xml"
    path = "xl/" + target.lstrip("/")
    if path not in z.namelist():
        path = next(n for n in z.namelist() if n.startswith("xl/worksheets/sheet"))
    rows = []
    for row in ET.fromstring(z.read(path)).iter(f"{{{NS['m']}}}row"):
        cells = {}
        for c in row.findall("m:c", NS):
            v, t = c.find("m:v", NS), c.get("t")
            if t == "inlineStr":
                isx = c.find("m:is", NS)
                val = "".join(x.text or "" for x in isx.iter(f"{{{NS['m']}}}t")) if isx is not None else ""
            elif v is None:
                val = ""
            elif t == "s":
                i = int(v.text)
                val = shared[i] if i < len(shared) else ""
            else:
                val = v.text or ""
            cells[_col_index(c.get("r"))] = val
        if cells:
            rows.append([cells.get(i, "") for i in range(max(cells) + 1)])
    return rows


# ---------------------------------------------------------------- parsing

def norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


def find_header(rows: list) -> int | None:
    for i, r in enumerate(rows[:20]):
        cells = [norm(c) for c in r]
        if any(c.startswith("kommunkod") for c in cells) and any(c == "kommun" for c in cells):
            return i
    return None


def find_columns(header: list) -> tuple[int | None, int | None]:
    """(kommunkod column, answer column)."""
    kod = ans = None
    for j, c in enumerate(header):
        n = norm(c)
        if kod is None and n.startswith("kommunkod"):
            kod = j
        if ans is None and "bostadsmarknadsläge" in n and "som helhet" in n and "tre år" not in n:
            ans = j
    return kod, ans


def parse(rows: list, year: int, warn) -> dict:
    hi = find_header(rows)
    if hi is None:
        warn(f"{year}: no header row with Kommunkod + Kommun")
        return {}
    kod, ans = find_columns(rows[hi])
    if kod is None or ans is None:
        warn(f"{year}: could not locate the 'I kommunen som helhet' column (kod={kod}, ans={ans})")
        return {}
    out = {}
    for r in rows[hi + 1:]:
        if len(r) <= max(kod, ans):
            continue
        raw = re.sub(r"\D", "", str(r[kod]))
        if not raw or len(raw) > 4:
            continue
        code = raw.zfill(4)
        if code == "0000":
            continue
        status = classify(r[ans])
        if status:                      # a kommun that did not answer stays absent
            out[code] = status
    return out


def workbook_for(year: int, warn):
    """The 'Läget på bostadsmarknaden' workbook for one year, as rows."""
    xlsx = RAW / f"bme-{year}.xlsx"
    if xlsx.exists():
        return sheet_rows(xlsx)
    zp = RAW / f"bme-{year}.zip"
    if not zp.exists():
        warn(f"{year}: neither bme-{year}.xlsx nor bme-{year}.zip on disk")
        return None
    z = zipfile.ZipFile(zp)
    # Names drift: "Läget på bostadsmarknaden & Bostadsbyggande - 2020.xlsx",
    # "... och bostadsbyggande - BME 2025.xlsx", sometimes inside a folder.
    cands = [n for n in z.namelist()
             if n.lower().endswith(".xlsx") and "bostadsmarknaden" in n.lower()
             and "analysdatabas" not in n.lower()]
    if not cands:
        warn(f"{year}: no 'Läget på bostadsmarknaden' workbook inside {zp.name}")
        return None
    return sheet_rows(io.BytesIO(z.read(sorted(cands, key=len)[0])))


def main() -> int:
    warnings: list[str] = []

    def warn(m: str) -> None:
        warnings.append(m)
        print(f"  ⚠ {m}", file=sys.stderr)

    years = sorted(int(m.group(1)) for p in RAW.iterdir()
                   for m in [re.search(r"bme-(\d{4})\.(zip|xlsx)$", p.name)] if m)
    if not years:
        print(f"nothing in {RAW} — download the BME files first", file=sys.stderr)
        return 1

    rows_out = []
    for year in years:
        rows = workbook_for(year, warn)
        if rows is None:
            continue
        got = parse(rows, year, warn)
        counts: dict = {}
        for code, st in sorted(got.items()):
            rows_out.append((code, year, st))
            counts[st] = counts.get(st, 0) + 1
        print(f"  {year}: {len(got):3d} kommuner · " +
              " · ".join(f"{k} {v}" for k, v in sorted(counts.items())))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh, delimiter=";")
        w.writerow(["kommun", "year", "status"])
        w.writerows(rows_out)
    print(f"\nwrote {OUT}: {len(rows_out)} rows, {len(years)} years "
          f"({years[0]}–{years[-1]})")
    if warnings:
        print(f"{len(warnings)} warning(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
