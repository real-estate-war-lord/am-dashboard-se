/* Arena adapter — Heimstaden and Victoriahem.
 *
 * Both run the same "Arena" letting platform, so one adapter serves both: the
 * payloads are byte-for-byte the same 69-key shape, only the host differs.
 *
 *   GET <host>/rentalobject/Listapartment/published
 *     -> {status:"success", data:"<a JSON string>"}    (yes, a string)
 *
 * The important difference from HomeQ: this endpoint takes **no geo filter and
 * no pagination**. It answers with the landlord's entire national vacancy list
 * — 3.2 MB for Heimstaden, 8.6 MB for Victoriahem — or nothing. There is no
 * way to ask "what is near this point", so the gateway cannot proxy it live
 * per request: one map click would pull 12 MB. Hence the hourly snapshot in
 * KV, which is the only place this gateway stores anything.
 *
 * Everything here except fetchPortal() is pure, and the tests drive it with a
 * synthetic fixture in the real payload's shape.
 */
"use strict";

import { haversine } from "../geo.js";
import { stripBoilerplate } from "../boilerplate.js";
import { offerFromText } from "../offers.js";

/* Every landlord known to run an Arena tenant portal, with the host that
 * answers. Found by gateway/tools/discover_portals.mjs, which probed 65
 * candidates on 2026-09-24; 17 of them answered with valid Arena JSON. The
 * counts in the comments are that day's vacancy list, recorded so a portal
 * that quietly goes empty or changes shape is noticeable.
 *
 * Heimstaden and Victoriahem come first because they are by far the largest
 * and were the two this adapter was written against. */
export const PORTALS = [
  { src: "heimstaden", label: "Heimstaden", host: "https://mitt.heimstaden.com" },
  { src: "victoriahem", label: "Victoriahem", host: "https://minasidor.victoriahem.se" },
  { src: "lkf", label: "LKF", host: "https://www.lkf.se" },                         /* 146 listings, 100% with coordinates */
  { src: "uddevallahem", label: "Uddevallahem", host: "https://www.uddevallahem.se" },/* 81 listings, 100% with coordinates */
  { src: "helsingborgshem", label: "Helsingborgshem", host: "https://www.helsingborgshem.se" },/* 30 listings, 100% with coordinates */
  { src: "dios", label: "Diös", host: "https://minasidor.dios.se" },                /* 29 listings, 100% with coordinates */
  { src: "trianon", label: "Trianon", host: "https://minasidor.trianon.se" },       /* 27 listings, 100% with coordinates */
  { src: "nykopingshem", label: "Nyköpingshem", host: "https://minasidor.nykopingshem.se" },/* 27 listings, 100% with coordinates */
  { src: "skovdebostader", label: "Skövdebostäder", host: "https://minasidor.skovdebostader.se" },/* 26 listings, 100% with coordinates */
  { src: "mitthem", label: "Mitthem", host: "https://www.mitthem.se" },             /* 24 listings, 100% with coordinates */
  { src: "botkyrkabyggen", label: "Botkyrkabyggen", host: "https://www.botkyrkabyggen.se" },/* 22 listings, 100% with coordinates */
  { src: "vasbyhem", label: "Väsbyhem", host: "https://www.vasbyhem.se" },          /* 20 listings, 100% with coordinates */
  { src: "kalmarhem", label: "Kalmarhem", host: "https://minasidor.kalmarhem.se" }, /* 13 listings, 100% with coordinates */
  { src: "sollentunahem", label: "Sollentunahem", host: "https://minasidor.sollentunahem.se" },/* 6 listings, 100% with coordinates */
  { src: "lulebo", label: "Lulebo", host: "https://www.lulebo.se" },                /* 5 listings, 100% with coordinates */
  { src: "haningebostader", label: "Haninge Bostäder", host: "https://minasidor.haningebostader.se" },/* 5 listings, 100% with coordinates */
  { src: "vatterhem", label: "Vätterhem", host: "https://minasidor.vatterhem.se" }, /* 3 listings, 100% with coordinates */
  { src: "tyresobostader", label: "Tyresö Bostäder", host: "https://www.tyresobostader.se" },/* empty list at discovery — coordinate share unverified */
  { src: "signalisten", label: "Signalisten", host: "https://minasidor.signalisten.se" },/* empty list at discovery — coordinate share unverified */
];

export const LIST_PATH = "/rentalobject/Listapartment/published";

/* KV key for a portal's snapshot. One key per portal, overwritten each run. */
export const kvKey = (src) => `arena:${src}`;

/* A snapshot older than this is not served. */
export const STALE_AFTER_MS = 3 * 60 * 60 * 1000;

/* --- text --- */

const NAMED_ENTITIES = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  aring: "å", Aring: "Å", auml: "ä", Auml: "Ä", ouml: "ö", Ouml: "Ö",
  eacute: "é", Eacute: "É", egrave: "è", uuml: "ü", Uuml: "Ü",
  oslash: "ø", Oslash: "Ø", aelig: "æ", AElig: "Æ",
  ndash: "–", mdash: "—", hellip: "…", bull: "•", middot: "·",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  deg: "°", sup2: "²", sup3: "³", frac12: "½", times: "×", euro: "€",
};

/* Arena descriptions are HTML with entity-escaped Swedish characters —
 * "V&auml;lkommen till en tv&aring;a" — so a decoder that only knows &amp;
 * leaves the text full of mojibake exactly where the Swedish letters are. */
export function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === "#") {
      const cp = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : m;
  });
}

export function toPlainText(html) {
  if (typeof html !== "string") return "";
  return decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, " ")
      .replace(/<[^>]*>/g, "")
  ).replace(/\s+/g, " ").trim();
}

