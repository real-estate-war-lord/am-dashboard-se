/* Bostadsförmedlingen i Stockholm — the municipal housing queue.
 *
 *   GET https://bostad.stockholm.se/AllaAnnonser/
 *
 * One request, every current advert in the Stockholm region, with
 * coordinates. This is the feed the site's own map view reads.
 *
 * WHY THIS SOURCE IS DIFFERENT FROM EVERY OTHER ONE
 *
 * These flats are real supply, but they are **not open to whoever applies
 * first**. They are allocated by queue time: you register, accrue days, and
 * the flat goes to the applicant with the longest queue time who applied. A
 * listing here is therefore not an offer you can take up — for most readers
 * it is unreachable, and the median advert in this feed wants 3 to 8 years of
 * queue time. Everything from this adapter carries `allocation: "queue"` so
 * the UI can say so, and the queue-time quartiles the feed publishes are
 * passed through rather than hidden.
 *
 * Roughly a third of the adverts are reserved for a particular group —
 * youth, student, senior or short-term lets — which is `audience`.
 */
"use strict";

import { haversine } from "../geo.js";

export const SRC = "bostadsformedlingen";
export const SRC_LABEL = "Bostadsförmedlingen (kö)";
export const ALLOCATION = "queue";

const HOST = "https://bostad.stockholm.se";
const LIST_PATH = "/AllaAnnonser/";

/* The reserved-audience flags, most specific first: an advert can carry more
 * than one, and "student" is a stronger statement than "youth". `Vanlig`
 * (ordinary) is the absence of a restriction and maps to null. */
const AUDIENCE_FLAGS = [
  ["Student", "student"],
  ["Ungdom", "youth"],
  ["Senior", "senior"],
  ["Korttid", "short_term"],
];

export function audienceOf(raw) {
  for (const [flag, value] of AUDIENCE_FLAGS) if (raw?.[flag] === true) return value;
  return null;
}

const num = (v) => (Number.isFinite(v) && v > 0 ? v : null);

export function normaliseRecord(raw, center) {
  const lat = raw?.KoordinatLatitud;
  const lon = raw?.KoordinatLongitud;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;

  const stats = raw.LiknadeLagenhetStatistik;

  const listing = {
    src: SRC,
    src_label: SRC_LABEL,
    id: raw.LägenhetId == null ? null : String(raw.LägenhetId),
    url: raw.Url ? HOST + raw.Url : null,
    address: (raw.Gatuadress || "").trim().replace(/\s+/g, " ") || null,
    /* Stadsdel is the neighbourhood, Kommun the municipality; outside
     * Stockholm city the neighbourhood alone would be ambiguous. */
    area_name: raw.Stadsdel && raw.Kommun && raw.Stadsdel !== raw.Kommun
      ? `${raw.Kommun} - ${raw.Stadsdel}`
      : (raw.Stadsdel || raw.Kommun || null),
    lat,
    lon,
    rent_sek_mo: num(raw.Hyra),
    size_m2: num(raw.Yta),
    rooms: num(raw.AntalRum),
    floor: Number.isFinite(raw.Vaning) ? raw.Vaning : null,
    year_built: null,
    available_from: null,
    published: raw.AnnonseradFran || null,
    image: null,
    text_start: null,
    discount: null,
    offer: null,
    is_new_production: raw.Nyproduktion === true ? true : null,
    allocation: ALLOCATION,
    audience: audienceOf(raw),
    /* Queue-specific, and the reason a reader should not treat this like a
     * listing they can simply take. */
    queue_name: raw.KoNamn || raw.Ko || null,
    /* The feed's own statistic: the first and third quartile of queue time,
     * in YEARS, among recently let flats like this one. Passed through as
     * published — no averaging, no single "expected" figure, because the
     * spread is the point. */
    queue_years_q1: Number.isFinite(stats?.KotidFordelningQ1) ? stats.KotidFordelningQ1 : null,
    queue_years_q3: Number.isFinite(stats?.KotidFordelningQ3) ? stats.KotidFordelningQ3 : null,
    /* Applications close on this date — a queue advert is open for days, not
     * until it is taken. */
    apply_by: raw.AnnonseradTill || null,
  };

  if (center) listing.dist_m = Math.round(haversine(center.lat, center.lon, lat, lon));
  return listing;
}

export function buildSnapshot(payload, now = new Date()) {
  const records = Array.isArray(payload) ? payload : (payload?.results ?? payload?.data);
  if (!Array.isArray(records)) {
    throw new Error(`${SRC_LABEL}: expected an array, got ${typeof records}`);
  }
  const listings = [];
  let dropped = 0;
  for (const raw of records) {
    const l = normaliseRecord(raw, null);
    if (l) listings.push(l); else dropped++;
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

export async function fetchSnapshot({ signal } = {}) {
  const res = await fetch(HOST + LIST_PATH, { headers: { accept: "application/json" }, signal });
  if (!res.ok) throw new Error(`${SRC_LABEL} returned HTTP ${res.status}`);
  return buildSnapshot(await res.json());
}
