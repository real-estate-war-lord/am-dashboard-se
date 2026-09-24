#!/usr/bin/env python3
"""Schools: per-school records, per-kommun point files, and area aggregates.

WHAT SKOLVERKET ACTUALLY PUBLISHES, and what that forces:

  * `valueType` is the whole story. EXISTS is a number;
    OMITTED_DUE_TO_BASED_ON_FEW_PUPILS is `..`, MISSING is nothing, and
    ROUNDED_OFF_DUE_TO_FEW_PUPILS_NOT_ELIGIBLE is `~100`. None of them is 0, and
    a suppressed school must not drag an average down.
  * `totalNumberOfPupils` is ALWAYS A BAND — "cirka 590" — never an exact count.
    It is the only size measure published, so it is what a pupil-weighted mean
    can weight by, and the indicator says so. It also counts the WHOLE unit, not
    the year-9 cohort, so an F-9 school weighs more than a 7-9 school with the
    same year-9 group. Stated rather than silently corrected.
  * `timePeriod` is the school year the pupils finished. Merit and eligibility
    run to 2025/26; the national tests lag one year at 2024/25. Each metric
    therefore carries its own period rather than sharing one "as of".

SALSA is NOT here. Skolverket's only remaining route to it is a stateful Oracle
APEX app with checksummed form posts and no export; there is no bulk file. The
merit value shipped here is the RAW one, which is exactly the
socioeconomically-confounded number SALSA exists to correct, and every label
says so.

    python3 scripts/build_schools.py
"""
from __future__ import annotations

import collections
import datetime as dt
import json
import math
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from se_common import GEO, PROC, ROOT                                    # noqa: E402

RAW = ROOT / "data" / "raw" / "skolverket"
OUT = PROC / "schools"

# field -> (short key, decimals). Only year-9 measures and the two staffing ones.
# Skolinspektionen's indices, joined by skolenhetskod. Kept apart from METRICS
# in the fetch, but aggregated the same way.
ENK = {"trygghet": ("trygghet", 2), "studiero": ("studiero", 2)}
METRICS = {
    "averageGradesMeritRating9thGrade":            ("merit", 1),
    "ratioOfPupilsIn9thGradeWithAllSubjectsPassed": ("passed", 1),
    "ratioOfPupils9thGradeEligibleForNationalProgramYR": ("eligible", 1),
    "averageResultNationalTestsSubjectSVE9thGrade": ("nt_sve", 1),
    "averageResultNationalTestsSubjectENG9thGrade": ("nt_eng", 1),
    "averageResultNationalTestsSubjectMA9thGrade":  ("nt_ma", 1),
    "certifiedTeachersQuota":                       ("certified", 1),
    "studentsPerTeacherQuota":                      ("per_teacher", 1),
}
PUPILS = "totalNumberOfPupils"


