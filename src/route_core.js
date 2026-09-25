/* Routing — the pure parts, kept out of src/app.js so they can be unit-tested.
   Same arrangement as src/testprop.js and src/listings/view.js: no DOM, no globals, no fetch.
   `make test-js` runs tests/route.test.js against this file.

   Ported from the Danish edition's src/route_core.js (v3.0) with the Swedish level
   vocabulary and the Swedish overlay ids.

   A hash has three spellings:

     old (v1.x, shared in emails and slide decks) … table/kommun · pipeline · market · sources
                                                     analysis?a=59.3,18.0&la=X&b=…&lb=…
                                                     map/0180?srv=1&clim=1 · area/regso/X?t=dist&g=Rents
                                                     listings.html#at=59.3,18.0&r=1000
     new (v2.0, what the app emits) ……………………………… data/areas/kommun · data/projects ·
                                                     data/national · data/sources ·
                                                     property?p=59.3,18.0:X · area/regso/X?show=dist ·
                                                     map/0180?lay=services&ind=flood100
     internal (S.view, unchanged so RENDER and the smoke test keep working) …
                                                     table · pipeline · market · property ·
                                                     area · makro · sheet

   `toV2()` maps old → new and is idempotent, so it can run on every hashchange without ever
   rewriting its own output. `toInternal()` maps either spelling → the view id and the parts the
   router needs. Nothing here decides *when* the rewrite happens — app.js does.

   Test property is ONE pin (the owner amendment), but the codec is list-capable (";") so the
   "paste several Google Maps links" idea needs no second format later. `b=`/`lb=` from the old
   two-pin Analysis sheet are dropped: `a` wins.
*/
"use strict";
/* Wrapped in an IIFE: the build inlines this file and app.js as two classic <script> blocks in one
   global lexical scope, so a top-level const here would collide with app.js and blank the page. */
