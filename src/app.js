/* AM Dashboard — Sweden Edition · app.js
   Ported from the Danish edition (v1.9); all data comes from window.DATA
   (built by scripts/build_dashboard.py from data/processed/*.json).

   Three geographic levels, renamed from the Danish vocabulary:
     kommun  290    · RegSO 3 363 (named)  · DeSO 6 160 (codes only)
   Kommun and RegSO ship inline. DeSO would double the page, so it ships as one
   file per kommun (dist/deso/<kommun>.json) and is fetched the first time that
   kommun is opened — the mechanism the Danish edition used for its building
   layer, which has no Swedish counterpart and is gone.

   DATA schema (see scripts/build_makro.py):
     meta         { built, sources:[{key,label,url,asof}], attribution:[], note,
                    years, latest_year, levels, dist:{age,income,tenure} }
     indicators   [ {key,label,short,unit,level,levels:[…],hue:[r,g,b],fmt,desc,
                     source,warn,note,moe,moe_rel,group,asof,hist_asof} ]
     kommuner     [ {code,name,lan,pop,rings,<keys>,<key>_moe,hist,dist} ]
     regso        [ {code,name,kommun,lan,pop,rings,<keys>,hist,dist} ]
     deso_index   { kommun: {n,file} }        → dist/deso/<kommun>.json
     macro        { series:{key:[{t,v}]}, breakdown, latest, hero, table, missing }

   A value the source suppressed is absent and renders as – ; it is never 0.
   Indicators whose source publishes a margin of error carry <key>_moe beside
   the value, and the UI renders the ±.

   Navigation is hash-based so every screen has a permalink:
     #map              national map        #map/0180       kommun drilled (RegSO)
     #map/0180/deso    same kommun as DeSO
     #table/kommun     table view (kommun | regso | deso)
     #area/kommun/0180 · #area/regso/<code> · #area/deso/<code>
     #charts · #market · #sources
   Query part: ?ind=<indicator>&y=<year>&g=<tile group>
*/
"use strict";
const D = window.DATA || {};
const IND = D.indicators || [];
const MUNI = D.kommuner || [];
const AREAS = D.regso || [];
const LOCALE = "sv-SE";

/* ---------- helpers ---------- */
const nf = (n, d = 1) => (n == null || isNaN(n)) ? "–" : Number(n).toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });
const sign = (n, f) => n == null || isNaN(n) ? "–" : (n > 0 ? "+" : "") + f(n);
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const FMT = {
  pct0: v => nf(v, 0) + " %", pct1: v => nf(v, 1) + " %", pct2: v => nf(v, 2) + " %",
  signpct1: v => sign(v, x => nf(x, 1) + " %"),
  ksek: v => nf(v, 0) + " kSEK", sek0: v => nf(v, 0) + " SEK",
  int: v => nf(v, 0), m2: v => nf(v, 0) + " m²", per1000: v => nf(v, 1) + " ‰",
  idx: v => nf(v, 1), idx1: v => nf(v, 1), ratio2: v => nf(v, 2), per10k: v => nf(v, 1) + " / 10k",
  /* rates per 1 000: the ‰ sign is not borrowed here because these are counts
     per 1 000 of a stock, not parts per thousand of the same quantity */
  num1: v => nf(v, 1), num2: v => nf(v, 2),
  /* `cat` is replaced per indicator by fmtOf, which knows its labels */
  cat: v => nf(v, 0)
};
const fmtOf = i => {
  const cats = catsOf(i);
  if (cats) return v => { const c = catOf(i, v); return c ? c.label : "–"; };
  return FMT[i.fmt] || FMT.int;
};
const isPct = i => (i.fmt || "").startsWith("pct") || i.fmt === "signpct1";
/* ---------- direction ----------
   Every indicator declares `direction` in config/indicators.json:
   higher_better | lower_better | neutral. It decides three things and nothing
   else: which end a rank counts from, whether a delta is drawn green or red,
   and whether the legend says so. `neutral` is the default for a descriptor —
   a share of flerbostadshus has no better end, and colouring one green would be
   editorialising. An indicator with no `direction` is treated as neutral rather
   than silently assumed to be higher-is-better; scripts/validate_indicators.py
   requires the field, so this is a belt-and-braces fallback, not a policy. */
const indOf = k => IND.find(i => i.key === k) || null;
/* An Outlook indicator is one published statement about a future year, not an
   observation, so it has no year to select and no observed history. `fc` on a
   kommun record holds the projected levels per year, kept beside `hist` and
   never inside it — putting 2027-2040 into the year selector would offer every
   other indicator years for which no observation exists. */
