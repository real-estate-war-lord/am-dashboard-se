/* AM Dashboard — Sweden edition · listings/parse.js
   Reads a location out of a pasted Google Maps link or a plain "lat, lon" pair.

   This is a deliberate twin of src/testprop.js on the v1.2-parity branch: the
   same bounds, the same patterns in the same order, the same return shape and
   the same messages. It exists separately only because that file is not on
   this branch yet. **When the branches merge, delete this file and point
   listings.js at testprop.js** — the API is identical, so it is a one-line
   change. See "Merging into the dashboard" in docs/LISTINGS.md.

   Browser only: nothing is fetched and no link is followed, so a short share
   link (maps.app.goo.gl) cannot be resolved here — the reader is asked for the
   long URL rather than the page quietly calling out to Google on their behalf.
*/
"use strict";

/* Coarse Sweden box — a first sanity check on the numbers, and what catches a
   swapped lon/lat pair. Sweden is tall: 55.0–69.2 N covers Smygehuk to
   Treriksröset, 10.5–24.3 E the Skagerrak to the Finnish border. */
const LP_BOUNDS = { lat: [55.0, 69.2], lon: [10.5, 24.3] };
const LP_SHORT_RE = /\b(?:maps\.app\.goo\.gl|goo\.gl|g\.co\/kgs)\b/i;
const LP_SHORT_MSG = "Short share links can't be read in the browser. Open the link and copy the full URL from the address bar, or right-click the spot in Google Maps and paste the coordinates.";

const LP_FORMATS = [
  ["place", "…/place/Name/@59.33,18.06,17z/data=…!3d59.33258!4d18.06490", "a Google Maps place URL (the !3d/!4d pin wins over the @ viewport)"],
  ["at", "…/maps/@59.33258,18.06490,17z", "a Google Maps view URL"],
  ["param", "…/maps?q=59.33258,18.06490", "a q= / ll= / query= parameter"],
  ["search", "…/maps/search/59.33258,18.06490", "a Google Maps search URL"],
  ["plain", "59.33258, 18.06490", "plain coordinates — comma, semicolon or space"]];

const lpNum = (s) => { const v = parseFloat(s); return isNaN(v) ? null : v; };
const LP_D = "(-?\\d{1,3}(?:\\.\\d+)?)";
const LP_SEP = "\\s*[,;]\\s*";

function lpPair(lat, lon, source) {
  if (lat == null || lon == null) return null;
  if (lat < LP_BOUNDS.lat[0] || lat > LP_BOUNDS.lat[1] || lon < LP_BOUNDS.lon[0] || lon > LP_BOUNDS.lon[1])
    return { error: "outside_se", message: `${lat}, ${lon} is outside Sweden (latitude ${LP_BOUNDS.lat[0]}–${LP_BOUNDS.lat[1]} N, longitude ${LP_BOUNDS.lon[0]}–${LP_BOUNDS.lon[1]} E). Latitude comes first — check the order.` };
  return { lat, lon, source };
}

/* text → {lat, lon, source} | {error, message} */
function parseLocation(text) {
  const raw = String(text == null ? "" : text).trim();
  if (!raw) return { error: "empty", message: "Paste a Google Maps link, or coordinates as \"59.33258, 18.06490\"." };
  let s = raw;
  try { s = decodeURIComponent(raw.replace(/\+/g, " ")); } catch (e) { /* a stray % — read the text as it stands */ }

  if (LP_SHORT_RE.test(s)) return { error: "short_link", message: LP_SHORT_MSG };

  let m;
  /* 1. the place pin (!3d lat !4d lon) — the actual spot, so it wins over the @ viewport centre */
  if ((m = s.match(new RegExp("!3d" + LP_D + "!4d" + LP_D)))) return lpPair(lpNum(m[1]), lpNum(m[2]), "place");
  /* 2. the viewport centre: @lat,lon,17z */
  if ((m = s.match(new RegExp("@" + LP_D + LP_SEP + LP_D)))) return lpPair(lpNum(m[1]), lpNum(m[2]), "at");
  /* 3. a coordinate parameter: q= / ll= / query= / daddr= / center= */
  if ((m = s.match(new RegExp("(?:^|[?&#])(?:q|ll|query|daddr|center)=" + LP_D + LP_SEP + LP_D, "i")))) return lpPair(lpNum(m[1]), lpNum(m[2]), "param");
  /* 4. /search/<lat>,<lon> */
  if ((m = s.match(new RegExp("/search/" + LP_D + LP_SEP + LP_D)))) return lpPair(lpNum(m[1]), lpNum(m[2]), "search");
  /* 5. the coordinates on their own — comma, semicolon or whitespace */
  if ((m = s.match(new RegExp("^" + LP_D + "(?:" + LP_SEP + "|\\s+)" + LP_D + "$")))) return lpPair(lpNum(m[1]), lpNum(m[2]), "plain");

  return { error: "no_match", message: "No coordinates in that text. Paste the full Google Maps URL from the address bar, or right-click the spot in Google Maps and copy the \"59.33258, 18.06490\" pair it offers." };
}

/* A classic script's top-level `const` is script-scoped, not a window
   property, so the page's globals are attached explicitly. */
if (typeof module !== "undefined" && module.exports) module.exports = { parseLocation, LP_BOUNDS, LP_FORMATS, LP_SHORT_MSG };
if (typeof window !== "undefined") { window.parseLocation = parseLocation; window.LP_BOUNDS = LP_BOUNDS; }
