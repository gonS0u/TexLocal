import os
import shutil
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .config import BUILD_DIR_NAME
from .paths import atomic_write, project_dir, safe_path
from .projects import META

router = APIRouter(prefix="/api/projects/{pid}", tags=["files"])

TEXT_EXT = {".tex", ".bib", ".sty", ".cls", ".bst", ".txt", ".md", ".csv", ".dat", ".tikz", ".bbx", ".cbx", ".lbx", ".cfg", ".def", ".ltx", ".dtx", ".ins", ".json", ".yaml", ".yml", ".py", ".r", ".m", ".lua", ".svg", ".xml", ".log"}
HIDDEN = {BUILD_DIR_NAME, META, ".git", ".history"}


class FileWrite(BaseModel):
    path: str
    content: str


class FileCreate(BaseModel):
    path: str
    kind: str = "file"  # file | folder


class FileMove(BaseModel):
    path: str
    new_path: str


def _tree(base: Path, d: Path, _seen: frozenset = frozenset()) -> list:
    """Directory listing; `_seen` holds the real paths of ancestors so symlink cycles stop."""
    real = os.path.realpath(d)
    if real in _seen:
        return []
    seen = _seen | {real}
    entries = []
    with os.scandir(d) as it:
        for e in it:
            if e.name in HIDDEN or e.name.startswith("."):
                continue
            try:
                is_dir = e.is_dir()
                size = 0 if is_dir else e.stat().st_size
            except OSError:
                continue  # broken symlink / vanished entry
            entries.append((e, is_dir, size))
    entries.sort(key=lambda x: (not x[1], x[0].name.lower()))
    items = []
    for e, is_dir, size in entries:
        p = Path(e.path)
        rel = p.relative_to(base).as_posix()
        if is_dir:
            items.append({"name": e.name, "path": rel, "type": "folder", "children": _tree(base, p, seen)})
        else:
            items.append({"name": e.name, "path": rel, "type": "file", "text": p.suffix.lower() in TEXT_EXT, "size": size})
    return items


def _guard(p: Path, base: Path):
    rel = p.relative_to(base).parts
    if rel and rel[0] in HIDDEN:
        raise HTTPException(400, "Reserved path")


@router.get("/tree")
def tree(pid: str):
    base = project_dir(pid)
    return _tree(base, base)


@router.get("/file")
def read_file(pid: str, path: str):
    base = project_dir(pid)
    p = safe_path(base, path)
    if not p.is_file():
        raise HTTPException(404, "File not found")
    if p.suffix.lower() in TEXT_EXT:
        try:
            return {"path": path, "content": p.read_text(encoding="utf-8"), "mtime": p.stat().st_mtime}
        except UnicodeDecodeError:
            return {"path": path, "content": p.read_text(encoding="latin-1"), "mtime": p.stat().st_mtime}
    raise HTTPException(415, "Binary file")


@router.get("/raw")
def raw_file(pid: str, path: str):
    base = project_dir(pid)
    p = safe_path(base, path)
    if not p.is_file():
        raise HTTPException(404, "File not found")
    return FileResponse(p)


@router.put("/file")
def write_file(pid: str, body: FileWrite):
    base = project_dir(pid)
    p = safe_path(base, body.path)
    _guard(p, base)
    p.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(p, body.content)
    return {"ok": True, "mtime": p.stat().st_mtime}


@router.post("/file")
def create_file(pid: str, body: FileCreate):
    base = project_dir(pid)
    p = safe_path(base, body.path)
    _guard(p, base)
    if p.exists():
        raise HTTPException(409, "Already exists")
    if body.kind == "folder":
        p.mkdir(parents=True)
    else:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("", encoding="utf-8")
    return {"ok": True}


@router.post("/upload")
async def upload(pid: str, folder: str = Form(""), files: list[UploadFile] = File(...), paths: list[str] | None = Form(None)):
    """Upload files; `paths` (optional, parallel to `files`) keeps relative sub-folders."""
    base = project_dir(pid)
    saved = []
    for i, f in enumerate(files):
        rel = paths[i] if paths and i < len(paths) and paths[i] else Path(f.filename or "file").name
        p = safe_path(base, f"{folder}/{rel}" if folder else rel)
        _guard(p, base)
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("wb") as out:
            shutil.copyfileobj(f.file, out)
        saved.append(p.relative_to(base).as_posix())
    return {"ok": True, "saved": saved}


@router.patch("/file")
def move_file(pid: str, body: FileMove):
    base = project_dir(pid)
    src = safe_path(base, body.path)
    dst = safe_path(base, body.new_path)
    _guard(src, base)
    _guard(dst, base)
    if not src.exists():
        raise HTTPException(404, "Not found")
    if dst.exists():
        raise HTTPException(409, "Destination already exists")
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)
    return {"ok": True}


@router.delete("/file")
def delete_file(pid: str, path: str):
    base = project_dir(pid)
    p = safe_path(base, path)
    _guard(p, base)
    if p.is_dir():
        shutil.rmtree(p)
    elif p.exists():
        p.unlink()
    else:
        raise HTTPException(404, "Not found")
    return {"ok": True}
