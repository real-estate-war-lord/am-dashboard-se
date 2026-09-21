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
assert("bme has no data and is reported, not crashed",
       (D.indicators.find(i => i.key === "bme") || {}).asof &&
       Object.keys((D.indicators.find(i => i.key === "bme") || {}).asof).length === 0,
       "renders as no data");

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

console.log(failures ? `\n${failures} check(s) failed` : "\nall smoke checks passed");
process.exit(failures ? 1 : 0);
