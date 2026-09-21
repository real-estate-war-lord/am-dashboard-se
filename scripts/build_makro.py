#!/usr/bin/env python3
"""Build data/processed/makro.json (+ deso/<kommun>.json) from the raw SCB pulls.

Inputs  config/indicators.json
        data/raw/scb_<TABLE>_<level>.jsonl.gz  (94 pulls)  + scb_<TABLE>.meta.json
        data/geo/kommuner.geojson · regso.geojson · deso.geojson
Output  data/processed/makro.json          kommun + RegSO inline
        data/processed/deso/<kommun>.json  DeSO, loaded on demand by the page
        data/processed/deso/index.json

Every calculation is driven by the `calc` field of an indicator. A source with
no `share` block is a passthrough even when its indicator is a ratio — that is
how one indicator can be a published percentage at kommun (TAB6260) and a
computed ratio below it (TAB6680).

Two things the Danish edition did not have to deal with:

  Zeros that mean "did not exist". SCB re-cut RegSO and DeSO on 2025-01-01 and
  returns 0 — not null — for a 2025-division area in a year before the division
  existed. Taken at face value every sub-municipal share reads 0 % back to 2014
  and growth divides by zero. A period in which no area anywhere has a non-zero
  value is therefore dropped as empty. In practice that leaves 2024–2025 below
  kommun level and the full 11 years at kommun level.

  Margins of error. TAB4590 is a sample survey and ships ± as its own
  ContentsCode; it travels with the value as <key>_moe so the UI can render it
  and grey the kommuner whose margin is too wide.

Usage: python3 scripts/build_makro.py
"""
from __future__ import annotations

import collections
import csv
import datetime as dt
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from se_common import (  # noqa: E402
    GEO, PROC, cfg, dim_labels, period_key, period_parts, period_year,
    plain_code, stream, table_meta,
)

OUT = PROC / "makro.json"
DESO_DIR = PROC / "deso"

RE_KOMMUN = re.compile(r"^\d{4}$")
RE_LAN = re.compile(r"^\d{2}$")

warnings: list[str] = []


def warn(msg: str) -> None:
    warnings.append(msg)


# ---------------------------------------------------------------- aggregation

def share_dimension(vars_: dict, of: list, table: str) -> str | None:
    """Which dimension the denominator codes belong to."""
    for dim, codes in vars_.items():
        if dim in ("Tid",):
            continue
        if set(of) & set(codes):
            return dim
    # denominator may name codes the numerator does not use (e.g. higher_ed)
    meta = table_meta(table)
    for dim in (meta.get("id") or []):
        d = (meta.get("dimension") or {}).get(dim) or {}
        idx = (d.get("category") or {}).get("index") or {}
        codes = set(idx.keys() if isinstance(idx, dict) else idx)
        if set(of) <= codes and dim not in ("Tid", "ContentsCode"):
            return dim
    return None


