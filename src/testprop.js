/* AM Dashboard — Sweden edition · testprop.js
   Reads a location out of a pasted Google Maps link or a plain "lat, lon" pair.
   Browser only: nothing is fetched and no link is followed, so a short share link
   (maps.app.goo.gl) cannot be resolved here — the reader is asked for the long URL
   rather than the page quietly calling out to Google on their behalf.

   Inlined into dist/index.html by scripts/build_dashboard.py, and required by
   tests/testprop.test.js (`make test-js`), so it stays free of DOM and window.
*/
"use strict";

/* Coarse Sweden box — a first sanity check on the numbers, and what catches a
   swapped lon/lat pair. Sweden is tall: 55.0–69.2 N covers Smygehuk to
   Treriksröset, 10.5–24.3 E the Skagerrak to the Finnish border. The real
   "which area is this" answer comes from locate() in app.js, against our own rings. */
const TP_BOUNDS = { lat: [55.0, 69.2], lon: [10.5, 24.3] };
const TP_SHORT_RE = /\b(?:maps\.app\.goo\.gl|goo\.gl|g\.co\/kgs)\b/i;
const TP_SHORT_MSG = "Short share links can't be read in the browser. Open the link and copy the full URL from the address bar, or right-click the spot in Google Maps and paste the coordinates.";
/* the formats the input accepts, in the order parseLocation tries them — also shown in the "?" tooltip */
const TP_FORMATS = [
  ["place", "…/place/Name/@59.33,18.06,17z/data=…!3d59.33258!4d18.06490", "a Google Maps place URL (the !3d/!4d pin wins over the @ viewport)"],
  ["at", "…/maps/@59.33258,18.06490,17z", "a Google Maps view URL"],
  ["param", "…/maps?q=59.33258,18.06490", "a q= / ll= / query= parameter"],
  ["search", "…/maps/search/59.33258,18.06490", "a Google Maps search URL"],
  ["plain", "59.33258, 18.06490", "plain coordinates — comma, semicolon or space"]];

const tpNum = s => { const v = parseFloat(s); return isNaN(v) ? null : v; };
const TP_D = "(-?\\d{1,3}(?:\\.\\d+)?)";                 /* a signed decimal degree */
const TP_SEP = "\\s*[,;]\\s*";                           /* the separator once "+" and %2C are decoded */

function tpPair(lat, lon, source) {
  if (lat == null || lon == null) return null;
  if (lat < TP_BOUNDS.lat[0] || lat > TP_BOUNDS.lat[1] || lon < TP_BOUNDS.lon[0] || lon > TP_BOUNDS.lon[1])
    return { error: "outside_se", message: `${lat}, ${lon} is outside Sweden (latitude ${TP_BOUNDS.lat[0]}–${TP_BOUNDS.lat[1]} N, longitude ${TP_BOUNDS.lon[0]}–${TP_BOUNDS.lon[1]} E). Latitude comes first — check the order.` };
  return { lat, lon, source };
}

/* text → {lat, lon, source} | {error, message} */
function parseLocation(text) {
  const raw = String(text == null ? "" : text).trim();
  if (!raw) return { error: "empty", message: "Paste a Google Maps link, or coordinates as \"59.33258, 18.06490\"." };
  /* "+" is a space in a query string and %2C a comma — decode once so every pattern below sees plain text */
  let s = raw;
  try { s = decodeURIComponent(raw.replace(/\+/g, " ")); } catch (e) { /* a stray % — read the text as it stands */ }

  if (TP_SHORT_RE.test(s)) return { error: "short_link", message: TP_SHORT_MSG };

  let m;
  /* 1. the place pin (!3d lat !4d lon) — the actual spot, so it wins over the @ viewport centre */
  if ((m = s.match(new RegExp("!3d" + TP_D + "!4d" + TP_D)))) return tpPair(tpNum(m[1]), tpNum(m[2]), "place");
  /* 2. the viewport centre: @lat,lon,17z */
  if ((m = s.match(new RegExp("@" + TP_D + TP_SEP + TP_D)))) return tpPair(tpNum(m[1]), tpNum(m[2]), "at");
  /* 3. a coordinate parameter: q= / ll= / query= / daddr= / center= */
  if ((m = s.match(new RegExp("(?:^|[?&#])(?:q|ll|query|daddr|center)=" + TP_D + TP_SEP + TP_D, "i")))) return tpPair(tpNum(m[1]), tpNum(m[2]), "param");
  /* 4. /search/<lat>,<lon> */
  if ((m = s.match(new RegExp("/search/" + TP_D + TP_SEP + TP_D)))) return tpPair(tpNum(m[1]), tpNum(m[2]), "search");
  /* 5. the coordinates on their own — comma, semicolon or whitespace */
  if ((m = s.match(new RegExp("^" + TP_D + "(?:" + TP_SEP + "|\\s+)" + TP_D + "$")))) return tpPair(tpNum(m[1]), tpNum(m[2]), "plain");

  return { error: "no_match", message: "No coordinates in that text. Paste the full Google Maps URL from the address bar, or right-click the spot in Google Maps and copy the \"59.33258, 18.06490\" pair it offers." };
}

if (typeof module !== "undefined" && module.exports) module.exports = { parseLocation, TP_BOUNDS, TP_FORMATS, TP_SHORT_MSG };
