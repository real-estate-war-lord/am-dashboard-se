#!/usr/bin/env python3
"""Re-fetch every verify-at-source query and check it answers.

A "Verify at source" link that 404s, or that quietly returns a different figure
from the one on the tile, is worse than no link at all — it looks like a check
and is not one. This script builds the same URL the page builds, fetches it, and
reports the cells that come back.

    python3 scripts/check_source_links.py               # the full sweep (make links)
    python3 scripts/check_source_links.py --sample 2    # 2 areas per indicator (make validate)
    python3 scripts/check_source_links.py --key rent    # one indicator

`src_url()` below is deliberately a second, independent implementation of the
URL that `indSrcLink()` in src/app.js builds. If the two drift apart, this stops
matching the page and the mismatch surfaces here rather than in front of a reader.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from se_common import CFG, PROC                                          # noqa: E402

UA = {"User-Agent": "am-dashboard-se/1.2 link-check (+https://github.com/real-estate-war-lord)"}
# SCB allows 30 calls / 10 s, but resets the connection well below that under a
# sustained sweep, so this keeps to 10 and retries a reset rather than reporting
# it as a broken link.
CALLS, WINDOW, PER_WINDOW = [], 10.0, 10


def throttle() -> None:
    while True:
        now = time.monotonic()
        while CALLS and now - CALLS[0] > WINDOW:
            CALLS.pop(0)
        if len(CALLS) < PER_WINDOW:
            CALLS.append(now)
            return
        time.sleep(0.25)


def periods_for(entry: dict, year: str, periods: dict) -> list[str]:
    """Which Tid codes the publisher's table actually has for this year.

    Two ways to get a 400 here rather than an empty answer: a year is not a Tid
    code on a monthly or quarterly table, and a table that ends in 2025 rejects
    2026 outright. The dashboard's "latest year" is the latest across all
    sources, so it is routinely ahead of any one table.
    """
    newest = entry.get("newest_period") or ""
    kind = entry.get("time_kind", "year")
    if kind == "year":
        return [min(year, newest)] if newest else [year]
    codes = periods.get(entry.get("table")) or []
    hit = [c for c in codes if c.startswith(year)]
    return hit or ([newest] if newest else [])


def src_url(entry: dict, code: str | None, year: str, periods: dict,
            fmt: str = "json-stat2") -> str | None:
    if entry.get("db") == "kolada":
        return f"{entry['api']}/{code}" if code else entry["api"]
    if entry.get("db") != "scb":
        return entry.get("page")
    tids = periods_for(entry, year, periods)
    if not tids:
        return None
    q = [("lang", "en"), ("outputFormat", fmt)]
    if code and entry.get("region_dim"):
        q.append((f"valueCodes[{entry['region_dim']}]", code))
    q.append((f"valueCodes[{entry['time_dim']}]", ",".join(tids)))
    for d, v in (entry.get("vars") or {}).items():
        q.append((f"valueCodes[{d}]", ",".join(v)))
    return entry["api"] + "?" + urllib.parse.urlencode(q, safe=",")


def fetch(url: str, tries: int = 3) -> tuple[int, dict | None, str]:
    last = ""
    for attempt in range(tries):
        throttle()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
                return r.status, json.loads(r.read()), ""
        except urllib.error.HTTPError as e:
            # a 400 is a wrong query and will not get better by asking again
            return e.code, None, f"HTTP {e.code}"
        except Exception as e:                                           # noqa: BLE001
            last = f"{type(e).__name__}: {e}"
            time.sleep(2.0 * (attempt + 1))
    return 0, None, last


def sample_codes(entry: dict, muni: list[dict], n: int) -> list[str | None]:
    """Region codes to ask for — at the level the TABLE publishes, not the level
    the dashboard displays. brf_price is shown per kommun but published per län;
    asking TAB1151 for kommun 1785 is a 400, not a wrong number."""
    lvl = entry.get("level")
    code_level = entry.get("code_level")
    levels = entry.get("region_levels") or []
    if lvl == "national":
        # A national series is displayed as one figure for Sweden, so that is
        # what the link must fetch — the riket code where the table has one,
        # and no Region filter at all where it has no Region dimension.
        return ["00"] if "riket" in levels else [None]
    if code_level == "riket":
        return ["00"]
    if lvl != "kommun" and lvl != "national":
        # RegSO/DeSO codes carry a vintage suffix in the statistics but not in
        # the boundary files; verifying those needs the suffix back, which the
        # processed data does not keep. Checked at kommun level instead — the
        # query is the same shape.
        return []
    codes = [m["code"] for m in muni]
    if not codes:
        return [None]
    picked = random.sample(codes, min(n, len(codes)))
    if code_level == "lan":
        # the län a sampled kommun belongs to is its first two digits
        return sorted({c[:2] for c in picked})
    if code_level == "riksomrade":
        return []                       # no stable kommun -> riksområde mapping
    return picked


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample", type=int, default=0, help="areas per indicator (0 = a fixed set)")
    ap.add_argument("--key", help="check one indicator")
    ap.add_argument("--seed", type=int, default=12)
    a = ap.parse_args()
    random.seed(a.seed)

    cfg = json.loads(CFG.read_text(encoding="utf-8"))
    periods = cfg.get("src_periods") or {}
    makro = json.loads((PROC / "makro.json").read_text(encoding="utf-8"))
    muni = makro.get("kommuner") or makro.get("muni") or []
    years = (makro.get("meta") or {}).get("years") or []
    latest = (makro.get("meta") or {}).get("latest_year") or (years[-1] if years else "")

    inds = [i for i in cfg["indicators"] if not a.key or i["key"] == a.key]
    n = a.sample or 2
    checked = ok = 0
    problems: list[str] = []

    for ind in inds:
        for entry in ind.get("src_verify") or []:
            if entry.get("db") not in ("scb", "kolada"):
                continue                        # a page link has nothing to recompute
            for code in sample_codes(entry, muni, n):
                yr = entry.get("year") or latest
                url = src_url(entry, code, yr, periods)
                if not url:
                    problems.append(f"{ind['key']}/{entry['level']}: no period code for {yr}")
                    continue
                checked += 1
                status, body, err = fetch(url)
                if status != 200 or body is None:
                    problems.append(f"{ind['key']}/{entry['level']}/{code or '-'}: {err or status}")
                    continue
                vals = body.get("value") if isinstance(body, dict) else None
                if entry["db"] == "kolada":
                    vals = [v for row in (body.get("values") or [])
                            for v in (row.get("values") or [])]
                if not vals:
                    problems.append(f"{ind['key']}/{entry['level']}/{code or '-'}: 200 but no cells")
                    continue
                ok += 1
        print(f"  {ind['key']:16s} {len(ind.get('src_verify') or [])} link(s)", flush=True)

    print(f"\n{ok} of {checked} queries returned cells")
    if problems:
        print(f"\n{len(problems)} problem(s):")
        for p in problems:
            print("  ⚠", p)
        return 1
    print("every verify-at-source link answers with the cells it promises")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
