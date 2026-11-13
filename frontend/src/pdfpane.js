import { el } from './api.js';
import { t } from './i18n.js';
import { PdfViewer } from './pdfviewer.js';

/**
 * PDF toolbar + viewer, shared by the project view and the detached PDF window.
 * `leftButtons` / `rightButtons` are extra elements placed around the standard controls.
 */
export function buildPdfPane({ onSyncToSource, leftButtons = [], rightButtons = [], hint = true }) {
  let viewer;
  const zoomLabel = el('span', { class: 'zoom', title: t('Actual size (100%)'), onclick: () => viewer.actualSize() }, '100%');
  const pageInput = el('input', {
    class: 'page-input', type: 'text', inputmode: 'numeric', value: '–', disabled: true, 'aria-label': t('Page'),
    onkeydown: (e) => {
      if (e.key === 'Enter') { viewer.goToPage(Number(pageInput.value)); pageInput.blur(); }
      else if (e.key === 'Escape') { pageInput.blur(); }
    },
    onfocus: () => pageInput.select(),
    onblur: () => viewer.notifyPage(true),
    onchange: () => viewer.goToPage(Number(pageInput.value)),
  });
  const pageTotal = el('span', { class: 'page-total' }, '/ –');

  const toolbar = el('div', { class: 'pdf-toolbar' },
    ...leftButtons,
    el('button', { class: 'icon-btn', title: t('Zoom out'), onclick: () => viewer.zoom(1 / 1.15) }, '−'),
    zoomLabel,
    el('button', { class: 'icon-btn', title: t('Zoom in'), onclick: () => viewer.zoom(1.15) }, '+'),
    el('button', { class: 'icon-btn', title: t('Fit width'), onclick: () => viewer.fitWidth() }, '↔'),
    el('button', { class: 'icon-btn small-txt', title: t('Actual size (100%)'), onclick: () => viewer.actualSize() }, '1:1'),
    el('span', { class: 'page-ind', title: t('Page') }, pageInput, pageTotal),
    el('div', { class: 'spacer' }),
    ...(hint ? [el('span', { class: 'muted small' }, t('Double-click → source'))] : []),
    ...rightButtons);
  const host = el('div', { class: 'pdf-host' });
  const pane = el('section', { class: 'pane pdf-pane' }, toolbar, host);

  viewer = new PdfViewer(host, { onSyncToSource });
  viewer.onScale = (s) => { zoomLabel.textContent = `${Math.round(s * 100)}%`; };
  viewer.onPageChange = (page, total) => {
    if (document.activeElement !== pageInput) pageInput.value = total ? String(page) : '–';
    pageInput.disabled = !total;
    pageInput.max = String(total || 1);
    pageTotal.textContent = `/ ${total || '–'}`;
  };
  return { pane, viewer, toolbar };
}

/** Channel shared by the project window and its detached PDF window. */
export const pdfChannel = (pid) => new BroadcastChannel(`latexlocal:${pid}`);
