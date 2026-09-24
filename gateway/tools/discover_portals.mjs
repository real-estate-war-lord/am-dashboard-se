/* Probe Swedish landlords for a Vitec Arena tenant portal.
 *
 *   node gateway/tools/discover_portals.mjs [--out report.json]
 *
 * For each landlord, try <prefix>.<domain>/rentalobject/Listapartment/published
 * until one answers with valid Arena JSON, then stop for that landlord.
 *
 * Politeness, because this is somebody else's server and the whole exercise
 * is one unsolicited request per host:
 *   - one request at a time, never concurrent
 *   - at least DELAY_MS between requests
 *   - an ordinary browser User-Agent and Accept, not a blank client
 *   - HTTP 429 or 503 aborts the whole run rather than retrying
 *
 * The output is a table plus a JSON report; it does not write PORTALS itself.
 */
"use strict";

import { CANDIDATES, HOST_PREFIXES } from "./candidates.js";
import fs from "node:fs";

const PATH = "/rentalobject/Listapartment/published";
const DELAY_MS = 1000;
const TIMEOUT_MS = 30000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Halt extends Error {}

/* One host. Returns a row describing what happened. */
async function probe(host) {
  const url = `https://${host}${PATH}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { "user-agent": UA, accept: "application/json, text/plain, */*" },
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const cause = err?.cause?.code || err?.name || "error";
    /* A domain that does not resolve is the common case and is not a finding. */
    return { host, status: cause === "ENOTFOUND" ? "no-dns" : `net:${cause}`, arena: false };
  }

  if (res.status === 429 || res.status === 503) {
    throw new Halt(`${host} answered HTTP ${res.status} — stopping the run`);
  }
  if (!res.ok) return { host, status: `http ${res.status}`, arena: false };

  const body = await res.text();
  let outer;
  try { outer = JSON.parse(body); } catch { 
    return { host, status: `http 200 (${/^\s*</.test(body) ? "html" : "not json"})`, arena: false };
  }
  if (!outer || typeof outer !== "object" || !("data" in outer)) {
    return { host, status: "http 200 (json, not Arena)", arena: false };
  }
  let records;
  try {
    records = typeof outer.data === "string" ? JSON.parse(outer.data) : outer.data;
  } catch {
    return { host, status: "http 200 (Arena envelope, bad data)", arena: false };
  }
  if (!Array.isArray(records)) {
    return { host, status: "http 200 (Arena envelope, data not an array)", arena: false };
  }

  const n = records.length;
  const withCoord = records.filter(
    (r) => Number.isFinite(r?.Latitude) && Number.isFinite(r?.Longitude) && !(r.Latitude === 0 && r.Longitude === 0)
  ).length;
  return {
    host, status: "http 200 ARENA", arena: true,
    count: n,
    coordShare: n ? withCoord / n : 0,
    bytes: body.length,
  };
}

const rows = [];
let halted = null;

outer:
for (const c of CANDIDATES) {
  const attempts = [];
  for (const prefix of HOST_PREFIXES) {
    const host = `${prefix}.${c.domain}`;
    if (rows.length || attempts.length) await sleep(DELAY_MS);
    let row;
    try {
      row = await probe(host);
    } catch (err) {
      if (err instanceof Halt) { halted = err.message; break outer; }
      throw err;
    }
    attempts.push(row);
    process.stderr.write(`  ${row.arena ? "ARENA" : "     "} ${host.padEnd(42)} ${row.status}${row.count != null ? `  ${row.count} records, ${(row.coordShare * 100).toFixed(0)}% with coords` : ""}\n`);
    if (row.arena) break;          // found it; stop probing this landlord
  }
  rows.push({ ...c, attempts, hit: attempts.find((a) => a.arena) || null });
}

const outIdx = process.argv.indexOf("--out");
const report = { checkedAt: new Date().toISOString(), halted, rows };
if (outIdx > -1) fs.writeFileSync(process.argv[outIdx + 1], JSON.stringify(report, null, 1));

const found = rows.filter((r) => r.hit);
console.log(`\n${found.length} of ${rows.length} landlords expose an Arena portal.`);
if (halted) console.log(`RUN HALTED: ${halted}`);
