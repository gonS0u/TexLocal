import os
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
PROJECTS_DIR = Path(os.environ.get("LATEX_PROJECTS_DIR", ROOT_DIR / "projects")).resolve()
FRONTEND_DIST = ROOT_DIR / "frontend" / "dist"
BUILD_DIR_NAME = ".build"
COMPILE_TIMEOUT = int(os.environ.get("LATEX_COMPILE_TIMEOUT", "180"))
ENGINES = ("pdflatex", "xelatex", "lualatex")

PROJECTS_DIR.mkdir(parents=True, exist_ok=True)

# Directories never worth descending into when scanning a project.
PRUNE_DIRS = frozenset({BUILD_DIR_NAME, ".history", ".git", "node_modules"})


def walk_files(base: Path, hidden: bool = False):
    """Yield files under base, pruning build/history/VCS dirs without descending into them.

    hidden=False also skips every dot-file/dot-dir (as the editor tree does).
    """
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if d not in PRUNE_DIRS and (hidden or not d.startswith("."))]
        for f in files:
            if hidden or not f.startswith("."):
                yield Path(root, f)
