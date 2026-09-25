/* GET /bbox?s=&w=&n=&e= — the map-viewport endpoint.
 *
 * It exists because a viewport is a rectangle. Answering one with a radius
 * around its centre either misses the corners (the inscribed circle leaves 21 %
 * of the box out) or over-fetches (the circumscribed circle is 27 % larger in
 * area). /bbox covers the box with the circumscribed circle and then trims the
 * answer back to the rectangle, so a marker layer receives exactly what is on
 * screen — and, just as importantly, the source-by-source honesty of /nearby is
 * shared code rather than a second copy.
 *
 * The Worker runtime is stubbed the same way as in worker.test.js.
 */
"use strict";

import test from "node:test";
import assert from "node:assert/strict";
import { PAYLOAD } from "./fixtures/arena.js";

globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const ctx = { waitUntil: () => {} };

const { default: worker } = await import("../src/index.js");
const { buildSnapshot, PORTALS } = await import("../src/sources/arena.js");
const { SNAPSHOT_SOURCES } = await import("../src/snapshots.js");
const { boxCover, inBox, haversine } = await import("../src/geo.js");

const DASHBOARD = "https://real-estate-war-lord.github.io";

function kvStub(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    get: async (key, opts) => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return opts?.type === "json" ? JSON.parse(raw) : raw;
    },
    put: async (key, value) => { store.set(key, value); },
  };
}

function freshSnapshots(when = new Date()) {
  const out = {};
  for (const s of SNAPSHOT_SOURCES) {
    const portal = { src: s.src, label: s.label, host: "https://stub.invalid" };
    out[s.kvKey] = buildSnapshot(PAYLOAD, portal, when);
  }
  return out;
}

async function call(path, { origin = DASHBOARD, upstream, env = {} } = {}) {
  const real = globalThis.fetch;
  if (upstream) globalThis.fetch = upstream;
  try {
    const req = new Request("https://gateway.invalid" + path, { headers: origin ? { Origin: origin } : {} });
    const res = await worker.fetch(req, env, ctx);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* shown by the assertion */ }
    return { status: res.status, headers: res.headers, body, text };
  } finally {
    globalThis.fetch = real;
  }
}

const okHomeq = (results = []) => async () =>
  new Response(JSON.stringify({ results, total_hits: results.length }), { status: 200 });
const deadHomeq = async () => new Response("nope", { status: 503 });

/* A HomeQ hit at an arbitrary point, so a test can place one inside or outside
 * the box on purpose. */
const hitAt = (id, lat, lon) => ({
  id, uri: `/lagenhet/${id}`, title: `Testgatan ${id}`,
  location: { lat, lon },
  rent: 9000, rooms: 2, area: 50, date_access: "2026-12-01",
  images: [{ image: "https://example.invalid/x.jpeg" }], discount: null,
});

/* Central Stockholm at about zoom 14: 2.2 km tall, 2.3 km wide, so the covering
 * circle (the half-diagonal, ~1.6 km) is well inside the 3 km cap. */
const BOX = { s: 59.31, w: 18.04, n: 59.33, e: 18.08 };
const Q = `s=${BOX.s}&w=${BOX.w}&n=${BOX.n}&e=${BOX.e}`;

/* --- the geometry --- */

test("the covering circle contains every corner of the box, and not much more", () => {
  const c = boxCover(BOX);
  const corners = [[BOX.s, BOX.w], [BOX.s, BOX.e], [BOX.n, BOX.w], [BOX.n, BOX.e]];
  for (const [lat, lon] of corners) {
    const d = haversine(c.lat, c.lon, lat, lon);
    assert.ok(d <= c.r + 1, `corner ${lat},${lon} is ${d.toFixed(0)} m from the centre, r=${c.r.toFixed(0)}`);
    /* it is the SMALLEST such circle: every corner sits on it */
    assert.ok(d >= c.r - 1, `corner ${lat},${lon} is well inside — the circle is bigger than it needs to be`);
  }
});

test("the covering circle is centred on the box", () => {
  const c = boxCover(BOX);
  assert.ok(Math.abs(c.lat - (BOX.s + BOX.n) / 2) < 1e-12);
  assert.ok(Math.abs(c.lon - (BOX.w + BOX.e) / 2) < 1e-12);
});

test("inBox is inclusive on every edge", () => {
  assert.equal(inBox(BOX.s, BOX.w, BOX), true);
  assert.equal(inBox(BOX.n, BOX.e, BOX), true);
  assert.equal(inBox(BOX.s - 1e-9, 18.05, BOX), false);
  assert.equal(inBox(59.32, BOX.e + 1e-9, BOX), false);
});

/* --- validation --- */

test("all four edges are required", async () => {
  const r = await call("/bbox?s=59.3&w=18.0&n=59.4");
  assert.equal(r.status, 400);
  assert.match(r.body.error, /s, w, n and e are all required/);
});

test("an inverted or empty box is refused rather than searched", async () => {
  for (const q of ["s=59.4&w=18.0&n=59.3&e=18.1", "s=59.3&w=18.1&n=59.4&e=18.0",
                   "s=59.3&w=18.0&n=59.3&e=18.1"]) {
    const r = await call("/bbox?" + q);
    assert.equal(r.status, 400, q);
    assert.match(r.body.error, /empty or inverted/);
  }
});

