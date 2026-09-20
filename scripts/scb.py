#!/usr/bin/env python3
"""SCB PxWebApi v2 client — metadata, selection planning, chunked fetching, json-stat2 flattening.

Standard library only. No API key: SCB's statistical database is keyless and CC0.

Design notes (all verified against the live API on 2026-09-18):
  * Values for one dimension go in ONE comma-separated parameter. Repeating
    `valueCodes[X]` returns HTTP 200 with all but the first value SILENTLY DROPPED,
    so this module never builds a query string by hand outside `_url()`.
  * `range(a,b)` and `top(n,offset)` are unusable over GET because the comma is the
    value separator. This module therefore resolves every selection to explicit
    value codes taken from the table's own metadata.
  * One call is capped at 150 000 data cells and roughly 2 100 URL characters.
    `plan()` splits a selection until each piece fits; `fetch()` switches to POST
    when the URL would be too long.
  * Rate limit is 30 calls / 10 s; this module keeps itself to 25.
"""
from __future__ import annotations

import json
import pathlib
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque

API = "https://api.scb.se/OV0104/v2beta/api/v2"
LANG = "en"
UA = {"User-Agent": "am-dashboard-se/0.1 (+https://github.com/real-estate-war-lord)"}

MAX_CELLS = 120_000        # server cap 150 000 — headroom for our own miscounting
MAX_URL = 1_900            # server rejects around 2 100 characters
CALLS_PER_WINDOW = 25      # server allows 30
WINDOW = 10.0

ROOT = pathlib.Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"

RE_KOMMUN = re.compile(r"^\d{4}$")
RE_REGSO_PLAIN = re.compile(r"^\d{4}R\d{3}$")
RE_DESO_PLAIN = re.compile(r"^\d{4}[A-Z]\d{4}$")


class ScbError(Exception):
    """Any failure that should be logged against one table without stopping the run."""


# ---------------------------------------------------------------- HTTP

_calls: deque[float] = deque()


def _throttle() -> None:
    while True:
        now = time.monotonic()
        while _calls and now - _calls[0] > WINDOW:
            _calls.popleft()
        if len(_calls) < CALLS_PER_WINDOW:
            _calls.append(now)
            return
        time.sleep(WINDOW - (now - _calls[0]) + 0.1)


