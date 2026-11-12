"""TeX package manager: tlmgr (user mode, no sudo) + apt (via pkexec)."""
import asyncio
import json
import os
import re
import shutil
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .paths import project_dir
from .symbols import DOCCLASS, USEPKG, iter_files, strip_comments

router = APIRouter(prefix="/api/packages", tags=["packages"])

NAME_RX = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$")
FILE_RX = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+/ -]{0,199}$")
DEFAULT_REPO = "https://mirror.ctan.org/systems/texlive/tlnet"


def _check_names(names: list[str]) -> list[str]:
    if not names:
        raise HTTPException(400, "No package given")
    for n in names:
        if not NAME_RX.match(n):
            raise HTTPException(400, f"Invalid package name: {n!r}")
    return names


def texmfhome() -> Path:
    try:
        import subprocess
        v = subprocess.run(["kpsewhich", "-var-value", "TEXMFHOME"], capture_output=True, text=True, timeout=10).stdout.strip()
        if v:
            return Path(v).expanduser()
    except Exception:
        pass
    return Path.home() / "texmf"


def usertree_ready() -> bool:
    return (texmfhome() / "tlpkg" / "texlive.tlpdb").exists()


async def run_capture(cmd: list[str], timeout: float = 120) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        env={**os.environ, "LC_ALL": "C"},
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise HTTPException(504, f"Timed out: {' '.join(cmd[:3])}")
    return proc.returncode, out.decode("utf-8", "replace")


def tlmgr(*args: str) -> list[str]:
    return ["tlmgr", "--usermode", *args]


# ---------------------------------------------------------------- jobs (SSE)
class Job:
    def __init__(self, title: str, cmds: list[list[str]], after=None):
        self.id = uuid.uuid4().hex[:12]
        self.title = title
        self.cmds = cmds
        self.lines: list[str] = []
        self.done = False
        self.rc: int | None = None
        self.started = time.time()
        self.after = after
        self._cond = asyncio.Condition()

    async def emit(self, line: str):
        async with self._cond:
            self.lines.append(line)
            self._cond.notify_all()

    async def run(self):
        rc = 0
        try:
            for cmd in self.cmds:
                await self.emit("$ " + " ".join(cmd))
                proc = await asyncio.create_subprocess_exec(
                    *cmd, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT, env={**os.environ, "LC_ALL": "C"},
                )
                assert proc.stdout
                async for raw in proc.stdout:
                    await self.emit(raw.decode("utf-8", "replace").rstrip("\n"))
                rc = await proc.wait()
                if rc != 0:
                    await self.emit(f"[exited with code {rc}]")
                    break
            if rc == 0 and self.after:
                await self.after(self)
        except Exception as e:  # noqa: BLE001
            rc = -1
            await self.emit(f"[error: {e}]")
        async with self._cond:
            self.rc = rc
            self.done = True
            self._cond.notify_all()

    def info(self):
        return {"id": self.id, "title": self.title, "done": self.done, "rc": self.rc, "started": self.started}


JOBS: dict[str, Job] = {}
_job_lock = asyncio.Lock()
_current: Job | None = None


async def start_job(title: str, cmds: list[list[str]], after=None) -> Job:
    global _current
    async with _job_lock:
        if _current and not _current.done:
            raise HTTPException(409, f"Already running: {_current.title}")
        job = Job(title, cmds, after)
        JOBS[job.id] = job
        _current = job
        asyncio.create_task(job.run())
    return job


async def _refresh_ls(job: Job):
    home = texmfhome()
    if home.exists() and shutil.which("mktexlsr"):
        await job.emit(f"$ mktexlsr {home}")
        rc, out = await run_capture(["mktexlsr", str(home)], timeout=120)
        for l in out.splitlines():
            await job.emit(l)


@router.get("/jobs")
def list_jobs():
    return [j.info() for j in sorted(JOBS.values(), key=lambda j: j.started, reverse=True)[:20]]


