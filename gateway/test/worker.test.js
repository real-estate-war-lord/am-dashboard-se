/* The request envelope: validation, CORS, the KV-backed portal sources, the
 * refresh endpoint, and above all the promise that a failing or stale source
 * is reported as such rather than as "no listings here".
 *
 * The Worker runtime is stubbed with the globals src/index.js touches — fetch,
 * caches and a KV binding — so routing can be tested without wrangler.
 */
"use strict";

import test from "node:test";
import assert from "node:assert/strict";
import { PAYLOAD } from "./fixtures/arena.js";

globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const ctx = { waitUntil: () => {} };

const { default: worker } = await import("../src/index.js");
const { buildSnapshot, PORTALS } = await import("../src/sources/arena.js");

const DASHBOARD = "https://real-estate-war-lord.github.io";
const CENTER = "lat=59.3165&lon=18.0335";

/* A KV namespace backed by a Map. */
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

/* Snapshots for both real portals, built from the fixture. */
function freshSnapshots(when = new Date()) {
  const out = {};
  for (const p of PORTALS) out[`arena:${p.src}`] = buildSnapshot(PAYLOAD, p, when);
  return out;
}

async function call(path, { origin = DASHBOARD, method = "GET", upstream, env = {}, headers = {} } = {}) {
  const real = globalThis.fetch;
  if (upstream) globalThis.fetch = upstream;
  try {
    const req = new Request("https://gateway.invalid" + path, {
      method,
      headers: { ...(origin ? { Origin: origin } : {}), ...headers },
    });
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

const HOMEQ_HIT = {
  id: 1, uri: "/lagenhet/1", title: "Testgatan 1",
  location: { lat: 59.3166, lon: 18.0336 },
  rent: 9000, rooms: 2, area: 50, date_access: "2026-12-01",
  images: [{ image: "https://example.invalid/x.jpeg" }], discount: null,
};

const srcOf = (body, src) => body.sources.find((s) => s.src === src);

/* --- the envelope --- */

test("the response lists every source: HomeQ plus every portal", async () => {
  const env = { LISTINGS_KV: kvStub(freshSnapshots()) };
  const r = await call(`/nearby?${CENTER}&r=3000`, { upstream: okHomeq([HOMEQ_HIT]), env });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.sources.map((s) => s.src), ["homeq", ...PORTALS.map((p) => p.src)]);
  assert.equal(r.body.sources.length, 1 + PORTALS.length);
  assert.deepEqual(Object.keys(r.body), ["fetchedAt", "radius", "sources", "deduped", "listings"]);
});

test("a portal source reports its snapshot's fetchedAt", async () => {
  const when = new Date("2026-09-24T11:30:00.000Z");
  const env = { LISTINGS_KV: kvStub(freshSnapshots(when)) };
  const r = await call(`/nearby?${CENTER}&r=3000`, { upstream: okHomeq(), env });
  const h = srcOf(r.body, "heimstaden");
  assert.equal(h.ok, true);
  assert.equal(h.fetchedAt, when.toISOString());
  assert.equal(h.count, 3);
});

test("a missing snapshot is ok:false, not an empty success", async () => {
  const env = { LISTINGS_KV: kvStub({}) };
  const r = await call(`/nearby?${CENTER}&r=3000`, { upstream: okHomeq([HOMEQ_HIT]), env });
  assert.equal(r.status, 200, "HomeQ still worked, so the call succeeds");
  for (const src of PORTALS.map((p) => p.src)) {
    const s = srcOf(r.body, src);
    assert.equal(s.ok, false, src);
    assert.equal(s.count, 0, src);
    assert.match(s.error, /no snapshot yet/, src);
  }
});

test("a snapshot older than three hours is refused as stale", async () => {
  const old = new Date(Date.now() - 4 * 60 * 60 * 1000);
  const env = { LISTINGS_KV: kvStub(freshSnapshots(old)) };
  const r = await call(`/nearby?${CENTER}&r=3000`, { upstream: okHomeq(), env });
  const s = srcOf(r.body, "heimstaden");
  assert.equal(s.ok, false);
  assert.match(s.error, /stale/);
  /* and none of its listings leak into the response */
  assert.ok(r.body.listings.every((l) => l.src !== "heimstaden"));
});

test("a snapshot just under three hours old is still served", async () => {
  const recent = new Date(Date.now() - (3 * 60 * 60 * 1000 - 60_000));
  const env = { LISTINGS_KV: kvStub(freshSnapshots(recent)) };
  const r = await call(`/nearby?${CENTER}&r=3000`, { upstream: okHomeq(), env });
  assert.equal(srcOf(r.body, "heimstaden").ok, true);
});

test("an unbound KV namespace is reported, not thrown", async () => {
  const r = await call(`/nearby?${CENTER}`, { upstream: okHomeq(), env: {} });
  assert.equal(r.status, 200);
  assert.match(srcOf(r.body, "heimstaden").error, /LISTINGS_KV is not bound/);
});

test("every source failing gives 502 with the envelope intact", async () => {
  const r = await call(`/nearby?${CENTER}`, { upstream: deadHomeq, env: {} });
  assert.equal(r.status, 502);
  assert.ok(r.body.sources.every((s) => s.ok === false));
  assert.deepEqual(r.body.listings, []);
  assert.deepEqual(Object.keys(r.body), ["fetchedAt", "radius", "sources", "deduped", "listings"]);
});

test("HomeQ failing does not take the portals down with it", async () => {
  const env = { LISTINGS_KV: kvStub(freshSnapshots()) };
  const r = await call(`/nearby?${CENTER}&r=3000`, { upstream: deadHomeq, env });
  assert.equal(r.status, 200);
  assert.equal(srcOf(r.body, "homeq").ok, false);
  assert.equal(srcOf(r.body, "heimstaden").ok, true);
  assert.ok(r.body.listings.length > 0);
});

test("a hanging HomeQ is cut off at 8 s and reported", async () => {
  const env = { LISTINGS_KV: kvStub(freshSnapshots()) };
  const r = await call(`/nearby?${CENTER}&r=3000`, {
    upstream: (url, opts) => new Promise((_res, rej) => {
      opts.signal.addEventListener("abort", () => rej(opts.signal.reason));
    }),
    env,
  });
  assert.equal(srcOf(r.body, "homeq").ok, false);
  assert.match(srcOf(r.body, "homeq").error, /did not answer in time/);
  assert.equal(srcOf(r.body, "heimstaden").ok, true, "the portals are unaffected");
});

test("listings from all sources come back sorted by distance", async () => {
  const env = { LISTINGS_KV: kvStub(freshSnapshots()) };
  const r = await call(`/nearby?${CENTER}&r=3000`, { upstream: okHomeq([HOMEQ_HIT]), env });
  const d = r.body.listings.map((l) => l.dist_m);
  assert.deepEqual(d, [...d].sort((a, b) => a - b));
  assert.ok(r.body.listings.every((l) => l.dist_m <= 3000));
});

test("the radius still trims the portal listings", async () => {
  const env = { LISTINGS_KV: kvStub(freshSnapshots()) };
  const r = await call(`/nearby?${CENTER}&r=100`, { upstream: okHomeq(), env });
  assert.ok(r.body.listings.every((l) => l.dist_m <= 100));
  /* Of the fixture's three placeable records, two are within 100 m (62 m and
   * 12 m) and Provvagen 5 at 187 m is not — and every portal is stubbed with
   * the same fixture, so it is two per portal. */
  assert.equal(r.body.listings.length, 2 * PORTALS.length);
  assert.ok(r.body.listings.every((l) => !l.address.startsWith("Provv")));
});

/* --- dedupe through the whole request --- */

test("a HomeQ duplicate of a portal flat is merged away", async () => {
  const env = { LISTINGS_KV: kvStub(freshSnapshots()) };
  /* The fixture's Dubblettgatan 37 B, as HomeQ would carry it. */
  const twin = {
    id: 999, uri: "/lagenhet/999", title: "Dubblettgatan 37B",
    location: { lat: 59.31661, lon: 18.03361 },
    rent: 5100, rooms: 1, area: 24.4, date_access: "2026-11-02",
    images: [], discount: null,
  };
  const r = await call(`/nearby?${CENTER}&r=3000`, { upstream: okHomeq([twin]), env });
  /* `deduped` counts HomeQ records folded away, not portal records touched:
   * one HomeQ ad disappeared, however many portal records it could match. */
  assert.equal(r.body.deduped, 1);
  const survivors = r.body.listings.filter((l) => l.address.startsWith("Dubblettgatan"));
  assert.ok(survivors.length > 0);
  assert.ok(survivors.every((l) => l.src !== "homeq"), "the portal record wins, the HomeQ twin is gone");
  const annotated = survivors.filter((l) => l.also_on?.includes("homeq"));
  assert.equal(annotated.length, 1);
  assert.equal(annotated[0].also_on_urls.homeq, "https://www.homeq.se/lagenhet/999");
  /* HomeQ still reports what it actually returned, before the merge. */
  assert.equal(srcOf(r.body, "homeq").count, 1);
});

test("a different flat at the same address is not merged", async () => {
  const env = { LISTINGS_KV: kvStub(freshSnapshots()) };
  const neighbour = {
    id: 998, uri: "/lagenhet/998", title: "Dubblettgatan 37B",
    location: { lat: 59.31661, lon: 18.03361 },
    rent: 9200, rooms: 3, area: 58, date_access: "2026-11-02",
    images: [], discount: null,
  };
  const r = await call(`/nearby?${CENTER}&r=3000`, { upstream: okHomeq([neighbour]), env });
  assert.equal(r.body.deduped, 0);
  assert.ok(r.body.listings.some((l) => l.src === "homeq" && l.id === 998));
});

/* --- /text --- */

test("/text serves a portal excerpt from the snapshot without an upstream call", async () => {
  const env = { LISTINGS_KV: kvStub(freshSnapshots()) };
  let called = false;
  const r = await call("/text?src=heimstaden&id=1000001-1001", {
    env, upstream: async () => { called = true; return new Response("{}"); },
  });
  assert.equal(r.status, 200);
  assert.match(r.body.text_start, /Modern tvåa på Exempelgatan/);
  assert.equal(called, false, "the snapshot already has the text");
  assert.match(r.headers.get("cache-control"), /max-age=3600/);
});

test("/text 404s for an id that is not in the snapshot", async () => {
  const env = { LISTINGS_KV: kvStub(freshSnapshots()) };
  const r = await call("/text?src=heimstaden&id=nosuchid", { env });
  assert.equal(r.status, 404);
});

test("/text on a stale portal snapshot is a 502, not a stale answer", async () => {
  const old = new Date(Date.now() - 5 * 60 * 60 * 1000);
  const env = { LISTINGS_KV: kvStub(freshSnapshots(old)) };
  const r = await call("/text?src=heimstaden&id=1000001-1001", { env });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /stale/);
});

