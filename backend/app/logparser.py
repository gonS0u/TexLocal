"""Parse a LaTeX .log produced with -file-line-error and max_print_line=10000."""
import re

FILE_LINE_ERR = re.compile(r"^(?P<file>(?:\.{0,2}/|/)?[^:\n]+?\.(?:tex|sty|cls|bib|ltx|def|cfg|bbl|aux|toc)):(?P<line>\d+): (?P<msg>.*)$")
BANG_ERR = re.compile(r"^! (?P<msg>.*)$")
WARN = re.compile(r"^(?P<kind>(?:LaTeX|Package [\w-]+|Class [\w-]+|pdfTeX|LuaTeX|XeTeX)) Warning: (?P<msg>.*)$")
INPUT_LINE = re.compile(r"on input line (\d+)")
BOX = re.compile(r"^(?P<msg>(?:Overfull|Underfull) \\[hv]box .*?)(?: in paragraph at lines (?P<line>\d+)--\d+| detected at line (?P<line2>\d+)|$)")
L_LINE = re.compile(r"^l\.(\d+)")
MISSING_FILE = [
    re.compile(r"File [`'](?P<f>[^`']+)' not found"),
    re.compile(r"I can't find file [`'](?P<f>[^`']+)'"),
    re.compile(r"Package fontspec Error: The font \"(?P<font>[^\"]+)\" cannot be found"),
    re.compile(r"Font (?:\\[\w@]+=)?(?P<tfm>[\w-]+)(?: at [\d.]+pt)? not loadable: Metric \(TFM\) file not found"),
    re.compile(r"Unknown option [`']?(?P<lang>[\w-]+)' for package `babel'"),
    re.compile(r"Package babel Error: Unknown option [`']?(?P<lang>[\w-]+)'"),
]
MISSING_LIKELY_EXT = (".sty", ".cls", ".def", ".cfg", ".fd", ".bst", ".bbx", ".cbx", ".tex", ".clo", ".ldf", ".lbx")
# Files that the user writes themselves: a missing one is not a package problem.
USER_EXT = (".bib", ".png", ".jpg", ".jpeg", ".pdf", ".eps")


def _norm(f: str) -> str:
    return f[2:] if f.startswith("./") else f


def parse_log(text: str) -> dict:
    errors, warnings, missing = [], [], []
    lines = text.splitlines()
    seen = set()
    file_stack_hint = None
    for i, line in enumerate(lines):
        m = FILE_LINE_ERR.match(line)
        if m:
            msg = m.group("msg")
            ctx = "\n".join(lines[i + 1 : i + 4]).strip()
            key = (m.group("file"), m.group("line"), msg)
            if key not in seen:
                seen.add(key)
                errors.append({"file": _norm(m.group("file")), "line": int(m.group("line")), "message": msg, "context": ctx})
            file_stack_hint = _norm(m.group("file"))
        else:
            m = BANG_ERR.match(line)
            if m:
                msg = m.group("msg")
                lnum = None
                for nxt in lines[i + 1 : i + 12]:
                    lm = L_LINE.match(nxt)
                    if lm:
                        lnum = int(lm.group(1))
                        break
                key = (None, lnum, msg)
                if key not in seen and not any(e["message"] == msg for e in errors):
                    seen.add(key)
                    errors.append({"file": file_stack_hint, "line": lnum, "message": msg, "context": ""})
        m = WARN.match(line)
        if m:
            msg = m.group("msg")
            # Continuation lines of package warnings start with "(pkg)"
            j = i + 1
            while j < len(lines) and re.match(r"^\([\w-]+\)\s+", lines[j]):
                msg += " " + re.sub(r"^\([\w-]+\)\s+", "", lines[j])
                j += 1
            lm = INPUT_LINE.search(msg)
            warnings.append({"file": None, "line": int(lm.group(1)) if lm else None, "message": f"{m.group('kind')}: {msg}", "type": "warning"})
        m = BOX.match(line)
        if m:
            ln = m.group("line") or m.group("line2")
            warnings.append({"file": None, "line": int(ln) if ln else None, "message": m.group("msg"), "type": "box"})
        for rx in MISSING_FILE:
            mm = rx.search(line)
            if mm:
                gd = mm.groupdict()
                if gd.get("f"):
                    f = gd["f"]
                    if f.lower().endswith(USER_EXT):
                        continue
                    if "." not in f.rsplit("/", 1)[-1]:
                        f += ".tex"
                    item = {"file": f, "kind": "file"}
                elif gd.get("font"):
                    item = {"file": gd["font"], "kind": "font"}
                elif gd.get("tfm"):
                    item = {"file": gd["tfm"] + ".tfm", "kind": "file"}
                else:
                    item = {"file": gd["lang"], "kind": "babel"}
                if item not in missing:
                    missing.append(item)
    return {"errors": errors, "warnings": warnings, "missing": missing}


def parse_blg(text: str) -> list:
    """Errors from bibtex (.blg) / biber (.blg)."""
    out = []
    for line in text.splitlines():
        if line.startswith("I couldn't open") or "---line" in line or line.startswith("ERROR") or "error message" in line:
            out.append({"file": None, "line": None, "message": "Bibliografia: " + line.strip()})
    return out
