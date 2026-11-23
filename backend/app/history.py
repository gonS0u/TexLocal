"""Version history: content-addressed snapshots of a project's sources in <project>/.history/."""
import difflib
import hashlib
import json
import os
import re
import secrets
import shutil
import tempfile
import time
import zipfile
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from .config import BUILD_DIR_NAME
from .paths import project_dir, safe_path
from .projects import META

router = APIRouter(prefix="/api/projects/{pid}/history", tags=["history"])

HISTORY_DIR = ".history"
SKIP_DIRS = {BUILD_DIR_NAME, HISTORY_DIR, ".git"}
MAX_FILE = 20 * 1024 * 1024
AUTO_INTERVAL = 600  # seconds between automatic snapshots
KEEP_AUTO = 50
_VID = re.compile(r"^\d{8}-\d{6}-[0-9a-f]{4}$")
TEXT_EXT = {".tex", ".bib", ".sty", ".cls", ".bst", ".txt", ".md", ".csv", ".dat", ".tikz", ".bbx", ".cbx", ".lbx", ".cfg",
            ".def", ".ltx", ".dtx", ".ins", ".json", ".yaml", ".yml", ".py", ".r", ".m", ".lua", ".svg", ".xml", ".log"}


class SnapshotReq(BaseModel):
    label: str = ""
    auto: bool = False


class RestoreReq(BaseModel):
    path: str | None = None


# ------------------------------------------------------------------ storage helpers
def _hdir(base: Path) -> Path:
    return base / HISTORY_DIR


def _obj(base: Path, sha: str) -> Path:
    return _hdir(base) / "objects" / sha[:2] / sha


def _source_files(base: Path):
    """(path, rel) of the project's sources: no build output, history, git, metadata, symlinks or huge files."""
    for root, dirs, files in os.walk(base):
        r = Path(root)
        dirs[:] = sorted(d for d in dirs if not (r == base and d in SKIP_DIRS) and not (r / d).is_symlink())
        for f in sorted(files):
            p = r / f
            rel = p.relative_to(base).as_posix()
            if rel == META or p.is_symlink() or not p.is_file():
                continue
            if p.stat().st_size > MAX_FILE:
                continue
            yield p, rel


_hash_cache: dict[str, tuple[int, int, str]] = {}  # path -> (mtime_ns, size, sha)


def _hash(p: Path) -> str:
    """sha256 of a file, memoised on (mtime_ns, size) so unchanged files are not re-read."""
    try:
        st = p.stat()
    except OSError:
        return _hash_uncached(p)
    key = str(p)
    hit = _hash_cache.get(key)
    if hit and hit[0] == st.st_mtime_ns and hit[1] == st.st_size:
        return hit[2]
    sha = _hash_uncached(p)
    if len(_hash_cache) > 20000:
        _hash_cache.clear()
    _hash_cache[key] = (st.st_mtime_ns, st.st_size, sha)
    return sha