test("/text still proxies HomeQ live", async () => {
  const r = await call("/text?src=homeq&id=100001", {
    upstream: async () => new Response(JSON.stringify({
      object_ad: { description: "<p>Ljus tvåa med balkong.</p>" },
    }), { status: 200 }),
  });
  assert.deepEqual(r.body, { text_start: "Ljus tvåa med balkong." });
});

test("/text names every known source when given an unknown one", async () => {
  const r = await call("/text?src=blocket&id=1");
  assert.equal(r.status, 400);
  assert.match(r.body.error, /homeq, heimstaden, victoriahem/);
});

test("/text validates src and id", async () => {
  assert.equal((await call("/text?src=homeq")).status, 400);
  assert.equal((await call("/text?id=1")).status, 400);
  assert.equal((await call("/text?src=heimstaden&id=../../secret")).status, 400);
});

/* --- /admin/refresh --- */

test("/admin/refresh is closed when no secret is configured", async () => {
  const r = await call("/admin/refresh", { env: { LISTINGS_KV: kvStub() } });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /REFRESH_SECRET is not set/);
});

test("/admin/refresh rejects a missing or wrong bearer token", async () => {
  const env = { LISTINGS_KV: kvStub(), REFRESH_SECRET: "s3cret" };
  assert.equal((await call("/admin/refresh", { env })).status, 401);
  assert.equal((await call("/admin/refresh", { env, headers: { Authorization: "Bearer wrong!" } })).status, 401);
  assert.equal((await call("/admin/refresh", { env, headers: { Authorization: "s3cret" } })).status, 401);
});

