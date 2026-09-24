/* Headless smoke test for src/app.js.
 *
 * There is no browser here, so this puts app.js behind a DOM small enough to
 * boot it and then renders every view with the real window.DATA out of
 * dist/index.html. It does not check how anything looks — it checks that each
 * view builds its HTML without throwing, which is what silently broke most
 * often while porting from the Danish edition.
 *
 * Usage: node tests/smoke.js   (after `make build`)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist", "index.html");
if (!fs.existsSync(DIST)) {
  console.error("dist/index.html missing — run `make build` first");
  process.exit(1);
}

const html = fs.readFileSync(DIST, "utf8");
const MARK = "window.DATA = ";
const at = html.indexOf(MARK);
const end = at < 0 ? -1 : html.indexOf(";</script>", at);
if (at < 0 || end < 0) { console.error("could not find window.DATA in dist/index.html"); process.exit(1); }
/* build_dashboard escapes the sequence that would close the tag early */
const DATA = JSON.parse(html.slice(at + MARK.length, end).replace(/<\\\//g, "</"));
const appJs = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
/* testprop.js is inlined ahead of app.js in the built page, so the sandbox has
   to load it in the same order — app.js calls parseLocation. */
const tpJs = fs.readFileSync(path.join(ROOT, "src", "testprop.js"), "utf8");

/* ---- the smallest DOM that lets app.js boot ---- */
function el(id) {
  return {
    id, innerHTML: "", textContent: "", style: {}, value: "", checked: false, open: false,
    dataset: {}, classList: { contains: () => false, add() {}, remove() {}, toggle() {} },
    children: [], scrollTop: 0,
    appendChild() {}, removeChild() {}, remove() {}, setAttribute() {}, removeAttribute() {},
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 600, bottom: 600, right: 800 }),
    closest: () => null, focus() {}, blur() {}, insertAdjacentHTML() {}, click() {},
  };
}
const nodes = {};
const document = {
  getElementById: id => (nodes[id] = nodes[id] || el(id)),
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: tag => el(tag),
  addEventListener() {},
  body: el("body"),
  documentElement: el("html"),
};
const listeners = {};
const window = {
  DATA,
  addEventListener: (k, f) => { (listeners[k] = listeners[k] || []).push(f); },
  location: { hash: "#map" },
  history: { replaceState() {}, back() {} },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  devicePixelRatio: 1,
  requestAnimationFrame: f => f(),
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
};
/* Leaflet is only touched once a map is actually created; every view under test
   calls setTimeout(lfInit) rather than building a map inline, and setTimeout is
   a no-op here, so a stub that never returns a real map is enough. */
const Lstub = new Proxy(function () {}, {
  get: () => Lstub, apply: () => Lstub, construct: () => Lstub,
});

const sandbox = {
  window, document, location: window.location, history: window.history,
  L: Lstub, console,
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
  requestAnimationFrame: f => f(), fetch: () => Promise.resolve({ ok: false }),
  navigator: { userAgent: "node", clipboard: { writeText: () => Promise.resolve() } },
  Blob: function () {}, URL: { createObjectURL: () => "blob:", revokeObjectURL() {} },
  Intl, Math, JSON, Date, Number, String, Array, Object, RegExp, Error, Map, Set, Proxy,
  encodeURIComponent, decodeURIComponent, isNaN, parseFloat, parseInt,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

let failures = 0;
function check(name, fn) {
  try {
    const out = fn();
    if (typeof out === "string" && out.includes("undefined undefined")) {
      console.log(`  ✗ ${name}: rendered "undefined undefined"`);
      failures++;
      return;
    }
    console.log(`  ✓ ${name}${typeof out === "string" ? ` (${out.length} chars)` : ""}`);
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    if (process.env.SMOKE_TRACE) console.log(e.stack.split("\n").slice(0,6).join("\n"));
    failures++;
  }
}

/* app.js declares everything with const/let, which are lexical bindings and do
   not become properties of globalThis — so the test appends one line, inside the
   same scope, handing out exactly what it needs to drive. */
const EXPORTS = "\n;globalThis.__app = { D, S, MK, AR, T, CH, vMakro, vTable, vArea, vCharts, vMarket, exportCsv, byCode, byRegso, distValues, pageOf };\n";
try {
  vm.runInContext(tpJs, sandbox, { filename: "testprop.js" });
  vm.runInContext(appJs + EXPORTS, sandbox, { filename: "app.js" });
} catch (e) {
  console.error("app.js threw while loading:", e.message);
  process.exit(1);
}

const A = sandbox.__app;
const S = A.S, MK = A.MK, AR = A.AR, T = A.T, CH = A.CH, D = A.D;

console.log(`\ndata: ${D.kommuner.length} kommuner · ${D.regso.length} RegSO · ` +
            `${Object.keys(D.deso_index).length} DeSO files · ${D.indicators.length} indicators\n`);

console.log("views:");
S.view = "makro"; MK.kommun = null;
check("map, national", () => A.vMakro());
MK.kommun = "0180";
check("map, Stockholm drilled", () => A.vMakro());
MK.kommun = null;

S.view = "table";
for (const lvl of ["kommun", "regso"]) {
  T.level = lvl;
  check(`table / ${lvl}`, () => A.vTable());
}

S.view = "market";
check("market", () => A.vMarket());

S.view = "charts";
CH.areas = ["kommun:0180", "kommun:1480"];
check("charts, two kommuner", () => A.vCharts());
CH.mode = "dist"; CH.dist = "age";
check("charts, age distribution", () => A.vCharts());
CH.mode = "auto";

S.view = "area";
AR.type = "kommun"; AR.code = "0180"; AR.tab = "ind";
check("area page, kommun (indicators)", () => A.vArea());
AR.tab = "dist";
check("area page, kommun (structure)", () => A.vArea());
AR.tab = "sub";
check("area page, kommun (sub-areas)", () => A.vArea());
const someRegso = D.regso.find(r => r.kommun === "0180");
AR.type = "regso"; AR.code = someRegso.code; AR.tab = "ind";
check(`area page, RegSO ${someRegso.name}`, () => A.vArea());
AR.tab = "dist";
check("area page, RegSO (structure)", () => A.vArea());

console.log("\nexports:");
S.view = "table"; T.level = "kommun";
check("CSV of the table view", () => { A.exportCsv(); return "ok"; });

/* ---- data assertions the dashboard is supposed to honour ---- */
console.log("\ndata contract:");
const byCode = A.byCode;
function assert(name, cond, detail) {
  if (cond) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  else { console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); failures++; }
}
const sthlm = byCode["0180"], mala = byCode["2418"];
assert("Stockholm rent 1710", sthlm.rent === 1710, `got ${sthlm.rent}`);
assert("Stockholm rent margin ±28", sthlm.rent_moe === 28, `got ±${sthlm.rent_moe}`);
assert("Malå rent suppressed (absent, not 0)", sthlm.rent != null && mala.rent == null,
       `Malå rent = ${JSON.stringify(mala.rent)}`);
