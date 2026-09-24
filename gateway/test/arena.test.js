/* The Arena adapter: envelope, normalisation, snapshot and staleness. */
"use strict";

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSnapshot, normaliseRecord, selectNearby, isStale, toPlainText,
  decodeEntities, imageUrl, isoDate, kvKey, PORTALS, STALE_AFTER_MS,
} from "../src/sources/arena.js";
import { PAYLOAD, RECORDS, PORTAL } from "./fixtures/arena.js";

const NOW = new Date("2026-09-24T12:00:00.000Z");

test("the portal registry is well formed", () => {
  /* The two originals stay at the head; the rest come from discovery. */
  assert.deepEqual(PORTALS.slice(0, 2), [
    { src: "heimstaden", label: "Heimstaden", host: "https://mitt.heimstaden.com" },
    { src: "victoriahem", label: "Victoriahem", host: "https://minasidor.victoriahem.se" },
  ]);
  assert.ok(PORTALS.length >= 2);
  assert.equal(kvKey("heimstaden"), "arena:heimstaden");

  const srcs = PORTALS.map((p) => p.src);
  assert.equal(new Set(srcs).size, srcs.length, "src keys must be unique — they are KV keys");
  for (const p of PORTALS) {
    /* An src reaches KV and the /text query string, so keep it boring. */
    assert.match(p.src, /^[a-z][a-z0-9-]{1,30}$/, p.src);
    assert.match(p.host, /^https:\/\/[a-z0-9.-]+$/, p.host);
    assert.ok(!p.host.endsWith("/"), `${p.src} host must not end in a slash`);
    assert.ok(p.label && p.label.length <= 40, p.src);
  }
});

test("`data` arrives as a JSON string and is parsed, not treated as an array", () => {
  assert.equal(typeof PAYLOAD.data, "string", "the fixture must reproduce the string envelope");
  const snap = buildSnapshot(PAYLOAD, PORTAL, NOW);
  assert.equal(snap.count + snap.dropped, RECORDS.length);
});

test("a whole response string is accepted too", () => {
  const snap = buildSnapshot(JSON.stringify(PAYLOAD), PORTAL, NOW);
  assert.equal(snap.count, 3);
});

test("records without usable coordinates are dropped and counted", () => {
  const snap = buildSnapshot(PAYLOAD, PORTAL, NOW);
  /* One record has null coordinates, one has 0,0 — the Gulf of Guinea, which
   * is how "no coordinate" gets written when the field must be a number. */
  assert.equal(snap.dropped, 2);
  assert.equal(snap.count, 3);
  assert.ok(snap.listings.every((l) => Number.isFinite(l.lat) && Number.isFinite(l.lon)));
  assert.ok(snap.listings.every((l) => !(l.lat === 0 && l.lon === 0)));
});

test("the snapshot carries its provenance and no listing carries dist_m", () => {
  const snap = buildSnapshot(PAYLOAD, PORTAL, NOW);
  assert.equal(snap.src, "testportal");
  assert.equal(snap.fetchedAt, NOW.toISOString());
  assert.equal(snap.count, snap.listings.length);
  /* Distance depends on the query point, so it belongs to the read, not the
   * stored snapshot. */
  assert.ok(snap.listings.every((l) => !("dist_m" in l)));
});

test("a record maps onto the same schema HomeQ uses", () => {
  const out = normaliseRecord(RECORDS[0], PORTAL);
  assert.deepEqual(out, {
    src: "testportal",
    src_label: "TestPortal",
    id: "1000001-1001",
    url: "https://portal.invalid/ledigt/detalj/id/1000001-1001",
    address: "Exempelgatan 12 A",
    area_name: "Testby - Centrum",
    lat: 59.3170,
    lon: 18.0340,
    rent_sek_mo: 9500,
    size_m2: 62,
    rooms: 2,
    floor: 3,
    year_built: 1974,
    available_from: "2026-12-01",
    published: "2026-09-20",
    image: out.image,
    text_start: out.text_start,
    discount: null,
    offer: null,
    is_new_production: null,
    geo_source: "source",
    allocation: "direct",
    audience: null,
  });
});

test("YearBuilt 0 is unknown, not the year zero", () => {
  /* Every one of Victoriahem's 1113 live records carries YearBuilt 0. Stored
   * as 0 it would put the whole portfolio in year zero. */
  const ground = normaliseRecord(RECORDS[1], PORTAL);
  assert.equal(ground.year_built, null);
  assert.equal(normaliseRecord(RECORDS[0], PORTAL).year_built, 1974);
});

test("Floor 0 is a real answer and is kept", () => {
  /* Bottenvåning. Unlike YearBuilt, zero here means something. */
  assert.equal(normaliseRecord(RECORDS[1], PORTAL).floor, 0);
});

test("dates are cut to ISO days, so they mean what a HomeQ date means", () => {
  assert.equal(isoDate("2026-12-01T00:00:00"), "2026-12-01");
  assert.equal(isoDate(null), null);
  assert.equal(isoDate(""), null);
  assert.equal(isoDate("garbage"), "garbage");
});

test("Swedish characters survive the HTML entities", () => {
  /* The live descriptions are entity-escaped exactly here — a decoder that
   * only knows &amp; leaves mojibake where every Swedish letter should be. */
  assert.equal(decodeEntities("tv&aring;a p&aring; V&auml;ster&ouml;"), "tvåa på Västerö");
  assert.equal(decodeEntities("&Aring;re &ndash; &quot;fint&quot;"), 'Åre – "fint"');
  assert.equal(decodeEntities("&#229;&#228;&#246;"), "åäö");
  assert.equal(decodeEntities("&#xE5;&#xE4;&#xF6;"), "åäö");
  assert.equal(decodeEntities("&unknownentity; stays"), "&unknownentity; stays");
});

