#!/usr/bin/env python3
"""Turn Brå's SOL exports into tidy CSVs the build can read.

SOL's export is a cross-tab meant for a spreadsheet, not a data feed:

  * the header is several stacked rows — a yearly file has "År" then the year,
    a quarterly file has the year then "Kvartal N" — so the period label has to
    be assembled from every header row above the `Antal` row rather than read
    off a fixed line;
  * each column appears twice, once as a count and once as per 100 000
    inhabitants;
  * a region is a row of its own with empty cells, and the offence rows follow
    it until the next region;
  * a nested selection drags its ancestors along as rows of `..`, which means
    "not selected", NOT zero. They are matched out by label against what the
    fetcher recorded it asked for.

Writes data/external/bra_crime.csv and bra_crime_quarterly.csv:
    kommun;period;key;count;per100k;preliminary

`period` is always `YYYY` or `YYYYKn`. SOL labels a not-yet-final quarter
"2026 prel." in the header row, which used to travel all the way to the page as
the period key AND the option label ("2026 prel.K1") — ugly, unsortable, and it
broke the period control's "latest" logic so the newest quarter never appeared in
the list at all. The word is stripped here and carried as `preliminary=1`, which
is what the UI renders as a small "prel." badge beside the period.

    python3 scripts/import_bra.py
"""
from __future__ import annotations

import csv
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from se_common import PROC, ROOT                                         # noqa: E402

RAW = ROOT / "data" / "raw" / "bra"
OUT = ROOT / "data" / "external"

NBSP = re.compile(r"(?:&nbsp;|\xa0|\\xA0)")
# "2026 prel.", "2026 prel", "2026 preliminär" — every spelling SOL has used
PREL = re.compile(r"\s*\bprel(?:iminär|iminary|\.)?\.?\s*", re.I)
PERIOD = re.compile(r"\d{4}(?:K[1-4])?")


def clean(s: str) -> str:
    return NBSP.sub(" ", s).strip()


def norm_period(label: str) -> tuple[str, bool]:
    """A SOL header label -> (`YYYY` or `YYYYKn`, is it preliminary).

    Anything that does not reduce to a period is returned as-is with the flag,
    so an unexpected label shows up in the output instead of being dropped."""
    prel = bool(PREL.search(label))
    out = PREL.sub("", label).strip()
    return (out if PERIOD.fullmatch(out) else label.strip()), prel


def num(s: str):
    """A SOL cell. `..` is 'not selected', an empty cell is 'no value' — both
    stay None. Never 0: a kommun with no reported burglaries and a kommun whose
    figure was not requested must not look the same."""
    s = clean(s).replace(" ", "")
    if not s or s in ("..", "-", "–"):
        return None
    try:
        return float(s.replace(",", "."))
    except ValueError:
        return None


