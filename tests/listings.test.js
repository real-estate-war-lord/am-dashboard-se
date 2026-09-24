/* The Listings page's two testable halves: the location parser and the
 * filter/median logic. Both are DOM-free on purpose.
 *
 *   node --test tests/listings.test.js
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseLocation, LP_BOUNDS } = require("../src/listings/parse.js");
const V = require("../src/listings/view.js");

/* ---------- the parser ---------- */

test("the place pin wins over the viewport centre", () => {
  /* A Google place URL carries both: @... is where the map was looking,
   * !3d/!4d is the pin itself. Taking the viewport would put the marker a
   * street or two away from the thing the reader actually clicked. */
  const r = parseLocation("https://www.google.com/maps/place/X/@59.3195,18.0715,17z/data=!3m1!4b1!4m6!3d59.31650!4d18.03350");
  assert.deepEqual(r, { lat: 59.3165, lon: 18.0335, source: "place" });
});

test("every documented format is accepted", () => {
  const cases = [
    ["https://www.google.com/maps/@59.33258,18.06490,17z", "at"],
    ["https://maps.google.com/maps?q=59.33258,18.06490", "param"],
    ["https://www.google.com/maps?ll=59.33258,18.06490", "param"],
    ["https://www.google.com/maps/search/59.33258,18.06490", "search"],
    ["59.33258, 18.06490", "plain"],
    ["59.33258;18.06490", "plain"],
    ["59.33258 18.06490", "plain"],
  ];
  for (const [text, source] of cases) {
    const r = parseLocation(text);
    assert.equal(r.source, source, text);
    assert.ok(Math.abs(r.lat - 59.33258) < 1e-9, text);
    assert.ok(Math.abs(r.lon - 18.0649) < 1e-9, text);
  }
});

test("url encoding is decoded before matching", () => {
  /* "+" is a space and %2C a comma in a query string. */
  assert.equal(parseLocation("https://maps.google.com/?q=59.33258%2C18.06490").source, "param");
  assert.equal(parseLocation("59.33258,+18.06490").source, "plain");
});

test("a short share link is refused with an explanation, not silently", () => {
  /* Resolving it would mean the page calling Google on the reader's behalf. */
  for (const u of ["https://maps.app.goo.gl/abc", "https://goo.gl/maps/xyz", "https://g.co/kgs/abc"]) {
    const r = parseLocation(u);
    assert.equal(r.error, "short_link", u);
    assert.match(r.message, /copy the full URL/i);
  }
});

test("a swapped lat/lon pair is caught, not plotted in the Black Sea", () => {
  const r = parseLocation("18.0335, 59.3165");
  assert.equal(r.error, "outside_se");
  assert.match(r.message, /Latitude comes first/);
});

test("points outside Sweden are refused at both ends of the box", () => {
  assert.equal(parseLocation(`${LP_BOUNDS.lat[0] - 0.1}, 18`).error, "outside_se");
  assert.equal(parseLocation(`${LP_BOUNDS.lat[1] + 0.1}, 18`).error, "outside_se");
  assert.equal(parseLocation(`62, ${LP_BOUNDS.lon[0] - 0.1}`).error, "outside_se");
  assert.equal(parseLocation(`62, ${LP_BOUNDS.lon[1] + 0.1}`).error, "outside_se");
  /* and the corners of the box itself are inside */
  assert.ok(parseLocation(`${LP_BOUNDS.lat[0]}, ${LP_BOUNDS.lon[0]}`).lat);
  assert.ok(parseLocation(`${LP_BOUNDS.lat[1]}, ${LP_BOUNDS.lon[1]}`).lat);
});

test("empty and unparseable input each get their own message", () => {
  assert.equal(parseLocation("").error, "empty");
  assert.equal(parseLocation("   ").error, "empty");
  assert.equal(parseLocation(null).error, "empty");
  assert.equal(parseLocation("Storgatan 1, Stockholm").error, "no_match");
});

/* ---------- grouping and filters ---------- */

const L = (o) => ({
  src: "homeq", src_label: "HomeQ", id: Math.random().toString(36).slice(2),
  address: "A 1", area_name: "Area", lat: 59.3, lon: 18.0, dist_m: 100,
  rent_sek_mo: 9000, size_m2: 50, rooms: 2, floor: 1, allocation: "direct",
  audience: null, offer: null, url: "https://example.invalid/x", ...o,
});

test("a queue listing groups by allocation, not by source name", () => {
  /* So a new queue source lands in the right group without a code change. */
  assert.equal(V.groupOf(L({ src: "bostadsformedlingen", allocation: "queue" })), "queue");
  assert.equal(V.groupOf(L({ src: "brand-new-queue", allocation: "queue" })), "queue");
  assert.equal(V.groupOf(L({ src: "homeq" })), "homeq");
  assert.equal(V.groupOf(L({ src: "lkf" })), "portal");
  assert.equal(V.groupOf(L({ src: "willhem" })), "portal");
});