test("text_start strips markup and is capped at 220 characters", () => {
  const out = normaliseRecord(RECORDS[0], PORTAL);
  assert.equal(out.text_start, "Modern tvåa på Exempelgatan Välkommen till en ljus lägenhet i populära Testby – nära till allt.");
  assert.ok(!/[<>]/.test(out.text_start));
  const long = { ...RECORDS[0], DescriptionHtml: "<p>" + "Lägenheten ".repeat(60) + "</p>" };
  assert.equal(normaliseRecord(long, PORTAL).text_start.length, 220);
});

test("text falls back to DescriptionHtml when Description is empty", () => {
  /* Heimstaden fills Description on 15 of 489 records and DescriptionHtml on
   * 486; reading only Description would leave 97 % of them blank. */
  assert.ok(RECORDS[0].Description === null && RECORDS[0].DescriptionHtml);
  assert.ok(normaliseRecord(RECORDS[0], PORTAL).text_start.length > 0);
  /* and the plain field wins when both are present */
  assert.equal(normaliseRecord(RECORDS[1], PORTAL).text_start, "Etta med balkong.");
});

test("stray whitespace is trimmed off addresses", () => {
  /* The live payload really does contain "Malakitgatan 12 " with a trailing
   * space; untrimmed it reaches the popup and the dedupe comparison. */
  const messy = { ...RECORDS[0], Adress1: "  Malakitgatan  12 ", AreaName: " Lund - Rabylund " };
  const out = normaliseRecord(messy, PORTAL);
  assert.equal(out.address, "Malakitgatan 12");
  assert.equal(out.area_name, "Lund - Rabylund");
  assert.equal(normaliseRecord({ ...RECORDS[0], Adress1: "   " }, PORTAL).address, null);
});

test("a record with neither description gets null, not an empty string", () => {
  const bare = { ...RECORDS[0], Description: null, DescriptionHtml: null };
  assert.equal(normaliseRecord(bare, PORTAL).text_start, null);
});

test("the image URL is built from FirstImage, which carries no URL of its own", () => {
  const img = RECORDS[0].FirstImage;
  assert.equal(img.ExternalUrl, null, "the live payload never populates this");
  assert.equal(img.Filename, null);
  const url = imageUrl(PORTAL.host, img);
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, "https://portal.invalid/Content/ImageUrl");
  assert.equal(u.searchParams.get("guid"), "bbbbbbbb-0000-0000-0000-000000000001");
  assert.equal(u.searchParams.get("extension"), ".jpg");
  assert.equal(u.searchParams.get("width"), "400");
  assert.equal(u.searchParams.get("crop"), "True");
});

test("no FirstImage means no image, not a broken URL", () => {
  assert.equal(imageUrl(PORTAL.host, null), null);
  assert.equal(imageUrl(PORTAL.host, {}), null);
  assert.equal(normaliseRecord(RECORDS[1], PORTAL).image, null);
});

test("id falls back to Guid when Id is missing", () => {
  const noId = { ...RECORDS[0], Id: null };
  assert.equal(normaliseRecord(noId, PORTAL).id, "aaaaaaaa-0000-0000-0000-000000000001");
});

test("a malformed envelope throws with a message naming the portal", () => {
  assert.throws(() => buildSnapshot({ status: "success", data: "{}" }, PORTAL, NOW), /TestPortal.*array/);
  assert.throws(() => buildSnapshot({ status: "error" }, PORTAL, NOW), /TestPortal.*array/);
  assert.throws(() => buildSnapshot({ status: "success", data: "not json" }, PORTAL, NOW));
});

test("selectNearby trims to the radius and adds dist_m", () => {
  const snap = buildSnapshot(PAYLOAD, PORTAL, NOW);
  const near = selectNearby(snap, 59.3170, 18.0340, 100);
  assert.ok(near.length >= 1);
  assert.ok(near.every((l) => l.dist_m <= 100));
  assert.ok(near.every((l) => Number.isInteger(l.dist_m)));
  assert.equal(near[0].dist_m, 0);
  /* far away from everything */
  assert.deepEqual(selectNearby(snap, 57.7089, 11.9746, 500), []);
  assert.deepEqual(selectNearby(null, 59.3, 18.0, 500), []);
});

test("selectNearby does not mutate the stored snapshot", () => {
  const snap = buildSnapshot(PAYLOAD, PORTAL, NOW);
  selectNearby(snap, 59.3170, 18.0340, 5000);
  assert.ok(snap.listings.every((l) => !("dist_m" in l)), "the snapshot must stay distance-free");
});

test("a snapshot older than three hours is stale", () => {
  const now = Date.parse("2026-09-24T12:00:00.000Z");
  const at = (ms) => ({ fetchedAt: new Date(now - ms).toISOString() });
  assert.equal(isStale(at(0), now), false);
  assert.equal(isStale(at(STALE_AFTER_MS - 1000), now), false);
  assert.equal(isStale(at(STALE_AFTER_MS + 1000), now), true);
  assert.equal(isStale({ fetchedAt: "not a date" }, now), true);
  assert.equal(isStale({}, now), true);
  assert.equal(isStale(null, now), true);
});

test("toPlainText handles the empty and non-string cases", () => {
  assert.equal(toPlainText(null), "");
  assert.equal(toPlainText(undefined), "");
  assert.equal(toPlainText(""), "");
  assert.equal(toPlainText("<script>bad()</script>ok"), "ok");
});
