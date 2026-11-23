import { toggleComment } from '@codemirror/commands';
import { el, store } from './api.js';
import { t } from './i18n.js';
import { wrapSelection } from './editor.js';

/*
 * Keyboard shortcuts: app actions with default keys the user can change, plus user-made
 * shortcuts that wrap the selection in text (e.g. \emph{…}). Keys use CodeMirror's notation
 * ("Mod-Shift-e"; Mod = Ctrl, or ⌘ on a Mac). ctx is the ProjectView.
 */
const sel = (ctx) => ctx.editor.view;
export const ACTIONS = [
  { id: 'compile', label: 'Save and compile', keys: ['Mod-s'], run: (c) => c.saveAndCompile() },
  { id: 'syncToPdf', label: 'Go to the cursor position in the PDF', keys: ['Mod-Enter'], editor: true, run: (c) => c.syncToPdfFromCursor() },
  { id: 'comment', label: 'Comment/uncomment lines', keys: ['Mod-/'], editor: true, run: (c) => toggleComment(sel(c)) },
  { id: 'bold', label: 'Bold (\\textbf)', keys: ['Mod-b'], editor: true, run: (c) => wrapSelection(sel(c), '\\textbf{', '}') },
  { id: 'italic', label: 'Italic (\\textit)', keys: ['Mod-i'], editor: true, run: (c) => wrapSelection(sel(c), '\\textit{', '}') },
  { id: 'toggleOutline', label: 'Show/hide outline', keys: [], run: (c) => c.outline.setOpen(!c.outline.open) },
  { id: 'toggleLog', label: 'Show/hide the log', keys: [], run: (c) => c.toggleLog() },
  { id: 'fontUp', label: 'Larger font', keys: [], run: (c) => c.fontSize(1) },
  { id: 'fontDown', label: 'Smaller font', keys: [], run: (c) => c.fontSize(-1) },
  { id: 'toggleWrap', label: 'Wrap lines on/off', keys: [], run: (c) => c.toggleWrap() },
  { id: 'toggleAuto', label: 'Auto-compile on/off', keys: [], run: (c) => c.toggleAuto() },
  { id: 'detachPdf', label: 'Open/reattach the PDF window', keys: [], run: (c) => (c.detached ? c.reattachPdf() : c.detachPdf()) },
  { id: 'history', label: 'Version history', keys: [], run: (c) => c.openHistory() },
  { id: 'packages', label: 'Packages & dictionaries', keys: [], run: (c) => c.openPackages() },
  { id: 'theme', label: 'Light/dark theme', keys: [], run: (c) => c.toggleTheme() },
  { id: 'help', label: 'Help and shortcuts', keys: ['F1'], run: (c) => c.openHelp() },
];

/** CodeMirror's own keys, shown read-only in the help. */
export const BUILTIN = [
  ['Find', ['Mod-f']], ['Find and replace', ['Mod-h']], ['Go to line', ['Mod-Alt-g']],
  ['Undo', ['Mod-z']], ['Redo', ['Mod-y', 'Mod-Shift-z']], ['Show completions', ['Ctrl-Space']],
  ['Select next occurrence', ['Mod-d']], ['Move line up/down', ['Alt-ArrowUp', 'Alt-ArrowDown']],
  ['Copy line down', ['Shift-Alt-ArrowDown']], ['Fold/unfold code', ['Mod-Shift-[', 'Mod-Shift-]']],
  ['Indent/unindent', ['Tab', 'Shift-Tab']], ['Select all', ['Mod-a']],
];

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const load = () => {
  const s = store.get('shortcuts', null);
  return { overrides: s?.overrides || {}, custom: Array.isArray(s?.custom) ? s.custom : [] };
};
const save = (s) => store.set('shortcuts', s);

export const keysFor = (id, s = load()) => s.overrides[id] ?? ACTIONS.find((a) => a.id === id).keys;

/** All active bindings: [{key, id, label, editor, run(ctx)}]. */
export function bindings() {
  const s = load();
  const out = [];
  for (const a of ACTIONS) for (const key of keysFor(a.id, s)) out.push({ key, id: a.id, label: t(a.label), editor: a.editor, run: a.run });
  for (const c of s.custom) {
    out.push({ key: c.key, id: c.id, label: c.label, editor: true, run: (ctx) => wrapSelection(sel(ctx), c.before, c.after) });
  }
  return out;
}

