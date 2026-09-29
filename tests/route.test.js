/* src/route_core.js — the v2.0 hash alias table.
 *
 * The point of these tests is that a link somebody shared in 2026 still opens the
 * right screen, and that the rewrite is idempotent: the app runs toV2() on every
 * hashchange, so a table that rewrote its own output would loop.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const R = require("../src/route_core.js");

/* ---- split / build ---- */

test("splitHash takes a leading #, a path and a query", () => {
  const r = R.splitHash("#table/kommun?ind=growth&y=2024");
  assert.strictEqual(r.path, "table/kommun");
  assert.deepStrictEqual(r.parts, ["table", "kommun"]);
  assert.deepStrictEqual(r.query, { ind: "growth", y: "2024" });
});

test("splitHash survives a hash with no query and one with no path", () => {
  assert.deepStrictEqual(R.splitHash("#map").parts, ["map"]);
  assert.deepStrictEqual(R.splitHash("").parts, []);
  assert.deepStrictEqual(R.splitHash("#?ind=growth").query, { ind: "growth" });
});

test("buildHash drops empty values and keeps a coordinate readable", () => {
  assert.strictEqual(R.buildHash("map", { ind: "growth", y: "" }), "map?ind=growth");
  assert.strictEqual(R.buildHash("property", { p: "59.31972,18.07194:Home" }),
    "property?p=59.31972,18.07194:Home");
  assert.strictEqual(R.buildHash("map", {}), "map");
});

test("buildHash still encodes what would break a hash", () => {
  assert.strictEqual(R.buildHash("property", { p: "59.3,18:A & B" }), "property?p=59.3,18:A%20%26%20B");
});

/* ---- coordinates ---- */

test("parseLatLon rounds to five decimals and refuses anything else", () => {
  assert.deepStrictEqual(R.parseLatLon("59.319721,18.071941"), [59.31972, 18.07194]);
  assert.deepStrictEqual(R.parseLatLon(" 59.3 , 18.0 "), [59.3, 18]);
  assert.strictEqual(R.parseLatLon("59.3"), null);
  assert.strictEqual(R.parseLatLon("Stockholm"), null);
  assert.strictEqual(R.parseLatLon(""), null);
});

test("the property codec round-trips, is list-capable, and keeps the label", () => {
  const items = [{ lat: 59.31972, lon: 18.07194, label: "Home" }];
  assert.strictEqual(R.propSerialise(items), "59.31972,18.07194:Home");
  assert.deepStrictEqual(R.propParse("59.31972,18.07194:Home"), items);
  assert.strictEqual(R.propParse("59.3,18.0;57.7,11.97").length, 2);
  assert.deepStrictEqual(R.propParse("nonsense"), []);
});

/* ---- the map's pin (v2.1.1) ---- */

test("the map's pin codec round-trips through pin= / pl= / rad=", () => {
  const pin = { lat: 59.31972, lon: 18.07194, label: "Home", rad: 2000 };
  assert.deepStrictEqual(R.pinQuery(pin), { pin: "59.31972,18.07194", pl: "Home", rad: "2000" });
  assert.deepStrictEqual(R.pinParse({ pin: "59.31972,18.07194", pl: "Home", rad: "2000" }), pin);
});

test("pinQuery leaves out a label nobody typed and the radius nobody chose", () => {
  assert.deepStrictEqual(R.pinQuery({ lat: 59.3, lon: 18, label: "", rad: 1000 }, 1000),
    { pin: "59.3,18" });
  /* the same radius is written down when it is not the default the caller names */
  assert.deepStrictEqual(R.pinQuery({ lat: 59.3, lon: 18, rad: 1000 }, 2000).rad, "1000");
  /* a radius that is not one of the three offered is not a radius */
  assert.strictEqual(R.pinQuery({ lat: 59.3, lon: 18, rad: 750 }, 1000).rad, undefined);
});

test("no pin, no keys — a link is never lengthened by a pin that does not exist", () => {
  assert.deepStrictEqual(R.pinQuery(null), {});
  assert.deepStrictEqual(R.pinQuery({ lat: null, lon: null }), {});
  assert.strictEqual(R.pinParse({}), null);
  assert.strictEqual(R.pinParse({ pin: "Stockholm" }), null);
});

test("toInternal hands the map's pin back parsed, the way property hands back p=", () => {
  const r = R.toInternal("#map/0180?ind=rent&pin=59.31972,18.07194&pl=Home&rad=2000");
  assert.strictEqual(r.view, "makro");
  assert.deepStrictEqual(r.parts, ["map", "0180"]);
  assert.deepStrictEqual(r.pin, { lat: 59.31972, lon: 18.07194, label: "Home", rad: 2000 });
  /* the keys stay in the query too, so nothing that reads the query is surprised */
  assert.strictEqual(r.query.pin, "59.31972,18.07194");
  assert.strictEqual(R.toInternal("#map/0180?ind=rent").pin, null);
});

