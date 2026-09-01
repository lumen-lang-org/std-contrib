#!/usr/bin/env python3
"""Fetch a picture from the web, one command:

    fetch-image https://example.com/photo.jpg out.jpg

The daemon's own gate refuses curl and wget with nobody attached to approve
them, which reads as "the network is blocked" and is not: this is a plain
script, it runs like any other, and the machine has ordinary egress. What it
will not do is reach anything private — the cloud's metadata service and the
site-local ranges are refused here as well as at the firewall, so a redirect
into them fails rather than surprising somebody.

https only. At most 25 MB. The answer has to actually be an image, so a login
page served with a 200 is an error rather than a file that opens as noise.
"""
from __future__ import annotations

import ipaddress
import os
import socket
import sys
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from artifact_path import resolve_output  # noqa: E402

MOST = 25 * 1024 * 1024
KINDS = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
    "image/webp": ".webp", "image/svg+xml": ".svg", "image/bmp": ".bmp",
}
AGENT = "Mozilla/5.0 (compatible; joule-code/1.0; +https://joule.sh)"


def public(host: str) -> None:
    try:
        found = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise SystemExit(f"{host}: that name does not resolve ({e.strerror})")
    for one in found:
        ip = ipaddress.ip_address(one[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise SystemExit(
                f"{host} resolves to {ip}, which is inside this network rather than out on"
                " the web — that is not somewhere a sandbox may read from"
            )


def fetch(url: str, out: Path) -> int:
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise SystemExit(f"{url}: fetch-image reads https, not {parsed.scheme or 'a bare path'}")
    if not parsed.hostname:
        raise SystemExit(f"{url}: no host in that address")
    public(parsed.hostname)

    ask = urllib.request.Request(url, headers={"User-Agent": AGENT, "Accept": "image/*"})
    try:
        answer = urllib.request.urlopen(ask, timeout=30)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{url}: the site answered {e.code} {e.reason}")
    except Exception as e:
        raise SystemExit(f"{url}: {type(e).__name__}: {e}")

    kind = (answer.headers.get("content-type") or "").split(";")[0].strip().lower()
    if kind not in KINDS:
        raise SystemExit(
            f"{url} answered with {kind or 'no content type'}, which is not an image —"
            " a page that needs a login or a search result reads like this"
        )
    body = answer.read(MOST + 1)
    if len(body) > MOST:
        raise SystemExit(f"{url} is larger than {MOST // (1024 * 1024)} MB")
    if not body:
        raise SystemExit(f"{url} answered with nothing")

    want = KINDS[kind]
    if out.suffix.lower() not in (want, ".jpeg" if want == ".jpg" else want):
        out = out.with_suffix(want)
    parent = os.path.dirname(str(out))
    if parent:
        os.makedirs(parent, exist_ok=True)
    out.write_bytes(body)
    print(f"wrote {out} ({len(body)} bytes, {kind})")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__)
        return 2
    return fetch(argv[1], Path(resolve_output(argv[2])))


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
