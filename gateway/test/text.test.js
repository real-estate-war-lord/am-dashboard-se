/* Boilerplate stripping and the offer flag.
 *
 * The Swedish strings below are the shapes observed in the live corpora,
 * rewritten with invented figures and places — they are pattern samples, not
 * copied listings.
 */
"use strict";

import test from "node:test";
import assert from "node:assert/strict";
import { stripBoilerplate, PATTERNS } from "../src/boilerplate.js";
import { offerFromText, offerFromDiscount, OFFER_KEYWORDS, SNIPPET_CHARS } from "../src/offers.js";

/* --- boilerplate --- */

test("every pattern is anchored at the start and named", () => {
  /* An unanchored pattern would cut text out of the middle of a description. */
  const seen = new Set();
  for (const { name, re } of PATTERNS) {
    assert.ok(name, "each pattern needs a name");
    assert.ok(!seen.has(name), `duplicate pattern name ${name}`);
    seen.add(name);
    assert.ok(re.source.startsWith("^"), `${name} is not anchored at the start`);
    assert.ok(!re.global, `${name} must not be a global regex`);
  }
});

test("no pattern matches the empty string", () => {
  /* One that did would spin the strip loop until its guard. */
  for (const { name, re } of PATTERNS) {
    assert.equal(re.test(""), false, `${name} matches the empty string`);
  }
});

test("the photo disclaimer is removed", () => {
  const { text } = stripBoilerplate("Interiörbilderna är exempelbilder på standarden. Ljus trea med balkong.");
  assert.equal(text, "Ljus trea med balkong.");
});

test("a stack of preamble is peeled off in one pass", () => {
  /* This is how the live texts are built: campaign, its terms, the rent-year
   * disclaimer, then the section label, then finally the description. */
  const input = "Hyresrabatt För dig som är ny kund erbjuder vi just nu en hyresrabatt på 2000 kronor i månaden under de första två åren. "
    + "Därefter gäller ordinarie hyra vilket i dagsläget är 9 567 kr/månad. "
    + "Hyran avser 2026 års hyresnivå. "
    + "Om lägenheten Välkommen till denna rymliga tvåa med balkong.";
  const { text, fired } = stripBoilerplate(input);
  assert.equal(text, "Välkommen till denna rymliga tvåa med balkong.");
  assert.ok(fired.includes("hyresrabatt-ny-kund"));
  assert.ok(fired.includes("thereafter-ordinary"));
  assert.ok(fired.includes("rent-year"));
  assert.ok(fired.includes("om-lagenheten-label"));
});

test("boilerplate is only removed from the head, never the middle", () => {
  /* The disclaimer here belongs to a sentence about the flat; cutting it out
   * mid-text would leave a mangled description. */
  const input = "Ljus trea med balkong. Interiörbilderna är exempelbilder på standarden.";
  assert.equal(stripBoilerplate(input).text, input);
});

test("a description that is only boilerplate ends up empty", () => {
  const { text } = stripBoilerplate("Interiörbilderna är exempelbilder på standarden. Hyran avser 2026 års hyresnivå.");
  assert.equal(text, "");
});

test("an ordinary description is untouched", () => {
  const input = "Välkommen till en ljus tvåa i centrala Lund med inglasad balkong i söderläge.";
  const { text, fired } = stripBoilerplate(input);
  assert.equal(text, input);
  assert.deepEqual(fired, []);
});

test("repeated descriptive copy is NOT boilerplate", () => {
  /* Heimstaden's development texts repeat 73 times but describe the flat, so
   * the rule (repeated AND non-descriptive) keeps them. */
  const input = "Här bor du i en välplanerad och modern tvåa med omsorgsfullt utvalda material.";
  assert.equal(stripBoilerplate(input).text, input);
});

test("the year in the rent-year disclaimer is not hard-coded", () => {
  for (const year of ["2024", "2026", "2031"]) {
    assert.equal(stripBoilerplate(`Hyran avser ${year} års hyresnivå. Fin etta.`).text, "Fin etta.");
  }
});

