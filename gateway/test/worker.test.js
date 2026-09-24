/* The request envelope: validation, CORS, and above all the promise that a
 * failing source is reported as a failure rather than as "no listings here".
 *
 * The Worker runtime is stubbed with the two globals src/index.js touches —
 * fetch and caches — so the routing can be tested without wrangler.
 */
"use strict";

import test from "node:test";
import assert from "node:assert/strict";

globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const ctx = { waitUntil: () => {} };

const { default: worker } = await import("../src/index.js");

const DASHBOARD = "https://real-estate-war-lord.github.io";

/* Runs one request with `fetch` replaced for the duration of the call. */
async function call(path, { origin = DASHBOARD, method = "GET", upstream } = {}) {
  const real = globalThis.fetch;
  if (upstream) globalThis.fetch = upstream;
  try {
    const req = new Request("https://gateway.invalid" + path, {
      method,
      headers: origin ? { Origin: origin } : {},
    });
    const res = await worker.fetch(req, {}, ctx);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* non-JSON is a failure the test will show */ }
    return { status: res.status, headers: res.headers, body, text };
  } finally {
    globalThis.fetch = real;
  }
}

const okUpstream = (results) => async () =>
  new Response(JSON.stringify({ results, total_hits: results.length }), {
    status: 200, headers: { "content-type": "application/json" },
  });

const HIT = {
  id: 1, uri: "/lagenhet/1", title: "Testgatan 1",
  location: { lat: 59.3166, lon: 18.0336 },
  rent: 9000, rooms: 2, area: 50, date_access: "2026-12-01",
  images: [{ image: "https://example.invalid/x.jpeg" }], discount: null,
};

test("a healthy source answers 200 with ok:true", async () => {
  const r = await call("/nearby?lat=59.3165&lon=18.0335&r=500", { upstream: okUpstream([HIT]) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.sources, [{ src: "homeq", ok: true, count: 1 }]);
  assert.equal(r.body.listings.length, 1);
  assert.equal(r.body.radius, 500);
  assert.ok(!Number.isNaN(Date.parse(r.body.fetchedAt)));
});

test("a source that errors is ok:false with a message, and the call is 502", async () => {
  const r = await call("/nearby?lat=59.3165&lon=18.0335", {
    upstream: async () => new Response("nope", { status: 503 }),
  });
  /* The point of the whole exercise: an upstream outage must never look like
   * an honest empty neighbourhood. */
  assert.equal(r.status, 502);
  assert.equal(r.body.sources[0].ok, false);
  assert.equal(r.body.sources[0].count, 0);
  assert.match(r.body.sources[0].error, /HomeQ/);
  assert.match(r.body.sources[0].error, /503/);
  assert.deepEqual(r.body.listings, []);
  /* and the envelope still has its documented shape */
  assert.deepEqual(Object.keys(r.body), ["fetchedAt", "radius", "sources", "listings"]);
});

test("a thrown network error is reported, not swallowed", async () => {
  const r = await call("/nearby?lat=59.3165&lon=18.0335", {
    upstream: async () => { throw new Error("connection refused"); },
  });
  assert.equal(r.status, 502);
  assert.equal(r.body.sources[0].ok, false);
  assert.match(r.body.sources[0].error, /connection refused/);
});

test("a source that hangs is cut off and reported as a timeout", async () => {
  const r = await call("/nearby?lat=59.3165&lon=18.0335", {
    upstream: (url, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => reject(opts.signal.reason));
    }),
  });
  assert.equal(r.status, 502);
  assert.equal(r.body.sources[0].ok, false);
  assert.match(r.body.sources[0].error, /did not answer within 8 s/);
});

test("an empty but healthy source is a 200 with count 0", async () => {
  const r = await call("/nearby?lat=59.3165&lon=18.0335", { upstream: okUpstream([]) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.sources, [{ src: "homeq", ok: true, count: 0 }]);
  assert.deepEqual(r.body.listings, []);
});

test("r defaults to 500 and is capped at 3000", async () => {
  const up = okUpstream([]);
  assert.equal((await call("/nearby?lat=59.3165&lon=18.0335", { upstream: up })).body.radius, 500);
  assert.equal((await call("/nearby?lat=59.3165&lon=18.0335&r=1200", { upstream: up })).body.radius, 1200);
  assert.equal((await call("/nearby?lat=59.3165&lon=18.0335&r=99999", { upstream: up })).body.radius, 3000);
});

test("coordinates outside Sweden are rejected before any upstream call", async () => {
  let called = false;
  const spy = async () => { called = true; return new Response("{}"); };
  for (const q of [
    "lat=18.0335&lon=59.3165",   // the classic swap
    "lat=54.9&lon=18",
    "lat=70.1&lon=18",
    "lat=59.3&lon=9.9",
    "lat=59.3&lon=25.1",
    "lat=abc&lon=18",
  ]) {
    const r = await call("/nearby?" + q, { upstream: spy });
    assert.equal(r.status, 400, q);
    assert.ok(r.body.error, q);
  }
  assert.equal(called, false, "a rejected request must not reach the source");
});

test("lat and lon are required", async () => {
  assert.equal((await call("/nearby")).status, 400);
  assert.equal((await call("/nearby?lat=59.3")).status, 400);
  assert.equal((await call("/nearby?lon=18")).status, 400);
});

test("CORS is granted to the two known origins and nobody else", async () => {
  for (const origin of [DASHBOARD, "http://localhost:8080"]) {
    const r = await call("/health", { origin });
    assert.equal(r.headers.get("access-control-allow-origin"), origin);
    assert.equal(r.headers.get("vary"), "Origin");
  }
  for (const origin of ["https://evil.example.com", "http://localhost:8081", "null"]) {
    const r = await call("/health", { origin });
    assert.equal(r.headers.get("access-control-allow-origin"), null, origin);
  }
});

test("a preflight is answered 204", async () => {
  const r = await call("/nearby", { method: "OPTIONS" });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-methods"), "GET, OPTIONS");
});

test("only GET is served", async () => {
  assert.equal((await call("/nearby", { method: "POST" })).status, 405);
  assert.equal((await call("/nearby", { method: "DELETE" })).status, 405);
});

test("unknown paths are 404", async () => {
  assert.equal((await call("/")).status, 404);
  assert.equal((await call("/listings")).status, 404);
});

test("/text validates src and id", async () => {
  assert.equal((await call("/text?src=homeq")).status, 400);
  assert.equal((await call("/text?id=1")).status, 400);
  assert.equal((await call("/text?src=blocket&id=1")).status, 400);
  assert.equal((await call("/text?src=homeq&id=../../secret")).status, 400);
  assert.equal((await call("/text?src=homeq&id=1%20OR%201")).status, 400);
});

test("/text returns the excerpt and asks for an hour of caching", async () => {
  const r = await call("/text?src=homeq&id=100001", {
    upstream: async () => new Response(JSON.stringify({
      object_ad: { description: "<p>Ljus tvåa med balkong.</p>" },
    }), { status: 200 }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { text_start: "Ljus tvåa med balkong." });
  assert.match(r.headers.get("cache-control"), /max-age=3600/);
});

test("/text surfaces an upstream failure as 502", async () => {
  const r = await call("/text?src=homeq&id=100001", {
    upstream: async () => new Response("gone", { status: 404 }),
  });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /HomeQ/);
});

test("error responses are never cached", async () => {
  const r = await call("/nearby?lat=1&lon=1");
  assert.equal(r.headers.get("cache-control"), "no-store");
});
