/* Normalisation of the HomeQ payloads.
 *
 * The fixtures below are synthetic — invented addresses, ids and prices in
 * the *shape* the live API returns. No third-party listing data is committed
 * to this repository, which is the same rule the gateway itself follows at
 * runtime (docs/LISTINGS.md).
 */
"use strict";

import test from "node:test";
import assert from "node:assert/strict";
import {
  normaliseListing, selectNearby, toPlainText, normaliseText, SRC, SRC_LABEL,
} from "../src/sources/homeq.js";
import { boundingBox, haversine } from "../src/geo.js";

const CENTER = { lat: 59.3165, lon: 18.0335 };

/* A hit with every field the live search endpoint carries. */
const FULL = {
  id: 100001,
  references: { estate: 1, apartment: 2, object_ad: 100001, company: 3, office: 4, project: null },
  type: "individual",
  uri: "/lagenhet/100001-2rum-stockholm-stockholms-lan-exempelgatan-1",
  municipality: "Stockholm",
  county: "Stockholms län",
  city: "Stockholm",
  location: { lat: 59.3170, lon: 18.0340 },
  images: [
    { image: "https://example.invalid/a.jpeg", caption: "", position: 0 },
    { image: "https://example.invalid/b.jpeg", caption: "", position: 1 },
  ],
  videos: [],
  boost_value: 0,
  discount: { months: 2 },
  title: "Exempelgatan 1",
  audience: "everyone",
  is_short_lease: false,
  early_access: null,
  rent: 12500,
  rooms: 2,
  area: 54,
  date_access: "2026-11-01",
  is_quick_apply: false,
};

test("a full hit maps onto the gateway schema", () => {
  const out = normaliseListing(FULL, CENTER);
  assert.deepEqual(out, {
    src: "homeq",
    src_label: "HomeQ",
    id: 100001,
    url: "https://www.homeq.se/lagenhet/100001-2rum-stockholm-stockholms-lan-exempelgatan-1",
    address: "Exempelgatan 1",
    area_name: null,
    lat: 59.3170,
    lon: 18.0340,
    rent_sek_mo: 12500,
    size_m2: 54,
    rooms: 2,
    floor: null,
    year_built: null,
    available_from: "2026-11-01",
    published: null,
    image: "https://example.invalid/a.jpeg",
    text_start: null,
    discount: { months: 2 },
    is_new_production: null,
    dist_m: out.dist_m,
  });
});

test("the schema keys are fixed, in order, and nothing leaks through", () => {
  /* A consumer reads these by name; an upstream field appearing unmapped
   * would be third-party data the gateway never promised to pass on. */
  assert.deepEqual(Object.keys(normaliseListing(FULL, CENTER)), [
    "src", "src_label", "id", "url", "address", "area_name", "lat", "lon",
    "rent_sek_mo", "size_m2", "rooms", "floor", "year_built", "available_from",
    "published", "image", "text_start", "discount", "is_new_production", "dist_m",
  ]);
});

test("src and label are the source's own constants", () => {
  const out = normaliseListing(FULL, CENTER);
  assert.equal(out.src, SRC);
  assert.equal(out.src_label, SRC_LABEL);
});

test("dist_m is the haversine distance, rounded to whole metres", () => {
  const out = normaliseListing(FULL, CENTER);
  const exact = haversine(CENTER.lat, CENTER.lon, FULL.location.lat, FULL.location.lon);
  assert.equal(out.dist_m, Math.round(exact));
  assert.ok(Number.isInteger(out.dist_m));
  assert.ok(out.dist_m > 50 && out.dist_m < 70, `${out.dist_m} m`); // ~58 m
});

test("missing optional fields become null, never undefined", () => {
  const sparse = { id: 2, uri: "/lagenhet/2", location: { lat: 59.32, lon: 18.03 } };
  const out = normaliseListing(sparse, CENTER);
  for (const key of ["address", "rent_sek_mo", "size_m2", "rooms", "available_from", "image", "discount"]) {
    assert.equal(out[key], null, `${key} should be null`);
  }
  assert.ok(Object.values(out).every((v) => v !== undefined));
});

