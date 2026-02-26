import asyncio
import hashlib
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.auth import BasicAuthMiddleware
from app.config import ISO_STORAGE_PATH, BASE_URL, AUTH_USERNAME, AUTH_PASSWORD
from app.database import init_db
from app.routes import isos, downloads, maintenance
from app.services.file_watcher import file_watcher_loop


def _file_hash(path: str) -> str:
    """Retourne les 8 premiers caractères du MD5 d'un fichier pour cache-busting."""
    try:
        h = hashlib.md5()
        with open(path, "rb") as f:
            while chunk := f.read(65536):
                h.update(chunk)
        return h.hexdigest()[:8]
    except Exception:
        return "dev"


@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(ISO_STORAGE_PATH, exist_ok=True)
    init_db()
    # Lancer le watcher en tâche de fond
    task = asyncio.create_task(file_watcher_loop())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


app = FastAPI(title="IsoStack", lifespan=lifespan)

app.add_middleware(BasicAuthMiddleware, username=AUTH_USERNAME, password=AUTH_PASSWORD)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[BASE_URL],
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)

app.include_router(isos.router)
app.include_router(downloads.router)
app.include_router(maintenance.router)

app.mount("/static", StaticFiles(directory="app/static"), name="static")

templates = Jinja2Templates(directory="app/templates")

# Cache-busters calculés au démarrage
_CSS_VER = _file_hash("app/static/css/style.css")
_JS_VER  = _file_hash("app/static/js/app.js")


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {
        "request": request,
        "base_url": BASE_URL,
        "css_ver": _CSS_VER,
        "js_ver": _JS_VER,
    })


@app.get("/files/{filename}")
async def serve_file(filename: str, request: Request):
    safe_name = os.path.basename(filename)
    file_path = os.path.realpath(os.path.join(ISO_STORAGE_PATH, safe_name))
    storage_root = os.path.realpath(ISO_STORAGE_PATH)
    if not file_path.startswith(storage_root + os.sep) and file_path != storage_root:
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=400, content={"detail": "Invalid filename"})
    if not os.path.exists(file_path):
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=404, content={"detail": "File not found"})

    file_size = os.path.getsize(file_path)
    range_header = request.headers.get("Range")

    if range_header:
        try:
            range_val = range_header.strip().replace("bytes=", "")
            start_str, end_str = range_val.split("-")
            start = int(start_str) if start_str else 0
            end = int(end_str) if end_str else file_size - 1
            end = min(end, file_size - 1)
            chunk_size = end - start + 1

            def iter_file():
                with open(file_path, "rb") as f:
                    f.seek(start)
                    remaining = chunk_size
                    while remaining > 0:
                        read_size = min(1024 * 1024, remaining)
                        data = f.read(read_size)
                        if not data:
                            break
                        yield data
                        remaining -= len(data)

            headers = {
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(chunk_size),
                "Content-Type": "application/octet-stream",
            }
            from fastapi.responses import StreamingResponse
            return StreamingResponse(iter_file(), status_code=206, headers=headers)
        except Exception:
            pass

    def iter_full():
        with open(file_path, "rb") as f:
            while chunk := f.read(1024 * 1024):
                yield chunk

    from fastapi.responses import StreamingResponse
    return StreamingResponse(
        iter_full(),
        media_type="application/octet-stream",
        headers={
            "Content-Length": str(file_size),
            "Accept-Ranges": "bytes",
            "Content-Disposition": f'attachment; filename="{safe_name}"',
        },
    )
