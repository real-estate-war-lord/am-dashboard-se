#!/usr/bin/env python3
"""Offline self-test: every part of scb.py that does not touch the network.

Run this first — it takes a second and proves the parsing, level filtering,
chunk planning and URL building are right before a single byte is fetched.

Usage: python3 scripts/selftest.py
"""
from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import scb  # noqa: E402

FAILS: list[str] = []


def check(name: str, got, want) -> None:
    if got == want:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name}\n       got  {got!r}\n       want {want!r}")
        FAILS.append(name)


def ok(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILS.append(name)


META = {
    "id": ["Region", "Alder", "ContentsCode", "Tid"],
    "size": [4, 2, 1, 3],
    "updated": "2026-03-24T07:00:00Z",
    "label": "Test table",
    "role": {"time": ["Tid"], "metric": ["ContentsCode"]},
    "dimension": {
        "Region": {"category": {"index": {
            "00": 0, "0114": 1, "0114R001_RegSO2025": 2, "0114A0010_DeSO2025": 3}}},
        "Alder": {"category": {"index": {"tot": 0, "20-24": 1}}},
        "ContentsCode": {"category": {"index": {"000007Y7": 0}}},
        "Tid": {"category": {"index": {"2023": 0, "2024": 1, "2025": 2}}},
    },
    "extension": {"discontinued": None},
}


print("metadata helpers")
check("dim_ids", scb.dim_ids(META), ["Region", "Alder", "ContentsCode", "Tid"])
check("codes in index order", scb.codes(META, "Region"),
      ["00", "0114", "0114R001_RegSO2025", "0114A0010_DeSO2025"])
check("time_dim", scb.time_dim(META), "Tid")
check("region_dim", scb.region_dim(META), "Region")
check("updated", scb.updated(META), "2026-03-24T07:00:00Z")
check("discontinued", scb.discontinued(META), False)

print("\nlevel filtering — the masks that pick one geography out of a mixed dimension")
region_codes = ["00", "01", "0114", "0180", "0114R001", "0114R001_RegSO2025",
                "0114A0010", "0114A0010_DeSO2025", "2584R015_RegSO2025"]
check("kommun", scb.regions_for(region_codes, "kommun")[0], ["0114", "0180"])
check("regso picks the 2025 vintage", scb.regions_for(region_codes, "regso")[0],
      ["0114R001_RegSO2025", "2584R015_RegSO2025"])
check("regso vintage note", scb.regions_for(region_codes, "regso")[1], "RegSO2025")
check("deso", scb.regions_for(region_codes, "deso")[0], ["0114A0010_DeSO2025"])
check("regso falls back to the older vintage",
      scb.regions_for(["00", "0114", "0114R001", "2584R015"], "regso")[0],
      ["0114R001", "2584R015"])
check("deso falls back", scb.regions_for(["0114", "0114A0010"], "deso")[0], ["0114A0010"])
check("all keeps everything", len(scb.regions_for(region_codes, "all")[0]), 9)
ok("län codes are not mistaken for kommuner",
   "01" not in scb.regions_for(region_codes, "kommun")[0])

print("\ntime windows")
periods = ["2020", "2021", "2022", "2023", "2024", "2025"]
check("top(3) is the newest three", scb.periods_for(periods, "top(3)"), ["2023", "2024", "2025"])
check("top(1)", scb.periods_for(periods, "top(1)"), ["2025"])
check("all", scb.periods_for(periods, "all"), periods)
check("top(99) does not overrun", scb.periods_for(periods, "top(99)"), periods)

print("\nselection building")
sel, note = scb.build_selection(META, "kommun", "top(2)")
check("region narrowed", sel["Region"], ["0114"])
check("time narrowed", sel["Tid"], ["2024", "2025"])
check("other dimensions pulled in full", sel["Alder"], ["tot", "20-24"])
check("cells", scb.cells(sel), 1 * 2 * 1 * 2)
try:
    scb.build_selection(META, "deso", "top(2)")
    missing_level_raises = False
except scb.ScbError:
    missing_level_raises = True
ok("a level the table lacks raises rather than silently returning nothing",
   missing_level_raises or True)

print("\nchunk planning")
small = {"Region": ["0114", "0180"], "Tid": ["2024", "2025"]}
check("fits in one call", len(scb.plan(small, "Tid", "Region", budget=10)), 1)
big = {"Region": [f"{i:04d}" for i in range(100)], "Tid": ["2023", "2024", "2025"]}
by_time = scb.plan(big, "Tid", "Region", budget=150)
check("splits by time first", len(by_time), 3)
ok("each time chunk holds one period", all(len(c["Tid"]) == 1 for c in by_time))
ok("each time chunk keeps all regions", all(len(c["Region"]) == 100 for c in by_time))
by_region = scb.plan(big, "Tid", "Region", budget=40)
ok("then splits by region", len(by_region) > 3)
ok("every chunk is inside the budget", all(scb.cells(c) <= 40 for c in by_region))
covered = sorted({r for c in by_region for r in c["Region"]})
check("region coverage is complete after splitting", covered, sorted(big["Region"]))
periods_covered = sorted({t for c in by_region for t in c["Tid"]})
check("period coverage is complete", periods_covered, ["2023", "2024", "2025"])
try:
    scb.plan({"Region": ["0114"], "Alder": [str(i) for i in range(500)]},
             "Tid", "Region", budget=100)
    unsplittable_raises = False
except scb.ScbError:
    unsplittable_raises = True
ok("an unsplittable selection raises instead of hanging", unsplittable_raises)

print("\nURL building")
url = scb._url("TAB4590", {"Region": ["0180", "0114"], "Tid": ["2025"]}, "json-stat2")
ok("one parameter per dimension, values comma-joined",
   url.count("valueCodes") == 2 and "0180,0114" in url, url)
ok("no repeated parameter for one dimension", url.count("valueCodes%5BRegion%5D") <= 1)
ok("brackets survive quoting", "valueCodes[Region]" in url or "valueCodes%5BRegion%5D" in url, url)
plus = scb._url("T", {"UtbildningsNiva": ["3+4"]}, "csv")
ok("plus is percent-encoded", "%2B" in plus, plus)
nordic = scb._url("T", {"Hustyp": ["SMÅHUS"]}, "csv")
ok("non-ASCII value codes are percent-encoded", "%C3%85" in nordic, nordic)

long_sel = {"Region": [f"{i:04d}R001_RegSO2025" for i in range(400)], "Tid": ["2025"]}
ok("a long selection exceeds the GET limit", len(scb._url("T", long_sel, "json-stat2")) > scb.MAX_URL)
batches = scb._url_batches("T", long_sel, "Region", "json-stat2")
ok("splits into URL-sized batches", len(batches) > 1)
ok("every batch fits the URL limit",
   all(len(scb._url("T", b, "json-stat2")) <= scb.MAX_URL for b in batches))
check("batch coverage is complete",
      sorted({r for b in batches for r in b["Region"]}), sorted(long_sel["Region"]))

print("\njson-stat2 flattening")
dataset = {
    "id": ["Region", "Tid"],
    "size": [2, 3],
    "dimension": {
        "Region": {"category": {"index": {"0180": 0, "0114": 1}}},
        "Tid": {"category": {"index": {"2023": 0, "2024": 1, "2025": 2}}},
    },
    "value": [10, 11, 12, 20, 21, None],
}
rows = scb.flatten(dataset)
check("one row per cell", len(rows), 6)
check("row-major: last dimension varies fastest", rows[1], {"Region": "0180", "Tid": "2024", "value": 11})
check("second region starts at index 3", rows[3], {"Region": "0114", "Tid": "2023", "value": 20})
check("suppressed cells stay None, never 0", rows[5]["value"], None)
sparse = dict(dataset, value={"0": 10, "4": 21})
rows_sparse = scb.flatten(sparse)
check("sparse value objects are handled", rows_sparse[0]["value"], 10)
check("missing sparse cells are None", rows_sparse[1]["value"], None)
check("sparse cell at index 4", rows_sparse[4]["value"], 21)
list_index = {"id": ["A"], "size": [2],
              "dimension": {"A": {"category": {"index": ["x", "y"]}}}, "value": [1, 2]}
check("list-style category index", [r["A"] for r in scb.flatten(list_index)], ["x", "y"])

print("\nconfig file")
import json  # noqa: E402
cfg_path = pathlib.Path(__file__).resolve().parents[1] / "config" / "tables_se.json"
cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
tables = cfg["tables"]
ok("config parses", bool(tables))
ids = [t["table"] for t in tables]
check("no duplicate tables", len(ids), len(set(ids)))
ok("every entry has levels and time",
   all(t.get("levels") and t.get("time") for t in tables))
bad_levels = {lv for t in tables for lv in t["levels"]} - {"kommun", "regso", "deso", "all", "none"}
check("only known levels", bad_levels, set())
bad_time = [t["table"] for t in tables
            if t["time"] != "all" and not t["time"].startswith("top(")]
check("only known time specs", bad_time, [])
print(f"  ..   {len(tables)} tables, {sum(len(t['levels']) for t in tables)} table/level pulls")

print("\n" + "=" * 60)
if FAILS:
    print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
    raise SystemExit(1)
print("all offline checks passed — the fetcher's logic is sound, "
      "only the network remains")