const sub = D.regso.filter(r => r.kommun === "0180");
const distinct = new Set(sub.map(r => r.income_med).filter(v => v != null));
assert("RegSO carry their own values, not the kommun's",
       distinct.size > 50 && !sub.every(r => r.income_med === sthlm.income_med),
       `${distinct.size} distinct income_med across ${sub.length} RegSO in Stockholm`);
const nulls = D.kommuner.filter(k => k.rent === 0).length;
assert("no rent rendered as 0", nulls === 0, `${nulls} kommuner with rent === 0`);
assert("macro has the Riksbank series",
       !!(D.macro.series && D.macro.series.policy_rate && D.macro.series.bond_10y),
       `policy_rate=${(D.macro.latest.policy_rate || {}).v} · bond_10y=${(D.macro.latest.bond_10y || {}).v}`);
/* bme had no data in v1.0; it is asserted properly under "Boverket BME" below. */
assert("every registered indicator either has data or says why",
       D.indicators.every(i => Object.keys(i.asof || {}).length > 0),
       D.indicators.filter(i => !Object.keys(i.asof || {}).length).map(i => i.key).join(", ") || "all have data");

/* ---- what actually reaches the HTML ---- */
console.log("\nrendered output:");
S.view = "table"; T.level = "kommun"; MK.ind = "rent";
const tbl = A.vTable();
assert("the ± is rendered, not just carried", tbl.includes("±28"), "Stockholm rent ±28 in the table");
assert("a suppressed value renders as –", />–</.test(tbl), "Malå row shows –");
assert("a margin too wide for the indicator is flagged", tbl.includes("moe wide"),
       `${(tbl.match(/moe wide/g) || []).length} kommuner greyed for a wide margin`);

S.view = "area"; AR.type = "kommun"; AR.code = "0180"; AR.tab = "ind";
assert("the ± reaches the area page too", A.vArea().includes("±"), "Stockholm page");

/* ---- the DeSO layer actually loads and renders ---- */
console.log("\nDeSO on demand:");
const desoFile = path.join(ROOT, "dist", "deso", "0180.json");
assert("per-kommun file exists", fs.existsSync(desoFile), "dist/deso/0180.json");
if (fs.existsSync(desoFile)) {
  const d = JSON.parse(fs.readFileSync(desoFile, "utf8"));
  /* feed the cache exactly the way loadDeso would */
  A.D.__none = null;
  const DESO = vm.runInContext("DESO", sandbox), byDeso = vm.runInContext("byDeso", sandbox);
  DESO["0180"] = d.areas; d.areas.forEach(a => byDeso[a.code] = a);
  assert("file carries areas with values", d.areas.length > 100 && d.areas[0].income_med != null,
         `${d.areas.length} DeSO, first income_med = ${d.areas[0].income_med}`);
  const dvals = new Set(d.areas.map(a => a.income_med).filter(v => v != null));
  assert("DeSO carry their own values", dvals.size > 100, `${dvals.size} distinct income_med`);
  S.view = "makro"; MK.kommun = "0180"; MK.sub = "deso";
  check("map, Stockholm as DeSO", () => A.vMakro());
  S.view = "area"; AR.type = "deso"; AR.code = d.areas[0].code; AR.tab = "ind";
  check(`area page, DeSO ${d.areas[0].code.split("_")[0]}`, () => A.vArea());
  AR.tab = "dist";
  check("area page, DeSO (structure)", () => A.vArea());
  S.view = "table"; T.level = "deso";
  check("table / deso", () => A.vTable());
  MK.sub = "regso"; MK.kommun = null;
}

/* ---- v1.0 fixes ---- */
console.log("\nformats:");
/* Every indicator's own fmt must be used. FMT used to be the Danish table, so
   every ksek/sek0/ratio2 indicator fell through to pct1 and a median income
   rendered as "380,8 %" — in the popup, the tiles, the table and the charts. */
const FMTS = vm.runInContext("FMT", sandbox), fmtOf = vm.runInContext("fmtOf", sandbox);
const missing = D.indicators.filter(i => !FMTS[i.fmt]).map(i => `${i.key}:${i.fmt}`);
assert("every indicator's fmt exists", missing.length === 0, missing.join(", ") || "all defined");
const medInd = D.indicators.find(i => i.key === "income_med");
const medTxt = fmtOf(medInd)(byCode["0180"].income_med);
assert("median income is not rendered as a percentage", !/%/.test(medTxt), `renders as "${medTxt}"`);

/* ---- v1.2 direction ----
   The same class of trap as the fmt fallback: a missing `direction` would not
   throw, it would silently rank the worst kommun #1 and paint a rise in
   unemployment green. */
console.log("\ndirection:");
const DIRS = ["higher_better", "lower_better", "neutral"];
const badDir = D.indicators.filter(i => !DIRS.includes(i.direction)).map(i => `${i.key}:${i.direction}`);
assert("every indicator declares a valid direction", badDir.length === 0, badDir.join(", ") || `all ${D.indicators.length} declared`);

