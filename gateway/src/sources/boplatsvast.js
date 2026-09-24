/* Boplats Väst — the Göteborg-region municipal housing queue.
 *
 * WHY THERE IS NO GEOCODER HERE
 *
 * Phase 5 reported that Boplats Väst exposes no coordinates. That was true of
 * the *listing* page and wrong about the site: each advert's own page carries
 *
 *   <div id="karta" data-latitude="57.6801051" data-longitude="11.9737198">
 *
 * which is the landlord's own position for the building. Geocoding the
 * address through Nominatim would have replaced an authoritative coordinate
 * with a guessed one — so this adapter reads the source instead, and every
 * listing is `geo_source: "source"` like every other source in the gateway.
 *
 * THE COST, AND THE CACHE
 *
 * That position is only on the detail page, so placing an advert costs one
 * extra request. At ~100 adverts an hourly refresh would be 100 requests. It
 * is not: detail results are cached in KV by object id and an advert's
 * position never changes, so after the first run only genuinely new adverts
 * are fetched — a handful an hour. Fetches are serial, one per second.
 *
 * WHAT IS DELIBERATELY NOT CARRIED
 *
 * The advert page shows a "Kötider i detta område" block, but to a
 * logged-out visitor it renders an unpopulated template: every advert reads
 * "genomsnittlig kötid på 15 år och 100 månader", and 100 months is not a
 * valid remainder. It is not data, so queue time is null here rather than
 * fabricated. Audience is null for the same reason — the public listing
 * exposes no youth/student/senior segmentation.
 */
"use strict";

import { haversine } from "../geo.js";
/* One entity decoder for the whole gateway. It lives in arena.js because that
 * was the first source to need it, and it already knows å/ä/ö — which this
 * page is full of ("Testomr&aring;det"). */
import { decodeEntities } from "./arena.js";

export const SRC = "boplatsvast";
export const SRC_LABEL = "Boplats Väst (kö)";
export const ALLOCATION = "queue";

const HOST = "https://boplats.se";
const LIST_PATH = "/sok?types=1hand";
export const DETAIL_CACHE_KEY = "cache:boplatsvast:detail";

/* How many uncached adverts to resolve in one refresh. The first run places
 * this many and the next run continues; steady-state turnover is far below
 * it. Bounded so one refresh cannot turn into a hundred-request crawl. */
export const MAX_NEW_DETAILS = 50;
const DETAIL_DELAY_MS = 1000;
/* Cache entries for adverts that have gone are dropped after this. */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --- parsing --- */

export const decode = (s) => decodeEntities(String(s ?? ""));