def aggregate(source: dict, ind: dict) -> tuple[dict, dict, dict]:
    """One streaming pass over a raw pull.

    Returns (num, den, moe), each {period: {region: value}}. `den` is empty
    unless the source declares a share; `moe` unless the indicator declares one.
    """
    table = source["table"]
    vars_ = dict(source.get("vars") or {})
    share = source.get("share") or {}
    moe_code = (ind.get("moe") or {}).get("contents")

    contents = list(vars_.get("ContentsCode") or [])
    value_codes = [c for c in contents if c != moe_code]
    den_contents = list(share.get("of_contents") or [])
    of = list(share.get("of") or [])
    sdim = share_dimension(vars_, of, table) if of else None
    if of and sdim is None:
        warn(f"{ind['key']}/{table}: share.of {of} matches no dimension — treated as passthrough")

    # Numerator filter: every dimension in vars, except ContentsCode (handled
    # separately so the ± code does not land in the value) and the share
    # dimension (its codes split numerator from denominator).
    filt = {d: set(c) for d, c in vars_.items() if d not in ("ContentsCode", "Tid")}
    num_sdim = set(vars_.get(sdim, [])) if sdim else None

    num: dict = collections.defaultdict(lambda: collections.defaultdict(float))
    den: dict = collections.defaultdict(lambda: collections.defaultdict(float))
    moe: dict = collections.defaultdict(dict)
    seen_num: dict = collections.defaultdict(set)
    seen_den: dict = collections.defaultdict(set)

    geo = source.get("geo")
    for r in stream(source["pull"]):
        region = r.get("Region")
        if region is None:
            region = "SE"                       # national table, no Region dimension
        elif geo == "kommun" and not RE_KOMMUN.match(region):
            continue                            # mixed-level pull, keep the 290
        elif geo == "lan" and not RE_LAN.match(region):
            continue                            # keep the 21 counties
        v = r.get("value")
        t = r["Tid"]
        cc = r.get("ContentsCode")

        # The ± must clear the same dimension filter as the value it belongs to.
        # TAB4590 publishes a margin for annual rent (Ah_kvm) and another for new
        # rent (Mh_kvm); letting the second through unfiltered overwrote Stockholm's
        # ±28 with the ±2 of a series the dashboard does not show.
        ok_other = all(r.get(d) in codes for d, codes in filt.items() if d != sdim)
        if not ok_other:
            continue

        if moe_code and cc == moe_code:
            if v is not None:
                moe[t][region] = v
            continue

        if den_contents and cc in den_contents:
            if v is not None:
                den[t][region] += v
                seen_den[t].add(region)
            continue
        if value_codes and cc not in value_codes:
            continue

        if sdim:
            sv = r.get(sdim)
            if sv in set(of):
                if v is not None:
                    den[t][region] += v
                    seen_den[t].add(region)
            if num_sdim is not None and sv in num_sdim:
                if v is not None:
                    num[t][region] += v
                    seen_num[t].add(region)
        else:
            if v is not None:
                num[t][region] += v
                seen_num[t].add(region)

    # Drop periods that are empty everywhere — the vintage trap described above.
    def live(d: dict) -> dict:
        return {t: vals for t, vals in d.items() if any(x for x in vals.values())}

    return live(num), live(den), {t: v for t, v in moe.items() if v}


# ---------------------------------------------------------------- calcs

def latest_in(periods: list, year: str | None) -> str | None:
    """Newest period, or the newest belonging to `year`."""
    ps = sorted(periods, key=period_key)
    if not ps:
        return None
    if year is None:
        return ps[-1]
    same = [p for p in ps if period_year(p) == str(year)]
    return same[-1] if same else None


def values_for(ind: dict, source: dict, num: dict, den: dict, year: str | None):
    """{region: value} plus the period it came from, for one reference year."""
    calc = ind["calc"]
    has_share = bool(den)

    if calc in ("sum4q", "sum4q_per_1000") and source.get("role") != "denominator":
        ps = sorted(num, key=period_key)
        if year is not None:
            ps = [p for p in ps if period_key(p) <= period_key(latest_in(ps, year) or "0000")]
        ps = ps[-4:]
        if not ps:
            return {}, None
        out: dict = collections.defaultdict(float)
        for p in ps:
            for a, v in num[p].items():
                out[a] += v
        return dict(out), f"{ps[0]}–{ps[-1]}"

    if calc == "yoy_pct":
        p = latest_in(list(num), year)
        if not p:
            return {}, None
        y, kind, sub = period_parts(p)
        prev = next((q for q in num if period_parts(q) == (y - 1, kind, sub)), None)
        if not prev:
            return {}, None
        cur, old = num[p], num[prev]
        return ({a: (v / old[a] - 1) * 100 for a, v in cur.items() if v and old.get(a)},
                f"{prev}→{p}")

    p = latest_in(list(num), year)
    if not p:
        return {}, None

    if has_share:
        d = den.get(p) or {}
        scale = 1.0 if calc == "per_unit" else 100.0
        return ({a: v / d[a] * scale for a, v in num[p].items() if d.get(a)}, p)

    return dict(num[p]), p