const rankOf = vm.runInContext("rankOf", sandbox);
const clsFn = vm.runInContext("cls", sandbox);
const MUNI_ = vm.runInContext("MUNI", sandbox);
/* unemployment is lower_better: the kommun with the lowest rate must rank #1 */
const un = MUNI_.filter(m => m.unemp != null).sort((a, b) => a.unemp - b.unemp);
if (un.length > 2) {
  const best = rankOf(un[0], "unemp", MUNI_), worst = rankOf(un[un.length - 1], "unemp", MUNI_);
  assert("lower_better ranks the lowest unemployment #1",
    best.r === 1 && worst.r === un.length, `lowest #${best.r}, highest #${worst.r} of ${best.n}`);
}
/* income is higher_better: the highest must rank #1 */
const inc = MUNI_.filter(m => m.income_med != null).sort((a, b) => b.income_med - a.income_med);
if (inc.length > 2) {
  const top = rankOf(inc[0], "income_med", MUNI_);
  assert("higher_better ranks the highest income #1", top.r === 1, `#${top.r} of ${top.n}`);
}
assert("a rise in unemployment is not green", clsFn(1.5, "unemp") === "dn", `cls = "${clsFn(1.5, "unemp")}"`);
assert("a fall in unemployment is green", clsFn(-1.5, "unemp") === "up", `cls = "${clsFn(-1.5, "unemp")}"`);
assert("a rise in income is green", clsFn(1.5, "income_med") === "up", `cls = "${clsFn(1.5, "income_med")}"`);
assert("a neutral indicator gets no good/bad colour", clsFn(1.5, "flats") === "", `cls = "${clsFn(1.5, "flats")}"`);
/* ---- v1.2 Outlook ----
   A projection is not an observation. The trap to guard is the projected years
   leaking into the dashboard's year selector, which would offer every other
   indicator years for which no observation exists. */
console.log("\noutlook:");
const FC = D.indicators.filter(i => i.outlook);
assert("seven Outlook indicators", FC.length === 7, FC.map(i => i.key).join(", "));
assert("all at kommun level", FC.every(i => i.level === "kommun"), "kommun");
assert("none is a score", FC.every(i => i.direction === "neutral"), "all neutral");
const fcCover = D.kommuner.filter(k => k.fc_growth != null).length;
assert("every kommun has a projection", fcCover === D.kommuner.length, `${fcCover} of ${D.kommuner.length}`);

const projYears = ["2027", "2030", "2035", "2040"];
const leaked = projYears.filter(y => (D.meta.years || []).includes(y));
assert("projected years stay out of the year selector", leaked.length === 0,
  leaked.join(", ") || `years end at ${(D.meta.years || []).slice(-1)[0]}`);
assert("the projected series lives in fc, not hist",
  D.kommuner.every(k => !(k.hist && k.hist.fc_abs)), "no fc_abs in hist");
const fcSthlm = byCode["0180"];
assert("the projected series is there for the chart",
  fcSthlm.fc && fcSthlm.fc.fc_abs && Object.keys(fcSthlm.fc.fc_abs).length === 15,
  `${Object.keys((fcSthlm.fc || {}).fc_abs || {}).length} projected years`);

/* the five figures recomputed from the API in scripts/verify_outlook.py */
const near = (a, b, t) => Math.abs(a - b) <= t;
assert("Stockholm 2040 projection", near(fcSthlm.fc_abs, 1041998.0, 1), `${fcSthlm.fc_abs}`);
assert("Stockholm growth 2026→2040", near(fcSthlm.fc_growth, 4.963, 0.01), `${fcSthlm.fc_growth} %`);
assert("Malå shrinks", byCode["2418"].fc_growth < 0, `${byCode["2418"].fc_growth} %`);
/* Ageing is near-universal but NOT universal: Hällefors (1863) is projected to
   shrink 8.2 % overall, and its 80+ cohort with it, -1.38 %. Verified straight
   from the API. The assertion says 289 of 290 rather than "every", because the
   first draft said "every" and was simply wrong about the data. */
const up80 = D.kommuner.filter(k => k.fc_80p != null && k.fc_80p > 0).length;
const has80 = D.kommuner.filter(k => k.fc_80p != null).length;
assert("ageing shows up in all but one kommun", up80 === has80 - 1, `${up80} of ${has80} rise`);
assert("and the exception is Hällefors, which is shrinking overall",
  byCode["1863"].fc_80p < 0 && byCode["1863"].fc_growth < -5,
  `80+ ${byCode["1863"].fc_80p.toFixed(2)} %, total ${byCode["1863"].fc_growth.toFixed(1)} %`);
/* a projection may be negative, and the diverging scale is what shows that */
assert("growth is diverging, centred on flat",
  FC.filter(i => i.scale === "diverging").every(i => i.center === 0), "centre 0");

const outlookLine = vm.runInContext("outlookLine", sandbox);
assert("the Outlook line names the projection and its date",
  /SCB trend projection, published 2024-06-11/.test(outlookLine(fcSthlm, false)), "labelled");
assert("below kommun it is marked as inherited",
  /Outlook\s*°/.test(outlookLine(fcSthlm, true)), "° present");

/* ---- v1.2 Safety ----
   Reported offences are a lower_better indicator, which is the whole reason
   Phase 1 had to land first: before direction awareness the kommun with the
   most crime ranked #1. */
console.log("\nsafety:");
const SAF = D.indicators.filter(i => i.group === "Safety");
assert("eight Safety indicators", SAF.length === 8, SAF.map(i => i.key).join(", "));
const crimeInds = SAF.filter(i => i.key !== "vulnerable_area_share" && i.key !== "crime_trend");
assert("reported offences are lower_better",
  crimeInds.every(i => i.direction === "lower_better"), crimeInds.length + " indicators");
const crimeCov = D.kommuner.filter(k => k.crime_1000 != null).length;
assert("every kommun has crime data", crimeCov === 290, `${crimeCov} of 290`);

/* the five kommuner recomputed from a fresh Brå session in verify_bra.py */
const near2 = (a, b, t) => a != null && Math.abs(a - b) <= t;
assert("Stockholm 2025 reported offences", near2(byCode["0180"].crime_1000, 191.59, 0.01),
  `${byCode["0180"].crime_1000} per 1 000`);
assert("Göteborg 2025", near2(byCode["1480"].crime_1000, 138.78, 0.01), `${byCode["1480"].crime_1000}`);
assert("Malmö 2025", near2(byCode["1280"].crime_1000, 161.83, 0.01), `${byCode["1280"].crime_1000}`);
assert("Stockholm burglary per 1 000 dwellings",
  near2(byCode["0180"].burglary_1000dw, 11.168, 0.01), `${byCode["0180"].burglary_1000dw}`);

/* Heby moved län in 2007 and Brå keeps the two entities apart; we take the
   current one, so its series must start at 2007 and never before */
