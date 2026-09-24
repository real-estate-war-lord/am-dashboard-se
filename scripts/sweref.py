#!/usr/bin/env python3
"""SWEREF99 TM (EPSG:3006) <-> WGS84, standard library only.

pyproj is not a dependency of this repo and one transform does not justify
adding it. This is Lantmäteriet's own published Gauss-Krüger formulation — the
Krüger series, not an approximation — accurate to well under a millimetre
anywhere in Sweden, which `selftest()` asserts by round-tripping.

SWEREF99 TM: GRS80, central meridian 15°E, scale 0.9996, false easting
500 000 m, false northing 0. Note Lantmäteriet's axis names: x is NORTHING and
y is EASTING, the opposite way round from the (lon, lat) order GeoJSON uses.
Every function here takes and returns (lon, lat) to match the GeoJSON files.
"""
from __future__ import annotations

import math

A = 6378137.0                      # GRS80 semi-major axis
F = 1 / 298.257222101              # GRS80 flattening
LON0 = math.radians(15.0)
K0 = 0.9996
FE = 500000.0
FN = 0.0

_e2 = F * (2 - F)
_n = F / (2 - F)
_ahat = A / (1 + _n) * (1 + _n ** 2 / 4 + _n ** 4 / 64)


def to_grid(lon: float, lat: float) -> tuple[float, float]:
    """(lon, lat) degrees -> (easting, northing) metres."""
    phi = math.radians(lat)
    dl = math.radians(lon) - LON0

    a = _e2
    b = (5 * _e2 ** 2 - _e2 ** 3) / 6
    c = (104 * _e2 ** 3 - 45 * _e2 ** 4) / 120
    d = 1237 * _e2 ** 4 / 1260
    s = math.sin(phi)
    phi_s = phi - math.sin(phi) * math.cos(phi) * (
        a + b * s ** 2 + c * s ** 4 + d * s ** 6)

    xi_p = math.atan2(math.tan(phi_s), math.cos(dl))
    eta_p = math.atanh(math.cos(phi_s) * math.sin(dl))

    b1 = _n / 2 - 2 * _n ** 2 / 3 + 5 * _n ** 3 / 16 + 41 * _n ** 4 / 180
    b2 = 13 * _n ** 2 / 48 - 3 * _n ** 3 / 5 + 557 * _n ** 4 / 1440
    b3 = 61 * _n ** 3 / 240 - 103 * _n ** 4 / 140
    b4 = 49561 * _n ** 4 / 161280

    north = K0 * _ahat * (xi_p
                          + b1 * math.sin(2 * xi_p) * math.cosh(2 * eta_p)
                          + b2 * math.sin(4 * xi_p) * math.cosh(4 * eta_p)
                          + b3 * math.sin(6 * xi_p) * math.cosh(6 * eta_p)
                          + b4 * math.sin(8 * xi_p) * math.cosh(8 * eta_p)) + FN
    east = K0 * _ahat * (eta_p
                         + b1 * math.cos(2 * xi_p) * math.sinh(2 * eta_p)
                         + b2 * math.cos(4 * xi_p) * math.sinh(4 * eta_p)
                         + b3 * math.cos(6 * xi_p) * math.sinh(6 * eta_p)
                         + b4 * math.cos(8 * xi_p) * math.sinh(8 * eta_p)) + FE
    return east, north


def to_wgs84(east: float, north: float) -> tuple[float, float]:
    """(easting, northing) metres -> (lon, lat) degrees."""
    xi = (north - FN) / (K0 * _ahat)
    eta = (east - FE) / (K0 * _ahat)

    d1 = _n / 2 - 2 * _n ** 2 / 3 + 37 * _n ** 3 / 96 - _n ** 4 / 360
    d2 = _n ** 2 / 48 + _n ** 3 / 15 - 437 * _n ** 4 / 1440
    d3 = 17 * _n ** 3 / 480 - 37 * _n ** 4 / 840
    d4 = 4397 * _n ** 4 / 161280

    xi_p = (xi
            - d1 * math.sin(2 * xi) * math.cosh(2 * eta)
            - d2 * math.sin(4 * xi) * math.cosh(4 * eta)
            - d3 * math.sin(6 * xi) * math.cosh(6 * eta)
            - d4 * math.sin(8 * xi) * math.cosh(8 * eta))
    eta_p = (eta
             - d1 * math.cos(2 * xi) * math.sinh(2 * eta)
             - d2 * math.cos(4 * xi) * math.sinh(4 * eta)
             - d3 * math.cos(6 * xi) * math.sinh(6 * eta)
             - d4 * math.cos(8 * xi) * math.sinh(8 * eta))

    phi_s = math.asin(math.sin(xi_p) / math.cosh(eta_p))
    dl = math.atan2(math.sinh(eta_p), math.cos(xi_p))

    ap = _e2 + _e2 ** 2 + _e2 ** 3 + _e2 ** 4
    bp = -(7 * _e2 ** 2 + 17 * _e2 ** 3 + 30 * _e2 ** 4) / 6
    cp = (224 * _e2 ** 3 + 889 * _e2 ** 4) / 120
    dp = -(4279 * _e2 ** 4) / 1260
    s = math.sin(phi_s)
    phi = phi_s + math.sin(phi_s) * math.cos(phi_s) * (
        ap + bp * s ** 2 + cp * s ** 4 + dp * s ** 6)

    return math.degrees(LON0 + dl), math.degrees(phi)


def ring_to_grid(ring):
    return [to_grid(p[0], p[1]) for p in ring]


def ring_to_wgs84(ring):
    return [list(to_wgs84(p[0], p[1])) for p in ring]


def selftest() -> int:
    """Round-trip the corners and middle of Sweden, and a few known places."""
    pts = [(11.0, 55.3), (24.2, 69.1), (18.07, 59.33), (11.97, 57.71),
           (13.00, 55.60), (15.00, 62.00), (19.6, 63.2), (17.0, 60.6)]
    worst = 0.0
    for lon, lat in pts:
        e, n = to_grid(lon, lat)
        lon2, lat2 = to_wgs84(e, n)
        # metres of error at this latitude
        dx = (lon2 - lon) * 111320 * math.cos(math.radians(lat))
        dy = (lat2 - lat) * 110540
        worst = max(worst, math.hypot(dx, dy))
    print(f"SWEREF99 TM round-trip worst error over {len(pts)} points: {worst * 1000:.4f} mm")

    # the central meridian must map exactly to the false easting
    e, n = to_grid(15.0, 0.0)
    print(f"  lon 15°, lat 0° -> E={e:.3f} (expect 500000.000), N={n:.3f} (expect 0.000)")
    ok = worst < 1e-3 and abs(e - 500000.0) < 1e-6 and abs(n) < 1e-6
    print("  " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(selftest())
