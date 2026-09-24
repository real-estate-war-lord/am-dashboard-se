# Listings gateway

A Cloudflare Worker that answers "what is for rent near this point?" for the
dashboard's area pages, from three sources under one schema.

**No third-party listing data is committed to this repository.** The gateway
does hold one thing at runtime: the latest hourly snapshot of each Arena
portal's vacancy list, in Workers KV, overwritten every hour with no history.
That is a change from phase 1, which stored nothing at all, and it is forced by
the upstream API — see *Why the portals are snapshotted*.

Everything lives under `gateway/`. It does not touch `src/`, `scripts/`,
`config/` or the `Makefile`.

## Why a gateway at all

The dashboard is a static page on GitHub Pages. The listing APIs it wants to read
send no CORS headers, so a browser cannot call them directly — the request is made
and the response is then withheld from the page. The Worker is the smallest thing
that fixes that: one hop, same-origin from the browser's point of view, which also
gives one place to enforce a radius cap, a timeout and an origin allowlist.

It is deliberately **not** a scraper and **not** an archive. It holds a one-hour
cache of each portal's current vacancy list because the upstream API leaves no
alternative, and it throws that away every hour rather than accumulating it.

The dashboard's own numbers come from SCB and are computed offline into
`data/processed/`; listings are live, third-party and licensed to somebody else.
Nothing from this gateway is ever written into `data/processed/` or committed —
that would publish data we have no right to publish, and would also be wrong on
its own terms: an advertised rent is not a contract rent and is not comparable
with the SCB rent statistics the area pages are built on. The UI must keep the
two visibly apart and never draw them as one series.

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
  "fetchedAt": "2026-09-24T11:16:26.663Z",
  "radius": 1000,
  "sources": [
    { "src": "homeq",       "ok": true, "count": 80 },
    { "src": "heimstaden",  "ok": true, "count": 17, "fetchedAt": "2026-09-24T11:39:13.873Z" },
    { "src": "victoriahem", "ok": true, "count": 10, "fetchedAt": "2026-09-24T11:39:13.812Z" }
  ],
  "deduped": 0,
  "listings": [ /* … sorted by dist_m … */ ]
}
```

A portal entry carries the `fetchedAt` of the **snapshot** it was served from,
which is older than the response's own `fetchedAt`. HomeQ, being live, has no
such field. `deduped` is how many HomeQ records were folded into a portal
record (see *Deduplication*).

`sources` is one entry per adapter and is the honest part of the response. A
source that fails carries `ok:false`, `count:0` and an `error` string. **A failing
source is never reported as an empty success** — if every source fails the status
code is `502` while the body keeps the shape above, so a client that only checks
the status cannot mistake an outage for a quiet neighbourhood.

A portal whose snapshot is missing, or **older than 3 hours**, is `ok:false` with
a `stale` error and contributes no listings. Stale data is not served as though
it were current: a flat let three days ago should not appear as available.

### `GET /text?src=&id=…`

```json
{ "text_start": "En charmig 1a i nära anslutning till affärer, buss och tunnelbana…" }
```

The first 220 characters of the ad description, tags stripped, HTML entities
decoded and whitespace collapsed.

For `homeq` this is a live second round trip, so it is deliberately not folded
into `/nearby` — the UI asks for it when a card is opened. For the portals the
text is already in the snapshot (their list endpoint carries the full
description), so it is served from KV with no upstream call at all. Cached at
the edge for one hour either way.

### `GET /health`

`{"ok":true,"sources":["homeq","heimstaden","victoriahem"]}`. No upstream call.

### `GET /admin/refresh`

Rebuilds both portal snapshots immediately, the same work the hourly cron does.
Requires `Authorization: Bearer $REFRESH_SECRET`; with no secret configured the
endpoint is **closed** (503) rather than open. Never cached, and no CORS headers
are granted to it — it is an operator endpoint, not something a page calls.

```sh
curl -H "Authorization: Bearer $REFRESH_SECRET" \
  https://am-se-listings.am-se-listings-gateway.workers.dev/admin/refresh
