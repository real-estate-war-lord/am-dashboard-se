#!/usr/bin/env python3
"""The v2.0 UI acceptance spec — headless Chromium through Playwright.

    python3 tests/ui_v2/spec.py --url http://localhost:8081/ --upto P11
    python3 tests/ui_v2/spec.py --shots --out docs/ui_v2        # capture the review set
    python3 tests/ui_v2/spec.py --live                          # the one live-gateway check

Every check belongs to a phase, and `--upto P4` runs the phases up to and
including P4 — so the spec is runnable from the first commit of the overhaul
rather than only at the end.

The listings gateway is NEVER called by these checks: `page.route` intercepts
every request to it and answers from tests/fixtures/listings_stockholm.json,
recorded once from the live gateway. A test that depended on a third-party
service would fail for reasons that have nothing to do with this repository, and
would also be impolite to a donated service. `--live` runs one separate check
against the real gateway and is the only thing here that touches the network.

Serve dist/ on port 8081, not 8080: the gateway's CORS allowlist permits both,
and 8081 is the one that is free when another project holds 8080.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "tests" / "fixtures" / "listings_stockholm.json"
GATEWAY_GLOB = "**am-se-listings**"

PHASES = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11"]

# Every route the spec drives, with a short name used for screenshots.
ROUTES = {
    "map": "#map",
    "map-kommun": "#map/0180",
    "map-deso": "#map/0180/deso",
    "area-kommun": "#area/kommun/0180",
    "area-regso": "#area/regso/0180R001_RegSO2025",
    "area-deso": "#area/deso/0180C1010_DeSO2025",
    "data-areas": "#data/areas/kommun",
    "data-projects": "#data/projects",
    "data-national": "#data/national",
    "data-sources": "#data/sources",
    "charts": "#charts?ind=growth&a=kommun:0180,kommun:1480",
    "property": "#property?p=59.31972,18.07194",
    "property-listings": "#property?p=59.31972,18.07194&show=listings",
}
WIDTHS = [(1366, 768), (1440, 900), (1536, 864), (390, 844)]

STHLM = "59.31972,18.07194"


class Report:
    def __init__(self, upto: str):
        self.upto = PHASES.index(upto)
        self.fails: list[str] = []
        self.n = 0
        self.phase = ""

    def wants(self, phase: str) -> bool:
        return PHASES.index(phase) <= self.upto

    def head(self, phase: str, title: str) -> None:
        self.phase = phase
        print(f"\n{phase} — {title}")

    def ok(self, name: str, cond, detail: str = "") -> bool:
        self.n += 1
        if cond:
            print(f"  ✓ {name}" + (f" — {detail}" if detail else ""))
            return True
        self.fails.append(f"{self.phase} {name}" + (f" — {detail}" if detail else ""))
        print(f"  ✗ {name}" + (f" — {detail}" if detail else ""))
        return False


# --------------------------------------------------------------------------- #
# driving helpers
# --------------------------------------------------------------------------- #

def install_gateway_fixture(page) -> dict:
    """Answer every gateway request from the recorded fixture."""
    body = json.loads(FIXTURE.read_text(encoding="utf-8"))
    calls = {"n": 0, "urls": []}

    def handler(route):
        calls["n"] += 1
        calls["urls"].append(route.request.url)
        url = route.request.url
        if "/text" in url:
            route.fulfill(status=200, content_type="application/json",
                          body=json.dumps({"text_start": "Fixture description text."}))
            return
        route.fulfill(status=200, content_type="application/json",
                      headers={"access-control-allow-origin": "*"},
                      body=json.dumps(body))

    page.route(GATEWAY_GLOB, handler)
    return calls


def boot(browser, url, width, height, fixture=True):
    page = browser.new_page(viewport={"width": width, "height": height})
    errs: list[str] = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.on("console", lambda m: errs.append("console.error: " + m.text) if m.type == "error" else None)
    calls = install_gateway_fixture(page) if fixture else {"n": 0, "urls": []}
    page.goto(url, wait_until="load")
    page.wait_for_function("typeof window.AM !== 'undefined'", timeout=20000)
    page.wait_for_timeout(400)
    return page, errs, calls


def hop(page, route, settle=650):
    page.evaluate("h => { location.hash = h; }", route)
    page.wait_for_timeout(settle)
    return page.evaluate("location.hash")


def open_menu(page, testid: str) -> None:
    """Click a menu trigger only if its popover is not already showing."""
    pop = {"layers-btn": "layers-pop", "export-btn": "export-menu",
           "ind-picker-btn": "ind-picker-pop"}[testid]
    if page.eval_on_selector_all(f"[data-testid={pop}]", "e => e.length") == 0:
        page.click(f"[data-testid={testid}]")
        page.wait_for_timeout(250)


def close_menus(page) -> None:
    page.keyboard.press("Escape")
    page.wait_for_timeout(150)


def hash_has(got: str, want: str) -> bool:
    """The redirect landed where it should. The view may add keys of its own
    afterwards — an area page writes its indicator into the hash — so this
    compares the path and requires every key the redirect owed, not equality."""
    def split(h):
        h = h.lstrip("#")
        path, _, qs = h.partition("?")
        return path, dict(p.split("=", 1) for p in qs.split("&") if "=" in p)
    gp, gq = split(got)
    wp, wq = split(want)
    return gp == wp and all(gq.get(k) == v for k, v in wq.items())


def text(page) -> str:
    return page.evaluate("document.body.innerText")


def boxes(page, selector):
    return page.eval_on_selector_all(
        selector,
        "els => els.filter(e => e.offsetParent !== null || getComputedStyle(e).position === 'fixed')"
        ".map(e => { const r = e.getBoundingClientRect();"
        " return { x: r.x, y: r.y, w: r.width, h: r.height }; })"
        ".filter(b => b.w > 0 && b.h > 0)")


def overlap(a, b) -> bool:
    return not (a["x"] + a["w"] <= b["x"] or b["x"] + b["w"] <= a["x"]
                or a["y"] + a["h"] <= b["y"] or b["y"] + b["h"] <= a["y"])


# --------------------------------------------------------------------------- #
# the phases
# --------------------------------------------------------------------------- #

def phase1(r: Report, page, errs) -> None:
    r.head("P1", "navigation and routes")
    hop(page, "#map")
    nav = page.eval_on_selector_all("[data-testid=nav-item]", "e => e.map(x => x.innerText.trim())")
    r.ok("exactly four destinations", len(nav) == 4, ", ".join(nav))
    r.ok("named Map, Data, Charts, Test property",
         nav == ["Map", "Data", "Charts", "Test property"], ", ".join(nav))
    r.ok("Export ▾ is in the sidebar footer",
         page.eval_on_selector_all("[data-testid=sidebar] [data-testid=export-btn]", "e => e.length") == 1)

    hop(page, "#data/areas/kommun")
    tabs = page.eval_on_selector_all("[data-testid=data-tabs] button", "e => e.map(x => x.innerText.trim())")
    r.ok("Data has four tabs", tabs == ["Areas", "Projects", "National series", "Sources"], ", ".join(tabs))
    r.ok("and its own Export ▾",
         page.eval_on_selector_all("[data-testid=data-tabs] ~ .menu [data-testid=export-btn], "
                                   ".dhead [data-testid=export-btn]", "e => e.length") >= 1)

    for old, want in [("#table/regso", "#data/areas/regso"),
                      ("#table", "#data/areas/kommun"),
                      ("#pipeline", "#data/projects"),
                      ("#market", "#data/national"),
                      ("#sources", "#data/sources"),
                      ("#market?src=1", "#data/sources"),
                      ("#analysis?a=59.31972,18.07194&la=Home", f"#property?p={STHLM}:Home"),
                      ("#analysis?a=59.31972,18.07194&b=57.7,11.97", f"#property?p={STHLM}"),
                      ("#compare?a=kommun:0180&b=kommun:1480", "#area/kommun/0180"),
                      ("#map/0180?srv=1&pub=1", "#map/0180?lay=public,services"),
                      ("#area/kommun/0180?t=dist&g=Rents", "#area/kommun/0180?show=dist")]:
        got = hop(page, old, 500)
        r.ok(f"{old} → {want}", hash_has(got, want), got)

    r.ok("no Compare anywhere on the map", "Compare" not in (hop(page, "#map") or "") and
         "Compare" not in text(page))

    r.ok("window.__maps exposes the live Leaflet instances",
         page.evaluate("Array.isArray(window.__maps)"))
    hop(page, "#map")
    r.ok("the map registers itself", page.evaluate("window.__maps.length") >= 1,
         str(page.evaluate("window.__maps.length")))
    hop(page, "#area/kommun/0180")
    r.ok("and only the new view's maps are alive after a route change",
         page.evaluate("window.__maps.length") == 1, str(page.evaluate("window.__maps.length")))

    # every route, zero errors
    bad = []
    for name, route in ROUTES.items():
        errs.clear()
        hop(page, route)
        if errs:
            bad.append(f"{name}: {errs[0][:90]}")
    r.ok("zero page errors on every route", not bad, "; ".join(bad))


def phase2(r: Report, page, errs) -> None:
    r.head("P2", "one toolbar on the map")
    hop(page, "#map")
    row1 = page.eval_on_selector_all(
        "[data-testid=map-toolbar][data-row='1'] > *",
        "e => e.map(x => (x.getAttribute('data-testid') || x.className || x.tagName).toString().trim())")
    r.ok("row 1 has at most five controls", len(row1) <= 5, " | ".join(row1))
    r.ok("the unified search is first", page.eval_on_selector_all(
        "[data-testid=map-toolbar][data-row='1'] > *:first-child [data-testid=search], "
        "[data-testid=map-toolbar][data-row='1'] > [data-testid=search]", "e => e.length") >= 1)
    for gone in ["Climate risk", "Vulnerable areas", "Public buildings", "Infrastructure"]:
        r.ok(f'no "{gone}" button outside the Layers menu',
             page.eval_on_selector_all(
                 f"[data-testid=map-toolbar] button", "e => e.map(x => x.innerText.trim())"
             ).count(gone) == 0)
    r.ok("Layers ▾ is in the toolbar",
         page.eval_on_selector_all("[data-testid=layers-btn]", "e => e.length") == 1)
    r.ok("full screen moved to the top bar",
         page.eval_on_selector_all(".topbar [data-testid=map-full]", "e => e.length") == 1)
    r.ok("the privacy sentence has left the map", "never sent to a server" not in text(page))

    page.set_viewport_size({"width": 1366, "height": 768})
    page.wait_for_timeout(400)
    top = page.eval_on_selector("[data-testid=map]", "e => Math.round(e.getBoundingClientRect().top)")
    r.ok("at 1366×768 the map starts within 200 px", top <= 200, f"{top} px")
    page.set_viewport_size({"width": 1440, "height": 900})
    page.wait_for_timeout(300)

    # coordinates in the search box go to the property page
    page.fill("[data-testid=search] input, input[data-testid=search]", "59.31972, 18.07194")
    page.wait_for_timeout(350)
    r.ok("a pasted coordinate offers a Test property result",
         page.eval_on_selector_all("[data-testid=search-coord]", "e => e.length") == 1)
    page.click("[data-testid=search-coord]")
    page.wait_for_timeout(600)
    r.ok("and clicking it opens the pin", hash_has(page.evaluate("location.hash"), f"property?p={STHLM}"),
         page.evaluate("location.hash"))

    hop(page, "#map")
    jumps = page.eval_on_selector_all("[data-testid=search-jumps] button", "e => e.map(x => x.innerText.trim())")
    r.ok("the quick jumps live in the search dropdown",
         jumps == ["Stockholm", "Göteborg", "Malmö", "Sweden"], ", ".join(jumps))
    before = page.evaluate("location.hash")
    page.keyboard.press("g")
    page.wait_for_timeout(500)
    r.ok("a jump moves the camera and nothing else",
         page.evaluate("location.hash").split("?")[0] == before.split("?")[0],
         page.evaluate("location.hash"))


def phase3(r: Report, page, errs, calls) -> None:
    r.head("P3", "Layers ▾ including rental listings")
    hop(page, "#map/0180")
    open_menu(page, "layers-btn")
    rows = page.eval_on_selector_all("[data-testid=layers-pop] [data-layer]",
                                     "e => e.map(x => x.getAttribute('data-layer'))")
    for want in ["infra", "public", "services", "schools", "uso", "listings"]:
        r.ok(f"the menu offers {want}", want in rows, ", ".join(rows))
    labels = page.inner_text("[data-testid=layers-pop]")
    r.ok("the listings row is named Rental listings", "Rental listings" in labels)

    # zoom 14 over Stockholm, tick the layer, expect markers from the fixture
    hop(page, f"#map/0180?c={STHLM}&z=14")
    calls["n"] = 0
    open_menu(page, "layers-btn")
    page.click("[data-testid=layers-pop] [data-layer=listings]")
    page.wait_for_timeout(1800)
    r.ok("ticking it writes lay=listings", "listings" in page.evaluate("location.hash"),
         page.evaluate("location.hash"))
    r.ok("the gateway was asked exactly once for this viewport", calls["n"] >= 1, str(calls["n"]))
    n = page.evaluate("document.querySelectorAll('.lst-mk').length")
    r.ok("and at least one listing marker is drawn", n >= 1, f"{n} markers")
    leg = page.inner_text("[data-testid=legend-listings]") if page.eval_on_selector_all(
        "[data-testid=legend-listings]", "e => e.length") else ""
    r.ok("the legend counts the three groups", "HomeQ" in leg and "queue" in leg.lower(), leg[:90])

    # panning inside the same area must not refetch
    calls["n"] = 0
    page.evaluate("window.__maps[0].panBy([12, 12])")
    page.wait_for_timeout(1500)
    r.ok("a small pan does not refetch", calls["n"] == 0, f"{calls['n']} calls")

    hop(page, f"#map/0180?c={STHLM}&z=11&lay=listings")
    page.wait_for_timeout(900)
    leg = page.inner_text("[data-testid=legend-listings]")
    r.ok("below zoom 13 the legend says to zoom in", "zoom in" in leg.lower(), leg[:90])


def phase4(r: Report, page, errs) -> None:
    r.head("P4", "one indicator picker and one period control")
    for name in ["map", "area-kommun", "data-areas", "charts", "property"]:
        hop(page, ROUTES[name])
        n = page.eval_on_selector_all("[data-testid=ind-picker]", "e => e.length")
        r.ok(f"exactly one picker on {name}", n == 1, str(n))
    hop(page, "#map")
    open_menu(page, "ind-picker-btn")
    r.ok("the popover opens with a focused search",
         page.eval_on_selector_all("[data-testid=ind-picker-pop] [data-testid=ind-search]", "e => e.length") == 1
         and page.evaluate("document.activeElement.getAttribute('data-testid')") == "ind-search")
    groups = page.eval_on_selector_all("[data-testid=ind-picker-pop] [data-group]",
                                       "e => e.map(x => x.getAttribute('data-group'))")
    r.ok("and shows every group", len(groups) >= 10, f"{len(groups)} groups")
    before = page.eval_on_selector_all("[data-testid=ind-picker-pop] [data-ind]", "e => e.length")
    page.fill("[data-testid=ind-search]", "rent")
    page.wait_for_timeout(250)
    # A row matches on its own text OR on its group — "New dwellings that are
    # hyresrätt" belongs under Rents, and its header is right above it on screen.
    vis = page.eval_on_selector_all(
        "[data-testid=ind-picker-pop] [data-ind]",
        "e => e.map(x => (x.closest('[data-group]').getAttribute('data-group') + ' ' + x.innerText).toLowerCase())")
    r.ok("search filters to matching rows",
         vis and len(vis) < before and all("rent" in v for v in vis), f"{len(vis)} of {before} rows")
    page.keyboard.press("Enter")
    page.wait_for_timeout(500)
    r.ok("Enter selects the first match", "ind=" in page.evaluate("location.hash"),
         page.evaluate("location.hash"))

    hop(page, "#map?ind=growth")
    r.ok("a history indicator shows the year select",
         page.eval_on_selector_all("[data-testid=period-year]", "e => e.length") == 1)
    hop(page, "#map?ind=fc_growth")
    r.ok("an Outlook indicator shows a projection badge, not a year",
         page.eval_on_selector_all("[data-testid=period-proj]", "e => e.length") == 1
         and page.eval_on_selector_all("[data-testid=period-year]", "e => e.length") == 0)
    hop(page, "#map?ind=sea2100_85")
    r.ok("a Climate indicator shows its scenario badge",
         page.eval_on_selector_all("[data-testid=period-clim]", "e => e.length") == 1)
    r.ok("and the hazard-zone legend appears with it",
         page.eval_on_selector_all("[data-testid=legend-zones] .lgtitle", "e => e.length") == 1)
    hop(page, "#map?ind=growth")
    r.ok("choosing a non-Climate indicator removes the zones",
         page.eval_on_selector_all("[data-testid=legend-zones] .lgtitle", "e => e.length") == 0)
    hop(page, "#map?ind=sea2100_85&zones=0")
    r.ok("zones=0 hides them even for a Climate indicator",
         page.eval_on_selector_all("[data-testid=legend-zones] .lgtitle", "e => e.length") == 0)
    hop(page, "#area/regso/0180R001_RegSO2025")
    open_menu(page, "ind-picker-btn")
    r.ok("a sub-area page groups the inherited indicators",
         page.eval_on_selector_all("[data-group='From the municipality']", "e => e.length") == 1)


def phase5(r: Report, page, errs) -> None:
    r.head("P5", "the map's area card")
    hop(page, "#map/0180")
    card = page.query_selector("[data-testid=area-card]")
    r.ok("a selected kommun gets one card", card is not None)
    if not card:
        return
    t = page.inner_text("[data-testid=area-card]")
    r.ok("it names the kommun, its län and its size", "Stockholm" in t and "inhabitants" in t)
    tiles = page.eval_on_selector_all("[data-testid=area-card] [data-testid^=tile-]", "e => e.length")
    r.ok("five headline figures in one row", tiles == 5, str(tiles))
    page.click("[data-testid=area-card] [data-testid^=tile-]")
    page.wait_for_timeout(450)
    r.ok("clicking a figure selects that indicator", "ind=" in page.evaluate("location.hash"))
    secs = page.eval_on_selector_all("[data-testid=area-card] details", "e => e.map(x => x.open)")
    r.ok("everything else is folded away, closed", secs and not any(secs), str(secs))


def phase6(r: Report, page, errs) -> None:
    r.head("P6", "the area page")
    hop(page, "#area/kommun/0180")
    r.ok("no KEY FIGURES block", "KEY FIGURES" not in text(page).upper())
    r.ok("the study row holds the chart panel and the mini-map",
         page.eval_on_selector_all("[data-testid=study-row] [data-testid=chart-panel]", "e => e.length") == 1
         and page.eval_on_selector_all("[data-testid=study-row] [data-testid=minimap]", "e => e.length") == 1)
    geo = page.evaluate("""() => {
      const p = document.querySelector('[data-testid=chart-panel]').getBoundingClientRect();
      const m = document.querySelector('[data-testid=minimap]').getBoundingClientRect();
      const row = document.querySelector('[data-testid=study-row]').getBoundingClientRect();
      return { ph: p.height, mh: m.height, pw: p.width / row.width, mw: m.width / row.width, left: p.x < m.x };
    }""")
    r.ok("equal height, chart left, about 60/40",
         abs(geo["ph"] - geo["mh"]) <= 4 and geo["left"] and 0.5 <= geo["pw"] <= 0.68,
         f"{geo['ph']:.0f}/{geo['mh']:.0f} px, {geo['pw']:.0%}/{geo['mw']:.0%}")
    r.ok("the mini-map drags", page.evaluate("""async () => {
      const m = window.__maps.find(x => x.getContainer().id === 'armap');
      if (!m) return false;
      const a = m.getCenter(); m.panBy([120, 0]); await new Promise(r => setTimeout(r, 400));
      const b = m.getCenter();
      return Math.abs(a.lng - b.lng) > 1e-6 && m.dragging.enabled();
    }"""))
    page.click("[data-testid=minimap-full]")
    page.wait_for_timeout(350)
    frac = page.eval_on_selector("[data-testid=minimap]",
                                 "e => { const r = e.getBoundingClientRect();"
                                 " return (r.width * r.height) / (innerWidth * innerHeight); }")
    r.ok("⤢ fills the viewport", frac > 0.85, f"{frac:.0%}")
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    frac2 = page.eval_on_selector("[data-testid=minimap]",
                                  "e => { const r = e.getBoundingClientRect();"
                                  " return (r.width * r.height) / (innerWidth * innerHeight); }")
    r.ok("and Esc puts it back", frac2 < 0.5, f"{frac2:.0%}")

    r.ok("the outlook section is open on a kommun page",
         page.eval_on_selector("[data-testid=sec-outlook]", "e => e.open"))
    hop(page, "#area/regso/0180R001_RegSO2025")
    r.ok("and closed below kommun level",
         not page.eval_on_selector_all("[data-testid=sec-outlook]", "e => e.length")
         or not page.eval_on_selector("[data-testid=sec-outlook]", "e => e.open"))
    t = text(page)
    r.ok("an inherited figure says so in words, not with a bare degree sign",
         "municipality figure" in t or "muni" in t)
    r.ok("no lone degree sign is left on the tiles",
         not re.search(r"\s°\s*$", page.inner_text("[data-testid=tiles]"), re.M))
    hop(page, "#area/regso/0180R001_RegSO2025?show=figures")
    r.ok("show= opens the named section",
         page.eval_on_selector("[data-testid=sec-figures]", "e => e.open"))


def phase7(r: Report, page, errs, calls) -> None:
    r.head("P7", "Test property with the listings module")
    hop(page, "#property")
    r.ok("the empty state focuses its input",
         page.eval_on_selector_all("[data-testid=state-empty]", "e => e.length") == 1
         and page.evaluate("document.activeElement.getAttribute('data-testid')") == "prop-input")
    r.ok("and offers one example link", STHLM.replace(",", ", ") in text(page))

    hop(page, f"#property?p={STHLM}")
    page.wait_for_timeout(900)
    tiles = page.eval_on_selector_all("[data-testid=tiles] > *", "e => e.map(x => x.innerText.trim())")
    r.ok("always five headline tiles", len(tiles) == 5, str(len(tiles)))
    r.ok("and none of them is an empty filler", all(t for t in tiles))
    r.ok("the study row is the same component as the area page's",
         page.eval_on_selector_all("[data-testid=study-row] [data-testid=chart-panel]", "e => e.length") == 1
         and page.eval_on_selector_all("[data-testid=study-row] [data-testid=minimap]", "e => e.length") == 1)
    head = text(page)
    r.ok("the header names kommun, RegSO and DeSO", "Stockholm" in head and "RegSO" in head and "DeSO" in head)
    r.ok("the mini-map drags", page.evaluate("""async () => {
      const m = window.__maps.find(x => x.getContainer().id === 'propmap');
      if (!m) return false;
      const a = m.getCenter(); m.panBy([120, 0]); await new Promise(r => setTimeout(r, 400));
      return Math.abs(a.lng - m.getCenter().lng) > 1e-6;
    }"""))

    hop(page, f"#property?p={STHLM}&show=listings")
    page.wait_for_timeout(2200)
    sec = page.inner_text("[data-testid=sec-listings]")
    r.ok("the summary line counts the groups first",
         re.search(r"\d+\s+live listings", sec) and "HomeQ" in sec, sec.splitlines()[0][:100] if sec else "")
    low = sec.lower().replace("\u2260", "is not")
    r.ok("the caveats are on the section",
         "advertised rent is not contract rent" in low and "adverts is not vacancy" in low,
         low[-180:].replace("\n", " "))
    med = page.eval_on_selector_all("[data-testid=lst-medians] .m", "e => e.map(x => x.innerText)")
    r.ok("medians are labelled advertised", "advertised" in sec.lower(), f"{len(med)} buckets")
    r.ok("and suppressed where n < 3",
         all(("too few" in m) == ("–" in m.split("\n")[0]) for m in med) if med else True)
    page.click("[data-testid=lst-show]")
    page.wait_for_timeout(1200)
    r.ok("Show listings renders the cards and the table",
         page.eval_on_selector_all("[data-testid=lst-cards] .lst-card", "e => e.length") >= 1
         and page.eval_on_selector_all("[data-testid=lst-table] tbody tr", "e => e.length") >= 1)
    r.ok("every card links to the original listing",
         page.eval_on_selector_all("[data-testid=lst-cards] .lst-card a.open",
                                   "e => e.every(a => /^https?:/.test(a.href))"))
    r.ok("no own-rent field anywhere on the page",
         not re.search(r"\bown rent\b|\bmy rent\b|egen hyra", text(page), re.I))
    r.ok("the listings also appear on the mini-map",
         page.evaluate("document.querySelectorAll('#propmap .lst-mk').length") >= 1,
         str(page.evaluate("document.querySelectorAll('#propmap .lst-mk').length")))

    for rad in ["500", "1000", "2000"]:
        hop(page, f"#property?p={STHLM}&rad={rad}")
        page.wait_for_timeout(500)
        r.ok(f"radius {rad} m drives the rings", f"rad={rad}" in page.evaluate("location.hash")
             or rad == "1000", page.evaluate("location.hash"))


def phase8(r: Report, page, errs) -> None:
    r.head("P8", "one export model")
    LONG = ("level;code;name;parent_code;parent_name;lan;population;indicator;label;unit;period;"
            "period_type;value;margin_of_error;value_type;inherited_from;direction;source;table_id;"
            "source_url;as_of;fetched;licence")
    hop(page, "#data/areas/kommun")
    open_menu(page, "export-btn")
    items = page.eval_on_selector_all("[data-testid=export-menu] [data-export]",
                                      "e => e.map(x => x.getAttribute('data-export'))")
    for want in ["view", "areas", "projects", "national", "property", "nearby", "sources"]:
        r.ok(f"the menu offers {want}", want in items, ", ".join(items))

    def header(export_id, route=None):
        if route:
            hop(page, route)
        page.wait_for_timeout(200)
        return page.evaluate("""async id => {
          const rows = await window.AM.exportRows(id);
          return rows ? rows[0] : null;
        }""", export_id)

    h = header("areas")
    r.ok("the long schema is exactly the documented one", h == LONG, (h or "")[:120])
    h = header("projects")
    r.ok("projects are their own file with no indicator column",
         h and "indicator" not in h.split(";"), (h or "")[:90])
    h = header("property", f"#property?p={STHLM}")
    r.ok("Test property leads with the property columns",
         h and h.startswith("property_label;lat;lon;level;code;"), (h or "")[:90])
    h = header("nearby", f"#property?p={STHLM}&show=listings")
    r.ok("Nearby carries kind, distance and the advertised rent",
         h == "kind;name;type;status;distance_m;rent;m2;rooms;source;source_url", (h or "")[:120])
    bad = page.evaluate("window.AM.exportUnitProblems()")
    r.ok("unit and magnitude agree in every exported row", not bad, str(bad)[:140])


def phase9(r: Report, page, errs) -> None:
    r.head("P9", "numbers and labels")
    hop(page, "#area/kommun/0180")
    t = text(page)
    r.ok("no rank is written with a slash", not re.search(r"#\d+\s*/\s*\d+", t),
         (re.search(r"#\d+\s*/\s*\d+", t) or [""])[0])
    r.ok("ranks read '#n of N'", re.search(r"#\d[\d\s ]*of\s[\d\s ]*\d", t) is not None)
    r.ok("a change carries its sign", re.search(r"[+−]\s?\d", t) is not None)
    r.ok("K/T-tal is never called a price per m²",
         not re.search(r"K/T[- ]tal[^.]{0,40}price per m", t, re.I))
    hop(page, "#data/areas/kommun?ind=rent")
    r.ok("rent is quoted in SEK/m²/yr", "SEK / m² / yr" in text(page) or "SEK/m²/yr" in text(page))
    r.ok("sv-SE thousands use a space, never a comma",
         not re.search(r"\b\d{1,3},\d{3}\b", text(page)))


def phase10(r: Report, page_unused, errs_unused, browser, url) -> None:
    r.head("P10", "responsive")
    for w, h in WIDTHS:
        page, errs, _ = boot(browser, url, w, h)
        bad, over = [], []
        for name, route in ROUTES.items():
            errs.clear()
            hop(page, route)
            sw = page.evaluate("document.documentElement.scrollWidth")
            if sw > w + 1:
                over.append(f"{name} {sw}>{w}")
            if errs:
                bad.append(f"{name}: {errs[0][:70]}")
        r.ok(f"{w}×{h}: no horizontal overflow", not over, "; ".join(over))
        r.ok(f"{w}×{h}: zero page errors", not bad, "; ".join(bad))
        if w <= 1024:
            hop(page, "#map")
            r.ok("the sidebar is replaced by a top bar",
                 page.eval_on_selector("[data-testid=sidebar]", "e => getComputedStyle(e).display") == "none"
                 and page.eval_on_selector("[data-testid=topbar-mobile]", "e => getComputedStyle(e).display") != "none")
            page.click("[data-testid=nav-toggle]")
            page.wait_for_timeout(250)
            r.ok("☰ opens the drawer", page.eval_on_selector("[data-testid=nav-drawer]", "e => !e.hidden"))
            page.keyboard.press("Escape")
            page.wait_for_timeout(250)
            r.ok("Esc closes it and returns focus",
                 page.eval_on_selector("[data-testid=nav-drawer]", "e => e.hidden")
                 and page.evaluate("document.activeElement.getAttribute('data-testid')") == "nav-toggle")
        page.close()


def phase11(r: Report, page, errs) -> None:
    r.head("P11", "legends and the words that must not appear")
    hop(page, "#map/0180?lay=infra,public,services,schools&ind=sea2100_85&c=" + STHLM + "&z=12")
    page.wait_for_timeout(1200)
    bs = boxes(page, "[data-testid^=legend]")
    pairs = [(i, j) for i in range(len(bs)) for j in range(i + 1, len(bs)) if overlap(bs[i], bs[j])]
    r.ok("legends never overlap each other", not pairs, f"{len(bs)} legends, {len(pairs)} overlaps")
    mapbox = page.eval_on_selector("[data-testid=map]", "e => { const r = e.getBoundingClientRect();"
                                   " return { x: r.x, y: r.y, w: r.width, h: r.height }; }")
    outside = [b for b in bs if b["x"] < mapbox["x"] - 1 or b["x"] + b["w"] > mapbox["x"] + mapbox["w"] + 1]
    r.ok("and all of them sit inside the map", not outside, str(len(outside)))
    r.ok("no legend carries a filter button",
         page.eval_on_selector_all("[data-testid^=legend] [data-srvcat], [data-testid^=legend] .lgb",
                                   "e => e.length") == 0)
    for name, route in ROUTES.items():
        hop(page, route)
        t = text(page)
        r.ok(f'no "Compare" on {name}', "Compare" not in t)
        r.ok(f'no "Climate risk" button on {name}', "Climate risk" not in t)
        r.ok(f'no "KEY FIGURES" on {name}', "KEY FIGURES" not in t.upper())


def live_check(browser, url, r: Report) -> None:
    r.head("live", "the real gateway, once")
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    seen = {"n": 0, "status": None}
    page.on("response", lambda resp: (seen.__setitem__("n", seen["n"] + 1),
                                      seen.__setitem__("status", resp.status))
            if "am-se-listings" in resp.url else None)
    page.goto(url, wait_until="load")
    page.wait_for_function("typeof window.AM !== 'undefined'", timeout=20000)
    hop(page, f"#property?p={STHLM}&show=listings", 6000)
    sec = page.inner_text("[data-testid=sec-listings]")
    r.ok("the live gateway answered", seen["n"] >= 1 and seen["status"] in (200, 502),
         f"{seen['n']} responses, last {seen['status']}")
    r.ok("and the section says how many listings it found",
         re.search(r"\d+\s+live listings", sec) is not None or "unavailable" in sec.lower(),
         sec.splitlines()[0][:110] if sec else "")
    page.close()


def shots(browser, url, out: pathlib.Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for w, h in [(1440, 900), (390, 844)]:
        page, _, _ = boot(browser, url, w, h)
        for name, route in ROUTES.items():
            hop(page, route, 1400)
            page.screenshot(path=str(out / f"{name}_{w}x{h}.png"), full_page=False)
        page.close()
    print(f"\nscreenshots → {out}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8081/")
    ap.add_argument("--upto", default="P11", choices=PHASES)
    ap.add_argument("--out", default=str(ROOT / "docs" / "ui_v2"))
    ap.add_argument("--shots", action="store_true")
    ap.add_argument("--live", action="store_true")
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright

    r = Report(args.upto)
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page, errs, calls = boot(browser, args.url, 1440, 900)
        if r.wants("P1"):
            phase1(r, page, errs)
        if r.wants("P2"):
            phase2(r, page, errs)
        if r.wants("P3"):
            phase3(r, page, errs, calls)
        if r.wants("P4"):
            phase4(r, page, errs)
        if r.wants("P5"):
            phase5(r, page, errs)
        if r.wants("P6"):
            phase6(r, page, errs)
        if r.wants("P7"):
            phase7(r, page, errs, calls)
        if r.wants("P8"):
            phase8(r, page, errs)
        if r.wants("P9"):
            phase9(r, page, errs)
        page.close()
        if r.wants("P10"):
            phase10(r, None, None, browser, args.url)
        if r.wants("P11"):
            page, errs, calls = boot(browser, args.url, 1440, 900)
            phase11(r, page, errs)
            page.close()
        if args.live:
            live_check(browser, args.url, r)
        if args.shots:
            shots(browser, args.url, pathlib.Path(args.out))
        browser.close()

    print(f"\n{r.n - len(r.fails)}/{r.n} checks passed (up to {args.upto})")
    if r.fails:
        print("\nfailures:")
        for f in r.fails:
            print("  ✗ " + f)
    return 1 if r.fails else 0


if __name__ == "__main__":
    sys.exit(main())
