import { t as tr } from './i18n.js';

async function req(method, url, body, opts = {}) {
  const init = { method, headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const r = await fetch(url, init);
  if (!r.ok) {
    let msg = r.statusText;
    try { const j = await r.json(); msg = j.detail || msg; } catch { /* not json */ }
    const err = new Error(typeof msg === 'string' ? tr(msg) : JSON.stringify(msg));
    err.status = r.status;
    throw err;
  }
  if (opts.raw) return r;
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r.text();
}

const q = (o) => new URLSearchParams(o).toString();
const P = (id) => `/api/projects/${encodeURIComponent(id)}`;

export const api = {
  projects: () => req('GET', '/api/projects'),
  createProject: (name, template, lang) => req('POST', '/api/projects', { name, template, lang }),
  importZip: (file, name = '') => { const fd = new FormData(); fd.append('file', file); fd.append('name', name); return req('POST', '/api/projects/import/zip', fd); },
  importFiles: (items, name = '') => {
    const fd = new FormData();
    fd.append('name', name);
    for (const { file, path } of items) { fd.append('files', file); fd.append('paths', path); }
    return req('POST', '/api/projects/import/files', fd);
  },
  importPath: (path, name) => req('POST', '/api/projects/import/path', { path, name }),
  project: (id) => req('GET', P(id)),
  updateProject: (id, data) => req('PATCH', P(id), data),
  deleteProject: (id) => req('DELETE', P(id)),
  copyProject: (id, name) => req('POST', `${P(id)}/copy`, { name }),
  exportUrl: (id) => `${P(id)}/export`,

  tree: (id) => req('GET', `${P(id)}/tree`),
  readFile: (id, path) => req('GET', `${P(id)}/file?${q({ path })}`),
  writeFile: (id, path, content) => req('PUT', `${P(id)}/file`, { path, content }),
  createFile: (id, path, kind = 'file') => req('POST', `${P(id)}/file`, { path, kind }),
  moveFile: (id, path, new_path) => req('PATCH', `${P(id)}/file`, { path, new_path }),
  deleteFile: (id, path) => req('DELETE', `${P(id)}/file?${q({ path })}`),
  rawUrl: (id, path) => `${P(id)}/raw?${q({ path })}`,
  /** files: File[] or [{file, path}] (path keeps sub-folders). */
  upload: (id, folder, files) => {
    const fd = new FormData();
    fd.append('folder', folder || '');
    for (const f of files) {
      if (f instanceof File) { fd.append('files', f); fd.append('paths', f.webkitRelativePath || f.name); }
      else { fd.append('files', f.file); fd.append('paths', f.path); }
    }
    return req('POST', `${P(id)}/upload`, fd);
  },

  compile: (id, opts = {}) => req('POST', `${P(id)}/compile`, opts),
  pdfUrl: (id, t) => `${P(id)}/pdf?t=${t || Date.now()}`,
  pdfDownloadUrl: (id) => `${P(id)}/pdf/download`,
  log: (id) => req('GET', `${P(id)}/log`),
  syncView: (id, file, line, column = 0) => req('GET', `${P(id)}/synctex/view?${q({ file, line, column })}`),
  syncEdit: (id, page, x, y) => req('GET', `${P(id)}/synctex/edit?${q({ page, x, y })}`),
  symbols: (id) => req('GET', `${P(id)}/symbols`),
  checkPackages: (id) => req('GET', `${P(id)}/check-packages`),

  pkg: {
    status: () => req('GET', '/api/packages/status'),
    init: (repository) => req('POST', '/api/packages/init', repository ? { repository } : {}),
    search: (qq) => req('GET', `/api/packages/search?${q({ q: qq })}`),
    info: (name) => req('GET', `/api/packages/info/${encodeURIComponent(name)}`),
    installed: () => req('GET', '/api/packages/installed'),
    updates: () => req('GET', '/api/packages/updates'),
    install: (packages, via = 'tlmgr') => req('POST', '/api/packages/install', { packages, via }),
    remove: (packages, via = 'tlmgr') => req('POST', '/api/packages/remove', { packages, via }),
    update: (packages, via = 'tlmgr', all = false) => req('POST', '/api/packages/update', { packages, via, all }),
    resolve: (files) => req('POST', '/api/packages/resolve', { files }),
    jobs: () => req('GET', '/api/packages/jobs'),
    stream: (jid) => new EventSource(`/api/packages/jobs/${jid}/stream`),
  },

  spell: {
    languages: () => req('GET', '/api/spell/languages'),
    check: (lang, words) => req('POST', '/api/spell/check', { lang, words }),
    suggest: (lang, word) => req('GET', `/api/spell/suggest?${q({ lang, word })}`),
    personal: (lang) => req('GET', `/api/spell/dictionary/${encodeURIComponent(lang)}`),
    addWord: (lang, word) => req('POST', '/api/spell/dictionary', { lang, word }),
    removeWord: (lang, word) => req('DELETE', `/api/spell/dictionary?${q({ lang, word })}`),
    download: (code) => req('POST', '/api/spell/download', { code }),
    removeLanguage: (code) => req('DELETE', `/api/spell/languages/${encodeURIComponent(code)}`),
  },
};

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

export function toast(msg, kind = 'info', ms = 3500) {
  let box = document.getElementById('toasts');
  if (!box) { box = el('div', { id: 'toasts' }); document.body.append(box); }
  const t = el('div', { class: `toast ${kind}` }, msg);
  box.append(t);
  setTimeout(() => t.remove(), ms);
}

export const store = {
  get(k, d) { try { const v = localStorage.getItem('latexlocal:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('latexlocal:' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

/**
 * Collect files from a drop event, walking dropped folders.
 * Returns [{file, path}] where path is relative (keeps the folder name).
 */
export async function droppedFiles(dataTransfer) {
  const entries = [...(dataTransfer.items || [])].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dataTransfer.files].map((file) => ({ file, path: file.name }));
  const out = [];
  const readAll = (reader) => new Promise((resolve, reject) => {
    const acc = [];
    const next = () => reader.readEntries((batch) => { if (!batch.length) resolve(acc); else { acc.push(...batch); next(); } }, reject);
    next();
  });
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: prefix + entry.name });
    } else if (entry.isDirectory) {
      if (/^(\.git|node_modules|__MACOSX)$/.test(entry.name)) return;
      for (const e of await readAll(entry.createReader())) await walk(e, `${prefix}${entry.name}/`);
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}
