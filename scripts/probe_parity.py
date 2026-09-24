#!/usr/bin/env python3
"""Probe every candidate source route for the v1.2 parity build.

Standard library only, like the rest of the pipeline. Nothing is stored: this
script answers "does this route exist, what does it cost, and what comes back"
so the phase scripts can be written against routes that are known to work.

Each PROBE names one capability and lists candidate URLs in preference order.
Every candidate is called, timed and summarised; the first one that satisfies
the probe's `ok` test is marked as the route to use. Writes docs/PARITY_PROBE.md.

    python3 scripts/probe_parity.py [--only SUBSTRING] [--timeout 30]
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import http.cookiejar
import io
import json
import pathlib
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from http_util import bra_context                                        # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "PARITY_PROBE.md"

UA = {
    "User-Agent": "am-dashboard-se/1.2-parity probe (+https://github.com/real-estate-war-lord)",
    "Accept": "*/*",
    "Accept-Encoding": "gzip",
}
MAX_KEEP = 400_000          # bytes of a body we are willing to hold in memory
TIMEOUT = 30


# ---------------------------------------------------------------- HTTP

class Result:
    def __init__(self, url, method):
        self.url, self.method = url, method
        self.status = 0
        self.secs = 0.0
        self.bytes = 0
        self.ctype = ""
        self.body = b""
        self.error = ""
        self.note = ""
        self.truncated = False

    @property
    def ok_http(self) -> bool:
        return 200 <= self.status < 300


# Brå's SOL is a session-based JSP app: the selection form is a 993-byte stub
# until a JSESSIONID from /action/start is presented with it. One opener, built
# lazily, carries the cookie across the SOL probes.
_sol_opener = None


def sol_opener():
    global _sol_opener
    if _sol_opener is None:
        cj = http.cookiejar.CookieJar()
        _sol_opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=bra_context()),
            urllib.request.HTTPCookieProcessor(cj))
        try:
            _sol_opener.open(urllib.request.Request(
                "https://statistik.bra.se/solwebb/action/start?menykatalogid=1",
                headers=dict(UA)), timeout=30).read()
        except Exception:                                                # noqa: BLE001
            pass
    return _sol_opener


def call(url: str, method: str = "GET", body: bytes | None = None,
         headers: dict | None = None, timeout: int = TIMEOUT) -> Result:
    r = Result(url, method)
    h = dict(UA)
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=body, headers=h, method=method)
    # statistik.bra.se serves a mismatched intermediate — see scripts/http_util.py
    ctx = bra_context() if "statistik.bra.se" in url else ssl.create_default_context()
    opener = sol_opener() if "statistik.bra.se/solwebb" in url else None
    t0 = time.monotonic()
    try:
        with (opener.open(req, timeout=timeout) if opener
              else urllib.request.urlopen(req, timeout=timeout, context=ctx)) as resp:
            r.status = resp.status
            r.ctype = resp.headers.get("Content-Type", "")
            declared = resp.headers.get("Content-Length")
            raw = resp.read(MAX_KEEP + 1) if method != "HEAD" else b""
            if len(raw) > MAX_KEEP:
                r.truncated = True
                raw = raw[:MAX_KEEP]
            if resp.headers.get("Content-Encoding") == "gzip" and raw:
                try:
                    raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
                except Exception:
                    pass
            r.body = raw
            r.bytes = int(declared) if declared and declared.isdigit() else len(raw)
    except urllib.error.HTTPError as e:
        r.status = e.code
        r.ctype = e.headers.get("Content-Type", "") if e.headers else ""
        try:
            r.body = e.read(4000)
        except Exception:
            pass
        r.error = f"HTTP {e.code} {e.reason}"
    except Exception as e:                                  # noqa: BLE001
        r.error = f"{type(e).__name__}: {e}"
    r.secs = time.monotonic() - t0
    return r


# ---------------------------------------------------------------- summarisers

def _json(r: Result):
    try:
        return json.loads(r.body.decode("utf-8", "replace"))
    except Exception:
        return None


def sum_json_keys(r: Result) -> str:
    j = _json(r)
    if j is None:
        return "not JSON"
    if isinstance(j, list):
        first = j[0] if j else None
        keys = ", ".join(list(first)[:12]) if isinstance(first, dict) else type(first).__name__
        return f"list of {len(j)}; item keys: {keys}"
    return "keys: " + ", ".join(list(j)[:14])


def sum_scb_meta(r: Result) -> str:
    j = _json(r)
    if not isinstance(j, dict):
        return "not JSON"
    dims = j.get("dimension") or {}
    bits = [f"label={j.get('label', '')[:60]!r}", f"updated={j.get('updated')}"]
    for d, v in list(dims.items())[:8]:
        n = len(((v.get("category") or {}).get("index") or {}))
        bits.append(f"{d}[{n}]")
    return "; ".join(bits)


def sum_scb_data(r: Result) -> str:
    j = _json(r)
    if not isinstance(j, dict):
        return "not JSON"
    size = j.get("size")
    vals = j.get("value") or []
    nn = sum(1 for v in vals if v is not None)
    return f"size={size} values={len(vals)} non-null={nn} updated={j.get('updated')}"


def sum_xml_types(r: Result) -> str:
    t = r.body.decode("utf-8", "replace")
    names = re.findall(r"<(?:\w+:)?Name>([^<]{1,80})</(?:\w+:)?Name>", t)
    seen, uniq = set(), []
    for n in names:
        if n not in seen:
            seen.add(n)
            uniq.append(n)
    head = re.search(r"<\??(\w[\w:.-]*)", t)
    return f"root~{head.group(1) if head else '?'}; Name elements ({len(uniq)}): " + ", ".join(uniq[:14])


def sum_text(r: Result) -> str:
    t = r.body.decode("utf-8", "replace")
    t = re.sub(r"<script.*?</script>", " ", t, flags=re.S | re.I)
    t = re.sub(r"<[^>]+>", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t[:260]


def sum_wfs(r: Result) -> str:
    head = r.body[:1]
    if head == b"{":
        j = _json(r)
        f = ((j or {}).get("features") or [{}])[0]
        return (f"GeoJSON matched={(j or {}).get('numberMatched')} "
                f"props: {', '.join(list(f.get('properties') or {}))}")
    if head == b"<":
        t = r.body.decode("utf-8", "replace")
        m = re.search(r"<ows:ExceptionText>([^<]+)", t)
        return "exception: " + (m.group(1) if m else t[:160])
    t = r.body.decode("utf-8", "replace")
    first = t.split("\n", 1)[0]
    return f"CSV columns: {first[:200]}"


def sum_sol(r: Result) -> str:
    """Brå's SOL selection page carries its vocabularies as JS arrays."""
    t = r.body.decode("iso-8859-1", "replace")
    out = []
    for name, what in (("arrayNivaett", "offence types"), ("arrayNivatva", "leaf types"),
                       ("arrayRegionNivaEtt", "regions"), ("arrayPeriod", "periods")):
        n = len(re.findall(rf"{name}\[\d+\]\s*=", t))
        if n:
            out.append(f"{n} {what}")
    per = re.findall(r"arrayPeriod\[\d+\]\s*=\s*[\"\']([^\"\']+)", t)
    if per:
        out.append(f"newest {per[0].split(chr(42))[1]!r}, oldest {per[-1].split(chr(42))[1]!r}")
    return "; ".join(out) or ("stub — no session cookie? " + sum_text(r)[:120])


