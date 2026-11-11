import { h, button, segmented, field, toggle, downloadBlob, baseName, formatBytes, progressBar } from '../lib/ui.js';
import { closePdf } from '../lib/pdf.js';
import { singlePdfInput, resultCard, callout, errorText, openInReaderButton } from '../lib/toolkit.js';
import { compressPdf, PRESETS } from '../lib/compress.js';

export default {
  mount(root, { toolPage }) {
    const inputBox = h('div');
    const work = h('div', { class: 'stack' });
    root.replaceChildren(...toolPage(h('div', { class: 'stack' }, inputBox, work)));

    const input = singlePdfInput(inputBox, {
      title: 'Drop a PDF to compress',
      hint: 'Scans and image-heavy PDFs shrink the most',
      onReset: () => work.replaceChildren(),
      onReady: (file) => setup(file),
    });

    function setup(file) {
      const s = { preset: 'balanced', strip: false };
      const hint = h('p', { class: 'muted small' }, PRESETS[s.preset].hint);
      const result = h('div');
      const runBtn = button('Compress PDF', { variant: 'primary', size: 'lg', icon: 'compress', cls: 'btn-block' });
      runBtn.addEventListener('click', () => run(file, s, result, runBtn));
      work.replaceChildren(
        h('div', { class: 'card card-pad stack' },
          field('Compression level', segmented(Object.entries(PRESETS).map(([value, p]) => ({ value, label: p.label })), s.preset, (v) => {
            s.preset = v;
            hint.textContent = `${PRESETS[v].hint} · images at about ${PRESETS[v].dpi} DPI`;
          }, { name: 'Compression level' })),
          hint,
          toggle('Remove metadata', s.strip, (v) => { s.strip = v; }, 'Strips title, author, editing history and embedded thumbnails.'),
          callout('info', 'Text, fonts and vector graphics are never touched, so everything stays sharp and searchable. Only oversized images are re-encoded.'),
          runBtn,
        ),
        result,
      );
      hint.textContent = `${PRESETS[s.preset].hint} · images at about ${PRESETS[s.preset].dpi} DPI`;
    }

    async function run(file, s, result, runBtn) {
      runBtn.disabled = true;
      const prog = progressBar();
      result.replaceChildren(h('div', { class: 'card card-pad' }, prog.el));
      try {
        const p = PRESETS[s.preset];
        const { bytes, stats } = await compressPdf(file.bytes, { dpi: p.dpi, quality: p.quality, stripMetadata: s.strip }, (f, t) => prog.set(f, t));
        prog.set(1, 'Done');
        const before = file.bytes.length;
        const after = bytes.length;
        const pct = Math.round((1 - after / before) * 100);
        const name = `${baseName(file.name)}-compressed.pdf`;
        if (after >= before * 0.98) {
          result.replaceChildren(callout('warn', h('b', null, 'This PDF is already well optimised. '),
            `CutePDF could not make it meaningfully smaller (${formatBytes(before)} → ${formatBytes(after)}). It probably contains mostly text and vector graphics, which are already compact.`,
            stats.images ? ` ${stats.images} image${stats.images === 1 ? '' : 's'} checked.` : ''));
        } else {
          result.replaceChildren(
            resultCard({
              title: `${pct}% smaller`,
              text: `${formatBytes(before)} → ${formatBytes(after)} · ${stats.recompressed} of ${stats.images} image${stats.images === 1 ? '' : 's'} optimised`,
              actions: [
                button('Download PDF', { variant: 'primary', icon: 'download', onClick: () => downloadBlob(bytes, name) }),
                openInReaderButton(() => ({ bytes, name })),
              ],
            }),
            h('div', { class: 'stat-row' },
              stat(formatBytes(before), 'original'),
              stat(formatBytes(after), 'compressed'),
              stat(`${pct}%`, 'saved'),
            ),
          );
        }
        result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (e) {
        console.error(e);
        result.replaceChildren(callout('error', errorText(e)));
      } finally {
        runBtn.disabled = false;
      }
    }

    return () => closePdf(input.current?.pdf);
  },
};

const stat = (v, label) => h('div', { class: 'stat' }, h('b', null, v), h('span', null, label));