const outlookOf = i => (typeof i === "string" ? indOf(i) : i) && ((typeof i === "string" ? indOf(i) : i).outlook || null);
const isOutlook = i => !!outlookOf(i);
const fcSeries = (o, key) => (o && o.fc && o.fc[key]) || null;
const dirOf = i => { const d = (typeof i === "string" ? indOf(i) : i); return (d && d.direction) || "neutral"; };
const lowerBetter = i => dirOf(i) === "lower_better";
const neutralDir = i => dirOf(i) === "neutral";
const median = arr => { const v = arr.filter(x => x != null && !isNaN(x)).sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const byCode = {}; MUNI.forEach(m => byCode[m.code] = m);
const byRegso = {}; AREAS.forEach(a => byRegso[a.code] = a);

/* DeSO (6 160 areas) is too much to inline, so it ships as one file per kommun
   (dist/deso/<kommun>.json) and is fetched the first time that kommun is opened.
   D.deso_index = {kommun: {n, file}}. Until a kommun's file has arrived its DeSO
   layer simply is not offered — nothing else in the page depends on it. */
const DESO_IDX = D.deso_index || {};
const DESO = {};                                   /* kommun code -> [area, …] once loaded */
const byDeso = {};                                 /* flat code -> area, filled as files arrive */
const desoAvail = code => !!(code && DESO_IDX[code]);
const desoLoaded = code => !!(code && DESO[code]);
const desoAreas = code => DESO[code] || [];
/* DeSO carries the same indicators as everything else — unlike the Danish
   Copenhagen layer, which had a set of its own. */
const IND_DESO = IND;

const S = { view: "makro" };
const YEARS = ((D.meta && D.meta.years) || []).slice().sort();
const LATEST = (D.meta && D.meta.latest_year) || (YEARS[YEARS.length - 1] || "");
/* sub = which layer a drilled kommun shows: its RegSO (default) or its DeSO */
const MK = { ind: (IND[0] || {}).key, kommun: null, own: false, year: LATEST, sub: "regso" };
const desoMode = () => !!(MK.kommun && MK.sub === "deso" && desoLoaded(MK.kommun));

const AR = { type: null, code: null, group: "", ind: null, sub: "regso", tab: "ind" };   /* area page: group = tile group, tab = lower panel */
const UI = { indxOpen: false };                                                    /* fold states that survive a re-render */
const MKT = { src: false };                                                        /* market: sources panel open */
const CH = { ind: (IND[0] || {}).key, areas: [], y0: "", y1: "", median: true, title: "", mode: "auto", dist: "age", fq: "year" };   /* chart generator; fq = yearly | quarterly */
const T = { q: "", level: "kommun", lan: "", minPop: 0 };                           /* table view filters */
const LAN = { "01": "Stockholm", "03": "Uppsala", "04": "Södermanland", "05": "Östergötland", "06": "Jönköping",
  "07": "Kronoberg", "08": "Kalmar", "09": "Gotland", "10": "Blekinge", "12": "Skåne", "13": "Halland",
  "14": "Västra Götaland", "17": "Värmland", "18": "Örebro", "19": "Västmanland", "20": "Dalarna",
  "21": "Gävleborg", "22": "Västernorrland", "23": "Jämtland", "24": "Västerbotten", "25": "Norrbotten" };
const lanName = c => LAN[c] || "";
const REGIONS = Object.keys(LAN).map(k => LAN[k]);
/* Sweden is tall and narrow — a lower zoom than Denmark's, centred on Dalarna */
const LF = { map: null, center: [62.5, 16.5], zoom: 5 };
/* every indicator is defined the same way at every level, so an area may always
   be compared with its kommun */
const muniCmp = (e, key) => !!e.kommun;
/* headline figures (area page header, map popups, kommun strip) — the first five available, in this order */
const HL_KEYS = ["growth", "income_med", "rent", "unemp", "renters", "higher_ed", "young", "kt_tal", "flats"];
/* quick-pick indicator chips next to the indicator select */
const QUICK_KEYS = ["growth", "income_med", "rent", "unemp", "renters", "kt_tal", "crime_1000"];
/* link into the chart generator with one area pre-selected */
const chartLink = (key, type, code) => `charts?ind=${encodeURIComponent(key)}&a=${type}:${code}&y0=&y1=&med=1`;
/* value of indicator k for kommun/area o in the selected year (latest = live field, else history) */
const V = (o, k, y) => { const yr = y || MK.year; if (!o) return null; if (!yr || yr === LATEST) return o[k] ?? null; const h = o.hist && o.hist[k]; return h && h[yr] != null ? h[yr] : null; };
/* the published margin of error that travels with a value, when the source has one */
const MOE = (o, k, y) => { const yr = y || MK.year; if (!o) return null; if (!yr || yr === LATEST) return o[k + "_moe"] ?? null; const h = o.hist && o.hist[k + "_moe"]; return h && h[yr] != null ? h[yr] : null; };
const yearsForPool = (k, pool) => YEARS.filter(y => y === LATEST || pool.some(m => m.hist && m.hist[k] && m.hist[k][y] != null));
/* years with actual history for charts and sparklines — the lagging "latest" value is not repeated as a later year */
const histYears = (k, pool) => YEARS.filter(y => pool.some(m => m.hist && m.hist[k] && m.hist[k][y] != null));
function curPool() { if (S.view === "area") { const e = areaEntity(); return e ? e.peers : MUNI; } if (S.view === "table") return T.level === "deso" ? allDeso() : T.level === "regso" ? AREAS : MUNI; return desoMode() ? desoAreas(MK.kommun) : MUNI; }
const allDeso = () => { const out = []; for (const k in DESO) out.push(...DESO[k]); return out; };
const yearsFor = k => yearsForPool(k, curPool());
const curInds = () => { if (S.view === "area") { const e = areaEntity(); return e ? e.inds : IND; } return IND; };
const curInd = () => { const L = curInds(); return L.find(i => i.key === MK.ind) || L[0] || { key: "", label: "", fmt: "pct1" }; };

/* ---------- routing (hash) ---------- */
function hashFor() {
  const q = [`ind=${encodeURIComponent(MK.ind || "")}`]; if (MK.year && MK.year !== LATEST) q.push(`y=${MK.year}`);
  let p;
  if (S.view === "area") { p = `area/${AR.type}/${AR.code}`; if (AR.group) q.push(`g=${encodeURIComponent(AR.group)}`); if (AR.sub !== "regso") q.push(`sub=${AR.sub}`); if (AR.tab !== "ind") q.push(`t=${AR.tab}`); }
  else if (S.view === "table") p = `table/${T.level}`;
  else if (S.view === "charts") { p = "charts"; q.length = 0; q.push(`ind=${encodeURIComponent(CH.ind)}`, `a=${CH.areas.join(",")}`, `y0=${CH.y0}`, `y1=${CH.y1}`, `med=${CH.median ? 1 : 0}`); if (CH.mode !== "auto") q.push(`mode=${CH.mode}`); if (CH.mode === "dist") q.push(`dist=${CH.dist}`); if (CH.fq !== "year") q.push(`fq=${CH.fq}`); }
  else if (S.view === "pipeline") { p = "pipeline"; q.length = 0;
    if (PIPE.type) q.push(`t=${PIPE.type}`); if (PIPE.status) q.push(`s=${PIPE.status}`); }
  else if (S.view === "analysis") { p = "analysis"; q.length = 0;
    if (AN.a) q.push(`a=${AN.a.lat},${AN.a.lon}`);
    if (AN.la) q.push(`la=${encodeURIComponent(AN.la)}`);
    if (AN.b) q.push(`b=${AN.b.lat},${AN.b.lon}`);
    if (AN.lb) q.push(`lb=${encodeURIComponent(AN.lb)}`); }
  else if (S.view === "sheet") { p = sheetHash(SH.kind, ...SH.parts); }
  else if (S.view === "market") { p = "market"; if (MKT.src) q.push("src=1"); }
  else if (S.view === "makro") { p = "map" + (MK.kommun ? "/" + MK.kommun + (MK.sub === "deso" ? "/deso" : "") : "");
    for (const o of ovList()) if (ovOn(o)) q.push(`${o.id}=1`); }
  else p = S.view;
  return p + "?" + q.join("&");
}
function parseHash() {
  const h = (location.hash || "#map").slice(1);
  const [path, qs] = h.split("?"); const parts = path.split("/").filter(Boolean);
  const q = {}; (qs || "").split("&").filter(Boolean).forEach(kv => { const [k, v] = kv.split("="); q[decodeURIComponent(k)] = decodeURIComponent(v || ""); });
  const prevView = S.view;
  if (q.ind) MK.ind = q.ind;
  MK.year = q.y && YEARS.includes(q.y) ? q.y : LATEST;
  const v = parts[0] || "map";
  if (v === "area" && parts[1] && parts[2]) { S.view = "area"; AR.type = parts[1]; AR.code = parts[2]; AR.group = q.g === "key" ? "" : (q.g || ""); AR.sub = q.sub || "regso"; AR.tab = ["ind", "dist", "sub"].includes(q.t) ? q.t : "ind"; }
  else if (v === "table") { S.view = "table"; if (["kommun", "regso", "deso"].includes(parts[1])) T.level = parts[1]; }
  else if (v === "sources") { S.view = "market"; MKT.src = true; }
  else if (v === "market") { S.view = "market"; MKT.src = q.src === "1"; }
  else if (v === "pipeline") { S.view = "pipeline";
    PIPE.type = q.t || ""; PIPE.status = q.s || ""; }
  else if (v === "analysis") { S.view = "analysis";
    const one = (q.a || "").split(",").map(Number);
    AN.a = one.length === 2 && !isNaN(one[0]) ? { lat: one[0], lon: one[1] } : null;
    const two = (q.b || "").split(",").map(Number);
    AN.b = two.length === 2 && !isNaN(two[0]) ? { lat: two[0], lon: two[1] } : null;
    AN.la = q.la || ""; AN.lb = q.lb || "";
    if (AN.a) anResolve("a"); if (AN.b) anResolve("b"); }
  else if (SHEETS[v] && parts.length > 1) { S.view = "sheet"; SH.kind = v; SH.parts = parts.slice(1); }
  else if (v === "charts") { S.view = "charts"; CH.ind = q.ind || CH.ind; CH.areas = q.a ? q.a.split(",").filter(Boolean) : CH.areas; CH.y0 = q.y0 || CH.y0; CH.y1 = q.y1 || CH.y1; CH.median = q.med !== "0"; CH.mode = q.mode || "auto"; CH.dist = q.dist || "size"; CH.fq = q.fq === "q" ? "q" : "year"; }
  else { S.view = "makro";
         for (const o of OV) MK[o.flag] = q[o.id] === "1";
         MK.kommun = parts[1] && byCode[parts[1]] ? parts[1] : null;
         MK.sub = parts[2] === "deso" ? "deso" : "regso";
         if (MK.sub === "deso") loadDeso(MK.kommun); }
  if (!curInds().some(i => i.key === MK.ind)) MK.ind = (curInds()[0] || {}).key;
  if (!yearsFor(MK.ind).includes(MK.year)) MK.year = LATEST;
  if (S.view === "makro") {
    /* zoom to a municipality the first time it is shown; back to the national frame when it is cleared */
    if (MK.kommun && MK.kommun !== LF.shownMuni) LF.pendingFit = MK.kommun;
    if (!MK.kommun && LF.shownMuni) { LF.center = [62.5, 16.5]; LF.zoom = 5; }
    LF.shownMuni = MK.kommun;
  }
  return { viewChanged: prevView !== S.view };
}
function go(hash) { if ("#" + hash === location.hash) { parseHash(); render(); } else location.hash = hash; }
function syncHash() { history.replaceState(null, "", "#" + hashFor()); }
/* A handle on the live page: the Leaflet instance is a lexical const, so without
   this neither the console nor a screenshot script can set a precise view. */
window.AM = { get map() { return LF.map; }, get area() { return LF.amap; }, go, D, MK, S, LF };
window.addEventListener("hashchange", () => { const r = parseHash(); render(); if (r.viewChanged) { const m = document.getElementById("main"); if (m) m.scrollTop = 0; } });

/* ---------- views & navigation ---------- */
const VIEWS = [
  ["makro",   "Macro map",     "Demographics, income, housing and prices by kommun, RegSO and DeSO", "map"],
  ["table",   "Table",         "Every kommun, RegSO and DeSO side by side — filter, sort, export", "table"],
  ["charts",  "Charts",        "Pick an indicator, areas and years — export the chart as PNG or the data as CSV", "charts"],
  ["market",  "Market",        "Prices, rents, supply, construction, macro indicators — and the data sources", "market"],
  ["pipeline","Pipeline",     "Every major transport project, its status, opening year and budget", "pipeline"],
  ["analysis","Test property",  "Drop a pin from a Google Maps link and see everything this dashboard knows about that spot", "analysis"],
  ["listings","Listings",       "What is advertised for rent near a point, live from the listings gateway — third-party data, kept apart from the dashboard's own statistics", "listings"]];
const NAV_GROUPS = [["Market intelligence", ["makro", "table", "charts", "market", "pipeline"]],
                    ["Analysis", ["analysis", "listings"]]];
/* Listings is its own page (dist/listings.html), not a view of this one: it has
   its own map, its own state and its own stylesheet, and it reads live
   third-party data through a gateway rather than anything in window.DATA. The
   nav entry is therefore a link, and the pin travels in the hash the page
   already understands. Keeping the two pages apart is also the honest
   arrangement — an advertised rent is not a contract rent, and the dashboard's
   own rent statistics must never be drawn as one series with it. */
const LISTINGS_HREF = "listings.html";
const listingsUrl = (lat, lon, r) => LISTINGS_HREF +
  (lat != null ? `#at=${(+lat).toFixed(6)},${(+lon).toFixed(6)}&r=${r || 1000}` : "");
const viewOf = id => VIEWS.find(v => v[0] === id) || VIEWS[0];

function renderNav() {
  const on = S.view === "area" ? "makro" : S.view;
  document.getElementById("nav").innerHTML = NAV_GROUPS.map(([lab, ids]) => `<div class="nav-glab">${lab}</div>` +
    ids.map(id => { const v = viewOf(id);
      if (id === "listings") {
        /* a real link to a real page — the pin comes along when there is one */
        const pin = AN.a;
        return `<a class="nav-item" href="${esc(listingsUrl(pin && pin.lat, pin && pin.lon, 1000))}" title="${esc(v[2])}"><b>${v[1]}</b><span class="navext">↗</span></a>`;
      }
      return `<button class="nav-item ${on === id ? "on" : ""}" data-go="${v[3]}" title="${esc(v[2])}"><b>${v[1]}</b></button>`; }).join("")).join("");
}
/* the top bar is a breadcrumb: Sweden › municipality › area — every step is a link, the last one is where you are */
function crumbs() {
  const q = `?ind=${encodeURIComponent(MK.ind)}` + (MK.year !== LATEST ? `&y=${MK.year}` : "");
  const c = [["Sweden", "map" + q]]; let tail = "", kind = "";
  if (S.view === "area") { const e = areaEntity(); if (!e) return { c, tail: "Area", kind: "" };
    if (e.kommun) c.push([e.kommun.name, `area/kommun/${e.kommun.code}` + q]); tail = e.name; kind = e.typeLabel; }
  else if (S.view === "makro") { const m = MK.kommun ? byCode[MK.kommun] : null;
    if (m) { tail = m.name; kind = desoMode() ? "DeSO areas" : "RegSO areas"; }
    else { tail = "Map"; kind = "kommuner and RegSO"; } }
  else if (S.view === "pipeline") { tail = "Pipeline"; kind = `${(INFRA.projects || []).length} projects`; }
  else if (S.view === "analysis") { tail = "Test property";
    kind = AN.b ? "two pins compared" : AN.a ? (anName("a") || "a pin") : "drop a pin"; }
  else if (S.view === "sheet") { const def = SHEETS[SH.kind];
    tail = (def && def.crumb && def.crumb(SH.parts)) || SH.parts.join(" / "); kind = (def && def.label) || ""; }
  else { tail = viewOf(S.view)[1]; kind = { table: "every area side by side", charts: "PNG and CSV export", market: "national series and sources" }[S.view] || ""; }
  return { c, tail, kind };
}
function renderTop() {
  const { c, tail, kind } = crumbs();
  document.getElementById("hd").innerHTML = `<nav class="crumbs">${c.map(([l, h]) => `<button data-go="${esc(h)}">${esc(l)}</button><i>›</i>`).join("")}<b>${esc(tail)}</b>${kind ? `<span class="dim">${esc(kind)}</span>` : ""}</nav>`;
}
const RENDER = { makro: vMakro, table: vTable, area: vArea, charts: vCharts, market: vMarket, sheet: vSheet, analysis: vAnalysis, pipeline: vPipeline };
function render() {
  renderNav(); renderTop();
  const body = document.getElementById("body");
  body.innerHTML = (RENDER[S.view] || vMakro)();
  enableSort(body);
}
function renderKeep() { const m = document.getElementById("main"), y = m.scrollTop; render(); m.scrollTop = y; }

document.addEventListener("click", e => {
  const g = sel => e.target.closest(sel);
  let el;
  if ((el = g("[data-go]"))) { go(el.dataset.go); return; }
  if ((el = g("[data-tlevel]"))) { T.level = el.dataset.tlevel; if (!curInds().some(i => i.key === MK.ind)) MK.ind = curInds()[0].key; syncHash(); renderKeep(); return; }
  if (g("[data-csv]")) { exportCsv(); return; }
  if (g("[data-xall]")) { exportAll(); return; }
  if (g("[data-mkown]")) { MK.own = !MK.own; renderKeep(); return; }
  if (g("[data-fs]")) { toggleFullscreen(); return; }
  if (g("[data-back]")) { history.back(); return; }
  if ((el = g("[data-anclear]"))) { const k = el.dataset.anclear;
    AN[k] = null; delete AN.res[k]; if (k === "a") AN.la = ""; else AN.lb = "";
    syncHash(); renderKeep(); return; }
  if ((el = g("[data-ov]"))) { const o = OV.find(x => x.id === el.dataset.ov);
    if (o) { MK[o.flag] = !MK[o.flag]; LF[o.id + "Drawn"] = false; syncHash(); renderKeep(); } return; }
  /* a jump moves the camera and returns — no selection change, so no re-render */
  if ((el = g("[data-pipetype]"))) { PIPE.type = el.dataset.pipetype; syncHash(); renderKeep(); return; }
  if ((el = g("[data-pipestatus]"))) { PIPE.status = el.dataset.pipestatus; syncHash(); renderKeep(); return; }
  if (g("[data-csv-pipe]")) { exportPipelineCsv(); return; }
  if ((el = g("[data-srvcat]"))) { const [w, c] = el.dataset.srvcat.split(":");
    const set = w === "srv" ? SF.srv : SF.pub;
    if (set.has(c)) set.delete(c); else set.add(c);
    LF[w + "Drawn"] = false; lfOverlays(); ovLegends(); return; }
  if ((el = g("[data-climlayer]"))) { CL.layer = el.dataset.climlayer;
    LF.climDrawn = false; lfOverlays(); ovLegends(); return; }
  if ((el = g("[data-mapjump]"))) { mapJump(el.dataset.mapjump); return; }
  if ((el = g("[data-chmode]"))) { CH.mode = el.dataset.chmode; syncHash(); renderKeep(); return; }
  if ((el = g("[data-chfq]"))) { CH.fq = el.dataset.chfq; syncHash(); renderKeep(); return; }
  if ((el = g("[data-chadd]"))) { chartAddMany(el.dataset.chadd.split("|")); return; }
  if ((el = g("[data-chrm]"))) { CH.areas = CH.areas.filter(a => a !== el.dataset.chrm); syncHash(); renderKeep(); return; }
  if (g("[data-chpng]")) { chartPng(); return; }
  if (g("[data-chcsv]")) { chartCsv(); return; }
  if (g("[data-chclear]")) { CH.areas = []; syncHash(); renderKeep(); return; }
  if ((el = g("[data-sub]"))) { MK.sub = el.dataset.sub; if (MK.sub === "deso") loadDeso(MK.kommun); syncHash(); renderKeep(); return; }
  if ((el = g("[data-argroup]"))) { AR.group = el.dataset.argroup; syncHash(); renderKeep(); return; }
  if ((el = g("[data-artab]"))) { AR.tab = el.dataset.artab; syncHash(); renderKeep(); return; }
  if ((el = g("[data-arsub]"))) { AR.sub = el.dataset.arsub; syncHash(); renderKeep(); return; }
  if ((el = g("[data-indq]"))) { MK.ind = el.dataset.indq; if (!yearsFor(MK.ind).includes(MK.year)) MK.year = LATEST; syncHash(); renderKeep(); return; }
  if (g("[data-mftoggle]")) { UI.mfOpen = !UI.mfOpen; const p = document.getElementById("mfpanel"), b = g("[data-mftoggle]"); if (p) p.style.display = UI.mfOpen ? "" : "none"; if (b) b.classList.toggle("on", UI.mfOpen); return; }
  if ((el = g("[data-arind]"))) { MK.ind = el.dataset.arind; if (!yearsFor(MK.ind).includes(MK.year)) MK.year = LATEST; syncHash(); renderKeep(); return; }
  if ((el = g(".im"))) { tipToggle(el); return; }
  tipHide();
});
document.addEventListener("change", e => {
  const el = e.target;
  if (el.id === "indsel") { MK.ind = el.value; if (!yearsFor(MK.ind).includes(MK.year)) MK.year = LATEST; syncHash(); renderKeep(); }
  if (el.id === "yearsel") { MK.year = el.value; syncHash(); renderKeep(); }
  if (el.id === "areaq") areaSearchGo(el.value);
  if (el.id === "mindsel") { MK.mind = el.value; syncHash(); renderKeep(); }
  if (el.id === "chind") { CH.ind = el.value; syncHash(); renderKeep(); }
  if (el.id === "chy0") { CH.y0 = el.value; syncHash(); renderKeep(); }
  if (el.id === "chy1") { CH.y1 = el.value; syncHash(); renderKeep(); }
  if (el.id === "chmed") { CH.median = el.checked; syncHash(); renderKeep(); }
  if (el.id === "chdist") { CH.dist = el.value; syncHash(); renderKeep(); }
  if (el.id === "chq") { chartAdd(null, el.value); }
  if (el.id === "chtitle") { CH.title = el.value; const t = document.getElementById("chsvgtitle"); if (t) t.textContent = CH.title || chartAutoTitle(); }
  if (el.id === "anin-a" || el.id === "anin-b") { anSet(el.id.slice(-1), el.value); }
  if (el.id === "anlab-a") { AN.la = el.value.trim(); syncHash(); }
  if (el.id === "anlab-b") { AN.lb = el.value.trim(); syncHash(); }
  if (el.id === "tregion") { T.lan = el.value; renderTableBody(); }
  if (el.id === "tminpop") { T.minPop = Number(el.value) || 0; renderTableBody(); }
});
document.addEventListener("input", e => { if (e.target.id === "tq") { T.q = e.target.value.trim().toLowerCase(); renderTableBody(); } });
document.addEventListener("toggle", e => { if (e.target.classList && e.target.classList.contains("indx")) UI.indxOpen = e.target.open; }, true);
document.addEventListener("keydown", e => {
  if (e.key === "Enter" && e.target.id === "areaq") { areaSearchGo(e.target.value); return; }
  if (e.key === "Enter" && e.target.id === "chq") { chartAdd(null, e.target.value); return; }
  if (e.key === "Enter" && /^anin-[ab]$/.test(e.target.id)) { anSet(e.target.id.slice(-1), e.target.value); return; }
  if (e.key === "Escape" && S.view === "area") history.back();
  /* Quick jumps. Only on the map view, never with a modifier (Cmd-S must stay
     Save), and never while the reader is typing — the area search box is one
     keystroke away from these keys. */
  if (S.view !== "makro" || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
  const j = MAP_JUMPS.find(x => x.key.toLowerCase() === (e.key || "").toLowerCase());
  if (j) { mapJump(j.id); }
});

/* ---------- info tooltips (ⓘ) ---------- */
let TIPEL = null, TIPFOR = null;
function tipToggle(el) { if (TIPFOR === el) { tipHide(); return; } tipShow(el); }
function tipShow(el) {
  const i = IND.concat(IND_DESO).find(x => x.key === el.dataset.m); if (!i) return;
  if (!TIPEL) { TIPEL = document.createElement("div"); TIPEL.className = "imtip"; document.body.appendChild(TIPEL); }
  TIPEL.innerHTML = `<b>${esc(i.label)}</b><p><em>Definition</em>${esc(i.desc || "")}</p>` + (i.source ? `<p><em>Source</em>${esc(i.source)}</p>` : "") + (i.warn ? `<p class="warn"><em>Caveat</em>${esc(i.warn)}</p>` : "");
  TIPEL.style.visibility = "hidden"; TIPEL.style.display = "block";
  const r = el.getBoundingClientRect(), t = TIPEL.getBoundingClientRect();
  let x = Math.max(8, Math.min(r.left + r.width / 2 - t.width / 2, window.innerWidth - t.width - 8));
  let y = r.bottom + 8; if (y + t.height > window.innerHeight - 8) y = Math.max(8, r.top - t.height - 8);
  TIPEL.style.left = x + "px"; TIPEL.style.top = y + "px"; TIPEL.style.visibility = "visible"; TIPFOR = el;
}
function tipHide() { if (TIPEL) TIPEL.style.display = "none"; TIPFOR = null; }

/* ---------- sortable tables ---------- */
function enableSort(root) {
  root.querySelectorAll("table[data-sortable]").forEach(tbl => {
    tbl.querySelectorAll("thead th").forEach((th, idx) => {
      th.classList.add("sth"); th.style.cursor = "pointer";
      th.addEventListener("click", () => {
        const tb = tbl.tBodies[0], rows = Array.from(tb.rows);
        const dir = th.dataset.dir === "asc" ? -1 : 1; th.dataset.dir = dir === 1 ? "asc" : "desc";
        const val = r => { const c = r.cells[idx]; if (!c) return null; const v = parseFloat((c.dataset.v ?? c.textContent).replace(/\s/g, "").replace(",", ".")); return isNaN(v) ? null : v; };
        rows.sort((a, b) => { const x = val(a), y = val(b); if (x == null && y == null) return (a.cells[idx] ? a.cells[idx].textContent : "").localeCompare(b.cells[idx] ? b.cells[idx].textContent : ""); if (x == null) return 1; if (y == null) return -1; return (x - y) * dir; });
        rows.forEach(r => tb.appendChild(r));
      });
    });
  });
}

/* ---------- choropleth colour model (identical to the Finnish edition) ---------- */
/* Categorical indicators (Boverket's shortage / balance / surplus) are not a
   ramp: each answer has its own colour, fixed by the registry. Values travel as
   numbers so ranking, sorting, charts and the CSV keep working, and `cats` maps
   them back to a label and a colour. */
const catsOf = i => (i && i.cats) || null;
const catOf = (i, v) => { const c = catsOf(i); return c ? c.find(x => x.v === v) || null : null; };
const PAPER = [232, 237, 231];
function mkShade(t, key, sc) {
  /* five steps from a light tint to the full hue, the top class deeper still — differences read at a glance */
  const i = IND.find(x => x.key === key);
  if (sc && sc.diverging) {
    /* below the centre runs out to hue_neg, above it to hue_pos, and the middle
       class stays paper — the eye reads the sign before it reads the size */
    const lo = (i && i.hue_neg) || [176, 51, 27], hi = (i && i.hue_pos) || [28, 107, 92];
    const d = (Math.max(0, Math.min(1, t)) - .5) * 2;
    const hue = d < 0 ? lo : hi; const s = 0.12 + 0.88 * Math.pow(Math.abs(d), .85);
    const c = PAPER.map((x, j) => Math.round(x + (hue[j] - x) * s));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }
  const hue = (i && i.hue) || [10, 88, 70];
  const s = 0.1 + 0.9 * Math.pow(Math.max(0, Math.min(1, t)), .9); const k = t >= .99 ? .72 : 1;
  const c = PAPER.map((x, j) => Math.round((x + (hue[j] - x) * s) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
/* Some indicators have a meaningful centre rather than a meaningful maximum —
   a projected population change is above or below flat, and shading it as a
   single ramp would make "-8 %" and "+1 %" two shades of the same colour.
   A diverging indicator declares `scale: "diverging"`, a `center` (usually 0)
   and two hues; breaks are quantiles of |v - centre| mirrored about it, so the
   two arms always get the same class widths and the centre class is genuinely
   "near flat". */
function divergingScale(vals, ind) {
  const c = ind.center != null ? ind.center : 0;
  const dev = vals.map(v => Math.abs(v - c)).sort((a, b) => a - b);
  if (!dev.length) return null;
  const q = p => dev[Math.min(dev.length - 1, Math.floor(p * dev.length))];
  const arm = [q(.4), q(.75)].filter((b, i, a) => b > 0 && (i === 0 || b > a[i - 1]));
  if (!arm.length) return null;
  const breaks = arm.slice().reverse().map(b => c - b).concat(arm.map(b => c + b));
  const n = breaks.length + 1;
  const mid = (n - 1) / 2;
  const t = v => { if (v == null || isNaN(v)) return null; let k = 0; while (k < breaks.length && v > breaks[k]) k++; return k / (n - 1); };
  return { t, lo: Math.min(...vals), hi: Math.max(...vals), breaks, classes: n, n: vals.length,
           diverging: true, center: c, mid };
}
/* quintile classes: each colour step holds a fifth of the areas, so a few outliers cannot flatten the map */
function scaleOf(list, vk, fixed, ind) {
  const cats = catsOf(ind);
  if (cats) {
    const seen = new Set(list.map(vk).filter(v => v != null));
    return { cats, t: v => (v == null ? null : v), color: v => (catOf(ind, v) || {}).color || "#C4CBC4",
             lo: null, hi: null, breaks: [], classes: cats.length,
             n: [...seen].length ? list.filter(o => vk(o) != null).length : 0 };
  }
  const vals = list.map(vk).filter(v => v != null && !isNaN(v)).sort((a, b) => a - b);
  if (!vals.length) return { t: () => null, lo: null, hi: null, breaks: [] };
  if (ind && ind.scale === "diverging") { const d = divergingScale(vals, ind); if (d) return d; }
  const q = p => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
  /* fixed breaks where the scale has a natural meaning (shares of a building); otherwise quintiles —
     repeated quantiles (many identical values) collapse into fewer, non-empty classes */
  const breaks = (fixed || [q(.2), q(.4), q(.6), q(.8)]).filter((b, i, a) => (i === 0 || b > a[i - 1]) && b < vals[vals.length - 1]);
  const n = breaks.length + 1;
  const t = v => { if (v == null || isNaN(v)) return null; let c = 0; while (c < breaks.length && v > breaks[c]) c++; return n > 1 ? c / (n - 1) : .5; };
  return { t, lo: vals[0], hi: vals[vals.length - 1], breaks, classes: n, n: vals.length };
}
function legendHtml(sc, ind, key, note) {
  /* class-break legend drawn on top of the map (bottom right) */
  const f = fmtOf(ind); const b = sc.breaks || []; const n = sc.classes || 0;
  const lab = c => n === 1 ? f(sc.lo) : c === 0 ? `≤ ${f(b[0])}` : c === n - 1 ? `> ${f(b[c - 1])}` : `${f(b[c - 1])} – ${f(b[c])}`;
  if (sc.cats) {
    const rows2 = sc.cats.slice().reverse().map(c => `<div class="lgrow"><i style="background:${c.color}"></i>${esc(c.label)}</div>`);
    return `<div class="lgtitle">${esc(ind.short || ind.label)}<span>${esc(ind.unit || "")}</span></div>` +
      rows2.join("") + `<div class="lgrow"><i style="background:#C4CBC4"></i>no answer</div>${note ? `<div class="lgnote">${note}</div>` : ""}`;
  }
  const rows = []; for (let c = n - 1; c >= 0; c--) rows.push(`<div class="lgrow"><i style="background:${mkShade(n > 1 ? c / (n - 1) : .5, key, sc)}"></i>${lab(c)}</div>`);
  /* The ramp itself is always "darkest = highest"; rather than invert the colours
     for a lower-is-better indicator — which would make two maps side by side
     unreadable — the legend says so in one line. */
  const dnote = sc.diverging ? `\u2195 diverging about ${f(sc.center)}`
    : lowerBetter(ind) ? "\u2193 lower is better \u00b7 darkest = highest"
    : dirOf(ind) === "higher_better" ? "\u2191 higher is better \u00b7 darkest = highest" : "";
  return `<div class="lgtitle">${esc(ind.short || ind.label)}<span>${esc(ind.unit || "")}</span></div>` +
    (n ? rows.join("") : `<div class="lgrow dim">no data</div>`) +
    `<div class="lgrow"><i style="background:#C4CBC4"></i>no data</div>` +
    (dnote ? `<div class="lgnote">${esc(dnote)}</div>` : "") +
    `${note ? `<div class="lgnote">${note}</div>` : ""}`;
}
function setLegend(id, sc, ind, key, note) {
  const el = document.getElementById(id); if (el) el.innerHTML = legendHtml(sc, ind, key, note);
  /* Every overlay legend is rewritten on every pass — including the ones whose
     overlay is off, which write "" — so no path can leave a stale box behind.
     `.maplegend:empty{display:none}` in style.css is what keeps an empty one
     from showing as a white bar. */
  ovLegends();
}
/* Rewritten on every legend pass AND whenever an overlay's data arrives — a
   lazily loaded layer draws before its legend would otherwise be refreshed,
   which left the box reading "loading…" over a fully drawn overlay. */
function ovLegends() {
  for (const o of ovList()) {
    const e2 = document.getElementById("lg-" + o.id);
    if (e2) e2.innerHTML = (ovOn(o) && o.legend) ? o.legend() : "";
  }
}
const GROUP_ORDER = ["Demographics", "Outlook", "Safety", "Schools", "Climate", "Growth signals", "Income & jobs", "Housing stock", "Rents", "Prices & market", "Construction", "Municipal finances", "Area quality"];
function indSelect() {
  const L = curInds();
  const groups = GROUP_ORDER.filter(gname => L.some(i => (i.group || "Other") === gname)).concat(L.some(i => !GROUP_ORDER.includes(i.group || "Other")) ? ["Other"] : []);
  return `<select id="indsel" class="indsel" aria-label="Indicator">${groups.map(gname => `<optgroup label="${esc(gname)}">${L.filter(i => (i.group || "Other") === gname).map(i =>
    `<option value="${i.key}" ${MK.ind === i.key ? "selected" : ""}>${esc(i.label)}${i.unit ? " · " + esc(i.unit) : ""}</option>`).join("")}</optgroup>`).join("")}</select>`;
}
function indQuick() {
  /* the six figures people ask for first, one click each */
  const L = curInds(); const ks = QUICK_KEYS.map(k => L.find(i => i.key === k)).filter(Boolean);
  return ks.length > 1 ? `<div class="iq">${ks.map(i => `<button class="iqb ${MK.ind === i.key ? "on" : ""}" data-indq="${i.key}" title="${esc(i.label)}">${esc(i.short || i.label)}</button>`).join("")}</div>` : "";
}
/* searchable area box: kommuner open on the map, RegSO areas open their page */
const AREA_OPTS = [{ t: "Sweden — whole country", h: "map", k: ["sweden", "sverige", "dk"] }];
MUNI.slice().sort((a, b) => a.name.localeCompare(b.name, LOCALE)).forEach(m => AREA_OPTS.push({ t: `${m.name} — municipality, ${m.lan || ""}`, h: `map/${m.code}`, k: [m.name.toLowerCase(), m.code] }));
AREAS.slice().sort((a, b) => a.code.localeCompare(b.code)).forEach(a => AREA_OPTS.push({ t: `${a.name} — RegSO, ${(byCode[a.kommun] || {}).name || ""}`, h: `area/regso/${a.code}`, k: [a.code, (a.name || "").toLowerCase()] }));
/* DeSO is not in the search box: its files load per kommun, so most of the 6 160
   are not in memory. Open a kommun and switch to DeSO to reach them. */
function areaSearch() {
  const m = MK.kommun ? byCode[MK.kommun] : null;
  return `<span class="asrch"><input id="areaq" list="arealist" class="indsel" placeholder="${m ? esc(m.name) + " — search another area…" : "Search kommun or RegSO…"}" autocomplete="off" aria-label="Area">
    <datalist id="arealist">${AREA_OPTS.map(o => `<option value="${esc(o.t)}"></option>`).join("")}</datalist></span>`;
}
function areaSearchGo(txt) {
  const q = (txt || "").trim(); if (!q) return;
  let o = AREA_OPTS.find(x => x.t === q);
  if (!o) { const ql = q.toLowerCase().replace(/\s+—.*$/, ""); o = AREA_OPTS.find(x => x.k.some(k => k === ql)) || AREA_OPTS.find(x => x.k.some(k => k.startsWith(ql))); }
  if (o) go(o.h + `?ind=${encodeURIComponent(MK.ind)}` + (MK.year !== LATEST ? `&y=${MK.year}` : ""));
}
function asofText(i) {
  const asofSrc = (MK.year !== LATEST && i.hist_asof && i.hist_asof[MK.year]) ? i.hist_asof[MK.year] : i.asof;
  return asofSrc ? Object.entries(asofSrc).map(([g, p]) => `${g === "regso" ? "RegSO" : g === "deso" ? "DeSO" : "kommuner"}: ${esc(p)}`).join(" · ") : "";
}
/* ---------- verify at source ----------
   A link that reproduces the publisher's own query for exactly the cells shown,
   so a reader can fetch the number and get the same answer. The URL is built
   here and, independently, in scripts/check_source_links.py — that duplication
   is on purpose: the checker re-fetches every one of them, so if the two drift
   apart the sweep stops matching the page and says so, instead of the reader
   finding out.

   The level a figure is DISPLAYED at is not always the level it is PUBLISHED
   at. `code_level` says which to send; brf_price is drawn per kommun but comes
   from a län table, and asking that table for a kommun code is a 400. */
const SRC_PERIODS = D.src_periods || {};
function srcPeriods(e, year) {
  const newest = e.newest_period || "";
  if ((e.time_kind || "year") === "year") return [newest && year > newest ? newest : year];
  const codes = SRC_PERIODS[e.table] || [];
  const hit = codes.filter(c => c.indexOf(year) === 0);
  return hit.length ? hit : (newest ? [newest] : []);
}
function srcCode(e, level, code) {
  const cl = e.code_level;
  if (e.level === "national") return (e.region_levels || []).includes("riket") ? "00" : null;
  if (cl === "riket") return "00";
  if (cl === "lan") return (code || "").slice(0, 2) || null;
  if (cl === "riksomrade") return null;
  return code || null;
}
function srcUrl(e, level, code, year) {
  if (!e) return null;
  if (e.db === "kolada") return code ? `${e.api}/${code}` : e.api;
  if (e.db !== "scb") return e.page || null;
  const tids = srcPeriods(e, year || LATEST);
  if (!tids.length) return null;
  const q = ["lang=en", "outputFormat=csv"];
  const rc = srcCode(e, level, code);
  if (rc && e.region_dim) q.push(`valueCodes[${e.region_dim}]=${encodeURIComponent(rc)}`);
  q.push(`valueCodes[${e.time_dim}]=${encodeURIComponent(tids.join(","))}`);
  for (const d in (e.vars || {})) q.push(`valueCodes[${d}]=${encodeURIComponent(e.vars[d].join(","))}`);
  return e.api + "?" + q.join("&");
}
/* the entry that can answer for this level, else the one nearest above it */
function pickSrc(i, level) {
  const L = i.src_verify || []; if (!L.length) return null;
  return L.find(e => e.level === level)
      || L.find(e => e.level === "kommun")
      || L.find(e => e.level === "national") || L[0];
}
function indSrcLink(i, level, code, year) {
  const e = pickSrc(i, level || "kommun"); if (!e) return "";
  const u = srcUrl(e, level, code, year);
  if (!u) return "";
  const what = e.db === "scb" ? "downloads the CSV for exactly these cells"
    : e.db === "kolada" ? "returns this KPI as JSON" : "opens the publisher's page";
  return `<a class="srcv" href="${esc(u)}" target="_blank" rel="noopener"
    title="${esc(e.label)} — ${what}">Verify at source ↗</a>`;
}

function indExplain(i) {
  const pool = curPool();
  const cov = `${MUNI.filter(m => m[i.key] != null).length}/${MUNI.length} kommuner${(i.levels || []).includes("regso") ? `, ${AREAS.filter(a => a[i.key] != null).length}/${AREAS.length} RegSO` : ""}${(i.levels || []).includes("deso") ? ", DeSO per kommun" : ""}`;
  const ys = yearsForPool(i.key, pool);
  const asof = asofText(i);
  /* one line by default — label, level, unit, period; the definition, source, coverage and caveat open on ⓘ */
  const asofShort = asofSrc => { const src = (MK.year !== LATEST && i.hist_asof && i.hist_asof[MK.year]) || i.asof || {}; return src.kommun || src.regso || src.deso || ""; };
  return `<details class="indx" ${UI.indxOpen ? "open" : ""}>
    <summary><b>${esc(i.label)}</b><span class="tag">${i.level === "deso" ? "DeSO level" : i.level === "regso" ? "RegSO level" : i.level === "none" ? "national" : "kommun level"}</span><span class="tag">${esc(i.unit || "")}</span>${asofShort() ? `<span class="dim">as of ${esc(asofShort())}</span>` : ""}${i.warn ? `<span class="warnline">⚠</span>` : ""}<i class="more">ⓘ details</i></summary>
    <div class="indx-body"><p>${esc(i.desc || "")}</p>
    <p class="dim"><em>Source</em> ${esc(i.source || "–")}${asof ? ` · <em>As of</em> ${asof}` : ""} · <em>Coverage</em> ${cov}${ys.length > 1 ? ` · <em>History</em> ${ys[0]}–${LATEST}` : ""} ${indSrcLink(i, MK.kommun ? (desoMode() ? "deso" : "regso") : "kommun", MK.kommun, MK.year === LATEST ? LATEST : MK.year)}</p>
    ${i.warn ? `<p class="warnline">⚠ ${esc(i.warn)}</p>` : ""}</div>
  </details>`;
}
function yearSelect() {
  const oi = outlookOf(curInd());
  if (oi) return `<span class="fclab" title="${esc((curInd().warn || ""))}">${esc(oi.label)} · SCB ${esc((oi.published || "").slice(0, 4))}</span>`;
  const ys = yearsFor(MK.ind);
  if (ys.length < 2) return "";
  const hy = ys.filter(y => y !== LATEST); const lastHist = hy[hy.length - 1];
  const pool = curPool();
  const label = y => y === LATEST ? (lastHist && lastHist !== LATEST && !pool.some(m => m.hist && m.hist[MK.ind] && m.hist[MK.ind][LATEST] != null) ? `latest (${lastHist} data)` : `${y} (latest)`) : y;
  return `<select id="yearsel" class="indsel" aria-label="Year">${ys.filter(y => !(y === lastHist && label(LATEST).startsWith("latest ("))).map(y => `<option value="${y}" ${MK.year === y ? "selected" : ""}>${label(y)}</option>`).join("")}</select>`;
}

/* geometry helpers: largest ring, centroid */
const mainRing = a => (a.rings || []).slice().sort((x, y) => y.length - x.length)[0] || [];
const centroid = ring => ring.reduce((o, p) => [o[0] + p[0] / ring.length, o[1] + p[1] / ring.length], [0, 0]);
function muniAreas(code) { return desoMode() ? desoAreas(code) : AREAS.filter(a => a.kommun === code); }
function boundsOf(list) { const pts = []; list.forEach(a => (a.rings || []).forEach(r => r.forEach(p => pts.push(p)))); return pts.length ? L.latLngBounds(pts) : null; }
function applyPendingFit() {
  if (!LF.map || !LF.pendingFit) return;
  const b = boundsOf(muniAreas(LF.pendingFit)); LF.pendingFit = null;
  if (b) LF.map.fitBounds(b, { padding: [12, 12] });
}
/* page links for the three entity types */
/* which page an entity belongs to, by shape: a DeSO names its RegSO, a RegSO names
   its kommun, a kommun names neither. */
const pageOf = o => o.regso ? `area/deso/${o.code}` : o.kommun ? `area/regso/${o.code}` : `area/kommun/${o.code}`;
const withQ = h => h + `?ind=${encodeURIComponent(MK.ind)}` + (MK.year !== LATEST ? `&y=${MK.year}` : "");

/* ---------- Macro map view ---------- */
function srcNote(extra = "") {
  /* collapsed by default — "Data information" opens the source list and the small print */
  const s = (D.meta && D.meta.sources) || [];
  const list = s.map(x => `${esc(x.label)}${x.asof ? " (" + esc(x.asof) + ")" : ""}`).join(" · ");
  return `<details class="dinfo"><summary>Data information</summary><div class="note"><b>Open data.</b> ${list || "no sources recorded"}.
    Municipality-level indicators are shown on postal-code polygons with the municipality value (marked °) when no finer statistic exists.
    ${esc((D.meta && D.meta.note) || "")}</div>${extra}<p class="cap">Full definitions and table stamps under <button class="lk mini" data-go="market?src=1">Market › Sources</button>. Built ${esc((D.meta && D.meta.built) || "–")}.</p></details>`;
}
function rankOf(o, key, peers) {
  /* #1 is the best end, not the highest — on unemployment or forced sales that
     is the lowest value. A neutral indicator still gets a position so the reader
     can see where the area sits, but it is reported as "highest first" and
     carries `neutral` so the caller can drop the good/bad colour. */
  const v = V(o, key); if (v == null) return null;
  const ind = indOf(key);
  const vals = peers.map(p => V(p, key)).filter(x => x != null);
  const lb = lowerBetter(ind);
  return { r: 1 + vals.filter(x => (lb ? x < v : x > v)).length, n: vals.length, neutral: neutralDir(ind) };
}
function muniStrip(m) {
  /* the selected municipality in one line: population, region, selected indicator + rank, link to its page */
  const inds = IND;
  const key = HL_KEYS.map(k => inds.find(i => i.key === k)).filter(i => i && V(m, i.key) != null).slice(0, 4);
  const cell = i => { const rk = rankOf(m, i.key, MUNI); return `<div><span>${esc(i.short || i.label)}</span><b>${fmtOf(i)(V(m, i.key))}</b><em>${rk ? `#${rk.r} of ${rk.n}` : ""}</em></div>`; };
  return `<div class="mstrip">
    <div class="mstrip-id"><b>${esc(m.name)}</b><span class="dim">${esc(m.lan || "")} · ${m.pop != null ? nf(m.pop, 0) + " inhabitants" : ""} · ${muniAreas(m.code).length} ${desoMode() ? "DeSO" : "RegSO"}</span></div>
    <div class="mstrip-k">${key.map(cell).join("")}</div>
    <div class="mstrip-act"><button class="lk primary" data-go="${withQ(pageOf(m))}">Open ${esc(m.name)} page ›</button><button class="lk" data-go="${chartLink(MK.ind, "kommun", m.code)}" title="Open the chart generator with this municipality">↗ Chart</button></div>
  </div>`;
}
function vMakro() {
  if (!AREAS.length || !MUNI.length) return `<div class="card"><p class="empty">No macro data built yet — run <code>make fetch</code>, <code>make geo</code> and <code>make build</code>.</p></div>`;
  const ind = curInd();
  setTimeout(lfInit, 0);
  const muni = MK.kommun ? byCode[MK.kommun] : null;
  return `
  <div class="card accent" id="mapcard">
    <div class="card-head tools-only">
      <div class="tools">${areaSearch()}${subToggle()}${indSelect() + yearSelect()}${ovTools()}${jumpTools()}${D.portfolio ? `<button class="lk mini ${MK.own ? "primary" : ""}" data-mkown>● Own properties</button>` : ""}<button class="lk" data-fs title="Full screen (Esc to exit)">⤢ Full screen</button></div>
      ${indQuick()}</div>
    ${indExplain(ind)}
    ${muni ? muniStrip(muni) : ""}
    <div class="mapwrap"><div id="lfmap"></div>
      <div class="maplegs">${ovList().map(o => `<div class="maplegend" id="lg-${o.id}"></div>`).join("")}</div>
      <div class="maplegend" id="maplegend"></div></div>
    ${srcNote(`<p class="cap">${muni ? "Click a polygon for its figures and a link to its page." : "Click a polygon for its figures; open a kommun with the search box above or from the popup. Table view lists everything side by side."} Colour classes: quintiles of the visible areas. Boundaries: SCB RegSO/DeSO 2025 (CC0), clipped to the coastline with OSM land polygons (ODbL); basemap OpenStreetMap.</p>`)}
  </div>`;
}

/* ---------- Table view ---------- */
/* Margins of error are first-class: TAB4590 is a ~16 000-apartment sample survey
   and publishes a ± per kommun. It is rendered next to the value, and a value
   whose margin is wider than the indicator's moe_rel is greyed — false precision
   is the easy mistake with this source. */
function moeOf(i, o, y) { return i && i.moe && o ? MOE(o, i.key, y) : null; }
function moeWide(i, v, m) { return i && i.moe_rel != null && v && m != null && Math.abs(m / v) > i.moe_rel; }
function moeSpan(i, v, m) {
  if (m == null) return "";
  return `<span class="moe${moeWide(i, v, m) ? " wide" : ""}" title="margin of error, ±${nf(m, 0)} ${esc(i.unit || "")}${moeWide(i, v, m) ? " — wider than the indicator allows, read with care" : ""}">±${nf(m, 0)}</span>`;
}
function fmtCell(i, v, fallback, o, y) {
  if (v == null || isNaN(v)) return `<td class="num">–</td>`;
  const m = moeOf(i, o, y);
  return `<td class="num${moeWide(i, v, m) ? " dim" : ""}" data-v="${v}">${fmtOf(i)(v)}${fallback ? " °" : ""}${moeSpan(i, v, m)}</td>`;
}
function deltaCell(o, i, pool) {
  const y0 = yearsForPool(i.key, pool || curPool())[0]; if (!y0 || y0 === MK.year) return `<td class="num dim">–</td>`;
  const a = V(o, i.key, y0), b = V(o, i.key); if (a == null || b == null) return `<td class="num dim">–</td>`;
  const d = isPct(i) ? b - a : (a ? (b / a - 1) * 100 : null); if (d == null) return `<td class="num dim">–</td>`;
  return `<td class="num ${d > 0 ? "good" : d < 0 ? "bad" : ""}" data-v="${d}">${sign(d, x => nf(x, 1))}${isPct(i) ? " pp" : " %"}</td>`;
}
function tableRows() {
  const q = T.q;
  if (T.level === "deso") return allDeso().filter(a => (a.pop || 0) >= T.minPop && (!q || (a.name || "").toLowerCase().includes(q) || a.code.toLowerCase().includes(q)));
  if (T.level === "kommun") return MUNI.filter(m => (!T.lan || m.lan === T.lan) && (m.pop || 0) >= T.minPop && (!q || m.name.toLowerCase().includes(q) || m.code.includes(q)));
  return AREAS.filter(a => { const m = byCode[a.kommun] || {}; return (!T.lan || m.lan === T.lan) && (a.pop || 0) >= T.minPop && (!q || (a.name || "").toLowerCase().includes(q) || a.code.includes(q) || (m.name || "").toLowerCase().includes(q)); });
}
function tableCols() { return T.level === "deso" ? IND_DESO : T.level === "regso" ? IND.filter(i => i.level === "regso").concat(IND.filter(i => i.level !== "regso")) : IND; }
function tableBodyHtml() {
  const cols = tableCols(), ind = curInd(), pool = curPool(), y0 = yearsForPool(ind.key, pool)[0];
  const rows = tableRows().slice().sort((a, b) => ((V(b, ind.key) ?? V(byCode[b.kommun], ind.key)) ?? -1e9) - ((V(a, ind.key) ?? V(byCode[a.kommun], ind.key)) ?? -1e9));
  if (!rows.length) return `<tr><td colspan="${cols.length + 5}" class="empty">no rows match the filters</td></tr>`;
  return rows.map(r => {
    const m = T.level === "regso" ? (byCode[r.kommun] || {}) : r;
    const lead = `<tr class="clickrow" data-go="${withQ(pageOf(r))}"><th><span class="thn">${esc(r.name)} <span class="go">›</span></span><button class="tch" data-go="${chartLink(ind.key, T.level, r.code)}" title="Open in Charts">↗</button></th>`;
    if (T.level === "deso") return `${lead}<td class="dim">${esc(r.code)}</td><td class="dim">${esc((byRegso[r.regso] || {}).name || "")}</td><td class="num dim" data-v="${r.pop || 0}">${r.pop != null ? nf(r.pop, 0) : "–"}</td>
      ${fmtCell(ind, V(r, ind.key), false, r)}${y0 && y0 !== MK.year ? deltaCell(r, ind, pool) : ""}${cols.filter(i => i.key !== ind.key).map(i => fmtCell(i, V(r, i.key), false, r)).join("")}</tr>`;
    const cell = i => { const own = V(r, i.key); return own != null ? fmtCell(i, own, false, r) : (T.level === "regso" ? fmtCell(i, V(m, i.key), true, m) : fmtCell(i, null, false)); };
    return `${lead}<td class="dim">${esc(r.code)}</td><td class="dim">${T.level === "regso" ? esc(m.name || "") : esc(r.lan || "")}</td>
      <td class="num dim" data-v="${r.pop || 0}">${r.pop != null ? nf(r.pop, 0) : "–"}</td>
      ${cell(ind)}${y0 && y0 !== MK.year ? deltaCell(r, ind, pool) : ""}${cols.filter(i => i.key !== ind.key).map(cell).join("")}</tr>`; }).join("");
}
function renderTableBody() {
  const tb = document.getElementById("tbody"); if (!tb) return;
  tb.innerHTML = tableBodyHtml();
  const n = document.getElementById("tcount"); if (n) n.textContent = `${tableRows().length} rows`;
}
function vTable() {
  const ind = curInd(), cols = tableCols(), y0 = yearsFor(ind.key)[0];
  return `
  <div class="card accent">
    <div class="card-head tools-only"><div class="tools">${indSelect()}${yearSelect()}</div>${indQuick()}</div>
    ${indExplain(ind)}
    <div class="tfilters">
      <input id="tq" type="search" placeholder="Search kommun, RegSO or code…" value="${esc(T.q)}">
      <div class="seg"><button class="sg ${T.level === "kommun" ? "on" : ""}" data-tlevel="kommun">Kommuner (${MUNI.length})</button><button class="sg ${T.level === "regso" ? "on" : ""}" data-tlevel="regso">RegSO (${AREAS.length})</button>${allDeso().length ? `<button class="sg ${T.level === "deso" ? "on" : ""}" data-tlevel="deso">DeSO (${allDeso().length})</button>` : ""}</div>
      ${T.level !== "deso" ? `<select id="tregion" class="indsel"><option value="">All regions</option>${REGIONS.map(r => `<option value="${r}" ${T.lan === r ? "selected" : ""}>${r}</option>`).join("")}</select>` : ""}
      <label class="hint">min. population <input id="tminpop" type="number" min="0" step="1000" value="${T.minPop}" style="width:90px"></label>
      <span class="hint" id="tcount">${tableRows().length} rows</span>
      <button class="lk mini" data-csv>⤓ Export CSV</button>
    </div>
    <div class="scrollx"><table class="tbl compact wraphead" data-sortable><thead><tr>
      <th>${T.level === "deso" ? "DeSO" : T.level === "regso" ? "RegSO" : "Kommun"}</th><th>Code</th><th>${T.level === "deso" ? "RegSO" : T.level === "regso" ? "Municipality" : "Region"}</th><th class="num">Population</th>
      <th class="num hi">${esc(ind.label)}<br><span class="dim">${esc(ind.unit || "")}</span></th>${y0 && y0 !== MK.year ? `<th class="num">Δ since ${y0}<br><span class="dim">${isPct(ind) ? "pp" : "%"}</span></th>` : ""}
      ${cols.filter(i => i.key !== ind.key).map(i => `<th class="num">${esc(i.label)}<br><span class="dim">${esc(i.unit || "")}</span></th>`).join("")}</tr></thead>
      <tbody id="tbody">${tableBodyHtml()}</tbody></table></div>
    <p class="cap">Sorted by the selected indicator; click a column header to re-sort, a row to open the area's page, ↗ to chart it. ° = kommun value shown on a sub-area. Rows: ${T.level === "regso" ? "postal codes (street-level codes in central Copenhagen merged by name)" : T.level === "deso" ? "Copenhagen quarters (DeSO areas), source Københavns Kommune statbank" : "municipalities"}.</p>
    ${srcNote()}
  </div>`;
}
function exportCsv() {
  const cols = tableCols(), rows = tableRows();
  const head = [T.level === "deso" ? "deso" : T.level === "regso" ? "regso" : "kommun", "code", T.level === "deso" ? "regso" : T.level === "regso" ? "municipality" : "region", "population"].concat(cols.map(i => i.key));
  const lines = [head.join(";")].concat(rows.map(r => { const m = T.level === "regso" ? (byCode[r.kommun] || {}) : r;
    return [r.name, r.code, T.level === "deso" ? ((byRegso[r.regso] || {}).name || "") : T.level === "regso" ? (m.name || "") : lanName(r.lan), r.pop ?? ""].concat(cols.map(i => V(r, i.key) ?? (T.level === "regso" ? (V(m, i.key) ?? "") : ""))).map(v => String(v).replace(/;/g, ",")).join(";"); }));
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `am-dashboard-dk_${T.level}_${MK.year}_${(D.meta && D.meta.built) || "data"}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function downloadCsv(lines, name) {
  const blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function exportAll() {
  /* one long-format CSV of everything the dashboard holds: every level, every indicator, every year, plus the macro series */
  const cl = v => String(v == null ? "" : v).replace(/;/g, ",").replace(/\r?\n/g, " ");
  const out = ["level;code;name;parent;region;population;year;indicator;label;unit;value;as_of"];
  const emit = (level, o, code, name, parent, region, inds, asofOf) => {
    inds.forEach(i => {
      const yrs = new Set(Object.keys((o.hist && o.hist[i.key]) || {})); if (o[i.key] != null) yrs.add(LATEST);
      [...yrs].sort().forEach(y => { const v = y === LATEST ? o[i.key] : o.hist[i.key][y]; if (v == null) return;
        out.push([level, code, name, parent, region, o.pop ?? "", y, i.key, i.label, i.unit || "", v, asofOf(i, y)].map(cl).join(";")); });
    });
  };
  const asofNat = lvl => (i, y) => { const src = (y !== LATEST && i.hist_asof && i.hist_asof[y]) || i.asof || {}; return src[lvl] || src.kommun || ""; };
  MUNI.forEach(m => emit("municipality", m, m.code, m.name, "Sweden", m.lan || "", IND, asofNat("kommun")));
  AREAS.forEach(a => { const m = byCode[a.kommun] || {}; emit("postal_code", a, a.code, a.name, m.name || "", m.lan || "", IND.filter(i => i.level === "regso"), asofNat("regso")); });
  allDeso().forEach(q => emit("deso", q, q.code, q.name, byCode[q.kommun] ? byCode[q.kommun].name : "", lanName(q.lan), IND, (i, y) => (y !== LATEST && i.hist_asof && i.hist_asof[y]) || (i.asof && i.asof.deso) || ""));
  const mac = D.macro || {}; Object.entries(mac.series || {}).forEach(([k, ser]) => { const lt = (mac.latest || {})[k] || {};
    ser.forEach(pt => { if (pt.v != null) out.push(["macro", k, lt.label || k, "Sweden", "", "", pt.t, k, lt.label || k, lt.unit || "", pt.v, lt.src || ""].map(cl).join(";")); }); });
  downloadCsv(out, `macro-dashboard-dk_all_${(D.meta && D.meta.built) || "data"}.csv`);
}

/* ---------- Area page (kommun · RegSO · DeSO) ---------- */
function areaEntity() {
  if (AR.type === "kommun") {
    const m = byCode[AR.code]; if (!m) return null;
    const mine = AREAS.filter(a => a.kommun === m.code);
    const subs = { regso: mine };
    if (desoLoaded(m.code)) subs.deso = desoAreas(m.code);
    return { type: "kommun", typeLabel: "Kommun", o: m, name: m.name, code: m.code, kommun: null, lan: m.lan, inds: IND, peers: MUNI, peerLabel: "kommuner",
             ctx: mine, own: mine, subs };
  }
  if (AR.type === "regso") {
    const a = byRegso[AR.code]; if (!a) return null; const m = byCode[a.kommun];
    const kids = desoAreas(a.kommun).filter(d => d.regso === a.code);
    return { type: "regso", typeLabel: "RegSO", o: a, name: a.name, code: a.code, kommun: m, lan: m && m.lan, inds: IND, peers: AREAS, peerLabel: "RegSO areas",
             ctx: AREAS.filter(x => x.kommun === a.kommun), own: [a], subs: kids.length ? { deso: kids } : null };
  }
  if (AR.type === "deso") {
    const q = byDeso[AR.code]; if (!q) return null; const m = byCode[q.kommun];
    const sibs = desoAreas(q.kommun);
    return { type: "deso", typeLabel: "DeSO", o: q, name: q.code.split("_")[0], code: q.code, kommun: m, lan: m && m.lan, inds: IND, peers: sibs.length ? sibs : [q], peerLabel: "DeSO areas",
             ctx: sibs, own: [q], subs: null };
  }
  return null;
}
/* Most indicators fall back to the kommun figure for a sub-area that has none,
   marked °. A few must NOT: the police designation is a statement about a
   specific piece of ground, so showing Stockholm's 4.4 % on every RegSO in the
   city would say that all of them are designated. An indicator with
   `no_inherit` is blank where it has no value of its own. */
const noInherit = i => !!(i && i.no_inherit);
const canInherit = k => !noInherit(indOf(k));
/* value for the entity: its own figure, or the kommun's (inherited, °) for sub-areas */
function eVal(e, k, y) { const own = V(e.o, k, y); if (own != null) return { v: own, own: true }; if (canInherit(k) && e.type === "regso" && e.kommun) { const mv = V(e.kommun, k, y); if (mv != null) return { v: mv, own: false }; } return { v: null, own: false }; }
function eYears(e, k) { return histYears(k, e.type === "regso" && V(e.o, k) == null ? MUNI : e.peers); }
function tileSpark(ys, own, med, i) {
  /* area (solid) against the median of its peers (dashed), last point marked, first/last year on the axis */
  const all = own.concat(med).filter(v => v != null); if (own.filter(v => v != null).length < 2) return "";
  const W = 220, H = 60, T0 = 6, B = 14, L0 = 4, R = 8;
  const lo = Math.min(...all), hi = Math.max(...all), sp = hi - lo || 1;
  const x = k => L0 + k / (ys.length - 1) * (W - L0 - R), y = v => T0 + (1 - (v - lo) / sp) * (H - T0 - B);
  const path = arr => { let d = "", open = false; arr.forEach((v, k) => { if (v == null) { open = false; return; } d += (open ? "L" : "M") + x(k).toFixed(1) + "," + y(v).toFixed(1); open = true; }); return d; };
  const li = own.map((v, k) => v == null ? -1 : k).filter(k => k >= 0).pop();
  return `<svg class="tspark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path d="${path(med)}" fill="none" stroke="#9A9D92" stroke-width="1.2" stroke-dasharray="3 3"/>
    <path d="${path(own)}" fill="none" stroke="#1C6B5C" stroke-width="2"/>
    ${li != null ? `<circle cx="${x(li).toFixed(1)}" cy="${y(own[li]).toFixed(1)}" r="2.8" fill="#1C6B5C"/>` : ""}
    <text class="ax" x="${L0}" y="${H - 3}">${ys[0]}</text><text class="ax" x="${W - R}" y="${H - 3}" text-anchor="end">${ys[ys.length - 1]}</text>
    ${own.map((v, k) => v == null ? "" : `<circle cx="${x(k).toFixed(1)}" cy="${y(v).toFixed(1)}" r="6" fill="transparent"><title>${ys[k]}: ${fmtOf(i)(v)}${med[k] != null ? " · median " + fmtOf(i)(med[k]) : ""}</title></circle>`).join("")}</svg>`;
}
/* everything a tile, headline cell or popup needs about one indicator for one area */
function tileStats(e, i) {
  const cur = eVal(e, i.key); if (cur.v == null) return null;
  const ys = eYears(e, i.key), y0 = ys[0];
  const own = ys.map(y => eVal(e, i.key, y).v), med = ys.map(y => median(e.peers.map(p => V(p, i.key, y))));
  const dlt = (a, b) => a == null || b == null ? null : isPct(i) ? b - a : (a ? (b / a - 1) * 100 : null);
  const unit = isPct(i) ? " pp" : " %";
  const li = own.map((v, k) => v == null ? -1 : k).filter(k => k >= 0).pop(); const idx = MK.year === LATEST ? li : ys.indexOf(MK.year);
  const yoy = idx > 0 ? dlt(own[idx - 1], own[idx]) : null;
  const since = y0 && y0 !== MK.year ? dlt(own[0], cur.v) : null;
  const vsMed = dlt(median(e.peers.map(p => V(p, i.key))), cur.v);
  const rk = cur.own ? rankOf(e.o, i.key, e.peers) : null;
  return { cur, ys, y0, own, med, yoy, since, vsMed, rk, unit };
}
/* A rise is green only where a rise is good. On unemployment it is red, and on
   a descriptor it is neither — `cls` returns "" and the delta is drawn plain. */
const cls = (d, key) => { const i = key ? indOf(key) : null;
  if (d == null || !d) return ""; if (i && neutralDir(i)) return "";
  const good = i && lowerBetter(i) ? d < 0 : d > 0; return good ? "up" : "dn"; };
function tileHtml(e, i, on) {
  const s = tileStats(e, i); if (!s) return "";
  return `<div class="tile ${on ? "on" : ""}" data-arind="${esc(i.key)}" title="${esc(i.desc || i.label)} — click to focus the chart and map">
    <button class="tch" data-go="${chartLink(i.key, e.type, e.code)}" title="Open in Charts">↗</button>
    <span class="tl">${esc(i.label)}${s.cur.own ? "" : " °"}</span>
    <div class="tv"><b>${fmtOf(i)(s.cur.v)}</b>${moeSpan(i, s.cur.v, moeOf(i, s.cur.own ? e.o : e.kommun))}${s.yoy != null ? `<i class="${cls(s.yoy, i.key)}">${sign(s.yoy, x => nf(x, 1))}${s.unit} y/y</i>` : ""}</div>
    ${tileSpark(s.ys, s.own, s.med, i)}
    <div class="tm">${s.rk ? `<span title="${s.rk.neutral ? "position, highest first — this indicator has no better end" : (lowerBetter(i) ? "rank, lowest first" : "rank, highest first")}">${s.rk.neutral ? "" : "#"}${s.rk.r} of ${s.rk.n}</span>` : `<span class="dim">municipality value</span>`}${s.vsMed != null ? `<span><i class="${cls(s.vsMed, i.key)}">${sign(s.vsMed, x => nf(x, 1))}${s.unit}</i> vs median</span>` : ""}</div>
  </div>`;
}
/* headline row under the area title: the five figures that answer "what kind of area is this" */
function headlineHtml(e) {
  const inds = HL_KEYS.map(k => e.inds.find(i => i.key === k)).filter(i => i && eVal(e, i.key).v != null).slice(0, 5);
  if (!inds.length) return "";
  return `<div class="hl">${inds.map(i => { const s = tileStats(e, i); return `<button class="hlc ${MK.ind === i.key ? "on" : ""}" data-arind="${esc(i.key)}" title="${esc(i.desc || i.label)} — click to focus the chart and map">
    <span>${esc(i.short || i.label)}${s.cur.own ? "" : " °"}</span><b>${fmtOf(i)(s.cur.v)}${moeSpan(i, s.cur.v, moeOf(i, s.cur.own ? e.o : e.kommun))}</b>
    <em>${s.yoy != null ? `<i class="${cls(s.yoy, i.key)}">${sign(s.yoy, x => nf(x, 1))}${s.unit}</i> y/y` : ""}${s.rk ? `${s.yoy != null ? " · " : ""}#${s.rk.r} of ${s.rk.n}` : ""}</em></button>`; }).join("")}</div>`;
}
function multiLine(series, ind, ys) {
  const all = series.flatMap(s => s.pts.map(p => p.v)).filter(v => v != null);
  if (!all.length || ys.length < 2) {
    /* "no history" is the wrong word for a projection: there is nothing to
       observe yet, and that is the point rather than a gap in the data. */
    const oi = outlookOf(ind);
    return `<p class="empty">${oi
      ? `A projection, not a series — one published figure for ${esc(oi.target)}. ` +
        `The projected path is under <b>Charts</b>.`
      : "no history for this indicator"}</p>`;
  }
  const W = 900, H = 240, L0 = 78, R = 16, T0 = 14, B = 26;
  const lo = Math.min(...all), hi = Math.max(...all), sp = (hi - lo) || 1;
  const x = i => L0 + i / (ys.length - 1) * (W - L0 - R), y = v => T0 + (1 - (v - lo) / sp) * (H - T0 - B);
  const ticks = [lo, lo + sp / 2, hi];
  const paths = series.map(s => { const pts = s.pts.map((p, i) => p.v == null ? null : `${x(i).toFixed(1)},${y(p.v).toFixed(1)}`); let d = "", open = false;
    pts.forEach(p => { if (!p) { open = false; return; } d += (open ? "L" : "M") + p; open = true; });
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.w || 2}" ${s.dash ? 'stroke-dasharray="5 4"' : ""}/>` + s.pts.map((p, i) => p.v == null ? "" : `<circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="${s.w ? 3 : 2.4}" fill="${s.color}"><title>${esc(s.name)} ${p.y}: ${fmtOf(ind)(p.v)}</title></circle>`).join(""); }).join("");
  const si = ys.indexOf(MK.year); const selX = si >= 0 ? `<line x1="${x(si).toFixed(1)}" x2="${x(si).toFixed(1)}" y1="${T0}" y2="${H - B}" class="splitline"/>` : "";
  return `<svg class="chart" viewBox="0 0 ${W} ${H}">
      ${ticks.map(t => `<line class="grid" x1="${L0}" x2="${W - R}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="ax" x="${L0 - 6}" y="${(y(t) + 3).toFixed(1)}" text-anchor="end">${fmtOf(ind)(t)}</text>`).join("")}
      ${ys.map((yy, i) => `<text class="ax" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${yy}</text>`).join("")}
      ${selX}${paths}</svg>
    <div class="bleg">${series.map(s => { const last = [...s.pts].reverse().find(p => p.v != null); return `<span><i style="background:${s.color}${s.dash ? ";height:2px" : ""}"></i>${esc(s.name)}${last ? ` <b>${fmtOf(ind)(last.v)}</b> <span class="dim">${last.y}</span>` : ""}</span>`; }).join("")}</div>`;
}
function areaChart(e, ind) {
  const ys = eYears(e, ind.key);
  const series = [{ name: e.name, color: "#1C6B5C", w: 2.6, pts: ys.map(y => ({ y, v: eVal(e, ind.key, y).v })) }];
  if (muniCmp(e, ind.key) && V(e.o, ind.key) != null) series.push({ name: e.kommun.name, color: "#B07A1E", pts: ys.map(y => ({ y, v: V(e.kommun, ind.key, y) })) });
  const medLabel = e.type === "kommun" ? "Sweden, median of kommuner" : e.type === "deso" ? "Median of DeSO in this kommun" : "Sweden, median of RegSO";
  series.push({ name: medLabel, color: "#5C5F52", dash: true, pts: ys.map(y => ({ y, v: median(e.peers.map(p => V(p, ind.key, y))) })) });
  return multiLine(series, ind, ys);
}
function areaCompareTable(e) {
  const ind = curInd(), medLabel = e.type === "kommun" ? "SE median" : e.type === "deso" ? "Kommun median (DeSO)" : "SE median (RegSO)";
  return `<div class="scrollx"><table class="tbl compact" data-sortable><thead><tr><th>Indicator</th><th class="num">${esc(e.type === "kommun" ? e.name : e.type === "deso" ? "DeSO" : "RegSO")}</th>${e.kommun ? `<th class="num">${esc(e.kommun.name)}</th>` : ""}<th class="num">${medLabel}</th><th class="num">Rank</th><th class="num">Δ since first year</th><th>As of</th></tr></thead>
    <tbody>${e.inds.map(i => { const cur = eVal(e, i.key); if (cur.v == null) return "";
      const ys = eYears(e, i.key), y0 = ys[0]; const first = y0 && y0 !== MK.year ? eVal(e, i.key, y0).v : null;
      const d = first == null ? null : isPct(i) ? cur.v - first : (first ? (cur.v / first - 1) * 100 : null);
      const rk = cur.own ? rankOf(e.o, i.key, e.peers) : null; const med = median(e.peers.map(p => V(p, i.key)));
      return `<tr class="clickrow ${i.key === ind.key ? "hi" : ""}" data-arind="${esc(i.key)}"><th><span class="thn">${esc(i.label)} <span class="dim">${esc(i.unit || "")}</span></span><button class="tch" data-go="${chartLink(i.key, e.type, e.code)}" title="Open in Charts">↗</button></th>
        ${fmtCell(i, cur.v, !cur.own, cur.own ? e.o : e.kommun)}${e.kommun ? (muniCmp(e, i.key) ? fmtCell(i, V(e.kommun, i.key), false, e.kommun) : `<td class="num dim" title="different definition at municipality level">n/c</td>`) : ""}${fmtCell(i, med, false)}
        <td class="num" data-v="${rk ? rk.r : ""}">${rk ? `#${rk.r} / ${rk.n}` : "–"}</td>
        <td class="num ${d > 0 ? "good" : d < 0 ? "bad" : ""}" data-v="${d ?? ""}">${d != null ? sign(d, x => nf(x, 1)) + (isPct(i) ? " pp" : " %") + ` <span class="dim">(${y0})</span>` : "–"}</td>
        <td class="dim">${asofText(i)}</td></tr>`; }).join("")}</tbody></table></div>`;
}
function areaSubTable(e) {
  if (!e.subs) return "";
  const keys = Object.keys(e.subs); const sub = keys.includes(AR.sub) ? AR.sub : keys[0]; const list = e.subs[sub];
  const cols = IND.filter(i => (i.levels || []).includes(sub));
  const ind = cols.find(i => i.key === MK.ind) || cols[0];
  const pool = sub === "deso" ? list : AREAS, y0 = yearsForPool(ind.key, pool)[0];
  const rows = list.slice().sort((a, b) => (V(b, ind.key) ?? -1e9) - (V(a, ind.key) ?? -1e9));
  return `<div class="tfilters">${keys.length > 1 ? `<div class="seg">${keys.map(k => `<button class="sg ${k === sub ? "on" : ""}" data-arsub="${k}">${k === "deso" ? `DeSO (${e.subs[k].length})` : `RegSO (${e.subs[k].length})`}</button>`).join("")}</div>` : ""}<span class="hint">sorted by ${esc(ind.label.toLowerCase())} · click a row for its page, ↗ to chart it</span></div>
    <div class="scrollx"><table class="tbl compact wraphead" data-sortable><thead><tr><th>${sub === "deso" ? "DeSO" : "RegSO"}</th><th>Code</th><th class="num">Population</th>
      <th class="num hi">${esc(ind.label)}<br><span class="dim">${esc(ind.unit || "")}</span></th>${y0 && y0 !== MK.year ? `<th class="num">Δ since ${y0}<br><span class="dim">${isPct(ind) ? "pp" : "%"}</span></th>` : ""}
      ${cols.filter(i => i.key !== ind.key).map(i => `<th class="num">${esc(i.label)}<br><span class="dim">${esc(i.unit || "")}</span></th>`).join("")}</tr></thead>
    <tbody>${rows.map(a => `<tr class="clickrow" data-go="${withQ(pageOf(a))}"><th><span class="thn">${esc(a.name)} <span class="go">›</span></span><button class="tch" data-go="${chartLink(ind.key, sub, a.code)}" title="Open in Charts">↗</button></th><td class="dim">${esc(a.code.split("_")[0])}</td><td class="num dim" data-v="${a.pop || 0}">${a.pop != null ? nf(a.pop, 0) : "–"}</td>
      ${fmtCell(ind, V(a, ind.key), false, a)}${y0 && y0 !== MK.year ? deltaCell(a, ind, pool) : ""}${cols.filter(i => i.key !== ind.key).map(i => fmtCell(i, V(a, i.key), false, a)).join("")}</tr>`).join("")}</tbody></table></div>
    <p class="cap">${sub === "deso" ? `${list.length} DeSO areas. Codes only — DeSO has no names.` : `${list.length} RegSO areas; only indicators published below kommun level are listed — the rest take the kommun value (see All indicators).`}</p>`;
}
/* Population and housing structure — the slot the Danish edition filled with the
   BBR building register. Sweden has no open building register with floor area,
   so the area page shows what SCB does publish at DeSO/RegSO level instead:
   the age x sex pyramid, the composition of income, and the tenure mix.
   The kommun is drawn behind each one as a reference outline. */
const DM = () => (D.meta && D.meta.dist) || {};
const shareOf = arr => { const t = (arr || []).reduce((x, y) => x + y, 0); return t ? arr.map(v => v / t * 100) : (arr || []).map(() => 0); };

function pyramidBlock(e) {
  const d = e.o.dist && e.o.dist.age; const meta = DM().age;
  if (!d || !meta) return "";
  const ref = e.kommun && e.kommun.dist && e.kommun.dist.age;
  const bands = meta.bands || [];
  const tot = d.m.reduce((a, b) => a + b, 0) + d.f.reduce((a, b) => a + b, 0);
  const mx = Math.max(1, ...d.m, ...d.f) / (tot || 1) * 100;
  const rs = ref ? (ref.m.reduce((a, b) => a + b, 0) + ref.f.reduce((a, b) => a + b, 0)) : 0;
  const pc = (v) => tot ? v / tot * 100 : 0;
  const rows = bands.map((b, i) => {
    const m = pc(d.m[i]), f = pc(d.f[i]);
    const rm = rs ? ref.m[i] / rs * 100 : null, rf = rs ? ref.f[i] / rs * 100 : null;
    return `<div class="pyrow"><span class="pyl"><i style="width:${(m / mx * 100).toFixed(1)}%"></i>${rm != null ? `<u style="right:${(rm / mx * 100).toFixed(1)}%"></u>` : ""}</span>
      <b>${esc(b.replace(/-$/, "+"))}</b>
      <span class="pyr"><i style="width:${(f / mx * 100).toFixed(1)}%"></i>${rf != null ? `<u style="left:${(rf / mx * 100).toFixed(1)}%"></u>` : ""}</span></div>`;
  }).join("");
  return `<div class="distblk wide"><h4>Age and sex · ${esc(meta.period || "")}</h4>
    <div class="pyhead"><span>men</span><b>${nf(tot, 0)} persons</b><span>women</span></div>
    ${rows}</div>`;
}

function barsBlock(title, labels, values, unitPct, ref) {
  if (!values || !values.length) return "";
  const vals = unitPct ? shareOf(values) : values;
  const refs = ref && ref.length ? (unitPct ? shareOf(ref) : ref) : null;
  const mx = Math.max(1, ...vals, ...(refs || []));
  const rows = labels.map((l, i) => {
    if (!vals[i]) return "";
    const w = vals[i] / mx * 100, r = refs ? refs[i] / mx * 100 : null;
    return `<div class="distrow"><span>${esc(l)}</span><em><i style="width:${w.toFixed(1)}%"></i>${r != null ? `<u style="left:${r.toFixed(1)}%"></u>` : ""}</em><b>${nf(vals[i], unitPct ? 0 : 1)}${unitPct ? " %" : ""}</b></div>`;
  }).join("");
  return `<div class="distblk"><h4>${esc(title)}</h4>${rows}</div>`;
}

/* Self-sufficiency (SCB's own measure: an income above a threshold set from the
   national median) split by where people were born — three bars, not a share of
   one whole, so it gets its own block rather than barsBlock's normalisation. */
function selfsuffBlock(e, meta) {
  const d = e.o.dist && e.o.dist.selfsuff;
  if (!d || !meta.labels) return "";
  const ref = e.kommun && e.kommun.dist && e.kommun.dist.selfsuff;
  const mx = Math.max(1, ...d.filter(v => v != null), ...((ref || []).filter(v => v != null)));
  const rows = meta.labels.map((l, i) => {
    if (d[i] == null) return "";
    const w = d[i] / mx * 100, r = ref && ref[i] != null ? ref[i] / mx * 100 : null;
    return `<div class="distrow"><span>${esc(l)}</span><em><i style="width:${w.toFixed(1)}%"></i>${r != null ? `<u style="left:${r.toFixed(1)}%"></u>` : ""}</em><b>${nf(d[i], 0)} %</b></div>`;
  }).join("");
  return `<div class="distblk"><h4>Self-sufficient 20–64 · ${esc(meta.period || "")}</h4>${rows}</div>`;
}

function distCard(e) {
  const d = e.o.dist; if (!d) return "";
  const meta = DM();
  const kd = e.kommun && e.kommun.dist;
  const inc = meta.income || {}, ten = meta.tenure || {};
  return `<p class="hint" style="margin:0 0 10px">Structure of the population and the housing stock${kd ? ` · tick = ${esc(e.kommun.name)}` : ""}</p>
    <div class="distgrid">
      ${pyramidBlock(e)}
      ${barsBlock(`Income by type · ${inc.period || ""} · kSEK/yr, mean`, inc.labels || [], d.income, false, kd && kd.income)}
      ${barsBlock(`Tenure · ${ten.period || ""}`, ten.labels || [], d.tenure, true, kd && kd.tenure)}
      ${barsBlock(`Employment by industry · ${(meta.industry || {}).period || ""}`, (meta.industry || {}).labels || [], d.industry, true, kd && kd.industry)}
      ${selfsuffBlock(e, meta.selfsuff || {})}
    </div>
    <p class="cap">Källa: SCB — population by age and sex (TAB6574), income structure (TAB6683), dwellings by tenure (${e.type === "kommun" ? "TAB824" : "TAB6638"}), employment by industry (TAB6681, summed from RegSO at kommun level), self-sufficiency (TAB6766). Mean amounts are per person over the whole population, so components most people do not receive read low.</p>`;
}
/* ---------- datasheet shell ----------
   One page for one thing that is not an area: a school, an infrastructure
   project, a public building. Phases 4 and 7 supply the content; the shape is
   fixed here so all three look and behave the same and the routing exists
   before there is anything to route to.

   A sheet is a hash route `#<kind>/<id…>`, and SHEETS is the only place that
   knows which kinds exist — add an entry and the route, the back button and the
   breadcrumb all work. `spec` is what the phase's renderer returns:
     { title, tags:[…], tools:"<html>", tiles:"<html>", body:"<html>",
       mapInit: fn|null, missing:"…" }
   `missing` is what to say when the id is not found — never a blank page, and
   never a zero. */
const SHEETS = {};                 /* kind -> { label, render(parts) -> spec } */
const SH = { kind: null, parts: [] };
const sheetHash = (kind, ...parts) => [kind].concat(parts.map(encodeURIComponent)).join("/");

function vSheet() {
  const def = SHEETS[SH.kind];
  const back = `<div class="back"><button data-go="map">‹ Macro map</button></div>`;
  if (!def) return back + `<div class="card"><p class="empty">Unknown page.</p></div>`;
  let spec;
  try { spec = def.render(SH.parts); } catch (e) { console.warn("sheet " + SH.kind, e); spec = null; }
  if (!spec) return back + `<div class="card"><p class="empty">${esc(def.missing || "Not found.")}</p></div>`;
  if (spec.missing) return back + `<div class="card"><p class="empty">${esc(spec.missing)}</p></div>`;
  if (spec.mapInit) setTimeout(spec.mapInit, 0);
  return `
  <div class="card accent arhead">
    <div class="arid">
      <h2>${esc(spec.title || "")}</h2>
      <div class="artags">${(spec.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join("")}</div>
    </div>
    <div class="tools"><button class="lk" data-back>‹ Back</button>${spec.tools || ""}</div>
    ${spec.tiles || ""}
  </div>
  ${spec.body || ""}`;
}

/* ---------- the Analysis sheet ----------
   Everything this dashboard carries for one spot, and — because a reader
   choosing between two homes wants exactly this — for two spots side by side.
   The comparison is deliberately NOT scored: rows are aligned and each
   difference is coloured by that indicator's own direction, with no overall
   winner, because summing incommensurable indicators into a verdict would be
   this dashboard inventing a judgement it has no basis for. */
const AN = { a: null, b: null, la: "", lb: "", res: {} };
/* the indicator's own format applied to a magnitude, with any sign the format
   would have added stripped — the caller adds exactly one */
const fmtAbs = (i, x) => String(fmtOf(i)(Math.abs(x))).replace(/^[+−-]\s*/, "");
/* parseLocation lives in src/testprop.js and is inlined ahead of this file, so
   it is testable offline with `node --test` and never touches the DOM. */
function anSet(k, text) {
  const err = document.getElementById("anerr-" + k);
  const r = parseLocation(text);
  if (r.error) {
    if (!String(text || "").trim()) { AN[k] = null; delete AN.res[k]; syncHash(); renderKeep(); return; }
    if (err) err.textContent = r.message;
    return;
  }
  if (err) err.textContent = "";
  AN[k] = { lat: +r.lat.toFixed(6), lon: +r.lon.toFixed(6) };
  delete AN.res[k];
  syncHash();
  anResolve(k).then(() => renderKeep());
  renderKeep();
}
const anName = k => (k === "a" ? AN.la : AN.lb) || ((AN.res[k] && AN.res[k].regso && AN.res[k].regso.name)
  || (AN.res[k] && AN.res[k].kommun && AN.res[k].kommun.name) || "");
async function anResolve(k) {
  const pin = AN[k]; if (!pin) { delete AN.res[k]; return; }
  const key = pin.lat + "," + pin.lon;
  if (AN.res[k] && AN.res[k]._key === key) return;
  const r = await locate(pin.lat, pin.lon);
  r._key = key; AN.res[k] = r;
  if (S.view === "analysis") renderKeep();
}
/* the finest entity we actually hold figures for */
function anEntity(k) {
  const r = AN.res[k]; if (!r || r.error) return null;
  const d = r.deso && byDeso[r.deso.code];
  const q = r.regso && byRegso[r.regso.code];
  const m = r.kommun && byCode[r.kommun.code];
  return { deso: d || null, regso: q || null, kommun: m || null };
}
const AN_GROUPS = ["Demographics", "Outlook", "Safety", "Schools", "Climate", "Growth signals", "Income & jobs",
                   "Housing stock", "Rents", "Prices & market", "Area quality"];
/* one indicator value for a pin, from the finest level that has it */
function anVal(k, key) {
  const e = anEntity(k); if (!e) return null;
  for (const [lvl, o] of [["DeSO", e.deso], ["RegSO", e.regso], ["kommun", e.kommun]]) {
    if (!o) continue;
    const v = V(o, key);
    if (v != null) return { v, lvl, own: lvl !== "kommun" };
    if (noInherit(indOf(key))) return null;
  }
  return null;
}
function anRow(i) {
  const a = anVal("a", i.key), b = AN.b ? anVal("b", i.key) : null;
  if (!a && !b) return "";
  const f = fmtOf(i);
  const d = (a && b) ? a.v - b.v : null;
  const dcls = d == null ? "" : cls(d, i.key);
  /* A signed format (signpct1) already prints its own sign, so wrapping it in
     sign() again produced "++6,8 %". The difference is formatted on its
     magnitude and signed exactly once. */
  const dTxt = d == null ? "" : sign(d, x => fmtAbs(i, x));
  return `<tr><th>${esc(i.short || i.label)}<span class="dim"> ${esc(i.unit || "")}</span></th>
    <td class="num">${a ? f(a.v) + (a.lvl === "kommun" ? " °" : "") : "–"}</td>
    ${AN.b ? `<td class="num">${b ? f(b.v) + (b.lvl === "kommun" ? " °" : "") : "–"}</td>
    <td class="num"><i class="${dcls}">${dTxt}</i></td>` : ""}
  </tr>`;
}
function anWhere(k) {
  const r = AN.res[k];
  if (!r) return `<p class="empty">Locating…</p>`;
  if (r.error) return `<p class="empty">${esc(r.error)}</p>`;
  const bits = [["Kommun", r.kommun && r.kommun.name], ["RegSO", r.regso && r.regso.name],
                ["DeSO", r.deso && r.deso.code]];
  return `<div class="anwhere">${bits.map(([l, v]) => v
    ? `<span><em>${esc(l)}</em>${esc(v)}</span>` : "").join("")}</div>`;
}
function anSchoolsNear(k, n) {
  const pin = AN[k], r = AN.res[k];
  if (!pin || !r || !r.kommun) return [];
  /* neighbouring kommuner matter: the nearest school to a pin near a boundary is
     often in the next kommun, so every kommun whose bbox is within ~8 km is read */
  const near = [];
  for (const code in SCH_IDX) {
    const bb = SCH_IDX[code].bbox;
    if (!bb) continue;
    const dLat = Math.max(0, Math.max(bb[0] - pin.lat, pin.lat - bb[2]));
    const dLon = Math.max(0, Math.max(bb[1] - pin.lon, pin.lon - bb[3]));
    if (havM(pin.lat, pin.lon, pin.lat + dLat, pin.lon + dLon) < 8000) near.push(code);
  }
  near.forEach(schLoad);
  const out = [];
  for (const code of near) {
    if (!Array.isArray(SCH[code])) continue;
    for (const s of SCH[code]) out.push({ s, m: havM(pin.lat, pin.lon, s.lat, s.lon) });
  }
  out.sort((x, y) => x.m - y.m);
  return out.slice(0, n || 5);
}
function anPinBox(k) {
  const pin = AN[k];
  const lab = k === "a" ? AN.la : AN.lb;
  return `<div class="anpin">
    <label>${k === "a" ? "Pin A" : "Pin B"}</label>
    <input id="anin-${k}" class="indsel anin" placeholder="Paste a Google Maps link or 59.33258, 18.06490"
      value="${esc(pin ? pin.lat + ", " + pin.lon : "")}" autocomplete="off">
    <input id="anlab-${k}" class="indsel anlab" placeholder="label (optional)" value="${esc(lab)}" autocomplete="off">
    ${pin ? `<button class="lk mini" data-anclear="${k}">clear</button>` : ""}
    <span class="anerr" id="anerr-${k}"></span>
  </div>`;
}
/* The Climate block on the Analysis sheet. Kept apart from the generic
   indicator table because every climate figure needs its horizon or scenario in
   the label, and because "Not mapped" has to read as a sentence rather than a
   dash in a column. */
const CLIM_KEYS = ["flood100", "flood200", "floodBHF", "coast20", "coast30",
                   "sea2100_85", "sea2100_45", "landslide"];
function anClimate(k) {
  const e = anEntity(k); if (!e) return "";
  const rows = CLIM_KEYS.map(key => {
    const i = indOf(key); if (!i) return "";
    const got = anVal(k, key);
    const txt = got ? fmtOf(i)(got.v) : `<span class="dim">Not mapped</span>`;
    return `<tr><th>${esc(i.label)}</th><td class="num">${txt}</td></tr>`;
  }).join("");
  const cb = e.kommun && e.kommun.cloudburst_mapped;
  return `<table class="tbl compact"><tbody>${rows}
    ${cb != null ? `<tr><th>Kommun's own cloudburst mapping</th><td class="num">${cb ? "yes" : "no"}</td></tr>` : ""}
    </tbody></table>
    <p class="cap"><b>Screening indicators, not a property assessment.</b> Each is the share of the
    surrounding area's land inside a published hazard polygon — it says nothing about this
    building, its floor level or its protection. <b>"Not mapped" is not zero:</b> MCF has mapped
    about 80 watercourses and SGU's landslide survey covers part of the country, so an area
    nobody surveyed has no value rather than a clean bill of health.</p>
    <p class="cap">Källa: MCF (översvämningskartering, kustöversvämning, skyfallsöversikt),
    SMHI (framtida medelvattenstånd, IPCC AR6/SROCC), SGU (aktsamhetsområden skred, CC0).</p>`;
}

function vAnalysis() {
  setTimeout(anMapInit, 0);
  const inds = IND.filter(i => AN_GROUPS.includes(i.group));
  const groups = AN_GROUPS.filter(g => inds.some(i => i.group === g));
  const both = !!(AN.a && AN.b);
  const head = `<tr><th>Indicator</th><th class="num">${esc(anName("a") || "Pin A")}</th>${
    both ? `<th class="num">${esc(anName("b") || "Pin B")}</th><th class="num">A − B</th>` : ""}</tr>`;
  const sch = AN.a ? anSchoolsNear("a", 5) : [];
  return `
  <div class="card accent arhead">
    <div class="arid"><h2>Test property</h2>
      <div class="artags"><span class="tag">point-in-polygon on our own boundaries</span>
      ${AN.a ? `<span class="tag">${esc(AN.a.lat.toFixed(5))}, ${esc(AN.a.lon.toFixed(5))}</span>` : ""}</div>
    </div>
    ${anPinBox("a")}
    ${anPinBox("b")}
    ${AN.a ? `<div class="tools"><a class="lk primary" href="${esc(listingsUrl(AN.a.lat, AN.a.lon, 1000))}">What is for rent near Pin A ↗</a>${
      AN.b ? `<a class="lk" href="${esc(listingsUrl(AN.b.lat, AN.b.lon, 1000))}">…near Pin B ↗</a>` : ""}
      <span class="cap">Live third-party adverts, through the listings gateway. An advertised rent is not a contract rent and is not comparable with the SCB rent statistics on this page.</span></div>` : ""}
    <p class="cap anpriv"><b>Nothing leaves your browser.</b> The link is parsed here, the point is tested
      against boundary files this page already serves, and the coordinate lives only in this page's
      address bar — the part after the # is never sent to a server. A short goo.gl link cannot be
      read without following it, so it is refused rather than resolved on your behalf.</p>
  </div>
  ${!AN.a ? `<div class="card"><p class="empty">Paste a Google Maps link above — right-click a spot in Google Maps and copy the coordinates it offers, or copy the full URL from the address bar.</p></div>` : `
  <div class="grid-2">
    <div class="card"><h3>Where it is</h3>${anWhere("a")}
      ${AN.b ? `<div class="ansep">Pin B</div>${anWhere("b")}` : ""}
      <div class="mapwrap anmap"><div id="anmapel"></div></div>
      <p class="cap">Rings simplified to about 40 m for this lookup — enough to say which RegSO a building is in, not a cadastral boundary.</p></div>
    <div class="card"><h3>Nearest schools with year 9</h3>
      ${sch.length ? `<table class="tbl compact"><thead><tr><th>School</th><th class="num">Distance</th><th class="num">Merit</th></tr></thead><tbody>
      ${sch.map(({ s, m }) => `<tr><th><button class="lk mini" data-go="school/${esc(s.code)}">${esc(s.name)}</button></th>
        <td class="num">${m < 1000 ? nf(Math.round(m / 10) * 10, 0) + " m" : nf(m / 1000, 1) + " km"}</td>
        <td class="num">${s.merit != null ? nf(s.merit, 1) : "–"}</td></tr>`).join("")}
      </tbody></table><p class="cap">Straight-line distance, not walking distance. Neighbouring kommuner are included — the nearest school to a pin near a boundary is often across it.</p>`
      : `<p class="empty">Loading schools near the pin…</p>`}
    </div>
  </div>
  <div class="grid-2">
    <div class="card"><h3>Climate risk${AN.b ? " — Pin A" : ""}</h3>${anClimate("a")}</div>
    ${AN.b ? `<div class="card"><h3>Climate risk — Pin B</h3>${anClimate("b")}</div>`
           : `<div class="card"><h3>How to read this page</h3>
      <p class="cap">Every figure is the published number for the area the pin falls in — DeSO where
      the statistic exists at that level, otherwise RegSO, otherwise the kommun, marked °. Nothing is
      interpolated to the point itself, and nothing is modelled: if a source publishes no figure for
      an area, the row shows a dash.</p>
      <p class="cap">Add a second pin above to compare two spots side by side.</p></div>`}
  </div>
  <div class="card"><h3>${both ? "Side by side" : "What this dashboard knows about the spot"}</h3>
    ${both ? `<p class="cap">Aligned rows, each difference coloured by that indicator's own direction. <b>There is no overall winner</b> — adding up indicators that measure different things would be this dashboard inventing a judgement rather than reporting figures.</p>` : ""}
    ${groups.map(g => `<h4 class="angrp">${esc(g)}</h4>
      <table class="tbl compact"><thead>${head}</thead><tbody>
      ${inds.filter(i => i.group === g).map(anRow).join("")}</tbody></table>`).join("")}
    <p class="cap">° = the kommun's figure, where no finer statistic exists. A dash means the source publishes nothing for that area — never a zero.</p>
  </div>`}`;
}
function anMapInit() {
  const el = document.getElementById("anmapel");
  if (!el || typeof L === "undefined" || !AN.a) return;
  if (LF.anmap) { try { LF.anmap.remove(); } catch (e) {} LF.anmap = null; }
  const m = L.map(el, { center: [AN.a.lat, AN.a.lon], zoom: 13, scrollWheelZoom: false });
  LF.anmap = m;
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, detectRetina: true,
    className: "basemap", attribution: '© OpenStreetMap contributors' }).addTo(m);
  const pins = [["a", AN.a, "#1C6B5C"], ["b", AN.b, "#B0331B"]].filter(x => x[1]);
  for (const [k, pin, col] of pins) {
    L.circleMarker([pin.lat, pin.lon], { radius: 8, color: col, weight: 3,
      fillColor: "#fff", fillOpacity: .9 }).addTo(m)
      .bindPopup(`<b>${esc(anName(k) || (k === "a" ? "Pin A" : "Pin B"))}</b><br>${pin.lat.toFixed(5)}, ${pin.lon.toFixed(5)}`);
    /* dashed rings at 500 m and 1 km, non-interactive — a sense of scale, not a claim */
    for (const r of [500, 1000]) {
      L.circle([pin.lat, pin.lon], { radius: r, color: col, weight: 1, opacity: .5,
        dashArray: "4,4", fill: false, interactive: false }).addTo(m);
    }
  }
  if (pins.length === 2) {
    m.fitBounds(L.latLngBounds(pins.map(x => [x[1].lat, x[1].lon])), { padding: [50, 50] });
  }
}

function vArea() {
  const e = areaEntity();
  if (!e) return `<div class="back"><button data-go="map">‹ Macro map</button></div><div class="card"><p class="empty">Unknown area.</p></div>`;
  const ind = curInd();
  setTimeout(arMapInit, 0);
  const groups = GROUP_ORDER.filter(gn => e.inds.some(i => (i.group || "Other") === gn && eVal(e, i.key).v != null));
  const grp = groups.includes(AR.group) ? AR.group : groups[0];
  const tiles = e.inds.filter(i => (i.group || "Other") === grp && eVal(e, i.key).v != null);
  const mapHash = e.type === "kommun" ? `map/${e.code}` : e.type === "deso" ? `map/${e.o.kommun}/deso` : `map/${e.o.kommun}`;
  /* lower panel: the full indicator list, the structure cards and the sub-areas as tabs of one card */
  const tabs = [["ind", "All indicators"]].concat(e.o.dist ? [["dist", "Population & housing structure"]] : []).concat(e.subs ? [["sub", e.subs.deso ? (e.subs.regso ? "RegSO & DeSO" : "DeSO") : "RegSO"]] : []);
  const tab = tabs.some(t => t[0] === AR.tab) ? AR.tab : "ind";
  const hint = `y/y = change from the previous year · "vs median" = against the median of ${e.peerLabel} (pp for shares, % otherwise) · #rank among ${e.peerLabel}, #1 = highest value · ° = municipality value where no ${e.type === "regso" ? "postal-code" : "finer"} statistic exists${e.type === "deso" ? " · n/c = not comparable (different definition at municipality level)" : ""}. Solid line = ${e.name}, dashed = median of ${e.peerLabel}. Click a tile to focus the chart and map, ↗ to open it in Charts.`;
  return `
  <div class="card accent arhead">
    <div class="arid">
      <h2>${esc(e.name)}</h2>
      <div class="artags"><span class="tag">${esc(e.typeLabel)}</span><span class="tag">code ${esc(e.code)}</span>${e.o.pop != null ? `<span class="tag">${nf(e.o.pop, 0)} inhabitants</span>` : ""}${e.type === "kommun" ? `<span class="tag">${e.ctx.length} postal codes</span>` : ""}${e.type === "regso" && e.o.codes && e.o.codes.length > 1 ? `<span class="tag">merged codes ${esc(e.o.codes.join(", "))}</span>` : ""}</div>
    </div>
    <div class="tools">${yearSelect()}<button class="lk" data-go="${withQ(mapHash)}">Show on map</button><button class="lk" data-go="${chartLink(MK.ind, e.type, e.code)}">↗ Chart</button>${e.type !== "deso" && desoAvail(e.type === "kommun" ? e.code : e.o.kommun) ? `<button class="lk primary" data-go="map/${e.type === "kommun" ? e.code : e.o.kommun}/deso?ind=${MK.ind}">DeSO ›</button>` : ""}</div>
    ${headlineHtml(e)}
    ${usoLine(e.o)}${outlookLine(e.type === "kommun" ? e.o : e.kommun, e.type !== "kommun")}
  </div>
  <div class="card">
    <div class="card-head"><h3>Key figures${MK.year !== LATEST ? " · " + MK.year : ""} <span class="hq" title="${esc(hint)}">ⓘ</span></h3>
      <div class="seg">${groups.map(g => `<button class="sg ${g === grp ? "on" : ""}" data-argroup="${esc(g)}">${esc(g)}</button>`).join("")}</div></div>
    <div class="hero wrap">${tiles.map(i => tileHtml(e, i, i.key === ind.key)).join("") || `<div><span>no data</span></div>`}</div>
  </div>
  <div class="grid-2">
    <div class="card">
      <div class="card-head"><h3>Trend — ${esc(ind.label)}</h3><span class="hint">${esc(ind.unit || "")} · same sub-period each year</span></div>
      ${areaChart(e, ind)}
      <p class="cap">${esc(ind.desc || "")} <span class="dim">${esc(ind.source || "")}</span>${ind.warn ? `<br>⚠ ${esc(ind.warn)}` : ""}</p>
    </div>
    <div class="card">
      <div class="card-head"><h3>${esc(ind.short || ind.label)} — ${(() => { const mm = arMapMode(e, ind); return e.type === "kommun" ? (mm.kommuneLevel ? esc(e.name) + " among kommuner" : esc(e.name) + " by " + (mm.useQ ? "quarter" : "postal code")) : "neighbours"; })()}</h3><span class="hint">${(() => { const mm = arMapMode(e, ind); return mm.kommuneLevel ? "municipality-level indicator · click a neighbour to open it" : e.type === "kommun" ? "click an area to open it" : "click a neighbour to open it"; })()}</span></div>
      <div class="mapwrap"><div id="armap"></div><div class="maplegend small" id="arlegend"></div></div>
    </div>
  </div>
  <div class="card">
    <div class="card-head"><div class="seg tabs">${tabs.map(([k, l]) => `<button class="sg ${k === tab ? "on" : ""}" data-artab="${k}">${esc(l)}</button>`).join("")}</div><span class="hint">${tab === "ind" ? "click a row to focus the chart, ↗ to chart it" : tab === "bbr" ? "current dwellings from the building register" : "click a row for its page"}</span></div>
    ${tab === "ind" ? areaCompareTable(e) : tab === "dist" ? distCard(e) : areaSubTable(e)}
  </div>
  ${srcNote()}`;
}
function arMapMode(e, ind) {
  /* what the small map shows: the kommun's DeSO, its RegSO, or (for a kommun-level
     indicator on a municipality page) the municipality among all others */
  const useQ = e.type === "deso" || (e.type === "kommun" && e.subs && e.subs.deso && AR.sub !== "regso");
  const subInds = useQ ? IND_DESO : IND; const sind = subInds.find(i => i.key === ind.key) || null;
  const kommuneLevel = e.type === "kommun" && !useQ && !!sind && sind.level !== "regso";
  return { useQ, sind, kommuneLevel };
}
function arMapInit() {
  const el = document.getElementById("armap"); if (!el || typeof L === "undefined") return;
  const e = areaEntity(); if (!e) return;
  if (LF.amap) { try { LF.amap.remove(); } catch (x) {} LF.amap = null; }
  const map = L.map(el, { center: [62.5, 16.5], zoom: 5, scrollWheelZoom: true, zoomSnap: 0.5, zoomDelta: 1, wheelPxPerZoomLevel: 30, wheelDebounceTime: 20, attributionControl: false });
  LF.amap = map;
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, maxNativeZoom: 19, detectRetina: true, className: "basemap" }).addTo(map);
  const ind = curInd(); const { useQ, sind, kommuneLevel } = arMapMode(e, ind);
  const ctx = e.type === "kommun" ? (useQ ? desoAreas(e.code) : kommuneLevel ? AREAS : e.ctx) : e.ctx;
  const vk = a => { if (!sind) return null; if (kommuneLevel) return V(byCode[a.kommun], sind.key); return V(a, sind.key) ?? (useQ ? null : V(byCode[a.kommun], sind.key)); };
  const sc = kommuneLevel ? scaleOf(MUNI, m => V(m, sind.key), null, sind) : scaleOf(ctx.filter(a => sind && V(a, sind.key) != null), vk, null, sind);
  const own = e.type === "kommun" ? e.ctx : e.own;
  const outline = e.type !== "kommun";
  ctx.forEach(a => {
    const isOwn = own.includes(a); const t = sc.t(vk(a));
    const p = L.polygon(a.rings, { color: isOwn && (outline || kommuneLevel) ? "#141C18" : "#FFFFFF", smoothFactor: 0.25, weight: isOwn && outline ? 2.6 : isOwn && kommuneLevel ? 1.2 : kommuneLevel ? 1.5 : useQ ? 0.4 : 0.8,
      fillColor: t == null ? "#C4CBC4" : (sc.color ? sc.color(t) : mkShade(t, ind.key, sc)), fillOpacity: isOwn ? .85 : kommuneLevel ? .35 : .45 });
    const v = vk(a); const native = kommuneLevel || (sind && V(a, sind.key) != null);
    const label = kommuneLevel ? (byCode[a.kommun] || {}).name : a.name;
    p.bindTooltip(`<b>${esc(label)}</b>${v != null ? `<br>${esc(sind.short || sind.label)}: ${fmtOf(sind)(v)}${native ? "" : " °"}` : ""}`);
    if (!isOwn) { p.on("click", () => go(withQ(kommuneLevel ? pageOf(byCode[a.kommun]) : pageOf(a)))); p.on("mouseover", () => p.setStyle({ weight: 2.2, color: "#141C18" })); p.on("mouseout", () => p.setStyle({ weight: kommuneLevel ? 0.6 : 1, color: "#FFFFFF" })); }
    else if (e.type === "kommun" && !kommuneLevel) { p.on("click", () => go(withQ(pageOf(a)))); }
    p.addTo(map);
  });
  if (sind) setLegend("arlegend", sc, sind, ind.key, kommuneLevel ? "kommuner" : useQ ? "DeSO" : "RegSO");
  const b = boundsOf(own); if (b) map.fitBounds(b, { padding: kommuneLevel ? [90, 90] : e.type === "kommun" ? [10, 10] : [70, 70], maxZoom: kommuneLevel ? 9 : 13 });
}

/* ---------- Leaflet layers (macro map) ---------- */
function lfPopup(a, muni) {
  /* two levels: the selected indicator big + four headline figures and the ways onward; every value behind "all values" */
  const row = (i, v, own, o) => `<span class="lfrow"><span>${esc(i.short || i.label)}</span><b>${fmtOf(i)(v)}${own ? "" : " °"}${moeSpan(i, v, moeOf(i, o))}</b></span>`;
  const LI = curInds(); const ind = curInd(); const isQ = a.regso != null;
  const val = i => { const v = V(a, i.key); if (v != null) return { v, own: true }; if (!noInherit(i) && muni && V(muni, i.key) != null) return { v: V(muni, i.key), own: false }; return null; };
  const peers = isQ ? desoAreas(a.kommun) : AREAS; const sel = val(ind);
  const rk = sel ? (sel.own ? rankOf(a, ind.key, peers) : (muni ? rankOf(muni, ind.key, MUNI) : null)) : null;
  const keys = HL_KEYS.filter(k => k !== ind.key).map(k => LI.find(i => i.key === k)).filter(Boolean).map(i => ({ i, x: val(i) })).filter(x => x.x).slice(0, 4);
  const native = LI.filter(i => V(a, i.key) != null).map(i => row(i, V(a, i.key), true, a)).join("");
  const inherited = LI.filter(i => !noInherit(i) && V(a, i.key) == null && muni && V(muni, i.key) != null).map(i => row(i, V(muni, i.key), false, muni)).join("");
  const n = LI.filter(i => val(i)).length; const type = isQ ? "deso" : "regso", code = a.code;
  return `<div class="lfpop"><b>${esc(a.name)}</b>${MK.year !== LATEST ? ` <span class="tag">${MK.year}</span>` : ""}
    <span class="dim">${a.regso && byRegso[a.regso] ? esc(byRegso[a.regso].name) + " · " : ""}${muni ? esc(muni.name) : ""}${a.pop != null ? " · " + nf(a.pop, 0) + " inhabitants" : ""}</span>
    ${sel ? `<div class="lfbig"><span>${esc(ind.label)}${sel.own ? "" : " °"}</span><b>${fmtOf(ind)(sel.v)}${moeSpan(ind, sel.v, moeOf(ind, sel.own ? a : muni))}</b><em>${rk ? `#${rk.r} of ${rk.n} ${sel.own ? (isQ ? "DeSO" : "RegSO") : "kommuner"}` : ""}</em></div>` : `<div class="lfbig dim"><span>${esc(ind.label)}</span><b>–</b></div>`}
    ${keys.length ? `<div class="lfkey">${keys.map(({ i, x }) => `<div><span>${esc(i.short || i.label)}${x.own ? "" : " °"}</span><b>${fmtOf(i)(x.v)}${moeSpan(i, x.v, moeOf(i, x.own ? a : muni))}</b></div>`).join("")}</div>` : ""}
    ${usoLine(a)}${outlookLine(muni, true)}
    <span class="lfact"><button class="lk mini primary" data-go="${withQ(pageOf(a))}">Open page ›</button>${muni && !MK.kommun ? `<button class="lk mini" data-go="map/${muni.code}?ind=${MK.ind}">Zoom to ${esc(muni.name)}</button>` : ""}${muni && desoAvail(muni.code) && !desoMode() ? `<button class="lk mini" data-go="map/${muni.code}/deso?ind=${MK.ind}">DeSO ›</button>` : ""}<button class="lk mini" data-go="${chartLink(ind.key, type, code)}">↗ Chart</button></span>
    <details class="lfmore"><summary>All ${n} values</summary>
    ${native ? `<span class="lfsec">${isQ ? "DeSO" : "RegSO"}</span><div class="lfrows">${native}</div>` : ""}
    ${inherited ? `<span class="lfsec">Kommun °</span><div class="lfrows">${inherited}</div>` : ""}</details></div>`;
}
/* which sub-area (RegSO / DeSO) of the drilled kommun a point lies in — ray casting on the rings */
function pip(pt, ring) { let ins = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const yi = ring[i][0], xi = ring[i][1], yj = ring[j][0], xj = ring[j][1]; if ((yi > pt[0]) !== (yj > pt[0]) && pt[1] < (xj - xi) * (pt[0] - yi) / (yj - yi) + xi) ins = !ins; } return ins; }
function areaAt(lat, lon) { return muniAreas(MK.kommun).find(a => (a.rings || []).some(r => pip([lat, lon], r))) || null; }
/* ---------- DeSO: the on-demand sub-level ---------- */
/* DeSO polygons and values live in dist/deso/<kommun>.json so the page does not
   carry 6 160 areas it will mostly never draw. The file is fetched once per
   kommun, cached, and the view re-renders when it lands. Fetch needs http, so
   from a file:// URL the layer stays unavailable and the toggle says so. */
function loadDeso(code, then) {
  if (!code || DESO[code]) { if (then) then(); return; }
  if (!desoAvail(code)) { if (then) then(); return; }
  if (LF.desoPending === code) return;
  LF.desoPending = code;
  fetch(DESO_IDX[code].file)
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(d => {
      DESO[code] = d.areas || [];
      DESO[code].forEach(a => byDeso[a.code] = a);
      LF.desoPending = null;
      if (then) then(); else renderKeep();
    })
    .catch(() => { LF.desoPending = null; LF.desoFailed = true; if (then) then(); else renderKeep(); });
}
/* the RegSO | DeSO switch shown once a kommun is drilled into */
function subToggle() {
  if (!MK.kommun) return "";
  const n = (DESO_IDX[MK.kommun] || {}).n || 0;
  if (!n) return "";
  const busy = LF.desoPending === MK.kommun;
  return `<div class="seg" role="group" aria-label="Sub-level">
    <button class="${MK.sub === "regso" ? "on" : ""}" data-sub="regso">RegSO</button>
    <button class="${MK.sub === "deso" ? "on" : ""}" data-sub="deso"${busy ? " disabled" : ""}>DeSO${busy ? " …" : ` (${n})`}</button>
  </div>`;
}


function lfLayers() {
  if (!LF.map) return;
  const ind = curInd();
  /* Three levels, and only one of them is ever drawn:
       no kommun open  -> the 290 kommuner
       kommun open     -> its RegSO
       kommun open + DeSO toggle -> its DeSO
     The Danish edition drew postal codes at every zoom and tinted them with the
     municipality value when they had none of their own; here that meant 3 363
     RegSO polygons on the national map and a click that opened a RegSO instead
     of the kommun under the cursor. Zoom no longer changes the level — drilling
     in does, which is also what the breadcrumb says is happening. */
  const drill = !!MK.kommun;
  const sub = drill && desoMode() ? "deso" : drill ? "regso" : null;
  const shapes = !drill ? MUNI : muniAreas(MK.kommun);
  const hasOwn = !sub || (ind.levels || []).includes(sub);
  LF.level = (sub || "national") + (MK.kommun || "");
  if (LF.areaG) LF.map.removeLayer(LF.areaG);
  if (LF.labG) LF.map.removeLayer(LF.labG);
  const vk = o => V(o, ind.key);
  const scalePool = !drill ? MUNI : shapes.filter(a => hasOwn && vk(a) != null);
  const sc = scaleOf(scalePool.length ? scalePool : MUNI, vk, null, ind);
  const polys = [];
  shapes.forEach(a => {
    const m = drill ? byCode[a.kommun] : a;
    /* falling back to the kommun's value tints every sub-area with it; an
       indicator that refuses inheritance (the police designation) must stay
       blank instead, or the whole city reads as designated */
    const src = !drill ? a : (hasOwn && vk(a) != null ? a : (noInherit(ind) ? null : m));
    const t = src ? sc.t(vk(src)) : null;
    /* thinner the finer the level: a 1.5 px stroke that reads as a border between
       kommuner turns into a white haze over a kommun's worth of DeSO. */
    const w = !drill ? 1.5 : sub === "deso" ? 0.4 : 0.8;
    const fill = t == null ? "#C4CBC4" : (sc.color ? sc.color(t) : mkShade(t, ind.key, sc));
    /* smoothFactor is Leaflet dropping vertices within N screen pixels. At the
       default 1 it undoes the simplification budget the geometry was built to,
       and the angularity shows at close zoom. */
    const p = L.polygon(a.rings, { color: "#FFFFFF", weight: w, fillColor: fill, fillOpacity: .72, smoothFactor: 0.25 });
    p.bindPopup(() => drill ? lfPopup(a, m) : lfKommunPopup(a), { maxWidth: 560, maxHeight: 560, autoPanPadding: [24, 24] });
    p.on("mouseover", () => p.setStyle({ weight: Math.max(2.2, w * 2), color: "#141C18" }));
    p.on("mouseout", () => p.setStyle({ weight: w, color: "#FFFFFF" }));
    polys.push(p);
  });
  LF.areaG = L.layerGroup(polys).addTo(LF.map);
  LF.ctx = { shapes, sc, sub, drill, hasOwn, ind, vk };
  lfLabels();
  setLegend("maplegend", sc, ind, ind.key,
    !drill ? "kommuner · open one for its RegSO"
           : sub === "deso" ? "DeSO" : (hasOwn ? "RegSO" : "RegSO · ° all take the kommun value"));
  if (LF.ownG) { LF.map.removeLayer(LF.ownG); LF.ownG = null; }
  if (MK.own && D.portfolio) {
    const marks = D.portfolio.properties.filter(p => p.lat != null).map(p => {
      const units = p.units || 20, pressure = ((p.vac || 0) + (p.notice || 0)) / Math.max(1, units);
      const m = L.circleMarker([p.lat, p.lon], { radius: Math.max(5, Math.min(11, Math.sqrt(units) * 1.15)), color: "#141C18", weight: 2, fillColor: pressure > .12 ? "#B5391F" : pressure > .06 ? "#D9A32E" : "#1C6B5C", fillOpacity: .92 });
      m.bindTooltip(`<b>${esc(p.name)}</b><br>${esc(p.address || "")}<br>${units} units · ${p.vac || 0} vacant · ${p.notice || 0} under notice`);
      return m;
    });
    LF.ownG = L.layerGroup(marks).addTo(LF.map);
  }
}

/* the national map's popup: a kommun, with the way into its sub-areas */
/* ---------- the Outlook line ----------
   One line wherever an area is described: what SCB's projection says about it.
   It is always labelled as a projection and always carries the publication
   date, because it is the only number on the page that is about the future.
   An area below kommun level shows its kommun's figure marked °, since SCB
   does not publish the projection below kommun. */
function outlookLine(m, inherited) {
  if (!m) return "";
  const g = indOf("fc_growth"), a = indOf("fc_abs"), g5 = indOf("fc_growth_5y");
  if (!g || m[g.key] == null) return "";
  const oi = outlookOf(g) || {};
  const mark = inherited ? " \u00b0" : "";
  const part = (i, lab) => i && m[i.key] != null
    ? `<span><em>${esc(lab)}</em>${fmtOf(i)(m[i.key])}</span>` : "";
  return `<div class="fcline" title="${esc(g.warn || "")}">
    <span class="fctag">Outlook${mark}</span>
    ${part(g, "2026\u21922040 ")}${part(g5, "to 2031 ")}${part(a, "population 2040 ")}
    <span class="fcsrc">SCB trend projection, published ${esc((oi.published || "2024-06-11"))}</span>
  </div>`;
}

/* ---------- police-designated vulnerable area ----------
   A flag, not a score. It says the police have designated part of this area,
   which class, and when — and nothing about the people who live there. An area
   with no designation shows no line at all rather than "0 %", because "not
   designated" and "designated but small" are different statements. */
const USO_LABEL = { utsatt: "Utsatt område", sarskilt: "Särskilt utsatt område" };
function usoLine(o) {
  if (!o || o.vulnerable_area_share == null) return "";
  const cls = o.vulnerable_area_share_class || "utsatt";
  const i = indOf("vulnerable_area_share");
  return `<div class="usoline ${esc(cls)}" title="${esc((i && i.warn) || "")}">
    <span class="usotag">${esc(USO_LABEL[cls] || cls)}</span>
    <span>${nf(o.vulnerable_area_share, 1)} % of the area</span>
    <span class="usosrc">Police-designated vulnerable area (Dec 2025)</span></div>`;
}

function lfKommunPopup(m) {
  const LI = curInds(), ind = curInd();
  const row = (i, v, o) => `<span class="lfrow"><span>${esc(i.short || i.label)}</span><b>${fmtOf(i)(v)}${moeSpan(i, v, moeOf(i, o))}</b></span>`;
  const sel = V(m, ind.key);
  const rk = sel != null ? rankOf(m, ind.key, MUNI) : null;
  const keys = HL_KEYS.filter(k => k !== ind.key).map(k => LI.find(i => i.key === k))
    .filter(i => i && V(m, i.key) != null).slice(0, 4);
  const all = LI.filter(i => V(m, i.key) != null);
  const n = (DESO_IDX[m.code] || {}).n || 0;
  return `<div class="lfpop"><b>${esc(m.name)}</b>${MK.year !== LATEST ? ` <span class="tag">${MK.year}</span>` : ""}
    <span class="dim">${esc(lanName(m.lan))}${m.pop != null ? " · " + nf(m.pop, 0) + " inhabitants" : ""} · ${AREAS.filter(a => a.kommun === m.code).length} RegSO${n ? ` · ${n} DeSO` : ""}</span>
    ${sel != null ? `<div class="lfbig"><span>${esc(ind.label)}</span><b>${fmtOf(ind)(sel)}${moeSpan(ind, sel, moeOf(ind, m))}</b><em>${rk ? `#${rk.r} of ${rk.n} kommuner` : ""}</em></div>`
                  : `<div class="lfbig dim"><span>${esc(ind.label)}</span><b>–</b></div>`}
    ${keys.length ? `<div class="lfkey">${keys.map(i => `<div><span>${esc(i.short || i.label)}</span><b>${fmtOf(i)(V(m, i.key))}${moeSpan(i, V(m, i.key), moeOf(i, m))}</b></div>`).join("")}</div>` : ""}
    ${usoLine(m)}${outlookLine(m, false)}
    <span class="lfact"><button class="lk mini primary" data-go="${withQ(`area/kommun/${m.code}`)}">Open page ›</button><button class="lk mini" data-go="${withQ(`map/${m.code}`)}">RegSO ›</button>${n ? `<button class="lk mini" data-go="${withQ(`map/${m.code}/deso`)}">DeSO ›</button>` : ""}<button class="lk mini" data-go="${chartLink(ind.key, "kommun", m.code)}">↗ Chart</button></span>
    <details class="lfmore"><summary>All ${all.length} values</summary>
    <div class="lfrows">${all.map(i => row(i, V(m, i.key), m)).join("")}</div></details></div>`;
}

function lfLabels() {
  /* labels are rebuilt on every zoom step: a name is shown only when its polygon is wide enough on screen */
  if (!LF.map || !LF.ctx) return;
  const { shapes, sc, sub, drill, hasOwn, ind, vk } = LF.ctx; const zoom = LF.map.getZoom(); const labs = [];
  if (LF.labG) LF.map.removeLayer(LF.labG);
  const px = ring => { const xs = [], ys = []; ring.forEach(q => { const c = LF.map.latLngToContainerPoint(q); xs.push(c.x); ys.push(c.y); }); return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]; };
  if (drill) {
    /* sub-areas: a value only where the polygon is clearly wide enough, the name only when there is room for both */
    shapes.slice().sort((x, y) => (y.pop || 0) - (x.pop || 0)).slice(0, 40).forEach(a => {
      const [w, h] = px(mainRing(a)); if (w < 64 || h < 26) return;
      const m = byCode[a.kommun]; const own = hasOwn && vk(a) != null;
      const v = own ? vk(a) : (noInherit(ind) ? null : (m ? vk(m) : null));
      const t = sc.t(v), dark = !sc.cats && t != null && t > .55; const val = v != null ? fmtOf(ind)(v) + (own ? "" : " °") : "–";
      const name = w >= 120 && h >= 36 ? `<b>${esc(a.name)}</b><br>` : "";
      labs.push(L.marker(centroid(mainRing(a)), { interactive: false, icon: L.divIcon({ className: "lflab" + (dark ? " lflab-dark" : ""), iconSize: null, html: name + val }) }));
    });
  } else {
    /* kommuner: the 12 largest by name at the national zoom, the 40 largest with values once zoomed in */
    const big = MUNI.slice().sort((a, b) => (b.pop || 0) - (a.pop || 0)).slice(0, zoom < 6 ? 12 : 40);
    const placed = [];   /* larger kommuner first; a label that would sit on top of one already placed is skipped */
    big.forEach(m => {
      const ring = mainRing(m); if (!ring.length) return;
      const [w, h] = px(ring); if (w < 34 || h < 16) return;
      const ll = centroid(ring), pt = LF.map.latLngToContainerPoint(ll);
      if (placed.some(q => Math.abs(q.x - pt.x) < 70 && Math.abs(q.y - pt.y) < 26)) return;
      placed.push(pt);
      const t = sc.t(vk(m)), dark = !sc.cats && t != null && t > .55;
      labs.push(L.marker(ll, { interactive: false, icon: L.divIcon({ className: "lflab" + (dark ? " lflab-dark" : ""), iconSize: null, html: `<b>${esc(m.name)}</b>${zoom >= 6 ? `<br>${vk(m) != null ? fmtOf(ind)(vk(m)) : "–"}` : ""}` }) }));
    });
  }
  LF.labG = L.layerGroup(labs).addTo(LF.map);
}

/* ---------- overlays ----------
   An overlay is five hooks and no registry: a flag on MK, a `data-*` button in
   the toolbar, an `lf<Name>Layers()` builder, a legend box in the stacked
   column, and a part in the hash. OV is only the list of names, so the toolbar,
   the hash and setLegend can iterate without any of them knowing what the
   overlays actually draw. Phases 4, 6 and 7 add entries here.
   Until one exists this is an empty list and every loop over it is a no-op. */
/* --- the police-designated areas, as an outline overlay ---
   One small file (126 kB), not per kommun: 65 polygons nationally. Drawn as an
   outline over the choropleth with no fill click target, so the area popup
   underneath still opens and shows the usoLine. */
const USO = { data: null, loading: false };
function usoLoad() {
  if (USO.data || USO.loading) return;
  USO.loading = true;
  fetch("polisen_uso.geojson").then(r => r.json()).then(j => {
    USO.data = j; USO.loading = false; lfOverlays(); ovLegends();
  }).catch(() => { USO.loading = false; USO.data = { features: [] }; });
}
const USO_COL = { utsatt: "#C2603F", sarskilt: "#8E2B1B" };
function usoBuild() {
  usoLoad();
  if (!USO.data || LF.usoDrawn) return;
  lfDrop("usoLayer");
  const g = L.layerGroup();
  for (const f of USO.data.features || []) {
    const col = USO_COL[f.properties.class] || USO_COL.utsatt;
    L.geoJSON(f, {
      style: { color: col, weight: f.properties.class === "sarskilt" ? 2.2 : 1.6,
               opacity: .95, fill: true, fillColor: col,
               fillOpacity: f.properties.class === "sarskilt" ? .16 : .09,
               dashArray: f.properties.class === "sarskilt" ? null : "5,3" },
      interactive: false,
    }).addTo(g);
  }
  g.addTo(LF.map); LF.usoLayer = g; LF.usoDrawn = true;
}
function usoLegend() {
  if (!USO.data) return `<div class="lgtitle">Vulnerable areas<span>loading…</span></div>`;
  const n = (USO.data.features || []).length;
  const c = { utsatt: 0, sarskilt: 0 };
  for (const f of USO.data.features || []) c[f.properties.class] = (c[f.properties.class] || 0) + 1;
  return `<div class="lgtitle">Police-designated areas<span>${n} areas, Dec 2025</span></div>` +
    `<div class="lgrow"><i style="background:${USO_COL.sarskilt};opacity:.7"></i>Särskilt utsatt (${c.sarskilt})</div>` +
    `<div class="lgrow"><i style="background:${USO_COL.utsatt};opacity:.5"></i>Utsatt (${c.utsatt})</div>` +
    `<div class="lgnote">Källa: Polismyndigheten. A police assessment of an area's conditions, not a rating of its residents.</div>`;
}

/* ---------- the test property ----------
   A pin the reader drops from a Google Maps link, so they can ask "what is this
   dashboard's answer for THIS address". Nothing is sent anywhere: the link is
   parsed in the browser by src/testprop.js, the point is tested against our own
   rings, and the coordinate lives only in this page's URL fragment — which is
   never sent to a server. The privacy line on the panel says exactly that.

   `pip` already exists for the choropleth; what is added here is `inPoly`,
   which subtracts the holes. A polygon with a lake in it must NOT contain a
   point in the lake, and a kommun that encloses another must not swallow it. */
const TP = { lat: null, lon: null, label: "", rad: 0 };
const TP_RADII = [0, 500, 1000, 2000, 5000];
const LOOK = { kom: null, komP: null, sub: {} };   /* lazily fetched ring files */

function inBox(bb, lat, lon) { return bb && lat >= bb[0] && lat <= bb[2] && lon >= bb[1] && lon <= bb[3]; }
/* ray casting on a [lon, lat] ring */
function ringHas(ring, lat, lon) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi) inside = !inside;
  }
  return inside;
}
/* one polygon: inside its shell and outside every hole */
function inPoly(poly, lat, lon) {
  if (!ringHas(poly[0], lat, lon)) return false;
  for (let k = 1; k < poly.length; k++) if (ringHas(poly[k], lat, lon)) return false;
  return true;
}
function areaAtPoint(list, lat, lon) {
  for (const a of list || []) {
    if (!inBox(a.bbox, lat, lon)) continue;
    for (const poly of a.p) if (inPoly(poly, lat, lon)) return a;
  }
  return null;
}
function lookKommuner() {
  if (LOOK.komP) return LOOK.komP;
  LOOK.komP = fetch("lookup_kommuner.json").then(r => r.json())
    .then(j => { LOOK.kom = j; return j; })
    .catch(() => { LOOK.kom = []; return []; });
  return LOOK.komP;
}
function lookSub(level, code) {
  const k = level + "_" + code;
  if (LOOK.sub[k]) return LOOK.sub[k];
  LOOK.sub[k] = fetch("lookup/" + k + ".json").then(r => r.json())
    .catch(() => []);
  return LOOK.sub[k];
}
/* {kommun, regso, deso} for a point, or an explanation. Async because the rings
   are fetched on demand — a pin is rare, and 2.5 MB should not be in the page. */
async function locate(lat, lon) {
  const koms = await lookKommuner();
  const k = areaAtPoint(koms, lat, lon);
  if (!k) return { error: "That point is in water, or outside Sweden. The boundaries here are land only — a pin in a lake or just off the coast falls outside every area." };
  const [rs, ds] = await Promise.all([lookSub("regso", k.code), lookSub("deso", k.code)]);
  return { kommun: k, regso: areaAtPoint(rs, lat, lon), deso: areaAtPoint(ds, lat, lon) };
}
const havM = (a, b, c, d) => {
  /* great-circle metres */
  const R = 6371000, r = Math.PI / 180;
  const dLat = (c - a) * r, dLon = (d - b) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
};

/* ---------- Schools overlay ----------
   1 791 points nationally, so they travel one file per kommun and are fetched
   only for the kommuner in view, nearest first and capped per pass — the same
   convention as the DeSO polygons. Below SCH_ZOOM nothing is drawn at all: a
   thousand dots over a national map is noise, not information. */
const SCH_IDX = D.schools_index || {};
const SCH_META = D.schools_meta || {};
const SCH = {};                        /* kommun code -> [school, …] */
const SCH_ZOOM = 9, SCH_MAX_FILES = 24;
function schLoad(code) {
  if (!code || SCH[code] || SCH["_l_" + code] || !SCH_IDX[code]) return;
  SCH["_l_" + code] = true;
  fetch("schools/" + code + ".json").then(r => r.json()).then(j => {
    SCH[code] = j; delete SCH["_l_" + code];
    if (S.view === "analysis") renderKeep(); else { lfOverlays(); ovLegends(); }
  }).catch(() => { SCH[code] = []; delete SCH["_l_" + code]; });
}
function schLoadVisible() {
  if (!LF.map || LF.map.getZoom() < SCH_ZOOM) return;
  const b = LF.map.getBounds(), c = b.getCenter();
  const want = [];
  for (const code in SCH_IDX) {
    const bb = SCH_IDX[code].bbox;            /* [S, W, N, E] */
    if (!bb || bb[0] > b.getNorth() || bb[2] < b.getSouth() ||
        bb[1] > b.getEast() || bb[3] < b.getWest()) continue;
    if (SCH[code] || SCH["_l_" + code]) continue;
    want.push([code, Math.hypot((bb[0] + bb[2]) / 2 - c.lat, (bb[1] + bb[3]) / 2 - c.lng)]);
  }
  want.sort((x, y) => x[1] - y[1]);
  want.slice(0, SCH_MAX_FILES).forEach(([code]) => schLoad(code));
}
const schInView = () => {
  if (!LF.map) return [];
  const b = LF.map.getBounds(), out = [];
  for (const code in SCH) {
    if (code.startsWith("_l_") || !Array.isArray(SCH[code])) continue;
    for (const s of SCH[code]) if (b.contains([s.lat, s.lon])) out.push(s);
  }
  return out;
};
/* Grade colour mode: a 5-step quintile ramp over the schools actually in view,
   not a fixed national scale, so the contrast is useful wherever you are. A
   school with no merit value keeps the base hue, hollow — never the bottom bin,
   which would read as "worst" when it means "not published". */
const SCH_BASE = "#3E6B8C";
function schScale() {
  const vals = schInView().map(s => s.merit).filter(v => v != null).sort((a, b) => a - b);
  if (vals.length < 5) return null;
  const q = p => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
  return [q(.2), q(.4), q(.6), q(.8)];
}
const SCH_RAMP = ["#D9E2E8", "#A8C0D0", "#6E93AE", "#41708F", "#1F4A6B"];
function schColor(v, br) {
  if (v == null || !br) return null;
  let k = 0; while (k < br.length && v > br[k]) k++;
  return SCH_RAMP[k];
}
function schBuild() {
  schLoadVisible();
  if (!LF.map) return;
  lfDrop("schLayer");
  if (LF.map.getZoom() < SCH_ZOOM) { LF.schDrawn = false; return; }
  const br = schScale();
  const g = L.layerGroup();
  for (const s of schInView()) {
    const col = schColor(s.merit, br);
    const m = L.circleMarker([s.lat, s.lon], {
      radius: 5, weight: 1.4,
      color: col || SCH_BASE, fillColor: col || "#FFFFFF",
      fillOpacity: col ? .92 : .15, renderer: LF.schCanvas || undefined,
    });
    m.bindPopup(() => schPopup(s), { maxWidth: 320, className: "lfpopw" });
    m.addTo(g);
  }
  g.addTo(LF.map); LF.schLayer = g; LF.schDrawn = true;
}
const schAreaRow = (lab, v, f) => v == null ? "" :
  `<span class="lfrow"><span>${esc(lab)}</span><b>${f(v)}</b></span>`;
function schPopup(s) {
  const km = byCode[s.kommun];
  const iM = indOf("school_merit");
  const f1 = v => nf(v, 1);
  const cmp = (v, areaV, lab) => (v == null || areaV == null) ? "" :
    `<span class="lfrow"><span>vs ${esc(lab)}</span><b class="${cls(v - areaV, "school_merit")}">${sign(v - areaV, x => nf(x, 1))}</b></span>`;
  const nat = SCH_META.national_merit;
  const why = s.merit == null ? (s.merit_why === "OMITTED_DUE_TO_BASED_ON_FEW_PUPILS"
      ? "not published — too few pupils" : "not published") : "";
  return `<div class="lfpop"><b>${esc(s.name)}</b>
    <span class="dim">${esc(km ? km.name : s.kommun)}${s.principal ? " · " + esc(s.principal) : ""}${s.pupils ? " · ca " + nf(s.pupils, 0) + " pupils" : ""}</span>
    <div class="lfbig"><span>Merit value, year 9${s.merit_period ? " · " + esc(s.merit_period) : ""}</span>
      <b>${s.merit != null ? f1(s.merit) : "–"}</b><em>${esc(why)}</em></div>
    <div class="lfrows">
      ${cmp(s.merit, km && km.school_merit, km ? km.name : "kommun")}
      ${nat != null ? cmp(s.merit, nat, "Sweden") : ""}
      ${schAreaRow("Passed all subjects", s.passed, v => nf(v, 1) + " %")}
      ${schAreaRow("Eligible for gymnasium", s.eligible, v => nf(v, 1) + " %")}
      ${schAreaRow("Certified teachers", s.certified, v => nf(v, 1) + " %")}
      ${schAreaRow("Pupils per teacher", s.per_teacher, f1)}
    </div>
    <span class="lfact"><button class="lk mini primary" data-go="school/${esc(s.code)}">School page ›</button>${km ? `<button class="lk mini" data-go="${withQ(`area/kommun/${km.code}`)}">${esc(km.name)} ›</button>` : ""}</span>
    <p class="cap">Källa: Skolverket${s.merit_period ? " · " + esc(s.merit_period) : ""}. Raw merit value, not adjusted for pupil background.</p></div>`;
}
function schLegend() {
  const inView = schInView();
  if (!inView.length) {
    return `<div class="lgtitle">Schools<span>${LF.map && LF.map.getZoom() < SCH_ZOOM ? "zoom in to show" : "loading…"}</span></div>`;
  }
  const br = schScale();
  const withV = inView.filter(s => s.merit != null).length;
  const rows = br ? SCH_RAMP.map((c, k) => {
    const lab = k === 0 ? `≤ ${nf(br[0], 0)}` : k === 4 ? `> ${nf(br[3], 0)}`
      : `${nf(br[k - 1], 0)} – ${nf(br[k], 0)}`;
    return `<div class="lgrow"><i style="background:${c}"></i>${lab}</div>`;
  }).reverse().join("") : "";
  return `<div class="lgtitle">Schools with year 9<span>merit value · ${inView.length} in view</span></div>` +
    rows +
    `<div class="lgrow"><i style="background:#FFFFFF;border:1.4px solid ${SCH_BASE}"></i>not published</div>` +
    `<div class="lgnote">Quintiles of the ${withV} schools in view. Källa: Skolverket. Raw merit value — not SALSA-adjusted.</div>`;
}

/* ---------- the school datasheet ---------- */
SHEETS.school = {
  label: "School",
  missing: "That school is not in this build — it may not teach year 9.",
  crumb: parts => {
    const s = schFind(parts[0]);
    return s ? s.name : parts[0];
  },
  render: parts => {
    const s = schFind(parts[0]);
    if (!s) { schLoadAll(parts[0]); return { missing: null, title: "", tags: [], body: `<div class="card"><p class="empty">Loading…</p></div>` }; }
    const km = byCode[s.kommun];
    const tile = (lab, v, f, sub) => v == null ? "" :
      `<div><span>${esc(lab)}</span><b>${f(v)}</b>${sub ? `<em>${esc(sub)}</em>` : ""}</div>`;
    const row = (lab, v, f, why) => `<tr><th>${esc(lab)}</th><td class="num">${v == null ? `–<span class="dim"> ${esc(why || "")}</span>` : f(v)}</td></tr>`;
    return {
      title: s.name,
      tags: [km ? km.name : s.kommun, s.principal || "", s.pupils ? `ca ${nf(s.pupils, 0)} pupils` : "",
             `code ${s.code}`].filter(Boolean),
      tools: `<button class="lk" data-go="map/${esc(s.kommun)}?ind=school_merit&sch=1">Show on map</button>` +
             (km ? `<button class="lk" data-go="${withQ(`area/kommun/${km.code}`)}">${esc(km.name)} ›</button>` : ""),
      tiles: `<div class="hl">
        ${tile("Merit value", s.merit, v => nf(v, 1), s.merit_period)}
        ${tile("Passed all subjects", s.passed, v => nf(v, 1) + " %", s.passed_period)}
        ${tile("Eligible for gymnasium", s.eligible, v => nf(v, 1) + " %", s.eligible_period)}
        ${tile("Certified teachers", s.certified, v => nf(v, 1) + " %", s.certified_period)}
        ${tile("Pupils per teacher", s.per_teacher, v => nf(v, 1), s.per_teacher_period)}
      </div>`,
      body: `<div class="grid-2">
        <div class="card"><h3>Year 9 results</h3>
          <table class="tbl compact"><tbody>
          ${row("Merit value (max 340)", s.merit, v => nf(v, 1), s.merit_why)}
          ${row("Passed all subjects", s.passed, v => nf(v, 1) + " %", s.passed_why)}
          ${row("Eligible for gymnasium (YR)", s.eligible, v => nf(v, 1) + " %", s.eligible_why)}
          ${row("National test, Swedish", s.nt_sve, v => nf(v, 1), s.nt_sve_why)}
          ${row("National test, English", s.nt_eng, v => nf(v, 1), s.nt_eng_why)}
          ${row("National test, maths", s.nt_ma, v => nf(v, 1), s.nt_ma_why)}
          </tbody></table>
          <p class="cap">A dash means Skolverket did not publish the figure — most often because too few pupils sat it. It is never a zero.</p></div>
        <div class="card"><h3>Context</h3>
          <table class="tbl compact"><tbody>
          ${row("Kommun mean (pupil-weighted)", km && km.school_merit, v => nf(v, 1))}
          ${row("Schools with year 9 in the kommun", km && km.schools_n, v => nf(v, 0))}
          ${row("Certified teachers", s.certified, v => nf(v, 1) + " %", s.certified_why)}
          ${row("Pupils per teacher", s.per_teacher, v => nf(v, 1), s.per_teacher_why)}
          </tbody></table>
          <p class="cap"><b>Not SALSA-adjusted.</b> This is the raw merit value. Skolverket's SALSA model, which accounts for pupil background, has no machine-readable export, so the residual it produces is not shown here. A raw merit value tracks the intake, not only the teaching.</p>
          <p class="cap">Källa: Skolverket, planned-educations v4${s.merit_period ? ` · ${esc(s.merit_period)}` : ""}.</p></div>
      </div>`,
    };
  },
};
function schFind(code) {
  for (const k in SCH) {
    if (!Array.isArray(SCH[k])) continue;
    const hit = SCH[k].find(s => s.code === code);
    if (hit) return hit;
  }
  return null;
}
let SCH_ALL_TRIED = false;
function schLoadAll(code) {
  /* a datasheet opened from a link has no map context, so find the school by
     walking the kommun files once */
  if (SCH_ALL_TRIED) return;
  SCH_ALL_TRIED = true;
  const codes = Object.keys(SCH_IDX);
  let i = 0;
  const step = () => {
    if (i >= codes.length || schFind(code)) { render(); return; }
    const batch = codes.slice(i, i + 40); i += 40;
    Promise.all(batch.map(c => SCH[c] ? null :
      fetch("schools/" + c + ".json").then(r => r.json()).then(j => { SCH[c] = j; }).catch(() => {})))
      .then(() => { if (schFind(code)) render(); else step(); });
  };
  step();
}

/* ---------- Services and Public buildings overlays ----------
   OpenStreetMap points, one file per kommun, fetched for the viewport. Points
   only: no rate, no density indicator. A count of cafés per 1 000 inhabitants
   would measure how thoroughly volunteers have mapped a place as much as how
   many cafés it has, and dressing that up as a statistic would be worse than
   showing the dots and letting a reader judge the coverage.

   Every point keeps the OSM tag that put it in its category, shown in the
   popup, so "why is this a supermarket?" always has an answer. */
const SRV_IDX = (D.services_meta || {}).index || D.services_index || {};
const SRV = {};
const SRV_ZOOM = 11, SRV_MAX_FILES = 20;
const SRV_CATS = {
  grocery:   ["Grocery", "#2E6389", 13],
  food:      ["Restaurants & cafés", "#B07A1E", 14],
  pharmacy:  ["Pharmacy", "#1C6B5C", 13],
  transport: ["Public transport", "#40547F", 12],
  education: ["Schools", "#5C8A3A", 12],
  daycare:   ["Förskola", "#7FA34F", 13],
  health:    ["Health", "#B0331B", 12],
  culture:   ["Culture", "#82346C", 13],
  sports:    ["Sports", "#5C5F52", 13],
};
const SRV_SET = ["grocery", "food", "pharmacy", "transport"];
const PUB_SET = ["education", "daycare", "health", "culture", "sports"];
const SF = { srv: new Set(SRV_SET), pub: new Set(PUB_SET) };
function srvLoad(code) {
  if (!code || SRV[code] || SRV["_l_" + code] || !SRV_IDX[code]) return;
  SRV["_l_" + code] = true;
  fetch("services/" + code + ".json").then(r => r.json()).then(j => {
    SRV[code] = j; delete SRV["_l_" + code];
    if (S.view === "analysis") renderKeep(); else { lfOverlays(); ovLegends(); }
  }).catch(() => { SRV[code] = []; delete SRV["_l_" + code]; });
}
function srvLoadVisible() {
  if (!LF.map || LF.map.getZoom() < SRV_ZOOM) return;
  const b = LF.map.getBounds(), c = b.getCenter(), want = [];
  for (const code in SRV_IDX) {
    const bb = SRV_IDX[code].bbox;
    if (!bb || bb[0] > b.getNorth() || bb[2] < b.getSouth() ||
        bb[1] > b.getEast() || bb[3] < b.getWest()) continue;
    if (SRV[code] || SRV["_l_" + code]) continue;
    want.push([code, Math.hypot((bb[0] + bb[2]) / 2 - c.lat, (bb[1] + bb[3]) / 2 - c.lng)]);
  }
  want.sort((x, y) => x[1] - y[1]);
  want.slice(0, SRV_MAX_FILES).forEach(([code]) => srvLoad(code));
}
function srvDraw(which) {
  const on = which === "srv" ? SF.srv : SF.pub;
  const name = which + "Layer";
  lfDrop(name);
  if (!LF.map) return;
  const z = LF.map.getZoom();
  if (z < SRV_ZOOM) { LF[which + "Drawn"] = false; srvLoadVisible(); return; }
  srvLoadVisible();
  const b = LF.map.getBounds();
  const g = L.layerGroup();
  let n = 0;
  for (const code in SRV) {
    if (code.startsWith("_l_") || !Array.isArray(SRV[code])) continue;
    for (const [cat, lat, lon, nm, tag] of SRV[code]) {
      if (!on.has(cat)) continue;
      const def = SRV_CATS[cat]; if (!def || z < def[2]) continue;
      if (!b.contains([lat, lon])) continue;
      const m = L.circleMarker([lat, lon], { radius: 3.6, weight: 1,
        color: def[1], fillColor: def[1], fillOpacity: .8,
        renderer: which === "srv" ? LF.srvCanvas : LF.pubCanvas });
      m.bindPopup(`<div class="lfpop"><b>${esc(nm || def[0])}</b>
        <span class="dim">${esc(def[0])}</span>
        <div class="lfrows"><span class="lfrow"><span>OSM tag</span><b>${esc(tag)}</b></span></div>
        <p class="cap">© OpenStreetMap contributors (ODbL). Shown because of the tag above — nothing is inferred.</p></div>`,
        { maxWidth: 280 });
      m.addTo(g); n++;
    }
  }
  g.addTo(LF.map); LF[name] = g; LF[which + "Drawn"] = true;
  LF[which + "Count"] = n;
}
function srvLegendFor(which) {
  const cats = which === "srv" ? SRV_SET : PUB_SET;
  const on = which === "srv" ? SF.srv : SF.pub;
  const z = LF.map ? LF.map.getZoom() : 0;
  if (z < SRV_ZOOM) {
    return `<div class="lgtitle">${which === "srv" ? "Services" : "Public buildings"}<span>zoom in to level ${SRV_ZOOM}</span></div>`;
  }
  return `<div class="lgtitle">${which === "srv" ? "Services" : "Public buildings"}<span>${nf(LF[which + "Count"] || 0, 0)} in view · click to filter</span></div>` +
    cats.map(c => { const d = SRV_CATS[c];
      return `<div class="lgrow lgclick ${on.has(c) ? "" : "off"}" data-srvcat="${which}:${c}">
        <i style="background:${on.has(c) ? d[1] : "#FFF"};border:1.2px solid ${d[1]}"></i>${esc(d[0])}
        ${z < d[2] ? `<em class="dim"> z${d[2]}+</em>` : ""}</div>`; }).join("") +
    `<div class="lgnote">© OpenStreetMap contributors (ODbL). Points only — a count per inhabitant would measure mapping effort as much as provision.${
      Object.keys(SRV_IDX).length < 290
        ? ` <b>Partial coverage:</b> ${Object.keys(SRV_IDX).length} of 290 kommuner fetched so far.`
        : ""}</div>`;
}

/* ---------- Infrastructure overlay ---------- */
const INFRA = D.infra || { projects: [] };
const INFRA_GEO = { data: null, loading: false };
const INFRA_TONE = { study: "#8A8C81", decided: "#B07A1E",
                     construction: "#B0331B", opened: "#5C8A3A" };
function infraLoad() {
  if (INFRA_GEO.data || INFRA_GEO.loading) return;
  INFRA_GEO.loading = true;
  fetch("infra_projects.geojson").then(r => r.json()).then(j => {
    INFRA_GEO.data = j; INFRA_GEO.loading = false;
    if (S.view === "analysis") renderKeep(); else { lfOverlays(); ovLegends(); }
  }).catch(() => { INFRA_GEO.loading = false; INFRA_GEO.data = { features: [] }; });
}
function infraBuild() {
  infraLoad();
  if (!LF.map || !INFRA_GEO.data) return;
  lfDrop("infLayer");
  const g = L.layerGroup();
  for (const f of INFRA_GEO.data.features || []) {
    if (!f.geometry) continue;                 /* not located — never drawn */
    const p = f.properties;
    const col = INFRA_TONE[p.status] || "#8A8C81";
    const pts = f.geometry.type === "Point" ? [f.geometry.coordinates]
                                            : f.geometry.coordinates;
    for (const [lon, lat] of pts) {
      L.circleMarker([lat, lon], { radius: 6, weight: 2.2, color: col,
        fillColor: "#fff", fillOpacity: .9 })
        .bindPopup(`<div class="lfpop"><b>${esc(p.name)}</b>
          <span class="dim">${esc(p.agency || "")}${p.open_year ? " · opens " + p.open_year : p.open_window ? " · " + esc(p.open_window) : ""}</span>
          <span class="lfact"><button class="lk mini primary" data-go="project/${esc(p.id)}">Project page ›</button></span></div>`,
          { maxWidth: 300 })
        .addTo(g);
    }
  }
  g.addTo(LF.map); LF.infLayer = g; LF.infDrawn = true;
}
function infraLegend() {
  const ps = INFRA.projects || [];
  const drawn = (INFRA_GEO.data ? (INFRA_GEO.data.features || []).filter(f => f.geometry).length : 0);
  const byStatus = {};
  ps.forEach(p => { byStatus[p.status] = (byStatus[p.status] || 0) + 1; });
  return `<div class="lgtitle">Infrastructure<span>${ps.length} projects · ${drawn} located</span></div>` +
    Object.keys(INFRA_TONE).map(k => byStatus[k]
      ? `<div class="lgrow"><i style="background:${INFRA_TONE[k]}"></i>${esc(k)} (${byStatus[k]})</div>` : "").join("") +
    `<div class="lgnote">A project whose stations could not be found in OSM is listed in <b>Pipeline</b> but not drawn — no alignment is sketched between points.</div>`;
}

/* ---------- Pipeline: every project as a list, with its own CSV ---------- */
const PIPE = { type: "", status: "" };
const INFRA_ORDER = { construction: 0, decided: 1, study: 2, opened: 3 };
const pipeRows = () => (INFRA.projects || [])
  .filter(p => (!PIPE.type || p.type === PIPE.type) && (!PIPE.status || p.status === PIPE.status))
  .slice().sort((a, b) =>
    (INFRA_ORDER[a.status] ?? 9) - (INFRA_ORDER[b.status] ?? 9)
    || (a.open_year || 9999) - (b.open_year || 9999)
    || a.name.localeCompare(b.name, "sv"));
const kNames = codes => (codes || []).map(c => (byCode[c] || {}).name).filter(Boolean);
function vPipeline() {
  const rows = pipeRows();
  const types = [...new Set((INFRA.projects || []).map(p => p.type))].sort();
  const sts = ["construction", "decided", "study", "opened"];
  return `
  <div class="card accent arhead">
    <div class="arid"><h2>Pipeline</h2>
      <div class="artags"><span class="tag">${(INFRA.projects || []).length} projects</span>
        <span class="tag">hand-curated, every row sourced</span></div></div>
    <div class="tools">
      <div class="seg"><button class="sg ${!PIPE.type ? "on" : ""}" data-pipetype="">All types</button>
        ${types.map(t => `<button class="sg ${PIPE.type === t ? "on" : ""}" data-pipetype="${esc(t)}">${esc(t)}</button>`).join("")}</div>
      <div class="seg"><button class="sg ${!PIPE.status ? "on" : ""}" data-pipestatus="">All</button>
        ${sts.map(t => `<button class="sg ${PIPE.status === t ? "on" : ""}" data-pipestatus="${esc(t)}">${esc(t)}</button>`).join("")}</div>
      <button class="lk" data-csv-pipe>↓ Pipeline CSV</button></div>
  </div>
  <div class="card">
    <div class="scrollx"><table class="tbl" data-sortable><thead><tr>
      <th>Project</th><th>Type</th><th>Status</th><th class="num">Opening</th>
      <th class="num">Budget</th><th>Price base</th><th>Agency</th><th>Kommuner</th></tr></thead>
      <tbody>${rows.map(p => `<tr>
        <th><button class="lk mini" data-go="project/${esc(p.id)}">${esc(p.name)}</button></th>
        <td>${esc(p.type)}</td>
        <td><span class="pipdot" style="background:${INFRA_TONE[p.status] || "#8A8C81"}"></span>${esc(p.status)}</td>
        <td class="num">${p.open_year || esc(p.open_window || "–")}</td>
        <td class="num">${p.budget_msek != null ? nf(p.budget_msek, 0) + " MSEK" : "–"}</td>
        <td>${esc(p.price_base || "–")}</td>
        <td>${esc(p.agency || "")}</td>
        <td>${esc(kNames(p.kommuner).join(", "))}</td></tr>`).join("")}</tbody></table></div>
    <p class="cap">A budget is shown only with the price base the source stated — a figure in
      unknown money is not a figure. A dash means the source publishes none; the Stockholm metro
      lines, for instance, are funded as one programme rather than per line.
      Sources: Trafikverket, Region Stockholm, Västtrafik and the project bodies themselves —
      each row links to the page it came from.</p>
  </div>`;
}
function exportPipelineCsv() {
  const head = ["id", "name", "type", "status", "open_year", "open_window",
                "budget_msek", "price_base", "agency", "kommuner", "source_url", "notes"];
  const rows = pipeRows().map(p => [p.id, p.name, p.type, p.status, p.open_year || "",
    p.open_window || "", p.budget_msek != null ? p.budget_msek : "", p.price_base || "",
    p.agency || "", kNames(p.kommuner).join("|"), p.source_url || "", p.notes || ""]);
  downloadCsv("pipeline_se.csv", [head].concat(rows));
}
SHEETS.project = {
  label: "Infrastructure project",
  missing: "No such project in this build.",
  crumb: parts => { const p = (INFRA.projects || []).find(x => x.id === parts[0]);
    return p ? p.name : parts[0]; },
  render: parts => {
    const p = (INFRA.projects || []).find(x => x.id === parts[0]);
    if (!p) return null;
    const feat = INFRA_GEO.data ? (INFRA_GEO.data.features || []).find(f => f.properties.id === p.id) : null;
    const located = feat ? (feat.properties.stations_located || []) : [];
    const tile = (l, v) => v == null || v === "" ? "" : `<div><span>${esc(l)}</span><b>${v}</b></div>`;
    return {
      title: p.name,
      tags: [p.type, p.status, p.agency, p.open_year ? "opens " + p.open_year : (p.open_window || "")]
        .filter(Boolean),
      tools: `<a class="lk" href="${esc(p.source_url)}" target="_blank" rel="noopener">Verify at source ↗</a>` +
        (feat && feat.geometry ? `<button class="lk" data-go="map?ind=${esc(MK.ind)}&inf=1">Show on map</button>` : "") +
        `<button class="lk" data-go="pipeline">Pipeline ›</button>`,
      tiles: `<div class="hl">
        ${tile("Status", esc(p.status))}
        ${tile("Opening", p.open_year || p.open_window || "–")}
        ${tile("Budget", p.budget_msek != null ? nf(p.budget_msek, 0) + " MSEK" : "not published")}
        ${tile("Price base", p.price_base || "–")}
        ${tile("Agency", esc(p.agency || ""))}</div>`,
      body: `<div class="grid-2">
        <div class="card"><h3>What it is</h3>
          <p>${esc(p.notes || "No further note recorded.")}</p>
          <table class="tbl compact"><tbody>
            <tr><th>Kommuner</th><td>${esc(kNames(p.kommuner).join(", ") || "–")}</td></tr>
            <tr><th>Stations named</th><td>${esc((feat ? feat.properties.stations : []).join(", ") || "–")}</td></tr>
            <tr><th>Located in OSM</th><td>${located.length} of ${(feat ? feat.properties.stations.length : 0)}</td></tr>
          </tbody></table>
          <p class="cap">${feat && feat.geometry
            ? "Station points come from OpenStreetMap, matched by name inside the kommuner this project runs through."
            : "<b>Not drawn on the map.</b> No station could be located, and sketching an alignment between points would be inventing geography."}</p></div>
        <div class="card"><h3>Source</h3>
          <p class="cap"><a href="${esc(p.source_url)}" target="_blank" rel="noopener">${esc(p.source_url)}</a></p>
          ${p.budget_msek != null ? `<p class="cap">Budget ${nf(p.budget_msek, 0)} MSEK at price base ${esc(p.price_base || "unknown")}. Figures from different price bases are not comparable and nothing here is converted.</p>` : `<p class="cap">No budget is published for this project on its own.</p>`}
          <p class="cap">Curated by hand in <code>data/external/infra_se.csv</code>. Every row carries the page it came from.</p></div>
      </div>`,
    };
  },
};

/* ---------- Climate risk overlay ----------
   The national hazard layers are 83-98 MB apiece, so they are never shipped
   whole: the build clips them per kommun, simplifies in metres and writes one
   file per kommun per layer. Nothing is drawn on the national view — at that
   scale an outline of every flood extent in Sweden is a smear — and from zoom
   10 the viewport's kommuner are fetched nearest-first.

   The horizon or scenario is in the pill label and in the legend, every time.
   A flood extent without "100-year" beside it is not a fact, it is a shape. */
const CLIM_IDX = (D.climate_meta || {}).zones || {};
const CLIM_ZONES = {};              /* "<layer>/<kommun>" -> geojson | [] */
const CLIM_ZOOM = 10, CLIM_MAX_FILES = 12;
const CLIM_LAYERS = [
  ["flood100",   "River flood, 100-year",            "#3E7CA6"],
  ["flood200",   "River flood, 200-year",            "#2E6389"],
  ["floodBHF",   "River flood, highest calculated",  "#1E4A6B"],
  ["coast20",    "Coastal +2.0 m (RH2000)",          "#2F8F8A"],
  ["coast30",    "Coastal +3.0 m (RH2000)",          "#1E6E69"],
  ["sea2100_85", "Mean sea level 2100 (RCP8.5)",     "#7A4E8C"],
  ["landslide",  "Landslide caution zone",           "#9A6B33"],
];
const CL = { layer: "flood100" };
const climAvail = () => CLIM_LAYERS.filter(l => CLIM_IDX[l[0]]);
function climLoad(layer, code) {
  const k = layer + "/" + code;
  if (CLIM_ZONES[k] || CLIM_ZONES["_l_" + k]) return;
  const idx = CLIM_IDX[layer];
  if (!idx || !idx.kommuner.includes(code)) { CLIM_ZONES[k] = []; return; }
  CLIM_ZONES["_l_" + k] = true;
  fetch("climate/" + layer + "/" + code + ".json").then(r => r.json()).then(j => {
    CLIM_ZONES[k] = j; delete CLIM_ZONES["_l_" + k];
    if (S.view === "analysis") renderKeep(); else { lfOverlays(); ovLegends(); }
  }).catch(() => { CLIM_ZONES[k] = []; delete CLIM_ZONES["_l_" + k]; });
}
function climLoadVisible() {
  if (!LF.map || LF.map.getZoom() < CLIM_ZOOM) return;
  const b = LF.map.getBounds(), c = b.getCenter();
  const want = [];
  for (const code in DESO_IDX) {
    const m = byCode[code]; if (!m) continue;
    const bb = boundsOf(AREAS.filter(a => a.kommun === code));
    if (!bb || !b.intersects(bb)) continue;
    const k = CL.layer + "/" + code;
    if (CLIM_ZONES[k] || CLIM_ZONES["_l_" + k]) continue;
    const cc = bb.getCenter();
    want.push([code, Math.hypot(cc.lat - c.lat, cc.lng - c.lng)]);
  }
  want.sort((x, y) => x[1] - y[1]);
  want.slice(0, CLIM_MAX_FILES).forEach(([code]) => climLoad(CL.layer, code));
}
function climBuild() {
  if (!LF.map) return;
  lfDrop("climLayer");
  if (LF.map.getZoom() < CLIM_ZOOM) { LF.climDrawn = false; climLoadVisible(); return; }
  climLoadVisible();
  const col = (CLIM_LAYERS.find(l => l[0] === CL.layer) || [])[2] || "#3E7CA6";
  const g = L.layerGroup();
  for (const k in CLIM_ZONES) {
    if (k.startsWith("_l_") || !k.startsWith(CL.layer + "/")) continue;
    const gj = CLIM_ZONES[k];
    if (!gj || !gj.type) continue;
    L.geoJSON(gj, { style: { color: col, weight: 1, opacity: .85,
                             fillColor: col, fillOpacity: .28 },
                    interactive: false }).addTo(g);
  }
  g.addTo(LF.map); LF.climLayer = g; LF.climDrawn = true;
}
function climLegend() {
  const avail = climAvail();
  if (!avail.length) return `<div class="lgtitle">Climate risk<span>no zone files built</span></div>`;
  const zoomed = LF.map && LF.map.getZoom() >= CLIM_ZOOM;
  const cur = avail.find(l => l[0] === CL.layer) || avail[0];
  return `<div class="lgtitle">Climate risk<span>${esc(cur[1])}</span></div>` +
    `<div class="lgpick">${avail.map(l =>
      `<button class="lgb ${l[0] === CL.layer ? "on" : ""}" data-climlayer="${l[0]}">${esc(l[1])}</button>`).join("")}</div>` +
    `<div class="lgrow"><i style="background:${cur[2]};opacity:.5"></i>${esc(cur[1])}</div>` +
    `<div class="lgnote">${zoomed ? "Zones for the kommuner in view."
      : `Zoom in to level ${CLIM_ZOOM} to draw the zones.`} Screening only, not a property-level assessment. Källa: MCF, SMHI, SGU.</div>`;
}

const OV = [
  { id: "srv", label: "Services", flag: "srv",
    title: "Grocery, food, pharmacy and public-transport points from OpenStreetMap",
    avail: () => Object.keys(SRV_IDX).length > 0,
    build: () => srvDraw("srv"), legend: () => srvLegendFor("srv") },
  { id: "pub", label: "Public buildings", flag: "pub",
    title: "Schools, förskolor, health, culture and sports from OpenStreetMap",
    avail: () => Object.keys(SRV_IDX).length > 0,
    build: () => srvDraw("pub"), legend: () => srvLegendFor("pub") },
  { id: "inf", label: "Infrastructure", flag: "inf",
    title: "Major transport projects — status by colour",
    avail: () => (INFRA.projects || []).length > 0,
    build: infraBuild, legend: infraLegend },
  { id: "clim", label: "Climate risk", flag: "clim",
    title: "Outline a published hazard zone — pick the layer in the legend (zoom in to draw)",
    avail: () => climAvail().length > 0,
    build: climBuild, legend: climLegend },
  { id: "sch", label: "Schools", flag: "sch",
    title: "Show every school with year 9; colour by merit value (zoom in to see them)",
    avail: () => Object.keys(SCH_IDX).length > 0,
    build: schBuild, legend: schLegend },
  { id: "uso", label: "Vulnerable areas", flag: "uso",
    title: "Outline the areas the police have designated as utsatt or särskilt utsatt (Dec 2025)",
    build: usoBuild, legend: usoLegend },
];                                /* [{id, label, flag, avail(), build(), legend()}] */
const ovOn = o => !!MK[o.flag];
const ovList = () => OV.filter(o => !o.avail || o.avail());

/* Leaflet's canvas renderer keeps redrawing after its map has gone, and a point
   layer that outlives a re-render throws inside _redraw on a null context —
   which in the Danish edition killed every later map interaction silently.
   The guard is a one-time prototype patch, and lfDrop() is its other half:
   remove a layer group and forget it in one step, so nothing can hold a stale
   reference. Both land now, before Phase 4 adds the first point layer. */
function lfGuardCanvas() {
  if (typeof L === "undefined" || !L.Canvas || L.Canvas.prototype._amGuarded) return;
  const cp = L.Canvas.prototype, _redraw = cp._redraw, _update = cp._update;
  cp._redraw = function () { if (!this._map || !this._ctx) return; return _redraw.apply(this, arguments); };
  cp._update = function () { if (!this._map) return; return _update.apply(this, arguments); };
  cp._amGuarded = true;
}
function lfDrop(...names) {
  for (const n of names) {
    const g = LF[n]; if (!g) continue;
    try { if (LF.map && LF.map.hasLayer(g)) LF.map.removeLayer(g); } catch (e) {}
    LF[n] = null;
  }
}

/* ---------- quick jumps ----------
   Camera only. mapJump() moves the viewport and does nothing else: it never
   sets MK.kommun, never touches the hash, never opens a popup. Zooming is a
   camera movement, never a selection — the Danish edition shipped a
   zoom-decides-the-level ladder in v2.5 and had to take it out again in v2.5.1
   because it kept changing what the reader had selected out from under them. */
const MAP_JUMPS = [
  { id: "sthlm", label: "Stockholm", key: "S", codes: ["0180"] },
  { id: "gbg",   label: "Göteborg",  key: "G", codes: ["1480"] },
  { id: "malmo", label: "Malmö",     key: "M", codes: ["1280"] },
  { id: "se",    label: "Sweden",    key: "W", codes: null },
];
function mapJump(id) {
  const j = MAP_JUMPS.find(x => x.id === id); if (!j || !LF.map) return;
  if (!j.codes) { LF.map.setView([62.5, 16.5], 5); return; }
  const b = boundsOf(j.codes.flatMap(c => muniAreas(c)));
  if (b) LF.map.fitBounds(b, { padding: [24, 24] });
}
/* Redraws every overlay that is on and drops every overlay that is off. Called
   after the choropleth is (re)built and on every viewport change, so an overlay
   that loads its data per kommun can fill in as the reader pans. */
function lfOverlays() {
  if (!LF.map) return;
  for (const o of ovList()) {
    if (ovOn(o)) { try { o.build(); } catch (e) { console.warn("overlay " + o.id, e); } }
    else { lfDrop(o.id + "Layer"); LF[o.id + "Drawn"] = false; }
  }
}
function ovTools() {
  const L2 = ovList(); if (!L2.length) return "";
  return `<div class="seg">${L2.map(o =>
    `<button class="sg ${ovOn(o) ? "on" : ""}" data-ov="${o.id}" title="${esc(o.title || o.label)}">${esc(o.label)}</button>`).join("")}</div>`;
}
function jumpTools() {
  return `<div class="seg jumps">${MAP_JUMPS.map(j =>
    `<button class="sg" data-mapjump="${j.id}" title="Move the map to ${esc(j.label)} (key ${j.key}) — this does not change the selection">${esc(j.label)}</button>`).join("")}</div>`;
}

function lfInit() {
  const el = document.getElementById("lfmap");
  if (!el || typeof L === "undefined") return;
  lfGuardCanvas();
  if (LF.map) { try { LF.map.remove(); } catch (e) {} LF.map = null; }
  const map = L.map(el, { center: LF.center, zoom: LF.zoom, scrollWheelZoom: true, zoomSnap: 0.5, zoomDelta: 1, wheelPxPerZoomLevel: 30, wheelDebounceTime: 20 });
  LF.map = map;
  /* detectRetina asks for 2x tiles on a 2x display; without it the basemap is
     upscaled 1x raster and looks soft next to the crisp vector boundaries. */
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, maxNativeZoom: 19,
    detectRetina: true, className: "basemap",
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a> · Boundaries: SCB RegSO/DeSO 2025 (CC0) · Coastline: OSM land polygons (ODbL)' }).addTo(map);
  map.on("moveend", () => { const c = map.getCenter(); LF.center = [c.lat, c.lng]; LF.zoom = map.getZoom(); });
  /* Leaflet stops click propagation inside popups, so page links in popups are wired here */
  map.on("popupopen", ev => { const el = ev.popup.getElement(); if (!el) return;
    el.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => go(b.dataset.go)));
    /* re-fit the popup when "all values" opens — popup.update() would rebuild the content and close the fold again */
    el.querySelectorAll("details").forEach(d => d.addEventListener("toggle", () => { const pp = ev.popup; if (pp._updateLayout) { pp._updateLayout(); pp._updatePosition(); pp._adjustPan(); } })); });
  map.on("zoomend", () => {
    /* rebuild polygons only when the display level changes — rebuilding on every pan would kill open popups */
    const lvl = (MK.kommun ? (desoMode() ? "deso" : "regso") : "national") + (MK.kommun || "");
    /* `fine` was a variable in the zoom-decides-the-level code that v1.0 replaced;
       the reference survived, so every zoomend threw and labels stopped being
       rebuilt. Labels are sized against the screen, so they are always redone. */
    if (lvl !== LF.level) lfLayers(); else lfLabels();
    lfOverlays();
  });
  /* one canvas renderer per map, in its own pane under the popups — a thousand
     circleMarkers as SVG is what makes a map crawl. The guard in lfGuardCanvas
     is what keeps it from throwing once this map is replaced. */
  map.createPane("schpane");
  map.getPane("schpane").style.zIndex = 450;
  LF.schCanvas = L.canvas({ pane: "schpane", padding: 0.3 });
  map.createPane("srvpane"); map.getPane("srvpane").style.zIndex = 440;
  LF.srvCanvas = L.canvas({ pane: "srvpane", padding: 0.3 });
  map.createPane("pubpane"); map.getPane("pubpane").style.zIndex = 435;
  LF.pubCanvas = L.canvas({ pane: "pubpane", padding: 0.3 });
  map.on("moveend", lfOverlays);
  lfLayers();
  lfOverlays();
  applyPendingFit();
}

/* ---------- Full-screen map ---------- */
function toggleFullscreen() {
  const el = document.getElementById("mapcard"); if (!el) return;
  if (document.fullscreenElement) { document.exitFullscreen(); return; }
  if (el.requestFullscreen) el.requestFullscreen().catch(() => el.classList.toggle("fs-fallback"));
  else el.classList.toggle("fs-fallback");
  setTimeout(() => LF.map && LF.map.invalidateSize(), 300);
}
document.addEventListener("fullscreenchange", () => {
  const b = document.querySelector("[data-fs]"); if (b) b.textContent = document.fullscreenElement ? "⤡ Exit full screen" : "⤢ Full screen";
  setTimeout(() => LF.map && LF.map.invalidateSize(), 250);
});

/* ---------- Chart generator ---------- */
const CH_COLORS = ["#1C6B5C", "#B07A1E", "#40547F", "#B0331B", "#82346C", "#5C5F52", "#6E8C5E", "#C08A24"];
function chEntity(id) {
  const [t, c] = id.split(":");
  if (t === "kommun" && byCode[c]) return { id, type: t, o: byCode[c], name: byCode[c].name, inds: IND, peers: MUNI, peerLabel: "municipalities" };
  if (t === "regso" && byRegso[c]) return { id, type: t, o: byRegso[c], name: byRegso[c].name, inds: IND, peers: AREAS, peerLabel: "RegSO areas", kommun: byCode[byRegso[c].kommun] };
  if (t === "deso" && byDeso[c]) return { id, type: t, o: byDeso[c], name: byDeso[c].code.split("_")[0], inds: IND, peers: desoAreas(byDeso[c].kommun), peerLabel: "DeSO areas" };
  return null;
}
function chartAdd(id, text) {
  if (!id && text) { const q = text.trim(); const o = AREA_OPTS.find(x => x.t === q) || AREA_OPTS.find(x => x.k.some(k => k === q.toLowerCase())) || AREA_OPTS.find(x => x.k.some(k => k.startsWith(q.toLowerCase())));
    if (!o) return; id = o.h.startsWith("map/") ? "kommun:" + o.h.slice(4) : o.h.replace("area/", "").replace("/", ":"); }
  if (!id || CH.areas.includes(id) || CH.areas.length >= 8) return;
  CH.areas.push(id); syncHash(); renderKeep();
  const q = document.getElementById("chq"); if (q) { q.value = ""; q.focus(); }
}
function chartInd() { return IND.concat(IND_DESO.filter(i => !IND.some(x => x.key === i.key))).find(i => i.key === CH.ind) || IND[0]; }
/* ---------- Yearly | Quarterly ----------
   Some series are published quarterly and shown as a rolling four-quarter sum,
   which is the only honest way to compare a quarter with the one before it. An
   indicator gets the toggle only when the build wrote `q_periods` for it, and
   only when EVERY selected area actually has quarters — a mixed selection falls
   back to yearly rather than drawing a line with holes in it. The caption then
   states that each point is a rolling four-quarter window. */
const chQPeriods = ind => (ind && ind.q_periods) || [];
function chartQ() {
  if (CH.fq !== "q") return false;
  const ind = chartInd();
  if (chQPeriods(ind).length < 2) return false;
  const ents = CH.areas.map(chEntity).filter(Boolean);
  return ents.every(e => e.o && e.o.q && e.o.q[ind.key]);
}
const chQVal = (o, key, t) => { const q = o && o.q && o.q[key]; return q && q[t] != null ? q[t] : null; };
/* For an Outlook indicator the x axis is the projection window, and every point
   on it is projected — so the whole line is drawn dashed and the caption says
   which projection it is. Observed and projected are never spliced into one
   series: they are different kinds of number. */
function chartFcYears() {
  const ind = chartInd(); const oi = outlookOf(ind); if (!oi) return null;
  const ents = CH.areas.map(chEntity).filter(Boolean);
  const set = new Set();
  for (const e of ents) { const f = fcSeries(e.o, ind.key) || fcSeries(e.kommun, ind.key); if (f) for (const y in f) set.add(y); }
  const ys = [...set].sort();
  return ys.length > 1 ? ys : null;
}
function chartPeriods() {
  const fy = chartFcYears(); if (fy) return fy;
  if (!chartQ()) return chartYears();
  const ps = chQPeriods(chartInd());
  return ps.filter(t => (!CH.y0 || t.slice(0, 4) >= CH.y0) && (!CH.y1 || t.slice(0, 4) <= CH.y1));
}
function chartYears() {
  const ents = CH.areas.map(chEntity).filter(Boolean); const pool = ents.length ? ents.map(e => e.o) : MUNI;
  const hy = histYears(CH.ind, pool.concat(MUNI));
  const ys = hy.filter(y => (!CH.y0 || y >= CH.y0) && (!CH.y1 || y <= CH.y1)); return ys.length >= 2 ? ys : hy;
}
function chartMode() {
  if (CH.mode !== "auto") return CH.mode;
  /* chartPeriods(), not chartYears(): an Outlook indicator has no observed
     history at all but fifteen projected points, and asking the wrong one drew
     it as a single bar labelled "no history". */
  return chartPeriods().length >= 2 ? "line" : "bar";
}
function chartAutoTitle() { if (chartMode() === "dist") return `${(DIST_DEFS[CH.dist] || DIST_DEFS.age)[0]} — share`; const i = chartInd(); return `${i.label}${i.unit ? " · " + i.unit : ""}${chartMode() === "bar" ? " — latest" : ""}`; }
function chartSeries() {
  const ind = chartInd(), q = chartQ(), ys = chartPeriods(); const ents = CH.areas.map(chEntity).filter(Boolean);
  const fc = !!chartFcYears();
  if (fc) {
    /* projected levels, dashed, no median band — the median of a projection
       across kommuner is not something SCB published */
    const ser = ents.map((e, k) => {
      const f = fcSeries(e.o, ind.key) || fcSeries(e.kommun, ind.key) || {};
      return { name: e.name + (fcSeries(e.o, ind.key) ? "" : " °"), color: CH_COLORS[k % CH_COLORS.length],
               dash: true, pts: ys.map(y => ({ y, v: f[y] != null ? f[y] : null })),
               inherited: !fcSeries(e.o, ind.key) };
    });
    return { ind, ys, fc: true, series: ser.filter(x => x.pts.some(pt => pt.v != null)) };
  }
  const series = ents.map((e, k) => { const own = e.inds.some(i => i.key === ind.key);
    const val = y => { if (q) return chQVal(e.o, ind.key, y);
      const v = V(e.o, ind.key, y); if (v != null) return v; return e.type === "regso" && e.kommun ? V(e.kommun, ind.key, y) : null; };
    return { name: e.name, color: CH_COLORS[k % CH_COLORS.length], pts: ys.map(y => ({ y, v: own ? val(y) : null })), inherited: e.type === "regso" && V(e.o, ind.key) == null && e.kommun && V(e.kommun, ind.key) != null }; });
  if (CH.median) { const pool = ents.length && ents.every(e => e.type === "deso") ? allDeso() : ents.length && ents.every(e => e.type === "regso") ? AREAS : MUNI;
    series.push({ name: pool === MUNI ? "Sweden — median of kommuner" : pool === AREAS ? "Sweden — median of RegSO" : "Median of DeSO", color: "#8A8C81", dash: true,
      pts: ys.map(y => ({ y, v: median(pool.map(p => q ? chQVal(p, ind.key, y) : V(p, ind.key, y))) })) }); }
  return { ind, ys, series: series.filter(s => s.pts.some(p => p.v != null)) };
}
/* self-contained SVG (inline styles, title, legend) so the same markup renders on screen and rasterises to PNG */
function chartSvg(withTitle) {
  const mode = chartMode();
  if (mode === "dist") return chartSvgDist(withTitle);
  if (mode === "bar") return chartSvgBar(withTitle);
  return chartSvgLine(withTitle);
}
const CH_FONT = "Inter, 'Helvetica Neue', Arial, sans-serif", CH_MONO = "'IBM Plex Mono', Menlo, monospace";
function chTitleBlock(withTitle, ind, L0, sub) {
  return withTitle ? `<text x="${L0}" y="40" font-family="${CH_FONT}" font-size="24" font-weight="600" fill="#16170F" id="chsvgtitle">${esc(CH.title || chartAutoTitle())}</text><text x="${L0}" y="64" font-family="${CH_MONO}" font-size="12" fill="#8A8C81">${esc(sub != null ? sub : (ind.desc || ""))}</text>` : "";
}
function chFoot(L0, H, ind, extra) {
  const src = (ind.source || ""); const short = src.length > 90 ? src.slice(0, 88) + "…" : src;
  /* a rolling window has to say so on the chart itself, not only in the toolbar —
     the PNG leaves the toolbar behind */
  const oi = outlookOf(ind);
  const roll = chartQ() ? " · rolling 4 quarters"
    : (oi && chartFcYears()) ? " · dashed = projected, not observed" : "";
  return `<text x="${L0}" y="${H - 14}" font-family="${CH_MONO}" font-size="11" fill="#8A8C81">Source: ${esc(short)} · Macro Dashboard — Sweden, open data · built ${esc((D.meta && D.meta.built) || "")}${roll}${extra || ""}</text>`;
}
/* bars: latest value per selected area, sorted, median as a dashed marker */
function chartSvgBar(withTitle) {
  const ind = chartInd(); const ents = CH.areas.map(chEntity).filter(Boolean);
  const rows = ents.map((e, k) => { const own = e.inds.some(i => i.key === ind.key); const v = own ? (V(e.o, ind.key) ?? (e.type === "regso" && e.kommun ? V(e.kommun, ind.key) : null)) : null;
    return { name: e.name, color: CH_COLORS[k % CH_COLORS.length], v, inh: own && V(e.o, ind.key) == null && v != null }; }).filter(r => r.v != null).sort((a, b) => b.v - a.v);
  const W = 1200, H = 640, L0 = 96, R = 170, T0 = withTitle ? 96 : 30, B = 70;
  if (!rows.length) return `<svg class="chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" id="chsvg"><rect width="${W}" height="${H}" fill="#FFFFFF"/><text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-family="${CH_FONT}" font-size="18" fill="#8A8C81">Add areas with the search box — nothing to plot yet</text></svg>`;
  const pool = ents.length && ents.every(e => e.type === "deso") ? allDeso() : ents.length && ents.every(e => e.type === "regso") ? AREAS : MUNI; const med = CH.median ? median(pool.map(p => V(p, ind.key))) : null;
  const vals = rows.map(r => r.v).concat(med != null ? [med] : []); const lo = Math.min(0, ...vals), hi = Math.max(...vals) || 1;
  const labW = 260; const x0 = L0 + labW, x1 = W - R; const x = v => x0 + (v - lo) / (hi - lo || 1) * (x1 - x0);
  const rowH = Math.min(52, (H - T0 - B) / rows.length), bh = rowH * .62;
  const bars = rows.map((r, i) => { const y = T0 + i * rowH + (rowH - bh) / 2; return `<text x="${x0 - 12}" y="${(y + bh / 2 + 5).toFixed(1)}" text-anchor="end" font-family="${CH_FONT}" font-size="15" fill="#16170F">${esc(r.name)}${r.inh ? " °" : ""}</text>
    <rect x="${x(Math.min(0, r.v)).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.abs(x(r.v) - x(0)).toFixed(1)}" height="${bh.toFixed(1)}" fill="${r.color}" rx="3"/>
    <text x="${(x(Math.max(0, r.v)) + 8).toFixed(1)}" y="${(y + bh / 2 + 5).toFixed(1)}" font-family="${CH_MONO}" font-size="14" fill="#16170F">${esc(fmtOf(ind)(r.v))}</text>`; }).join("");
  const medLine = med != null ? `<line x1="${x(med).toFixed(1)}" x2="${x(med).toFixed(1)}" y1="${T0 - 8}" y2="${T0 + rows.length * rowH}" stroke="#5C5F52" stroke-width="2" stroke-dasharray="7 5"/><text x="${(x(med) + 6).toFixed(1)}" y="${T0 - 12}" font-family="${CH_MONO}" font-size="12" fill="#5C5F52">${pool === MUNI ? "SE median (kommuner)" : pool === AREAS ? "SE median (RegSO)" : "median (DeSO)"} ${esc(fmtOf(ind)(med))}</text>` : "";
  const asof = asofText(ind);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" id="chsvg"><rect width="${W}" height="${H}" fill="#FFFFFF"/>${chTitleBlock(withTitle, ind, L0, `${ind.desc || ""}${asof ? " · as of " + asof : ""}`)}
    <line x1="${x(0).toFixed(1)}" x2="${x(0).toFixed(1)}" y1="${T0}" y2="${T0 + rows.length * rowH}" stroke="#E6E6E0"/>${bars}${medLine}${chFoot(L0, H, ind, rows.some(r => r.inh) ? " · ° = municipality value" : "")}</svg>`;
}
/* distributions published by SCB below kommun level: one donut per area.
   The Danish edition drew the BBR building register here; Sweden has none, so
   these are the age structure, the tenure mix and the largest income components. */
const AGE_GROUPS = [["0–19", ["-4", "5-9", "10-14", "15-19"]], ["20–34", ["20-24", "25-29", "30-34"]],
                    ["35–64", ["35-39", "40-44", "45-49", "50-54", "55-59", "60-64"]],
                    ["65+", ["65-69", "70-74", "75-79", "80-"]]];
const INC_TOP = 5;
const IND_TOP = 6;
function distDefs() {
  const m = (D.meta && D.meta.dist) || {};
  const inc = (m.income && m.income.labels) || [];
  return {
    age: ["Age structure", AGE_GROUPS.map(g => g[0])],
    tenure: ["Tenure", (m.tenure && m.tenure.labels) || []],
    income: ["Income by type", inc.slice(0, INC_TOP)],
    industry: ["Employment by industry", ((m.industry && m.industry.labels) || []).slice(0, IND_TOP)],
  };
}
const DIST_DEFS = new Proxy({}, { get: (_, k) => distDefs()[k] });
/* values for one area in the chosen distribution, aligned with its labels */
function distValues(e, kind) {
  const d = e.o && e.o.dist; if (!d) return null;
  if (kind === "tenure") return d.tenure || null;
  if (kind === "income") return d.income ? d.income.slice(0, INC_TOP) : null;
  if (kind === "industry") return d.industry ? d.industry.slice(0, IND_TOP) : null;
  if (kind === "age") {
    const meta = (D.meta && D.meta.dist && D.meta.dist.age) || {}; const bands = meta.bands || [];
    if (!d.age) return null;
    return AGE_GROUPS.map(([, codes]) => codes.reduce((s_, c) => {
      const i = bands.indexOf(c); return i < 0 ? s_ : s_ + (d.age.m[i] || 0) + (d.age.f[i] || 0); }, 0));
  }
  return null;
}
const DIST_COLORS = ["#C9DCD6", "#7FB0A4", "#3E8A78", "#1C6B5C", "#B07A1E"];
function chartSvgDist(withTitle) {
  const ents = CH.areas.map(chEntity).filter(Boolean).filter(e => distValues(e, CH.dist)); const [dl, labels] = DIST_DEFS[CH.dist] || DIST_DEFS.age;
  const W = 1200, H = 640, L0 = 96, T0 = withTitle ? 96 : 30;
  const ind = { label: `${dl} — share`, unit: "", desc: "Structure published by SCB at kommun, RegSO and DeSO level.", source: "Källa: SCB" };
  if (!ents.length) return `<svg class="chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" id="chsvg"><rect width="${W}" height="${H}" fill="#FFFFFF"/>${chTitleBlock(withTitle, ind, L0, "")}<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-family="${CH_FONT}" font-size="18" fill="#8A8C81">Add areas with BBR data (municipalities, postal codes or quarters) to draw distributions</text></svg>`;
  const perRow = Math.min(4, ents.length), cw = (W - L0 * 2) / perRow, rows = Math.ceil(ents.length / perRow), avail = H - T0 - 110, rh = avail / rows, r0 = Math.min(cw, rh) * .34, r1 = r0 * .55;
  const arc = (cx, cy, a0, a1, R0, R1) => { const p = (a, r) => [cx + r * Math.cos(a), cy + r * Math.sin(a)]; const [x0, y0] = p(a0, R0), [x1, y1] = p(a1, R0), [x2, y2] = p(a1, R1), [x3, y3] = p(a0, R1); const big = a1 - a0 > Math.PI ? 1 : 0;
    return `M${x0.toFixed(1)},${y0.toFixed(1)}A${R0},${R0} 0 ${big} 1 ${x1.toFixed(1)},${y1.toFixed(1)}L${x2.toFixed(1)},${y2.toFixed(1)}A${R1},${R1} 0 ${big} 0 ${x3.toFixed(1)},${y3.toFixed(1)}Z`; };
  const donuts = ents.map((e, k) => { const cx = L0 + (k % perRow) * cw + cw / 2, cy = T0 + Math.floor(k / perRow) * rh + rh / 2 - 10; const d = distValues(e, CH.dist) || [0, 0, 0, 0]; const tot = d.reduce((a, b) => a + b, 0) || 1; let a = -Math.PI / 2;
    const slices = d.map((v, i) => { const a1 = a + v / tot * 2 * Math.PI - 1e-6; const path = `<path d="${arc(cx, cy, a, a1, r0, r1)}" fill="${DIST_COLORS[i]}"><title>${esc(labels[i])}: ${nf(v / tot * 100, 0)} % (${nf(v, 0)})</title></path>`; const mid = (a + a1) / 2; const lab = v / tot >= .07 ? `<text x="${(cx + (r0 + r1) / 2 * Math.cos(mid)).toFixed(1)}" y="${(cy + (r0 + r1) / 2 * Math.sin(mid) + 5).toFixed(1)}" text-anchor="middle" font-family="${CH_MONO}" font-size="13" font-weight="600" fill="${i >= 2 ? "#FFFFFF" : "#16170F"}">${nf(v / tot * 100, 0)} %</text>` : ""; a = a1 + 1e-6; return path + lab; }).join("");
    return slices + `<text x="${cx}" y="${(cy + r0 + 26).toFixed(1)}" text-anchor="middle" font-family="${CH_FONT}" font-size="15" font-weight="600" fill="#16170F">${esc(e.name)}</text><text x="${cx}" y="${(cy + r0 + 46).toFixed(1)}" text-anchor="middle" font-family="${CH_MONO}" font-size="12" fill="#8A8C81">${nf(e.o.pop || 0, 0)} dwellings</text>`; }).join("");
  const legY = H - 52; const legend = labels.map((l, i) => `<rect x="${L0 + i * 220}" y="${legY - 12}" width="14" height="14" fill="${DIST_COLORS[i]}" rx="2"/><text x="${L0 + i * 220 + 22}" y="${legY}" font-family="${CH_FONT}" font-size="14" fill="#16170F">${esc(l)}</text>`).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" id="chsvg"><rect width="${W}" height="${H}" fill="#FFFFFF"/>${chTitleBlock(withTitle, ind, L0, ind.desc)}${donuts}${legend}${chFoot(L0, H, ind)}</svg>`;
}
function chartSvgLine(withTitle) {
  const { ind, ys, series } = chartSeries();
  const W = 1200, H = 640, L0 = 96, R = 30, T0 = withTitle ? 84 : 24, B = 150;
  const all = series.flatMap(s_ => s_.pts.map(p => p.v)).filter(v => v != null);
  const F = "Inter, 'Helvetica Neue', Arial, sans-serif", M = "'IBM Plex Mono', Menlo, monospace";
  if (!all.length) return `<svg class="chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="#FFFFFF"/><text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-family="${F}" font-size="18" fill="#8A8C81">Add areas with the search box — nothing to plot yet</text></svg>`;
  const lo0 = Math.min(...all), hi0 = Math.max(...all), pad = (hi0 - lo0 || Math.abs(hi0) || 1) * .08;
  /* Padding below the smallest value put the axis at -80 532 on a population
     count, because Malå and Stockholm differ by three orders of magnitude.
     A series whose values are all >= 0 keeps its axis at 0 or above. */
  const lo = lo0 >= 0 ? Math.max(0, lo0 - pad) : lo0 - pad, hi = hi0 + pad, sp = (hi - lo) || 1;
  const x = i => L0 + i / (ys.length - 1) * (W - L0 - R), y = v => T0 + (1 - (v - lo) / sp) * (H - T0 - B);
  const ticks = [0, .25, .5, .75, 1].map(t => lo + t * sp);
  const paths = series.map(s_ => { let d = "", open = false; s_.pts.forEach((p, i) => { if (p.v == null) { open = false; return; } d += (open ? "L" : "M") + x(i).toFixed(1) + "," + y(p.v).toFixed(1); open = true; });
    return `<path d="${d}" fill="none" stroke="${s_.color}" stroke-width="${s_.dash ? 2 : 3}" ${s_.dash ? 'stroke-dasharray="7 5"' : ""} stroke-linejoin="round"/>` +
      s_.pts.map((p, i) => p.v == null || s_.dash ? "" : `<circle cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="4" fill="${s_.color}"><title>${esc(s_.name)} ${p.y}: ${fmtOf(ind)(p.v)}</title></circle>`).join(""); }).join("");
  const legY = H - B + 46; const perRow = 3, colW = (W - L0 - R) / perRow;
  const legend = series.map((s_, k) => { const lx = L0 + (k % perRow) * colW, ly = legY + Math.floor(k / perRow) * 24; const last = [...s_.pts].reverse().find(p => p.v != null);
    return `<line x1="${lx}" x2="${lx + 26}" y1="${ly - 4}" y2="${ly - 4}" stroke="${s_.color}" stroke-width="${s_.dash ? 2 : 3}" ${s_.dash ? 'stroke-dasharray="7 5"' : ""}/><text x="${lx + 34}" y="${ly}" font-family="${F}" font-size="14" fill="#16170F">${esc(s_.name)}${s_.inherited ? " °" : ""}${last ? ` <tspan font-family="${M}" fill="#4A4C43">${esc(fmtOf(ind)(last.v))} (${last.y})</tspan>` : ""}</text>`; }).join("");
  const title = withTitle ? `<text x="${L0}" y="40" font-family="${F}" font-size="24" font-weight="600" fill="#16170F" id="chsvgtitle">${esc(CH.title || chartAutoTitle())}</text><text x="${L0}" y="64" font-family="${M}" font-size="12" fill="#8A8C81">${esc(ind.desc || "")}</text>` : "";
  /* The line chart draws its own footer rather than calling chFoot, so the
     rolling-window and projection notes have to be repeated here — the PNG
     leaves the toolbar behind, and a dashed line has to say what it means. */
  const note = chartQ() ? " · rolling 4 quarters"
    : (outlookOf(ind) && chartFcYears()) ? " · dashed = projected, not observed" : "";
  const fsrc = (ind.source || ""); const fshort = fsrc.length > 78 ? fsrc.slice(0, 76) + "…" : fsrc;
  const foot = `<text x="${L0}" y="${H - 14}" font-family="${M}" font-size="11" fill="#8A8C81">Source: ${esc(fshort)} · Macro Dashboard — Sweden, open data · built ${esc((D.meta && D.meta.built) || "")}${note}${series.some(s_ => s_.inherited) ? " · ° = municipality value shown for a RegSO or DeSO" : ""}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" id="chsvg"><rect width="${W}" height="${H}" fill="#FFFFFF"/>${title}
    ${ticks.map(t => `<line x1="${L0}" x2="${W - R}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke="#EFEFEA"/><text x="${L0 - 10}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end" font-family="${M}" font-size="12" fill="#8A8C81">${esc(fmtOf(ind)(t))}</text>`).join("")}
    ${ys.map((yy, i) => `<text x="${x(i).toFixed(1)}" y="${H - B + 22}" text-anchor="middle" font-family="${M}" font-size="12" fill="#8A8C81">${yy}</text>`).join("")}
    ${paths}${legend}${foot}</svg>`;
}
function vCharts() {
  const ind = chartInd(), ys = chartYears(); const ents = CH.areas.map(chEntity).filter(Boolean);
  const L = IND.concat(IND_DESO.filter(i => !IND.some(x => x.key === i.key)));
  const groups = GROUP_ORDER.filter(gn => L.some(i => (i.group || "Other") === gn)).concat(L.some(i => !GROUP_ORDER.includes(i.group || "Other")) ? ["Other"] : []);
  const quick = [["Top 5 kommuner", MUNI.slice().sort((a, b) => (b.pop || 0) - (a.pop || 0)).slice(0, 5).map(m => "kommun:" + m.code)],
                 ["Storstäder", ["0180", "1480", "1280"].filter(c => byCode[c]).map(c => "kommun:" + c)],
                 ["University towns", ["0380", "1280", "0580", "1880"].filter(c => byCode[c]).map(c => "kommun:" + c)]];
  const { series } = chartSeries();
  return `
  <div class="card accent">
    <div class="card-head tools-only"><div class="tools">
      <select id="chind" class="indsel">${groups.map(gn => `<optgroup label="${esc(gn)}">${L.filter(i => (i.group || "Other") === gn).map(i => `<option value="${i.key}" ${CH.ind === i.key ? "selected" : ""}>${esc(i.label)}${i.unit ? " · " + esc(i.unit) : ""}</option>`).join("")}</optgroup>`).join("")}</select>
      ${(() => { const fy = chartFcYears(); const ys = fy || YEARS; const lo = ys[0], hi = ys[ys.length - 1];
        return `<select id="chy0" class="indsel"><option value="">from ${lo}</option>${ys.map(y => `<option value="${y}" ${CH.y0 === y ? "selected" : ""}>${y}</option>`).join("")}</select>
      <select id="chy1" class="indsel"><option value="">to ${hi}</option>${ys.map(y => `<option value="${y}" ${CH.y1 === y ? "selected" : ""}>${y}</option>`).join("")}</select>`; })()}
      <label class="hint" style="display:flex;align-items:center;gap:5px"><input type="checkbox" id="chmed" ${CH.median ? "checked" : ""}> median</label>
      <div class="seg">${[["auto", "Auto"], ["line", "Line"], ["bar", "Bars"], ["dist", "Distribution"]].map(([m, l]) => `<button class="sg ${CH.mode === m ? "on" : ""}" data-chmode="${m}">${l}</button>`).join("")}</div>
      ${chQPeriods(chartInd()).length > 1 ? `<div class="seg">${[["year", "Yearly"], ["q", "Quarterly"]].map(([m, l]) => `<button class="sg ${CH.fq === m ? "on" : ""}" data-chfq="${m}" title="${m === "q" ? "Each point is the rolling sum of the four quarters ending there" : "One point per year"}">${l}</button>`).join("")}</div>` : ""}
      ${chartMode() === "dist" ? `<select id="chdist" class="indsel">${Object.entries(DIST_DEFS).map(([k, v]) => `<option value="${k}" ${CH.dist === k ? "selected" : ""}>${v[0]}</option>`).join("")}</select>` : ""}</div></div>
    ${CH.fq === "q" && !chartQ() && chQPeriods(chartInd()).length > 1 ? `<p class="hint" style="margin:0 0 8px">Showing years: not every selected area has quarterly figures, and a line mixing the two would not be comparable.</p>` : ""}
    ${ents.length && CH.mode === "auto" && chartMode() === "bar" && !chartFcYears() && chartYears().length < 2 ? `<p class="hint" style="margin:0 0 8px">This indicator is a single snapshot (no history) — shown as bars of the latest value. BBR distributions are under <b>Distribution</b>.</p>` : ""}
    <div class="tfilters">
      <span class="asrch"><input id="chq" list="arealist" class="indsel" placeholder="Add kommun or RegSO… (Enter)" autocomplete="off"><datalist id="arealist">${AREA_OPTS.map(o => `<option value="${esc(o.t)}"></option>`).join("")}</datalist></span>
      ${quick.map(([l, ids]) => `<button class="lk mini" data-chadd="${ids.join("|")}">+ ${l}</button>`).join("")}
      ${CH.areas.length ? `<button class="lk mini" data-chclear>clear</button>` : ""}
    </div>
    <div class="chips">${ents.map((e, k) => `<span class="chip" style="border-color:${CH_COLORS[k % CH_COLORS.length]}"><i style="background:${CH_COLORS[k % CH_COLORS.length]}"></i>${esc(e.name)}${!e.inds.some(i => i.key === ind.key) ? ' <em title="indicator not available at this level">n/a</em>' : ""}<button data-chrm="${esc(e.id)}" title="remove">×</button></span>`).join("")}</div>
    <div class="tfilters"><label class="hint" style="flex:1;display:flex;gap:8px;align-items:center">title <input id="chtitle" type="text" value="${esc(CH.title)}" placeholder="${esc(chartAutoTitle())}" style="flex:1;min-width:200px"></label>
      <button class="lk primary" data-chpng>⤓ Download PNG</button><button class="lk" data-chcsv>⤓ Data CSV</button><span class="hint">link: copy the address bar — it holds the whole setup</span></div>
    <div class="chartbox">${ents.length ? chartSvg(true) : `<div class="chempty"><b>Nothing to plot yet</b><p>Type a kommun or RegSO in the box above (up to 8), or start with a set:</p>
      <div class="tools">${quick.map(([l, ids]) => `<button class="lk" data-chadd="${ids.join("|")}">+ ${l}</button>`).join("")}</div>
      <p class="dim">Tip: every area page and table row has a ↗ that opens it here with the indicator pre-selected.</p></div>`}</div>
    <p class="cap">${esc(ind.desc || "")} ${ind.warn ? "⚠ " + esc(ind.warn) : ""} Same sub-period each year (e.g. Q3 or July); values are those shown in the dashboard.</p>
  </div>
  ${chartMode() === "line" && ents.length && series.length ? `<div class="card"><div class="card-head"><h3>Data</h3><span class="hint">${esc(ind.unit || "")}</span></div>
    <div class="scrollx"><table class="tbl compact" data-sortable><thead><tr><th>Year</th>${series.map(s_ => `<th class="num">${esc(s_.name)}</th>`).join("")}</tr></thead>
    <tbody>${ys.map((yy, i) => `<tr><th>${yy}</th>${series.map(s_ => fmtCell(ind, s_.pts[i].v, false)).join("")}</tr>`).join("")}</tbody></table></div></div>` : ""}
  ${chartMode() === "dist" && ents.some(e => e.o.dist) ? `<div class="card"><div class="card-head"><h3>Data</h3><span class="hint">share · count</span></div>
    <div class="scrollx"><table class="tbl compact" data-sortable><thead><tr><th>Area</th><th class="num">Population</th>${(DIST_DEFS[CH.dist] || DIST_DEFS.age)[1].map(l => `<th class="num">${esc(l)}</th>`).join("")}</tr></thead>
    <tbody>${ents.filter(e => distValues(e, CH.dist)).map(e => { const d = distValues(e, CH.dist); const t = d.reduce((a, b) => a + b, 0) || 1; return `<tr><th>${esc(e.name)}</th><td class="num">${nf(e.o.pop || 0, 0)}</td>${d.map(v => `<td class="num" data-v="${v / t * 100}">${nf(v / t * 100, 0)} % <span class="dim">${nf(v, 0)}</span></td>`).join("")}</tr>`; }).join("")}</tbody></table></div></div>` : ""}`;
}
function chartAddMany(ids) { ids.forEach(id => { if (!CH.areas.includes(id) && CH.areas.length < 8) CH.areas.push(id); }); syncHash(); renderKeep(); }
function chartPng() {
  const svg = chartSvg(true).replace('class="chart" ', 'width="1200" height="640" ').replace(' id="chsvg"', "");
  const img = new Image(); const scale = 2; const W = 1200, H = 640;
  img.onload = () => { const c = document.createElement("canvas"); c.width = W * scale; c.height = H * scale; const ctx = c.getContext("2d"); ctx.scale(scale, scale); ctx.drawImage(img, 0, 0, W, H);
    c.toBlob(b => { const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = `chart_${CH.ind}_${chartYears()[0]}-${chartYears().slice(-1)[0]}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }, "image/png"); };
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}
function chartCsv() {
  if (chartMode() === "dist") { const ents = CH.areas.map(chEntity).filter(e => e && distValues(e, CH.dist)); const [dl, labels] = DIST_DEFS[CH.dist] || DIST_DEFS.age;
    downloadCsv([["area", "population"].concat(labels).join(";")].concat(ents.map(e => [e.name, e.o.pop || 0].concat(distValues(e, CH.dist)).join(";"))), `chart_${CH.dist}_distribution.csv`); return; }
  if (chartMode() === "bar") { const ind = chartInd(); const ents = CH.areas.map(chEntity).filter(Boolean);
    downloadCsv([["area", ind.key].join(";")].concat(ents.map(e => [e.name, V(e.o, ind.key) ?? (e.type === "regso" && e.kommun ? V(e.kommun, ind.key) : "") ?? ""].join(";"))), `chart_${ind.key}_latest.csv`); return; }
  const { ind, ys, series } = chartSeries();
  downloadCsv([["year"].concat(series.map(s_ => s_.name)).join(";")].concat(ys.map((yy, i) => [yy].concat(series.map(s_ => s_.pts[i].v ?? "")).map(v => String(v).replace(/;/g, ",")).join(";"))), `chart_${ind.key}.csv`);
}

