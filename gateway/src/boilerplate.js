/* Boilerplate stripped from the head of a listing description.
 *
 * Landlords prepend disclaimers and campaign terms to the ad text, so the
 * first 220 characters — all the dashboard shows — often describe the offer,
 * the photo policy or the viewing procedure rather than the flat. Before this
 * ran, 924 of Victoriahem's 1112 descriptions and 128 of Heimstaden's 490
 * opened with boilerplate; afterwards, 22 and 2.
 *
 * THE RULE FOR ADDING A PATTERN — it must be
 *   (a) a phrase repeated at least 20 times in one portal's snapshot, and
 *   (b) not a description of the flat.
 *
 * (a) alone is not enough. Heimstaden's "Här bor du i en välplanerad och
 * modern tvåa..." repeats 73 times because a whole development shares one
 * text, but it describes the flat and stays. Every pattern below carries the
 * count it actually fired on, measured 2026-09-24 with scripts/…/pat.mjs; a
 * pattern that drops under 20 should be removed rather than left to rot.
 *
 * Campaign text removed here is not lost: it is captured in `offer` first
 * (see offers.js), which is computed on the untouched text.
 *
 * Patterns are anchored at the start and applied repeatedly until none match,
 * because the preamble is a stack: a campaign opener, then its terms, then the
 * rent-year disclaimer, then the "Om lägenheten" label.
 */
"use strict";

export const PATTERNS = [
  /* "Interiörbilderna är exempelbilder på standarden." — a photo disclaimer,
   * the single most common opener in the corpus.            376x victoriahem */
  { name: "interior-disclaimer", re: /^Interi(ö|o)rbilderna (ä|a)r exempelbilder p(å|a) standarden\.?\s*/i },

  /* "Hyran avser 2026 års hyresnivå." — which year's rent table applies. The
   * rent itself is already a field.                          200x victoriahem */
  { name: "rent-year", re: /^Hyran avser \d{4} (å|a)rs hyresniv(å|a)\.?\s*/i },

  /* "Visning Är du intresserad av en visning?" — the viewing-booking block,
   * identical on every ad that has it.                        94x victoriahem */
  { name: "viewing-block", re: /^Visning\s*(Ä|A)r du intresserad av en visning\?\s*/i },

  /* Campaign openers. The label and its first sentence are one unit. */
  /* "Kampanj Teckna ett hyresavtal med oss och flytta in senast …" 82x vh */
  { name: "kampanj-teckna", re: /^Kampanj\s+Teckna ett hyresavtal[^.!?]*[.!?]\s*/i },
  /* "Kampanj Erbjudande just nu!"                              44x victoriahem */
  { name: "kampanj-erbjudande", re: /^Kampanj\s+Erbjudande just nu!\s*/i },
  /* A bare "Kampanj" label in front of some other campaign sentence. Only the
   * label is removed; the sentence is left to the tails below.  22x victoriahem */
  { name: "kampanj-generic", re: /^Kampanj\s+(?=[A-ZÅÄÖ])/ },
  /* "Hyresrabatt För dig som är ny kund erbjuder vi just nu …"  129x vh */
  { name: "hyresrabatt-ny-kund", re: /^Hyresrabatt\s+F(ö|o)r dig som (ä|a)r ny kund[^.!?]*[.!?]\s*/i },
  /* "Hyresrabatt Just nu bjuder vi på en del av månadshyran …"   31x vh */
  { name: "hyresrabatt-just-nu", re: /^Hyresrabatt\s+Just nu bjuder vi[^.!?]*[.!?]\s*/i },

  /* Campaign tails — the sentences that follow an opener and only ever appear
   * as part of one. They become head-anchored once the opener is removed. */
  /* "Därefter gäller ordinarie hyra vilket i dagsläget är 9 567 kr/månad." 135x */
  { name: "thereafter-ordinary", re: /^D(ä|a)refter g(ä|a)ller ordinarie hyra[^.!?]*[.!?]\s*/i },
  /* "Ordinarie månadshyra är 11 639 kr."                        92x victoriahem */
  { name: "ordinary-rent-is", re: /^Ordinarie m(å|a)nadshyra (ä|a)r [\d\s  ]+kr\.?\s*/i },
  /* "Erbjudandet gäller på utvalda lägenheter …"                125x victoriahem */
  { name: "offer-applies", re: /^Erbjudandet g(ä|a)ller[^.!?]*[.!?]\s*/i },
  /* "Dessutom bjuder vi på en del av hyran under de första …"   106x victoriahem */
  { name: "also-discount", re: /^Dessutom bjuder vi[^.!?]*[.!?]\s*/i },
  /* "Om du tecknar ett hyresavtal med oss i september får du …"  44x victoriahem */
  { name: "sign-get-giftcard", re: /^Om du tecknar ett hyresavtal[^.!?]*[.!?]\s*/i },
  /* "Presentkortet är från Handla för Eskilstuna och kan …"      44x victoriahem */
  { name: "giftcard-from", re: /^Presentkortet (ä|a)r fr(å|a)n[^.!?]*[.!?]\s*/i },

  /* One development's shared marketing opener, on every flat in it. The text
   * that follows it does describe the individual flat.         126x heimstaden */
  { name: "rabylund", re: /^Nu har du chansen att s(ö|o)ka bostad i den sista etappen[^.!?]*[.!?]\s*/i },

  /* The bare "Om lägenheten" section heading once it is at the head. It is a
   * label, not prose, and reads as noise in a popup.           700x victoriahem */
  { name: "om-lagenheten-label", re: /^Om l(ä|a)genheten\s+(?=[A-ZÅÄÖ])/ },
];

/* Guard against a pattern that could match the empty string looping forever. */
const MAX_ROUNDS = 40;

/* Strip leading boilerplate. Returns the trimmed text and which patterns
 * fired, so the effect stays measurable. */
export function stripBoilerplate(text) {
  if (typeof text !== "string") return { text: "", fired: [] };
  let s = text;
  const fired = [];
  for (let round = 0, again = true; again && round < MAX_ROUNDS; round++) {
    again = false;
    for (const { name, re } of PATTERNS) {
      if (!re.test(s)) continue;
      const next = s.replace(re, "");
      if (next === s) continue;
      s = next;
      fired.push(name);
      again = true;
    }
  }
  return { text: s.trim(), fired };
}
