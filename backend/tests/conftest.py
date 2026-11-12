import os
import tempfile

os.environ.setdefault("LATEX_PROJECTS_DIR", tempfile.mkdtemp(prefix="latex-test-"))
os.environ["LATEX_DATA_DIR"] = tempfile.mkdtemp(prefix="latex-data-")
