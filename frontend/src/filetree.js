import { api, el, toast, droppedFiles } from './api.js';
import { t } from './i18n.js';

const ICON = { folder: '📁', open: '📂', tex: '📄', bib: '📚', img: '🖼', file: '📃' };

function iconFor(n) {
  if (n.type === 'folder') return null;
  if (/\.tex$/i.test(n.name)) return ICON.tex;
  if (/\.bib$/i.test(n.name)) return ICON.bib;
  if (/\.(png|jpe?g|gif|svg|pdf|eps)$/i.test(n.name)) return ICON.img;
  return ICON.file;
}

export class FileTree {
  constructor(parent, { projectId, onOpen, onChanged, getMain, onSetMain }) {
    this.pid = projectId;
    this.onOpen = onOpen;
    this.onChanged = onChanged;
    this.getMain = getMain;
    this.onSetMain = onSetMain;
    this.expanded = new Set(['']);
    this.selected = null;
    this.selectedFolder = '';

    const toolbar = el('div', { class: 'tree-toolbar' },
      el('span', { class: 'tree-title' }, t('Files')),
      el('button', { title: t('New file'), onclick: () => this.newItem('file') }, '＋📄'),
      el('button', { title: t('New folder'), onclick: () => this.newItem('folder') }, '＋📁'),
      el('button', { title: t('Upload files'), onclick: () => this.fileInput.click() }, '⬆'),
      el('button', { title: t('Upload folder'), onclick: () => this.folderInput.click() }, '⬆📁'),
    );
    this.fileInput = el('input', { type: 'file', multiple: true, style: { display: 'none' }, onchange: () => this.uploadFiles(this.fileInput.files) });
    this.folderInput = el('input', { type: 'file', multiple: true, webkitdirectory: true, style: { display: 'none' }, onchange: () => this.uploadFiles(this.folderInput.files) });
    this.list = el('div', { class: 'tree-list' });
    this.list.addEventListener('dragover', (e) => { e.preventDefault(); this.list.classList.add('drop'); });
    this.list.addEventListener('dragleave', () => this.list.classList.remove('drop'));
    this.list.addEventListener('drop', (e) => {
      e.preventDefault();
      this.list.classList.remove('drop');
      if (e.dataTransfer.types.includes('Files')) droppedFiles(e.dataTransfer).then((f) => this.uploadFiles(f));
    });
    parent.append(toolbar, this.fileInput, this.folderInput, this.list);
    this.menu = null;
    document.addEventListener('click', () => this.closeMenu());
  }

  async refresh() {
    this.data = await api.tree(this.pid);
    this.render();
    return this.data;
  }

  allFiles(nodes = this.data || [], acc = []) {
    for (const n of nodes) {
      if (n.type === 'folder') this.allFiles(n.children, acc);
      else acc.push(n.path);
    }
    return acc;
  }