```

```json
{"refreshedAt":"…","portals":[
  {"src":"heimstaden","ok":true,"count":492,"dropped":1,"fetchedAt":"…"},
  {"src":"victoriahem","ok":true,"count":1110,"dropped":2,"fetchedAt":"…"}, …]}
```

All 21 sources refresh in about 5 seconds. They are fetched **four at a time**,
not all at once: Victoriahem's list alone is 8.6 MB and parsing it costs
several times that in live objects, so nineteen in flight together would run at
the Worker's 128 MB ceiling.

`dropped` is how many records were discarded for having no usable coordinates.
The secret is set with `wrangler secret put REFRESH_SECRET` and is not in the
repository.

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
| `text_start` | string\|null | excerpt, boilerplate-stripped; always `null` from `/nearby` for HomeQ, present for portals |
| `offer` | object\|null | `{flag:true, snippet}` when the ad advertises a discount |
| `discount` | object\|null | source-shaped campaign object, passed through |
| `is_new_production` | bool\|null | |
| `dist_m` | number | metres from the query point, whole metres |
| `allocation` | `"direct"` \| `"queue"` | how the flat is let — see *Queue sources* |
| `audience` | string\|null | `student`, `youth`, `senior`, `short_term` when reserved for a group |
| `also_on` | string[] | present only on a deduplicated record: other sources carrying the same flat |
| `also_on_urls` | object | `{src: url}` for those other sources |

Queue sources add three more: `queue_name`, `queue_years_q1` / `queue_years_q3`
(the feed's own queue-time quartiles, in years) and `apply_by`.

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
cursor: an all-Sweden box answers with ~6 450 results. There is therefore no
pagination to handle at the radii this gateway allows, and no reason to ever send
an all-Sweden box.

Coverage is nationwide but partial — HomeQ carries the landlords who list on it,
weighted towards allmännytta and larger private landlords, and towards new
production. It is a sample of the market, not the market. Treat a count of
listings near a point as "what is advertised on HomeQ right now", never as vacancy.

### Heimstaden (`heimstaden`) and Victoriahem (`victoriahem`)

Two landlords running the same **Arena** letting platform, so one adapter
serves both — the payloads are the same 69-key shape and only the host differs.

| | |
|---|---|
| Heimstaden | `https://mitt.heimstaden.com` |
| Victoriahem | `https://minasidor.victoriahem.se` |

`GET <host>/rentalobject/Listapartment/published` returns

```json
{ "status": "success", "data": "<a JSON string containing the array>" }
```

`data` is a JSON **string** inside the JSON envelope, not an array — it must be
parsed a second time. Live sizes: ~490 records / 3.2 MB (Heimstaden) and ~1 110
records / 8.6 MB (Victoriahem).

These are the landlords' own letting systems, so the records carry things HomeQ
does not: `floor`, `year_built`, `area_name` and the page where you actually
apply. Coverage is only these two landlords' own stock, nationwide.

#### Why the portals are snapshotted

The endpoint takes **no geo filter and no pagination**. It answers with the
landlord's entire national vacancy list or nothing — there is no way to ask
"what is near this point". Proxying it live would mean pulling 12 MB on every
map click, so instead a cron rebuilds both snapshots hourly into KV and
`/nearby` trims them to the radius. This is the only thing the gateway stores.

#### Traps in the Arena payload

- **`YearBuilt` is `0`, not null, when unknown** — on *every one* of
  Victoriahem's 1 110 records and 135 of Heimstaden's. Stored at face value the
  entire portfolio sits in year zero and any average built-year collapses. It
  is mapped to `null`. (`Floor` is different: `0` there means bottenvåning and
  is kept.) The same trap as the RegSO zeros in `build_makro.py`.
- **`Description` is usually empty; the text lives in `DescriptionHtml`.**
  Heimstaden fills `Description` on 15 of 489 records and `DescriptionHtml` on
  486. Reading only `Description`, as the field name suggests, leaves 97 % of
  Heimstaden's listings with no text. The adapter prefers the plain field and
  falls back to the HTML one.
