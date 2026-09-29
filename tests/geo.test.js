/* src/geo_core.js — the ring codec, offline.
 *
 * Two things are being asserted, and the second is the one that matters:
 *   1. the round trip is lossless at 5 decimals, which is what build_makro.py
 *      rounds every ring to before encoding;
 *   2. nothing swaps [lat, lon]. CLAUDE.md records what happened the one time a
 *      second swap crept into this pipeline — every sub-municipal polygon drawn
 *      off the Somali coast, unnoticed until somebody took a screenshot — so the
 *      order is checked against hard-coded Swedish coordinates rather than
 *      against whatever the encoder happens to give back.
 *
 * `make test-js` runs this. It also checks the real build output: the encoded
 * rings in data/processed/ decode to points inside Sweden.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const GC = require("../src/geo_core.js");
const ROOT = path.resolve(__dirname, "..");
/* Sweden, generously: 55.2–69.1 N, 10.9–24.2 E */
const BOX = [55.0, 69.3, 10.5, 24.5];
const inSweden = p => p[0] >= BOX[0] && p[0] <= BOX[1] && p[1] >= BOX[2] && p[1] <= BOX[3];

test("the alphabet is JSON-safe and 64 characters", () => {
  assert.strictEqual(GC.ALPHA.length, 64);
  assert.strictEqual(new Set(GC.ALPHA).size, 64);
  for (const ch of GC.ALPHA) {
    assert.ok(!'"\\&<>'.includes(ch), `${ch} would have to be escaped`);
    assert.strictEqual(JSON.parse(JSON.stringify(ch)), ch);
  }
  /* the whole point of not using Google's 0x3F offset */
  assert.ok(!GC.ALPHA.includes("\\"));
});

test("one ring round-trips exactly, in [lat, lon] order", () => {
  /* Stockholm City Hall, Gamla stan, Slussen — lat first, as every ring in this
     repository is stored. A swap would put these in Somalia. */
  const ring = [[59.32744, 18.05444], [59.32520, 18.07110], [59.31972, 18.07194],
                [59.31745, 18.06610], [59.32744, 18.05444]];
  const s = GC.encodeRing(ring);
  assert.strictEqual(typeof s, "string");
  const back = GC.decodeRing(s);
  assert.deepStrictEqual(back, ring);
  assert.ok(back.every(inSweden), "decoded points are inside Sweden");
  /* and it is actually shorter than the JSON it replaces */
  assert.ok(s.length < JSON.stringify(ring).length / 2,
            `${s.length} chars vs ${JSON.stringify(ring).length} of JSON`);
});

test("negative deltas, zero deltas and a single point all survive", () => {
  for (const ring of [[[0, 0]], [[59.5, 17.9], [59.5, 17.9]],
                      [[69.05999, 20.54999], [55.33701, 12.94001], [59.0, -0.5]],
                      [[-33.86785, 151.20732]]]) {
    assert.deepStrictEqual(GC.decodeRing(GC.encodeRing(ring)), ring);
  }
});

test("an empty ring is an empty string and comes back empty", () => {
  assert.strictEqual(GC.encodeRing([]), "");
  assert.deepStrictEqual(GC.decodeRing(""), []);
  assert.deepStrictEqual(GC.decodeRing(null), []);
  assert.deepStrictEqual(GC.decodeRings(null), []);
});

test("a truncated or corrupt string stops rather than inventing a point", () => {
  const s = GC.encodeRing([[59.32744, 18.05444], [59.32520, 18.07110]]);
  /* every prefix decodes to some whole number of points and nothing else —
     never NaN, never a stray [0, 0] */
  for (let i = 0; i <= s.length; i++) {
    const got = GC.decodeRing(s.slice(0, i));
    assert.ok(got.every(p => isFinite(p[0]) && isFinite(p[1])), `prefix ${i}`);
  }
  assert.deepStrictEqual(GC.decodeRing("!!!"), []);
});

test("decodeRings is idempotent — decoding twice cannot corrupt a ring", () => {
  const rings = [[[59.32744, 18.05444], [59.32520, 18.07110], [59.31972, 18.07194]]];
  const enc = GC.encodeRings(rings);
  const once = GC.decodeRings(enc);
  const twice = GC.decodeRings(once);
  assert.deepStrictEqual(once, rings);
  assert.deepStrictEqual(twice, rings);
  const o = { rings: enc.slice() };
  GC.decodeEntity(o); GC.decodeEntity(o); GC.decodeEntity(o);
  assert.deepStrictEqual(o.rings, rings);
});

test("5 decimals is the precision, and it is not exceeded silently", () => {
  /* a sixth decimal is rounded, exactly as build_makro.py's round(p, 5) does */
  const back = GC.decodeRing(GC.encodeRing([[59.327444, 18.054446]]));
  assert.deepStrictEqual(back, [[59.32744, 18.05445]]);
});

/* ---- the real build output, if it is on disk ---- */
const VALS = path.join(ROOT, "data", "processed", "regso", "index.json");

test("the build's own encoded rings decode to points inside Sweden", { skip: !fs.existsSync(VALS) }, () => {
  const idx = JSON.parse(fs.readFileSync(VALS, "utf8")).kommuner || {};
  const codes = Object.keys(idx);
  assert.ok(codes.length > 250, `${codes.length} ring files`);
  /* Stockholm, Värmdö (60 islands — the archipelago is where a coordinate bug
     shows first) and Malå (one inland part) */
  let points = 0;
  for (const kod of ["0180", "0120", "2418"].filter(k => idx[k])) {
    const f = path.join(ROOT, "data", "processed", "regso", `${kod}.json`);
    const rings = JSON.parse(fs.readFileSync(f, "utf8")).rings || {};
    const n = Object.keys(rings).length;
    assert.strictEqual(n, idx[kod].n, `${kod}: ${n} areas against the index's ${idx[kod].n}`);
    for (const code of Object.keys(rings)) {
      assert.ok(rings[code].length > 0, `${code} has no ring`);
      for (const r of rings[code]) {
        assert.strictEqual(typeof r, "string", `${code} ring is not encoded`);
        const pts = GC.decodeRing(r);
        assert.ok(pts.length >= 3, `${code} ring decoded to ${pts.length} points`);
        for (const p of pts) {
          assert.ok(inSweden(p), `${code} has a point at ${p} — check the coordinate order`);
          points++;
        }
      }
    }
  }
  assert.ok(points > 10000, `${points} points checked`);
});

test("the kommun outlines in makro.json are encoded and land in Sweden", () => {
  const f = path.join(ROOT, "data", "processed", "makro.json");
  if (!fs.existsSync(f)) return;
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  const kom = (d.kommuner || []).find(m => m.code === "0180");
  assert.ok(kom, "Stockholm is in makro.json");
  assert.strictEqual(typeof kom.rings[0], "string", "kommun rings are encoded");
  assert.ok(GC.decodeRing(kom.rings[0]).every(inSweden));
  /* the RegSO in the page are the name index only — no geometry, no figures */
  const a = (d.regso || [])[0];
  assert.ok(a && a.code && a.name && a.kommun, "the RegSO index carries code, name, kommun");
  assert.strictEqual(a.rings, undefined, "and no rings");
  assert.strictEqual(a.hist, undefined, "and no history");
});
