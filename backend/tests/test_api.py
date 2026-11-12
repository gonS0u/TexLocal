import os
import shutil
import tempfile

import pytest

_tmp = tempfile.mkdtemp(prefix="latex-test-")
os.environ["LATEX_PROJECTS_DIR"] = _tmp

from fastapi.testclient import TestClient  # noqa: E402

from app.logparser import parse_log  # noqa: E402
from app.main import app  # noqa: E402

c = TestClient(app)


@pytest.fixture(scope="module")
def pid():
    r = c.post("/api/projects", json={"name": "Teste Ção", "template": "article", "lang": "pt"})
    assert r.status_code == 200
    pid = r.json()["id"]
    # Keep tests independent of installed language packs.
    src = c.get(f"/api/projects/{pid}/file", params={"path": "main.tex"}).json()["content"]
    src = src.replace("\\usepackage[portuguese]{babel}\n", "")
    c.put(f"/api/projects/{pid}/file", json={"path": "main.tex", "content": src})
    yield pid


def test_create_and_list(pid):
    assert pid == "teste-cao"
    assert any(p["id"] == pid for p in c.get("/api/projects").json())
    names = [n["name"] for n in c.get(f"/api/projects/{pid}/tree").json()]
    assert "main.tex" in names and "project.json" not in names


@pytest.mark.parametrize("bad", ["../../etc/passwd", "..", "a/../../x"])
def test_path_traversal(pid, bad):
    r = c.get(f"/api/projects/{pid}/file", params={"path": bad})
    assert r.status_code in (400, 404)
    r = c.put(f"/api/projects/{pid}/file", json={"path": bad, "content": "x"})
    assert r.status_code == 400


def test_bad_project_id():
    assert c.get("/api/projects/..%2F..").status_code in (400, 404)
    assert c.get("/api/projects/.hidden").status_code == 400


def test_file_crud(pid):
    assert c.post(f"/api/projects/{pid}/file", json={"path": "sec/a.tex"}).status_code == 200
    assert c.put(f"/api/projects/{pid}/file", json={"path": "sec/a.tex", "content": "olá"}).status_code == 200
    assert c.get(f"/api/projects/{pid}/file", params={"path": "sec/a.tex"}).json()["content"] == "olá"
    assert c.patch(f"/api/projects/{pid}/file", json={"path": "sec/a.tex", "new_path": "sec/b.tex"}).status_code == 200
    assert c.delete(f"/api/projects/{pid}/file", params={"path": "sec"}).status_code == 200
    assert c.put(f"/api/projects/{pid}/file", json={"path": ".build/x.tex", "content": "x"}).status_code == 400


def test_compile_ok_and_synctex(pid):
    r = c.post(f"/api/projects/{pid}/compile", json={}).json()
    assert r["pdf"], r["output"][-2000:]
    assert r["errors"] == [], r["errors"]
    assert c.get(f"/api/projects/{pid}/pdf").status_code == 200
    src = c.get(f"/api/projects/{pid}/file", params={"path": "main.tex"}).json()["content"].splitlines()
    ln = next(i for i, l in enumerate(src, 1) if l.startswith("Texto de exemplo"))
    v = c.get(f"/api/projects/{pid}/synctex/view", params={"file": "main.tex", "line": ln})
    assert v.status_code == 200, v.text
    pos = v.json()
    assert pos["page"] == 1
    e = c.get(f"/api/projects/{pid}/synctex/edit", params={"page": 1, "x": pos["x"] + 5, "y": pos["y"] - 2})
    assert e.status_code == 200, e.text
    assert e.json()["file"] == "main.tex"
    assert abs(e.json()["line"] - ln) <= 2


def test_compile_error_location(pid):
    src = c.get(f"/api/projects/{pid}/file", params={"path": "main.tex"}).json()["content"]
    bad = src.replace("\\section{Introdução}", "\\undefinedcmd\n\\section{Introdução}")
    c.put(f"/api/projects/{pid}/file", json={"path": "main.tex", "content": bad})
    r = c.post(f"/api/projects/{pid}/compile", json={}).json()
    assert not r["ok"]
    err = r["errors"][0]
    ln = next(i for i, l in enumerate(bad.splitlines(), 1) if l == "\\undefinedcmd")
    assert err["file"] == "main.tex" and err["line"] == ln and "Undefined control sequence" in err["message"]
    c.put(f"/api/projects/{pid}/file", json={"path": "main.tex", "content": src})


def test_symbols(pid):
    s = c.get(f"/api/projects/{pid}/symbols").json()
    assert {"key": "sec:intro", "file": "main.tex"}.items() <= s["labels"][0].items()
    assert s["citations"][0]["key"] == "knuth1984"


def test_check_packages(pid):
    src = c.get(f"/api/projects/{pid}/file", params={"path": "main.tex"}).json()["content"]
    c.put(f"/api/projects/{pid}/file", json={"path": "main.tex", "content": src.replace("\\usepackage{hyperref}", "\\usepackage{hyperref}\n\\usepackage{naoexiste123}")})
    r = c.get(f"/api/projects/{pid}/check-packages").json()
    assert [m["file"] for m in r["missing"]] == ["naoexiste123.sty"]
    comp = c.post(f"/api/projects/{pid}/compile", json={}).json()
    assert {"file": "naoexiste123.sty", "kind": "file"} in comp["missing"]
    c.put(f"/api/projects/{pid}/file", json={"path": "main.tex", "content": src})


@pytest.mark.parametrize("bad", ["foo; rm -rf /", "../x", "-x", "a b", ""])
def test_package_name_validation(bad):
    r = c.post("/api/packages/install", json={"packages": [bad]})
    assert r.status_code == 400


def test_logparser_missing():
    log = "/usr/share/texlive/texmf-dist/tex/generic/babel/babel.sty:4459: Package babel Error: Unknown option 'portuguese'. Suggested actions:\n"
    assert parse_log(log)["missing"] == [{"file": "portuguese", "kind": "babel"}]
    log = "./main.tex:3: LaTeX Error: File `siunitx.sty' not found.\n! LaTeX Error: File `foo.cls' not found.\n"
    r = parse_log(log)
    assert {"file": "siunitx.sty", "kind": "file"} in r["missing"]
    assert {"file": "foo.cls", "kind": "file"} in r["missing"]
    assert r["errors"][0]["line"] == 3


def test_job_streaming():
    import asyncio

    from app import packages

    async def go():
        job = await packages.start_job("eco", [["echo", "olá"], ["echo", "fim"]])
        while not job.done:
            await asyncio.sleep(0.05)
        return job

    job = asyncio.run(go())
    assert job.rc == 0 and "olá" in job.lines and "fim" in job.lines
    body = c.get(f"/api/packages/jobs/{job.id}/stream").text
    assert '"line": "fim"' in body and "event: done" in body
