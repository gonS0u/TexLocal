import asyncio
import shutil
from pathlib import Path

from fastapi import APIRouter, HTTPException

from .compiler import view_pdf
from .paths import project_dir, safe_path

router = APIRouter(prefix="/api/projects/{pid}/synctex", tags=["synctex"])


async def _synctex(args: list[str], cwd: Path) -> str:
    if not shutil.which("synctex"):
        raise HTTPException(500, "synctex is not installed")
    proc = await asyncio.create_subprocess_exec(
        "synctex", *args, cwd=cwd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    out, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
    return out.decode("utf-8", "replace")


def _records(out: str) -> list[dict]:
    recs, cur = [], None
    for line in out.splitlines():
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        if k in ("Output", "Input") and cur is not None and k in cur:
            recs.append(cur)
            cur = None
        if k in ("Output", "Input") and cur is None:
            cur = {}
        if cur is not None:
            cur[k] = v
    if cur:
        recs.append(cur)
    return recs


@router.get("/view")
async def view(pid: str, file: str, line: int, column: int = 0):
    """Source position -> PDF position (PDF points, origin top-left)."""
    base = project_dir(pid)
    src = safe_path(base, file)
    pdf = view_pdf(pid)
    if not pdf:
        raise HTTPException(404, "No PDF")
    # Try a few path spellings: synctex matches the name recorded by TeX.
    rel = src.relative_to(base).as_posix()
    for name in (f"./{rel}", rel, str(src)):
        out = await _synctex(["view", "-i", f"{line}:{column}:{name}", "-o", str(pdf), "-d", str(pdf.parent)], base)
        recs = [r for r in _records(out) if "Page" in r]
        if recs:
            r = recs[0]
            return {
                "page": int(r["Page"]),
                "x": float(r.get("h", r.get("x", 0))),
                "y": float(r.get("v", r.get("y", 0))),
                "width": float(r.get("W", 0)),
                "height": float(r.get("H", 0)),
                "boxes": [{"page": int(x["Page"]), "h": float(x.get("h", 0)), "v": float(x.get("v", 0)), "W": float(x.get("W", 0)), "H": float(x.get("H", 0))} for x in recs[:20]],
            }
    raise HTTPException(404, "Position not found in the PDF")


@router.get("/edit")
async def edit(pid: str, page: int, x: float, y: float):
    """PDF position (points, origin top-left) -> source file/line."""
    base = project_dir(pid)
    pdf = view_pdf(pid)
    if not pdf:
        raise HTTPException(404, "No PDF")
    out = await _synctex(["edit", "-o", f"{page}:{x:.2f}:{y:.2f}:{pdf}", "-d", str(pdf.parent)], base)
    for r in _records(out):
        if "Input" in r and "Line" in r:
            p = Path(r["Input"])
            if not p.is_absolute():
                p = base / p
            p = p.resolve()
            try:
                rel = p.relative_to(base).as_posix()
            except ValueError:
                continue
            return {"file": rel, "line": max(1, int(r["Line"])), "column": max(0, int(r.get("Column", "0") or 0))}
    raise HTTPException(404, "Position not found in the source")
