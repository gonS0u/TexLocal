import './style.css';
import { api, el, toast, store, droppedFiles } from './api.js';
import { t, getLang, setLang, fmtDate } from './i18n.js';
import { Editor } from './editor.js';
import { PdfViewer } from './pdfviewer.js';
import { FileTree } from './filetree.js';
import { LogPanel } from './logpanel.js';
import { PackageManager } from './packages.js';

const app = document.getElementById('app');
// Theme: stored choice, else follow the system preference.
const darkMq = matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => { document.documentElement.dataset.theme = store.get('theme', null) || (darkMq.matches ? 'dark' : 'light'); };
applyTheme();
darkMq.addEventListener('change', applyTheme);
document.documentElement.lang = getLang();
document.documentElement.style.setProperty('--editor-font-size', `${store.get('fontSize', 14)}px`);

const pm = new PackageManager({
  getProjectId: () => current?.pid,
  onInstalled: async () => { if (current) await current.compile(); },
  onDictionariesChanged: () => current?.refreshSpellLanguages(),
});

let current = null;

function route() {
  const m = location.hash.match(/^#\/p\/([^/]+)/);
  if (current) { current.destroy(); current = null; }
  if (m) current = new ProjectView(decodeURIComponent(m[1]));
  else showProjects();
}
window.addEventListener('hashchange', route);

function toggleTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  store.set('theme', document.documentElement.dataset.theme);
}

/** EN | PT switch; changing language reloads the page (unsaved edits trigger the usual prompt). */
function langSwitch() {
  const b = (code, label) => el('button', { class: getLang() === code ? 'active' : '', title: code === 'en' ? 'English' : 'Português (Portugal)', onclick: () => { if (getLang() !== code) { setLang(code); location.reload(); } } }, label);
  return el('div', { class: 'lang-switch', title: t('Interface language') }, b('en', 'EN'), b('pt-PT', 'PT'));
}

const themeBtn = () => el('button', { class: 'btn ghost', title: t('Light/dark theme'), onclick: toggleTheme }, '◐');

function openProject(p) {
  location.hash = `#/p/${encodeURIComponent(p.id)}`;
}

// ------------------------------------------------------------------ import
async function runImport(promise, label) {
  const tt = el('div', { class: 'toast' }, `⏳ ${label}`);
  let box = document.getElementById('toasts');
  if (!box) { box = el('div', { id: 'toasts' }); document.body.append(box); }
  box.append(tt);
  try {
    const p = await promise;
    toast(t('Imported “{name}” (main: {main}, {engine})', { name: p.name, main: p.main, engine: p.engine }), 'success', 5000);
    openProject(p);
  } catch (e) { toast(e.message, 'error', 6000); } finally { tt.remove(); }
}

function importFromDrop(dt) {
  const files = [...dt.files];
  if (files.length === 1 && /\.zip$/i.test(files[0].name) && !dt.items?.[0]?.webkitGetAsEntry?.()?.isDirectory) {
    runImport(api.importZip(files[0]), t('Importing {name}…', { name: files[0].name }));
    return;
  }
  droppedFiles(dt).then((items) => {
    if (!items.length) return;
    runImport(api.importFiles(items), t('Uploading {n} files…', { n: items.length }));
  });
}