- **`FirstImage` carries no URL.** `ExternalUrl`, `ExternalPartnerUrl` and
  `Filename` are null on every record in both portals; only `Guid`,
  `Id`, `DateChanged` and `Extension` are populated. The URL is built the way
  the portal's own `og:image` builds it:
  `<host>/Content/ImageUrl?guid=&width=400&height=300&crop=True&datechanged=&extension=`,
  which 301-redirects to the resized file under `/Cache/` — a redirect a
  browser follows by itself in an `<img src>`. Most records have no image at
  all (1 007 of 1 110 Victoriahem, 484 of 489 Heimstaden), so the UI must cope
  with `image: null` as the normal case, not the exception.
- **Coordinates can be `0,0`** — "no coordinate" written as a number, which
  would place the flat in the Gulf of Guinea. Those records are dropped and
  counted in `dropped`, alongside the ones with nulls.
- Addresses carry stray whitespace (`"Malakitgatan 12 "`), trimmed on the way in.

### The portal register

All 19 Arena portals, **checked 2026-09-24**. Counts are that day's vacancy
list, recorded so a portal that quietly empties or changes shape is noticeable.

| src | landlord | host | listings | with coordinates |
|---|---|---|---:|---:|
| `heimstaden` | Heimstaden | `mitt.heimstaden.com` | 492 | 100 % |
| `victoriahem` | Victoriahem | `minasidor.victoriahem.se` | 1 110 | 100 % |
| `lkf` | LKF (Lund) | `www.lkf.se` | 146 | 100 % |
| `uddevallahem` | Uddevallahem | `www.uddevallahem.se` | 81 | 100 % |
| `helsingborgshem` | Helsingborgshem | `www.helsingborgshem.se` | 30 | 100 % |
| `dios` | Diös | `minasidor.dios.se` | 29 | 100 % |
| `trianon` | Trianon | `minasidor.trianon.se` | 27 | 100 % |
| `nykopingshem` | Nyköpingshem | `minasidor.nykopingshem.se` | 27 | 100 % |
| `skovdebostader` | Skövdebostäder | `minasidor.skovdebostader.se` | 26 | 100 % |
| `mitthem` | Mitthem (Sundsvall) | `www.mitthem.se` | 24 | 100 % |
| `botkyrkabyggen` | Botkyrkabyggen | `www.botkyrkabyggen.se` | 22 | 100 % |
| `vasbyhem` | Väsbyhem | `www.vasbyhem.se` | 20 | 100 % |
| `kalmarhem` | Kalmarhem | `minasidor.kalmarhem.se` | 13 | 100 % |
| `sollentunahem` | Sollentunahem | `minasidor.sollentunahem.se` | 6 | 100 % |
| `lulebo` | Lulebo (Luleå) | `www.lulebo.se` | 5 | 100 % |
| `haningebostader` | Haninge Bostäder | `minasidor.haningebostader.se` | 5 | 100 % |
| `vatterhem` | Jönköpings Rådhus/Vätterhem | `minasidor.vatterhem.se` | 3 | 100 % |
| `tyresobostader` | Tyresö Bostäder | `www.tyresobostader.se` | 0 | — |
| `signalisten` | Signalisten (Solna) | `minasidor.signalisten.se` | 0 | — |

Found by `gateway/tools/discover_portals.mjs`, which probed 65 candidate
landlords — the large private residential owners plus the largest
allmännyttiga company in each of the ~30 biggest kommuner — against
`mitt.`, `minasidor.`, `minasidor2.` and `www.` of each domain. 17 answered
with valid Arena JSON. Re-run it to refresh this table:

```sh
node gateway/tools/discover_portals.mjs --out report.json
```

It is deliberately slow and serial: one request at a time, a second apart, a
normal User-Agent, and HTTP 429 or 503 aborts the whole run. It probes hosts
in order and stops at a landlord's first hit, so a found portal costs one
request.

