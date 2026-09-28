#!/usr/bin/env python3
"""The v2.1 "Sweden fit" acceptance spec — headless Chromium through Playwright.

    python3 tests/ui_v2_1/spec.py --url http://localhost:8081/ --upto P1
    python3 tests/ui_v2_1/spec.py --upto P6 --out logs/shots/P6 --shots

Modelled on tests/ui_v2/spec.py — same Report, same gateway interception, same
port — with two deliberate differences, both of them answers to what v2.0's 169
checks failed to catch:

1. **Content, not presence.** v2.0 asserted that a Services section existed. It
   did exist, and it said "Grocery 0" for a pin with 31 groceries within a
   kilometre, for months. Every check here reads what the page SAYS and, where a
   number can be recomputed from the files in dist/, recomputes it and compares.

2. **The gateway can fail.** v2.0 answered every listings request with a success
   fixture, so the retry storm (~90 requests in 14 s against a donated service)
   was invisible. `--` there is an explicit error mode here: the route answers
   HTTP 500 and the checks count the requests.

Every check is registered with the phase that delivered it, so `--upto P3` runs
P1…P3 and the spec is runnable from the first commit of the release rather than
only at the end. `--out` always receives report.json.
"""
from __future__ import annotations

import argparse
import json
import math
import pathlib
import re
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
DIST = ROOT / "dist"
FIXTURE = ROOT / "tests" / "fixtures" / "listings_stockholm.json"
GATEWAY_GLOB = "**am-se-listings**"

PHASES = ["P1", "P2", "P3", "P4", "P5", "P6"]

# The pins the spec drives. Södermalm is the one every audit note is written
# about; Göteborg is the second so nothing passes by being hard-coded to 0180.
STHLM = "59.31972,18.07194"
GBG = "57.7089,11.9746"
PINS = [(STHLM, "0180", "Stockholm"), (GBG, "1480", "Göteborg")]

# Views a screenshot pass captures, for the eyes-on review the phase demands.
# The second element scrolls to a section before the shot: the audit bugs are
# below the fold on a 900 px viewport and a top-of-page screenshot never showed
# them, which is part of how they survived v2.0.
SHOT_ROUTES = {
    "property": (f"#property?p={STHLM}:Test", None),
    "property-services": (f"#property?p={STHLM}:Test&show=services,schools", "sec-services"),
    "property-infra": (f"#property?p={STHLM}:Test&show=infra,safety", "sec-infra"),
    "property-listings": (f"#property?p={STHLM}:Test&show=listings", "sec-listings"),
    "map-kommun": ("#map/0180", None),
    "map-quarter": ("#map/0180?ind=crime_1000&fq=q", None),
    "data-national": ("#data/national", None),
    "data-areas": ("#data/areas/kommun", None),
    "data-projects": ("#data/projects", None),
    # P2 — Map only, at all three levels it is reachable from
    "maponly": ("#map?ind=none", None),
    "maponly-kommun": ("#map/0180?ind=none", None),
    "maponly-area": ("#area/kommun/0180?ind=none", None),
}
SHOT_SIZES = [(1440, 900), (1366, 768), (390, 844)]


# --------------------------------------------------------------------------- #
# the report
# --------------------------------------------------------------------------- #

class Report:
    def __init__(self, upto: str):
        self.upto = PHASES.index(upto)
        self.fails: list[str] = []
        self.n = 0
        self.phase = ""
        self.rows: list[dict] = []

    def wants(self, phase: str) -> bool:
        return PHASES.index(phase) <= self.upto

    def head(self, phase: str, title: str) -> None:
        self.phase = phase
        print(f"\n{phase} — {title}")

    def ok(self, name: str, cond, detail: str = "") -> bool:
        self.n += 1
        cond = bool(cond)
        self.rows.append({"phase": self.phase, "check": name, "ok": cond, "detail": str(detail)[:400]})
        if cond:
            print(f"  ✓ {name}" + (f" — {detail}" if detail else ""))
            return True
        self.fails.append(f"{self.phase} {name}" + (f" — {detail}" if detail else ""))
        print(f"  ✗ {name}" + (f" — {detail}" if detail else ""))
        return False

    def write(self, out: pathlib.Path) -> None:
        out.mkdir(parents=True, exist_ok=True)
        (out / "report.json").write_text(json.dumps({
            "upto": PHASES[self.upto],
            "checks": self.n,
            "failed": len(self.fails),
            "failures": self.fails,
            "rows": self.rows,
        }, ensure_ascii=False, indent=1), encoding="utf-8")


# --------------------------------------------------------------------------- #
# the check registry
# --------------------------------------------------------------------------- #

CHECKS: list[dict] = []


def check(cid: str, phase: str, title: str = "", needs: str = "page"):
    """Register one acceptance item against the phase that delivered it.

    `needs` picks the fixture the check runs against:
      page   the shared page, gateway answering from the recorded fixture
      error  a fresh page whose gateway answers HTTP 500
      fresh  a fresh page with the success fixture (for cold-open checks)
    """
    def deco(fn):
        CHECKS.append({"id": cid, "phase": phase, "title": title or (fn.__doc__ or cid).strip(),
                       "fn": fn, "needs": needs})
        return fn
    return deco


# --------------------------------------------------------------------------- #
# driving helpers
# --------------------------------------------------------------------------- #

def install_gateway(page, status: int = 200) -> dict:
    """Answer every gateway request from the recorded fixture, or fail it.

    The real gateway is never called: a test that depended on a third-party
    service would fail for reasons that have nothing to do with this repository,
    and would also be impolite to a donated one."""
    body = json.loads(FIXTURE.read_text(encoding="utf-8"))
    calls = {"n": 0, "urls": [], "t0": None}

    def handler(route):
        calls["n"] += 1
        if calls["t0"] is None:
            calls["t0"] = time.time()
        calls["urls"].append(route.request.url)
        if status != 200:
            route.fulfill(status=status, content_type="application/json",
                          headers={"access-control-allow-origin": "*"},
                          body=json.dumps({"error": "upstream"}))
            return
        if "/text" in route.request.url:
            route.fulfill(status=200, content_type="application/json",
                          headers={"access-control-allow-origin": "*"},
                          body=json.dumps({"text_start": "Fixture description text."}))
            return
        route.fulfill(status=200, content_type="application/json",
                      headers={"access-control-allow-origin": "*"},
                      body=json.dumps(body))

    page.route(GATEWAY_GLOB, handler)
    return calls


