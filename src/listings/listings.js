/* AM Dashboard — Sweden edition · the Listings page.
 *
 * Reads the listings gateway (gateway/, deployed to workers.dev) and draws
 * what is advertised near a point. Standalone: it shares src/style.css tokens
 * and the vendored Leaflet with the dashboard but touches none of its code.
 *
 * The whole view — pin, radius, filters, sort — lives in the URL hash, so a
 * link reproduces exactly what the sender was looking at. Nothing is stored.
 */
"use strict";
(function () {
  const GATEWAY = "https://am-se-listings.am-se-listings-gateway.workers.dev";

  const V = window.LISTINGS_VIEW;
  const parseLocation = window.parseLocation;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nf = (v, d = 0) => v == null || !Number.isFinite(v) ? "–"
    : v.toLocaleString("sv-SE", { minimumFractionDigits: d, maximumFractionDigits: d });

  /* ---- state ---- */

  const S = {
    lat: null, lon: null, r: 500,
    filters: JSON.parse(JSON.stringify(V.DEFAULT_FILTERS)),
    sort: "dist", desc: false,
    body: null, error: null, loading: false, open: null,
  };

  /* The hash is the only place state lives. Booleans are 1/0 and lists are
     comma-separated, so a pasted link stays readable. */
  function writeHash() {
    const f = S.filters;
    const q = [];
    if (S.lat != null) q.push(`at=${S.lat.toFixed(6)},${S.lon.toFixed(6)}`);
    q.push(`r=${S.r}`);
    if (f.groups.length !== 3) q.push(`g=${f.groups.join(",")}`);
    if (f.allocation.length !== 2) q.push(`al=${f.allocation.join(",")}`);
    if (f.rooms.length) q.push(`rm=${f.rooms.join(",")}`);
    if (f.showReserved) q.push("res=1");
    if (f.offerOnly) q.push("offer=1");
    if (f.sources) q.push(`src=${f.sources.join(",")}`);
    if (S.sort !== "dist" || S.desc) q.push(`sort=${S.sort}${S.desc ? ":d" : ""}`);
    const h = q.join("&");
    if (("#" + h) !== location.hash) history.replaceState(null, "", "#" + h);
  }

  function readHash() {
    const h = location.hash.replace(/^#/, "");
    if (!h) return;
    const q = Object.fromEntries(h.split("&").filter(Boolean).map((p) => {
      const i = p.indexOf("="); return i < 0 ? [p, ""] : [p.slice(0, i), decodeURIComponent(p.slice(i + 1))];
    }));
    if (q.at) {
      const [a, b] = q.at.split(",").map(Number);
      if (Number.isFinite(a) && Number.isFinite(b)) { S.lat = a; S.lon = b; }
    }
    if (q.r) { const r = Number(q.r); if ([500, 1000, 2000].includes(r)) S.r = r; }
    const f = S.filters;
    if (q.g) f.groups = q.g.split(",").filter(Boolean);
    if (q.al) f.allocation = q.al.split(",").filter(Boolean);
    if (q.rm) f.rooms = q.rm.split(",").filter(Boolean);
    if (q.src) f.sources = q.src.split(",").filter(Boolean);
    f.showReserved = q.res === "1";
    f.offerOnly = q.offer === "1";
    if (q.sort) { const [k, d] = q.sort.split(":"); S.sort = k; S.desc = d === "d"; }
  }

  /* ---- the gateway ---- */

  async function load() {
    if (S.lat == null) return;
    S.loading = true; S.error = null; render();
    try {
      const res = await fetch(`${GATEWAY}/nearby?lat=${S.lat}&lon=${S.lon}&r=${S.r}`, { headers: { accept: "application/json" } });
      const body = await res.json().catch(() => null);
      if (!res.ok && !body) throw new Error(`the gateway answered HTTP ${res.status}`);
      /* A 502 still carries the source-by-source reasons, so it is rendered
         rather than thrown away — the strip must say which source failed. */
      S.body = body;
      if (!body || !Array.isArray(body.listings)) throw new Error("the gateway sent something unexpected");
    } catch (err) {
      S.body = null;
      S.error = `Could not reach the listings gateway (${err.message}). It may be down, or this page may be served from an origin it does not allow.`;
    } finally {
      S.loading = false; render();
    }
  }

  const textCache = new Map();
  async function loadText(l) {
    const key = `${l.src}:${l.id}`;
    if (textCache.has(key)) return textCache.get(key);
    const p = fetch(`${GATEWAY}/text?src=${encodeURIComponent(l.src)}&id=${encodeURIComponent(l.id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j && j.text_start) || null)
      .catch(() => null);
    textCache.set(key, p);
    return p;
  }

  /* ---- map ---- */

  let map = null, layer = null, pinLayer = null;
  const markerOf = new Map();

  function ensureMap() {
    if (map) return;
    map = L.map("lst-map", { scrollWheelZoom: true, attributionControl: true })
      .setView([S.lat ?? 59.33, S.lon ?? 18.06], 14);
    /* The same basemap the dashboard uses — OSM's own tiles, no API key.
       CARTO's used to be the obvious light basemap but now answers with an
       "API KEY REQUIRED" tile, which renders as a watermark across the map.
       detectRetina asks for 2x tiles so the labels are not blurred on a
       retina display, exactly as app.js does it. */
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18, maxNativeZoom: 19, detectRetina: true, className: "basemap",
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    }).addTo(map);
    layer = L.layerGroup().addTo(map);
    pinLayer = L.layerGroup().addTo(map);
  }

  function drawMap(shown) {
    ensureMap();
    layer.clearLayers(); pinLayer.clearLayers(); markerOf.clear();
    if (S.lat == null) return;

    L.marker([S.lat, S.lon], {
      icon: L.divIcon({ className: "", html: '<div class="lst-pin" style="width:16px;height:16px"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }),
      zIndexOffset: 1000, keyboard: false,
    }).addTo(pinLayer);
    L.circle([S.lat, S.lon], { radius: S.r, color: "#16170F", weight: 1, opacity: .35, fillOpacity: .03 }).addTo(pinLayer);

    const colour = Object.fromEntries(V.GROUPS.map((g) => [g.key, g.color]));
    /* Listings on a shared point are fanned out, never stacked — otherwise the
       one on top is the only one a reader can ever click. */
    for (const cluster of V.clusterByPoint(shown)) {
      const offs = V.spiderOffsets(cluster.length, cluster[0].lat);
      cluster.forEach((l, i) => {
        const [dLat, dLon] = offs[i];
        const m = L.marker([l.lat + dLat, l.lon + dLon], {
          icon: L.divIcon({
            className: "",
            html: `<div class="lst-mk" style="width:13px;height:13px;background:${colour[V.groupOf(l)]}"></div>`,
            iconSize: [13, 13], iconAnchor: [6.5, 6.5],
          }),
          title: `${l.address || ""} · ${l.src_label || l.src}`,
        }).addTo(layer);
        if (cluster.length > 1) {
          L.polyline([[l.lat, l.lon], [l.lat + dLat, l.lon + dLon]],
            { color: colour[V.groupOf(l)], weight: 1, opacity: .5 }).addTo(layer);
        }
        m.bindPopup(cardHtml(l), { maxWidth: 320, minWidth: 300 });
        m.on("popupopen", () => fillText(l));
        markerOf.set(l.src + ":" + l.id, m);
      });
    }
    map.setView([S.lat, S.lon], S.r <= 500 ? 16 : S.r <= 1000 ? 15 : 14);
  }

  /* ---- the card ---- */

  function badges(l) {
    const b = [];
    if (l.offer && l.offer.flag) b.push(`<span class="lst-bdg offer" title="${esc(l.offer.snippet || "")}">Kampanj</span>`);
    if (l.allocation === "queue") {
      const q = (l.queue_years_q1 != null && l.queue_years_q3 != null)
        ? `Kö: ${l.queue_years_q1}–${l.queue_years_q3} år`
        : "Kö: köad tid avgör";
      b.push(`<span class="lst-bdg queue" title="Allocated by queue time, not first come first served">${esc(q)}</span>`);
    }
    if (Array.isArray(l.also_on) && l.also_on.length) {
      const u = (l.also_on_urls && l.also_on_urls.homeq) || null;
      b.push(u ? `<a class="lst-bdg also" href="${esc(u)}" target="_blank" rel="noopener">Also on HomeQ ›</a>`
                : `<span class="lst-bdg also">Also on ${esc(l.also_on.join(", "))}</span>`);
    }
    /* Boplats Väst publishes a position for the property, not the entrance,
       and several adverts can share one point. Saying so on the card is the
       difference between a dot that is approximate and a dot that lies. */
    if (l.src === "boplatsvast") b.push('<span class="lst-bdg pos" title="The source gives one position per property, not per entrance">Position: property-level</span>');
    if (l.audience) b.push(`<span class="lst-bdg">${esc(V.AUDIENCE_LABEL[l.audience] || l.audience)}</span>`);
    return b.join("");
  }

  function cardHtml(l) {
    const m2 = V.sekPerM2Year(l);
    const sub = [l.area_name, l.landlord].filter(Boolean).join(" · ") || l.src_label || l.src;
    const img = l.image
      ? `<img class="img" src="${esc(l.image)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=\\'noimg\\'>no photo</div>'">`
      : '<div class="noimg">no photo</div>';
    return `<div class="lst-card" data-card="${esc(l.src)}:${esc(l.id)}">
      ${img}
      <div class="pad">
        <h3>${esc(l.address || "Address not given")}</h3>
        <div class="sub">${esc(sub)} · ${esc(l.src_label || l.src)}</div>
        <div class="facts">
          <div><i>Rent</i> ${l.rent_sek_mo != null ? nf(l.rent_sek_mo) + " kr/mån" : "–"}</div>
          <div><i>Size</i> ${l.size_m2 != null ? nf(l.size_m2, 1) + " m²" : "–"}</div>
          <div><i>Rooms</i> ${l.rooms != null ? nf(l.rooms, l.rooms % 1 ? 1 : 0) : "–"}</div>
          <div><i>Floor</i> ${l.floor != null ? nf(l.floor) : "–"}</div>
          <div><i>SEK/m²/yr</i> ${m2 != null ? nf(m2) : "–"}</div>
          <div><i>From</i> ${esc(l.available_from || "–")}</div>
        </div>
        <div class="badges">${badges(l)}</div>
        <div class="text" data-text>…</div>
        <a class="open" href="${esc(l.url || "#")}" target="_blank" rel="noopener">Open listing ›</a>
      </div></div>`;
  }

  async function fillText(l) {
    const node = document.querySelector(`[data-card="${CSS.escape(l.src + ":" + l.id)}"] [data-text]`);
    if (!node) return;
    if (l.text_start) { node.textContent = l.text_start; return; }
    node.textContent = "…";
    const t = await loadText(l);
    if (!document.body.contains(node)) return;
    if (t) node.textContent = t;
    else {
      node.classList.add("muted");
      node.innerHTML = `Listing text isn't available here. <a href="${esc(l.url || "#")}" target="_blank" rel="noopener">Read the full listing ›</a>`;
    }
  }

  /* ---- chrome ---- */

  function renderStrip() {
    const el = $("lst-strip");
    if (!S.body) { el.innerHTML = ""; return; }
    el.innerHTML = V.sourceChips(S.body).map((c) => {
      const cls = c.ok ? (c.count ? "" : "zero") : (c.stale ? "warn" : "bad");
      const right = c.ok
        ? `<b>${c.count}</b>${c.live ? '<span class="age">live</span>' : c.age ? `<span class="age">${esc(c.age)}</span>` : ""}`
        : `<span class="age">${esc(c.stale ? "stale" : "error")}</span>`;
      return `<span class="lst-chip ${cls}" title="${esc(c.error || (c.live ? "queried live" : "snapshot " + (c.age || "")))}"><span class="dot"></span>${esc(c.src)} ${right}</span>`;
    }).join("");
  }

  function tog(on, attrs, label) {
    return `<button class="lst-tog${attrs.sub ? " sub" : ""}" aria-pressed="${on}" ${attrs.data}>${attrs.swatch || ""}${label}</button>`;
  }

  function renderFilters() {
    const f = S.filters;
    const all = (S.body && S.body.listings) || [];
    const bySrc = {};
    for (const l of all) bySrc[l.src] = (bySrc[l.src] || 0) + 1;

    const groupBtns = V.GROUPS.map((g) => {
      const n = all.filter((l) => V.groupOf(l) === g.key).length;
      return tog(f.groups.includes(g.key), {
        data: `data-group="${g.key}"`,
        swatch: `<span class="swatch" style="background:${g.color}"></span>`,
      }, `${esc(g.label)} <span style="opacity:.65">${n}</span>`);
    }).join("");

    const srcBtns = Object.keys(bySrc).sort().map((src) => {
      const on = !f.sources || f.sources.includes(src);
      return tog(on, { data: `data-src="${esc(src)}"`, sub: true }, `${esc(src)} ${bySrc[src]}`);
    }).join("");

    const roomBtns = ["1", "2", "3", "4+"].map((b) =>
      tog(f.rooms.includes(b), { data: `data-room="${b}"`, sub: true }, b + " rum")).join("");

    const hidden = V.hiddenCounts(all, f);

    $("lst-filters").innerHTML = `
      <div class="lst-fgroup"><span>Source group</span>${groupBtns}</div>
      <div class="lst-fgroup"><span>Allocation</span>
        ${tog(f.allocation.includes("direct"), { data: 'data-alloc="direct"', sub: true }, "Direct")}
        ${tog(f.allocation.includes("queue"), { data: 'data-alloc="queue"', sub: true }, "Queue")}
      </div>
      <div class="lst-fgroup"><span>Rooms</span>${roomBtns}</div>
      <div class="lst-fgroup"><span>Show</span>
        ${tog(f.offerOnly, { data: 'data-offer="1"', sub: true }, "Kampanj only")}
        ${tog(f.showReserved, { data: 'data-res="1"', sub: true }, `Reserved (student/ungdom/senior)${hidden.reserved && !f.showReserved ? " · " + hidden.reserved + " hidden" : ""}`)}
      </div>
      <div class="lst-fgroup"><span>Sources</span>${srcBtns}</div>`;
  }

  function renderLegend() {
    $("lst-legend").innerHTML = V.GROUPS.map((g) =>
      `<span class="k"><span class="swatch" style="background:${g.color}"></span>${esc(g.label)}</span>`).join("")
      + '<span class="k" style="color:var(--dim)">Lines join listings that share one position.</span>';
  }

  const COLS = [
    ["src", "Source", 0], ["address", "Address", 0], ["area_name", "Area", 0],
    ["rooms", "Rooms", 1], ["size", "m²", 1], ["rent", "SEK/mån", 1],
    ["m2yr", "SEK/m²/yr", 1], ["dist", "m", 1], ["available_from", "From", 0],
  ];

  function renderTable(shown) {
    const rows = V.sortListings(shown, S.sort, S.desc);
    const colour = Object.fromEntries(V.GROUPS.map((g) => [g.key, g.color]));
    $("lst-count").textContent = `— ${rows.length} shown`;
    $("lst-table").innerHTML =
      `<thead><tr>${COLS.map(([k, label, num]) =>
        `<th class="${num ? "num" : ""}" data-sort="${k}">${esc(label)}${S.sort === k ? (S.desc ? " ▾" : " ▴") : ""}</th>`).join("")}</tr></thead>
       <tbody>${rows.map((l) => {
        const m2 = V.sekPerM2Year(l);
        return `<tr data-row="${esc(l.src)}:${esc(l.id)}">
          <td><span class="srcdot" style="background:${colour[V.groupOf(l)]}"></span>${esc(l.src)}</td>
          <td>${esc(l.address || "–")}</td>
          <td>${esc(l.area_name || "–")}</td>
          <td class="num">${l.rooms != null ? nf(l.rooms, l.rooms % 1 ? 1 : 0) : "–"}</td>
          <td class="num">${l.size_m2 != null ? nf(l.size_m2, 1) : "–"}</td>
          <td class="num">${l.rent_sek_mo != null ? nf(l.rent_sek_mo) : "–"}</td>
          <td class="num">${m2 != null ? nf(m2) : "–"}</td>
          <td class="num">${l.dist_m != null ? nf(l.dist_m) : "–"}</td>
          <td>${esc(l.available_from || "–")}</td></tr>`;
      }).join("")}</tbody>`;
  }

  function renderMedians(shown) {
    const med = V.mediansByRooms(shown);
    const el = $("lst-medians");
    if (!med.length) { el.innerHTML = '<div style="color:var(--muted);font-size:12px">Nothing to summarise yet.</div>'; return; }
    el.innerHTML = med.map((m) => m.suppressed
      ? `<div class="m sup"><b>–</b><span>${esc(m.rooms)} rum · n=${m.n}, too few</span></div>`
      : `<div class="m"><b>${nf(m.median)}</b><span>${esc(m.rooms)} rum · n=${m.n}</span></div>`).join("");
  }

  function renderNote() {
    const el = $("lst-note");
    if (S.error) { el.innerHTML = `<div class="lst-msg err">${esc(S.error)}</div>`; return; }
    if (S.loading) { el.innerHTML = '<div class="lst-msg info">Loading…</div>'; return; }
    if (S.lat == null) {
      el.innerHTML = '<div class="lst-msg info">Paste a Google Maps link or a "59.3165, 18.0335" pair to begin. Try <a href="#at=59.371000,16.509000&r=1000">Eskilstuna centrum</a>, <a href="#at=57.700700,11.968600&r=2000">Göteborg centrum</a> or <a href="#at=59.315700,18.030000&r=500">Hornstull</a>.</div>';
      return;
    }
    const bad = ((S.body && S.body.sources) || []).filter((s) => s.ok === false);
    el.innerHTML = bad.length
      ? `<div class="lst-msg err"><b>${bad.length} source${bad.length > 1 ? "s" : ""} did not answer.</b> The counts below exclude ${bad.length > 1 ? "them" : "it"}: ${bad.map((s) => `${esc(s.src)} — ${esc(s.error || "failed")}`).join("; ")}</div>`
      : "";
  }

  function render() {
    /* Chrome restores a text field's previous value on reload, after this
       script has run, so the box can end up naming a different place from the
       one on the map. Re-syncing it from state on every render settles that —
       except while it has focus, which would fight someone typing. */
    const box = $("lst-input");
    if (S.lat != null && document.activeElement !== box) box.value = `${S.lat}, ${S.lon}`;
    renderNote();
    renderStrip();
    if (!S.body) { $("lst-filters").innerHTML = ""; $("lst-legend").innerHTML = ""; $("lst-table").innerHTML = ""; $("lst-medians").innerHTML = ""; $("lst-count").textContent = ""; if (map) { layer && layer.clearLayers(); pinLayer && pinLayer.clearLayers(); } return; }
    const shown = V.applyFilters(S.body.listings, S.filters);
    renderFilters(); renderLegend();
    drawMap(shown); renderTable(shown); renderMedians(shown);
    for (const b of document.querySelectorAll("#lst-radius button")) b.setAttribute("aria-pressed", String(Number(b.dataset.r) === S.r));
    writeHash();
  }

  /* ---- events ---- */

  function submit() {
    const res = parseLocation($("lst-input").value);
    if (!res) return;
    if (res.error) { S.error = res.message; S.body = null; render(); return; }
    S.lat = res.lat; S.lon = res.lon; S.error = null;
    load();
  }

  function toggleIn(list, value) {
    const i = list.indexOf(value);
    if (i < 0) list.push(value); else list.splice(i, 1);
    return list;
  }

  document.addEventListener("click", (e) => {
    const t = e.target.closest("button, th[data-sort], tr[data-row]");
    if (!t) return;
    const f = S.filters;

    if (t.id === "lst-go") return submit();
    if (t.id === "lst-csv") return downloadCsv();
    if (t.dataset.r) { S.r = Number(t.dataset.r); return load(); }
    if (t.dataset.group) { toggleIn(f.groups, t.dataset.group); return render(); }
    if (t.dataset.alloc) { toggleIn(f.allocation, t.dataset.alloc); return render(); }
    if (t.dataset.room) { toggleIn(f.rooms, t.dataset.room); return render(); }
    if (t.dataset.offer) { f.offerOnly = !f.offerOnly; return render(); }
    if (t.dataset.res) { f.showReserved = !f.showReserved; return render(); }
    if (t.dataset.src) {
      const all = [...new Set((S.body.listings || []).map((l) => l.src))];
      if (!f.sources) f.sources = all.slice();
      toggleIn(f.sources, t.dataset.src);
      if (f.sources.length === all.length) f.sources = null;
      return render();
    }
    if (t.dataset.sort) {
      if (S.sort === t.dataset.sort) S.desc = !S.desc; else { S.sort = t.dataset.sort; S.desc = false; }
      return render();
    }
    if (t.dataset.row) {
      const m = markerOf.get(t.dataset.row);
      if (m) { map.setView(m.getLatLng(), Math.max(map.getZoom(), 16)); m.openPopup(); }
    }
  });

  $("lst-input").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

  function downloadCsv() {
    if (!S.body) return;
    const shown = V.sortListings(V.applyFilters(S.body.listings, S.filters), S.sort, S.desc);
    const blob = new Blob(["﻿" + V.toCsv(shown, S.body.fetchedAt)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `listings_${S.lat.toFixed(4)}_${S.lon.toFixed(4)}_r${S.r}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  window.addEventListener("hashchange", () => {
    const before = `${S.lat},${S.lon},${S.r}`;
    readHash();
    if (`${S.lat},${S.lon},${S.r}` !== before) load(); else render();
  });

  readHash();
  if (S.lat != null) load(); else render();
})();