# ---------------------------------------------------------------- external files

EXT = PROC.parent / "external"

# Categorical answers are carried as numbers so ranking, sorting, charting and
# the CSV export all keep working; the registry's `cats` maps them back to a
# label and a colour for the map.
BME_CODE = {"shortage": -1, "balance": 0, "surplus": 1}


def external_csv(name: str, key_col: int = 0, val_col: int = 2) -> dict:
    """data/external/<name>.csv -> {year: {code: value}}. Empty when absent."""
    p = EXT / f"{name}.csv"
    if not p.exists():
        return {}
    out: dict = collections.defaultdict(dict)
    with p.open(encoding="utf-8") as fh:
        rows = csv.reader(fh, delimiter=";")
        header = next(rows, None)
        for r in rows:
            if len(r) < 3:
                continue
            if len(r) <= max(key_col, val_col):
                continue
            code, year, raw = r[key_col].strip(), r[1].strip(), r[val_col].strip()
            v = BME_CODE.get(raw)
            if v is None:
                try:
                    v = float(raw)
                except ValueError:
                    continue
            out[year][code] = v
    return dict(out)


def dwellings_by_lan() -> dict:
    """Dwellings per län, summed from the kommun stock (TAB824, latest live year).

    Kronofogden publishes forced sales per län only, so the rate has to share
    that geography — a kommun denominator against a län numerator would invent
    precision the source does not have.
    """
    best, vals = None, collections.defaultdict(lambda: collections.defaultdict(float))
    try:
        rows = stream("scb_TAB824_kommun")
    except FileNotFoundError:
        return {}
    for r in rows:
        if r.get("ContentsCode") != "BO0104AH" or not r.get("value"):
            continue
        t = r["Tid"]
        if best is None or period_key(t) > period_key(best):
            best = t
        vals[t][r["Region"]] += r["value"]
    if best is None:
        return {}
    out: dict = collections.defaultdict(float)
    for code, v in vals[best].items():
        out[_LAN_OF.get(code, "")] += v
    return {k: v for k, v in out.items() if k}


_LAN_OF: dict = {}


# ---------------------------------------------------------------- geometry

def load_geo(name: str):
    p = GEO / f"{name}.geojson"
    if not p.exists():
        warn(f"data/geo/{name}.geojson missing — run 'make geo'")
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def rings_of(feature: dict) -> list:
    return [[[round(p[1], 5), round(p[0], 5)] for p in ring]
            for poly in feature["geometry"]["coordinates"] for ring in poly]


# ---------------------------------------------------------------- distributions

def pyramid(pull: str, keep: set) -> dict:
    """Age × sex counts per area, latest live year (TAB6574)."""
    bands = [c for c in (dim_labels("TAB6574", "Alder") or {}) if c != "totalt"]
    by: dict = collections.defaultdict(lambda: collections.defaultdict(dict))
    best = None
    for r in stream(pull):
        if r["Kon"] not in ("1", "2") or r["Alder"] == "totalt":
            continue
        if r["value"] in (None, 0):
            continue
        a = r["Region"]
        if a not in keep:
            continue
        t = r["Tid"]
        if best is None or period_key(t) > period_key(best):
            best = t
        by[t][a][(r["Alder"], r["Kon"])] = r["value"]
    if best is None:
        return {}
    out = {}
    for a, cells in by[best].items():
        m = [cells.get((b, "1"), 0) for b in bands]
        f = [cells.get((b, "2"), 0) for b in bands]
        if any(m) or any(f):
            out[a] = {"m": m, "f": f}
    return {"period": best, "bands": bands, "data": out}