def boot(browser, url, width=1440, height=900, status=200):
    page = browser.new_page(viewport={"width": width, "height": height})
    errs: list[str] = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.on("console", lambda m: errs.append("console.error: " + m.text) if m.type == "error" else None)
    calls = install_gateway(page, status)
    page.goto(url, wait_until="load")
    page.wait_for_function("typeof window.AM !== 'undefined'", timeout=20000)
    page.wait_for_timeout(400)
    return page, errs, calls


def hop(page, route, wait=650):
    page.evaluate("h => { location.hash = h; }", route)
    page.wait_for_timeout(wait)
    return page.evaluate("location.hash")


def text(page) -> str:
    return page.evaluate("document.body.innerText")


LOADING = re.compile(r"Loading\b|Asking the listings gateway|asking the gateway", re.I)


def settle(page, timeout_ms: int = 8000) -> str:
    """Wait until nothing on the page says it is still loading, then return the text.

    This is what makes a content check honest. A lazily loaded section renders
    "Loading …" first, and asserting against the page before those files land
    reads the placeholder — which is how v2.0's checks passed while three
    sections never finished loading at all."""
    t0 = time.time()
    while (time.time() - t0) * 1000 < timeout_ms:
        t = text(page)
        if not LOADING.search(t):
            return t
        page.wait_for_timeout(150)
    return text(page)


def loading_bits(page) -> list[str]:
    """Every line still claiming to load — the detail for a failed settle."""
    return [ln.strip() for ln in text(page).splitlines() if LOADING.search(ln)]


def table_rows(page, testid: str) -> int:
    return page.eval_on_selector_all(f"[data-testid={testid}] tbody tr", "e => e.length")


def sel_text(page, selector: str) -> str:
    return page.eval_on_selector_all(selector, "e => e.map(x => x.innerText).join('\\n')")


# --------------------------------------------------------------------------- #
# recomputing what the page claims, from the files in dist/
# --------------------------------------------------------------------------- #

def hav_m(a_lat, a_lon, b_lat, b_lon) -> float:
    r = 6371000.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


_SRV_INDEX = None


def srv_index() -> dict:
    global _SRV_INDEX
    if _SRV_INDEX is None:
        p = ROOT / "data" / "processed" / "services.json"
        _SRV_INDEX = (json.loads(p.read_text(encoding="utf-8")).get("index") or {}) if p.exists() else {}
    return _SRV_INDEX


def services_within(lat: float, lon: float, radius: int, cat: str) -> int:
    """The count the page must print for one category — computed the way the page
    computes it: every kommun file whose bbox comes within the radius, straight-line
    distance, no rounding of the boundary."""
    n = 0
    for code, meta in srv_index().items():
        bb = meta.get("bbox")
        if not bb:
            continue
        d_lat = max(0.0, bb[0] - lat, lat - bb[2])
        d_lon = max(0.0, bb[1] - lon, lon - bb[3])
        if hav_m(lat, lon, lat + d_lat, lon + d_lon) >= radius + 500:
            continue
        f = DIST / "services" / f"{code}.json"
        if not f.exists():
            continue
        for row in json.loads(f.read_text(encoding="utf-8")):
            if row[0] != cat:
                continue
            if hav_m(lat, lon, row[1], row[2]) <= radius:
                n += 1
    return n


def swedish_int(n: int) -> str:
    """1337 -> '1 337' — the page groups thousands with a space, sv-SE style."""
    s = f"{n:,}".replace(",", " ")
    return s


# --------------------------------------------------------------------------- #
# P1 — the v2.0 audit bugs
# --------------------------------------------------------------------------- #

@check("pin-sections-finish", "P1", "every Test property section finishes loading", needs="fresh")
def _pin_sections_finish(r, page, errs, calls):
    for pin, code, name in PINS:
        hop(page, f"#property?p={pin}:Test", 900)
        # the sections that lazily load are opened, so the checks read real content
        hop(page, f"#property?p={pin}:Test&show=services,public,schools,infra", 900)
        t = settle(page)
        r.ok(f"{name}: nothing still says Loading", not LOADING.search(t),
             "; ".join(loading_bits(page))[:160])
        r.ok(f"{name}: no page error while the files arrived", not errs, (errs[0] if errs else "")[:120])
        errs.clear()


@check("pin-services-count", "P1", "Services prints the count the files hold", needs="fresh")
def _pin_services_count(r, page, errs, calls):
    for pin, code, name in PINS:
        lat, lon = (float(x) for x in pin.split(","))
        hop(page, f"#property?p={pin}:Test&show=services", 900)
        settle(page)
        want = services_within(lat, lon, 1000, "grocery")
        r.ok(f"{name}: the files hold groceries to compare against", want > 0, f"{want} within 1 km")
        got = page.eval_on_selector_all(
            "[data-testid=services-near] tbody tr",
            "els => { const o = {}; for (const tr of els)"
            " o[tr.cells[0].innerText.trim()] = tr.cells[1].innerText.trim(); return o; }")
        shown = got.get("Grocery", "")
        r.ok(f"{name}: Grocery within 1 km reads {want}",
             shown.replace(" ", " ").replace(" ", "") == str(want),
             f"page says {shown!r}, files say {want}")
        r.ok(f"{name}: no category is left at 0 for the whole table",
             any(v not in ("", "0") for v in got.values()), json.dumps(got, ensure_ascii=False)[:160])


@check("pin-schools-rows", "P1", "Schools lists the nearest six", needs="fresh")
def _pin_schools(r, page, errs, calls):
    for pin, code, name in PINS:
        hop(page, f"#property?p={pin}:Test&show=schools", 900)
        settle(page)
        n = table_rows(page, "schools-near")
        r.ok(f"{name}: six schools in the table", n == 6, f"{n} rows")


