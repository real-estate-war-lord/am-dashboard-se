#!/usr/bin/env python3
"""HTTP helpers shared by the fetchers: throttling, and one broken TLS chain.

`statistik.bra.se` presents the WRONG intermediate certificate. Its leaf is
issued by "DigiCert EV RSA CA G2", but the server sends "GeoTrust EV RSA CA
2018" alongside it, so the chain does not join up. curl on macOS happens to
succeed because the system keychain already holds the correct intermediate;
Python's ssl module does not, and fails with CERTIFICATE_VERIFY_FAILED.

The fix is emphatically NOT to switch verification off. Instead we fetch the
correct intermediate from the CA Issuers URL named in the leaf's own Authority
Information Access extension, cache it under data/external/raw/ca/, and add it
to an SSL context. The chain then joins a DigiCert root that is already trusted,
and verification stays on everywhere, not just on a Mac with a warm keychain.

    from http_util import get, bra_context
"""
from __future__ import annotations

import pathlib
import ssl
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
CA_DIR = ROOT / "data" / "external" / "raw" / "ca"

# Named in the leaf certificate's AIA extension, verified 2026-09-24:
#   CA Issuers - URI:http://cacerts.digicert.com/DigiCertEVRSACAG2.crt
BRA_INTERMEDIATE = "http://cacerts.digicert.com/DigiCertEVRSACAG2.crt"

UA = {"User-Agent": "am-dashboard-se/1.2 (+https://github.com/real-estate-war-lord)"}

_ctx_cache: dict[str, ssl.SSLContext] = {}


def _cached_ca(url: str) -> pathlib.Path:
    """Download a DER certificate once and keep it as PEM."""
    CA_DIR.mkdir(parents=True, exist_ok=True)
    pem = CA_DIR / (url.rsplit("/", 1)[-1].rsplit(".", 1)[0] + ".pem")
    if pem.exists() and pem.stat().st_size > 0:
        return pem
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        der = r.read()
    pem.write_text(ssl.DER_cert_to_PEM_cert(der), encoding="ascii")
    return pem


def context_with_ca(url: str) -> ssl.SSLContext:
    """A verifying context that also trusts the intermediate at `url`."""
    if url in _ctx_cache:
        return _ctx_cache[url]
    ctx = ssl.create_default_context()
    ctx.load_verify_locations(cafile=str(_cached_ca(url)))
    # verify_mode and check_hostname stay at their defaults — this adds a
    # certificate to the trust set, it does not weaken the check.
    _ctx_cache[url] = ctx
    return ctx


def bra_context() -> ssl.SSLContext:
    return context_with_ca(BRA_INTERMEDIATE)


class Throttle:
    """n calls per window, shared by whoever holds the instance."""

    def __init__(self, calls: int, window: float):
        self.calls, self.window, self.at = calls, window, []

    def wait(self) -> None:
        while True:
            now = time.monotonic()
            self.at = [t for t in self.at if now - t <= self.window]
            if len(self.at) < self.calls:
                self.at.append(now)
                return
            time.sleep(0.2)


def get(url: str, *, headers: dict | None = None, context: ssl.SSLContext | None = None,
        data: bytes | None = None, timeout: int = 45, tries: int = 3,
        throttle: Throttle | None = None) -> tuple[int, bytes, dict]:
    """GET (or POST when `data` is given). Returns (status, body, headers)."""
    h = dict(UA)
    if headers:
        h.update(headers)
    last = None
    for attempt in range(tries):
        if throttle:
            throttle.wait()
        try:
            req = urllib.request.Request(url, data=data, headers=h)
            with urllib.request.urlopen(req, timeout=timeout, context=context) as r:
                return r.status, r.read(), dict(r.headers)
        except urllib.error.HTTPError as e:
            if e.code < 500 or attempt == tries - 1:
                return e.code, e.read(), dict(e.headers or {})
            last = e
        except Exception as e:                                           # noqa: BLE001
            last = e
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{url}: {last}")


if __name__ == "__main__":
    s, b, _ = get("https://statistik.bra.se/solwebb/action/start?menykatalogid=1",
                  context=bra_context())
    print(f"statistik.bra.se -> HTTP {s}, {len(b):,} bytes, verification ON")