test("a swapped lat/lon pair is caught by the Sweden bounds", async () => {
  const r = await call("/bbox?s=18.0&w=59.3&n=18.1&e=59.4");
  assert.equal(r.status, 400);
  assert.match(r.body.error, /latitude between/);
});

/* --- the answer --- */

test("the answer is trimmed to the rectangle, not to the covering circle", async () => {
  const env = { LISTINGS_KV: kvStub(freshSnapshots()) };
  const inside = hitAt(1, 59.32, 18.06);
  /* 220 m north of the top edge: outside the rectangle, but 1.3 km from the
   * centre and so well inside the covering circle — which is the only way this
   * test can tell a rectangle trim from a radius trim. */
  const outside = hitAt(2, BOX.n + 0.002, 18.06);
  const r = await call(`/bbox?${Q}`, { upstream: okHomeq([inside, outside]), env });
  assert.equal(r.status, 200);
  const ids = r.body.listings.filter((l) => l.src === "homeq").map((l) => String(l.id));
  assert.deepEqual(ids, ["1"], `got ${JSON.stringify(ids)}`);
  for (const l of r.body.listings) assert.equal(inBox(l.lat, l.lon, BOX), true, JSON.stringify(l));
});

test("it echoes the box and what it actually searched", async () => {
  const env = { LISTINGS_KV: kvStub(freshSnapshots()) };
  const r = await call(`/bbox?${Q}`, { upstream: okHomeq(), env });
  assert.deepEqual(r.body.bbox, BOX);
  assert.equal(r.body.covered, true);
  const c = boxCover(BOX);
  assert.ok(Math.abs(r.body.radius - c.r) < 1, `radius ${r.body.radius} vs cover ${c.r}`);
  assert.deepEqual(Object.keys(r.body),
    ["fetchedAt", "bbox", "radius", "covered", "sources", "deduped", "allocation", "listings"]);
});

test("a box too big for the radius cap says so rather than pretending", async () => {
  const env = { LISTINGS_KV: kvStub(freshSnapshots()) };
  /* half of Sweden: the covering circle is far past the 3 km cap */
  const r = await call("/bbox?s=56&w=12&n=60&e=19", { upstream: okHomeq(), env });
  assert.equal(r.status, 200);
  assert.equal(r.body.covered, false);
  assert.equal(r.body.radius, 3000);
});

test("every source is listed, with a count that matches what came back", async () => {
  const env = { LISTINGS_KV: kvStub(freshSnapshots()) };
  const r = await call(`/bbox?${Q}`, { upstream: okHomeq([hitAt(1, 59.32, 18.06)]), env });
  assert.deepEqual(r.body.sources.map((s) => s.src), ["homeq", ...SNAPSHOT_SOURCES.map((p) => p.src)]);
  const perSrc = {};
  for (const l of r.body.listings) perSrc[l.src] = (perSrc[l.src] || 0) + 1;
  for (const s of r.body.sources) {
    if (s.ok) assert.equal(s.count, perSrc[s.src] || 0, `${s.src} claims ${s.count}`);
  }
});

test("a failing source is ok:false here too, never an empty success", async () => {
  const env = { LISTINGS_KV: kvStub(freshSnapshots()) };
  const r = await call(`/bbox?${Q}`, { upstream: deadHomeq, env });
  const h = r.body.sources.find((s) => s.src === "homeq");
  assert.equal(h.ok, false);
  assert.equal(h.count, 0);
  assert.match(h.error, /HomeQ/);
});

test("and if every source fails the status is 502 with the shape intact", async () => {
  const r = await call(`/bbox?${Q}`, { upstream: deadHomeq, env: { LISTINGS_KV: kvStub({}) } });
  assert.equal(r.status, 502);
  assert.ok(Array.isArray(r.body.listings));
  assert.ok(r.body.sources.every((s) => !s.ok));
});

test("the allocation split is recomputed for the trimmed set", async () => {
  const env = { LISTINGS_KV: kvStub(freshSnapshots()) };
  const r = await call(`/bbox?${Q}`, { upstream: okHomeq([hitAt(1, 59.32, 18.06)]), env });
  const queue = r.body.listings.filter((l) => l.allocation === "queue").length;
  const direct = r.body.listings.length - queue;
  assert.deepEqual(r.body.allocation, { direct, queue });
});

test("/health advertises the endpoint", async () => {
  const r = await call("/health");
  assert.deepEqual(r.body.endpoints, ["/nearby", "/bbox", "/text"]);
});

test("an unknown endpoint names the real ones", async () => {
  const r = await call("/listings");
  assert.equal(r.status, 404);
  assert.match(r.body.error, /\/nearby, \/bbox, \/text/);
});

test("/nearby is unchanged — the shared fan-out did not alter its answer", async () => {
  const env = { LISTINGS_KV: kvStub(freshSnapshots()) };
  const r = await call("/nearby?lat=59.32&lon=18.06&r=3000", { upstream: okHomeq([hitAt(1, 59.32, 18.06)]), env });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ["fetchedAt", "radius", "sources", "deduped", "allocation", "listings"]);
  assert.equal(r.body.radius, 3000);
  assert.ok(!("bbox" in r.body));
});