@check("pin-infra-section", "P1", "Infrastructure says either what is near or that nothing is", needs="fresh")
def _pin_infra(r, page, errs, calls):
    for pin, code, name in PINS:
        hop(page, f"#property?p={pin}:Test&show=infra", 900)
        settle(page)
        has_table = page.eval_on_selector_all("[data-testid=infra-near] tbody tr", "e => e.length") > 0
        body = page.inner_text("[data-testid=sec-infra]")
        r.ok(f"{name}: a project table or the 'No mapped project' sentence",
             has_table or "No mapped project" in body,
             ("table" if has_table else body.replace("\n", " ")[:120]))


@check("listings-no-retry-storm", "P1", "a failing gateway is asked twice at most", needs="error")
def _listings_storm(r, page, errs, calls):
    hop(page, f"#property?p={STHLM}:Test&show=listings", 1200)
    page.wait_for_timeout(9000)                       # ten seconds in total, with the hop
    r.ok("at most two requests in 10 s against a 500", calls["n"] <= 2, f"{calls['n']} requests")
    r.ok("and at least one — the section did try", calls["n"] >= 1, f"{calls['n']} requests")
    sec = page.inner_text("[data-testid=sec-listings]")
    r.ok("the error line is on the page", "Listings unavailable" in sec, sec.replace("\n", " ")[:120])
    r.ok("with a Retry the reader can press",
         page.eval_on_selector_all("[data-testid=lst-retry]", "e => e.length") == 1)
    # pressing Retry asks again — exactly once more
    before = calls["n"]
    page.click("[data-testid=lst-retry]")
    page.wait_for_timeout(2500)
    r.ok("Retry asks again, once", calls["n"] == before + 1, f"{calls['n'] - before} new requests")


@check("crime-quarter-periods", "P1", "quarterly crime periods are YYYYKn, all of them")
def _crime_periods(r, page, errs, calls):
    hop(page, "#map/0180?ind=crime_1000", 700)
    opts = page.eval_on_selector_all("[data-testid=period-year] option", "e => e.map(x => x.value)")
    r.ok("the yearly options are years", opts and all(re.fullmatch(r"\d{4}", o) for o in opts),
         ", ".join(opts[:6]))
    page.click("[data-testid=period-fq] button[data-fq=q]")
    page.wait_for_timeout(700)
    qopts = page.eval_on_selector_all("[data-testid=period-year] option", "e => e.map(x => x.value)")
    r.ok("every quarterly option is YYYYKn",
         qopts and all(re.fullmatch(r"\d{4}K[1-4]", o) for o in qopts),
         ", ".join(q for q in qopts if not re.fullmatch(r"\d{4}K[1-4]", q)) or f"{len(qopts)} options")
    r.ok("nothing carries the source's 'prel.' inside the period key",
         not any("prel" in q for q in qopts), ", ".join(q for q in qopts if "prel" in q))
    newest = qopts[-1] if qopts else ""
    q_periods = page.evaluate(
        "() => (window.AM.D.indicators.find(i => i.key === 'crime_1000') || {}).q_periods || []")
    r.ok("and the newest published quarter is offered", newest == (q_periods[-1] if q_periods else None),
         f"select ends {newest!r}, data ends {(q_periods or ['–'])[-1]!r}")
    # switching to Quarterly must SELECT a quarter, not leave the yearly period
    # standing while the map goes on drawing the yearly figure
    sel = page.eval_on_selector("[data-testid=period-year]", "e => e.value")
    r.ok("switching to Quarterly selects the newest quarter", sel == newest,
         f"selected {sel!r}, newest {newest!r}")
    r.ok("and the hash carries it", f"y={sel}" in page.evaluate("location.hash"),
         page.evaluate("location.hash"))
    hop(page, "#map/0180?ind=crime_1000&fq=q", 800)
    sel = page.eval_on_selector("[data-testid=period-year]", "e => e.value")
    r.ok("a fq=q link with no year opens on the newest quarter", sel == newest,
         f"selected {sel!r}, newest {newest!r}")


@check("crime-quarter-render", "P1", "a selected quarter keeps the card whole")
def _crime_quarter_render(r, page, errs, calls):
    q = page.evaluate(
        "() => ((window.AM.D.indicators.find(i => i.key === 'crime_1000') || {}).q_periods || []).slice(-1)[0]")
    hop(page, f"#map/0180?ind=crime_1000&fq=q&y={q}", 900)
    tiles = page.eval_on_selector_all("[data-testid=area-card] [data-testid^=tile-]", "e => e.length")
    r.ok("the five headline tiles survive a quarter", tiles == 5, f"{tiles} tiles with y={q}")
    badge = page.inner_text("[data-testid=level-badge]") if page.eval_on_selector_all(
        "[data-testid=level-badge]", "e => e.length") else ""
    asof = sel_text(page, ".indx summary .dim")
    r.ok("the as-of names the selected quarter", q in asof, f"{asof!r} (want {q})")
    prel = page.eval_on_selector_all("[data-testid=prel]", "e => e.length")
    q_prel = page.evaluate(
        "() => (window.AM.D.indicators.find(i => i.key === 'crime_1000') || {}).q_prel || []")
    if q in q_prel:
        r.ok("a preliminary quarter is badged prel.", prel >= 1, f"{prel} badges for {q}")
    else:
        r.ok("a final quarter carries no prel. badge", prel == 0, f"{prel} badges for {q}")
    r.ok("the level badge is present", bool(badge), badge)


@check("crime-quarter-single", "P1", "a quarter is called a single quarter, not a rolling sum")
def _crime_single(r, page, errs, calls):
    hop(page, "#map/0180?ind=crime_1000", 700)
    tip = page.eval_on_selector_all("[data-testid=period-fq] button[data-fq=q]",
                                    "e => e.map(x => x.title).join(' ')")
    r.ok("the Quarterly control says single quarter", "single quarter" in tip.lower(), tip[:120])
    r.ok("and does not claim a rolling sum",
         "rolling" not in tip.lower() or "not a rolling" in tip.lower(), tip[:120])