test("/admin/refresh with the right token rebuilds every snapshot", async () => {
  const kv = kvStub();
  const env = { LISTINGS_KV: kv, REFRESH_SECRET: "s3cret" };
  const r = await call("/admin/refresh", {
    env,
    headers: { Authorization: "Bearer s3cret" },
    upstream: async () => new Response(JSON.stringify(PAYLOAD), { status: 200 }),
  });
  assert.equal(r.status, 200);
  /* Order is preserved even though the refresh runs a bounded worker pool. */
  assert.deepEqual(r.body.portals.map((p) => p.src), PORTALS.map((p) => p.src));
  assert.ok(r.body.portals.every((p) => p.ok && p.count === 3 && p.dropped === 2));
  assert.equal(kv.store.size, PORTALS.length);
  assert.ok(kv.store.has("arena:heimstaden"));
});

test("a portal failing the refresh leaves the others' snapshots alone", async () => {
  const kv = kvStub();
  const env = { LISTINGS_KV: kv, REFRESH_SECRET: "s3cret" };
  const r = await call("/admin/refresh", {
    env,
    headers: { Authorization: "Bearer s3cret" },
    upstream: async (url) => String(url).includes("heimstaden")
      ? new Response("down", { status: 500 })
      : new Response(JSON.stringify(PAYLOAD), { status: 200 }),
  });
  assert.equal(r.status, 200, "the others succeeded");
  assert.equal(r.body.portals.find((p) => p.src === "heimstaden").ok, false);
  assert.equal(r.body.portals.find((p) => p.src === "victoriahem").ok, true);
  assert.equal(kv.store.size, PORTALS.length - 1, "the failed portal writes nothing");
});

