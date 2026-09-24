/* Rent campaigns.
 *
 * A discount is the thing a reader most wants to spot, and it is also the
 * thing that crowds the description out of a 220-character excerpt. So it is
 * lifted into a field of its own: `offer`, detected on the description
 * *before* boilerplate stripping, so removing the campaign text from
 * `text_start` does not lose the fact that there is a campaign.
 *
 *   offer: null                              no campaign found
 *   offer: {flag: true, snippet: "..."}      the sentence that mentions it
 *
 * The snippet is the source's own words, capped at 140 characters. Nothing is
 * computed from it — no amount is parsed out of Swedish prose and presented
 * as a number, because "2000 kronor i månaden under de första två åren" and
 * "en del av månadshyran" are not the same kind of claim and a parser that
 * flattened both into a figure would be inventing precision.
 */
"use strict";

export const SNIPPET_CHARS = 140;

/* Kampanj / Hyresrabatt / rabatt / "första månaden" / hyresfri.
 * `rabatt` on its own also covers hyresrabatt and rabatterad. */
export const OFFER_KEYWORDS = /(kampanj|rabatt|f(ö|o)rsta m(å|a)naden|hyresfri)/i;

/* Sentence containing the first keyword hit, capped. */
export function offerFromText(text) {
  if (typeof text !== "string" || !text) return null;
  const hit = text.match(OFFER_KEYWORDS);
  if (!hit) return null;

  /* Walk out from the match to the surrounding sentence rather than splitting
   * the whole text: Swedish abbreviations ("bl.a.", "ca.") make a general
   * sentence splitter unreliable, and here only one sentence is needed. */
  const at = hit.index;
  let start = 0;
  for (const m of text.slice(0, at).matchAll(/[.!?]\s+/g)) start = m.index + m[0].length;
  const endMatch = text.slice(at).match(/[.!?](\s|$)/);
  const end = endMatch ? at + endMatch.index + 1 : text.length;

  const snippet = text.slice(start, end).trim().replace(/\s+/g, " ");
  if (!snippet) return null;
  return { flag: true, snippet: snippet.slice(0, SNIPPET_CHARS).trim() };
}

/* HomeQ ships a structured discount instead of prose:
 *   {enabled, discount_type, duration, amount_type, amount}
 * `enabled` is genuinely false on some records, and a disabled campaign is
 * not an offer. The snippet is composed rather than quoted, in Swedish to
 * match the portals' own wording. */
export function offerFromDiscount(discount) {
  if (!discount || typeof discount !== "object") return null;
  if (discount.enabled === false) return null;

  const months = Number.isFinite(discount.duration) && discount.duration > 0
    ? `${discount.duration} ${discount.duration === 1 ? "månad" : "månader"}`
    : null;

  let snippet;
  if (discount.discount_type === "free_months") {
    snippet = months ? `${months} hyresfritt` : "Hyresfria månader";
  } else if (discount.amount_type === "percentage" && Number.isFinite(discount.amount)) {
    snippet = `${discount.amount} % rabatt på hyran${months ? ` i ${months}` : ""}`;
  } else if (Number.isFinite(discount.amount) && discount.amount > 0) {
    /* Thin space as the thousands separator, as Swedish writes it. */
    const kr = String(discount.amount).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    snippet = `${kr} kr rabatt per månad${months ? ` i ${months}` : ""}`;
  } else {
    snippet = "Kampanj";
  }
  return { flag: true, snippet: snippet.slice(0, SNIPPET_CHARS) };
}