@router.get("/jobs/{jid}/stream")
async def stream_job(jid: str):
    job = JOBS.get(jid)
    if not job:
        raise HTTPException(404, "Job not found")

    async def gen():
        i = 0
        while True:
            async with job._cond:
                while i >= len(job.lines) and not job.done:
                    try:
                        await asyncio.wait_for(job._cond.wait(), timeout=15)
                    except asyncio.TimeoutError:
                        break
                new = job.lines[i:]
                i += len(new)
                done = job.done and i >= len(job.lines)
            for l in new:
                yield f"data: {json.dumps({'line': l})}\n\n"
            if not new and not done:
                yield ": keepalive\n\n"
            if done:
                yield f"event: done\ndata: {json.dumps({'rc': job.rc})}\n\n"
                return

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------------------------------------------------------------- status
@router.get("/status")
async def status():
    repo = None
    if shutil.which("tlmgr") and usertree_ready():
        rc, out = await run_capture(tlmgr("option", "repository"), timeout=30)
        m = re.search(r"repository[^:]*:\s*(\S+)", out)
        repo = m.group(1) if m else None
    apt_file_ready = False
    if shutil.which("apt-file"):
        rc, out = await run_capture(["apt-file", "search", "-l", "/usr/bin/tex"], timeout=30)
        apt_file_ready = rc == 0 and bool(out.strip())
    return {
        "tlmgr": bool(shutil.which("tlmgr")),
        "usertree": usertree_ready(),
        "texmfhome": str(texmfhome()),
        "repository": repo,
        "apt_file": bool(shutil.which("apt-file")),
        "apt_file_ready": apt_file_ready,
        "pkexec": bool(shutil.which("pkexec")),
        "latexmk": bool(shutil.which("latexmk")),
        "engines": {e: bool(shutil.which(e)) for e in ("pdflatex", "xelatex", "lualatex", "bibtex", "biber")},
        "busy": _current.info() if _current and not _current.done else None,
    }


class InitReq(BaseModel):
    repository: str = DEFAULT_REPO


@router.post("/init")
async def init_usertree(req: InitReq):
    if not re.match(r"^https?://[\w.:/~+-]+$", req.repository):
        raise HTTPException(400, "Invalid repository")
    cmds = []
    if not usertree_ready():
        cmds.append(tlmgr("init-usertree"))
    cmds.append(tlmgr("option", "repository", req.repository))
    job = await start_job("Set up user tree", cmds)
    return job.info()


# ---------------------------------------------------------------- search / info
def _need_tlmgr():
    if not shutil.which("tlmgr"):
        raise HTTPException(500, "tlmgr is not available")
    if not usertree_ready():
        raise HTTPException(412, "The user tree (~/texmf) is not initialised. Go to Settings.")


@router.get("/search")
async def search(q: str):
    _need_tlmgr()
    q = q.strip()
    if not q or not re.match(r"^[\w .+-]{1,80}$", q):
        raise HTTPException(400, "Invalid search")
    rc, out = await run_capture(tlmgr("search", "--global", q), timeout=180)
    results = []
    for line in out.splitlines():
        m = re.match(r"^([A-Za-z0-9._+-]+) - (.*)$", line)
        if m:
            results.append({"name": m.group(1), "description": m.group(2)})
    if rc != 0 and not results:
        raise HTTPException(502, out.strip()[-500:] or "Search failed")
    installed = {p["name"] for p in await _user_installed()}
    sys_files = await _kpse_have([r["name"] + ".sty" for r in results])
    for r in results:
        r["installed"] = "user" if r["name"] in installed else ("system" if r["name"] + ".sty" in sys_files else None)
    return results[:300]


@router.get("/info/{name}")
async def info(name: str):
    _need_tlmgr()
    _check_names([name])
    rc, out = await run_capture(tlmgr("info", name), timeout=120)
    data = {}
    for line in out.splitlines():
        m = re.match(r"^([\w ]+):\s+(.*)$", line)
        if m:
            data[m.group(1).strip().lower().replace(" ", "_")] = m.group(2)
    if not data:
        raise HTTPException(404, out.strip()[-400:] or "Package not found")
    return data


