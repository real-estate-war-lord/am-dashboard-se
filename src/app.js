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
/* ---------- the Swedish tenure words ----------
   hyresrätt, bostadsrätt, äganderätt and allmännytta are the legal forms, and they are
   what a lease, a broker's listing and SCB's own tables say. "Rented dwellings" is an
   approximation that loses the form, and on a Swedish dashboard it is the reader who
   pays for the translation. config/indicators.json is built from SCB's table metadata
   and validated against it, so it is not the place to make a wording decision: the
   display labels are overridden here, once, and the picker, the chips, the tiles, the
   popups, the tables, the chart titles and the CSV export all read the same words.
   The English gloss is given exactly once, in the picker's help line. */
const TENURE_WORDS = {
  renters: { label: "Hyresrätt share", short: "Hyresrätt" },
  new_rental: { short: "New hyresrätt" },
  rent_owner: { label: "Rent by landlord: allmännytta or private", short: "Rent, allmännytta/private" },
};
IND.forEach(i => { const w = TENURE_WORDS[i.key]; if (w) Object.assign(i, w); });
const MUNI = D.kommuner || [];
const AREAS = D.regso || [];
const LOCALE = "sv-SE";

/* ---------- helpers ---------- */
const nf = (n, d = 1) => (n == null || isNaN(n)) ? "–" : Number(n).toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });
/* One signed-change path. A change is ALWAYS signed, the sign is added exactly
   once (so a format that prints its own sign cannot produce "++6,8 %"), and the
   unit comes after it: `+0,4 pp`, `−5,9 %`. `pp` for a change in a share, `%`
   for a change in a level — the caller picks, `unitFor` below decides. */