test("a pinned map link survives the rewrite, unchanged and idempotently", () => {
  const h = "map/0180?ind=rent&lay=services&pin=59.31972,18.07194&pl=Home&rad=2000";
  assert.strictEqual(R.toV2(h), h);
  assert.strictEqual(R.toV2(R.toV2(h)), h);
  /* the old flag spelling still resolves, and takes the pin with it */
  assert.strictEqual(R.toV2("map/0180?ind=rent&srv=1&pin=59.3,18"),
    "map/0180?ind=rent&pin=59.3,18&lay=services");
});

test("a pin and a property link are two spellings of one point", () => {
  const q = R.pinQuery({ lat: 59.31972, lon: 18.07194, label: "Home", rad: 2000 }, 1000);
  const back = R.pinParse(q);
  assert.strictEqual(R.propSerialise([back]), "59.31972,18.07194:Home");
  assert.deepStrictEqual(R.toInternal("#property?p=59.31972,18.07194:Home&rad=2000").pins,
    [{ lat: 59.31972, lon: 18.07194, label: "Home" }]);
});

/* ---- the redirects the task names ---- */

test("#table/* → #data/areas/*, with an unknown level falling back to kommun", () => {
  assert.strictEqual(R.toV2("#table/regso"), "data/areas/regso");
  assert.strictEqual(R.toV2("#table/deso?ind=growth"), "data/areas/deso?ind=growth");
  assert.strictEqual(R.toV2("#table"), "data/areas/kommun");
  assert.strictEqual(R.toV2("#table/postnr"), "data/areas/kommun");
});

test("#pipeline → #data/projects and #market → #data/national", () => {
  assert.strictEqual(R.toV2("#pipeline?t=rail"), "data/projects?t=rail");
  assert.strictEqual(R.toV2("#market"), "data/national");
});

test("#sources and #market?src=1 both land on #data/sources", () => {
  assert.strictEqual(R.toV2("#sources"), "data/sources");
  assert.strictEqual(R.toV2("#market?src=1"), "data/sources");
  assert.strictEqual(R.toV2("#market?src=0"), "data/national");
});

test("#analysis?a=…&la=… → #property?p=lat,lon:label", () => {
  assert.strictEqual(R.toV2("#analysis?a=59.31972,18.07194&la=Home"),
    "property?p=59.31972,18.07194:Home");
  assert.strictEqual(R.toV2("#analysis?a=59.31972,18.07194"), "property?p=59.31972,18.07194");
  assert.strictEqual(R.toV2("#analysis"), "property");
});

test("the second pin of the old Analysis sheet is dropped — one property at a time", () => {
  const h = R.toV2("#analysis?a=59.3,18.0&la=A&b=57.7,11.97&lb=B");
  assert.strictEqual(h, "property?p=59.3,18:A");
  assert.ok(!/b=/.test(h), "no b= survives: " + h);
});

test("#analysis keeps the keys that are not about the pins", () => {
  assert.strictEqual(R.toV2("#analysis?a=59.3,18.0&ind=unemp&rad=1000"),
    "property?p=59.3,18&ind=unemp&rad=1000");
});

test("#compare lands on the first area's page, on a property, or on the map", () => {
  assert.strictEqual(R.toV2("#compare?a=kommun:0180&b=kommun:1480"), "area/kommun/0180");
  assert.strictEqual(R.toV2("#compare?a=regso:0180R001&b=kommun:1480"), "area/regso/0180R001");
  assert.strictEqual(R.toV2("#compare?a=59.3,18.0"), "property?p=59.3,18");
  assert.strictEqual(R.toV2("#compare"), "map");
  assert.strictEqual(R.toV2("#compare?a=garbage"), "map");
});

test("listings.html#at=…&r=… → #property?p=…&rad=…&show=listings", () => {
  assert.strictEqual(R.fromListingsHash("#at=59.315700,18.030000&r=500"),
    "property?p=59.3157,18.03&rad=500&show=listings");
  /* an r the page never offered is not carried across */
  assert.strictEqual(R.fromListingsHash("#at=59.3,18.0&r=9999"),
    "property?p=59.3,18&show=listings");
  /* no pin at all still opens the section, with the empty state */
  assert.strictEqual(R.fromListingsHash(""), "property?show=listings");
});

