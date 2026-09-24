/* Cross-source deduplication. */
"use strict";

import test from "node:test";
import assert from "node:assert/strict";
import { addressKey, isSameFlat, dedupe } from "../src/dedupe.js";

const portal = (o) => ({
  src: "heimstaden", address: "Dubblettgatan 37 B", rooms: 1,
  size_m2: 24, rent_sek_mo: 5098, dist_m: 12, url: "https://portal/1", ...o,
});
const hq = (o) => ({
  src: "homeq", address: "Dubblettgatan 37B", rooms: 1,
  size_m2: 24.4, rent_sek_mo: 5100, dist_m: 10, url: "https://www.homeq.se/lagenhet/1", ...o,
});

test("the entrance letter is matched whether or not it is spaced", () => {
  /* HomeQ writes both forms in a single response — "37 B" and "37B" both
   * occur — so the space cannot be trusted either way. */
  assert.equal(addressKey("Rademachergatan 37 B"), "rademachergatan|37b");
  assert.equal(addressKey("Rademachergatan 37B"), "rademachergatan|37b");
  assert.equal(addressKey("RADEMACHERGATAN 37b"), "rademachergatan|37b");
});

test("Swedish letters are kept, not folded away", () => {
  /* å, ä and ö are letters, not decorated a's and o's: Malmö and Malmo are
   * not the same word, and Bjorkrisvagen is not a street. */
  assert.equal(addressKey("Björkrisvägen 10 J"), "björkrisvägen|10j");
  assert.notEqual(addressKey("Björkrisvägen 10"), addressKey("Bjorkrisvagen 10"));
});

test("a decomposed å matches a precomposed one", () => {
  const precomposed = "Långgatan 4";
  const decomposed = "Långgatan 4";
  assert.notEqual(precomposed, decomposed, "the two strings really do differ");
  assert.equal(addressKey(precomposed), addressKey(decomposed));
});

test("multi-word streets and trailing noise are handled", () => {
  assert.equal(addressKey("Bergsunds strand 3"), "bergsunds strand|3");
  assert.equal(addressKey("Norra Långgatan 12, lgh 1102"), "norra långgatan|12");
  assert.equal(addressKey("  Kungsgatan   20  "), "kungsgatan|20");
});

test("an address with no number has no key", () => {
  assert.equal(addressKey("Kungsgatan"), null);
  assert.equal(addressKey(""), null);
  assert.equal(addressKey(null), null);
  assert.equal(addressKey(undefined), null);
  assert.equal(addressKey(42), null);
});

test("the same flat is recognised across the tolerances", () => {
  assert.equal(isSameFlat(portal(), hq()), true);
});

test("size may differ by 1 m2, not more", () => {
  assert.equal(isSameFlat(portal({ size_m2: 24 }), hq({ size_m2: 25 })), true);
  assert.equal(isSameFlat(portal({ size_m2: 24 }), hq({ size_m2: 25.1 })), false);
});

test("rent may differ by 1 %, not more", () => {
  assert.equal(isSameFlat(portal({ rent_sek_mo: 10000 }), hq({ rent_sek_mo: 10100 })), true);
  assert.equal(isSameFlat(portal({ rent_sek_mo: 10000 }), hq({ rent_sek_mo: 10101 })), false);
});

test("room count must match exactly", () => {
  /* HomeQ carries fractional rooms (1.5) where the portals carry whole ones.
   * Treating 1.5 as 2 would merge a one-and-a-half-room flat into a two. */
  assert.equal(isSameFlat(portal({ rooms: 2 }), hq({ rooms: 1.5 })), false);
  assert.equal(isSameFlat(portal({ rooms: 2 }), hq({ rooms: 2 })), true);
});

test("a null on either side never matches", () => {
  /* Better to show a flat twice than to merge two different flats and then
   * report only one of their rents. */
  assert.equal(isSameFlat(portal({ rent_sek_mo: null }), hq()), false);
  assert.equal(isSameFlat(portal(), hq({ rent_sek_mo: null })), false);
  assert.equal(isSameFlat(portal({ size_m2: null }), hq()), false);
  assert.equal(isSameFlat(portal({ rooms: null }), hq()), false);
  assert.equal(isSameFlat(portal({ address: null }), hq()), false);
});

test("a different street number is a different flat", () => {
  assert.equal(isSameFlat(portal({ address: "Dubblettgatan 39" }), hq()), false);
  assert.equal(isSameFlat(portal({ address: "Annangatan 37 B" }), hq()), false);
});

test("dedupe keeps the portal record and annotates it", () => {
  const { listings, merged } = dedupe([portal()], [hq()]);
  assert.equal(merged, 1);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].src, "heimstaden");
  assert.deepEqual(listings[0].also_on, ["homeq"]);
  assert.deepEqual(listings[0].also_on_urls, { homeq: "https://www.homeq.se/lagenhet/1" });
});

test("an unmatched HomeQ listing survives untouched", () => {
  const other = hq({ id: 7, address: "Annangatan 1", url: "https://www.homeq.se/lagenhet/7" });
  const { listings, merged } = dedupe([portal()], [other]);
  assert.equal(merged, 0);
  assert.equal(listings.length, 2);
  assert.ok(listings.some((l) => l.src === "homeq" && l.address === "Annangatan 1"));
  assert.ok(!listings.find((l) => l.src === "homeq").also_on);
});

test("the merged result stays sorted by distance", () => {
  const listings = dedupe(
    [portal({ dist_m: 300 }), portal({ address: "Bgatan 2", dist_m: 50 })],
    [hq({ address: "Cgatan 3", dist_m: 120 }), hq({ address: "Dgatan 4", dist_m: 10 })],
  ).listings;
  assert.deepEqual(listings.map((l) => l.dist_m), [10, 50, 120, 300]);
});

test("nothing on either side is handled", () => {
  assert.deepEqual(dedupe([], []), { listings: [], merged: 0 });
  assert.equal(dedupe([], [hq()]).listings.length, 1);
  assert.equal(dedupe([portal()], []).listings.length, 1);
});

test("a portal listing with an unparseable address is still returned", () => {
  /* It just cannot participate in matching. */
  const odd = portal({ address: "Fastighet utan nummer" });
  const { listings, merged } = dedupe([odd], [hq()]);
  assert.equal(merged, 0);
  assert.equal(listings.length, 2);
});

test("one HomeQ ad matching two portal records is counted once", () => {
  const { listings, merged } = dedupe([portal({ src: "heimstaden" }), portal({ src: "victoriahem" })], [hq()]);
  assert.equal(merged, 1, "one HomeQ ad disappeared");
  assert.equal(listings.length, 2, "both portal records are kept");
  assert.equal(listings.filter((l) => l.also_on).length, 1);
});