async def _user_installed() -> list[dict]:
    if not (shutil.which("tlmgr") and usertree_ready()):
        return []
    rc, out = await run_capture(tlmgr("info", "--only-installed", "--data", "name,revision,shortdesc"), timeout=60)
    res = []
    for line in out.splitlines():
        parts = line.split(",", 2)
        if len(parts) >= 2 and NAME_RX.match(parts[0]):
            res.append({"name": parts[0], "revision": parts[1], "description": parts[2].strip('"') if len(parts) > 2 else ""})
    return res


async def _kpse_have(files: list[str]) -> set[str]:
    files = [f for f in files if FILE_RX.match(f)]
    if not files or not shutil.which("kpsewhich"):
        return set()
    found = set()
    for i in range(0, len(files), 200):
        rc, out = await run_capture(["kpsewhich", *files[i:i + 200]], timeout=30)
        found.update(Path(l.strip()).name for l in out.splitlines() if l.strip())
    return found


@router.get("/installed")
async def installed():
    user = [{**p, "source": "user"} for p in await _user_installed()]
    system = []
    if shutil.which("dpkg-query"):
        rc, out = await run_capture(["dpkg-query", "-W", "-f", "${Package}\t${Version}\t${db:Status-Abbrev}\t${binary:Summary}\n", "texlive*", "tex-*", "latexmk", "biber", "lmodern", "cm-super"], timeout=30)
        for line in out.splitlines():
            p = line.split("\t")
            if len(p) >= 4 and p[2].startswith("ii"):
                system.append({"name": p[0], "revision": p[1], "description": p[3], "source": "system"})
    return {"user": user, "system": system}


@router.get("/updates")
async def updates():
    user = []
    if shutil.which("tlmgr") and usertree_ready():
        rc, out = await run_capture(tlmgr("update", "--list", "--all", "--machine-readable"), timeout=240)
        in_body = False
        for line in out.splitlines():
            if line.startswith("end-of-header"):
                in_body = True
                continue
            if line.startswith("end-of-updates"):
                break
            if in_body:
                p = line.split("\t")
                if len(p) >= 4 and p[1] in ("u", "a", "r"):
                    user.append({"name": p[0], "status": {"u": "atualizar", "a": "novo (auto)", "r": "reverter"}[p[1]], "local": p[2], "remote": p[3], "source": "user"})
    system = []
    if shutil.which("apt"):
        rc, out = await run_capture(["apt", "list", "--upgradable"], timeout=60)
        for line in out.splitlines():
            m = re.match(r"^((?:texlive|tex-|latexmk|biber|lmodern|cm-super)[^/\s]*)/\S+\s+(\S+)\s+\S+\s+\[upgradable from: ([^\]]+)\]", line)
            if m:
                system.append({"name": m.group(1), "remote": m.group(2), "local": m.group(3), "status": "atualizar", "source": "system"})
    return {"user": user, "system": system}


# ---------------------------------------------------------------- actions
class PkgReq(BaseModel):
    packages: list[str] = []
    via: str = "tlmgr"  # tlmgr | apt
    all: bool = False


def _apt_cmd(action: str, pkgs: list[str]) -> list[str]:
    if not shutil.which("pkexec"):
        raise HTTPException(500, "pkexec not available; install manually with sudo apt")
    return ["pkexec", "apt-get", action, "-y", *pkgs]


@router.post("/install")
async def install(req: PkgReq):
    pkgs = _check_names(req.packages)
    if req.via == "apt":
        job = await start_job(f"apt install {' '.join(pkgs)}", [_apt_cmd("install", pkgs)])
    else:
        _need_tlmgr()
        job = await start_job(f"tlmgr install {' '.join(pkgs)}", [tlmgr("install", *pkgs)], after=_refresh_ls)
    return job.info()


