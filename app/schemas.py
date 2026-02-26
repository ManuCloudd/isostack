from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel


class ISOCreate(BaseModel):
    url: str
    name: Optional[str] = None
    category: str = "other"
    os_family: Optional[str] = None
    edition: Optional[str] = None
    file_format: Optional[str] = None
    version: Optional[str] = None
    architecture: Optional[str] = "x86_64"
    expected_checksum: Optional[str] = None
    checksum_type: Optional[str] = "sha256"
    description: Optional[str] = None
    tags: Optional[str] = None


class ISOUpdate(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None
    os_family: Optional[str] = None
    edition: Optional[str] = None
    file_format: Optional[str] = None
    version: Optional[str] = None
    architecture: Optional[str] = None
    description: Optional[str] = None
    tags: Optional[str] = None
    expected_checksum: Optional[str] = None
    checksum_type: Optional[str] = None


class ISOResponse(BaseModel):
    id: int
    name: str
    filename: str
    category: Optional[str]
    os_family: Optional[str]
    edition: Optional[str]
    file_format: Optional[str]
    version: Optional[str]
    architecture: Optional[str]
    size_bytes: int
    sha256: Optional[str]
    sha512: Optional[str]
    md5: Optional[str]
    expected_checksum: Optional[str]
    checksum_type: Optional[str]
    checksum_verified: Optional[bool]
    description: Optional[str]
    tags: Optional[str]
    source_url: Optional[str]
    add_method: Optional[str]
    status: str
    download_progress: int
    error_message: Optional[str]
    file_path: Optional[str]
    http_url: Optional[str]
    is_favorite: Optional[bool]
    upstream_sha256: Optional[str]
    update_available: Optional[bool]
    last_update_check: Optional[datetime]
    created_at: Optional[datetime]
    updated_at: Optional[datetime]

    class Config:
        from_attributes = True


class ISOProgressResponse(BaseModel):
    id: int
    status: str
    download_progress: int
    error_message: Optional[str]


class ISOListResponse(BaseModel):
    items: List[ISOResponse]
    total: int
    page: int
    per_page: int
    pages: int


class StatsResponse(BaseModel):
    total: int
    available: int
    downloading: int
    uploading: int
    verifying: int
    error: int
    disk_used_bytes: int
    disk_used_formatted: str
