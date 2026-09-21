"""Shared helpers for the Swedish build: locate raw pulls, stream them, order periods."""
from __future__ import annotations

import gzip
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
GEO = ROOT / "data" / "geo"
PROC = ROOT / "data" / "processed"
CFG = ROOT / "config" / "indicators.json"

LEVELS = ("kommun", "regso", "deso")


def cfg() -> dict:
    return json.loads(CFG.read_text(encoding="utf-8"))


def pull_path(pull: str) -> pathlib.Path:
    return RAW / f"{pull}.jsonl.gz"


def stream(pull: str):
    """Yield one dict per data cell from a raw pull. Raises if it is not on disk."""
    p = pull_path(pull)
    if not p.exists():
        raise FileNotFoundError(f"no raw pull {p.name} — run 'make fetch'")
    with gzip.open(p, "rt", encoding="utf-8") as fh:
        for line in fh:
            yield json.loads(line)


def table_meta(table: str) -> dict:
    p = RAW / f"scb_{table}.meta.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def dim_labels(table: str, dim: str) -> dict:
    d = (table_meta(table).get("dimension") or {}).get(dim) or {}
    return (d.get("category") or {}).get("label") or {}


def period_parts(t: str):
    """'2025' -> (2025, None, 0); '2026K2' -> (2026,'K',2); '2026M06' -> (2026,'M',6)."""
    m = re.match(r"(\d{4})(?:([KQM])(\d{1,2}))?", t or "")
    return (int(m.group(1)), m.group(2), int(m.group(3) or 0)) if m else (0, None, 0)


def period_key(t: str):
    y, kind, n = period_parts(t)
    return (y, n * (3 if kind in ("K", "Q") else 1))


def period_year(t: str) -> str:
    return str(period_parts(t)[0])


def plain_code(code: str) -> str:
    """Strip the vintage suffix SCB appends to 2025-division region codes.

    The statistics say '0114R001_RegSO2025', the boundary files say '0114R001'.
    """
    return code.split("_", 1)[0]
