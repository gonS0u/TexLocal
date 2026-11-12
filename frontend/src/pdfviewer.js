import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { el } from './api.js';
import { t } from './i18n.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Continuous-scroll PDF viewer. Coordinates exchanged with SyncTeX are PDF
 * points with origin at the top-left of the page.
 */
export class PdfViewer {
  constructor(parent, { onSyncToSource }) {
    this.parent = parent;
    this.onSyncToSource = onSyncToSource;
    this.scale = 1.2;
    this.fit = 'width'; // width | none
    this.pdf = null;
    this.pages = []; // {wrap, canvas, w, h, rendered}
    this.renderToken = 0;

    this.container = el('div', { class: 'pdf-scroll' });
    this.empty = el('div', { class: 'pdf-empty' }, t('No PDF yet. Compile the project (Ctrl+S).'));
    this.container.append(this.empty);
    parent.append(this.container);

    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) this.renderPage(Number(e.target.dataset.page));
    }, { root: this.container, rootMargin: '600px 0px' });

    this.container.addEventListener('dblclick', (ev) => this.handleDblClick(ev));
    new ResizeObserver(() => { if (this.fit === 'width' && this.pdf) this.debouncedRelayout(); }).observe(this.container);
  }

  debouncedRelayout() {
    clearTimeout(this._rl);
    this._rl = setTimeout(() => this.layout(true), 150);
  }

  async load(url) {
    const anchor = this.currentAnchor();
    const task = pdfjsLib.getDocument({ url, isEvalSupported: false });
    let pdf;
    try { pdf = await task.promise; } catch (e) { this.showEmpty(t('Could not open the PDF.')); return; }
    const old = this.task;
    this.task = task;
    this.pdf = pdf;
    if (old) old.destroy().catch(() => {});
    this.sizes = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const p = await pdf.getPage(i);
      const vp = p.getViewport({ scale: 1 });
      this.sizes.push({ w: vp.width, h: vp.height });
    }
    await this.layout(false);
    if (anchor) this.restoreAnchor(anchor);
    this.onPageCount?.(pdf.numPages);
  }

  showEmpty(msg) {
    this.container.innerHTML = '';
    this.empty.textContent = msg;
    this.container.append(this.empty);
  }

  effectiveScale() {
    if (this.fit === 'width' && this.sizes?.length) {
      const avail = this.container.clientWidth - 32;
      return Math.max(0.3, avail / Math.max(...this.sizes.map((s) => s.w)));
    }
    return this.scale;
  }

  async layout(keepPosition) {
    const anchor = keepPosition ? this.currentAnchor() : null;
    const s = this.effectiveScale();
    this.curScale = s;
    this.renderToken++;
    this.observer.disconnect();
    this.container.innerHTML = '';
    this.pages = this.sizes.map((sz, i) => {
      const wrap = el('div', { class: 'pdf-page', 'data-page': i + 1, style: { width: `${sz.w * s}px`, height: `${sz.h * s}px` } });
      this.container.append(wrap);
      this.observer.observe(wrap);
      return { wrap, w: sz.w, h: sz.h, rendered: false };
    });
    this.onScale?.(s);
    if (anchor) this.restoreAnchor(anchor);
  }

  async renderPage(n) {
    const pg = this.pages[n - 1];
    if (!pg || pg.rendered) return;
    pg.rendered = true;
    const token = this.renderToken;
    const page = await this.pdf.getPage(n);
    if (token !== this.renderToken) return;
    const dpr = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: this.curScale * dpr });
    const canvas = el('canvas', { width: Math.floor(viewport.width), height: Math.floor(viewport.height) });
    canvas.style.width = `${pg.w * this.curScale}px`;
    canvas.style.height = `${pg.h * this.curScale}px`;
    try {
      await page.render({ canvas, viewport }).promise;
    } catch (e) { console.error("PDF render", e); pg.rendered = false; return; }
    if (token !== this.renderToken) return;
    pg.wrap.querySelector('canvas')?.remove();
    pg.wrap.prepend(canvas);
  }

  currentAnchor() {
    if (!this.pages.length) return null;
    const top = this.container.scrollTop;
    for (let i = 0; i < this.pages.length; i++) {
      const w = this.pages[i].wrap;
      if (w.offsetTop + w.offsetHeight > top) {
        return { page: i + 1, frac: (top - w.offsetTop) / w.offsetHeight, left: this.container.scrollLeft };
      }
    }
    return null;
  }

  restoreAnchor(a) {
    const p = this.pages[Math.min(a.page, this.pages.length) - 1];
    if (!p) return;
    this.container.scrollTop = p.wrap.offsetTop + a.frac * p.wrap.offsetHeight;
    this.container.scrollLeft = a.left || 0;
  }

  zoom(factor) {
    this.fit = 'none';
    this.scale = Math.min(5, Math.max(0.25, (this.curScale || this.scale) * factor));
    this.layout(true);
  }

  fitWidth() { this.fit = 'width'; this.layout(true); }

  handleDblClick(ev) {
    const wrap = ev.target.closest('.pdf-page');
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    const x = (ev.clientX - r.left) / this.curScale;
    const y = (ev.clientY - r.top) / this.curScale;
    this.onSyncToSource?.(Number(wrap.dataset.page), x, y);
  }

  /** Scroll to and highlight a SyncTeX box (points, top-left origin; v is the baseline). */
  showPosition({ page, boxes }) {
    const pg = this.pages[page - 1];
    if (!pg) return;
    const s = this.curScale;
    this.container.querySelectorAll('.sync-mark').forEach((m) => m.remove());
    const list = (boxes && boxes.length ? boxes : [{ page, h: 0, v: 0, W: pg.w, H: 12 }]).filter((b) => b.page === page);
    let firstTop = null;
    for (const b of list) {
      const W = b.W > 0 ? b.W : pg.w * 0.8;
      const H = b.H > 0 ? b.H : 12;
      const top = (b.v - H) * s;
      firstTop = firstTop === null ? top : Math.min(firstTop, top);
      const m = el('div', { class: 'sync-mark', style: { left: `${b.h * s}px`, top: `${top}px`, width: `${W * s}px`, height: `${(H + 3) * s}px` } });
      pg.wrap.append(m);
      setTimeout(() => m.remove(), 2500);
    }
    this.container.scrollTop = pg.wrap.offsetTop + (firstTop ?? 0) - this.container.clientHeight / 3;
  }
}
