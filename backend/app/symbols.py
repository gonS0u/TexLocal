import re

from fastapi import APIRouter

from .config import BUILD_DIR_NAME
from .paths import project_dir

router = APIRouter(prefix="/api/projects/{pid}", tags=["symbols"])

LABEL = re.compile(r"\\label\{([^}]+)\}")
BIBKEY = re.compile(r"@(\w+)\s*\{\s*([^,\s]+)\s*,")
BIBTITLE = re.compile(r"title\s*=\s*[{\"](.+?)[}\"]\s*,?\s*$", re.I | re.M)
NEWCMD = re.compile(r"\\(?:newcommand|renewcommand|DeclareMathOperator)\*?\{?\\([A-Za-z@]+)\}?")
NEWENV = re.compile(r"\\newenvironment\{([^}]+)\}")
USEPKG = re.compile(r"\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^}]+)\}")
DOCCLASS = re.compile(r"\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}")


def iter_files(base, exts):
    for p in base.rglob("*"):
        if p.is_file() and p.suffix.lower() in exts and BUILD_DIR_NAME not in p.parts and not any(x.startswith(".") for x in p.relative_to(base).parts):
            yield p


def strip_comments(text: str) -> str:
    return re.sub(r"(?<!\\)%.*", "", text)


@router.get("/symbols")
def symbols(pid: str):
    base = project_dir(pid)
    labels, cites, commands, envs = [], [], set(), set()
    for f in iter_files(base, {".tex", ".sty", ".cls"}):
        text = strip_comments(f.read_text(errors="replace"))
        rel = f.relative_to(base).as_posix()
        for m in LABEL.finditer(text):
            labels.append({"key": m.group(1), "file": rel, "line": text.count("\n", 0, m.start()) + 1})
        commands.update(NEWCMD.findall(text))
        envs.update(NEWENV.findall(text))
    for f in iter_files(base, {".bib"}):
        text = f.read_text(errors="replace")
        entries = list(BIBKEY.finditer(text))
        for i, m in enumerate(entries):
            if m.group(1).lower() in ("comment", "string", "preamble"):
                continue
            chunk = text[m.end(): entries[i + 1].start() if i + 1 < len(entries) else len(text)]
            t = BIBTITLE.search(chunk)
            cites.append({"key": m.group(2), "type": m.group(1).lower(), "title": (t.group(1) if t else "").replace("{", "").replace("}", "")})
    return {"labels": labels, "citations": cites, "commands": sorted(commands), "environments": sorted(envs)}
