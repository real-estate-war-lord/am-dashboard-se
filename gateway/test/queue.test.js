/* Bostadsförmedlingen — the municipal queue source. */
"use strict";

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSnapshot, normaliseRecord, selectNearby, audienceOf, SRC, SRC_LABEL, ALLOCATION,
} from "../src/sources/bostadsformedlingen.js";
import { QUEUE_RECORDS } from "./fixtures/sources.js";

const NOW = new Date("2026-09-24T12:00:00.000Z");

test("queue listings are marked as allocated by queue", () => {
  /* The whole reason this source is tagged: these flats are real supply but
   * are not available to whoever applies first. */
  assert.equal(ALLOCATION, "queue");
  assert.equal(normaliseRecord(QUEUE_RECORDS[0], null).allocation, "queue");
  assert.match(SRC_LABEL, /kö/);
});

test("a record maps onto the shared schema plus the queue fields", () => {
  const out = normaliseRecord(QUEUE_RECORDS[0], null);
  assert.equal(out.src, SRC);
  assert.equal(out.id, "202500001");
  assert.equal(out.url, "https://bostad.stockholm.se/bostad/202500001/");
  assert.equal(out.address, "Köexempelgatan 3");
  assert.equal(out.rent_sek_mo, 8900);
  assert.equal(out.size_m2, 56);
  assert.equal(out.rooms, 2);
  assert.equal(out.floor, 2);
  assert.equal(out.published, "2026-09-22");
  assert.equal(out.apply_by, "2026-09-30");
  assert.equal(out.queue_name, "Bostadskön");
  assert.equal(out.queue_years_q1, 5);
  assert.equal(out.queue_years_q3, 10);
});

test("the area name carries the kommun when it differs from the stadsdel", () => {
  /* "Alby" alone is ambiguous; "Botkyrka - Alby" is not. */
  assert.equal(normaliseRecord(QUEUE_RECORDS[0], null).area_name, "Teststad - Testby");
  /* and is not doubled when they are the same */
  assert.equal(normaliseRecord(QUEUE_RECORDS[1], null).area_name, "Testby");
});

test("a reserved audience is tagged, an ordinary flat is not", () => {
  assert.equal(audienceOf({ Vanlig: true }), null);
  assert.equal(audienceOf({ Ungdom: true }), "youth");
  assert.equal(audienceOf({ Senior: true }), "senior");
  assert.equal(audienceOf({ Korttid: true }), "short_term");
  /* student beats youth when an advert carries both, which live records do */
  assert.equal(audienceOf({ Ungdom: true, Student: true }), "student");
  assert.equal(normaliseRecord(QUEUE_RECORDS[1], null).audience, "student");
  assert.equal(normaliseRecord(QUEUE_RECORDS[0], null).audience, null);
});

test("queue-time quartiles are passed through, never averaged into one figure", () => {
  const out = normaliseRecord(QUEUE_RECORDS[1], null);
  assert.equal(out.queue_years_q1, 2);
  assert.equal(out.queue_years_q3, 4);
  /* A single "expected queue time" would hide the spread, which is the point. */
  assert.ok(!("queue_years" in out));
});

test("a missing statistics block leaves the queue fields null", () => {
  const out = normaliseRecord({ ...QUEUE_RECORDS[0], LiknadeLagenhetStatistik: null }, null);
  assert.equal(out.queue_years_q1, null);
  assert.equal(out.queue_years_q3, null);
});

test("0,0 coordinates are dropped and counted", () => {
  const snap = buildSnapshot(QUEUE_RECORDS, NOW);
  assert.equal(snap.count, 2);
  assert.equal(snap.dropped, 1);
  assert.ok(snap.listings.every((l) => !(l.lat === 0 && l.lon === 0)));
});

test("a non-array payload throws with the source named", () => {
  assert.throws(() => buildSnapshot({ nope: true }, NOW), /Bostadsförmedlingen/);
  assert.throws(() => buildSnapshot(null, NOW), /Bostadsförmedlingen/);
});

test("selectNearby trims to the radius and sorts", () => {
  const snap = buildSnapshot(QUEUE_RECORDS, NOW);
  const near = selectNearby(snap, 59.3166, 18.0336, 3000);
  assert.equal(near.length, 2);
  assert.ok(near[0].dist_m <= near[1].dist_m);
  assert.deepEqual(selectNearby(snap, 57.7, 11.9, 500), []);
});