const MODS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS']);

/** Key names for an event, most specific first (layout-independent letter/digit, then the typed symbol). */
function eventKeys(e) {
  if (MODS.has(e.key)) return [];
  const mod = (e.ctrlKey || e.metaKey ? 'Mod-' : '') + (e.altKey ? 'Alt-' : '');
  const m = /^(?:Key([A-Z])|Digit(\d))$/.exec(e.code || '');
  const out = [];
  if (m) out.push(mod + (e.shiftKey ? 'Shift-' : '') + (m[1] ? m[1].toLowerCase() : m[2]));
  const k = e.key === ' ' ? 'Space' : e.key;
  // A typed symbol (/, ?, [ …) already reflects Shift, so it is not repeated.
  if (k.length === 1 && !/[a-z0-9]/i.test(k)) out.push(mod + k);
  else if (!m) out.push(mod + (e.shiftKey ? 'Shift-' : '') + (k.length === 1 ? k.toLowerCase() : k));
  return out;
}

export function keyFromEvent(e) { return eventKeys(e)[0] || null; }

/** The binding matching a keydown, or null. */
export function matchShortcut(e) {
  const ks = eventKeys(e);
  if (!ks.length) return null;
  return bindings().find((b) => ks.includes(b.key)) || null;
}

/** "Mod-Shift-e" → "Ctrl+Shift+E". */
export function formatKey(k) {
  const m = /^((?:(?:Mod|Ctrl|Alt|Shift|Meta)-)*)(.+)$/.exec(k);
  const mods = m[1].split('-').filter(Boolean).map((x) => ({ Mod: isMac ? '⌘' : 'Ctrl', Alt: isMac ? '⌥' : 'Alt', Meta: '⌘' }[x] || x));
  const names = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: t('Space') };
  const key = names[m[2]] || (m[2].length === 1 ? m[2].toUpperCase() : m[2]);
  return [...mods, key].join('+');
}

let capturing = false;
export const isCapturing = () => capturing;

