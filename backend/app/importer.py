"""Import projects from a .zip, from a folder uploaded by the browser, or from a local folder on disk."""
import os
import re
import shutil
import stat
import time
import zipfile
from pathlib import Path, PurePosixPath

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from .config import BUILD_DIR_NAME, PROJECTS_DIR
from .paths import project_dir, safe_path
from .projects import META, new_project_id, read_meta, write_meta
from .symbols import DOCCLASS, USEPKG, strip_comments

router = APIRouter(prefix="/api/projects/import", tags=["import"])

MAX_TOTAL = 500 * 1024 * 1024
MAX_FILES = 20000
SKIP_DIRS = {".git", ".svn", ".hg", "__MACOSX", BUILD_DIR_NAME, "node_modules", ".idea", ".vscode"}
SKIP_FILES = {".DS_Store", "Thumbs.db", META}
AUX_SUFFIXES = (
    ".aux", ".log", ".synctex.gz", ".synctex", ".fls", ".fdb_latexmk", ".out", ".toc", ".blg", ".bcf",
    ".run.xml", ".lof", ".lot", ".xdv", ".nav", ".snm", ".synctex(busy)",
)

LANG_MAP = {
    "portuguese": "pt_PT", "portuges": "pt_PT", "portugues": "pt_PT", "portugal": "pt_PT",
    "brazil": "pt_BR", "brazilian": "pt_BR",
    "english": "en_US", "american": "en_US", "USenglish": "en_US", "british": "en_GB", "UKenglish": "en_GB",
    "spanish": "es", "french": "fr", "francais": "fr", "german": "de", "ngerman": "de", "italian": "it",
    "dutch": "nl", "catalan": "ca", "galician": "gl", "polish": "pl", "russian": "ru", "swedish": "sv",
    "danish": "da", "norsk": "nb", "finnish": "fi", "czech": "cs", "greek": "el", "turkish": "tr", "romanian": "ro",
}
XELATEX_PKGS = {"fontspec", "polyglossia", "unicode-math", "xeCJK", "mathspec"}
LUALATEX_PKGS = {"luacode", "luatextra", "luaotfload", "lua-visual-debug"}


def _skip(parts: tuple[str, ...]) -> bool:
    if not parts:
        return True
    if any(p in SKIP_DIRS for p in parts[:-1]):
        return True
    name = parts[-1]
    return name in SKIP_FILES or name.lower().endswith(AUX_SUFFIXES)


def _strip_common_root(names: list[str]) -> str:
    """If every entry lives under the same single top folder, return that prefix."""
    firsts = {PurePosixPath(n).parts[0] for n in names if PurePosixPath(n).parts}
    if len(firsts) == 1 and all(len(PurePosixPath(n).parts) > 1 for n in names):
        return next(iter(firsts)) + "/"
    return ""


def detect(base: Path) -> dict:
    """Guess main file, engine and spell-check language."""
    texs = sorted(p for p in base.rglob("*.tex") if BUILD_DIR_NAME not in p.parts)
    cands = []
    for p in texs:
        try:
            txt = strip_comments(p.read_text(errors="replace"))
        except OSError:
            continue
        if DOCCLASS.search(txt):
            cands.append((p, txt))

    def rank(item):
        p, _ = item
        rel = p.relative_to(base)
        name = p.stem.lower()
        preferred = name in ("main", "thesis", "tese", "dissertacao", "dissertation", "report", "relatorio", "paper", "artigo")
        return (len(rel.parts), 0 if name == "main" else 1 if preferred else 2, str(rel))

    main, main_text = (sorted(cands, key=rank)[0] if cands else (None, ""))
    all_text = main_text + "\n".join(t for _, t in cands)
    pkgs = {x.strip() for m in USEPKG.findall(all_text) for x in m.split(",")}
    engine = "pdflatex"
    if pkgs & LUALATEX_PKGS:
        engine = "lualatex"
    elif pkgs & XELATEX_PKGS:
        engine = "xelatex"

    spell = None
    m = re.search(r"\\set(?:default|main)language(?:\[[^\]]*\])?\{(\w+)\}", main_text)
    if m:
        spell = LANG_MAP.get(m.group(1))
    if not spell:
        opts = []
        for mm in re.finditer(r"\\usepackage\[([^\]]*)\]\{babel\}", main_text):
            opts += [o.strip() for o in mm.group(1).split(",")]
        mm = re.search(r"\\documentclass\[([^\]]*)\]", main_text)
        if mm:
            opts += [o.strip() for o in mm.group(1).split(",")]
        for o in opts:
            o = o.split("=")[-1]
            if o in LANG_MAP:
                spell = LANG_MAP[o]  # babel: the last language option is the main one
    return {
        "main": main.relative_to(base).as_posix() if main else "main.tex",
        "engine": engine,
        "spell": spell or "en_US",
    }


def _finish(pid: str, name: str) -> dict:
    d = project_dir(pid)
    info = detect(d)
    write_meta(pid, {"name": name, **info, "created": time.time()})
    return read_meta(pid)


