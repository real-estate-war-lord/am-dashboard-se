/* am-se-listings — the listings gateway.
 *
 * Why it exists: the dashboard is a static page on GitHub Pages, and the
 * listing APIs it wants to read send no CORS headers, so the browser cannot
 * call them directly. This Worker is the smallest thing that fixes that.
 *
 *   GET /nearby?lat=&lon=&r=   listings within r metres, nearest first
 *   GET /bbox?s=&w=&n=&e=      listings inside a map viewport, nearest first
 *   GET /text?src=&id=         the description excerpt for one listing
 *   GET /health                liveness, no upstream call
 *   POST-like /admin/refresh   rebuild the portal snapshots (bearer secret)
 *   cron "7 * * * *"           the same refresh, hourly
 *
 * Two source kinds, for one reason (see docs/LISTINGS.md):
 *   - HomeQ takes a bounding box, so it is proxied live per request.
 *   - The Arena portals take no geo filter at all and answer with the whole
 *     national list, so they are snapshotted hourly into KV and read from
 *     there. That snapshot is the only thing this gateway stores.
 *
 * Rules it enforces:
 *   - a source that fails is reported as ok:false, never as an empty success
 *   - a snapshot older than 3 h is stale and is not served as if it were fresh
 *   - one slow source cannot hold the response past its 8 s budget
 */
"use strict";

import * as homeq from "./sources/homeq.js";
import { SNAPSHOT_SOURCES, bySrc, isStale } from "./snapshots.js";
import { dedupe } from "./dedupe.js";
import { boxCover, inBox } from "./geo.js";

const ALLOWED_ORIGINS = new Set([
  "https://real-estate-war-lord.github.io",
  /* The two local dev ports. 8080 is what `python3 -m http.server 8080
   * --directory dist` uses; 8081 is the fallback for when 8080 is already
   * taken by another project on the same machine. Both are loopback-only and
   * cannot be reached from another host. */
  "http://localhost:8080",
  "http://localhost:8081",
]);

const LAT_MIN = 55, LAT_MAX = 70;
const LON_MIN = 10, LON_MAX = 25;

const R_DEFAULT = 500;
const R_MAX = 3000;

const SOURCE_TIMEOUT_MS = 8000;
/* The refresh runs on a cron with no user waiting, and pulls 3 MB and 8 MB
 * bodies, so it gets a budget of its own rather than the per-request one. */
const REFRESH_TIMEOUT_MS = 25000;

const TEXT_CACHE_SECONDS = 3600;
const NEARBY_CACHE_SECONDS = 60;

/* --- HTTP helpers --- */

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const headers = { Vary: "Origin" };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}

function json(body, { status = 200, request, cache = 0 } = {}) {
  return new Response(JSON.stringify(body, null, status === 200 ? 0 : 1), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cache > 0 ? `public, max-age=${cache}` : "no-store",
      ...corsHeaders(request),
    },
  });
}

const fail = (status, message, request) => json({ error: message }, { status, request });

const describeError = (label, err) =>
  err?.name === "TimeoutError" || err?.name === "AbortError"
    ? `${label} did not answer in time`
    : `${label}: ${err?.message || String(err)}`;

/* --- input validation --- */

function parseNearbyParams(params) {
  if (!params.has("lat") || !params.has("lon")) throw new Error("lat and lon are required");
  const lat = Number(params.get("lat"));
  const lon = Number(params.get("lon"));
  if (!Number.isFinite(lat) || lat < LAT_MIN || lat > LAT_MAX) {
    throw new Error(`lat must be a number between ${LAT_MIN} and ${LAT_MAX}`);
  }
  if (!Number.isFinite(lon) || lon < LON_MIN || lon > LON_MAX) {
    throw new Error(`lon must be a number between ${LON_MIN} and ${LON_MAX}`);
  }
  let r = R_DEFAULT;
  if (params.has("r") && params.get("r") !== "") {
    r = Number(params.get("r"));
    if (!Number.isFinite(r) || r <= 0) throw new Error("r must be a positive number of metres");
    r = Math.min(r, R_MAX);
  }
  return { lat, lon, r };
}

/* A viewport, as four edges. The same Sweden bounds as /nearby catch a swapped
 * pair, and an inverted or empty box is a client bug rather than a query. The
 * covering circle is capped at R_MAX exactly as `r` is, and the effective
 * coverage comes back in the answer so a client can tell it zoomed out too far. */
function parseBboxParams(params) {
  const need = ["s", "w", "n", "e"];
  for (const k of need) if (!params.has(k)) throw new Error("s, w, n and e are all required");
  const [s, w, n, e] = need.map((k) => Number(params.get(k)));
  for (const [k, v] of [["s", s], ["n", n]]) {
    if (!Number.isFinite(v) || v < LAT_MIN || v > LAT_MAX) {
      throw new Error(`${k} must be a latitude between ${LAT_MIN} and ${LAT_MAX}`);
    }
  }
  for (const [k, v] of [["w", w], ["e", e]]) {
    if (!Number.isFinite(v) || v < LON_MIN || v > LON_MAX) {
      throw new Error(`${k} must be a longitude between ${LON_MIN} and ${LON_MAX}`);
    }
  }
  if (n <= s || e <= w) throw new Error("the box is empty or inverted: expected s < n and w < e");
  const box = { s, w, n, e };
  const cover = boxCover(box);
  return { box, lat: cover.lat, lon: cover.lon, r: Math.min(cover.r, R_MAX), cover: cover.r };
}

