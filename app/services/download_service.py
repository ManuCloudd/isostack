import os
import time
from datetime import datetime

import httpx
from sqlalchemy.orm import Session

from app.config import ISO_STORAGE_PATH, BASE_URL
from app.services.hash_service import compute_sha256, verify_checksum


async def download_iso(iso_id: int, url: str, filename: str, expected_checksum: str, checksum_type: str, db: Session):
    from app.models import ISO

    dest_path = os.path.join(ISO_STORAGE_PATH, filename)

    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=None) as client:
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
