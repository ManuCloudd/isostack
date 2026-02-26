"""
Vérifie périodiquement que les fichiers ISO existent encore sur le disque.
Si un fichier est absent, le statut passe à 'missing'.
Si un fichier 'missing' réapparaît, le statut repasse à 'available'.
Détecte aussi les nouveaux fichiers déposés manuellement et les importe automatiquement.
"""
import asyncio
import logging
import os

from app.config import ISO_STORAGE_PATH, FILE_CHECK_INTERVAL, AUTO_IMPORT_ENABLED, BASE_URL
from app.database import SessionLocal
from app.models import ISO

logger = logging.getLogger("file_watcher")

ACTIVE_STATUSES = {"downloading", "uploading", "verifying"}

WATCHED_EXTENSIONS = {".iso", ".img", ".vmdk", ".qcow2", ".vdi", ".raw", ".vhd", ".vhdx"}


def _detect_os_info(filename: str) -> dict:
    f = filename.lower()
    if any(x in f for x in ["windows", "win10", "win11"]):
        return {"category": "windows", "os_family": "windows"}
    for os_name in ["ubuntu", "debian", "fedora", "centos", "kali", "arch", "mint",
                    "manjaro", "alpine", "opensuse", "truenas", "proxmox", "unraid"]:
        if os_name in f:
            return {"category": "linux", "os_family": os_name}
    if "linux" in f:
        return {"category": "linux", "os_family": "linux"}
    return {"category": "other", "os_family": None}


async def _auto_import_file(filename: str):
    """Importe un fichier dans la DB et calcule son SHA256 en arrière-plan."""
    from app.services.hash_service import compute_sha256
    from datetime import datetime

    file_path = os.path.join(ISO_STORAGE_PATH, filename)
    db = SessionLocal()
    try:
        # Double-check — un autre worker a peut-être déjà importé
        existing = db.query(ISO).filter(ISO.filename == filename).first()
        if existing:
            return

        size_bytes = os.path.getsize(file_path)
        os_info = _detect_os_info(filename)
        name = os.path.splitext(filename)[0]
        http_url = f"{BASE_URL}/files/{filename}"
        ext = os.path.splitext(filename)[1].lower().lstrip(".")

        iso = ISO(
            name=name,
            filename=filename,
            category=os_info["category"],
            os_family=os_info["os_family"],
            file_format=ext if ext else None,
            add_method="auto_import",
            status="verifying",
            download_progress=0,
            size_bytes=size_bytes,
            file_path=f"/data/isos/{filename}",
            http_url=http_url,
        )
        db.add(iso)
        db.commit()
        db.refresh(iso)
        iso_id = iso.id
        logger.info(f"Auto-import : {filename} (id={iso_id}) — calcul SHA256…")

        sha256 = await compute_sha256(file_path)
        db.query(ISO).filter(ISO.id == iso_id).update({
            "status": "available",
            "sha256": sha256,
            "download_progress": 100,
            "updated_at": datetime.utcnow(),
        })
        db.commit()
        logger.info(f"Auto-import terminé : {filename} sha256={sha256[:12]}…")
    except Exception as e:
        logger.error(f"Auto-import échoué pour {filename} : {e}")
        try:
            db.rollback()
        except Exception:
            pass
    finally:
        db.close()


async def run_auto_import():
    """Détecte les fichiers non suivis dans ISO_STORAGE_PATH et les importe."""
    db = SessionLocal()
    try:
        tracked = {iso.filename for iso in db.query(ISO.filename).all()}
        try:
            all_files = os.listdir(ISO_STORAGE_PATH)
        except FileNotFoundError:
            return
        new_files = [
            f for f in all_files
            if os.path.splitext(f)[1].lower() in WATCHED_EXTENSIONS
            and f not in tracked
            and os.path.isfile(os.path.join(ISO_STORAGE_PATH, f))
        ]
    finally:
        db.close()

    for filename in new_files:
        logger.info(f"Nouveau fichier détecté : {filename}")
        await _auto_import_file(filename)



async def run_file_check():
    db = SessionLocal()
    try:
        isos = db.query(ISO).filter(
            ISO.status.notin_(list(ACTIVE_STATUSES))
        ).all()

        changed = 0
        for iso in isos:
            if not iso.filename:
                continue
            path = os.path.join(ISO_STORAGE_PATH, iso.filename)
            exists = os.path.isfile(path)

            if not exists and iso.status == "available":
                iso.status = "missing"
                logger.warning(f"Fichier manquant : {iso.filename} (id={iso.id})")
                changed += 1
            elif exists and iso.status == "missing":
                iso.status = "available"
                # Mettre à jour la taille au cas où
                iso.size_bytes = os.path.getsize(path)
                logger.info(f"Fichier retrouvé : {iso.filename} (id={iso.id})")
                changed += 1

        if changed:
            db.commit()
            logger.info(f"File check terminé — {changed} ISO(s) mis à jour")
    except Exception as e:
        logger.error(f"Erreur file_watcher : {e}")
        db.rollback()
    finally:
        db.close()


async def file_watcher_loop():
    logger.info(f"File watcher démarré (intervalle : {FILE_CHECK_INTERVAL}s, auto-import : {AUTO_IMPORT_ENABLED})")
    while True:
        await run_file_check()
        if AUTO_IMPORT_ENABLED:
            await run_auto_import()
        await asyncio.sleep(FILE_CHECK_INTERVAL)