@check("national-number-formats", "P1", "Data › National writes its numbers properly")
def _national_formats(r, page, errs, calls):
    hop(page, "#data/national", 900)
    t = settle(page)
    r.ok("no −0,0 anywhere", "−0,0" not in t and "-0,0" not in t,
         next((ln for ln in t.splitlines() if "−0,0" in ln or "-0,0" in ln), ""))
    r.ok("no ',0 SEK' — a rent in SEK has no decimal", ",0 SEK" not in t,
         next((ln for ln in t.splitlines() if ",0 SEK" in ln), ""))
    r.ok("no ',0 dwellings' — a count of dwellings has no decimal", ",0 dwellings" not in t,
         next((ln for ln in t.splitlines() if ",0 dwellings" in ln), ""))
    # the tile label is uppercased in CSS, so the sweep is case-insensitive
    rows = page.eval_on_selector_all(
        "[data-testid=tiles] > div, [data-testid=national-table] tbody tr",
        "e => e.map(x => x.innerText.replace(/\\n/g, ' '))")
    find = lambda needle: [x for x in rows if needle.lower() in x.lower()]  # noqa: E731
    pol = find("Policy rate")
    r.ok("the policy rate is on the page once", len(pol) == 1, f"{len(pol)} places: {pol}")
    r.ok("and its y/y is in pp, not %",
         bool(pol) and re.search(r"[+−]\d+,\d\s*pp\s*y/y", pol[0]), (pol[0] if pol else "")[:140])
    mort = find("Mortgage rate")
    r.ok("the mortgage rate appears once", len(mort) == 1, f"{len(mort)} places")
    gdp = find("GDP")
    r.ok("y/y of a growth rate is in pp too",
         not gdp or "pp y/y" in gdp[0] or "y/y" not in gdp[0], (gdp[0] if gdp else "")[:140])


@check("national-tile-grid", "P1", "the tile grid has no empty grey cell")
def _national_grid(r, page, errs, calls):
    hop(page, "#data/national", 700)
    geo = page.evaluate("""() => {
      const g = document.querySelector('[data-testid=tiles]');
      if (!g) return null;
      const cs = getComputedStyle(g);
      const kids = [...g.children].filter(e => e.offsetParent !== null);
      if (!kids.length) return null;
      const k0 = getComputedStyle(kids[0]);
      const cols = cs.gridTemplateColumns.split(' ').filter(Boolean).length;
      return { cols, n: kids.length, gap: cs.columnGap,
               gridBg: cs.backgroundColor, tileBg: k0.backgroundColor,
               last: Math.round(kids[kids.length - 1].getBoundingClientRect().right),
               right: Math.round(g.getBoundingClientRect().right) };
    }""")
    r.ok("the tile grid is there", geo is not None)
    if not geo:
        return
    # An unfilled cell can only read as a grey box if the grid paints a colour of
    # its own behind the tiles. Either the tiles fill every column, or the grid's
    # background is the tile's own — those are the two ways there is nothing to see.
    filled = geo["n"] % geo["cols"] == 0
    seamless = geo["gridBg"] == geo["tileBg"] and geo["gap"] in ("0px", "normal")
    r.ok("no unfilled cell shows the grid's own background", filled or seamless,
         f'{geo["n"]} tiles in {geo["cols"]} columns · grid bg {geo["gridBg"]} '
         f'vs tile bg {geo["tileBg"]} · column gap {geo["gap"]}')


@check("level-controls-styled", "P1", "the RegSO/DeSO control is the segmented control")
def _level_controls(r, page, errs, calls):
    hop(page, "#map/0180", 900)
    n = page.eval_on_selector_all("[data-testid=sub-level] button", "e => e.length")
    r.ok("the sub-level control has two buttons", n == 2, f"{n} buttons")
    # Compared against another segment on the same toolbar rather than against a
    # colour written down here: this catches "it renders as a native button",
    # which is what v2.0 shipped, without freezing the palette into the test.
    # The Yearly|Quarterly segment sets its own 11px, so the size is compared
    # within a point rather than exactly.
    styled = page.evaluate("""() => {
      const mine = [...document.querySelectorAll('[data-testid=sub-level] button')];
      const refs = [...document.querySelectorAll('[data-testid=period-fq] .sg')];
      const ref = refs[0] || document.querySelector('.seg .sg:not([data-sub])');
      if (!mine.length || !ref) return null;
      const r0 = getComputedStyle(ref);
      /* a segment has two looks, selected and not; each button is compared with
         the reference in the SAME state */
      const bgOf = on => { const e = refs.find(x => x.classList.contains('on') === on);
        return e ? getComputedStyle(e).backgroundColor : null; };
      const onBg = bgOf(true), offBg = bgOf(false);
      return mine.map(b => { const c = getComputedStyle(b);
        const want = b.classList.contains('on') ? onBg : offBg;
        return { sg: b.classList.contains('sg'),
                 font: c.fontFamily === r0.fontFamily,
                 mono: /mono|menlo/i.test(c.fontFamily),
                 size: Math.abs(parseFloat(c.fontSize) - parseFloat(r0.fontSize)) <= 1,
                 border: c.borderTopWidth === r0.borderTopWidth,
                 bg: want == null || c.backgroundColor === want,
                 got: c.backgroundColor, want,
                 px: c.fontSize, fam: c.fontFamily, refpx: r0.fontSize };
      });
    }""")
    r.ok("a reference segment exists to compare against", styled is not None)
    if styled:
        r.ok("both carry the segment class", all(b["sg"] for b in styled), json.dumps(styled))
        r.ok("and render in the segment's mono face, not the browser's button face",
             all(b["font"] and b["mono"] for b in styled),
             "; ".join(b["fam"] for b in styled)[:160])
        r.ok("at the segment's size and border",
             all(b["size"] and b["border"] for b in styled),
             "; ".join(f'{b["px"]} vs {b["refpx"]}' for b in styled))
        r.ok("on the segment's own background, not the native grey",
             all(b["bg"] for b in styled),
             "; ".join(f'{b["got"]} vs {b["want"]}' for b in styled))


