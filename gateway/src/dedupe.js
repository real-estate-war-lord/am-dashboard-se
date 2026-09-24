/* Cross-source deduplication.
 *
 * The same flat is often advertised both by its landlord's own portal and on
 * HomeQ, and showing it twice makes a neighbourhood look busier than it is.
 *
 * The portal record wins. It comes straight from the landlord's letting
 * system, carries floor, year built and area name that HomeQ does not, and
 * links to the page where you actually apply. The HomeQ duplicate is dropped
 * and recorded on the survivor as `also_on` / `also_on_urls`, so the UI can
 * still say "also on HomeQ" and link there.
 *
 * The matching rule is deliberately strict — street and number and room count
 * must agree exactly, and size and rent within a tolerance. A missed merge
 * shows one flat twice, which is untidy; a false merge hides a real, different
 * flat and misstates the rent of the one it kept. So anything uncertain (a
 * null on either side, a fractional room count against a whole one) is treated
 * as "not the same flat".
 */
"use strict";

export const SIZE_TOLERANCE_M2 = 1;
export const RENT_TOLERANCE = 0.01; // 1 %

/* "Björkrisvägen 10 J" -> "björkrisvägen|10j"
 * "Rademachergatan 37B" -> "rademachergatan|37b"
 *
 * HomeQ writes the entrance letter both ways ("37 B" and "37B" both occur in
 * one response), so the space is removed rather than trusted. Swedish å/ä/ö
 * are kept — they are distinct letters, not accents to be folded away — but
 * the string is normalised to NFC so a decomposed "a + ring" from one source
 * matches a precomposed "å" from the other.
 */
export function addressKey(address) {
  if (typeof address !== "string") return null;
  const s = address.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
  const m = s.match(/^(.*?[^\d\s])\s*(\d+)\s*([a-zåäöü])?(?![\wåäöü])/);
  if (!m) return null;
  const street = m[1].replace(/[.,]/g, "").trim();
  if (!street) return null;
  return `${street}|${m[2]}${m[3] || ""}`;
}

const near = (a, b, tol) =>
  Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

/* Are these two listings the same flat? */
export function isSameFlat(a, b) {
  const ka = addressKey(a.address);
  if (!ka || ka !== addressKey(b.address)) return false;
  if (!Number.isFinite(a.rooms) || a.rooms !== b.rooms) return false;
  if (!near(a.size_m2, b.size_m2, SIZE_TOLERANCE_M2)) return false;
  if (!Number.isFinite(a.rent_sek_mo) || !Number.isFinite(b.rent_sek_mo)) return false;
  /* The 1 % is taken against the *smaller* rent, which is the stricter of the
   * two readings: 10 000 and 10 100 match, 10 000 and 10 101 do not. Erring
   * tight is deliberate — see the note at the top of the file. */
  return near(a.rent_sek_mo, b.rent_sek_mo, RENT_TOLERANCE * Math.min(a.rent_sek_mo, b.rent_sek_mo));
}

/* Merge portal listings with HomeQ listings.
 *
 * Returns {listings, merged}. `listings` keeps every portal record plus the
 * HomeQ records that matched nothing; `merged` is how many HomeQ records were
 * folded away, which the response reports so the count is explainable.
 */
export function dedupe(portalListings, homeqListings) {
  /* Bucket the portal side by address so this is not quadratic over the whole
   * radius: only listings at the same street number are ever compared. */
  const buckets = new Map();
  for (const p of portalListings) {
    const k = addressKey(p.address);
    if (!k) continue;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(p);
  }

  const kept = [];
  let merged = 0;
  for (const h of homeqListings) {
    const k = addressKey(h.address);
    const match = k && buckets.has(k) ? buckets.get(k).find((p) => isSameFlat(p, h)) : undefined;
    if (!match) { kept.push(h); continue; }
    merged++;
    match.also_on = [...new Set([...(match.also_on || []), h.src])];
    match.also_on_urls = { ...(match.also_on_urls || {}), [h.src]: h.url };
  }

  const listings = [...portalListings, ...kept].sort((a, b) => a.dist_m - b.dist_m);
  return { listings, merged };
}