const signed = (v, d = 1, unit = "") => {
  if (v == null || isNaN(v)) return "–";
  const a = Math.abs(v);
  /* A change that rounds to zero at this precision is not "−0,0". The sign
     claims a direction the printed number does not support, and "−0,0 %"
     appeared on the National tiles for a series that had barely moved. */
  const zero = a < 0.5 / Math.pow(10, d);
  return (zero ? "" : v > 0 ? "+" : "−") + nf(a, d) + (unit ? " " + unit : "");
};
/* the unit a y/y or "since" change is expressed in for this indicator */
const deltaUnit = i => (isPct(i) ? "pp" : "%");
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const FMT = {
  pct0: v => nf(v, 0) + " %", pct1: v => nf(v, 1) + " %", pct2: v => nf(v, 2) + " %",
  /* An indicator whose VALUE is a signed change — projected population change,
     the crime trend — prints its own sign through the one signed() path. */
  signpct1: v => signed(v, 1, "%"),
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
/* ---------- units on a figure ----------
   "1 710 SEK" is not a rent anyone can act on: per month or per year, per flat or
   per square metre? The registry knows — `unit` is "SEK / m² / yr" — so the tiles
   print the part of it the number does not already carry. `fmtOf` writes the leading
   token itself (sek0 → "1 710 SEK"), so printing the unit whole would read
   "1 710 SEK SEK/m²/yr"; UNIT_IN_FMT is what each format already says. */
const unitTight = u => String(u == null ? "" : u).replace(/\s*\/\s*/g, "/").trim();
const UNIT_IN_FMT = { pct0: "%", pct1: "%", pct2: "%", signpct1: "%", ksek: "kSEK",
                      sek0: "SEK", m2: "m²", per1000: "‰", per10k: "/10k" };
function tileUnit(i) {
  const u = unitTight(i && i.unit); if (!u) return "";
  const own = UNIT_IN_FMT[i.fmt];
  return (own && u.indexOf(own) === 0) ? u.slice(own.length).trim() : u;
}
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

/* ---------- geometry: the page carries kommun outlines, encoded ----------
   Every ring in this build is one short string (src/geo_core.js). The 290
   kommun outlines are the only ones that travel in the page, and they are
   decoded here, once, at load. Nothing below this line ever sees a string.

   COORDINATE ORDER: [lat, lon] in, [lat, lon] out. geo_core never swaps and
   neither does this — the one swap in the pipeline is build_makro.py's
   rings_of(). CLAUDE.md records what the second swap did the time it existed. */
const GC = window.GEO_CORE || { decodeRings: r => r, decodeEntity: o => o };
MUNI.forEach(GC.decodeEntity);

/* ---------- RegSO: 3 363 areas, fetched rather than inlined ----------
   Until v2.1 the whole RegSO layer — rings, eleven years of history, the
   distribution cards — sat in dist/index.html, which is why the page was 17 MB
   before a reader had asked to see anything below kommun level. It now arrives
   in two shapes, because the two are wanted at different moments:

     regso/values.json      every figure for all 3 363, no geometry. What the
                            Data table, a national RegSO median, a rank and the
                            export need — all of them, none of the coastline.
     regso/<kommun>.json    the rings of one kommun's RegSO. What the map needs
                            — one kommun, not the country.

   `AREAS` is the name index the page is built with (code, name, kommun) and the
   values are merged INTO those same objects, so `byRegso`, `AREA_OPTS` and every
   reference taken before the fetch stays valid. A surface that needs figures
   asks regsoReady() first and says "Loading…" while it waits — a RegSO whose
   file has not landed must never read as a dash, which is what a suppressed
   value looks like.

   The values file is asked for as soon as the first paint is done rather than on
   the first surface that needs it: everything but the bare national map wants it,
   it is ~1 MB over the wire, and holding it back only moves the wait. The ring
   files stay strictly on demand. */
const RG_META = D.regso_meta || {};
const RG_IDX = D.regso_index || {};
const RG = { vals: false, valsPending: false, valsFailed: false,
             rings: {}, ringPending: {}, ringFailed: {} };
const REGSO_N = RG_META.n || AREAS.length;
/* every RegSO of a kommun, by name — right from the first paint, rings or not */
const regsoAll = code => (code ? AREAS.filter(a => a.kommun === code) : []);
/* the same list, but only once its rings are here: what may be DRAWN. An empty
   list is what stops L.polygon() being handed an undefined ring. */
const regsoDrawable = code => (code && RG.rings[code] ? regsoAll(code) : []);
const regsoRingsIn = code => !!(code && RG.rings[code]);
/* figures for all of them, and — when a kommun is named — its geometry too */
const regsoReady = code => RG.vals && (!code || regsoRingsIn(code));
const regsoFailed = code => RG.valsFailed || !!(code && RG.ringFailed[code]);
/* Callers that want to know when the pool is here queue up rather than each
   starting a fetch of their own — and a caller that arrives while one is already
   in flight must still be told, which is the bug an `if (pending) return` on its
   own would have: the export and the pin both ask, and whichever asked second
   would have waited for ever. */
const RG_WAITERS = [];
function rgFlush() { RG_WAITERS.splice(0).forEach(f => { try { f(); } catch (e) {} }); }
function regsoLoadVals(then) {
  /* a failure answers too: a caller that is waiting to write a CSV has to be
     let go, and the surfaces say what went wrong on their own */
  if (RG.vals || RG.valsFailed) { if (then) then(); return; }
  if (then) RG_WAITERS.push(then);
  if (RG.valsPending) return;
  if (!RG_META.file) { RG.valsFailed = true; rgFlush(); return; }
  RG.valsPending = true;
  fetch(RG_META.file)
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(j => {
      /* merged into the objects the page already holds, never replaced: a
         reference taken before the fetch has to keep pointing at the same area */
      (j.areas || []).forEach(a => { const o = byRegso[a.code]; if (o) Object.assign(o, a); });
      RG.vals = true; RG.valsPending = false; RG.valsFailed = false;
      afterRegso(); rgFlush();
    })
    .catch(() => { RG.valsPending = false; RG.valsFailed = true; afterRegso(); rgFlush(); });
}
function regsoLoadRings(code, then) {
  if (!code || RG.rings[code]) { if (then) then(); return; }
  const meta = RG_IDX[code];
  if (!meta || RG.ringPending[code]) { if (!meta) RG.ringFailed[code] = true; return; }
  RG.ringPending[code] = true;
  fetch(meta.file)
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(j => {
      const rings = j.rings || {};
      for (const cod in rings) { const o = byRegso[cod]; if (o) o.rings = GC.decodeRings(rings[cod]); }
      RG.rings[code] = true; delete RG.ringPending[code]; delete RG.ringFailed[code];
      afterRegso(); if (then) then();
    })
    .catch(() => { delete RG.ringPending[code]; RG.ringFailed[code] = true; afterRegso(); if (then) then(); });
}
/* the figures always, the geometry of one kommun when one is named */
function regsoLoad(code) { regsoLoadVals(); if (code) regsoLoadRings(code); }
/* Coalesced, and a full re-render rather than afterLazyLoad(): the RegSO pool is
   read as TEXT by the table, the area page and every rank, not only drawn as a
   layer, so repainting the overlays would leave those on "Loading…" for ever. */
let RG_T = null;
function afterRegso() {
  if (RG_T) return;
  RG_T = setTimeout(() => { RG_T = null; renderKeep(); }, 60);
}

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
/* sub = which layer a drilled kommun shows: its RegSO (default) or its DeSO.
   indPrev = the indicator `0` (Map only) comes back to. */
const MK = { ind: (IND[0] || {}).key, indPrev: (IND[0] || {}).key, kommun: null, own: false,
             year: LATEST, sub: "regso", fq: "year" };
const desoMode = () => !!(MK.kommun && MK.sub === "deso" && desoLoaded(MK.kommun));

/* area page: `show` is the set of open <details> sections, serialised as show= */
const AR = { type: null, code: null, ind: null, sub: "regso", show: new Set() };
/* The outlook chart answers "is this place growing", and it is the only place a
   projection is fully explained, so it opens itself on a kommun page. Below
   kommun level SCB publishes no projection, so nothing opens. */
const areaShowDefaults = () => (AR.type === "kommun" ? ["outlook"] : []);

/* Test property: ONE pin at a time (the URL codec in route_core.js is
   list-capable so the "paste several links" idea needs no second format). */
const PROP_RAD_DEFAULT = 1000;
/* v2.1 P5: the two sections the summary strip's own figures come out of open
   themselves, so a reader who follows a strip item straight down finds the
   working already on screen. The Summary strip itself is not an accordion — it
   is the page's first row and there is nothing to fold. Everything else
   (Public buildings, Schools, Infrastructure, Safety, Climate, the area profile,
   Sources) stays folded, and `show=` still overrides all of it. */
const PROP_SHOW_DEFAULTS = ["listings", "services"];
const PROP = { lat: null, lon: null, label: "", rad: PROP_RAD_DEFAULT,
               show: new Set(PROP_SHOW_DEFAULTS), res: null, resKey: "" };
const UI = { indxOpen: false, menu: null, cardFold: false, legFold: {} };           /* fold states that survive a re-render */
const MKT = { src: false };                                                        /* market: sources panel open */
/* Charts opens with a chart on it. "Nothing to plot yet" was the first thing a reader
   saw who followed the nav rather than a ↗ link, and an empty frame teaches nothing
   about what the page can do. The default is the three storstäder plus Uppsala — the
   four kommuner every Swedish housing conversation starts from — against the Sweden
   median, which is the `median` checkbox and is on. An empty chart is still reachable:
   `clear`, and `#charts?a=-` in a link. */
const CH_DEFAULT_AREAS = ["0180", "1480", "1280", "0380"].filter(c => byCode[c]).map(c => "kommun:" + c);
const CH_EMPTY = "-";                                                              /* "no areas" spelled in the hash, so `clear` is linkable */
const CH = { ind: (IND[0] || {}).key, areas: CH_DEFAULT_AREAS.slice(), y0: "", y1: "", median: true, title: "", mode: "auto", dist: "age", fq: "year" };   /* chart generator; fq = yearly | quarterly */
const T = { q: "", level: "kommun", lan: "", minPop: 0, cols: "headline" };                           /* table view filters */
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
/* ---------- the headline figures ----------
   Sweden's strength is what SCB publishes below kommun, and the headline row leads with
   it: five figures that exist at DeSO and RegSO — population growth, median disposable
   income, the hyresrätt share, post-secondary education and the employment rate — in
   that order, on the map's area card, on every area page and on Test property.

   Rent is the sixth and the only kommun-only figure promoted here, because "what does it
   cost to rent here" is the question a housing dashboard is opened with. On a sub-area it
   is the kommun's number and the tile says so in words. Nothing else kommun-only earns a
   slot: six municipal figures on a RegSO page would be a page about the kommun wearing
   the area's name.

   HL_SPARE is not a sixth, seventh and eighth headline — it only keeps the row at five
   where one of the five has no value for this particular area. */
const HL_LOCAL = ["growth", "income_med", "renters", "higher_ed", "employment"];
const HL_MUNI = ["rent"];
const HL_SPARE = ["unemp", "young", "flats", "single", "income"];
/* the order the map popups and the table's headline columns read, longest first */
const HL_KEYS = HL_LOCAL.concat(HL_MUNI, HL_SPARE);
/* quick-pick indicator chips next to the indicator select */
const QUICK_KEYS = ["growth", "income_med", "rent", "unemp", "renters", "kt_tal", "crime_1000"];
/* link into the chart generator with one area pre-selected */
const chartLink = (key, type, code) => `charts?ind=${encodeURIComponent(key)}&a=${type}:${code}&y0=&y1=&med=1`;
/* value of indicator k for kommun/area o in the selected year (latest = live field, else history) */
const V = (o, k, y) => {
  const yr = y || MK.year; if (!o) return null;
  /* a quarter reads the quarterly series, a year the yearly one — the period
     carries its own kind, so nothing else has to branch. Each quarterly point is
     ONE quarter as Brå publishes it, never a rolling four-quarter sum. */
  if (yr && /K\d/.test(yr)) { const q = o.q && o.q[k]; return q && q[yr] != null ? q[yr] : null; }
  if (!yr || yr === LATEST) return o[k] ?? null;
  const h = o.hist && o.hist[k]; return h && h[yr] != null ? h[yr] : null;
};
/* the published margin of error that travels with a value, when the source has one */
const MOE = (o, k, y) => { const yr = y || MK.year; if (!o) return null; if (!yr || yr === LATEST) return o[k + "_moe"] ?? null; const h = o.hist && o.hist[k + "_moe"]; return h && h[yr] != null ? h[yr] : null; };
const yearsForPool = (k, pool) => YEARS.filter(y => y === LATEST || pool.some(m => m.hist && m.hist[k] && m.hist[k][y] != null));
/* years with actual history for charts and sparklines — the lagging "latest" value is not repeated as a later year */
const histYears = (k, pool) => YEARS.filter(y => pool.some(m => m.hist && m.hist[k] && m.hist[k][y] != null));
function curPool() { if (S.view === "area") { const e = areaEntity(); return e ? e.peers : MUNI; } if (S.view === "table") return T.level === "deso" ? allDeso() : T.level === "regso" ? AREAS : MUNI; return desoMode() ? desoAreas(MK.kommun) : MUNI; }
const allDeso = () => { const out = []; for (const k in DESO) out.push(...DESO[k]); return out; };
/* The pool the PERIOD controls read, which is not always the pool on screen.
   While the RegSO or DeSO figures are still in flight their areas carry no
   history, and reading the selectable years off them would find only the latest
   one — so `#data/areas/regso?y=2020` would be rewritten to the latest year
   before the file landed and never put back. Kommun history is a superset of
   every sub-level's, so it stands in until the pool has any history at all. */
const periodPool = () => { const p = curPool(); return p.some(o => o && o.hist) ? p : MUNI; };
const yearsFor = k => yearsForPool(k, periodPool());
const curInds = () => { if (S.view === "area") { const e = areaEntity(); return e ? e.inds : IND; } return IND; };

/* ---------- Map only ----------
   The owner's wish: the map with nothing coloured in — boundaries, the basemap and
   whichever feature layers are on, and no choropleth at all. It is the ABSENCE of
   an indicator, not another indicator and not another layer, so it lives in the
   same `ind=` key (`ind=none`; the codec is in route_core.js) and every control
   that names the active indicator names it: the first chip, the first row of the
   picker, and the key `0`.

   It is only offered where there is a map to look at. A Data table's highlighted
   column and a Charts axis need a real series, so on those views `ind=none` is
   dropped from the hash and the view falls back to its first indicator rather than
   drawing a column of dashes. */
/* read off route_core.js, which is inlined before this file and owns the spelling */
const IND_NONE = (window.ROUTE_CORE || {}).IND_NONE || "none";
const NONE_IND = { key: IND_NONE, label: "Map only", short: "Map only", unit: "", group: "Map",
  fmt: "int", direction: "neutral", level: "kommun", levels: ["kommun", "regso", "deso"],
  desc: "No indicator: the boundaries are drawn as outlines and nothing is coloured in. "
      + "Clicking an area still opens its figures.", source: "" };
const MAP_ONLY_VIEWS = ["makro", "area", "property"];
const mapOnlyOk = () => MAP_ONLY_VIEWS.includes(S.view);
const mapOnly = () => MK.ind === IND_NONE && mapOnlyOk();
/* A link out to Charts needs a real series, so from Map only it names the first
   headline indicator rather than passing `none` to an axis. */
const linkInd = () => (MK.ind === IND_NONE
  ? (HL_KEYS.find(k => IND.some(i => i.key === k)) || (IND[0] || {}).key || "")
  : MK.ind);
/* One setter for every control that changes the map's indicator, so "remember what
   `0` comes back to" and "a period that does not exist for the new indicator" are
   handled in one place rather than in four click handlers. */
function setMapInd(key) {
  if (key !== IND_NONE) MK.indPrev = key;
  MK.ind = key;
  if (MK.fq === "q" && !quarterly(curInd())) MK.fq = "year";
  if (!curPeriods().includes(MK.year)) MK.year = newestPeriod();
}
function toggleMapOnly() {
  if (MK.ind === IND_NONE) {
    const back = [MK.indPrev].concat(QUICK_KEYS).find(k => k && curInds().some(i => i.key === k));
    setMapInd(back || (curInds()[0] || {}).key);
  } else setMapInd(IND_NONE);
  syncHash(); renderKeep();
}
const curInd = () => {
  if (mapOnly()) return NONE_IND;
  const L = curInds(); return L.find(i => i.key === MK.ind) || L[0] || { key: "", label: "", fmt: "pct1" };
};

/* ---------- routing (hash) ----------
   The hash is the source of truth, and src/route_core.js owns its spelling: the
   canonical v2.0 paths, the alias table every old link resolves through, and the
   codecs for the property pin and the layer list. app.js decides only *when* to
   rewrite — on every hashchange, which is safe because toV2() is idempotent.

   Internal view ids are unchanged on purpose (`table`, `market`, `pipeline` are
   now the three non-default tabs of the Data section rather than destinations of
   their own), so RENDER, the nav and tests/smoke.js keep working off one name
   each while only the hash spelling and the labels move. */
const RC = window.ROUTE_CORE;
/* Which feature layers are drawn. One set, read by the map, the area page's
   mini-map and the Test property mini-map, carried in the hash as `lay=`. */
const LAY = new Set();
/* Climate zones ride along with a Climate indicator; `zones=0` hides them. */
const ZN = { off: false };
/* Which tab the Data section shows. */
const DT = { tab: "areas" };
/* the map area card: which sections are open, and whether the panel itself is
   collapsed to its title bar (`card=0` in the hash — v2.1 P4) */
const MC = { show: new Set(), fold: false };

/* `show=` is the whole truth when it is present; when the key is absent the
   view's own defaults apply. Closing every section therefore has to serialise
   as something rather than as an empty value, or the default would come back on
   the next parse — that something is `show=none`. */
function setShow(set, raw, defaults) {
  set.clear();
  if (raw == null) { (defaults || []).forEach(k => set.add(k)); return; }
  if (raw === "none") return;
  String(raw).split(",").filter(Boolean).forEach(k => set.add(k));
}
function showValue(set, defaults) {
  const on = [...set];
  if (on.length) return on.join(",");
  return (defaults || []).length ? "none" : "";
}

function hashFor() {
  const q = {};
  const withInd = () => { if (MK.ind) q.ind = MK.ind; if (MK.year && MK.year !== LATEST) q.y = MK.year;
    if (MK.fq === "q") q.fq = "q"; };
  let p;
  if (S.view === "area") {
    p = `area/${AR.type}/${AR.code}`; withInd();
    if (AR.sub !== "regso") q.sub = AR.sub;
    q.show = showValue(AR.show, areaShowDefaults());
  } else if (S.view === "table") { p = `data/areas/${T.level}`; withInd(); if (T.cols === "all") q.cols = "all"; }
  else if (S.view === "market") { p = MKT.src ? "data/sources" : "data/national"; }
  else if (S.view === "pipeline") { p = "data/projects"; if (PIPE.type) q.t = PIPE.type; if (PIPE.status) q.s = PIPE.status; }
  else if (S.view === "charts") {
    /* buildHash drops an empty value, so an emptied set has to be spelled out or the
       link would reopen with the default four and `clear` would not survive a reload */
    p = "charts"; q.ind = CH.ind; q.a = CH.areas.length ? CH.areas.join(",") : CH_EMPTY;
    if (CH.y0) q.y0 = CH.y0; if (CH.y1) q.y1 = CH.y1;
    q.med = CH.median ? "1" : "0";
    if (CH.mode !== "auto") q.mode = CH.mode;
    if (CH.mode === "dist") q.dist = CH.dist;
    if (CH.fq !== "year") q.fq = CH.fq;
  } else if (S.view === "property") {
    p = "property"; withInd();
    if (PROP.lat != null) q.p = RC.propSerialise([{ lat: PROP.lat, lon: PROP.lon, label: PROP.label }]);
    if (PROP.rad !== PROP_RAD_DEFAULT) q.rad = String(PROP.rad);
    q.show = showValue(PROP.show, PROP_SHOW_DEFAULTS);
    if (LAY.size) q.lay = layList();
    if (LAY.has("listings") || PROP.show.has("listings")) Object.assign(q, lstQuery());
  } else if (S.view === "sheet") { p = sheetHash(SH.kind, ...SH.parts); }
  else if (S.view === "makro") {
    p = "map" + (MK.kommun ? "/" + MK.kommun + (MK.sub === "deso" ? "/deso" : "") : "");
    withInd();
    if (LAY.size) q.lay = layList();
    if (LAY.has("listings")) Object.assign(q, lstQuery());
    if (ZN.off) q.zones = "0";
    if (MK.kommun) q.show = showValue(MC.show, MC_SHOW_DEFAULTS);
    /* the panel is open by default, so only the collapsed state is spelled out */
    if (MK.kommun && MC.fold) q.card = "0";
    /* Camera in the hash, so a view can be linked to. Zooming still never
       changes the selection — this records where the camera is, it does not
       give it a say in what is selected. */
    if (LF.map && LF.shownMuni === MK.kommun) {
      const c = LF.map.getCenter();
      q.c = `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`; q.z = String(LF.map.getZoom());
    }
  } else p = S.view;
  return RC.buildHash(p, q);
}
/* the canonical order, so two links that mean the same thing are the same link */
const layList = () => RC.LAYERS.filter(k => LAY.has(k)).join(",");

function parseHash() {
  const raw = (location.hash || "#map").replace(/^#/, "");
  const canon = RC.toV2(raw, { isClim: isClimKey });
  /* An old link is rewritten in place — no history entry, so Back still goes
     where the reader came from rather than bouncing off the redirect. */
  if (canon !== raw) { try { history.replaceState(null, "", "#" + canon); } catch (e) {} }
  const r = RC.toInternal(canon, { isClim: isClimKey });
  const q = r.query, parts = r.parts, v = r.view;
  const prevView = S.view;
  if (q.ind) MK.ind = q.ind;
  if (q.ind && q.ind !== IND_NONE) MK.indPrev = q.ind;
  MK.fq = q.fq === "q" ? "q" : "year";
  MK.year = q.y || LATEST;
  LAY.clear();
  String(q.lay || "").split(",").filter(Boolean).forEach(k => { if (RC.LAYERS.includes(k)) LAY.add(k); });
  ZN.off = q.zones === "0";
  lstReadHash(q);

  if (v === "area" && parts[1] && parts[2]) {
    S.view = "area"; AR.type = parts[1]; AR.code = parts[2];
    AR.sub = q.sub === "deso" ? "deso" : "regso";
    setShow(AR.show, q.show, areaShowDefaults());
    /* the sub-municipal files this page needs. A kommun page shows its RegSO in a
       table and on the mini-map; a RegSO page needs the whole pool for its rank
       and the Sweden median, and its kommun's rings for the map beside it. */
    if (AR.type === "deso") { loadDeso(desoKomOf(AR.code)); regsoLoadVals(); }
    else if (AR.type === "kommun") { loadDeso(AR.code); regsoLoad(AR.code); }
    else if (AR.type === "regso") regsoLoad(komOf(AR.code));
  } else if (v === "table") { S.view = "table"; if (RC.LEVELS.includes(parts[1])) T.level = parts[1];
    T.cols = q.cols === "all" ? "all" : "headline"; DT.tab = "areas";
    if (T.level === "regso") regsoLoadVals(); }
  else if (v === "market") { S.view = "market"; MKT.src = q.src === "1"; DT.tab = MKT.src ? "sources" : "national"; }
  else if (v === "pipeline") { S.view = "pipeline"; PIPE.type = q.t || ""; PIPE.status = q.s || ""; DT.tab = "projects"; }
  else if (v === "property") {
    S.view = "property";
    const pin = (r.pins || [])[0] || null;
    PROP.lat = pin ? pin.lat : null; PROP.lon = pin ? pin.lon : null; PROP.label = pin ? pin.label : "";
    PROP.rad = RC.RADII.includes(Number(q.rad)) ? Number(q.rad) : PROP_RAD_DEFAULT;
    setShow(PROP.show, q.show, PROP_SHOW_DEFAULTS);
    if (PROP.lat != null) propResolve();
  } else if (SHEETS[v] && parts.length > 1) { S.view = "sheet"; SH.kind = v; SH.parts = parts.slice(1); }
  else if (v === "charts") {
    /* `ind=none` is Map only — a chart axis cannot be nothing, so it is ignored
       here as well as stripped from the hash by route_core.js */
    S.view = "charts"; CH.ind = (q.ind && q.ind !== IND_NONE) ? q.ind : CH.ind;
    /* `a=-` and `a=` are both an explicit empty set; no `a=` at all leaves whatever is
       already selected, which on a cold open is CH_DEFAULT_AREAS */
    CH.areas = (q.a === "" || q.a === CH_EMPTY) ? []
      : q.a ? q.a.split(",").filter(Boolean) : CH.areas;
    CH.y0 = q.y0 || ""; CH.y1 = q.y1 || "";
    CH.median = q.med !== "0"; CH.mode = q.mode || "auto";
    CH.dist = q.dist || CH.dist; CH.fq = q.fq === "q" ? "q" : "year";
    /* a RegSO series, or the "Sweden — median of RegSO" line, is the whole pool */
    if (CH.areas.some(a => String(a).indexOf("regso:") === 0)) regsoLoadVals();
  } else {
    S.view = "makro";
    MK.kommun = parts[1] && byCode[parts[1]] ? parts[1] : null;
    MK.sub = parts[2] === "deso" ? "deso" : "regso";
    setShow(MC.show, q.show, MC_SHOW_DEFAULTS);
    MC.fold = q.card === "0";
    /* RegSO is the default sub-level AND the fallback while a DeSO file is in
       flight, so a drilled kommun always wants its RegSO — both halves of it. */
    if (MK.kommun) regsoLoad(MK.kommun);
    if (MK.sub === "deso") loadDeso(MK.kommun);
  }
  /* Map only survives only on a view that has a map; anywhere else the view falls
     back to its first indicator, which is what route_core.js has already done to
     the hash. */
  if (MK.ind === IND_NONE) { if (!mapOnlyOk()) MK.ind = (curInds()[0] || {}).key; }
  else if (!curInds().some(i => i.key === MK.ind)) MK.ind = (curInds()[0] || {}).key;
  if (MK.fq === "q" && !quarterly(curInd())) MK.fq = "year";
  if (!curPeriods().includes(MK.year)) MK.year = newestPeriod();
  if (S.view === "makro") {
    /* an explicit camera in the hash wins over the automatic fit */
    const cc = (q.c || "").split(",").map(Number);
    const zz = Number(q.z);
    const haveCam = cc.length === 2 && !isNaN(cc[0]) && !isNaN(cc[1]) && zz >= 4 && zz <= 18;
    if (haveCam) { LF.center = [cc[0], cc[1]]; LF.zoom = zz; }
    /* zoom to a municipality the first time it is shown; back to the national frame when it is cleared */
    if (MK.kommun && MK.kommun !== LF.shownMuni && !haveCam) LF.pendingFit = MK.kommun;
    if (!MK.kommun && LF.shownMuni && !haveCam) { LF.center = [62.5, 16.5]; LF.zoom = 5; }
    LF.shownMuni = MK.kommun;
  }
  return { viewChanged: prevView !== S.view };
}
function go(hash) { if ("#" + hash === location.hash) { parseHash(); render(); } else location.hash = hash; }
function syncHash() { history.replaceState(null, "", "#" + hashFor()); }
/* A handle on the live page: the Leaflet instance is a lexical const, so without
   this neither the console nor a screenshot script can set a precise view. */
window.AM = { get map() { return LF.map; }, get area() { return LF.amap; },
  go, D, MK, S, LF, LAY, PROP,
  /* LST is declared further down the file, so it is read lazily */
  get LST() { return LST; },
  /* v2.1 P4: what the lazily fetched RegSO pool is doing, and a promise a test
     can await instead of sleeping. `injectRegso` is how tests/smoke.js — which
     has no fetch — puts the pool in place from data/processed/regso/. */
  RG, regsoReady: code => regsoReady(code),
  loadAreas: () => Promise.all([loadAllRegso(), loadAllDeso()]),
  injectRegso: (vals, ringsByKommun) => {
    (((vals || {}).areas) || []).forEach(a => { const o = byRegso[a.code]; if (o) Object.assign(o, a); });
    if (vals) { RG.vals = true; RG.valsFailed = false; RG.valsPending = false; rgFlush(); }
    for (const k in (ringsByKommun || {})) {
      const rings = (ringsByKommun[k] || {}).rings || ringsByKommun[k] || {};
      for (const cod in rings) { const o = byRegso[cod]; if (o) o.rings = GC.decodeRings(rings[cod]); }
      RG.rings[k] = true; delete RG.ringFailed[k];
    }
  },
  /* v2.1 P5: the summary strip's model, so a check can compare what the seven
     items say with what the Nearby export writes without parsing either. */
  stripItems: () => stripItems(),
  /* the export model, readable without downloading a file. `exportRowCount`
     skips the CSV serialisation — "All area data" is 556 000 rows, and a check
     that only wants the count should not build 150 MB of strings for it. */
  exportRows: id => exportRows(id),
  exportRowCount: id => ((EXPORTS[id] || { rows: () => [] }).rows() || []).length,
  exportUnitProblems: () => exportUnitProblems() };
window.addEventListener("hashchange", () => {
  /* a popover belongs to the screen it was opened on */
  UI.menu = null; SR.open = false;
  const r = parseHash(); render();
  if (r.viewChanged) { const m = document.getElementById("main"); if (m) m.scrollTop = 0; }
});

/* ---------- views & navigation ----------
   Four destinations. Market and Pipeline became tabs of Data, Sources became its
   fourth tab, and the Listings page became a section of Test property — so a
   reader chooses between four things rather than seven, and every table lives in
   one place with one Export menu. */
const VIEWS = [
  ["makro",    "Map",           "Demographics, income, housing and prices by kommun, RegSO and DeSO", "map"],
  ["table",    "Data",          "Every area, every project, the national series and the sources — as tables, with export", "data/areas/kommun"],
  ["charts",   "Charts",        "Pick an indicator, areas and years — export the chart as PNG or the data as CSV", "charts"],
  ["property", "Test property", "Drop a pin from a Google Maps link and read every layer against that spot, including what is advertised for rent nearby", "property"]];
/* which nav item is lit for a view that is not itself a destination */
const NAV_ON = { area: "makro", market: "table", pipeline: "table" };
const viewOf = id => VIEWS.find(v => v[0] === id) || VIEWS[0];
const navOn = () => (S.view === "sheet" ? ((SHEETS[SH.kind] || {}).nav || "makro") : (NAV_ON[S.view] || S.view));

function navHtml() {
  const on = navOn();
  return VIEWS.map(v => `<button class="nav-item ${on === v[0] ? "on" : ""}" data-testid="nav-item" data-go="${v[3]}" title="${esc(v[2])}"><b>${v[1]}</b></button>`).join("");
}
function renderNav() {
  const el = document.getElementById("nav"); if (el) el.innerHTML = navHtml();
  /* The drawer holds a second copy of the same list, but only while it is open:
     otherwise every "how many nav items are there" question — a reader tabbing
     through, a screen reader, a test — would get eight where there are four. */
  const dr = document.getElementById("navdrawer");
  if (dr) dr.innerHTML = document.body.classList.contains("navopen") ? navHtml() : "";
  const foot = exportFootHtml();
  const sf = document.getElementById("sidefoot"); if (sf) sf.innerHTML = foot;
  const df = document.getElementById("drawerfoot");
  if (df) df.innerHTML = document.body.classList.contains("navopen") ? foot : "";
  const mv = document.getElementById("mview");
  if (mv) mv.textContent = (VIEWS.find(v => v[0] === navOn()) || VIEWS[0])[1];
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
  else if (S.view === "table" || S.view === "market" || S.view === "pipeline") {
    tail = "Data"; kind = (DATA_TABS.find(t => t[0] === DT.tab) || [])[1] || ""; }
  else if (S.view === "property") { tail = "Test property";
    kind = PROP.lat != null ? (propName() || "a pin") : "drop a pin"; }
  else if (S.view === "sheet") { const def = SHEETS[SH.kind];
    if (def && def.nav === "table") c.push(["Data", "data/projects"]);
    tail = (def && def.crumb && def.crumb(SH.parts)) || SH.parts.join(" / "); kind = (def && def.label) || ""; }
  else { tail = viewOf(S.view)[1]; kind = { charts: "PNG and CSV export" }[S.view] || ""; }
  return { c, tail, kind };
}
/* Page-level actions live on the top bar's right: full screen for the map, the
   copy-link button for a property. One place, so no view grows a second row. */
function pageActions() {
  if (S.view === "makro") return `<button class="lk" data-fs data-testid="map-full" title="Full screen (Esc to exit)">⤢ Full screen</button>`;
  if (S.view === "property" && PROP.lat != null) return `<button class="lk" data-copylink>Copy link</button>`;
  return "";
}
function renderTop() {
  const { c, tail, kind } = crumbs();
  document.getElementById("hd").innerHTML = `<nav class="crumbs">${c.map(([l, h]) => `<button data-go="${esc(h)}">${esc(l)}</button><i>›</i>`).join("")}<b>${esc(tail)}</b>${kind ? `<span class="dim">${esc(kind)}</span>` : ""}</nav>`;
  const pa = document.getElementById("pageact"); if (pa) pa.innerHTML = pageActions();
}
const RENDER = { makro: vMakro, table: vData, area: vArea, charts: vCharts, market: vData,
                 sheet: vSheet, property: vProperty, pipeline: vData };
function render() {
  dropMaps();
  renderNav(); renderTop();
  const body = document.getElementById("body");
  body.innerHTML = (RENDER[S.view] || vMakro)();
  enableSort(body);
  if (UI.menu === "picker") { const f = document.getElementById("indsearch"); if (f) { f.focus(); f.select(); } }
  /* with no pin there is exactly one thing to do on the page, so the caret goes there */
  else if (S.view === "property" && PROP.lat == null) { const f = document.getElementById("propin"); if (f) f.focus(); }
}
function renderKeep() { const m = document.getElementById("main"), y = m.scrollTop; render(); m.scrollTop = y; }

/* ---------- what to do when a lazily loaded file arrives ----------
   Two kinds of view read these files. A map view draws them as layers, so the
   overlays and their legends are repainted and the page is left alone. Test
   property reads them as TEXT — the Services table, the six nearest schools, the
   Infrastructure rows — which is built during render, so the page itself has to
   be rendered again or the section stays on "Loading…" for ever.

   This is one helper, called from every loader, because v2.0 renamed the pin view
   from "analysis" to "property" and left four `S.view === "analysis"` checks
   behind: Schools and Infrastructure never left "Loading…", and Services showed
   0 in every category on a pin that has 31 groceries within a kilometre.

   The re-render is coalesced: a pin near a kommun boundary loads up to a dozen
   files and each one would otherwise rebuild the whole page. */
const isPinView = () => S.view === "property";
let LAZY_T = null;
function afterLazyLoad() {
  if (!isPinView()) { lfOverlays(); ovLegends(); return; }
  if (LAZY_T) return;
  LAZY_T = setTimeout(() => {
    LAZY_T = null;
    if (isPinView()) renderKeep(); else { lfOverlays(); ovLegends(); }
  }, 120);
}

/* ---------- the Leaflet teardown registry ----------
   Every map this app creates is registered here and every one of them is removed
   before #body is replaced. Without it a map whose DOM is gone keeps receiving
   tile, fetch and zoom-animation callbacks and throws inside _getMapPanePos on a
   deleted _mapPane — which in the Danish edition killed every later map
   interaction with no visible error. `window.__maps` is the same array, so a
   Playwright test can drag a mini-map and read its centre back.

   Two halves, as in the Danish brief: this registry, and the prototype guards
   below for the animation frames that are already in flight when a map goes. */
const MAPS = [];
window.__maps = MAPS;
function regMap(m) { MAPS.push(m); return m; }
const LF_LAYER_KEYS = "areaG labG ownG usoLayer schLayer srvLayer pubLayer infLayer climLayer listLayer".split(" ");
function dropMaps() {
  while (MAPS.length) {
    const m = MAPS.pop();
    /* off() FIRST. Leaflet's stop() completes a pan animation, and completing one
       fires `moveend` — on a map that is being destroyed, whose moveend handler
       writes the camera back into LF. That is how a fresh `#map/0180?c=…&z=14`
       ended up at the zoom of the map it had just replaced. */
    try { m.off(); } catch (e) {}
    try { m.stop(); } catch (e) {}
    try { m.remove(); } catch (e) {}
  }
  LF.map = null; LF.amap = null; LF.pmap = null;
  LF_LAYER_KEYS.forEach(k => { LF[k] = null; });
  "sch srv pub clim list uso inf".split(" ").forEach(k => { LF[k + "Canvas"] = null; LF[k + "Drawn"] = false; });
  LF.ctx = null;
}
function lfGuardMap() {
  if (typeof L === "undefined" || !L.Map || L.Map.prototype._amGuarded) return;
  const mp = L.Map.prototype, end = mp._onZoomTransitionEnd, move = mp._move;
  mp._onZoomTransitionEnd = function () { if (!this._mapPane) return; return end.apply(this, arguments); };
  mp._move = function () { if (!this._mapPane) return this; return move.apply(this, arguments); };
  mp._amGuarded = true;
}

/* ---------- the mobile drawer ---------- */
function navToggle() { document.body.classList.contains("navopen") ? navClose() : navOpen(); }
function navOpen() {
  document.body.classList.add("navopen");
  renderNav();
  const d = document.getElementById("drawer"), s = document.getElementById("scrim");
  if (d) { d.hidden = false; const f = d.querySelector("button"); if (f) f.focus(); }
  if (s) s.hidden = false;
  const t = document.querySelector("[data-testid=nav-toggle]"); if (t) t.setAttribute("aria-expanded", "true");
}
function navClose() {
  if (!document.body.classList.contains("navopen")) return;
  document.body.classList.remove("navopen");
  renderNav();
  const d = document.getElementById("drawer"), s = document.getElementById("scrim");
  if (d) d.hidden = true;
  if (s) s.hidden = true;
  const t = document.querySelector("[data-testid=nav-toggle]");
  if (t) { t.setAttribute("aria-expanded", "false"); t.focus(); }
}

/* the address bar already holds the whole view, so "copy link" is exactly that */
function copyLink() {
  const url = location.href;
  const done = () => { const b = document.querySelector("[data-copylink]"); if (b) { b.textContent = "Copied"; setTimeout(() => { b.textContent = "Copy link"; }, 1200); } };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, () => {});
  else done();
}

/* ---------- small shared helpers ---------- */
/* A DeSO code carries its kommun in the first four characters (0114A0010_DeSO2025),
   which is why DeSO → RegSO → kommun → län is an attribute rollup here and never
   a spatial join. */
/* Every code below kommun level carries its kommun in front of it —
   0180R001_RegSO2025, 0180A0010_DeSO2025 — so the file a code needs is an
   attribute rollup and never a lookup. */
const komOf = code => String(code || "").slice(0, 4);
const desoKomOf = komOf;
function isClimKey(k) { return CLIM_KEYS.indexOf(k) >= 0; }
/* the LF bookkeeping key for a layer: LF.<key>Layer, LF.<key>Drawn, LF.<key>Canvas */
const LAY_KEY = { infra: "inf", public: "pub", services: "srv", schools: "sch", uso: "uso", listings: "list" };
const layKey = k => LAY_KEY[k] || k;

document.addEventListener("click", e => {
  const g = sel => e.target.closest(sel);
  let el;
  /* A popover closes on any click that is not inside it and not on its own
     trigger — one rule for the Export menu, the Layers menu and the picker. */
  if ((el = g("[data-menu]"))) { UI.menu = UI.menu === el.dataset.menu ? null : el.dataset.menu; UI.pickQ = ""; renderKeep(); return; }
  if (UI.menu && !g(".menupop")) { UI.menu = null; renderKeep(); }
  if ((el = g("[data-go]"))) { navClose(); go(el.dataset.go); return; }
  if ((el = g("[data-searchgo]"))) { searchGo(el.dataset.searchgo); return; }
  if ((el = g("[data-tcols]"))) { T.cols = el.dataset.tcols; syncHash(); renderKeep(); return; }
  if ((el = g("[data-tlevel]"))) { T.level = el.dataset.tlevel; if (!curInds().some(i => i.key === MK.ind)) MK.ind = curInds()[0].key; syncHash(); renderKeep(); return; }
  if ((el = g("[data-export]"))) { UI.menu = null; runExport(el.dataset.export); renderKeep(); return; }
  if (g("[data-navtoggle], [data-testid=nav-toggle]")) { navToggle(); return; }
  if (g("[data-navclose]") || g("#scrim")) { navClose(); return; }
  if (g("[data-copylink]")) { copyLink(); return; }
  if ((el = g("[data-minifull]"))) { toggleMiniFull(el.dataset.minifull); return; }
  if (g("[data-mcfold]")) { MC.fold = !mcFolded(); syncHash(); renderKeep(); return; }
  if (g("[data-mkown]")) { MK.own = !MK.own; renderKeep(); return; }
  if (g("[data-fs]")) { toggleFullscreen(); return; }
  if (g("[data-back]")) { history.back(); return; }
  if ((el = g("[data-propclear]"))) { PROP.lat = PROP.lon = null; PROP.label = ""; PROP.res = null; PROP.resKey = "";
    syncHash(); renderKeep(); return; }
  /* a summary-strip item opens the section its figure comes from and scrolls to it */
  if ((el = g("[data-secgo]"))) { propGoSec(el.dataset.secgo); return; }
  if ((el = g("[data-layer]"))) { const k = el.dataset.layer;
    if (LAY.has(k)) LAY.delete(k); else LAY.add(k);
    LF[layKey(k) + "Drawn"] = false; syncHash(); renderKeep(); return; }
  if ((el = g("[data-zones]"))) { ZN.off = !ZN.off; LF.climDrawn = false; syncHash(); renderKeep(); return; }
  if ((el = g("[data-lstgroup]"))) { lstToggle(LST.filters.groups, el.dataset.lstgroup); return; }
  if (g("[data-lstretry]")) { lstRetry(); return; }
  if (g("[data-lstretrypin]")) { LST.error = null; LST.pins.clear(); LST.pinFails.clear(); lstSectionRefresh(); return; }
  if (g("[data-lstshow]")) { LST.open = !LST.open; syncHash(); lstSectionRefresh(); return; }
  if (g("[data-lstcsv]")) { lstCsv(); return; }
  if ((el = g("[data-lstalloc]"))) { lstToggle(LST.filters.allocation, el.dataset.lstalloc); return; }
  if ((el = g("[data-lstroom]"))) { lstToggle(LST.filters.rooms, el.dataset.lstroom); return; }
  if (g("[data-lstoffer]")) { LST.filters.offerOnly = !LST.filters.offerOnly; lstAfterFilter(); return; }
  if (g("[data-lstres]")) { LST.filters.showReserved = !LST.filters.showReserved; lstAfterFilter(); return; }
  if ((el = g("[data-lstsrc]"))) { const f = LST.filters;
    const all = [...new Set(LST.rows.map(l => l.src))];
    if (!f.sources) f.sources = all.slice();
    lstToggle(f.sources, el.dataset.lstsrc);
    if (f.sources.length === all.length) { f.sources = null; lstAfterFilter(); }
    return; }
  if ((el = g("[data-lstsort]"))) { const k = el.dataset.lstsort;
    if (LST.sort === k) LST.desc = !LST.desc; else { LST.sort = k; LST.desc = false; }
    syncHash(); lstSectionRefresh(); return; }
  if ((el = g("[data-lstrow]"))) { lstFocus(el.dataset.lstrow); return; }
  if (g("[data-legpill]")) { document.body.classList.toggle("legopen"); return; }
  if ((el = g("[data-legfold]"))) { const k = el.dataset.legfold; UI.legFold[k] = !UI.legFold[k]; ovLegends(); return; }
  /* a jump moves the camera and returns — no selection change, so no re-render */
  if ((el = g("[data-pipetype]"))) { PIPE.type = el.dataset.pipetype; syncHash(); renderKeep(); return; }
  if ((el = g("[data-pipestatus]"))) { PIPE.status = el.dataset.pipestatus; syncHash(); renderKeep(); return; }
  if ((el = g("[data-srvcat]"))) { const [w, c] = el.dataset.srvcat.split(":");
    const set = w === "srv" ? SF.srv : SF.pub;
    if (set.has(c)) set.delete(c); else set.add(c);
    LF[w + "Drawn"] = false; lfOverlays(); ovLegends(); return; }
  if ((el = g("[data-mapjump]"))) { mapJump(el.dataset.mapjump); return; }
  if ((el = g("[data-chmode]"))) { CH.mode = el.dataset.chmode; syncHash(); renderKeep(); return; }
  if ((el = g("[data-chfq]"))) { CH.fq = el.dataset.chfq; syncHash(); renderKeep(); return; }
  if ((el = g("[data-chadd]"))) { chartAddMany(el.dataset.chadd.split("|")); return; }
  if ((el = g("[data-chrm]"))) { CH.areas = CH.areas.filter(a => a !== el.dataset.chrm); syncHash(); renderKeep(); return; }
  if (g("[data-chpng]")) { chartPng(); return; }
  if (g("[data-chcsv]")) { chartCsv(); return; }
  if (g("[data-chclear]")) { CH.areas = []; syncHash(); renderKeep(); return; }
  if ((el = g("[data-sub]"))) { MK.sub = el.dataset.sub; if (MK.sub === "deso") loadDeso(MK.kommun); syncHash(); renderKeep(); return; }
  if ((el = g("[data-arsub]"))) { AR.sub = el.dataset.arsub; syncHash(); renderKeep(); return; }
  if ((el = g("[data-indq]"))) { setMapInd(el.dataset.indq); syncHash(); renderKeep(); return; }
  if ((el = g("[data-pick]"))) { const [sc, ...rest] = el.dataset.pick.split(":"); pickerPick(sc, rest.join(":")); return; }
  if ((el = g("[data-fq]"))) { MK.fq = el.dataset.fq; MK.year = newestPeriod(); syncHash(); renderKeep(); return; }
  if (g("[data-mftoggle]")) { UI.mfOpen = !UI.mfOpen; const p = document.getElementById("mfpanel"), b = g("[data-mftoggle]"); if (p) p.style.display = UI.mfOpen ? "" : "none"; if (b) b.classList.toggle("on", UI.mfOpen); return; }
  if ((el = g("[data-arind]"))) { setMapInd(el.dataset.arind); syncHash(); renderKeep(); return; }
  if ((el = g(".im"))) { tipToggle(el); return; }
  tipHide();
});
document.addEventListener("change", e => {
  const el = e.target;
  if (el.id === "yearsel") { MK.year = el.value; syncHash(); renderKeep(); }
  if (el.id === "mindsel") { MK.mind = el.value; syncHash(); renderKeep(); }
  if (el.id === "chind") { CH.ind = el.value; syncHash(); renderKeep(); }
  if (el.id === "chy0") { CH.y0 = el.value; syncHash(); renderKeep(); }
  if (el.id === "chy1") { CH.y1 = el.value; syncHash(); renderKeep(); }
  if (el.id === "chmed") { CH.median = el.checked; syncHash(); renderKeep(); }
  if (el.id === "chdist") { CH.dist = el.value; syncHash(); renderKeep(); }
  if (el.id === "chq") { chartAdd(null, el.value); }
  if (el.id === "chtitle") { CH.title = el.value; const t = document.getElementById("chsvgtitle"); if (t) t.textContent = CH.title || chartAutoTitle(); }
  if (el.id === "propin") { propSet(el.value); }
  if (el.id === "proplab") { PROP.label = el.value.trim(); syncHash(); }
  if (el.id === "proprad") { PROP.rad = Number(el.value) || PROP_RAD_DEFAULT; syncHash(); renderKeep(); }
  if (el.id === "tregion") { T.lan = el.value; renderTableBody(); }
  if (el.id === "tminpop") { T.minPop = Number(el.value) || 0; renderTableBody(); }
});
document.addEventListener("input", e => {
  if (e.target.id === "tq") { T.q = e.target.value.trim().toLowerCase(); renderTableBody(); return; }
  /* the search box redraws its own dropdown and nothing else — a full re-render
     would take the focus and the caret with it on every keystroke */
  if (e.target.id === "areaq") { SR.q = e.target.value; SR.sel = 0; SR.open = true; searchRefresh(); return; }
  if (e.target.id === "indsearch") { UI.pickQ = e.target.value; pickerRefresh(); }
});
document.addEventListener("focusin", e => {
  if (e.target.id === "areaq") { SR.open = true; searchRefresh(); }
  else if (SR.open && !e.target.closest(".asrch")) { SR.open = false; searchRefresh(); }
});
document.addEventListener("toggle", e => { if (e.target.classList && e.target.classList.contains("indx")) UI.indxOpen = e.target.open; }, true);
document.addEventListener("toggle", e => {
  /* One key for every <details> whose open state is shareable. The section's own
     id is what goes into show=, so a link reproduces exactly which panels were
     open when it was copied. */
  const t = e.target;
  if (!t || !t.dataset || !t.dataset.sec) return;
  const set = S.view === "property" ? PROP.show : S.view === "makro" ? MC.show : AR.show;
  if (t.open) set.add(t.dataset.sec); else set.delete(t.dataset.sec);
  syncHash();
  if (t.dataset.secRender) renderKeep();
}, true);
document.addEventListener("keydown", e => {
  if (e.target.id === "areaq") {
    if (e.key === "Enter") { searchEnter(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const n = searchResults(SR.q).length;
      if (n) { SR.sel = (SR.sel + (e.key === "ArrowDown" ? 1 : n - 1)) % n; searchRefresh(); e.preventDefault(); }
      return;
    }
    if (e.key === "Escape") { SR.open = false; searchRefresh(); e.target.blur(); return; }
  }
  if (e.target.id === "indsearch" && e.key === "Enter") { pickerEnter(); return; }
  if (e.key === "Enter" && e.target.id === "chq") { chartAdd(null, e.target.value); return; }
  if (e.key === "Enter" && e.target.id === "propin") { propSet(e.target.value); return; }
  if (e.key === "Escape") {
    if (UI.menu) { UI.menu = null; UI.pickQ = ""; renderKeep(); return; }
    if (document.body.classList.contains("navopen")) { navClose(); return; }
    if (LF.fullKey) { closeMiniFull(); return; }
    if (S.view === "area") history.back();
  }
  /* Single-key shortcuts: never with a modifier (Cmd-S must stay Save), and never
     while the reader is typing — the area search box is one keystroke away. */
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
  /* `0` turns the indicator fill off and back on, wherever there is a map: the big
     one, the area page's and Test property's. */
  if (e.key === "0" && mapOnlyOk()) { toggleMapOnly(); return; }
  /* Quick jumps move the camera, and only the big map has one. */
  if (S.view !== "makro") return;
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
/* ---------- Map only: the outline style ----------
   Nothing is coloured in, and the areas stay clickable. Leaflet only hit-tests the
   interior of a path whose `fill` attribute is not "none", so the polygon keeps a
   fill and sets its opacity to zero: `fill: false` would draw the same outline and
   answer clicks on the 1 px stroke alone.

   The hover highlight is the stroke, never a wash of colour, so "in Map only mode
   no area is filled" is true at every moment — including while the cursor is on
   one — and a test can assert it without having to know where the mouse is. */
const MO_LINE = "#5C6B5F", MO_HOVER = "#141C18";
const MO_SCALE = { t: () => null, lo: null, hi: null, breaks: [], classes: 0, n: 0 };
const moWeight = sub => (sub === "deso" ? 0.5 : sub === "regso" ? 0.7 : 1.1);
const moStyle = w => ({ className: "mo-outline", color: MO_LINE, weight: w, opacity: .85,
  fill: true, fillColor: MO_LINE, fillOpacity: 0, smoothFactor: 0.25 });
const moHover = w => ({ color: MO_HOVER, weight: Math.max(2, w * 2.6), opacity: 1, fillOpacity: 0 });

/* ---------- a kommun-only indicator, drilled into RegSO or DeSO ----------
   Rent, K/T-tal, sales, completions, forced sales and reported offences are published
   per kommun and nowhere finer. The v2.0 map tinted all 127 Stockholm RegSO with the
   same colour and marked each one °, which draws one number 127 times and reads as 127
   local measurements — the single most misleading thing a Swedish map of this data can
   do, because the areas people care about are exactly the ones the figure is not about.

   So the kommun is drawn as itself, filled with its own value against the national
   scale, and its sub-areas go on top as neutral outlines. Nothing is hidden: clicking a
   sub-area still opens it, and its popup still carries the kommun's figure, marked as
   the kommun's. The legend and the strip above the map both say "published per kommun
   only" in those words.

   The outline is WHITE, not Map only's dark green. Map only's outlines sit on the bare
   basemap; these sit on a filled kommun that can be any shade of the ramp, and a mid-grey
   line disappears on the dark end of it. White is also what every other boundary on a
   choropleth in this dashboard is drawn in, so the picture stays one picture. */
const KO_LINE = "#FFFFFF";
const KOMMUN_ONLY_LINE = "published per kommun only";
const koWeight = sub => (sub === "deso" ? 0.5 : 0.8);
const koStyle = w => ({ className: "ko-outline", color: KO_LINE, weight: w, opacity: .85,
  fill: true, fillColor: KO_LINE, fillOpacity: 0, smoothFactor: 0.25 });
const koHover = w => ({ color: MO_HOVER, weight: Math.max(1.8, w * 2.4), opacity: 1, fillOpacity: 0 });
/* the sub-level the big map is drilled to, or null when the 290 kommuner are drawn */
const drillSub = () => (MK.kommun ? (desoMode() ? "deso" : "regso") : null);
/* Is the selected indicator published only for the kommun we are inside? An indicator
   that refuses inheritance is not this case — it has nothing to put on the kommun
   either, and its sub-areas are correctly blank. */
function kommunOnlyMap() {
  const sub = drillSub(); if (!sub || mapOnly()) return false;
  const i = curInd();
  return !(i.levels || []).includes(sub) && !noInherit(i);
}
/* The same question for a mini-map, which knows its level from the entity rather than
   from MK: would this map be painting one kommun figure across every sub-area? Shared
   by studyRow (which writes the note) and by both mini-map builders (which draw it), so
   the note and the picture cannot disagree. Returns { lvl, kom } or null. */
function areaKomOnly(e, i, lvl) {
  if (!e || !i || !lvl || lvl === "kommun" || mapOnly()) return null;
  if ((i.levels || []).includes(lvl) || noInherit(i)) return null;
  const kom = e.type === "kommun" ? e.o : e.kommun;
  return kom && (kom.rings || []).length ? { lvl, kom } : null;
}
/* Each mini-map decides its own level, so each gets its own thin wrapper rather than one
   guess that would be right for one of them. A kommun page showing the 290 kommuner is
   already the right picture — `kommun` is excluded above. */
function arKomOnly(e, i) {
  const { useQ, sind, kommuneLevel } = arMapMode(e, i);
  return areaKomOnly(e, sind, e.type === "kommun" ? (useQ ? "deso" : kommuneLevel ? "kommun" : "regso") : e.type);
}
const propKomOnly = (e, i) => areaKomOnly(e, i, e.type === "kommun" ? "regso" : e.type);
/* The kommun polygon, filled with its own value against the national scale — the one
   shape a kommun-only indicator is about. Non-interactive: it covers exactly the ground
   all the outlines over it cover, and they are what a click belongs to. */
function komFillPoly(kom, i) {
  const sc = scaleOf(MUNI, m => V(m, i.key), null, i);
  const t = sc.t(V(kom, i.key));
  return { sc, poly: L.polygon(kom.rings, { className: "ko-fill", color: "#FFFFFF", weight: 1.6,
    fillColor: t == null ? "#C4CBC4" : (sc.color ? sc.color(t) : mkShade(t, i.key, sc)),
    fillOpacity: .72, smoothFactor: .25, interactive: false }) };
}
/* "the polygons on screen are a different set now". Both sides of the zoomend
   comparison spell it through this one helper — they did not, so every zoom step in
   Map only rebuilt the layer and closed whatever popup was open. */
const mapLevelKey = () => (drillSub() || "national") + (MK.kommun || "")
  + (mapOnly() ? ":only" : kommunOnlyMap() ? ":ko" : "");

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
    if (e2) e2.innerHTML = (ovOn(o) && o.legend) ? legCard(o.id, o.label, o.legend()) : "";
  }
  const z = document.getElementById("lg-zones");
  if (z) z.innerHTML = climOn() ? legCard("zones", "Hazard zones", climLegend()) : "";
}
/* A layer legend is a key and a collapse control — nothing that filters. The
   filters moved into Layers ▾, which is what keeps these cards small enough to
   stack without ever covering each other. */
function legCard(id, label, inner) {
  const folded = !!UI.legFold[id];
  return `<div class="lgc ${folded ? "folded" : ""}"><button class="lgfold" data-legfold="${esc(id)}" title="${folded ? "Show" : "Hide"} the ${esc(label)} key" aria-expanded="${!folded}">${folded ? "+" : "–"}</button>${folded ? `<div class="lgtitle">${esc(label)}</div>` : inner}</div>`;
}
const GROUP_ORDER = ["Demographics", "Outlook", "Safety", "Schools", "Climate", "Growth signals", "Income & jobs", "Housing stock", "Rents", "Prices & market", "Construction", "Municipal finances", "Area quality"];
const MUNI_GROUP = "From the municipality";

/* ---------- IndicatorPicker ----------
   One component, one markup, one behaviour, on the Map, the Area page, Data ›
   Areas, Charts and Test property. Before this there were three different
   grouped <select>s and the reader had to learn each one.

   `scope` says whose indicator it sets: "map" is the shared MK.ind that the map,
   the tables and the area pages all read; "chart" is the chart generator's own.
   Everything else — the groups, the search, the availability tags — is the same.

   An indicator whose value at THIS level is the kommun's is listed under "From
   the municipality" rather than mixed in with the ones the area publishes
   itself, because those are two different claims about the same number. */
const pickerList = sc => (sc === "chart" ? IND.concat(IND_DESO.filter(i => !IND.some(x => x.key === i.key))) : curInds());
const pickerCur = sc => (sc === "chart" ? chartInd() : curInd());

/* Which keys, in the context on screen, would be showing the kommun's figure. */
function pickerMuniKeys(sc) {
  const out = new Set();
  if (sc === "chart") return out;
  if (S.view === "area") {
    const e = areaEntity();
    if (!e || e.type === "kommun" || !e.kommun) return out;
    for (const i of e.inds) if (V(e.o, i.key) == null && canInherit(i.key) && V(e.kommun, i.key) != null) out.add(i.key);
    return out;
  }
  if (S.view === "property") {
    for (const i of IND) { const a = propVal(i.key); if (a && !a.own) out.add(i.key); }
    return out;
  }
  if (S.view === "makro" && MK.kommun) {
    const sub = desoMode() ? "deso" : "regso";
    for (const i of IND) if (!(i.levels || []).includes(sub) && canInherit(i.key)) out.add(i.key);
    return out;
  }
  if (S.view === "table" && T.level !== "kommun") {
    for (const i of IND) if (!(i.levels || []).includes(T.level) && canInherit(i.key)) out.add(i.key);
  }
  return out;
}
/* The right-aligned availability tag: the history span, or `snapshot` when the
   publisher has issued the figure once, or `muni` when it is inherited here. */
function pickerTag(i, muniKeys, sc) {
  if (muniKeys.has(i.key)) return { t: "muni", cls: "tag-muni", title: "the kommun's figure is what is shown at this level" };
  if (isOutlook(i)) return { t: "projection", cls: "tag-proj", title: "a published statement about a future year, not an observation" };
  if (isClimKey(i.key)) return { t: "scenario", cls: "tag-clim", title: "a screening share under a named scenario" };
  const ys = sc === "chart" ? histYears(i.key, MUNI) : yearsForPool(i.key, curPool());
  const hy = ys.filter(y => y !== LATEST);
  if (hy.length > 1) return { t: hy[0] + "–", cls: "", title: `history from ${hy[0]}` };
  return { t: "snapshot", cls: "", title: "published once — no history to plot" };
}
/* Label, short label, group and unit — not the description. A row whose
   definition happens to mention the word, while nothing on the row does, reads
   as a bug rather than as a match. The short label is on the row for the same
   reason: it is what the chips are named after, so searching it has to be
   something the reader can see the result of. */
const pickerMatch = (i, q) => !q || [i.label, i.short, i.group, i.unit].some(x => String(x || "").toLowerCase().includes(q));

/* The Map only row: first in the list, in a group of its own, and filtered by the
   search box like every other row — a row that ignored the query would sit above
   the matches for "rent" claiming to be one. */
const NONE_WORDS = "map only boundaries no indicator outlines blank";
function pickerNoneRow(sc, cur, q) {
  if (sc === "chart" || !mapOnlyOk()) return "";
  if (q && !NONE_WORDS.includes(q)) return "";
  const on = cur.key === IND_NONE;
  return `<div class="pkgroup" data-group="Map"><div class="pkglab">Map<em>no indicator</em></div>
    <button class="pkrow none ${on ? "on" : ""}" role="option" aria-selected="${on}"
      data-ind="${IND_NONE}" data-pick="${sc}:${IND_NONE}" data-testid="pick-none"
      title="${esc(NONE_IND.desc)}">
      <span class="pkl">${esc(NONE_IND.label)} <em class="sh">boundaries only</em></span>
      <span class="pku"></span><span class="pkt" title="no figure is coloured in">key 0</span></button></div>`;
}

function pickerRows(sc) {
  const L = pickerList(sc), cur = pickerCur(sc), muniKeys = pickerMuniKeys(sc);
  const q = (UI.pickQ || "").trim().toLowerCase();
  const groups = GROUP_ORDER.filter(g => L.some(i => (i.group || "Other") === g))
    .concat(L.some(i => !GROUP_ORDER.includes(i.group || "Other")) ? ["Other"] : []);
  const out = [];
  const none = pickerNoneRow(sc, cur, q);
  if (none) out.push(none);
  const row = i => {
    const tag = pickerTag(i, muniKeys, sc);
    return `<button class="pkrow ${i.key === cur.key ? "on" : ""}" role="option" aria-selected="${i.key === cur.key}"
      data-ind="${esc(i.key)}" data-pick="${sc}:${esc(i.key)}" title="${esc(i.desc || i.label)}">
      <span class="pkl">${esc(i.label)}${i.short && i.short !== i.label ? ` <em class="sh">${esc(i.short)}</em>` : ""}${lowerBetter(i) ? ` <em class="lb" title="lower is better">↓</em>` : ""}</span>
      <span class="pku">${esc(i.unit || "")}</span>
      <span class="pkt ${tag.cls}" title="${esc(tag.title)}">${esc(tag.t)}</span></button>`;
  };
  for (const g of groups) {
    const rows = L.filter(i => (i.group || "Other") === g && !muniKeys.has(i.key) && pickerMatch(i, q));
    if (!rows.length) continue;
    out.push(`<div class="pkgroup" data-group="${esc(g)}"><div class="pkglab">${esc(g)}</div>${rows.map(row).join("")}</div>`);
  }
  const inh = L.filter(i => muniKeys.has(i.key) && pickerMatch(i, q));
  if (inh.length) {
    out.push(`<div class="pkgroup" data-group="${esc(MUNI_GROUP)}"><div class="pkglab">${esc(MUNI_GROUP)}
      <em>shown here as the kommun's figure</em></div>${inh.map(row).join("")}</div>`);
  }
  if (!out.length) return `<div class="snone">No indicator matches “${esc(UI.pickQ || "")}”.</div>`;
  return out.join("");
}
/* The one place the Swedish words are glossed. Once, where a reader who does not know
   them is already looking for an indicator — not on every tile, which would turn the
   terms into something the page is apologising for. */
const PICKER_HELP = `<details class="pkhelp" data-testid="picker-help"><summary>Swedish terms used here</summary>
  <p><b>hyresrätt</b> rented · <b>bostadsrätt</b> tenant-owned (co-op) · <b>äganderätt</b> owner-occupied
  · <b>allmännytta</b> the municipal housing company · <b>bruksvärde</b> the negotiated-rent system.
  They are kept because they are the legal forms, and a translation would lose which one a figure is about.</p>
  <p><b>K/T-tal</b> is the purchase price divided by the assessed value — <b>not</b> a price per m².
  Sweden publishes no open realised price per m² at any geography. Rents are <b>SEK/m²/yr</b>.</p></details>`;
function indPicker(scope) {
  const sc = scope || "map";
  const i = pickerCur(sc);
  const muniKeys = pickerMuniKeys(sc);
  const open = UI.menu === "picker";
  return `<span class="menu picker" data-testid="ind-picker">
    <button class="lk indbtn" data-testid="ind-picker-btn" data-menu="picker" data-pickscope="${sc}"
      aria-haspopup="listbox" aria-expanded="${open}" title="${esc(i.desc || i.label)}">
      <b>${esc(i.label)}</b><i class="u">${esc(i.unit || "")}</i>${muniKeys.has(i.key) ? `<i class="tag-muni">municipality</i>` : ""} ▾</button>
    ${open ? `<div class="menupop pickerpop" role="dialog" aria-label="Indicator" data-testid="ind-picker-pop">
      <input id="indsearch" data-testid="ind-search" class="indsel" placeholder="Search indicators…" autocomplete="off"
        value="${esc(UI.pickQ || "")}" data-pickscope="${sc}">
      ${PICKER_HELP}
      <div class="pkbody" id="pkbody" role="listbox">${pickerRows(sc)}</div>
    </div>` : ""}</span>`;
}
function pickerRefresh() {
  const sc = (document.querySelector("[data-testid=ind-search]") || { dataset: {} }).dataset.pickscope || "map";
  const b = document.getElementById("pkbody"); if (b) b.innerHTML = pickerRows(sc);
}
function pickerPick(sc, key) {
  UI.menu = null; UI.pickQ = "";
  if (sc === "chart") CH.ind = key;
  else setMapInd(key);
  syncHash(); renderKeep();
}
function pickerEnter() {
  const sc = (document.querySelector("[data-testid=ind-search]") || { dataset: {} }).dataset.pickscope || "map";
  const first = document.querySelector("[data-testid=ind-picker-pop] .pkrow");
  if (first) pickerPick(sc, first.dataset.ind);
}
/* the chips: the figures people ask for first, one click each — and, first of all,
   the way back to a map with no figure on it at all */
function indQuick() {
  const L = curInds(); const ks = QUICK_KEYS.map(k => L.find(i => i.key === k)).filter(Boolean);
  if (ks.length < 2) return "";
  const none = mapOnlyOk() ? `<button class="iqb none ${mapOnly() ? "on" : ""}" data-indq="${IND_NONE}"
    data-testid="chip-none" title="${esc(NONE_IND.desc)} Key 0.">${esc(NONE_IND.label)}</button>` : "";
  return `<div class="iq" data-testid="ind-chips">${none}${ks.map(i => `<button class="iqb ${MK.ind === i.key ? "on" : ""}" data-indq="${i.key}" title="${esc(i.label)}">${esc(i.short || i.label)}</button>`).join("")}</div>`;
}

/* ---------- the unified search ----------
   One box. It takes a kommun, a RegSO or a DeSO by name or by code, and it also
   takes a Google Maps link or a bare "lat, lon" — which resolves to a Test
   property pin rather than to an area, because a coordinate is not an area.

   The quick jumps sit at the top of its dropdown rather than in the toolbar,
   which is what gets row 1 down to four controls. They move the camera and
   nothing else: MK.kommun, the indicator and the hash path are untouched, so
   zooming still never changes the selection.

   The privacy sentence that used to run across every map lives on the ? here and
   on the Test property page, where the pin actually is. */
/* The keys every row is matched on come from src/search_core.js, which folds the
   diacritics away (goteborg → Göteborg, sodermalm → Södermalm) and derives the forms
   nobody would curate 290 times ("Stockholms stad"). The keys are never shown — `t`
   is, with its diacritics intact. */
const SC = window.SEARCH_CORE;
const AREA_OPTS = [];
MUNI.slice().sort((a, b) => a.name.localeCompare(b.name, LOCALE)).forEach(m => AREA_OPTS.push(
  { t: m.name, sub: `Kommun · ${lanName(m.lan) || m.lan || ""}`, h: `map/${m.code}`,
    k: SC.keysFor("kommun", m.name, m.code) }));
AREAS.slice().sort((a, b) => (a.name || "").localeCompare(b.name || "", LOCALE)).forEach(a => AREA_OPTS.push(
  { t: a.name, sub: `RegSO · ${(byCode[a.kommun] || {}).name || ""}`, h: `area/regso/${a.code}`,
    k: SC.keysFor("regso", a.name, a.code) }));
/* DeSO has codes and no names, and its files arrive per kommun, so only the
   kommuner already opened contribute — which is honest: the rest are not in
   memory to be searched. */
const desoOpts = () => {
  const out = [];
  for (const kom in DESO) for (const d of DESO[kom]) out.push(
    { t: d.code.split("_")[0], sub: `DeSO · ${(byRegso[d.regso] || {}).name || (byCode[kom] || {}).name || ""}`,
      h: `area/deso/${d.code}`, k: SC.keysFor("deso", d.code.split("_")[0], d.code) });
  return out;
};
const SR = { q: "", open: false, sel: 0 };
const SR_MAX = 10;

/* what the box would do with what is typed in it */
function searchResults(q) {
  const s = String(q || "").trim();
  if (!s) return [];
  /* a coordinate or a Maps link is a pin, not an area */
  const loc = parseLocation(s);
  if (loc && !loc.error) {
    const ll = `${(+loc.lat).toFixed(5)},${(+loc.lon).toFixed(5)}`;
    return [{ coord: true, t: `Test property at ${nf(loc.lat, 5)}, ${nf(loc.lon, 5)}`,
              sub: "a coordinate is a point, not an area — it opens as a pin",
              h: `property?p=${ll}` }];
  }
  /* the ranking lives in src/search_core.js and is unit-tested there: exact, then
     prefix, then word start, then anywhere, and the pool's own order inside a rank —
     which is kommuner before RegSO before DeSO, each alphabetical */
  return SC.match(AREA_OPTS.concat(desoOpts()), s, SR_MAX);
}
const PRIVACY_TIP = "A pasted Google Maps link or coordinate is parsed in your browser and tested "
  + "against boundary files this page already serves. It lives only in this page's address bar — the "
  + "part after the # is never sent to a server. A short goo.gl link is refused rather than followed.";
function areaSearch() {
  const m = MK.kommun ? byCode[MK.kommun] : null;
  return `<span class="asrch" data-testid="search" role="combobox" aria-expanded="${SR.open}" aria-haspopup="listbox">
    <input id="areaq" class="indsel" value="${esc(SR.q)}" autocomplete="off" aria-label="Search area, code or coordinate"
      placeholder="${m ? esc(m.name) + " — search area, code or coordinate" : "Search area, code, Maps link or lat, lon"}">
    <button class="qmark" type="button" title="${esc(PRIVACY_TIP)}" aria-label="How a pasted coordinate is handled">?</button>
    <div class="sdrop" id="sdrop">${searchDropHtml()}</div>
  </span>`;
}
function searchDropHtml() {
  const res = searchResults(SR.q);
  const jumps = `<div class="sjump" data-testid="search-jumps"><em>Jump to</em>${MAP_JUMPS.map(j =>
    `<button data-mapjump="${j.id}" title="Move the camera to ${esc(j.label)} (key ${j.key}) — the selection does not change">${esc(j.label)}</button>`).join("")}</div>`;
  const rows = res.length
    ? res.map((o, k) => `<button class="srow ${k === SR.sel ? "on" : ""}"${o.coord ? ' data-testid="search-coord"' : ""}
        data-searchgo="${esc(o.h)}" role="option"><b>${esc(o.t)}</b><em>${esc(o.sub)}</em></button>`).join("")
    : SR.q ? `<div class="snone">No area matches “${esc(SR.q)}” — try a kommun name, a RegSO name, a RegSO or DeSO code, or a coordinate. <em>å ä ö are optional: goteborg finds Göteborg.</em></div>` : "";
  return jumps + rows;
}
function searchRefresh() {
  const d = document.getElementById("sdrop"); if (d) d.innerHTML = searchDropHtml();
  const w = document.querySelector(".asrch"); if (w) w.setAttribute("aria-expanded", String(SR.open));
}
function searchGo(h) {
  SR.q = ""; SR.open = false; SR.sel = 0;
  /* a coordinate result carries a whole hash of its own; an area keeps the
     indicator and year the reader is looking at */
  go(h.indexOf("?") >= 0 ? h : withQ(h));
}
function searchEnter() {
  const res = searchResults(SR.q);
  if (res.length) searchGo(res[Math.min(SR.sel, res.length - 1)].h);
}
/* The selected quarter IS the as-of. hist_asof is keyed by year, so a quarter
   fell through to the yearly stamp and the card said "2025" under a 2026K2 map. */
const asofOne = i => (isQuarter(MK.year) && qPeriodsOf(i).includes(MK.year)) ? MK.year : null;
function asofText(i) {
  const q = asofOne(i);
  if (q) return `kommuner: ${esc(q)}`;
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

/* ---------- which level is actually on screen ----------
   Not the finest level the indicator is published at — the level the reader is
   looking at. Data › Areas at Kommuner used to badge growth "DeSO level" because
   growth IS published down to DeSO, which told the reader the 290 rows in front
   of them were something they are not. Where the drawn level has no figure of
   its own the badge says both: "RegSO rows · kommun figures". */
const LEVEL_WORD = { kommun: "kommun", regso: "RegSO", deso: "DeSO", sweden: "national" };
const LEVEL_RANK = { sweden: 0, kommun: 1, regso: 2, deso: 3 };
function drawnLevel() {
  if (S.view === "table") return T.level;
  if (S.view === "area") { const e = areaEntity(); return e ? e.type : "kommun"; }
  if (S.view === "property") { const e = propArea(); return e ? e.type : "kommun"; }
  if (S.view === "market") return "sweden";
  return desoMode() ? "deso" : (MK.kommun ? "regso" : "kommun");
}
function levelBadge(i) {
  if (i.level === "none") return "national";
  const at = drawnLevel(), word = LEVEL_WORD[at] || at;
  const pub = i.level || "kommun";
  /* finer than the publisher goes: the rows are this level, the figures are not.
     `levels` lists where the indicator can be SHOWN, inheritance included, so it
     is `level` — the finest level actually published — that decides this. */
  if ((LEVEL_RANK[at] || 0) > (LEVEL_RANK[pub] || 0)) return `${word} rows · ${LEVEL_WORD[pub] || pub} figures`;
  if (!(i.levels || [pub]).includes(at)) return `not published at ${word}`;
  return `${word} level`;
}
function indExplain(i) {
  const pool = curPool();
  /* the RegSO numerator is a count of the pool, so it is "…" rather than 0 until
     the pool is here — the denominator is known from the build either way */
  const rgCov = RG.vals ? AREAS.filter(a => a[i.key] != null).length : "…";
  const cov = `${MUNI.filter(m => m[i.key] != null).length}/${MUNI.length} kommuner${(i.levels || []).includes("regso") ? `, ${rgCov}/${REGSO_N} RegSO` : ""}${(i.levels || []).includes("deso") ? ", DeSO per kommun" : ""}`;
  const ys = yearsForPool(i.key, pool);
  const asof = asofText(i);
  /* one line by default — label, level, unit, period; the definition, source, coverage and caveat open on ⓘ */
  const asofShort = () => { if (asofOne(i)) return asofOne(i);
    const src = (MK.year !== LATEST && i.hist_asof && i.hist_asof[MK.year]) || i.asof || {}; return src.kommun || src.regso || src.deso || ""; };
  return `<details class="indx" ${UI.indxOpen ? "open" : ""}>
    <summary><b>${esc(i.label)}</b><span class="tag" data-testid="level-badge">${esc(levelBadge(i))}</span><span class="tag">${esc(i.unit || "")}</span>${asofShort() ? `<span class="dim">as of ${esc(asofShort())}</span>${prelBadge(i, asofShort())}` : ""}${i.warn ? `<span class="warnline">⚠</span>` : ""}<i class="more">ⓘ details</i></summary>
    <div class="indx-body"><p>${esc(i.desc || "")}</p>
    <p class="dim"><em>Source</em> ${esc(i.source || "–")}${asof ? ` · <em>As of</em> ${asof}` : ""} · <em>Coverage</em> ${cov}${ys.length > 1 ? ` · <em>History</em> ${ys[0]}–${LATEST}` : ""} ${indSrcLink(i, MK.kommun ? (desoMode() ? "deso" : "regso") : "kommun", MK.kommun, MK.year === LATEST ? LATEST : MK.year)}</p>
    ${i.warn ? `<p class="warnline">⚠ ${esc(i.warn)}</p>` : ""}</div>
  </details>`;
}
/* ---------- PeriodControl ----------
   One control, four modes, chosen by the active indicator rather than by the
   view — so the same indicator reads the same way on the map, in the table and
   on an area page, and a projection can never appear next to a year selector
   that implies it was observed.

     year       a select of the periods this indicator actually has
     quarter    the same, plus a Yearly | Quarterly segment where the source
                publishes quarters (Safety: reported offences). Each quarter is
                ONE quarter — Brå publishes single quarters, not a rolling
                four-quarter sum, which is why Stockholm reads ~41–50 per 1 000
                per quarter against 191,6 for the year.
     projection a static badge — an Outlook indicator is one published statement
                about a future year, so there is nothing to select
     climate    a static badge naming the scenario, for the same reason

   A quarter is carried in the same `y=` key as a year ("2025K4"), so a link is
   the same shape either way and V() is the only place that has to know. */
const isQuarter = t => /K\d/.test(String(t || ""));
const qPeriodsOf = i => (i && i.q_periods) || [];
/* Is this period preliminary? Never guessed from how new it looks — the build
   reads it off the publisher's own metadata and ships `prel_periods` / `q_prel`
   (Brå's explicit lists) and `prel` — {geography: "all" | first year} — because
   an indicator can be preliminary at kommun and final below it. */
function isPrel(i, t) {
  if (!i || !t) return false;
  if ((i.prel_periods || []).includes(t) || (i.q_prel || []).includes(t)) return true;
  const rule = i.prel && i.prel[drawnLevel()];
  if (!rule) return false;
  return rule === "all" || String(t).slice(0, 4) >= String(rule);
}
const PREL_TIP = "Preliminary — the publisher has not finalised this period and the figure can still be revised.";
const prelBadge = (i, t) => isPrel(i, t)
  ? `<span class="prel" data-testid="prel" title="${esc(PREL_TIP)}">prel.</span>` : "";
/* The period a tile or a rank reads. A quarter chosen for the active indicator
   does not exist for the other four headline figures, and v2.0 blanked the whole
   row rather than leaving them on their own latest year. */
const periodFor = i => (isQuarter(MK.year) && !qPeriodsOf(i).length) ? LATEST : MK.year;
/* Quarters are only offered where every area in the pool actually has them — a
   mixed pool would show a figure for some areas and a dash for the rest. */
function quarterly(i) {
  if (!i || qPeriodsOf(i).length < 2) return false;
  const pool = periodPool();
  return pool.length > 0 && pool.every(o => o && o.q && o.q[i.key]);
}
function curPeriods() {
  const i = curInd();
  if (MK.fq === "q" && quarterly(i)) return qPeriodsOf(i);
  return yearsFor(MK.ind);
}
/* The newest period of whichever mode is on. LATEST is a YEAR, so falling back
   to it after a switch to Quarterly picked a period the quarterly series has
   never heard of: the select showed the oldest quarter and the map quietly went
   on drawing the yearly figure. */
function newestPeriod() {
  const ps = curPeriods();
  return ps.includes(LATEST) ? LATEST : (ps[ps.length - 1] || LATEST);
}
/* ---------- what a RegSO surface says before its file is here ----------
   "Loading…", never a dash and never a 0. A dash in this dashboard means the
   source suppressed the value, which is a statement about the data; an empty
   count would be a statement about the place. Neither is true of a fetch that
   has not come back. `settle()` in tests/ui_v2_1/spec.py waits on the word
   Loading, so every check below reads the real figures or fails. */
const RG_WAIT = "Loading the RegSO figures…";
const RG_WAIT_GEO = "Loading the RegSO boundaries…";
/* A fetch needs http. Opened from a file:// URL there is nothing to fetch from,
   and saying so is more use than an error that never resolves. */
const RG_GONE = "The RegSO data could not be loaded. It is fetched from regso/ next to this page, "
  + "which needs a web server — from a file:// URL only kommun level is available.";
function regsoWait(code, what) {
  if (regsoReady(code)) return "";
  if (regsoFailed(code)) return `<p class="empty" data-testid="regso-failed">${esc(RG_GONE)}</p>`;
  return `<p class="empty" data-testid="regso-loading">${esc(what || RG_WAIT)}</p>`;
}
/* the line that stands where the indicator line stands, so turning the fill off
   does not make the map jump up the page */
const MAP_ONLY_LINE = "Map only — pick an indicator to colour the areas";
function mapOnlyStrip() {
  return `<div class="indx monly" data-testid="maponly-note"><b>Map only</b>
    <span>— pick an indicator to colour the areas</span>
    <span class="dim">boundaries only · click an area for its figures · key 0</span></div>`;
}
/* The note that says the figure on screen belongs to the kommun and not to the areas
   drawn inside it. It names the indicator, because the map looks different from the one
   the reader just had and the reason has to be on the page rather than only in the
   legend.

   v2.1 P4 moved it ONTO the map, where the two mini-maps have always put it — three
   lines of amber prose above the map cost 79 px, which is most of the 200 px the map
   itself is allowed before it starts. It is one line now, with the full sentence on its
   hover, and it reads the same on the big map and on the small ones. On a phone it is
   an ordinary strip above the map again: there is no 200 px budget there and an
   overlay would be sitting on a third of the map. */
function kommunOnlyStrip(i) {
  const m = MK.kommun ? byCode[MK.kommun] : null;
  const sub = drillSub() === "deso" ? "DeSO" : "RegSO";
  const full = `${i.label} is published per kommun and no finer, so ${m ? m.name : "the kommun"} is `
    + `filled with its own figure and its ${sub} areas are drawn as outlines, not coloured in. `
    + `Clicking one still opens it — the kommun's figure is on it, marked as the kommun's.`;
  return `<div class="monote ko" data-testid="kommun-only-note" title="${esc(full)}">
    <b>${esc(KOMMUN_ONLY_LINE)}</b> — ${esc(i.label)}, ${esc(m ? m.name : "the kommun")} filled · ${sub} outlined</div>`;
}
function periodControl() {
  const i = curInd();
  /* nothing is drawn from a period, so there is no period to choose */
  if (mapOnly()) return "";
  const oi = outlookOf(i);
  if (oi) {
    return `<span class="period" data-testid="period"><span class="fclab" data-testid="period-proj"
      title="${esc(i.warn || "")}">${esc(oi.label)} · SCB ${esc((oi.published || "").slice(0, 4))}</span></span>`;
  }
  if (isClimKey(i.key)) {
    /* the indicator's own scenario, from its label and its publisher */
    const src = String(i.source || "").replace(/^Källa:\s*/i, "").split(/[.,(]/)[0].trim();
    return `<span class="period" data-testid="period"><span class="fclab clim" data-testid="period-clim"
      title="${esc(i.desc || "")}">${esc(i.label)}${src ? " · " + esc(src) : ""}</span></span>`;
  }
  const q = quarterly(i);
  const ps = curPeriods();
  const seg = q ? `<span class="seg qseg" data-testid="period-fq">${[["year", "Yearly"], ["q", "Quarterly"]].map(([m, l]) =>
    `<button class="sg ${(MK.fq === m || (m === "year" && MK.fq !== "q")) ? "on" : ""}" data-fq="${m}"
      title="${m === "q" ? "One figure per single quarter — Brå publishes single quarters, not a rolling four-quarter sum" : "One figure per year"}">${l}</button>`).join("")}</span>` : "";
  if (ps.length < 2) return seg ? `<span class="period" data-testid="period">${seg}</span>` : "";
  const qmode = MK.fq === "q" && q;
  /* The select names the indicator's OWN latest period, not the dashboard's: an
     indicator whose newest figure is two years old must not read "2026". This
     only applies to years — LATEST is a year, so in quarterly mode every period
     is "not LATEST" and the rule used to drop the newest quarter from the list
     entirely (2026K2 was simply missing). */
  const hy = ps.filter(y => y !== LATEST); const lastHist = hy[hy.length - 1];
  const pool = curPool();
  const lagging = !qmode && lastHist && lastHist !== LATEST
    && !pool.some(m => m.hist && m.hist[MK.ind] && m.hist[MK.ind][LATEST] != null);
  const label = y => y !== LATEST ? y : (lagging ? `${lastHist} (latest)` : `${y} (latest)`);
  const opts = ps.filter(y => !(lagging && y === lastHist));
  return `<span class="period" data-testid="period">${seg}<select id="yearsel" class="indsel" data-testid="period-year"
    aria-label="Period">${opts.map(y => `<option value="${y}" ${MK.year === y ? "selected" : ""}>${esc(label(y))}</option>`).join("")}</select>${prelBadge(i, MK.year)}</span>`;
}

/* geometry helpers: largest ring, centroid */
const mainRing = a => (a.rings || []).slice().sort((x, y) => y.length - x.length)[0] || [];
const centroid = ring => ring.reduce((o, p) => [o[0] + p[0] / ring.length, o[1] + p[1] / ring.length], [0, 0]);
/* what the big map DRAWS inside a kommun: its DeSO, or its RegSO once their ring
   file is here. Empty while the file is in flight, which is what keeps
   L.polygon() from being handed an undefined ring — the count the card and the
   popups print comes from regsoAll()/the index instead, so nothing reads 0. */
function muniAreas(code) { return desoMode() ? desoAreas(code) : regsoDrawable(code); }
function boundsOf(list) { const pts = []; list.forEach(a => (a.rings || []).forEach(r => r.forEach(p => pts.push(p)))); return pts.length ? L.latLngBounds(pts) : null; }
function applyPendingFit() {
  if (!LF.map || !LF.pendingFit) return;
  /* The sub-areas' geometry may still be in flight, and waiting for it would
     leave the reader looking at the whole country after asking for one kommun.
     The kommun's own outline is in the page, covers the same ground, and gives
     the same frame — so the camera moves now and the polygons arrive into it. */
  const kom = byCode[LF.pendingFit];
  const b = boundsOf(muniAreas(LF.pendingFit)) || (kom ? boundsOf([kom]) : null);
  if (!b) return;
  LF.pendingFit = null;
  LF.map.fitBounds(b, { padding: [12, 12] });
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
    A kommun-level indicator is drawn on RegSO and DeSO polygons with the kommun's own value, marked ° on the map and "muni" in every table.
    ${esc((D.meta && D.meta.note) || "")}</div>${extra}<p class="cap">Full definitions and table stamps under <button class="lk mini" data-go="data/sources">Market › Sources</button>. Built ${esc((D.meta && D.meta.built) || "–")}.</p></details>`;
}
function rankOf(o, key, peers, per) {
  /* #1 is the best end, not the highest — on unemployment or forced sales that
     is the lowest value. A neutral indicator still gets a position so the reader
     can see where the area sits, but it is reported as "highest first" and
     carries `neutral` so the caller can drop the good/bad colour. */
  const v = V(o, key, per); if (v == null) return null;
  const ind = indOf(key);
  const vals = peers.map(p => V(p, key, per)).filter(x => x != null);
  const lb = lowerBetter(ind);
  return { r: 1 + vals.filter(x => (lb ? x < v : x > v)).length, n: vals.length, neutral: neutralDir(ind) };
}
/* ---------- HeadlineTiles ----------
   The five figures that answer "what kind of place is this", in one row, on the
   map's area card, the area page and Test property. Clicking one selects that
   indicator, which is what makes the row a control rather than a summary.

   A tile whose value is the kommun's says so in words — "municipality figure" —
   rather than with a lone degree sign that the reader has to decode from a
   footnote somewhere else on the page. An empty slot is not rendered: a grey
   filler is visual noise that means nothing. */
function headlineInds(e) {
  const has = k => { const i = e.inds.find(x => x.key === k); return (i && eVal(e, i.key, periodFor(i)).v != null) ? i : null; };
  const local = HL_LOCAL.map(has).filter(Boolean);
  const spare = local.length < 5 ? HL_SPARE.map(has).filter(Boolean).slice(0, 5 - local.length) : [];
  /* at most one, and always last, so the row reads "five about here, then the kommun's" */
  const muni = HL_MUNI.map(has).filter(Boolean).slice(0, 1);
  return local.concat(spare).slice(0, 5).concat(muni);
}
function headlineTiles(e) {
  const inds = headlineInds(e);
  if (!inds.length) return "";
  return `<div class="hl${inds.length > 5 ? " n6" : ""}" data-testid="tiles">${inds.map(i => {
    const s = tileStats(e, i);
    const inh = !s.cur.own;
    const proj = isOutlook(i);
    return `<button class="hlc ${MK.ind === i.key ? "on" : ""}${inh ? " inh" : ""}${proj ? " proj" : ""}"
      data-testid="tile-${esc(i.key)}" data-arind="${esc(i.key)}"
      title="${esc(i.desc || i.label)} — click to read it in the chart and on the map">
      <span>${esc(i.short || i.label)}${isPrel(i, s.per) ? ` <i class="prel" title="${esc(PREL_TIP)}">prel.</i>` : ""}</span>
      <b>${fmtOf(i)(s.cur.v)}</b>
      ${(() => { const u = tileUnit(i), m = moeSpan(i, s.cur.v, moeOf(i, inh ? e.kommun : e.o, s.per));
        /* the unit and the ± on their own line under the figure. Inline they broke a
           narrow tile between the number and its own unit — "1 710" over "SEK/m²/yr" —
           which reads as two figures rather than one. */
        return (u || m) ? `<span class="hlsub">${u ? esc(u) : ""}${m}</span>` : ""; })()}
      <em>${inh ? `<i class="inh">municipality figure</i>`
        : proj ? `<i class="projpill">Projection</i>`
        : `${s.yoy != null ? `<i class="${cls(s.yoy, i.key)}">${signed(s.yoy, 1, deltaUnit(i))}</i> y/y` : ""}${s.rk ? `${s.yoy != null ? " · " : ""}#${s.rk.r} of ${s.rk.n}` : ""}`}</em></button>`;
  }).join("")}</div>`;
}
/* the same entity shape areaEntity() returns, for a kommun that is not the page */
function kommunEntity(m) {
  return { type: "kommun", typeLabel: "Kommun", o: m, name: m.name, code: m.code, kommun: null,
           lan: m.lan, inds: IND, peers: MUNI, peerLabel: "kommuner",
           ctx: AREAS.filter(a => a.kommun === m.code), own: [m], subs: null };
}

/* ---------- the map's area card ----------
   What the map says about the kommun that is open: who it is, the headline
   figures, and the two ways onward. Everything else is behind a toggle, closed,
   with its state in the URL — so the map keeps its height and a link still
   reproduces exactly what was unfolded.

   v2.1 P4 moved it ONTO the map. As a block above it, the card pushed the map
   down by 200-odd pixels, so drilling into a kommun — the one action the whole
   page is for — made the thing you had come to look at half as tall. It is a
   panel over the map's left edge now (a bottom sheet on a phone), collapsible
   to its own title bar, and the collapsed state is in the URL. The legends sit
   at the map's top right and the panel at its left, so neither covers the other. */
/* Collapsed or not is in the URL (`card=0`), not in localStorage. v2.0 kept it
   per browser, which meant two people opening the same link saw two different
   maps and neither could send the other what they were looking at. `card=0` is
   only written when the panel IS collapsed, so an ordinary link stays short. */
const mcFolded = () => !!MC.fold;
const MC_SHOW_DEFAULTS = [];
function mapAreaCard(m) {
  const e = kommunEntity(m);
  const folded = mcFolded();
  /* the count of sub-areas, not the count of sub-areas whose geometry has
     arrived — "0 RegSO" would be a false statement about the kommun */
  const subs = desoMode() ? desoAreas(m.code).length : ((RG_IDX[m.code] || {}).n || regsoAll(m.code).length);
  const projects = (INFRA.projects || []).filter(p => (p.kommuner || []).includes(m.code));
  const outlook = outlookLine(m, false);
  return `<div class="acard mappanel ${folded ? "folded" : ""}" data-testid="area-card">
    <div class="acard-id">
      <b>${esc(m.name)}</b>
      <span class="dim">${esc(lanName(m.lan) ? lanName(m.lan) + " län" : (m.lan || ""))}${m.pop != null ? " · " + nf(m.pop, 0) + " inhabitants" : ""} · ${subs} ${desoMode() ? "DeSO" : "RegSO"}</span>
      <button class="acard-fold" data-mcfold title="${folded ? "Show" : "Hide"} this card" aria-expanded="${!folded}">${folded ? "+" : "–"}</button>
    </div>
    ${folded ? "" : `${headlineTiles(e)}
    <div class="acard-act">
      <button class="lk primary" data-go="${withQ(pageOf(m))}">Open ${esc(m.name)} page ›</button>
      <button class="lk" data-go="${chartLink(linkInd(), "kommun", m.code)}" title="Open the chart generator with this kommun">↗ Chart</button>
    </div>
    ${outlook ? `<details class="acard-sec" data-sec="outlook"${MC.show.has("outlook") ? " open" : ""}>
      <summary>Outlook 2040</summary><div class="secbody">${outlook}
      <p class="cap">SCB's trend projection for this kommun. A projection is one published statement about a future year, not an observation — it is never plotted as one series with the observed history.</p></div></details>` : ""}
    ${projects.length ? `<details class="acard-sec" data-sec="projects"${MC.show.has("projects") ? " open" : ""}>
      <summary>Upcoming projects (${projects.length})</summary><div class="secbody">
      <table class="tbl compact"><tbody>${projects.map(p => `<tr>
        <th><button class="lk mini" data-go="project/${esc(p.id)}">${esc(p.name)}</button></th>
        <td><span class="pipdot" style="background:${INFRA_TONE[p.status] || "#8A8C81"}"></span>${esc(p.status)}</td>
        <td class="num">${p.open_year || esc(p.open_window || "–")}</td></tr>`).join("")}</tbody></table>
      <p class="cap">Hand-curated from the agencies' own pages; every row links to the source. <b>Not a forecast of anything</b> — a status and an opening year as the project body states them.</p></div></details>` : ""}`}
  </div>`;
}
/* The note over the map while a drilled kommun's sub-areas are still being
   fetched. The kommun outline is drawn (it is in the page); the areas inside it
   are not there yet, and the map says so rather than reading as an empty kommun. */
function mapWaitNote() {
  if (!MK.kommun || regsoReady(MK.kommun)) return "";
  const txt = regsoFailed(MK.kommun) ? RG_GONE : RG.vals ? RG_WAIT_GEO : RG_WAIT;
  return `<div class="monote wait" data-testid="map-loading">${esc(txt)}</div>`;
}
function vMakro() {
  if (!AREAS.length || !MUNI.length) return `<div class="card"><p class="empty">No macro data built yet — run <code>make fetch</code>, <code>make geo</code> and <code>make build</code>.</p></div>`;
  const ind = curInd();
  setTimeout(lfInit, 0);
  const muni = MK.kommun ? byCode[MK.kommun] : null;
  return `
  <div class="card accent" id="mapcard">
    <div class="card-head tools-only">
      <div class="tools" data-testid="map-toolbar" data-row="1">${areaSearch()}${layersMenuHtml()}${indPicker("map")}${periodControl()}${subToggle()}</div>
      <div class="chiprow" data-row="2">${indQuick()}</div></div>
    ${mapOnly() ? mapOnlyStrip() : indExplain(ind)}
    <div class="mapwrap${mapOnly() ? " maponly" : ""}"><div id="lfmap" data-testid="map"></div>
      ${muni ? mapAreaCard(muni) : ""}
      ${kommunOnlyMap() ? kommunOnlyStrip(ind) : ""}
      ${mapWaitNote()}
      <div class="maplegs" data-testid="legends">
        <div class="maplegend" id="maplegend" data-testid="legend"></div>
        <div class="maplegend" id="lg-zones" data-testid="legend-zones"></div>
        ${ovList().map(o => `<div class="maplegend" id="lg-${o.id}" data-testid="legend-${o.id}"></div>`).join("")}
      </div>
      ${mapOnly() && !LAY.size ? "" : `<button class="legpill" data-legpill aria-label="Show or hide the map legend">Legend ▾</button>`}</div>
    ${srcNote(`<p class="cap">${muni ? "Click a polygon for its figures and a link to its page." : "Click a polygon for its figures; open a kommun with the search box above or from the popup. Table view lists everything side by side."} Colour classes: quintiles of the visible areas. Boundaries: SCB RegSO/DeSO 2025 (CC0), clipped to the coastline with OSM land polygons (ODbL); basemap OpenStreetMap.</p>`)}
  </div>`;
}

/* ---------- Data ----------
   One section, four tabs, one Export menu. Areas is the old Table, Projects the
   old Pipeline, National series the old Market panels as a table, and Sources the
   list that used to be folded inside Market. The tab is in the path, so every tab
   is a link. */
const DATA_TABS = [["areas", "Areas", () => `data/areas/${T.level}`],
                   ["projects", "Projects", () => "data/projects"],
                   ["national", "National series", () => "data/national"],
                   ["sources", "Sources", () => "data/sources"]];
function vData() {
  const tab = DATA_TABS.some(t => t[0] === DT.tab) ? DT.tab : "areas";
  const body = tab === "projects" ? vPipeline() : tab === "national" ? vMarket()
             : tab === "sources" ? vSources() : vTable();
  return `<div class="dhead">
    <div class="seg tabs" data-testid="data-tabs">${DATA_TABS.map(([k, lab, href]) =>
      `<button class="sg ${k === tab ? "on" : ""}" data-go="${esc(href())}">${esc(lab)}</button>`).join("")}</div>
    ${exportBtnHtml()}
  </div>${body}`;
}

/* ---------- Export ▾ — the menu ---------- */
function exportBtnHtml(cls) {
  return `<span class="menu ${UI.menu === "export" ? "open" : ""}">
    <button class="lk ${cls || ""}" data-testid="export-btn" data-menu="export" aria-haspopup="true" aria-expanded="${UI.menu === "export"}">Export ▾</button>
    ${UI.menu === "export" ? exportMenuHtml() : ""}</span>`;
}
function exportFootHtml() {
  return exportBtnHtml("wide") +
    `<div class="xcap">CSV, semicolon-separated, UTF-8 with a BOM — opens in a Swedish Excel and reads cleanly into a script. Every row carries its source, table id, period and as-of.</div>`;
}
function exportMenuHtml() {
  const items = exportItems();
  return `<div class="menupop" role="dialog" aria-label="Export" data-testid="export-menu">${items.map(it =>
    `<button class="mi ${it.off ? "off" : ""}" data-export="${it.id}"${it.off ? ` disabled title="${esc(it.off)}"` : ""}>${esc(it.label)}${it.off ? `<em>${esc(it.off)}</em>` : ""}</button>`).join("")}</div>`;
}

/* ---------- Table view ---------- */
/* Margins of error are first-class: TAB4590 is a ~16 000-apartment sample survey
   and publishes a ± per kommun. It is rendered next to the value, and a value
   whose margin is wider than the indicator's moe_rel is greyed — false precision
   is the easy mistake with this source. */
function moeOf(i, o, y) { return i && i.moe && o ? MOE(o, i.key, y) : null; }
function moeWide(i, v, m) { return i && i.moe_rel != null && v && m != null && Math.abs(m / v) > i.moe_rel; }
/* A bare grey "±28" beside a rent is a riddle. The hover says what it is, who
   published it and in what unit — "±28 = SCB margin of error (SEK/m²/yr)" — because
   TAB4590 is a ~16 000-apartment sample survey and the interval is the honest part
   of the figure, not a footnote. */
function moeSpan(i, v, m) {
  if (m == null) return "";
  const who = /^SCB/.test(i.source || "") ? "SCB" : (String(i.source || "").split(/[,(]/)[0].trim() || "the publisher");
  const u = unitTight((i.moe && i.moe.unit) || i.unit);
  const tip = `±${nf(m, 0)} = ${who} margin of error${u ? ` (${u})` : ""}`
    + (moeWide(i, v, m) ? " — wider than this indicator allows, read with care" : "");
  return `<span class="moe${moeWide(i, v, m) ? " wide" : ""}" data-testid="moe" title="${esc(tip)}" aria-label="${esc(tip)}">±${nf(m, 0)}</span>`;
}
function fmtCell(i, v, fallback, o, y) {
  if (v == null || isNaN(v)) return `<td class="num">–</td>`;
  const m = moeOf(i, o, y);
  return `<td class="num${moeWide(i, v, m) ? " dim" : ""}${fallback ? " inh" : ""}" data-v="${v}">${fmtOf(i)(v)}${fallback ? ` <span class="tag-muni" title="the kommun's figure — no finer statistic is published">muni</span>` : ""}${moeSpan(i, v, m)}</td>`;
}
function deltaCell(o, i, pool) {
  /* A coded indicator has no arithmetic: "Shortage → Balance" is not +1 pp. */
  if (catsOf(i)) return `<td class="num dim" title="a coded assessment, not a quantity — a change in it is not a number">–</td>`;
  const y0 = yearsForPool(i.key, pool || curPool())[0]; if (!y0 || y0 === MK.year) return `<td class="num dim">–</td>`;
  const a = V(o, i.key, y0), b = V(o, i.key); if (a == null || b == null) return `<td class="num dim">–</td>`;
  const d = isPct(i) ? b - a : (a ? (b / a - 1) * 100 : null); if (d == null) return `<td class="num dim">–</td>`;
  return `<td class="num ${cls(d, i.key)}" data-v="${d}">${signed(d, 1, deltaUnit(i))}</td>`;
}
function tableRows() {
  const q = T.q;
  if (T.level === "deso") return allDeso().filter(a => (a.pop || 0) >= T.minPop && (!q || (a.name || "").toLowerCase().includes(q) || a.code.toLowerCase().includes(q)));
  if (T.level === "kommun") return MUNI.filter(m => (!T.lan || m.lan === T.lan) && (m.pop || 0) >= T.minPop && (!q || m.name.toLowerCase().includes(q) || m.code.includes(q)));
  return AREAS.filter(a => { const m = byCode[a.kommun] || {}; return (!T.lan || m.lan === T.lan) && (a.pop || 0) >= T.minPop && (!q || (a.name || "").toLowerCase().includes(q) || a.code.includes(q) || (m.name || "").toLowerCase().includes(q)); });
}
/* Every indicator, in the order this level publishes them. */
function tableColsAll() {
  return T.level === "deso" ? IND_DESO
    : T.level === "regso" ? IND.filter(i => i.level === "regso").concat(IND.filter(i => i.level !== "regso"))
    : IND;
}
/* What the table actually draws. 3 363 RegSO × 67 indicators is 225 000 cells and
   11 MB of DOM, which is slow to build, slow to scroll and not what anyone came
   for: the default is the active indicator plus the headline set, and `Columns`
   opens the rest. The export is unaffected — it always writes every indicator. */
function tableCols() {
  const all = tableColsAll();
  if (T.cols === "all") return all;
  const want = new Set([MK.ind].concat(HL_KEYS).concat(QUICK_KEYS));
  return all.filter(i => want.has(i.key));
}
function tableBodyHtml() {
  const cols = tableCols(), ind = curInd(), pool = curPool(), y0 = yearsForPool(ind.key, pool)[0];
  /* 3 363 rows of dashes would read as 3 363 suppressed figures */
  if (T.level === "regso" && !RG.vals) {
    return `<tr><td colspan="${cols.length + 5}" class="empty" data-testid="${RG.valsFailed ? "regso-failed" : "regso-loading"}">${esc(RG.valsFailed ? RG_GONE : RG_WAIT)}</td></tr>`;
  }
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
    <div class="card-head tools-only"><div class="tools">${indPicker("map")}${periodControl()}</div>${indQuick()}</div>
    ${indExplain(ind)}
    <div class="tfilters">
      <input id="tq" type="search" placeholder="Search kommun, RegSO or code…" value="${esc(T.q)}">
      <div class="seg"><button class="sg ${T.level === "kommun" ? "on" : ""}" data-tlevel="kommun">Kommuner (${MUNI.length})</button><button class="sg ${T.level === "regso" ? "on" : ""}" data-tlevel="regso">RegSO (${REGSO_N})</button>${allDeso().length ? `<button class="sg ${T.level === "deso" ? "on" : ""}" data-tlevel="deso">DeSO (${allDeso().length})</button>` : ""}</div>
      ${T.level !== "deso" ? `<select id="tregion" class="indsel"><option value="">All regions</option>${REGIONS.map(r => `<option value="${r}" ${T.lan === r ? "selected" : ""}>${r}</option>`).join("")}</select>` : ""}
      <label class="hint">min. population <input id="tminpop" type="number" min="0" step="1000" value="${T.minPop}" style="width:90px"></label>
      <span class="hint" id="tcount">${tableRows().length} rows</span>
      <div class="seg" role="group" aria-label="Columns">
        <button class="sg ${T.cols === "all" ? "" : "on"}" data-tcols="headline">Headline columns (${tableCols().length})</button>
        <button class="sg ${T.cols === "all" ? "on" : ""}" data-tcols="all">All ${tableColsAll().length}</button>
      </div>
    </div>
    <div class="scrollx"><table class="tbl compact wraphead" data-sortable><thead><tr>
      <th>${T.level === "deso" ? "DeSO" : T.level === "regso" ? "RegSO" : "Kommun"}</th><th>Code</th><th>${T.level === "deso" ? "RegSO" : T.level === "regso" ? "Municipality" : "Region"}</th><th class="num">Population</th>
      <th class="num hi">${esc(ind.label)}<br><span class="dim">${esc(ind.unit || "")}</span></th>${y0 && y0 !== MK.year ? `<th class="num">Δ since ${y0}<br><span class="dim">${isPct(ind) ? "pp" : "%"}</span></th>` : ""}
      ${cols.filter(i => i.key !== ind.key).map(i => `<th class="num">${esc(i.label)}<br><span class="dim">${esc(i.unit || "")}</span></th>`).join("")}</tr></thead>
      <tbody id="tbody">${tableBodyHtml()}</tbody></table></div>
    <p class="cap">Sorted by the selected indicator; click a column header to re-sort, a row to open the area's page, ↗ to chart it. A cell tagged <span class="tag-muni">muni</span> is the kommun's figure, shown where the sub-area publishes none. Rows: ${T.level === "regso" ? `${REGSO_N} RegSO — SCB's named neighbourhoods, 2025 division` : T.level === "deso" ? `${allDeso().length} DeSO in the kommuner opened so far — codes only, no names` : `${MUNI.length} kommuner`}. <b>Export writes every indicator</b> whichever column set is on screen.</p>
    ${srcNote()}
  </div>`;
}
function downloadCsv(lines, name) {
  const blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- Area page (kommun · RegSO · DeSO) ---------- */
function areaEntity() {
  if (AR.type === "kommun") {
    const m = byCode[AR.code]; if (!m) return null;
    /* `ctx`/`own` are DRAWN, so they are the RegSO whose rings have arrived;
       `subs` is TABLED, so it is all of them by name. The two used to be the
       same array, which with lazy geometry meant either a mini-map handed an
       undefined ring or a sub-area table that lost 127 rows. */
    const drawn = regsoDrawable(m.code);
    const subs = { regso: regsoAll(m.code) };
    if (desoLoaded(m.code)) subs.deso = desoAreas(m.code);
    return { type: "kommun", typeLabel: "Kommun", o: m, name: m.name, code: m.code, kommun: null, lan: m.lan, inds: IND, peers: MUNI, peerLabel: "kommuner",
             ctx: drawn, own: drawn, subs };
  }
  if (AR.type === "regso") {
    const a = byRegso[AR.code]; if (!a) return null; const m = byCode[a.kommun];
    const kids = desoAreas(a.kommun).filter(d => d.regso === a.code);
    return { type: "regso", typeLabel: "RegSO", o: a, name: a.name, code: a.code, kommun: m, lan: m && m.lan, inds: IND, peers: AREAS, peerLabel: "RegSO areas",
             ctx: regsoDrawable(a.kommun), own: [a], subs: kids.length ? { deso: kids } : null };
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
/* The kommun a sub-area falls back to, or null for a kommun. BOTH sub-levels: the map
   has always tinted a DeSO with its kommun's value for a kommun-only indicator, and a
   DeSO page that answered "–" to the same question was the one place that disagreed —
   which is why rent was missing from a DeSO area page and from a pin that landed in one. */
const subKommun = e => (e && (e.type === "regso" || e.type === "deso") && e.kommun) || null;
/* value for the entity: its own figure, or the kommun's (inherited, °) for sub-areas */
function eVal(e, k, y) { const own = V(e.o, k, y); if (own != null) return { v: own, own: true }; const m = subKommun(e); if (canInherit(k) && m) { const mv = V(m, k, y); if (mv != null) return { v: mv, own: false }; } return { v: null, own: false }; }
function eYears(e, k) { return histYears(k, subKommun(e) && V(e.o, k) == null ? MUNI : e.peers); }
/* everything a tile, headline cell or popup needs about one indicator for one area */
function tileStats(e, i) {
  /* `per` rather than MK.year throughout: on the map a quarter can be selected
     for the active indicator while the other tiles read their own latest year */
  const per = periodFor(i);
  const cur = eVal(e, i.key, per); if (cur.v == null) return null;
  const ys = eYears(e, i.key), y0 = ys[0];
  const own = ys.map(y => eVal(e, i.key, y).v), med = ys.map(y => median(e.peers.map(p => V(p, i.key, y))));
  const dlt = (a, b) => a == null || b == null ? null : isPct(i) ? b - a : (a ? (b / a - 1) * 100 : null);
  const unit = isPct(i) ? " pp" : " %";
  const li = own.map((v, k) => v == null ? -1 : k).filter(k => k >= 0).pop(); const idx = per === LATEST ? li : ys.indexOf(per);
  /* a coded assessment has no arithmetic: Shortage → Balance is not +1 pp */
  const coded = !!catsOf(i);
  const yoy = coded || idx <= 0 ? null : dlt(own[idx - 1], own[idx]);
  const since = coded || !y0 || y0 === per ? null : dlt(own[0], cur.v);
  /* a difference, in pp for a share and in the indicator's own unit otherwise —
     never a percentage OF a median */
  const medPeer = median(e.peers.map(p => V(p, i.key, per)));
  const vsMed = medPeer == null ? null : cur.v - medPeer;
  const rk = cur.own ? rankOf(e.o, i.key, e.peers, per) : null;
  return { cur, per, ys, y0, own, med, yoy, since, vsMed, rk, unit };
}
/* A rise is green only where a rise is good. On unemployment it is red, and on
   a descriptor it is neither — `cls` returns "" and the delta is drawn plain. */
const cls = (d, key) => { const i = key ? indOf(key) : null;
  if (d == null || !d) return ""; if (i && neutralDir(i)) return "";
  const good = i && lowerBetter(i) ? d < 0 : d > 0; return good ? "up" : "dn"; };
/* headline row under the area title: the five figures that answer "what kind of area is this" */
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
  return `<div class="scrollx"><table class="tbl compact" data-sortable data-testid="figures-table"><thead><tr><th>Indicator</th><th>Level</th><th class="num">${esc(e.type === "kommun" ? e.name : e.type === "deso" ? "DeSO" : "RegSO")}</th>${e.kommun ? `<th class="num">${esc(e.kommun.name)}</th>` : ""}<th class="num">${medLabel}</th><th class="num">Rank</th><th class="num">Δ since first year</th><th>As of</th></tr></thead>
    <tbody>${e.inds.map(i => { const cur = eVal(e, i.key); if (cur.v == null) return "";
      const ys = eYears(e, i.key), y0 = ys[0]; const first = y0 && y0 !== MK.year ? eVal(e, i.key, y0).v : null;
      const d = first == null ? null : isPct(i) ? cur.v - first : (first ? (cur.v / first - 1) * 100 : null);
      const rk = cur.own ? rankOf(e.o, i.key, e.peers) : null; const med = median(e.peers.map(p => V(p, i.key)));
      return `<tr class="clickrow ${i.key === ind.key ? "hi" : ""}${cur.own ? "" : " inh"}" data-arind="${esc(i.key)}"><th><span class="thn">${esc(i.label)} <span class="dim">${esc(i.unit || "")}</span></span><button class="tch" data-go="${chartLink(i.key, e.type, e.code)}" title="Open in Charts">↗</button></th>
        <td>${cur.own ? `<span class="dim">${esc(e.typeLabel.toLowerCase())}</span>` : `<span class="tag-muni" title="the kommun's figure — no finer statistic is published">muni</span>`}</td>
        ${fmtCell(i, cur.v, false, cur.own ? e.o : e.kommun)}${e.kommun ? (muniCmp(e, i.key) ? fmtCell(i, V(e.kommun, i.key), false, e.kommun) : `<td class="num dim" title="different definition at municipality level">n/c</td>`) : ""}${fmtCell(i, med, false)}
        <td class="num" data-v="${rk ? rk.r : ""}" title="${rk ? `among the ${rk.n} ${esc(e.peerLabel)} with a figure` : ""}">${rk ? `#${rk.r} of ${rk.n}` : "–"}</td>
        <td class="num ${d > 0 ? "good" : d < 0 ? "bad" : ""}" data-v="${d ?? ""}">${d != null ? signed(d, 1, deltaUnit(i)) + ` <span class="dim">(${y0})</span>` : "–"}</td>
        <td class="dim">${asofText(i)}</td></tr>`; }).join("")}</tbody></table></div>`;
}
function areaSubTable(e) {
  if (!e.subs) return "";
  const keys = Object.keys(e.subs); const sub = keys.includes(AR.sub) ? AR.sub : keys[0]; const list = e.subs[sub];
  /* the RegSO rows are names now and figures once regso/values.json lands */
  if (sub === "regso" && !RG.vals) return regsoWait();
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

/* ---------- Test property ----------
   One pin, read against every layer this dashboard carries. The route is
   `#property?p=lat,lon[:label]`; the codec in route_core.js is list-capable so
   the "paste several Google Maps links" idea needs no second format later, but
   one property at a time is what this page does.

   Nothing about the pin leaves the browser: the link is parsed here by
   src/testprop.js, the point is tested against boundary rings this page already
   serves, and the coordinate lives only in the fragment — which is never sent to
   a server. That sentence belongs on this page and nowhere else, which is why it
   left the map's toolbar.

   Every figure is the published number for the AREA the pin falls in — DeSO where
   the statistic exists at that level, otherwise RegSO, otherwise the kommun,
   labelled as such. Nothing is interpolated to the point and nothing is modelled. */
/* the indicator's own format applied to a magnitude, with any sign the format
   would have added stripped — the caller adds exactly one */
const fmtAbs = (i, x) => String(fmtOf(i)(Math.abs(x))).replace(/^[+−-]\s*/, "");

/* parseLocation lives in src/testprop.js and is inlined ahead of this file, so
   it is testable offline with `node --test` and never touches the DOM. */
function propSet(text) {
  const err = document.getElementById("properr");
  const r = parseLocation(text);
  if (r.error) {
    if (!String(text || "").trim()) { PROP.lat = PROP.lon = null; PROP.res = null; PROP.resKey = ""; syncHash(); renderKeep(); return; }
    if (err) err.textContent = r.message;
    return;
  }
  if (err) err.textContent = "";
  PROP.lat = +r.lat.toFixed(6); PROP.lon = +r.lon.toFixed(6);
  PROP.res = null; PROP.resKey = "";
  syncHash();
  propResolve().then(() => { if (S.view === "property") renderKeep(); });
  renderKeep();
}
const propName = () => PROP.label
  || (PROP.res && PROP.res.regso && PROP.res.regso.name)
  || (PROP.res && PROP.res.kommun && PROP.res.kommun.name) || "";
async function propResolve() {
  if (PROP.lat == null) { PROP.res = null; PROP.resKey = ""; return; }
  const key = PROP.lat + "," + PROP.lon;
  if (PROP.resKey === key) return;
  PROP.resKey = key;
  const r = await locate(PROP.lat, PROP.lon);
  /* And the RegSO figures, before the page reads any of them. propVal() walks
     DeSO → RegSO → kommun and takes the first figure it finds, so a pin resolved
     while the pool was still in flight would fall through to the kommun's figure
     and label it "municipality figure" — a wrong statement, not a missing one. */
  await new Promise(res => regsoLoadVals(res));
  /* the reader may have moved the pin while the rings were in flight */
  if (PROP.resKey !== key) return;
  PROP.res = r;
  /* the pin reads its figures off the finest area it lands in, and draws that
     area's neighbours on the mini-map — so both levels of the kommun it landed
     in are fetched, not only DeSO */
  if (PROP.lat != null) { loadDeso(r && r.kommun ? r.kommun.code : null); regsoLoad(r && r.kommun ? r.kommun.code : null); }
  if (S.view === "property") renderKeep();
}
/* the finest entity we actually hold figures for */
function propEntity() {
  const r = PROP.res; if (!r || r.error) return null;
  return {
    deso: (r.deso && byDeso[r.deso.code]) || null,
    regso: (r.regso && byRegso[r.regso.code]) || null,
    kommun: (r.kommun && byCode[r.kommun.code]) || null,
  };
}
const PROP_GROUPS = ["Demographics", "Outlook", "Safety", "Schools", "Climate", "Growth signals",
                     "Income & jobs", "Housing stock", "Rents", "Prices & market", "Area quality"];
/* one indicator value for the pin, from the finest level that publishes it */
function propVal(key) {
  const e = propEntity(); if (!e) return null;
  for (const [lvl, o] of [["DeSO", e.deso], ["RegSO", e.regso], ["kommun", e.kommun]]) {
    if (!o) continue;
    const v = V(o, key);
    if (v != null) return { v, lvl, own: lvl !== "kommun", o };
    if (noInherit(indOf(key))) return null;
  }
  return null;
}
function propRow(i) {
  const a = propVal(i.key);
  if (!a) return "";
  return `<tr><th>${esc(i.short || i.label)}<span class="dim"> ${esc(i.unit || "")}</span></th>
    <td class="num">${fmtOf(i)(a.v)}${moeSpan(i, a.v, moeOf(i, a.o))}</td>
    <td class="dim">${a.own ? esc(a.lvl) : `<span class="inh">municipality figure</span>`}</td>
  </tr>`;
}
function propWhere() {
  const r = PROP.res;
  if (!r) return `<p class="empty">Locating…</p>`;
  if (r.error) return `<p class="empty">${esc(r.error)}</p>`;
  const bits = [["Kommun", r.kommun && r.kommun.name], ["RegSO", r.regso && r.regso.name],
                ["DeSO", r.deso && r.deso.code]];
  return `<div class="anwhere">${bits.map(([l, v]) => v
    ? `<span><em>${esc(l)}</em>${esc(v)}</span>` : "").join("")}</div>`;
}
function propSchoolsNear(n) {
  if (PROP.lat == null || !PROP.res || !PROP.res.kommun) return [];
  /* neighbouring kommuner matter: the nearest school to a pin near a boundary is
     often in the next kommun, so every kommun whose bbox is within ~8 km is read */
  const near = [];
  for (const code in SCH_IDX) {
    const bb = SCH_IDX[code].bbox;
    if (!bb) continue;
    const dLat = Math.max(0, Math.max(bb[0] - PROP.lat, PROP.lat - bb[2]));
    const dLon = Math.max(0, Math.max(bb[1] - PROP.lon, PROP.lon - bb[3]));
    if (havM(PROP.lat, PROP.lon, PROP.lat + dLat, PROP.lon + dLon) < 8000) near.push(code);
  }
  near.forEach(schLoad);
  const out = [];
  for (const code of near) {
    if (!Array.isArray(SCH[code])) continue;
    for (const s of SCH[code]) out.push({ s, m: havM(PROP.lat, PROP.lon, s.lat, s.lon) });
  }
  out.sort((x, y) => x.m - y.m);
  return out.slice(0, n || 5);
}
const distTxt = m => m < 1000 ? nf(Math.round(m / 10) * 10, 0) + " m" : nf(m / 1000, 1) + " km";

/* The Climate block is kept apart from the generic indicator table because every
   climate figure needs its horizon or scenario in the label, and because "Not
   mapped" has to read as a sentence rather than a dash in a column. */
const CLIM_KEYS = ["flood100", "flood200", "floodBHF", "coast20", "coast30",
                   "sea2100_85", "sea2100_45", "landslide"];
function propClimate() {
  const e = propEntity(); if (!e) return "";
  const rows = CLIM_KEYS.map(key => {
    const i = indOf(key); if (!i) return "";
    const got = propVal(key);
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

/* a <details> section whose open state is shareable through show= */
const showSet = () => (S.view === "property" ? PROP.show : S.view === "makro" ? MC.show : AR.show);
function secHtml(id, title, right, body, opts) {
  const o = opts || {};
  const open = showSet().has(id);
  return `<details class="sec" data-sec="${esc(id)}" data-testid="sec-${esc(id)}"${open ? " open" : ""}${o.render ? ' data-sec-render="1"' : ""}>
    <summary><b>${esc(title)}</b>${right ? `<span class="dim">${right}</span>` : ""}</summary>
    <div class="secbody">${body}</div></details>`;
}

/* The pin's finest area, in the shape areaEntity() returns, so the study row,
   the tiles and the All-figures table are the SAME components as the area page's
   rather than a second implementation. DeSO where the statistic exists at that
   level, otherwise RegSO, otherwise the kommun — and the level is on the page. */
function propArea() {
  const e = propEntity(); if (!e) return null;
  if (e.deso) {
    const sibs = desoAreas(e.deso.kommun);
    return { type: "deso", typeLabel: "DeSO", o: e.deso, name: e.deso.code.split("_")[0], code: e.deso.code,
             kommun: e.kommun, lan: e.kommun && e.kommun.lan, inds: IND,
             peers: sibs.length ? sibs : [e.deso], peerLabel: "DeSO areas", ctx: sibs, own: [e.deso], subs: null };
  }
  if (e.regso) {
    return { type: "regso", typeLabel: "RegSO", o: e.regso, name: e.regso.name, code: e.regso.code,
             kommun: e.kommun, lan: e.kommun && e.kommun.lan, inds: IND, peers: AREAS, peerLabel: "RegSO areas",
             ctx: regsoDrawable(e.regso.kommun), own: [e.regso], subs: null };
  }
  if (e.kommun) return kommunEntity(e.kommun);
  return null;
}
const radTxt = r => (r < 1000 ? `${r} m` : `${r / 1000} km`);

/* --- what is within the radius --- */
/* The pin's own kommun is not enough: a pin 300 m from a boundary has half its
   neighbourhood in the next kommun, and the files are per kommun. */
function nearKommuner(extraM) {
  const out = [];
  if (PROP.lat == null) return out;
  const reach = PROP.rad + (extraM || 0);
  for (const code in SRV_IDX) {
    const bb = SRV_IDX[code].bbox; if (!bb) continue;
    const dLat = Math.max(0, Math.max(bb[0] - PROP.lat, PROP.lat - bb[2]));
    const dLon = Math.max(0, Math.max(bb[1] - PROP.lon, PROP.lon - bb[3]));
    if (havM(PROP.lat, PROP.lon, PROP.lat + dLat, PROP.lon + dLon) < reach) out.push(code);
  }
  return out;
}
/* every OSM point within the radius, with its distance */
function pointsNear(cats) {
  if (PROP.lat == null) return [];
  const codes = nearKommuner(500);
  codes.forEach(srvLoad);
  const out = [];
  for (const code of codes) {
    if (!Array.isArray(SRV[code])) continue;
    for (const [cat, lat, lon, nm, tag] of SRV[code]) {
      if (!cats.includes(cat)) continue;
      const m = havM(PROP.lat, PROP.lon, lat, lon);
      if (m > PROP.rad) continue;
      out.push({ cat, lat, lon, name: nm, tag, m: Math.round(m) });
    }
  }
  out.sort((a, b) => a.m - b.m);
  return out;
}
/* A file that has not arrived yet is not an absence. Until every kommun the
   radius reaches has answered, these sections say so — "0 groceries" and "none
   within 1 km" are claims, and making them while the fetch is in flight is how
   v2.0 told a Södermalm reader there was no shop within a kilometre of 31 of them. */
const srvWaiting = () => nearKommuner(500).some(c => SRV["_l_" + c] || (SRV_IDX[c] && !Array.isArray(SRV[c])));
const schWaiting = () => Object.keys(SCH_IDX).some(c => SCH["_l_" + c]);
const loadingP = what => `<p class="empty" data-testid="loading">Loading ${esc(what)}…</p>`;
function nearCard(cats, testid) {
  if (!Object.keys(SRV_IDX).length) return `<p class="empty">Not covered yet — no OpenStreetMap point files in this build.</p>`;
  const pts = pointsNear(cats);                       /* also starts the fetches */
  if (srvWaiting()) return loadingP("the OpenStreetMap points around the pin");
  const rows = cats.map(c => {
    const mine = pts.filter(p => p.cat === c);
    const d = SRV_CATS[c];
    const nearest = mine[0];
    return `<tr><th><span class="pipdot" style="background:${d[1]}"></span>${esc(d[0])}</th>
      <td class="num">${mine.length}</td>
      <td>${nearest ? `${esc(nearest.name || d[0])} <span class="dim">${distTxt(nearest.m)}</span>` : `<span class="dim">none within ${radTxt(PROP.rad)}</span>`}</td></tr>`;
  }).join("");
  return `<table class="tbl compact" data-testid="${esc(testid)}"><thead><tr><th>Category</th><th class="num">Within ${radTxt(PROP.rad)}</th><th>Nearest</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="cap">© OpenStreetMap contributors (ODbL). Points only, straight-line distance. <b>A count is coverage as much as provision</b> — it measures how thoroughly volunteers have mapped this place as well as what is there — which is why there is no per-inhabitant rate here.</p>`;
}
/* Public buildings repeat: one school is tagged once as a building and once as
   an amenity, a few metres apart. Rows with the same name, the same use and a
   distance within 20 m are one row with a count. */
function publicNear() {
  if (!Object.keys(SRV_IDX).length) return `<p class="empty">Not covered yet — no OpenStreetMap point files in this build.</p>`;
  const pts = pointsNear(PUB_SET);
  if (srvWaiting()) return loadingP("the OpenStreetMap points around the pin");
  if (!pts.length) return `<p class="empty">Nothing within ${radTxt(PROP.rad)} in this build.</p>`;
  const groups = [];
  for (const p of pts) {
    const hit = groups.find(g => g.name === (p.name || "") && g.cat === p.cat && Math.abs(g.m - p.m) <= 20);
    if (hit) { hit.n++; continue; }
    groups.push({ name: p.name || "", cat: p.cat, m: p.m, tag: p.tag, n: 1 });
  }
  return `<table class="tbl compact" data-testid="public-near"><thead><tr><th>Building</th><th>Use</th><th class="num">Distance</th></tr></thead>
    <tbody>${groups.map(g => { const d = SRV_CATS[g.cat];
      return `<tr><th>${esc(g.name || d[0])}${g.n > 1 ? ` <span class="tag-muni" title="${g.n} OpenStreetMap objects with the same name and use within 20 m of each other">×${g.n}</span>` : ""}</th>
        <td><span class="pipdot" style="background:${d[1]}"></span>${esc(d[0])} <span class="dim">${esc(g.tag)}</span></td>
        <td class="num">${distTxt(g.m)}</td></tr>`; }).join("")}</tbody></table>
    <p class="cap">Grouped where the name, the use and the distance (±20 m) match, because one building is often tagged more than once in OpenStreetMap. © OpenStreetMap contributors (ODbL).</p>`;
}
function infraNear() {
  infraLoad();
  if (!INFRA_GEO.data) return loadingP("the project geometry");
  const hits = [];
  for (const f of INFRA_GEO.data.features || []) {
    if (!f.geometry) continue;
    let best = Infinity;
    const scan = pts => { for (const [lon, lat] of pts) { const m = havM(PROP.lat, PROP.lon, lat, lon); if (m < best) best = m; } };
    if (f.geometry.type === "MultiLineString") f.geometry.coordinates.forEach(scan);
    else if (f.geometry.type === "Point") scan([f.geometry.coordinates]);
    else scan(f.geometry.coordinates);
    if (best <= Math.max(PROP.rad, 2000)) hits.push({ p: f.properties, m: Math.round(best) });
  }
  hits.sort((a, b) => a.m - b.m);
  if (!hits.length) return `<p class="empty">No mapped project within ${radTxt(Math.max(PROP.rad, 2000))}. A project whose stations could not be found in OpenStreetMap is in <b>Data › Projects</b> but is not drawn, and so cannot be measured from here.</p>`;
  return `<table class="tbl compact" data-testid="infra-near"><thead><tr><th>Project</th><th>Status</th><th class="num">Opening</th><th class="num">Distance</th></tr></thead>
    <tbody>${hits.map(h => `<tr><th><button class="lk mini" data-go="project/${esc(h.p.id)}">${esc(h.p.name)}</button></th>
      <td><span class="pipdot" style="background:${INFRA_TONE[h.p.status] || "#8A8C81"}"></span>${esc(h.p.status)}</td>
      <td class="num">${h.p.open_year || esc(h.p.open_window || "–")}</td>
      <td class="num">${distTxt(h.m)}</td></tr>`).join("")}</tbody></table>
    <p class="cap">Distance to the nearest drawn point of the alignment or of a located station, not to a platform entrance. Shown out to ${radTxt(Math.max(PROP.rad, 2000))} because a transport project matters further away than a grocer does.</p>`;
}
function safetyNear() {
  const e = propEntity(); if (!e || !e.kommun) return "";
  const keys = IND.filter(i => i.group === "Safety" && i.key !== "vulnerable_area_share");
  const uso = (e.deso && e.deso.vulnerable_area_share != null) ? e.deso
    : (e.regso && e.regso.vulnerable_area_share != null) ? e.regso : null;
  return `<table class="tbl compact"><thead><tr><th>Indicator</th><th class="num">${esc(e.kommun.name)}</th><th class="num">SE median</th></tr></thead>
    <tbody>${keys.map(i => { const v = V(e.kommun, i.key); if (v == null) return "";
      return `<tr><th>${esc(i.label)} <span class="dim">${esc(i.unit || "")}</span></th>${fmtCell(i, v, false, e.kommun)}${fmtCell(i, median(MUNI.map(m => V(m, i.key))), false)}</tr>`; }).join("")}</tbody></table>
    ${uso ? usoLine(uso) : `<p class="cap">The police have designated no part of this pin's ${e.deso ? "DeSO" : "RegSO"} area.</p>`}
    <p class="cap">Reported offences are counted where the offence was reported, not where the offender or the victim lives, and a kommun with a shopping centre or a station counts offences committed against people who do not live there. Källa: Brå. The police designation is an assessment of an area's conditions, not a rating of its residents.</p>`;
}
function schoolsNear() {
  if (!Object.keys(SCH_IDX).length) return `<p class="empty">Not covered yet — no Skolverket files in this build.</p>`;
  const sch = propSchoolsNear(6);                     /* also starts the fetches */
  if (schWaiting()) return loadingP("the schools around the pin");
  if (!sch.length) return `<p class="empty">No school with a year 9 within 8 km of the pin.</p>`;
  const e = propEntity();
  const km = e && e.kommun;
  const nat = SCH_META.national_merit;
  return `<table class="tbl compact" data-testid="schools-near"><thead><tr><th>School</th><th class="num">Distance</th><th class="num">Merit</th><th class="num">vs ${esc(km ? km.name : "kommun")}</th><th class="num">vs Sweden</th></tr></thead>
    <tbody>${sch.map(({ s, m }) => `<tr><th><button class="lk mini" data-go="school/${esc(s.code)}">${esc(s.name)}</button></th>
      <td class="num">${distTxt(m)}</td>
      <td class="num">${s.merit != null ? nf(s.merit, 1) : `–<span class="dim"> ${esc(s.merit_why === "OMITTED_DUE_TO_BASED_ON_FEW_PUPILS" ? "too few pupils" : "not published")}</span>`}</td>
      <td class="num ${s.merit != null && km && km.school_merit != null ? cls(s.merit - km.school_merit, "school_merit") : ""}">${s.merit != null && km && km.school_merit != null ? signed(s.merit - km.school_merit, 1) : "–"}</td>
      <td class="num ${s.merit != null && nat != null ? cls(s.merit - nat, "school_merit") : ""}">${s.merit != null && nat != null ? signed(s.merit - nat, 1) : "–"}</td></tr>`).join("")}</tbody></table>
    <p class="cap">Straight-line distance, not walking distance, and neighbouring kommuner are included — the nearest school to a pin near a boundary is often across it. <b>Raw merit value, not SALSA-adjusted</b>: it tracks the intake as much as the teaching. Källa: Skolverket.</p>`;
}

/* ---------- the summary strip (v2.1 P5) ----------
   Seven answers an asset manager wants before reading anything else, each one a
   link into the section that shows its working. The strip is BUILT from the same
   inputs those sections use — one model, `stripItems()`, read by the DOM and by
   the Nearby export — so it cannot say one thing while the table under it says
   another.

   Two rules the whole strip turns on:
     · an input that has not arrived yet makes the item say "…", never 0. A count
       of 0 is a statement about the place; "…" is a statement about the fetch,
       and v2.0 shipped the first one for months ("Grocery 0" beside 31 shops).
     · a hazard layer that never surveyed this spot reads "not mapped", which is
       not "clear". 0 % means surveyed and found clear; null means nobody looked.

   The strip reaches further than the sections do — a transport stop out to 2 km
   whatever the pin's radius, groceries at the brief's fixed 500 m — so it has
   its own kommun set and its own waiting predicate. Reusing srvWaiting() here
   would let it print a count off a file that was still on the way. */
const STRIP_GROCERY_M = 500;        /* the brief's own radius, not the reader's */
const STRIP_STOP_M = 2000;          /* a stop further out than this is not "nearby" */
const STRIP_WAIT = "…";
const stripReach = () => Math.max(PROP.rad + 500, STRIP_STOP_M, STRIP_GROCERY_M);
const stripKommuner = () => nearKommuner(stripReach() - PROP.rad);
const stripSrvWaiting = () => stripKommuner().some(c => SRV["_l_" + c] || (SRV_IDX[c] && !Array.isArray(SRV[c])));
/* every OSM point of these categories within `reach` metres, nearest first */
function stripPoints(cats, reach) {
  if (PROP.lat == null) return [];
  const codes = stripKommuner();
  codes.forEach(srvLoad);                             /* also starts the fetches */
  const out = [];
  for (const code of codes) {
    if (!Array.isArray(SRV[code])) continue;
    for (const [cat, lat, lon, nm, tag] of SRV[code]) {
      if (!cats.includes(cat)) continue;
      const m = havM(PROP.lat, PROP.lon, lat, lon);
      if (m > reach) continue;
      out.push({ cat, name: nm, tag, m: Math.round(m) });
    }
  }
  out.sort((a, b) => a.m - b.m);
  return out;
}
/* Which mapped hazard layers this spot is inside, which mapped it and found it
   clear, and which never covered it. Three answers, never folded into two. */
function stripClimate() {
  const zones = [], clear = [], unmapped = [];
  for (const key of CLIM_KEYS) {
    const i = indOf(key); if (!i) continue;
    const got = propVal(key);
    if (!got || got.v == null) { unmapped.push(i); continue; }
    if (got.v > 0) zones.push({ i, v: got.v }); else clear.push(i);
  }
  return { zones, clear, unmapped, n: CLIM_KEYS.length };
}
/* The police designation, read at the finest level that carries one. It never
   inherits, so a kommun figure is not an answer about this spot. */
function stripUso() {
  const e = propEntity(); if (!e) return null;
  const lvl = e.deso ? "DeSO" : e.regso ? "RegSO" : "kommun";
  const o = (e.deso && e.deso.vulnerable_area_share != null) ? e.deso
    : (e.regso && e.regso.vulnerable_area_share != null) ? e.regso : null;
  if (!o) return { inside: false, lvl };
  return { inside: o.vulnerable_area_share > 0, share: o.vulnerable_area_share,
           cls: o.vulnerable_area_share_class || "utsatt",
           lvl: o === e.deso ? "DeSO" : "RegSO" };
}
/* The listings figures the strip shows. It does NOT start the request — the
   section below does that on the same render — so "nothing has come back yet"
   is `pinDone`, not an empty array. An empty array once the answer is in is a
   real zero and says so. */
function stripListings() {
  if (LST.error) return { error: LST.error };
  if (!LST.pinDone.has(lstPinKey())) return { loading: true };
  const near = lstNearPin(LST.rows);
  const shown = LV.applyFilters ? LV.applyFilters(near, LST.filters) : near;
  const direct = shown.filter(l => !lstIsQueue(l));
  const vals = direct.map(l => LV.sekPerM2Year(l)).filter(v => v != null);
  const minN = LV.MIN_N || 3;
  return { n: shown.length, direct: direct.length, queue: shown.length - direct.length,
           med: vals.length >= minN ? LV.median(vals) : null, medN: vals.length, minN };
}
/* The publisher and the page that reproduces a figure, off the indicator
   registry rather than written out a second time here. */
function stripSrcOf(key, fallback) {
  const i = indOf(key) || {}, v = ((i.src_verify || [])[0]) || {};
  return [v.label || i.source || fallback, v.page || ""];
}
const OSM_SRC = ["OpenStreetMap contributors (ODbL)", "https://www.openstreetmap.org/copyright"];
const SKV_SRC = ["Skolverket", "https://www.skolverket.se/"];

function stripItems() {
  if (PROP.lat == null || !propEntity()) return [];
  const haveOsm = Object.keys(SRV_IDX).length > 0;
  /* the point scans start the fetches, so they run before the waiting question */
  const stops = haveOsm ? stripPoints(["transport"], STRIP_STOP_M) : [];
  const groc = haveOsm ? stripPoints(["grocery"], STRIP_GROCERY_M) : [];
  const srvWait = haveOsm && stripSrvWaiting();
  const sch = Object.keys(SCH_IDX).length ? propSchoolsNear(1) : [];
  const schWait = Object.keys(SCH_IDX).length > 0 && schWaiting();
  const clim = stripClimate();
  const uso = stripUso();
  const lst = stripListings();
  const it = [];

  /* 1 — the nearest public transport stop */
  if (!haveOsm) it.push({ id: "transport", sec: "services", label: "Nearest transport stop",
    value: "–", sub: "not covered yet", state: "none", src: OSM_SRC[0], src_url: OSM_SRC[1] });
  else if (srvWait) it.push({ id: "transport", sec: "services", label: "Nearest transport stop",
    value: STRIP_WAIT, sub: "Loading the OpenStreetMap points…", state: "loading",
    src: OSM_SRC[0], src_url: OSM_SRC[1] });
  else it.push({ id: "transport", sec: "services", label: "Nearest transport stop",
    value: stops.length ? distTxt(stops[0].m) : "–",
    sub: stops.length ? `${stops[0].name || "unnamed stop"} · ${stops[0].tag}`
                      : `none within ${radTxt(STRIP_STOP_M)}`,
    state: stops.length ? "ok" : "none", dist: stops.length ? stops[0].m : null,
    src: OSM_SRC[0], src_url: OSM_SRC[1] });

  /* 2 — groceries within 500 m, whatever the reader's radius is set to */
  if (!haveOsm) it.push({ id: "grocery", sec: "services", label: `Groceries within ${radTxt(STRIP_GROCERY_M)}`,
    value: "–", sub: "not covered yet", state: "none", src: OSM_SRC[0], src_url: OSM_SRC[1] });
  else if (srvWait) it.push({ id: "grocery", sec: "services", label: `Groceries within ${radTxt(STRIP_GROCERY_M)}`,
    value: STRIP_WAIT, sub: "Loading the OpenStreetMap points…", state: "loading",
    src: OSM_SRC[0], src_url: OSM_SRC[1] });
  else it.push({ id: "grocery", sec: "services", label: `Groceries within ${radTxt(STRIP_GROCERY_M)}`,
    value: nf(groc.length, 0),
    sub: groc.length ? `nearest ${distTxt(groc[0].m)} · ${groc[0].name || "unnamed"}`
                     : `none within ${radTxt(STRIP_GROCERY_M)}`,
    state: groc.length ? "ok" : "none", src: OSM_SRC[0], src_url: OSM_SRC[1] });

  /* 3 — the nearest year 9, and its merit value */
  const s0 = sch[0];
  if (!Object.keys(SCH_IDX).length) it.push({ id: "school", sec: "schools", label: "Nearest year-9 merit",
    value: "–", sub: "not covered yet", state: "none", src: SKV_SRC[0], src_url: SKV_SRC[1] });
  else if (schWait) it.push({ id: "school", sec: "schools", label: "Nearest year-9 merit",
    value: STRIP_WAIT, sub: "Loading the schools around the pin…", state: "loading",
    src: SKV_SRC[0], src_url: SKV_SRC[1] });
  else it.push({ id: "school", sec: "schools", label: "Nearest year-9 merit",
    value: s0 && s0.s.merit != null ? nf(s0.s.merit, 1) : "–",
    sub: s0 ? `${s0.s.name} · ${distTxt(s0.m)}${s0.s.merit == null ? " · merit not published" : ""}`
            : "no year 9 within 8 km",
    state: s0 ? (s0.s.merit != null ? "ok" : "none") : "none",
    dist: s0 ? Math.round(s0.m) : null, src: SKV_SRC[0], src_url: SKV_SRC[1] });

  /* 4 — in any mapped hazard zone, and which */
  const cSrc = stripSrcOf("flood100", "MCF, SMHI och SGU");
  it.push({ id: "climate", sec: "climate", label: "In a mapped hazard zone",
    value: clim.zones.length ? "Yes" : clim.clear.length ? "No" : "Not mapped",
    sub: clim.zones.length
      ? clim.zones.map(z => z.i.short || z.i.label).join(", ")
      : clim.clear.length
        ? `${clim.clear.length} of ${clim.n} layers cover this spot and none includes it`
        : `none of the ${clim.n} hazard layers covers this spot`,
    state: clim.zones.length ? "warn" : clim.clear.length ? "ok" : "none",
    src: cSrc[0], src_url: cSrc[1] });

  /* 5 — police-designated area */
  const uSrc = stripSrcOf("vulnerable_area_share", "Polismyndigheten");
  it.push({ id: "police", sec: "safety", label: "Police-designated area",
    value: uso && uso.inside ? "Yes" : "No",
    sub: uso && uso.inside
      ? `${USO_LABEL[uso.cls] || uso.cls} · ${nf(uso.share, 1)} % of this ${uso.lvl}`
      : `no designation in this pin's ${(uso && uso.lvl) || "area"}`,
    state: uso && uso.inside ? "warn" : "ok", src: uSrc[0], src_url: uSrc[1] });

  /* 6 — the live adverts inside the reader's radius */
  it.push({ id: "listings", sec: "listings", label: `Live listings within ${radTxt(PROP.rad)}`,
    value: lst.error ? "unavailable" : lst.loading ? STRIP_WAIT : nf(lst.n, 0),
    sub: lst.error ? "gateway error — open the section to retry"
       : lst.loading ? "Loading the listings gateway…"
       : `${nf(lst.direct, 0)} direct · ${nf(lst.queue, 0)} queue`,
    state: lst.error ? "err" : lst.loading ? "loading" : lst.n ? "ok" : "none",
    src: "Third-party adverts, live through this project's gateway", src_url: "" });

  /* 7 — and what they ask, over the direct ones only */
  it.push({ id: "median", sec: "listings", label: "Median advertised",
    value: lst.error ? "–" : lst.loading ? STRIP_WAIT : lst.med != null ? nf(lst.med, 0) : "–",
    sub: lst.error ? "listings unavailable"
       : lst.loading ? "Loading the listings gateway…"
       : lst.med != null ? `SEK/m²/yr · n=${lst.medN} direct · advertised`
       : `n=${lst.medN} direct · too few to publish (n ≥ ${lst.minN})`,
    state: lst.error ? "err" : lst.loading ? "loading" : lst.med != null ? "ok" : "none",
    src: "Third-party adverts, live through this project's gateway", src_url: "" });

  return it;
}
const STRIP_CAP = `<p class="cap">Each answer links to the section that shows its working.
  Straight-line distances from OpenStreetMap points, the nearest year 9 from Skolverket, the
  hazard layers from MCF/SMHI/SGU and the designation from Polismyndigheten.
  <b>An item still fetching says "…", never 0</b>, and a hazard layer that never surveyed this
  spot reads "not mapped" — which is not the same as surveyed and clear. The median is over
  <b>direct listings only</b> and is an advertised rent, not a contract rent.</p>`;
function propStripInner() {
  const items = stripItems();
  if (!items.length) return "";
  return `<div class="pstrip" data-testid="prop-strip">${items.map(it =>
    `<button class="pst ${esc(it.state)}" data-testid="strip-${esc(it.id)}" data-secgo="${esc(it.sec)}"
      title="${esc(`${it.label} — ${it.src}. Click to open the section it comes from.`)}">
      <span class="pstl">${esc(it.label)}</span>
      <b>${esc(it.value)}</b>
      <em>${esc(it.sub)}</em></button>`).join("")}</div>
  ${STRIP_CAP}`;
}
/* the listings items arrive after the first paint, and lstSectionRefresh() only
   redraws the section — the strip has to be told too */
function propStripRefresh() {
  const el = document.getElementById("propstrip");
  if (el && S.view === "property" && PROP.lat != null) el.innerHTML = propStripInner();
}
/* ---------- the privacy position ----------
   One line, because that is the sentence a reader needs, with the whole of it a
   click away. v2.0 printed the full paragraph above every pin, which pushed the
   first real figure below the fold and got skipped by exactly the readers it was
   written for. Both halves stay in the DOM whether the fold is open or not, so
   the page never has to be trusted on this. */
const PRIVACY_FOLD = `<details class="privfold" data-testid="privacy">
  <summary><b>Nothing leaves your browser except the listings request.</b> <i>details</i></summary>
  <div class="privbody">
    <p>The link is parsed here, the point is tested against boundary files this page already
      serves, and the coordinate lives only in this page's address bar — the part after the #
      is <b>never sent to a server</b>. A short goo.gl link cannot be read without following
      it, so it is refused rather than resolved on your behalf.</p>
    <p>The one request that does leave is the rental-listings query, to this project's own
      gateway. It sends the point and the radius and nothing else: no label, no identifier,
      and nothing about you. Nothing is stored — the adverts are read live and kept only in
      this tab. Every other file this page fetches (boundaries, OpenStreetMap points, schools,
      hazard layers) comes from the same address as the page itself.</p>
  </div></details>`;
/* a strip item opens its section and takes the reader to it */
function propGoSec(id) {
  showSet().add(id);
  syncHash();
  renderKeep();
  setTimeout(() => {
    const el = document.querySelector(`[data-sec="${id}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "start", behavior: "smooth" });
  }, 40);
}

function vProperty() {
  setTimeout(propMapInit, 0);
  const pinned = PROP.lat != null;
  const r = PROP.res || {};
  const e = pinned ? propArea() : null;
  const ind = curInd();
  const osm = pinned ? `https://www.openstreetmap.org/?mlat=${PROP.lat}&mlon=${PROP.lon}#map=17/${PROP.lat}/${PROP.lon}` : "";
  const head = `
  <div class="card accent arhead">
    <div class="arid"><h2>${esc(propName() || "Test property")}</h2>
      <div class="artags">
        ${r.kommun ? `<span class="tag">${esc(r.kommun.name)}</span>` : ""}
        ${r.regso ? `<span class="tag">RegSO ${esc(r.regso.name)}</span>` : ""}
        ${r.deso ? `<span class="tag">DeSO ${esc(r.deso.code.split("_")[0])}</span>` : ""}
        ${pinned ? `<span class="tag">${esc(PROP.lat.toFixed(5))}, ${esc(PROP.lon.toFixed(5))}</span>` : ""}
        ${e ? `<span class="tag">figures read at ${esc(e.typeLabel)} level where published</span>` : ""}</div>
    </div>
    <div class="anpin">
      <input id="propin" class="indsel anin" data-testid="prop-input" placeholder="Paste a Google Maps link or 59.31972, 18.07194"
        value="${esc(pinned ? PROP.lat + ", " + PROP.lon : "")}" autocomplete="off">
      <input id="proplab" class="indsel anlab" placeholder="label (optional)" value="${esc(PROP.label)}" autocomplete="off">
      ${pinned ? `<button class="lk mini" data-propclear>clear</button>` : ""}
      <label class="hint">within <select id="proprad" class="indsel" data-testid="prop-rad">${RC.RADII.map(x =>
        `<option value="${x}" ${PROP.rad === x ? "selected" : ""}>${radTxt(x)}</option>`).join("")}</select></label>
      <span class="anerr" id="properr"></span>
    </div>
    ${pinned ? `<div class="tools">
      <button class="lk" data-go="${withQ("map/" + (r.kommun ? r.kommun.code : ""))}">Open on map</button>
      ${e ? `<button class="lk" data-go="${withQ(`area/${e.type}/${e.code}`)}">${esc(e.name)} ›</button>` : ""}
      ${r.kommun && e && e.type !== "kommun" ? `<button class="lk" data-go="${withQ("area/kommun/" + r.kommun.code)}">${esc(r.kommun.name)} ›</button>` : ""}
      <a class="lk" href="${esc(osm)}" target="_blank" rel="noopener">OpenStreetMap ↗</a>
      <button class="lk" data-copylink>Copy link</button>
    </div>` : ""}
    ${e ? headlineTiles(e) : ""}
    ${PRIVACY_FOLD}
  </div>`;
  if (!pinned) {
    return head + `<div class="card" data-testid="state-empty"><p class="empty">Paste a Google Maps link above — right-click a spot in Google Maps and copy the coordinates it offers, or copy the full URL from the address bar. For example
      <button class="lk mini" data-go="property?p=59.31972,18.07194:Södermalm">59.31972, 18.07194 — Södermalm, Stockholm</button>.</p></div>`;
  }
  if (r.error) return head + `<div class="card"><p class="empty">${esc(r.error)}</p></div>`;
  if (!e) return head + `<div class="card"><p class="empty">Locating…</p></div>`;
  return head + `
  <div class="card stripcard" id="propstrip">${propStripInner()}</div>
  <div class="card tools-card">
    <div class="tools">${indPicker("map")}${periodControl()}${layersMenuHtml()}</div>
    ${indQuick()}
  </div>
  ${studyRow(e, ind, "prop")}
  ${secHtml("listings", "Rental listings nearby", `within ${radTxt(PROP.rad)} · live, third-party`,
    `<div id="lstsec">${lstSectionBody()}</div>`, { render: false })}
  ${secHtml("services", "Services within the radius", `${radTxt(PROP.rad)} · OpenStreetMap`, nearCard(SRV_SET, "services-near"))}
  ${secHtml("public", "Public buildings within the radius", `${radTxt(PROP.rad)} · OpenStreetMap`, publicNear())}
  ${secHtml("schools", "Schools with year 9", "nearest six · Skolverket", schoolsNear())}
  ${secHtml("infra", "Infrastructure nearby", "Trafikverket and the regions", infraNear())}
  ${secHtml("safety", "Safety", "Brå and Polismyndigheten", safetyNear())}
  ${secHtml("climate", "Climate", "screening only", propClimate())}
  ${secHtml("figures", `Area profile — every figure published for this spot`, `read at ${esc(e.typeLabel)} level where published`, areaCompareTable(e))}
  ${secHtml("sources", "Sources and as-of", "", `${vSources()}`)}`;
}
function propMapInit() {
  const el = document.getElementById("propmap");
  if (!el || typeof L === "undefined" || PROP.lat == null) return;
  lfGuardCanvas(); lfGuardMap();
  const e = propArea();
  const m = regMap(L.map(el, { center: [PROP.lat, PROP.lon], zoom: 14, dragging: true,
    scrollWheelZoom: true, zoomSnap: 0.5, attributionControl: false }));
  LF.pmap = m;
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, detectRetina: true,
    className: "basemap", attribution: '© OpenStreetMap contributors' }).addTo(m);
  m.createPane("schpane"); m.getPane("schpane").style.zIndex = 450;
  LF.schCanvas = L.canvas({ pane: "schpane", padding: 0.3 });
  m.createPane("srvpane"); m.getPane("srvpane").style.zIndex = 440;
  LF.srvCanvas = L.canvas({ pane: "srvpane", padding: 0.3 });
  m.createPane("pubpane"); m.getPane("pubpane").style.zIndex = 435;
  LF.pubCanvas = L.canvas({ pane: "pubpane", padding: 0.3 });
  /* the pin's own area, coloured by the active indicator, so the mini-map answers
     the same question the chart panel beside it does */
  const ind = curInd();
  const only = mapOnly();
  if (e && e.ctx && e.ctx.length) {
    /* the same kommun-only rule as the big map and the area page: one kommun figure is
       drawn once, on the kommun, and the sub-areas around the pin are outlines */
    const kof = only ? null : (() => { const k = propKomOnly(e, ind); return k ? Object.assign(komFillPoly(k.kom, ind), k) : null; })();
    const vk = a => (only || kof ? null : V(a, ind.key) ?? (canInherit(ind.key) && a.kommun ? V(byCode[a.kommun], ind.key) : null));
    const sc = only ? MO_SCALE : kof ? kof.sc : scaleOf(e.ctx.filter(a => vk(a) != null), vk, null, ind);
    if (kof) kof.poly.addTo(m);
    e.ctx.forEach(a => {
      const own = e.own.includes(a); const t = sc.t(vk(a));
      const w = only ? (own ? 2.4 : moWeight("regso")) : kof ? (own ? 2.2 : koWeight("regso")) : null;
      const p = only
        ? L.polygon(a.rings, Object.assign(moStyle(w), own ? { color: MO_HOVER, opacity: 1 } : {}))
        : kof
        ? L.polygon(a.rings, Object.assign(koStyle(w), own ? { color: MO_HOVER, opacity: 1 } : {}))
        : L.polygon(a.rings, { color: own ? "#141C18" : "#FFFFFF", weight: own ? 2.4 : 0.8,
        fillColor: t == null ? "#C4CBC4" : (sc.color ? sc.color(t) : mkShade(t, ind.key, sc)),
        fillOpacity: own ? .5 : .42, smoothFactor: .25 });
      p.bindTooltip(`<b>${esc(a.name || a.code.split("_")[0])}</b>${vk(a) != null ? `<br>${esc(ind.short || ind.label)}: ${fmtOf(ind)(vk(a))}` : ""}`);
      if (!own) { p.on("click", () => go(withQ(pageOf(a))));
        if (only) { p.on("mouseover", () => p.setStyle(moHover(w))); p.on("mouseout", () => p.setStyle(moStyle(w))); }
        else if (kof) { p.on("mouseover", () => p.setStyle(koHover(w))); p.on("mouseout", () => p.setStyle(koStyle(w))); } }
      p.addTo(m);
    });
    if (!only) setLegend("proplegend", sc, ind, ind.key,
      kof ? `<b>${esc(KOMMUN_ONLY_LINE)}</b> · ${esc(kof.kom.name)} filled` : e.typeLabel);
  }
  L.circleMarker([PROP.lat, PROP.lon], { radius: 8, color: "#1C6B5C", weight: 3,
    fillColor: "#fff", fillOpacity: .95 }).addTo(m)
    .bindPopup(`<b>${esc(propName() || "Test property")}</b><br>${PROP.lat.toFixed(5)}, ${PROP.lon.toFixed(5)}`);
  for (const rad of RC.RADII) {
    L.circle([PROP.lat, PROP.lon], { radius: rad, color: "#1C6B5C",
      weight: rad === PROP.rad ? 1.8 : 1, opacity: rad === PROP.rad ? .85 : .3,
      dashArray: rad === PROP.rad ? null : "4,4", fill: false, interactive: false }).addTo(m);
  }
  /* the sections that are open put their own points on this map */
  if (PROP.show.has("services")) srvDraw("srv", m);
  if (PROP.show.has("public")) srvDraw("pub", m);
  if (PROP.show.has("schools")) schBuild(m);
  if (PROP.show.has("listings") || LAY.has("listings")) lstBuild(m);
  lfOverlays(m);
  m.fitBounds(L.latLng(PROP.lat, PROP.lon).toBounds(PROP.rad * 2.4));
}

/* ---------- the study row ----------
   One indicator at a time, read two ways at once: the chart panel on the left
   says how it has moved and where this area sits among its peers, the mini-map
   on the right says where that is. They are the same component on the area page
   and on Test property, which is why neither page has a second implementation of
   "show me this number".

   The panel renders whichever of four shapes the indicator needs, and never
   mixes them: an observed series is a solid green line, a projection is dashed
   purple and says so, a climate share is a screening figure under a named
   scenario, and an indicator published once is a distribution strip rather than
   a line with two points on it. */
function panelHead(e, i) {
  const s = tileStats(e, i);
  if (!s) return `<div class="pnhead"><b>–</b><span class="dim">no figure published for this area</span></div>`;
  const med = median(e.peers.map(p => V(p, i.key)));
  const inh = !s.cur.own;
  return `<div class="pnhead">
    <b>${fmtOf(i)(s.cur.v)}${(() => { const u = tileUnit(i); return u ? `<i class="hlu${u.charAt(0) === "/" ? " t" : ""}">${esc(u)}</i>` : ""; })()}${moeSpan(i, s.cur.v, moeOf(i, inh ? e.kommun : e.o))}</b>
    ${inh ? `<span class="inh">${esc(e.kommun ? e.kommun.name : "municipality")} — municipality figure</span>` : ""}
    ${s.yoy != null ? `<span><i class="${cls(s.yoy, i.key)}">${signed(s.yoy, 1, deltaUnit(i))}</i> y/y</span>` : ""}
    ${s.rk ? `<span title="among the ${s.rk.n} ${esc(e.peerLabel)} with a figure${lowerBetter(i) ? ", lowest first" : s.rk.neutral ? ", highest first — this indicator has no better end" : ", highest first"}">#${s.rk.r} of ${s.rk.n}</span>` : ""}
    ${med != null && s.cur.v != null ? `<span>${vsMedianTxt(i, s.cur.v, med)} <em class="dim">vs ${esc(e.peerLabel)} median</em></span>` : ""}
  </div>`;
}
/* "vs median" is a difference, never a percentage OF a median: a share is
   compared in percentage points and everything else in its own unit. Dividing
   one median into another and calling it a percentage is how "3 % above the
   median rent" comes to mean two different things on two pages. */
function vsMedianTxt(i, v, med) {
  const d = v - med;
  if (isPct(i)) return signed(d, 1, "pp");
  return (d > 0 ? "+" : d < 0 ? "−" : "") + fmtAbs(i, d);
}
/* peers as ticks on one axis, this area as a labelled dot, the median marked —
   for an indicator the publisher has issued once, where a line would be two
   points and a slope that means nothing */
function distStrip(e, i) {
  const vals = e.peers.map(p => ({ p, v: V(p, i.key) })).filter(x => x.v != null);
  const mine = eVal(e, i.key).v;
  if (vals.length < 5 || mine == null) return "";
  const lo = Math.min(...vals.map(x => x.v)), hi = Math.max(...vals.map(x => x.v));
  const sp = (hi - lo) || 1;
  const W = 900, H = 96, L0 = 10, R = 10, TOP = 30;
  const x = v => L0 + (v - lo) / sp * (W - L0 - R);
  const med = median(vals.map(x2 => x2.v));
  return `<svg class="chart diststrip" data-testid="dist-strip" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line class="grid" x1="${L0}" x2="${W - R}" y1="${TOP + 22}" y2="${TOP + 22}"/>
    ${vals.map(t => `<line x1="${x(t.v).toFixed(1)}" x2="${x(t.v).toFixed(1)}" y1="${TOP + 10}" y2="${TOP + 34}" stroke="#9A9D92" stroke-width="1" opacity=".5"/>`).join("")}
    <line x1="${x(med).toFixed(1)}" x2="${x(med).toFixed(1)}" y1="${TOP + 4}" y2="${TOP + 40}" stroke="#5C5F52" stroke-width="2" stroke-dasharray="5 4"/>
    <circle cx="${x(mine).toFixed(1)}" cy="${TOP + 22}" r="6" fill="#1C6B5C"/>
    <text class="ax" x="${L0}" y="${H - 6}">${esc(fmtOf(i)(lo))}</text>
    <text class="ax" x="${W - R}" y="${H - 6}" text-anchor="end">${esc(fmtOf(i)(hi))}</text>
    <text class="ax" x="${Math.min(W - R - 60, Math.max(L0, x(mine))).toFixed(1)}" y="${TOP - 6}" text-anchor="middle">${esc(e.name)}</text>
    <text class="ax" x="${Math.min(W - R, Math.max(L0, x(med))).toFixed(1)}" y="${H - 6}" text-anchor="middle">median</text>
  </svg>`;
}
/* the projected path, dashed and purple from end to end, because every point on
   it is projected — the one observed number is marked separately and labelled */
function outlookChart(e, i) {
  const o = e.type === "kommun" ? e.o : e.kommun;
  const f = fcSeries(o, "fc_abs");
  if (!f) return "";
  const ys = Object.keys(f).sort();
  if (ys.length < 2) return "";
  const vals = ys.map(y => f[y]);
  const obs = o.pop;
  const all = vals.concat(obs != null ? [obs] : []);
  const lo = Math.min(...all), hi = Math.max(...all), sp = (hi - lo) || 1;
  const W = 900, H = 220, L0 = 88, R = 16, T0 = 14, B = 28;
  const x = k => L0 + k / (ys.length - 1) * (W - L0 - R), y = v => T0 + (1 - (v - lo) / sp) * (H - T0 - B);
  const d = vals.map((v, k) => `${k ? "L" : "M"}${x(k).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const ticks = [lo, lo + sp / 2, hi];
  const every = Math.max(1, Math.round(ys.length / 8));
  return `<svg class="chart" data-testid="outlook-chart" viewBox="0 0 ${W} ${H}">
    ${ticks.map(t => `<line class="grid" x1="${L0}" x2="${W - R}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="ax" x="${L0 - 6}" y="${(y(t) + 3).toFixed(1)}" text-anchor="end">${nf(t, 0)}</text>`).join("")}
    ${ys.map((yy, k) => k % every ? "" : `<text class="ax" x="${x(k).toFixed(1)}" y="${H - 8}" text-anchor="middle">${yy}</text>`).join("")}
    <path d="${d}" fill="none" stroke="#5B4A9C" stroke-width="2.4" stroke-dasharray="6 4"/>
    ${vals.map((v, k) => `<circle cx="${x(k).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.4" fill="#5B4A9C"><title>${ys[k]}: ${nf(v, 0)} (projected)</title></circle>`).join("")}
    ${obs != null ? `<circle cx="${x(0).toFixed(1)}" cy="${y(obs).toFixed(1)}" r="5" fill="#1C6B5C"><title>observed population ${nf(obs, 0)}</title></circle>` : ""}
  </svg>
  <div class="bleg"><span><i style="background:#1C6B5C"></i>Observed population <b>${obs != null ? nf(obs, 0) : "–"}</b></span>
    <span><i style="background:#5B4A9C;height:2px"></i>Projected path ${esc(ys[0])}–${esc(ys[ys.length - 1])} <b>${nf(vals[vals.length - 1], 0)}</b></span></div>`;
}
function panelBody(e, i) {
  if (isOutlook(i)) {
    const c = outlookChart(e, i);
    return c || `<p class="empty" data-testid="state-nohistory">A projection, not a series — one published figure for ${esc((outlookOf(i) || {}).target || "the target year")}.</p>`;
  }
  if (isClimKey(i.key)) {
    const strip = distStrip(e, i);
    return (strip || `<p class="empty" data-testid="state-nohistory">Not mapped for this area — which is not the same as zero.</p>`) +
      `<p class="cap">A screening share under a named scenario: the share of the area's land inside a published hazard polygon. It says nothing about any one building, its floor level or its protection.</p>`;
  }
  const ys = eYears(e, i.key);
  if (ys.length >= 2) return areaChart(e, i);
  const strip = distStrip(e, i);
  return `<p class="empty" data-testid="state-nohistory">Published once — no history to plot${asofText(i) ? " · " + asofText(i) : ""}.</p>` + strip;
}
function chartPanel(e, i) {
  const lvl = i.level === "deso" ? "DeSO" : i.level === "regso" ? "RegSO" : i.level === "none" ? "national" : "kommun";
  return `<div class="card chartpanel" data-testid="chart-panel">
    <div class="card-head"><h3>${esc(i.label)}</h3><span class="hint">${esc(i.unit || "")} · published at ${esc(lvl)} level</span></div>
    ${panelHead(e, i)}
    <div class="pnbody">${panelBody(e, i)}</div>
    <p class="cap pnfoot">${esc(i.desc || "")} <span class="dim">${esc(i.source || "")}${asofText(i) ? " · as of " + asofText(i) : ""}</span>
      ${indSrcLink(i, e.type, e.code, MK.year === LATEST ? LATEST : MK.year)}${i.warn ? `<br>⚠ ${esc(i.warn)}` : ""}</p>
  </div>`;
}
/* In Map only there is no series to chart, so the panel is not rendered at all and
   the mini-map takes the row: a chart panel about no indicator would be a card full
   of dashes. The note says what the reader is looking at and how to leave it. */
function studyRow(e, i, key) {
  const only = mapOnly();
  const ko = only ? null : (key === "area" ? arKomOnly(e, i) : propKomOnly(e, i));
  return `<div class="studyrow${only ? " maponly" : ""}" data-testid="study-row">
    ${only ? "" : chartPanel(e, i)}
    <div class="card mapwrap minicard${only ? " maponly" : ""}" data-mini="${esc(key)}" data-testid="minimap">
      <div id="${key === "area" ? "armap" : "propmap"}"></div>
      <button class="mfull" data-minifull="${esc(key)}" data-testid="minimap-full" title="Full screen (Esc closes)">⤢</button>
      <div class="maplegend small" id="${key === "area" ? "arlegend" : "proplegend"}"></div>
      ${only ? `<div class="monote" data-testid="maponly-note">${esc(MAP_ONLY_LINE)}</div>`
        : ko ? `<div class="monote ko" data-testid="kommun-only-note"
            title="${esc(`${i.label} is published per kommun and no finer. ${ko.kom.name} is filled with its own figure; its ${ko.lvl === "deso" ? "DeSO" : "RegSO"} areas are drawn as outlines.`)}"
            >${esc(KOMMUN_ONLY_LINE)}</div>` : ""}
    </div>
  </div>`;
}

function vArea() {
  const e = areaEntity();
  if (!e) return `<div class="back"><button data-go="map">‹ Map</button></div><div class="card"><p class="empty">Unknown area.</p></div>`;
  /* A RegSO page is entirely made of figures that arrive with regso/values.json,
     and every rank and median on it is read off the other 3 362. Until the file
     is here the page says so — rendering it early would print a dash in every
     cell, and a dash in this dashboard means the source suppressed the value. */
  if (e.type === "regso" && !RG.vals) {
    return `<div class="back"><button data-go="${esc(withQ("map/" + e.o.kommun))}">‹ Map</button></div>
      <div class="card accent arhead"><div class="arid"><h2>${esc(e.name)}</h2>
      <div class="artags"><span class="tag">RegSO</span><span class="tag">code ${esc(e.code)}</span>${e.kommun ? `<span class="tag">${esc(e.kommun.name)}</span>` : ""}</div></div>
      ${regsoWait()}</div>`;
  }
  const ind = curInd();
  setTimeout(arMapInit, 0);
  const mapHash = e.type === "kommun" ? `map/${e.code}` : e.type === "deso" ? `map/${e.o.kommun}/deso` : `map/${e.o.kommun}`;
  const subLabel = e.subs ? (e.subs.deso && e.subs.regso ? "Sub-areas — RegSO and DeSO"
    : e.subs.deso ? `DeSO (${e.subs.deso.length})` : `RegSO (${e.subs.regso.length})`) : "";
  const nSub = e.subs ? (e.subs[Object.keys(e.subs)[0]] || []).length : 0;
  const hasOutlook = !!fcSeries(e.type === "kommun" ? e.o : e.kommun, "fc_abs");
  return `
  <div class="card accent arhead">
    <div class="arid">
      <h2>${esc(e.name)}</h2>
      <div class="artags"><span class="tag">${esc(e.typeLabel)}</span><span class="tag">code ${esc(e.code)}</span>${e.o.pop != null ? `<span class="tag">${nf(e.o.pop, 0)} inhabitants</span>` : ""}${e.kommun ? `<span class="tag">${esc(e.kommun.name)}</span>` : ""}${e.type === "regso" && e.o.codes && e.o.codes.length > 1 ? `<span class="tag">merged codes ${esc(e.o.codes.join(", "))}</span>` : ""}</div>
    </div>
    <div class="tools">
      <button class="lk" data-go="${withQ(mapHash)}">Show on map</button>
      <button class="lk" data-go="${chartLink(linkInd(), e.type, e.code)}">↗ Chart</button>
      ${e.type !== "deso" && desoAvail(e.type === "kommun" ? e.code : e.o.kommun) ? `<button class="lk" data-go="${withQ("map/" + (e.type === "kommun" ? e.code : e.o.kommun) + "/deso")}">DeSO ›</button>` : ""}
    </div>
    ${headlineTiles(e)}
    ${usoLine(e.o)}
  </div>
  <div class="card tools-card">
    <div class="tools">${indPicker("map")}${periodControl()}</div>
    ${indQuick()}
  </div>
  ${studyRow(e, ind, "area")}
  ${hasOutlook ? secHtml("outlook", "Population outlook", `SCB trend projection, published ${esc(((outlookOf(indOf("fc_growth")) || {}).published) || "")}`,
      `${outlookChart(e, indOf("fc_abs") || ind)}${outlookLine(e.type === "kommun" ? e.o : e.kommun, e.type !== "kommun")}
       <p class="cap">SCB publishes its trend projection at kommun level only, so a RegSO or DeSO page shows its kommun's figure. Every point on the dashed line is projected; the single green point is the latest observed population, which comes from a different vintage and is shown rather than spliced onto the projection.</p>`) : ""}
  ${secHtml("figures", `All figures (${e.inds.filter(i => eVal(e, i.key).v != null).length})`, "the Level column says which are the kommun's", areaCompareTable(e))}
  ${e.o.dist ? secHtml("dist", "Population and housing structure", "SCB, below kommun level", distCard(e)) : ""}
  ${e.subs ? secHtml("sub", subLabel, `${nSub} areas`, areaSubTable(e)) : ""}
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
  lfGuardCanvas(); lfGuardMap();
  const map = regMap(L.map(el, { center: [62.5, 16.5], zoom: 5, dragging: true, scrollWheelZoom: true, zoomSnap: 0.5, zoomDelta: 1, wheelPxPerZoomLevel: 30, wheelDebounceTime: 20, attributionControl: false }));
  LF.amap = map;
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, maxNativeZoom: 19, detectRetina: true, className: "basemap" }).addTo(map);
  const ind = curInd(); const { useQ, sind, kommuneLevel } = arMapMode(e, ind);
  /* "the municipality among all others" is drawn as the 290 kommuner, whose
     outlines are in the page. v2.0 drew it as all 3 363 RegSO tinted with their
     kommun's value — the same 290 figures repeated over twelve times as many
     polygons — which v2.1 P4 can no longer do anyway: RegSO geometry is fetched
     per kommun, so the national set does not exist in memory. */
  const ctx = e.type === "kommun" ? (useQ ? desoAreas(e.code) : kommuneLevel ? MUNI : e.ctx) : e.ctx;
  const vk = a => { if (!sind) return null; if (kommuneLevel) return V(a, sind.key); return V(a, sind.key) ?? (useQ ? null : V(byCode[a.kommun], sind.key)); };
  /* Built from vk, the same accessor the fill uses. Building it from the areas'
     OWN values instead left a RegSO page showing a kommun-level indicator with a
     legend that said "no data" over polygons that were all drawn in one colour. */
  /* a kommun-only indicator with sub-areas on screen: the kommun is filled with its own
     figure and they are outlines over it, exactly as on the big map */
  const only = mapOnly();
  const kof = only ? null : (() => { const k = arKomOnly(e, ind); return k ? Object.assign(komFillPoly(k.kom, sind), k) : null; })();
  const sc = kof ? kof.sc
    : kommuneLevel ? scaleOf(MUNI, m => V(m, sind.key), null, sind)
    : scaleOf(ctx.filter(a => vk(a) != null), vk, null, sind);
  if (kof) kof.poly.addTo(map);
  /* at kommun level the page's own shape is the kommun itself, one polygon among
     the 290; otherwise it is every sub-area of it */
  const own = kommuneLevel ? [e.o] : e.type === "kommun" ? e.ctx : e.own;
  const outline = e.type !== "kommun";
  /* Map only on a mini-map: the same outlines, and the area the page is about keeps
     its heavier stroke so the reader can still see which one it is. `sind` is null
     for Map only, so the legend below is skipped on its own. */
  ctx.forEach(a => {
    const isOwn = own.includes(a); const t = sc.t(vk(a));
    /* "own" on a kommun page is every sub-area of the kommun, so the heavier
       stroke is only for the page of ONE area — giving 127 RegSO a 2.6 px outline
       turns the city into a black mesh. */
    const heavy = isOwn && e.type !== "kommun";
    const w = only ? (heavy ? 2.4 : moWeight(useQ ? "deso" : "regso"))
      : kof ? (heavy ? 2.2 : koWeight(useQ ? "deso" : "regso")) : null;
    const p = only
      ? L.polygon(a.rings, Object.assign(moStyle(w), heavy ? { color: MO_HOVER, opacity: 1 } : {}))
      : kof
      ? L.polygon(a.rings, Object.assign(koStyle(w), heavy ? { color: MO_HOVER, opacity: 1 } : {}))
      : L.polygon(a.rings, { color: isOwn && (outline || kommuneLevel) ? "#141C18" : "#FFFFFF", smoothFactor: 0.25, weight: isOwn && outline ? 2.6 : isOwn && kommuneLevel ? 1.2 : kommuneLevel ? 1.5 : useQ ? 0.4 : 0.8,
      fillColor: t == null ? "#C4CBC4" : (sc.color ? sc.color(t) : mkShade(t, ind.key, sc)), fillOpacity: isOwn ? .85 : kommuneLevel ? .35 : .45 });
    const v = vk(a); const native = kommuneLevel || (sind && V(a, sind.key) != null);
    /* no value in the tooltip where the value would be the kommun's, repeated per area */
    p.bindTooltip(`<b>${esc(a.name)}</b>${!only && !kof && v != null ? `<br>${esc(sind.short || sind.label)}: ${fmtOf(sind)(v)}${native ? "" : " °"}` : ""}`);
    if (!isOwn) { p.on("click", () => go(withQ(pageOf(a))));
      p.on("mouseover", () => p.setStyle(only ? moHover(w) : kof ? koHover(w) : { weight: 2.2, color: "#141C18" }));
      p.on("mouseout", () => p.setStyle(only ? moStyle(w) : kof ? koStyle(w) : { weight: kommuneLevel ? 0.6 : 1, color: "#FFFFFF" })); }
    else if (e.type === "kommun" && !kommuneLevel) { p.on("click", () => go(withQ(pageOf(a)))); }
    p.addTo(map);
  });
  if (sind && !only) setLegend("arlegend", sc, sind, ind.key,
    kof ? `<b>${esc(KOMMUN_ONLY_LINE)}</b> · ${esc(kof.kom.name)} filled`
      : kommuneLevel ? "kommuner" : useQ ? "DeSO" : "RegSO");
  const b = boundsOf(own); if (b) map.fitBounds(b, { padding: kommuneLevel ? [90, 90] : e.type === "kommun" ? [10, 10] : [70, 70], maxZoom: kommuneLevel ? 9 : 13 });
}

/* ---------- Leaflet layers (macro map) ---------- */
function lfPopup(a, muni) {
  /* two levels: the selected indicator big + four headline figures and the ways onward; every value behind "all values" */
  const row = (i, v, own, o) => `<span class="lfrow"><span>${esc(i.short || i.label)}</span><b>${fmtOf(i)(v)}${own ? "" : ` <span class="tag-muni">muni</span>`}${moeSpan(i, v, moeOf(i, o))}</b></span>`;
  const LI = curInds(); const ind = curInd(); const isQ = a.regso != null;
  /* Map only has no selected indicator, so the popup leads with the headline row
     instead of a big figure — the figures are still all here, which is the point:
     turning the fill off does not turn the data off. */
  const only = mapOnly();
  const val = i => { const v = V(a, i.key); if (v != null) return { v, own: true }; if (!noInherit(i) && muni && V(muni, i.key) != null) return { v: V(muni, i.key), own: false }; return null; };
  const peers = isQ ? desoAreas(a.kommun) : AREAS; const sel = only ? null : val(ind);
  const rk = sel ? (sel.own ? rankOf(a, ind.key, peers) : (muni ? rankOf(muni, ind.key, MUNI) : null)) : null;
  const keys = HL_KEYS.filter(k => only || k !== ind.key).map(k => LI.find(i => i.key === k)).filter(Boolean).map(i => ({ i, x: val(i) })).filter(x => x.x).slice(0, only ? 5 : 4);
  const native = LI.filter(i => V(a, i.key) != null).map(i => row(i, V(a, i.key), true, a)).join("");
  const inherited = LI.filter(i => !noInherit(i) && V(a, i.key) == null && muni && V(muni, i.key) != null).map(i => row(i, V(muni, i.key), false, muni)).join("");
  const n = LI.filter(i => val(i)).length; const type = isQ ? "deso" : "regso", code = a.code;
  return `<div class="lfpop"><b>${esc(a.name)}</b>${MK.year !== LATEST ? ` <span class="tag">${MK.year}</span>` : ""}
    <span class="dim">${a.regso && byRegso[a.regso] ? esc(byRegso[a.regso].name) + " · " : ""}${muni ? esc(muni.name) : ""}${a.pop != null ? " · " + nf(a.pop, 0) + " inhabitants" : ""}</span>
    ${only ? "" : sel ? `<div class="lfbig"><span>${esc(ind.label)}${sel.own ? "" : ` <span class="tag-muni">muni</span>`}</span><b>${fmtOf(ind)(sel.v)}${moeSpan(ind, sel.v, moeOf(ind, sel.own ? a : muni))}</b><em title="among the ${rk ? rk.n : 0} with a figure">${rk ? `#${rk.r} of ${rk.n} ${sel.own ? (isQ ? "DeSO" : "RegSO") : "kommuner"}` : ""}</em></div>` : `<div class="lfbig dim"><span>${esc(ind.label)}</span><b>–</b></div>`}
    ${keys.length ? `<div class="lfkey">${keys.map(({ i, x }) => `<div><span>${esc(i.short || i.label)}${x.own ? "" : ` <span class="tag-muni">muni</span>`}</span><b>${fmtOf(i)(x.v)}${moeSpan(i, x.v, moeOf(i, x.own ? a : muni))}</b></div>`).join("")}</div>` : ""}
    ${usoLine(a)}${outlookLine(muni, true)}
    <span class="lfact"><button class="lk mini primary" data-go="${withQ(pageOf(a))}">Open page ›</button>${muni && !MK.kommun ? `<button class="lk mini" data-go="map/${muni.code}?ind=${MK.ind}">Zoom to ${esc(muni.name)}</button>` : ""}${muni && desoAvail(muni.code) && !desoMode() ? `<button class="lk mini" data-go="map/${muni.code}/deso?ind=${MK.ind}">DeSO ›</button>` : ""}<button class="lk mini" data-go="${chartLink(linkInd(), type, code)}">↗ Chart</button></span>
    <details class="lfmore"><summary>All ${n} values</summary>
    ${native ? `<span class="lfsec">${isQ ? "DeSO" : "RegSO"}</span><div class="lfrows">${native}</div>` : ""}
    ${inherited ? `<span class="lfsec">The kommun's figure</span><div class="lfrows">${inherited}</div>` : ""}</details></div>`;
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
      /* the rings arrive encoded (src/geo_core.js); decoded once, here */
      DESO[code].forEach(a => { GC.decodeEntity(a); byDeso[a.code] = a; });
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
  /* `sg` is what makes a .seg child a segment — without it the browser drew two
     native grey buttons in the middle of the map toolbar */
  return `<div class="seg" role="group" aria-label="Sub-level" data-testid="sub-level">
    <button class="sg ${MK.sub === "regso" ? "on" : ""}" data-sub="regso">RegSO</button>
    <button class="sg ${MK.sub === "deso" ? "on" : ""}" data-sub="deso"${busy ? " disabled" : ""}>DeSO${busy ? " …" : ` (${n})`}</button>
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
  const only = mapOnly();
  const drill = !!MK.kommun;
  const sub = drill && desoMode() ? "deso" : drill ? "regso" : null;
  const shapes = !drill ? MUNI : muniAreas(MK.kommun);
  const hasOwn = !sub || (ind.levels || []).includes(sub);
  /* a kommun-level figure with sub-areas on screen: the kommun is filled, they are not */
  const komOnly = kommunOnlyMap();
  /* Map only and kommun-only are part of the level key: switching the fill off, or
     over to the kommun, has to rebuild the polygons, not just relabel them. */
  LF.level = mapLevelKey();
  if (LF.areaG) LF.map.removeLayer(LF.areaG);
  if (LF.labG) LF.map.removeLayer(LF.labG);
  const vk = o => V(o, ind.key);
  const scalePool = !drill ? MUNI : shapes.filter(a => hasOwn && vk(a) != null);
  /* kommun-only reads its colour off the 290 kommuner, which is the comparison the
     one figure on screen actually belongs to */
  const sc = only ? MO_SCALE : scaleOf(scalePool.length ? scalePool : MUNI, vk, null, ind);
  const polys = [];
  const kom = drill ? byCode[MK.kommun] : null;
  /* The sub-areas' files are not here yet. The kommun outline IS — it ships in
     the page — so the map shows the kommun and the note above it says what is
     still coming, rather than going blank and rather than colouring one figure
     across a shape the reader did not ask about. */
  if (drill && !shapes.length && kom && (kom.rings || []).length) {
    const p = L.polygon(kom.rings, { color: MO_LINE, weight: 1.4, opacity: .9,
      fill: true, fillColor: KO_LINE, fillOpacity: .12, smoothFactor: 0.25, className: "rg-wait" });
    p.bindPopup(() => lfKommunPopup(kom), { maxWidth: 560, maxHeight: 560, autoPanPadding: [24, 24] });
    LF.areaG = L.layerGroup([p]).addTo(LF.map);
    LF.ctx = { shapes: [], sc, sub, drill, hasOwn, ind, vk, only, komOnly, kom };
    /* no classes are on screen, so there is no key to draw; the note under the
       map is what says why */
    const el = document.getElementById("maplegend"); if (el) el.innerHTML = "";
    ovLegends();
    if (LF.ownG) { LF.map.removeLayer(LF.ownG); LF.ownG = null; }
    return;
  }
  if (komOnly && kom && (kom.rings || []).length) {
    const kt = sc.t(vk(kom));
    /* first into the group, so the outlines above take the clicks; `interactive:false`
       because this polygon covers exactly the same ground as all of them together */
    polys.push(L.polygon(kom.rings, { className: "ko-fill", color: "#FFFFFF", weight: 1.6,
      fillColor: kt == null ? "#C4CBC4" : (sc.color ? sc.color(kt) : mkShade(kt, ind.key, sc)),
      fillOpacity: .72, smoothFactor: 0.25, interactive: false }));
  }
  shapes.forEach(a => {
    const m = drill ? byCode[a.kommun] : a;
    /* falling back to the kommun's value tints every sub-area with it; an
       indicator that refuses inheritance (the police designation) must stay
       blank instead, or the whole city reads as designated */
    const src = !drill ? a : (hasOwn && vk(a) != null ? a : (noInherit(ind) ? null : m));
    const t = src ? sc.t(vk(src)) : null;
    /* thinner the finer the level: a 1.5 px stroke that reads as a border between
       kommuner turns into a white haze over a kommun's worth of DeSO. */
    const w = only ? moWeight(sub) : komOnly ? koWeight(sub) : (!drill ? 1.5 : sub === "deso" ? 0.4 : 0.8);
    const fill = t == null ? "#C4CBC4" : (sc.color ? sc.color(t) : mkShade(t, ind.key, sc));
    /* smoothFactor is Leaflet dropping vertices within N screen pixels. At the
       default 1 it undoes the simplification budget the geometry was built to,
       and the angularity shows at close zoom. */
    const p = only ? L.polygon(a.rings, moStyle(w))
      : komOnly ? L.polygon(a.rings, koStyle(w))
      : L.polygon(a.rings, { color: "#FFFFFF", weight: w, fillColor: fill, fillOpacity: .72, smoothFactor: 0.25 });
    p.bindPopup(() => drill ? lfPopup(a, m) : lfKommunPopup(a), { maxWidth: 560, maxHeight: 560, autoPanPadding: [24, 24] });
    p.on("mouseover", () => p.setStyle(only ? moHover(w) : komOnly ? koHover(w) : { weight: Math.max(2.2, w * 2), color: "#141C18" }));
    p.on("mouseout", () => p.setStyle(only ? moStyle(w) : komOnly ? koStyle(w) : { weight: w, color: "#FFFFFF" }));
    polys.push(p);
  });
  LF.areaG = L.layerGroup(polys).addTo(LF.map);
  LF.ctx = { shapes, sc, sub, drill, hasOwn, ind, vk, only, komOnly, kom };
  lfLabels();
  /* No indicator, no key. The box is emptied rather than left standing, and
     `.maplegend:empty` in style.css is what keeps it from showing as a white bar. */
  if (only) { const el = document.getElementById("maplegend"); if (el) el.innerHTML = ""; ovLegends(); }
  else setLegend("maplegend", sc, ind, ind.key,
    !drill ? "kommuner · open one for its RegSO"
      : komOnly ? `<b>${esc(KOMMUN_ONLY_LINE)}</b> · ${esc(kom ? kom.name : "the kommun")} is filled, its ${sub === "deso" ? "DeSO" : "RegSO"} are outlines`
      : !hasOwn ? `not published per ${sub === "deso" ? "DeSO" : "RegSO"}`
      : sub === "deso" ? "DeSO" : "RegSO");
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
  const only = mapOnly();
  const row = (i, v, o) => `<span class="lfrow"><span>${esc(i.short || i.label)}</span><b>${fmtOf(i)(v)}${moeSpan(i, v, moeOf(i, o))}</b></span>`;
  const sel = only ? null : V(m, ind.key);
  const rk = sel != null ? rankOf(m, ind.key, MUNI) : null;
  const keys = HL_KEYS.filter(k => only || k !== ind.key).map(k => LI.find(i => i.key === k))
    .filter(i => i && V(m, i.key) != null).slice(0, only ? 5 : 4);
  const all = LI.filter(i => V(m, i.key) != null);
  const n = (DESO_IDX[m.code] || {}).n || 0;
  return `<div class="lfpop"><b>${esc(m.name)}</b>${MK.year !== LATEST ? ` <span class="tag">${MK.year}</span>` : ""}
    <span class="dim">${esc(lanName(m.lan))}${m.pop != null ? " · " + nf(m.pop, 0) + " inhabitants" : ""} · ${(RG_IDX[m.code] || {}).n || regsoAll(m.code).length} RegSO${n ? ` · ${n} DeSO` : ""}</span>
    ${only ? "" : sel != null ? `<div class="lfbig"><span>${esc(ind.label)}</span><b>${fmtOf(ind)(sel)}${moeSpan(ind, sel, moeOf(ind, m))}</b><em title="among the ${rk ? rk.n : 0} kommuner with a figure">${rk ? `#${rk.r} of ${rk.n} kommuner` : ""}</em></div>`
                  : `<div class="lfbig dim"><span>${esc(ind.label)}</span><b>–</b></div>`}
    ${keys.length ? `<div class="lfkey">${keys.map(i => `<div><span>${esc(i.short || i.label)}</span><b>${fmtOf(i)(V(m, i.key))}${moeSpan(i, V(m, i.key), moeOf(i, m))}</b></div>`).join("")}</div>` : ""}
    ${usoLine(m)}${outlookLine(m, false)}
    <span class="lfact"><button class="lk mini primary" data-go="${withQ(`area/kommun/${m.code}`)}">Open page ›</button><button class="lk mini" data-go="${withQ(`map/${m.code}`)}">RegSO ›</button>${n ? `<button class="lk mini" data-go="${withQ(`map/${m.code}/deso`)}">DeSO ›</button>` : ""}<button class="lk mini" data-go="${chartLink(linkInd(), "kommun", m.code)}">↗ Chart</button></span>
    <details class="lfmore"><summary>All ${all.length} values</summary>
    <div class="lfrows">${all.map(i => row(i, V(m, i.key), m)).join("")}</div></details></div>`;
}

function lfLabels() {
  /* labels are rebuilt on every zoom step: a name is shown only when its polygon is wide enough on screen */
  if (!LF.map || !LF.ctx) return;
  const { shapes, sc, sub, drill, hasOwn, ind, vk, only, komOnly, kom } = LF.ctx; const zoom = LF.map.getZoom(); const labs = [];
  if (LF.labG) LF.map.removeLayer(LF.labG);
  const px = ring => { const xs = [], ys = []; ring.forEach(q => { const c = LF.map.latLngToContainerPoint(q); xs.push(c.x); ys.push(c.y); }); return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]; };
  if (drill) {
    /* sub-areas: a value only where the polygon is clearly wide enough, the name only when there is room for both */
    shapes.slice().sort((x, y) => (y.pop || 0) - (x.pop || 0)).slice(0, 40).forEach(a => {
      const [w, h] = px(mainRing(a)); if (w < 64 || h < 26) return;
      /* Map only: the name and nothing else. There is no value to print, and
         printing the dash a missing value renders as would be a figure that is not
         missing — it is not asked for. */
      /* kommun-only: the same, and for the same reason. Repeating one kommun figure
         on forty sub-area labels is the misreading the mode exists to prevent; the
         kommun's own value is printed once, on the kommun, below. */
      if (only || komOnly) { labs.push(L.marker(centroid(mainRing(a)), { interactive: false,
        icon: L.divIcon({ className: "lflab", iconSize: null, html: `<b>${esc(a.name)}</b>` }) })); return; }
      const m = byCode[a.kommun]; const own = hasOwn && vk(a) != null;
      const v = own ? vk(a) : (noInherit(ind) ? null : (m ? vk(m) : null));
      const t = sc.t(v), dark = !sc.cats && t != null && t > .55; const val = v != null ? fmtOf(ind)(v) + (own ? "" : " °") : "–";
      const name = w >= 120 && h >= 36 ? `<b>${esc(a.name)}</b><br>` : "";
      labs.push(L.marker(centroid(mainRing(a)), { interactive: false, icon: L.divIcon({ className: "lflab" + (dark ? " lflab-dark" : ""), iconSize: null, html: name + val }) }));
    });
    /* the one figure there is, on the one area it is about, last so it sits on top */
    if (komOnly && kom && mainRing(kom).length) {
      const kv = vk(kom), kt = sc.t(kv), kdark = !sc.cats && kt != null && kt > .55;
      labs.push(L.marker(centroid(mainRing(kom)), { interactive: false,
        icon: L.divIcon({ className: "lflab lflab-kom" + (kdark ? " lflab-dark" : ""), iconSize: null,
          html: `<b>${esc(kom.name)}</b><br>${kv != null ? fmtOf(ind)(kv) : "–"}` }) }));
    }
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
      labs.push(L.marker(ll, { interactive: false, icon: L.divIcon({ className: "lflab" + (dark ? " lflab-dark" : ""), iconSize: null, html: `<b>${esc(m.name)}</b>${!only && zoom >= 6 ? `<br>${vk(m) != null ? fmtOf(ind)(vk(m)) : "–"}` : ""}` }) }));
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
function usoBuild(map) {
  const m = map || LF.map;
  usoLoad();
  if (!m || !USO.data || LF.usoDrawn) return;
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
  g.addTo(m); LF.usoLayer = g; LF.usoDrawn = true;
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
    afterLazyLoad();
  }).catch(() => { SCH[code] = []; delete SCH["_l_" + code]; afterLazyLoad(); });
}
function schLoadVisible(map) {
  const m = map || LF.map;
  if (!m || m.getZoom() < SCH_ZOOM) return;
  const b = m.getBounds(), c = b.getCenter();
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
const schInView = (map) => {
  const m = map || LF.map;
  if (!m) return [];
  const b = m.getBounds(), out = [];
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
function schBuild(map) {
  const m = map || LF.map;
  schLoadVisible(m);
  if (!m) return;
  lfDrop("schLayer");
  if (m.getZoom() < SCH_ZOOM) { LF.schDrawn = false; return; }
  const br = schScale();
  const g = L.layerGroup();
  for (const s of schInView(m)) {
    const col = schColor(s.merit, br);
    const m = L.circleMarker([s.lat, s.lon], {
      radius: 5, weight: 1.4,
      color: col || SCH_BASE, fillColor: col || "#FFFFFF",
      fillOpacity: col ? .92 : .15, renderer: LF.schCanvas || undefined,
    });
    m.bindPopup(() => schPopup(s), { maxWidth: 320, className: "lfpopw" });
    m.addTo(g);
  }
  g.addTo(m); LF.schLayer = g; LF.schDrawn = true;
}
const schAreaRow = (lab, v, f) => v == null ? "" :
  `<span class="lfrow"><span>${esc(lab)}</span><b>${f(v)}</b></span>`;
function schPopup(s) {
  const km = byCode[s.kommun];
  const iM = indOf("school_merit");
  const f1 = v => nf(v, 1);
  const cmp = (v, areaV, lab) => (v == null || areaV == null) ? "" :
    `<span class="lfrow"><span>vs ${esc(lab)}</span><b class="${cls(v - areaV, "school_merit")}">${signed(v - areaV, 1)}</b></span>`;
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
  nav: "makro",
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
      tools: `<button class="lk" data-go="map/${esc(s.kommun)}?ind=school_merit&lay=schools">Show on map</button>` +
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
    afterLazyLoad();
  }).catch(() => { SRV[code] = []; delete SRV["_l_" + code]; afterLazyLoad(); });
}
function srvLoadVisible(map) {
  const m = map || LF.map;
  if (!m || m.getZoom() < SRV_ZOOM) return;
  const b = m.getBounds(), c = b.getCenter(), want = [];
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
function srvDraw(which, map) {
  const m = map || LF.map;
  const on = which === "srv" ? SF.srv : SF.pub;
  const name = which + "Layer";
  lfDrop(name);
  if (!m) return;
  const z = m.getZoom();
  if (z < SRV_ZOOM) { LF[which + "Drawn"] = false; srvLoadVisible(m); return; }
  srvLoadVisible(m);
  const b = m.getBounds();
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
  g.addTo(m); LF[name] = g; LF[which + "Drawn"] = true;
  LF[which + "Count"] = n;
}
function srvLegendFor(which) {
  const cats = which === "srv" ? SRV_SET : PUB_SET;
  const on = which === "srv" ? SF.srv : SF.pub;
  const z = LF.map ? LF.map.getZoom() : 0;
  if (z < SRV_ZOOM) {
    return `<div class="lgtitle">${which === "srv" ? "Services" : "Public buildings"}<span>zoom in to level ${SRV_ZOOM}</span></div>`;
  }
  /* Keys only. The category ticks live in Layers ▾ now, which is what keeps this
     card small enough to stack beside the others without ever covering one. */
  return `<div class="lgtitle">${which === "srv" ? "Services" : "Public buildings"}<span>${nf(LF[which + "Count"] || 0, 0)} in view</span></div>` +
    cats.filter(c => on.has(c)).map(c => { const d = SRV_CATS[c];
      return `<div class="lgrow"><i style="background:${d[1]}"></i>${esc(d[0])}${z < d[2] ? `<em class="dim"> z${d[2]}+</em>` : ""}</div>`; }).join("") +
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
    afterLazyLoad();
  }).catch(() => { INFRA_GEO.loading = false; INFRA_GEO.data = { features: [] }; afterLazyLoad(); });
}
function infraBuild(map) {
  const m = map || LF.map;
  infraLoad();
  if (!m || !INFRA_GEO.data) return;
  lfDrop("infLayer");
  const g = L.layerGroup();
  for (const f of INFRA_GEO.data.features || []) {
    if (!f.geometry) continue;                 /* not located — never drawn */
    const p = f.properties;
    const col = INFRA_TONE[p.status] || "#8A8C81";
    const popup = `<div class="lfpop"><b>${esc(p.name)}</b>
      <span class="dim">${esc(p.agency || "")}${p.open_year ? " · opens " + p.open_year : p.open_window ? " · " + esc(p.open_window) : ""}</span>
      <span class="lfact"><button class="lk mini primary" data-go="project/${esc(p.id)}">Project page ›</button></span></div>`;
    if (f.geometry.type === "MultiLineString") {
      /* An alignment OSM actually tags. Drawn as a line, dashed while it is
         only proposed or decided and solid once it is being built, so the map
         reads the same way the Pipeline list does. */
      const dash = p.status === "construction" ? null : "6,4";
      for (const seg of f.geometry.coordinates) {
        if (!seg || seg.length < 2) continue;
        L.polyline(seg.map(c => [c[1], c[0]]),
          { color: col, weight: 3.5, opacity: .9, dashArray: dash })
          .bindPopup(popup, { maxWidth: 300 }).addTo(g);
      }
      continue;
    }
    const pts = f.geometry.type === "Point" ? [f.geometry.coordinates]
                                            : f.geometry.coordinates;
    for (const [lon, lat] of pts) {
      L.circleMarker([lat, lon], { radius: 6, weight: 2.2, color: col,
        fillColor: "#fff", fillOpacity: .9 })
        .bindPopup(popup, { maxWidth: 300 })
        .addTo(g);
    }
  }
  g.addTo(m); LF.infLayer = g; LF.infDrawn = true;
}
function infraLegend() {
  const ps = INFRA.projects || [];
  const drawn = (INFRA_GEO.data ? (INFRA_GEO.data.features || []).filter(f => f.geometry).length : 0);
  const byStatus = {};
  ps.forEach(p => { byStatus[p.status] = (byStatus[p.status] || 0) + 1; });
  const asLine = INFRA_GEO.data
    ? (INFRA_GEO.data.features || []).filter(f => f.geometry && f.geometry.type === "MultiLineString").length : 0;
  return `<div class="lgtitle">Infrastructure<span>${ps.length} projects · ${drawn} drawn (${asLine} as an alignment)</span></div>` +
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
/* ---------- the Budget cell ----------
   A blank budget in data/external/infra_se.csv is deliberate and nothing is
   invented to fill it: the four nya tunnelbanan extensions are funded as one
   55,5 bn SEK programme and no per-line figure is published anywhere. A bare "–"
   read as a gap in this dashboard rather than as a fact about the source, so the
   cell says which of the two kinds of blank it is and carries the note.
   `budget_state` and `budget_note` are curated in
   data/external/infra_budget_state.csv — never inferred from the project's prose. */
const budgetProgramme = p => p.budget_state === "programme";
const budgetWord = p => (budgetProgramme(p) ? "programme only" : "not published");
const BUDGET_TIP = { programme: "Funded inside a larger programme — the source publishes no cost for this project on its own.",
                     not_published: "The source states no cost for this project." };
function budgetCell(p) {
  if (p.budget_msek != null) return `${nf(p.budget_msek, 0)} MSEK`;
  const tip = p.budget_note || BUDGET_TIP[p.budget_state] || BUDGET_TIP.not_published;
  return `<span class="nobudget" data-testid="no-budget" title="${esc(tip)}">${budgetWord(p)}</span>`;
}
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
</div>
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
        <td class="num">${budgetCell(p)}</td>
        <td>${esc(p.price_base || "–")}</td>
        <td>${esc(p.agency || "")}</td>
        <td>${esc(kNames(p.kommuner).join(", "))}</td></tr>`).join("")}</tbody></table></div>
    <p class="cap">A budget is shown only with the price base the source stated — a figure in
      unknown money is not a figure. <b>programme only</b> means the project is funded inside a
      larger programme and no figure exists for it on its own — the four Stockholm metro
      extensions share one 55,5 bn SEK (2016 price level) programme total — and <b>not published</b>
      means the source states no cost at all. Hover either for the note the source gave.
      Nothing is apportioned or estimated.
      Sources: Trafikverket, Region Stockholm, Västtrafik and the project bodies themselves —
      each row links to the page it came from.</p>
  </div>`;
}
SHEETS.project = {
  label: "Infrastructure project",
  nav: "table",
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
        (feat && feat.geometry ? `<button class="lk" data-go="map?ind=${esc(MK.ind)}&lay=infra">Show on map</button>` : "") +
        `<button class="lk" data-go="data/projects">Projects ›</button>`,
      tiles: `<div class="hl">
        ${tile("Status", esc(p.status))}
        ${tile("Opening", p.open_year || p.open_window || "–")}
        ${tile("Budget", budgetCell(p))}
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
          ${p.budget_msek != null ? `<p class="cap">Budget ${nf(p.budget_msek, 0)} MSEK at price base ${esc(p.price_base || "unknown")}. Figures from different price bases are not comparable and nothing here is converted.</p>` : `<p class="cap"><b>Budget: ${budgetWord(p)}.</b> ${esc(p.budget_note || BUDGET_TIP[p.budget_state] || BUDGET_TIP.not_published)} Nothing is apportioned or estimated here.</p>`}
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
const climAvail = () => CLIM_LAYERS.filter(l => CLIM_IDX[l[0]]);
function climLoad(layer, code) {
  const k = layer + "/" + code;
  if (CLIM_ZONES[k] || CLIM_ZONES["_l_" + k]) return;
  const idx = CLIM_IDX[layer];
  if (!idx || !idx.kommuner.includes(code)) { CLIM_ZONES[k] = []; return; }
  CLIM_ZONES["_l_" + k] = true;
  fetch("climate/" + layer + "/" + code + ".json").then(r => r.json()).then(j => {
    CLIM_ZONES[k] = j; delete CLIM_ZONES["_l_" + k];
    afterLazyLoad();
  }).catch(() => { CLIM_ZONES[k] = []; delete CLIM_ZONES["_l_" + k]; afterLazyLoad(); });
}
function climLoadVisible(map) {
  const m = map || LF.map;
  const layer = climLayerFor(MK.ind);
  if (!m || !layer || m.getZoom() < CLIM_ZOOM) return;
  const b = m.getBounds(), c = b.getCenter();
  const want = [];
  for (const code in DESO_IDX) {
    if (!byCode[code]) continue;
    /* the kommun's own outline, which is in the page — this used to union the
       kommun's RegSO rings, and those are fetched per kommun now, so a kommun
       nobody had opened would never have been reached */
    const bb = boundsOf([byCode[code]]);
    if (!bb || !b.intersects(bb)) continue;
    const k = layer + "/" + code;
    if (CLIM_ZONES[k] || CLIM_ZONES["_l_" + k]) continue;
    const cc = bb.getCenter();
    want.push([code, Math.hypot(cc.lat - c.lat, cc.lng - c.lng)]);
  }
  want.sort((x, y) => x[1] - y[1]);
  want.slice(0, CLIM_MAX_FILES).forEach(([code]) => climLoad(layer, code));
}
function climBuild(map) {
  const m = map || LF.map;
  if (!m) return;
  lfDrop("climLayer");
  const layer = climLayerFor(MK.ind);
  if (!layer) { LF.climDrawn = false; return; }
  if (m.getZoom() < CLIM_ZOOM) { LF.climDrawn = false; climLoadVisible(m); return; }
  climLoadVisible(m);
  const col = (CLIM_LAYERS.find(l => l[0] === layer) || [])[2] || "#3E7CA6";
  const g = L.layerGroup();
  for (const k in CLIM_ZONES) {
    if (k.startsWith("_l_") || !k.startsWith(layer + "/")) continue;
    const gj = CLIM_ZONES[k];
    if (!gj || !gj.type) continue;
    L.geoJSON(gj, { style: { color: col, weight: 1, opacity: .85,
                             fillColor: col, fillOpacity: .28, dashArray: "4,3" },
                    interactive: false }).addTo(g);
  }
  g.addTo(m); LF.climLayer = g; LF.climDrawn = true;
}
/* The zones legend names the scenario every time. A flood extent without
   "100-year" beside it is not a fact, it is a shape. */
function climLegend() {
  const layer = climLayerFor(MK.ind);
  const cur = CLIM_LAYERS.find(l => l[0] === layer);
  if (!cur) return `<div class="lgtitle">Hazard zones<span>no zone files for this indicator</span></div>`;
  const zoomed = LF.map && LF.map.getZoom() >= CLIM_ZOOM;
  return `<div class="lgtitle">Hazard zones<span>${esc(cur[1])}</span></div>` +
    `<div class="lgrow"><i style="background:${cur[2]};opacity:.5;border:1px dashed ${cur[2]}"></i>${esc(cur[1])}</div>` +
    `<div class="lgnote">${zoomed ? "Zones for the kommuner in view."
      : `Zoom in to level ${CLIM_ZOOM} to draw the zones.`} The same source as the figure on the map, drawn geometrically. Screening only, not a property-level assessment. Källa: MCF, SMHI, SGU.</div>`;
}

/* ---------- Rental listings ----------
   The only live, third-party layer on the page. Everything else here is an
   official figure computed offline into data/processed; these are advertisements,
   read through the gateway in gateway/ because the sources send no CORS headers.

   The rules the gateway's own documentation sets, kept on this side too:
     - an advertised rent is NOT a contract rent, and must never be drawn as one
       series with the SCB rent statistics this dashboard is built on
     - a count of adverts is NOT a vacancy rate
     - medians only at n >= 3, and labelled "advertised"
     - a queue listing is allocated by queue time and says so
     - every card links to the original advert
     - and the layer never carries an own-rent field of any kind: this dashboard
       has no business knowing what anybody pays

   Politeness to the gateway: one request per viewport, debounced 600 ms after the
   map stops moving, and a box already fetched this session is never fetched
   again. There is no polling loop anywhere.

   src/listings/view.js holds the decisions (which group a source is in, which
   listings survive the filters, the medians) and is DOM-free and unit-tested.
   This file is the rendering. */
const LV = window.LISTINGS_VIEW || {};
const GATEWAY = "https://am-se-listings.am-se-listings-gateway.workers.dev";
const LST_ZOOM = 13;
const LST_DEBOUNCE = 600;
/* The box is padded before it is fetched, so a small pan stays inside something
   already in hand rather than asking again. */
const LST_PAD = 0.25;
/* The gateway caps a radius at 3 km; the task caps the fallback at 2 km. Only
   used if /bbox is not deployed — it answers 404 and this switches over once. */
const LST_FALLBACK_MAX = 2000;
/* One automatic retry per box, and not for five seconds. Beyond that the reader
   presses Retry — a page that keeps asking a failing service is a load generator,
   not a dashboard. */
const LST_MAX_TRIES = 2;
const LST_RETRY_MS = 5000;

const LST = {
  boxes: [],            /* every box fetched this session */
  rows: [],             /* every listing seen this session, deduped by src:id */
  seen: new Set(),
  sources: [],          /* the source roll-call of the last answer */
  fetchedAt: null,
  covered: true,
  error: null,
  loading: false,
  timer: null,
  bboxOk: true,
  filters: JSON.parse(JSON.stringify(LV.DEFAULT_FILTERS || {})),
  pins: new Set(),      /* every (pin, radius) already asked for this session */
  /* ---- what failed, so nothing asks again on its own ----
     v2.0 deleted the pin key on an error and then refreshed the section, which
     called lstSectionBody → lstWantPin → lstFetchPin again: ~90 requests in 14 s
     against a donated gateway that was already answering 500. A failure is now
     remembered. The pin waits for the reader's Retry; a map box gets ONE
     automatic retry after a backoff and then waits too. */
  pinFails: new Set(),  /* (pin, radius) keys that failed */
  /* (pin, radius) keys that came BACK. The summary strip is built before the
     listings section on the same render, so "no rows" and "nothing has answered
     yet" are two different states and only this set can tell them apart. */
  pinDone: new Set(),
  boxFails: [],         /* [{ box, tries }] for the map's viewport queries */
  open: false,          /* the Test property section's "show the full module" state */
  sort: "dist",
  desc: false,
};

/* --- the hash --- */
/* The filter keys are prefixed `l` so they cannot collide with the dashboard's
   own, and they are the same spellings route_core.js migrates the old Listings
   page's links to. */
function lstQuery() {
  const f = LST.filters, q = {};
  const d = LV.DEFAULT_FILTERS || {};
  if (f.groups && d.groups && f.groups.length !== d.groups.length) q.lg = f.groups.join(",");
  if (f.allocation && d.allocation && f.allocation.length !== d.allocation.length) q.lal = f.allocation.join(",");
  if (f.rooms && f.rooms.length) q.lrm = f.rooms.join(",");
  if (f.sources) q.lsrc = f.sources.join(",");
  if (f.showReserved) q.lres = "1";
  if (f.offerOnly) q.loffer = "1";
  if (LST.sort !== "dist" || LST.desc) q.lsort = LST.sort + (LST.desc ? ":d" : "");
  if (LST.open) q.lopen = "1";
  return q;
}
function lstReadHash(q) {
  const f = LST.filters;
  const d = LV.DEFAULT_FILTERS || {};
  f.groups = q.lg ? q.lg.split(",").filter(Boolean) : (d.groups || []).slice();
  f.allocation = q.lal ? q.lal.split(",").filter(Boolean) : (d.allocation || []).slice();
  f.rooms = q.lrm ? q.lrm.split(",").filter(Boolean) : [];
  f.sources = q.lsrc ? q.lsrc.split(",").filter(Boolean) : null;
  f.showReserved = q.lres === "1";
  f.offerOnly = q.loffer === "1";
  if (q.lsort) { const [k, dd] = q.lsort.split(":"); LST.sort = k; LST.desc = dd === "d"; }
  else { LST.sort = "dist"; LST.desc = false; }
  LST.open = q.lopen === "1";
}

/* --- the session cache --- */
const lstContains = (a, b) => a.s <= b.s && a.w <= b.w && a.n >= b.n && a.e >= b.e;
function lstPad(box) {
  const dLat = (box.n - box.s) * LST_PAD, dLon = (box.e - box.w) * LST_PAD;
  return { s: box.s - dLat, w: box.w - dLon, n: box.n + dLat, e: box.e + dLon };
}
function lstBoxOf(map) {
  const b = map.getBounds();
  return { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() };
}
const lstHave = box => LST.boxes.some(b => lstContains(b, box));

/* --- fetching --- */
/* One request per viewport, 600 ms after the map stops. A box already in hand is
   never asked for again, and there is no interval anywhere. */
/* a box that overlaps one which already failed is the same failure */
const lstFailFor = box => LST.boxFails.find(f => lstContains(f.box, box) || lstContains(box, f.box));
function lstWant(map) {
  if (!map || !LAY.has("listings")) return;
  if (map.getZoom() < LST_ZOOM) return;
  const box = lstBoxOf(map);
  if (lstHave(box) || LST.loading) return;
  const f = lstFailFor(box);
  if (f && f.tries >= LST_MAX_TRIES) return;      /* waiting for Retry, not looping */
  if (LST.timer) clearTimeout(LST.timer);
  LST.timer = setTimeout(() => { LST.timer = null; lstFetch(lstPad(box), map); },
                         f ? LST_RETRY_MS : LST_DEBOUNCE);
}
function lstUrl(box) {
  if (LST.bboxOk) return `${GATEWAY}/bbox?s=${box.s.toFixed(6)}&w=${box.w.toFixed(6)}&n=${box.n.toFixed(6)}&e=${box.e.toFixed(6)}`;
  /* the fallback for a gateway without /bbox: the centre, and a radius that
     covers the view, capped */
  const lat = (box.s + box.n) / 2, lon = (box.w + box.e) / 2;
  const halfLat = havM(box.s, lon, box.n, lon) / 2, halfLon = havM(lat, box.w, lat, box.e) / 2;
  const r = Math.min(LST_FALLBACK_MAX, Math.round(Math.sqrt(halfLat * halfLat + halfLon * halfLon)) || 500);
  return `${GATEWAY}/nearby?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&r=${r}`;
}
async function lstFetch(box, map) {
  LST.loading = true; LST.error = null; lstRefresh();
  try {
    let res = await fetch(lstUrl(box), { headers: { accept: "application/json" } });
    if (res.status === 404 && LST.bboxOk) {
      /* an older deployment without /bbox — fall back once, for the session */
      LST.bboxOk = false;
      res = await fetch(lstUrl(box), { headers: { accept: "application/json" } });
    }
    const body = await res.json().catch(() => null);
    if (!body || !Array.isArray(body.listings)) throw new Error(`the gateway answered HTTP ${res.status}`);
    /* A 502 still carries the reason for every source, so it is rendered rather
       than thrown away: the legend has to be able to say which one failed. */
    LST.boxes.push(box);
    LST.boxFails = LST.boxFails.filter(f => !lstContains(box, f.box));
    LST.sources = body.sources || [];
    LST.fetchedAt = body.fetchedAt || null;
    LST.covered = body.covered !== false;
    for (const l of body.listings) {
      const k = l.src + ":" + l.id;
      if (LST.seen.has(k)) continue;
      LST.seen.add(k); LST.rows.push(l);
    }
  } catch (err) {
    LST.error = err && err.message ? err.message : "the gateway did not answer";
    const f = lstFailFor(box);
    if (f) f.tries++; else LST.boxFails.push({ box, tries: 1 });
  } finally {
    LST.loading = false;
    lstRefresh(map);
  }
}
/* redraw whatever is showing listings right now, without re-rendering the page */
function lstRefresh(map) {
  const m = map || LF.map || LF.pmap;
  if (m && LAY.has("listings")) { LF.listDrawn = false; try { lstBuild(m); } catch (e) { console.warn("listings", e); } }
  ovLegends();
  lstSectionRefresh();
}
function lstRetry() {
  LST.error = null; LST.boxes.length = 0; LST.boxFails.length = 0;
  lstWant(LF.map || LF.pmap);
}

/* --- what is on screen --- */
/* Queue supply is decided by `allocation`, through listings/view.js's own group
   rule, so a new municipal queue source joins the right side without a list of
   names here. */
const lstIsQueue = l => (LV.groupOf ? LV.groupOf(l) === "queue" : !!(l && l.allocation === "queue"));
const lstShown = () => (LV.applyFilters ? LV.applyFilters(LST.rows, LST.filters) : LST.rows);
const lstInBox = (rows, box) => rows.filter(l =>
  l.lat != null && l.lon != null && l.lat >= box.s && l.lat <= box.n && l.lon >= box.w && l.lon <= box.e);
/* the listings within the Test property radius — the pin's own circle, not a box */
function lstNearPin(rows) {
  if (PROP.lat == null) return rows;
  return rows.filter(l => l.lat != null && havM(PROP.lat, PROP.lon, l.lat, l.lon) <= PROP.rad)
             .map(l => Object.assign({}, l, { dist_m: Math.round(havM(PROP.lat, PROP.lon, l.lat, l.lon)) }))
             .sort((a, b) => a.dist_m - b.dist_m);
}

/* --- the markers --- */
const LST_COL = () => { const o = {}; (LV.GROUPS || []).forEach(g => { o[g.key] = g.color; }); return o; };
function lstBuild(map) {
  const m = map || LF.map;
  if (!m) return;
  lfDrop("listLayer");
  if (m.getZoom() < LST_ZOOM && m !== LF.pmap) { LF.listDrawn = false; lstWant(m); return; }
  lstWant(m);
  const col = LST_COL();
  const rows = m === LF.pmap && PROP.lat != null ? lstNearPin(lstShown()) : lstInBox(lstShown(), lstBoxOf(m));
  const g = L.layerGroup();
  /* Listings on a shared point are fanned out, never stacked — otherwise the one
     on top is the only one a reader can ever click. */
  for (const cluster of (LV.clusterByPoint ? LV.clusterByPoint(rows) : [rows])) {
    const offs = LV.spiderOffsets(cluster.length, cluster[0].lat);
    cluster.forEach((l, i) => {
      const [dLat, dLon] = offs[i];
      const mk = L.marker([l.lat + dLat, l.lon + dLon], {
        icon: L.divIcon({ className: "",
          html: `<div class="lst-mk" style="width:13px;height:13px;background:${col[LV.groupOf(l)]}"></div>`,
          iconSize: [13, 13], iconAnchor: [6.5, 6.5] }),
        title: `${l.address || ""} · ${l.src_label || l.src}`,
      });
      if (cluster.length > 1) {
        L.polyline([[l.lat, l.lon], [l.lat + dLat, l.lon + dLon]],
          { color: col[LV.groupOf(l)], weight: 1, opacity: .5 }).addTo(g);
      }
      mk.bindPopup(lstCard(l), { maxWidth: 320, minWidth: 300, className: "lstpop" });
      mk.on("popupopen", () => lstFillText(l));
      mk.addTo(g);
    });
  }
  g.addTo(m); LF.listLayer = g; LF.listDrawn = true; LF.listCount = rows.length;
}

/* --- the card --- */
function lstBadges(l) {
  const b = [];
  if (l.offer && l.offer.flag) b.push(`<span class="lst-bdg offer" title="${esc(l.offer.snippet || "")}">Kampanj</span>`);
  if (l.allocation === "queue") {
    const q = (l.queue_years_q1 != null && l.queue_years_q3 != null)
      ? `Kö: ${l.queue_years_q1}–${l.queue_years_q3} år`
      : "Kö: köad tid avgör";
    b.push(`<span class="lst-bdg queue" title="Allocated by queue time, not first come first served">${esc(q)}</span>`);
  }
  if (Array.isArray(l.also_on) && l.also_on.length) {
    const u = (l.also_on_urls && l.also_on_urls.homeq) || null;
    b.push(u ? `<a class="lst-bdg also" href="${esc(u)}" target="_blank" rel="noopener">Also on HomeQ ›</a>`
             : `<span class="lst-bdg also">Also on ${esc(l.also_on.join(", "))}</span>`);
  }
  /* Boplats Väst publishes a position for the property, not the entrance, and
     several adverts can share one point. Saying so is the difference between a
     dot that is approximate and a dot that lies. */
  if (l.src === "boplatsvast") b.push('<span class="lst-bdg pos" title="The source gives one position per property, not per entrance">Position: property-level</span>');
  if (l.audience) b.push(`<span class="lst-bdg">${esc((LV.AUDIENCE_LABEL || {})[l.audience] || l.audience)}</span>`);
  return b.join("");
}
function lstCard(l) {
  const m2 = LV.sekPerM2Year(l);
  const sub = [l.area_name, l.landlord].filter(Boolean).join(" · ") || l.src_label || l.src;
  const img = l.image
    ? `<img class="img" src="${esc(l.image)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=\\'noimg\\'>no photo</div>'">`
    : '<div class="noimg">no photo</div>';
  return `<div class="lst-card" data-card="${esc(l.src)}:${esc(l.id)}">
    ${img}
    <div class="pad">
      <h3>${esc(l.address || "Address not given")}</h3>
      <div class="sub">${esc(sub)} · ${esc(l.src_label || l.src)}</div>
      <div class="facts">
        <div><i>Advertised rent</i> ${l.rent_sek_mo != null ? nf(l.rent_sek_mo, 0) + " kr/mån" : "–"}</div>
        <div><i>Size</i> ${l.size_m2 != null ? nf(l.size_m2, 1) + " m²" : "–"}</div>
        <div><i>Rooms</i> ${l.rooms != null ? nf(l.rooms, l.rooms % 1 ? 1 : 0) : "–"}</div>
        <div><i>Floor</i> ${l.floor != null ? nf(l.floor, 0) : "–"}</div>
        <div><i>SEK/m²/yr</i> ${m2 != null ? nf(m2, 0) : "–"}</div>
        <div><i>From</i> ${esc(l.available_from || "–")}</div>
      </div>
      <div class="badges">${lstBadges(l)}</div>
      <div class="text" data-text>…</div>
      <a class="open" href="${esc(l.url || "#")}" target="_blank" rel="noopener">Open listing ›</a>
    </div></div>`;
}
const lstText = new Map();
async function lstFillText(l) {
  const node = document.querySelector(`[data-card="${(window.CSS && CSS.escape) ? CSS.escape(l.src + ":" + l.id) : l.src + ":" + l.id}"] [data-text]`);
  if (!node) return;
  if (l.text_start) { node.textContent = l.text_start; return; }
  node.textContent = "…";
  const key = `${l.src}:${l.id}`;
  if (!lstText.has(key)) {
    lstText.set(key, fetch(`${GATEWAY}/text?src=${encodeURIComponent(l.src)}&id=${encodeURIComponent(l.id)}`)
      .then(r => (r.ok ? r.json() : null)).then(j => (j && j.text_start) || null).catch(() => null));
  }
  const t = await lstText.get(key);
  if (!document.body.contains(node)) return;
  if (t) node.textContent = t;
  else {
    node.classList.add("muted");
    node.innerHTML = `Listing text isn't available here. <a href="${esc(l.url || "#")}" target="_blank" rel="noopener">Read the full listing ›</a>`;
  }
}

/* --- the legend --- */
function lstGroupCounts(rows) {
  const out = {};
  (LV.GROUPS || []).forEach(g => { out[g.key] = 0; });
  for (const l of rows) out[LV.groupOf(l)] = (out[LV.groupOf(l)] || 0) + 1;
  return out;
}
function lstStatusLine() {
  const bad = (LST.sources || []).filter(s => s.ok === false);
  const age = LV.snapshotAge ? LV.snapshotAge(LST.fetchedAt) : null;
  if (!LST.sources.length) return LST.loading ? "asking the gateway…" : "";
  if (bad.length) {
    const stale = bad.filter(s => /stale/i.test(s.error || "")).length;
    return `${LST.sources.length - bad.length} of ${LST.sources.length} sources answered · ${stale ? stale + " stale" : bad.length + " failed"}`;
  }
  return `${LST.sources.length} sources answered${age ? " · " + age : ""}`;
}
function lstLegend() {
  const z = LF.map ? LF.map.getZoom() : LST_ZOOM;
  if (LST.error) {
    return `<div class="lgtitle">Rental listings<span>unavailable</span></div>
      <div class="lgnote">Listings unavailable — gateway error, <button class="lgb" data-lstretry>retry</button>.
      Nothing else on the map is affected. <span class="dim">${esc(LST.error)}</span></div>`;
  }
  if (z < LST_ZOOM) {
    return `<div class="lgtitle">Rental listings<span>zoom in to see listings</span></div>
      <div class="lgnote">Live adverts are drawn from zoom ${LST_ZOOM}: at this scale a national dot cloud would say nothing about any one place.</div>`;
  }
  const rows = LF.map ? lstInBox(lstShown(), lstBoxOf(LF.map)) : lstShown();
  const c = lstGroupCounts(rows);
  const col = LST_COL();
  return `<div class="lgtitle">Rental listings<span>${LST.loading ? "loading…" : nf(rows.length, 0) + " in view"}</span></div>` +
    (LV.GROUPS || []).map(g => `<div class="lgrow"><i style="background:${col[g.key]}"></i>${esc(g.label)} <b>${nf(c[g.key] || 0, 0)}</b></div>`).join("") +
    `<div class="lgnote">${esc(lstStatusLine())}${LST.covered ? "" : " · the view is wider than one query covers, so this is its middle — zoom in for the rest"}.
      <b>Advertised</b> rents from third-party adverts, not contract rents, and a count of adverts is not a vacancy rate.</div>`;
}


/* ---------- the Test property section ----------
   The Listings page used to be a second application at a second address. It is a
   section here instead, so a reader compares what is advertised now against what
   SCB publishes for the same ground without changing pages — and so the caveat
   that keeps those two apart is on the same screen as both of them.

   The pin is a circle, not a viewport, so this asks /nearby with the radius the
   reader chose. One request per (pin, radius), remembered for the session. */
const lstPinKey = () => `${PROP.lat},${PROP.lon},${PROP.rad}`;
function lstWantPin() {
  if (PROP.lat == null || LST.loading) return;
  const k = lstPinKey();
  if (LST.pins.has(k) || LST.pinFails.has(k)) return;
  LST.pins.add(k);
  lstFetchPin(k);
}
async function lstFetchPin(k) {
  LST.loading = true; LST.error = null; lstSectionRefresh();
  try {
    const url = `${GATEWAY}/nearby?lat=${PROP.lat}&lon=${PROP.lon}&r=${PROP.rad}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    const body = await res.json().catch(() => null);
    if (!body || !Array.isArray(body.listings)) throw new Error(`the gateway answered HTTP ${res.status}`);
    LST.sources = body.sources || [];
    LST.fetchedAt = body.fetchedAt || null;
    LST.covered = true;
    for (const l of body.listings) {
      const key = l.src + ":" + l.id;
      if (LST.seen.has(key)) continue;
      LST.seen.add(key); LST.rows.push(l);
    }
    LST.pinDone.add(k);
  } catch (err) {
    /* the key stays in `pins` AND goes into `pinFails`: the refresh below runs
       lstSectionBody again, and both sets have to say "do not ask" */
    LST.pinFails.add(k);
    LST.error = err && err.message ? err.message : "the gateway did not answer";
  } finally {
    LST.loading = false;
    lstSectionRefresh();
    if (LF.pmap && (PROP.show.has("listings") || LAY.has("listings"))) { LF.listDrawn = false; try { lstBuild(LF.pmap); } catch (e) {} }
  }
}
/* redraw the section in place: a full re-render would close the popover a reader
   may have open on the mini-map */
function lstSectionRefresh() {
  const el = document.getElementById("lstsec");
  if (el && S.view === "property") el.innerHTML = lstSectionBody();
  /* two of the strip's seven items are listings figures, and this is the only
     path a gateway answer takes on the pin view */
  propStripRefresh();
}

const LST_COLS = [["src", "Source", 0], ["address", "Address", 0], ["area_name", "Area", 0],
                  ["rooms", "Rooms", 1], ["size", "m²", 1], ["rent", "SEK/mån", 1],
                  ["m2yr", "SEK/m²/yr", 1], ["dist", "m", 1], ["available_from", "From", 0]];

function lstSummary(rows, nDirect, nQueue) {
  const c = lstGroupCounts(rows);
  const radTxt = PROP.rad < 1000 ? `${PROP.rad} m` : `${PROP.rad / 1000} km`;
  return `<div class="lst-sum">
    <b>${nf(rows.length, 0)}</b> live listings within ${radTxt}
    ${(LV.GROUPS || []).map(g => `<span>${esc(g.label)} <b>${nf(c[g.key] || 0, 0)}</b></span>`).join("")}
    <span class="st">${esc(lstStatusLine())}</span></div>
    <div class="lst-split" data-testid="lst-split">
      <span>Direct / first come <b>${nf(nDirect, 0)}</b></span>
      <span>Queue <b>${nf(nQueue, 0)}</b></span>
      <i>the medians below are over the direct listings only</i></div>`;
}
/* Medians only where at least three adverts back the figure, and labelled
   advertised every time: a median of two adverts is not a market rate, and an
   advertised rent is not a contract rent.

   v2.1 P5: the rows handed in here are the DIRECT ones only. A queue advert's
   rent is what the flat will cost whoever reaches the front of the queue after
   several years of queuing; a direct advert's is what it costs whoever applies
   first. Pooling them would put two different allocation systems into one
   figure, so the caller splits them and the caption says so. */
function lstMedians(rows) {
  const med = LV.mediansByRooms ? LV.mediansByRooms(rows) : [];
  const cap = `<p class="cap" data-testid="lst-med-cap">Over <b>direct listings only</b> —
    queue listings are never mixed in, because a queue rent is allocated by queued time and a
    direct rent by who applies first. Advertised, not contract rents, and only where at least
    ${LV.MIN_N || 3} adverts back the room count.</p>`;
  if (!med.length) return `<div class="lst-med" data-testid="lst-medians"><div class="m sup"><b>–</b><span>no direct listing with both a rent and a size</span></div></div>${cap}`;
  return `<div class="lst-med" data-testid="lst-medians">${med.map(m => m.suppressed
    ? `<div class="m sup"><b>–</b><span>${esc(m.rooms)} rum · n=${m.n}, too few to publish</span></div>`
    : `<div class="m"><b>${nf(m.median, 0)}</b><span>${esc(m.rooms)} rum · n=${m.n} · advertised SEK/m²/yr</span></div>`).join("")}</div>${cap}`;
}
/* --- direct vs queue ---
   The two ways a Swedish rental is allocated, and the difference is the whole
   answer for a reader deciding whether a figure is reachable: a direct advert is
   applied for first come, first served, a queue advert goes to whoever has
   queued longest. The queue block carries the source's OWN queued-time figures
   where it publishes them and says "not published" where it does not — no
   estimate is made here. */
const QUEUE_LEAD = "Bostadsförmedlingen, Boplats and the other municipal queues";
const DIRECT_LEAD = "HomeQ and the landlords' own portals";
function lstQueueYears(rows) {
  const q1 = rows.map(l => l.queue_years_q1).filter(v => Number.isFinite(v));
  const q3 = rows.map(l => l.queue_years_q3).filter(v => Number.isFinite(v));
  if (!q1.length || !q3.length) return null;
  return { lo: LV.median(q1), hi: LV.median(q3), n: Math.min(q1.length, q3.length) };
}
function lstAllocBlock(kind, rows, all) {
  const direct = kind === "direct";
  const qy = direct ? null : lstQueueYears(rows);
  const head = `<div class="lst-ahead">
      <h4>${direct ? "Direct / first come" : "Queue"}<span class="n">${nf(rows.length, 0)}</span></h4>
      <span class="lst-awhy">${direct
        ? `${esc(DIRECT_LEAD)} · applied for first come, first served`
        : `${esc(QUEUE_LEAD)} · allocated by queued time, not by who applies first`}</span>
      ${!direct ? `<span class="lst-aq">${qy
        ? `queued time ${nf(qy.lo, 0)}–${nf(qy.hi, 0)} years <i>(the sources' own q1–q3, ${qy.n} advert${qy.n === 1 ? "" : "s"})</i>`
        : `queued time <i>not published by these sources</i>`}</span>` : ""}
    </div>`;
  if (!rows.length) {
    return `<div class="lst-alloc ${esc(kind)}" data-testid="lst-alloc-${esc(kind)}">${head}
      <p class="empty">No ${direct ? "direct" : "queue"} listing within ${radTxt(PROP.rad)} in this answer.</p></div>`;
  }
  /* the direct block keeps the plain `lst-cards` / `lst-table` ids: it is the one
     a reader lands on and the one v2.0's checks already read */
  return `<div class="lst-alloc ${esc(kind)}" data-testid="lst-alloc-${esc(kind)}">${head}
    <div class="lst-cards" data-testid="lst-cards${direct ? "" : "-queue"}">${rows.map(l => lstCard(l)).join("")}</div>
    ${lstTable(rows, direct ? "" : "-queue")}</div>`;
}
function lstFilterBar(all) {
  const f = LST.filters;
  const bySrc = {};
  for (const l of all) bySrc[l.src] = (bySrc[l.src] || 0) + 1;
  const hidden = LV.hiddenCounts ? LV.hiddenCounts(all, f) : { reserved: 0 };
  const col = LST_COL();
  const tog = (on, attr, label) => `<button class="lst-tog" aria-pressed="${on}" ${attr}>${label}</button>`;
  return `<div class="lst-filters">
    <div class="lst-fgroup"><span>Group</span>${(LV.GROUPS || []).map(g =>
      tog(f.groups.includes(g.key), `data-lstgroup="${g.key}"`,
        `<span class="swatch" style="background:${col[g.key]}"></span>${esc(g.label)} <span style="opacity:.65">${all.filter(l => LV.groupOf(l) === g.key).length}</span>`)).join("")}</div>
    <div class="lst-fgroup"><span>Allocation</span>
      ${tog(f.allocation.includes("direct"), 'data-lstalloc="direct"', "Direct")}
      ${tog(f.allocation.includes("queue"), 'data-lstalloc="queue"', "Queue")}</div>
    <div class="lst-fgroup"><span>Rooms</span>${["1", "2", "3", "4+"].map(b =>
      tog(f.rooms.includes(b), `data-lstroom="${b}"`, b + " rum")).join("")}</div>
    <div class="lst-fgroup"><span>Show</span>
      ${tog(f.offerOnly, 'data-lstoffer="1"', "Kampanj only")}
      ${tog(f.showReserved, 'data-lstres="1"', `Reserved (student/ungdom/senior)${hidden.reserved && !f.showReserved ? " · " + hidden.reserved + " hidden" : ""}`)}</div>
    <div class="lst-fgroup"><span>Sources</span>${Object.keys(bySrc).sort().map(src =>
      tog(!f.sources || f.sources.includes(src), `data-lstsrc="${esc(src)}"`, `${esc(src)} ${bySrc[src]}`)).join("")}</div>
  </div>`;
}
function lstTable(rows, suffix) {
  const sorted = LV.sortListings ? LV.sortListings(rows, LST.sort, LST.desc) : rows;
  const col = LST_COL();
  return `<div class="lst-scroll"><table class="lst-tbl" data-testid="lst-table${esc(suffix || "")}"><thead><tr>${LST_COLS.map(([k, label, num]) =>
    `<th class="${num ? "num" : ""}" data-lstsort="${k}">${esc(label)}${LST.sort === k ? (LST.desc ? " ▾" : " ▴") : ""}</th>`).join("")}</tr></thead>
    <tbody>${sorted.map(l => { const m2 = LV.sekPerM2Year(l);
      return `<tr data-lstrow="${esc(l.src)}:${esc(l.id)}">
        <td><span class="srcdot" style="background:${col[LV.groupOf(l)]}"></span>${esc(l.src)}</td>
        <td>${esc(l.address || "–")}</td><td>${esc(l.area_name || "–")}</td>
        <td class="num">${l.rooms != null ? nf(l.rooms, l.rooms % 1 ? 1 : 0) : "–"}</td>
        <td class="num">${l.size_m2 != null ? nf(l.size_m2, 1) : "–"}</td>
        <td class="num">${l.rent_sek_mo != null ? nf(l.rent_sek_mo, 0) : "–"}</td>
        <td class="num">${m2 != null ? nf(m2, 0) : "–"}</td>
        <td class="num">${l.dist_m != null ? nf(l.dist_m, 0) : "–"}</td>
        <td>${esc(l.available_from || "–")}</td></tr>`; }).join("")}</tbody></table></div>`;
}
function lstSectionBody() {
  if (PROP.lat == null) return `<p class="empty">Drop a pin first.</p>`;
  /* the error is checked BEFORE asking, so a failed pin cannot be re-requested by
     the very refresh that draws its error message */
  if (LST.error) {
    return `<div class="lst-msg err" data-testid="lst-error">Listings unavailable — gateway error.
      <button class="lk mini" data-lstretrypin data-testid="lst-retry">Retry</button> <span class="dim">${esc(LST.error)}</span></div>
      ${LST_CAVEAT}`;
  }
  lstWantPin();
  const near = lstNearPin(LST.rows);
  const shown = LV.applyFilters ? LV.applyFilters(near, LST.filters) : near;
  if (LST.loading && !near.length) return `<p class="empty">Asking the listings gateway…</p>`;
  /* the split is made once, here, and everything below reads it: the counts, the
     medians (direct only) and the two card blocks */
  const direct = shown.filter(l => !lstIsQueue(l));
  const queue = shown.filter(lstIsQueue);
  return `${lstSummary(shown, direct.length, queue.length)}
    ${lstMedians(direct)}
    <div class="tools" style="margin-top:10px">
      <button class="lk ${LST.open ? "primary" : ""}" data-lstshow data-testid="lst-show">${LST.open ? "Hide listings" : `Show listings (${shown.length})`}</button>
      ${LST.open ? `<button class="lk mini" data-lstcsv>⤓ CSV</button>` : ""}
    </div>
    ${LST.open ? `${lstFilterBar(near)}
      ${shown.length ? `${lstAllocBlock("direct", direct)}${lstAllocBlock("queue", queue)}`
        : `<p class="empty">Nothing matches these filters.</p>`}` : ""}
    ${LST_CAVEAT}`;
}
const LST_CAVEAT = `<p class="lst-caveat">Advertised rent ≠ contract rent · a count of adverts ≠ vacancy · queue listings are allocated by queued time, not first come first served · medians only at n ≥ 3 · third-party adverts, read live through the gateway and stored nowhere.</p>`;
/* One path for every filter change: write the hash, redraw the section in place
   and redraw whichever map is showing the markers. A full re-render would close
   a popup the reader has open on the mini-map. */
function lstToggle(list, value) {
  const i = list.indexOf(value);
  if (i < 0) list.push(value); else list.splice(i, 1);
  lstAfterFilter();
}
function lstAfterFilter() {
  syncHash();
  lstSectionRefresh();
  const m = S.view === "property" ? LF.pmap : LF.map;
  if (m && (LAY.has("listings") || PROP.show.has("listings"))) { LF.listDrawn = false; try { lstBuild(m); } catch (e) {} }
  ovLegends();
  if (UI.menu === "layers") renderKeep();
}
/* clicking a table row takes the map to that advert and opens its card */
function lstFocus(key) {
  const m = S.view === "property" ? LF.pmap : LF.map;
  const l = LST.rows.find(x => x.src + ":" + x.id === key);
  if (!m || !l || l.lat == null) return;
  m.setView([l.lat, l.lon], Math.max(m.getZoom(), 16));
  L.popup({ maxWidth: 320, minWidth: 300, className: "lstpop" })
    .setLatLng([l.lat, l.lon]).setContent(lstCard(l)).openOn(m);
  lstFillText(l);
}
function lstCsv() {
  const near = lstNearPin(LST.rows);
  const shown = LV.sortListings(LV.applyFilters(near, LST.filters), LST.sort, LST.desc);
  downloadCsv([LV.toCsv(shown, LST.fetchedAt)], `listings_${PROP.lat.toFixed(4)}_${PROP.lon.toFixed(4)}_r${PROP.rad}.csv`);
}

/* ---------- the feature layers ----------
   A layer is five hooks and no more: an id (which is what `lay=` carries), a row
   in the Layers ▾ menu, an `lf…Layers()` builder, a legend, and optional
   sub-filters rendered inside the menu. `LAY` is the only place "is it on" lives.

   The climate hazard zones are deliberately NOT in this list. They are the same
   source as the Climate indicators rendered geometrically, so they only make
   sense beside the figure they explain: they are drawn when a Climate indicator
   is selected, and the menu offers them as a context row with a hide toggle. */
const OV = [
  { id: "infra", label: "Infra projects",
    title: "Major transport projects — status by colour",
    note: () => `${(INFRA.projects || []).length} projects · Trafikverket, regions`,
    avail: () => (INFRA.projects || []).length > 0,
    build: map => infraBuild(map), legend: infraLegend },
  { id: "public", label: "Public buildings",
    title: "Schools, förskolor, health, culture and sports from OpenStreetMap",
    note: () => "OpenStreetMap · zoom 11+",
    avail: () => Object.keys(SRV_IDX).length > 0,
    subs: () => srvSubs("pub"),
    build: map => srvDraw("pub", map), legend: () => srvLegendFor("pub") },
  { id: "services", label: "Services",
    title: "Grocery, food, pharmacy and public-transport points from OpenStreetMap",
    note: () => "OpenStreetMap · zoom 11+",
    avail: () => Object.keys(SRV_IDX).length > 0,
    subs: () => srvSubs("srv"),
    build: map => srvDraw("srv", map), legend: () => srvLegendFor("srv") },
  { id: "schools", label: "Schools",
    title: "Every school with year 9, coloured by merit value (zoom 9+)",
    note: () => "Skolverket · merit colour · zoom 9+",
    avail: () => Object.keys(SCH_IDX).length > 0,
    build: map => schBuild(map), legend: schLegend },
  { id: "uso", label: "Police-designated areas",
    title: "The areas the police have designated as utsatt or särskilt utsatt (Dec 2025)",
    note: () => "Polismyndigheten, Dec 2025",
    build: map => usoBuild(map), legend: usoLegend },
  { id: "listings", label: "Rental listings",
    title: "What is advertised for rent in view, live through the listings gateway (zoom 13+)",
    note: () => "live third-party adverts · zoom 13+",
    subs: () => lstSubs(),
    build: map => lstBuild(map), legend: lstLegend },
];
const ovOn = o => LAY.has(o.id);
const ovList = () => OV.filter(o => !o.avail || o.avail());
const ovOf = id => OV.find(o => o.id === id) || null;

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
function lfOverlays(map) {
  const m = map || LF.map;
  if (!m) return;
  for (const o of ovList()) {
    if (ovOn(o)) { try { o.build(m); } catch (e) { console.warn("layer " + o.id, e); } }
    else { lfDrop(layKey(o.id) + "Layer"); LF[layKey(o.id) + "Drawn"] = false; }
  }
  /* the climate context zones follow the indicator, not a button of their own */
  if (climOn()) { try { climBuild(m); } catch (e) { console.warn("zones", e); } }
  else { lfDrop("climLayer"); LF.climDrawn = false; }
}
/* Zones are drawn when a Climate indicator is selected and the reader has not
   ticked them off. `zones=0` is the only thing that hides them. */
const climOn = () => isClimKey(MK.ind) && !ZN.off && !!climLayerFor(MK.ind);
const climLayerFor = k => (CLIM_IDX[k] ? k : null);

/* ---------- Layers ▾ ----------
   One button replaces the six overlay buttons the toolbar used to carry, and the
   sub-filters that used to sit inside each floating legend live in the menu, so
   the legends on the map are keys and nothing else. */
function layersMenuHtml() {
  const list = ovList();
  const n = list.filter(ovOn).length;
  const zoneRow = isClimKey(MK.ind) && climLayerFor(MK.ind)
    ? `<div class="mlab">Context</div>
       <button class="mi row ${ZN.off ? "" : "on"}" data-zones data-layer-ctx="zones" role="switch" aria-checked="${!ZN.off}">
         <i class="tick">${ZN.off ? "" : "✓"}</i><span><b>${esc((indOf(MK.ind) || {}).short || "Hazard zones")}</b>
         <em>shown because a Climate indicator is active · zoom ${CLIM_ZOOM}+</em></span></button>` : "";
  return `<span class="menu ${UI.menu === "layers" ? "open" : ""}">
    <button class="lk ${n ? "primary" : ""}" data-testid="layers-btn" data-menu="layers" aria-haspopup="true" aria-expanded="${UI.menu === "layers"}">Layers${n ? " · " + n : ""} ▾</button>
    ${UI.menu === "layers" ? `<div class="menupop wide" role="dialog" aria-label="Layers" data-testid="layers-pop">
      <div class="mlab">Feature layers</div>
      ${list.map(o => `<button class="mi row ${ovOn(o) ? "on" : ""}" data-layer="${o.id}" role="switch" aria-checked="${ovOn(o)}" title="${esc(o.title || o.label)}">
        <i class="tick">${ovOn(o) ? "✓" : ""}</i><span><b>${esc(o.label)}</b><em>${esc(o.note ? o.note() : "")}</em></span></button>
        ${ovOn(o) && o.subs ? `<div class="msubs">${o.subs()}</div>` : ""}`).join("")}
      ${zoneRow}</div>` : ""}</span>`;
}
/* the three group ticks for the listings layer, in the menu with every other
   sub-filter — the same grouping and the same colours the section below uses */
function lstSubs() {
  const on = (LST.filters.groups || []);
  const col = LST_COL();
  return (LV.GROUPS || []).map(g =>
    `<button class="mchip ${on.includes(g.key) ? "on" : ""}" data-lstgroup="${g.key}"><i style="background:${on.includes(g.key) ? col[g.key] : "transparent"};border-color:${col[g.key]}"></i>${esc(g.label)}</button>`).join("");
}
/* the category ticks that used to live inside the Services / Public legends */
function srvSubs(which) {
  const cats = which === "srv" ? SRV_SET : PUB_SET;
  const on = which === "srv" ? SF.srv : SF.pub;
  return cats.map(c => { const d = SRV_CATS[c];
    return `<button class="mchip ${on.has(c) ? "on" : ""}" data-srvcat="${which}:${c}"><i style="background:${on.has(c) ? d[1] : "transparent"};border-color:${d[1]}"></i>${esc(d[0])}</button>`; }).join("");
}

/* ---------- the map is the page ----------
   v2.1 P4: the map starts within 200 px of the top of the window at 1366×768
   and takes the rest of it. The stylesheet used to say
   `clamp(380px, 100vh - 250px, 760px)` — a guess at how tall everything above
   the map is, which was wrong by a different amount at every display scaling
   and left either a gap under the map or the legend below the fold. The height
   is measured from where the container actually sits instead.

   The mini-maps' own full screen is excluded: `.mapwrap.is-full > div:first-child`
   is 100vh with !important and must stay that way. The big map's Fullscreen API
   toggle is NOT excluded — the card moves to the top of the screen, so the
   measurement is exactly what should be redone, and the fullscreenchange handler
   calls this. */
const MAP_MIN_H = 320;      /* below this the map is not worth having */
const MAP_GAP = 10;         /* so the bottom border is not flush with the window */
let MAP_H_T = null;
function fitMapHeight() {
  const el = document.getElementById("lfmap");
  if (!el) return;
  const wrap = el.parentElement;
  if (wrap && wrap.classList && wrap.classList.contains("is-full")) return;
  const top = el.getBoundingClientRect().top;
  const h = Math.max(MAP_MIN_H, Math.round(window.innerHeight - top - MAP_GAP));
  el.style.height = h + "px";
  if (LF.map) LF.map.invalidateSize();
}
function lfInit() {
  const el = document.getElementById("lfmap");
  if (!el || typeof L === "undefined") return;
  lfGuardCanvas(); lfGuardMap();
  /* sized BEFORE Leaflet reads the container, or the first fitBounds is
     computed against the stylesheet's height and the view is off */
  fitMapHeight();
  /* render() has already torn every map down through the registry, so there is
     nothing to remove here — only to register. */
  const map = regMap(L.map(el, { center: LF.center, zoom: LF.zoom, scrollWheelZoom: true, zoomSnap: 0.5, zoomDelta: 1, wheelPxPerZoomLevel: 30, wheelDebounceTime: 20 }));
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
    /* `fine` was a variable in the zoom-decides-the-level code that v1.0 replaced;
       the reference survived, so every zoomend threw and labels stopped being
       rebuilt. Labels are sized against the screen, so they are always redone.
       The key comes from mapLevelKey() on both sides — spelling it out here without
       the mode suffix made every zoom step in Map only rebuild the polygons. */
    if (mapLevelKey() !== LF.level) lfLayers(); else lfLabels();
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
  setTimeout(fitMapHeight, 300);
}
document.addEventListener("fullscreenchange", () => {
  const b = document.querySelector("[data-fs]"); if (b) b.textContent = document.fullscreenElement ? "⤡ Exit full screen" : "⤢ Full screen";
  /* the card is at the top of the screen in full screen and back in the page
     out of it, so the height is re-measured either way rather than left at
     whatever it was on the other side of the toggle */
  setTimeout(fitMapHeight, 250);
});
/* A mini-map cannot use the Fullscreen API: it sits inside a scrolling column and
   the API would take the whole card with it, losing the chart beside it. It gets a
   fixed overlay instead, and Esc closes it the same way. */
function toggleMiniFull(key) {
  const wrap = document.querySelector(`[data-mini="${key}"]`);
  if (!wrap) return;
  const on = !wrap.classList.contains("is-full");
  document.querySelectorAll(".mapwrap.is-full").forEach(w => w.classList.remove("is-full"));
  wrap.classList.toggle("is-full", on);
  LF.fullKey = on ? key : null;
  const m = key === "area" ? LF.amap : LF.pmap;
  setTimeout(() => { if (m) m.invalidateSize(); }, 60);
}
function closeMiniFull() { if (LF.fullKey) toggleMiniFull(LF.fullKey); }

/* ---------- Chart generator ---------- */
const CH_COLORS = ["#1C6B5C", "#B07A1E", "#40547F", "#B0331B", "#82346C", "#5C5F52", "#6E8C5E", "#C08A24"];
function chEntity(id) {
  const [t, c] = id.split(":");
  if (t === "kommun" && byCode[c]) return { id, type: t, o: byCode[c], name: byCode[c].name, inds: IND, peers: MUNI, peerLabel: "municipalities" };
  if (t === "regso" && byRegso[c]) return { id, type: t, o: byRegso[c], name: byRegso[c].name, inds: IND, peers: AREAS, peerLabel: "RegSO areas", kommun: byCode[byRegso[c].kommun] };
  if (t === "deso" && byDeso[c]) return { id, type: t, o: byDeso[c], name: byDeso[c].code.split("_")[0], inds: IND, peers: desoAreas(byDeso[c].kommun), peerLabel: "DeSO areas", kommun: byCode[byDeso[c].kommun] };
  return null;
}
function chartAdd(id, text) {
  /* the datalist offers the exact name, so that is tried first; anything else goes
     through the same ranked, diacritic-insensitive match the search box uses */
  if (!id && text) { const q = text.trim(); const o = AREA_OPTS.find(x => x.t === q) || SC.match(AREA_OPTS, q, 1)[0];
    if (!o) return; id = o.h.startsWith("map/") ? "kommun:" + o.h.slice(4) : o.h.replace("area/", "").replace("/", ":"); }
  if (!id || CH.areas.includes(id) || CH.areas.length >= 8) return;
  CH.areas.push(id); syncHash(); renderKeep();
  const q = document.getElementById("chq"); if (q) { q.value = ""; q.focus(); }
}
function chartInd() { return IND.concat(IND_DESO.filter(i => !IND.some(x => x.key === i.key))).find(i => i.key === CH.ind) || IND[0]; }
/* ---------- Yearly | Quarterly ----------
   Some series are published quarterly, and each point is ONE quarter exactly as
   the publisher wrote it — Brå's reported offences run ~41–50 per 1 000 per
   quarter against 191,6 for the year in Stockholm. Nothing here is summed over a
   window; v2.0's captions said "rolling 4 quarters" and that was never true of
   this data. An indicator gets the toggle only when the build wrote `q_periods`
   for it, and only when EVERY selected area actually has quarters — a mixed
   selection falls back to yearly rather than drawing a line with holes in it. */
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
      const v = V(e.o, ind.key, y); if (v != null) return v; const m = subKommun(e); return m && canInherit(ind.key) ? V(m, ind.key, y) : null; };
    return { name: e.name, color: CH_COLORS[k % CH_COLORS.length], pts: ys.map(y => ({ y, v: own ? val(y) : null })), inherited: !!subKommun(e) && V(e.o, ind.key) == null && V(subKommun(e), ind.key) != null }; });
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
  /* what a point IS has to say so on the chart itself, not only in the toolbar —
     the PNG leaves the toolbar behind */
  const oi = outlookOf(ind);
  const roll = chartQ() ? " · each point is one quarter"
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
     period-kind and projection notes have to be repeated here — the PNG leaves
     the toolbar behind, and a dashed line has to say what it means. */
  const note = chartQ() ? " · each point is one quarter"
    : (outlookOf(ind) && chartFcYears()) ? " · dashed = projected, not observed" : "";
  const fsrc = (ind.source || ""); const fshort = fsrc.length > 78 ? fsrc.slice(0, 76) + "…" : fsrc;
  const foot = `<text x="${L0}" y="${H - 14}" font-family="${M}" font-size="11" fill="#8A8C81">Source: ${esc(fshort)} · Macro Dashboard — Sweden, open data · built ${esc((D.meta && D.meta.built) || "")}${note}${series.some(s_ => s_.inherited) ? " · ° = municipality value shown for a RegSO or DeSO" : ""}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" id="chsvg"><rect width="${W}" height="${H}" fill="#FFFFFF"/>${title}
    ${ticks.map(t => `<line x1="${L0}" x2="${W - R}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke="#EFEFEA"/><text x="${L0 - 10}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end" font-family="${M}" font-size="12" fill="#8A8C81">${esc(fmtOf(ind)(t))}</text>`).join("")}
    ${ys.map((yy, i) => `<text x="${x(i).toFixed(1)}" y="${H - B + 22}" text-anchor="middle" font-family="${M}" font-size="12" fill="#8A8C81">${yy}</text>`).join("")}
    ${paths}${legend}${foot}</svg>`;
}
/* A RegSO line, and the "Sweden — median of RegSO" line behind it, are read off
   the whole pool — so a chart that names one waits for regso/values.json rather
   than drawing a flat line at nothing. */
const chartWaiting = () => !RG.vals && CH.areas.some(a => String(a).indexOf("regso:") === 0);
function vCharts() {
  const ind = chartInd(), ys = chartYears(); const ents = CH.areas.map(chEntity).filter(Boolean);
  const quick = [["Top 5 kommuner", MUNI.slice().sort((a, b) => (b.pop || 0) - (a.pop || 0)).slice(0, 5).map(m => "kommun:" + m.code)],
                 ["Storstäder", ["0180", "1480", "1280"].filter(c => byCode[c]).map(c => "kommun:" + c)],
                 ["University towns", ["0380", "1280", "0580", "1880"].filter(c => byCode[c]).map(c => "kommun:" + c)]];
  const { series } = chartSeries();
  return `
  <div class="card accent">
    <div class="card-head tools-only"><div class="tools">
      ${indPicker("chart")}
      ${(() => { const fy = chartFcYears(); const ys = fy || YEARS; const lo = ys[0], hi = ys[ys.length - 1];
        return `<select id="chy0" class="indsel"><option value="">from ${lo}</option>${ys.map(y => `<option value="${y}" ${CH.y0 === y ? "selected" : ""}>${y}</option>`).join("")}</select>
      <select id="chy1" class="indsel"><option value="">to ${hi}</option>${ys.map(y => `<option value="${y}" ${CH.y1 === y ? "selected" : ""}>${y}</option>`).join("")}</select>`; })()}
      <label class="hint" style="display:flex;align-items:center;gap:5px"><input type="checkbox" id="chmed" ${CH.median ? "checked" : ""}> median</label>
      <div class="seg">${[["auto", "Auto"], ["line", "Line"], ["bar", "Bars"], ["dist", "Distribution"]].map(([m, l]) => `<button class="sg ${CH.mode === m ? "on" : ""}" data-chmode="${m}">${l}</button>`).join("")}</div>
      ${chQPeriods(chartInd()).length > 1 ? `<div class="seg">${[["year", "Yearly"], ["q", "Quarterly"]].map(([m, l]) => `<button class="sg ${CH.fq === m ? "on" : ""}" data-chfq="${m}" title="${m === "q" ? "Each point is one quarter as the publisher wrote it — not a rolling four-quarter sum" : "One point per year"}">${l}</button>`).join("")}</div>` : ""}
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
    <div class="chartbox">${chartWaiting() ? regsoWait() : ents.length ? chartSvg(true) : `<div class="chempty" data-testid="chart-empty"><b>Nothing to plot</b><p>The selection is empty. Type a kommun or RegSO in the box above (up to 8), or start with a set:</p>
      <div class="tools"><button class="lk primary" data-chadd="${CH_DEFAULT_AREAS.join("|")}" data-testid="chart-default">+ the default four</button>${quick.map(([l, ids]) => `<button class="lk" data-chadd="${ids.join("|")}">+ ${l}</button>`).join("")}</div>
      <p class="dim">Tip: every area page and table row has a ↗ that opens it here with the indicator pre-selected.</p></div>`}</div>
    <p class="cap">${esc(ind.desc || "")} ${ind.warn ? "⚠ " + esc(ind.warn) : ""} Same sub-period each year (e.g. Q3 or July); values are those shown in the dashboard.</p>
  </div>
  ${!chartWaiting() && chartMode() === "line" && ents.length && series.length ? `<div class="card"><div class="card-head"><h3>Data</h3><span class="hint">${esc(ind.unit || "")}</span></div>
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

/* ---------- Data › National series ---------- */
/* One row of the series' own shape. The axis is the series' own range rather than
   a shared one, so a sparkline says "which way" and never "how much" — the number
   next to it is what says how much. */
function spark(series, w = 160, h = 26) {
  const v = (series || []).map(p => p.v).filter(x => x != null);
  if (v.length < 2) return "";
  const lo = Math.min(...v), hi = Math.max(...v), sp = hi - lo || 1;
  const pts = v.map((x, i) => `${(i / (v.length - 1) * w).toFixed(1)},${(h - 2 - (x - lo) / sp * (h - 4)).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline fill="none" stroke="currentColor" stroke-width="1.5" points="${pts}"/></svg>`;
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
/* ---------- Data › National series ----------
   The four big charts are gone: the series are the national context an investment
   committee asks for (rates, CPI, rent index, price index), and a table with a
   sparkline per row answers "where is it now, and which way" in one screen, with
   the source on every row. Anyone who wants the curve opens it in Charts.

   The breakdowns stay, folded: for new-build rent by rent-setting model and for
   vacancy by owner category the split IS the point. */
const NAT_SPARK_NOTE = "sparkline: the whole series, not a window — the axis is the series' own range";
/* ---------- how a national series is written ----------
   Decimals come from the series' own format, not from a default of 1: a rent in
   SEK and a count of dwellings are whole numbers, and "1 337,0 SEK" and
   "1 464,0 dwellings" are false precision.

   A y/y change of a RATE or of a GROWTH RATE is in percentage points. The policy
   rate falling from 2,50 to 1,75 is −0,75 pp; writing it as "−0,8 %" says the
   rate fell by four fifths of a per cent, which is wrong by two orders of
   magnitude. Everything measured as a level or an index keeps %. */
const MAC_DEC = { pct0: 0, sek0: 0, ksek: 0, int: 0, m2: 0, cat: 0,
                  pct1: 1, idx: 1, idx1: 1, num1: 1, signpct1: 1, per1000: 1, per10k: 1,
                  pct2: 2, ratio2: 2, num2: 2 };
const macDec = o => (o.dec != null ? o.dec : (MAC_DEC[o.fmt] != null ? MAC_DEC[o.fmt] : 1));
const macDeltaUnit = o => deltaUnit({ fmt: o.fmt });
/* A national series carries no `direction` — CPI rising is neither good nor bad,
   it is CPI — so the y/y is drawn plain unless the build says otherwise. Colour
   without a stated direction is editorialising. */
const macCls = (o, d) => {
  if (!o || !o.direction || d == null || !d) return "";
  return (o.direction === "lower_better" ? d < 0 : d > 0) ? "up" : "dn";
};
function vMarket() {
  const mac = D.macro || {}, lt = mac.latest || {};
  if (!Object.keys(lt).length) return `<div class="card"><p class="empty">No macro series built yet — run the pipeline (see Sources).</p></div>`;
  const tile = (key, label) => { const o = lt[key]; if (!o) return ""; const yoy = o.yoy;
    return `<div><span>${esc(label)}</span><b>${nf(o.v, macDec(o))}<i class="u">${esc(o.unit || "")}</i></b>
      ${yoy != null ? `<em class="k ${macCls(o, yoy)}">${signed(yoy, 1, macDeltaUnit(o))} y/y</em>` : ""}<em>${esc(o.t || "")}${o.src ? " · " + esc(o.src) : ""}</em>${spark((mac.series || {})[key])}</div>`; };
  const heroKeys = (mac.hero || ["policy_rate", "mortgage_rate", "bond_10y", "cpi"]).filter(k => lt[k]);
  /* the headline series are the tiles above; repeating them as rows is how the
     mortgage rate came to appear twice on one screen */
  const tableKeys = (mac.table || Object.keys(lt)).filter(k => lt[k] && !heroKeys.includes(k));
  const bds = [["newbuild_rent", "New-build rent by rent-setting model", "SEK / m² / yr", 0],
               ["vacancy", "Vacant dwellings by owner category", "% of dwellings", 1],
               ["permits", "Building permits by dwelling type", "dwellings", 0]]
    .filter(([k]) => ((mac.breakdown || {})[k]));
  return `
  <div class="hero natrow" data-testid="tiles">${heroKeys.map(k => tile(k, (lt[k] || {}).label || k)).join("")}</div>
  <div class="card">
    <div class="card-head"><h3>National series</h3><span class="hint">${tableKeys.length} more series · the ${heroKeys.length} headline ones are the tiles above · latest available period each · ${NAT_SPARK_NOTE}</span></div>
    <div class="scrollx"><table class="tbl compact" data-sortable data-testid="national-table"><thead><tr>
      <th>Series</th><th class="num">Latest</th><th>Period</th><th class="num">y/y</th><th>Trend</th><th>Source</th><th></th></tr></thead>
    <tbody>${tableKeys.map(k => { const o = lt[k]; if (!o) return "";
      return `<tr><th>${esc(o.label || k)}</th>
        <td class="num" data-v="${o.v}">${nf(o.v, macDec(o))} ${esc(o.unit || "")}</td>
        <td class="dim">${esc(o.t || "")}</td>
        <td class="num ${macCls(o, o.yoy)}" data-v="${o.yoy ?? ""}">${o.yoy != null ? signed(o.yoy, 1, macDeltaUnit(o)) : "–"}</td>
        <td class="sparkcell">${spark((mac.series || {})[k], 120, 22)}</td>
        <td class="dim">${esc(o.src || "")}</td>
        <td><button class="tch" data-go="charts?ind=${esc(k)}&a=" title="Open in Charts">↗</button></td></tr>`; }).join("")}</tbody></table></div>
    <p class="cap">${esc(mac.note || "")}</p>
  </div>
  ${bds.length ? bds.map(([k, title, unit, dec]) => `<details class="sec"><summary><b>${esc(title)}</b><span class="dim">${esc(unit)}</span></summary>
    <div class="secbody">${bdTable(k, unit, dec)}
    ${k === "newbuild_rent" ? `<p class="cap">Presumtionshyra exempts a new build from the bruksvärde cap for 15 years, which is why these sit far above the stock next door. Six national groups, 2022–2024 — no kommun breakdown exists.</p>` : ""}
    ${k === "vacancy" ? `<p class="cap"><b>Stale.</b> Triennial and the series stops at 2024 (2019, 2021, 2024); SCB has announced no next publication, so this does not track the current market. Sample survey — the published margin of error is wider than most of the differences between the groups.</p>` : ""}
    </div></details>`).join("") : ""}
  <div class="card"><p class="cap">Sweden publishes no open realised price per m² at any geography, so there is no price-per-m² series here and the price chip on the map is <b>K/T-tal</b> — purchase price divided by assessed value. The rent series are <b>SEK/m²/yr</b>. Full definitions and table stamps are under the <b>Sources</b> tab.</p></div>`;
}

/* ---------- Data › Sources ---------- */
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

/* ---------- Export ▾ ----------
   One menu, in the sidebar footer and in the Data header, so there is one answer
   to "how do I get this out" wherever the reader is. src/export_core.js owns the
   schema, the CSV rules and the unit check; this file knows where the values are.

   Every row carries its provenance — source, table id, the URL that reproduces
   the publisher's own query, their as-of and this build's date — because a figure
   without those is not evidence of anything. A suppressed value is an empty cell
   and never a zero. */
const XC = window.EXPORT_CORE;
const BUILT = (D.meta && D.meta.built) || "data";
const FETCHED = BUILT;
const SRC_META = {};
((D.meta && D.meta.sources) || []).forEach(x => { SRC_META[x.key] = x; });

/* the catalogue entry behind an indicator, for the table id, the URL and the licence */
function indSource(i, level) {
  const e = pickSrc(i, level || "kommun");
  const tid = e ? e.table : "";
  const cat = SRC_META[tid] || {};
  return {
    table_id: tid || "n/a (curated or register)",
    source: i.source || cat.label || "",
    source_url: (e ? srcUrl(e, level, null, null) : "") || cat.url || (e && e.table_url) || "",
    licence: cat.licence || "",
    publisher: (e && e.publisher) || "",
  };
}
const asofOf = (i, level, period) => {
  const src = (period && period !== LATEST && i.hist_asof && i.hist_asof[period]) || i.asof || {};
  return src[level] || src.kommun || src.regso || src.deso || "";
};

/* one long-schema row */
function longRow(o, i, level, period, value, opts) {
  const x = opts || {};
  const src = indSource(i, level);
  return {
    level, code: o.code, name: o.name || o.code,
    parent_code: x.parent_code || "", parent_name: x.parent_name || "",
    lan: lanName(x.lan || o.lan) || "",
    population: o.pop != null ? o.pop : "",
    indicator: i.key, label: i.label, unit: i.unit || "",
    period, period_type: XC.periodType(period, { projection: isOutlook(i), scenario: isClimKey(i.key) }),
    /* a coded indicator keeps its number in `value` and gains the word beside it */
    value, value_label: catsOf(i) ? ((catOf(i, value) || {}).label || "") : "",
    margin_of_error: x.moe != null ? x.moe : "",
    value_type: x.value_type || (isOutlook(i) ? "projection" : "actual"),
    inherited_from: x.inherited_from || "",
    direction: dirOf(i),
    source: src.source, table_id: src.table_id, source_url: src.source_url,
    as_of: asofOf(i, level, period), fetched: FETCHED, licence: src.licence,
  };
}
/* every published figure at every level, for every period the build holds */
function rowsAreas() {
  const out = [];
  const emit = (o, level, inds, extra) => {
    for (const i of inds) {
      const periods = new Set(Object.keys((o.hist && o.hist[i.key]) || {}));
      if (o[i.key] != null) periods.add(LATEST);
      for (const t of [...periods].sort()) {
        const v = t === LATEST ? o[i.key] : o.hist[i.key][t];
        if (v == null) continue;
        const m = t === LATEST ? (o[i.key + "_moe"] ?? null) : ((o.hist && o.hist[i.key + "_moe"] && o.hist[i.key + "_moe"][t]) ?? null);
        out.push(longRow(o, i, level, t, v, Object.assign({ moe: m }, extra)));
      }
      /* the quarterly series is a period type of its own, not a year */
      const q = o.q && o.q[i.key];
      if (q) for (const t of Object.keys(q).sort()) { if (q[t] != null) out.push(longRow(o, i, level, t, q[t], extra)); }
      /* and the projected path is labelled as projected, every point of it */
      const f = o.fc && o.fc[i.key];
      if (f) for (const t of Object.keys(f).sort()) {
        if (f[t] == null) continue;
        out.push(longRow(o, i, level, t, f[t], Object.assign({ value_type: "projection" }, extra)));
      }
    }
  };
  MUNI.forEach(m => emit(m, "kommun", IND, { parent_code: "SE", parent_name: "Sweden", lan: m.lan }));
  AREAS.forEach(a => { const m = byCode[a.kommun] || {};
    emit(a, "regso", IND, { parent_code: a.kommun, parent_name: m.name || "", lan: m.lan }); });
  allDeso().forEach(d => { const m = byCode[d.kommun] || {};
    emit(d, "deso", IND, { parent_code: d.regso || d.kommun, parent_name: (byRegso[d.regso] || {}).name || m.name || "", lan: m.lan }); });
  return out;
}
/* what is on this screen, in the same schema */
function rowsView() {
  if (S.view === "pipeline") return rowsProjects();
  if (S.view === "market") return rowsNational();
  if (S.view === "property") return rowsProperty();
  const level = S.view === "table" ? T.level : S.view === "area" ? AR.type : (MK.kommun ? (desoMode() ? "deso" : "regso") : "kommun");
  const list = S.view === "table" ? tableRows() : S.view === "area" ? [(areaEntity() || {}).o].filter(Boolean) : curPool();
  const inds = curInds();
  const out = [];
  for (const o of list) {
    if (!o) continue;
    const m = o.kommun ? byCode[o.kommun] : null;
    for (const i of inds) {
      let v = V(o, i.key), inherited = false, src = o;
      /* the table shows the kommun's figure where a sub-area has none, so the
         export says that in `value_type` rather than repeating it as the area's own */
      if (v == null && m && canInherit(i.key)) { v = V(m, i.key); inherited = v != null; src = m; }
      if (v == null) continue;
      out.push(longRow(o, i, level, MK.year, v, {
        parent_code: o.kommun || "SE", parent_name: m ? m.name : "Sweden",
        lan: m ? m.lan : o.lan, moe: MOE(src, i.key),
        value_type: inherited ? "inherited" : (isOutlook(i) ? "projection" : "actual"),
        inherited_from: inherited ? m.code : "",
      }));
    }
  }
  return out;
}
function rowsProjects() {
  return pipeRows().map(p => ({
    id: p.id, name: p.name, type: p.type, status: p.status,
    open_year: p.open_year || "", open_window: p.open_window || "",
    budget_msek: p.budget_msek != null ? p.budget_msek : "",
    price_base: p.price_base || "", agency: p.agency || "",
    kommuner: kNames(p.kommuner).join("|"), source_url: p.source_url || "", notes: p.notes || "",
  }));
}
/* the national series in the same long schema, at level `sweden` */
function rowsNational() {
  const mac = D.macro || {}, lt = mac.latest || {};
  const out = [];
  for (const [k, ser] of Object.entries(mac.series || {})) {
    const meta = lt[k] || {};
    for (const pt of ser) {
      if (pt.v == null) continue;
      out.push({
        level: "sweden", code: "SE", name: "Sweden", parent_code: "", parent_name: "", lan: "",
        population: "", indicator: k, label: meta.label || k, unit: meta.unit || "",
        period: pt.t, period_type: XC.periodType(pt.t), value: pt.v, value_label: "",
        margin_of_error: "",
        value_type: "actual", inherited_from: "", direction: "", source: meta.src || "",
        table_id: meta.src || "n/a", source_url: "", as_of: meta.t || "", fetched: FETCHED,
        licence: "CC0",
      });
    }
  }
  return out;
}
function rowsSources() {
  return ((D.meta && D.meta.sources) || []).map(x => ({
    key: x.key, label: x.label, publisher: String(x.label || "").split(" ")[0],
    tables: x.tables || "", as_of: x.asof || "", fetched: x.fetched || FETCHED,
    url: x.url || "", licence: x.licence || "",
    used_for: IND.filter(i => (i.src_verify || []).some(e => e.table === x.key)).map(i => i.key).join("|"),
  }));
}
/* the pin: every figure for its finest area, with the property's own columns in
   front so a spreadsheet of several exports sorts by property */
function rowsProperty() {
  const e = PROP.lat != null ? propArea() : null;
  if (!e) return [];
  const label = propName() || "Test property";
  const pe = propEntity() || {};
  const out = [];
  for (const i of e.inds) {
    const got = propVal(i.key);
    if (!got) continue;
    const own = got.own;
    const row = longRow(got.o, i, own ? e.type : "kommun", MK.year, got.v, {
      parent_code: e.kommun ? e.kommun.code : "SE", parent_name: e.kommun ? e.kommun.name : "Sweden",
      lan: e.lan, moe: MOE(got.o, i.key),
      value_type: own ? (isOutlook(i) ? "projection" : "actual") : "inherited",
      inherited_from: own ? "" : (pe.kommun ? pe.kommun.code : ""),
    });
    out.push(Object.assign({ property_label: label, lat: PROP.lat, lon: PROP.lon }, row));
  }
  return out;
}
/* The summary strip, as rows — the same `stripItems()` model the page draws, so
   the file and the screen cannot disagree. They lead the Nearby file because they
   are the answers, and the thousand rows under them are the working.
   `status` carries the figure in words (the strip's own value and sub, which is
   where "Not mapped", "too few to publish" and "unavailable" live — none of which
   is a number), and `distance_m` is filled only where the figure IS a distance. */
function rowsStrip() {
  return stripItems().map(it => ({
    kind: "summary", name: it.label, type: "summary strip",
    status: it.sub ? `${it.value} — ${it.sub}` : it.value,
    distance_m: it.dist != null ? it.dist : "",
    rent: "", m2: "", rooms: "", source: it.src, source_url: it.src_url || "",
  }));
}
/* everything the pin can see around it, one row per thing, with its distance */
function rowsNearby() {
  if (PROP.lat == null) return [];
  const out = [];
  for (const p of pointsNear(SRV_SET)) out.push({ kind: "service", name: p.name || SRV_CATS[p.cat][0],
    type: SRV_CATS[p.cat][0], status: "", distance_m: p.m, rent: "", m2: "", rooms: "",
    source: `OpenStreetMap (${p.tag})`, source_url: "https://www.openstreetmap.org/copyright" });
  for (const p of pointsNear(PUB_SET)) out.push({ kind: "public", name: p.name || SRV_CATS[p.cat][0],
    type: SRV_CATS[p.cat][0], status: "", distance_m: p.m, rent: "", m2: "", rooms: "",
    source: `OpenStreetMap (${p.tag})`, source_url: "https://www.openstreetmap.org/copyright" });
  for (const { s, m } of propSchoolsNear(10)) out.push({ kind: "school", name: s.name, type: "year 9",
    status: s.merit != null ? `merit ${nf(s.merit, 1)}` : "merit not published", distance_m: Math.round(m),
    rent: "", m2: "", rooms: "", source: "Skolverket", source_url: "https://www.skolverket.se/" });
  infraLoad();
  for (const f of (INFRA_GEO.data ? INFRA_GEO.data.features || [] : [])) {
    if (!f.geometry) continue;
    let best = Infinity;
    const scan = pts => { for (const [lon, lat] of pts) { const d = havM(PROP.lat, PROP.lon, lat, lon); if (d < best) best = d; } };
    if (f.geometry.type === "MultiLineString") f.geometry.coordinates.forEach(scan);
    else if (f.geometry.type === "Point") scan([f.geometry.coordinates]);
    else scan(f.geometry.coordinates);
    if (best > Math.max(PROP.rad, 2000)) continue;
    out.push({ kind: "infra", name: f.properties.name, type: f.properties.type || "", status: f.properties.status || "",
      distance_m: Math.round(best), rent: "", m2: "", rooms: "", source: f.properties.agency || "curated",
      source_url: f.properties.source_url || "" });
  }
  /* the advertised rent, never an own rent: this dashboard has no business
     knowing what anybody pays */
  for (const l of lstNearPin(LST.rows)) out.push({ kind: "listing", name: l.address || "", type: l.src_label || l.src,
    status: l.allocation === "queue" ? "queue" : "direct", distance_m: l.dist_m != null ? l.dist_m : "",
    rent: l.rent_sek_mo != null ? l.rent_sek_mo : "", m2: l.size_m2 != null ? l.size_m2 : "",
    rooms: l.rooms != null ? l.rooms : "", source: `advertised, ${l.src_label || l.src}`, source_url: l.url || "" });
  out.sort((a, b) => (a.distance_m || 0) - (b.distance_m || 0));
  /* the strip's seven rows first, in the order the page shows them */
  return rowsStrip().concat(out);
}

const EXPORTS = {
  view:     { label: "This view (CSV)", rows: rowsView, cols: () => (S.view === "pipeline" ? XC.PROJECT_COLUMNS : S.view === "property" ? XC.PROPERTY_LEAD.concat(XC.LONG_COLUMNS) : XC.LONG_COLUMNS), file: () => `view_${S.view}` },
  areas:    { label: "All area data (long)", rows: rowsAreas, cols: () => XC.LONG_COLUMNS, file: () => "areas_long" },
  projects: { label: "Projects", rows: rowsProjects, cols: () => XC.PROJECT_COLUMNS, file: () => "projects", when: () => (INFRA.projects || []).length > 0 },
  national: { label: "National series", rows: rowsNational, cols: () => XC.LONG_COLUMNS, file: () => "national_series" },
  property: { label: "Test property", rows: rowsProperty, cols: () => XC.PROPERTY_LEAD.concat(XC.LONG_COLUMNS), file: () => "test_property", when: () => PROP.lat != null },
  nearby:   { label: "Nearby", rows: rowsNearby, cols: () => XC.NEARBY_COLUMNS, file: () => "test_property_nearby", when: () => PROP.lat != null },
  sources:  { label: "Sources catalogue", rows: rowsSources, cols: () => XC.SOURCES_COLUMNS, file: () => "sources" },
};
const EXPORT_ORDER = ["view", "areas", "projects", "national", "property", "nearby", "sources"];
/* An item the reader would get an empty file from is offered but disabled, with
   the reason on it, rather than hidden — "where did Test property go" is a worse
   question than "why is it greyed out". */
function exportItems() {
  return EXPORT_ORDER.map(id => {
    const x = EXPORTS[id];
    const off = x.when && !x.when()
      ? (id === "property" || id === "nearby" ? "drop a pin on Test property first" : "nothing to export in this build")
      : null;
    return { id, label: x.label, off };
  });
}
/* the rows a test can read without downloading a file */
function exportRows(id) {
  const x = EXPORTS[id]; if (!x) return null;
  return XC.toCsv(x.rows(), x.cols());
}
/* DeSO ships as one file per kommun and is fetched when a kommun is opened, so
   "All area data" would otherwise mean "all of it that happens to be in memory".
   The export fetches the rest first and says that it is doing so. */
function loadAllDeso() {
  const missing = Object.keys(DESO_IDX).filter(c => !DESO[c]);
  if (!missing.length) return Promise.resolve(0);
  toast(`Fetching ${missing.length} DeSO files so the export is complete…`);
  return Promise.all(missing.map(c => fetch(DESO_IDX[c].file)
    .then(r => (r.ok ? r.json() : null))
    .then(j => { if (!j) return; DESO[c] = j.areas || [];
                 DESO[c].forEach(a => { GC.decodeEntity(a); byDeso[a.code] = a; }); })
    .catch(() => {}))).then(() => missing.length);
}
/* The RegSO figures are one file, so "All area data" waits for it rather than
   writing a CSV whose RegSO rows happen to be whatever the reader had opened.
   No rings are fetched: the export has no geometry column. */
function loadAllRegso() {
  if (RG.vals) return Promise.resolve(false);
  toast("Fetching the RegSO figures so the export is complete…");
  return new Promise(res => regsoLoadVals(() => res(true)));
}
function runExport(id) {
  const x = EXPORTS[id]; if (!x) return;
  if (id === "areas") { Promise.all([loadAllRegso(), loadAllDeso()]).then(() => writeExport(id)); return; }
  /* the view's own rows can be a RegSO table or a RegSO page, and those are
     already on screen only once the pool is here — but a link straight to
     Export ▾ must not write a file of blanks */
  if (id === "view" && !RG.vals && (T.level === "regso" || AR.type === "regso")) {
    loadAllRegso().then(() => writeExport(id)); return;
  }
  writeExport(id);
}
function writeExport(id) {
  const x = EXPORTS[id]; if (!x) return;
  const rows = x.rows();
  const bad = XC.unitProblems(rows);
  if (bad.length) {
    /* Loud, and the file is still written: refusing to export would hide the
       problem, and writing it silently would publish it. */
    console.warn(`export ${id}: ${bad.length} row(s) whose unit and magnitude disagree`, bad.slice(0, 5));
    toast(`${x.label}: ${bad.length} row(s) flagged — unit and magnitude disagree (see the console)`);
  }
  downloadCsv(XC.toCsv(rows, x.cols()), XC.fileName(x.file(), BUILT));
  if (!bad.length) toast(`${XC.fileName(x.file(), BUILT)} · ${nf(rows.length, 0)} rows`);
}
/* every unit/magnitude disagreement in everything this build can export */
function exportUnitProblems() {
  const out = [];
  for (const id of EXPORT_ORDER) {
    const x = EXPORTS[id];
    if (x.when && !x.when()) continue;
    for (const p of XC.unitProblems(x.rows())) out.push(Object.assign({ file: id }, p));
  }
  return out;
}
let TOAST_T = null;
function toast(msg) {
  let el = document.getElementById("toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add("on");
  if (TOAST_T) clearTimeout(TOAST_T);
  TOAST_T = setTimeout(() => el.classList.remove("on"), 4000);
}

parseHash();
render();
/* The RegSO figures, once the first paint is out of the way.
   Every surface but the bare national map wants them — a drill-down, an area
   page, the Data table, a rank, the export — and holding them back until one of
   those is opened only moves the wait to the click. They are ~1 MB over the
   wire against the 12 MB they used to add to this file, and the map on screen is
   drawn entirely from geometry the page already carries, so nothing on it is
   waiting for this. The per-kommun RING files stay strictly on demand. */
setTimeout(regsoLoadVals, 0);
/* the map is sized to the window rather than to a guess in the stylesheet */
fitMapHeight();
window.addEventListener("resize", () => { if (MAP_H_T) clearTimeout(MAP_H_T); MAP_H_T = setTimeout(fitMapHeight, 120); });