def income_mix(pull: str, keep: set) -> dict:
    """Mean amount per income component, latest live year (TAB6683)."""
    comps = ["10", "30", "230", "70", "80", "100", "110", "120", "140", "150", "160", "170", "180"]
    labels = dim_labels("TAB6683", "Inkomstkomponenter")
    by: dict = collections.defaultdict(lambda: collections.defaultdict(dict))
    best = None
    for r in stream(pull):
        if r["ContentsCode"] != "000008A4" or r["Kon"] != "1+2":
            continue
        if r["Inkomstkomponenter"] not in comps or r["value"] in (None, 0):
            continue
        a = r["Region"]
        if a not in keep:
            continue
        t = r["Tid"]
        if best is None or period_key(t) > period_key(best):
            best = t
        by[t][a][r["Inkomstkomponenter"]] = r["value"]
    if best is None:
        return {}
    data = {a: [cells.get(c, 0) for c in comps] for a, cells in by[best].items()}
    return {"period": best, "comps": comps,
            "labels": [labels.get(c, c) for c in comps],
            "data": {a: v for a, v in data.items() if any(v)}}


def tenure_mix(pull: str, keep: set, dim: str, codes: list, table: str, cc: str) -> dict:
    """Dwellings (or persons) by tenure, latest live year."""
    labels = dim_labels(table, dim)
    by: dict = collections.defaultdict(lambda: collections.defaultdict(dict))
    best = None
    for r in stream(pull):
        if cc and r.get("ContentsCode") != cc:
            continue
        if r.get(dim) not in codes or r["value"] in (None, 0):
            continue
        a = r["Region"]
        if a not in keep:
            continue
        t = r["Tid"]
        if best is None or period_key(t) > period_key(best):
            best = t
        by[t][a][r[dim]] = by[t][a].get(r[dim], 0) + r["value"]
    if best is None:
        return {}
    data = {a: [cells.get(c, 0) for c in codes] for a, cells in by[best].items()}
    return {"period": best, "codes": codes,
            "labels": [labels.get(c, c) for c in codes],
            "data": {a: v for a, v in data.items() if any(v)}}


def industry_mix(pull: str, keep: set) -> dict:
    """Employed by industry, latest live year (TAB6681). The 16 SNI groups
    without the total and the 'not available' bucket."""
    labels = dim_labels("TAB6681", "SNI2007")
    codes = [c for c in labels if c not in ("A-U+US", "US")]
    by: dict = collections.defaultdict(lambda: collections.defaultdict(dict))
    best = None
    for r in stream(pull):
        if r.get("Kon") != "1+2" or r.get("ContentsCode") != "000008A0":
            continue
        if r.get("SNI2007") not in codes or not r["value"]:
            continue
        a = r["Region"]
        if a not in keep:
            continue
        t = r["Tid"]
        if best is None or period_key(t) > period_key(best):
            best = t
        by[t][a][r["SNI2007"]] = r["value"]
    if best is None:
        return {}
    data = {a: [cells.get(c, 0) for c in codes] for a, cells in by[best].items()}
    return {"period": best, "codes": codes,
            "labels": [labels.get(c, c) for c in codes],
            "data": {a: v for a, v in data.items() if any(v)}}


def selfsuff(pull: str, keep: set) -> dict:
    """Share of self-sufficient persons 20-64 by region of birth (TAB6766).

    Self-sufficiency is SCB's own measure: an income above a threshold set from
    the national median, so it says something about labour-market attachment
    that the unemployment rate alone does not.
    """
    labels = dim_labels("TAB6766", "Fodelseregion")
    codes = ["samt", "in", "ut"]
    by: dict = collections.defaultdict(lambda: collections.defaultdict(dict))
    best = None
    for r in stream(pull):
        if r.get("ContentsCode") != "000008GN" or r.get("Kon") != "1+2":
            continue
        if r.get("Alder") != "20-64" or r.get("Fodelseregion") not in codes:
            continue
        if r["value"] in (None, 0):
            continue
        a = r["Region"]
        if a not in keep:
            continue
        t = r["Tid"]
        if best is None or period_key(t) > period_key(best):
            best = t
        by[t][a][r["Fodelseregion"]] = r["value"]
    if best is None:
        return {}
    data = {a: [cells.get(c) for c in codes] for a, cells in by[best].items()}
    return {"period": best, "codes": codes,
            "labels": [labels.get(c, c) for c in codes],
            "data": {a: v for a, v in data.items() if any(x for x in v if x is not None)}}


