#!/usr/bin/env python3
"""Reported offences per kommun from Brå's SOL (Statistik On-Line).

Brå has no open-data API — its own page says so — so the only machine route to
kommun-level crime is the SOL web application. It is a session-based JSP app
from the 2000s, and this drives it the way a browser would: open a session,
load the selection form (which carries the whole vocabulary as JS arrays), post
a selection, run it, and ask for the tab-separated result.

TRAPS, all verified live:

  * The id separator is `*`, NOT a comma. A comma returns HTTP 200 with all but
    one id silently dropped — the same failure mode as repeating SCB's
    valueCodes[X]. Data loss with no error.
  * `/urval?menyid=…` is a 993-byte stub unless a JSESSIONID from
    `/action/start` is presented with it.
  * statistik.bra.se serves a MISMATCHED TLS intermediate; see http_util.py.
    Verification stays on.
  * Bodies are ISO-8859-1, not UTF-8.
  * Heby appears twice, split by its 2007 move from Västmanland to Uppsala
    (8556 current, 8608 to 2006). We take the current entity only and let its
    series start where SCB's does — splicing two entities would be inventing
    a continuous kommun that did not exist.

Output: data/raw/bra/<key>.csv, one file per offence type, gitignored and
resumable — a file already on disk is not fetched again.

    python3 scripts/fetch_bra.py            # yearly, all offence types
    python3 scripts/fetch_bra.py --quarters # plus the quarterly total
    python3 scripts/fetch_bra.py --refresh  # ignore what is on disk
"""
from __future__ import annotations

import argparse
import http.cookiejar
import json
import pathlib
import re
import sys
import urllib.parse
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from http_util import UA, bra_context                                    # noqa: E402
from se_common import PROC, ROOT                                         # noqa: E402

BASE = "https://statistik.bra.se/solwebb/action"
OUT = ROOT / "data" / "raw" / "bra"
MENY_YEAR = 101          # kommun + storstädernas stadsområden, yearly 1996-
MENY_QUARTER = 90        # the same regions, monthly and quarterly

# Offence types, by Brå's own published category. Nothing here is a composite
# we invented except `drugs_weapons`, which is the sum of two published rows and
# is labelled as such.
OFFENCES = {
    "total":         ["5036"],            # Totalt antal brott
    "person":        ["11086"],           # 3-7 kap. Brott mot person
    "theft":         ["11095"],           # 8 kap. Stöld, rån m.m.
    "burglary":      ["11462"],           # Stöld genom inbrott, inbrottsstöld i bostad
    "vandalism":     ["11099"],           # 12 kap. Skadegörelsebrott
    "drugs_weapons": ["11650", "11708"],  # narkotikastrafflagen + vapenlagen
}

HEBY = "8556"            # Heby kommun (Uppsala län from 2007); 8608 is the pre-2007 entity


class Sol:
    def __init__(self) -> None:
        self.cj = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=bra_context()),
            urllib.request.HTTPCookieProcessor(self.cj))
        self.op.open(urllib.request.Request(
            f"{BASE}/start?menykatalogid=1", headers=dict(UA)), timeout=60).read()
        self._vocab: dict[int, str] = {}

    def _req(self, url: str, form: dict | None = None) -> bytes:
        data = urllib.parse.urlencode(form).encode("iso-8859-1") if form is not None else None
        h = dict(UA)
        if data is not None:
            h["Content-Type"] = "application/x-www-form-urlencoded"
        r = self.op.open(urllib.request.Request(url, data=data, headers=h), timeout=180)
        return r.read()

    def form(self, menyid: int) -> str:
        if menyid not in self._vocab:
            self._vocab[menyid] = self._req(
                f"{BASE}/anmalda/urval/urval?menyid={menyid}").decode("iso-8859-1", "replace")
        return self._vocab[menyid]

    def array(self, menyid: int, name: str) -> list[str]:
        return re.findall(rf"{name}\[\d+\]\s*=\s*[\"']([^\"']+)[\"']", self.form(menyid))

    def regions(self, menyid: int) -> dict[str, str]:
        """kommun name -> SOL region id. Only the 290 kommuner, never a stadsdel."""
        out = {}
        for row in self.array(menyid, "arrayRegionNivaEtt"):
            rid, lab = row.split("*", 1)
            lab = lab.replace("\xa0", " ").replace("\\xA0", " ").strip()
            if not lab.endswith(" kommun"):
                continue                         # stadsdelsområde, or a dated variant
            out[lab[:-7].strip()] = rid
        # the two Heby entities both end in " kommun" only after the paren is stripped
        for row in self.array(menyid, "arrayRegionNivaEtt"):
            rid, lab = row.split("*", 1)
            if rid == HEBY:
                out["Heby"] = rid
        return out

    def periods(self, menyid: int) -> list[tuple[str, str]]:
        """(period id, label) newest first, as SOL lists them."""
        out = []
        for row in self.array(menyid, "arrayPeriod"):
            bits = row.split("*")
            out.append((bits[0], bits[1] if len(bits) > 1 else ""))
        return out

    def run(self, menyid: int, offences: list[str], regions: list[str],
            periods: list[str]) -> bytes:
        self.form(menyid)                        # the selection is session state
        cells = len(offences) * len(regions) * len(periods) * 2
        self._req(f"{BASE}/anmalda/urval/vantapopup", {
            "brottstyp_id_string": "*".join(offences),
            "region_id_string": "*".join(regions),
            "period_id_string": "*".join(periods),
            "fordelning_id_string": "",
            "antal": "1", "antal_100k": "1", "har_valt": str(cells)})
        self._req(f"{BASE}/anmalda/urval/sok")
        return self._req(f"{BASE}/anmalda/resultat/textfil", {})