/* --- the snapshots --- */

async function readSnapshot(env, source) {
  if (!env?.LISTINGS_KV) throw new Error("LISTINGS_KV is not bound");
  const snap = await env.LISTINGS_KV.get(source.kvKey, { type: "json" });
  if (!snap) throw new Error("no snapshot yet — the hourly refresh has not run");
  if (isStale(snap)) {
    throw new Error(`stale — snapshot is from ${snap.fetchedAt}, older than 3 h`);
  }
  return snap;
}

/* How many portals are fetched at once. Victoriahem's list is 8.6 MB and
 * parsing it costs several times that in live objects; nineteen of those in
 * flight together would run at the Worker's 128 MB ceiling. Four keeps the
 * peak well under it while still finishing the whole refresh in seconds. */
const REFRESH_CONCURRENCY = 4;

/* Rebuild every snapshot. Each source is independent: one failing leaves the
 * others' snapshots alone rather than blanking them. */
export async function refreshAll(env) {
  const portals = SNAPSHOT_SOURCES;
  const results = new Array(portals.length);
  let next = 0;

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= portals.length) return;
      const portal = portals[i];
      try {
        const snap = await portal.fetch({
          signal: AbortSignal.timeout(portal.timeoutMs ?? REFRESH_TIMEOUT_MS),
          ...(portal.needsEnv ? { env } : {}),
        });
        await env.LISTINGS_KV.put(portal.kvKey, JSON.stringify(snap));
        results[i] = { src: portal.src, ok: true, count: snap.count, dropped: snap.dropped, fetchedAt: snap.fetchedAt };
      } catch (err) {
        results[i] = { src: portal.src, ok: false, error: describeError(portal.label, err) };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(REFRESH_CONCURRENCY, portals.length) }, worker));
  return { refreshedAt: new Date().toISOString(), portals: results };
}

/* --- routes --- */

/* Every source, asked once for one circle. Shared by /nearby and /bbox: a second
 * copy of this fan-out is a second place for "a failing source is never an empty
 * success" to be got wrong. */
async function collect(lat, lon, r, env) {
  /* HomeQ live, both portals from KV, all at once. */
  const homeqAttempt = (async () => {
    try {
      const listings = await homeq.fetchNearby(lat, lon, r, {
        signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
      });
      return { status: { src: homeq.SRC, ok: true, count: listings.length }, listings };
    } catch (err) {
      return {
        status: { src: homeq.SRC, ok: false, count: 0, error: describeError(homeq.SRC_LABEL, err) },
        listings: [],
      };
    }
  })();

  const portalAttempts = SNAPSHOT_SOURCES.map(async (portal) => {
    try {
      const snap = await readSnapshot(env, portal);
      const listings = portal.selectNearby(snap, lat, lon, r);
      return {
        status: { src: portal.src, ok: true, count: listings.length, fetchedAt: snap.fetchedAt },
        listings,
      };
    } catch (err) {
      return {
        status: { src: portal.src, ok: false, count: 0, error: describeError(portal.label, err) },
        listings: [],
      };
    }
  });

  const [homeqResult, ...portalResults] = await Promise.all([homeqAttempt, ...portalAttempts]);

  const portalListings = portalResults.flatMap((p) => p.listings);
  const { listings, merged } = dedupe(portalListings, homeqResult.listings);
  return { sources: [homeqResult.status, ...portalResults.map((p) => p.status)], deduped: merged, listings };
}

/* How a set of listings is allocated. A queue flat is real supply but is not open
 * to whoever applies first, so a consumer that shows one total would be mixing
 * two different things. */
function allocationOf(listings) {
  const allocation = { direct: 0, queue: 0 };
  for (const l of listings) {
    if (l.allocation === "queue") allocation.queue++; else allocation.direct++;
  }
  return allocation;
}

/* The source counts describe what came back, so trimming the listings without
 * recounting would leave a source claiming more than the answer contains. */
function recount(sources, listings) {
  const seen = new Map();
  for (const l of listings) seen.set(l.src, (seen.get(l.src) || 0) + 1);
  return sources.map((s) => (s.ok ? { ...s, count: seen.get(s.src) || 0 } : s));
}

function answer(request, body) {
  const allFailed = body.sources.every((s) => !s.ok);
  return json(body, {
    status: allFailed ? 502 : 200,
    request,
    cache: allFailed ? 0 : NEARBY_CACHE_SECONDS,
  });
}

