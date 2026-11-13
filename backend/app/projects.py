import json
import os
import re
import shutil
import tempfile
import time
import unicodedata
import zipfile

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from .config import BUILD_DIR_NAME, ENGINES, PROJECTS_DIR
from .paths import project_dir

router = APIRouter(prefix="/api/projects", tags=["projects"])

META = "project.json"

BIB = r"""@book{knuth1984,
  author    = {Donald E. Knuth},
  title     = {The {\TeX}book},
  publisher = {Addison-Wesley},
  year      = {1984}
}
"""

TEXT = {
    "en": {
        "babel": "english", "spell": "en_US",
        "title": "Document Title", "thesis_title": "Dissertation Title", "author": "Author",
        "intro": "Introduction", "abstract": "Abstract of the dissertation.",
        "body": r"Example text. See Section~\ref{sec:intro} and reference~\cite{knuth1984}.",
        "chapter_body": r"Introduction text~\cite{knuth1984}.", "chapters": "chapters", "intro_file": "introduction",
    },
    "pt": {
        "babel": "portuguese", "spell": "pt_PT",
        "title": "Título do Documento", "thesis_title": "Título da Dissertação", "author": "Autor",
        "intro": "Introdução", "abstract": "Resumo da dissertação.",
        "body": r"Texto de exemplo. Ver a Secção~\ref{sec:intro} e a referência~\cite{knuth1984}.",
        "chapter_body": r"Texto da introdução~\cite{knuth1984}.", "chapters": "capitulos", "intro_file": "introducao",
    },
}

PREAMBLE = r"""\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[%(babel)s]{babel}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
"""


def render_template(template: str, lang: str) -> dict[str, str]:
    t = TEXT[lang]
    pre = PREAMBLE % t
    if template == "article":
        return {
            "main.tex": r"\documentclass[11pt,a4paper]{article}" "\n" + pre + r"""\usepackage{hyperref}

\title{%(title)s}
\author{%(author)s}
\date{\today}

\begin{document}
\maketitle

\section{%(intro)s}\label{sec:intro}
%(body)s

\begin{equation}\label{eq:example}
  E = mc^2
\end{equation}

\bibliographystyle{plain}
\bibliography{refs}
\end{document}
""" % t,
            "refs.bib": BIB,
        }
    if template == "thesis":
        return {
            "main.tex": r"\documentclass[12pt,a4paper,oneside]{report}" "\n" + pre + r"""\usepackage[margin=2.5cm]{geometry}
\usepackage{setspace}
\usepackage{hyperref}
\onehalfspacing

\title{%(thesis_title)s}
\author{%(author)s}
\date{\today}

\begin{document}
\maketitle
\begin{abstract}
%(abstract)s
\end{abstract}
\tableofcontents

\include{%(chapters)s/%(intro_file)s}

\bibliographystyle{plain}
\bibliography{refs}
\end{document}
""" % t,
            f"{t['chapters']}/{t['intro_file']}.tex": r"\chapter{%(intro)s}\label{cap:intro}" "\n%(chapter_body)s\n" % t,
            "refs.bib": BIB,
        }
    return {"main.tex": "\\documentclass{article}\n\\begin{document}\n\n\\end{document}\n"}


TEMPLATES = ("article", "thesis", "blank")
SPELL_RX = re.compile(r"^(off|[A-Za-z]{2,3}(?:[_-][A-Za-z0-9]{2,8})*)$")


class ProjectCreate(BaseModel):
    name: str
    template: str = "article"
    lang: str = "en"


class ProjectCopy(BaseModel):
    name: str | None = None


class ProjectUpdate(BaseModel):
    name: str | None = None
    main: str | None = None
    engine: str | None = None
    spell: str | None = None