def _hash_uncached(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _versions(base: Path) -> list[dict]:
    """All versions, newest first."""
    d = _hdir(base) / "versions"
    if not d.is_dir():
        return []
    out = []
    for f in sorted(d.glob("*.json"), reverse=True):
        try:
            out.append(json.loads(f.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            continue
    return out


def _last_auto_time(base: Path) -> float | None:
    """Time of the newest automatic version, parsing as few version files as possible."""
    d = _hdir(base) / "versions"
    if not d.is_dir():
        return None
    for f in sorted(d.glob("*.json"), reverse=True):
        try:
            v = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if v.get("auto"):
            return v["time"]
    return None


def _load(base: Path, vid: str) -> dict:
    if not _VID.match(vid):
        raise HTTPException(400, "Invalid version id")
    f = _hdir(base) / "versions" / f"{vid}.json"
    if not f.is_file():
        raise HTTPException(404, "Version not found")
    return json.loads(f.read_text(encoding="utf-8"))


def _gc(base: Path):
    """Prune old automatic versions and delete objects no version references."""
    vs = _versions(base)
    autos = [v for v in vs if v.get("auto")]
    for v in autos[KEEP_AUTO:]:
        (_hdir(base) / "versions" / f"{v['id']}.json").unlink(missing_ok=True)
    keep = {f["sha"] for v in _versions(base) for f in v["files"].values()}
    od = _hdir(base) / "objects"
    if od.is_dir():
        for p in od.glob("*/*"):
            if p.name not in keep:
                p.unlink(missing_ok=True)


def snapshot(base: Path, label: str = "", auto: bool = False, only_if_changed: bool = False) -> dict | None:
    """Store the current sources as a new version; None if nothing changed (or throttled, for auto)."""
    now = time.time()
    if auto:
        last = _last_auto_time(base)
        if last is not None and now - last < AUTO_INTERVAL:
            return None
    vs = _versions(base)
    files = {}
    for p, rel in _source_files(base):
        sha = _hash(p)
        o = _obj(base, sha)
        if not o.exists():
            o.parent.mkdir(parents=True, exist_ok=True)
            tmp = o.with_suffix(".tmp")
            shutil.copyfile(p, tmp)
            tmp.replace(o)
        files[rel] = {"sha": sha, "size": p.stat().st_size}
    if vs and vs[0]["files"] == files and (auto or only_if_changed or not label):
        return None
    vid = time.strftime("%Y%m%d-%H%M%S", time.localtime(now)) + "-" + secrets.token_hex(2)
    v = {"id": vid, "time": now, "label": label.strip()[:200], "auto": bool(auto), "files": files}
    vd = _hdir(base) / "versions"
    vd.mkdir(parents=True, exist_ok=True)
    (vd / f"{vid}.json").write_text(json.dumps(v), encoding="utf-8")
    _gc(base)
    return v


def _summary(v: dict, prev: dict | None) -> dict:
    pf = prev["files"] if prev else {}
    changed = sum(1 for k, f in v["files"].items() if pf.get(k, {}).get("sha") != f["sha"]) + sum(1 for k in pf if k not in v["files"])
    return {"id": v["id"], "time": v["time"], "label": v.get("label", ""), "auto": v.get("auto", False),
            "nfiles": len(v["files"]), "changed": changed}


def _read_text(data: bytes) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("latin-1")


# ------------------------------------------------------------------ routes
@router.get("")
def list_versions(pid: str):
    base = project_dir(pid)
    vs = _versions(base)
    return [_summary(v, vs[i + 1] if i + 1 < len(vs) else None) for i, v in enumerate(vs)]


@router.post("")
def create_version(pid: str, body: SnapshotReq | None = None):
    body = body or SnapshotReq()
    v = snapshot(project_dir(pid), body.label, body.auto)
    if v is None:
        return {"skipped": True}
    return {"version": _summary(v, None)}


@router.delete("/{vid}")
def delete_version(pid: str, vid: str):
    base = project_dir(pid)
    _load(base, vid)
    (_hdir(base) / "versions" / f"{vid}.json").unlink()
    _gc(base)
    return {"ok": True}


@router.get("/{vid}/files")
def version_files(pid: str, vid: str):
    base = project_dir(pid)
    v = _load(base, vid)
    current = {rel: p for p, rel in _source_files(base)}
    out = []
    for rel, f in v["files"].items():
        p = current.get(rel)
        if p is None:
            status = "deleted"
        else:
            status = "same" if p.stat().st_size == f["size"] and _hash(p) == f["sha"] else "modified"
        out.append({"path": rel, "status": status, "text": Path(rel).suffix.lower() in TEXT_EXT})
    for rel in current:
        if rel not in v["files"]:
            out.append({"path": rel, "status": "added", "text": Path(rel).suffix.lower() in TEXT_EXT})
    out.sort(key=lambda x: x["path"].lower())
    return out


@router.get("/{vid}/diff")
def version_diff(pid: str, vid: str, path: str):
    """Line diff from the version (old) to the file on disk now (new)."""
    base = project_dir(pid)
    v = _load(base, vid)
    f = v["files"].get(path)
    p = safe_path(base, path)
    if f is None and not p.is_file():
        raise HTTPException(404, "File not found")
    if Path(path).suffix.lower() not in TEXT_EXT:
        return {"binary": True, "hunks": []}
    old = _read_text(_obj(base, f["sha"]).read_bytes()).splitlines() if f else []
    new = _read_text(p.read_bytes()).splitlines() if p.is_file() else []
    hunks = []
    for group in difflib.SequenceMatcher(None, old, new, autojunk=False).get_grouped_opcodes(3):
        lines = []
        for tag, i1, i2, j1, j2 in group:
            if tag == "equal":
                lines += [{"t": " ", "s": s} for s in old[i1:i2]]
                continue
            if tag in ("replace", "delete"):
                lines += [{"t": "-", "s": s} for s in old[i1:i2]]
            if tag in ("replace", "insert"):
                lines += [{"t": "+", "s": s} for s in new[j1:j2]]
        hunks.append({"old_start": group[0][1] + 1, "new_start": group[0][3] + 1, "lines": lines})
    return {"binary": False, "hunks": hunks}


@router.post("/{vid}/restore")
def restore_version(pid: str, vid: str, body: RestoreReq | None = None):
    base = project_dir(pid)
    v = _load(base, vid)
    path = body.path if body else None
    if path and path not in v["files"]:
        raise HTTPException(404, "File not in this version")
    snapshot(base, f"Before restore ({vid})", only_if_changed=True)
    targets = {path: v["files"][path]} if path else v["files"]
    for rel, f in targets.items():
        p = safe_path(base, rel)
        if p.relative_to(base).parts[0] in SKIP_DIRS or rel == META:
            continue
        if p.is_dir():
            shutil.rmtree(p)
        p.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(_obj(base, f["sha"]), p)
    if not path:
        for p, rel in list(_source_files(base)):
            if rel not in v["files"]:
                p.unlink()
        # drop folders left empty by the deletions
        for root, dirs, _files in os.walk(base, topdown=False):
            r = Path(root)
            if r == base or set(r.relative_to(base).parts) & SKIP_DIRS:
                continue
            if not any(r.iterdir()):
                r.rmdir()
    return {"ok": True}


@router.get("/{vid}/zip")
def version_zip(pid: str, vid: str):
    base = project_dir(pid)
    v = _load(base, vid)
    fd, tmp = tempfile.mkstemp(prefix="latexlocal-version-", suffix=".zip")
    os.close(fd)
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
            for rel, f in v["files"].items():
                z.write(_obj(base, f["sha"]), f"{pid}/{rel}")
    except Exception:
        os.unlink(tmp)
        raise
    return FileResponse(tmp, media_type="application/zip", filename=f"{pid}-{vid}.zip",
                        headers={"Cache-Control": "no-store"}, background=BackgroundTask(os.unlink, tmp))
