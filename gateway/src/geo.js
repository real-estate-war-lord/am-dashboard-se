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
