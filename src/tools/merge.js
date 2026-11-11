import { h, button, iconButton, icon, dropzone, toast, downloadBlob, formatBytes, isPdf, readFile, enableReorder, parsePageRanges, progressBar } from '../lib/ui.js';
import { resultCard, callout, errorText, openInReaderButton } from '../lib/toolkit.js';
import { openPdf, renderThumb, closePdf, releaseImage } from '../lib/pdf.js';
import { loadPdfLib, saveDoc } from '../lib/pdfdoc.js';
import { embedImageFile, addImagePage } from '../lib/images.js';
import { takePending } from '../lib/handoff.js';
import { PDFDocument } from 'pdf-lib';

export default {
  mount(root, { toolPage }) {
    const items = []; // { id, kind: 'pdf'|'image', name, size, bytes?, file?, pages?, range, thumb }
    let nextId = 1;
    const list = h('div', { class: 'file-list' });
    const result = h('div');
    const mergeBtn = button('Merge files', { variant: 'primary', size: 'lg', icon: 'merge', cls: 'btn-block' });
    const summary = h('div', { class: 'muted small' });
    const listCard = h('div', { class: 'card card-pad stack hidden' },
      h('div', { class: 'row' }, h('div', { class: 'options-title grow' }, 'Files to merge'), summary),
      h('p', { class: 'muted small' }, 'Drag the handles to change the order. Optionally choose which pages to take from each PDF.'),
      list,
      mergeBtn,
    );
    const dz = dropzone({
      multiple: true,
      accept: 'application/pdf,.pdf,image/*',
      title: 'Drop PDFs (and images) to merge',
      hint: 'Add as many as you like — they stay on this device',
      onFiles: (files) => addFiles(files),
    });
    root.replaceChildren(...toolPage(h('div', { class: 'stack' }, dz, listCard, result)));
    dz.classList.add('compact');

    const stopReorder = enableReorder(list, '.file-row', (order) => {
      const copy = order.map((i) => items[i]);
      items.splice(0, items.length, ...copy);
      render();
    }, '.drag-handle');

    async function addFiles(files) {
      for (const f of files) {
        const isImg = /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif)$/i.test(f.name);
        if (!isPdf(f) && !isImg) {
          toast(`Skipped ${f.name}: not a PDF or image`, 'error');
          continue;
        }
        const it = { id: nextId++, kind: isImg ? 'image' : 'pdf', name: f.name, size: f.size, file: f, range: '' };
        items.push(it);
        if (it.kind === 'pdf') {
          try {
            it.bytes = await readFile(f);
            const pdf = await openPdf(it.bytes, f.name);
            it.pages = pdf.numPages;
            renderThumb(pdf, 1, 80).then((c) => { it.thumb = c; render(); closePdf(pdf); }).catch(() => closePdf(pdf));
          } catch (e) {
            toast(`${f.name}: ${errorText(e)}`, 'error', 6000);
            items.splice(items.indexOf(it), 1);
          }
        } else {
          it.url = URL.createObjectURL(f);
          it.pages = 1;
        }
        render();
      }
    }

    function render() {
      listCard.classList.toggle('hidden', !items.length);
      result.replaceChildren();
      const totalPages = items.reduce((n, it) => n + (rangeCount(it) ?? 0), 0);
      summary.textContent = `${items.length} file${items.length === 1 ? '' : 's'} · ${totalPages} pages`;
      mergeBtn.disabled = items.length < 1 || items.some((it) => rangeCount(it) === null);
      list.replaceChildren(...items.map((it, i) => {
        const rangeInput = it.kind === 'pdf' && it.pages > 1 ? h('input', { class: 'input', style: { width: '120px', minHeight: '34px' }, placeholder: `All ${it.pages}`, value: it.range, 'aria-label': `Pages of ${it.name}` }) : null;
        rangeInput?.addEventListener('change', () => {
          it.range = rangeInput.value;
          render();
        });
        const bad = rangeCount(it) === null;
        const thumb = h('div', { class: 'mini-thumb' });
        if (it.thumb) thumb.append(it.thumb);
        else if (it.url) thumb.append(h('img', { src: it.url, alt: '' }));
        else thumb.append(icon('file', 18));
        return h('div', { class: 'file-row', dataset: { index: String(i) } },
          h('button', { class: 'drag-handle', type: 'button', 'aria-label': 'Drag to reorder' }, icon('grip', 18)),
          thumb,
          h('div', { class: 'grow' },
            h('div', { class: 'file-name', title: it.name }, it.name),
            h('div', { class: 'file-meta', style: bad ? { color: 'var(--danger)' } : null }, bad ? 'Invalid page range' : `${it.kind === 'pdf' ? `${it.pages} page${it.pages === 1 ? '' : 's'}` : 'Image'} · ${formatBytes(it.size)}`),
          ),
          rangeInput,
          iconButton('up', 'Move up', () => move(i, -1), { cls: i === 0 ? 'hidden' : '' }),
          iconButton('trash', 'Remove', () => {
            if (it.url) URL.revokeObjectURL(it.url);
            releaseImage(it.thumb);
            items.splice(i, 1);
            render();
          }),
        );
      }));
    }

    function move(i, d) {
      const j = i + d;
      if (j < 0 || j >= items.length) return;
      [items[i], items[j]] = [items[j], items[i]];
      render();
    }

    function rangeCount(it) {
      if (it.kind !== 'pdf' || !it.range.trim()) return it.pages ?? 0;
      try {
        const r = parsePageRanges(it.range, it.pages);
        return r.length ? r.length : null;
      } catch {
        return null;
      }
    }

    mergeBtn.addEventListener('click', async () => {
      mergeBtn.disabled = true;
      const prog = progressBar();
      result.replaceChildren(h('div', { class: 'card card-pad' }, prog.el));
      try {
        const out = await PDFDocument.create();
        for (let k = 0; k < items.length; k++) {
          const it = items[k];
          prog.set(k / items.length, `Adding ${it.name}…`);
          if (it.kind === 'pdf') {
            const src = await loadPdfLib(it.bytes);
            const idx = it.range.trim() ? parsePageRanges(it.range, it.pages) : src.getPageIndices();
            const pages = await out.copyPages(src, idx);
            pages.forEach((p) => out.addPage(p));
          } else {
            const img = await embedImageFile(out, it.file);
            addImagePage(out, img, { size: 'a4', margin: 0 });
          }
        }
        prog.set(0.95, 'Saving…');
        const bytes = await saveDoc(out);
        const name = 'merged.pdf';
        result.replaceChildren(resultCard({
          title: 'Merged!',
          text: `${out.getPageCount()} pages · ${formatBytes(bytes.length)}`,
          actions: [button('Download PDF', { variant: 'primary', icon: 'download', onClick: () => downloadBlob(bytes, name) }), openInReaderButton(() => ({ bytes, name }))],
        }));
        result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (e) {
        console.error(e);
        result.replaceChildren(callout('error', errorText(e)));
      } finally {
        mergeBtn.disabled = false;
      }
    });

    const pending = takePending();
    if (pending) addFiles([new File([pending.bytes], pending.name, { type: 'application/pdf' })]);

    return () => {
      stopReorder();
      for (const it of items) {
        if (it.url) URL.revokeObjectURL(it.url);
        releaseImage(it.thumb);
      }
    };
  },
};
