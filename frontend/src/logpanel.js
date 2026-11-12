import { el } from './api.js';
import { t } from './i18n.js';

export class LogPanel {
  constructor(parent, { onJump, onInstallMissing }) {
    this.onJump = onJump;
    this.onInstallMissing = onInstallMissing;
    this.filter = 'errors';
    this.tabs = el('div', { class: 'log-tabs' });
    this.body = el('div', { class: 'log-body' });
    parent.append(this.tabs, this.body);
    this.result = null;
    this.render();
  }

  set(result) {
    this.result = result;
    if (result && !result.errors.length && this.filter === 'errors') this.filter = result.warnings.length ? 'warnings' : 'errors';
    if (result && result.errors.length) this.filter = 'errors';
    this.render();
  }

  render() {
    const r = this.result;
    const tab = (id, label, n, cls) => el('button', {
      class: `log-tab ${this.filter === id ? 'active' : ''} ${cls || ''}`,
      onclick: () => { this.filter = id; this.render(); },
    }, label, n !== undefined ? el('span', { class: 'count' }, n) : null);
    this.tabs.innerHTML = '';
    this.tabs.append(
      tab('errors', t('Errors'), r?.errors.length ?? 0, r?.errors.length ? 'has-errors' : ''),
      tab('warnings', t('Warnings'), r ? r.warnings.filter((w) => w.type !== 'box').length : 0),
      tab('boxes', t('Boxes'), r ? r.warnings.filter((w) => w.type === 'box').length : 0),
      tab('raw', t('Full log')),
      r ? el('span', { class: 'log-meta' }, `${r.engine} · ${r.duration}s`) : null,
    );
    this.body.innerHTML = '';
    if (!r) { this.body.append(el('div', { class: 'muted pad' }, t('Not compiled yet.'))); return; }

    if (r.missing?.length) {
      this.body.append(el('div', { class: 'missing-banner' },
        el('strong', {}, t('Missing packages:') + ' '),
        r.missing.map((m) => m.kind === 'babel' ? t('babel language “{name}”', { name: m.file }) : m.file).join(', '),
        el('button', { class: 'btn primary small', onclick: () => this.onInstallMissing(r.missing) }, t('Resolve…'))));
    }

    if (this.filter === 'raw') {
      const pre = el('pre', { class: 'raw-log' }, t('Loading…'));
      this.body.append(pre);
      this.onRaw?.().then((t) => { pre.textContent = t || r.output; });
      return;
    }
    const items = this.filter === 'errors' ? r.errors
      : this.filter === 'warnings' ? r.warnings.filter((w) => w.type !== 'box')
        : r.warnings.filter((w) => w.type === 'box');
    if (!items.length) {
      this.body.append(el('div', { class: 'muted pad' }, this.filter === 'errors' ? (r.ok ? t('✓ No errors.') : t('No errors identified — see the full log.')) : t('Nothing to show.')));
      return;
    }
    for (const it of items) {
      const jumpable = it.line && !it.external;
      this.body.append(el('div', {
        class: `log-item ${this.filter} ${jumpable ? 'clickable' : ''}`,
        onclick: () => jumpable && this.onJump(it.file || r.main, it.line),
      },
      el('div', { class: 'log-loc' }, it.file || (it.line ? r.main : ''), it.line ? `:${it.line}` : ''),
      el('div', { class: 'log-msg' }, it.message),
      it.context ? el('pre', { class: 'log-ctx' }, it.context) : null));
    }
  }
}
