import os
from urllib.parse import urlsplit

from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import compiler, files, history, importer, packages, projects, spell, symbols, synctex
from .config import FRONTEND_DIST

app = FastAPI(title="LaTeX Local")

# The API can read and write the user's disk, so only answer requests meant for this app:
# a foreign Host (DNS rebinding) or a cross-site Origin on a state-changing call is refused.
# Set LATEX_ALLOWED_HOSTS="host1,host2" when serving it under another name.
_hosts = ["127.0.0.1", "localhost", "[::1]", "testserver"] + [h for h in os.environ.get("LATEX_ALLOWED_HOSTS", "").split(",") if h]
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=_hosts)


@app.middleware("http")
async def same_origin_writes(request, call_next):
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin")
        if origin and origin != "null" and urlsplit(origin).netloc != request.headers.get("host"):
            return JSONResponse({"detail": "Cross-origin request refused"}, status_code=403)
    return await call_next(request)


for r in (importer.router, spell.router, projects.router, files.router, compiler.router, synctex.router, symbols.router, history.router, packages.router, packages.proj_router):
    app.include_router(r)


class ImmutableStatic(StaticFiles):
    """Vite fingerprints everything in /assets, so browsers can cache it forever."""

    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp


if (FRONTEND_DIST / "assets").exists():
    app.mount("/assets", ImmutableStatic(directory=FRONTEND_DIST / "assets"), name="assets")


@app.get("/{full_path:path}", include_in_schema=False)
def spa(full_path: str):
    if full_path.startswith("api/"):
        return JSONResponse({"detail": "Not found"}, status_code=404)
    index = FRONTEND_DIST / "index.html"
    if index.exists():
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
    return HTMLResponse("<p>Frontend not built yet. Run <code>./run.sh</code>.</p>")
