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

# The viewer is served a stable copy of the last *good* PDF (plus its SyncTeX file),
# published atomically after each compilation. The raw output in .build/ is rewritten
# in place by TeX, truncated at the start of every run and deleted by some fatal errors,
# so serving it directly makes the preview vanish or show garbage.
VIEW_DIR = ".view"


def _pdf_state(p: Path) -> str | None:
    """'complete' (has the %%EOF trailer), 'partial' (a PDF that TeX stopped writing,
    e.g. LuaLaTeX after a fatal error; pdf.js can still show the finished pages) or None."""
    try:
        size = p.stat().st_size
        if size < 64:
            return None
        with p.open("rb") as f:
            if f.read(5) != b"%PDF-":
                return None
            f.seek(max(0, size - 2048))
            return "complete" if b"%%EOF" in f.read() else "partial"
    except OSError:
        return None


def _publish(build: Path, stem: str) -> str | None:
    """Copy build/<stem>.pdf (+ .synctex.gz) to build/.view/ atomically.

    A complete PDF is always published. A partial one only when nothing complete has been
    published yet, so a good preview is never replaced by a truncated one.
    Returns the state published ('complete' / 'partial') or None if nothing was published.
    """
    pdf = build / f"{stem}.pdf"
    state = _pdf_state(pdf)
    if state is None:
        return None
    view = build / VIEW_DIR
    marker = view / f"{stem}.partial"
    if state == "partial" and (view / f"{stem}.pdf").exists() and not marker.exists():
        return None
    view.mkdir(exist_ok=True)
    for name in (f"{stem}.synctex.gz", f"{stem}.pdf"):  # PDF last: its mtime marks a complete publish
        src, dst = build / name, view / name
        if src.exists():
            tmp = view / f".{name}.tmp"
            shutil.copyfile(src, tmp)
            os.replace(tmp, dst)
        elif dst.exists():
            dst.unlink()
    if state == "partial":
        marker.touch()
    elif marker.exists():
        marker.unlink()
    return state


def _aux_file(base: Path, stem: str, ext: str) -> Path | None:
    """Newest <stem>.<ext> in .build/ or in a first-level folder of the project.

    A project's own .latexmkrc may set $aux_dir (e.g. '.aux'), in which case the log and
    the .blg are written there instead of in the output directory.
    """
    name = f"{stem}.{ext}"
    cands = [base / BUILD_DIR_NAME / name, base / name, *base.glob(f"*/{name}")]
    found = [p for p in cands if p.is_file() and VIEW_DIR not in p.parts]
    return max(found, key=lambda p: p.stat().st_mtime, default=None)


def _latexmk_summary(output: str, base: Path) -> list[dict]:
    """latexmk's "Collected error summary" (e.g. biber failing), used when the log has no errors."""
    errs, on = [], False
    for line in output.splitlines():
        if line.startswith("Collected error summary"):
            on = True
            continue
        if on:
            if not line.startswith("  "):
                break
            errs.append({"file": None, "line": None, "message": "latexmk: " + line.strip()})
    if any("biber" in e["message"] for e in errs) and not shutil.which("biber"):
        errs.insert(0, {"file": None, "line": None, "message": "biber is not installed (sudo apt install biber): the bibliography cannot be built."})
    return errs


def view_pdf(pid: str) -> Path | None:
    """The PDF shown to the user: the last good one, published from .build/ if needed."""
    build = project_dir(pid) / BUILD_DIR_NAME
    stem = _main_stem(pid)
    pdf = build / VIEW_DIR / f"{stem}.pdf"
    if pdf.exists():
        return pdf
    if _publish(build, stem):  # projects compiled before the view copy existed
        return pdf
    return None


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
        stem = Path(main).with_suffix("").name
        raw = build / f"{stem}.pdf"
        before = raw.stat().st_mtime_ns if raw.exists() else None
        t0 = time.monotonic()
        rc, output = await _compile(base, main, engine)
        dt = time.monotonic() - t0
        produced = raw.exists() and raw.stat().st_mtime_ns != before
        updated = bool(produced and _publish(build, stem))
    log_file = _aux_file(base, stem, "log")
    log_text = log_file.read_text(errors="replace") if log_file else output
    parsed = parse_log(log_text)
    blg = _aux_file(base, stem, "blg")
    if blg:
        parsed["errors"] += parse_blg(blg.read_text(errors="replace"))
    if rc != 0 and not parsed["errors"]:
        parsed["errors"] += _latexmk_summary(output, base)
    for item in parsed["errors"] + parsed["warnings"]:
        f = item.get("file")
        if f:
            fp = Path(f) if Path(f).is_absolute() else (base / f)
            try:
                item["file"] = fp.resolve().relative_to(base).as_posix()
                item["external"] = False
            except ValueError:
                item["external"] = True
    pdf = build / VIEW_DIR / f"{stem}.pdf"
    return {
        "ok": rc == 0 and not parsed["errors"],
        "pdf": pdf.exists(),
        "pdf_mtime": pdf.stat().st_mtime if pdf.exists() else None,
        "pdf_updated": updated,  # False: errors stopped TeX, the previous PDF is still shown
        "pdf_partial": pdf.with_suffix(".partial").exists(),  # only the pages before a fatal error
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
    pdf = view_pdf(pid)
    if not pdf:
        raise HTTPException(404, "PDF not compiled yet")
    return FileResponse(pdf, media_type="application/pdf", headers={"Cache-Control": "no-store"})


@router.get("/pdf/download")
def download_pdf(pid: str):
    pdf = view_pdf(pid)
    if not pdf:
        raise HTTPException(404, "PDF not compiled yet")
    return FileResponse(pdf, media_type="application/pdf", filename=f"{pid}.pdf")


@router.get("/log", response_class=PlainTextResponse)
def get_log(pid: str):
    base = project_dir(pid)
    log = _aux_file(base, _main_stem(pid), "log")
    return log.read_text(errors="replace") if log else ""
