/* am-se-listings — the listings gateway.
 *
 * Why it exists: the dashboard is a static page on GitHub Pages, and the
 * listing APIs it wants to read send no CORS headers, so the browser cannot
 * call them directly. This Worker is the smallest thing that fixes that: it
 * forwards one request per source, normalises the answers into one schema and
 * returns them. It is deliberately not a scraper and not a database.
 *
 *   GET /nearby?lat=&lon=&r=   listings within r metres, nearest first
 *   GET /text?src=&id=         the description excerpt for one listing
 *   GET /health                liveness, no upstream call
 *
 * Rules it enforces (see docs/LISTINGS.md):
 *   - nothing is stored; the only persistence is Cloudflare's edge cache
 *   - a source that fails is reported as ok:false, never as an empty success
 *   - one slow source cannot hold the response past its 8 s budget
 */
"use strict";

import * as homeq from "./sources/homeq.js";

/* Only the dashboard's own two origins. The gateway is a free proxy in front
 * of somebody else's API, so it is not left open to any page on the web. */
const ALLOWED_ORIGINS = new Set([
  "https://real-estate-war-lord.github.io",
  "http://localhost:8080",
]);

/* Sweden's bounding box, roughly. Anything outside it is a client bug — a
 * swapped lat/lon pair most likely — and is rejected rather than forwarded. */
const LAT_MIN = 55, LAT_MAX = 70;
const LON_MIN = 10, LON_MAX = 25;

const R_DEFAULT = 500;
const R_MAX = 3000;

const SOURCE_TIMEOUT_MS = 8000;
const TEXT_CACHE_SECONDS = 3600;
/* /nearby is not cached as long: listings turn over daily and a stale answer
 * is visible to the user. A minute is enough to absorb a map the user is
 * clicking around, which is what actually protects the upstream API. */
const NEARBY_CACHE_SECONDS = 60;

const SOURCES = [homeq];

/* --- HTTP helpers --- */

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const headers = { Vary: "Origin" };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
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

function fail(status, message, request) {
  return json({ error: message }, { status, request });
}

/* --- input validation --- */

/* Returns {lat, lon, r} or throws with a message meant for the client.
 * `r` is clamped rather than rejected: R_MAX is a cap on how much work the
 * gateway will do, and the effective value is echoed back in the response so
 * a caller that asked for more can see what it got. */
function parseNearbyParams(params) {
  const lat = Number(params.get("lat"));
  const lon = Number(params.get("lon"));
  if (!params.has("lat") || !params.has("lon")) {
    throw new Error("lat and lon are required");
  }
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

/* --- routes --- */

async function handleNearby(request, url) {
  let q;
  try {
    q = parseNearbyParams(url.searchParams);
  } catch (err) {
    return fail(400, err.message, request);
  }

  /* Every source is asked at once, each under its own timeout, and each
   * settles into its own {src, ok, count} entry. Promise.all over adapters
   * that never reject keeps one broken source from emptying the response. */
  const attempts = await Promise.all(SOURCES.map(async (source) => {
    try {
      const listings = await source.fetchNearby(q.lat, q.lon, q.r, {
        signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
      });
      return { status: { src: source.SRC, ok: true, count: listings.length }, listings };
    } catch (err) {
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      return {
        status: {
          src: source.SRC,
          ok: false,
          count: 0,
          error: timedOut
            ? `${source.SRC_LABEL} did not answer within ${SOURCE_TIMEOUT_MS / 1000} s`
            : `${source.SRC_LABEL}: ${err?.message || String(err)}`,
        },
        listings: [],
      };
    }
  }));

  const listings = attempts.flatMap((a) => a.listings)
    .sort((a, b) => a.dist_m - b.dist_m);

  const body = {
    fetchedAt: new Date().toISOString(),
    radius: q.r,
    sources: attempts.map((a) => a.status),
    listings,
  };

  /* If nothing succeeded there is no partial answer to serve, and a 200 would
   * let a caller that only checks the status code treat a total outage as
   * "no listings here". The body keeps its shape so the reason is readable. */
  const allFailed = body.sources.every((s) => !s.ok);
  return json(body, {
    status: allFailed ? 502 : 200,
    request,
    cache: allFailed ? 0 : NEARBY_CACHE_SECONDS,
  });
}

async function handleText(request, url) {
  const src = url.searchParams.get("src");
  const id = url.searchParams.get("id");
  if (!src || !id) return fail(400, "src and id are required", request);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return fail(400, "id is malformed", request);

  const source = SOURCES.find((s) => s.SRC === src);
  if (!source) {
    return fail(400, `unknown src '${src}' — known: ${SOURCES.map((s) => s.SRC).join(", ")}`, request);
  }

  try {
    const body = await source.fetchText(id, { signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) });
    return json(body, { request, cache: TEXT_CACHE_SECONDS });
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return fail(502, timedOut
      ? `${source.SRC_LABEL} did not answer within ${SOURCE_TIMEOUT_MS / 1000} s`
      : `${source.SRC_LABEL}: ${err?.message || String(err)}`, request);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (request.method !== "GET") {
      return fail(405, "only GET is supported", request);
    }

    if (url.pathname === "/health") {
      return json({ ok: true, sources: SOURCES.map((s) => s.SRC) }, { request });
    }

    if (url.pathname !== "/nearby" && url.pathname !== "/text") {
      return fail(404, "no such endpoint — try /nearby or /text", request);
    }

    /* Read through Cloudflare's edge cache. The cache key drops the Origin,
     * so the CORS headers are re-applied to the hit for the requesting
     * origin rather than served from whoever warmed the entry. */
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) {
      const headers = new Headers(hit.headers);
      for (const [k, v] of Object.entries(corsHeaders(request))) headers.set(k, v);
      headers.set("x-gateway-cache", "hit");
      return new Response(hit.body, { status: hit.status, headers });
    }

    const response = url.pathname === "/nearby"
      ? await handleNearby(request, url)
      : await handleText(request, url);

    if (response.status === 200 && response.headers.get("cache-control")?.includes("max-age")) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    const headers = new Headers(response.headers);
    headers.set("x-gateway-cache", "miss");
    return new Response(response.body, { status: response.status, headers });
  },
};