def parse(path: pathlib.Path) -> tuple[list[str], set[str], dict[str, dict[str, dict]]]:
    """-> (periods, preliminary periods, {region: {offence: {period: (count, per100k)}}})"""
    # `&nbsp;` ENDS IN A SEMICOLON, which is also the field separator, so the
    # measure row `Antal;/100&nbsp;000&nbsp;inv;…` splits into twice as many
    # fields as the data rows and every column index after it is wrong. Decode
    # the entity before splitting, not after. (The first cut of this parser
    # survived only because the surplus columns fell off the end.)
    raw = path.read_text("iso-8859-1").replace("&nbsp;", "\u00a0")
    lines = raw.splitlines()
    # the measure row is the last header row; everything between the title and it
    # describes the periods
    mi = next(i for i, l in enumerate(lines) if clean(l.split(";")[1] if ";" in l else "") == "Antal")
    head = [l.split(";") for l in lines[1:mi]]
    meas = [clean(c) for c in lines[mi].split(";")]

    ncol = len(meas)
    periods: list[str] = []
    prel: set[str] = set()
    for c in range(1, ncol):
        parts = [clean(r[c]) for r in head if c < len(r) and clean(r[c]) and clean(r[c]) != "År"]
        lab = ""
        for p in parts:
            m = re.fullmatch(r"Kvartal (\d)", p)
            lab = (lab + "K" + m.group(1)) if m else (p if not lab else lab + p)
        lab, is_prel = norm_period(lab) if lab else ("", False)
        if is_prel and lab:
            prel.add(lab)
        periods.append(lab)

    out: dict[str, dict[str, dict]] = {}
    region = None
    for l in lines[mi + 1:]:
        cells = l.split(";")
        name = clean(cells[0])
        if not name or name == "Anmälda brott":
            continue
        vals = [num(c) for c in cells[1:ncol]]
        if all(v is None for v in vals) and " kommun" in name:
            # SOL disambiguates a kommun that changed län with a parenthetical:
            # "Heby kommun (Uppsala län from 2007)". Strip it — the fetcher
            # already chose which of the two entities to ask for, and only that
            # one is in the export.
            region = re.sub(r"\s*\(.*?\)\s*$", "", name)
            if not region.endswith(" kommun"):
                continue
            region = region[:-7].strip()
            out.setdefault(region, {})
            continue
        if region is None:
            continue
        per: dict[str, tuple] = {}
        for c in range(0, len(vals) - 1, 2):
            p = periods[c] if c < len(periods) else ""
            if p:
                per[p] = (vals[c], vals[c + 1])
        out[region][name] = per
    return periods, prel, out


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    makro = json.loads((PROC / "makro.json").read_text(encoding="utf-8"))
    code_of = {k["name"]: k["code"] for k in makro["kommuner"]}

    rows, qrows = [], []
    for meta_path in sorted(RAW.glob("*.meta.json")):
        key = meta_path.stem.replace(".meta", "")
        csv_path = RAW / f"{key}.csv"
        if not csv_path.exists():
            continue
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        wanted = {clean(v) for v in (meta.get("labels") or {}).values()}
        periods, prel, data = parse(csv_path)
        n = 0
        for region, offences in data.items():
            code = code_of.get(region)
            if not code:
                continue
            # sum the rows we actually asked for; ignore the `..` ancestors
            acc: dict[str, list] = {}
            for lab, per in offences.items():
                if clean(lab) not in wanted:
                    continue
                for p, (cnt, rate) in per.items():
                    if cnt is None:
                        continue
                    a = acc.setdefault(p, [0.0, 0.0, 0])
                    a[0] += cnt
                    if rate is not None:
                        a[1] += rate
                    a[2] += 1
            for p, (cnt, rate, k) in acc.items():
                rows.append([code, p, key, int(round(cnt)),
                             round(rate, 2) if k else "", "1" if p in prel else ""])
                n += 1
        print(f"  {key:16s} {n:,} kommun-periods · {len(set(p for p in periods if p))} periods · "
              f"{len(wanted)} offence row(s)"
              + (f" · preliminary: {', '.join(sorted(prel))}" if prel else ""))

    qcsv = RAW / "total_quarterly.csv"
    if qcsv.exists():
        periods, prel, data = parse(qcsv)
        for region, offences in data.items():
            code = code_of.get(region)
            if not code:
                continue
            for lab, per in offences.items():
                if "Totalt antal brott" not in clean(lab):
                    continue
                for p, (cnt, rate) in per.items():
                    if cnt is None:
                        continue
                    qrows.append([code, p, "total", int(round(cnt)),
                                  round(rate, 2) if rate is not None else "",
                                  "1" if p in prel else ""])
        bad = sorted({p for _c, p, *_r in qrows if not PERIOD.fullmatch(p)})
        if bad:
            print(f"  ⚠ quarterly periods that are not YYYYKn: {bad}")
        print(f"  {'quarterly':16s} {len(qrows):,} kommun-quarters · "
              f"{len(set(p for p in periods if p))} periods"
              + (f" · preliminary: {', '.join(sorted(prel))}" if prel else ""))

    for name, data in (("bra_crime.csv", rows), ("bra_crime_quarterly.csv", qrows)):
        if not data:
            continue
        p = OUT / name
        with p.open("w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh, delimiter=";")
            w.writerow(["kommun", "period", "key", "count", "per100k", "preliminary"])
            w.writerows(sorted(data))
        print(f"wrote {p.relative_to(ROOT)} · {len(data):,} rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
