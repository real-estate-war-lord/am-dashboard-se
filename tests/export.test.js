/* src/export_core.js — the export schema, the CSV rules and the unit check.
 *
 * The schema is a contract: somebody's spreadsheet joins on these column names,
 * so a column that quietly moves or disappears is a breaking change. The unit
 * check is here because a kSEK column holding SEK is a thousandfold error that
 * nothing else in the pipeline would notice — the Danish edition shipped exactly
 * that for a year.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const X = require("../src/export_core.js");

/* ---- the schema ---- */

test("the long schema is exactly the documented column list, in order", () => {
  assert.deepStrictEqual(X.LONG_COLUMNS, [
    "level", "code", "name", "parent_code", "parent_name", "lan", "population",
    "indicator", "label", "unit", "period", "period_type", "value", "margin_of_error",
    "value_type", "inherited_from", "direction", "source", "table_id", "source_url",
    "as_of", "fetched", "licence",
  ]);
});

test("projects are their own columns and never carry an indicator", () => {
  assert.ok(!X.PROJECT_COLUMNS.includes("indicator"));
  assert.ok(!X.PROJECT_COLUMNS.includes("value"));
  assert.ok(X.PROJECT_COLUMNS.includes("budget_msek"));
  assert.ok(X.PROJECT_COLUMNS.includes("price_base"), "a budget without its price base is not a figure");
});

test("the nearby file carries the advertised rent and its distance", () => {
  assert.deepStrictEqual(X.NEARBY_COLUMNS,
    ["kind", "name", "type", "status", "distance_m", "rent", "m2", "rooms", "source", "source_url"]);
});

test("a property file leads with the property's own columns", () => {
  assert.deepStrictEqual(X.PROPERTY_LEAD, ["property_label", "lat", "lon"]);
  assert.strictEqual(X.PROPERTY_LEAD.concat(X.LONG_COLUMNS).join(";").indexOf("property_label"), 0);
});

/* ---- period types ---- */

test("a period says what kind it is by its own shape", () => {
  assert.strictEqual(X.periodType("2025"), "year");
  assert.strictEqual(X.periodType("2025K4"), "quarter");
  assert.strictEqual(X.periodType("2026 prel.K2"), "quarter");
  assert.strictEqual(X.periodType("2026M08"), "month");
  assert.strictEqual(X.periodType("2024→2025"), "window");
  assert.strictEqual(X.periodType("2025+2026"), "window");
  assert.strictEqual(X.periodType("2026-09-15"), "snapshot");
  assert.strictEqual(X.periodType(""), "snapshot");
  assert.strictEqual(X.periodType(null), "snapshot");
});

test("but a projection and a scenario are told, not guessed", () => {
  assert.strictEqual(X.periodType("2040", { projection: true }), "projection");
  assert.strictEqual(X.periodType("2100", { scenario: true }), "scenario");
});

/* ---- the unit / magnitude check ---- */

const row = (unit, value, extra) => Object.assign({ indicator: "x", level: "kommun", code: "0180", unit, value }, extra);

test("a kSEK column holding SEK is caught", () => {
  assert.strictEqual(X.unitProblems([row("kSEK / yr", 385.3)]).length, 0);
  const bad = X.unitProblems([row("kSEK / yr", 385300)]);
  assert.strictEqual(bad.length, 1);
  assert.match(bad[0].why, /almost certainly SEK/);
});

test("and a SEK column holding kSEK", () => {
  assert.strictEqual(X.unitProblems([row("SEK / m² / yr", 1710)]).length, 0);
  assert.strictEqual(X.unitProblems([row("SEK / m² / yr", 1.71)]).length, 1);
  /* zero is a real answer, not a mislabelled one */
  assert.strictEqual(X.unitProblems([row("SEK / m² / yr", 0)]).length, 0);
});

test("a share of a whole cannot leave 0–100", () => {
  assert.strictEqual(X.unitProblems([row("% of dwellings", 43)]).length, 0);
  assert.strictEqual(X.unitProblems([row("% of dwellings", 0)]).length, 0);
  assert.strictEqual(X.unitProblems([row("% of dwellings", 100)]).length, 0);
  assert.strictEqual(X.unitProblems([row("% of dwellings", 143)]).length, 1);
  assert.strictEqual(X.unitProblems([row("% of dwellings", -2)]).length, 1);
});

