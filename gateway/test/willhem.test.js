/* The Willhem adapter. */
"use strict";

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSnapshot, normaliseRecord, selectNearby, swedishNumber, parseRooms, prop,
  SRC, ALLOCATION,
} from "../src/sources/willhem.js";
import { WILLHEM_CHILDREN } from "./fixtures/sources.js";

const RECORDS = WILLHEM_CHILDREN.filter((c) => (c.contentType || []).includes("VacantObjectPage"));
const REGION = [{ name: "Testby", records: RECORDS }];
const NOW = new Date("2026-09-24T12:00:00.000Z");

test("Episerver's {value} wrapper is unwrapped, bare values pass through", () => {
  assert.equal(prop({ value: 59.3, propertyDataType: "PropertyFloatNumber" }), 59.3);
  assert.equal(prop("9500"), "9500");
  assert.equal(prop(null), null);
  assert.equal(prop({ value: null }), null);
});

test("a Swedish decimal comma is not a thousands separator", () => {
  /* Number("34,7") is NaN, which silently nulled the size of 155 of 645 live
   * flats before this existed. */
  assert.equal(swedishNumber("34,7"), 34.7);
  assert.equal(swedishNumber("62,5"), 62.5);
  assert.equal(swedishNumber("81"), 81);
  assert.equal(swedishNumber(45), 45);
  assert.equal(swedishNumber("1 234"), 1234);
  assert.equal(swedishNumber("abc"), null);
  assert.equal(swedishNumber(null), null);
  assert.equal(swedishNumber(NaN), null);
});

test("room counts are prose and must be parsed", () => {
  assert.equal(parseRooms("2 rum & kök"), 2);
  assert.equal(parseRooms("1.5 rum & kök"), 1.5);
  assert.equal(parseRooms("1,5 rum & kök"), 1.5);
  assert.equal(parseRooms("6 rum & kök"), 6);
  assert.equal(parseRooms(3), 3);
  assert.equal(parseRooms("rum"), null);
  assert.equal(parseRooms(null), null);
});

test("a record maps onto the shared schema", () => {
  const out = normaliseRecord(RECORDS[0], "Testby");
  assert.deepEqual(out, {
    src: "willhem",
    src_label: "Willhem",
    id: "900001",
    url: "https://www.willhem.se/sok-bostad/Testby/exempelgatan-12-a/",
    address: "Exempelgatan 12 A",
    area_name: "Testby",
    lat: 59.3170,
    lon: 18.0340,
    rent_sek_mo: 9500,
    size_m2: 62.5,
    rooms: 2,
    floor: 3,
    year_built: null,
    available_from: "2026-12-01",
    published: "2026-09-20",
    image: null,
    text_start: "Ljus tvåa med balkong.",
    discount: null,
    offer: null,
    is_new_production: null,
    allocation: "direct",
    audience: null,
    geo_source: "source",
  });
});

test("the Om lägenheten heading is stripped from the excerpt", () => {
  assert.ok(!normaliseRecord(RECORDS[0], "X").text_start.startsWith("Om lägenheten"));
});

test("a campaign in the description becomes an offer", () => {
  const out = normaliseRecord(RECORDS[1], "Testby");
  assert.equal(out.offer.flag, true);
  assert.match(out.offer.snippet, /första månaden/);
});

test("a student flat is tagged", () => {
  assert.equal(normaliseRecord(RECORDS[1], "Testby").audience, "student");
  assert.equal(normaliseRecord(RECORDS[0], "Testby").audience, null);
});

test("stray whitespace is trimmed off the address", () => {
  assert.equal(normaliseRecord(RECORDS[1], "Testby").address, "Provvägen 5");
});

test("floor 0 survives as a real ground floor", () => {
  assert.equal(normaliseRecord(RECORDS[1], "Testby").floor, 0);
});

test("Willhem lets directly, never by queue", () => {
  assert.equal(ALLOCATION, "direct");
  assert.equal(normaliseRecord(RECORDS[0], "X").allocation, "direct");
});

test("a record without coordinates is dropped and counted", () => {
  const snap = buildSnapshot(REGION, NOW);
  assert.equal(snap.src, SRC);
  assert.equal(snap.count, 2);
  assert.equal(snap.dropped, 1);
  assert.equal(snap.fetchedAt, NOW.toISOString());
  assert.ok(snap.listings.every((l) => !("dist_m" in l)));
});

test("selectNearby trims and adds dist_m without mutating the snapshot", () => {
  const snap = buildSnapshot(REGION, NOW);
  const near = selectNearby(snap, 59.3170, 18.0340, 100);
  assert.equal(near.length, 1);
  assert.equal(near[0].dist_m, 0);
  assert.ok(snap.listings.every((l) => !("dist_m" in l)));
  assert.deepEqual(selectNearby(snap, 57.7, 11.9, 500), []);
  assert.deepEqual(selectNearby(null, 59.3, 18, 500), []);
});