export const TEXT_START_CHARS = 220;

/* --- normalisation --- */

/* "2026-12-01T00:00:00" -> "2026-12-01", so a date means the same thing here
 * as it does in a HomeQ listing. Anything unparseable is passed through. */
export function isoDate(v) {
  if (typeof v !== "string" || !v) return null;
  const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : v;
}

/* The image. FirstImage carries no URL of its own — ExternalUrl, Filename and
 * ExternalPartnerUrl are null on every record in both portals — so the URL is
 * built the way the portal's own og:image tag builds it. /Content/ImageUrl
 * 301-redirects to the resized file under /Cache/, which a browser follows by
 * itself in an <img src>. */
export const IMAGE_W = 400;
export const IMAGE_H = 300;

export function imageUrl(host, firstImage) {
  const guid = firstImage?.Guid;
  if (!guid) return null;
  const q = new URLSearchParams({
    guid,
    width: String(IMAGE_W),
    height: String(IMAGE_H),
    crop: "True",
    datechanged: firstImage.DateChanged || "",
    extension: firstImage.Extension || "",
  });
  return `${host}/Content/ImageUrl?${q}`;
}

/* One Arena record -> the gateway schema, or null when it cannot be placed. */
export function normaliseRecord(raw, portal) {
  const lat = raw?.Latitude;
  const lon = raw?.Longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  /* 0,0 is the Gulf of Guinea, i.e. "no coordinate" written as a number. */
  if (lat === 0 && lon === 0) return null;

  /* Description is the plain-text field and DescriptionHtml the rich one, but
   * which is populated differs by portal: Heimstaden fills Description on 15
   * of 489 records and DescriptionHtml on 486. Preferring the plain field and
   * falling back to the HTML one is what actually yields text for both. */
  const full = toPlainText(raw.Description) || toPlainText(raw.DescriptionHtml);
  /* The campaign is read off the untouched text, then the campaign wording is
   * stripped out of the excerpt — so the fact of a discount survives in
   * `offer` while `text_start` gets on with describing the flat. */
  const offer = offerFromText(full);
  const text = stripBoilerplate(full).text;

  /* Addresses come out of the letting system with stray whitespace
   * ("Malakitgatan 12 "), which would otherwise reach the popup and, worse,
   * be compared against a HomeQ address during deduplication. */
  const clean = (v) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ") : null);

  return {
    src: portal.src,
    src_label: portal.label,
    id: raw.Id ?? raw.Guid ?? null,
    url: raw.DetailsUrl ? portal.host + raw.DetailsUrl : null,
    address: clean(raw.Adress1),
    area_name: clean(raw.AreaName),
    lat,
    lon,
    rent_sek_mo: Number.isFinite(raw.Cost) && raw.Cost > 0 ? raw.Cost : null,
    size_m2: Number.isFinite(raw.Size) && raw.Size > 0 ? raw.Size : null,
    rooms: Number.isFinite(raw.NoOfRooms) && raw.NoOfRooms > 0 ? raw.NoOfRooms : null,
    /* Floor 0 is a real answer (bottenvåning) and is kept; YearBuilt 0 is not
     * a year, it is "unknown" written as a zero — every one of Victoriahem's
     * 1113 records carries it. Storing it as 0 would put the entire portfolio
     * in year zero and drag any average built-year to nothing. The same trap
     * as the RegSO zeros in build_makro.py. */
    floor: Number.isFinite(raw.Floor) ? raw.Floor : null,
    year_built: Number.isFinite(raw.YearBuilt) && raw.YearBuilt > 1000 ? raw.YearBuilt : null,
    available_from: isoDate(raw.AvailableDate),
    published: isoDate(raw.ShowDateStart),
    image: imageUrl(portal.host, raw.FirstImage),
    text_start: text ? text.slice(0, TEXT_START_CHARS) : null,
    discount: null,
    offer,
    is_new_production: null,
    /* These landlords let directly: first suitable applicant, no queue time.
     * The list endpoint carries no youth/student/senior flag, so audience is
     * unknown rather than "everyone". */
    /* Coordinates come from the source, not from geocoding an address. */
    geo_source: "source",
    allocation: "direct",
    audience: null,
  };
}

/* The whole payload -> a snapshot ready for KV. `dist_m` is deliberately
 * absent: it depends on the query point and is added when the snapshot is
 * read, not when it is written. */
export function buildSnapshot(payload, portal, now = new Date()) {
  const outer = typeof payload === "string" ? JSON.parse(payload) : payload;
  /* `data` is a JSON *string* inside the JSON envelope, not an array. */
  const raw = outer?.data;
  const records = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(records)) {
    throw new Error(`${portal.label}: expected data to be an array, got ${typeof records}`);
  }

  const listings = [];
  let dropped = 0;
  for (const rec of records) {
    const listing = normaliseRecord(rec, portal);
    if (listing) listings.push(listing); else dropped++;
  }
  return {
    src: portal.src,
    fetchedAt: now.toISOString(),
    count: listings.length,
    dropped,
    listings,
  };
}

/* A snapshot -> the listings inside the circle, with dist_m attached. */
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

export function isStale(snapshot, now = Date.now()) {
  const t = Date.parse(snapshot?.fetchedAt ?? "");
  if (!Number.isFinite(t)) return true;
  return now - t > STALE_AFTER_MS;
}

/* --- I/O --- */

export async function fetchPortal(portal, { signal } = {}) {
  const res = await fetch(portal.host + LIST_PATH, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(`${portal.label} returned HTTP ${res.status}`);
  return buildSnapshot(await res.json(), portal);
}
