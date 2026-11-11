import { h, button, segmented, field, downloadBlob, baseName, formatBytes, parsePageRanges, progressBar } from '../lib/ui.js';
import { singlePdfInput, resultCard, callout, errorText, canvasToBlob } from '../lib/toolkit.js';
import { renderToCanvas, closePdf } from '../lib/pdf.js';
import { zipSync } from 'fflate';

export default {
  mount(root, { toolPage }) {
    const inputBox = h('div');
    const work = h('div', { class: 'stack' });
    root.replaceChildren(...toolPage(h('div', { class: 'stack' }, inputBox, work)));
    const urls = [];
    let cancelled = false;

    const input = singlePdfInput(inputBox, {
      title: 'Drop a PDF to convert to images',
      onReset: () => work.replaceChildren(),
      onReady: (file) => setup(file),
    });

    function setup(file) {
      const n = file.pdf.numPages;
      const s = { format: 'png', dpi: 150, pages: '' };
      const pagesInput = h('input', { class: 'input', placeholder: `All pages (1-${n})` });
      pagesInput.addEventListener('input', () => { s.pages = pagesInput.value; });
      const result = h('div', { class: 'stack' });
      const runBtn = button('Convert to images', { variant: 'primary', size: 'lg', icon: 'images', cls: 'btn-block' });
      runBtn.addEventListener('click', () => run(file, s, result, runBtn));
      work.replaceChildren(
        h('div', { class: 'card card-pad stack' },
          h('div', { class: 'grid-2' },
            field('Format', segmented([{ value: 'png', label: 'PNG' }, { value: 'jpg', label: 'JPG' }], s.format, (v) => { s.format = v; }, { name: 'Format' }), 'PNG is sharp for text and figures; JPG is smaller for photos.'),
            field('Resolution', segmented([{ value: 72, label: '72 DPI' }, { value: 150, label: '150 DPI' }, { value: 300, label: '300 DPI' }], s.dpi, (v) => { s.dpi = v; }, { name: 'Resolution' }), 'Use 300 DPI for posters and print.'),
          ),
          field('Pages', pagesInput, 'Leave empty for all pages, or e.g. 1-3, 7'),
          runBtn,
        ),
        result,
      );
    }

    async function run(file, s, result, runBtn) {
      let pages;
      try {
        pages = s.pages.trim() ? parsePageRanges(s.pages, file.pdf.numPages) : Array.from({ length: file.pdf.numPages }, (_, i) => i);
        if (!pages.length) throw new Error('No pages selected');
      } catch (e) {
        result.replaceChildren(callout('error', errorText(e)));
        return;
      }
      cancelled = false;
      runBtn.disabled = true;
      const prog = progressBar();
      result.replaceChildren(h('div', { class: 'card card-pad' }, prog.el));
      const base = baseName(file.name);
      const ext = s.format === 'png' ? 'png' : 'jpg';
      const outs = [];
      try {
        for (let k = 0; k < pages.length && !cancelled; k++) {
          const i = pages[k];
          prog.set(k / pages.length, `Rendering page ${i + 1}…`);
          const page = await file.pdf.getPage(i + 1);
          const { canvas } = await renderToCanvas(page, s.dpi / 72, { maxPixels: 40e6 });
          const blob = await canvasToBlob(canvas, s.format === 'png' ? 'image/png' : 'image/jpeg', 0.9);
          canvas.width = canvas.height = 0;
          page.cleanup();
          outs.push({ name: `${base}-page-${String(i + 1).padStart(String(file.pdf.numPages).length, '0')}.${ext}`, blob });
        }
        prog.set(1, 'Done');
        for (const u of urls.splice(0)) URL.revokeObjectURL(u);
        const total = outs.reduce((n, o) => n + o.blob.size, 0);
        const zipAll = async () => {
          const files = {};
          for (const o of outs) files[o.name] = [new Uint8Array(await o.blob.arrayBuffer()), { level: 0 }];
          downloadBlob(zipSync(files), `${base}-images.zip`, 'application/zip');
        };
        const gallery = h('div', { class: 'image-grid' }, outs.map((o) => {
          const url = URL.createObjectURL(o.blob);
          urls.push(url);
          return h('a', { class: 'image-tile', href: url, download: o.name, title: `Download ${o.name}`, style: { cursor: 'pointer', touchAction: 'auto' } },
            h('div', { class: 'thumb' }, h('img', { src: url, alt: o.name, loading: 'lazy' })),
            h('div', { class: 'tile-foot' }, h('span', null, o.name.split('-page-')[1]), h('span', null, formatBytes(o.blob.size))));
        }));
        result.replaceChildren(
          resultCard({
            title: `${outs.length} image${outs.length === 1 ? '' : 's'} ready`,
            text: `${ext.toUpperCase()} · ${s.dpi} DPI · ${formatBytes(total)} total`,
            actions: outs.length === 1
              ? [button('Download image', { variant: 'primary', icon: 'download', onClick: () => downloadBlob(outs[0].blob, outs[0].name) })]
              : [button('Download all (ZIP)', { variant: 'primary', icon: 'download', onClick: zipAll })],
          }),
          outs.length > 1 ? h('p', { class: 'muted small' }, 'Tap an image to download it on its own.') : null,
          gallery,
        );
      } catch (e) {
        console.error(e);
        result.replaceChildren(callout('error', errorText(e)));
      } finally {
        runBtn.disabled = false;
      }
    }

    return () => {
      cancelled = true;
      for (const u of urls) URL.revokeObjectURL(u);
      closePdf(input.current?.pdf);
    };
  },
};
