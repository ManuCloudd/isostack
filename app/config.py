import os

ISO_STORAGE_PATH = os.getenv("ISO_STORAGE_PATH", "/data/isos")
DB_PATH = os.getenv("DB_PATH", "/data/db.sqlite")
BASE_URL = os.getenv("BASE_URL", "http://localhost:8585")
MAX_CONCURRENT_DOWNLOADS = int(os.getenv("MAX_CONCURRENT_DOWNLOADS", "3"))
MAX_UPLOAD_SIZE_GB = int(os.getenv("MAX_UPLOAD_SIZE_GB", "0"))

# Auth (optionnel — laisser vide pour désactiver)
AUTH_USERNAME = os.getenv("AUTH_USERNAME", "")
AUTH_PASSWORD = os.getenv("AUTH_PASSWORD", "")

# Intervalle du check fichiers manquants (secondes)
FILE_CHECK_INTERVAL = int(os.getenv("FILE_CHECK_INTERVAL", "60"))

# Auto-import des nouveaux fichiers détectés dans ISO_STORAGE_PATH
AUTO_IMPORT_ENABLED = os.getenv("AUTO_IMPORT_ENABLED", "true").lower() == "true"

# Quota disque : bloquer uploads/téléchargements au-delà de ce % d'utilisation (0 = désactivé)
MAX_DISK_USAGE_PCT = int(os.getenv("MAX_DISK_USAGE_PCT", "90"))
