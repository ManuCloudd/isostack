from typing import List
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import ISO
from app.schemas import ISOProgressResponse

router = APIRouter(prefix="/api/downloads", tags=["downloads"])


@router.get("/active", response_model=List[ISOProgressResponse])
def get_active_downloads(db: Session = Depends(get_db)):
    active = db.query(ISO).filter(
        ISO.status.in_(["downloading", "uploading", "verifying"])
    ).all()
    return active
