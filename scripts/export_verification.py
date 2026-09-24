#!/usr/bin/env python3
"""The v1.2 verification export: every kommun × every new indicator, in one CSV.

Long format, one row per (level, code, name, indicator, value, as-of), so a
reader can open it in a spreadsheet, filter to an indicator and check the
dashboard against it — or hand the whole thing to something else and ask it to
find an outlier. Suppressed and not-mapped values are written as EMPTY, never as
0, and the `status` column says which it is.

    python3 -u scripts/export_verification.py
"""
from __future__ import annotations

import csv
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from se_common import PROC, ROOT                                         # noqa: E402

OUT = ROOT / "docs" / "verification" / "parity_v1_2.csv"
NEW_GROUPS = {"Outlook", "Safety", "Schools", "Climate", "Growth signals"}


def main() -> int:
    makro = json.loads((PROC / "makro.json").read_text(encoding="utf-8"))
    inds = [i for i in makro["indicators"] if i.get("group") in NEW_GROUPS]
    print(f"{len(inds)} indicators in the v1.2 groups")

    rows = []
    for m in makro["kommuner"]:
        for i in inds:
            v = m.get(i["key"])
            asof = (i.get("asof") or {}).get("kommun") or ""
            status = "value" if v is not None else (
                "not mapped" if i.get("no_inherit") else "not published")
            rows.append(["kommun", m["code"], m["name"], i["group"], i["key"],
                         i["label"], "" if v is None else v, i.get("unit", ""),
                         asof, status])

    # 30 sampled schools, spread across the country by kommun code
    sch_dir = PROC / "schools"
    picked = []
    if sch_dir.exists():
        files = sorted(sch_dir.glob("*.json"))
        step = max(1, len(files) // 30)
        for fp in files[::step][:30]:
            lst = json.loads(fp.read_text(encoding="utf-8"))
            if lst:
                picked.append(max(lst, key=lambda s: s.get("pupils") or 0))
    for s in picked:
        for key, lab in (("merit", "Merit value, year 9"),
                         ("passed", "Passed all subjects"),
                         ("eligible", "Eligible for gymnasium"),
                         ("trygghet", "Trygghet index")):
            v = s.get(key)
            rows.append(["school", s["code"], s["name"], "Schools", "school_" + key, lab,
                         "" if v is None else v, "", s.get(key + "_period", ""),
                         "value" if v is not None else (s.get(key + "_why") or "not published")])

    # 10 infrastructure projects
    ip = PROC / "infra_index.json"
    if ip.exists():
        projects = json.loads(ip.read_text(encoding="utf-8")).get("projects") or []
        step = max(1, len(projects) // 10)
        for p in projects[::step][:10]:
            rows.append(["project", p["id"], p["name"], "Growth signals", "budget_msek",
                         "Budget", p.get("budget_msek") if p.get("budget_msek") is not None else "",
                         "MSEK " + (p.get("price_base") or "no price base"),
                         str(p.get("open_year") or p.get("open_window") or ""),
                         "value" if p.get("budget_msek") is not None else "not published"])

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, delimiter=";")
        w.writerow(["level", "code", "name", "group", "indicator", "label",
                    "value", "unit", "as_of", "status"])
        w.writerows(rows)
    n_val = sum(1 for r in rows if r[6] != "")
    print(f"wrote {OUT.relative_to(ROOT)} · {len(rows):,} rows "
          f"({n_val:,} with a value, {len(rows) - n_val:,} blank by design)")
    print(f"  {len(makro['kommuner'])} kommuner × {len(inds)} indicators, "
          f"{len(picked)} schools, {min(10, len(projects) if ip.exists() else 0)} projects")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
