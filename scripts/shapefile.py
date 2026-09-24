#!/usr/bin/env python3
"""A minimal Esri shapefile reader — polygons and their attributes, stdlib only.

Generalised from scripts/clip_geo.py, which reads the OSM land polygons the same
way. Several of the climate sources ship as zipped shapefiles (SMHI's mean sea
level, MCF's flood extents), and adding a GIS dependency for a format that is
this simple to read would be the wrong trade.

Handles Polygon (5), PolygonZ (15) and PolygonM (25) — the Z and M variants put
their extra arrays AFTER the x/y points, so the x/y block is read identically and
the rest of the record is skipped by its own content length.

    from shapefile import read_shapefile
    for rings, attrs in read_shapefile(shp_bytes, dbf_bytes):
        ...
"""
from __future__ import annotations

import io
import struct

POLYGON_TYPES = {5, 15, 25}


def _rings(pts, parts, n_points):
    out = []
    for i, off in enumerate(parts):
        end = parts[i + 1] if i + 1 < len(parts) else n_points
        ring = [(pts[2 * j], pts[2 * j + 1]) for j in range(off, end)]
        if len(ring) >= 4:
            out.append(ring)
    return out


def read_dbf(data: bytes) -> list[dict]:
    """The attribute table beside a .shp. Only the field types these files use."""
    if not data or len(data) < 32:
        return []
    n_rec, hdr_len, rec_len = struct.unpack("<IHH", data[4:12])
    fields = []
    pos = 32
    while pos < hdr_len - 1 and data[pos] != 0x0D:
        raw = data[pos:pos + 32]
        name = raw[:11].split(b"\0")[0].decode("latin-1").strip()
        ftype = chr(raw[11])
        flen = raw[16]
        fields.append((name, ftype, flen))
        pos += 32
    out = []
    base = hdr_len
    for r in range(n_rec):
        start = base + r * rec_len
        row = data[start:start + rec_len]
        if not row or row[:1] == b"*":                 # deleted record
            continue
        rec, off = {}, 1
        for name, ftype, flen in fields:
            val = row[off:off + flen].decode("latin-1").strip()
            off += flen
            if ftype in "NF" and val:
                try:
                    rec[name] = float(val) if ("." in val or ftype == "F") else int(val)
                except ValueError:
                    rec[name] = val
            else:
                rec[name] = val
        out.append(rec)
    return out


def read_shapefile(shp: bytes, dbf: bytes | None = None, bbox=None):
    """Yield (rings, attrs). `bbox` is (x0, y0, x1, y1) in the file's own CRS."""
    attrs = read_dbf(dbf) if dbf else []
    fh = io.BytesIO(shp)
    size = len(shp)
    fh.seek(100)
    idx = -1
    while fh.tell() < size:
        head = fh.read(8)
        if len(head) < 8:
            break
        _num, words = struct.unpack(">ii", head)
        content = words * 2
        start = fh.tell()
        idx += 1
        shape_type = struct.unpack("<i", fh.read(4))[0]
        if shape_type not in POLYGON_TYPES:
            fh.seek(start + content)
            continue
        bx0, by0, bx1, by1 = struct.unpack("<4d", fh.read(32))
        if bbox and (bx1 < bbox[0] or bx0 > bbox[2] or by1 < bbox[1] or by0 > bbox[3]):
            fh.seek(start + content)
            continue
        n_parts, n_points = struct.unpack("<ii", fh.read(8))
        pbuf = fh.read(4 * n_parts)
        xbuf = fh.read(16 * n_points)
        # a truncated file (a partial download, or a slice taken for a test)
        # stops here rather than raising out of the middle of a record
        if len(pbuf) < 4 * n_parts or len(xbuf) < 16 * n_points:
            break
        parts = struct.unpack(f"<{n_parts}i", pbuf)
        pts = struct.unpack(f"<{2 * n_points}d", xbuf)
        rings = _rings(pts, parts, n_points)
        # PolygonZ/M carry their Z and M arrays after the x/y block; the record's
        # own content length is what moves us to the next record, not our reading
        fh.seek(start + content)
        if rings:
            yield rings, (attrs[idx] if idx < len(attrs) else {})


def from_zip(zbytes: bytes, bbox=None):
    """Read the first .shp/.dbf pair inside a zip."""
    import zipfile
    z = zipfile.ZipFile(io.BytesIO(zbytes))
    shp_name = next((n for n in z.namelist() if n.lower().endswith(".shp")), None)
    if not shp_name:
        return
    dbf_name = shp_name[:-4] + ".dbf"
    dbf = z.read(dbf_name) if dbf_name in z.namelist() else None
    yield from read_shapefile(z.read(shp_name), dbf, bbox)