  render() {
    this.list.innerHTML = '';
    const main = this.getMain();
    const walk = (nodes, depth) => {
      for (const n of nodes) {
        const isOpen = this.expanded.has(n.path);
        const row = el('div', {
          class: `tree-row ${this.selected === n.path ? 'selected' : ''} ${n.type}`,
          style: { paddingLeft: `${8 + depth * 14}px` },
          title: n.path,
          draggable: 'true',
          onclick: (e) => { e.stopPropagation(); this.click(n); },
          oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); this.contextMenu(e, n); },
          ondragstart: (e) => e.dataTransfer.setData('text/x-path', n.path),
          ondragover: (e) => { if (n.type === 'folder') { e.preventDefault(); row.classList.add('drop'); } },
          ondragleave: () => row.classList.remove('drop'),
          ondrop: async (e) => {
            row.classList.remove('drop');
            if (n.type !== 'folder') return;
            e.preventDefault(); e.stopPropagation();
            const src = e.dataTransfer.getData('text/x-path');
            if (src && src !== n.path) await this.move(src, `${n.path}/${src.split('/').pop()}`);
            else if (e.dataTransfer.types.includes('Files')) droppedFiles(e.dataTransfer).then((f) => this.uploadFiles(f, n.path));
          },
        },
        el('span', { class: 'tree-icon' }, n.type === 'folder' ? (isOpen ? ICON.open : ICON.folder) : iconFor(n)),
        el('span', { class: 'tree-name' }, n.name),
        n.path === main ? el('span', { class: 'badge', title: t('Main file') }, 'main') : null);
        this.list.append(row);
        if (n.type === 'folder' && isOpen) walk(n.children, depth + 1);
      }
    };
    walk(this.data || [], 0);
  }

  click(n) {
    this.selected = n.path;
    if (n.type === 'folder') {
      this.selectedFolder = n.path;
      if (this.expanded.has(n.path)) this.expanded.delete(n.path); else this.expanded.add(n.path);
    } else {
      this.selectedFolder = n.path.includes('/') ? n.path.slice(0, n.path.lastIndexOf('/')) : '';
      this.onOpen(n);
    }
    this.render();
  }

  select(path) {
    this.selected = path;
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) this.expanded.add(parts.slice(0, i).join('/'));
    this.render();
  }

  closeMenu() { this.menu?.remove(); this.menu = null; }

  contextMenu(e, n) {
    this.closeMenu();
    const item = (label, fn) => el('div', { class: 'menu-item', onclick: () => { this.closeMenu(); fn(); } }, label);
    this.menu = el('div', { class: 'context-menu', style: { left: `${e.clientX}px`, top: `${e.clientY}px` } },
      n.type === 'folder' ? item(t('New file here'), () => { this.selectedFolder = n.path; this.newItem('file'); }) : null,
      n.type === 'folder' ? item(t('New folder here'), () => { this.selectedFolder = n.path; this.newItem('folder'); }) : null,
      n.type === 'file' && /\.tex$/.test(n.name) ? item(t('Set as main file'), () => this.onSetMain(n.path)) : null,
      n.type === 'file' ? item(t('Download'), () => window.open(api.rawUrl(this.pid, n.path))) : null,
      item(t('Rename…'), () => this.rename(n)),
      item(t('Delete'), () => this.remove(n)),
    );
    document.body.append(this.menu);
  }

  async newItem(kind) {
    const base = this.selectedFolder ? this.selectedFolder + '/' : '';
    const name = prompt(kind === 'folder' ? t('Folder name:') : t('File name:'), kind === 'folder' ? '' : t('new.tex'));
    if (!name) return;
    try {
      await api.createFile(this.pid, base + name, kind);
      if (base) this.expanded.add(this.selectedFolder);
      await this.refresh();
      this.onChanged?.();
      if (kind === 'file') this.onOpen({ path: base + name, name, type: 'file', text: true });
    } catch (err) { toast(err.message, 'error'); }
  }

  async rename(n) {
    const np = prompt(t('New path:'), n.path);
    if (!np || np === n.path) return;
    await this.move(n.path, np);
  }

  async move(src, dst) {
    try {
      await api.moveFile(this.pid, src, dst);
      this.onChanged?.({ renamed: [src, dst] });
      await this.refresh();
    } catch (err) { toast(err.message, 'error'); }
  }

  async remove(n) {
    if (!confirm(t('Delete “{path}”?', { path: n.path }))) return;
    try {
      await api.deleteFile(this.pid, n.path);
      this.onChanged?.({ deleted: n.path });
      await this.refresh();
    } catch (err) { toast(err.message, 'error'); }
  }

  async uploadFiles(files, folder = this.selectedFolder) {
    if (!files?.length) return;
    try {
      const r = await api.upload(this.pid, folder, files);
      toast(r.saved.length > 5 ? t('Uploaded {n} files', { n: r.saved.length }) : t('Uploaded: {files}', { files: r.saved.join(', ') }), 'success');
      await this.refresh();
      this.onChanged?.();
    } catch (err) { toast(err.message, 'error'); }
    this.fileInput.value = '';
    this.folderInput.value = '';
  }
}