/** Wait for the next key combination; resolves to its name, or null on Escape. */
function captureKey(btn) {
  return new Promise((resolve) => {
    capturing = true;
    const old = btn.textContent;
    btn.textContent = t('Press the keys…');
    btn.classList.add('sc-capture');
    const done = (k) => {
      capturing = false;
      window.removeEventListener('keydown', onKey, true);
      btn.textContent = old;
      btn.classList.remove('sc-capture');
      resolve(k);
    };
    const onKey = (e) => {
      if (MODS.has(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { done(null); return; }
      const k = keyFromEvent(e);
      // Without Ctrl/Alt a key would fire while typing; only F-keys are allowed alone.
      if (!/^(Mod|Alt)-/.test(k) && !/^(Shift-)?F\d+$/.test(k)) {
        btn.textContent = t('Use Ctrl or Alt (or an F key)');
        return;
      }
      done(k);
    };
    window.addEventListener('keydown', onKey, true);
  });
}

/** Who uses key already: a label, or null. */
function owner(key, s, skip) {
  for (const a of ACTIONS) if (a.id !== skip && keysFor(a.id, s).includes(key)) return { label: t(a.label), id: a.id };
  for (const c of s.custom) if (c.id !== skip && c.key === key) return { label: c.label, id: c.id, custom: true };
  for (const [label, keys] of BUILTIN) if (keys.includes(key)) return { label: t(label), builtin: true };
  return null;
}

/** Ask before taking a key from someone else; removes it there when confirmed. */
function claim(key, s, forId) {
  const o = owner(key, s, forId);
  if (!o) return true;
  if (!confirm(t('{key} is already used by “{name}”. Use it here instead?', { key: formatKey(key), name: o.label }))) return false;
  if (o.custom) s.custom = s.custom.filter((c) => c.id !== o.id);
  else if (o.id) s.overrides[o.id] = keysFor(o.id, s).filter((k) => k !== key);
  return true;
}

const kbd = (k, onRemove) => el('span', { class: 'kbd' }, formatKey(k),
  onRemove ? el('button', { class: 'kbd-x', title: t('Remove'), onclick: onRemove }, '×') : null);

/** The Help modal: shortcut list, key editing and custom shortcuts. */
export function openHelp({ onChange } = {}) {
  document.querySelector('.modal-backdrop.sc')?.remove();
  const body = el('div', { class: 'sc-body' });
  const close = () => { if (!capturing) root.remove(); };
  const root = el('div', { class: 'modal-backdrop sc', onclick: (e) => { if (e.target === root) close(); } },
    el('div', { class: 'modal sc-modal', tabindex: '-1', onkeydown: (e) => { if (e.key === 'Escape') close(); } },
      el('div', { class: 'modal-head' }, el('h2', {}, t('Help and shortcuts')), el('button', { class: 'icon-btn', onclick: close, title: t('Close') }, '✕')),
      body));
  const commit = (s) => { save(s); onChange?.(); render(); };

  function render() {
    const s = load();
    body.innerHTML = '';
    body.append(el('p', { class: 'muted' }, t('Click “+ key” to add a combination to an action, or × to remove one. Changes are saved in this browser.')));

    body.append(el('h3', {}, t('App shortcuts')));
    for (const a of ACTIONS) {
      const keys = keysFor(a.id, s);
      const add = el('button', { class: 'btn small', onclick: async () => {
        const k = await captureKey(add);
        if (!k || keys.includes(k)) return;
        const s2 = load();
        if (!claim(k, s2, a.id)) return;
        s2.overrides[a.id] = [...keysFor(a.id, s2), k];
        commit(s2);
      } }, '+ ' + t('key'));
      body.append(el('div', { class: 'sc-row' },
        el('span', { class: 'sc-name' }, t(a.label)),
        el('span', { class: 'sc-keys' }, ...keys.map((k) => kbd(k, () => { const s2 = load(); s2.overrides[a.id] = keysFor(a.id, s2).filter((x) => x !== k); commit(s2); })),
          keys.length ? null : el('span', { class: 'muted' }, '—')),
        add));
    }

    body.append(el('h3', {}, t('Custom shortcuts')),
      el('p', { class: 'muted' }, t('Wrap the selected text (or insert at the cursor) with text of your choice, e.g. \\emph{ … }.')));
    for (const c of s.custom) {
      body.append(el('div', { class: 'sc-row' },
        el('span', { class: 'sc-name' }, c.label, ' ', el('code', {}, `${c.before}…${c.after}`)),
        el('span', { class: 'sc-keys' }, kbd(c.key)),
        el('button', { class: 'btn small danger', onclick: () => { const s2 = load(); s2.custom = s2.custom.filter((x) => x.id !== c.id); commit(s2); } }, t('Delete'))));
    }
    const name = el('input', { placeholder: t('Name (e.g. Emphasis)') });
    const before = el('input', { placeholder: t('Before (e.g. \\emph{)'), class: 'mono' });
    const after = el('input', { placeholder: t('After (e.g. })'), class: 'mono' });
    const addBtn = el('button', { class: 'btn primary small', onclick: async () => {
      if (!before.value && !after.value) { before.focus(); return; }
      const k = await captureKey(addBtn);
      if (!k) return;
      const s2 = load();
      const id = `custom-${Date.now()}`;
      if (!claim(k, s2, id)) return;
      s2.custom.push({ id, key: k, label: name.value.trim() || `${before.value}…${after.value}`, before: before.value, after: after.value });
      commit(s2);
    } }, t('Choose key and add'));
    body.append(el('div', { class: 'sc-new' }, name, before, after, addBtn));

    body.append(el('h3', {}, t('Editor shortcuts')));
    for (const [label, keys] of BUILTIN) {
      body.append(el('div', { class: 'sc-row' }, el('span', { class: 'sc-name' }, t(label)), el('span', { class: 'sc-keys' }, ...keys.map((k) => kbd(k)))));
    }

    body.append(el('div', { class: 'sc-foot' },
      el('button', { class: 'btn', onclick: () => { if (confirm(t('Restore the default shortcuts? Your custom shortcuts will be deleted.'))) commit({ overrides: {}, custom: [] }); } }, t('Restore defaults'))));
  }

  render();
  document.body.append(root);
  root.querySelector('.modal').focus();
}
