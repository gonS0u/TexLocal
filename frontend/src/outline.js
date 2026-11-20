import { el } from './api.js';
import { t } from './i18n.js';

const LEVELS = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 };
const ICONS = ['Ⅰ', '§', '§', '·', '·', '·'];
const HEAD = /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{/g;

/** Drop everything after an unescaped % (an even number of backslashes before it). */
function stripComment(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '%') continue;
    let bs = 0;
    for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) bs++;
    if (bs % 2 === 0) return line.slice(0, i);
  }
  return line;
}

/** Read a balanced {...} group starting right after its opening brace; null if unclosed. */
function readGroup(s, start) {
  let depth = 1;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return s.slice(start, i);
  }
  return null;
}

function cleanTitle(s) {
  return s
    .replace(/\\\\(\[[^\]]*\])?/g, ' ')
    .replace(/\\(?:label|index|footnote)\{[^}]*\}/g, '')
    .replace(/\\[a-zA-Z]+\*?\s*(?:\[[^\]]*\])?\{([^{}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z]+\*?/g, '')
    .replace(/\\(.)/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Headings of a document: [{level, title, line}]. `doc` is a CodeMirror Text or a string. */
export function parseOutline(doc) {
  const lines = typeof doc === 'string' ? doc.split('\n') : null;
  const n = lines ? lines.length : doc.lines;
  const out = [];
  for (let ln = 1; ln <= n; ln++) {
    const raw = lines ? lines[ln - 1] : doc.line(ln).text;
    if (!raw.includes('\\')) continue;
    const text = stripComment(raw);
    HEAD.lastIndex = 0;
    let m;
    while ((m = HEAD.exec(text))) {
      let body = readGroup(text, m.index + m[0].length);
      if (body == null) {
        // Title continues on the next lines: join a few of them.
        let joined = text.slice(m.index + m[0].length);
        for (let k = 1; k <= 5 && ln + k <= n && body == null; k++) {
          joined += ' ' + stripComment(lines ? lines[ln + k - 1] : doc.line(ln + k).text);
          body = readGroup(joined, 0);
        }
      }
      out.push({ level: LEVELS[m[1]], title: cleanTitle(body ?? '') || '…', line: ln });
    }
  }
  return out;
}

export class Outline {
  constructor(parent, { onGoto, onToggle, open = true }) {
    this.onGoto = onGoto;
    this.onToggle = onToggle;
    this.items = [];
    this.rows = [];
    this.active = -1;
    this.arrow = el('span', { class: 'outline-arrow' });
    this.head = el('div', { class: 'tree-toolbar outline-head', onclick: () => this.setOpen(!this.open) },
      this.arrow, el('span', { class: 'tree-title' }, t('Outline')));
    this.list = el('div', { class: 'outline-list' });
    parent.append(this.head, this.list);
    this.parent = parent;
    this.setOpen(open, true);
    this.update(null);
  }

  setOpen(open, silent) {
    this.open = open;
    this.arrow.textContent = open ? '▾' : '▸';
    this.parent.classList.toggle('collapsed', !open);
    if (!silent) this.onToggle?.(open);
  }

  update(doc, path) {
    this.items = path && /\.(tex|ltx|sty|cls|dtx)$/i.test(path) && doc ? parseOutline(doc) : [];
    this.list.innerHTML = '';
    this.rows = [];
    this.active = -1;
    if (!this.items.length) {
      this.list.append(el('div', { class: 'outline-empty' }, t('No sections in this file')));
      return;
    }
    const top = Math.min(...this.items.map((i) => i.level));
    for (const it of this.items) {
      const row = el('div', {
        class: `outline-row lvl${it.level}`,
        style: { paddingLeft: `${8 + (it.level - top) * 12}px` },
        title: `${it.title} (L${it.line})`,
        onclick: () => this.onGoto?.(it.line),
      }, el('span', { class: 'outline-icon' }, ICONS[it.level]), el('span', { class: 'outline-text' }, it.title));
      this.rows.push(row);
      this.list.append(row);
    }
  }

  setCursorLine(n) {
    let idx = -1;
    for (let i = 0; i < this.items.length && this.items[i].line <= n; i++) idx = i;
    if (idx === this.active) return;
    this.rows[this.active]?.classList.remove('active');
    this.active = idx;
    const row = this.rows[idx];
    if (!row) return;
    row.classList.add('active');
    const l = this.list;
    if (row.offsetTop < l.scrollTop || row.offsetTop + row.offsetHeight > l.scrollTop + l.clientHeight) {
      l.scrollTop = row.offsetTop - l.clientHeight / 3;
    }
  }
}
