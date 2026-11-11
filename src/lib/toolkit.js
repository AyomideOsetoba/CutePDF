// Building blocks shared by the tool pages.
import { h, icon, button, toast, formatBytes, isPdf, readFile, dropzone } from './ui.js';
import { openPdf, closePdf } from './pdf.js';
import { takePending, go } from './handoff.js';

export function fileChip({ name, meta, onChange, iconName = 'file' }) {
  return h('div', { class: 'file-chip' },
    h('div', { class: 'file-ic' }, icon(iconName, 20)),
    h('div', { class: 'grow' }, h('div', { class: 'file-name', title: name }, name), h('div', { class: 'file-meta' }, meta)),
    onChange ? button('Change', { size: 'sm', onClick: onChange }) : null,
  );
}

export function resultCard({ title, text, actions = [] }) {
  return h('div', { class: 'result' },
    h('div', { class: 'result-ic' }, icon('check', 24)),
    h('div', null, h('h3', null, title), text ? h('p', null, text) : null),
    h('div', { class: 'row' }, actions),
  );
}

export function callout(kind, ...content) {
  const ic = { info: 'info', warn: 'warn', success: 'check', error: 'warn' }[kind] || 'info';
  return h('div', { class: `callout ${kind}` }, icon(ic, 18), h('div', null, ...content));
}

export function errorText(e) {
  return String(e?.message || e || 'Something went wrong');
}

/**
 * Standard single-PDF flow: show a dropzone (or take a file handed over from
 * another tool), open it with pdf.js and call onReady({ bytes, name, pdf, size }).
 */
export function singlePdfInput(container, { title = 'Drop a PDF here', hint, onReady, onReset }) {
  let current = null;
  const showDrop = () => {
    closePdf(current?.pdf);
    current = null;
    onReset?.();
    container.replaceChildren(dropzone({ title, hint, onFiles: ([f]) => load(f) }));
  };
  const load = async (fileOrPending) => {
    try {
      let bytes;
      let name;
      if (fileOrPending instanceof Blob) {
        if (!isPdf(fileOrPending)) {
          toast('Please choose a PDF file', 'error');
          return;
        }
        bytes = await readFile(fileOrPending);
        name = fileOrPending.name;
      } else {
        ({ bytes, name } = fileOrPending);
      }
      container.replaceChildren(h('div', { class: 'file-chip' }, icon('spinner', 20, 'spin'), h('span', null, `Opening ${name}…`)));
      const pdf = await openPdf(bytes, name);
      current = { bytes, name, pdf, size: bytes.length };
      container.replaceChildren(fileChip({ name, meta: `${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'} · ${formatBytes(bytes.length)}`, onChange: showDrop }));
      await onReady(current);
    } catch (e) {
      console.error(e);
      toast(errorText(e), 'error', 6000);
      showDrop();
    }
  };
  const pending = takePending();
  if (pending) load(pending);
  else showDrop();
  return { reset: showDrop, get current() { return current; } };
}

export function openInReaderButton(getFile) {
  return button('Open in Reader', { icon: 'read', onClick: () => go('#/read', getFile()) });
}

export const canvasToBlob = (canvas, type = 'image/png', quality) =>
  new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality));

export function isMobile() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
}

/** Run async tasks with limited concurrency. */
export async function runPool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}
