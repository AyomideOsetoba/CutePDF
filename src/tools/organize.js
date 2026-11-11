import { h, button, downloadBlob, baseName, formatBytes } from '../lib/ui.js';
import { closePdf } from '../lib/pdf.js';
import { singlePdfInput, resultCard, callout, errorText, openInReaderButton } from '../lib/toolkit.js';
import { loadPdfLib, saveDoc } from '../lib/pdfdoc.js';
import { pageGrid } from '../lib/pagegrid.js';
import { PDFDocument, degrees } from 'pdf-lib';

export default {
  mount(root, { toolPage }) {
    const inputBox = h('div');
    const work = h('div', { class: 'stack' });
    root.replaceChildren(...toolPage(h('div', { class: 'stack' }, inputBox, work)));
    let grid = null;

    const input = singlePdfInput(inputBox, {
      title: 'Drop a PDF to organise',
      onReset: () => {
        grid?.destroy();
        work.replaceChildren();
      },
      onReady: (file) => setup(file),
    });

    function setup(file) {
      const result = h('div');
      const info = h('span', { class: 'muted small' });
      const saveBtn = button('Save PDF', { variant: 'primary', icon: 'check' });
      const changed = () => grid.state.pages.some((p, i) => p.src !== i || p.rotation || p.deleted);
      const update = () => {
        const kept = grid.state.pages.filter((p) => !p.deleted).length;
        info.textContent = `${kept} of ${grid.state.pages.length} pages kept`;
        saveBtn.disabled = !changed() || kept === 0;
        result.replaceChildren();
      };
      grid = pageGrid(file.pdf, { reorderable: true, rotatable: true, deletable: true, onChange: update });

      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        try {
          const src = await loadPdfLib(file.bytes);
          const doc = await PDFDocument.create();
          const keep = grid.state.pages.filter((p) => !p.deleted);
          const copied = await doc.copyPages(src, keep.map((p) => p.src));
          copied.forEach((pg, i) => {
            const extra = keep[i].rotation;
            if (extra) pg.setRotation(degrees((pg.getRotation().angle + extra) % 360));
            doc.addPage(pg);
          });
          const bytes = await saveDoc(doc);
          const name = `${baseName(file.name)}-organized.pdf`;
          result.replaceChildren(resultCard({
            title: 'Your pages are organised',
            text: `${keep.length} page${keep.length === 1 ? '' : 's'} · ${formatBytes(bytes.length)}`,
            actions: [button('Download PDF', { variant: 'primary', icon: 'download', onClick: () => downloadBlob(bytes, name) }), openInReaderButton(() => ({ bytes, name }))],
          }));
          result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } catch (e) {
          console.error(e);
          result.replaceChildren(callout('error', errorText(e)));
        } finally {
          saveBtn.disabled = false;
        }
      });

      work.replaceChildren(
        h('div', { class: 'card card-pad stack' },
          h('p', { class: 'muted small' }, 'Drag pages to reorder them. Use the buttons on each page to rotate or delete it.'),
          h('div', { class: 'row' },
            button('Rotate all left', { size: 'sm', icon: 'rotateCcw', onClick: () => grid.setAll((p) => { p.rotation = (p.rotation + 270) % 360; }) }),
            button('Rotate all right', { size: 'sm', icon: 'rotateCw', onClick: () => grid.setAll((p) => { p.rotation = (p.rotation + 90) % 360; }) }),
            button('Reverse order', { size: 'sm', icon: 'sort', onClick: () => { grid.state.pages.reverse(); grid.render(); update(); } }),
            button('Reset', { size: 'sm', icon: 'undo', onClick: () => { grid.state.pages.sort((a, b) => a.src - b.src); grid.setAll((p) => { p.rotation = 0; p.deleted = false; }); } }),
            h('div', { class: 'grow' }),
            info,
            saveBtn,
          ),
        ),
        result,
        grid.el,
      );
      update();
    }

    return () => {
      grid?.destroy();
      closePdf(input.current?.pdf);
    };
  },
};