const hebyYears = Object.keys((byCode["0331"].hist || {}).crime_1000 || {}).sort();
assert("Heby's series starts no earlier than 2007", hebyYears[0] >= "2007",
  `starts ${hebyYears[0]}`);

/* quarters exist for the headline indicator, and they are what the toggle needs */
const crimeInd = D.indicators.find(i => i.key === "crime_1000");
assert("crime has quarterly periods", (crimeInd.q_periods || []).length === 48,
  `${(crimeInd.q_periods || []).length} quarters`);
assert("and a kommun carries them", Object.keys((byCode["0180"].q || {}).crime_1000 || {}).length === 48,
  `${Object.keys((byCode["0180"].q || {}).crime_1000 || {}).length} quarters on Stockholm`);

/* clearance is national only — it must NOT appear as a kommun indicator */
assert("no clearance indicator, because Brå does not publish it per kommun",
  !D.indicators.some(i => /clearance|uppklar/i.test(i.key)), "absent, as logged");

/* the police designation: a flag with two classes, never 0 for 'not designated' */
const uso = D.regso.filter(a => a.vulnerable_area_share != null);
assert("RegSO areas carry a designation share", uso.length > 100, `${uso.length} RegSO`);
assert("an undesignated area has no value rather than 0",
  D.regso.some(a => a.vulnerable_area_share == null) &&
  !D.regso.some(a => a.vulnerable_area_share === 0), "null, not 0");
assert("two classes only — riskområde is gone",
  new Set(uso.map(a => a.vulnerable_area_share_class)).size <= 2,
  [...new Set(uso.map(a => a.vulnerable_area_share_class))].join(", "));
/* the designation must never be inherited: showing Stockholm's 4.4 % on every
   RegSO in the city would say all of them are designated */
const eValFn = vm.runInContext("eVal", sandbox);
const usoInd = D.indicators.find(i => i.key === "vulnerable_area_share");
assert("the designation refuses to be inherited", usoInd.no_inherit === true, "no_inherit");
const plainRegso = D.regso.find(a => a.kommun === "0180" && a.vulnerable_area_share == null);
if (plainRegso) {
  const got = eValFn({ o: plainRegso, type: "regso", kommun: byCode["0180"] }, "vulnerable_area_share");
  assert("an undesignated RegSO in Stockholm stays blank", got.v === null,
    `got ${got.v}, own=${got.own}`);
  /* contrast: a kommun-only indicator DOES still reach a RegSO, marked ° —
     the no_inherit flag must be specific to the designation, not a global change */
  const inc = eValFn({ o: plainRegso, type: "regso", kommun: byCode["0180"] }, "kommun_tax");
  assert("but a kommun-only indicator still inherits with °", inc.v != null && inc.own === false,
    `kommun_tax ${inc.v}, own=${inc.own}`);
}

const usoLine = vm.runInContext("usoLine", sandbox);
assert("the designation line carries its date",
  /Police-designated vulnerable area \(Dec 2025\)/.test(usoLine(uso[0])), "dated");
assert("and no line at all where there is no designation",
  usoLine(D.regso.find(a => a.vulnerable_area_share == null)) === "", "empty");

/* ---- v1.2 Schools ----
   The trap here is a suppressed value becoming a zero: Skolverket withholds a
   figure when too few pupils sat it, and a zero merit value would drag an area
   average down and colour the map wrong. */
console.log("\nschools:");
const SCHI = D.indicators.filter(i => i.group === "Schools");
assert("eight Schools indicators", SCHI.length === 8, SCHI.map(i => i.key).join(", "));
assert("none of them is a quick chip", SCHI.every(i => i.chip !== true), "hidden from the chip row");
assert("the schools manifest ships", Object.keys(D.schools_index || {}).length === 290,
  `${Object.keys(D.schools_index || {}).length} kommuner`);
const totalSchools = Object.values(D.schools_index).reduce((a, b) => a + b.n, 0);
assert("1 791 schools with year 9 and coordinates", totalSchools === 1791, `${totalSchools}`);
/* 289 of 290, not all: Robertsfors has a single year-9 school and Skolverket
   publishes nothing for it — the API returns null for merit, pass rate and even
   the pupil band. That is a real gap in the source, and it must stay a gap
   rather than become a zero. */
assert("289 of 290 kommuner have a merit value",
  D.kommuner.filter(k => k.school_merit != null).length === 289,
  `${D.kommuner.filter(k => k.school_merit != null).length} of 290`);
assert("and the gap is Robertsfors, blank rather than zero",
  byCode["2409"].school_merit == null && byCode["2409"].schools_n === 1,
  `merit ${byCode["2409"].school_merit}, ${byCode["2409"].schools_n} school`);

/* five schools recomputed one by one in scripts/verify_schools.py */
assert("Stockholm's pupil-weighted merit value", near2(byCode["0180"].school_merit, 256.2, 0.1),
  `${byCode["0180"].school_merit}`);
assert("the national pupil-weighted merit value is published with the build",
  near2((D.schools_meta || {}).national_merit, 233.2, 0.1), `${(D.schools_meta || {}).national_merit}`);

/* a merit value must be a plausible merit value, never 0 */
const merits = D.kommuner.map(k => k.school_merit).filter(v => v != null);
assert("no kommun has a zero merit value", merits.every(v => v > 100),
  `min ${Math.min(...merits).toFixed(1)}, max ${Math.max(...merits).toFixed(1)}`);
assert("and none exceeds the 340 maximum", merits.every(v => v <= 340), `max ${Math.max(...merits)}`);

/* SALSA is not shipped, and must not appear by accident */
assert("no SALSA indicator — it has no bulk export",
  !D.indicators.some(i => /salsa/i.test(i.key + i.label)), "absent, as logged");
assert("and every school indicator says the merit value is raw",
  SCHI.filter(i => /merit|passed|eligible/.test(i.key)).every(i => /NOT adjusted|not adjusted/i.test(i.warn || "")),
  "caveat present");

/* Skolenkäten runs on a rotation, so its as-of is two years, not one */
const tryg = D.indicators.find(i => i.key === "school_trygghet");
assert("the survey's as-of names both rounds", /2025\+2026/.test(tryg.asof.kommun || ""),
  tryg.asof.kommun);