def slugify(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    s = re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-").lower()
    return s[:60] or "project"


def new_project_id(name: str) -> str:
    base = slugify(name)
    pid, i = base, 2
    while (PROJECTS_DIR / pid).exists():
        pid = f"{base}-{i}"
        i += 1
    return pid


def read_meta(pid: str) -> dict:
    d = project_dir(pid)
    meta = {"id": pid, "name": pid, "main": "main.tex", "engine": "pdflatex", "spell": "en_US"}
    f = d / META
    if f.exists():
        try:
            meta.update(json.loads(f.read_text()))
        except json.JSONDecodeError:
            pass
    meta["id"] = pid
    meta["modified"] = max(
        (p.stat().st_mtime for p in d.rglob("*") if BUILD_DIR_NAME not in p.parts and p.is_file()),
        default=d.stat().st_mtime,
    )
    return meta


def write_meta(pid: str, meta: dict) -> None:
    d = project_dir(pid)
    data = {k: meta[k] for k in ("name", "main", "engine", "spell", "created") if k in meta}
    (d / META).write_text(json.dumps(data, indent=2, ensure_ascii=False))


@router.get("")
def list_projects():
    out = []
    for d in sorted(PROJECTS_DIR.iterdir()):
        if d.is_dir() and not d.name.startswith("."):
            try:
                out.append(read_meta(d.name))
            except HTTPException:
                continue
    out.sort(key=lambda m: m["modified"], reverse=True)
    return out


@router.post("")
def create_project(body: ProjectCreate):
    if body.template not in TEMPLATES:
        raise HTTPException(400, "Unknown template")
    if body.lang not in TEXT:
        raise HTTPException(400, "Unknown language")
    pid = new_project_id(body.name)
    d = project_dir(pid, must_exist=False)
    d.mkdir()
    for rel, content in render_template(body.template, body.lang).items():
        f = d / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(content)
    meta = {"name": body.name.strip() or pid, "main": "main.tex", "engine": "pdflatex",
            "spell": TEXT[body.lang]["spell"], "created": time.time()}
    write_meta(pid, meta)
    return read_meta(pid)


@router.get("/{pid}")
def get_project(pid: str):
    return read_meta(pid)


@router.patch("/{pid}")
def update_project(pid: str, body: ProjectUpdate):
    meta = read_meta(pid)
    if body.name is not None:
        meta["name"] = body.name.strip() or meta["name"]
    if body.main is not None:
        meta["main"] = body.main
    if body.engine is not None:
        if body.engine not in ENGINES:
            raise HTTPException(400, "Invalid engine")
        meta["engine"] = body.engine
    if body.spell is not None:
        if not SPELL_RX.match(body.spell):
            raise HTTPException(400, "Invalid language")
        meta["spell"] = body.spell
    write_meta(pid, meta)
    return read_meta(pid)


@router.delete("/{pid}")
def delete_project(pid: str):
    shutil.rmtree(project_dir(pid))
    return {"ok": True}


@router.post("/{pid}/copy")
def copy_project(pid: str, body: ProjectCopy | None = None):
    """Duplicate a project's sources (not its build output) under a new id."""
    src = project_dir(pid)
    meta = read_meta(pid)
    name = ((body.name if body else None) or "").strip()[:120] or f"{meta['name']} (copy)"
    new_id = new_project_id(name)
    dst = project_dir(new_id, must_exist=False)
    shutil.copytree(src, dst, symlinks=True, ignore=shutil.ignore_patterns(BUILD_DIR_NAME))
    write_meta(new_id, {**meta, "name": name, "created": time.time()})
    return read_meta(new_id)


def _export_files(d):
    """Project sources to export: no build output, no metadata, no symlinks."""
    for p in sorted(d.rglob("*")):
        rel = p.relative_to(d)
        if BUILD_DIR_NAME in rel.parts or rel.as_posix() == META:
            continue
        if p.is_symlink() or not p.is_file():
            continue
        yield p, rel.as_posix()


@router.get("/{pid}/export")
def export_project(pid: str):
    """The whole project as a .zip with a single top-level folder named after the project id."""
    d = project_dir(pid)
    fd, tmp = tempfile.mkstemp(prefix="latexlocal-export-", suffix=".zip")
    os.close(fd)
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
            for p, rel in _export_files(d):
                z.write(p, f"{pid}/{rel}")
    except Exception:
        os.unlink(tmp)
        raise
    return FileResponse(tmp, media_type="application/zip", filename=f"{pid}.zip",
                        headers={"Cache-Control": "no-store"}, background=BackgroundTask(os.unlink, tmp))
