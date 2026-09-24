# Listings gateway

Phase 1 of the listings layer: a Cloudflare Worker that answers "what is for rent
near this point?" for the dashboard's area pages. It is a read-through proxy with
a normalising layer, and nothing else — **it stores nothing, and no third-party
listing data is committed to this repository.**

Everything lives under `gateway/`. It does not touch `src/`, `scripts/`,
`config/` or the `Makefile`.

## Why a gateway at all

The dashboard is a static page on GitHub Pages. The listing APIs it wants to read
send no CORS headers, so a browser cannot call them directly — the request is made
and the response is then withheld from the page. The Worker is the smallest thing
that fixes that: one hop, same-origin from the browser's point of view, which also
gives one place to enforce a radius cap, a timeout and an origin allowlist.

It is deliberately **not** a scraper and **not** a database. The dashboard's own
numbers come from SCB and are computed offline into `data/processed/`; listings are
live, third-party, and licensed to somebody else. Mixing the two would put data in
`data/processed/` that we have no right to publish.

## Endpoints

### `GET /nearby?lat=&lon=&r=`

Listings within `r` metres of the point, nearest first.

| Parameter | Required | Rule |
|---|---|---|
| `lat` | yes | 55–70 (Sweden). Anything else is `400`. |
| `lon` | yes | 10–25 (Sweden). Anything else is `400`. |
| `r`   | no  | metres, default **500**, capped at **3000**. A larger value is clamped, not rejected; the effective value comes back as `radius`. |

The lat/lon bounds mostly catch a swapped pair: `lat=18&lon=59` is a client bug,
and rejecting it beats forwarding a box over the Black Sea.

```json
{
  "fetchedAt": "2026-09-24T11:04:34.734Z",
  "radius": 500,
  "sources": [{ "src": "homeq", "ok": true, "count": 2 }],
  "listings": [ /* … sorted by dist_m … */ ]
}
```

`sources` is one entry per adapter and is the honest part of the response. A
source that fails carries `ok:false`, `count:0` and an `error` string. **A failing
source is never reported as an empty success** — if every source fails the status
code is `502` while the body keeps the shape above, so a client that only checks
the status cannot mistake an outage for a quiet neighbourhood.

### `GET /text?src=homeq&id=…`

```json
{ "text_start": "En charmig 1a i nära anslutning till affärer, buss och tunnelbana…" }
```

The first 220 characters of the ad description, tags stripped and whitespace
collapsed. It is a second round trip per listing, so it is deliberately *not*
folded into `/nearby` — the UI asks for it when a card is opened. Cached at the
edge for one hour.

### `GET /health`

`{"ok":true,"sources":["homeq"]}`. No upstream call.

## Listing schema

Every source normalises to the same object, and every key is always present —
`null` where the source has no answer, so a consumer can read `listing.year_built`
without knowing which source it came from.

| Field | Type | Notes |
|---|---|---|
| `src` | string | `"homeq"` — the adapter key, stable, used by `/text` |
| `src_label` | string | `"HomeQ"` — for display and attribution |
| `id` | number/string | the source's own id |
| `url` | string | **the ad on the source's own site** — see Rules |
| `address` | string | street address as the source states it |
| `area_name` | string\|null | neighbourhood, when the source names one |
| `lat`, `lon` | number | WGS84 |
| `rent_sek_mo` | number\|null | SEK per month, as advertised |
| `size_m2` | number\|null | |
| `rooms` | number\|null | may be fractional (1.5 rum) |
| `floor` | number\|null | |
| `year_built` | number\|null | |
| `available_from` | string\|null | ISO date |
| `published` | string\|null | ISO date |
| `image` | string\|null | first photo, hotlinked from the source's CDN |
| `text_start` | string\|null | always `null` from `/nearby`; filled by `/text` |
| `discount` | object\|null | source-shaped campaign object, passed through |
| `is_new_production` | bool\|null | |
| `dist_m` | number | metres from the query point, whole metres |

Fields a source does not carry stay `null` rather than being guessed — the same
rule the dashboard applies to suppressed SCB values. A rent is what the landlord
advertises, which is not the same thing as a contract rent and is not comparable
with the SCB rent statistics on the area pages; the UI must not present the two
as one series.

## Sources

### HomeQ (`homeq`)