def sum_kommun_word(r: Result) -> str:
    t = r.body.decode("utf-8", "replace").lower()
    return (f"page has {t.count('kommun')} occurrence(s) of 'kommun' — "
            + ("a kommun cut may exist" if t.count("kommun") else "no kommun cut"))


def sum_arcgis_layers(r: Result) -> str:
    j = _json(r)
    if not isinstance(j, dict):
        return "not JSON"
    lay = j.get("layers") or []
    names = [str(x.get("name")) for x in lay[:6]]
    return (f"{len(lay)} layers; capabilities={j.get('capabilities')}; "
            f"first: {', '.join(names)}")


def sum_skyfall(r: Result) -> str:
    j = _json(r)
    f = (j or {}).get("features") or []
    st = {}
    for x in f:
        k = (x.get("properties") or {}).get("Status")
        st[k] = st.get(k, 0) + 1
    return f"{len(f)} kommuner; Status counts {st}"


def sum_binary(r: Result) -> str:
    sig = r.body[:4].hex()
    kind = {"504b0304": "zip/xlsx", "1f8b0800": "gzip", "255044462d": "pdf"}.get(sig, sig or "-")
    return f"content-type={r.ctype or '-'} magic={kind} bytes={r.bytes:,}"


def sum_links(pattern: str):
    def f(r: Result) -> str:
        t = r.body.decode("utf-8", "replace")
        hits = re.findall(pattern, t, flags=re.I)
        seen, uniq = set(), []
        for h in hits:
            h = h if isinstance(h, str) else h[0]
            if h not in seen:
                seen.add(h)
                uniq.append(h)
        return f"{len(uniq)} matching links: " + " | ".join(uniq[:8]) if uniq else "no matching links"
    return f