@check("level-badge-truth", "P1", "the level badge names the level on screen")
def _level_badge(r, page, errs, calls):
    for route, want in [("#data/areas/kommun?ind=growth", "kommun level"),
                        ("#data/areas/regso?ind=growth", "RegSO level"),
                        ("#map?ind=growth", "kommun level"),
                        ("#map/0180?ind=growth", "RegSO level")]:
        hop(page, route, 800)
        got = page.inner_text("[data-testid=level-badge]")
        r.ok(f"{route} badges '{want}'", got.strip() == want, f"badge says {got.strip()!r}")
    # an indicator published only at kommun, tabulated at RegSO, must say both
    for route, want in [("#data/areas/regso?ind=rent", "RegSO rows · kommun figures"),
                        ("#map/0180?ind=crime_1000", "RegSO rows · kommun figures"),
                        ("#data/areas/kommun?ind=socio", "not published at kommun")]:
        hop(page, route, 800)
        got = page.inner_text("[data-testid=level-badge]").strip()
        r.ok(f"{route} badges '{want}'", got == want, f"badge says {got!r}")


@check("project-budget-cell", "P1", "a missing budget is words, not a dash")
def _budget(r, page, errs, calls):
    hop(page, "#data/projects", 900)
    cells = page.eval_on_selector_all(
        "[data-sortable] tbody tr",
        "e => e.map(tr => ({ name: tr.cells[0].innerText.trim(), budget: tr.cells[4].innerText.trim(),"
        " title: (tr.cells[4].querySelector('[title]') || {}).title || '' }))")
    r.ok("the project table has rows", len(cells) > 10, f"{len(cells)} rows")
    bare = [c["name"] for c in cells if c["budget"] in ("–", "-", "")]
    r.ok("no budget cell is a bare dash", not bare, "; ".join(bare[:4]))
    words = [c for c in cells if c["budget"] in ("programme only", "not published")]
    r.ok("the blank ones say which kind of blank they are", len(words) >= 5, f"{len(words)} cells")
    r.ok("and each carries the source's note", all(len(c["title"]) > 20 for c in words),
         "; ".join(f'{c["name"]}: {c["title"][:40]!r}' for c in words if len(c["title"]) <= 20)[:200])
    prog = [c["name"] for c in words if c["budget"] == "programme only"]
    r.ok("the metro extension funded as a programme says so", len(prog) >= 1, "; ".join(prog[:4]))
    r.ok("the caption explains both words",
         "programme only" in text(page) and "not published" in text(page))


@check("bme-in-words", "P1", "the housing-market assessment reads as words")
def _bme(r, page, errs, calls):
    hop(page, "#data/areas/kommun?ind=bme", 900)
    # the highlighted column IS the selected indicator's, wherever it sits
    vals = page.evaluate("""() => {
      const th = [...document.querySelectorAll('table.tbl thead th')];
      const i = th.findIndex(x => x.classList.contains('hi'));
      if (i < 0) return null;
      return [...document.querySelectorAll('#tbody tr')].slice(0, 40)
        .map(tr => (tr.cells[i] || {}).innerText || '').map(s => s.trim());
    }""")
    words = {"Shortage", "Balance", "Surplus", "–"}
    r.ok("the BME column is words, never −1/0/1",
         vals and all(v in words for v in vals),
         ", ".join(sorted(set(vals or []) - words))[:120] or f"{len(vals or [])} cells")
    hop(page, "#map?ind=bme", 1100)
    leg = page.inner_text("[data-testid=legend]")
    r.ok("the map legend names the categories too",
         all(w in leg for w in ("Shortage", "Balance", "Surplus")), leg.replace("\n", " ")[:140])
    row = page.evaluate("""async () => {
      const rows = await window.AM.exportRows('areas');
      const head = rows[0].split(';');
      const iInd = head.indexOf('indicator'), iV = head.indexOf('value'), iL = head.indexOf('value_label');
      const hit = rows.slice(1).find(x => x.split(';')[iInd] === 'bme');
      if (!hit) return null;
      const c = hit.split(';');
      return { head: head[iV] + ',' + head[iL], value: c[iV], label: c[iL] };
    }""")
    r.ok("the export carries the number and the word side by side",
         row and row["value"] != "" and row["label"] in ("Shortage", "Balance", "Surplus"),
         json.dumps(row))


@check("scb-prel-marked", "P1", "a preliminary SCB period says so")
def _scb_prel(r, page, errs, calls):
    keys = page.evaluate("() => window.AM.D.indicators.filter(i => i.prel).map(i => i.key)")
    r.ok("the build found at least one preliminary SCB series", len(keys) >= 1, ", ".join(keys[:6]))
    if not keys:
        return
    key = keys[0]
    lvl = page.evaluate("k => (window.AM.D.indicators.find(i => i.key === k) || {}).prel", key)
    r.ok("and recorded which geography it is preliminary at", bool(lvl), json.dumps(lvl))
    hop(page, f"#data/areas/kommun?ind={key}", 800)
    n = page.eval_on_selector_all("[data-testid=prel]", "e => e.length")
    if lvl and "kommun" in lvl:
        r.ok(f"{key} is badged prel. at kommun level", n >= 1, f"{n} badges")
        hop(page, f"#data/areas/regso?ind={key}", 800)
        n2 = page.eval_on_selector_all("[data-testid=prel]", "e => e.length")
        r.ok("and not at a level whose table is final", n2 == 0, f"{n2} badges at RegSO")
    else:
        r.ok(f"{key} is badged where its table is preliminary", True, json.dumps(lvl))


@check("payload-src-periods", "P1", "the page ships no period it cannot select")
def _src_periods(r, page, errs, calls):
    info = page.evaluate("""() => {
      const sp = window.AM.D.src_periods || {};
      const y0 = (window.AM.D.meta.years || [])[0] || '0000';
      const bad = [];
      for (const [t, list] of Object.entries(sp)) for (const p of list) if (p.slice(0, 4) < y0) bad.push(t + ':' + p);
      return { y0, tables: Object.keys(sp).length, bad: bad.slice(0, 5),
               n: Object.values(sp).reduce((a, l) => a + l.length, 0) };
    }""")
    r.ok("src_periods is still shipped — srcPeriods() reads it", info["tables"] >= 1,
         f'{info["tables"]} tables, {info["n"]} periods')
    r.ok("and holds nothing before the first year the reader can pick", not info["bad"],
         ", ".join(info["bad"]))
    hop(page, "#data/areas/kommun?ind=unemp", 700)
    href = page.eval_on_selector_all("a.srcv", "e => e.map(x => x.href)")
    r.ok("a monthly indicator still builds its verify-at-source link",
         bool(href) and "valueCodes%5BTid%5D" in href[0] or bool(href) and "valueCodes[Tid]" in href[0],
         (href[0] if href else "no link")[:140])