(function () {

/* The climate indicator a `clim=1` link lands on when it names no climate indicator of its own.
   River flood, 100-year is the layer with the widest kommun coverage. */
const CLIM_FALLBACK_IND = "flood100";
/* Used only when the caller passes no isClim(): the climate keys in the Swedish registry. */
const CLIM_KEYS = ["flood100", "flood200", "floodBHF", "coast20", "coast30",
                   "sea2100_85", "sea2100_45", "landslide", "cloudburst_mapped"];

const LEVELS = ["kommun", "regso", "deso"];
const AREA_TYPES = LEVELS;

/* ---------- hash ⇄ parts ---------- */
/* "#table/kommun?ind=growth&y=2024" → { path, parts, query } — the inverse of buildHash() */
function splitHash(hash) {
  let h = String(hash == null ? "" : hash);
  if (h.charAt(0) === "#") h = h.slice(1);
  const i = h.indexOf("?");
  const path = (i < 0 ? h : h.slice(0, i)).replace(/^\/+|\/+$/g, "");
  const qs = i < 0 ? "" : h.slice(i + 1);
  const query = {};
  qs.split("&").filter(Boolean).forEach(kv => {
    const j = kv.indexOf("=");
    const k = j < 0 ? kv : kv.slice(0, j), v = j < 0 ? "" : kv.slice(j + 1);
    query[dec(k)] = dec(v);
  });
  return { path, parts: path.split("/").filter(Boolean), query };
}
function dec(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
/* `,` `:` `;` and `/` are legal in a fragment and are what makes a coordinate link readable
   ("p=59.31972,18.07194:Home", not "p=59.31972%2C18.07194%3AHome"), so they survive encoding */
function enc(s) { return encodeURIComponent(String(s)).replace(/%2C/g, ",").replace(/%3A/g, ":").replace(/%3B/g, ";").replace(/%2F/g, "/"); }
/* every key whose value is not null/undefined/"" , in insertion order.
   An empty value is dropped: a link is shorter and `?ind=&y=` says nothing. */
function buildHash(path, query) {
  const q = [];
  Object.keys(query || {}).forEach(k => {
    const v = query[k];
    if (v === null || v === undefined || v === "") return;
    q.push(enc(k) + "=" + enc(v));
  });
  const p = String(path || "");
  return q.length ? p + "?" + q.join("&") : p;
}

/* ---------- coordinates ---------- */
/* five decimals is ~1 m — the precision the pin has always been serialised with */
const round5 = n => Number(Number(n).toFixed(5));
/* "59.31972,18.07194" → [59.31972, 18.07194]; anything else → null */
function parseLatLon(s) {
  const m = String(s == null ? "" : s).trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = round5(m[1]), lon = round5(m[2]);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  return [lat, lon];
}
/* the property codec: "lat,lon[:label]", list-capable (";") */
function propSerialise(items) {
  return (items || []).map(p => {
    const ll = `${round5(p.lat)},${round5(p.lon)}`;
    return p.label ? `${ll}:${p.label}` : ll;
  }).join(";");
}
function propParse(s) {
  return String(s == null ? "" : s).split(";").map(part => {
    const i = part.indexOf(":");
    const ll = parseLatLon(i < 0 ? part : part.slice(0, i));
    if (!ll) return null;
    return { lat: ll[0], lon: ll[1], label: i < 0 ? "" : part.slice(i + 1) };
  }).filter(Boolean);
}

/* ---------- old → new ---------- */
/* one row per old path. Each returns the new { path, query }. */
const ALIASES = {
  table:    (parts, q) => ({ path: "data/areas/" + (LEVELS.indexOf(parts[1]) >= 0 ? parts[1] : "kommun"), query: q }),
  pipeline: (parts, q) => ({ path: "data/projects", query: q }),
  /* the Data section itself: `#data` and `#data/areas` are spelled out in full, so a bare link is
     already the canonical link and the tab bar never has to guess which level it is showing */
  data:     (parts, q) => {
    const tab = parts[1] || "areas";
    if (tab === "projects" || tab === "national" || tab === "sources") return { path: "data/" + tab, query: q };
    return { path: "data/areas/" + (LEVELS.indexOf(parts[2]) >= 0 ? parts[2] : "kommun"), query: q };
  },
  /* #sources was already an alias for "market with the sources panel open"; both land on the tab */
  market:   (parts, q) => { const src = q.src === "1"; const r = Object.assign({}, q); delete r.src;
                            return { path: src ? "data/sources" : "data/national", query: r }; },
  sources:  (parts, q) => { const r = Object.assign({}, q); delete r.src; return { path: "data/sources", query: r }; },
  /* the pin leads: a shared property link reads "property?p=59.31972,18.07194:Home" first.
     The old sheet took two pins; one property at a time now, so `b`/`lb` are dropped. */
  analysis: (parts, q) => {
    const ll = parseLatLon(q.a), r = {};
    if (ll) r.p = propSerialise([{ lat: ll[0], lon: ll[1], label: q.la || "" }]);
    Object.keys(q).forEach(k => { if (!"a la b lb p".split(" ").includes(k)) r[k] = q[k]; });
    return { path: "property", query: r };
  },
  /* Compare never shipped in the Swedish edition and is removed from the Danish one, but a link
     could exist: it lands on the first area's own page, or the map. */
  compare:  (parts, q) => {
    const r = Object.assign({}, q); delete r.a; delete r.b;
    const m = String(q.a || "").split(":");
    if (m.length === 2 && AREA_TYPES.indexOf(m[0]) >= 0 && m[1]) return { path: `area/${m[0]}/${m[1]}`, query: r };
    const ll = parseLatLon(q.a);
    if (ll) return { path: "property", query: Object.assign({ p: propSerialise([{ lat: ll[0], lon: ll[1], label: q.la || "" }]) }, r) };
    return { path: "map", query: r };
  },
  /* the standalone Listings page became a section of Test property */
  listings: (parts, q) => ({ path: "property", query: listingsQuery(q) }),
};

/* `map…&clim=1`: the climate overlay became an indicator family. An explicit climate indicator in
   the link wins — the flag only decides what to show when the link names a non-climate one. */
function climateFlag(query, isClim) {
  const q = Object.assign({}, query);
  if (q.clim !== "1") { delete q.clim; return q; }
  delete q.clim;
  const test = typeof isClim === "function" ? isClim : (k => CLIM_KEYS.indexOf(k) >= 0);
  if (!q.ind || !test(q.ind)) q.ind = CLIM_FALLBACK_IND;
  return q;
}

/* The five map overlay buttons became one `Layers ▾` menu, so their five flags became one comma
   list: `srv=1&pub=1&inf=1` → `lay=services,public,infra`. A link that already spells `lay=`
   keeps what it names and the flags only add to it, so this stays idempotent. */
const LAY_FLAGS = [["inf", "infra"], ["pub", "public"], ["srv", "services"],
                   ["sch", "schools"], ["uso", "uso"]];
const LAYERS = ["infra", "public", "services", "schools", "uso", "listings"];
function layerFlags(query) {
  const q = Object.assign({}, query);
  const on = String(q.lay == null ? "" : q.lay).split(",").filter(Boolean);
  let had = false;
  LAY_FLAGS.forEach(([flag, name]) => {
    if (!Object.prototype.hasOwnProperty.call(q, flag)) return;
    had = true;
    if (q[flag] === "1" && on.indexOf(name) < 0) on.push(name);
    delete q[flag];
  });
  if (!had) return q;
  if (on.length) q.lay = on.join(",");
  else delete q.lay;
  return q;
}

/* The area page's lower tab bar and its tile-group segments became <details> sections whose open
   state is one key: `t=ind|dist|sub` named the open tab, `g=<group>` the open tile group of a
   "Key figures" block that no longer exists. `t=` becomes the section it opened, `g=` is dropped.
   A link that already spells `show=` keeps it, so this stays idempotent. */
const AREA_TAB_SHOW = { ind: "figures", dist: "dist", sub: "sub" };
function areaTabs(query) {
  const q = Object.assign({}, query);
  const has = k => Object.prototype.hasOwnProperty.call(q, k);
  if (!has("t") && !has("g")) return q;
  const want = AREA_TAB_SHOW[q.t];
  delete q.t; delete q.g;
  if (want && !q.show) q.show = want;
  return q;
}

/* ---------- the standalone Listings page ---------- */
/* listings.html carried its own hash: `#at=lat,lon&r=1000&g=…&al=…&rm=…&res=1&offer=1&src=…&sort=…`.
   It becomes `#property?p=lat,lon&rad=1000&show=listings` plus the filter keys the section reads.
   Exported so dist/listings.html (a four-line redirect) and the test use the same codec. */
const RADII = [500, 1000, 2000];
function listingsQuery(q) {
  const out = {};
  const ll = parseLatLon(q.at);
  if (ll) out.p = propSerialise([{ lat: ll[0], lon: ll[1], label: "" }]);
  const r = Number(q.r);
  if (RADII.indexOf(r) >= 0) out.rad = String(r);
  out.show = "listings";
  /* the filter keys keep their spelling — the section reads exactly these */
  "g al rm src sort".split(" ").forEach(k => { if (q[k]) out["l" + k] = q[k]; });
  if (q.res === "1") out.lres = "1";
  if (q.offer === "1") out.loffer = "1";
  return out;
}
/* "#at=59.3,18.0&r=1000" → "property?p=59.3,18&rad=1000&show=listings".
   The Listings page's fragment was a bare query string with no path in front of it, so it is
   parsed as one rather than through splitHash, which would read it all as a path. */
function fromListingsHash(hash) {
  let h = String(hash == null ? "" : hash);
  if (h.charAt(0) === "#") h = h.slice(1);
  if (h.charAt(0) === "?") h = h.slice(1);
  const query = {};
  h.split("&").filter(Boolean).forEach(kv => {
    const j = kv.indexOf("=");
    query[dec(j < 0 ? kv : kv.slice(0, j))] = j < 0 ? "" : dec(kv.slice(j + 1));
  });
  return buildHash("property", listingsQuery(query));
}

/* old hash → the canonical v2 hash. Idempotent: toV2(toV2(h)) === toV2(h) for every h. */
function toV2(hash, opts) {
  const o = opts || {};
  const { parts, query } = splitHash(hash);
  const head = parts[0] || "map";
  const fn = Object.prototype.hasOwnProperty.call(ALIASES, head) ? ALIASES[head] : null;
  if (fn) { const r = fn(parts, query); return buildHash(r.path, r.query); }
  if (head === "map") return buildHash(parts.join("/") || "map", layerFlags(climateFlag(query, o.isClim)));
  if (head === "area") return buildHash(parts.join("/"), areaTabs(query));
  return buildHash(parts.join("/") || "map", query);
}

/* ---------- either spelling → the internal view ---------- */
/* Returns { view, parts, query }: `view` is an S.view id, `parts` the path segments the router
   reads, `query` normalised to the keys app.js knows. The property `p=` is handed back parsed as
   `pins`, so parseHash needs no second coordinate branch. */
function toInternal(hash, opts) {
  const v2 = toV2(hash, opts);
  const { parts, query } = splitHash(v2);
  const q = Object.assign({}, query);
  const head = parts[0] || "map";
  if (head === "data") {
    const tab = parts[1] || "areas";
    if (tab === "projects") return { view: "pipeline", parts: ["pipeline"], query: q, tab: "projects" };
    if (tab === "national") return { view: "market", parts: ["market"], query: q, tab: "national" };
    if (tab === "sources") { q.src = "1"; return { view: "market", parts: ["market"], query: q, tab: "sources" }; }
    const lvl = LEVELS.indexOf(parts[2]) >= 0 ? parts[2] : "kommun";
    return { view: "table", parts: ["table", lvl], query: q, tab: "areas" };
  }
  if (head === "property") {
    const pins = propParse(q.p);
    delete q.p;
    return { view: "property", parts: ["property"], query: q, pins };
  }
  if (head === "area") return { view: "area", parts, query: q };
  if (head === "map") return { view: "makro", parts, query: q };
  return { view: head, parts, query: q };
}

const API = { CLIM_FALLBACK_IND, CLIM_KEYS, LEVELS, LAYERS, RADII, ALIASES,
              splitHash, buildHash, parseLatLon, round5, propParse, propSerialise,
              climateFlag, layerFlags, areaTabs, listingsQuery, fromListingsHash,
              toV2, toInternal };
if (typeof window !== "undefined") window.ROUTE_CORE = API;
if (typeof module !== "undefined" && module.exports) module.exports = API;

})();
