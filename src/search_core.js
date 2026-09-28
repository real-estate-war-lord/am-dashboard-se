/* Area search — the pure matching logic, kept out of src/app.js so it can be unit-tested.
   Same arrangement as src/route_core.js, src/testprop.js and src/listings/view.js: no DOM,
   no globals, no fetch. `make test-js` runs tests/search.test.js against this file.

   Sweden is the reason this exists. A reader types what is on their keyboard:

     goteborg   → Göteborg          malmo    → Malmö
     sodermalm  → Södermalm RegSO   angered  → Angered
     Sthlm      → Stockholm         Gbg      → Göteborg
     Stockholms stad → Stockholm    Malmö stad → Malmö

   Three rules, in this order, and nothing else:

   1. **Fold, don't guess.** å ä ö é ü are stripped to their base letter through NFD, and
      ø/æ/ß — which a Danish or German keyboard produces — are mapped by hand because NFD
      does not decompose them. The fold is applied to the query AND to every key, so the
      comparison is always fold-to-fold. It is never applied to what is SHOWN: the page
      still says Södermalm.
   2. **Derive what can be derived.** "Stockholms stad" and "Stockholm kommun" are not
      aliases worth curating for 290 kommuner — they are the name plus a suffix, so
      keysFor() generates them. The hand-written table below holds only the abbreviations
      that cannot be derived from the name at all.
   3. **Rank, don't filter.** An exact hit beats a prefix, a prefix beats a word start, a
      word start beats a substring anywhere. Within a rank the pool's own order decides,
      so kommuner stay above RegSO and both stay alphabetical — a stable sort, so the
      same query always returns the same list.

   Codes are searchable too, and a RegSO code carries its vintage suffix
   ("0180R001_RegSO2025"), so the fold turns every run of punctuation into one space and
   the bare code still matches as a prefix.
*/
"use strict";
/* Wrapped in an IIFE: the build inlines this file and app.js as two classic <script> blocks
   in one global lexical scope, so a top-level const here would collide and blank the page. */
(function () {

/* Letters NFD does not take apart. Everything else — å ä ö é è ü ñ ô — decomposes into
   base + combining mark, and the mark is stripped below. */
const HARD = { "ø": "o", "æ": "ae", "œ": "oe", "ß": "ss", "đ": "d", "ð": "d", "ł": "l", "þ": "th" };

/* "Södermalm Östra" → "sodermalm ostra". Punctuation and runs of whitespace become one
   space, so "0180R001_RegSO2025" → "0180r001 regso2025" and a typed bare code still hits. */
function fold(s) {
  let t = String(s == null ? "" : s).toLowerCase();
  t = t.replace(/[øæœßđðłþ]/g, c => HARD[c] || c);
  if (t.normalize) t = t.normalize("NFD").replace(/[̀-ͯ]/g, "");
  return t.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/* The abbreviations a Swedish reader types that no rule could produce from the name.
   Deliberately short: a long alias table is a maintenance burden and a source of wrong
   hits, and everything of the form "<name> stad" / "<name> kommun" is derived instead. */
const ALIASES = {
  "0180": ["sthlm", "stockholm city", "sto"],
  "1480": ["gbg", "gothenburg"],
  "1280": ["malmoe"],
  "0580": ["lkpg"],
  "0581": ["nkpg"],
  "0680": ["jkpg"],
  "1283": ["hbg"],
  "1980": ["vsts"],
  "2480": ["umea uni"],
};

/* Every string a kommun, RegSO or DeSO answers to. The display name is NOT one of them —
   it is what the row shows; these are what the row is matched on, all folded. */
function keysFor(kind, name, code) {
  const out = [];
  const push = s => { const f = fold(s); if (f && out.indexOf(f) < 0) out.push(f); };
  const n = fold(name);
  if (n) push(n);
  if (code) {
    push(code);
    /* "0180R001_RegSO2025" is also reachable by its bare code, which is what the page prints */
    const bare = String(code).split("_")[0];
    if (bare !== String(code)) push(bare);
  }
  if (kind === "kommun" && n) {
    /* Stockholm → "stockholm stad", "stockholms stad", "stockholm kommun", "stockholms kommun".
       The official name of several of them IS "<name>s stad", and it is what an address or a
       news article says, so it has to match. */
    ["stad", "kommun"].forEach(w => { push(n + " " + w); push(n + "s " + w); });
    (ALIASES[String(code)] || []).forEach(push);
  }
  return out;
}

/* 4 exact · 3 prefix · 2 word start · 1 anywhere · 0 no match. Nothing is scored on a
   description or a parent name: a row that matches on something the reader cannot see on
   it reads as a bug rather than as a hit. */
function rank(keys, q) {
  const ks = keys || [];
  let best = 0;
  for (let i = 0; i < ks.length; i++) {
    const k = ks[i];
    if (!k) continue;
    if (k === q) return 4;
    if (k.indexOf(q) === 0) { if (best < 3) best = 3; continue; }
    const at = k.indexOf(q);
    if (at < 0) continue;
    if (k.charAt(at - 1) === " ") { if (best < 2) best = 2; continue; }
    if (best < 1) best = 1;
  }
  return best;
}

/* pool: [{ k: [folded keys…], … }] — whatever else the entry carries is passed through
   untouched, so this module never has to know what a result looks like on screen. */
function match(pool, query, max) {
  const q = fold(query);
  if (!q) return [];
  const lim = max == null ? 10 : max;
  const hits = [];
  for (let i = 0; i < (pool || []).length; i++) {
    const r = rank(pool[i].k, q);
    if (r) hits.push({ r, i, o: pool[i] });
  }
  /* stable: equal ranks keep the pool's order, which is kommuner first and alphabetical */
  hits.sort((a, b) => (b.r - a.r) || (a.i - b.i));
  return hits.slice(0, lim).map(h => h.o);
}

const API = { fold, keysFor, rank, match, ALIASES };
if (typeof window !== "undefined") window.SEARCH_CORE = API;
if (typeof module !== "undefined" && module.exports) module.exports = API;

})();