test("an empty image array does not throw", () => {
  assert.equal(normaliseListing({ ...FULL, images: [] }, CENTER).image, null);
  assert.equal(normaliseListing({ ...FULL, images: undefined }, CENTER).image, null);
});

test("a hit without usable coordinates is dropped", () => {
  assert.equal(normaliseListing({ ...FULL, location: null }, CENTER), null);
  assert.equal(normaliseListing({ ...FULL, location: {} }, CENTER), null);
  assert.equal(normaliseListing({ ...FULL, location: { lat: "59.3", lon: "18.0" } }, CENTER), null);
  assert.equal(normaliseListing({ ...FULL, location: { lat: NaN, lon: 18 } }, CENTER), null);
});

test("selectNearby trims the box corners back to a circle", () => {
  const r = 500;
  const box = boundingBox(CENTER.lat, CENTER.lon, r);
  const payload = {
    results: [
      { ...FULL, id: 1, location: { lat: box.max_lat, lon: box.max_lng } },  // corner: 707 m
      { ...FULL, id: 2, location: { lat: box.max_lat, lon: CENTER.lon } },   // edge:   500 m
      { ...FULL, id: 3, location: CENTER },                                  // centre:   0 m
    ],
  };
  const out = selectNearby(payload, CENTER.lat, CENTER.lon, r);
  assert.deepEqual(out.map((l) => l.id), [3, 2], "the corner hit must be trimmed away");
});

test("selectNearby sorts nearest first", () => {
  const payload = {
    results: [
      { ...FULL, id: "far", location: { lat: 59.3200, lon: 18.0335 } },
      { ...FULL, id: "near", location: { lat: 59.3167, lon: 18.0335 } },
      { ...FULL, id: "mid", location: { lat: 59.3180, lon: 18.0335 } },
    ],
  };
  const out = selectNearby(payload, CENTER.lat, CENTER.lon, 1000);
  assert.deepEqual(out.map((l) => l.id), ["near", "mid", "far"]);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].dist_m >= out[i - 1].dist_m);
});

test("selectNearby survives a payload with no results", () => {
  for (const payload of [{ results: [] }, {}, null, { results: null }]) {
    assert.deepEqual(selectNearby(payload, CENTER.lat, CENTER.lon, 500), []);
  }
});

test("toPlainText strips markup and collapses whitespace", () => {
  assert.equal(toPlainText("<p>Ljus <b>tvåa</b></p><p>Nära tunnelbanan</p>"), "Ljus tvåa Nära tunnelbanan");
  assert.equal(toPlainText("Rad ett<br>Rad två"), "Rad ett Rad två");
  assert.equal(toPlainText("Kök &amp; bad&nbsp;ingår"), "Kök & bad ingår");
  assert.equal(toPlainText("<script>alert(1)</script>Text"), "Text");
  assert.equal(toPlainText("  spaced   out \n text "), "spaced out text");
  assert.equal(toPlainText(null), "");
  assert.equal(toPlainText(undefined), "");
});

test("normaliseText returns the first 220 characters", () => {
  const long = "Lägenheten ".repeat(60);
  const { text_start } = normaliseText({ object_ad: { description: long } });
  assert.equal(text_start.length, 220);
  assert.equal(text_start, toPlainText(long).slice(0, 220));
});

test("a short description is returned whole, and a missing one is null", () => {
  assert.equal(normaliseText({ object_ad: { description: "Kort text." } }).text_start, "Kort text.");
  assert.equal(normaliseText({ object_ad: {} }).text_start, null);
  assert.equal(normaliseText({}).text_start, null);
  assert.equal(normaliseText({ object_ad: { description: "   " } }).text_start, null);
});
