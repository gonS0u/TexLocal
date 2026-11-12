import os
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[2]
PROJECTS_DIR = Path(os.environ.get("LATEX_PROJECTS_DIR", ROOT_DIR / "projects")).resolve()
FRONTEND_DIST = ROOT_DIR / "frontend" / "dist"
BUILD_DIR_NAME = ".build"
COMPILE_TIMEOUT = int(os.environ.get("LATEX_COMPILE_TIMEOUT", "180"))
ENGINES = ("pdflatex", "xelatex", "lualatex")

PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
