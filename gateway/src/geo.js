/* Geometry for the radius search.
 *
 * Both functions are pure and are the unit-tested core of the gateway: the
 * bounding box is what gets sent upstream, the haversine distance is what
 * trims the box back to a circle. A box is always wider than the circle it
 * contains (by 4/pi - 1 = 27 % in area at the equator, more towards the pole),
 * so the trim is not cosmetic — without it a 500 m search returns listings up
 * to 707 m away in the corners.
 */
"use strict";

/* Metres per degree of latitude. A round number on purpose: it is the figure
 * the upstream sources' own map clients use, so the boxes agree. */
export const M_PER_DEG_LAT = 111320;

/* IUGG mean Earth radius, metres. */
export const EARTH_RADIUS_M = 6371008.8;

const DEG = Math.PI / 180;

/* The smallest lat/lon box that contains the circle of radius `r` metres
 * around (lat, lon). A degree of longitude shrinks with cos(latitude) — at
 * 59 degrees N it is about half a degree of latitude — so the two offsets
 * differ, and using one for both is the classic way to get an oval. */
export function boundingBox(lat, lon, r) {
  const dLat = r / M_PER_DEG_LAT;
  const dLon = r / (M_PER_DEG_LAT * Math.cos(lat * DEG));
  return {
    min_lat: lat - dLat,
    max_lat: lat + dLat,
    min_lng: lon - dLon,
    max_lng: lon + dLon,
  };
}

/* Great-circle distance in metres. */
export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/* --- the viewport box (the /bbox endpoint) ---
 *
 * A map viewport is a rectangle, and answering it with a radius around its
 * centre either misses the corners or over-fetches: the circumscribed circle of
 * a rectangle is 4/pi = 27 % larger in area than the box at the equator, and the
 * inscribed circle misses 21 % of it. So /bbox does both halves properly — it
 * covers the box with the smallest circle that contains it, runs the existing
 * radius machinery, and then trims the answer back to the rectangle. Nothing
 * outside the reader's view comes back, and nothing inside it is missed.
 */

/* Half-diagonal of the box, in metres: the radius of the smallest circle that
 * contains it, measured from its centre. */
export function boxCover(box) {
  const lat = (box.s + box.n) / 2;
  const lon = (box.w + box.e) / 2;
  const halfLat = haversine(box.s, lon, box.n, lon) / 2;
  const halfLon = haversine(lat, box.w, lat, box.e) / 2;
  return { lat, lon, r: Math.sqrt(halfLat * halfLat + halfLon * halfLon) };
}

/* Is the point inside the box? Inclusive on every edge, so a listing sitting
 * exactly on the boundary is returned rather than silently dropped. */
export function inBox(lat, lon, box) {
  return lat >= box.s && lat <= box.n && lon >= box.w && lon <= box.e;
}
