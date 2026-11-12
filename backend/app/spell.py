"""Spell checking with Hunspell (pipe mode), personal dictionaries and downloadable languages."""
import asyncio
import os
import re
import shutil
import urllib.request
from collections import OrderedDict
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .packages import Job, start_job

router = APIRouter(prefix="/api/spell", tags=["spell"])

DATA_DIR = Path(os.environ.get("LATEX_DATA_DIR", Path.home() / ".local" / "share" / "latexlocal")).expanduser()
USER_DICTS = DATA_DIR / "dictionaries"
SYSTEM_DIRS = [Path("/usr/share/hunspell"), Path("/usr/share/myspell"), Path("/usr/share/myspell/dicts")]
CDN = "https://cdn.jsdelivr.net/npm/{pkg}/index.{ext}"

CODE_RX = re.compile(r"^[A-Za-z]{2,3}(?:_[A-Za-z0-9]{2,8})*$")
WORD_RX = re.compile(r"^[^\s\\{}$%]{1,60}$")

# code -> (npm package from wooorm/dictionaries, English name, native name)
CATALOG: dict[str, tuple[str, str, str]] = {
    "en_US": ("dictionary-en", "English (US)", "English (US)"),
    "en_GB": ("dictionary-en-gb", "English (UK)", "English (UK)"),
    "en_AU": ("dictionary-en-au", "English (Australia)", "English (Australia)"),
    "en_CA": ("dictionary-en-ca", "English (Canada)", "English (Canada)"),
    "pt_PT": ("dictionary-pt-pt", "Portuguese (Portugal)", "Português (Portugal)"),
    "pt_BR": ("dictionary-pt", "Portuguese (Brazil)", "Português (Brasil)"),
    "es": ("dictionary-es", "Spanish", "Español"),
    "fr": ("dictionary-fr", "French", "Français"),
    "de": ("dictionary-de", "German", "Deutsch"),
    "de_AT": ("dictionary-de-at", "German (Austria)", "Deutsch (Österreich)"),
    "de_CH": ("dictionary-de-ch", "German (Switzerland)", "Deutsch (Schweiz)"),
    "it": ("dictionary-it", "Italian", "Italiano"),
    "nl": ("dictionary-nl", "Dutch", "Nederlands"),
    "ca": ("dictionary-ca", "Catalan", "Català"),
    "gl": ("dictionary-gl", "Galician", "Galego"),
    "eu": ("dictionary-eu", "Basque", "Euskara"),
    "pl": ("dictionary-pl", "Polish", "Polski"),
    "cs": ("dictionary-cs", "Czech", "Čeština"),
    "sk": ("dictionary-sk", "Slovak", "Slovenčina"),
    "sl": ("dictionary-sl", "Slovenian", "Slovenščina"),
    "hr": ("dictionary-hr", "Croatian", "Hrvatski"),
    "hu": ("dictionary-hu", "Hungarian", "Magyar"),
    "ro": ("dictionary-ro", "Romanian", "Română"),
    "bg": ("dictionary-bg", "Bulgarian", "Български"),
    "ru": ("dictionary-ru", "Russian", "Русский"),
    "uk": ("dictionary-uk", "Ukrainian", "Українська"),
    "el": ("dictionary-el", "Greek", "Ελληνικά"),
    "tr": ("dictionary-tr", "Turkish", "Türkçe"),
    "sv": ("dictionary-sv", "Swedish", "Svenska"),
    "da": ("dictionary-da", "Danish", "Dansk"),
    "nb": ("dictionary-nb", "Norwegian (Bokmål)", "Norsk bokmål"),
    "nn": ("dictionary-nn", "Norwegian (Nynorsk)", "Norsk nynorsk"),
    "is": ("dictionary-is", "Icelandic", "Íslenska"),
    "lt": ("dictionary-lt", "Lithuanian", "Lietuvių"),
    "lv": ("dictionary-lv", "Latvian", "Latviešu"),
    "et": ("dictionary-et", "Estonian", "Eesti"),
    "ga": ("dictionary-ga", "Irish", "Gaeilge"),
    "cy": ("dictionary-cy", "Welsh", "Cymraeg"),
    "la": ("dictionary-la", "Latin", "Latina"),
}


def hunspell_bin() -> str | None:
    return shutil.which("hunspell")


