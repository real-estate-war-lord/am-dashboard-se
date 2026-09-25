/* The export schema — the pure parts, kept out of src/app.js so they can be
   unit-tested. Same arrangement as route_core.js and listings/view.js: no DOM,
   no globals, no fetch. `make test-js` runs tests/export.test.js against it.

   One long schema for every area figure, one file per other kind of thing, and
   one set of rules about what a cell may contain:

     - a suppressed value is empty, never 0 — the publisher had nothing to say
       and an export that writes 0 turns that into a claim
     - every row carries where it came from: source, table id, the URL that
       reproduces it, the publisher's as-of and this build's fetch date
     - `value_type` says what kind of number it is, so a projection and an
       observation can never be added up by accident
     - `inherited_from` names the kommun whose figure a sub-area row is showing
     - the unit and the magnitude are checked against each other before the file
       is written: a kSEK column holding SEK is the mistake this guards, and it
       is one the Danish edition shipped for a year

   CSV: UTF-8 with a BOM and `;` separators, because a Swedish Excel reads a
   comma as a decimal point and would split every number across two columns.
   Inside the file the decimal separator is `.` and there is no thousands
   grouping, because the file is also read by machines.
*/
"use strict";
/* Wrapped in an IIFE: the build inlines this file and app.js as classic <script>
   blocks in one global lexical scope, so a top-level const here would collide. */
(function () {

const LONG_COLUMNS = [
  "level", "code", "name", "parent_code", "parent_name", "lan", "population",
  "indicator", "label", "unit", "period", "period_type", "value", "margin_of_error",
  "value_type", "inherited_from", "direction", "source", "table_id", "source_url",
  "as_of", "fetched", "licence",
];
/* Projects are not indicator rows and must never be poured into the same
   columns: the Danish edition's single CSV had project rows sharing the
   indicator columns, which made every consumer special-case them. */
const PROJECT_COLUMNS = [
  "id", "name", "type", "status", "open_year", "open_window", "budget_msek",
  "price_base", "agency", "kommuner", "source_url", "notes",
];
const NEARBY_COLUMNS = [
  "kind", "name", "type", "status", "distance_m", "rent", "m2", "rooms", "source", "source_url",
];
const SOURCES_COLUMNS = [
  "key", "label", "publisher", "tables", "as_of", "fetched", "url", "licence", "used_for",
];
const PROPERTY_LEAD = ["property_label", "lat", "lon"];

const VALUE_TYPES = ["actual", "projection", "inherited", "derived"];
const PERIOD_TYPES = ["year", "quarter", "month", "window", "snapshot", "projection", "scenario"];

/* What kind of period a label is, read off the label itself rather than from a
   flag somebody has to remember to set. */
function periodType(period, opts) {
  const o = opts || {};
  if (o.projection) return "projection";
  if (o.scenario) return "scenario";
  const p = String(period == null ? "" : period);
  if (!p) return "snapshot";
  if (/K\d/.test(p)) return "quarter";
  if (/^\d{4}M\d{2}$/.test(p)) return "month";
  if (/→|->|\+/.test(p)) return "window";
  if (/^\d{4}(-\d{2}-\d{2})?$/.test(p)) return /^\d{4}$/.test(p) ? "year" : "snapshot";
  return "snapshot";
}

/* ---------- the unit / magnitude check ----------
   Rules only where a mistake is both possible and silent. A kSEK column holding
   SEK reads as a thousandfold error to anyone who trusts the header, and nothing
   in the pipeline would otherwise notice. */
const UNIT_RULES = [
  { name: "kSEK holding SEK",
    when: u => /kSEK/i.test(u),
    ok: v => Math.abs(v) < 100000,
    why: "a value in a kSEK column above 100 000 is almost certainly SEK" },
  { name: "SEK holding kSEK",
    when: u => /(^|[^k])SEK/i.test(u) && !/kSEK/i.test(u),
    ok: v => v === 0 || Math.abs(v) >= 10,
    why: "a value below 10 in a SEK column is almost certainly kSEK" },
  /* Only where the unit says "% of <a whole>". A bare "%" in this registry is a
     CHANGE — projected population change, the crime trend — and a change is
     signed and unbounded, so bounding it would flag correct rows. */
  { name: "a share outside 0–100",
    when: u => /^%\s+of\b/.test(u),
    ok: v => v >= -0.001 && v <= 100.001,
    why: "a share of a whole cannot be negative or exceed 100 %" },
];
/* Every row whose unit and magnitude disagree, with the rule that caught it.
   Empty is the only acceptable answer at export time. */
function unitProblems(rows) {
  const out = [];
  for (const r of rows || []) {
    const u = String(r.unit == null ? "" : r.unit);
    const v = r.value;
    if (v === "" || v == null || !isFinite(Number(v))) continue;
    for (const rule of UNIT_RULES) {
      if (!rule.when(u)) continue;
      if (rule.ok(Number(v))) continue;
      out.push({ indicator: r.indicator, level: r.level, code: r.code, unit: u, value: Number(v),
                 rule: rule.name, why: rule.why });
      break;
    }
  }
  return out;
}

/* ---------- CSV ---------- */
/* A cell never carries the separator, a newline or a stray quote into the file.
   A newline is COLLAPSED to a space rather than quoted: a quoted newline is legal
   CSV, but one row per line is what every consumer of this file actually assumes,
   and a source description that wraps is not worth breaking that for. */
function csvCell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") {
    if (!isFinite(v)) return "";
    /* `.` decimal, no grouping: this file is read by machines as well as by
       Excel, and toLocaleString would give it a Swedish comma. */
    return String(v);
  }
  const s = String(v).replace(/\r?\n/g, " ");
  return /[";]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows, columns) {
  const cols = columns || LONG_COLUMNS;
  const out = [cols.join(";")];
  for (const r of rows || []) out.push(cols.map(c => csvCell(r[c])).join(";"));
  return out;
}
/* The file name carries what it is and when it was built, so two downloads a
   month apart do not overwrite each other in a downloads folder. */
const fileName = (what, built) => `am_dashboard_se_${what}_${built || "data"}.csv`;

const API = { LONG_COLUMNS, PROJECT_COLUMNS, NEARBY_COLUMNS, SOURCES_COLUMNS, PROPERTY_LEAD,
              VALUE_TYPES, PERIOD_TYPES, UNIT_RULES,
              periodType, unitProblems, csvCell, toCsv, fileName };
if (typeof window !== "undefined") window.EXPORT_CORE = API;
if (typeof module !== "undefined" && module.exports) module.exports = API;

})();
