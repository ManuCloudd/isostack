import ipaddress
import os
import socket
import time
from datetime import datetime
from urllib.parse import urlparse

import httpx
from sqlalchemy.orm import Session

from app.config import ISO_STORAGE_PATH, BASE_URL
from app.services.hash_service import compute_sha256, verify_checksum

_PRIVATE_NETWORKS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
]


def _validate_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("Seuls les schémas http et https sont autorisés")
    host = parsed.hostname or ""
    try:
        ip = ipaddress.ip_address(socket.gethostbyname(host))
        if any(ip in net for net in _PRIVATE_NETWORKS):
            raise ValueError("Les adresses IP privées/locales ne sont pas autorisées")
    except (socket.gaierror, ValueError):
        raise


async def download_iso(iso_id: int, url: str, filename: str, expected_checksum: str, checksum_type: str, db: Session):
    from app.models import ISO

    dest_path = os.path.join(ISO_STORAGE_PATH, filename)

    try:
        _validate_url(url)
        timeout = httpx.Timeout(connect=10.0, read=3600.0, write=None, pool=5.0)
        async with httpx.AsyncClient(follow_redirects=True, timeout=timeout) as client:
            async with client.stream("GET", url) as response:
                response.raise_for_status()
                total = int(response.headers.get("content-length", 0))
                downloaded = 0
                last_update = time.time()

                with open(dest_path, "wb") as f:
                    async for chunk in response.aiter_bytes(chunk_size=1024 * 1024):
                        f.write(chunk)
                        downloaded += len(chunk)

                        now = time.time()
                        if now - last_update >= 2 and total > 0:
                            progress = int(downloaded / total * 100)
                            db.query(ISO).filter(ISO.id == iso_id).update({
                                "download_progress": progress,
                                "updated_at": datetime.utcnow(),
                            })
                            db.commit()
                            last_update = now

        # Compute hashes
        db.query(ISO).filter(ISO.id == iso_id).update({
            "status": "verifying",
            "download_progress": 100,
            "updated_at": datetime.utcnow(),
        })
        db.commit()

        sha256 = await compute_sha256(dest_path)
        size_bytes = os.path.getsize(dest_path)
        http_url = f"{BASE_URL}/files/{filename}"

        checksum_verified = None
        if expected_checksum:
            checksum_verified = await verify_checksum(dest_path, expected_checksum, checksum_type or "sha256")

        db.query(ISO).filter(ISO.id == iso_id).update({
            "status": "available",
            "sha256": sha256,
            "size_bytes": size_bytes,
            "http_url": http_url,
            "checksum_verified": checksum_verified,
            "download_progress": 100,
            "updated_at": datetime.utcnow(),
        })
        db.commit()

    except Exception as e:
        db.query(ISO).filter(ISO.id == iso_id).update({
            "status": "error",
            "error_message": str(e),
            "updated_at": datetime.utcnow(),
        })
        db.commit()
        if os.path.exists(dest_path):
            os.remove(dest_path)