# ---------------------------------------------------------------- probe table

SCB = "https://api.scb.se/OV0104/v2beta/api/v2"


def scb_data_url(table: str, sel: dict) -> str:
    q = [("lang", "en"), ("outputFormat", "json-stat2")]
    for dim, vals in sel.items():
        q.append((f"valueCodes[{dim}]", ",".join(vals)))
    return f"{SCB}/tables/{table}/data?" + urllib.parse.urlencode(q, safe=",")


PROBES: list[dict] = [
    # ---------------------------------------------------------- Phase 2
    dict(group="Phase 2 — Population outlook", name="SCB TAB6008 metadata",
         urls=[f"{SCB}/tables/TAB6008/metadata?lang=en"], summary=sum_scb_meta,
         want="projection by kommun, sex, age, year"),
    dict(group="Phase 2 — Population outlook", name="SCB TAB698 metadata",
         urls=[f"{SCB}/tables/TAB698/metadata?lang=en"], summary=sum_scb_meta,
         want="national projection, single years"),
    dict(group="Phase 2 — Population outlook", name="SCB TAB6008 data 0180/1480/1280 x 2026/2031/2040",
         urls=["@TAB6008_DATA@"], summary=sum_scb_data,
         want="values for three kommuner and three horizons"),
    dict(group="Phase 2 — Population outlook", name="SCB TAB698 data 0180/1480/1280 x 2026/2031/2040",
         urls=["@TAB698_DATA@"], summary=sum_scb_data,
         want="the same three kommuner from the second table, to check the two agree"),

    # ---------------------------------------------------------- Phase 3
    dict(group="Phase 3 — Safety", name="Brå SOL session start",
         urls=["https://statistik.bra.se/solwebb/action/start?menykatalogid=1"],
         summary=sum_text, want="the Statistik om brott web app (needs the CA fix)"),
    dict(group="Phase 3 — Safety", name="Brå SOL kommun selection form (menyid=101)",
         urls=["https://statistik.bra.se/solwebb/action/anmalda/urval/urval?menyid=101"],
         summary=sum_sol, want="the offence, region and period vocabularies, as JS arrays"),
    dict(group="Phase 3 — Safety", name="Brå SOL kommun monthly/quarterly form (menyid=90)",
         urls=["https://statistik.bra.se/solwebb/action/anmalda/urval/urval?menyid=90"],
         summary=sum_sol, want="whether kommun-level quarters exist"),
    dict(group="Phase 3 — Safety", name="Brå clearance (personuppklarade) — is it per kommun?",
         urls=["https://bra.se/statistik/statistik-om-rattsvasendet/handlagda-brott"],
         summary=sum_kommun_word, want="clearance per kommun, or national only"),
    dict(group="Phase 3 — Safety", name="Brå open-data / statistikdatabas index",
         urls=["https://bra.se/statistik/kriminalstatistik/anmalda-brott.html",
               "https://bra.se/om-bra/oppna-data.html"],
         summary=sum_links(r'href="([^"]*(?:\.csv|\.xlsx|\.xls|oppna-data|api)[^"]*)"'),
         want="documented open-data / bulk download"),
    dict(group="Phase 3 — Safety", name="Kolada v3 KPI search: brott",
         urls=["https://api.kolada.se/v3/kpi?title=brott&per_page=100",
               "https://api.kolada.se/v2/kpi?title=brott"],
         summary=sum_json_keys, want="crime KPIs per kommun"),
    dict(group="Phase 3 — Safety", name="Kolada v3 KPI search: anmälda",
         urls=["https://api.kolada.se/v3/kpi?title=anm%C3%A4lda&per_page=100"],
         summary=sum_json_keys, want="reported-offence KPIs"),
    dict(group="Phase 3 — Safety", name="Kolada v3 KPI search: trygg",
         urls=["https://api.kolada.se/v3/kpi?title=trygg&per_page=100"],
         summary=sum_json_keys, want="perceived-safety KPIs"),
    dict(group="Phase 3 — Safety", name="Kolada v3 KPI search: uppklar",
         urls=["https://api.kolada.se/v3/kpi?title=uppklar&per_page=100"],
         summary=sum_json_keys, want="clearance-rate KPIs"),
    dict(group="Phase 3 — Safety", name="Polisen utsatta områden — geometry",
         urls=["https://polisen.se/33a4eb398c9ca7879ac47049931a252f/contentassets/"
               "1f86e17354294629b5b66559eef35972/uso_2025_geojson.zip"],
         summary=sum_binary, want="polygons, not just a PDF list"),
    dict(group="Phase 3 — Safety", name="Polisen utsatta områden page",
         urls=["https://polisen.se/om-polisen/polisens-arbete/utsatta-omraden/"],
         summary=sum_links(r'href="([^"]*(?:uso_2025|lagesbild)[^"]*)"'),
         want="the download links, to confirm the vintage"),

    # ---------------------------------------------------------- Phase 4
    dict(group="Phase 4 — Schools", name="Skolverket planned-educations v4 school-units",
         urls=["https://api.skolverket.se/planned-educations/v4/school-units?size=5",
               "https://api.skolverket.se/planned-educations/v3/school-units?size=5",
               "https://api.skolverket.se/planned-educations/v4/school-units"],
         summary=sum_json_keys, want="the school-unit list"),
    dict(group="Phase 4 — Schools", name="Skolverket statistics/gr for 99648792",
         urls=["https://api.skolverket.se/planned-educations/v4/school-units/99648792/statistics/gr",
               "https://api.skolverket.se/planned-educations/v3/school-units/99648792/statistics/gr"],
         summary=sum_json_keys, want="year-9 results; check school-year label shift"),
    dict(group="Phase 4 — Schools", name="Skolverket school-unit 99648792 detail",
         urls=["https://api.skolverket.se/planned-educations/v4/school-units/99648792"],
         summary=sum_json_keys, want="name, kommun, coordinates?"),
    dict(group="Phase 4 — Schools", name="Skolenhetsregistret v2 (coordinates)",
         urls=["https://api.skolverket.se/skolenhetsregistret/v1/skolenhet",
               "https://api.skolverket.se/skolenhetsregistret/v2/skolenhet"],
         summary=sum_json_keys,
         want="coordinates — though planned-educations v4 already carries wgs84_Lat/Long"),
    dict(group="Phase 4 — Schools", name="Skolverket SALSA export",
         urls=["https://siris.skolverket.se/siris/reports/export_api/xls/?pForm=salsa",
               "https://siris.skolverket.se/siris/f?p=SIRIS:164"],
         summary=sum_text,
         want="a bulk SALSA export — the APEX page is not one",
         fallback="the old SIRIS export module is gone (404) and SALSA now lives only "
                  "inside a stateful Oracle APEX app with checksummed POSTs. No bulk file "
                  "exists. Phase 4 ships the raw merit value from planned-educations v4 "
                  "and says plainly that it is NOT SALSA-adjusted."),
    dict(group="Phase 4 — Schools", name="Skolinspektionen Skolenkäten, per-school xlsx",
         urls=["https://www.skolinspektionen.se/globalassets/02-beslut-rapporter-stat/statistik/"
               "statistik-skolenkaten/2026/skolenkaten-elever-grundskola-ak-8-2026.xlsx"],
         method="HEAD", summary=sum_binary,
         want="per-school results with skolenhetskod and lägeskommun"),

    # ---------------------------------------------------------- Phase 6
    dict(group="Phase 6 — Climate", name="MCF flood WFS GetCapabilities",
         urls=["https://inspire.mcf.se/oversvamning/ows?service=WFS&version=2.0.0&request=GetCapabilities",
               "https://inspire.msb.se/oversvamning/ows?service=WFS&version=2.0.0&request=GetCapabilities"],
         summary=sum_xml_types, want="NZ_Oversvamning_100 / _200 / _BHF feature types"),
    dict(group="Phase 6 — Climate", name="MCF flood WFS GetFeature (which outputFormat delivers)",
         urls=["https://inspire.mcf.se/oversvamning/ows?service=WFS&version=2.0.0&request=GetFeature"
               "&typeNames=oversvamning:NZ_Oversvamning_100&count=1&outputFormat=text/csv",
               "https://inspire.mcf.se/oversvamning/ows?service=WFS&version=2.0.0&request=GetFeature"
               "&typeNames=oversvamning:NZ_Oversvamning_100&count=1&outputFormat=json"
               "&bbox=6580000,670000,6590000,680000,urn:ogc:def:crs:EPSG::3006",
               "https://inspire.mcf.se/oversvamning/ows?service=WFS&version=2.0.0&request=GetFeature"
               "&typeNames=oversvamning:NZ_Oversvamning_100&count=1&outputFormat=application/geo%2Bjson"],
         summary=sum_wfs, want="features and their attribute names"),
    dict(group="Phase 6 — Climate", name="MCF ArcGIS REST root (post-reorg host)",
         urls=["https://gis-tjanster.mcf.se/arcgis/rest/services?f=json"],
         summary=sum_json_keys, want="the service catalogue MSB's old host now redirects to"),
    dict(group="Phase 6 — Climate", name="MCF kustöversvämning levels",
         urls=["https://gis-tjanster.mcf.se/arcgis/rest/services/Oversvamningskarteringar/"
               "kustoversvamning/MapServer?f=json"],
         summary=sum_arcgis_layers, want="one layer per water level in RH2000"),
    dict(group="Phase 6 — Climate", name="SMHI framtida medelvattenstånd",
         urls=["https://opendata-download.smhi.se/framtida_medelvattenstand/baserat-pa-ipcc-ar6-srocc-2019/",
               "https://opendata-download.smhi.se/framtida_medelvattenstand/"],
         summary=sum_text, want="mean-sea-level 2100 rasters/polygons"),
    dict(group="Phase 6 — Climate", name="SGU landslide OGC API features",
         urls=["https://api.sgu.se/oppnadata/forutsattningar-skred-finkornig-jordart/ogc/features/v1?f=json",
               "https://api.sgu.se/oppnadata/forutsattningar-skred-finkornig-jordart/ogc/features/v1/collections?f=json"],
         summary=sum_json_keys, want="collections and the landslide caution zones"),
    dict(group="Phase 6 — Climate", name="MCF Skyfallskartering_Oversikt — per-kommun flag",
         urls=["https://gis-tjanster.mcf.se/arcgis/rest/services/Oversvamningskarteringar/"
               "Skyfallskartering_Oversikt/FeatureServer/0/query?where=1%3D1"
               "&outFields=KOM_KOD,KOMMUNNAMN,Status&returnGeometry=false&f=geojson"],
         summary=sum_skyfall, want="which kommuner have their own cloudburst mapping"),

    # ---------------------------------------------------------- Phase 7
    dict(group="Phase 7 — Overlays", name="Lantmäteriet STAC vektor collections",
         urls=["https://api.lantmateriet.se/stac-vektor/v1/collections"],
         summary=sum_json_keys, want="open vector collections (Byggnad needs Geotorget)"),
    dict(group="Phase 7 — Overlays", name="Lantmäteriet byggnader asset download (auth?)",
         urls=["https://dl1.lantmateriet.se/byggnadsverk/byggnad_kn2482.zip"],
         method="HEAD", summary=sum_binary,
         want="the per-kommun building GeoPackage the STAC item points at",
         fallback="401 — the STAC catalogue is public but the files behind it need "
                  "Lantmäteriet Geotorget Basic auth. Phases 6 and 7 use OSM footprints "
                  "and area shares instead; upgrade available when GEOTORGET_USER / "
                  "GEOTORGET_PASS exist in .env."),
    dict(group="Phase 7 — Overlays", name="Geofabrik sweden-latest.osm.pbf (HEAD)",
         urls=["https://download.geofabrik.de/europe/sweden-latest.osm.pbf"],
         method="HEAD", summary=sum_binary, want="size and date of the Sweden extract"),
    dict(group="Phase 7 — Overlays", name="Overpass API status",
         urls=["https://overpass-api.de/api/status"], summary=sum_text,
         want="per-kommun queries as the alternative to the pbf"),
    dict(group="Phase 7 — Overlays", name="Trafikverket Nationell plan 2026–2037 page",
         urls=["https://bransch.trafikverket.se/for-dig-i-branschen/Planera-och-utreda/"
               "langsiktig-planering-av-infrastruktur/nationell-plan/nationell-plan-2026-2037/"],
         summary=sum_links(r'href="([^"]*bilaga1[^"]*)"'),
         want="the adopted plan's page"),
    dict(group="Phase 7 — Overlays", name="Trafikverket bilaga 1 (named investments, xlsx)",
         urls=["https://bransch.trafikverket.se/contentassets/2fca968f05c545d59749ce9d442e117a/"
               "bilaga1_nationell_plan_for_transportinfrastrukturen_2026-2037-webb.xlsx"],
         method="HEAD", summary=sum_binary, want="the 266-row investment list"),
    dict(group="Phase 7 — Overlays", name="Trafiklab GTFS Sverige 2 (key needed)",
         urls=["https://opendata.samtrafiken.se/gtfs-sweden/sweden.zip"],
         method="HEAD", summary=sum_binary, want="stops; needs TRAFIKLAB_KEY",
         fallback="403 — GTFS Sverige 2 needs a Trafiklab account. Phase 7 uses OSM "
                  "public_transport stops instead; upgrade available when TRAFIKLAB_KEY "
                  "exists in .env."),
]