def installed() -> dict[str, dict]:
    """code -> {code, name, source, path (without extension)}; user dictionaries win over system ones."""
    out: dict[str, dict] = {}
    for src, dirs in (("system", SYSTEM_DIRS), ("user", [USER_DICTS])):
        for d in dirs:
            if not d.is_dir():
                continue
            for aff in sorted(d.glob("*.aff")):
                code = aff.stem
                if not CODE_RX.match(code) or not aff.with_suffix(".dic").exists():
                    continue
                name = CATALOG.get(code, (None, code, code))
                out[code] = {"code": code, "name": name[1], "native": name[2], "source": src, "path": str(aff.with_suffix(""))}
    return out


def _personal_file(code: str) -> Path:
    return DATA_DIR / f"personal-{code}.txt"


def personal_words(code: str) -> set[str]:
    f = _personal_file(code)
    if not f.exists():
        return set()
    return {w.strip() for w in f.read_text(encoding="utf-8").splitlines() if w.strip()}


def _save_personal(code: str, words: set[str]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _personal_file(code).write_text("\n".join(sorted(words, key=str.lower)) + ("\n" if words else ""), encoding="utf-8")


class Speller:
    """One long-running `hunspell -a` process per language, with an LRU cache of results."""

    def __init__(self, code: str, path: str):
        self.code = code
        self.path = path
        self.proc: asyncio.subprocess.Process | None = None
        self.lock: asyncio.Lock | None = None
        self.loop = None
        self.cache: OrderedDict[str, list[str] | None] = OrderedDict()  # word -> None (ok) | suggestions

    async def _ensure(self):
        if self.proc and self.proc.returncode is None and self.loop is asyncio.get_running_loop():
            return
        self.close()
        self.loop = asyncio.get_running_loop()
        self.proc = await asyncio.create_subprocess_exec(
            hunspell_bin() or "hunspell", "-a", "-i", "utf-8", "-d", self.path,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            env={**os.environ, "LC_ALL": "C.UTF-8"},
        )
        await asyncio.wait_for(self.proc.stdout.readline(), timeout=20)  # banner

    async def _ask(self, word: str) -> list[str] | None:
        assert self.proc and self.proc.stdin and self.proc.stdout
        self.proc.stdin.write(("^" + word + "\n").encode("utf-8"))
        await self.proc.stdin.drain()
        bad, sugg = False, []
        while True:
            line = (await asyncio.wait_for(self.proc.stdout.readline(), timeout=20)).decode("utf-8", "replace").rstrip("\n")
            if line == "":
                break
            if line[0] == "&":
                bad = True
                if ":" in line:
                    sugg += [s.strip() for s in line.split(":", 1)[1].split(",") if s.strip()]
            elif line[0] == "#":
                bad = True
        return sugg[:8] if bad else None

    async def check(self, words: list[str]) -> dict[str, list[str] | None]:
        res: dict[str, list[str] | None] = {}
        todo = []
        for w in words:
            if w in self.cache:
                self.cache.move_to_end(w)
                res[w] = self.cache[w]
            else:
                todo.append(w)
        if todo:
            if self.lock is None or self.loop is not asyncio.get_running_loop():
                self.lock = asyncio.Lock()
            async with self.lock:
                for attempt in range(2):
                    try:
                        await self._ensure()
                        for w in todo:
                            if w not in res:
                                res[w] = await self._ask(w)
                                self.cache[w] = res[w]
                        break
                    except (asyncio.TimeoutError, BrokenPipeError, ConnectionResetError, AssertionError):
                        if self.proc and self.proc.returncode is None:
                            self.proc.kill()
                        self.proc = None
                        if attempt:
                            raise HTTPException(500, "Hunspell stopped responding")
            while len(self.cache) > 50000:
                self.cache.popitem(last=False)
        return res

    def close(self):
        if self.proc and self.proc.returncode is None:
            self.proc.kill()
        self.proc = None


SPELLERS: dict[str, Speller] = {}


def speller(code: str) -> Speller:
    if not CODE_RX.match(code or ""):
        raise HTTPException(400, "Invalid language")
    if not hunspell_bin():
        raise HTTPException(500, "hunspell is not installed")
    d = installed().get(code)
    if not d:
        raise HTTPException(404, "Dictionary not installed")
    sp = SPELLERS.get(code)
    if not sp or sp.path != d["path"]:
        if sp:
            sp.close()
        sp = SPELLERS[code] = Speller(code, d["path"])
    return sp


def _valid_words(words: list[str]) -> list[str]:
    return list(dict.fromkeys(w for w in words if isinstance(w, str) and WORD_RX.match(w)))


# ---------------------------------------------------------------- endpoints
@router.get("/languages")
def languages():
    inst = installed()
    return {
        "available": bool(hunspell_bin()),
        "installed": sorted(({k: v for k, v in d.items() if k != "path"} for d in inst.values()), key=lambda d: d["name"]),
        "catalog": [
            {"code": c, "name": n, "native": nat, "installed": c in inst} for c, (_, n, nat) in CATALOG.items()
        ],
    }


class CheckBody(BaseModel):
    lang: str
    words: list[str]


@router.post("/check")
async def check(body: CheckBody):
    if len(body.words) > 5000:
        raise HTTPException(413, "Too many words")
    sp = speller(body.lang)
    words = _valid_words(body.words)
    personal = personal_words(body.lang)
    words = [w for w in words if w not in personal]
    res = await sp.check(words)
    return {"misspelled": [w for w, s in res.items() if s is not None]}


@router.get("/suggest")
async def suggest(lang: str, word: str):
    if not WORD_RX.match(word):
        raise HTTPException(400, "Invalid word")
    res = await speller(lang).check([word])
    return {"word": word, "suggestions": res.get(word) or []}


class WordBody(BaseModel):
    lang: str
    word: str


@router.get("/dictionary/{lang}")
def get_personal(lang: str):
    if not CODE_RX.match(lang):
        raise HTTPException(400, "Invalid language")
    return {"lang": lang, "words": sorted(personal_words(lang), key=str.lower)}


@router.post("/dictionary")
def add_word(body: WordBody):
    if not CODE_RX.match(body.lang) or not WORD_RX.match(body.word):
        raise HTTPException(400, "Invalid word")
    words = personal_words(body.lang)
    words.add(body.word)
    _save_personal(body.lang, words)
    return {"ok": True}


@router.delete("/dictionary")
def remove_word(lang: str, word: str):
    if not CODE_RX.match(lang):
        raise HTTPException(400, "Invalid language")
    words = personal_words(lang)
    words.discard(word)
    _save_personal(lang, words)
    return {"ok": True}


class DownloadBody(BaseModel):
    code: str


def _fetch(url: str, dest: Path) -> int:
    req = urllib.request.Request(url, headers={"User-Agent": "latex-local"})
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(req, timeout=60) as r, tmp.open("wb") as out:
        shutil.copyfileobj(r, out)
    size = tmp.stat().st_size
    if size == 0:
        tmp.unlink()
        raise RuntimeError(f"empty download: {url}")
    return size


@router.post("/download")
async def download(body: DownloadBody):
    if body.code not in CATALOG:
        raise HTTPException(400, "Unknown dictionary")
    pkg = CATALOG[body.code][0]
    USER_DICTS.mkdir(parents=True, exist_ok=True)

    async def do(job: Job):
        parts = []
        for ext in ("aff", "dic"):
            url = CDN.format(pkg=pkg, ext=ext)
            dest = USER_DICTS / f"{body.code}.{ext}"
            await job.emit(f"GET {url}")
            size = await asyncio.to_thread(_fetch, url, dest)
            await job.emit(f"  {size / 1024:.0f} KiB")
            parts.append(dest)
        for dest in parts:  # only publish once both files are complete
            dest.with_suffix(dest.suffix + ".part").replace(dest)
        SPELLERS.pop(body.code, None)
        await job.emit(f"Installed {body.code} in {USER_DICTS}")

    job = await start_job(f"Download dictionary {body.code}", [], after=do)
    return job.info()


@router.delete("/languages/{code}")
def remove_language(code: str):
    if not CODE_RX.match(code):
        raise HTTPException(400, "Invalid language")
    d = installed().get(code)
    if not d or d["source"] != "user":
        raise HTTPException(400, "Only downloaded dictionaries can be removed")
    for ext in ("aff", "dic"):
        (USER_DICTS / f"{code}.{ext}").unlink(missing_ok=True)
    sp = SPELLERS.pop(code, None)
    if sp:
        sp.close()
    return {"ok": True}
