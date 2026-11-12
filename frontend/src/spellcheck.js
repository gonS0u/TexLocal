import { StateEffect } from '@codemirror/state';
import { ViewPlugin, Decoration, EditorView } from '@codemirror/view';
import { api, el, toast } from './api.js';
import { t } from './i18n.js';

/** Dispatch to force a re-check (language changed, word added, …). */
export const refreshSpell = StateEffect.define();

// ------------------------------------------------------------------ LaTeX-aware tokenizer
/** Commands whose first {argument} is code / keys, never prose. */
const SKIP_ARG = new Set([
  'ref', 'eqref', 'pageref', 'autoref', 'nameref', 'cref', 'Cref', 'vref', 'label', 'cite', 'citep', 'citet', 'citealp', 'citeauthor',
  'citeyear', 'parencite', 'textcite', 'autocite', 'footcite', 'fullcite', 'nocite', 'Cite', 'Parencite', 'Textcite', 'Autocite',
  'begin', 'end', 'usepackage', 'RequirePackage', 'documentclass', 'input', 'include', 'includeonly', 'subfile', 'includegraphics',
  'includepdf', 'url', 'href', 'bibliography', 'bibliographystyle', 'addbibresource', 'printbibliography', 'newcommand', 'renewcommand',
  'providecommand', 'newenvironment', 'renewenvironment', 'DeclareMathOperator', 'setlength', 'addtolength', 'setcounter',
  'addtocounter', 'newcounter', 'stepcounter', 'hypersetup', 'geometry', 'pagestyle', 'thispagestyle', 'pagenumbering', 'color',
  'textcolor', 'colorbox', 'definecolor', 'vspace', 'hspace', 'lstinputlisting', 'inputminted', 'mintinline', 'usetikzlibrary',
  'graphicspath', 'newglossaryentry', 'newacronym', 'gls', 'Gls', 'glspl', 'Glspl', 'acrshort', 'acrlong', 'acrfull', 'ac', 'acp',
  'fontsize', 'selectfont', 'setmainfont', 'setsansfont', 'setmonofont', 'setmainlanguage', 'setdefaultlanguage', 'setotherlanguage',
  'selectlanguage', 'foreignlanguage', 'bibitem', 'verb', 'lstset', 'sisetup', 'SI', 'si', 'num', 'qty', 'unit', 'pgfplotsset',
  'tikzset', 'addplot', 'newtheorem', 'theoremstyle', 'counterwithin', 'numberwithin', 'renewbibmacro', 'DeclareFieldFormat',
  'captionsetup', 'titleformat', 'titlespacing', 'fancyhead', 'fancyfoot', 'fancyhf', 'setstretch', 'linespread', 'makeatletter',
  'texttt', 'path', 'nolinkurl', 'email', 'orcid', 'doi',
]);
/** Commands whose optional [argument] is prose. */
const TEXT_OPT = new Set(['item', 'section', 'subsection', 'subsubsection', 'chapter', 'part', 'paragraph', 'subparagraph', 'caption', 'footnote', 'title', 'author']);
const SKIP_ENV = /^(equation|align|alignat|gather|multline|flalign|eqnarray|displaymath|math|split|dmath|verbatim|Verbatim|lstlisting|minted|comment|filecontents|tikzpicture|tikzcd|pspicture|axis|forest|lstinline|alltt)\*?$/;
const ARG_ENV = /^(tabular|tabularx|tabulary|tabu|array|longtable|xltabular|minipage|multicols|wrapfigure|wraptable|subfigure|tcolorbox|thebibliography|adjustbox|otherlanguage|exercise)\*?$/;
const WORD = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/uy;

function skipBalanced(s, i, open, close) {
  if (s[i] !== open) return i;
  let depth = 0;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
  }
  return s.length;
}
const skipSpaces = (s, i) => { while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '*')) i++; return i; };

