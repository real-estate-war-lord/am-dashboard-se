/* HomeQ adapter.
 *
 * HomeQ (homeq.se) is a Swedish rental marketplace whose public web client
 * talks to an unauthenticated JSON API. Two endpoints are used:
 *
 *   POST /api/v3/search      {geo_bounds:{min_lat,max_lat,min_lng,max_lng}}
 *   GET  /api/v1/object/<id>  the full ad, only for its description
 *
 * The search endpoint returns every hit in the box in one response — an
 * all-Sweden box answers with ~6 500 results and no cursor — so there is no
 * pagination to handle at the radii this gateway allows (max 3 km).
 *
 * `fetchNearby` is the only function here that does I/O. The two normalisers
 * are pure so the tests can pin the output schema against a recorded payload.
 */
"use strict";

import { boundingBox, haversine } from "../geo.js";
import { stripBoilerplate } from "../boilerplate.js";
import { offerFromDiscount } from "../offers.js";

export const SRC = "homeq";
export const SRC_LABEL = "HomeQ";

const SEARCH_URL = "https://api.homeq.se/api/v3/search";
const OBJECT_URL = "https://api.homeq.se/api/v1/object/";
const SITE = "https://www.homeq.se";

/* One raw search hit -> one listing in the gateway's schema, or null when the
 * hit is unusable. A hit with no coordinates cannot be placed on a map or
 * distance-sorted, and is the one case worth dropping outright.
 *
 * Every field the search endpoint does not carry is null rather than absent:
 * the schema is the same for every source, so a consumer can read
 * `listing.year_built` without checking which source it came from. The detail
 * endpoint does carry floor, publication date and new-production flags, but
 * fetching it per hit would mean one upstream call per listing, so those stay
 * null here and /text fills the only one that earns a second round trip.
 */
export function normaliseListing(raw, center) {
  const lat = raw?.location?.lat;
  const lon = raw?.location?.lon;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  return {
    src: SRC,
    src_label: SRC_LABEL,
    id: raw.id,
    url: raw.uri ? SITE + raw.uri : null,
    address: raw.title ?? null,
    area_name: null,
    lat,
    lon,
    rent_sek_mo: raw.rent ?? null,
    size_m2: raw.area ?? null,
    rooms: raw.rooms ?? null,
    floor: null,
    year_built: null,
    available_from: raw.date_access ?? null,
    published: null,
    image: raw.images?.[0]?.image ?? null,
    text_start: null,
    discount: raw.discount ?? null,
    /* HomeQ ships a structured discount rather than prose, so the offer is
     * composed from it instead of being read out of the description — which
     * /nearby does not fetch anyway. `enabled` is genuinely false on some
     * records and those are not offers. */
    offer: offerFromDiscount(raw.discount),
    is_new_production: null,
    dist_m: Math.round(haversine(center.lat, center.lon, lat, lon)),
  };
}

/* The whole search payload -> the listings actually inside the circle,
 * nearest first. The trim compares the exact distance against r and only then
 * rounds, so a listing at 500.4 m is excluded from a 500 m search rather than
 * rounded into it. */
export function selectNearby(payload, lat, lon, r) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const center = { lat, lon };
  const out = [];
  for (const raw of results) {
    const listing = normaliseListing(raw, center);
    if (!listing) continue;
    if (haversine(lat, lon, listing.lat, listing.lon) > r) continue;
    out.push(listing);
  }
  out.sort((a, b) => a.dist_m - b.dist_m || String(a.id).localeCompare(String(b.id)));
  return out;
}

/* Strip a description down to plain text. HomeQ descriptions are usually
 * already plain, but some carry markup from the landlord's own CMS, and a
 * half-open tag rendered verbatim in a dashboard tooltip looks like a bug. */
export function toPlainText(html) {
  if (typeof html !== "string") return "";
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6])>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export const TEXT_START_CHARS = 220;

/* The description excerpt for one object id. The same boilerplate stripper
 * runs here as on the portals: its patterns are drawn from the portal corpora
 * and mostly will not match HomeQ prose, but HomeQ's per-listing descriptions
 * cannot be corpus-analysed the same way — that would mean one request per
 * listing across ~6 400 ads — so no HomeQ-specific patterns exist yet. */
export function normaliseText(payload) {
  const text = stripBoilerplate(toPlainText(payload?.object_ad?.description)).text;
  return { text_start: text.slice(0, TEXT_START_CHARS) || null };
}

/* --- I/O --- */

export async function fetchNearby(lat, lon, r, { signal } = {}) {
  const res = await fetch(SEARCH_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ geo_bounds: boundingBox(lat, lon, r) }),
    signal,
  });
  if (!res.ok) throw new Error(`HomeQ search returned HTTP ${res.status}`);
  return selectNearby(await res.json(), lat, lon, r);
}

export async function fetchText(id, { signal } = {}) {
  const res = await fetch(OBJECT_URL + encodeURIComponent(id), {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(`HomeQ object returned HTTP ${res.status}`);
  return normaliseText(await res.json());
}