/* ---- v1.2 the dropped pin ----
   locate() is exercised here against the real lookup files rather than mocked:
   point-in-polygon with holes is the kind of code that is either right or
   embarrassingly wrong, and the only way to know is to drop pins on places
   whose answer is known. */
console.log("\ntest property:");
const lookKom = JSON.parse(fs.readFileSync(path.join(ROOT, "dist", "lookup_kommuner.json"), "utf8"));
const ringHas = vm.runInContext("ringHas", sandbox);
const inPolyFn = vm.runInContext("inPoly", sandbox);
const areaAtPoint = vm.runInContext("areaAtPoint", sandbox);
const havMFn = vm.runInContext("havM", sandbox);

const pinCases = [
  ["Stadshuset, Stockholm", 59.3275, 18.0543, "0180"],
  ["Avenyn, Göteborg", 57.70135, 11.9746, "1480"],
  ["Turning Torso, Malmö", 55.6135, 12.9769, "1280"],
  ["Uppsala domkyrka", 59.858, 17.6333, "0380"],
  ["Kiruna", 67.8557, 20.2253, "2584"],
  ["Visby, Gotland", 57.634, 18.295, "0980"],
];
let pinOk = 0;
for (const [name, lat, lon, want] of pinCases) {
  const got = areaAtPoint(lookKom, lat, lon);
  if (got && got.code === want) pinOk++;
  else console.log(`    ! ${name}: got ${got ? got.code : "none"}, expected ${want}`);
}
assert("a pin lands in the right kommun", pinOk === pinCases.length,
  `${pinOk} of ${pinCases.length} landmarks`);

/* Out at sea there is no kommun, because the boundaries were clipped to the
   coastline. In a LAKE there is one, because Swedish kommun boundaries really
   do divide the inland lakes between the kommuner around them — Vättern belongs
   to Karlsborg and its neighbours. Those two are different answers and the test
   says so, because the first draft of it called the lake a bug. */
assert("a pin in the Baltic belongs to no kommun",
  areaAtPoint(lookKom, 58.5, 19.5) === null, "no area at sea");
const lake = areaAtPoint(lookKom, 58.4, 14.55);
assert("but a pin in Vättern does, as the administrative boundaries do",
  lake !== null, lake ? `${lake.code} ${lake.name}` : "none");

/* holes must actually subtract */
const square = [[[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]],
                [[4, 4], [4, 6], [6, 6], [6, 4], [4, 4]]];
assert("a point inside the shell is inside", inPolyFn(square, 1, 1) === true, "shell");
assert("a point inside a hole is NOT inside", inPolyFn(square, 5, 5) === false, "hole subtracted");
assert("a point outside is outside", inPolyFn(square, 20, 20) === false, "outside");

/* the distance helper, against a known separation */
const dKm = havMFn(59.3275, 18.0543, 57.70135, 11.9746) / 1000;
assert("Stockholm to Göteborg is about 400 km", dKm > 390 && dKm < 410, `${dKm.toFixed(0)} km`);

/* the parser is inlined into the page, not only available to node --test */
assert("testprop is inlined into the built page", /function parseLocation/.test(html),
  "parseLocation present");
const parseLoc = vm.runInContext("parseLocation", sandbox);
assert("and the page can parse a Swedish Maps link",
  (parseLoc("https://www.google.com/maps/@59.31972,18.07194,17z") || {}).lat === 59.31972, "parsed");
assert("and refuses a short link by name",
  (parseLoc("https://maps.app.goo.gl/x") || {}).error === "short_link", "refused");

/* A signed format prints its own sign, so signing the difference again gave
   "++6,8 %" in the compare column. */
const fmtAbsFn = vm.runInContext("fmtAbs", sandbox);
const signedInd = D.indicators.find(i => i.fmt === "signpct1");
assert("a signed format is not signed twice in the compare column",
  !/^[+\-−]/.test(fmtAbsFn(signedInd, 6.8)), `fmtAbs -> "${fmtAbsFn(signedInd, 6.8)}"`);
assert("and a magnitude is used, not the raw value",
  fmtAbsFn(signedInd, -6.8) === fmtAbsFn(signedInd, 6.8), "magnitude");

/* the Analysis view renders with and without a pin */
S.view = "analysis";
const AN_ = vm.runInContext("AN", sandbox);
AN_.a = null; AN_.b = null;
let anHtml = vm.runInContext("vAnalysis()", sandbox);
assert("the Analysis view renders empty", /Paste a Google Maps link/.test(anHtml), "prompt shown");
assert("and states the privacy position", /never sent to a server/.test(anHtml), "privacy line");

/* ---- v1.2 Climate ----
   The one thing that must never break here: "not mapped" and 0 % are different
   answers. MCF has mapped about 80 watercourses and SGU's survey covers part of
   the country, so an absence of data is not an absence of risk. */
console.log("\nclimate:");
const CLI = D.indicators.filter(i => i.group === "Climate");
assert("nine Climate indicators", CLI.length === 9, CLI.map(i => i.key).join(", "));
assert("none of them inherits down the hierarchy",
  CLI.filter(i => i.key !== "cloudburst_mapped").every(i => i.no_inherit === true),
  "no_inherit on every area share");
assert("every label carries its horizon or scenario",
  ["coast20", "coast30", "sea2100_85", "sea2100_45", "flood100", "flood200"]
    .every(k => /\d/.test((D.indicators.find(i => i.key === k) || {}).label || "")),
  "levels and years in the labels");

const floodK = D.kommuner.filter(k => k.flood100 != null).length;
assert("river flood is scored only where a watercourse is mapped",
  floodK > 150 && floodK < 290, `${floodK} of 290 kommuner scored`);
assert("and the rest are blank, not zero",
  D.kommuner.some(k => k.flood100 == null), "unmapped kommuner carry no value");

const cb = D.kommuner.filter(k => k.cloudburst_mapped != null).length;
const cbYes = D.kommuner.filter(k => k.cloudburst_mapped === 1).length;
assert("the cloudburst flag covers all 290 kommuner", cb === 290, `${cb}`);
assert("and 267 of them have their own mapping", cbYes === 267, `${cbYes}`);

/* a share is a share: nothing may exceed 100 % or go below 0 */
const shares = [];
for (const k of D.kommuner)
  for (const key of ["flood100", "flood200", "floodBHF", "coast20", "coast30",
                     "sea2100_85", "sea2100_45", "landslide"])
    if (k[key] != null) shares.push([key, k[key]]);
