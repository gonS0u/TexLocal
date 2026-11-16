"""Parse a LaTeX .log produced with -file-line-error and max_print_line=10000."""
import re

FILE_LINE_ERR = re.compile(r"^(?P<file>(?:\.{0,2}/|/)?[^:\n]+?\.(?:tex|sty|cls|bib|ltx|def|cfg|bbl|aux|toc)):(?P<line>\d+): (?P<msg>.*)$")
BANG_ERR = re.compile(r"^! (?P<msg>.*)$")
WARN = re.compile(r"^(?P<kind>(?:LaTeX|Package [\w-]+|Class [\w-]+|pdfTeX|LuaTeX|XeTeX)) Warning: (?P<msg>.*)$")
INPUT_LINE = re.compile(r"on input line (\d+)")
BOX = re.compile(r"^(?P<msg>(?:Overfull|Underfull) \\[hv]box .*?)(?: in paragraph at lines (?P<line>\d+)--\d+| detected at line (?P<line2>\d+)|$)")
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


# Plain-language explanations of common TeX errors. The text is an English template; the
# frontend translates it (i18n) and fills {params} taken from the named regex groups.
HINTS = [
    (re.compile(r"Undefined control sequence"),
     "The command {cmd} does not exist. Check its spelling, or load the package that defines it with \\usepackage{…} in the preamble."),
    (re.compile(r"Missing \$ inserted"),
     "A math-only symbol (such as _ or ^) was used outside math mode, or a $ is missing. Put the formula between $…$, or write \\_ for a literal underscore."),
    (re.compile(r"Environment (?P<env>\S+) undefined"),
     "The environment “{env}” does not exist. Check its spelling, or load the package that defines it."),
    (re.compile(r"\\begin\{(?P<env>[^}]*)\} on input line (?P<l>\d+) ended by \\end\{(?P<env2>[^}]*)\}"),
     "\\begin{{env}} (line {l}) was closed with \\end{{env2}}. Environments must be closed in the reverse order they were opened."),
    (re.compile(r"\\begin\{(?P<env>[^}]*)\} ended by \\end\{document\}"),
     "\\begin{{env}} was never closed: add \\end{{env}} before \\end{document}."),
    (re.compile(r"Missing \} inserted|Extra \}, or forgotten|Too many \}'s|Runaway argument|Paragraph ended before|File ended while scanning"),
     "The braces { } are unbalanced: a { is missing its }, or there is a } too many. Check the text around this line."),
    (re.compile(r"Misplaced alignment tab character"),
     "The & character is only allowed inside tables and aligned equations. To print it, write \\&."),
    (re.compile(r"There's no line here to end"),
     "\\\\ (line break) was used where there is no line to end, e.g. after a blank line or at the start of a paragraph. Remove it or use \\par / a blank line."),
    (re.compile(r"File [`'](?P<file>[^`']+)' not found"),
     "The file “{file}” was not found. Check the name and path (case matters), or install the missing package."),
    (re.compile(r"Unicode character (?P<char>.) .*not set up"),
     "The character “{char}” is not supported by pdfLaTeX. Compile with LuaLaTeX or XeLaTeX, or replace the character."),
    (re.compile(r"Missing \\begin\{document\}"),
     "There is text before \\begin{document}, or the preamble has a typo. Only commands may appear in the preamble."),
    (re.compile(r"Too many unprocessed floats"),
     "Too many figures/tables are waiting to be placed. Add \\clearpage between them or use the [H] / [!htbp] placement."),
    (re.compile(r"Illegal unit of measure"),
     "A length is missing its unit (e.g. write 2cm or 0.5\\textwidth, not 2)."),
    (re.compile(r"Package fontspec Error: The font \"(?P<font>[^\"]+)\" cannot be found"),
     "The font “{font}” is not installed on this system. Install it or choose another font."),
    (re.compile(r"Can be used only in preamble"),
     "This command may only be used before \\begin{document}: move it to the preamble."),
    (re.compile(r"Lonely \\item"),
     "\\item was used outside a list. Put it inside itemize, enumerate or description."),
    (re.compile(r"Something's wrong--perhaps a missing \\item"),
     "A list (itemize/enumerate) has text before its first \\item, or is empty."),
    (re.compile(r'syntax error: found "(?P<field>[^"]+)", expected end of entry'),
     "Syntax error in the .bib file: a comma is probably missing at the end of the line before “{field}” (every field except the last must end with a comma)."),
    (re.compile(r"Citation [`'](?P<key>[^`']+)' .*undefined"),
     "The citation “{key}” was not found in the bibliography: check the key in the .bib file. If it was just added, compile again so biber can run."),
    (re.compile(r"Reference [`'](?P<key>[^`']+)' .*undefined"),
     "The reference “{key}” has no matching \\label{{key}}: check the name. If it was just added, compile again."),
    (re.compile(r"Label [`'](?P<key>[^`']+)' multiply defined"),
     "The label “{key}” is defined more than once: each \\label must be unique."),
]
CS = re.compile(r"\\(?:[A-Za-z@]+|.)")
# Boilerplate between an error and its context that tells nothing to the user.
NOISE = re.compile(r"^(See the \S+ (?:package )?documentation|See the LaTeX manual|Type  H <return>| \.\.\.\s*$|\(That was another \\errmessage\.\))")


