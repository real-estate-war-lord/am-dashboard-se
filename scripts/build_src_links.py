#!/usr/bin/env python3
"""Add `src_verify` to every indicator — the query that reproduces the shown figure.

"Verify at source" is not a link to a front page. It is the publisher's own query
for exactly the cells the dashboard is showing, so a reader can fetch the number
themselves and get the same answer. This script builds one entry per level an
indicator serves, taking the dimension names and value codes from the metadata
already on disk — nothing here is guessed, and an entry that cannot be built is
reported rather than invented.

    python3 scripts/build_src_links.py            # rewrite config/indicators.json
    python3 scripts/build_src_links.py --check    # report only, change nothing

The page fills in the region code and the year at click time (`indSrcLink` in
src/app.js); scripts/check_source_links.py re-fetches the result and recomputes
the displayed value from it.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from se_common import CFG, table_meta                                    # noqa: E402

SCB_API = "https://api.scb.se/OV0104/v2beta/api/v2"
KOLADA_API = "https://api.kolada.se/v3"

# Which Region codes a level asks for. The page substitutes the actual code; this
# is only here so an entry records which level it can answer for — sending a DeSO
# code to a kommun-only table is a 400, not a wrong answer.
LEVELS = ("kommun", "regso", "deso")
# The 21 län. A four-digit Region code is a kommun only when its first two digits
# are one of these: SCB also publishes *riksområden* as four-digit codes (0010,
# 0020, 0030, 0060), and mistaking one of those for a kommun is how the first cut
# of this script produced links that 400 on every kommun in the country.
LAN_CODES = {"01", "03", "04", "05", "06", "07", "08", "09", "10", "12", "13",
             "14", "17", "18", "19", "20", "21", "22", "23", "24", "25"}
# A national series has level "none": it is still verifiable, it just has no
# region code to substitute, so its entry records level "national" and the page
# leaves valueCodes[Region] off.
ALL_LEVELS = LEVELS + ("none",)

# Sources that are a file import rather than a queryable API: the honest link is
# the publisher's own page for the dataset, which the registry records per source.
PAGE_ONLY = {
    # Brå's SOL is a stateful session app: there is no URL that reproduces one
    # kommun's figure, so the honest "verify at source" is the selection form
    # itself, which is where a reader would go to rebuild the query by hand.
    # Brå's own page states it has no public open-data API.
    # Skolverket's API answers per school, not per area, so the verifiable route
    # is the school-unit endpoint the figures are built from.
    "skolverket": ("Skolverket, planned-educations v4",
                   "https://api.skolverket.se/planned-educations/v4/school-units"),
    # Polisen publishes the designation as one file, so the verifiable thing is
    # that file itself plus the report that explains the classes.
    "polisen": ("Polismyndigheten, utsatta områden 2025",
                "https://polisen.se/om-polisen/polisens-arbete/utsatta-omraden/"),
    "bra": ("Brå, Statistik On-Line (anmälda brott)",
            "https://statistik.bra.se/solwebb/action/anmalda/urval/urval?menyid=101"),
    "boverket": ("Boverket, Bostadsmarknadsenkäten",
                 "https://www.boverket.se/sv/samhallsplanering/bostadsmarknad/"
                 "bostadsmarknadsenkaten-i-korthet/"),
    "kronofogden": ("Kronofogden, försäljning av bostäder",
                    "https://kronofogden.se/om-kronofogden/statistik"),
    "riksbank": ("Sveriges riksbank, SWEA API",
                 "https://www.riksbank.se/sv/statistik/rantor-och-valutakurser/"),
}


# table -> its period codes, for the monthly and quarterly tables only. Shared at
# the top of the config rather than copied into each of the 70 entries: the same
# table backs several indicators at several levels, and six copies of 250 period
# codes is most of the file.
PERIODS: dict[str, list[str]] = {}


def scb_entry(ind: dict, src: dict, level: str) -> tuple[dict | None, str]:
    table = src.get("table")
    meta = table_meta(table)
    if not meta:
        return None, f"{ind['key']}/{table}: no metadata on disk"
    dims = meta.get("dimension") or {}
    region = next((d for d in dims if d.lower().startswith("region")), None)
    time = "Tid" if "Tid" in dims else None
    if not time:
        return None, f"{ind['key']}/{table}: no Tid dimension"

    # A year is not a valid Tid code on a monthly or quarterly table — asking
    # TAB6260 for "2025" is a 400, not an empty answer. Record the granularity
    # and the table's own period codes so a consumer can expand a year into the
    # periods that actually exist, rather than constructing "2025M01".."M12" and
    # asking for months the table does not have.
    tcodes = list(((dims[time].get("category") or {}).get("index") or {}))
    kind = ("month" if any(re.match(r"^\d{4}M\d{2}$", c) for c in tcodes)
            else "quarter" if any(re.match(r"^\d{4}[KQ]\d$", c) for c in tcodes)
            else "year" if any(re.match(r"^\d{4}$", c) for c in tcodes) else "other")
    if kind != "year":
        PERIODS[table] = tcodes

    # Which geography the table's Region codes actually are. Several tables the
    # dashboard shows at kommun level only publish at län — brf_price and taxv
    # are län figures repeated across their kommuner, and the smoke test already
    # asserts that. Sending a kommun code to one of those is an HTTP 400
    # "Non-existent value", so the entry records the code level to send, which is
    # not always the level the figure is displayed at.
    rcodes = list(((dims.get(region) or {}).get("category") or {}).get("index") or {}) if region else []
    have = set()
    for c in rcodes:
        base = c.split("_", 1)[0]
        if re.match(r"^\d{4}R\d{3}$", base):
            have.add("regso")
        elif re.match(r"^\d{4}[A-Z]\d{4}$", base):
            have.add("deso")
        elif re.match(r"^\d{4}$", base):
            have.add("kommun" if base[:2] in LAN_CODES else "riksomrade")
        elif re.match(r"^\d{2}$", base):
            have.add("lan")
        elif base in ("00", "0", "Riket", "SE"):
            have.add("riket")
    # finest available at or above the display level
    order = ["deso", "regso", "kommun", "lan", "riksomrade", "riket"]
    want = order.index(level) if level in order else order.index("kommun")
    code_level = next((l for l in order[want:] if l in have), None)

    # Every non-eliminable dimension must be pinned or the query is a 400. The
    # registry's `vars` already carry the ones the pull selected; anything else
    # that cannot be eliminated is taken from the metadata, first code only, and
    # flagged so the mismatch shows up in check_source_links.py rather than here.
    varz = dict(src.get("vars") or {})
    pinned = []
    for d, spec in dims.items():
        if d in (region, time) or d in varz:
            continue
        if (spec.get("extension") or {}).get("elimination"):
            continue
        codes = list(((spec.get("category") or {}).get("index") or {}))
        if not codes:
            return None, f"{ind['key']}/{table}: dimension {d} has no codes"
        varz[d] = [codes[0]]
        pinned.append(d)

    return {
        "level": level,
        "db": "scb",
        "table": table,
        "api": f"{SCB_API}/tables/{table}/data",
        "table_url": f"{SCB_API}/tables/{table}?lang=en",
        "region_dim": region,
        "time_dim": time,
        "time_kind": kind,
        "newest_period": tcodes[-1] if tcodes else None,
        "code_level": code_level,
        "region_levels": sorted(have),
        "vars": varz,
        "auto_pinned": pinned,
        "publisher": "SCB",
        "label": f"SCB {table}",
        "updated": meta.get("updated"),
    }, ""


def kolada_entry(ind: dict, src: dict, level: str) -> tuple[dict | None, str]:
    # The registry records the KPI in `source` as "Kolada (RKA), KPI N03046".
    kpi = src.get("kpi") or ""
    if not kpi:
        text = ind.get("source") or ""
        if "KPI " in text:
            kpi = text.split("KPI ", 1)[1].split()[0].strip(" .,")
    if not kpi:
        return None, f"{ind['key']}: Kolada source with no KPI id"
    return {
        "level": level,
        "db": "kolada",
        "kpi": kpi,
        "api": f"{KOLADA_API}/data/kpi/{kpi}/municipality",
        "table_url": f"{KOLADA_API}/kpi?id={kpi}",
        "publisher": "Kolada (RKA)",
        "label": f"Kolada {kpi}",
    }, ""


def build(ind: dict) -> tuple[list[dict], list[str]]:
    out, notes = [], []
    srcs = ind.get("sources") or []
    for level in ind.get("levels") or []:
        if level not in ALL_LEVELS:
            continue
        if level == "none":
            level = "national"
        # the source whose geo matches this level, else the one that covers "all"
        src = next((s for s in srcs if s.get("geo") == level), None) \
            or next((s for s in srcs if s.get("geo") in ("all", "none", "kommun")), None) \
            or (srcs[0] if srcs else None)
        if not src:
            notes.append(f"{ind['key']}: no source at all")
            continue
        db = src.get("db")
        if db == "scb":
            e, why = scb_entry(ind, src, level)
        elif db == "kolada":
            e, why = kolada_entry(ind, src, level)
        elif db in PAGE_ONLY:
            lab, url = PAGE_ONLY[db]
            e, why = {"level": level, "db": db, "publisher": lab,
                      "label": lab, "page": url}, ""
        else:
            e, why = None, f"{ind['key']}: unknown db '{db}'"
        if e:
            out.append(e)
        if why:
            notes.append(why)
    return out, notes


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()

    cfg = json.loads(CFG.read_text(encoding="utf-8"))
    inds = cfg["indicators"]
    total, without, all_notes = 0, [], []
    for ind in inds:
        entries, notes = build(ind)
        all_notes += notes
        if entries:
            ind["src_verify"] = entries
            total += len(entries)
        else:
            ind.pop("src_verify", None)
            without.append(ind["key"])

    cfg["src_periods"] = PERIODS
    print(f"{total} verify-at-source queries across {len(inds) - len(without)} indicators; "
          f"period codes for {len(PERIODS)} non-yearly table(s)")
    if without:
        print(f"  no query for {len(without)}: {', '.join(without)}")
    for n in all_notes:
        print("  ⚠", n)
    pinned = {e["table"] for i in inds for e in (i.get("src_verify") or [])
              if e.get("auto_pinned")}
    if pinned:
        print(f"  note: a dimension was pinned from metadata in {len(pinned)} table(s) — "
              "check_source_links.py recomputes, so a wrong pin shows up there")

    if not a.check:
        CFG.write_text(json.dumps(cfg, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print(f"wrote {CFG}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