# ---------------------------------------------------------------- main

def main() -> int:
    c = cfg()
    inds = c["indicators"]
    built = dt.date.today().isoformat()

    # ---- entities from geometry
    kom_geo = load_geo("kommuner")
    regso_geo = load_geo("regso")
    deso_geo = load_geo("deso")
    if not (kom_geo and regso_geo and deso_geo):
        print("geometry missing — run 'make geo' first", file=sys.stderr)
        return 1

    kommuner = {}
    for f in kom_geo["features"]:
        pr = f["properties"]
        kommuner[pr["code"]] = {"code": pr["code"], "name": pr["name"], "lan": pr.get("lan", ""),
                                "rings": rings_of(f), "hist": {}}
    regso = {}
    for f in regso_geo["features"]:
        pr = f["properties"]
        regso[pr["code"]] = {"code": pr["code"], "name": pr["name"], "kommun": pr["kommun"],
                             "lan": pr.get("lan", ""), "rings": rings_of(f), "hist": {}}
    deso = {}
    for f in deso_geo["features"]:
        pr = f["properties"]
        deso[pr["code"]] = {"code": pr["code"], "name": pr["plain"], "kommun": pr["kommun"],
                            "regso": pr["regso"], "lan": pr.get("lan", ""),
                            "rings": rings_of(f), "hist": {}}
    ENT = {"kommun": kommuner, "regso": regso, "deso": deso}
    _LAN_OF.update({c: e.get("lan", "") for c, e in kommuner.items()})
    print(f"entities: {len(kommuner)} kommun · {len(regso)} RegSO · {len(deso)} DeSO")

    # ---- population (also the weight for roll-ups)
    for level, pull in (("kommun", "scb_TAB6574_kommun"), ("regso", "scb_TAB6574_regso"),
                        ("deso", "scb_TAB6574_deso")):
        best, vals = None, collections.defaultdict(dict)
        for r in stream(pull):
            if r["Alder"] != "totalt" or r["Kon"] != "1+2" or not r["value"]:
                continue
            t = r["Tid"]
            if best is None or period_key(t) > period_key(best):
                best = t
            vals[t][r["Region"]] = r["value"]
        for a, v in (vals.get(best) or {}).items():
            if a in ENT[level]:
                ENT[level][a]["pop"] = v
        missing = [a for a in ENT[level] if "pop" not in ENT[level][a]]
        if missing:
            warn(f"{level}: {len(missing)} areas without population (e.g. {missing[:3]})")
        print(f"  population {level}: {best} · {len(vals.get(best) or {})} areas")

    # ---- indicators
    n_hist = int(c.get("history_years", 11))
    all_years: set = set()
    indicators_out = []

    for ind in inds:
        key = ind["key"]
        if ind.get("level") == "none":
            continue                                   # national series → market.json
        srcs = [s for s in ind["sources"] if s.get("role") != "denominator"]
        ext = next((s for s in srcs if s.get("db") in ("boverket", "kronofogden", "kolada")), None)
        if ext:
            ext_name = ext.get("file")
            byyear = external_csv(ext_name, val_col=int(ext.get("value_col", 2)))
            spread = ext.get("spread")          # "lan": one figure repeated over its kommuner
            per = ext.get("per")                # normalise by dwellings, e.g. per 10 000
            scale = float(ext.get("scale", 1))  # Kolada publishes kr/inhabitant, the page wants kSEK
            if scale != 1:
                byyear = {y: {a: v * scale for a, v in vals.items()} for y, vals in byyear.items()}
            if spread == "lan":
                dw = dwellings_by_lan()
                by_lan: dict = collections.defaultdict(list)
                for a, e in kommuner.items():
                    by_lan[e.get("lan")].append(a)
                spread_years = {}
                for y, vals in byyear.items():
                    out_y = {}
                    for lan, v in vals.items():
                        d = dw.get(lan)
                        if per and not d:
                            continue
                        rate = v / d * per if per else v
                        for a in by_lan.get(lan, []):
                            out_y[a] = round(rate, 3)
                    spread_years[y] = out_y
                byyear = spread_years
            if not byyear:
                indicators_out.append(meta_of(ind, {}, {}))
                warn(f"{key}: data/external/{ext_name}.csv not on disk — renders as 'no data'")
                continue
            years = sorted(byyear, key=int)[-n_hist:]
            all_years.update(years)
            for y in years:
                for a, v in byyear[y].items():
                    e = kommuner.get(a)
                    if e is not None:
                        e["hist"].setdefault(key, {})[y] = v
            last = years[-1]
            for a, v in byyear[last].items():
                if a in kommuner:
                    kommuner[a][key] = v
            indicators_out.append(meta_of(ind, {"kommun": last},
                                          {y: {"kommun": y} for y in years}))
            print(f"  {key:14s} kommun:{len(byyear[last])} · {years[0]}–{last}")
            continue
        if any(s.get("db") != "scb" for s in srcs):
            indicators_out.append(meta_of(ind, {}, {}))
            warn(f"{key}: no SCB source on disk — renders as 'no data'")
            continue

        asof: dict = {}
        hist_asof: dict = collections.defaultdict(dict)
        done_geo: set = set()
        for s in srcs:
            geo = s.get("geo")
            spread_lan = geo == "lan" or s.get("spread") == "lan"
            geo = "kommun" if geo in ("all", "lan") else geo
            if geo not in ENT or geo in done_geo:
                continue
            try:
                num, den, moe = aggregate(s, ind)
            except FileNotFoundError as exc:
                warn(f"{key}: {exc}")
                continue
            if not num:
                warn(f"{key}/{s['table']} {geo}: no rows survived the selection")
                continue
            done_geo.add(geo)

            # denominator that lives in another table (dwellings per 1 000)
            if ind["calc"] == "sum4q_per_1000":
                dnm = next((d for d in ind["sources"] if d.get("role") == "denominator"), None)
                dvals = {}
                if dnm:
                    dn, _, _ = aggregate(dnm, ind)
                    p = latest_in(list(dn), None)
                    dvals = dn.get(p) or {}

            def to_kommuner(vals: dict) -> dict:
                """A län figure repeated over each of its kommuner — the geography
                the source actually has, said plainly by the indicator's warn."""
                if not spread_lan:
                    return vals
                out = {}
                for a, e in kommuner.items():
                    v = vals.get(e.get("lan"))
                    if v is not None:
                        out[a] = v
                return out

            years = sorted({period_year(p) for p in num}, key=int)[-n_hist:]
            all_years.update(years)
            for y in years:
                vals, per = values_for(ind, s, num, den, y)
                vals = to_kommuner(vals)
                if not vals or per is None:
                    continue
                if ind["calc"] == "sum4q_per_1000":
                    vals = {a: v / dvals[a] * 1000 for a, v in vals.items() if dvals.get(a)}
                hist_asof[y][geo] = per
                tgt = ENT[geo]
                mvals = moe.get(per) or {}
                for a, v in vals.items():
                    e = tgt.get(a)
                    if e is None or v is None:
                        continue
                    e["hist"].setdefault(key, {})[y] = round(v, 3)
                    if a in mvals:
                        e["hist"].setdefault(key + "_moe", {})[y] = round(mvals[a], 3)

            # latest
            vals, per = values_for(ind, s, num, den, None)
            vals = to_kommuner(vals)
            if per is None:
                continue
            if ind["calc"] == "sum4q_per_1000":
                vals = {a: v / dvals[a] * 1000 for a, v in vals.items() if dvals.get(a)}
            asof[geo] = per
            mvals = moe.get(per) or {}
            for a, v in vals.items():
                e = ENT[geo].get(a)
                if e is None or v is None:
                    continue
                e[key] = round(v, 3)
                if a in mvals:
                    e[key + "_moe"] = round(mvals[a], 3)

        indicators_out.append(meta_of(ind, asof, dict(hist_asof)))
        cover = " · ".join(f"{g}:{sum(1 for e in ENT[g].values() if key in e)}" for g in ENT if g in asof)
        print(f"  {key:14s} {cover or 'no data'}")

    years_sorted = sorted(all_years, key=int)
    latest_year = years_sorted[-1] if years_sorted else ""

    # ---- distribution cards for the area pages (the slot the Danish BBR layer had)
    print("distributions…")
    dists = {}
    for level in ("kommun", "regso", "deso"):
        keep = set(ENT[level])
        dists[level] = {
            "age": pyramid(f"scb_TAB6574_{level}", keep),
            "income": income_mix(f"scb_TAB6683_{level}", keep),
            "tenure": (tenure_mix(f"scb_TAB824_kommun", keep, "Upplatelseform",
                                  ["1", "2", "3", "ÖVRIGT"], "TAB824", "BO0104AH")
                       if level == "kommun" else
                       tenure_mix(f"scb_TAB6638_{level}", keep, "Upplatelseform",
                                  ["1", "2", "3", "ÖVRIGT"], "TAB6638", "00000864")),
            # TAB6681 is published for RegSO and DeSO only; the kommun mix is
            # summed from its RegSO, which is exact for counts.
            "industry": (industry_mix(f"scb_TAB6681_regso", set(regso)) if level == "kommun"
                         else industry_mix(f"scb_TAB6681_{level}", keep)
                         if level == "regso" else {}),
            # TAB6766 has kommun and RegSO, no DeSO.
            "selfsuff": (selfsuff(f"scb_TAB6766_{level}", keep)
                         if level in ("kommun", "regso") else {}),
        }
        for what, d in dists[level].items():
            print(f"  {level:7s} {what:7s} {len(d.get('data') or {}):5d} areas · {d.get('period', '–')}")

    ind_regso = dists["kommun"].get("industry") or {}
    if ind_regso.get("data"):
        rolled: dict = collections.defaultdict(lambda: [0.0] * len(ind_regso["codes"]))
        for a, v in ind_regso["data"].items():
            k = regso[a]["kommun"] if a in regso else None
            if k:
                for i, x in enumerate(v):
                    rolled[k][i] += x
        dists["kommun"]["industry"] = {**ind_regso, "data": {k: [round(x) for x in v]
                                                             for k, v in rolled.items()}}
    for level in ("kommun", "regso", "deso"):
        for what, d in dists[level].items():
            for a, v in (d.get("data") or {}).items():
                ENT[level][a].setdefault("dist", {})[what] = v

    dist_meta = {what: {"period": dists["kommun"][what].get("period"),
                        "labels": dists["kommun"][what].get("labels"),
                        "bands": dists["kommun"][what].get("bands"),
                        "comps": dists["kommun"][what].get("comps"),
                        "codes": dists["kommun"][what].get("codes")}
                 for what in ("age", "income", "tenure", "industry", "selfsuff")}

    # ---- DeSO goes to one file per kommun, loaded on demand
    DESO_DIR.mkdir(parents=True, exist_ok=True)
    for old in DESO_DIR.glob("*.json"):
        old.unlink()
    by_kommun: dict = collections.defaultdict(list)
    for e in deso.values():
        by_kommun[e["kommun"]].append(e)
    index = {}
    for kod, items in by_kommun.items():
        items.sort(key=lambda e: e["code"])
        (DESO_DIR / f"{kod}.json").write_text(
            json.dumps({"kommun": kod, "areas": items}, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8")
        index[kod] = {"n": len(items), "file": f"deso/{kod}.json"}
    (DESO_DIR / "index.json").write_text(
        json.dumps({"kommuner": index, "built": built}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8")
    total_mb = sum(p.stat().st_size for p in DESO_DIR.glob("*.json")) / 1e6
    print(f"deso: {len(index)} files · {total_mb:.1f} MB total · "
          f"largest {max(p.stat().st_size for p in DESO_DIR.glob('*.json')) / 1e3:.0f} kB")

    # ---- sources
    sources, seen = [], set()
    for ind in inds:
        for s in ind["sources"]:
            t = s.get("table")
            if not t or t in seen or s.get("db") != "scb":
                continue
            seen.add(t)
            m = table_meta(t)
            sources.append({"key": t, "label": f"SCB {t}", "tables": m.get("label", ""),
                            "asof": (m.get("updated") or "")[:10],
                            "url": f"https://www.statistikdatabasen.scb.se/pxweb/sv/ssd/START__{t}/",
                            "licence": "CC0"})
    for s in inds:
        pass
    if (PROC.parent / "raw" / "riksbank_SECBREPOEFF.json").exists():
        sources.append({"key": "riksbank", "label": "Riksbanken SWEA", "tables": "SECBREPOEFF, SEGVB10YC",
                        "asof": built, "url": "https://api.riksbank.se/swea/v1", "licence": "free reuse"})

    out = {
        "meta": {
            "built": built,
            "sources": sorted(sources, key=lambda s: s["key"]),
            "attribution": ["Källa: SCB (CC0)", "Sveriges riksbank, SWEA",
                            "Boundaries: SCB RegSO/DeSO 2025 (CC0)",
                            "Coastline: OpenStreetMap land polygons (ODbL)",
                            "Boverket, Bostadsmarknadsenkäten"],
            "years": years_sorted,
            "latest_year": latest_year,
            "levels": {"kommun": len(kommuner), "regso": len(regso), "deso": len(deso)},
            "dist": dist_meta,
            "note": ("RegSO and DeSO were re-cut on 2025-01-01; SCB publishes the 2025 division "
                     "from 2024 onwards, so areas below kommun have two years of history at most "
                     "while kommuner have eleven. Values suppressed by the source stay empty and "
                     "render as – — never as 0."),
            "warnings": warnings,
        },
        "indicators": indicators_out,
        "kommuner": sorted(kommuner.values(), key=lambda m: -(m.get("pop") or 0)),
        "regso": sorted(regso.values(), key=lambda a: a["code"]),
        "deso_index": index,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"\nwrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB): "
          f"{len(kommuner)} kommuner, {len(regso)} RegSO, {len(indicators_out)} indicators")
    for w in warnings:
        print("  ⚠", w)
    return 0


def meta_of(ind: dict, asof: dict, hist_asof: dict) -> dict:
    out = {k: ind[k] for k in ("key", "label", "short", "unit", "level", "levels", "hue", "group")
           if k in ind}
    if ind.get("cats"):
        out["cats"] = ind["cats"]
    out.update({"fmt": ind.get("fmt", "pct1"), "desc": ind.get("desc", ""),
                "source": ind.get("source", ""), "warn": ind.get("warn", ""),
                "note": ind.get("note", ""), "moe": bool(ind.get("moe")),
                "moe_rel": (ind.get("moe") or {}).get("suppress_if_rel_gt"),
                "asof": asof, "hist_asof": hist_asof})
    return out


if __name__ == "__main__":
    raise SystemExit(main())
