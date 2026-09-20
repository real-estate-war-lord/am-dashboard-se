#!/usr/bin/env python3
"""Check config/indicators.json against the metadata on disk.

The one rule this enforces mechanically: no invented codes. Every table, every
dimension, every value code and every ContentsCode in the registry must exist in
data/raw/scb_<TABLE>.meta.json. It also checks that the geographic level an
indicator claims really exists in that table's Region dimension, that the vintage
recorded matches the codes the pull would actually select, and that an indicator
declaring a margin of error names a ContentsCode the table really publishes.

Exits non-zero on any error. Warnings (missing raw file, placeholder source) do
not fail the run — they are the to-do list.

Usage: python3 scripts/validate_indicators.py
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import scb  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
CFG = ROOT / "config" / "indicators.json"

LEVEL_RE = {
    "kommun": re.compile(r"^\d{4}$"),
    "regso": re.compile(r"^\d{4}R\d{3}(_RegSO2025)?$"),
    "deso": re.compile(r"^\d{4}[A-Z]\d{4}(_DeSO2025)?$"),
}

errors: list[str] = []
warnings: list[str] = []


def load_meta(table: str) -> dict | None:
    path = RAW / f"scb_{table}.meta.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        errors.append(f"{table}: metadata is not valid JSON ({exc})")
        return None


def check_source(key: str, source: dict) -> None:
    db = source.get("db")
    if db != "scb":
        if not source.get("pull"):
            warnings.append(f"{key}: source db='{db}' has no raw file yet — placeholder")
        return

    table = source.get("table")
    meta = load_meta(table)
    if meta is None:
        errors.append(f"{key}: no metadata on disk for {table}")
        return

    dims = set(scb.dim_ids(meta))
    geo = source.get("geo")

    # every dimension and every value code must exist
    for dim, wanted in (source.get("vars") or {}).items():
        if dim not in dims:
            errors.append(f"{key}/{table}: no dimension '{dim}' (has {sorted(dims)})")
            continue
        have = set(scb.codes(meta, dim))
        missing = [c for c in wanted if c not in have]
        if missing:
            errors.append(f"{key}/{table}.{dim}: codes not in metadata: {missing}")

    # denominator codes live in the same dimension as the numerator
    share = source.get("share") or {}
    if share.get("of"):
        dim = next((d for d in (source.get("vars") or {})
                    if d not in ("ContentsCode", "Tid")
                    and set(share["of"]) & set(scb.codes(meta, d))), None)
        if dim is None:
            errors.append(f"{key}/{table}: share.of {share['of']} matches no dimension")
    if share.get("of_contents"):
        have = set(scb.codes(meta, "ContentsCode"))
        missing = [c for c in share["of_contents"] if c not in have]
        if missing:
            errors.append(f"{key}/{table}: share.of_contents not in metadata: {missing}")

    # the level the source claims must exist in the Region dimension
    rdim = scb.region_dim(meta)
    if geo in LEVEL_RE:
        if rdim is None:
            errors.append(f"{key}/{table}: claims geo '{geo}' but the table has no Region dimension")
        else:
            codes = scb.codes(meta, rdim)
            picked, vintage = scb.regions_for(codes, geo)
            if not picked:
                errors.append(f"{key}/{table}: no '{geo}' codes in the Region dimension")
            elif source.get("vintage") not in ("kommun", vintage) and geo != "kommun":
                errors.append(f"{key}/{table}: vintage says '{source.get('vintage')}' "
                              f"but the pull would select '{vintage}'")
    elif geo not in ("all", "none"):
        errors.append(f"{key}: unknown geo '{geo}'")

    # the raw file the registry points at
    pull = source.get("pull")
    if pull and not (RAW / f"{pull}.jsonl.gz").exists():
        warnings.append(f"{key}: raw file {pull}.jsonl.gz not on disk yet")


def main() -> int:
    cfg = json.loads(CFG.read_text(encoding="utf-8"))
    inds = cfg["indicators"]
    seen: set[str] = set()

    for ind in inds:
        key = ind.get("key")
        if not key:
            errors.append(f"an indicator has no key: {ind}")
            continue
        if key in seen:
            errors.append(f"duplicate key '{key}'")
        seen.add(key)

        for field in ("label", "short", "unit", "level", "levels", "sources",
                      "calc", "fmt", "desc", "source", "group"):
            if field not in ind:
                errors.append(f"{key}: missing required field '{field}'")

        if ind.get("level") not in ("kommun", "regso", "deso", "none"):
            errors.append(f"{key}: level '{ind.get('level')}' is not kommun|regso|deso|none")
        if ind.get("level") not in (ind.get("levels") or []):
            errors.append(f"{key}: level '{ind.get('level')}' is not listed in levels {ind.get('levels')}")

        for source in ind.get("sources") or []:
            check_source(key, source)

        # a margin of error must name a ContentsCode the table publishes
        moe = ind.get("moe")
        if moe:
            code = moe.get("contents")
            ok = False
            for source in ind.get("sources") or []:
                meta = load_meta(source.get("table")) if source.get("db") == "scb" else None
                if meta and code in set(scb.codes(meta, "ContentsCode")):
                    ok = True
            if not ok:
                errors.append(f"{key}: moe contents '{code}' is not a ContentsCode of any source")

    print(f"{len(inds)} indicators · {len({i['level'] for i in inds})} distinct levels")
    by_group: dict[str, int] = {}
    for i in inds:
        by_group[i.get("group", "?")] = by_group.get(i.get("group", "?"), 0) + 1
    for g, n in sorted(by_group.items()):
        print(f"  {g:18s} {n}")

    if warnings:
        print(f"\n{len(warnings)} warning(s):")
        for w in warnings:
            print(f"  ! {w}")
    if errors:
        print(f"\n{len(errors)} ERROR(S):")
        for e in errors:
            print(f"  ✗ {e}")
        return 1
    print("\nall codes check out against data/raw/*.meta.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
