/* The snapshot sources: every source that cannot be queried by location and
 * is therefore refreshed hourly into KV instead of proxied live.
 *
 * Three shapes behind one interface:
 *   - the 19 Arena portals, which share one adapter and differ only by host
 *   - Willhem, whose Episerver API needs one request per region
 *   - Bostadsförmedlingen, the Stockholm municipal queue
 *
 * Each entry exposes {src, label, allocation, kvKey, fetch, selectNearby} so
 * index.js does not care which kind it is.
 */
"use strict";

import * as arena from "./sources/arena.js";
import * as willhem from "./sources/willhem.js";
import * as bostadsformedlingen from "./sources/bostadsformedlingen.js";

export const SNAPSHOT_SOURCES = [
  ...arena.PORTALS.map((portal) => ({
    src: portal.src,
    label: portal.label,
    allocation: "direct",
    kvKey: arena.kvKey(portal.src),
    fetch: (opts) => arena.fetchPortal(portal, opts),
    selectNearby: arena.selectNearby,
  })),
  {
    src: willhem.SRC,
    label: willhem.SRC_LABEL,
    allocation: willhem.ALLOCATION,
    kvKey: `snapshot:${willhem.SRC}`,
    fetch: (opts) => willhem.fetchSnapshot(opts),
    selectNearby: willhem.selectNearby,
  },
  {
    src: bostadsformedlingen.SRC,
    label: bostadsformedlingen.SRC_LABEL,
    allocation: bostadsformedlingen.ALLOCATION,
    kvKey: `snapshot:${bostadsformedlingen.SRC}`,
    fetch: (opts) => bostadsformedlingen.fetchSnapshot(opts),
    selectNearby: bostadsformedlingen.selectNearby,
  },
];

export const bySrc = (src) => SNAPSHOT_SOURCES.find((s) => s.src === src);

/* Staleness is a property of a snapshot, not of the adapter that wrote it —
 * re-exported here so callers do not reach into the Arena module for it. */
export { isStale, STALE_AFTER_MS } from "./sources/arena.js";
