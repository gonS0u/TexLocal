import asyncio
import os
import re
import shutil
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel

from .config import BUILD_DIR_NAME, COMPILE_TIMEOUT, ENGINES
from .logparser import parse_blg, parse_log
from .paths import project_dir, safe_path
from .projects import read_meta

router = APIRouter(prefix="/api/projects/{pid}", tags=["compile"])

_locks: dict[str, asyncio.Lock] = {}


class CompileReq(BaseModel):
    engine: str | None = None
    main: str | None = None
    clean: bool = False


def _env(base: Path) -> dict:
    env = os.environ.copy()
    # Avoid wrapped log lines so the parser sees whole messages.
    env.update({"max_print_line": "10000", "error_line": "254", "half_error_line": "238"})
    sep = os.pathsep
    for var in ("TEXINPUTS", "BIBINPUTS", "BSTINPUTS"):
        env[var] = f"{base}{sep}{base}//{sep}" + env.get(var, "")
    return env


def _mirror_dirs(base: Path, build: Path):
    """\\include{dir/file} writes dir/file.aux inside the output dir: create it."""
    for d in base.rglob("*"):
        if d.is_dir() and not any(part.startswith(".") for part in d.relative_to(base).parts):
            (build / d.relative_to(base)).mkdir(parents=True, exist_ok=True)


async def _run(cmd: list[str], cwd: Path, env: dict, deadline: float) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        *cmd, cwd=cwd, env=env, stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=max(1, deadline - time.monotonic()))
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise HTTPException(504, f"Compilation exceeded {COMPILE_TIMEOUT}s")
    return proc.returncode, out.decode("utf-8", "replace")


async def _compile(base: Path, main: str, engine: str) -> tuple[int, str]:
    build = base / BUILD_DIR_NAME
    build.mkdir(exist_ok=True)
    _mirror_dirs(base, build)
    env = _env(base)
    deadline = time.monotonic() + COMPILE_TIMEOUT
    common = ["-synctex=1", "-interaction=nonstopmode", "-file-line-error", "-halt-on-error"]
    if shutil.which("latexmk"):
        flag = {"pdflatex": "-pdf", "xelatex": "-xelatex", "lualatex": "-lualatex"}[engine]
        cmd = ["latexmk", flag, "-f", "-silent", f"-outdir={BUILD_DIR_NAME}",
               *[f"-latexoption={o}" for o in common if o != "-halt-on-error"], main]
        return await _run(cmd, base, env, deadline)
    # Fallback without latexmk: engine, bibtex/biber if needed, engine x2.
    if not shutil.which(engine):
        raise HTTPException(500, f"{engine} is not installed")
    eng = [engine, *[o for o in common if o != "-halt-on-error"], f"-output-directory={BUILD_DIR_NAME}", main]
    out_all = []
    rc, out = await _run(eng, base, env, deadline)
    out_all.append(out)
    stem = Path(main).with_suffix("").name
    aux = build / f"{stem}.aux"
    bcf = build / f"{stem}.bcf"
    ran_bib = False
    if bcf.exists() and shutil.which("biber"):
        _, o = await _run(["biber", "--input-directory", str(base), stem], build, env, deadline)
        out_all.append(o)
        ran_bib = True
    elif aux.exists() and re.search(r"\\bibdata", aux.read_text(errors="replace")):
        _, o = await _run(["bibtex", stem], build, env, deadline)
        out_all.append(o)
        ran_bib = True
    log = build / f"{stem}.log"
    needs_rerun = ran_bib or (log.exists() and "Rerun to get" in log.read_text(errors="replace"))
    for _ in range(2 if needs_rerun else 0):
        rc, out = await _run(eng, base, env, deadline)
        out_all.append(out)
        if "Rerun to get" not in log.read_text(errors="replace"):
            break
    return rc, "\n".join(out_all)


@router.post("/compile")
async def compile_project(pid: str, req: CompileReq):
    base = project_dir(pid)
    meta = read_meta(pid)
    engine = req.engine or meta.get("engine", "pdflatex")
    main = req.main or meta.get("main", "main.tex")
    if engine not in ENGINES:
        raise HTTPException(400, "Invalid engine")
    main_path = safe_path(base, main)
    if not main_path.is_file():
        raise HTTPException(400, f"Main file '{main}' does not exist")
    main = main_path.relative_to(base).as_posix()
    lock = _locks.setdefault(pid, asyncio.Lock())
    async with lock:
        build = base / BUILD_DIR_NAME
        if req.clean and build.exists():
            shutil.rmtree(build)
        t0 = time.monotonic()
        rc, output = await _compile(base, main, engine)
        dt = time.monotonic() - t0
    stem = Path(main).with_suffix("").name
    log_file = build / f"{stem}.log"
    log_text = log_file.read_text(errors="replace") if log_file.exists() else output
    parsed = parse_log(log_text)
    blg = build / f"{stem}.blg"
    if blg.exists():
        parsed["errors"] += parse_blg(blg.read_text(errors="replace"))
    for item in parsed["errors"] + parsed["warnings"]:
        f = item.get("file")
        if f:
            fp = Path(f) if Path(f).is_absolute() else (base / f)
            try:
                item["file"] = fp.resolve().relative_to(base).as_posix()
                item["external"] = False
            except ValueError:
                item["external"] = True
    pdf = build / f"{stem}.pdf"
    return {
        "ok": rc == 0 and not parsed["errors"],
        "pdf": pdf.exists(),
        "pdf_mtime": pdf.stat().st_mtime if pdf.exists() else None,
        "duration": round(dt, 2),
        "engine": engine,
        "main": main,
        "output": output[-20000:],
        **parsed,
    }


def _main_stem(pid: str) -> str:
    return Path(read_meta(pid).get("main", "main.tex")).with_suffix("").name


@router.get("/pdf")
def get_pdf(pid: str):
    base = project_dir(pid)
    pdf = base / BUILD_DIR_NAME / f"{_main_stem(pid)}.pdf"
    if not pdf.exists():
        raise HTTPException(404, "PDF not compiled yet")
    return FileResponse(pdf, media_type="application/pdf", headers={"Cache-Control": "no-store"})


@router.get("/pdf/download")
def download_pdf(pid: str):
    base = project_dir(pid)
    pdf = base / BUILD_DIR_NAME / f"{_main_stem(pid)}.pdf"
    if not pdf.exists():
        raise HTTPException(404, "PDF not compiled yet")
    return FileResponse(pdf, media_type="application/pdf", filename=f"{pid}.pdf")


@router.get("/log", response_class=PlainTextResponse)
def get_log(pid: str):
    base = project_dir(pid)
    log = base / BUILD_DIR_NAME / f"{_main_stem(pid)}.log"
    return log.read_text(errors="replace") if log.exists() else ""
