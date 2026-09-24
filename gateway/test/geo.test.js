/* Box maths and haversine. */
"use strict";

import test from "node:test";
import assert from "node:assert/strict";
import { boundingBox, haversine, M_PER_DEG_LAT } from "../src/geo.js";

const SLUSSEN = { lat: 59.3165, lon: 18.0335 };

test("the box is square in metres, not in degrees", () => {
  const b = boundingBox(SLUSSEN.lat, SLUSSEN.lon, 500);
  const latSpan = haversine(b.min_lat, SLUSSEN.lon, b.max_lat, SLUSSEN.lon);
  const lonSpan = haversine(SLUSSEN.lat, b.min_lng, SLUSSEN.lat, b.max_lng);
  /* Both sides are 2r across. The two spans must agree to well under a metre;
   * if the longitude offset ever loses its cos(lat) factor this gap becomes
   * ~960 m at Stockholm's latitude. */
  assert.ok(Math.abs(latSpan - lonSpan) < 1, `latSpan ${latSpan} vs lonSpan ${lonSpan}`);
  assert.ok(Math.abs(latSpan - 1000) < 2, `latSpan ${latSpan}`);
});

test("the box is centred on the point", () => {
  const b = boundingBox(SLUSSEN.lat, SLUSSEN.lon, 1000);
  assert.ok(Math.abs((b.min_lat + b.max_lat) / 2 - SLUSSEN.lat) < 1e-12);
  assert.ok(Math.abs((b.min_lng + b.max_lng) / 2 - SLUSSEN.lon) < 1e-12);
  assert.ok(b.min_lat < SLUSSEN.lat && b.max_lat > SLUSSEN.lat);
  assert.ok(b.min_lng < SLUSSEN.lon && b.max_lng > SLUSSEN.lon);
});

test("the latitude offset is r/111320 degrees and does not depend on latitude", () => {
  for (const lat of [55, 59.3165, 67.85]) {
    const b = boundingBox(lat, 18, 500);
    assert.ok(Math.abs((b.max_lat - lat) - 500 / M_PER_DEG_LAT) < 1e-12);
  }
});

test("the longitude offset widens as you go north", () => {
  const south = boundingBox(55, 18, 500);
  const north = boundingBox(67.85, 18, 500); // Kiruna
  const widthDeg = (b) => b.max_lng - b.min_lng;
  assert.ok(widthDeg(north) > widthDeg(south));
  /* cos(55)/cos(67.85) = 0.5736/0.3767 */
  assert.ok(Math.abs(widthDeg(north) / widthDeg(south) - Math.cos(55 * Math.PI / 180) / Math.cos(67.85 * Math.PI / 180)) < 1e-9);
});

test("the box scales linearly with the radius", () => {
  const a = boundingBox(SLUSSEN.lat, SLUSSEN.lon, 500);
  const b = boundingBox(SLUSSEN.lat, SLUSSEN.lon, 3000);
  assert.ok(Math.abs((b.max_lat - SLUSSEN.lat) / (a.max_lat - SLUSSEN.lat) - 6) < 1e-9);
});

test("haversine: zero, symmetry and a known distance", () => {
  assert.equal(haversine(SLUSSEN.lat, SLUSSEN.lon, SLUSSEN.lat, SLUSSEN.lon), 0);
  const gbg = { lat: 57.7089, lon: 11.9746 };
  const there = haversine(SLUSSEN.lat, SLUSSEN.lon, gbg.lat, gbg.lon);
  const back = haversine(gbg.lat, gbg.lon, SLUSSEN.lat, SLUSSEN.lon);
  assert.equal(there, back);
  /* Slussen - central Goteborg is 394.5 km on a sphere of this radius,
   * cross-checked against the spherical law of cosines (394.492 km) and
   * Vincenty on WGS84 (395.749 km — the 0.3 % gap is sphere versus
   * ellipsoid, which is well inside what a listings search needs). */
  assert.ok(there > 393_000 && there < 396_000, `${there} m`);
});

test("haversine: one degree of latitude is about 111.2 km anywhere", () => {
  for (const lat of [55, 62, 69]) {
    const d = haversine(lat, 18, lat + 1, 18);
    assert.ok(Math.abs(d - 111_195) < 200, `at ${lat}: ${d} m`);
  }
});

test("the box corner is further away than the radius", () => {
  /* This is the whole reason selectNearby trims: the corner of the box sits
   * at r*sqrt(2), so a box-only search over-reaches by 41 %. */
  const r = 500;
  const b = boundingBox(SLUSSEN.lat, SLUSSEN.lon, r);
  const corner = haversine(SLUSSEN.lat, SLUSSEN.lon, b.max_lat, b.max_lng);
  assert.ok(Math.abs(corner - r * Math.SQRT2) < 5, `${corner} m`);
});
