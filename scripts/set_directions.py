#!/usr/bin/env python3
"""One-off: add `direction` to every indicator in config/indicators.json.

Run once for v1.2 (Phase 1). Kept in the tree so the reasoning is auditable and
so a later indicator can be checked against the same rule.

THE RULE. An indicator gets `higher_better` or `lower_better` only where the
source itself, or an uncontested convention in the field, says which end is
good. Everything else is `neutral`, which switches off the green/red delta
colouring and the "#n of 290" ranking sense — a descriptor like "share of
flerbostadshus" or "share aged 20-34" has no better end, and colouring one
green would be this dashboard editorialising rather than reporting.

That is deliberately conservative: `neutral` is the safe default, because a
wrong direction silently inverts a rank and a colour, which is exactly the
class of error the fmt fallback trap already cost us once.
"""
from __future__ import annotations

import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
CFG = ROOT / "config" / "indicators.json"

LOWER_BETTER = {
    "unemp":        "unemployment rate — adverse by definition",
    "low_econ":     "at-risk-of-poverty rate — SCB publishes it as a deprivation measure",
    "forced_sales": "executive auctions by Kronofogden — adverse by definition",
    "kommun_debt":  "långfristiga skulder per inhabitant — lower is the sound end in "
                    "municipal finance, and Kolada presents it that way",
}

HIGHER_BETTER = {
    "employment":   "employment rate 20–64 — higher is the sound end",
    "income":       "mean net income per person",
    "income_med":   "median disposable income",
    "kommun_equity": "soliditet incl. pension commitment — higher is the sound end",
}

# Everything else is neutral. The ones worth stating a reason for, because a
# reader may expect a direction and should find out why there is none:
NEUTRAL_NOTE = {
    "growth":     "population growth is not good or bad in itself — a shrinking kommun "
                  "and an overheating one are different problems, not a ranking",
    "young":      "age structure is a descriptor",
    "single":     "household structure is a descriptor",
    "foreign":    "a population descriptor, not a score",
    "higher_ed":  "an education descriptor; treating it as a score would rank people",
    "socio":      "SCB's socio-economic index — which end is 'better' is not stated in "
                  "the metadata on disk, so it stays neutral until it is verified",
    "flats":      "building-type mix is a descriptor",
    "renters":    "tenure mix is a descriptor",
    "avg_m2":     "floor space per person is a descriptor",
    "vacancy":    "vacancy cuts both ways — slack for a tenant, loss for an owner",
    "kt_tal":     "K/T-tal is a valuation ratio, not a score",
    "kommun_tax": "a higher rate buys more service — not a ranking",
    "kommun_netcost": "net operating cost per inhabitant is a descriptor",
    "rent":       "a rent is a cost to one side and income to the other",
    "rent_mean":  "as rent",
    "rent_owner": "as rent",
    "newbuild_rent": "as rent",
    "bme":        "categorical — shortage/balance/surplus already carry their own colours",
    "policy_rate": "a macro rate has no better end",
    "mortgage_rate": "as policy_rate",
    "bond_10y":   "as policy_rate",
    "cpi":        "an index level",
    "cpi_rent":   "an index level",
    "hpi":        "an index level",
    "gdp":        "shown as a national card, not ranked",
}


def main() -> int:
    cfg = json.loads(CFG.read_text(encoding="utf-8"))
    inds = cfg["indicators"]
    counts = {"higher_better": 0, "lower_better": 0, "neutral": 0}
    for i in inds:
        k = i["key"]
        if k in LOWER_BETTER:
            d, why = "lower_better", LOWER_BETTER[k]
        elif k in HIGHER_BETTER:
            d, why = "higher_better", HIGHER_BETTER[k]
        else:
            d, why = "neutral", NEUTRAL_NOTE.get(k, "")
        i["direction"] = d
        if why:
            i["direction_note"] = why
        elif "direction_note" in i:
            del i["direction_note"]
        counts[d] += 1

    cfg.setdefault("_doc", "")
    CFG.write_text(json.dumps(cfg, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{len(inds)} indicators: "
          + ", ".join(f"{v} {k}" for k, v in counts.items()))
    unknown = (set(LOWER_BETTER) | set(HIGHER_BETTER) | set(NEUTRAL_NOTE)) - {i["key"] for i in inds}
    if unknown:
        print("WARNING: named but not in the registry:", ", ".join(sorted(unknown)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