async function handleNearby(request, url, env) {
  let q;
  try { q = parseNearbyParams(url.searchParams); }
  catch (err) { return fail(400, err.message, request); }

  const got = await collect(q.lat, q.lon, q.r, env);
  return answer(request, {
    fetchedAt: new Date().toISOString(),
    radius: q.r,
    sources: got.sources,
    deduped: got.deduped,
    allocation: allocationOf(got.listings),
    listings: got.listings,
  });
}

/* A map viewport. The covering circle is fetched and the answer is then trimmed
 * to the rectangle, so a marker layer gets exactly what is on screen. */
async function handleBbox(request, url, env) {
  let q;
  try { q = parseBboxParams(url.searchParams); }
  catch (err) { return fail(400, err.message, request); }

  const got = await collect(q.lat, q.lon, q.r, env);
  const listings = got.listings.filter((l) =>
    Number.isFinite(l.lat) && Number.isFinite(l.lon) && inBox(l.lat, l.lon, q.box));
  return answer(request, {
    fetchedAt: new Date().toISOString(),
    bbox: q.box,
    /* what was actually searched: the covering circle, and whether R_MAX clipped it */
    radius: q.r,
    covered: q.cover <= R_MAX,
    sources: recount(got.sources, listings),
    deduped: got.deduped,
    allocation: allocationOf(listings),
    listings,
  });
}

async function handleText(request, url, env) {
  const src = url.searchParams.get("src");
  const id = url.searchParams.get("id");
  if (!src || !id) return fail(400, "src and id are required", request);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return fail(400, "id is malformed", request);

  if (src === homeq.SRC) {
    try {
      const body = await homeq.fetchText(id, { signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) });
      return json(body, { request, cache: TEXT_CACHE_SECONDS });
    } catch (err) {
      return fail(502, describeError(homeq.SRC_LABEL, err), request);
    }
  }

  const portal = bySrc(src);
  if (!portal) {
    const known = [homeq.SRC, ...SNAPSHOT_SOURCES.map((p) => p.src)].join(", ");
    return fail(400, `unknown src '${src}' — known: ${known}`, request);
  }

  /* Snapshot excerpts are already stored — the list endpoints carry the full
   * description, so there is no per-listing call to make. */
  try {
    const snap = await readSnapshot(env, portal);
    const hit = snap.listings.find((l) => String(l.id) === id);
    if (!hit) return fail(404, `no listing '${id}' in the ${portal.label} snapshot`, request);
    return json({ text_start: hit.text_start ?? null }, { request, cache: TEXT_CACHE_SECONDS });
  } catch (err) {
    return fail(502, describeError(portal.label, err), request);
  }
}

/* Constant-time-ish string compare, so the secret cannot be guessed by
 * timing the response. */
function secretMatches(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleAdminRefresh(request, env) {
  const expected = env?.REFRESH_SECRET;
  /* An unset secret closes the endpoint rather than opening it. */
  if (!expected) return fail(503, "refresh endpoint is disabled: REFRESH_SECRET is not set", request);

  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!secretMatches(token, expected)) return fail(401, "unauthorized", request);

  if (!env?.LISTINGS_KV) return fail(503, "LISTINGS_KV is not bound", request);

  const summary = await refreshAll(env);
  const anyOk = summary.portals.some((p) => p.ok);
  return json(summary, { status: anyOk ? 200 : 502, request });
}

export default {
  /* Hourly cron: rebuild both snapshots. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const summary = await refreshAll(env);
      for (const p of summary.portals) {
        console.log(p.ok
          ? `refresh ${p.src}: ${p.count} listings, ${p.dropped} dropped`
          : `refresh ${p.src}: FAILED — ${p.error}`);
      }
    })());
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    /* Never cached, never CORS-exposed to a page: an operator endpoint. */
    if (url.pathname === "/admin/refresh") return handleAdminRefresh(request, env);

    if (request.method !== "GET") return fail(405, "only GET is supported", request);

    if (url.pathname === "/health") {
      return json({
        ok: true,
        endpoints: ["/nearby", "/bbox", "/text"],
        sources: [homeq.SRC, ...SNAPSHOT_SOURCES.map((p) => p.src)],
      }, { request });
    }

    const HANDLERS = { "/nearby": handleNearby, "/bbox": handleBbox, "/text": handleText };
    const handler = HANDLERS[url.pathname];
    if (!handler) {
      return fail(404, `no such endpoint — try ${Object.keys(HANDLERS).join(", ")}`, request);
    }

    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) {
      const headers = new Headers(hit.headers);
      for (const [k, v] of Object.entries(corsHeaders(request))) headers.set(k, v);
      headers.set("x-gateway-cache", "hit");
      return new Response(hit.body, { status: hit.status, headers });
    }

    const response = await handler(request, url, env);

    if (response.status === 200 && response.headers.get("cache-control")?.includes("max-age")) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    const headers = new Headers(response.headers);
    headers.set("x-gateway-cache", "miss");
    return new Response(response.body, { status: response.status, headers });
  },
};