def num(v) -> float | None:
    """A Skolverket value. Swedish decimal comma; `..`, `~100` and None are not
    numbers and never become 0."""
    if v is None:
        return None
    s = str(v).replace("\xa0", " ").strip()
    if not s or s in ("..", ".", "-", "None"):
        return None
    s = s.replace(" ", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def pupils_of(v) -> int | None:
    """"cirka 590" -> 590. The band is the published figure; nothing sharper exists."""
    if v is None:
        return None
    m = re.search(r"(\d[\d\s ]*)", str(v))
    if not m:
        return None
    try:
        return int(m.group(1).replace(" ", "").replace("\xa0", ""))
    except ValueError:
        return None


def newest(rows: list) -> tuple[float | None, str, str]:
    """The newest row that is an actual number, with its period and valueType."""
    for r in sorted(rows or [], key=lambda x: x.get("timePeriod") or "", reverse=True):
        vt = r.get("valueType")
        v = num(r.get("value"))
        if v is not None and vt == "EXISTS":
            return v, r.get("timePeriod") or "", vt
    # nothing usable — report the newest row's reason so the UI can say why
    for r in sorted(rows or [], key=lambda x: x.get("timePeriod") or "", reverse=True):
        return None, r.get("timePeriod") or "", r.get("valueType") or "MISSING"
    return None, "", "MISSING"


def main() -> int:
    try:
        from shapely.geometry import shape, Point
        from shapely.strtree import STRtree
    except ImportError:
        print("shapely is needed for this step — see requirements-geo.txt", file=sys.stderr)
        return 1

    units = json.loads((RAW / "units.json").read_text(encoding="utf-8"))
    schools, no_stats, no_coord = [], 0, 0
    for u in units:
        code = u["code"]
        det = json.loads((RAW / "unit" / f"{code}.json").read_text(encoding="utf-8"))
        d = det.get("body") or {}
        lat, lon = num(d.get("wgs84_Lat")), num(d.get("wgs84_Long"))
        if lat is None or lon is None:
            no_coord += 1
            continue
        g = json.loads((RAW / "gr" / f"{code}.json").read_text(encoding="utf-8"))
        b = g.get("body") or {}
        if g.get("_missing") or not b:
            no_stats += 1
            b = {}
        rec = {
            "code": code,
            "name": d.get("name") or u.get("name") or "",
            "kommun": d.get("geographicalAreaCode") or "",
            "lat": round(lat, 6), "lon": round(lon, 6),
            "principal": d.get("principalOrganizerType") or "",
            "org": d.get("corporationName") or "",
        }
        p, pper, _ = newest(b.get(PUPILS))
        rec["pupils"] = pupils_of((b.get(PUPILS) or [{}])[0].get("value")) if b.get(PUPILS) else None
        rec["pupils_period"] = pper
        for field, (short, dec) in METRICS.items():
            v, per, vt = newest(b.get(field))
            rec[short] = round(v, dec) if v is not None else None
            rec[short + "_period"] = per
            if v is None:
                rec[short + "_why"] = vt
        schools.append(rec)

    # --- Skolinspektionen's Skolenkäten, joined on skolenhetskod ---
    enk = {}
    ep = ROOT / "data" / "external" / "skolenkaten.csv"
    if ep.exists():
        import csv as _csv
        with ep.open(encoding="utf-8") as fh:
            for r in _csv.DictReader(fh, delimiter=";"):
                enk[r["skolenhetskod"]] = r
    hit = 0
    for rec in schools:
        e = enk.get(rec["code"])
        if not e:
            continue
        for k in ("trygghet", "studiero"):
            v = num(e.get(k))
            if v is not None:
                rec[k] = round(v, 2)
        if rec.get("trygghet") is not None or rec.get("studiero") is not None:
            rec["enk_year"] = e.get("year")
            hit += 1
    if enk:
        print(f"  Skolenkäten joined to {hit:,} of {len(schools):,} schools "
              f"(the survey runs on a roughly two-year rotation)")

    print(f"{len(schools):,} schools with coordinates "
          f"({no_coord} without, {no_stats} with no statistics block)")

    # --- attach RegSO and DeSO by point-in-polygon on our own rings ---
    pts = [Point(s["lon"], s["lat"]) for s in schools]
    for level, fname, prop in (("regso", "regso.geojson", "code"),
                               ("deso", "deso.geojson", "code")):
        data = json.loads((GEO / fname).read_text(encoding="utf-8"))
        geoms, props = [], []
        for f in data["features"]:
            geoms.append(shape(f["geometry"]))
            props.append(f["properties"])
        tree = STRtree(geoms)
        hit = 0
        for s, pt in zip(schools, pts):
            for i in tree.query(pt):
                if geoms[i].contains(pt):
                    s[level] = props[i][prop]
                    hit += 1
                    break
        print(f"  {level}: {hit:,} of {len(schools):,} schools located")

    # --- per-kommun point files for the lazy overlay ---
    OUT.mkdir(parents=True, exist_ok=True)
    for p in OUT.glob("*.json"):
        p.unlink()
    by_kommun: dict = collections.defaultdict(list)
    for s in schools:
        if s["kommun"]:
            by_kommun[s["kommun"]].append(s)
    index = {}
    for code, lst in sorted(by_kommun.items()):
        lats = [s["lat"] for s in lst]; lons = [s["lon"] for s in lst]
        (OUT / f"{code}.json").write_text(
            json.dumps(lst, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        index[code] = {"n": len(lst),
                       "bbox": [round(min(lats), 4), round(min(lons), 4),
                                round(max(lats), 4), round(max(lons), 4)]}
    print(f"  wrote {len(index)} per-kommun files → {OUT.relative_to(ROOT)}")

    # --- area aggregates: pupil-weighted means of published values, and counts ---
    agg: dict = {lvl: collections.defaultdict(lambda: collections.defaultdict(list))
                 for lvl in ("kommun", "regso", "deso")}
    for s in schools:
        for lvl, key in (("kommun", s.get("kommun")), ("regso", s.get("regso")),
                         ("deso", s.get("deso"))):
            if not key:
                continue
            agg[lvl][key]["_n"].append(1)
            w = s.get("pupils")
            if w:
                agg[lvl][key]["_pupils"].append(w)
            for short in [x[0] for x in METRICS.values()] + list(ENK):
                v = s.get(short)
                if v is not None:
                    agg[lvl][key][short].append((v, w or 0))

    out: dict = {}
    for lvl, areas in agg.items():
        out[lvl] = {}
        for key, cols in areas.items():
            row = {"schools_n": len(cols["_n"]),
                   "pupils_n": sum(cols["_pupils"]) if cols["_pupils"] else None}
            for short, dec in ([(x[0], x[1]) for x in METRICS.values()]
                               + [(k, v[1]) for k, v in ENK.items()]):
                pairs = cols.get(short) or []
                wsum = sum(w for _v, w in pairs)
                if not pairs:
                    continue
                if wsum > 0:
                    row[short] = round(sum(v * w for v, w in pairs) / wsum, dec)
                    row[short + "_w"] = "pupils"
                else:
                    row[short] = round(sum(v for v, _w in pairs) / len(pairs), dec)
                    row[short + "_w"] = "unweighted"
                row[short + "_n"] = len(pairs)
            out[lvl][key] = row
        print(f"  {lvl}: {len(out[lvl]):,} areas with at least one school")

    meta = {
        "source": "Skolverket, planned-educations v4",
        # the roster is a snapshot of the register on the day it was pulled; a
        # count of schools has no publication period of its own, so this is its
        # "as of"
        "fetched": dt.date.fromtimestamp(
            (RAW / "units.json").stat().st_mtime).isoformat(),
        "schools": len(schools),
        "periods": {short: sorted({s[short + "_period"] for s in schools
                                   if s.get(short + "_period")})[-1:]
                    for _, (short, _d) in METRICS.items()},
        "enkat": {"schools": sum(1 for s in schools if s.get("enk_year")),
                  "years": sorted({s["enk_year"] for s in schools if s.get("enk_year")}),
                  "note": "Skolinspektionen's Skolenkäten runs on a roughly "
                          "two-year rotation, so this is the union of the two most "
                          "recent rounds and each school carries its own year. An "
                          "index needs at least five respondents; a masked cell is "
                          "blank, a genuine zero is 0."},
        "pupils_note": "Skolverket publishes pupil counts as rounded bands "
                       "('cirka 590') for the whole school unit, not the year-9 "
                       "cohort. That band is the weight.",
        # the pupil-weighted national mean, for the "vs Sweden" line in a popup
        "national_merit": (lambda ps: round(sum(v * w for v, w in ps) / sum(w for _v, w in ps), 1)
                           if ps and sum(w for _v, w in ps) else None)(
            [(s["merit"], s.get("pupils") or 0) for s in schools
             if s.get("merit") is not None and s.get("pupils")]),
        "salsa": "not available — no bulk export exists; the merit value here is "
                 "the raw one, not adjusted for pupil background",
    }
    (PROC / "schools.json").write_text(
        json.dumps({"meta": meta, "index": index, "areas": out},
                   ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    sz = (PROC / "schools.json").stat().st_size
    print(f"wrote {(PROC / 'schools.json').relative_to(ROOT)} ({sz / 1024:.0f} kB)")
    print("  newest period per metric: " + ", ".join(
        f"{k}={(v or ['-'])[0]}" for k, v in meta["periods"].items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