const text = (html) => decode(String(html ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/* "6 437 kr" -> 6437. The thousands separator is a space (sometimes a
 * non-breaking or thin one), never a comma. */
export function parseSek(s) {
  const m = String(s ?? "").match(/([\d\s  ]+)\s*kr/i);
  if (!m) return null;
  const n = Number(m[1].replace(/[\s  ]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/* "37.5 m²" -> 37.5, "45 m²" -> 45. Boplats writes a decimal point here,
 * unlike Willhem's comma, so both forms are accepted. */
export function parseArea(s) {
  const m = String(s ?? "").match(/([\d]+(?:[.,]\d+)?)\s*m²/);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parseRooms(s) {
  const m = String(s ?? "").match(/([\d]+(?:[.,]\d+)?)\s*rum/i);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const MONTHS = ["januari","februari","mars","april","maj","juni","juli","augusti","september","oktober","november","december"];

/* "Sista dagen att söka denna lägenhet är 8 oktober." -> "2026-10-08".
 * The year is not printed. An advert always closes within weeks, so a date
 * that would be far in the past is next year's. */
export function parseApplyBy(s, now = new Date()) {
  const m = String(s ?? "").match(/(\d{1,2})\s+(januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december)/i);
  if (!m) return null;
  const day = Number(m[1]);
  const month = MONTHS.indexOf(m[2].toLowerCase());
  if (month < 0) return null;
  let year = now.getUTCFullYear();
  const candidate = Date.UTC(year, month, day);
  if (candidate < now.getTime() - 180 * 24 * 3600 * 1000) year += 1;
  const d = new Date(Date.UTC(year, month, day));
  return d.toISOString().slice(0, 10);
}

/* One search-result card -> the fields the listing page carries. */
export function parseCards(html) {
  const out = [];
  const cardRe = /<div class="search-result-item[^"]*">([\s\S]*?)<\/a>/g;
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    const card = m[1];
    const id = (card.match(/objekt\/1hand\/([A-Za-z0-9]+)/) || [])[1];
    if (!id) continue;
    const pick = (cls) => {
      const r = new RegExp(`<div class="[^"]*${cls}[^"]*">([\\s\\S]*?)</div>`);
      const hit = card.match(r);
      return hit ? text(hit[1]) : null;
    };
    /* Size and rooms sit in unnamed right-align cells, so they are read off
     * the card's whole text by their unit rather than by class. */
    const whole = text(card);
    out.push({
      id,
      url: `${HOST}/objekt/1hand/${id}`,
      area_name: pick("search-result-area-name"),
      rent_sek_mo: parseSek(pick("search-result-price") ?? whole),
      address: pick("search-result-address"),
      size_m2: parseArea(whole),
      rooms: parseRooms(whole),
      floor: null,
      published_raw: pick("publ-date"),
      image: (card.match(/<img class="wide" src="([^"]+)"/) || [])[1] ?? null,
    });
  }
  return out;
}

/* The advert page -> the bits only it carries. */
export function parseDetail(html, now = new Date()) {
  const lat = Number((html.match(/data-latitude="([^"]+)"/) || [])[1]);
  const lon = Number((html.match(/data-longitude="([^"]+)"/) || [])[1]);
  /* The landlord sits between its own heading and the next one. Phone and
   * e-mail follow the name in the same block and are cut off — the dashboard
   * wants to say who lets the flat, not publish a contact card. */
  const landlordBlock = html.match(
    /<h3 class="object-attribute-heading">\s*Hyresv(?:ä|&auml;)rd\s*<\/h3>([\s\S]*?)(?=<h3 class="object-attribute-heading">|$)/
  );
  const landlord = landlordBlock
    ? (text(landlordBlock[1]).split(/\s+(?=[\d+]{2,}[\d\s-]{5,})|\s+(?=\S+@)/)[0] || "").trim() || null
    : null;
  const plain = text(html);
  return {
    lat: Number.isFinite(lat) && lat !== 0 ? lat : null,
    lon: Number.isFinite(lon) && lon !== 0 ? lon : null,
    landlord,
    /* "Guldheden, Göteborgs Centrum, Göteborg" — the last part is the kommun. */
    kommun: (() => {
      const m = plain.match(/Se karta\s+([^|]{3,80}?)\s+Ans(?:ö|o)k/);
      if (!m) return null;
      const parts = m[1].split(",").map((x) => x.trim()).filter(Boolean);
      return parts.length ? parts[parts.length - 1] : null;
    })(),
    apply_by: parseApplyBy(plain, now),
  };
}

/* --- assembly --- */

export function buildListing(card, detail) {
  const placed = Boolean(detail && Number.isFinite(detail.lat) && Number.isFinite(detail.lon));
  return {
    src: SRC,
    src_label: SRC_LABEL,
    id: card.id,
    url: card.url,
    address: card.address,
    area_name: detail?.kommun && card.area_name && detail.kommun !== card.area_name
      ? `${detail.kommun} - ${card.area_name}`
      : (card.area_name ?? detail?.kommun ?? null),
    lat: placed ? detail.lat : null,
    lon: placed ? detail.lon : null,
    rent_sek_mo: card.rent_sek_mo,
    size_m2: card.size_m2,
    rooms: card.rooms,
    floor: card.floor,
    year_built: null,
    available_from: null,
    published: null,
    image: card.image,
    text_start: null,
    discount: null,
    offer: null,
    is_new_production: null,
    allocation: ALLOCATION,
    /* The public listing carries no youth/student/senior segmentation. */
    audience: null,
    landlord: detail?.landlord ?? null,
    /* Read from the advert page, not guessed from the address. */
    geo_source: "source",
    /* Queue time is shown on the page only as an unpopulated template to a
     * logged-out visitor, so there is nothing honest to publish. */
    queue_name: "Boplats Väst",
    queue_years_q1: null,
    queue_years_q3: null,
    apply_by: detail?.apply_by ?? null,
    _placed: placed,
  };
}

export function buildSnapshot(cards, cache, now = new Date()) {
  const listings = [];
  const unplaced = [];
  for (const card of cards) {
    const l = buildListing(card, cache[card.id]);
    const placed = l._placed;
    delete l._placed;
    if (placed) listings.push(l);
    else unplaced.push({ id: card.id, address: card.address, area_name: card.area_name, url: card.url });
  }
  return {
    src: SRC,
    fetchedAt: now.toISOString(),
    count: listings.length,
    dropped: unplaced.length,
    unplaced: unplaced.length,
    unplaced_examples: unplaced.slice(0, 5),
    listings,
  };
}

export function selectNearby(snapshot, lat, lon, r) {
  const listings = Array.isArray(snapshot?.listings) ? snapshot.listings : [];
  const out = [];
  for (const l of listings) {
    if (!Number.isFinite(l.lat) || !Number.isFinite(l.lon)) continue;
    const d = haversine(lat, lon, l.lat, l.lon);
    if (d > r) continue;
    out.push({ ...l, dist_m: Math.round(d) });
  }
  out.sort((a, b) => a.dist_m - b.dist_m);
  return out;
}

/* --- I/O --- */

async function getText(url, signal) {
  const res = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      /* Identifies the caller and where to complain, as a courtesy to a
       * public service being read once an hour. */
      "user-agent": "am-se-listings/1.0 (+https://github.com/real-estate-war-lord/am-dashboard-se)",
    },
    signal,
  });
  if (!res.ok) throw new Error(`${SRC_LABEL} ${new URL(url).pathname} returned HTTP ${res.status}`);
  return res.text();
}

export async function fetchSnapshot({ signal, env } = {}) {
  const listHtml = await getText(HOST + LIST_PATH, signal);
  const cards = parseCards(listHtml);
  if (!cards.length) throw new Error(`${SRC_LABEL}: no adverts parsed from the listing page`);

  const now = Date.now();
  let cache = {};
  if (env?.LISTINGS_KV) {
    cache = (await env.LISTINGS_KV.get(DETAIL_CACHE_KEY, { type: "json" })) || {};
  }
  /* Forget adverts that have been gone for a month. */
  for (const [id, entry] of Object.entries(cache)) {
    if (!Number.isFinite(entry?.at) || now - entry.at > CACHE_TTL_MS) delete cache[id];
  }

  const missing = cards.filter((c) => !cache[c.id]).slice(0, MAX_NEW_DETAILS);
  let fetched = 0;
  for (const card of missing) {
    if (fetched > 0) await sleep(DETAIL_DELAY_MS);
    try {
      const detail = parseDetail(await getText(card.url, signal));
      cache[card.id] = { ...detail, at: now };
      fetched++;
    } catch {
      /* Leave it uncached so the next run retries; the advert is unplaced
       * until then rather than placed wrongly. */
    }
  }

  if (env?.LISTINGS_KV) await env.LISTINGS_KV.put(DETAIL_CACHE_KEY, JSON.stringify(cache));

  const snap = buildSnapshot(cards, cache);
  snap.detail_fetched = fetched;
  snap.detail_cached = Object.keys(cache).length;
  return snap;
}