function importSection() {
  const zipInput = el('input', { type: 'file', accept: '.zip,application/zip', class: 'hidden', onchange: () => { const f = zipInput.files[0]; if (f) runImport(api.importZip(f), t('Importing {name}…', { name: f.name })); zipInput.value = ''; } });
  const dirInput = el('input', {
    type: 'file', multiple: true, webkitdirectory: true, class: 'hidden',
    onchange: () => {
      const items = [...dirInput.files].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
      if (items.length) runImport(api.importFiles(items), t('Uploading {n} files…', { n: items.length }));
      dirInput.value = '';
    },
  });
  const pathInput = el('input', { type: 'text', class: 'grow', placeholder: t('Folder on this computer, e.g. ~/Documents/thesis') });
  const fromPath = () => { const v = pathInput.value.trim(); if (v) runImport(api.importPath(v), t('Copying {name}…', { name: v })); else pathInput.focus(); };
  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') fromPath(); });
  const zone = el('div', { class: 'dropzone' }, t('…or drop a .zip or a folder here'));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drop'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drop'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('drop'); importFromDrop(e.dataTransfer); });
  return el('section', { class: 'new-project' },
    el('h2', {}, t('Import')),
    el('p', { class: 'muted small' }, t('Import an existing project (e.g. an Overleaf export). The main file, engine and language are detected automatically.')),
    el('div', { class: 'import-row' },
      el('button', { class: 'btn', onclick: () => zipInput.click() }, '🗜 ' + t('ZIP file…')),
      el('button', { class: 'btn', onclick: () => dirInput.click() }, '📁 ' + t('Folder…'))),
    el('div', { class: 'row' }, pathInput, el('button', { class: 'btn', onclick: fromPath }, t('Copy folder from disk'))),
    zone, zipInput, dirInput);
}

// ------------------------------------------------------------------ project list
async function showProjects() {
  document.title = 'LaTeX Local';
  app.innerHTML = '';
  const list = el('div', { class: 'project-grid' }, el('div', { class: 'muted' }, t('Loading…')));
  const name = el('input', { type: 'text', placeholder: t('New project name'), class: 'grow' });
  const tpl = el('select', { title: t('Template') }, el('option', { value: 'article' }, t('Article')), el('option', { value: 'thesis' }, t('Dissertation / thesis')), el('option', { value: 'blank' }, t('Blank')));
  const docLang = store.get('docLang', getLang() === 'pt-PT' ? 'pt' : 'en');
  const lang = el('select', { title: t('Document language'), onchange: () => store.set('docLang', lang.value) },
    el('option', { value: 'en', selected: docLang === 'en' }, 'English'), el('option', { value: 'pt', selected: docLang === 'pt' }, 'Português'));
  const create = async () => {
    if (!name.value.trim()) { name.focus(); return; }
    try {
      const p = await api.createProject(name.value.trim(), tpl.value, lang.value);
      location.hash = `#/p/${encodeURIComponent(p.id)}`;
    } catch (e) { toast(e.message, 'error'); }
  };
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
  app.append(
    el('header', { class: 'topbar' },
      el('div', { class: 'brand' }, el('span', { class: 'logo' }, 'TeX'), 'LaTeX Local'),
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn ghost', onclick: () => pm.open('settings') }, '📦 ' + t('Packages')),
      langSwitch(),
      themeBtn()),
    el('main', { class: 'projects-page' },
      el('section', { class: 'new-project' }, el('h2', {}, t('New project')),
        el('div', { class: 'row' }, name, tpl, lang, el('button', { class: 'btn primary', onclick: create }, t('Create')))),
      importSection(),
      el('h2', {}, t('Your projects')),
      list));
  try {
    const projects = await api.projects();
    list.innerHTML = '';
    if (!projects.length) list.append(el('div', { class: 'muted' }, t('No projects yet. Create or import one above.')));
    for (const p of projects) {
      list.append(el('div', { class: 'project-card', onclick: () => { location.hash = `#/p/${encodeURIComponent(p.id)}`; } },
        el('div', { class: 'pc-name' }, p.name),
        el('div', { class: 'pc-meta' }, `${p.main} · ${p.engine}`),
        el('div', { class: 'pc-meta' }, t('Modified {date}', { date: fmtDate(p.modified * 1000) })),
        el('div', { class: 'pc-actions' },
          el('button', { class: 'btn small', onclick: async (e) => { e.stopPropagation(); const n = prompt(t('New name:'), p.name); if (n) { await api.updateProject(p.id, { name: n }); showProjects(); } } }, t('Rename')),
          el('button', { class: 'btn danger small', onclick: async (e) => { e.stopPropagation(); if (confirm(t('Delete the project “{name}” and all its files?', { name: p.name }))) { await api.deleteProject(p.id); showProjects(); } } }, t('Delete')))));
    }
  } catch (e) { list.innerHTML = ''; list.append(el('div', { class: 'notice error' }, e.message)); }
  name.focus();
}