assert("every climate share is between 0 and 100 %",
  shares.every(([, v]) => v >= 0 && v <= 100),
  `${shares.length} values, max ${Math.max(...shares.map(x => x[1])).toFixed(2)} %`);
/* A 200-year flood share CAN be smaller than the 100-year one, and that is the
   source's doing rather than a bug: the products cover 76, 71 and 78 different
   watercourses, and the difference shows up inside one kommun — Umeå is covered
   by three mapped watercourses in the 100-year map and two in the 200-year one.
   The first version of this test asserted monotonicity and was testing
   hydrology that these PRODUCTS do not satisfy. What must hold instead is that
   the indicators warn about it, because a reader comparing the two columns would
   otherwise draw a wrong conclusion. */
const nonMono = D.kommuner.filter(k => k.flood100 != null && k.flood200 != null &&
  k.flood200 < k.flood100 - 0.01);
assert("the flood layers' differing coverage is visible in the data",
  nonMono.length > 0, `${nonMono.length} kommuner where 200-yr < 100-yr`);
assert("and every flood indicator warns that they are not comparable with each other",
  ["flood100", "flood200", "floodBHF"].every(k =>
    /do not cover the same watercourses/.test((D.indicators.find(i => i.key === k) || {}).warn || "")),
  "caveat present on all three");
const bad30 = D.kommuner.filter(k => k.coast20 != null && k.coast30 != null &&
  k.coast30 < k.coast20 - 0.01);
assert("nor is +3.0 m smaller than +2.0 m", bad30.length === 0,
  bad30.length ? bad30.slice(0, 3).map(k => k.name).join(", ") : "monotonic");

