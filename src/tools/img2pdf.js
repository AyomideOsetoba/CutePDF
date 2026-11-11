import { h, button, iconButton, dropzone, toast, downloadBlob, formatBytes, enableReorder, segmented, field, progressBar } from '../lib/ui.js';
import { resultCard, callout, errorText, openInReaderButton } from '../lib/toolkit.js';
import { saveDoc } from '../lib/pdfdoc.js';
import { embedImageFile, addImagePage } from '../lib/images.js';
import { PDFDocument } from 'pdf-lib';

const IMG_RE = /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif|tiff?)$/i;

export default {
  mount(root, { toolPage }) {
    const items = []; // { id, file, url, rotation }
    let nextId = 1;
    const s = { size: 'a4', orientation: 'auto', margin: 'small', quality: 'original' };
    const grid = h('div', { class: 'image-grid' });
    const result = h('div');
    const count = h('span', { class: 'muted small' });
    const createBtn = button('Create PDF', { variant: 'primary', size: 'lg', icon: 'file', cls: 'btn-block' });
    const dz = dropzone({
      multiple: true,
      accept: 'image/*',
      camera: true,
      title: 'Drop images here',
      hint: 'JPG, PNG, WebP, HEIC (where supported)… or take photos with your phone',
      onFiles: (files) => add(files),
    });
    const options = h('div', { class: 'card card-pad stack hidden' },
      h('div', { class: 'row' }, h('div', { class: 'options-title grow' }, 'Images'), count),
      h('p', { class: 'muted small' }, 'Drag to reorder. Rotation is lossless.'),
      grid,
      h('div', { class: 'grid-2' },
        field('Page size', segmented([{ value: 'a4', label: 'A4' }, { value: 'letter', label: 'Letter' }, { value: 'fit', label: 'Fit image' }], s.size, (v) => { s.size = v; }, { name: 'Page size' })),
        field('Orientation', segmented([{ value: 'auto', label: 'Auto' }, { value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }], s.orientation, (v) => { s.orientation = v; }, { name: 'Orientation' })),
        field('Margin', segmented([{ value: 'none', label: 'None' }, { value: 'small', label: 'Small' }, { value: 'large', label: 'Large' }], s.margin, (v) => { s.margin = v; }, { name: 'Margin' })),
        field('Image quality', segmented([{ value: 'original', label: 'Original' }, { value: 'smaller', label: 'Smaller file' }], s.quality, (v) => { s.quality = v; }, { name: 'Quality' }), 'Smaller file resizes big phone photos to ~200 DPI on the page.'),
      ),
      createBtn,
    );
    root.replaceChildren(...toolPage(h('div', { class: 'stack' }, dz, options, result)));

    const stopReorder = enableReorder(grid, '.image-tile', (order) => {
      const copy = order.map((i) => items[i]);
      items.splice(0, items.length, ...copy);
      render();
    });

    function add(files) {
      for (const f of files) {
        if (!/^image\//.test(f.type) && !IMG_RE.test(f.name)) {
          toast(`Skipped ${f.name}: not an image`, 'error');
          continue;
        }
        items.push({ id: nextId++, file: f, url: URL.createObjectURL(f), rotation: 0 });
      }
      render();
    }

    function render() {
      options.classList.toggle('hidden', !items.length);
      dz.classList.toggle('compact', items.length > 0);
      result.replaceChildren();
      count.textContent = `${items.length} image${items.length === 1 ? '' : 's'}`;
      createBtn.disabled = !items.length;
      grid.replaceChildren(...items.map((it, i) => {
        const img = h('img', { src: it.url, alt: it.file.name, draggable: 'false', style: { transform: `rotate(${it.rotation}deg)` } });
        return h('div', { class: 'image-tile', dataset: { index: String(i) } },
          h('div', { class: 'thumb' }, img),
          h('div', { class: 'tile-foot' },
            h('span', null, `${i + 1}`),
            h('div', { class: 'row', style: { gap: '0' } },
              iconButton('rotateCw', 'Rotate', () => { it.rotation = (it.rotation + 90) % 360; img.style.transform = `rotate(${it.rotation}deg)`; }),
              iconButton('trash', 'Remove', () => { URL.revokeObjectURL(it.url); items.splice(i, 1); render(); }),
            ),
          ),
        );
      }));
    }

    createBtn.addEventListener('click', async () => {
      createBtn.disabled = true;
      const prog = progressBar();
      result.replaceChildren(h('div', { class: 'card card-pad' }, prog.el));
      try {
        const doc = await PDFDocument.create();
        const margin = { none: 0, small: 18, large: 42 }[s.margin];
        for (let i = 0; i < items.length; i++) {
          prog.set(i / items.length, `Adding image ${i + 1} of ${items.length}…`);
          const it = items[i];
          const img = await embedImageFile(doc, it.file, s.quality === 'smaller' ? { maxSide: 2200, quality: 0.82 } : {});
          addImagePage(doc, img, { size: s.size, orientation: s.orientation, margin, rotation: it.rotation, dpi: s.quality === 'smaller' ? 200 : 150 });
        }
        prog.set(0.97, 'Saving…');
        const bytes = await saveDoc(doc);
        const name = items.length === 1 ? `${items[0].file.name.replace(/\.[^.]+$/, '')}.pdf` : 'images.pdf';
        result.replaceChildren(resultCard({
          title: 'PDF created',
          text: `${items.length} page${items.length === 1 ? '' : 's'} · ${formatBytes(bytes.length)}`,
          actions: [button('Download PDF', { variant: 'primary', icon: 'download', onClick: () => downloadBlob(bytes, name) }), openInReaderButton(() => ({ bytes, name }))],
        }));
        result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (e) {
        console.error(e);
        result.replaceChildren(callout('error', errorText(e)));
      } finally {
        createBtn.disabled = false;
      }
    });

    return () => {
      stopReorder();
      for (const it of items) URL.revokeObjectURL(it.url);
    };
  },
};
