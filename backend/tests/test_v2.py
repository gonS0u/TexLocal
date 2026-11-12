import io
import shutil
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app import spell

c = TestClient(app)


def _zip(files: dict[str, str | bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for n, data in files.items():
            z.writestr(n, data)
    return buf.getvalue()


def test_templates_by_language():
    en = c.post("/api/projects", json={"name": "Lang EN", "template": "thesis", "lang": "en"}).json()
    pt = c.post("/api/projects", json={"name": "Lang PT", "template": "thesis", "lang": "pt"}).json()
    assert en["spell"] == "en_US" and pt["spell"] == "pt_PT"
    src = c.get(f"/api/projects/{pt['id']}/file", params={"path": "main.tex"}).json()["content"]
    assert "[portuguese]{babel}" in src and "capitulos/introducao" in src
    tree = [n["name"] for n in c.get(f"/api/projects/{en['id']}/tree").json()]
    assert "chapters" in tree
    assert c.patch(f"/api/projects/{en['id']}", json={"spell": "pt_PT"}).json()["spell"] == "pt_PT"
    assert c.patch(f"/api/projects/{en['id']}", json={"spell": "x; rm"}).status_code == 400
    assert c.post("/api/projects", json={"name": "x", "lang": "zz"}).status_code == 400


def test_import_zip_strips_root_and_detects():
    data = _zip({
        "Minha Tese/thesis.tex": "\\documentclass{report}\n\\usepackage{fontspec}\n\\usepackage[english,portuguese]{babel}\n\\begin{document}\\input{cap/a}\\end{document}\n",
        "Minha Tese/cap/a.tex": "Olá\n",
        "Minha Tese/thesis.aux": "junk",
        "Minha Tese/.git/config": "x",
        "__MACOSX/._thesis.tex": "x",
    })
    r = c.post("/api/projects/import/zip", files={"file": ("tese.zip", data, "application/zip")})
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["name"] == "Minha Tese" and p["main"] == "thesis.tex" and p["engine"] == "xelatex" and p["spell"] == "pt_PT"
    names = [n["name"] for n in c.get(f"/api/projects/{p['id']}/tree").json()]
    assert sorted(names) == ["cap", "thesis.tex"]


@pytest.mark.parametrize("evil", ["../evil.tex", "a/../../evil.tex"])
def test_import_zip_slip_rejected(evil):
    before = {x["id"] for x in c.get("/api/projects").json()}
    data = _zip({"main.tex": "\\documentclass{article}", evil: "x"})
    r = c.post("/api/projects/import/zip", files={"file": ("evil.zip", data)})
    assert r.status_code == 400
    after = {x["id"] for x in c.get("/api/projects").json()}
    assert before == after  # partially extracted project was removed


def test_import_bad_zip():
    assert c.post("/api/projects/import/zip", files={"file": ("x.zip", b"not a zip")}).status_code == 400


def test_import_browser_folder():
    files = [("files", ("a", b"\\documentclass{article}\\begin{document}x\\end{document}")), ("files", ("b", b"@book{k,}"))]
    data = {"paths": ["proj/main.tex", "proj/bib/refs.bib"]}
    r = c.post("/api/projects/import/files", files=files, data=data)
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["name"] == "proj" and p["main"] == "main.tex" and p["engine"] == "pdflatex"
    assert c.get(f"/api/projects/{p['id']}/file", params={"path": "bib/refs.bib"}).status_code == 200


def test_import_local_path(tmp_path):
    src = tmp_path / "Relatorio"
    (src / "figs").mkdir(parents=True)
    (src / "report.tex").write_text("\\documentclass{article}\n\\usepackage{polyglossia}\n\\setdefaultlanguage{english}\n")
    (src / "figs" / "a.txt").write_text("x")
    (src / "report.log").write_text("junk")
    (src / "link").symlink_to("/etc")
    r = c.post("/api/projects/import/path", json={"path": str(src)})
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["main"] == "report.tex" and p["engine"] == "xelatex" and p["spell"] == "en_US"
    names = sorted(n["name"] for n in c.get(f"/api/projects/{p['id']}/tree").json())
    assert names == ["figs", "report.tex"]
    assert c.post("/api/projects/import/path", json={"path": str(tmp_path / "nope")}).status_code == 400


def test_upload_keeps_subfolders():
    pid = c.post("/api/projects", json={"name": "Upl", "template": "blank"}).json()["id"]
    r = c.post(f"/api/projects/{pid}/upload", files=[("files", ("x.png", b"1")), ("files", ("y.tex", b"2"))],
               data={"paths": ["imgs/x.png", "sec/sub/y.tex"]})
    assert r.status_code == 200, r.text
    assert sorted(r.json()["saved"]) == ["imgs/x.png", "sec/sub/y.tex"]
    bad = c.post(f"/api/projects/{pid}/upload", files=[("files", ("x", b"1"))], data={"paths": ["../../x"]})
    assert bad.status_code == 400


needs_hunspell = pytest.mark.skipif(not shutil.which("hunspell"), reason="hunspell not installed")


@needs_hunspell
def test_spell_languages_and_check():
    langs = c.get("/api/spell/languages").json()
    codes = {d["code"] for d in langs["installed"]}
    if not {"pt_PT", "en_US"} <= codes:
        pytest.skip("pt_PT/en_US dictionaries not installed")
    r = c.post("/api/spell/check", json={"lang": "pt_PT", "words": ["ortografia", "ortogrfia", "Lisboa", "ortogrfia"]})
    assert r.json()["misspelled"] == ["ortogrfia"]
    s = c.get("/api/spell/suggest", params={"lang": "pt_PT", "word": "ortogrfia"}).json()
    assert "ortografia" in s["suggestions"]
    r = c.post("/api/spell/check", json={"lang": "en_US", "words": ["the", "teh", "document", "documnt"]})
    assert sorted(r.json()["misspelled"]) == ["documnt", "teh"]
    assert c.post("/api/spell/check", json={"lang": "../x", "words": ["a"]}).status_code == 400
    assert c.post("/api/spell/check", json={"lang": "xx_YY", "words": ["a"]}).status_code == 404


@needs_hunspell
def test_personal_dictionary():
    assert c.post("/api/spell/dictionary", json={"lang": "en_US", "word": "synctex"}).status_code == 200
    assert "synctex" in c.get("/api/spell/dictionary/en_US").json()["words"]
    assert c.post("/api/spell/check", json={"lang": "en_US", "words": ["synctex"]}).json()["misspelled"] == []
    c.delete("/api/spell/dictionary", params={"lang": "en_US", "word": "synctex"})
    assert c.post("/api/spell/check", json={"lang": "en_US", "words": ["synctex"]}).json()["misspelled"] == ["synctex"]
    assert c.post("/api/spell/dictionary", json={"lang": "en_US", "word": "a b"}).status_code == 400


def test_download_validation():
    assert c.post("/api/spell/download", json={"code": "../../etc"}).status_code == 400
    assert c.post("/api/spell/download", json={"code": "zz"}).status_code == 400
    assert c.delete("/api/spell/languages/en_US").status_code in (400,)  # system dictionaries cannot be removed
    assert spell.CATALOG["pt_PT"][0] == "dictionary-pt-pt"