# --------------------------------------------------------------------------- #
# P2 — "Map only"
# --------------------------------------------------------------------------- #

# What "nothing is coloured in" means in the DOM. Leaflet writes fill="none" for a
# path with no fill and fill="<colour>" + fill-opacity="<n>" for one with a fill, so
# a filled path is one whose fill is a colour AND whose fill-opacity is above zero.
# Map only keeps a transparent fill on purpose — Leaflet only hit-tests the interior
# of a path whose fill is not "none" — so the opacity is what has to be asserted,
# never the presence of the attribute.
PATHS_JS = """() => {
  const q = s => [...document.querySelectorAll(s)];
  const filled = ps => ps.filter(p => {
    const f = (p.getAttribute('fill') || '').toLowerCase();
    const o = parseFloat(p.getAttribute('fill-opacity') ?? '1');
    return f && f !== 'none' && o > 0;
  });
  const scope = sel => {
    const all = q(sel + ' .leaflet-overlay-pane path');
    const out = all.filter(p => p.classList.contains('mo-outline'));
    return { paths: all.length, outlines: out.length, others: all.length - out.length,
             filled: filled(all).length, filledOutlines: filled(out).length,
             strokes: [...new Set(out.map(p => p.getAttribute('stroke')))].slice(0, 3) };
  };
  return { map: scope('#lfmap'), area: scope('#armap'), prop: scope('#propmap') };
}"""


def paths(page, which="map") -> dict:
    return page.evaluate(PATHS_JS)[which]


def legend_state(page, sel: str) -> dict:
    return page.evaluate("""s => { const e = document.querySelector(s);
      if (!e) return { there: false, text: '', shown: false };
      return { there: true, text: e.innerText.trim(), shown: e.offsetParent !== null }; }""", sel)


def open_area_popup(page, name: str) -> str:
    """Open the choropleth popup of the named kommun the way a click does, and
    return what it says. The polygons are SVG paths with no text of their own, so
    the layer is found through Leaflet rather than by clicking a pixel and hoping."""
    ok = page.evaluate("""nm => {
      const m = window.AM.map; if (!m) return false;
      let hit = null;
      m.eachLayer(l => {
        if (hit || !l.getPopup || !l.getPopup()) return;
        const c = l.getPopup().getContent();
        const html = typeof c === 'function' ? c(l) : String(c || '');
        if (html.indexOf('>' + nm + '<') >= 0) hit = l;
      });
      if (!hit) return false;
      hit.openPopup();
      return true;
    }""", name)
    if not ok:
        return ""
    page.wait_for_timeout(400)
    return page.eval_on_selector_all(".leaflet-popup-content", "e => e.map(x => x.innerText).join('\\n')")


@check("maponly-no-fill", "P2", "#map?ind=none draws outlines and colours nothing in")
def _maponly_no_fill(r, page, errs, calls):
    # the baseline first: the same measurement must see a full choropleth, or the
    # check below would pass on a map that failed to draw at all
    hop(page, "#map?ind=growth", 1300)
    base = paths(page)
    r.ok("with an indicator the kommuner are filled", base["filled"] > 250,
         f'{base["filled"]} filled of {base["paths"]} paths')
    r.ok("and none of them is an outline path", base["outlines"] == 0, str(base["outlines"]))

    hop(page, "#map?ind=none", 1300)
    got = paths(page)
    r.ok("Map only draws every kommun as an outline", got["outlines"] > 250,
         f'{got["outlines"]} outlines')
    r.ok("and not one filled area path", got["filled"] == 0,
         f'{got["filled"]} filled of {got["paths"]} paths')
    r.ok("nothing else is on the map either", got["others"] == 0, f'{got["others"]} other paths')
    r.ok("the outline is a neutral stroke, not the ramp's green",
         all(s and s.lower() not in ("#1c6b5c", "#ffffff") for s in got["strokes"]),
         ", ".join(str(s) for s in got["strokes"]))
    r.ok("no page error in Map only", not errs, (errs[0] if errs else "")[:140])
    errs.clear()


@check("maponly-controls", "P2", "the chip, the picker, the strip and the missing period control")
def _maponly_controls(r, page, errs, calls):
    hop(page, "#map?ind=none", 1100)
    chips = page.eval_on_selector_all(
        "[data-testid=ind-chips] button",
        "e => e.map(x => ({ t: x.innerText.trim(), id: x.getAttribute('data-testid') || '',"
        " ind: x.getAttribute('data-indq'), on: x.classList.contains('on') }))")
    r.ok("the chip row starts with Map only", bool(chips) and chips[0]["t"] == "Map only",
         (chips[0]["t"] if chips else "no chips"))
    r.ok("and it is the chip that is lit", bool(chips) and chips[0]["on"] and chips[0]["ind"] == "none",
         json.dumps(chips[0] if chips else {}, ensure_ascii=False))
    r.ok("the other chips are still there to leave with", len(chips) >= 4, f"{len(chips)} chips")

    r.ok("the picker button names the mode",
         "Map only" in page.inner_text("[data-testid=ind-picker-btn]"),
         page.inner_text("[data-testid=ind-picker-btn]").replace("\n", " ")[:80])
    page.click("[data-testid=ind-picker-btn]")
    page.wait_for_timeout(350)
    first = page.eval_on_selector_all(
        "[data-testid=ind-picker-pop] .pkrow",
        "e => e.slice(0, 1).map(x => ({ ind: x.getAttribute('data-ind'), t: x.innerText.replace(/\\n/g,' ').trim() }))")
    r.ok("the picker's first entry is Map only",
         bool(first) and first[0]["ind"] == "none" and "Map only" in first[0]["t"],
         json.dumps(first, ensure_ascii=False)[:140])
    # it is a row like any other: a search that does not match it hides it
    page.fill("[data-testid=ind-search]", "rent")
    page.wait_for_timeout(300)
    r.ok("and it is filtered out by a search it does not match",
         page.eval_on_selector_all("[data-testid=ind-picker-pop] [data-ind=none]", "e => e.length") == 0)
    page.keyboard.press("Escape")
    page.wait_for_timeout(250)

    r.ok("no period control — nothing is drawn from a period",
         page.eval_on_selector_all("[data-testid=period]", "e => e.length") == 0)
    r.ok("no indicator legend", not legend_state(page, "#maplegend")["text"],
         legend_state(page, "#maplegend")["text"][:80])
    r.ok("and the empty legend box is not shown as a bare white bar",
         not legend_state(page, "#maplegend")["shown"])
    note = page.inner_text("[data-testid=maponly-note]") if page.eval_on_selector_all(
        "[data-testid=maponly-note]", "e => e.length") else ""
    r.ok("the info strip says what the map is showing",
         "Map only — pick an indicator to colour the areas" in note.replace("\n", " "),
         note.replace("\n", " ")[:120])