[homeq.se](https://www.homeq.se) — a rental marketplace whose public web client
talks to an unauthenticated JSON API.

- `POST /api/v3/search` with `{"geo_bounds":{min_lat,max_lat,min_lng,max_lng}}`
- `GET /api/v1/object/<id>` — the full ad, read only for its description

The search endpoint returns **every** hit in the box in one response with no
cursor: an all-Sweden box answers with ~6 500 results. There is therefore no
pagination to handle at the radii this gateway allows, and no reason to ever send
an all-Sweden box.

Coverage is nationwide but partial — HomeQ carries the landlords who list on it,
weighted towards allmännytta and larger private landlords, and towards new
production. It is a sample of the market, not the market. Treat a count of
listings near a point as "what is advertised on HomeQ right now", never as vacancy.

Adding a source means one file in `gateway/src/sources/` exporting `SRC`,
`SRC_LABEL`, `fetchNearby(lat, lon, r, {signal})` and `fetchText(id, {signal})`,
plus one line in `SOURCES` in `src/index.js`. The envelope, timeout, error
reporting and CORS are handled for it.

## Geometry

A source is asked for a **box**; the gateway returns a **circle**.

The box is `r/111320` degrees of latitude and `r/(111320·cos(lat))` degrees of
longitude either side of the point — the cosine matters, since at Stockholm's
59° N a degree of longitude is about half a degree of latitude, and using one
offset for both gives an oval a kilometre out of true. Results are then trimmed
by haversine distance to `≤ r`, because the corner of the box sits at `r·√2`:
without the trim a 500 m search quietly returns listings 707 m away.

This is the same trap as the metres-versus-degrees one in `build_geo.py`, in a
different costume.

## Rules

1. **Nothing is stored.** No KV, no D1, no R2, no logs of responses. The only
   persistence is Cloudflare's edge cache: 1 h for `/text`, 60 s for `/nearby`
   (short, because listings turn over daily and a stale card is visible to the
   user; the minute exists to absorb a user clicking around a map, which is what
   actually protects the upstream API).

   That cache is **best-effort and must never be relied on**. The write happens
   in `ctx.waitUntil` *after* the response is sent, so a second request arriving
   immediately behind the first still misses; entries are per-colo, so a hit in
   one location says nothing about another; and Cloudflare may evict at any
   time. Observed in production: miss, hit, then miss again on the same URL
   within ten seconds. `x-gateway-cache: hit|miss` reports what happened, for
   debugging only — correctness never depends on it.
2. **Area level only.** Listings are shown as an aggregate or a short list on an
   area page. The gateway is not a search engine and the dashboard is not a
   listings portal; nothing here is re-published as a dataset.
3. **Always link back.** Every listing carries `url` and `src_label`, and the UI
   must render both. The photo is hotlinked from the source's own CDN — never
   copied, never re-hosted.
4. **No third-party data in the repository.** The tests use synthetic fixtures in
   the live payloads' shape, with invented addresses and ids.
5. **Origins are allowlisted**: `https://real-estate-war-lord.github.io` and
   `http://localhost:8080`. Anything else gets no CORS headers.
6. **8 s per source**, enforced with `AbortSignal.timeout`. One slow source cannot
   hold the response.

Licensing is the reason for 1–4. The SCB data behind the rest of the dashboard is
CC0; these listings are not ours, and the gateway's job is to point at them, not
to accumulate them.

## Development

```sh
npm --prefix gateway test     # 37 unit tests, no network (one takes 8 s: the timeout budget)
cd gateway && npx wrangler dev
```

The unit tests cover the box maths, the haversine trim, the normalisation schema
and the failure envelope, with `fetch` stubbed — they never touch the network, so
they neither depend on HomeQ being up nor add load to it.

Live smoke test:

```sh
curl 'http://127.0.0.1:8787/nearby?lat=59.3165&lon=18.0335&r=500'   # Slussen
curl 'http://127.0.0.1:8787/nearby?lat=59.3710&lon=16.5090&r=1000'  # Eskilstuna centrum
```

## Deploying

```sh
cd gateway
npx wrangler login
npx wrangler deploy
```

**Live at <https://am-se-listings.am-se-listings-gateway.workers.dev>** (account
`625d331c77c0d97127dbebfc30755b33`, first deployed 2026-09-24). The first deploy
registers the workers.dev subdomain and DNS took about 75 seconds to answer; a
fresh deploy afterwards is immediate.

If the workers.dev subdomain ever changes, the origin allowlist in `src/index.js`
is what the dashboard must match, not the other way round.

`wrangler login` mints a broad account-wide OAuth token (`d1:write`,
`pages:write`, `workers_kv:write`, `ssl_certs:write` and more) that this Worker
does not need — it uses `workers:write` and has no bindings at all. A scoped API
token limited to *Workers Scripts: Edit*, passed as `CLOUDFLARE_API_TOKEN`, is
the tighter setup for CI or a shared machine.
