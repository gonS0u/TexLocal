import { api, el, toast } from './api.js';
import { t, fmtDate } from './i18n.js';

const STATUS = {
  modified: ['M', 'Modified'],
  deleted: ['−', 'Deleted since'],
  added: ['+', 'New since'],
  same: ['=', 'Unchanged'],
};

/** Version history modal. `view` is the ProjectView (pid, reloadFromDisk). */
export function openHistory(view) {
  document.querySelector('.modal-backdrop.hist')?.remove();
  const pid = view.pid;
  const list = el('div', { class: 'hist-list' });
  const detail = el('div', { class: 'hist-detail' });
  const close = () => root.remove();
  const root = el('div', { class: 'modal-backdrop hist', onclick: (e) => { if (e.target === root) close(); } },
    el('div', { class: 'modal hist-modal', tabindex: '-1', onkeydown: (e) => { if (e.key === 'Escape') close(); } },
      el('div', { class: 'modal-head' }, el('h2', {}, t('Version history')), el('button', { class: 'icon-btn', onclick: close, title: t('Close') }, '✕')),
      el('div', { class: 'hist-body' },
        el('div', { class: 'hist-side' },
          el('button', { class: 'btn primary small', onclick: saveVersion }, '＋ ' + t('Save version…')),
          el('p', { class: 'muted small' }, t('A version is also saved automatically while you work (at most every 10 minutes).')),
          list),
        detail)));

  let versions = [];
  let current = null;
  let showSame = false;

  const vname = (v) => v.label ? (v.label.startsWith('Before restore') ? t('Before restoring') : v.label) : t('Automatic');

  async function loadList(selectId) {
    try { versions = await api.history(pid); } catch (e) { toast(e.message, 'error'); return; }
    list.innerHTML = '';
    if (!versions.length) {
      list.append(el('div', { class: 'muted pad' }, t('No versions yet.')));
      detail.innerHTML = '';
      return;
    }
    for (const v of versions) {
      v.row = el('div', { class: `hist-row ${v.auto ? 'auto' : 'named'}`, onclick: () => select(v) },
        el('div', { class: 'hist-name' }, vname(v)),
        el('div', { class: 'hist-meta' }, fmtDate(v.time * 1000), ' · ', t('{n} changed', { n: v.changed })));
      list.append(v.row);
    }
    select(versions.find((v) => v.id === selectId) || versions[0]);
  }

  async function saveVersion() {
    const label = prompt(t('Name of this version (e.g. “Sent to supervisor”):'), '');
    if (label === null) return;
    try {
      const r = await api.snapshot(pid, label.trim() || t('Manual version'));
      if (r.skipped) toast(t('Nothing changed since the last version.'));
      await loadList(r.version?.id);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function select(v) {
    current = v;
    for (const x of versions) x.row.classList.toggle('active', x === v);
    let files;
    try { files = await api.versionFiles(pid, v.id); } catch (e) { toast(e.message, 'error'); return; }
    if (current !== v) return;
    detail.innerHTML = '';
    const changed = files.filter((f) => f.status !== 'same');
    const shown = showSame ? files : changed;
    const diffBox = el('div', { class: 'hist-diff' }, el('div', { class: 'muted pad' },
      changed.length ? t('Choose a file to see what changed.') : t('This version is identical to the current files.')));
    const fileList = el('div', { class: 'hist-files' },
      ...shown.map((f) => {
        const [sym, label] = STATUS[f.status];
        const row = el('div', { class: `hist-file ${f.status}`, title: t(label), onclick: () => showDiff(f, row, diffBox) },
          el('span', { class: 'hist-badge' }, sym), el('span', { class: 'hist-path' }, f.path));
        return row;
      }));
    detail.append(
      el('div', { class: 'hist-head' },
        el('div', {}, el('strong', {}, vname(v)), el('div', { class: 'muted small' }, fmtDate(v.time * 1000), ' · ', t('{n} files', { n: v.nfiles }))),
        el('div', { class: 'hist-actions' },
          el('button', { class: 'btn small', onclick: () => restore(v) }, '↺ ' + t('Restore project')),
          el('a', { class: 'btn small', href: api.versionZipUrl(pid, v.id), download: '' }, '⬇ ZIP'),
          el('button', { class: 'btn small danger', onclick: () => remove(v) }, t('Delete')))),
      el('div', { class: 'hist-sub' },
        el('span', { class: 'muted small' }, t('Compared with the current files: {n} different', { n: changed.length })),
        el('label', { class: 'check small' },
          el('input', { type: 'checkbox', checked: showSame, onchange: (e) => { showSame = e.target.checked; select(v); } }),
          t('Show unchanged'))),
      el('div', { class: 'hist-split' }, fileList, diffBox));
  }

  async function showDiff(f, row, box) {
    for (const r of row.parentElement.children) r.classList.toggle('active', r === row);
    const v = current;
    box.innerHTML = '';
    const head = el('div', { class: 'hist-diff-head' }, el('code', {}, f.path));
    if (f.status !== 'added') {
      head.append(el('button', { class: 'btn small', onclick: () => restore(v, f.path) }, '↺ ' + t('Restore this file')));
    }
    box.append(head);
    if (!f.text) { box.append(el('div', { class: 'muted pad' }, t('Binary file: no line comparison.'))); return; }
    let d;
    try { d = await api.versionDiff(pid, v.id, f.path); } catch (e) { toast(e.message, 'error'); return; }
    if (!d.hunks.length) { box.append(el('div', { class: 'muted pad' }, t('No differences.'))); return; }
    box.append(el('div', { class: 'muted small pad-x' }, t('Red: only in this version · Green: only in the current file')));
    const pre = el('div', { class: 'diff' });
    for (const h of d.hunks) {
      let o = h.old_start; let n = h.new_start;
      pre.append(el('div', { class: 'diff-hunk' }, `@@ −${h.old_start} +${h.new_start} @@`));
      for (const l of h.lines) {
        const cls = l.t === '-' ? 'del' : l.t === '+' ? 'add' : '';
        pre.append(el('div', { class: `diff-line ${cls}` },
          el('span', { class: 'diff-ln' }, l.t === '+' ? '' : String(o)),
          el('span', { class: 'diff-ln' }, l.t === '-' ? '' : String(n)),
          el('span', { class: 'diff-text' }, `${l.t} ${l.s}`)));
        if (l.t !== '+') o++;
        if (l.t !== '-') n++;
      }
    }
    box.append(pre);
  }

  async function restore(v, path) {
    const msg = path
      ? t('Restore “{path}” as it was in this version? The current state is saved as a version first.', { path })
      : t('Restore the whole project to this version? Files created since then are removed. The current state is saved as a version first, so you can undo this.');
    if (!confirm(msg)) return;
    try {
      await view.saveAll();
      await api.restoreVersion(pid, v.id, path || null);
      await view.reloadFromDisk();
      toast(path ? t('File restored.') : t('Project restored.'), 'success');
      await loadList(v.id);
    } catch (e) { toast(e.message, 'error'); }
  }

  async function remove(v) {
    if (!confirm(t('Delete this version? This cannot be undone.'))) return;
    try { await api.deleteVersion(pid, v.id); await loadList(); } catch (e) { toast(e.message, 'error'); }
  }

  document.body.append(root);
  root.querySelector('.modal').focus();
  loadList();
}