test("reserved listings are hidden by default and countable", () => {
  const all = [L({}), L({ audience: "student" }), L({ audience: "youth" }), L({ audience: "senior" }), L({ audience: "short_term" })];
  assert.equal(V.applyFilters(all, {}).length, 1);
  assert.equal(V.hiddenCounts(all, {}).reserved, 4);
  assert.equal(V.applyFilters(all, { showReserved: true }).length, 5);
});

test("filters compose", () => {
  const all = [
    L({ src: "homeq", rooms: 1 }),
    L({ src: "lkf", rooms: 2, allocation: "direct" }),
    L({ src: "bostadsformedlingen", rooms: 2, allocation: "queue" }),
    L({ src: "homeq", rooms: 5, offer: { flag: true, snippet: "Kampanj" } }),
  ];
  assert.equal(V.applyFilters(all, { groups: ["homeq"] }).length, 2);
  assert.equal(V.applyFilters(all, { allocation: ["queue"] }).length, 1);
  assert.equal(V.applyFilters(all, { offerOnly: true }).length, 1);
  assert.equal(V.applyFilters(all, { rooms: ["2"] }).length, 2);
  assert.equal(V.applyFilters(all, { rooms: ["4+"] }).length, 1, "5 rooms falls in the 4+ bucket");
  assert.equal(V.applyFilters(all, { sources: ["lkf"] }).length, 1);
  assert.equal(V.applyFilters(all, { groups: ["homeq"], rooms: ["1"] }).length, 1);
});

test("room bucketing puts a half with the whole number below it, consistently", () => {
  /* "2,5 rum & kök" is a two-room flat plus a half. Rounding 1.5 up and 2.5
   * down — which an earlier version did — puts equivalent flats in different
   * buckets depending on how the landlord wrote the number. */
  assert.equal(V.roomBucket(1), "1");
  assert.equal(V.roomBucket(1.5), "1");
  assert.equal(V.roomBucket(2), "2");
  assert.equal(V.roomBucket(2.5), "2");
  assert.equal(V.roomBucket(3), "3");
  assert.equal(V.roomBucket(3.5), "3");
  assert.equal(V.roomBucket(4), "4+");
  assert.equal(V.roomBucket(9), "4+");
  assert.equal(V.roomBucket(null), null);
  assert.equal(V.roomBucket(0), null);
});

test("an empty filter set shows everything, an empty listing set breaks nothing", () => {
  assert.equal(V.applyFilters([], {}).length, 0);
  assert.equal(V.applyFilters(null, {}).length, 0);
  assert.equal(V.applyFilters([L({})], null).length, 1);
});

/* ---------- the rent figure ---------- */

test("SEK/m²/yr needs both parts and is never inferred from one", () => {
  assert.equal(V.sekPerM2Year(L({ rent_sek_mo: 9000, size_m2: 50 })), 2160);
  assert.equal(V.sekPerM2Year(L({ rent_sek_mo: null, size_m2: 50 })), null);
  assert.equal(V.sekPerM2Year(L({ rent_sek_mo: 9000, size_m2: null })), null);
  assert.equal(V.sekPerM2Year(L({ rent_sek_mo: 9000, size_m2: 0 })), null);
});

test("a median of fewer than three listings is suppressed, not printed", () => {
  /* Two adverts are not a market rate, and printing one next to a median of
   * forty invites the reader to treat them alike. */
  const two = [L({ rooms: 1, rent_sek_mo: 6000, size_m2: 30 }), L({ rooms: 1, rent_sek_mo: 7000, size_m2: 30 })];
  const [row] = V.mediansByRooms(two);
  assert.equal(row.rooms, "1");
  assert.equal(row.n, 2);
  assert.equal(row.median, null);
  assert.equal(row.suppressed, true);
});

test("three listings give a median, and it is the middle value", () => {
  const three = [
    L({ rooms: 2, rent_sek_mo: 5000, size_m2: 50 }),   // 1200
    L({ rooms: 2, rent_sek_mo: 9000, size_m2: 50 }),   // 2160
    L({ rooms: 2, rent_sek_mo: 7000, size_m2: 50 }),   // 1680
  ];
  const [row] = V.mediansByRooms(three);
  assert.equal(row.n, 3);
  assert.equal(row.median, 1680);
  assert.equal(row.suppressed, false);
});

test("an even count averages the middle pair", () => {
  assert.equal(V.median([1, 2, 3, 4]), 2.5);
  assert.equal(V.median([5]), 5);
  assert.equal(V.median([]), null);
  assert.equal(V.median([1, null, 3]), 2);
});

test("listings without a usable rent are left out of the median, not counted as zero", () => {
  const rows = V.mediansByRooms([
    L({ rooms: 3, rent_sek_mo: 9000, size_m2: 50 }),
    L({ rooms: 3, rent_sek_mo: 9000, size_m2: 50 }),
    L({ rooms: 3, rent_sek_mo: 9000, size_m2: 50 }),
    L({ rooms: 3, rent_sek_mo: null, size_m2: 50 }),
  ]);
  assert.equal(rows[0].n, 3, "the one without a rent is not counted");
  assert.equal(rows[0].median, 2160);
});

