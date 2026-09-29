/* tests/search.test.js — src/search_core.js, the area search's matching logic.
   Offline, no DOM: `make test-js` (node --test tests/*.test.js).

   What is being defended here is the reader who cannot type å ä ö — which, on a Swedish
   dashboard read from anywhere else, is most of them. Every case below is a string a
   person actually types: goteborg, malmo, sodermalm, Sthlm, Gbg, Stockholms stad. */
const test = require("node:test");
const assert = require("node:assert");
const S = require("../src/search_core.js");

/* the pool the app builds: kommuner first (name-sorted), then RegSO, then loaded DeSO */
const pool = [
  { t: "Göteborg", h: "map/1480", k: S.keysFor("kommun", "Göteborg", "1480") },
  { t: "Malmö", h: "map/1280", k: S.keysFor("kommun", "Malmö", "1280") },
  { t: "Stockholm", h: "map/0180", k: S.keysFor("kommun", "Stockholm", "0180") },
  { t: "Umeå", h: "map/2480", k: S.keysFor("kommun", "Umeå", "2480") },
  { t: "Södermalm Östra", h: "area/regso/0180R012", k: S.keysFor("regso", "Södermalm Östra", "0180R012_RegSO2025") },
  { t: "Angered Norra", h: "area/regso/1480R001", k: S.keysFor("regso", "Angered Norra", "1480R001_RegSO2025") },
  { t: "0180A0010", h: "area/deso/0180A0010_DeSO2025", k: S.keysFor("deso", "0180A0010", "0180A0010_DeSO2025") },
];
const first = q => (S.match(pool, q, 10)[0] || {}).t || "";
const titles = q => S.match(pool, q, 10).map(o => o.t);

test("fold strips the diacritics a keyboard may not have", () => {
  assert.equal(S.fold("Göteborg"), "goteborg");
  assert.equal(S.fold("Malmö"), "malmo");
  assert.equal(S.fold("Södermalm Östra"), "sodermalm ostra");
  assert.equal(S.fold("Umeå"), "umea");
  assert.equal(S.fold("Åre"), "are");
  /* NFD does not take these apart, so they are mapped by hand */
  assert.equal(S.fold("Ørsted"), "orsted");
  assert.equal(S.fold("Æblet"), "aeblet");
  assert.equal(S.fold("Straße"), "strasse");
});

test("fold turns punctuation into one space, so a suffixed code still reads as a code", () => {
  assert.equal(S.fold("0180R012_RegSO2025"), "0180r012 regso2025");
  assert.equal(S.fold("  Upplands-Väsby  "), "upplands vasby");
  assert.equal(S.fold(null), "");
});

test("the query needs no diacritics", () => {
  assert.equal(first("goteborg"), "Göteborg");
  assert.equal(first("GOTEBORG"), "Göteborg");
  assert.equal(first("malmo"), "Malmö");
  assert.equal(first("umea"), "Umeå");
  assert.equal(first("sodermalm"), "Södermalm Östra");
});

test("and it still works with them", () => {
  assert.equal(first("Göteborg"), "Göteborg");
  assert.equal(first("Södermalm"), "Södermalm Östra");
  assert.equal(first("Malmö"), "Malmö");
});

test("RegSO names are searchable, not only kommuner", () => {
  assert.deepEqual(titles("sodermalm"), ["Södermalm Östra"]);
  assert.deepEqual(titles("angered"), ["Angered Norra"]);
  /* a RegSO reached by the word in the middle of its name, not only by its first word */
  assert.deepEqual(titles("ostra"), ["Södermalm Östra"]);
});

test("the abbreviations people actually type", () => {
  assert.equal(first("sthlm"), "Stockholm");
  assert.equal(first("Sthlm"), "Stockholm");
  assert.equal(first("gbg"), "Göteborg");
  assert.equal(first("Gbg"), "Göteborg");
  assert.equal(first("gothenburg"), "Göteborg");
  assert.equal(first("malmoe"), "Malmö");
});

test("the official name — <name>s stad — is derived, not curated", () => {
  assert.equal(first("Stockholms stad"), "Stockholm");
  assert.equal(first("stockholms stad"), "Stockholm");
  assert.equal(first("Göteborgs stad"), "Göteborg");
  assert.equal(first("goteborgs stad"), "Göteborg");
  assert.equal(first("Malmö stad"), "Malmö");
  assert.equal(first("Umeå kommun"), "Umeå");
  /* and it is derived for a kommun with no hand-written alias at all */
  assert.deepEqual(S.keysFor("kommun", "Kiruna", "2584").includes("kirunas stad"), true);
});

test("codes are searchable, bare or with the vintage suffix", () => {
  assert.equal(first("0180"), "Stockholm");
  assert.equal(first("0180R012"), "Södermalm Östra");
  assert.equal(first("0180R012_RegSO2025"), "Södermalm Östra");
  assert.equal(first("0180A0010"), "0180A0010");
});

test("an exact hit beats a prefix, a prefix beats a substring", () => {
  assert.equal(S.rank(["stockholm", "0180"], "stockholm"), 4);
  assert.equal(S.rank(["stockholm"], "stock"), 3);
  assert.equal(S.rank(["sodermalm ostra"], "ostra"), 2);
  assert.equal(S.rank(["sodermalm ostra"], "malm"), 1);
  assert.equal(S.rank(["sodermalm ostra"], "zzz"), 0);
  /* "malm" is inside Södermalm and starts Malmö: the prefix wins the first slot */
  assert.equal(first("malm"), "Malmö");
});

test("equal ranks keep the pool's order, so the same query is the same list", () => {
  const twice = [titles("s"), titles("s")];
  assert.deepEqual(twice[0], twice[1]);
  const got = titles("o");
  assert.deepEqual(got, got.slice().sort((a, b) => pool.findIndex(p => p.t === a) - pool.findIndex(p => p.t === b)));
});

test("an empty or unmatched query returns nothing at all", () => {
  assert.deepEqual(S.match(pool, "", 10), []);
  assert.deepEqual(S.match(pool, "   ", 10), []);
  assert.deepEqual(S.match(pool, "zzzzz", 10), []);
  assert.deepEqual(S.match(null, "sthlm", 10), []);
});

test("the cap is honoured", () => {
  assert.equal(S.match(pool, "o", 2).length, 2);
  assert.ok(S.match(pool, "o", 10).length > 2);
});