test("stripBoilerplate handles non-strings", () => {
  assert.deepEqual(stripBoilerplate(null), { text: "", fired: [] });
  assert.deepEqual(stripBoilerplate(undefined), { text: "", fired: [] });
  assert.deepEqual(stripBoilerplate(""), { text: "", fired: [] });
});

/* --- offers --- */

test("the keyword set is the documented one", () => {
  for (const s of ["Kampanj", "kampanj", "Hyresrabatt", "rabatt", "första månaden", "hyresfri"]) {
    assert.ok(OFFER_KEYWORDS.test(s), s);
  }
  assert.equal(OFFER_KEYWORDS.test("Ljus tvåa med balkong"), false);
});

test("the offer snippet is the sentence around the keyword", () => {
  const o = offerFromText("Välkommen till en ljus trea. Vi bjuder på första månaden om du flyttar in i december. Köket är nyrenoverat.");
  assert.equal(o.flag, true);
  assert.equal(o.snippet, "Vi bjuder på första månaden om du flyttar in i december.");
});

test("a leading campaign sentence is picked up whole", () => {
  const o = offerFromText("Kampanj Teckna ett hyresavtal med oss så bjuder vi på månadshyran i februari. Om lägenheten Fin tvåa.");
  assert.equal(o.snippet, "Kampanj Teckna ett hyresavtal med oss så bjuder vi på månadshyran i februari.");
});

test("no campaign means offer is null, not a false flag", () => {
  assert.equal(offerFromText("En ljus och trivsam tvåa med balkong i söderläge."), null);
  assert.equal(offerFromText(""), null);
  assert.equal(offerFromText(null), null);
});

test("the snippet is capped at 140 characters", () => {
  const long = "Kampanj " + "mycket ".repeat(60) + "rabatt.";
  const o = offerFromText(long);
  assert.ok(o.snippet.length <= SNIPPET_CHARS, o.snippet.length);
});

test("the offer is read before stripping, so it survives the strip", () => {
  /* This is the whole point of the ordering in the adapters: the campaign
   * leaves text_start but is not lost. */
  const full = "Kampanj Teckna ett hyresavtal med oss så bjuder vi på månadshyran. Om lägenheten Fin tvåa med balkong.";
  const offer = offerFromText(full);
  const { text } = stripBoilerplate(full);
  assert.equal(offer.flag, true);
  assert.equal(text, "Fin tvåa med balkong.");
  assert.ok(!OFFER_KEYWORDS.test(text), "the campaign wording is gone from the excerpt");
});

test("HomeQ's structured discount becomes a readable snippet", () => {
  assert.deepEqual(
    offerFromDiscount({ enabled: true, discount_type: "discount_period", duration: 6, amount_type: "fixed", amount: 3400 }),
    { flag: true, snippet: "3 400 kr rabatt per månad i 6 månader" });
  assert.deepEqual(
    offerFromDiscount({ enabled: true, discount_type: "free_months", duration: 2, amount_type: null, amount: null }),
    { flag: true, snippet: "2 månader hyresfritt" });
  assert.deepEqual(
    offerFromDiscount({ enabled: true, discount_type: "discount_period", duration: 12, amount_type: "percentage", amount: 15 }),
    { flag: true, snippet: "15 % rabatt på hyran i 12 månader" });
});

test("a single month is singular", () => {
  assert.match(offerFromDiscount({ enabled: true, discount_type: "free_months", duration: 1 }).snippet, /^1 månad hyresfritt$/);
});

test("a disabled discount is not an offer", () => {
  /* HomeQ really does ship enabled:false records. */
  assert.equal(offerFromDiscount({ enabled: false, discount_type: "discount_period", duration: 6, amount_type: "fixed", amount: 2000 }), null);
});

test("a missing or malformed discount is not an offer", () => {
  assert.equal(offerFromDiscount(null), null);
  assert.equal(offerFromDiscount(undefined), null);
  assert.equal(offerFromDiscount("2 months"), null);
});

test("a discount with no usable numbers still flags, without inventing any", () => {
  const o = offerFromDiscount({ enabled: true, discount_type: "discount_period" });
  assert.equal(o.flag, true);
  assert.equal(/\d/.test(o.snippet), false, "no figure may be conjured out of nothing");
});