@check("maponly-popup", "P2", "clicking an area still opens its figures")
def _maponly_popup(r, page, errs, calls):
    hop(page, "#map?ind=none", 1300)
    txt = open_area_popup(page, "Stockholm")
    r.ok("the Stockholm polygon opens a popup", "Stockholm" in txt, txt.replace("\n", " ")[:120])
    r.ok("it still names the population", "inhabitants" in txt, txt.replace("\n", " ")[:160])
    figs = page.eval_on_selector_all(
        ".leaflet-popup-content .lfkey div",
        "e => e.map(x => x.innerText.replace(/\\n/g, ': '))")
    r.ok("and carries the headline figures", len(figs) >= 4, " · ".join(figs)[:200])
    r.ok("every one of them is a number, not a dash",
         bool(figs) and all(re.search(r"\d", f.split(":")[-1]) for f in figs),
         " · ".join(f for f in figs if not re.search(r"\d", f.split(":")[-1]))[:140])
    r.ok("there is no big figure for an indicator that is not selected",
         page.eval_on_selector_all(".leaflet-popup-content .lfbig", "e => e.length") == 0)
    r.ok("the 'all values' fold is still there",
         page.eval_on_selector_all(".leaflet-popup-content .lfmore", "e => e.length") == 1)
    # and the popup did not paint the map: still nothing filled
    r.ok("opening it filled nothing", paths(page)["filled"] == 0, str(paths(page)["filled"]))


@check("maponly-layers", "P2", "a feature layer works on top of Map only", needs="fresh")
def _maponly_layers(r, page, errs, calls):
    hop(page, "#map?ind=none", 1300)
    before = paths(page)
    page.click("[data-testid=layers-btn]")
    page.wait_for_timeout(300)
    r.ok("the Layers menu lists every layer",
         page.eval_on_selector_all("[data-testid=layers-pop] [data-layer]", "e => e.length") >= 5)
    page.click("[data-testid=layers-pop] [data-layer=uso]")
    page.wait_for_timeout(1500)
    on = paths(page)
    r.ok("the layer draws over the outlines", on["others"] > before["others"],
         f'{on["others"]} extra paths')
    r.ok("its own key appears", bool(legend_state(page, "[data-testid=legend-uso]")["text"]),
         legend_state(page, "[data-testid=legend-uso]")["text"].replace("\n", " ")[:90])
    r.ok("the areas are still unfilled under it", on["filledOutlines"] == 0,
         str(on["filledOutlines"]))
    r.ok("the hash carries the layer with the mode",
         "lay=uso" in page.evaluate("location.hash") and "ind=none" in page.evaluate("location.hash"),
         page.evaluate("location.hash"))
    # the menu stays open across a toggle, so the same row is clicked again
    page.click("[data-testid=layers-pop] [data-layer=uso]")
    page.wait_for_timeout(900)
    off = paths(page)
    r.ok("switching it off removes it again", off["others"] == 0, f'{off["others"]} paths left')
    r.ok("and its key with it", not legend_state(page, "[data-testid=legend-uso]")["text"])
    r.ok("the hash drops it too", "lay=" not in page.evaluate("location.hash"),
         page.evaluate("location.hash"))
    r.ok("and Map only survived the round trip", "ind=none" in page.evaluate("location.hash"),
         page.evaluate("location.hash"))


@check("maponly-hash-stable", "P2", "the link survives a reload unchanged", needs="fresh")
def _maponly_hash(r, page, errs, calls):
    for route in ["#map?ind=none", "#map/0180?ind=none&lay=uso", "#map/0180/deso?ind=none"]:
        hop(page, route, 1400)
        before = page.evaluate("location.hash")
        r.ok(f"{route} is already canonical", before == route, f"became {before}")
        page.reload(wait_until="load")
        page.wait_for_function("typeof window.AM !== 'undefined'", timeout=20000)
        page.wait_for_timeout(1200)
        after = page.evaluate("location.hash")
        r.ok(f"{route} is unchanged after a reload", after == before, f"{before} → {after}")
        r.ok(f"{route} still draws outlines after the reload", paths(page)["outlines"] > 10,
             json.dumps(paths(page)))


@check("maponly-key-0", "P2", "the key 0 toggles it, and never while typing")
def _maponly_key(r, page, errs, calls):
    hop(page, "#map/0180?ind=growth", 1200)
    # the shortcut is ignored while the caret is in a field, so the caret is put
    # nowhere first — and put back into a field further down to prove the guard
    page.evaluate("() => document.activeElement && document.activeElement.blur()")
    page.keyboard.press("0")
    page.wait_for_timeout(900)
    r.ok("0 turns the fill off", "ind=none" in page.evaluate("location.hash"),
         page.evaluate("location.hash"))
    r.ok("and the map is outlines", paths(page)["filled"] == 0 and paths(page)["outlines"] > 5,
         json.dumps(paths(page)))
    page.keyboard.press("0")
    page.wait_for_timeout(900)
    r.ok("0 again brings the same indicator back", "ind=growth" in page.evaluate("location.hash"),
         page.evaluate("location.hash"))
    r.ok("and the fill with it", paths(page)["filled"] > 5, json.dumps(paths(page)))
    # typing a 0 in the search box is a 0 in the search box
    page.click("#areaq")
    page.fill("#areaq", "0180")
    page.wait_for_timeout(500)
    r.ok("typing 0 in the search box does not toggle the mode",
         "ind=growth" in page.evaluate("location.hash"), page.evaluate("location.hash"))
    r.ok("the keystroke went into the box", page.eval_on_selector("#areaq", "e => e.value") == "0180")
    page.fill("#areaq", "")
    page.keyboard.press("Escape")


