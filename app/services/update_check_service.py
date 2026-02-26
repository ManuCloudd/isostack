"""
Check whether a tracked ISO has an update available upstream.

Security considerations implemented:
- SSRF guard: blocks private/loopback IP ranges and non-HTTP(S) schemes
- Response size cap: checksum files are read up to MAX_CHECKSUM_BYTES only
- Strict timeouts: 10 s connect, 30 s read
- Max 5 redirects
"""

import ipaddress
import os
import re
import socket
from datetime import datetime
from typing import Optional
from urllib.parse import urlparse

import httpx

MAX_CHECKSUM_BYTES = 1 * 1024 * 1024  # 1 MB cap on checksum file download

# Common checksum filename patterns to try alongside the ISO URL
CHECKSUM_FILENAMES = [
    "SHA256SUMS",
    "sha256sums",
    "SHA256SUMS.txt",
    "CHECKSUMS",
    "checksums.txt",
]

_PRIVATE_NETWORKS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),   # link-local / AWS metadata
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
]


def _validate_url(url: str) -> None:
    """Raise ValueError if the URL is unsafe (non-HTTP/S or SSRF risk)."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"Unsupported scheme: {parsed.scheme!r}")

    hostname = parsed.hostname
    if not hostname:
        raise ValueError("URL has no hostname")

    # Resolve to IP and check for private ranges
    try:
        addr = ipaddress.ip_address(socket.gethostbyname(hostname))
    except (socket.gaierror, ValueError):
        raise ValueError(f"Cannot resolve hostname: {hostname!r}")

    for network in _PRIVATE_NETWORKS:
        if addr in network:
            raise ValueError(f"Blocked: {addr} is in a private/reserved range (SSRF guard)")


def _make_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        follow_redirects=True,
        max_redirects=5,
        timeout=httpx.Timeout(connect=10.0, read=30.0, write=10.0, pool=5.0),
    )


def _base_url(url: str) -> str:
    """Return the directory part of a URL (without the filename)."""
    return url.rsplit("/", 1)[0] + "/"


async def _fetch_checksum_file(client: httpx.AsyncClient, base: str, iso_filename: str) -> Optional[str]:
    """
    Try to find a SHA256 for iso_filename in common checksum files next to it.
    Returns the hex digest string or None.
    """
    for name in CHECKSUM_FILENAMES:
        candidate = base + name
        try:
            _validate_url(candidate)
            response = await client.get(candidate)
            if response.status_code != 200:
                continue

            # Read up to MAX_CHECKSUM_BYTES to avoid RAM exhaustion
            content = b""
            async for chunk in response.aiter_bytes(4096):
                content += chunk
                if len(content) > MAX_CHECKSUM_BYTES:
                    break  # file too large — skip

            text = content.decode("utf-8", errors="ignore")
            # Lines look like: "<hash>  <filename>" or "<hash> *<filename>"
            for line in text.splitlines():
                parts = line.strip().split()
                if len(parts) >= 2:
                    digest, fname = parts[0], parts[-1].lstrip("*")
                    if fname == iso_filename and re.fullmatch(r"[0-9a-fA-F]{64}", digest):
                        return digest.lower()
        except Exception:
            continue

    return None


async def _fetch_etag_info(client: httpx.AsyncClient, url: str) -> dict:
    """
    Do a HEAD request and return ETag + Content-Length for change detection.
    Falls back gracefully if HEAD is not supported.
    """
    try:
        response = await client.head(url)
        return {
            "etag": response.headers.get("etag"),
            "content_length": response.headers.get("content-length"),
            "last_modified": response.headers.get("last-modified"),
        }
    except Exception:
        return {}


async def check_for_update(
    source_url: str,
    local_sha256: Optional[str],
    local_size_bytes: Optional[int],
) -> dict:
    """
    Compare local ISO state against what is available at source_url.

    Returns a dict with:
      - update_available (bool | None): True = update detected, False = up to date,
                                        None = could not determine
      - upstream_sha256 (str | None): SHA256 found upstream if any
      - method (str): how the check was performed
      - error (str | None): error message if check failed
    """
    result = {
        "update_available": None,
        "upstream_sha256": None,
        "method": "none",
        "error": None,
    }

    try:
        _validate_url(source_url)
    except ValueError as e:
        result["error"] = str(e)
        return result

    iso_filename = source_url.rsplit("/", 1)[-1].split("?")[0]
    base = _base_url(source_url)

    async with _make_client() as client:
        # 1. Try to find a checksum file next to the ISO
        upstream_sha256 = await _fetch_checksum_file(client, base, iso_filename)

        if upstream_sha256:
            result["upstream_sha256"] = upstream_sha256
            result["method"] = "checksum_file"
            if local_sha256:
                result["update_available"] = upstream_sha256.lower() != local_sha256.lower()
            else:
                result["update_available"] = None  # can't compare without local hash
            return result

        # 2. Fallback: compare ETag / Content-Length via HEAD
        meta = await _fetch_etag_info(client, source_url)
        result["method"] = "http_meta"

        if not meta:
            result["error"] = "Could not reach source URL"
            return result

        # If Content-Length differs from local size, an update is likely
        upstream_length = meta.get("content_length")
        if upstream_length and local_size_bytes:
            try:
                if int(upstream_length) != local_size_bytes:
                    result["update_available"] = True
                    return result
            except ValueError:
                pass

        # ETag presence alone doesn't tell us much without a stored baseline —
        # report undetermined rather than a false positive
        result["update_available"] = None
        result["error"] = "No checksum file found; HTTP metadata insufficient for definitive comparison"

    return result
