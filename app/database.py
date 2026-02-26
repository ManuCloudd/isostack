import os
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker
from app.config import DB_PATH, ISO_STORAGE_PATH

os.makedirs(ISO_STORAGE_PATH, exist_ok=True)
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False},
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    from app import models  # noqa: F401
    Base.metadata.create_all(bind=engine)
    _migrate()


def _migrate():
    """Ajoute les colonnes manquantes sans casser les données existantes."""
    new_columns = [
        ("edition", "TEXT"),
        ("file_format", "TEXT"),
        ("is_favorite", "INTEGER DEFAULT 0"),
        ("upstream_sha256", "TEXT"),
        ("update_available", "INTEGER"),
        ("last_update_check", "DATETIME"),
    ]
    with engine.connect() as conn:
        result = conn.execute(__import__("sqlalchemy").text("PRAGMA table_info(isos)"))
        existing = {row[1] for row in result}
        for col, col_type in new_columns:
            if col not in existing:
                conn.execute(__import__("sqlalchemy").text(
                    f"ALTER TABLE isos ADD COLUMN {col} {col_type}"
                ))
                conn.commit()