/* ---- v1.2 Infrastructure ---- */
console.log("\ninfrastructure:");
const PR = (D.infra || {}).projects || [];
assert("the curated project list ships", PR.length >= 30, `${PR.length} projects`);
assert("every project has a source URL", PR.every(p => /^https?:\/\//.test(p.source_url || "")),
  PR.filter(p => !/^https?:/.test(p.source_url || "")).map(p => p.id).join(", ") || "all sourced");
assert("no budget without a price base",
  PR.every(p => p.budget_msek == null || !!p.price_base),
  PR.filter(p => p.budget_msek != null && !p.price_base).map(p => p.id).join(", ") || "all based");
assert("statuses are from the fixed set",
  PR.every(p => ["study", "decided", "construction", "opened"].includes(p.status)),
  [...new Set(PR.map(p => p.status))].join(", "));
assert("every project maps to real kommun codes",
  PR.every(p => (p.kommuner || []).every(c => !!byCode[c])),
  "all kommun codes resolve");
const vPipe = vm.runInContext("vPipeline", sandbox);
S.view = "pipeline";
const pipeHtml = vPipe();
assert("the Pipeline view renders every project", (pipeHtml.match(/data-go="project\//g) || []).length === PR.length,
  `${(pipeHtml.match(/data-go="project\//g) || []).length} rows`);
assert("and says a budget needs its price base", /price base/i.test(pipeHtml), "stated");

/* ---- v1.2.1: the three limitations closed ---- */
console.log("\nv1.2.1 coverage:");
const srvIdx = (D.services_meta || {}).index || {};
assert("services cover all 290 kommuner", Object.keys(srvIdx).length === 290,
  `${Object.keys(srvIdx).length} of 290`);
const srvTotal = Object.values(srvIdx).reduce((a, b) => a + b.n, 0);
assert("and carry the whole country's points", srvTotal > 90000, `${srvTotal.toLocaleString()} points`);
/* services_meta is the whole {meta, index} object, so the route lives one level in */
const srvRoute = ((D.services_meta || {}).meta || {}).route || "";
assert("read from the extract, not Overpass", /pbf|Geofabrik/i.test(srvRoute), srvRoute);

const infra = (D.infra || {}).projects || [];
assert("the project list is unchanged at 49", infra.length === 49, `${infra.length}`);

const zoneLayers = Object.keys(((D.climate_meta || {}).zones) || {});
assert("six climate layers ship zone outlines", zoneLayers.length === 6,
  zoneLayers.sort().join(", "));
assert("and landslide is deliberately not one of them",
  !zoneLayers.includes("landslide"),
  "242 000 tiny polygons do not simplify — choropleth only");
assert("landslide is still fully available as a number",
  D.kommuner.filter(k => k.landslide != null).length > 250,
  `${D.kommuner.filter(k => k.landslide != null).length} kommuner`);

/* ---- v1.2 verify-at-source ----
   The link must reproduce the publisher's query for the cells on screen. Two
   ways it silently goes wrong: sending a kommun code to a län table (400), and
   sending a bare year to a monthly table (400). Both are asserted here, and
   scripts/check_source_links.py then re-fetches every link for real. */
console.log("\nverify at source:");
const srcUrl = vm.runInContext("srcUrl", sandbox), pickSrc = vm.runInContext("pickSrc", sandbox);
const withLink = D.indicators.filter(i => (i.src_verify || []).length);
assert("every indicator carries a verify query", withLink.length === D.indicators.length,
  `${withLink.length} of ${D.indicators.length}`);

const uIncome = srcUrl(pickSrc(D.indicators.find(i => i.key === "income_med"), "kommun"), "kommun", "0180", D.meta.latest_year);
assert("a kommun indicator asks for the kommun code", /valueCodes%5BRegion%5D=0180|valueCodes\[Region\]=0180/.test(uIncome), uIncome.slice(0, 110));

/* brf_price is drawn per kommun but published per län — the link must send the
   län code, or SCB answers 400 "Non-existent value". */
const brf = D.indicators.find(i => i.key === "brf_price");
if (brf) {
  const e = pickSrc(brf, "kommun");
  const u = srcUrl(e, "kommun", "1785", D.meta.latest_year);
  assert("a län-published indicator sends the län code, not the kommun",
    e.code_level === "lan" && /Region\]=17|Region%5D=17/.test(u), `code_level=${e.code_level}, ${u.slice(-60)}`);
}
/* unemp sits on a monthly table: a bare year is not a Tid code there */
const un2 = D.indicators.find(i => i.key === "unemp");
if (un2) {
  const e = pickSrc(un2, "kommun");
  const u = srcUrl(e, "kommun", "0180", D.meta.latest_year);
  assert("a monthly table gets month codes, not a bare year",
    e.time_kind === "month" && /M\d\d/.test(u), `time_kind=${e.time_kind}`);
}
/* never ask a table for a period it does not have */
const ahead = D.indicators.filter(i => (i.src_verify || []).some(e =>
  e.newest_period && String(e.newest_period) < String(D.meta.latest_year) &&
  (srcUrl(e, e.level, "0180", D.meta.latest_year) || "").includes(D.meta.latest_year)));
assert("no link asks a table for a period after its last one", ahead.length === 0,
  ahead.map(i => i.key).join(", ") || "all clamped to the table's newest period");

assert("a neutral indicator's rank is marked neutral",
  (rankOf(MUNI_.find(m => m.flats != null), "flats", MUNI_) || {}).neutral === true, "neutral flag set");

S.view = "makro"; MK.kommun = null; MK.ind = "income_med";
const mapHtml = A.vMakro();
assert('no "380,8 %" anywhere on the map view', !/380[.,]8\s*%/.test(mapHtml), "checked the rendered HTML");
S.view = "area"; AR.type = "kommun"; AR.code = "0180"; AR.tab = "ind";
assert("nor on the area page", !/%/.test((A.vArea().match(/385[.,]3[^<]*/) || [""])[0]), "income_med cell");
S.view = "table"; T.level = "kommun";
assert("nor in the table", !/385[.,]3\s*%/.test(A.vTable()), "income_med column");

console.log("\nmap levels and attribution:");
const src = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
assert("map opens on Sweden", /center: \[62\.5, 16\.5\], zoom: 5/.test(src), "[62.5, 16.5] zoom 5");
assert("no Danish centre left", !/56(\.0)?, 10\.5/.test(src), "checked src/app.js");
assert("boundary attribution is SCB's", /Boundaries: SCB RegSO\/DeSO 2025 \(CC0\)/.test(src));
assert("no DAGI / Klimadatastyrelsen anywhere",
       !/DAGI|Klimadatastyrelsen/i.test(src) && !/DAGI|Klimadatastyrelsen/i.test(JSON.stringify(D.meta)));
assert("zoom no longer decides the level", !/SUB_ZOOM/.test(src), "drilling does");

/* the national map must draw the 290 kommuner, and a click must open a kommun */
MK.kommun = null; MK.ind = "growth";
const kpop = vm.runInContext("lfKommunPopup", sandbox)(byCode["0180"]);
assert("national popup is a kommun popup", /area\/kommun\/0180/.test(kpop), "Open page -> kommun");
assert("it offers the way down to RegSO", /map\/0180(\?|")/.test(kpop) && /RegSO ›/.test(kpop));
assert("and to DeSO", /map\/0180\/deso/.test(kpop));

console.log("\nboundaries clipped to land:");
/* RegSO and DeSO tile the territory including water. Before clipping every
   kommun dissolved to a single ring that reached out to sea; an archipelago
   kommun should now be many parts, and an inland one still exactly one. */
const parts = k => byCode[k].rings.length;
assert("Värmdö is an archipelago, not one blob", parts("0120") > 20, `${parts("0120")} parts`);
assert("Nynäshamn likewise", parts("0192") > 5, `${parts("0192")} parts`);
assert("Gotland is the island plus its islets", parts("0980") > 1, `${parts("0980")} parts`);
assert("inland Malå is untouched", parts("2418") === 1, `${parts("2418")} part`);
const seaLon = byCode["0120"].rings.flat().some(p => p[1] > 19.6);
assert("no kommun ring reaches into open Baltic", !seaLon, "Värmdö stays west of 19.6°E");
assert("the ODbL coastline is attributed",
       (D.meta.attribution || []).some(a => /OpenStreetMap land polygons \(ODbL\)/.test(a)),
       (D.meta.attribution || []).join(" · "));

console.log("\nBoverket BME:");
const bme = D.indicators.find(i => i.key === "bme");
assert("bme has data now", bme && Object.keys(bme.asof || {}).length > 0, `asof ${JSON.stringify(bme.asof)}`);
assert("three categories with colours", (bme.cats || []).length === 3,
       (bme.cats || []).map(c => `${c.label}=${c.color}`).join(" "));
const withBme = D.kommuner.filter(k => k.bme != null).length;
assert("most kommuner answered", withBme > 280 && withBme < 290, `${withBme} of 290`);
assert("non-answers stay blank, not 0", D.kommuner.some(k => k.bme === undefined || k.bme === null),
       `${290 - withBme} kommuner blank`);
const vals = new Set(D.kommuner.map(k => k.bme).filter(v => v != null));
assert("values are the three codes", [...vals].sort().join(",") === "-1,0,1", [...vals].sort().join(","));
const hist = (byCode["0180"].hist || {}).bme || {};
assert("history spans the survey years", Object.keys(hist).length >= 6, Object.keys(hist).sort().join(" "));
const fmtB = fmtOf(bme);
assert("a category renders as its label, not a number", fmtB(-1) === "Shortage", `fmtOf(-1) = "${fmtB(-1)}"`);
assert("Boverket is attributed", (D.meta.attribution || []).some(a => /Boverket/.test(a)));
S.view = "makro"; MK.kommun = null; MK.ind = "bme";
const bmap = A.vMakro();
assert("the map renders with bme selected", bmap.length > 1000 && !/undefined/.test(bmap.slice(0, 4000)));

console.log("\nKronofogden forced sales:");
const fsVals = new Set(D.kommuner.map(k => k.forced_sales).filter(v => v != null));
assert("covers every kommun", D.kommuner.filter(k => k.forced_sales != null).length === 290);
assert("but carries only 21 distinct values — it is a län figure",
       fsVals.size === 21, `${fsVals.size} distinct values`);
assert("neighbouring kommuner in one län match",
       byCode["0180"].forced_sales === byCode["0114"].forced_sales,
       `Stockholm ${byCode["0180"].forced_sales} = Upplands Väsby ${byCode["0114"].forced_sales}`);
const fsInd = D.indicators.find(i => i.key === "forced_sales");
assert("and says so loudly", /LÄN FIGURE, NOT A KOMMUN ONE/.test(fsInd.warn || ""));

console.log("\nKolada municipal finances:");
const fin = D.indicators.filter(i => i.group === "Municipal finances");
assert("four indicators in their own group", fin.length === 4, fin.map(i => i.key).join(", "));
for (const k of ["kommun_tax", "kommun_netcost", "kommun_debt", "kommun_equity"])
  assert(`${k} covers all 290`, D.kommuner.filter(m => m[k] != null).length === 290);
assert("tax rates look like municipal rates",
       byCode["0180"].kommun_tax > 16 && byCode["0180"].kommun_tax < 20,
       `Stockholm ${byCode["0180"].kommun_tax} %`);
assert("Gotland levies both rates and is left alone",
       byCode["0980"].kommun_tax > 30, `Gotland ${byCode["0980"].kommun_tax} %`);
assert("net cost reads as a cost, not a negative",
       D.kommuner.every(m => m.kommun_netcost == null || m.kommun_netcost > 0),
       `median ${byCode["0180"].kommun_netcost} kSEK`);
assert("equity ratio may be negative and is not clipped",
       D.kommuner.some(m => m.kommun_equity < 0),
       `${D.kommuner.filter(m => m.kommun_equity < 0).length} kommuner below zero`);
assert("Kolada is credited", fin.every(i => /Kolada \(RKA\)/.test(i.source)));

console.log("\nunused-on-disk tables, now used:");
const kd = byCode["0180"].dist || {};
assert("industry mix on the kommun page", (kd.industry || []).length > 10,
       `${(kd.industry || []).length} SNI groups`);
const someR = D.regso.find(r => r.kommun === "0180" && r.dist && r.dist.industry);
assert("and on RegSO", !!someR, someR ? someR.name : "none");
assert("industry rolls up exactly from RegSO",
       Math.abs(kd.industry.reduce((a, b) => a + b, 0) -
                D.regso.filter(r => r.kommun === "0180" && r.dist && r.dist.industry)
                  .reduce((s_, r) => s_ + r.dist.industry.reduce((a, b) => a + b, 0), 0)) < 1,
       `${kd.industry.reduce((a, b) => a + b, 0)} employed`);
assert("self-sufficiency by region of birth", (kd.selfsuff || []).length === 3,
       (kd.selfsuff || []).map(v => `${v} %`).join(" / "));
assert("brf price is a län figure repeated over kommuner",
       new Set(D.kommuner.map(k => k.brf_price).filter(v => v != null)).size === 21,
       `${new Set(D.kommuner.map(k => k.brf_price).filter(v => v != null)).size} distinct`);
for (const k of ["newbuild_rent", "vacancy"])
  assert(`${k} is a macro series`, !!(D.macro.series || {})[k],
         `${((D.macro.series || {})[k] || []).length} points`);
assert("vacancy carries its breakdown", Object.keys((D.macro.breakdown || {}).vacancy || {}).length === 3);
assert("and is flagged stale", /STALE/.test((D.macro.latest.vacancy || {}).warn || ""));
S.view = "market";
const mkt = A.vMarket();
assert("both new panels render", /New-build rent by rent-setting model/.test(mkt) && /Vacant dwellings/.test(mkt));
assert("the staleness is on the page, not just in the registry", /<b>Stale\.<\/b>/.test(mkt));

console.log("\ngeometry lands in Sweden:");
/* RegSO and DeSO rings were written [lat,lon] into the GeoJSON and swapped again
   by build_makro, so every sub-municipal polygon was drawn off the Somali coast
   from v1.0 until this was caught by looking at a screenshot. Rings are [lat,lon]
   for Leaflet; anything outside Sweden's box is the swap coming back. */
const SE = { lat: [55.0, 69.3], lon: [10.5, 24.5] };
function ringsOk(list, label) {
  let bad = 0, sample = null;
  for (const o of list) for (const r of (o.rings || [])) for (const p of r) {
    if (p[0] < SE.lat[0] || p[0] > SE.lat[1] || p[1] < SE.lon[0] || p[1] > SE.lon[1]) {
      bad++; sample = sample || `${o.name || o.code} ${JSON.stringify(p)}`;
    }
  }
  assert(`${label} rings are inside Sweden`, bad === 0, bad ? `${bad} stray points, e.g. ${sample}` : "all inside");
}
ringsOk(D.kommuner, "kommun");
ringsOk(D.regso, "RegSO");
/* and the sub-areas must sit inside their own kommun's box, not merely in Sweden */
const sth = byCode["0180"], sthLat = sth.rings.flat().map(p => p[0]), sthLon = sth.rings.flat().map(p => p[1]);
const box = [Math.min(...sthLat) - 0.02, Math.max(...sthLat) + 0.02, Math.min(...sthLon) - 0.02, Math.max(...sthLon) + 0.02];
const stray = D.regso.filter(r => r.kommun === "0180")
  .filter(r => r.rings.flat().some(p => p[0] < box[0] || p[0] > box[1] || p[1] < box[2] || p[1] > box[3]));
assert("Stockholm's RegSO sit inside Stockholm", stray.length === 0,
       stray.length ? `${stray.length} outside, e.g. ${stray[0].name}` : `${D.regso.filter(r => r.kommun === "0180").length} checked`);
assert("the archipelago survived the skerry filter", byCode["0120"].rings.length > 100,
       `Värmdö ${byCode["0120"].rings.length} parts`);
assert("inland kommuner stay single-part", byCode["2418"].rings.length === 1, `Malå ${byCode["2418"].rings.length}`);

console.log("\nmarket cards:");
const mk = (S.view = "market", A.vMarket());
for (const gone of ["DST HUS1", "DST EJ56", "Finans Danmark", "Nationalbank", "Homes for sale"])
  assert(`"${gone}" is gone`, !mk.includes(gone));
for (const want of ["Rent index (CPI 04.1)", "Property price index (FASTPI)", "Interest rates"])
  assert(`"${want}" is present`, mk.includes(want));
assert("the rate card draws three series", /Policy rate/.test(mk) && /10-yr government bond/.test(mk) && /Mortgage, new agreements/.test(mk));
assert("no empty-series placeholder on the cards", !/no series for/.test(mk));

console.log(failures ? `\n${failures} check(s) failed` : "\nall smoke checks passed");
process.exit(failures ? 1 : 0);