def resolve_placeholders() -> None:
    for p in PROBES:
        p["urls"] = [
            scb_data_url("TAB6008", {
                "Region": ["0180", "1480", "1280"],
                "Tid": ["2026", "2031", "2040"],
                "ContentsCode": ["000005RC"],
            }) if u == "@TAB6008_DATA@" else
            scb_data_url("TAB698", {
                "Region": ["0180", "1480", "1280"],
                "Tid": ["2026", "2031", "2040"],
                "ContentsCode": ["000004LG"],
            }) if u == "@TAB698_DATA@" else u
            for u in p["urls"]
        ]


# ---------------------------------------------------------------- run

def run(only: str | None, timeout: int) -> list[dict]:
    resolve_placeholders()
    rows = []
    for p in PROBES:
        if only and only.lower() not in (p["name"] + p["group"]).lower():
            continue
        attempts = []
        for u in p["urls"]:
            r = call(u, p.get("method", "GET"), timeout=timeout)
            try:
                note = p["summary"](r) if r.body or r.ok_http else (r.error or "empty body")
            except Exception as e:                           # noqa: BLE001
                note = f"summary failed: {type(e).__name__}: {e}"
            r.note = note
            attempts.append(r)
            print(f"  {r.status or 'ERR':>4}  {r.secs:5.2f}s  {r.bytes:>10,}  {u[:100]}", flush=True)
            if r.ok_http:
                break
        p["attempts"] = attempts
        rows.append(p)
    return rows


