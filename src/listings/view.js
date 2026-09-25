/* AM Dashboard — Sweden edition · listings/view.js
   The decisions the Listings page makes about a set of listings: which group a
   source belongs to, which listings survive the filters, and the advertised
   SEK/m²/yr medians.

   Kept free of DOM and window so tests/listings.test.js can drive it directly;
   listings.js does the rendering.
*/
"use strict";
/* Wrapped in an IIFE because v2.0 inlines this file into dist/index.html as a
   classic <script> beside app.js, in one global lexical scope: a top-level
   `const median` here and a top-level `const median` there is a SyntaxError that
   blanks the page. Nothing but window.LISTINGS_VIEW (and module.exports, for
   node --test) escapes.
*/
(function () {

/* The three groups a reader actually distinguishes. Queue supply is the one
   that changes how a listing should be read, so it is decided by `allocation`
   rather than by a list of source names — a new queue source joins the right
   group without touching this file. */
const GROUPS = [
  { key: "homeq", label: "HomeQ", color: "#B07A1E" },
  { key: "portal", label: "Landlord portals", color: "#1C6B5C" },
  { key: "queue", label: "Municipal queues", color: "#5C5F52" },
];

function groupOf(listing) {
  if (listing && listing.allocation === "queue") return "queue";
  if (listing && listing.src === "homeq") return "homeq";
  return "portal";
}

/* Reserved-audience listings are real supply, but most readers cannot apply
   for them, so they are out of the default view and counted separately rather
   than dropped. */
const RESERVED = ["student", "youth", "senior", "short_term"];
const AUDIENCE_LABEL = { student: "Student", youth: "Ungdom", senior: "Senior", short_term: "Korttid" };

/* "2,5 rum & kök" is a two-room flat plus a half room, so a half always
   belongs to the whole number below it: 1.5 -> 1, 2.5 -> 2. Rounding halves up
   in one place and down in another is how a flat ends up in two different
   buckets depending on which way it was written. Size is normalised out of the
   median anyway, since it is per square metre. */
const roomBucket = (rooms) => {
  if (!Number.isFinite(rooms) || rooms < 1) return null;
  const whole = Math.floor(rooms);
  return whole >= 4 ? "4+" : String(whole);
};

const DEFAULT_FILTERS = {
  groups: ["homeq", "portal", "queue"],
  sources: null,          /* null = every source in the active groups */
  allocation: ["direct", "queue"],
  showReserved: false,
  offerOnly: false,
  rooms: [],              /* [] = any */
};

/* Everything the filters let through, in the order the gateway returned them
   (nearest first). */
function applyFilters(listings, f) {
  const filters = { ...DEFAULT_FILTERS, ...(f || {}) };
  return (listings || []).filter((l) => {
    if (!filters.groups.includes(groupOf(l))) return false;
    if (filters.sources && !filters.sources.includes(l.src)) return false;
    if (!filters.allocation.includes(l.allocation === "queue" ? "queue" : "direct")) return false;
    if (!filters.showReserved && l.audience && RESERVED.includes(l.audience)) return false;
    if (filters.offerOnly && !(l.offer && l.offer.flag)) return false;
    if (filters.rooms.length) {
      const b = roomBucket(l.rooms);
      if (!b || !filters.rooms.includes(b)) return false;
    }
    return true;
  });
}

/* How many listings each filter is currently holding back, so the page can say
   "12 hidden" instead of quietly showing fewer. */
function hiddenCounts(listings, f) {
  const filters = { ...DEFAULT_FILTERS, ...(f || {}) };
  const shown = new Set(applyFilters(listings, filters));
  const out = { reserved: 0, total: 0 };
  for (const l of listings || []) {
    if (shown.has(l)) continue;
    out.total++;
    if (!filters.showReserved && l.audience && RESERVED.includes(l.audience)) out.reserved++;
  }
  return out;
}

/* Asking rent per square metre per year — the figure Swedish rents are quoted
   in. Null unless both parts are present; never inferred from one of them. */
function sekPerM2Year(listing) {
  const rent = listing && listing.rent_sek_mo;
  const size = listing && listing.size_m2;
  if (!Number.isFinite(rent) || !Number.isFinite(size) || size <= 0) return null;
  return (rent * 12) / size;
}

function median(values) {
  const v = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/* Medians by room count, and ONLY where at least MIN_N listings back the
   figure. A median of two adverts is not a market rate, and printing it with
   the same weight as a median of forty is the mistake this guards against. */
const MIN_N = 3;

function mediansByRooms(listings, minN = MIN_N) {
  const buckets = new Map();
  for (const l of listings || []) {
    const b = roomBucket(l.rooms);
    const v = sekPerM2Year(l);
    if (!b || v == null) continue;
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(v);
  }
  const order = ["1", "2", "3", "4+"];
  return order
    .filter((b) => buckets.has(b))
    .map((b) => {
      const vals = buckets.get(b);
      return {
        rooms: b,
        n: vals.length,
        /* Below the threshold the count is still shown — the reader learns
           there is supply, just not a number to trust. */
        median: vals.length >= minN ? median(vals) : null,
        suppressed: vals.length < minN,
      };
    });
}

/* Listings sharing a coordinate, so the map can fan them out instead of
   stacking one marker on top of another and hiding the rest. */
function clusterByPoint(listings) {
  const map = new Map();
  for (const l of listings || []) {
    if (!Number.isFinite(l.lat) || !Number.isFinite(l.lon)) continue;
    const key = `${l.lat.toFixed(6)},${l.lon.toFixed(6)}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(l);
  }
  return [...map.values()];
}

/* A ring of offsets for a shared point. Metres converted to degrees at this
   latitude, so the fan looks circular rather than an ellipse. */
function spiderOffsets(n, lat, radiusM = 12) {
  if (n <= 1) return [[0, 0]];
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n - Math.PI / 2;
    return [dLat * Math.sin(a), dLon * Math.cos(a)];
  });
}

const SORTERS = {
  dist: (a, b) => (a.dist_m ?? Infinity) - (b.dist_m ?? Infinity),
  rent: (a, b) => (a.rent_sek_mo ?? Infinity) - (b.rent_sek_mo ?? Infinity),
  size: (a, b) => (b.size_m2 ?? -Infinity) - (a.size_m2 ?? -Infinity),
  rooms: (a, b) => (b.rooms ?? -Infinity) - (a.rooms ?? -Infinity),
  m2yr: (a, b) => (sekPerM2Year(a) ?? Infinity) - (sekPerM2Year(b) ?? Infinity),
  src: (a, b) => String(a.src_label || "").localeCompare(String(b.src_label || ""), "sv"),
};

function sortListings(listings, key, desc) {
  const cmp = SORTERS[key] || SORTERS.dist;
  const out = (listings || []).slice().sort(cmp);
  return desc ? out.reverse() : out;
}

/* How old a snapshot is, in words. Live sources have no snapshot and say so. */
function snapshotAge(fetchedAt, now = Date.now()) {
  if (!fetchedAt) return null;
  const t = Date.parse(fetchedAt);
  if (!Number.isFinite(t)) return null;
  const mins = Math.max(0, Math.round((now - t) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/* One row per source for the status strip, in a stable order: the live source
   first, then snapshots by size. A source with an error keeps its place and
   shows the error — it never disappears into a zero. */
function sourceChips(body, now = Date.now()) {
  const sources = (body && body.sources) || [];
  return sources.map((s) => ({
    src: s.src,
    count: s.count ?? 0,
    ok: s.ok !== false,
    stale: s.ok === false && /stale/i.test(s.error || ""),
    error: s.ok === false ? (s.error || "failed") : null,
    age: snapshotAge(s.fetchedAt, now),
    live: !s.fetchedAt && s.ok !== false,
  }));
}

const CSV_COLUMNS = [
  "source", "source_label", "allocation", "audience", "address", "area_name",
  "landlord", "rooms", "size_m2", "rent_sek_mo", "sek_per_m2_year", "floor",
  "available_from", "dist_m", "offer", "queue_years_q1", "queue_years_q3",
  "geo_source", "lat", "lon", "url", "fetched_at",
];

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* Semicolon-separated: Excel in a Swedish locale reads a comma as a decimal
   point and would otherwise split the numbers across columns. */
function toCsv(listings, fetchedAt) {
  const rows = [CSV_COLUMNS.join(";")];
  for (const l of listings || []) {
    const m2 = sekPerM2Year(l);
    rows.push([
      l.src, l.src_label, l.allocation, l.audience, l.address, l.area_name,
      l.landlord, l.rooms, l.size_m2, l.rent_sek_mo,
      m2 == null ? null : m2.toFixed(1), l.floor,
      l.available_from, l.dist_m, l.offer && l.offer.snippet,
      l.queue_years_q1, l.queue_years_q3, l.geo_source, l.lat, l.lon, l.url,
      fetchedAt,
    ].map(csvCell).join(";"));
  }
  return rows.join("\n");
}

const LISTINGS_VIEW = {
  GROUPS, groupOf, RESERVED, AUDIENCE_LABEL, roomBucket, DEFAULT_FILTERS,
  applyFilters, hiddenCounts, sekPerM2Year, median, mediansByRooms, MIN_N,
  clusterByPoint, spiderOffsets, sortListings, snapshotAge, sourceChips,
  toCsv, CSV_COLUMNS,
};

/* Same reason as parse.js: attach explicitly rather than rely on scoping. */
if (typeof module !== "undefined" && module.exports) module.exports = LISTINGS_VIEW;
if (typeof window !== "undefined") window.LISTINGS_VIEW = LISTINGS_VIEW;

})();
