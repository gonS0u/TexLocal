import io
import zipfile

from fastapi.testclient import TestClient

from app import history
from app.main import app

c = TestClient(app)


def _proj(name):
    p = c.post("/api/projects", json={"name": name, "template": "article", "lang": "en"}).json()
    return p["id"], f"/api/projects/{p['id']}"


def _write(base, path, content):
    assert c.put(f"{base}/file", json={"path": path, "content": content}).status_code == 200


def test_snapshot_diff_restore():
    pid, base = _proj("Hist A")
    _write(base, "a.tex", "one\ntwo\nthree\n")
    _write(base, "sub/b.tex", "bee\n")
    v1 = c.post(f"{base}/history", json={"label": "first"}).json()["version"]
    assert v1["label"] == "first" and v1["nfiles"] >= 2
    # unchanged content: an unnamed snapshot is skipped
    assert c.post(f"{base}/history", json={}).json() == {"skipped": True}

    _write(base, "a.tex", "one\nTWO\nthree\n")
    c.delete(f"{base}/file", params={"path": "sub/b.tex"})
    _write(base, "new.tex", "x\n")

    files = {f["path"]: f["status"] for f in c.get(f"{base}/history/{v1['id']}/files").json()}
    assert files["a.tex"] == "modified" and files["sub/b.tex"] == "deleted" and files["new.tex"] == "added"
    assert files["main.tex"] == "same"

    d = c.get(f"{base}/history/{v1['id']}/diff", params={"path": "a.tex"}).json()
    lines = [(l["t"], l["s"]) for h in d["hunks"] for l in h["lines"]]
    assert ("-", "two") in lines and ("+", "TWO") in lines

    # restore one file
    assert c.post(f"{base}/history/{v1['id']}/restore", json={"path": "a.tex"}).json()["ok"]
    assert c.get(f"{base}/file", params={"path": "a.tex"}).json()["content"] == "one\ntwo\nthree\n"
    assert any(v["label"].startswith("Before restore") for v in c.get(f"{base}/history").json())

    # restore whole project: deleted file comes back, added file goes away
    assert c.post(f"{base}/history/{v1['id']}/restore", json={}).json()["ok"]
    assert c.get(f"{base}/file", params={"path": "sub/b.tex"}).json()["content"] == "bee\n"
    assert c.get(f"{base}/file", params={"path": "new.tex"}).status_code == 404
    assert c.get(f"/api/projects/{pid}").status_code == 200

    # zip holds the old content
    r = c.get(f"{base}/history/{v1['id']}/zip")
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert z.read(f"{pid}/a.tex").decode() == "one\ntwo\nthree\n"

    # export and copy exclude the history
    ez = zipfile.ZipFile(io.BytesIO(c.get(f"{base}/export").content))
    assert not any(".history" in n for n in ez.namelist())
    cp = c.post(f"{base}/copy", json={"name": "Hist copy"}).json()
    assert c.get(f"/api/projects/{cp['id']}/history").json() == []

    # the history folder is not writable through the files API
    assert c.put(f"{base}/file", json={"path": ".history/x", "content": "x"}).status_code == 400


def test_auto_throttle_and_gc(monkeypatch):
    pid, base = _proj("Hist B")
    assert "version" in c.post(f"{base}/history", json={"auto": True}).json()
    _write(base, "a.tex", "1")
    assert c.post(f"{base}/history", json={"auto": True}).json() == {"skipped": True}  # throttled
    monkeypatch.setattr(history, "AUTO_INTERVAL", 0)
    monkeypatch.setattr(history, "KEEP_AUTO", 2)
    for i in range(4):
        _write(base, "a.tex", f"v{i}")
        assert "version" in c.post(f"{base}/history", json={"auto": True}).json()
    vs = c.get(f"{base}/history").json()
    assert len(vs) == 2 and all(v["auto"] for v in vs)
    from app.paths import project_dir
    objs = list((project_dir(pid) / ".history" / "objects").glob("*/*"))
    keep = {f["sha"] for v in history._versions(project_dir(pid)) for f in v["files"].values()}
    assert {o.name for o in objs} == keep
    # delete
    assert c.delete(f"{base}/history/{vs[0]['id']}").json()["ok"]
    assert len(c.get(f"{base}/history").json()) == 1


def test_bad_ids():
    pid, base = _proj("Hist C")
    assert c.get(f"{base}/history/../files").status_code in (400, 404)
    assert c.get(f"{base}/history/nope/files").status_code == 400
    assert c.get(f"{base}/history/20250101-000000-abcd/files").status_code == 404
    v = c.post(f"{base}/history", json={"label": "x"}).json()["version"]
    assert c.get(f"{base}/history/{v['id']}/diff", params={"path": "missing.tex"}).status_code == 404
    assert c.get(f"{base}/history/{v['id']}/diff", params={"path": "../../etc/passwd"}).status_code in (400, 404)
    assert c.post(f"{base}/history/{v['id']}/restore", json={"path": "missing.tex"}).status_code == 404
