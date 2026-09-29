/* Ring geometry — the codec, kept out of src/app.js so it can be unit-tested.
   Same arrangement as src/route_core.js and src/search_core.js: no DOM, no
   globals, no fetch. `make test-js` runs tests/geo.test.js against this file.

   v2.1 P4 moved every polygon out of the JSON-array-of-pairs shape and into one
   short string per ring. A ring of 300 points was 300 × `[59.51204,17.94366],`
   ≈ 6 kB; delta-encoded against the previous point at the same 5-decimal
   precision it is ≈ 1.6 kB. Across the three levels that is 8.9 MB → 2.0 MB,
   which is most of what took dist/index.html from 17 MB to under 5.

   The encoding is Google's polyline algorithm with one change: the alphabet.
   Polyline offsets each 5-bit group by 0x3F, which puts `\` (0x5C) inside the
   range — JSON then escapes it as `\\` and the saving is spent on escapes. The
   64 characters below are the base64url set: none of them is escaped by JSON,
   by HTML or by a URL, and every one is a single byte in UTF-8.

   ---------------------------------------------------------------------------
   COORDINATE ORDER — read this before touching anything here.

   A ring is [[lat, lon], …] going in and [[lat, lon], …] coming out. This file
   NEVER swaps. The swap happens exactly once in the whole pipeline, in
   build_makro.py's rings_of(), which turns GeoJSON's [lon, lat] into the
   [lat, lon] Leaflet wants. CLAUDE.md records what happened the last time a
   second swap crept in (every sub-municipal polygon off the Somali coast), and
   decodeRings() is deliberately idempotent — handed an array of already-decoded
   rings it returns them unchanged — so calling it twice cannot corrupt them.
   ---------------------------------------------------------------------------
*/
"use strict";
/* Wrapped in an IIFE: the build inlines this file and app.js as classic <script>
   blocks in one global lexical scope, so a top-level const here would collide
   with app.js and blank the page. */
(function () {

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const IDX = {};
for (let i = 0; i < 64; i++) IDX[ALPHA.charAt(i)] = i;
/* 1e5 is ~1.1 m, and it is exactly the precision build_makro.py rounds the
   rings to before encoding — so the round trip is lossless, not merely close. */
const SCALE = 100000;

/* one signed integer, zig-zagged and written 5 bits at a time, low group first */
function encNum(v) {
  let x = v < 0 ? ~(v << 1) : (v << 1);
  let s = "";
  while (x >= 0x20) { s += ALPHA.charAt(0x20 | (x & 0x1f)); x >>= 5; }
  return s + ALPHA.charAt(x);
}

/* [[lat, lon], …] → one string. Deltas against the previous point, so a dense
   coastline costs 2–5 characters per point instead of ~21. */
function encodeRing(ring) {
  let la = 0, lo = 0, s = "";
  for (let i = 0; i < (ring || []).length; i++) {
    const a = Math.round(ring[i][0] * SCALE), b = Math.round(ring[i][1] * SCALE);
    s += encNum(a - la) + encNum(b - lo);
    la = a; lo = b;
  }
  return s;
}

/* the inverse. An unknown character ends the ring rather than producing NaN
   points: a truncated file should draw nothing, never a polygon through [0, 0]. */
function decodeRing(s) {
  const str = String(s == null ? "" : s);
  const out = [];
  let i = 0, la = 0, lo = 0;
  while (i < str.length) {
    let d = [0, 0], bad = false;
    for (let k = 0; k < 2; k++) {
      let res = 0, shift = 0, c;
      do {
        c = IDX[str.charAt(i++)];
        if (c === undefined) { bad = true; break; }
        res |= (c & 0x1f) << shift;
        shift += 5;
      } while (c >= 0x20);
      if (bad) break;
      d[k] = (res & 1) ? ~(res >> 1) : (res >> 1);
    }
    if (bad) break;
    la += d[0]; lo += d[1];
    out.push([la / SCALE, lo / SCALE]);
  }
  return out;
}

const encodeRings = rings => (rings || []).map(encodeRing);
/* Idempotent on purpose — see the coordinate-order note at the top. */
const decodeRings = rings => (rings || []).map(r => (typeof r === "string" ? decodeRing(r) : r));

/* Decode in place, once. `o.enc` is the flag the build writes; an entity that
   has already been decoded is left alone however many times this is called. */
function decodeEntity(o) {
  if (!o || !o.rings) return o;
  if (o.rings.length && typeof o.rings[0] === "string") o.rings = decodeRings(o.rings);
  return o;
}

const API = { ALPHA, SCALE, encNum, encodeRing, decodeRing, encodeRings, decodeRings, decodeEntity };
if (typeof window !== "undefined") window.GEO_CORE = API;
if (typeof module !== "undefined" && module.exports) module.exports = API;

})();