@router.post("/remove")
async def remove(req: PkgReq):
    pkgs = _check_names(req.packages)
    if req.via == "apt":
        job = await start_job(f"apt remove {' '.join(pkgs)}", [_apt_cmd("remove", pkgs)])
    else:
        _need_tlmgr()
        job = await start_job(f"tlmgr remove {' '.join(pkgs)}", [tlmgr("remove", *pkgs)], after=_refresh_ls)
    return job.info()


@router.post("/update")
async def update(req: PkgReq):
    if req.via == "apt":
        pkgs = _check_names(req.packages)
        job = await start_job("apt upgrade", [_apt_cmd("install", ["--only-upgrade", *pkgs])])
    else:
        _need_tlmgr()
        args = ["--all"] if req.all else _check_names(req.packages)
        job = await start_job("tlmgr update", [tlmgr("update", *args)], after=_refresh_ls)
    return job.info()


class ResolveReq(BaseModel):
    files: list[dict]  # [{file, kind}]


async def _tlmgr_pkg_for_file(fname: str) -> str | None:
    if not (shutil.which("tlmgr") and usertree_ready()):
        return None
    rc, out = await run_capture(tlmgr("search", "--global", "--file", "/" + fname), timeout=180)
    pkg = None
    for line in out.splitlines():
        m = re.match(r"^([A-Za-z0-9._+-]+):$", line)
        if m:
            pkg = m.group(1)
        elif pkg and line.strip().endswith("/" + fname):
            return pkg
    return None


async def _apt_pkg_for_file(fname: str) -> str | None:
    if not shutil.which("apt-file"):
        return None
    rc, out = await run_capture(["apt-file", "search", "-l", "/" + fname], timeout=60)
    cands = [l.strip() for l in out.splitlines() if l.strip()]
    rank = lambda c: 0 if c.startswith("texlive-") else 1 if c.startswith(("tex-", "texlive")) else 2 if "latex" in c else 3
    return sorted(cands, key=rank)[0] if cands else None


@router.post("/resolve")
async def resolve(req: ResolveReq):
    out = []
    for item in req.files[:20]:
        f = str(item.get("file", ""))
        kind = item.get("kind", "file")
        if kind == "babel":
            f = f"{f}.ldf"
        if not FILE_RX.match(f) or ".." in f:
            continue
        name = Path(f).name
        if kind == "font":
            out.append({"file": f, "kind": kind, "tlmgr": None, "apt": None, "hint": "Fonte do sistema: instale-a no SO ou procure um package de fontes."})
            continue
        t, a = await asyncio.gather(_tlmgr_pkg_for_file(name), _apt_pkg_for_file(name))
        out.append({"file": f, "kind": kind, "tlmgr": t, "apt": a})
    return out


# ---------------------------------------------------------------- project check
proj_router = APIRouter(prefix="/api/projects/{pid}", tags=["packages"])


@proj_router.get("/check-packages")
async def check_project(pid: str):
    base = project_dir(pid)
    wanted: dict[str, list[str]] = {}
    local = {p.name for p in base.rglob("*") if p.suffix in (".sty", ".cls")}
    for f in iter_files(base, {".tex"}):
        text = strip_comments(f.read_text(errors="replace"))
        rel = f.relative_to(base).as_posix()
        for m in USEPKG.finditer(text):
            for name in m.group(1).split(","):
                name = name.strip()
                if name:
                    wanted.setdefault(f"{name}.sty", []).append(rel)
        for m in DOCCLASS.finditer(text):
            wanted.setdefault(f"{m.group(1).strip()}.cls", []).append(rel)
    have = await _kpse_have(list(wanted))
    result = []
    for fname, used_in in sorted(wanted.items()):
        ok = fname in have or fname in local
        result.append({"file": fname, "found": ok, "used_in": sorted(set(used_in))})
    return {"packages": result, "missing": [r for r in result if not r["found"]]}