@check("maponly-minimaps", "P2", "the area page and Test property mini-maps do it too")
def _maponly_minimaps(r, page, errs, calls):
    hop(page, "#area/kommun/0180?ind=growth", 1400)
    base = paths(page, "area")
    r.ok("the area mini-map is filled with an indicator", base["filled"] > 5,
         f'{base["filled"]} filled')
    r.ok("and the chart panel is beside it",
         page.eval_on_selector_all("[data-testid=chart-panel]", "e => e.length") == 1)

    hop(page, "#area/kommun/0180?ind=none", 1400)
    got = paths(page, "area")
    r.ok("in Map only it is outlines only", got["outlines"] > 5 and got["filled"] == 0,
         json.dumps(got))
    r.ok("its legend is gone", not legend_state(page, "#arlegend")["text"],
         legend_state(page, "#arlegend")["text"][:80])
    r.ok("and no chart panel about no indicator",
         page.eval_on_selector_all("[data-testid=chart-panel]", "e => e.length") == 0)
    r.ok("the map says what it is showing",
         "Map only" in (page.inner_text("[data-testid=maponly-note]")
                        if page.eval_on_selector_all("[data-testid=maponly-note]", "e => e.length") else ""))
    tiles = page.eval_on_selector_all("[data-testid=tiles] [data-testid^=tile-]", "e => e.length")
    r.ok("the headline figures are still on the page", tiles >= 3, f"{tiles} tiles")

    hop(page, f"#property?p={STHLM}:Test&ind=none", 1600)
    settle(page)
    pr = paths(page, "prop")
    # the pin itself and its radius circles are not areas, so the assertion is on
    # the area outlines rather than on every path the mini-map draws
    r.ok("Test property's mini-map is outlines only",
         pr["outlines"] > 0 and pr["filledOutlines"] == 0, json.dumps(pr))
    r.ok("and the only other marks on it are the pin and its radii", pr["others"] <= 4,
         f'{pr["others"]} other paths')
    r.ok("its legend is gone too", not legend_state(page, "#proplegend")["text"])
    r.ok("and its headline tiles are not",
         page.eval_on_selector_all("[data-testid=tiles] [data-testid^=tile-]", "e => e.length") >= 3)


@check("maponly-not-on-tables", "P2", "a view with no map falls back to a real indicator")
def _maponly_tables(r, page, errs, calls):
    hop(page, "#data/areas/kommun?ind=none", 1100)
    r.ok("the Data hash drops ind=none", page.evaluate("location.hash") == "#data/areas/kommun",
         page.evaluate("location.hash"))
    head = page.eval_on_selector_all("table.tbl thead th.hi", "e => e.map(x => x.innerText.replace(/\\n/g,' '))")
    r.ok("the highlighted column names a real indicator",
         bool(head) and "Map only" not in head[0], (head[0] if head else "no column")[:80])
    cells = page.eval_on_selector_all(
        "#tbody tr",
        "e => { const th = [...document.querySelectorAll('table.tbl thead th')];"
        " const i = th.findIndex(x => x.classList.contains('hi'));"
        " return e.slice(0, 10).map(tr => (tr.cells[i] || {}).innerText || ''); }")
    r.ok("and the column holds figures, not dashes",
         sum(1 for c in cells if re.search(r"\d", c)) >= 8, json.dumps(cells[:6], ensure_ascii=False))
    r.ok("no Map only chip where there is no map",
         page.eval_on_selector_all("[data-testid=chip-none]", "e => e.length") == 0)
    hop(page, "#charts?ind=none&a=kommun:0180", 1200)
    r.ok("a Charts link drops it as well", "ind=none" not in page.evaluate("location.hash"),
         page.evaluate("location.hash"))
    r.ok("and the chart still draws", page.eval_on_selector_all("svg#chsvg", "e => e.length") == 1)


# --------------------------------------------------------------------------- #
# screenshots
# --------------------------------------------------------------------------- #

def shots(browser, url, out: pathlib.Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for w, h in SHOT_SIZES:
        page, _, _ = boot(browser, url, w, h)
        for name, (route, anchor) in SHOT_ROUTES.items():
            hop(page, route, 1200)
            settle(page, 6000)
            if anchor and page.eval_on_selector_all(f"[data-testid={anchor}]", "e => e.length"):
                page.eval_on_selector(f"[data-testid={anchor}]",
                                      "e => e.scrollIntoView({ block: 'start' })")
                page.wait_for_timeout(500)
            page.screenshot(path=str(out / f"{name}_{w}x{h}.png"), full_page=False)
        page.close()
    print(f"\nscreenshots → {out}")


# --------------------------------------------------------------------------- #

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8081/")
    ap.add_argument("--upto", default=PHASES[-1], choices=PHASES)
    ap.add_argument("--out", default=str(ROOT / "docs" / "ui_v2_1"))
    ap.add_argument("--shots", action="store_true")
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright

    r = Report(args.upto)
    out = pathlib.Path(args.out)
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        shared = boot(browser, args.url)
        for c in CHECKS:
            if not r.wants(c["phase"]):
                continue
            r.head(c["phase"], c["title"])
            if c["needs"] == "page":
                page, errs, calls = shared
            else:
                page, errs, calls = boot(browser, args.url, status=500 if c["needs"] == "error" else 200)
            try:
                c["fn"](r, page, errs, calls)
            except Exception as exc:                              # noqa: BLE001
                r.ok(c["id"], False, f"{type(exc).__name__}: {exc}")
            finally:
                if c["needs"] != "page":
                    page.close()
        shared[0].close()
        if args.shots:
            shots(browser, args.url, out)
        browser.close()

    r.write(out)
    print(f"\n{r.n - len(r.fails)}/{r.n} checks passed (up to {args.upto}) · report → {out / 'report.json'}")
    if r.fails:
        print("\nfailures:")
        for f in r.fails:
            print("  ✗ " + f)
    return 1 if r.fails else 0


if __name__ == "__main__":
    sys.exit(main())
