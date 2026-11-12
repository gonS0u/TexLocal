import { EditorState, EditorSelection, Compartment } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
  dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands';
import {
  StreamLanguage, syntaxHighlighting, HighlightStyle, bracketMatching, foldGutter, indentOnInput, foldKeymap,
} from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search';
import { setDiagnostics, lintGutter } from '@codemirror/lint';
import { latexCompletion } from './completion.js';
import { spellcheck, refreshSpell } from './spellcheck.js';

/* Colours come from CSS variables (style.css) so both themes stay readable. */
const latexHighlight = HighlightStyle.define([
  { tag: t.tagName, color: 'var(--hl-command)' },
  { tag: t.keyword, color: 'var(--hl-keyword)', fontWeight: '600' },
  { tag: t.atom, color: 'var(--hl-atom)' },
  { tag: [t.special(t.variableName), t.variableName], color: 'var(--hl-math)' },
  { tag: t.comment, color: 'var(--hl-comment)', fontStyle: 'italic' },
  { tag: [t.bracket, t.paren, t.squareBracket, t.brace], color: 'var(--hl-bracket)' },
  { tag: t.number, color: 'var(--hl-number)' },
  { tag: [t.string, t.meta], color: 'var(--hl-string)' },
  { tag: t.invalid, color: 'var(--hl-error)' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, color: 'var(--hl-command)', textDecoration: 'underline' },
  { tag: t.heading, color: 'var(--hl-keyword)', fontWeight: '700' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--editor-font-size, 14px)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--fg)' },
  '.cm-gutters': { background: 'var(--panel)', color: 'var(--muted)', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { background: 'var(--active-line)' },
  '.cm-activeLineGutter': { background: 'var(--active-line)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { background: 'var(--selection) !important' },
  '.cm-flash-line': { background: 'var(--flash)', transition: 'background 1s' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)', borderLeftWidth: '2px' },
  '.cm-matchingBracket': { background: 'var(--accent-soft)', outline: '1px solid var(--accent)', color: 'inherit !important' },
  '.cm-nonmatchingBracket': { background: 'color-mix(in srgb, var(--danger) 25%, transparent)' },
  '.cm-searchMatch': { background: 'rgba(255, 200, 0, 0.35)', outline: '1px solid rgba(230, 160, 0, 0.8)' },
  '.cm-searchMatch-selected': { background: 'rgba(255, 140, 0, 0.55)' },
  '.cm-selectionMatch': { background: 'var(--accent-soft)' },
  '.cm-foldPlaceholder': { background: 'var(--accent-soft)', color: 'var(--fg)', border: '1px solid var(--border)' },
  '.cm-panels': { background: 'var(--panel)', color: 'var(--fg)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panel input, .cm-panel button, .cm-textfield, .cm-button': { color: 'var(--fg)', background: 'var(--surface)', backgroundImage: 'none', border: '1px solid var(--border)', borderRadius: '4px' },
  '.cm-tooltip': { background: 'var(--surface)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: '6px', boxShadow: '0 6px 20px rgba(0,0,0,.25)' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px !important' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: 'var(--accent)', color: 'var(--accent-fg)' },
  '.cm-completionDetail': { color: 'inherit', opacity: '0.75' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '700' },
  '.cm-tooltip-lint, .cm-diagnostic': { color: 'var(--fg)' },
  '.cm-diagnostic-error': { borderLeftColor: 'var(--danger)' },
  '.cm-diagnostic-warning': { borderLeftColor: 'var(--warn)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--danger)', textUnderlineOffset: '3px' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline dotted var(--warn)', textUnderlineOffset: '3px' },
  '.cm-specialChar': { color: 'var(--danger)' },
});

/**
 * Multi-file editor: one EditorView, one EditorState per open file.
 */
export class Editor {
  constructor(parent, { onSave, onSyncToPdf, onChange, getSymbols, spell }) {
    this.parent = parent;
    this.docs = new Map(); // path -> {state, savedContent}
    this.current = null;
    this.onChange = onChange;
    this.wrap = new Compartment();
    this.extensions = [
      lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(), dropCursor(),
      EditorState.allowMultipleSelections.of(true), indentOnInput(), syntaxHighlighting(latexHighlight),
      bracketMatching(), closeBrackets(), rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
      search({ top: true }), lintGutter(),
      StreamLanguage.define(stex),
      autocompletion({ override: [latexCompletion(getSymbols)], activateOnTyping: true, maxRenderedOptions: 80 }),
      this.wrap.of(EditorView.lineWrapping),
      spell ? spellcheck({ ...spell, getPath: () => this.current }) : [],
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { onSave(); return true; } },
        { key: 'Mod-Enter', preventDefault: true, run: (v) => { const l = v.state.doc.lineAt(v.state.selection.main.head); onSyncToPdf(this.current, l.number, v.state.selection.main.head - l.from); return true; } },
        { key: 'Mod-/', run: toggleComment },
        { key: 'Mod-b', run: (v) => wrapSelection(v, '\\textbf{', '}') },
        { key: 'Mod-i', run: (v) => wrapSelection(v, '\\textit{', '}') },
        ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && this.current) {
          const d = this.docs.get(this.current);
          if (d) d.dirty = u.state.doc.toString() !== d.saved;
          this.onChange?.(this.current, d?.dirty);
        }
      }),
      theme,
    ];
    this.view = new EditorView({ parent, state: EditorState.create({ doc: '', extensions: [...this.extensions, EditorState.readOnly.of(true)] }) });
  }

  open(path, content) {
    if (this.current && this.docs.has(this.current)) this.docs.get(this.current).state = this.view.state;
    let d = this.docs.get(path);
    if (!d) {
      d = { state: EditorState.create({ doc: content, extensions: this.extensions }), saved: content, dirty: false };
      this.docs.set(path, d);
    }
    this.current = path;
    this.view.setState(d.state);
    this.applyDiagnostics();
    this.view.focus();
  }

  has(path) { return this.docs.has(path); }

  close(path) {
    this.docs.delete(path);
    if (this.current === path) {
      this.current = null;
      this.view.setState(EditorState.create({ doc: '', extensions: [...this.extensions, EditorState.readOnly.of(true)] }));
    }
  }

  rename(oldPath, newPath) {
    const d = this.docs.get(oldPath);
    if (!d) return;
    this.docs.delete(oldPath);
    this.docs.set(newPath, d);
    if (this.current === oldPath) this.current = newPath;
  }

  content(path) {
    if (path === this.current) return this.view.state.doc.toString();
    return this.docs.get(path)?.state.doc.toString();
  }

  dirtyFiles() {
    if (this.current && this.docs.has(this.current)) this.docs.get(this.current).state = this.view.state;
    return [...this.docs.entries()].filter(([, d]) => d.state.doc.toString() !== d.saved).map(([p]) => p);
  }

  markSaved(path, content) {
    const d = this.docs.get(path);
    if (d) { d.saved = content; d.dirty = false; }
  }

  goto(line, column = 0) {
    const doc = this.view.state.doc;
    const l = doc.line(Math.min(Math.max(1, line), doc.lines));
    const pos = Math.min(l.from + column, l.to);
    this.view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
    this.view.focus();
    // brief highlight
    const dom = this.view.domAtPos(l.from).node;
    const lineEl = (dom.nodeType === 1 ? dom : dom.parentElement)?.closest('.cm-line');
    if (lineEl) { lineEl.classList.add('cm-flash-line'); setTimeout(() => lineEl.classList.remove('cm-flash-line'), 1200); }
  }

  /** Re-run the spell checker (after a language change or dictionary update). */
  refreshSpell() { this.view.dispatch({ effects: refreshSpell.of(null) }); }

  setWrap(on) { this.view.dispatch({ effects: this.wrap.reconfigure(on ? EditorView.lineWrapping : []) }); }

  /** errors: [{file, line, message, severity}] for all files; applied to current view. */
  setDiagnostics(all) {
    this.diagnostics = all;
    this.applyDiagnostics();
  }

  applyDiagnostics() {
    const doc = this.view.state.doc;
    const diags = (this.diagnostics || [])
      .filter((d) => d.file === this.current && d.line)
      .map((d) => {
        const l = doc.line(Math.min(d.line, doc.lines));
        return { from: l.from, to: l.to, severity: d.severity, message: d.message };
      });
    this.view.dispatch(setDiagnostics(this.view.state, diags));
  }
}

function wrapSelection(view, before, after) {
  const changes = view.state.changeByRange((range) => ({
    changes: [{ from: range.from, insert: before }, { from: range.to, insert: after }],
    range: range.empty
      ? EditorSelection.cursor(range.from + before.length)
      : EditorSelection.range(range.from + before.length, range.to + before.length),
  }));
  view.dispatch(view.state.update(changes, { scrollIntoView: true }));
  return true;
}