/** Returns [{from, to, word}] for prose words in a LaTeX source string. */
export function latexWords(s) {
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '%') { const j = s.indexOf('\n', i); i = j < 0 ? n : j + 1; continue; }
    if (c === '$') {
      if (s[i + 1] === '$') { const j = s.indexOf('$$', i + 2); i = j < 0 ? n : j + 2; continue; }
      let j = i + 1;
      while (j < n && !(s[j] === '$' && s[j - 1] !== '\\')) j++;
      i = j + 1;
      continue;
    }
    if (c === '\\') {
      const m = /^[A-Za-z@]+/.exec(s.slice(i + 1, i + 40));
      if (!m) {
        const d = s[i + 1];
        if (d === '(' || d === '[') {
          const end = s.indexOf(d === '(' ? '\\)' : '\\]', i + 2);
          i = end < 0 ? n : end + 2;
        } else i += 2; // \\ \% \$ \& \{ …
        continue;
      }
      const name = m[0];
      i += 1 + name.length;
      if (name === 'begin') {
        let j = skipSpaces(s, i);
        const em = /^\{([^}]*)\}/.exec(s.slice(j, j + 60));
        if (em) {
          const env = em[1].trim();
          j += em[0].length;
          if (SKIP_ENV.test(env)) {
            const endTag = `\\end{${env}}`;
            const k = s.indexOf(endTag, j);
            i = k < 0 ? n : k + endTag.length;
            continue;
          }
          j = skipSpaces(s, j);
          while (s[j] === '[') j = skipSpaces(s, skipBalanced(s, j, '[', ']'));
          if (ARG_ENV.test(env)) { j = skipSpaces(s, j); j = skipBalanced(s, j, '{', '}'); if (/^(tabularx|tabulary|xltabular)/.test(env)) j = skipBalanced(s, skipSpaces(s, j), '{', '}'); }
          i = j;
        }
        continue;
      }
      if (name === 'verb' || name === 'lstinline') {
        let j = i;
        if (s[j] === '*') j++;
        const delim = s[j];
        if (delim === '{') { i = skipBalanced(s, j, '{', '}'); continue; }
        const k = s.indexOf(delim, j + 1);
        i = k < 0 ? n : k + 1;
        continue;
      }
      if (SKIP_ARG.has(name)) {
        let j = skipSpaces(s, i);
        while (s[j] === '[') j = skipSpaces(s, skipBalanced(s, j, '[', ']'));
        j = skipBalanced(s, j, '{', '}');
        if (name === 'textcolor' || name === 'colorbox' || name === 'href') { /* second argument is prose */ }
        else if (name === 'definecolor' || name === 'newcommand' || name === 'renewcommand' || name === 'newenvironment' || name === 'setcounter' || name === 'setlength' || name === 'newacronym') {
          j = skipSpaces(s, j);
          while (s[j] === '[' || s[j] === '{') j = skipSpaces(s, s[j] === '[' ? skipBalanced(s, j, '[', ']') : skipBalanced(s, j, '{', '}'));
        }
        i = j;
        continue;
      }
      if (!TEXT_OPT.has(name)) {
        const j = skipSpaces(s, i);
        if (s[j] === '[') i = skipBalanced(s, j, '[', ']');
      }
      continue;
    }
    WORD.lastIndex = i;
    const m = WORD.exec(s);
    if (m) {
      const w = m[0];
      const end = i + w.length;
      const prev = s[i - 1];
      const next = s[end];
      const glued = /[0-9_]/.test(prev || '') || /[0-9_]/.test(next || '');
      const innerCaps = /\p{Lu}/u.test(w.slice(1)); // LaTeX, PDF, iPhone: acronyms/names, skip
      if (w.length > 1 && !glued && !innerCaps) out.push({ from: i, to: end, word: w.replace(/’/g, "'") });
      i = end;
      continue;
    }
    i++;
  }
  return out;
}

// ------------------------------------------------------------------ shared state
const cache = new Map(); // lang -> Map(word -> bad:boolean)
const ignored = new Set();
const cacheFor = (lang) => { if (!cache.has(lang)) cache.set(lang, new Map()); return cache.get(lang); };

export function markWordOk(lang, word) { cacheFor(lang).set(word, false); }
export function clearSpellCache(lang) { if (lang) cache.delete(lang); else cache.clear(); }

const mark = Decoration.mark({ class: 'cm-spell-error' });

/**
 * CodeMirror extension. Options: getLang() -> 'pt_PT' | 'off' | …, getPath() -> current file.
 */
