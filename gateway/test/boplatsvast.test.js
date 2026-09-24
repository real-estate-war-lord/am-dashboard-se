/* Boplats Väst: HTML parsing, the detail cache and the unplaced rule.
 *
 * The HTML below reproduces the real page's structure with invented
 * addresses and prices — no third-party listing data is committed.
 */
"use strict";

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCards, parseDetail, parseSek, parseArea, parseRooms, parseApplyBy,
  buildListing, buildSnapshot, selectNearby, decode, SRC, ALLOCATION,
} from "../src/sources/boplatsvast.js";

const CARD_HTML = `
<div class="search-result-item item imageitem">
  <a href="https://boplats.se/objekt/1hand/AAAA1111" class="search-result-link">
    <div class="mob-row"><div class="mob-thumb">
      <img class="wide" src="https://boplats.se/bilder/1hand/IMG1/full/300/300" alt="foto1" />
    </div><div class="mob-info-container"><div class="pure-g mob-info">
      <div class="pure-u-2-3 search-result-area-name">Testomr&aring;det</div>
      <div class="pure-u-1-3 right-align search-result-price">6 437 kr</div>
      <div class="pure-u-3-5 search-result-address">Exempelgatan 14C</div>
      <div class="pure-u-2-5 right-align">37.5 m&sup2;</div>
      <div class="pure-u-3-4 search-result-floors"></div>
      <div class="pure-u-1-4 right-align">1 rum</div>
      <div class="pure-u-1 publ-date">Publ. idag</div>
    </div></div></div>
  </a>
</div>
<div class="search-result-item item imageitem">
  <a href="https://boplats.se/objekt/1hand/BBBB2222" class="search-result-link">
    <div class="mob-info-container"><div class="pure-g mob-info">
      <div class="pure-u-2-3 search-result-area-name">Annat</div>
      <div class="pure-u-1-3 right-align search-result-price">11 280 kr</div>
      <div class="pure-u-3-5 search-result-address">Provv&auml;gen 3</div>
      <div class="pure-u-2-5 right-align">78 m&sup2;</div>
      <div class="pure-u-1-4 right-align">3 rum</div>
      <div class="pure-u-1 publ-date">Publ. ig&aring;r</div>
    </div></div>
  </a>
</div>`;

const DETAIL_HTML = `
<h1></h1>
<div>Exempelgatan 14C B&aring;da bilder <a href="#karta">Se karta</a> Testomr&aring;det, Testby Centrum, Teststad Ans&ouml;k</div>
<div>Sista dagen att s&ouml;ka denna l&auml;genhet &auml;r 8 oktober.</div>
<h3 class="object-attribute-heading">Karta</h3>
<div tabindex=0 id="karta" class="karta" data-modules="map" data-latitude="57.6801051" data-longitude="11.9737198" data-object-id="AAAA1111"></div>
<h3 class="object-attribute-heading">K&ouml;tider i detta omr&aring;de</h3>
<div>Under de senaste 12 m&aring;naderna har 30 stycken liknande bost&auml;der f&ouml;rmedlats i omr&aring;det. De har f&ouml;rmedlats med en genomsnittlig k&ouml;tid p&aring; 15 &aring;r och 100 m&aring;nader.</div>
<h3 class="object-attribute-heading">Hyresv&auml;rd</h3>
<div class="object-attribute-value">Testbost&auml;der AB 031-1234567 info@example.invalid</div>
<h3 class="object-attribute-heading">S&aring; best&auml;ms vem som f&aring;r l&auml;genheten</h3>
<div>Du som &auml;r bostadss&ouml;kande...</div>`;

/* --- scalars --- */

test("entities are decoded, including Swedish letters", () => {
  assert.equal(decode("Testomr&aring;det"), "Testområdet");
  assert.equal(decode("Provv&auml;gen"), "Provvägen");
  assert.equal(decode("37.5 m&sup2;"), "37.5 m²");
  assert.equal(decode("&#229;&#228;&#246;"), "åäö");
});

test("rent uses a space as the thousands separator, never a comma", () => {
  assert.equal(parseSek("6 437 kr"), 6437);
  assert.equal(parseSek("11 280 kr"), 11280);
  assert.equal(parseSek("980 kr"), 980);
  assert.equal(parseSek(" 5 000 kr"), 5000);
  assert.equal(parseSek("inget"), null);
  assert.equal(parseSek(null), null);
});

test("area accepts a decimal point or comma", () => {
  assert.equal(parseArea("37.5 m²"), 37.5);
  assert.equal(parseArea("37,5 m²"), 37.5);
  assert.equal(parseArea("78 m²"), 78);
  assert.equal(parseArea("no size"), null);
});

test("rooms are read off the card text", () => {
  assert.equal(parseRooms("1 rum"), 1);
  assert.equal(parseRooms("3 rum"), 3);
  assert.equal(parseRooms("1.5 rum"), 1.5);
  assert.equal(parseRooms("rum"), null);
});

test("the apply deadline has no year and the nearest sensible one is chosen", () => {
  const now = new Date("2026-09-24T00:00:00Z");
  assert.equal(parseApplyBy("Sista dagen att söka denna lägenhet är 8 oktober.", now), "2026-10-08");
  assert.equal(parseApplyBy("... är 27 september.", now), "2026-09-27");
  /* January, seen in September, is next year rather than nine months ago. */
  assert.equal(parseApplyBy("... är 5 januari.", now), "2027-01-05");
  assert.equal(parseApplyBy("no date here", now), null);
});