def _hint(msg: str, top: str = "") -> tuple[str | None, dict]:
    for rx, text in HINTS:
        m = rx.search(msg)
        if m:
            params = {k: v for k, v in m.groupdict().items() if v is not None}
            if "{cmd}" in text:
                cs = CS.findall(top)
                params["cmd"] = cs[-1] if cs else "?"
            return text, params
    return None, {}


def _block(lines: list[str], i: int) -> tuple[int | None, str, str, str]:
    """What TeX prints after an error at lines[i]: (l.N line number, source excerpt, help, top line).

    The excerpt is the two-line `l.N <code up to the error>` / `<rest of the line>` pair; the help
    is TeX's own explanation that follows it, up to the next blank line.
    """
    top = ""
    for k in range(i + 1, min(i + 25, len(lines))):
        ln = lines[k]
        if not top and ln.strip() and not NOISE.match(ln):
            top = ln
        if FILE_LINE_ERR.match(ln) or BANG_ERR.match(ln):
            break
        lm = re.match(r"^l\.(\d+) ?(.*)$", ln)
        if lm:
            ctx = [ln] + ([lines[k + 1]] if k + 1 < len(lines) else [])  # 2nd line may be blank
            help_lines = []
            for h in lines[k + len(ctx):k + len(ctx) + 15]:
                if not h.strip() or FILE_LINE_ERR.match(h) or BANG_ERR.match(h):
                    break
                help_lines.append(h)
            return int(lm.group(1)), "\n".join(ctx).rstrip(), " ".join(x.strip() for x in help_lines), top
    return None, "", "", top


def parse_log(text: str) -> dict:
    errors, warnings, missing = [], [], []
    lines = text.splitlines()
    seen = set()
    file_stack_hint = None
    for i, line in enumerate(lines):
        m = FILE_LINE_ERR.match(line)
        if m:
            msg = m.group("msg")
            _, ctx, help_, top = _block(lines, i)
            key = (m.group("file"), m.group("line"), msg)
            if key not in seen:
                seen.add(key)
                hint, params = _hint(msg, top)
                errors.append({"file": _norm(m.group("file")), "line": int(m.group("line")), "message": msg,
                               "context": ctx, "help": help_, "hint": hint, "hint_params": params})
            file_stack_hint = _norm(m.group("file"))
        else:
            m = BANG_ERR.match(line)
            if m:
                msg = m.group("msg")
                lnum, ctx, help_, top = _block(lines, i)
                key = (None, lnum, msg)
                if key not in seen and not any(e["message"] == msg for e in errors):
                    seen.add(key)
                    hint, params = _hint(msg, top)
                    errors.append({"file": file_stack_hint, "line": lnum, "message": msg,
                                   "context": ctx, "help": help_, "hint": hint, "hint_params": params})
        m = WARN.match(line)
        if m:
            msg = m.group("msg")
            # Continuation lines of package warnings start with "(pkg)"
            j = i + 1
            while j < len(lines) and re.match(r"^\([\w-]+\)\s+", lines[j]):
                msg += " " + re.sub(r"^\([\w-]+\)\s+", "", lines[j])
                j += 1
            lm = INPUT_LINE.search(msg)
            hint, params = _hint(msg)
            warnings.append({"file": None, "line": int(lm.group(1)) if lm else None, "message": f"{m.group('kind')}: {msg}",
                             "type": "warning", "hint": hint, "hint_params": params})
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


BIBER_LOG = re.compile(r"^\[\d+\] [\w:.]+> (?P<lvl>WARN|ERROR) - (?P<msg>.*)$")
BIBER_SOURCE = re.compile(r"Found BibTeX data source '([^']+)'")
BIBER_TMP = re.compile(r"\S*biber_tmp_\w+/\S+?, line (?P<line>\d+)")
BIBER_ENTRY = re.compile(r"(?:entry|key) '(?P<key>[^']+)'(?: \((?P<file>[^)]+)\))?")


def parse_blg(text: str) -> dict:
    """Errors and warnings from bibtex / biber (.blg)."""
    errors, warnings = [], []
    source = None  # .bib currently being read: biber reports syntax errors on a temp copy of it
    for line in text.splitlines():
        sm = BIBER_SOURCE.search(line)
        if sm:
            source = sm.group(1)
        m = BIBER_LOG.match(line)
        if m:
            msg = m.group("msg").strip()
            msg = re.sub(r"^Datamodel: ", "", msg)
            em = BIBER_ENTRY.search(msg)
            item = {"file": em.group("file") if em and em.group("file") else None, "line": None,
                    "key": em.group("key") if em else None}
            tm = BIBER_TMP.search(msg)
            if tm and source:
                msg = msg.replace(tm.group(0), f"{source}, line {tm.group('line')}")
                item.update(file=source, line=int(tm.group("line")))
            hint, params = _hint(msg)
            item.update(message="Bibliografia: " + msg, hint=hint, hint_params=params)
            if m.group("lvl") == "ERROR":
                errors.append(item)
            else:
                warnings.append({**item, "type": "warning"})
        elif line.startswith("I couldn't open") or "---line" in line or line.startswith("ERROR") or "error message" in line:
            errors.append({"file": None, "line": None, "message": "Bibliografia: " + line.strip()})
    return {"errors": errors, "warnings": warnings}
