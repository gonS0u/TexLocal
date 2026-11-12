from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from . import compiler, files, importer, packages, projects, spell, symbols, synctex
from .config import FRONTEND_DIST

app = FastAPI(title="LaTeX Local")

for r in (importer.router, spell.router, projects.router, files.router, compiler.router, synctex.router, symbols.router, packages.router, packages.proj_router):
    app.include_router(r)


if (FRONTEND_DIST / "assets").exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")


@app.get("/{full_path:path}", include_in_schema=False)
def spa(full_path: str):
    if full_path.startswith("api/"):
        return HTMLResponse("Not found", status_code=404)
    index = FRONTEND_DIST / "index.html"
    if index.exists():
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
    return HTMLResponse("<p>Frontend not built yet. Run <code>./run.sh</code>.</p>")