def write(rows: list[dict], started: str) -> None:
    L = []
    L.append("# Parity endpoint probe\n")
    L.append(f"Run {started}. Generated by `scripts/probe_parity.py` — re-run with "
             "`python3 scripts/probe_parity.py`.\n")
    L.append("Every candidate URL for every capability the v1.2 parity build needs, in "
             "preference order. `bytes` is Content-Length where the server sent one, the "
             "read size otherwise; bodies are read to at most 400 kB.\n")
    ok = sum(1 for p in rows if any(a.ok_http for a in p["attempts"]))
    L.append(f"**{ok} of {len(rows)} capabilities have a working route.**\n")
    L.append("The other half of the phase-0 probe — which Danish v2.0–v2.5.1 UI pieces are "
             "already here and which are missing — is in "
             "[`PARITY_UI_INVENTORY.md`](PARITY_UI_INVENTORY.md), which this script does "
             "not overwrite.\n")

    group = None
    for p in rows:
        if p["group"] != group:
            group = p["group"]
            L.append(f"\n## {group}\n")
        L.append(f"\n### {p['name']}\n")
        L.append(f"_Wanted: {p['want']}._\n")
        L.append("\n| candidate | HTTP | s | bytes | result |")
        L.append("|---|---:|---:|---:|---|")
        for a in p["attempts"]:
            u = a.url if len(a.url) < 110 else a.url[:107] + "…"
            note = (a.note or a.error or "").replace("|", "\\|").replace("\n", " ")
            if len(note) > 300:
                note = note[:297] + "…"
            status = str(a.status) if a.status else "ERR"
            L.append(f"| `{u}` | {status} | {a.secs:.2f} | {a.bytes:,} | {note} |")
        L.append("")
        winner = next((a for a in p["attempts"] if a.ok_http), None)
        if winner and p.get("fallback"):
            # answered, but not with the thing we needed
            L.append(f"**Route:** `{winner.url}` — but see below.\n")
            L.append(f"**Not usable as-is:** {p['fallback']}\n")
        elif winner:
            L.append(f"**Route:** `{winner.url}`\n")
        elif p.get("fallback"):
            L.append(f"**Route:** none answered. **Fallback:** {p['fallback']}\n")
        else:
            L.append("**Route:** none of the candidates answered — needs research.\n")

    OUT.write_text("\n".join(L) + "\n", encoding="utf-8")
    print(f"\nwrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size:,} bytes), "
          f"{ok}/{len(rows)} capabilities routed")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    ap.add_argument("--timeout", type=int, default=TIMEOUT)
    a = ap.parse_args()
    started = dt.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M %Z")
    rows = run(a.only, a.timeout)
    if not a.only:
        write(rows, started)
    return 0


if __name__ == "__main__":
    sys.exit(main())