test("the Listings filter keys survive the move, prefixed so they cannot collide", () => {
  const h = R.fromListingsHash("#at=59.3,18.0&r=1000&g=homeq,queue&rm=1,2&res=1&offer=1&sort=rent:d");
  assert.match(h, /lg=homeq,queue/);
  assert.match(h, /lrm=1,2/);
  assert.match(h, /lres=1/);
  assert.match(h, /loffer=1/);
  assert.match(h, /lsort=rent:d/);
});

/* ---- the map flags ---- */

test("the five overlay flags become one lay= list, in one canonical order", () => {
  /* the order is the menu's, not the link's, so two links that mean the same thing
     produce the same hash and the idempotence test below has something to stand on */
  assert.strictEqual(R.toV2("#map/0180?srv=1&pub=1"), "map/0180?lay=public,services");
  assert.strictEqual(R.toV2("#map/0180?pub=1&srv=1"), "map/0180?lay=public,services");
  assert.strictEqual(R.toV2("#map?inf=1&sch=1&uso=1"), "map?lay=infra,schools,uso");
  /* a flag that is off contributes nothing and does not leave lay= behind */
  assert.strictEqual(R.toV2("#map?srv=0"), "map");
});

test("a link that already spells lay= keeps it, and a flag only adds", () => {
  assert.strictEqual(R.toV2("#map?lay=infra&srv=1"), "map?lay=infra,services");
  assert.strictEqual(R.toV2("#map?lay=infra,services&srv=1"), "map?lay=infra,services");
});

test("clim=1 selects a climate indicator, and an explicit one wins", () => {
  assert.strictEqual(R.toV2("#map/0180?clim=1"), "map/0180?ind=" + R.CLIM_FALLBACK_IND);
  assert.strictEqual(R.toV2("#map/0180?clim=1&ind=coast30"), "map/0180?ind=coast30");
  assert.strictEqual(R.toV2("#map/0180?clim=1&ind=growth"), "map/0180?ind=" + R.CLIM_FALLBACK_IND);
});

test("isClim can be injected, so the registry decides rather than this file", () => {
  const isClim = k => k === "my_own_climate_key";
  assert.strictEqual(R.toV2("#map?clim=1&ind=my_own_climate_key", { isClim }),
    "map?ind=my_own_climate_key");
});

/* ---- Map only (ind=none) ---- */

test("ind=none survives on every path that has a map", () => {
  assert.strictEqual(R.IND_NONE, "none");
  assert.strictEqual(R.toV2("#map?ind=none"), "map?ind=none");
  assert.strictEqual(R.toV2("#map/0180?ind=none"), "map/0180?ind=none");
  assert.strictEqual(R.toV2("#map/0180/deso?ind=none"), "map/0180/deso?ind=none");
  assert.strictEqual(R.toV2("#area/kommun/0180?ind=none"), "area/kommun/0180?ind=none");
  assert.strictEqual(R.toV2("#area/deso/0180A0010_DeSO2025?ind=none"),
    "area/deso/0180A0010_DeSO2025?ind=none");
  assert.strictEqual(R.toV2("#property?p=59.3,18.07&ind=none"), "property?p=59.3,18.07&ind=none");
});

test("and is dropped from every path that has none — a table column cannot be nothing", () => {
  assert.strictEqual(R.toV2("#data/areas/kommun?ind=none"), "data/areas/kommun");
  assert.strictEqual(R.toV2("#table/regso?ind=none"), "data/areas/regso");
  assert.strictEqual(R.toV2("#charts?ind=none&a=kommun:0180"), "charts?a=kommun:0180");
  assert.strictEqual(R.toV2("#data/national?ind=none"), "data/national");
  /* another key on the same link is untouched */
  assert.strictEqual(R.toV2("#data/areas/regso?ind=none&cols=all"), "data/areas/regso?cols=all");
});

test("Map only carries its layers, and the old flags still fold into them", () => {
  assert.strictEqual(R.toV2("#map?ind=none&srv=1&uso=1"), "map?ind=none&lay=services,uso");
  assert.strictEqual(R.toV2("#map?ind=none&lay=listings"), "map?ind=none&lay=listings");
});

test("clim=1 wins over Map only: a climate link asks for a climate indicator", () => {
  /* `none` is not a climate key, so the flag supplies the fallback exactly as it
     does for any other non-climate indicator */
  assert.strictEqual(R.toV2("#map?clim=1&ind=none"), "map?ind=" + R.CLIM_FALLBACK_IND);
});

