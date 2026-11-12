import { api, el, toast } from './api.js';
import { t } from './i18n.js';
import { clearSpellCache } from './spellcheck.js';

/**
 * Package manager modal: Missing · Search · Installed · Updates · Settings.
 * Long operations run as server jobs whose output is streamed via SSE.
 */
export class PackageManager {
  constructor({ getProjectId, onInstalled, onDictionariesChanged }) {
    this.onDictionariesChanged = onDictionariesChanged;
    this.getProjectId = getProjectId;
    this.onInstalled = onInstalled;
    this.tab = 'missing';
    this.missing = [];
    this.status = null;
  }

  async open(tab, missing) {
    if (missing) this.missing = missing;
    if (tab) this.tab = tab;
    if (!this.root) this.build();
    document.body.append(this.root);
    this.root.querySelector('.modal').focus();
    await this.loadStatus();
    this.renderTabs();
    this.show();
  }

  close() { this.root?.remove(); }

  build() {
    this.tabsEl = el('div', { class: 'pm-tabs' });
    this.content = el('div', { class: 'pm-content' });
    this.console = el('pre', { class: 'pm-console hidden' });
    this.root = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === this.root) this.close(); } },
      el('div', { class: 'modal pm', tabindex: '-1', onkeydown: (e) => { if (e.key === 'Escape') this.close(); } },
        el('div', { class: 'modal-head' }, el('h2', {}, t('Packages & dictionaries')), el('button', { class: 'icon-btn', onclick: () => this.close(), title: t('Close') }, '✕')),
        this.tabsEl, this.content, this.console));
  }

  async loadStatus() {
    try { this.status = await api.pkg.status(); } catch (e) { this.status = null; toast(e.message, 'error'); }
  }

  renderTabs() {
    const tabs = [['missing', t('Missing')], ['search', t('Search')], ['installed', t('Installed')], ['updates', t('Updates')], ['dicts', t('Dictionaries')], ['settings', t('Settings')]];
    this.tabsEl.innerHTML = '';
    for (const [id, label] of tabs) {
      this.tabsEl.append(el('button', { class: `pm-tab ${this.tab === id ? 'active' : ''}`, onclick: () => { this.tab = id; this.renderTabs(); this.show(); } },
        label, id === 'missing' && this.missing.length ? el('span', { class: 'count err' }, this.missing.length) : null,
        id === 'settings' && this.status && !this.status.usertree ? el('span', { class: 'count err' }, '!') : null));
    }
  }

  show() {
    this.content.innerHTML = '';
    ({ missing: () => this.showMissing(), search: () => this.showSearch(), installed: () => this.showInstalled(), updates: () => this.showUpdates(), dicts: () => this.showDictionaries(), settings: () => this.showSettings() })[this.tab]();
  }

  needUsertree() {
    if (this.status?.usertree) return null;
    return el('div', { class: 'notice warn' },
      t('Installing without sudo (tlmgr user mode) is not set up yet.') + ' ',
      el('button', { class: 'btn small', onclick: () => { this.tab = 'settings'; this.renderTabs(); this.show(); } }, t('Set up now')));
  }

  // ----------------------------------------------------------- jobs
  runJob(promise, { onDone } = {}) {
    return new Promise((resolve) => {
      this.console.classList.remove('hidden');
      this.console.textContent = '';
      promise.then((job) => {
        this.console.textContent = `▶ ${job.title}\n`;
        const es = api.pkg.stream(job.id);
        es.onmessage = (ev) => {
          const { line } = JSON.parse(ev.data);
          this.console.textContent += line + '\n';
          this.console.scrollTop = this.console.scrollHeight;
        };
        es.addEventListener('done', (ev) => {
          es.close();
          const { rc } = JSON.parse(ev.data);
          this.console.textContent += rc === 0 ? `\n✓ ${t('Done.')}\n` : `\n✗ ${t('Failed (code {rc}).', { rc })}\n`;
          this.console.scrollTop = this.console.scrollHeight;
          toast(rc === 0 ? `${job.title}: ${t('done')}` : `${job.title}: ${t('failed')}`, rc === 0 ? 'success' : 'error');
          onDone?.(rc);
          resolve(rc);
        });
        es.onerror = () => { /* EventSource auto-retries; 'done' closes it */ };
      }).catch((e) => {
        this.console.textContent += `✗ ${e.message}\n`;
        toast(e.message, 'error');
        resolve(-1);
      });
    });
  }

  install(pkgs, via, then) {
    return this.runJob(api.pkg.install(pkgs, via), { onDone: async (rc) => { if (rc === 0) { await this.onInstalled?.(); } then?.(rc); } });
  }

  // ----------------------------------------------------------- tabs
  async showMissing() {
    const c = this.content;
    const pid = this.getProjectId();
    c.append(el('p', { class: 'muted' }, t('Files the compilation could not find, and a check of the project’s \\usepackage / \\documentclass.')));
    const warn = this.needUsertree();
    if (warn) c.append(warn);
    const actions = el('div', { class: 'row' },
      pid ? el('button', { class: 'btn', onclick: () => this.checkProject() }, '🔍 ' + t('Check project packages')) : null);
    c.append(actions);
    this.missingBox = el('div', {});
    c.append(this.missingBox);
    if (!this.missing.length) {
      this.missingBox.append(el('div', { class: 'muted pad' }, t('No missing packages detected in the last compilation.')));
      return;
    }
    await this.resolveAndRender(this.missing);
  }

  async checkProject() {
    const pid = this.getProjectId();
    this.missingBox.innerHTML = '';
    this.missingBox.append(el('div', { class: 'muted pad' }, t('Checking…')));
    try {
      const r = await api.checkPackages(pid);
      this.missingBox.innerHTML = '';
      this.missingBox.append(el('div', { class: 'muted pad' }, t('{used} packages/classes used, {missing} missing.', { used: r.packages.length, missing: r.missing.length })));
      if (r.missing.length) {
        this.missing = r.missing.map((m) => ({ file: m.file, kind: 'file' }));
        this.renderTabs();
        await this.resolveAndRender(this.missing);
      }
    } catch (e) { toast(e.message, 'error'); }
  }

  async resolveAndRender(missing) {
    const box = this.missingBox;
    const loading = el('div', { class: 'muted pad' }, t('Looking up which package provides each file (may take a while the first time)…'));
    box.append(loading);
    let res;
    try { res = await api.pkg.resolve(missing); } catch (e) { loading.textContent = e.message; return; }
    loading.remove();
    const table = el('table', { class: 'pm-table' },
      el('thead', {}, el('tr', {}, el('th', {}, t('Missing')), el('th', {}, t('CTAN (tlmgr, no sudo)')), el('th', {}, 'Debian (apt)'))));
    const tbody = el('tbody');
    for (const r of res) {
      tbody.append(el('tr', {},
        el('td', {}, el('code', {}, r.file), r.hint ? el('div', { class: 'muted small' }, r.hint) : null),
        el('td', {}, r.tlmgr
          ? [el('code', {}, r.tlmgr), ' ', el('button', { class: 'btn primary small', disabled: !this.status?.usertree, onclick: () => this.install([r.tlmgr], 'tlmgr', () => this.afterFix()) }, t('Install'))]
          : el('span', { class: 'muted' }, this.status?.usertree ? t('not found') : '—')),
        el('td', {}, r.apt
          ? [el('code', {}, r.apt), ' ', el('button', { class: 'btn small', disabled: !this.status?.pkexec, onclick: () => this.install([r.apt], 'apt', () => this.afterFix()) }, t('Install (admin)'))]
          : el('span', { class: 'muted' }, this.status?.apt_file ? t('not found') : t('apt-file unavailable')))));
    }
    table.append(tbody);
    box.append(table);
    const tl = [...new Set(res.map((r) => r.tlmgr).filter(Boolean))];
    if (tl.length > 1 && this.status?.usertree) {
      box.append(el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: () => this.install(tl, 'tlmgr', () => this.afterFix()) }, t('Install all via tlmgr ({list})', { list: tl.join(', ') }))));
    }
  }

  afterFix() {
    this.missing = [];
    this.renderTabs();
  }

  showSearch() {
    const c = this.content;
    const warn = this.needUsertree();
    if (warn) c.append(warn);
    const input = el('input', { type: 'search', placeholder: t('Name or description (e.g. siunitx, tikz, glossaries)…'), class: 'grow' });
    const results = el('div', { class: 'pm-results' });
    const go = async () => {
      const qq = input.value.trim();
      if (!qq) return;
      results.innerHTML = '';
      results.append(el('div', { class: 'muted pad' }, t('Searching CTAN…')));
      try {
        const list = await api.pkg.search(qq);
        results.innerHTML = '';
        if (!list.length) results.append(el('div', { class: 'muted pad' }, t('No results.')));
        const table = el('table', { class: 'pm-table' });
        for (const p of list) {
          table.append(el('tr', {},
            el('td', {}, el('a', { href: '#', onclick: (e) => { e.preventDefault(); this.showInfo(p.name, row); } }, el('code', {}, p.name))),
            el('td', { class: 'desc' }, p.description),
            el('td', {}, p.installed === 'user' ? el('span', { class: 'tag ok' }, t('installed'))
              : p.installed === 'system' ? el('span', { class: 'tag' }, t('system'))
                : el('button', { class: 'btn primary small', onclick: () => this.install([p.name], 'tlmgr') }, t('Install')))));
          const row = el('tr', { class: 'info-row hidden' }, el('td', { colspan: 3 }));
          table.append(row);
        }
        results.append(table);
      } catch (e) { results.innerHTML = ''; results.append(el('div', { class: 'notice error' }, e.message)); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    c.append(el('div', { class: 'row' }, input, el('button', { class: 'btn primary', onclick: go }, t('Search'))), results);
    setTimeout(() => input.focus(), 0);
  }

  async showInfo(name, row) {
    if (!row.classList.contains('hidden')) { row.classList.add('hidden'); return; }
    row.classList.remove('hidden');
    const td = row.firstChild;
    td.textContent = t('Loading…');
    try {
      const info = await api.pkg.info(name);
      td.innerHTML = '';
      const dl = el('dl', { class: 'pm-info' });
      for (const k of ['shortdesc', 'longdesc', 'category', 'cat-version', 'cat-license', 'installed', 'revision', 'collection', 'cat-topics']) {
        if (info[k] !== undefined) dl.append(el('dt', {}, k), el('dd', {}, info[k]));
      }
      td.append(dl, el('a', { href: `https://ctan.org/pkg/${encodeURIComponent(name)}`, target: '_blank', rel: 'noopener' }, t('View on CTAN ↗')));
    } catch (e) { td.textContent = e.message; }
  }

  async showInstalled() {
    const c = this.content;
    const filter = el('input', { type: 'search', placeholder: t('Filter…'), class: 'grow' });
    const box = el('div', {}, el('div', { class: 'muted pad' }, t('Loading…')));
    c.append(el('div', { class: 'row' }, filter), box);
    let data;
    try { data = await api.pkg.installed(); } catch (e) { box.textContent = e.message; return; }
    const render = () => {
      const f = filter.value.toLowerCase();
      const match = (p) => !f || p.name.toLowerCase().includes(f) || (p.description || '').toLowerCase().includes(f);
      box.innerHTML = '';
      box.append(el('h3', {}, `${t('User (~/texmf, tlmgr)')} — ${data.user.length}`));
      if (!data.user.length) box.append(el('div', { class: 'muted pad' }, t('No packages installed in user mode.')));
      const t1 = el('table', { class: 'pm-table' });
      for (const p of data.user.filter(match)) {
        t1.append(el('tr', {}, el('td', {}, el('code', {}, p.name)), el('td', { class: 'desc' }, p.description), el('td', {}, `r${p.revision}`),
          el('td', {}, el('button', { class: 'btn danger small', onclick: () => { if (confirm(t('Remove {name}?', { name: p.name }))) this.runJob(api.pkg.remove([p.name], 'tlmgr'), { onDone: () => this.show() }); } }, t('Remove')))));
      }
      box.append(t1);
      box.append(el('h3', {}, `${t('System (apt)')} — ${data.system.length}`));
      const t2 = el('table', { class: 'pm-table' });
      for (const p of data.system.filter(match)) {
        t2.append(el('tr', {}, el('td', {}, el('code', {}, p.name)), el('td', { class: 'desc' }, p.description), el('td', { class: 'small' }, p.revision),
          el('td', {}, el('button', { class: 'btn danger small', disabled: !this.status?.pkexec, onclick: () => { if (confirm(t('Remove the system package {name}? (asks for the administrator password)', { name: p.name }))) this.runJob(api.pkg.remove([p.name], 'apt'), { onDone: () => this.show() }); } }, t('Remove')))));
      }
      box.append(t2);
    };
    filter.addEventListener('input', render);
    render();
  }

  async showUpdates() {
    const c = this.content;
    const warn = this.needUsertree();
    if (warn) c.append(warn);
    const box = el('div', {}, el('div', { class: 'muted pad' }, t('Checking for updates (CTAN and apt)…')));
    c.append(box);
    let data;
    try { data = await api.pkg.updates(); } catch (e) { box.textContent = e.message; return; }
    box.innerHTML = '';
    const section = (title, list, via) => {
      box.append(el('h3', {}, `${title} — ${list.length}`));
      if (!list.length) { box.append(el('div', { class: 'muted pad' }, t('Everything is up to date.'))); return; }
      const checks = [];
      const tbl = el('table', { class: 'pm-table' });
      for (const p of list) {
        const cb = el('input', { type: 'checkbox', checked: true, value: p.name });
        checks.push(cb);
        tbl.append(el('tr', {}, el('td', {}, cb), el('td', {}, el('code', {}, p.name)), el('td', {}, p.status), el('td', { class: 'small' }, `${p.local} → ${p.remote}`)));
      }
      box.append(tbl);
      const sel = () => checks.filter((x) => x.checked).map((x) => x.value);
      box.append(el('div', { class: 'row' },
        el('button', { class: 'btn primary', onclick: () => this.runJob(api.pkg.update(sel(), via), { onDone: () => this.show() }) }, via === 'apt' ? t('Update selected (admin)') : t('Update selected')),
        via === 'tlmgr' ? el('button', { class: 'btn', onclick: () => this.runJob(api.pkg.update([], 'tlmgr', true), { onDone: () => this.show() }) }, t('Update all')) : null));
    };
    section(t('User (tlmgr)'), data.user, 'tlmgr');
    section(t('System (apt)'), data.system, 'apt');
    box.append(el('p', { class: 'muted small' }, t('The apt list depends on a recent “apt update” (sudo apt update).')));
  }

  showSettings() {
    const s = this.status || {};
    const c = this.content;
    const yes = (b) => el('span', { class: `tag ${b ? 'ok' : 'bad'}` }, b ? t('yes') : t('no'));
    const dl = el('dl', { class: 'pm-info' },
      el('dt', {}, t('tlmgr available')), el('dd', {}, yes(s.tlmgr)),
      el('dt', {}, t('User tree')), el('dd', {}, yes(s.usertree), ' ', el('code', {}, s.texmfhome || '')),
      el('dt', {}, t('CTAN repository')), el('dd', {}, s.repository || '—'),
      el('dt', {}, t('apt-file (Debian lookup)')), el('dd', {}, yes(s.apt_file), s.apt_file && !s.apt_file_ready ? ' — ' + t('run: sudo apt-file update') : ''),
      el('dt', {}, t('pkexec (install via apt)')), el('dd', {}, yes(s.pkexec)),
      el('dt', {}, 'latexmk'), el('dd', {}, yes(s.latexmk), s.latexmk ? '' : ' — ' + t('recommended: sudo apt install latexmk')),
      el('dt', {}, t('Engines')), el('dd', {}, Object.entries(s.engines || {}).map(([k, v]) => el('span', { class: `tag ${v ? 'ok' : 'bad'}` }, k))));
    const repo = el('input', { type: 'url', class: 'grow', value: s.repository || 'https://mirror.ctan.org/systems/texlive/tlnet' });
    c.append(dl,
      el('h3', {}, t('Install without sudo (tlmgr --usermode)')),
      el('p', { class: 'muted' }, t('Packages go to ~/texmf and TeX finds them automatically. The repository must match the installed TeX Live version (for older versions use a historic repository, e.g. https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2025/tlnet-final).')),
      el('div', { class: 'row' }, repo,
        el('button', { class: 'btn primary', onclick: () => this.runJob(api.pkg.init(repo.value.trim()), { onDone: async () => { await this.loadStatus(); this.renderTabs(); this.show(); } }) }, s.usertree ? t('Save repository') : t('Initialise ~/texmf'))),
      el('h3', {}, t('Install system tools')),
      el('div', { class: 'row' },
        ...['latexmk', 'texlive-xetex', 'biber', 'texlive-lang-portuguese', 'texlive-lang-english', 'texlive-science', 'texlive-bibtex-extra', 'hunspell'].map((p) =>
          el('button', { class: 'btn small', disabled: !s.pkexec, onclick: () => this.runJob(api.pkg.install([p], 'apt'), { onDone: async () => { await this.loadStatus(); this.show(); } }) }, p))));
  }

  // ----------------------------------------------------------- dictionaries
  async showDictionaries() {
    const c = this.content;
    const box = el('div', {}, el('div', { class: 'muted pad' }, t('Loading…')));
    c.append(el('p', { class: 'muted' }, t('Spell-check dictionaries (Hunspell). Choose the language of each project in the editor toolbar.')), box);
    let data;
    try { data = await api.spell.languages(); } catch (e) { box.textContent = e.message; return; }
    box.innerHTML = '';
    if (!data.available) {
      box.append(el('div', { class: 'notice warn' }, t('Hunspell is not installed. Install it with: sudo apt install hunspell'),
        ' ', el('button', { class: 'btn small', disabled: !this.status?.pkexec, onclick: () => this.runJob(api.pkg.install(['hunspell'], 'apt'), { onDone: () => this.show() }) }, t('Install (admin)'))));
    }
    const changed = () => { clearSpellCache(); this.onDictionariesChanged?.(); this.show(); };

    box.append(el('h3', {}, `${t('Installed')} — ${data.installed.length}`));
    const t1 = el('table', { class: 'pm-table' });
    for (const d of data.installed) {
      t1.append(el('tr', {},
        el('td', {}, el('code', {}, d.code)),
        el('td', {}, d.name, d.native && d.native !== d.name ? el('span', { class: 'muted' }, ` · ${d.native}`) : null),
        el('td', {}, el('span', { class: `tag ${d.source === 'user' ? 'ok' : ''}` }, d.source === 'user' ? t('downloaded') : t('system'))),
        el('td', {},
          el('button', { class: 'btn small', onclick: () => this.showPersonal(d.code, row) }, t('Personal words')), ' ',
          d.source === 'user' ? el('button', {
            class: 'btn danger small',
            onclick: async () => {
              if (!confirm(t('Remove the {name} dictionary?', { name: d.name }))) return;
              try { await api.spell.removeLanguage(d.code); changed(); } catch (e) { toast(e.message, 'error'); }
            },
          }, t('Remove')) : null)));
      const row = el('tr', { class: 'hidden' }, el('td', { colspan: 4 }));
      t1.append(row);
    }
    box.append(t1);

    const filter = el('input', { type: 'search', placeholder: t('Filter…'), class: 'grow' });
    const t2 = el('table', { class: 'pm-table' });
    const render = () => {
      const f = filter.value.toLowerCase();
      t2.innerHTML = '';
      for (const d of data.catalog.filter((x) => !f || `${x.code} ${x.name} ${x.native}`.toLowerCase().includes(f))) {
        t2.append(el('tr', {},
          el('td', {}, el('code', {}, d.code)),
          el('td', {}, d.name, el('span', { class: 'muted' }, ` · ${d.native}`)),
          el('td', {}, d.installed ? el('span', { class: 'tag ok' }, t('installed'))
            : el('button', { class: 'btn primary small', onclick: () => this.runJob(api.spell.download(d.code), { onDone: (rc) => { if (rc === 0) changed(); } }) }, t('Download')))));
      }
    };
    filter.addEventListener('input', render);
    render();
    box.append(el('h3', {}, t('Download more languages')),
      el('p', { class: 'muted small' }, t('Dictionaries from wooorm/dictionaries (LibreOffice/Hunspell), downloaded from cdn.jsdelivr.net to ~/.local/share/latexlocal/dictionaries.')),
      el('div', { class: 'row' }, filter), t2);
  }

  async showPersonal(code, row) {
    if (!row.classList.contains('hidden')) { row.classList.add('hidden'); return; }
    row.classList.remove('hidden');
    const td = row.firstChild;
    const draw = async () => {
      td.innerHTML = '';
      let words = [];
      try { ({ words } = await api.spell.personal(code)); } catch (e) { td.textContent = e.message; return; }
      const input = el('input', { type: 'text', placeholder: t('Add a word…') });
      const add = async () => {
        const w = input.value.trim();
        if (!w) return;
        try { await api.spell.addWord(code, w); clearSpellCache(code); this.onDictionariesChanged?.(); draw(); } catch (e) { toast(e.message, 'error'); }
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
      td.append(el('div', { class: 'row' }, input, el('button', { class: 'btn small', onclick: add }, t('Add'))),
        words.length ? el('div', { class: 'row' }, ...words.map((w) => el('span', { class: 'tag' }, w, ' ',
          el('a', { href: '#', title: t('Remove'), onclick: async (e) => { e.preventDefault(); await api.spell.removeWord(code, w); clearSpellCache(code); this.onDictionariesChanged?.(); draw(); } }, '×'))))
          : el('div', { class: 'muted small' }, t('No personal words yet.')));
    };
    draw();
  }
}