def kommun_names() -> dict[str, str]:
    makro = json.loads((PROC / "makro.json").read_text(encoding="utf-8"))
    return {k["name"]: k["code"] for k in makro["kommuner"]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quarters", action="store_true")
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--quarter-years", type=int, default=12)
    a = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    ours = kommun_names()
    sol = Sol()

    reg = sol.regions(MENY_YEAR)
    missing = sorted(set(ours) - set(reg))
    if missing:
        print(f"ERROR: {len(missing)} kommuner have no SOL region id: {missing}", file=sys.stderr)
        return 1
    ids = [reg[n] for n in ours]
    print(f"{len(ids)} kommun region ids resolved (Heby = {reg['Heby']})")

    years = [pid for pid, lab in sol.periods(MENY_YEAR)]
    print(f"{len(years)} yearly periods")

    # A nested selection brings its ancestors back as `..` placeholder rows, so
    # the importer has to know which row label belongs to which code it asked
    # for. Hardcoding the labels would rot the first time Brå renames a category,
    # so the mapping is written here, from the vocabulary in the live session.
    labels = {}
    for row in sol.array(MENY_YEAR, "arrayNivaett"):
        cid, lab = row.split("*", 1)
        labels[cid] = lab.replace("\xa0", " ").replace("\\xA0", " ").strip()

    for key, codes in OFFENCES.items():
        path = OUT / f"{key}.csv"
        side = OUT / f"{key}.meta.json"
        side.write_text(json.dumps({
            "key": key, "codes": codes,
            "labels": {c: labels.get(c, "") for c in codes},
            "menyid": MENY_YEAR, "regions": len(ids), "periods": len(years),
            "source": "Brå, Statistik On-Line (anmälda brott)",
            "fetched": __import__("datetime").date.today().isoformat(),
        }, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        if path.exists() and not a.refresh:
            print(f"  {key:14s} cached ({path.stat().st_size:,} bytes) · "
                  f"{', '.join(labels.get(c, c)[:34] for c in codes)}")
            continue
        body = sol.run(MENY_YEAR, codes, ids, years)
        path.write_bytes(body)
        rows = body.count(b"\n")
        print(f"  {key:14s} {len(body):,} bytes · {rows:,} lines")
        if rows < 100:
            print(f"    WARNING: {key} looks short — check the selection", file=sys.stderr)

    if a.quarters:
        # Only the headline total, and only the recent window: the quarterly menu
        # carries months as well as quarters, and asking for everything at once
        # is far past what the server will return in one go.
        qreg = sol.regions(MENY_QUARTER)
        qids = [qreg[n] for n in ours if n in qreg]
        qper = [(pid, lab) for pid, lab in sol.periods(MENY_QUARTER) if "Kvartal" in lab]
        qper = qper[:a.quarter_years * 4]
        qtypes = sol.array(MENY_QUARTER, "arrayNivaett")
        tot = next((r.split("*")[0] for r in qtypes if "Totalt antal brott" in r), None)
        if not tot:
            print("  quarters: no 'Totalt antal brott' in the quarterly menu — skipped",
                  file=sys.stderr)
        else:
            path = OUT / "total_quarterly.csv"
            if path.exists() and not a.refresh:
                print(f"  {'quarters':14s} cached ({path.stat().st_size:,} bytes)")
            else:
                body = sol.run(MENY_QUARTER, [tot], qids, [p for p, _ in qper])
                path.write_bytes(body)
                print(f"  {'quarters':14s} {len(body):,} bytes · {body.count(chr(10).encode()):,} lines"
                      f" · {len(qper)} quarters")

    print(f"\nwrote to {OUT.relative_to(ROOT)} — Källa: Brå")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
