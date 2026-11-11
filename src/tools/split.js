import { h, button, segmented, field, downloadBlob, baseName, formatBytes, parseRangeGroups } from '../lib/ui.js';
import { closePdf } from '../lib/pdf.js';
import { singlePdfInput, resultCard, callout, errorText, openInReaderButton } from '../lib/toolkit.js';
import { loadPdfLib, saveDoc } from '../lib/pdfdoc.js';
import { pageGrid } from '../lib/pagegrid.js';
import { PDFDocument } from 'pdf-lib';
import { zipSync } from 'fflate';

export default {
  mount(root, { toolPage }) {
    const inputBox = h('div');
    const work = h('div', { class: 'stack' });
    root.replaceChildren(...toolPage(h('div', { class: 'stack' }, inputBox, work)));
    let grid = null;

    const input = singlePdfInput(inputBox, {
      title: 'Drop a PDF to split',
      onReset: () => {
        grid?.destroy();
        work.replaceChildren();
      },
      onReady: (file) => setup(file),
    });

    function setup(file) {
      const n = file.pdf.numPages;
      const half = Math.ceil(n / 2);
      const s = { mode: 'select', ranges: n > 1 ? `1-${half}, ${half + 1}-${n}` : '1', every: 1 };
      const result = h('div');
      const selInfo = h('span', { class: 'muted small' });
      grid = pageGrid(file.pdf, { selectable: true, onChange: () => update() });
      const rangeInput = h('input', { class: 'input', value: s.ranges, placeholder: 'e.g. 1-3, 4-10, 11' });
      rangeInput.addEventListener('input', () => { s.ranges = rangeInput.value; update(); });
      const everyInput = h('input', { class: 'input', type: 'number', min: '1', max: String(n), value: '1', inputmode: 'numeric', style: { maxWidth: '120px' } });
      everyInput.addEventListener('input', () => { s.every = Math.max(1, parseInt(everyInput.value, 10) || 1); update(); });
      const modeBox = h('div');
      const runBtn = button('Split PDF', { variant: 'primary', size: 'lg', icon: 'split', cls: 'btn-block' });
      const summary = h('div');

      const selectionBar = h('div', { class: 'row' },
        button('Select all', { size: 'sm', onClick: () => grid.setAll((p) => { p.selected = true; }) }),
        button('Clear', { size: 'sm', onClick: () => grid.setAll((p) => { p.selected = false; }) }),
        button('Odd', { size: 'sm', onClick: () => grid.setAll((p) => { p.selected = p.src % 2 === 0; }) }),
        button('Even', { size: 'sm', onClick: () => grid.setAll((p) => { p.selected = p.src % 2 === 1; }) }),
        h('div', { class: 'grow' }), selInfo,
      );

      const renderMode = () => {
        modeBox.replaceChildren(
          s.mode === 'select' ? h('div', { class: 'stack' }, h('p', { class: 'muted small' }, 'Tap pages below to select them (Shift-click selects a range). They are saved together as one new PDF.'), selectionBar) : '',
          s.mode === 'ranges' ? field('Page ranges', rangeInput, 'Each comma-separated range becomes its own PDF. Example: 1-3, 4-10, 11-') : '',
          s.mode === 'every' ? field('Pages per file', everyInput, `Splits the ${n} pages into files of this many pages.`) : '',
        );
        grid.el.classList.toggle('hidden', s.mode !== 'select');
        update();
      };

      function groups() {
        if (s.mode === 'select') {
          const sel = grid.state.pages.filter((p) => p.selected).map((p) => p.src);
          return sel.length ? [sel] : [];
        }
        if (s.mode === 'ranges') return parseRangeGroups(s.ranges, n).filter((g) => g.length);
        const out = [];
        for (let i = 0; i < n; i += s.every) out.push(Array.from({ length: Math.min(s.every, n - i) }, (_, k) => i + k));
        return out;
      }

      function update() {
        const selCount = grid.state.pages.filter((p) => p.selected).length;
        selInfo.textContent = `${selCount} of ${n} selected`;
        try {
          const g = groups();
          runBtn.disabled = !g.length;
          summary.replaceChildren(g.length
            ? callout('info', g.length === 1 ? `Creates 1 PDF with ${g[0].length} page${g[0].length === 1 ? '' : 's'}.` : `Creates ${g.length} PDFs, downloaded together as a ZIP.`)
            : callout('warn', s.mode === 'select' ? 'Select at least one page.' : 'Enter at least one valid range.'));
        } catch (e) {
          runBtn.disabled = true;
          summary.replaceChildren(callout('error', errorText(e)));
        }
      }

      runBtn.addEventListener('click', async () => {
        runBtn.disabled = true;
        result.replaceChildren(callout('info', 'Splitting…'));
        try {
          const g = groups();
          const src = await loadPdfLib(file.bytes);
          const outs = [];
          for (const pages of g) {
            const doc = await PDFDocument.create();
            const copied = await doc.copyPages(src, pages);
            copied.forEach((p) => doc.addPage(p));
            outs.push({ pages, bytes: await saveDoc(doc) });
          }
          const base = baseName(file.name);
          const label = (pages) => (pages.length === 1 ? `p${pages[0] + 1}` : `p${pages[0] + 1}-${pages[pages.length - 1] + 1}`);
          if (outs.length === 1) {
            const name = `${base}-${label(outs[0].pages)}.pdf`;
            result.replaceChildren(resultCard({
              title: 'Pages extracted',
              text: `${outs[0].pages.length} page${outs[0].pages.length === 1 ? '' : 's'} · ${formatBytes(outs[0].bytes.length)}`,
              actions: [button('Download PDF', { variant: 'primary', icon: 'download', onClick: () => downloadBlob(outs[0].bytes, name) }), openInReaderButton(() => ({ bytes: outs[0].bytes, name }))],
            }));
          } else {
            const files = {};
            for (const o of outs) files[`${base}-${label(o.pages)}.pdf`] = [o.bytes, { level: 0 }];
            const zip = zipSync(files);
            result.replaceChildren(resultCard({
              title: `${outs.length} PDFs ready`,
              text: `ZIP archive · ${formatBytes(zip.length)}`,
              actions: [button('Download ZIP', { variant: 'primary', icon: 'download', onClick: () => downloadBlob(zip, `${base}-split.zip`, 'application/zip') })],
            }));
          }
          result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } catch (e) {
          console.error(e);
          result.replaceChildren(callout('error', errorText(e)));
        } finally {
          runBtn.disabled = false;
        }
      });

      work.replaceChildren(
        h('div', { class: 'card card-pad stack' },
          field('How do you want to split?', segmented([
            { value: 'select', label: 'Pick pages' },
            { value: 'ranges', label: 'By ranges' },
            { value: 'every', label: 'Every N pages' },
          ], s.mode, (v) => { s.mode = v; renderMode(); }, { name: 'Split mode' })),
          modeBox,
          summary,
          runBtn,
        ),
        result,
        grid.el,
      );
      renderMode();
    }

    return () => {
      grid?.destroy();
      closePdf(input.current?.pdf);
    };
  },
};
