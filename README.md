# LaTeX Local

A self-hosted LaTeX editor in the spirit of Overleaf, running entirely on your own machine. You write on the left, the compiled PDF updates on the right, and everything stays on your disk: no accounts, no cloud, no upload limits.

Portuguese version: [README.pt-PT.md](README.pt-PT.md)

---

## Contents

1. [Features](#features)
2. [Requirements](#requirements)
3. [Getting started](#getting-started)
4. [Usage](#usage)
5. [Keyboard shortcuts](#keyboard-shortcuts)
6. [Where your data lives](#where-your-data-lives)
7. [Configuration](#configuration)
8. [Security notes](#security-notes)
9. [Project structure](#project-structure)
10. [Development](#development)
11. [Troubleshooting](#troubleshooting)

---

## Features

**Editing**
- CodeMirror 6 editor with LaTeX syntax highlighting, using a high-contrast palette (at least 4.5:1 contrast in both themes).
- Context-aware autocompletion for commands, environments, `\ref{}` labels and `\cite{}` keys taken from your `.bib` files.
- Multiple open files in tabs, search and replace, comment toggling, adjustable font size.
- Spell checking in English and European Portuguese, with about 40 more languages available for download.

**Compiling**
- `pdflatex`, `xelatex` and `lualatex`, selectable per project.
- Uses `latexmk` when installed; otherwise runs the engine, BibTeX or Biber, and the extra passes itself.
- Optional automatic compilation about two seconds after you stop typing.
- A log panel that lists errors and warnings; clicking one jumps to the offending line.

**PDF preview**
- Opens at 100% (real paper size), with zoom in and out, fit-to-width and a one-click return to 100%.
- Shows the current page and the total page count; type a page number to jump to it.
- Two-way SyncTeX: jump from the cursor to the PDF, or double-click the PDF to jump to the source.
- Can be opened in a separate window (for example on a second monitor) that stays in sync with the editor.

**Projects**
- Templates (article, thesis, blank) in English or Portuguese.
- Import from a ZIP file (for example an Overleaf export), from a folder chosen in the browser, or from a folder on disk.
- Duplicate a project, or export the whole project as a ZIP file.
- Projects are ordinary folders, so they work with Git, backups and other editors.

**Package manager**
- Detects missing packages after a failed compilation and maps them to TeX Live and Debian packages.
- Installs without root through `tlmgr --usermode`, or system-wide through `apt` with a graphical password prompt.
- Lists installed packages and available updates.

**Interface**
- English (default) or European Portuguese.
- Light and dark themes, following the system preference until you choose one.

---

## Requirements

| Component | Version / notes |
|---|---|
| Operating system | Linux (developed on Debian-based distributions) |
| Python | 3.10 or newer, with `venv` |
| Node.js and npm | 18 or newer (only needed to build the interface) |
| TeX Live | Any recent distribution providing `pdflatex` |
| Hunspell | Required for spell checking |

Recommended packages on Debian, Ubuntu or Kali:

```bash
sudo apt install texlive-latex-extra latexmk texlive-xetex texlive-luatex biber \
                 texlive-lang-portuguese texlive-lang-english hunspell hunspell-pt-pt hunspell-en-us
```

Everything except a working `pdflatex` is optional: the application reports what is missing and the package manager can install it later.

---

## Getting started

```bash
./run.sh
```

Then open <http://127.0.0.1:8765> in your browser.

On the first run the script:
1. creates a Python virtual environment in `.venv` and installs the backend dependencies;
2. installs the frontend dependencies and builds the interface into `frontend/dist`;
3. warns about missing recommended tools (`latexmk`, `xelatex`, `biber`);
4. starts the server.

Later runs only rebuild the interface when its source files have changed. To use a different port:

```bash
PORT=9000 ./run.sh
```

Do not run `run.sh` with `sudo`. The application never needs root to run; if root files end up in `.venv`, see [Troubleshooting](#troubleshooting).

---

## Usage

### Creating a project

On the start page, enter a name, choose a template and choose the document language. The language sets the Babel option, the sample text and the project's spell-checking language.

### Importing an existing project

The **Import** section on the start page offers three methods:

| Method | Use it for |
|---|---|
| ZIP file | Overleaf exports or any zipped project. If the archive contains a single top-level folder, that folder becomes the project root. |
| Folder | A folder chosen in the browser, or dragged onto the drop zone. |
| Folder on disk | A path such as `~/Documents/thesis`. The folder is copied; the original is never modified. |

During import the application:
- finds the main file (the `.tex` file containing `\documentclass`, preferring `main.tex`);
- selects `xelatex` when the project uses `fontspec`, `polyglossia` or `unicode-math`;
- selects the spell-checking language from the Babel or Polyglossia options;
- skips build artefacts (`.aux`, `.log`, `.synctex.gz` and similar), version-control folders such as `.git`, and symbolic links.

Imports are limited to 500 MB and 20,000 files.

Inside an open project you can also add files by dragging them onto the file tree, or upload a whole folder with the upload-folder button in the file tree toolbar. Subfolders are preserved.

### Copying and exporting a project

Open the **Project** menu in the top bar of a project. It has two entries:

- **Make a copy...** asks for a name (suggested: the current name followed by "(copy)") and creates a new, independent project with the same files and settings: main file, engine and spell-check language. It then opens the copy. Use this to keep a snapshot before making large changes.
- **Download as ZIP** downloads every source file of the project as `<project-id>.zip`.

Both actions save any unsaved changes in the editor first, so the copy and the ZIP always match what you see. The project list has the same actions as **Copy** and **ZIP** buttons on each project card.

Build output (`.build/`) and the `project.json` settings file are left out. The copy is recompiled when you open it. The ZIP holds a single top-level folder, so it can be imported again here, or uploaded to Overleaf, without changes.

### Editing and compiling

- **Compile** (or Ctrl+S) saves all open files and compiles the project.
- The **Auto** checkbox compiles automatically after you pause typing.
- The engine selector chooses between `pdflatex`, `xelatex` and `lualatex`.
- Right-click a file in the tree to set it as the main file, rename it or delete it.
- The **Log** panel at the bottom lists errors and warnings. Click an entry to open the file at that line.

### Working with the PDF

- The toolbar above the PDF holds the zoom controls: zoom out, the current zoom level (click it to return to 100%), zoom in, fit to width, and 1:1 (actual size).
- The page box shows the visible page and the total number of pages. Type a number and press Enter to jump to that page.
- Zoom level and scroll position are kept when you recompile.
- **Source to PDF:** press Ctrl+Enter, or use the arrow button, to highlight the text under the cursor in the PDF.
- **PDF to source:** double-click anywhere in the PDF to open the corresponding line in the editor.

#### PDF in a separate window

Click the "Open PDF in a new window" button at the right of the PDF toolbar to move the preview into its own browser window, which you can place on another monitor. While it is open:

- The PDF pane in the main window is collapsed, so the editor takes the full width. A narrow strip on the right edge has a "Reattach PDF" button.
- Every compilation reloads the PDF in the separate window, keeping its zoom level and page.
- SyncTeX works across both windows: Ctrl+Enter in the editor highlights the position in the separate window, and double-clicking there jumps to the line in the editor.
- Ctrl+S in the PDF window saves and compiles, just as it does in the editor.
- Closing the window, or clicking "Reattach PDF" in either window, brings the PDF back into the main window.

If nothing happens when you click the button, your browser is blocking pop-ups: allow them for `127.0.0.1`.

### Spell checking

- Choose the language for each project in the selector in the editor toolbar, or pick "Spelling: off". The selector's "Manage dictionaries" entry opens the dictionary manager.
- Misspelled words get a wavy red underline. Right-click one to see suggestions, add the word to your personal dictionary, or ignore it for the rest of the session.
- Only prose is checked. Commands, mathematics, comments, labels, citation keys, file names, URLs and code environments (`verbatim`, `lstlisting`, `minted`) are skipped, as are acronyms and words containing digits.
- To add a language, open **Packages**, go to the **Dictionaries** tab and choose **Download**. Dictionaries come from the open-source [wooorm/dictionaries](https://github.com/wooorm/dictionaries) collection. The same tab lets you remove downloaded dictionaries and edit your personal word lists.

### Managing LaTeX packages

Open **Packages** in the project toolbar.

| Tab | Purpose |
|---|---|
| Missing | Packages, classes and Babel languages the last compilation could not find, plus a check of every `\usepackage` in the project. Each entry shows the CTAN package and the Debian package that provides it. |
| Search | Find a package or file by name and install it. |
| Installed | Packages installed in your user tree and on the system. |
| Updates | Packages with newer versions available, with update actions. |
| Dictionaries | Spell-checking languages (see above). |
| Settings | Initialise the user tree (`~/texmf`) before the first user-mode installation. |

There are two ways to install a package:
- **User mode:** `tlmgr --usermode` installs into `~/texmf`. No administrator password is needed.
- **System:** `apt`, run through `pkexec`, which asks for the administrator password in a system dialog.

### Interface language and theme

The **EN | PT** switch in the top bar changes the interface language; your choice is remembered. The theme button switches between light and dark. **A-** and **A+** change the editor font size.

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+S | Save all files and compile |
| Ctrl+Enter | Show the cursor position in the PDF (SyncTeX) |
| Double-click in the PDF | Go to the matching source line |
| Ctrl+Space | Open autocompletion |
| Ctrl+B | Wrap the selection in `\textbf{}` |
| Ctrl+I | Wrap the selection in `\textit{}` |
| Ctrl+/ | Comment or uncomment the current line |
| Ctrl+F | Search and replace |
| Enter in the page box | Jump to the typed page |

On macOS, use Cmd instead of Ctrl.

---

## Where your data lives

| Location | Contents |
|---|---|
| `projects/<id>/` | Your project files, exactly as you see them in the file tree |
| `projects/<id>/project.json` | Project settings: name, main file, engine, spell-checking language |
| `projects/<id>/.build/` | Compilation output: PDF, log, SyncTeX and auxiliary files |
| `~/.local/share/latexlocal/dictionaries/` | Downloaded spell-checking dictionaries |
| `~/.local/share/latexlocal/personal-<lang>.txt` | Your personal word list for each language |
| `~/texmf/` | Packages installed in user mode with `tlmgr` |

Interface preferences (language, theme, font size, panel sizes) are stored in your browser.

To back up a project, copy its folder. The `.build` folder can always be deleted; it is regenerated on the next compilation.

---

## Configuration

All settings are optional environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8765` | Port the server listens on (read by `run.sh`) |
| `LATEX_PROJECTS_DIR` | `./projects` | Folder that holds the projects |
| `LATEX_DATA_DIR` | `~/.local/share/latexlocal` | Folder for dictionaries and personal word lists |
| `LATEX_COMPILE_TIMEOUT` | `180` | Maximum compilation time, in seconds |

Example:

```bash
LATEX_PROJECTS_DIR=~/Documents/latex-projects PORT=9000 ./run.sh
```

---

## Security notes

LaTeX Local is designed for a single user on their own computer.

- The server listens only on `127.0.0.1` and has no authentication. Do not expose it to a network.
- Every file path is resolved and checked to stay inside its project, which protects against path traversal and "zip slip" archives. Symbolic links are not followed during import.
- Documents are compiled without `-shell-escape`, so a document cannot run arbitrary shell commands.
- System-wide package installation requires the administrator password through `pkexec`. The server itself never runs as root.
- Dictionary downloads only accept language codes from a built-in list and are fetched from the jsDelivr CDN.

---

## Project structure

```
.
├── run.sh                  Start script: creates the environment, builds the UI, runs the server
├── backend/
│   ├── requirements.txt
│   ├── app/
│   │   ├── main.py         FastAPI application; serves the API and the built interface
│   │   ├── config.py       Paths, timeouts and environment variables
│   │   ├── paths.py        Safe path resolution inside a project
│   │   ├── projects.py     Project list, creation from templates, settings
│   │   ├── importer.py     ZIP, browser-folder and disk-folder import with auto-detection
│   │   ├── files.py        File tree, read, write, upload, rename, delete
│   │   ├── compiler.py     latexmk or manual engine/BibTeX/Biber runs
│   │   ├── logparser.py    Turns the LaTeX log into errors and warnings
│   │   ├── synctex.py      Source-to-PDF and PDF-to-source lookups
│   │   ├── symbols.py      Labels, citations and commands for autocompletion
│   │   ├── packages.py     tlmgr and apt package management, background jobs
│   │   └── spell.py        Hunspell spell checking and dictionary downloads
│   └── tests/              pytest suite
├── frontend/
│   ├── index.html
│   ├── vite.config.js
│   └── src/
│       ├── main.js         Pages, layout, toolbars and wiring
│       ├── editor.js       CodeMirror setup, highlighting, key bindings
│       ├── completion.js   LaTeX autocompletion
│       ├── spellcheck.js   LaTeX-aware spell-check extension
│       ├── pdfviewer.js    PDF.js viewer with zoom, page tracking and SyncTeX
│       ├── pdfpane.js      PDF toolbar, shared by the main and the separate PDF window
│       ├── filetree.js     File tree, drag-and-drop and uploads
│       ├── logpanel.js     Compilation log panel
│       ├── packages.js     Package and dictionary manager
│       ├── i18n.js         English and Portuguese interface strings
│       ├── api.js          HTTP client and DOM helpers
│       └── style.css       Themes and layout
└── projects/               Your projects (created on first run)
```

---

## Development

Run the backend tests:

```bash
cd backend
../.venv/bin/pip install -r requirements-dev.txt   # once: installs pytest
../.venv/bin/python -m pytest -q
```

Work on the interface with hot reload. Start the backend with `./run.sh` first; the Vite development server proxies `/api` requests to it.

```bash
cd frontend
npm run dev      # http://127.0.0.1:5173
```

Build the interface for production (`run.sh` does this automatically when sources change):

```bash
cd frontend
npm run build
```

To add a new interface string, write it in English inside `t('...')` and add its Portuguese translation to the dictionary in `frontend/src/i18n.js`. Untranslated strings fall back to English.

---

## Troubleshooting

**"xelatex not found" or "biber not found" at startup.**
These tools are optional. Projects using `pdflatex` and BibTeX work without them. Install them with `sudo apt install texlive-xetex biber`, or from the Packages dialog.

**Compilation fails with "File `something.sty' not found".**
Open **Packages**, then **Missing**, and choose **Resolve**. You can install the package in user mode without a password.

**A document that uses `minted` or another package needing `-shell-escape` does not compile.**
Shell escape is disabled for security. Use `listings` instead of `minted`.

**`run.sh` fails with "Permission denied" inside `.venv`.**
The environment was created by a run with `sudo`. Remove it and start again as your normal user; it is recreated automatically:

```bash
sudo rm -rf .venv
./run.sh
```

**"address already in use".**
Another instance is already running on that port. Use it, stop it, or start on another port with `PORT=9000 ./run.sh`.

**No spell-check underlines appear.**
Make sure `hunspell` is installed and that a language, not "Spelling: off", is selected in the editor toolbar. Only `.tex` files are checked.