def _new_dir(name: str) -> tuple[str, Path]:
    pid = new_project_id(name)
    d = project_dir(pid, must_exist=False)
    d.mkdir(parents=True)
    return pid, d


def _clean_name(name: str | None, fallback: str) -> str:
    n = (name or "").strip() or fallback.strip() or "Imported project"
    return n[:120]


@router.post("/zip")
async def import_zip(file: UploadFile = File(...), name: str = Form("")):
    try:
        zf = zipfile.ZipFile(file.file)
    except zipfile.BadZipFile:
        raise HTTPException(400, "Not a valid ZIP file")
    with zf:
        infos = [i for i in zf.infolist() if not i.is_dir()]
        infos = [i for i in infos if not stat.S_ISLNK(i.external_attr >> 16)
                 and not _skip(PurePosixPath(i.filename.replace("\\", "/")).parts)]
        names = [i.filename.replace("\\", "/") for i in infos]
        if len(infos) > MAX_FILES:
            raise HTTPException(413, f"Too many files (max {MAX_FILES})")
        if sum(i.file_size for i in infos) > MAX_TOTAL:
            raise HTTPException(413, "ZIP too large (max 500 MB uncompressed)")
        prefix = _strip_common_root(names)
        stem = Path(file.filename or "project.zip").stem
        pid, d = _new_dir(_clean_name(name, prefix.rstrip("/") or stem))
        try:
            for info, n in zip(infos, names):
                rel = n[len(prefix):] if prefix else n
                parts = PurePosixPath(rel).parts
                if _skip(parts):
                    continue
                target = safe_path(d, rel)  # raises on zip-slip
                target.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(info) as src, target.open("wb") as out:
                    shutil.copyfileobj(src, out)
        except Exception:
            shutil.rmtree(d, ignore_errors=True)
            raise
    return _finish(pid, _clean_name(name, prefix.rstrip("/") or stem))


@router.post("/files")
async def import_files(files: list[UploadFile] = File(...), paths: list[str] = Form(...), name: str = Form("")):
    """A folder chosen in the browser (webkitdirectory); `paths` holds each file's relative path."""
    if len(files) != len(paths):
        raise HTTPException(400, "files and paths must have the same length")
    if len(files) > MAX_FILES:
        raise HTTPException(413, f"Too many files (max {MAX_FILES})")
    pairs = [(f, p.replace("\\", "/").lstrip("/")) for f, p in zip(files, paths)]
    pairs = [(f, p) for f, p in pairs if not _skip(PurePosixPath(p).parts)]
    norm = [p for _, p in pairs]
    prefix = _strip_common_root(norm)
    title = _clean_name(name, prefix.rstrip("/"))
    pid, d = _new_dir(title)
    total = 0
    try:
        for (f, _), rel in zip(pairs, norm):
            rel = rel[len(prefix):] if prefix else rel
            if _skip(PurePosixPath(rel).parts):
                continue
            target = safe_path(d, rel)
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("wb") as out:
                shutil.copyfileobj(f.file, out)
            total += target.stat().st_size
            if total > MAX_TOTAL:
                raise HTTPException(413, "Folder too large (max 500 MB)")
    except Exception:
        shutil.rmtree(d, ignore_errors=True)
        raise
    return _finish(pid, title)


class PathImport(BaseModel):
    path: str
    name: str | None = None


@router.post("/path")
def import_path(body: PathImport):
    """Copy a folder that already exists on this machine into a new project."""
    src = Path(os.path.expanduser(body.path.strip())).resolve()
    if not body.path.strip() or not src.is_dir():
        raise HTTPException(400, "Folder not found")
    if src == PROJECTS_DIR or PROJECTS_DIR in src.parents:
        raise HTTPException(400, "That folder is already inside the projects directory")
    count, total = 0, 0
    for root, dirs, fnames in os.walk(src):
        dirs[:] = [x for x in dirs if x not in SKIP_DIRS and not os.path.islink(os.path.join(root, x))]
        for fn in fnames:
            fp = os.path.join(root, fn)
            if os.path.islink(fp):
                continue
            count += 1
            total += os.path.getsize(fp)
        if count > MAX_FILES:
            raise HTTPException(413, f"Too many files (max {MAX_FILES})")
        if total > MAX_TOTAL:
            raise HTTPException(413, "Folder too large (max 500 MB)")

    def ignore(dirpath, names):
        out = set()
        for n in names:
            full = os.path.join(dirpath, n)
            if os.path.islink(full) or n in SKIP_DIRS or n in SKIP_FILES or n.lower().endswith(AUX_SUFFIXES):
                out.add(n)
        return out

    title = _clean_name(body.name, src.name)
    pid = new_project_id(title)
    d = project_dir(pid, must_exist=False)
    try:
        shutil.copytree(src, d, symlinks=True, ignore=ignore)
    except OSError as e:
        shutil.rmtree(d, ignore_errors=True)
        raise HTTPException(500, f"Copy failed: {e}")
    return _finish(pid, title)
