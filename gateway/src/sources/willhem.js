/* Willhem.
 *
 * Willhem runs Episerver/Optimizely, and its Content Delivery API is open:
 *
 *   GET /api/episerver/v2.0/content/<regionPageId>/children
 *
 * returns every VacantObjectPage under a region, with coordinates, rent, area,
 * floor and the description. The region ids come from /mvcapi/search-landing,
 * so the set is discovered rather than hard-coded and a new Willhem city
 * appears by itself. That is 14 requests per refresh for ~645 flats.
 *
 * What this is NOT: Willhem's `/rentalobject/Listapartment/published` answers
 * HTTP 200 with a JSON-rendered 404 page. Phase 4's discovery classified that
 * as "own JSON API, not Arena"; it is simply a 404 that happens to be JSON,
 * and Willhem has no Arena portal. The note in this file is the correction.
 *
 * Every Willhem flat is also advertised on HomeQ — `isHomeQApartment` is true
 * on all 645 — which is what makes the HomeQ/portal deduplication matter here
 * in a way it did not for the Arena landlords.
 */
"use strict";

import { haversine } from "../geo.js";
import { stripBoilerplate } from "../boilerplate.js";
import { offerFromText } from "../offers.js";
import { toPlainText, isoDate } from "./arena.js";

export const SRC = "willhem";
export const SRC_LABEL = "Willhem";
export const ALLOCATION = "direct";

const HOST = "https://www.willhem.se";
const REGIONS_PATH = "/mvcapi/search-landing";
const CHILDREN_PATH = (id) => `/api/episerver/v2.0/content/${id}/children`;

export const TEXT_START_CHARS = 220;

/* Episerver wraps some properties as {value, propertyDataType} and leaves
 * others bare, in the same object. */
export function prop(v) {
  return v && typeof v === "object" && !Array.isArray(v) && "value" in v ? v.value : v;
}

/* "34,7" -> 34.7. Willhem writes areas with a Swedish decimal comma, so
 * Number("34,7") is NaN and 155 of 645 flats would silently lose their size.
 * A comma is only ever a decimal point here — these are never thousands. */
export function swedishNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = Number(v.trim().replace(/\s| | /g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/* "2 rum & kök" -> 2, "1.5 rum & kök" -> 1.5. The field is prose, not a
 * number, so every room count would otherwise be null. */
export function parseRooms(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const m = v.match(/(\d+(?:[.,]\d+)?)/);
  return m ? swedishNumber(m[1]) : null;
}

export function normaliseRecord(raw, regionName) {
  const lat = prop(raw?.latitude);
  const lon = prop(raw?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;

  const full = toPlainText(prop(raw.description));
  const offer = offerFromText(full);
  const text = stripBoilerplate(full).text;

  const id = prop(raw.code) ?? raw?.contentLink?.id ?? null;
  const url = raw.url ? (raw.url.startsWith("http") ? raw.url : HOST + raw.url) : null;

  const student = prop(raw.isStudentApartment) === true;

  return {
    src: SRC,
    src_label: SRC_LABEL,
    id: id === null ? null : String(id),
    url,
    address: (prop(raw.address) || "").trim().replace(/\s+/g, " ") || null,
    /* city/district/zipCode are present in the schema but empty on every
     * record, so the region page the flat was found under is the only area
     * name available. */
    area_name: regionName || null,
    lat,
    lon,
    rent_sek_mo: swedishNumber(prop(raw.rent)),
    size_m2: swedishNumber(prop(raw.area)),
    rooms: parseRooms(prop(raw.noOfRooms)),
    floor: swedishNumber(prop(raw.floor)),
    year_built: null,
    available_from: isoDate(prop(raw.availableFrom)),
    published: isoDate(prop(raw.startPublish)),
    /* Every image property on this content type is empty, so there is no
     * picture to link. Saying null is better than inventing a URL. */
    image: null,
    text_start: text ? text.slice(0, TEXT_START_CHARS) : null,
    discount: null,
    offer,
    is_new_production: prop(raw.isNewProduction) === true ? true : null,
    allocation: ALLOCATION,
    audience: student ? "student" : null,
    geo_source: "source",
  };
}

export function buildSnapshot(regions, now = new Date()) {
  const listings = [];
  let dropped = 0;
  for (const { name, records } of regions) {
    for (const rec of records) {
      const l = normaliseRecord(rec, name);
      if (l) listings.push(l); else dropped++;
    }
  }
  return { src: SRC, fetchedAt: now.toISOString(), count: listings.length, dropped, listings };
}

export function selectNearby(snapshot, lat, lon, r) {
  const listings = Array.isArray(snapshot?.listings) ? snapshot.listings : [];
  const out = [];
  for (const l of listings) {
    const d = haversine(lat, lon, l.lat, l.lon);
    if (d > r) continue;
    out.push({ ...l, dist_m: Math.round(d) });
  }
  out.sort((a, b) => a.dist_m - b.dist_m);
  return out;
}

/* --- I/O --- */

async function getJson(path, signal) {
  const res = await fetch(HOST + path, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(`Willhem ${path} returned HTTP ${res.status}`);
  return res.json();
}

export async function fetchSnapshot({ signal } = {}) {
  const landing = await getJson(REGIONS_PATH, signal);
  const regionPages = landing?.data?.regionPages;
  if (!Array.isArray(regionPages) || !regionPages.length) {
    throw new Error("Willhem: no region pages in search-landing");
  }

  const regions = [];
  /* Serial on purpose: 13 small requests against somebody else's CMS, once an
   * hour, is a rounding error; thirteen at once is a spike. */
  for (const page of regionPages) {
    const id = page?.contentLink?.id;
    if (!Number.isFinite(id)) continue;
    let children;
    try {
      children = await getJson(CHILDREN_PATH(id), signal);
    } catch {
      continue; // one region failing must not empty the whole snapshot
    }
    const arr = Array.isArray(children) ? children : (children?.items ?? []);
    regions.push({
      name: page.name ?? null,
      records: arr.filter((c) => (c?.contentType ?? []).includes("VacantObjectPage")),
    });
  }
  if (!regions.length) throw new Error("Willhem: every region request failed");
  return buildSnapshot(regions);
}
