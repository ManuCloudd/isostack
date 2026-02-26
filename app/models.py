from datetime import datetime
from sqlalchemy import Boolean, Column, DateTime, Integer, Text
from app.database import Base


class ISO(Base):
    __tablename__ = "isos"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(Text, nullable=False)
    filename = Column(Text, nullable=False)
    category = Column(Text, default="other")
    os_family = Column(Text)
    edition = Column(Text)      # desktop / server / cli / live / netinstall / core / workstation
    file_format = Column(Text)  # iso / img / vmdk / qcow2 / vdi / raw / vhd / vhdx
    version = Column(Text)
    architecture = Column(Text)
    size_bytes = Column(Integer, default=0)
    sha256 = Column(Text)
    sha512 = Column(Text)
    md5 = Column(Text)
    expected_checksum = Column(Text)
    checksum_type = Column(Text)
    checksum_verified = Column(Boolean)
    description = Column(Text)
    tags = Column(Text)  # JSON array stored as string
    source_url = Column(Text)
    add_method = Column(Text)  # "url" or "upload"
    status = Column(Text, default="available")  # available / downloading / uploading / verifying / error
    download_progress = Column(Integer, default=0)
    error_message = Column(Text)
    file_path = Column(Text)
    http_url = Column(Text)
    is_favorite = Column(Boolean, default=False)
    upstream_sha256 = Column(Text)
    update_available = Column(Boolean)
    last_update_check = Column(DateTime)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
