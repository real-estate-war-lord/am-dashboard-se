/* node --test tests/testprop.test.js  (make test-js)
   The parser is the one piece of this dashboard a reader hands untrusted text
   to, so every accepted format and every refusal has a case here. */
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { parseLocation, TP_BOUNDS } = require("../src/testprop.js");

const SLUSSEN = [59.31972, 18.07194];          /* Slussen, Stockholm */
const AVENYN = [57.70135, 11.97460];           /* Kungsportsavenyen, Göteborg */

function ok(text, lat, lon, source) {
  const r = parseLocation(text);
  assert.strictEqual(r.error, undefined, `unexpected error: ${r.message}`);
  assert.ok(Math.abs(r.lat - lat) < 1e-6, `lat ${r.lat} != ${lat}`);
  assert.ok(Math.abs(r.lon - lon) < 1e-6, `lon ${r.lon} != ${lon}`);
  if (source) assert.strictEqual(r.source, source);
}
function fails(text, code) {
  const r = parseLocation(text);
  assert.strictEqual(r.error, code, `expected ${code}, got ${r.error || "a coordinate"}`);
  assert.ok((r.message || "").length > 10, "an error must explain itself");
}

test("the !3d/!4d place pin wins over the @ viewport", () => {
  ok("https://www.google.com/maps/place/Slussen/@59.3200,18.0700,17z/data=!4m6!3m5!1s0x0:0x0!8m2!3d59.31972!4d18.07194",
     SLUSSEN[0], SLUSSEN[1], "place");
});
test("falls back to @ when there is no !3d", () => {
  ok("https://www.google.com/maps/@59.31972,18.07194,17z", SLUSSEN[0], SLUSSEN[1], "at");
});
test("a bare @ URL with a trailing path", () => {
  ok("https://maps.google.se/maps/@57.70135,11.97460,15.5z/data=!3m1", AVENYN[0], AVENYN[1], "at");
});
test("q= with an encoded comma", () => {
  ok("https://www.google.com/maps?q=59.31972%2C18.07194", SLUSSEN[0], SLUSSEN[1], "param");
});
test("q= with a plus for the space", () => {
  ok("https://www.google.com/maps?q=59.31972,+18.07194", SLUSSEN[0], SLUSSEN[1], "param");
});
test("ll=", () => ok("https://maps.google.com/?ll=57.70135,11.97460&z=16", AVENYN[0], AVENYN[1], "param"));
test("query=", () => ok("https://www.google.com/maps/search/?api=1&query=59.31972,18.07194", SLUSSEN[0], SLUSSEN[1], "param"));
test("/search/ path", () => ok("https://www.google.com/maps/search/59.31972,18.07194", SLUSSEN[0], SLUSSEN[1], "search"));
test("a plain pair with a comma", () => ok("59.31972, 18.07194", SLUSSEN[0], SLUSSEN[1], "plain"));
test("a plain pair with a space", () => ok("59.31972 18.07194", SLUSSEN[0], SLUSSEN[1], "plain"));
test("a plain pair with a semicolon", () => ok("59.31972;18.07194", SLUSSEN[0], SLUSSEN[1], "plain"));

test("the far north is inside Sweden", () => ok("68.35, 18.82", 68.35, 18.82, "plain"));
test("the far south is inside Sweden", () => ok("55.34, 13.36", 55.34, 13.36, "plain"));
test("Gotland is inside Sweden", () => ok("57.63, 18.30", 57.63, 18.30, "plain"));

test("a short share link is refused by name", () => fails("https://maps.app.goo.gl/AbCdEf123", "short_link"));
test("goo.gl too", () => fails("https://goo.gl/maps/xyz", "short_link"));
test("a swapped pair is caught by the box", () => fails("18.07194, 59.31972", "outside_se"));
test("Hamburg is south of the box", () => fails("53.55, 9.99", "outside_se"));
test("Helsinki is east of the box", () => fails("60.17, 24.94", "outside_se"));
test("Tromsø is north-west of the box", () => fails("69.65, 18.96", "outside_se"));

/* The box is a coarse sanity check on the NUMBERS, not a border. Oslo and
   Copenhagen both fall inside a rectangle drawn around Sweden, and that is fine:
   parseLocation's job is to catch a swapped pair or a typo, and locate() in
   app.js gives the real answer by testing the point against our own rings. A
   test that pretended otherwise would be testing a promise the design does not
   make. */
test("the box is coarse: a neighbour's capital inside the rectangle is passed on to locate()", () => {
  for (const near of ["55.67610, 12.56830", "59.91, 10.75"]) {
    const r = parseLocation(near);
    assert.strictEqual(r.error, undefined, `${near} should pass the box`);
  }
});
test("empty input", () => fails("", "empty"));
test("text with no coordinates", () => fails("Sveavägen 10, Stockholm", "no_match"));

test("the Sweden box is the documented one", () => {
  assert.deepStrictEqual(TP_BOUNDS.lat, [55.0, 69.2]);
  assert.deepStrictEqual(TP_BOUNDS.lon, [10.5, 24.3]);
});