test("stripNone is the one rule, and it is idempotent", () => {
  assert.deepStrictEqual(R.stripNone("data/areas/kommun", { ind: "none", y: "2024" }), { y: "2024" });
  assert.deepStrictEqual(R.stripNone("map", { ind: "none" }), { ind: "none" });
  assert.deepStrictEqual(R.stripNone("area/kommun/0180", { ind: "none" }), { ind: "none" });
  /* a real indicator is never touched, on any path */
  assert.deepStrictEqual(R.stripNone("charts", { ind: "growth" }), { ind: "growth" });
  /* "nonetheless" is not "none" */
  assert.deepStrictEqual(R.stripNone("charts", { ind: "none_of_it" }), { ind: "none_of_it" });
});

/* ---- the area page tabs ---- */

test("the area page's t= becomes show= and g= is dropped", () => {
  assert.strictEqual(R.toV2("#area/kommun/0180?t=dist&g=Rents"), "area/kommun/0180?show=dist");
  assert.strictEqual(R.toV2("#area/regso/0180R001?t=sub"), "area/regso/0180R001?show=sub");
  assert.strictEqual(R.toV2("#area/kommun/0180?g=Rents"), "area/kommun/0180");
  /* an existing show= is not overwritten */
  assert.strictEqual(R.toV2("#area/kommun/0180?show=outlook&t=sub"), "area/kommun/0180?show=outlook");
});

/* ---- idempotence, the property that makes it safe to run on every hashchange ---- */

const HASHES = [
  "#map", "#map/0180", "#map/0180/deso", "#map/0180?srv=1&pub=1&clim=1",
  "#map?lay=infra,listings&ind=growth&y=2020&c=59.3,18.0&z=12",
  "#table/kommun", "#table/regso?ind=rent", "#data/areas/deso", "#data/projects",
  "#data/national", "#data/sources", "#market?src=1", "#sources", "#pipeline?t=rail&s=decided",
  "#analysis?a=59.31972,18.07194&la=Home&b=57.7,11.97", "#property?p=59.3,18:Home&rad=1000&show=listings",
  "#compare?a=kommun:0180&b=kommun:1480", "#area/kommun/0180?t=dist&g=Rents",
  "#area/regso/0180R001?show=figures", "#area/deso/0180A0010_DeSO2025",
  "#charts?ind=growth&a=kommun:0180", "#school/12345", "#project/x", "#nonsense/deep/path",
  "#map?ind=none", "#map/0180?ind=none&lay=uso", "#map/0180/deso?ind=none",
  "#area/kommun/0180?ind=none", "#property?p=59.3,18.0&ind=none",
  "#data/areas/kommun?ind=none", "#charts?ind=none&a=kommun:0180",
];

test("toV2 is idempotent for every hash the app has ever emitted", () => {
  for (const h of HASHES) {
    const once = R.toV2(h), twice = R.toV2("#" + once);
    assert.strictEqual(twice, once, `not idempotent: ${h} → ${once} → ${twice}`);
  }
});

test("toInternal returns a view id for every one of them, and never throws", () => {
  for (const h of HASHES) {
    const r = R.toInternal(h);
    assert.ok(r && typeof r.view === "string" && r.view, `no view for ${h}`);
    assert.ok(r.query && typeof r.query === "object", `no query for ${h}`);
  }
});

test("toInternal keeps the old internal view ids so the router needs no second branch", () => {
  assert.strictEqual(R.toInternal("#data/areas/regso").view, "table");
  assert.deepStrictEqual(R.toInternal("#data/areas/regso").parts, ["table", "regso"]);
  assert.strictEqual(R.toInternal("#data/projects").view, "pipeline");
  assert.strictEqual(R.toInternal("#data/national").view, "market");
  assert.strictEqual(R.toInternal("#data/sources").query.src, "1");
  assert.strictEqual(R.toInternal("#map/0180").view, "makro");
  assert.strictEqual(R.toInternal("#area/kommun/0180").view, "area");
  assert.strictEqual(R.toInternal("#school/12345").view, "school");
});

test("toInternal hands the property view its pins already parsed", () => {
  const r = R.toInternal("#analysis?a=59.31972,18.07194&la=Home");
  assert.strictEqual(r.view, "property");
  assert.deepStrictEqual(r.pins, [{ lat: 59.31972, lon: 18.07194, label: "Home" }]);
  assert.ok(!("p" in r.query), "p= is consumed, not passed through");
  assert.deepStrictEqual(R.toInternal("#property").pins, []);
});

test("toInternal names the Data tab, so the tab bar does not re-derive it", () => {
  assert.strictEqual(R.toInternal("#data/areas/kommun").tab, "areas");
  assert.strictEqual(R.toInternal("#pipeline").tab, "projects");
  assert.strictEqual(R.toInternal("#sources").tab, "sources");
});