test("medians come back in room order", () => {
  const mk = (rooms) => [0, 1, 2].map(() => L({ rooms, rent_sek_mo: 9000, size_m2: 50 }));
  const rows = V.mediansByRooms([...mk(4), ...mk(1), ...mk(2)]);
  assert.deepEqual(rows.map((r) => r.rooms), ["1", "2", "4+"]);
});

/* ---------- map helpers ---------- */

test("listings on one point are clustered so none is hidden", () => {
  const a = L({ lat: 59.3, lon: 18.0 }), b = L({ lat: 59.3, lon: 18.0 }), c = L({ lat: 59.4, lon: 18.1 });
  const clusters = V.clusterByPoint([a, b, c]).sort((x, y) => y.length - x.length);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].length, 2);
});

test("a single listing is not offset; a shared point fans out evenly", () => {
  assert.deepEqual(V.spiderOffsets(1, 59.3), [[0, 0]]);
  const offs = V.spiderOffsets(4, 59.3);
  assert.equal(offs.length, 4);
  /* every spoke the same distance from the centre, in metres */
  const d = offs.map(([dLat, dLon]) =>
    Math.hypot(dLat * 111320, dLon * 111320 * Math.cos((59.3 * Math.PI) / 180)));
  for (const x of d) assert.ok(Math.abs(x - 12) < 0.5, String(x));
});

test("unplaceable listings are skipped by the clusterer", () => {
  assert.equal(V.clusterByPoint([L({ lat: null, lon: null })]).length, 0);
});

/* ---------- source status ---------- */

test("a failing source keeps its chip instead of becoming a zero", () => {
  const chips = V.sourceChips({
    sources: [
      { src: "homeq", ok: true, count: 7 },
      { src: "lkf", ok: true, count: 3, fetchedAt: new Date(Date.now() - 90 * 60000).toISOString() },
      { src: "willhem", ok: false, count: 0, error: "Willhem did not answer in time" },
      { src: "dios", ok: false, count: 0, error: "stale — snapshot is from …" },
    ],
  });
  assert.equal(chips.length, 4);
  assert.equal(chips[0].live, true);
  assert.equal(chips[1].age, "2 h ago");
  assert.equal(chips[2].ok, false);
  assert.equal(chips[2].stale, false);
  assert.match(chips[2].error, /did not answer/);
  assert.equal(chips[3].stale, true, "a stale snapshot is distinguished from an outright failure");
});

test("snapshot age reads in the largest sensible unit", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  const at = (ms) => new Date(now - ms).toISOString();
  assert.equal(V.snapshotAge(at(0), now), "just now");
  assert.equal(V.snapshotAge(at(5 * 60000), now), "5 min ago");
  assert.equal(V.snapshotAge(at(3 * 3600000), now), "3 h ago");
  assert.equal(V.snapshotAge(at(3 * 86400000), now), "3 d ago");
  assert.equal(V.snapshotAge(null, now), null);
  assert.equal(V.snapshotAge("nonsense", now), null);
});

/* ---------- sorting and CSV ---------- */

test("sorting is stable across the offered keys", () => {
  const rows = [L({ dist_m: 300, rent_sek_mo: 5000 }), L({ dist_m: 100, rent_sek_mo: 9000 })];
  assert.deepEqual(V.sortListings(rows, "dist", false).map((r) => r.dist_m), [100, 300]);
  assert.deepEqual(V.sortListings(rows, "dist", true).map((r) => r.dist_m), [300, 100]);
  assert.deepEqual(V.sortListings(rows, "rent", false).map((r) => r.rent_sek_mo), [5000, 9000]);
});

test("the CSV carries source, url and the fetch time", () => {
  const csv = V.toCsv([L({ address: "A 1", url: "https://example.invalid/1" })], "2026-09-24T12:00:00Z");
  const [head, row] = csv.split("\n");
  assert.ok(head.startsWith("source;source_label;allocation"));
  assert.ok(head.includes("url"));
  assert.ok(head.includes("fetched_at"));
  assert.ok(row.includes("https://example.invalid/1"));
  assert.ok(row.endsWith("2026-09-24T12:00:00Z"));
});

test("a field containing the separator is quoted", () => {
  const csv = V.toCsv([L({ address: 'Gatan 1; "B"' })], "t");
  assert.ok(csv.includes('"Gatan 1; ""B"""'), csv.split("\n")[1]);
});

test("the CSV uses semicolons, since a Swedish Excel reads a comma as a decimal point", () => {
  const csv = V.toCsv([L({ size_m2: 37.5 })], "t");
  assert.ok(csv.split("\n")[0].includes(";"));
  assert.ok(!csv.split("\n")[0].includes(","));
});
