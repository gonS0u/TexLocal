from pathlib import Path

from app.config import walk_files
from app.files import _tree


def test_walk_files_prunes_and_hides(tmp_path: Path):
    for rel in ("a.tex", "sec/b.tex", ".build/x.aux", ".history/o/1", ".git/HEAD", "node_modules/m.js", ".hidden/h.tex", ".dot"):
        f = tmp_path / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text("x")
    assert {p.relative_to(tmp_path).as_posix() for p in walk_files(tmp_path)} == {"a.tex", "sec/b.tex"}
    with_hidden = {p.relative_to(tmp_path).as_posix() for p in walk_files(tmp_path, hidden=True)}
    assert with_hidden == {"a.tex", "sec/b.tex", ".hidden/h.tex", ".dot"}


def test_tree_survives_symlink_cycle(tmp_path: Path):
    (tmp_path / "d").mkdir()
    (tmp_path / "d" / "f.tex").write_text("x")
    (tmp_path / "d" / "loop").symlink_to(tmp_path, target_is_directory=True)
    tree = _tree(tmp_path, tmp_path)
    assert tree[0]["name"] == "d"
    names = [c["name"] for c in tree[0]["children"]]
    assert "f.tex" in names


def test_middleware_rules():
    from fastapi.testclient import TestClient
    from app.main import app
    c = TestClient(app)
    assert c.get("/api/nope").status_code == 404
    assert c.get("/api/nope").headers["content-type"].startswith("application/json")
    assert c.get("/api/projects", headers={"host": "evil.example"}).status_code == 400
    r = c.post("/api/projects", json={"name": "x"}, headers={"origin": "http://evil.example"})
    assert r.status_code == 403