// ------------------------------------------------------------------ project editor
class ProjectView {
  constructor(pid) {
    this.pid = pid;
    this.symbols = null;
    this.tabs = [];
    this.compiling = false;
    this.pendingCompile = false;
    this.autoCompile = store.get('autocompile', false);
    this.keyHandler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); this.saveAndCompile(); }
    };
    window.addEventListener('keydown', this.keyHandler);
    this.beforeUnload = (e) => { if (this.editor?.dirtyFiles().length) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', this.beforeUnload);
    this.init();
  }

  destroy() {
    window.removeEventListener('keydown', this.keyHandler);
    window.removeEventListener('beforeunload', this.beforeUnload);
    this.pdf?.observer.disconnect();
  }

  async init() {
    try { this.meta = await api.project(this.pid); } catch (e) { toast(e.message, 'error'); location.hash = ''; return; }
    document.title = `${this.meta.name} — LaTeX Local`;
    app.innerHTML = '';
    this.buildLayout();
    await this.tree.refresh();
    this.refreshSymbols();
    const saved = store.get(`open:${this.pid}`, null);
    const files = this.tree.allFiles();
    const toOpen = (saved?.tabs || []).filter((p) => files.includes(p));
    if (!toOpen.length && files.includes(this.meta.main)) toOpen.push(this.meta.main);
    for (const p of toOpen) await this.openFile(p, { silent: true });
    const active = saved?.active && toOpen.includes(saved.active) ? saved.active : toOpen[0];
    if (active) await this.openFile(active);
    try {
      await this.pdf.load(api.pdfUrl(this.pid));
    } catch { /* no pdf yet */ }
    this.compile();
  }

  buildLayout() {
    this.engineSel = el('select', { title: t('Compiler engine'), onchange: async () => { this.meta = await api.updateProject(this.pid, { engine: this.engineSel.value }); this.compile(); } },
      ...['pdflatex', 'xelatex', 'lualatex'].map((e) => el('option', { value: e, selected: this.meta.engine === e }, e)));
    this.compileBtn = el('button', { class: 'btn primary compile-btn', onclick: () => this.saveAndCompile(), title: t('Save and compile (Ctrl+S)') }, '▶ ' + t('Compile'));
    this.statusEl = el('span', { class: 'status' });
    const autoCb = el('input', { type: 'checkbox', checked: this.autoCompile, onchange: () => { this.autoCompile = autoCb.checked; store.set('autocompile', this.autoCompile); } });
    this.spellSel = el('select', { class: 'spell-select', title: t('Spell-check language'), onchange: () => this.setSpell(this.spellSel.value) });
    this.refreshSpellLanguages();
    const wrapCb = el('input', { type: 'checkbox', checked: store.get('wrap', true), onchange: () => { this.editor.setWrap(wrapCb.checked); store.set('wrap', wrapCb.checked); } });

    const top = el('header', { class: 'topbar' },
      el('a', { class: 'brand', href: '#' }, el('span', { class: 'logo' }, 'TeX'), ''),
      el('span', { class: 'project-name', title: t('Rename'), onclick: async () => { const n = prompt(t('Project name:'), this.meta.name); if (n) { this.meta = await api.updateProject(this.pid, { name: n }); top.querySelector('.project-name').textContent = this.meta.name; } } }, this.meta.name),
      el('div', { class: 'spacer' }),
      this.compileBtn,
      this.engineSel,
      el('label', { class: 'check', title: t('Compile automatically ~2s after you stop typing') }, autoCb, t('Auto')),
      el('label', { class: 'check', title: t('Wrap lines in the editor') }, wrapCb, t('Wrap')),
      this.spellSel,
      el('button', { class: 'icon-btn', title: t('Smaller font'), onclick: () => this.fontSize(-1) }, 'A−'),
      el('button', { class: 'icon-btn', title: t('Larger font'), onclick: () => this.fontSize(1) }, 'A+'),
      this.statusEl,
      el('button', { class: 'btn ghost', onclick: () => pm.open('missing', this.lastResult?.missing || []) }, '📦 ' + t('Packages')),
      el('a', { class: 'btn ghost', href: api.pdfDownloadUrl(this.pid), title: t('Download PDF') }, '⬇ PDF'),
      langSwitch(),
      themeBtn(),
    );

    const treePane = el('aside', { class: 'pane tree-pane' });
    this.tabBar = el('div', { class: 'tabbar' });
    const editorHost = el('div', { class: 'editor-host' });
    this.imgPreview = el('div', { class: 'img-preview hidden' });
    const editorPane = el('section', { class: 'pane editor-pane' }, this.tabBar, editorHost, this.imgPreview);
    const pdfToolbar = el('div', { class: 'pdf-toolbar' },
      el('button', { class: 'icon-btn', title: t('Go to the cursor position in the PDF (Ctrl+Enter)'), onclick: () => this.syncToPdfFromCursor() }, '→'),
      el('button', { class: 'icon-btn', title: t('Zoom out'), onclick: () => this.pdf.zoom(1 / 1.15) }, '−'),
      this.zoomLabel = el('span', { class: 'zoom', title: t('Actual size (100%)'), onclick: () => this.pdf.actualSize() }, '100%'),
      el('button', { class: 'icon-btn', title: t('Zoom in'), onclick: () => this.pdf.zoom(1.15) }, '+'),
      el('button', { class: 'icon-btn', title: t('Fit width'), onclick: () => this.pdf.fitWidth() }, '↔'),
      el('button', { class: 'icon-btn small-txt', title: t('Actual size (100%)'), onclick: () => this.pdf.actualSize() }, '1:1'),
      el('span', { class: 'page-ind', title: t('Page') },
        this.pageInput = el('input', {
          class: 'page-input', type: 'text', inputmode: 'numeric', value: '–', disabled: true, 'aria-label': t('Page'),
          onkeydown: (e) => {
            if (e.key === 'Enter') { this.pdf.goToPage(Number(this.pageInput.value)); this.pageInput.blur(); }
            else if (e.key === 'Escape') { this.pageInput.blur(); }
          },
          onfocus: () => this.pageInput.select(),
          onblur: () => this.pdf.notifyPage(true),
          onchange: () => this.pdf.goToPage(Number(this.pageInput.value)),
        }),
        this.pageTotal = el('span', { class: 'page-total' }, '/ –')),
      el('div', { class: 'spacer' }),
      el('span', { class: 'muted small' }, t('Double-click → source')));
    const pdfHost = el('div', { class: 'pdf-host' });
    const pdfPane = el('section', { class: 'pane pdf-pane' }, pdfToolbar, pdfHost);
    this.logHost = el('div', { class: 'log-pane' });
    this.logToggle = el('button', { class: 'log-toggle', onclick: () => this.toggleLog() }, '▴ ' + t('Log'));

    const g1 = el('div', { class: 'gutter', 'data-for': 'tree' });
    const g2 = el('div', { class: 'gutter', 'data-for': 'editor' });
    this.workspace = el('div', { class: 'workspace' }, treePane, g1, editorPane, g2, pdfPane);
    const gLog = el('div', { class: 'gutter-h' });
    this.mainArea = el('div', { class: 'main-area' }, this.workspace, gLog, this.logHost);
    app.append(top, this.mainArea, this.logToggle);

    const sizes = store.get('sizes', { tree: 220, editor: 50, log: 200, logOpen: false });
    this.sizes = sizes;
    treePane.style.width = `${sizes.tree}px`;
    editorPane.style.flexBasis = `${sizes.editor}%`;
    this.logHost.style.height = `${sizes.log}px`;
    this.setLogOpen(sizes.logOpen);
    this.dragGutter(g1, (dx, start) => { sizes.tree = Math.max(120, Math.min(500, start.tree + dx)); treePane.style.width = `${sizes.tree}px`; }, () => ({ tree: treePane.offsetWidth }));
    this.dragGutter(g2, (dx, start) => {
      const total = this.workspace.clientWidth - treePane.offsetWidth;
      sizes.editor = Math.max(15, Math.min(85, ((start.w + dx) / total) * 100));
      editorPane.style.flexBasis = `${sizes.editor}%`;
    }, () => ({ w: editorPane.offsetWidth }));
    this.dragGutter(gLog, (dx, start, dy) => { sizes.log = Math.max(80, Math.min(window.innerHeight * 0.7, start.h - dy)); this.logHost.style.height = `${sizes.log}px`; }, () => ({ h: this.logHost.offsetHeight }));

    this.tree = new FileTree(treePane, {
      projectId: this.pid,
      onOpen: (n) => this.openFile(n.path),
      getMain: () => this.meta.main,
      onSetMain: async (p) => { this.meta = await api.updateProject(this.pid, { main: p }); this.tree.render(); this.compile(); },
      onChanged: (ev) => {
        if (ev?.renamed) {
          const [a, b] = ev.renamed;
          for (const t of [...this.tabs]) {
            if (t === a || t.startsWith(a + '/')) {
              const nb = b + t.slice(a.length);
              this.editor.rename(t, nb);
              this.tabs[this.tabs.indexOf(t)] = nb;
            }
          }
          this.renderTabs();
        }
        if (ev?.deleted) for (const t of [...this.tabs]) if (t === ev.deleted || t.startsWith(ev.deleted + '/')) this.closeTab(t, true);
        this.refreshSymbols();
      },
    });

    this.editor = new Editor(editorHost, {
      onSave: () => this.saveAndCompile(),
      onSyncToPdf: (file, line, col) => this.syncToPdf(file, line, col),
      onChange: () => { this.renderTabs(); this.scheduleAuto(); },
      getSymbols: () => this.symbols && { ...this.symbols, files: this.tree.allFiles() },
      spell: { getLang: () => this.meta.spell || 'off' },
    });
    this.editor.setWrap(store.get('wrap', true));

    this.pdf = new PdfViewer(pdfHost, { onSyncToSource: (page, x, y) => this.syncToSource(page, x, y) });
    this.pdf.onScale = (s) => { this.zoomLabel.textContent = `${Math.round(s * 100)}%`; };
    this.pdf.onPageChange = (page, total) => {
      if (document.activeElement !== this.pageInput) this.pageInput.value = total ? String(page) : '–';
      this.pageInput.disabled = !total;
      this.pageInput.max = String(total || 1);
      this.pageTotal.textContent = `/ ${total || '–'}`;
    };

    this.log = new LogPanel(this.logHost, {
      onJump: (file, line) => this.openFile(file, { line }),
      onInstallMissing: (missing) => pm.open('missing', missing),
    });
    this.log.onRaw = () => api.log(this.pid);
  }

  dragGutter(g, onMove, getStart) {
    g.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const sx = e.clientX; const sy = e.clientY; const start = getStart();
      document.body.classList.add('dragging');
      const mm = (ev) => onMove(ev.clientX - sx, start, ev.clientY - sy);
      const mu = () => { document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); document.body.classList.remove('dragging'); store.set('sizes', this.sizes); };
      document.addEventListener('mousemove', mm);
      document.addEventListener('mouseup', mu);
    });
  }

  setLogOpen(open) {
    this.sizes.logOpen = open;
    this.mainArea.classList.toggle('log-open', open);
    this.logToggle.textContent = `${open ? '▾' : '▴'} ${t('Log')}`;
    store.set('sizes', this.sizes);
  }

  toggleLog() { this.setLogOpen(!this.sizes.logOpen); }

  persistTabs() { store.set(`open:${this.pid}`, { tabs: this.tabs, active: this.editor.current }); }

  async openFile(path, { line, column, silent } = {}) {
    const isText = /\.(tex|bib|sty|cls|bst|txt|md|csv|dat|tikz|bbx|cbx|lbx|cfg|def|ltx|dtx|ins|json|ya?ml|py|r|m|lua|svg|xml|log)$/i.test(path);
    if (!isText) { this.showImage(path); return; }
    this.imgPreview.classList.add('hidden');
    if (!this.editor.has(path)) {
      try {
        const f = await api.readFile(this.pid, path);
        this.editor.open(path, f.content);
      } catch (e) { toast(e.message, 'error'); return; }
    }
    if (!this.tabs.includes(path)) this.tabs.push(path);
    if (!silent || !this.editor.current) this.editor.open(path);
    this.tree.select(path);
    this.renderTabs();
    this.persistTabs();
    if (line) this.editor.goto(line, column || 0);
  }

  showImage(path) {
    this.imgPreview.innerHTML = '';
    const url = api.rawUrl(this.pid, path);
    this.imgPreview.append(
      el('div', { class: 'img-head' }, el('code', {}, path), el('button', { class: 'icon-btn', onclick: () => this.imgPreview.classList.add('hidden') }, '✕')),
      /\.pdf$/i.test(path) ? el('iframe', { src: url }) : /\.(png|jpe?g|gif|svg)$/i.test(path) ? el('img', { src: url }) : el('div', { class: 'muted pad' }, t('Preview not available.') + ' ', el('a', { href: url, target: '_blank' }, t('Open'))));
    this.imgPreview.classList.remove('hidden');
  }

  renderTabs() {
    this.tabBar.innerHTML = '';
    const dirty = new Set(this.editor.dirtyFiles());
    for (const t of this.tabs) {
      this.tabBar.append(el('div', {
        class: `tab ${this.editor.current === t ? 'active' : ''} ${dirty.has(t) ? 'dirty' : ''}`, title: t,
        onclick: () => this.openFile(t),
        onauxclick: (e) => { if (e.button === 1) this.closeTab(t); },
      }, el('span', {}, t.split('/').pop()), el('button', { class: 'tab-close', onclick: (e) => { e.stopPropagation(); this.closeTab(t); } }, dirty.has(t) ? '●' : '×')));
    }
  }

  closeTab(path, force = false) {
    if (!force && this.editor.dirtyFiles().includes(path) && !confirm(t('“{path}” has unsaved changes. Close anyway?', { path }))) return;
    const i = this.tabs.indexOf(path);
    this.tabs.splice(i, 1);
    const wasCurrent = this.editor.current === path;
    this.editor.close(path);
    if (wasCurrent && this.tabs.length) this.openFile(this.tabs[Math.max(0, i - 1)]);
    this.renderTabs();
    this.persistTabs();
  }

  async saveAll() {
    const dirty = this.editor.dirtyFiles();
    for (const p of dirty) {
      const content = this.editor.content(p);
      await api.writeFile(this.pid, p, content);
      this.editor.markSaved(p, content);
    }
    if (dirty.length) { this.renderTabs(); this.refreshSymbols(); }
    return dirty.length;
  }

  scheduleAuto() {
    if (!this.autoCompile) return;
    clearTimeout(this.autoTimer);
    this.autoTimer = setTimeout(() => this.saveAndCompile(), 2000);
  }

  async saveAndCompile() {
    clearTimeout(this.autoTimer);
    try { await this.saveAll(); } catch (e) { toast(t('Error saving: {msg}', { msg: e.message }), 'error'); return; }
    await this.compile();
  }

  async compile() {
    if (this.compiling) { this.pendingCompile = true; return; }
    this.compiling = true;
    this.compileBtn.disabled = true;
    this.compileBtn.textContent = '⏳ ' + t('Compiling…');
    this.statusEl.textContent = '';
    try {
      const r = await api.compile(this.pid);
      this.lastResult = r;
      this.log.set(r);
      this.statusEl.className = `status ${r.ok ? 'ok' : r.errors.length ? 'err' : 'warn'}`;
      this.statusEl.textContent = r.ok ? `✓ ${r.duration}s` : `✗ ${t('{n} error(s)', { n: r.errors.length })}`;
      this.statusEl.title = r.ok ? t('Compiled successfully') : t('Show log');
      this.statusEl.onclick = () => this.setLogOpen(true);
      this.editor.setDiagnostics([
        ...r.errors.filter((e) => !e.external).map((e) => ({ ...e, file: e.file || r.main, severity: 'error' })),
        ...r.warnings.filter((w) => w.file && !w.external).map((w) => ({ ...w, severity: 'warning' })),
      ]);
      if (r.pdf) await this.pdf.load(api.pdfUrl(this.pid, r.pdf_mtime));
      if (r.errors.length && !this.sizes.logOpen) this.setLogOpen(true);
      if (r.missing?.length) toast(t('Missing packages: {list} — open 📦 Packages', { list: r.missing.map((m) => m.file).join(', ') }), 'error', 6000);
    } catch (e) {
      this.statusEl.className = 'status err';
      this.statusEl.textContent = '✗ ' + t('failed');
      toast(e.message, 'error');
    } finally {
      this.compiling = false;
      this.compileBtn.disabled = false;
      this.compileBtn.textContent = '▶ ' + t('Compile');
      if (this.pendingCompile) { this.pendingCompile = false; this.compile(); }
    }
  }

  fontSize(delta) {
    const v = Math.max(10, Math.min(28, store.get('fontSize', 14) + delta));
    store.set('fontSize', v);
    document.documentElement.style.setProperty('--editor-font-size', `${v}px`);
    this.editor.view.requestMeasure();
  }

  async refreshSpellLanguages() {
    let langs = [];
    try { langs = (await api.spell.languages()).installed; } catch { /* hunspell missing */ }
    const cur = this.meta.spell || 'off';
    const sel = this.spellSel;
    sel.innerHTML = '';
    sel.append(el('option', { value: 'off', selected: cur === 'off' }, '✓ ' + t('Spelling: off')));
    for (const l of langs) sel.append(el('option', { value: l.code, selected: cur === l.code }, `✓ ${l.native || l.name}`));
    if (cur !== 'off' && !langs.some((l) => l.code === cur)) sel.append(el('option', { value: cur, selected: true }, `✓ ${cur} (${t('not installed')})`));
    sel.append(el('option', { value: '__manage' }, t('Manage dictionaries…')));
    this.editor?.refreshSpell();
  }

  async setSpell(code) {
    if (code === '__manage') {
      this.spellSel.value = this.meta.spell || 'off';
      pm.open('dicts');
      return;
    }
    try {
      this.meta = await api.updateProject(this.pid, { spell: code });
      this.editor.refreshSpell();
    } catch (e) { toast(e.message, 'error'); }
  }

  async refreshSymbols() {
    try { this.symbols = await api.symbols(this.pid); } catch { /* ignore */ }
  }

  syncToPdfFromCursor() {
    const v = this.editor.view;
    if (!this.editor.current) return;
    const l = v.state.doc.lineAt(v.state.selection.main.head);
    this.syncToPdf(this.editor.current, l.number, 0);
  }

  async syncToPdf(file, line, col) {
    if (!file) return;
    try {
      const pos = await api.syncView(this.pid, file, line, col);
      this.pdf.showPosition(pos);
    } catch (e) { toast('SyncTeX: ' + e.message, 'error'); }
  }

  async syncToSource(page, x, y) {
    try {
      const r = await api.syncEdit(this.pid, page, x, y);
      await this.openFile(r.file, { line: r.line });
    } catch (e) { toast('SyncTeX: ' + e.message, 'error'); }
  }
}

route();