test("both portals failing the refresh is a 502", async () => {
  const env = { LISTINGS_KV: kvStub(), REFRESH_SECRET: "s3cret" };
  const r = await call("/admin/refresh", {
    env, headers: { Authorization: "Bearer s3cret" },
    upstream: async () => new Response("down", { status: 500 }),
  });
  assert.equal(r.status, 502);
  assert.ok(r.body.portals.every((p) => !p.ok));
});

test("/admin/refresh is never edge-cached", async () => {
  const r = await call("/admin/refresh", { env: { LISTINGS_KV: kvStub() } });
  assert.equal(r.headers.get("cache-control"), "no-store");
});

/* --- unchanged phase-1 guarantees --- */

test("r defaults to 500 and is capped at 3000", async () => {
  const env = { LISTINGS_KV: kvStub(freshSnapshots()) };
  const up = okHomeq();
  assert.equal((await call(`/nearby?${CENTER}`, { upstream: up, env })).body.radius, 500);
  assert.equal((await call(`/nearby?${CENTER}&r=1200`, { upstream: up, env })).body.radius, 1200);
  assert.equal((await call(`/nearby?${CENTER}&r=99999`, { upstream: up, env })).body.radius, 3000);
});

test("coordinates outside Sweden are rejected before any upstream call", async () => {
  let called = false;
  const spy = async () => { called = true; return new Response("{}"); };
  for (const q of ["lat=18.0335&lon=59.3165", "lat=54.9&lon=18", "lat=70.1&lon=18", "lat=59.3&lon=9.9", "lat=59.3&lon=25.1", "lat=abc&lon=18"]) {
    assert.equal((await call("/nearby?" + q, { upstream: spy })).status, 400, q);
  }
  assert.equal(called, false);
});

test("lat and lon are required", async () => {
  assert.equal((await call("/nearby")).status, 400);
  assert.equal((await call("/nearby?lat=59.3")).status, 400);
});

test("CORS is granted to the two known origins and nobody else", async () => {
  for (const origin of [DASHBOARD, "http://localhost:8080"]) {
    assert.equal((await call("/health", { origin })).headers.get("access-control-allow-origin"), origin);
  }
  for (const origin of ["https://evil.example.com", "http://localhost:8081"]) {
    assert.equal((await call("/health", { origin })).headers.get("access-control-allow-origin"), null, origin);
  }
});

test("/health names every source", async () => {
  const r = await call("/health");
  assert.deepEqual(r.body.sources, ["homeq", ...PORTALS.map((p) => p.src)]);
});

test("a preflight is answered 204, only GET is served, unknown paths 404", async () => {
  assert.equal((await call("/nearby", { method: "OPTIONS" })).status, 204);
  assert.equal((await call("/nearby", { method: "POST" })).status, 405);
  assert.equal((await call("/")).status, 404);
});

test("error responses are never cached", async () => {
  assert.equal((await call("/nearby?lat=1&lon=1")).headers.get("cache-control"), "no-store");
});

/* --- the cron --- */

test("the scheduled handler writes every snapshot", async () => {
  const kv = kvStub();
  const pending = [];
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(PAYLOAD), { status: 200 });
  try {
    await worker.scheduled({}, { LISTINGS_KV: kv }, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
  } finally { globalThis.fetch = real; }
  assert.equal(kv.store.size, PORTALS.length);
  const snap = JSON.parse(kv.store.get("arena:victoriahem"));
  assert.equal(snap.count, 3);
  assert.equal(snap.dropped, 2);
});