def _request(url: str, body: dict | None = None, tries: int = 3) -> dict:
    last = ""
    for attempt in range(tries):
        _throttle()
        try:
            if body is None:
                req = urllib.request.Request(url, headers=UA)
            else:
                req = urllib.request.Request(
                    url,
                    data=json.dumps(body).encode("utf-8"),
                    headers={**UA, "Content-Type": "application/json"},
                    method="POST",
                )
            with urllib.request.urlopen(req, timeout=600) as resp:
                return json.loads(resp.read().decode("utf-8-sig"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace").strip().replace("\n", " ")[:300]
            last = f"HTTP {exc.code} {detail}"
            if exc.code in (429, 500, 502, 503, 504) and attempt < tries - 1:
                time.sleep(5 * (3 ** attempt))
                continue
            raise ScbError(last) from None
        except urllib.error.URLError as exc:
            last = f"network error: {exc.reason}"
            if attempt < tries - 1:
                time.sleep(5 * (3 ** attempt))
                continue
            raise ScbError(last) from None
        except json.JSONDecodeError as exc:
            raise ScbError(f"response was not JSON: {exc}") from None
    raise ScbError(last or "unknown error")


# ---------------------------------------------------------------- metadata

def metadata(table: str, refresh: bool = False) -> dict:
    """Table metadata (json-stat2 shape, no values). Cached under data/raw/."""
    RAW.mkdir(parents=True, exist_ok=True)
    path = RAW / f"scb_{table}.meta.json"
    if path.exists() and not refresh:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass
    meta = _request(f"{API}/tables/{table}/metadata?lang={LANG}")
    path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    return meta


def dim_ids(meta: dict) -> list[str]:
    return list(meta.get("id") or [])


def codes(meta: dict, dim: str) -> list[str]:
    """Value codes of one dimension, in the order the API reports them."""
    index = ((meta.get("dimension") or {}).get(dim) or {}).get("category", {}).get("index")
    if index is None:
        return []
    if isinstance(index, dict):
        out: list[str | None] = [None] * len(index)
        for code, pos in index.items():
            if 0 <= pos < len(out):
                out[pos] = code
        return [c for c in out if c is not None]
    return list(index)


def time_dim(meta: dict) -> str | None:
    role_time = (meta.get("role") or {}).get("time") or []
    if role_time:
        return role_time[0]
    return "Tid" if "Tid" in dim_ids(meta) else None


def region_dim(meta: dict) -> str | None:
    for name in ("Region", "region"):
        if name in dim_ids(meta):
            return name
    return None


def updated(meta: dict) -> str:
    return meta.get("updated") or ""


def discontinued(meta: dict) -> bool:
    return bool((meta.get("extension") or {}).get("discontinued"))


# ---------------------------------------------------------------- selection

def regions_for(all_codes: list[str], level: str) -> tuple[list[str], str]:
    """Pick one geographic level out of SCB's mixed Region dimension.

    Returns (codes, vintage-note). Falls back to the un-suffixed older vintage
    when the 2025 re-cut is not present in the table.
    """
    if level in ("all", "none"):
        return list(all_codes), "all levels"
    if level == "kommun":
        return [c for c in all_codes if RE_KOMMUN.match(c)], "kommun"
    if level == "regso":
        new = [c for c in all_codes if c.endswith("_RegSO2025")]
        if new:
            return new, "RegSO2025"
        return [c for c in all_codes if RE_REGSO_PLAIN.match(c)], "RegSO2020 (no 2025 codes in table)"
    if level == "deso":
        new = [c for c in all_codes if c.endswith("_DeSO2025")]
        if new:
            return new, "DeSO2025"
        return [c for c in all_codes if RE_DESO_PLAIN.match(c)], "DeSO2018 (no 2025 codes in table)"
    raise ScbError(f"unknown level '{level}'")


def periods_for(all_periods: list[str], spec: str) -> list[str]:
    """`all` or `top(N)` — resolved here rather than server-side, so the
    inverted meaning of top() on the time dimension can never surprise us."""
    spec = (spec or "all").strip()
    if spec == "all":
        return list(all_periods)
    match = re.fullmatch(r"top\((\d+)\)", spec)
    if match:
        n = int(match.group(1))
        return list(all_periods[-n:]) if n else []
    raise ScbError(f"unsupported time spec '{spec}' (use 'all' or 'top(N)')")


def build_selection(meta: dict, level: str, time_spec: str,
                    pin: dict[str, list[str]] | None = None) -> tuple[dict[str, list[str]], str]:
    """Every dimension fully selected, Region narrowed to one level,
    Tid narrowed to the requested window. Returns (selection, vintage-note)."""
    sel: dict[str, list[str]] = {}
    notes: list[str] = []
    pin = pin or {}
    rdim, tdim = region_dim(meta), time_dim(meta)
    for dim in dim_ids(meta):
        values = codes(meta, dim)
        if not values:
            raise ScbError(f"dimension '{dim}' has no value codes in metadata")
        if dim == rdim and level != "none":
            values, note = regions_for(values, level)
            notes.append(note)
            if not values:
                raise ScbError(f"no '{level}' codes in this table's Region dimension")
        elif dim == tdim:
            values = periods_for(values, time_spec)
            if not values:
                raise ScbError("time window resolved to nothing")
        elif dim in pin:
            # Pins kill pure cross-product bloat (a sex or age breakdown we never
            # chart triples a table for nothing). Intersect with what the table
            # really has: a wrong code is dropped, never turned into an HTTP 400,
            # and a pin matching nothing keeps the full dimension — a smaller
            # pull is never worth a failed one.
            wanted = [c for c in pin[dim] if c in values]
            if wanted:
                values = wanted
            else:
                notes.append(f"pin for {dim} matched nothing — kept all {len(values)}")
        sel[dim] = values
    return sel, " · ".join(n for n in notes if n)


def cells(sel: dict[str, list[str]]) -> int:
    total = 1
    for values in sel.values():
        total *= max(1, len(values))
    return total


def plan(sel: dict[str, list[str]], tdim: str | None, rdim: str | None,
         budget: int = MAX_CELLS) -> list[dict[str, list[str]]]:
    """Split one selection into pieces that each fit inside the cell budget.

    Splits by time first (natural, keeps whole geographies together), then by
    region. Raises if a single period × single region still exceeds the budget.
    """
    if cells(sel) <= budget:
        return [sel]

    pieces: list[dict[str, list[str]]] = []
    time_values = sel.get(tdim) if tdim else None
    if time_values and len(time_values) > 1:
        for period in time_values:
            pieces.extend(plan({**sel, tdim: [period]}, tdim, rdim, budget))
        return pieces

    region_values = sel.get(rdim) if rdim else None
    if region_values and len(region_values) > 1:
        per_region = cells({k: v for k, v in sel.items() if k != rdim})
        if per_region > budget:
            raise ScbError(
                f"one region alone needs {per_region} cells (> {budget}); "
                "narrow the table's other dimensions"
            )
        batch = max(1, budget // per_region)
        for start in range(0, len(region_values), batch):
            pieces.append({**sel, rdim: region_values[start:start + batch]})
        return pieces

    raise ScbError(f"selection of {cells(sel)} cells cannot be split any further")


# ---------------------------------------------------------------- data

def _url(table: str, sel: dict[str, list[str]], fmt: str) -> str:
    parts = [f"lang={LANG}", f"outputFormat={fmt}"]
    for dim, values in sel.items():
        key = urllib.parse.quote(f"valueCodes[{dim}]", safe="[]")
        parts.append(f"{key}={urllib.parse.quote(','.join(values), safe=',')}")
    return f"{API}/tables/{table}/data?" + "&".join(parts)


_post_works: bool | None = None   # None = untried, False = fall straight to GET batches


def _url_batches(table: str, sel: dict[str, list[str]], rdim: str | None,
                 fmt: str) -> list[dict[str, list[str]]]:
    """Split until every piece's GET URL fits inside MAX_URL."""
    if len(_url(table, sel, fmt)) <= MAX_URL:
        return [sel]
    if not rdim or len(sel.get(rdim, [])) <= 1:
        raise ScbError("selection too long for a GET URL and not splittable by region")
    values = sel[rdim]
    half = len(values) // 2
    return (_url_batches(table, {**sel, rdim: values[:half]}, rdim, fmt)
            + _url_batches(table, {**sel, rdim: values[half:]}, rdim, fmt))


def fetch(table: str, sel: dict[str, list[str]], fmt: str = "json-stat2") -> dict:
    """One raw call. GET when the URL fits, POST when it does not."""
    url = _url(table, sel, fmt)
    if len(url) <= MAX_URL:
        return _request(url)
    body = {"selection": [{"variableCode": dim, "valueCodes": values}
                          for dim, values in sel.items()]}
    return _request(f"{API}/tables/{table}/data?lang={LANG}&outputFormat={fmt}", body=body)


def fetch_rows(table: str, sel: dict[str, list[str]], rdim: str | None = None,
               fmt: str = "json-stat2") -> list[dict]:
    """One chunk as flat rows, whatever the transport.

    Long selections go over POST. POST is documented but was not verifiable
    remotely, so the first failure disables it for the rest of the run and
    everything falls back to GET batches that fit the URL limit.
    """
    global _post_works
    url = _url(table, sel, fmt)
    if len(url) <= MAX_URL:
        return flatten(_request(url))

    if _post_works is not False:
        try:
            rows = flatten(fetch(table, sel, fmt))
            _post_works = True
            return rows
        except ScbError as exc:
            if _post_works is None:
                _post_works = False
                print(f"    note: POST unavailable ({exc}) — using GET batches from here on",
                      flush=True)
            else:
                raise

    rows: list[dict] = []
    for batch in _url_batches(table, sel, rdim, fmt):
        rows.extend(flatten(_request(_url(table, batch, fmt))))
    return rows


def flatten(js: dict) -> list[dict]:
    """json-stat2 dataset → one dict per cell: {dim: code, ..., value: float|None}.

    `value` is row-major over `size`: the LAST dimension varies fastest.
    Suppressed cells arrive as null and stay None — never 0, never imputed.
    """
    ids = js.get("id") or []
    size = js.get("size") or []
    if not ids or len(ids) != len(size):
        raise ScbError("json-stat2 response has no usable id/size")

    dim_codes_list: list[list[str]] = []
    for dim in ids:
        index = ((js.get("dimension") or {}).get(dim) or {}).get("category", {}).get("index")
        if isinstance(index, dict):
            arr: list[str | None] = [None] * len(index)
            for code, pos in index.items():
                if 0 <= pos < len(arr):
                    arr[pos] = code
            dim_codes_list.append([c if c is not None else "" for c in arr])
        elif isinstance(index, list):
            dim_codes_list.append(list(index))
        else:  # a dimension collapsed to a single unnamed value
            dim_codes_list.append([""])

    values = js.get("value")
    total = 1
    for s in size:
        total *= s

    if isinstance(values, dict):
        def value_at(i: int):
            return values.get(str(i))
    elif isinstance(values, list):
        def value_at(i: int):
            return values[i] if i < len(values) else None
    else:
        raise ScbError("json-stat2 response has no value array")

    rows = []
    for i in range(total):
        rest = i
        row: dict[str, object] = {}
        for k in range(len(ids) - 1, -1, -1):
            n = size[k] or 1
            pos = rest % n
            rest //= n
            col = dim_codes_list[k]
            row[ids[k]] = col[pos] if pos < len(col) else ""
        row["value"] = value_at(i)
        rows.append(row)
    return rows


def search(query: str, page_size: int = 20, lang: str = "sv") -> list[dict]:
    """Find tables by free-text query — used to resolve tables we only know by
    their old PxWeb path."""
    url = (f"{API}/tables?lang={lang}"
           f"&query={urllib.parse.quote(query)}&pageSize={page_size}")
    payload = _request(url)
    # The catalogue's envelope key is not something we could verify remotely,
    # so accept the plausible shapes rather than silently returning nothing.
    if isinstance(payload, list):
        tables = payload
    else:
        tables = (payload.get("tables") or payload.get("data")
                  or payload.get("items") or payload.get("results") or [])
    out = []
    for tab in tables:
        if not isinstance(tab, dict):
            continue
        out.append({
            "id": tab.get("id"),
            "label": tab.get("label"),
            "updated": tab.get("updated"),
            "firstPeriod": tab.get("firstPeriod"),
            "lastPeriod": tab.get("lastPeriod"),
            "discontinued": tab.get("discontinued"),
        })
    return out