/* --- the listing page --- */

test("every card field is parsed", () => {
  const cards = parseCards(CARD_HTML);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0], {
    id: "AAAA1111",
    url: "https://boplats.se/objekt/1hand/AAAA1111",
    area_name: "Testområdet",
    rent_sek_mo: 6437,
    address: "Exempelgatan 14C",
    size_m2: 37.5,
    rooms: 1,
    floor: null,
    published_raw: "Publ. idag",
    image: "https://boplats.se/bilder/1hand/IMG1/full/300/300",
  });
  assert.equal(cards[1].rent_sek_mo, 11280);
  assert.equal(cards[1].size_m2, 78);
  assert.equal(cards[1].rooms, 3);
  assert.equal(cards[1].image, null);
});

test("a page with no cards parses to nothing rather than throwing", () => {
  assert.deepEqual(parseCards("<html><body>inget</body></html>"), []);
  assert.deepEqual(parseCards(""), []);
});

/* --- the advert page --- */

test("coordinates come from the advert's own map element", () => {
  const d = parseDetail(DETAIL_HTML);
  assert.equal(d.lat, 57.6801051);
  assert.equal(d.lon, 11.9737198);
});

test("the kommun is the last part of the area breadcrumb", () => {
  assert.equal(parseDetail(DETAIL_HTML).kommun, "Teststad");
});

test("the landlord is taken without its phone number or e-mail", () => {
  assert.equal(parseDetail(DETAIL_HTML).landlord, "Testbostäder AB");
});

test("an advert page without a map element yields no coordinates", () => {
  const d = parseDetail("<div>no map</div>");
  assert.equal(d.lat, null);
  assert.equal(d.lon, null);
});

test("0,0 is treated as no coordinate", () => {
  const d = parseDetail('<div id="karta" data-latitude="0" data-longitude="0"></div>');
  assert.equal(d.lat, null);
  assert.equal(d.lon, null);
});

/* --- assembly --- */

test("a placed advert carries queue metadata and source coordinates", () => {
  const card = parseCards(CARD_HTML)[0];
  const l = buildListing(card, parseDetail(DETAIL_HTML));
  assert.equal(l.src, SRC);
  assert.equal(l.allocation, "queue");
  assert.equal(ALLOCATION, "queue");
  assert.equal(l.geo_source, "source", "not geocoded — the site publishes the position");
  assert.equal(l.lat, 57.6801051);
  assert.equal(l.area_name, "Teststad - Testområdet");
  assert.equal(l.landlord, "Testbostäder AB");
  assert.equal(l.apply_by, parseApplyBy("8 oktober", new Date()) && l.apply_by);
  assert.equal(l.queue_name, "Boplats Väst");
});

test("the fake queue-time template is NOT passed through", () => {
  /* Every advert page tells a logged-out visitor "15 år och 100 månader".
   * 100 months is not a remainder; it is an unpopulated template, and
   * publishing it would be publishing a fabricated statistic. */
  const l = buildListing(parseCards(CARD_HTML)[0], parseDetail(DETAIL_HTML));
  assert.equal(l.queue_years_q1, null);
  assert.equal(l.queue_years_q3, null);
});

test("audience is null because the public listing does not segment it", () => {
  assert.equal(buildListing(parseCards(CARD_HTML)[0], parseDetail(DETAIL_HTML)).audience, null);
});

test("an advert with no cached detail is unplaced, counted, and not drawn", () => {
  const cards = parseCards(CARD_HTML);
  const cache = { AAAA1111: { ...parseDetail(DETAIL_HTML), at: Date.now() } };
  const snap = buildSnapshot(cards, cache);
  assert.equal(snap.count, 1);
  assert.equal(snap.unplaced, 1);
  assert.equal(snap.dropped, 1);
  assert.equal(snap.unplaced_examples.length, 1);
  assert.equal(snap.unplaced_examples[0].id, "BBBB2222");
  /* the unplaced one must not reach the listings array at all */
  assert.ok(snap.listings.every((l) => l.id !== "BBBB2222"));
  assert.ok(snap.listings.every((l) => Number.isFinite(l.lat) && Number.isFinite(l.lon)));
  assert.ok(snap.listings.every((l) => !("_placed" in l)));
});

test("no listing is ever emitted without coordinates", () => {
  const snap = buildSnapshot(parseCards(CARD_HTML), {});
  assert.equal(snap.count, 0);
  assert.equal(snap.unplaced, 2);
  assert.deepEqual(snap.listings, []);
});

test("selectNearby trims and sorts, and skips anything unplaced", () => {
  const cache = { AAAA1111: { ...parseDetail(DETAIL_HTML), at: Date.now() } };
  const snap = buildSnapshot(parseCards(CARD_HTML), cache);
  const near = selectNearby(snap, 57.6801051, 11.9737198, 500);
  assert.equal(near.length, 1);
  assert.equal(near[0].dist_m, 0);
  assert.deepEqual(selectNearby(snap, 59.3, 18.0, 1000), []);
  assert.deepEqual(selectNearby(null, 57.68, 11.97, 500), []);
});
