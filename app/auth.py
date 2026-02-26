"""
Authentification HTTP Basic optionnelle.
Activée uniquement si AUTH_USERNAME et AUTH_PASSWORD sont définis.
"""
import secrets
from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

from app.config import AUTH_USERNAME, AUTH_PASSWORD


class BasicAuthMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, username: str, password: str):
        super().__init__(app)
        self.username = username
        self.password = password
        self.enabled = bool(username and password)

    async def dispatch(self, request: Request, call_next):
        if not self.enabled:
            return await call_next(request)

        # Laisser passer les fichiers statiques sans auth
        if request.url.path.startswith("/static/"):
            return await call_next(request)

        auth = request.headers.get("Authorization", "")
        if auth.startswith("Basic "):
            import base64
            try:
                decoded = base64.b64decode(auth[6:]).decode("utf-8")
                user, _, pwd = decoded.partition(":")
                user_ok = secrets.compare_digest(user, self.username)
                pwd_ok  = secrets.compare_digest(pwd,  self.password)
                if user_ok and pwd_ok:
                    return await call_next(request)
            except Exception:
                pass

        return Response(
            content="Authentification requise",
            status_code=401,
            headers={"WWW-Authenticate": 'Basic realm="IsoStack"'},
        )
