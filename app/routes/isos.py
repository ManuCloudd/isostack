import os
import math
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import or_
from sqlalchemy.orm import Session

import shutil
from app.config import ISO_STORAGE_PATH, BASE_URL, MAX_DISK_USAGE_PCT
from app.database import get_db
from app.models import ISO
from app.schemas import ISOCreate, ISOListResponse, ISOProgressResponse, ISOResponse, ISOUpdate, StatsResponse
from app.services.download_service import download_iso
from app.services.hash_service import compute_sha256, verify_checksum
from app.services.update_check_service import check_for_update

router = APIRouter(prefix="/api", tags=["isos"])


def _format_size(size_bytes: int) -> str:
    if size_bytes == 0:
        return "0 B"
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if size_bytes < 1024:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024
    return f"{size_bytes:.1f} PB"


def _filename_from_url(url: str) -> str:
    return url.split("?")[0].split("/")[-1] or "download.iso"


def _check_disk_quota():
    """Lève une HTTPException 507 si le quota disque est dépassé."""
    if MAX_DISK_USAGE_PCT <= 0:
        return
    try:
        usage = shutil.disk_usage(ISO_STORAGE_PATH)
        pct = usage.used / usage.total * 100
        if pct >= MAX_DISK_USAGE_PCT:
            free_gb = usage.free / (1024 ** 3)
            raise HTTPException(
                status_code=507,
                detail=f"Espace disque insuffisant — {pct:.1f}% utilisé (quota : {MAX_DISK_USAGE_PCT}%). "
                       f"Espace libre : {free_gb:.1f} Go.",
            )
    except HTTPException:
        raise
    except Exception:
        pass  # Ne pas bloquer si disk_usage échoue


def _unique_filename(filename: str) -> str:
    base, ext = os.path.splitext(filename)
    path = os.path.join(ISO_STORAGE_PATH, filename)
    counter = 1
    while os.path.exists(path):
        filename = f"{base}_{counter}{ext}"
        path = os.path.join(ISO_STORAGE_PATH, filename)
        counter += 1
    return filename


@router.get("/isos", response_model=ISOListResponse)
def list_isos(
    category: Optional[str] = None,
    os: Optional[str] = None,
    arch: Optional[str] = None,
    edition: Optional[str] = None,
    q: Optional[str] = None,
    favorites: Optional[bool] = None,
    page: int = 1,
    per_page: int = 20,
    db: Session = Depends(get_db),
):
    query = db.query(ISO)

    if favorites:
        query = query.filter(ISO.is_favorite == True)  # noqa: E712
    if category:
        query = query.filter(ISO.category == category)
    if os:
        query = query.filter(ISO.os_family.ilike(f"%{os}%"))
    if arch:
        query = query.filter(ISO.architecture == arch)
    if edition:
        query = query.filter(ISO.edition == edition)
    if q:
        query = query.filter(
            or_(
                ISO.name.ilike(f"%{q}%"),
                ISO.filename.ilike(f"%{q}%"),
                ISO.description.ilike(f"%{q}%"),
                ISO.tags.ilike(f"%{q}%"),
                ISO.version.ilike(f"%{q}%"),
                ISO.os_family.ilike(f"%{q}%"),
            )
        )

    total = query.count()
    items = query.order_by(ISO.created_at.desc()).offset((page - 1) * per_page).limit(per_page).all()
    pages = math.ceil(total / per_page) if total > 0 else 1

    return ISOListResponse(items=items, total=total, page=page, per_page=per_page, pages=pages)


@router.get("/stats", response_model=StatsResponse)
def get_stats(db: Session = Depends(get_db)):
    all_isos = db.query(ISO).all()
    total = len(all_isos)
    disk_used = sum(i.size_bytes or 0 for i in all_isos)

    return StatsResponse(
        total=total,
        available=sum(1 for i in all_isos if i.status == "available"),
        downloading=sum(1 for i in all_isos if i.status == "downloading"),
        uploading=sum(1 for i in all_isos if i.status == "uploading"),
        verifying=sum(1 for i in all_isos if i.status == "verifying"),
        error=sum(1 for i in all_isos if i.status == "error"),
        disk_used_bytes=disk_used,
        disk_used_formatted=_format_size(disk_used),
    )


@router.get("/isos/{iso_id}", response_model=ISOResponse)
def get_iso(iso_id: int, db: Session = Depends(get_db)):
    iso = db.query(ISO).filter(ISO.id == iso_id).first()
    if not iso:
        raise HTTPException(status_code=404, detail="ISO not found")
    return iso