test("but a bare % is a change, which is signed and unbounded", () => {
  /* projected population change and the crime trend both live in "%": bounding
     them to 0–100 would flag correct rows, which is worse than not checking */
  assert.strictEqual(X.unitProblems([row("%", -19.9)]).length, 0);
  assert.strictEqual(X.unitProblems([row("% / yr", -6.2)]).length, 0);
  assert.strictEqual(X.unitProblems([row("%", 1030)]).length, 0);
});

test("a suppressed value is never checked, because there is nothing to check", () => {
  assert.strictEqual(X.unitProblems([row("kSEK", ""), row("kSEK", null), row("kSEK", undefined)]).length, 0);
});

test("a problem names the row, the rule and the reason", () => {
  const [p] = X.unitProblems([row("kSEK", 999999, { indicator: "income_med", code: "1480" })]);
  assert.strictEqual(p.indicator, "income_med");
  assert.strictEqual(p.code, "1480");
  assert.strictEqual(p.unit, "kSEK");
  assert.ok(p.rule && p.why);
});

/* ---- CSV ---- */

test("a cell never carries the separator or a newline into the file", () => {
  assert.strictEqual(X.csvCell("a;b"), '"a;b"');
  /* collapsed, not quoted: one row per line is what consumers assume */
  assert.strictEqual(X.csvCell("a\nb"), "a b");
  assert.strictEqual(X.csvCell("a\r\nb"), "a b");
  assert.strictEqual(X.csvCell('say "hi"'), '"say ""hi"""');
  assert.strictEqual(X.csvCell("plain"), "plain");
});

test("a number keeps a dot decimal and no grouping, whatever the reader's locale", () => {
  assert.strictEqual(X.csvCell(1234.5), "1234.5");
  assert.strictEqual(X.csvCell(1000000), "1000000");
  assert.strictEqual(X.csvCell(0), "0");
});

test("an empty cell is empty and a missing one is too — neither becomes a zero", () => {
  assert.strictEqual(X.csvCell(null), "");
  assert.strictEqual(X.csvCell(undefined), "");
  assert.strictEqual(X.csvCell(""), "");
  assert.strictEqual(X.csvCell(NaN), "");
  assert.strictEqual(X.csvCell(Infinity), "");
});

test("toCsv writes the header first and one line per row, in column order", () => {
  const out = X.toCsv([{ level: "kommun", code: "0180", value: 1710 }], ["level", "code", "value"]);
  assert.deepStrictEqual(out, ["level;code;value", "kommun;0180;1710"]);
});

test("a column a row does not have is an empty cell, not a gap", () => {
  const out = X.toCsv([{ level: "kommun" }], ["level", "code", "value"]);
  assert.strictEqual(out[1], "kommun;;");
  assert.strictEqual(out[1].split(";").length, 3);
});

/* a quote-aware split, the way a consumer would read the file back */
function parseLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ";") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

test("no row can ever have a different number of cells from the header", () => {
  const rows = [{ name: "a;b" }, { name: "c\nd" }, { name: 'e "f"' }, { name: null }];
  const out = X.toCsv(rows, ["name", "code"]);
  assert.strictEqual(out.length, rows.length + 1);
  for (const line of out) {
    assert.ok(!/\n/.test(line), "no line contains a newline: " + JSON.stringify(line));
    assert.strictEqual(parseLine(line).length, 2, line);
  }
  assert.deepStrictEqual(parseLine(out[1]), ["a;b", ""]);
  assert.deepStrictEqual(parseLine(out[3]), ['e "f"', ""]);
});

test("the file name says what it is and when it was built", () => {
  assert.strictEqual(X.fileName("areas_long", "2026-09-25"), "am_dashboard_se_areas_long_2026-09-25.csv");
  assert.match(X.fileName("areas_long"), /_data\.csv$/);
});

test("the value types are the four the schema documents", () => {
  assert.deepStrictEqual(X.VALUE_TYPES, ["actual", "projection", "inherited", "derived"]);
});