Tyresö Bostäder and Signalisten are included with **empty** lists — valid
Arena portals advertising nothing on the day. The ≥ 90 % coordinate test could
not be applied to them, so they are in on the argument that an empty portal
costs one KV key and contributes nothing, while records that do appear are
quality-checked at normalisation anyway. Drop them if you would rather only
carry portals that have proved themselves.

### The landlords with no Arena portal

48 of the 65 have none, and the reason is structural rather than a URL we
failed to guess: **most large allmännyttiga companies let through a shared
municipal queue, not their own site.**

| platform | landlords |
|---|---|
| Municipal queue — [bostad.stockholm.se](https://bostad.stockholm.se) | Stockholmshem, Svenska Bostäder, Familjebostäder (Sthlm), Förvaltaren, Telge, Huge, Botkyrkabyggen* |
| Municipal queue — [boplats.se](https://boplats.se) (Göteborg) | Poseidon, Bostadsbolaget, Familjebostäder Gbg |
| Municipal queue — [boplatssyd.se](https://www.boplatssyd.se) (Skåne) | MKB |
| Own site, not Arena (serves HTML, no JSON list endpoint) | Stena Fastigheter, SBB, Akelius, Aranäs, Uppsalahem, Hyresbostäder (Norrköping), ÖBO, KBAB, Kopparstaden, HFAB, Östersundshem, Eidar, ABK, Övikshem, Varbergs Bostad, Järfällahus |
| Own site, own JSON API (not Arena) | Willhem |
| Inconclusive — TLS handshake failed on every subdomain | Balder, Brinova, MKB, Skebo, Karlskronahem |
| Inconclusive — connect timeout | Familjebostäder Sthlm, Växjöbostäder, Huge Bostäder |
| No host resolved | Wallenstam, Rikshem, Einar Mattsson, Magnolia, Ikano, K-Fastigheter, Amasten, Graflunds, Lundbergs, Stångåstaden, Mimer, Bostaden (Umeå), Gavlegårdarna, Kfast, Tunabyggen, AB Bostäder i Borås |

\* Botkyrkabyggen has both a queue presence and its own Arena portal.

**No adapters are built for these.** The queues are a different kind of system
— you join a line and accrue days, and what is "available" depends on your
place in it — and modelling that as a listing feed would misrepresent it.

This is why **Stockholm and Göteborg look thin**: their municipal stock is let
through the queues, so the gateway sees only HomeQ there. A user comparing
Eskilstuna (226 listings) with Göteborg (7) is seeing a difference in *where
landlords advertise*, not in how much is for rent. The UI must not present a
listing count as a vacancy rate.

### Willhem (`willhem`)

[willhem.se](https://www.willhem.se) — a large private residential owner, ~645
flats across 13 cities. It runs Optimizely/Episerver and its Content Delivery
API is open:

```
GET /mvcapi/search-landing                       the 13 region pages
GET /api/episerver/v2.0/content/<regionId>/children   every VacantObjectPage
```

14 requests per refresh, done serially. The region ids are read from
`search-landing` rather than hard-coded, so a new Willhem city appears without
a code change.

**Correction to phase 4.** The discovery run classified Willhem as "own JSON
API, not Arena" because `/rentalobject/Listapartment/published` answered
HTTP 200 with JSON. That JSON is a *rendered 404 page*. Willhem has no Arena
portal and never did; the finding was a false positive, and the probe now has
a test for exactly this shape.

Traps:

- **`area` uses a Swedish decimal comma** — `"34,7"`. `Number("34,7")` is
  `NaN`, which silently nulled the size of 155 of 645 flats before it was
  handled. A comma here is never a thousands separator.
- **`noOfRooms` is prose**, `"2 rum & kök"`, so the room count has to be
  parsed out. Fractional counts (`"1.5 rum & kök"`) exist.
- **Properties are inconsistently wrapped.** `latitude` is
  `{value, propertyDataType}` while `rent` in the same object is a bare
  string.
- **Every image property is empty** on every record, so `image` is always
  `null`. There is no picture to link, and inventing a URL would be worse.
- `city`, `district` and `zipCode` are present in the schema and empty on
  every record; `area_name` therefore comes from the region page the flat was
  found under.

### Adding a source

One file in `gateway/src/sources/` exporting `SRC`, `SRC_LABEL`,
`fetchNearby(lat, lon, r, {signal})` and `fetchText(id, {signal})`, plus one
line in `SOURCES` in `src/index.js`. The envelope, timeout, error reporting and
CORS are handled for it. A source that cannot be queried by location belongs in
the Arena pattern instead: a snapshot plus an entry in `PORTALS`.

## Queue sources

### Bostadsförmedlingen i Stockholm (`bostadsformedlingen`)

```
GET https://bostad.stockholm.se/AllaAnnonser/
```

One request, every current advert in the Stockholm region with coordinates —
the feed the site's own map view reads. ~534 adverts across 26 kommuner
(Stockholm 155, Södertälje 59, Nacka 57, Botkyrka 45, …).

**These flats are real supply, but they are not open to whoever applies
first.** They are allocated by queue time: you register, accrue days, and the
flat goes to the applicant with the longest queue who applied before the
advert closed. Everything from this source therefore carries
`allocation: "queue"`, and everything from every other source carries
`allocation: "direct"`. A consumer that adds the two into one number is
counting two different things.

How different: the feed publishes, per advert, the first and third quartile of
queue time among recently let comparable flats. Across the whole feed the
median advert wants **3 years (Q1) to 8 years (Q3)**. Those quartiles are
passed through as `queue_years_q1` / `queue_years_q3` exactly as published —
no averaging into a single "expected queue time", because the spread is the
information.

Roughly a third of adverts are reserved for a group, which is `audience`:
student (87), youth (35), senior (7), short-term (8) at the time of writing.
They are kept rather than filtered, so the UI can choose.

Fields available and used: address, coordinates, rent, rooms, m², floor,
neighbourhood + kommun, new production, queue name, publish date and
`apply_by`. **Not available: the landlord.** The feed names no owner, so a
queue listing cannot be attributed to a specific company.

### Boplats Väst and Boplats Syd — not built, and why

Both were probed. Neither produced an adapter.

**Boplats Syd** (Malmö/Skåne, `boplatssyd.se`) redirects its "lediga bostäder"
page to `/mypages/app` — the listings sit behind a **login**. Per the standing
instruction this was stopped there rather than worked around, and no
credentialed access was attempted.

**Boplats Väst** (Göteborg, `boplats.se`) serves its listings as
server-rendered HTML with address, rent and size, but **no coordinates
anywhere in the payload** — the map is drawn from a source not exposed to the
page. Placing ~100 adverts would mean adding a geocoder, which is a new
external dependency and a new class of silent error (a mis-geocoded flat looks
exactly like a correct one). That is a decision worth taking deliberately
rather than as a side effect, so it is left open.

Consequence: **Göteborg and Malmö are still thin**, and for the same
structural reason as before — their municipal stock is let through queues this
gateway does not read.

## Campaign text and the `offer` field

Landlords prepend disclaimers and campaign terms to the ad, so the first 220
characters — all the dashboard shows — often described the offer, the photo
policy or the viewing procedure rather than the flat. Two rules fix that.

**1. The offer is lifted into its own field**, detected on the *untouched*
description, so stripping the campaign wording out of the excerpt does not lose
the fact that there is a campaign:

```json
"offer": { "flag": true, "snippet": "Kampanj Teckna ett hyresavtal med oss så bjuder vi på månadshyran i februari." }
```

Triggered by `kampanj`, `rabatt` (which covers `hyresrabatt`), `första
månaden` or `hyresfri`. The snippet is the source's own sentence, capped at
140 characters. **No amount is parsed out of the prose** — "2 000 kronor i
månaden under de första två åren" and "en del av månadshyran" are not the same
kind of claim, and flattening both to a number would invent precision.

HomeQ is different: it ships a structured discount object
(`{enabled, discount_type, duration, amount_type, amount}`), so its snippet is
composed from those fields instead — "3 400 kr rabatt per månad i 6 månader".
`enabled` is genuinely `false` on some records and those are not offers.

**2. Boilerplate is stripped from the head of the excerpt**, from the pattern
list in `gateway/src/boilerplate.js`. A pattern is only added when it is

- a phrase repeated **at least 20 times** in one portal's snapshot, **and**
- not a description of the flat.

The second condition is doing real work. Heimstaden's "Här bor du i en
välplanerad och modern tvåa…" repeats 73 times because a whole development
shares one text — it is repetitive, but it describes the flat, so it stays.
Patterns are anchored at the head and applied repeatedly, because the preamble
is a stack: campaign opener, campaign terms, rent-year disclaimer, then the
`Om lägenheten` section label, then finally the description.

Measured over all 19 portals, 2 009 descriptions (2026-09-24):

| | before | after |
|---|---|---|
| descriptions opening with boilerplate | 1 052 | **28** |

All of it was Heimstaden's and Victoriahem's: **the other 17 portals have no
boilerplate at all**, and no pattern fires on them. That is the point of the
"repeated phrase" rule — the list is tuned to two landlords' copywriting and
provably leaves everyone else's text alone. 457 of the 2 009 (23 %) carry an
offer.

HomeQ's own descriptions have not been corpus-analysed, because that would
mean one request per listing across ~6 400 ads. The same stripper runs on them
and simply does not match, so no HomeQ-specific patterns exist yet.

## Deduplication

The same flat can be advertised both by its landlord's own portal and on HomeQ.
A duplicate is detected when **street and number and room count agree exactly**,
size agrees within **1 m²**, and rent within **1 %** of the smaller of the two.

The portal record wins — it is the landlord's own data, carries floor and year
built, and links to where you apply — and the HomeQ twin is dropped, recorded on
the survivor as `also_on: ["homeq"]` plus `also_on_urls`. `deduped` in the
response counts HomeQ records folded away.

The rule is deliberately strict. A missed merge shows one flat twice, which is
untidy; a false merge hides a real flat and misstates the rent of the one it
kept. So a null on either side never matches, and HomeQ's fractional room counts
(1.5 rum) never match a portal's whole ones.

**How much it fires depends entirely on the landlord.**

| pair | same street+number | confirmed same flat |
|---|---:|---:|
| HomeQ × Willhem | 651 | **646** |
| HomeQ × the 19 Arena portals | 15 | **0** |

Willhem advertises *every* one of its flats on HomeQ — `isHomeQApartment` is
true on all 645 — so almost every Willhem listing has a HomeQ twin, and the
matcher finds 646 of the 651 candidate pairs. The five it rejects are visibly
different flats at the same address (1 rum / 18 m² against 2 rum / 70 m², and
so on), which is the rule working, not failing. Rent and size agree *exactly*
in the matched pairs, so the tolerances are not carrying the match.

Heimstaden and Victoriahem, by contrast, do not cross-post at all: 15 shared
street numbers, none the same flat. Without Willhem the dedupe looked like
dead weight; with it, it removes 30 duplicates in Borås and 77 in Eskilstuna
on a single 1 km query.

About 1.5 % of HomeQ addresses (97 of 6 448) are property names like
"Kv. Vulkanen" rather than street addresses and can never be matched.

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

1. **The only stored thing is the source snapshot.** One KV namespace, one key
   per snapshot source (`arena:<src>` for the 19 portals, `snapshot:<src>` for
   Willhem and Bostadsförmedlingen — 21 in all), each the latest vacancy list,
   overwritten hourly. **Latest only: no history, no time series,
   no per-user data, nothing else.** Keeping a history would turn the gateway
   into a database of someone else's listings, which is the thing rule 4 exists
   to prevent; and a vacancy series is not a market statistic — flats leave the
   list when let *and* when withdrawn, and the two are indistinguishable from
   outside. HomeQ is proxied live and never stored.

   Beyond that, the only persistence is Cloudflare's edge cache: 1 h for
   `/text`, 60 s for `/nearby`
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
6. **8 s per source** on a request, enforced with `AbortSignal.timeout`; one slow
   source cannot hold the response. The hourly refresh gets 25 s, since it pulls
   12 MB with no user waiting.
7. **A snapshot older than 3 h is not served.** It is reported `ok:false`
   with a `stale` error instead. Showing a stale vacancy as current is the one
   failure mode a user would actually act on.
8. **Queue supply is labelled, never merged into direct supply.** Every
   listing carries `allocation`, and `/nearby` returns the split. A queue flat
   is real, but it is not available to a reader who has not been queuing for
   years, and presenting the two as one number would misrepresent both.
9. **No source is accessed behind a login.** Boplats Syd was dropped for this
   reason rather than worked around.

Licensing is the reason for 1–4. The SCB data behind the rest of the dashboard is
CC0; these listings are not ours, and the gateway's job is to point at them, not
to accumulate them.

## Development

```sh
npm --prefix gateway test     # 135 unit tests, no network (one takes 8 s: the timeout budget)
cd gateway && npx wrangler dev
```

The tests cover the box maths, the haversine trim, both normalisation schemas,
the dedupe rules, snapshot staleness, boilerplate stripping, offer detection,
the refresh endpoint's authorisation and the failure envelope — with `fetch`, `caches` and KV stubbed. They never touch
the network, so they neither depend on the sources being up nor add load to
them. The Arena fixture in `test/fixtures/arena.js` is synthetic but reproduces
the real payload's structure, including `data`-as-a-string, entity-escaped
Swedish text, `YearBuilt: 0` and `0,0` coordinates.

Live smoke test:

```sh
B=https://am-se-listings.am-se-listings-gateway.workers.dev
curl "$B/nearby?lat=59.3165&lon=18.0335&r=500"    # Slussen
curl "$B/nearby?lat=59.3710&lon=16.5090&r=1000"   # Eskilstuna centrum
curl "$B/nearby?lat=58.5877&lon=16.1924&r=1000"   # Norrkoping centrum
curl "$B/nearby?lat=55.6953&lon=13.2290&r=1000"   # Lund, Rabylund
curl "$B/nearby?lat=59.2370&lon=15.2370&r=1000"   # Orebro, Brickebacken
```

`wrangler dev` runs the cron locally too:

```sh
curl "http://127.0.0.1:8787/__scheduled?cron=7+*+*+*+*"
```

## Operations

The hourly cron (`7 * * * *`, offset off the hour) rebuilds both snapshots. To
force one immediately, call `/admin/refresh` with the bearer secret — see the
endpoint above. `wrangler tail` shows each run's per-portal counts.

A first deploy to a fresh account needs the KV namespace created and bound:

```sh
npx wrangler kv namespace create LISTINGS_KV   # then put the id in wrangler.toml
npx wrangler secret put REFRESH_SECRET         # any long random string
```

## Known limits

- **`/nearby` reads every snapshot on every request** — 21 KV reads and about
  2.2 MB of JSON parsed per call. It answers in 0.3–0.9 s today, but this
  grows linearly with the portal count. A combined, spatially bucketed index
  would be the fix if the register keeps growing.
- **A listing count is not a vacancy rate.** Coverage depends on where a
  landlord chooses to advertise, and the municipal queues are invisible here.
- **An advertised rent is not a contract rent** and is not comparable with the
  SCB rent statistics on the same area page.
- Tyresö Bostäder and Signalisten are registered on an unverified coordinate
  share (both were empty at discovery).
- **Göteborg and Malmö remain thin.** Boplats Väst has no coordinates and
  Boplats Syd is behind a login, so their municipal supply is not represented.
- Queue listings have no landlord attribution — the feed does not name one.

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