export function spellcheck({ getLang, getPath }) {
  const plugin = ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.decorations = Decoration.none;
      this.tokens = [];
      this.seq = 0;
      this.schedule(50);
    }

    update(u) {
      if (u.docChanged) this.decorations = this.decorations.map(u.changes);
      const forced = u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshSpell)));
      if (u.docChanged || forced) this.schedule(forced ? 0 : 450);
    }

    schedule(ms) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.run(), ms);
    }

    destroy() { clearTimeout(this.timer); this.dead = true; }

    async run() {
      const seq = ++this.seq;
      const lang = getLang();
      const path = getPath() || '';
      if (!lang || lang === 'off' || !/\.tex$/i.test(path)) {
        this.tokens = [];
        this.setDecos([]);
        return;
      }
      const text = this.view.state.doc.toString();
      const tokens = latexWords(text);
      const known = cacheFor(lang);
      const unknown = [...new Set(tokens.map((x) => x.word).filter((w) => !known.has(w)))];
      try {
        for (let k = 0; k < unknown.length; k += 2000) {
          const chunk = unknown.slice(k, k + 2000);
          const r = await api.spell.check(lang, chunk);
          const bad = new Set(r.misspelled);
          for (const w of chunk) known.set(w, bad.has(w));
        }
      } catch (e) {
        if (!this.warned) { this.warned = true; toast(t('Spell check: {msg}', { msg: e.message }), 'error'); }
        return;
      }
      if (this.dead || seq !== this.seq || this.view.state.doc.toString() !== text) return;
      this.tokens = tokens.filter((x) => known.get(x.word) && !ignored.has(x.word));
      this.setDecos(this.tokens);
    }

    setDecos(tokens) {
      this.decorations = Decoration.set(tokens.map((x) => mark.range(x.from, x.to)));
      this.view.dispatch({}); // repaint
    }

    at(pos) {
      let hit = null;
      this.decorations.between(pos, pos, (from, to) => { hit = { from, to }; return false; });
      return hit;
    }
  }, { decorations: (v) => v.decorations });

  const menu = EditorView.domEventHandlers({
    contextmenu(ev, view) {
      const p = view.plugin(plugin);
      const pos = view.posAtCoords({ x: ev.clientX, y: ev.clientY });
      if (!p || pos == null) return false;
      const hit = p.at(pos);
      if (!hit) return false;
      ev.preventDefault();
      showMenu(ev, view, hit, getLang(), () => view.dispatch({ effects: refreshSpell.of(null) }));
      return true;
    },
  });

  return [plugin, menu];
}

let openMenu = null;
function closeMenu() { openMenu?.remove(); openMenu = null; }
document.addEventListener('click', closeMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

async function showMenu(ev, view, { from, to }, lang, refresh) {
  closeMenu();
  const word = view.state.sliceDoc(from, to);
  const sugg = el('div', {}, el('div', { class: 'menu-item disabled' }, t('Loading suggestions…')));
  const item = (label, fn, cls = '') => el('div', { class: `menu-item ${cls}`, onclick: (e) => { e.stopPropagation(); closeMenu(); fn(); } }, label);
  const m = el('div', { class: 'context-menu', style: { left: `${ev.clientX}px`, top: `${ev.clientY}px` }, onclick: (e) => e.stopPropagation() },
    sugg,
    el('div', { class: 'menu-sep' }),
    item(t('Add “{word}” to dictionary', { word }), async () => {
      try { await api.spell.addWord(lang, word.replace(/’/g, "'")); markWordOk(lang, word.replace(/’/g, "'")); refresh(); } catch (e) { toast(e.message, 'error'); }
    }),
    item(t('Ignore in this session'), () => { ignored.add(word.replace(/’/g, "'")); refresh(); }));
  document.body.append(m);
  openMenu = m;
  const r = m.getBoundingClientRect();
  if (r.right > innerWidth) m.style.left = `${Math.max(4, innerWidth - r.width - 4)}px`;
  if (r.bottom > innerHeight) m.style.top = `${Math.max(4, ev.clientY - r.height)}px`;
  try {
    const { suggestions } = await api.spell.suggest(lang, word.replace(/’/g, "'"));
    sugg.innerHTML = '';
    if (!suggestions.length) sugg.append(el('div', { class: 'menu-item disabled' }, t('No suggestions')));
    for (const s of suggestions) {
      sugg.append(item(s, () => {
        if (view.state.sliceDoc(from, to) !== word) return;
        view.dispatch({ changes: { from, to, insert: s }, selection: { anchor: from + s.length } });
        view.focus();
      }, 'sugg'));
    }
  } catch (e) { sugg.innerHTML = ''; sugg.append(el('div', { class: 'menu-item disabled' }, e.message)); }
}
