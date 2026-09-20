#!/usr/bin/env python3
"""Deep raw pull from SCB — every table in config/tables_se.json, at every
geographic level it supports, across the requested history window.

Writes, per (table, level):
  data/raw/scb_<TABLE>_<level>.jsonl     one JSON object per data cell
  data/raw/scb_<TABLE>.meta.json         the table's metadata at fetch time
  data/raw/scb_<TABLE>_<level>.state.json  progress, so an interrupted run resumes

Nothing is ever overwritten silently: a completed (table, level) is skipped on
re-run unless --refresh is given. A failing table is logged and the run
continues — one broken table must never cost a night.

Usage:
  python3 scripts/fetch_scb.py                 # everything
  python3 scripts/fetch_scb.py --only TAB4590  # one table (repeatable)
  python3 scripts/fetch_scb.py --dry-run       # plan only: calls, cells, no data
  python3 scripts/fetch_scb.py --refresh       # ignore saved progress
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import scb  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
CFG = ROOT / "config" / "tables_se.json"
RAW = ROOT / "data" / "raw"
LOG = RAW / "_fetch_log.txt"

_log_lines: list[str] = []


def log(msg: str = "") -> None:
    print(msg, flush=True)
    _log_lines.append(msg)


def chunk_key(sel: dict[str, list[str]]) -> str:
    """Stable identity for a chunk, so resume can skip what is already on disk."""
    return json.dumps({k: [v[0], v[-1], len(v)] for k, v in sorted(sel.items())},
                      ensure_ascii=False)


def load_state(path: pathlib.Path) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    return {"done": [], "rows": 0, "started": None, "finished": None}


def pull(table: str, level: str, time_spec: str, note: str, pin: dict | None,
         dry_run: bool, refresh: bool) -> tuple[str, int, str]:
    """Returns (status, rows, detail)."""
    tag = f"{table}/{level}"
    out_path = RAW / f"scb_{table}_{level}.jsonl.gz"
    state_path = RAW / f"scb_{table}_{level}.state.json"

    try:
        meta = scb.metadata(table, refresh=refresh)
    except scb.ScbError as exc:
        return "FAILED", 0, f"metadata: {exc}"

    if scb.discontinued(meta):
        log(f"    note: SCB marks {table} as discontinued")

    try:
        sel, vintage = scb.build_selection(meta, level, time_spec, pin)
        chunks = scb.plan(sel, scb.time_dim(meta), scb.region_dim(meta))
    except scb.ScbError as exc:
        return "SKIPPED", 0, str(exc)

    total_cells = scb.cells(sel)
    label = (meta.get("label") or "")[:70]
    log(f"  {tag:28s} {len(chunks):4d} call(s) · {total_cells:9,d} cells · {vintage} · {label}")

    if dry_run:
        return "PLANNED", 0, f"{len(chunks)} calls"

    state = load_state(state_path)
    if refresh:
        state = {"done": [], "rows": 0, "started": None, "finished": None}
        out_path.unlink(missing_ok=True)
    elif out_path.exists() and not state.get("done"):
        # Rows on disk that no state file accounts for. Chunks are appended, so
        # re-running would write them a second time and there is no way to tell
        # the copies apart afterwards. Nothing records what is in there, so it
        # cannot be trusted or resumed — start the pull over.
        log(f"    discarding {out_path.name}: rows on disk with no progress record")
        out_path.unlink()
    if state.get("finished") and not refresh:
        return "CACHED", int(state.get("rows") or 0), f"already complete {state['finished'][:10]}"

    state["started"] = state.get("started") or dt.datetime.now().isoformat(timespec="seconds")
    done = set(state.get("done") or [])
    rows_written = int(state.get("rows") or 0)

    with gzip.open(out_path, "at", encoding="utf-8") as fh:
        for i, chunk in enumerate(chunks, 1):
            key = chunk_key(chunk)
            if key in done:
                continue
            try:
                rows = scb.fetch_rows(table, chunk, scb.region_dim(meta))
            except Exception as exc:  # noqa: BLE001 — the progress record matters more
                # Catch everything, not just ScbError: whatever went wrong, the
                # chunks already written have to be recorded or the next run
                # appends them again.
                fh.flush()
                state["done"] = sorted(done)
                state["rows"] = rows_written
                state_path.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
                detail = exc if isinstance(exc, scb.ScbError) else f"{type(exc).__name__}: {exc}"
                return "FAILED", rows_written, f"chunk {i}/{len(chunks)}: {detail}"
            for row in rows:
                fh.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
            rows_written += len(rows)
            done.add(key)
            if i % 10 == 0 or i == len(chunks):
                fh.flush()
                state["done"] = sorted(done)
                state["rows"] = rows_written
                state_path.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
                log(f"      {tag} {i}/{len(chunks)} chunks · {rows_written:,} rows")

    state["done"] = sorted(done)
    state["rows"] = rows_written
    state["finished"] = dt.datetime.now().isoformat(timespec="seconds")
    state["updated_at_source"] = scb.updated(meta)
    state["vintage"] = vintage
    state["time_spec"] = time_spec
    state["note"] = note
    state_path.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    return "OK", rows_written, ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", action="append", default=[], help="table id, repeatable")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--refresh", action="store_true")
    args = ap.parse_args()

    cfg = json.loads(CFG.read_text(encoding="utf-8"))
    RAW.mkdir(parents=True, exist_ok=True)
    started = time.time()

    entries = [t for t in cfg["tables"] if not args.only or t["table"] in args.only]
    log(f"SCB deep pull · {len(entries)} tables · started {dt.datetime.now():%Y-%m-%d %H:%M}")
    log("")

    results: list[tuple[str, str, int, str]] = []
    for entry in entries:
        table = entry["table"]
        levels = entry.get("levels") or ["all"]
        time_spec = entry.get("time", "all")
        note = entry.get("note", "")
        log(f"{table}  {note}")
        for level in levels:
            try:
                status, rows, detail = pull(table, level, time_spec, note, entry.get("pin"),
                                            args.dry_run, args.refresh)
            except KeyboardInterrupt:
                log("\ninterrupted — progress is saved, re-run the same command to continue")
                return 130
            except Exception as exc:  # noqa: BLE001 — never let one table kill the night
                status, rows, detail = "FAILED", 0, f"unexpected: {type(exc).__name__}: {exc}"
            results.append((table, level, rows, status))
            if status in ("FAILED", "SKIPPED"):
                log(f"    {status}: {detail}")
            elif status == "CACHED":
                log(f"    cached ({rows:,} rows)")
            elif status == "OK":
                log(f"    ok · {rows:,} rows")
        log("")

    ok = [r for r in results if r[3] == "OK"]
    cached = [r for r in results if r[3] == "CACHED"]
    failed = [r for r in results if r[3] == "FAILED"]
    skipped = [r for r in results if r[3] == "SKIPPED"]
    total_rows = sum(r[2] for r in results)

    log("=" * 64)
    log(f"done in {(time.time() - started) / 60:.1f} min · {total_rows:,} rows total")
    log(f"ok {len(ok)} · cached {len(cached)} · skipped {len(skipped)} · failed {len(failed)}")
    if skipped:
        log("\nSKIPPED (table does not carry that level, or window empty):")
        for table, level, _, _ in skipped:
            log(f"  {table}/{level}")
    if failed:
        log("\nFAILED (paste these lines into the chat):")
        for table, level, _, _ in failed:
            log(f"  {table}/{level}")
    log("")
    log("raw files: data/raw/*.jsonl.gz · metadata: data/raw/*.meta.json")

    LOG.write_text("\n".join(_log_lines), encoding="utf-8")
    print(f"\nlog written to {LOG}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