@router.post("/isos/from-url", response_model=ISOResponse)
def create_from_url(payload: ISOCreate, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    _check_disk_quota()
    filename = _filename_from_url(payload.url)
    filename = _unique_filename(filename)
    name = payload.name or filename

    iso = ISO(
        name=name,
        filename=filename,
        category=payload.category,
        os_family=payload.os_family,
        version=payload.version,
        architecture=payload.architecture,
        expected_checksum=payload.expected_checksum,
        checksum_type=payload.checksum_type,
        description=payload.description,
        tags=payload.tags,
        source_url=payload.url,
        add_method="url",
        status="downloading",
        download_progress=0,
        file_path=f"/data/isos/{filename}",
    )
    db.add(iso)
    db.commit()
    db.refresh(iso)

    from app.database import SessionLocal
    bg_db = SessionLocal()
    background_tasks.add_task(
        download_iso,
        iso.id,
        payload.url,
        filename,
        payload.expected_checksum,
        payload.checksum_type,
        bg_db,
    )

    return iso


@router.post("/isos/upload", response_model=ISOResponse)
async def upload_iso(  # noqa: PLR0913
    file: UploadFile = File(...),
    name: Optional[str] = Form(None),
    category: str = Form("other"),
    os_family: Optional[str] = Form(None),
    version: Optional[str] = Form(None),
    architecture: Optional[str] = Form("x86_64"),
    description: Optional[str] = Form(None),
    tags: Optional[str] = Form(None),
    db: Session = Depends(get_db),
):
    _check_disk_quota()
    filename = _unique_filename(file.filename or "upload.iso")
    display_name = name or filename
    dest_path = os.path.join(ISO_STORAGE_PATH, filename)

    iso = ISO(
        name=display_name,
        filename=filename,
        category=category,
        os_family=os_family,
        version=version,
        architecture=architecture,
        description=description,
        tags=tags,
        add_method="upload",
        status="uploading",
        download_progress=0,
        file_path=f"/data/isos/{filename}",
    )
    db.add(iso)
    db.commit()
    db.refresh(iso)

    try:
        with open(dest_path, "wb") as f:
            while chunk := await file.read(1024 * 1024):
                f.write(chunk)

        sha256 = await compute_sha256(dest_path)
        size_bytes = os.path.getsize(dest_path)
        http_url = f"{BASE_URL}/files/{filename}"

        db.query(ISO).filter(ISO.id == iso.id).update({
            "status": "available",
            "sha256": sha256,
            "size_bytes": size_bytes,
            "http_url": http_url,
            "download_progress": 100,
            "updated_at": datetime.utcnow(),
        })
        db.commit()
        db.refresh(iso)
    except Exception as e:
        db.query(ISO).filter(ISO.id == iso.id).update({
            "status": "error",
            "error_message": str(e),
            "updated_at": datetime.utcnow(),
        })
        db.commit()
        if os.path.exists(dest_path):
            os.remove(dest_path)

    return iso


@router.put("/isos/{iso_id}", response_model=ISOResponse)
def update_iso(iso_id: int, payload: ISOUpdate, db: Session = Depends(get_db)):
    iso = db.query(ISO).filter(ISO.id == iso_id).first()
    if not iso:
        raise HTTPException(status_code=404, detail="ISO not found")

    update_data = payload.model_dump(exclude_unset=True)
    update_data["updated_at"] = datetime.utcnow()
    db.query(ISO).filter(ISO.id == iso_id).update(update_data)
    db.commit()
    db.refresh(iso)
    return iso


@router.delete("/isos/{iso_id}")
def delete_iso(iso_id: int, db: Session = Depends(get_db)):
    iso = db.query(ISO).filter(ISO.id == iso_id).first()
    if not iso:
        raise HTTPException(status_code=404, detail="ISO not found")

    file_path = os.path.join(ISO_STORAGE_PATH, iso.filename)
    if os.path.exists(file_path):
        os.remove(file_path)

    db.delete(iso)
    db.commit()
    return {"success": True}


@router.post("/isos/{iso_id}/verify", response_model=ISOResponse)
async def verify_iso(iso_id: int, db: Session = Depends(get_db)):
    iso = db.query(ISO).filter(ISO.id == iso_id).first()
    if not iso:
        raise HTTPException(status_code=404, detail="ISO not found")

    file_path = os.path.join(ISO_STORAGE_PATH, iso.filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found on disk")

    db.query(ISO).filter(ISO.id == iso_id).update({
        "status": "verifying",
        "updated_at": datetime.utcnow(),
    })
    db.commit()

    sha256 = await compute_sha256(file_path)
    checksum_verified = None
    if iso.expected_checksum:
        checksum_verified = await verify_checksum(file_path, iso.expected_checksum, iso.checksum_type or "sha256")

    db.query(ISO).filter(ISO.id == iso_id).update({
        "status": "available",
        "sha256": sha256,
        "checksum_verified": checksum_verified,
        "updated_at": datetime.utcnow(),
    })
    db.commit()
    db.refresh(iso)
    return iso


@router.post("/isos/{iso_id}/favorite", response_model=ISOResponse)
def toggle_favorite(iso_id: int, db: Session = Depends(get_db)):
    iso = db.query(ISO).filter(ISO.id == iso_id).first()
    if not iso:
        raise HTTPException(status_code=404, detail="ISO not found")
    new_val = not bool(iso.is_favorite)
    db.query(ISO).filter(ISO.id == iso_id).update({
        "is_favorite": new_val,
        "updated_at": datetime.utcnow(),
    })
    db.commit()
    db.refresh(iso)
    return iso


@router.get("/isos/{iso_id}/progress", response_model=ISOProgressResponse)
def get_progress(iso_id: int, db: Session = Depends(get_db)):
    iso = db.query(ISO).filter(ISO.id == iso_id).first()
    if not iso:
        raise HTTPException(status_code=404, detail="ISO not found")
    return iso


# ── BROWSE ──────────────────────────────────────────────────────────

ALLOWED_EXTENSIONS = {".iso", ".img", ".vmdk", ".vdi", ".qcow2", ".raw", ".vhd", ".vhdx",
                      ".ova", ".ovf", ".tar", ".gz", ".xz", ".zst"}


@router.get("/browse")
def browse_storage(db: Session = Depends(get_db)):
    """List ALL compatible files in ISO_STORAGE_PATH with tracking status."""
    tracked_map = {iso.filename: iso.id for iso in db.query(ISO.filename, ISO.id).all()}

    files = []
    try:
        for fname in sorted(os.listdir(ISO_STORAGE_PATH)):
            ext = os.path.splitext(fname)[1].lower()
            if ext not in ALLOWED_EXTENSIONS:
                continue
            full = os.path.join(ISO_STORAGE_PATH, fname)
            if not os.path.isfile(full):
                continue
            iso_id = tracked_map.get(fname)
            files.append({
                "filename": fname,
                "size_bytes": os.path.getsize(full),
                "extension": ext,
                "tracked": fname in tracked_map,
                "iso_id": iso_id,
            })
    except FileNotFoundError:
        pass

    return {
        "files": files,
        "total": len(files),
        "untracked": sum(1 for f in files if not f["tracked"]),
    }


@router.post("/isos/{iso_id}/check-update", response_model=ISOResponse)
async def check_iso_update(iso_id: int, db: Session = Depends(get_db)):
    """Compare the local ISO SHA256 against what is available at source_url."""
    iso = db.query(ISO).filter(ISO.id == iso_id).first()
    if not iso:
        raise HTTPException(status_code=404, detail="ISO not found")

    if not iso.source_url:
        raise HTTPException(status_code=400, detail="No source URL recorded for this ISO")

    result = await check_for_update(
        source_url=iso.source_url,
        local_sha256=iso.sha256,
        local_size_bytes=iso.size_bytes,
    )

    db.query(ISO).filter(ISO.id == iso_id).update({
        "upstream_sha256": result["upstream_sha256"],
        "update_available": result["update_available"],
        "last_update_check": datetime.utcnow(),
        "updated_at": datetime.utcnow(),
    })
    db.commit()
    db.refresh(iso)
    return iso


@router.post("/isos/import")
async def import_from_storage(payload: dict, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """Import an existing file from storage into the DB."""
    filename = payload.get("filename")
    if not filename:
        raise HTTPException(status_code=400, detail="filename required")

    file_path = os.path.join(ISO_STORAGE_PATH, filename)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found in storage")

    existing = db.query(ISO).filter(ISO.filename == filename).first()
    if existing:
        raise HTTPException(status_code=409, detail="File already tracked")

    name = payload.get("name") or os.path.splitext(filename)[0]
    size_bytes = os.path.getsize(file_path)
    http_url = f"{BASE_URL}/files/{filename}"

    iso = ISO(
        name=name,
        filename=filename,
        category=payload.get("category", "other"),
        os_family=payload.get("os_family"),
        version=payload.get("version"),
        architecture=payload.get("architecture", "x86_64"),
        description=payload.get("description"),
        tags=payload.get("tags"),
        add_method="import",
        status="verifying",
        download_progress=0,
        size_bytes=size_bytes,
        file_path=f"/data/isos/{filename}",
        http_url=http_url,
    )
    db.add(iso)
    db.commit()
    db.refresh(iso)

    from app.database import SessionLocal
    from app.services.hash_service import compute_sha256 as _sha256

    async def _compute_and_update(iso_id: int):
        bg_db = SessionLocal()
        try:
            sha = await _sha256(file_path)
            bg_db.query(ISO).filter(ISO.id == iso_id).update({
                "status": "available",
                "sha256": sha,
                "download_progress": 100,
                "updated_at": datetime.utcnow(),
            })
            bg_db.commit()
        except Exception as e:
            bg_db.query(ISO).filter(ISO.id == iso_id).update({
                "status": "error",
                "error_message": str(e),
                "updated_at": datetime.utcnow(),
            })
            bg_db.commit()
        finally:
            bg_db.close()

    background_tasks.add_task(_compute_and_update, iso.id)
    return iso
