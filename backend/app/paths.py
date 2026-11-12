import re
from pathlib import Path

from fastapi import HTTPException

from .config import PROJECTS_DIR

_PROJECT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")


def project_dir(project_id: str, must_exist: bool = True) -> Path:
    if not _PROJECT_ID.match(project_id) or project_id in (".", ".."):
        raise HTTPException(400, "Invalid project id")
    p = (PROJECTS_DIR / project_id).resolve()
    if p.parent != PROJECTS_DIR:
        raise HTTPException(400, "Invalid project id")
    if must_exist and not p.is_dir():
        raise HTTPException(404, "Project not found")
    return p


def safe_path(base: Path, rel: str) -> Path:
    """Resolve `rel` inside `base`, rejecting anything that escapes it."""
    if rel is None or rel.strip() == "":
        raise HTTPException(400, "Empty path")
    rel = rel.replace("\\", "/").lstrip("/")
    p = (base / rel).resolve()
    try:
        p.relative_to(base)
    except ValueError:
        raise HTTPException(400, "Path outside the project")
    if p == base:
        raise HTTPException(400, "Invalid path")
    return p
