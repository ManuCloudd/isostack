import os
import shutil
from datetime import datetime

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import ISO_STORAGE_PATH, DB_PATH, MAX_DISK_USAGE_PCT, AUTO_IMPORT_ENABLED
from app.database import get_db, engine
from app.models import ISO

router = APIRouter(prefix="/api", tags=["maintenance"])


def _disk_usage(path: str):
    try:
        usage = shutil.disk_usage(path)
        return {
            "total": usage.total,
            "used": usage.used,
            "free": usage.free,
            "pct": round(usage.used / usage.total * 100, 1) if usage.total else 0,
        }
    except Exception:
        return None


@router.get("/system-info")
def system_info(db: Session = Depends(get_db)):
    """Retourne les informations système : chemin stockage, DB, espace disque."""
    disk = _disk_usage(ISO_STORAGE_PATH)
    db_size = os.path.getsize(DB_PATH) if os.path.exists(DB_PATH) else 0
    iso_count = db.query(ISO).count()

    disk_quota_exceeded = False
    if disk and MAX_DISK_USAGE_PCT > 0:
        disk_quota_exceeded = disk["pct"] >= MAX_DISK_USAGE_PCT

    return {
        "db_size_bytes": db_size,
        "iso_count": iso_count,
        "disk": disk,
        "disk_quota_pct": MAX_DISK_USAGE_PCT,
        "disk_quota_exceeded": disk_quota_exceeded,
        "auto_import_enabled": AUTO_IMPORT_ENABLED,
    }


@router.post("/maintenance/vacuum")
def vacuum_db():
    """Compacte la base SQLite (VACUUM)."""
    try:
        with engine.connect() as conn:
            conn.execute(text("VACUUM"))
        db_size = os.path.getsize(DB_PATH) if os.path.exists(DB_PATH) else 0
        return {"success": True, "message": "VACUUM exécuté avec succès.", "db_size_bytes": db_size}
    except Exception as e:
        return {"success": False, "message": str(e)}


@router.get("/maintenance/integrity")
def integrity_check():
    """Vérifie l'intégrité de la base SQLite."""
    try:
        with engine.connect() as conn:
            result = conn.execute(text("PRAGMA integrity_check")).fetchall()
        rows = [r[0] for r in result]
        ok = rows == ["ok"]
        return {
            "success": True,
            "ok": ok,
            "result": rows,
            "message": "Base de données intègre." if ok else f"{len(rows)} problème(s) détecté(s).",
        }
    except Exception as e:
        return {"success": False, "ok": False, "result": [], "message": str(e)}


@router.post("/maintenance/cleanup-orphans")
def cleanup_orphans(db: Session = Depends(get_db)):
    """Supprime les entrées DB dont le fichier n'existe plus sur le disque."""
    isos = db.query(ISO).filter(ISO.status == "available").all()
    removed = []
    for iso in isos:
        file_path = os.path.join(ISO_STORAGE_PATH, iso.filename)
        if not os.path.exists(file_path):
            removed.append({"id": iso.id, "name": iso.name, "filename": iso.filename})
            db.delete(iso)
    db.commit()
    return {
        "success": True,
        "removed": len(removed),
        "items": removed,
        "message": f"{len(removed)} entrée(s) orpheline(s) supprimée(s)." if removed else "Aucune orpheline trouvée.",
    }


@router.post("/maintenance/reindex")
def reindex_db():
    """Recrée les index SQLite."""
    try:
        with engine.connect() as conn:
            conn.execute(text("REINDEX"))
        return {"success": True, "message": "Index reconstruits avec succès."}
    except Exception as e:
        return {"success": False, "message": str(e)}