/* ---------- Market view (Sweden-only panel) ---------- */
function spark(series, w = 160, h = 26) {
  const v = (series || []).map(p => p.v).filter(x => x != null);
  if (v.length < 2) return "";
  const lo = Math.min(...v), hi = Math.max(...v), sp = hi - lo || 1;
  const pts = v.map((x, i) => `${(i / (v.length - 1) * w).toFixed(1)},${(h - 2 - (x - lo) / sp * (h - 4)).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline fill="none" stroke="currentColor" stroke-width="1.5" points="${pts}"/></svg>`;
}
function lineChart(key, opts = {}) {
  /* `key` is one series key, or a list of {key,label,color} drawn on shared axes
     (the interest-rate card puts the policy rate, the 10-year yield and the
     mortgage rate side by side — they are all per cent, so they share a scale). */
  const all = (D.macro && D.macro.series) || {};
  const defs = Array.isArray(key) ? key : [{ key, label: "", color: opts.color }];
  const series = defs.map(d => ({ ...d, pts: (all[d.key] || []).filter(p => p.v != null) }))
                     .filter(d => d.pts.length > 1);
  if (!series.length) return `<p class="empty">no series for ${esc(Array.isArray(key) ? defs.map(d => d.key).join(", ") : key)}</p>`;
  const W = 640, H = 180, L0 = 44, R = 10, T0 = 10, B = series.length > 1 ? 38 : 24;
  /* a shared time axis: the union of every period, so series of different
     lengths and cadences line up instead of being stretched to the same width */
  const times = [...new Set(series.flatMap(d => d.pts.map(p => p.t)))].sort((a, b) => {
    const k = t => { const m = /(\d{4})(?:[KQM](\d{1,2}))?|(\d{4})-(\d{2})-(\d{2})/.exec(t) || [];
      return m[3] ? [+m[3], +m[4], +m[5]] : [+m[1] || 0, +m[2] || 0, 0]; };
    const A = k(a), B_ = k(b); return A[0] - B_[0] || A[1] - B_[1] || A[2] - B_[2];
  });
  const xi = {}; times.forEach((t, i) => xi[t] = i);
  const v = series.flatMap(d => d.pts.map(p => p.v));
  const lo = opts.zero ? 0 : Math.min(...v), hi = Math.max(...v), sp = hi - lo || 1;
  const x = i => L0 + (times.length < 2 ? 0 : i / (times.length - 1) * (W - L0 - R));
  const y = val => T0 + (1 - (val - lo) / sp) * (H - T0 - B);
  const COL = ["#1C6B5C", "#B07A1E", "#40547F"];
  const paths = series.map((d, k) => `<path d="${d.pts.map((p, i) => `${i ? "L" : "M"}${x(xi[p.t]).toFixed(1)},${y(p.v).toFixed(1)}`).join("")}" fill="none" stroke="${d.color || COL[k % COL.length]}" stroke-width="2"/>`).join("");
  const ticks = [lo, lo + sp / 2, hi];
  const xl = [0, Math.floor(times.length / 2), times.length - 1];
  const legend = series.length > 1
    ? `<g>${series.map((d, k) => `<rect x="${L0 + k * 168}" y="${H - 12}" width="10" height="3" fill="${d.color || COL[k % COL.length]}"/><text class="ax" x="${L0 + k * 168 + 15}" y="${H - 8}">${esc(d.label || d.key)}</text>`).join("")}</g>` : "";
  return `<svg class="chart" viewBox="0 0 ${W} ${H}">
    ${ticks.map(t => `<line class="grid" x1="${L0}" x2="${W - R}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="ax" x="${L0 - 6}" y="${(y(t) + 3).toFixed(1)}" text-anchor="end">${nf(t, opts.dec ?? 1)}</text>`).join("")}
    ${xl.map(i => `<text class="ax" x="${x(i).toFixed(1)}" y="${H - (series.length > 1 ? 20 : 6)}" text-anchor="${i === 0 ? "start" : i === times.length - 1 ? "end" : "middle"}">${esc(times[i] || "")}</text>`).join("")}
    ${paths}${legend}</svg>`;
}
/* the named sub-series a macro indicator carries, as a small table — used where
   the breakdown is the point (owner category, rent-setting model) */
function bdTable(key, unit, dec) {
  const bd = ((D.macro && D.macro.breakdown) || {})[key];
  if (!bd) return "";
  const names = Object.keys(bd);
  if (names.length < 2) return "";
  const times = bd[names[0]].map(p => p.t);
  return `<div class="scrollx"><table class="tbl compact"><thead><tr><th>${esc(unit)}</th>${times.map(t => `<th class="num">${esc(t)}</th>`).join("")}</tr></thead>
    <tbody>${names.map(n => `<tr><th>${esc(n)}</th>${times.map(t => { const p = bd[n].find(x => x.t === t); return `<td class="num">${p ? nf(p.v, dec) : "–"}</td>`; }).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function vMarket() {
  const mac = D.macro || {}, lt = mac.latest || {};
  if (!Object.keys(lt).length) return `<div class="card"><p class="empty">No macro series built yet — run the pipeline (see Sources).</p></div>`;
  const tile = (key, label) => { const o = lt[key]; if (!o) return ""; const yoy = o.yoy;
    return `<div><span>${esc(label)}</span><b>${nf(o.v, o.dec ?? 1)}<i class="u">${esc(o.unit || "")}</i></b>
      ${yoy != null ? `<em class="k ${cls(yoy, key)}">${sign(yoy, x => nf(x, 1) + " %")} y/y</em>` : ""}<em>${esc(o.label || "")} · ${esc(o.t || "")}</em>${spark((mac.series || {})[key])}</div>`; };
  const heroKeys = mac.hero || ["policy_rate", "mortgage_rate", "bond_10y", "cpi"];
  const tableKeys = mac.table || Object.keys(lt);
  return `
  <div class="hero">${heroKeys.map(k => tile(k, (lt[k] || {}).label || k)).join("")}</div>
  <div class="grid-2">
    <div class="card"><div class="card-head"><h3>Rent index (CPI 04.1)</h3><span class="hint">SCB TAB6598 · 2020 = 100</span></div>${lineChart("cpi_rent")}
      <p class="cap">Actual rental payments made for housing, the CPI component Swedish leases are indexed on (CPI for October). Rebased to 2020 = 100 in January 2026.</p></div>
    <div class="card"><div class="card-head"><h3>Property price index (FASTPI)</h3><span class="hint">SCB TAB1149 · 1981 = 100</span></div>${lineChart("hpi", { color: "#40547F" })}
      <p class="cap">Fastighetsprisindex for permanent småhus. An index of how prices moved — Sweden publishes no open realised price per m² at any geography.</p></div>
    <div class="card"><div class="card-head"><h3>Interest rates</h3><span class="hint">Riksbanken SWEA · SCB TAB5783</span></div>${lineChart([
      { key: "policy_rate", label: "Policy rate" },
      { key: "bond_10y", label: "10-yr government bond" },
      { key: "mortgage_rate", label: "Mortgage, new agreements" }], { dec: 2 })}
      <p class="cap">Policy rate and 10-year yield from the Riksbank (daily, thinned to month-end); the mortgage rate is SCB's lending rate to households for housing loans, all fixation periods.</p></div>
    <div class="card"><div class="card-head"><h3>New-build rent by rent-setting model</h3><span class="hint">SCB TAB6417 · six national groups</span></div>${lineChart([
      { key: "newbuild_rent", label: "All models" }], { dec: 0 })}
      ${bdTable("newbuild_rent", "SEK / m² / yr", 0)}
      <p class="cap">Presumtionshyra exempts a new build from the bruksvärde cap for 15 years, which is why these sit far above the stock next door. Six national groups, 2022–2024 — no kommun breakdown exists.</p></div>
    <div class="card"><div class="card-head"><h3>Vacant dwellings, multi-dwelling buildings</h3><span class="hint">SCB TAB5602 · 1 March</span></div>${lineChart([
      { key: "vacancy", label: "All owners" }], { dec: 1 })}
      ${bdTable("vacancy", "% of dwellings", 1)}
      <p class="cap"><b>Stale.</b> Triennial and the series stops at 2024 (2019, 2021, 2024); SCB has announced no next publication, so this does not track the current market. Sample survey — the published margin of error is wider than most of the differences between the groups.</p></div>
  </div>
  <div class="card"><div class="card-head"><h3>Macro indicators</h3><span class="hint">latest available period per series</span></div>
    <table class="tbl compact" data-sortable><thead><tr><th>Indicator</th><th class="num">Value</th><th class="num">y/y</th><th>Period</th><th>Source</th></tr></thead>
    <tbody>${tableKeys.map(k => { const o = lt[k]; if (!o) return ""; return `<tr><th>${esc(o.label || k)}</th><td class="num" data-v="${o.v}">${nf(o.v, o.dec ?? 1)} ${esc(o.unit || "")}</td>
      <td class="num ${o.yoy > 0 ? "good" : o.yoy < 0 ? "bad" : ""}">${o.yoy != null ? sign(o.yoy, x => nf(x, 1) + " %") : "–"}</td><td class="dim">${esc(o.t || "")}</td><td class="dim">${esc(o.src || "")}</td></tr>`; }).join("")}</tbody></table>
    <p class="cap">${esc(mac.note || "")}</p></div>
  <details class="dinfo srcfold" ${MKT.src ? "open" : ""} id="srcfold"><summary>Sources, freshness and indicator definitions</summary>${vSources()}</details>`;
}

/* ---------- Sources (folded under Market) ---------- */
function vSources() {
  const s = (D.meta && D.meta.sources) || [];
  const defs = (list, title) => `<div class="card"><div class="card-head"><h3>${title}</h3></div>
    <table class="tbl compact"><thead><tr><th>Indicator</th><th>Unit</th><th>Level</th><th>Definition</th><th>Source</th><th>Caveat</th></tr></thead>
    <tbody>${list.map(i => `<tr><th>${esc(i.label)}</th><td class="dim">${esc(i.unit || "")}</td><td class="dim">${esc(i.level)}</td><td>${esc(i.desc || "")}</td><td class="dim">${esc(i.source || "")}</td><td class="dim">${esc(i.warn || "")}</td></tr>`).join("")}</tbody></table></div>`;
  return `<div class="card"><div class="card-head"><h3>Data sources and freshness</h3><span class="hint">built ${esc((D.meta && D.meta.built) || "–")}</span></div>
    <table class="tbl compact"><thead><tr><th>Source</th><th>Tables / files</th><th>As of</th><th>Fetched</th><th>Licence</th></tr></thead>
    <tbody>${s.map(x => `<tr><th>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.label)}</a>` : esc(x.label)}</th><td class="dim">${esc(x.tables || "")}</td><td>${esc(x.asof || "")}</td><td class="dim">${esc(x.fetched || "")}</td><td class="dim">${esc(x.licence || "")}</td></tr>`).join("") || `<tr><td colspan="5" class="empty">no sources recorded</td></tr>`}</tbody></table>
    <p class="cap">${((D.meta && D.meta.attribution) || []).map(esc).join(" · ")}</p></div>
  ${defs(IND, "Indicator definitions")}`;
}

parseHash();
render();
