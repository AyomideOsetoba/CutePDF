import { h, button, icon, toast, progressBar, segmented, toggle, field, downloadBlob, baseName, formatBytes } from '../lib/ui.js';
import { singlePdfInput, resultCard, callout, errorText, openInReaderButton, canvasToBlob, isMobile } from '../lib/toolkit.js';
import { renderToCanvas, AnnotationMode, countTextChars, closePdf } from '../lib/pdf.js';
import { loadPdfLib, pageContentBytes, setPageContentBytes, saveDoc } from '../lib/pdfdoc.js';
import { countTextOps, stripInvisibleText } from '../lib/contentstream.js';
import { OcrPool, wordsToLines } from '../lib/ocr.js';
import { embedTextLayerFont, writeInvisibleText, viewportMapping } from '../lib/textlayer-pdf.js';
import { linesToText } from '../lib/layout.js';
import { pageText } from '../lib/textorder.js';

const REC_DPI = isMobile() ? 250 : 300;
const DPI_OPTIONS = [
  { value: 200, label: 'Fast' },
  { value: REC_DPI, label: 'Recommended' },
  { value: 400, label: 'Small print' },
];

export default {
  mount(root, { toolPage }) {
    const inputBox = h('div');
    const work = h('div', { class: 'stack' });
    root.replaceChildren(...toolPage(h('div', { class: 'stack' }, inputBox, work)));

    let aborted = false;
    let pool = null;
    const settings = { dpi: REC_DPI, redo: true };

    const input = singlePdfInput(inputBox, {
      title: 'Drop a scanned PDF here',
      hint: 'Scans, photographed pages, or PDFs with a broken text layer',
      onReset: () => work.replaceChildren(),
      onReady: (file) => analyze(file),
    });

    async function analyze(file) {
      const status = h('div', { class: 'card card-pad' }, h('div', { class: 'row' }, icon('spinner', 18, 'spin'), h('span', null, 'Checking which pages need OCR…')));
      work.replaceChildren(status);
      const { pdf, bytes } = file;
      const kinds = []; // 'scan' | 'ocr' | 'text'
      let lib = null;
      let libError = null;
      try {
        lib = await loadPdfLib(bytes);
      } catch (e) {
        libError = e;
      }
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const chars = countTextChars(await page.getTextContent());
        if (chars < 25) kinds.push('scan');
        else if (lib) {
          let ops = { visible: 1, invisible: 0 };
          try {
            ops = countTextOps(pageContentBytes(lib.getPage(i - 1)));
          } catch {
            /* unreadable content: treat as digital text */
          }
          kinds.push(ops.invisible > 0 && ops.invisible >= 4 * ops.visible ? 'ocr' : 'text');
        } else kinds.push('text');
        page.cleanup();
      }
      if (libError) {
        work.replaceChildren(callout('error', errorText(libError)));
        return;
      }
      showOptions(file, lib, kinds);
    }

    function showOptions(file, lib, kinds) {
      const nScan = kinds.filter((k) => k === 'scan').length;
      const nOcr = kinds.filter((k) => k === 'ocr').length;
      const nText = kinds.filter((k) => k === 'text').length;
      const stats = h('div', { class: 'stat-row' },
        stat(nScan, 'scanned pages (no text)'),
        stat(nOcr, 'pages OCR’d by another app'),
        stat(nText, 'pages with digital text'),
      );
      const plan = h('div');
      const startBtn = button('Make searchable', { variant: 'primary', size: 'lg', icon: 'ocr', cls: 'btn-block' });
      const updatePlan = () => {
        const todo = nScan + (settings.redo ? nOcr : 0);
        startBtn.disabled = todo === 0;
        if (todo === 0) {
          plan.replaceChildren(callout('success', h('b', null, 'This PDF already has real text. '), 'Nothing to OCR. Open it in the Reader: CutePDF puts the existing text in column order so selection and copy work on two-column pages.', h('div', { class: 'row', style: { marginTop: '10px' } }, openInReaderButton(() => ({ bytes: file.bytes, name: file.name })))));
        } else {
          plan.replaceChildren(callout('info', `${todo} page${todo === 1 ? '' : 's'} will be recognised. Pages with digital text are left untouched. Two-column layouts are detected per page automatically.`));
        }
      };
      const options = h('div', { class: 'card card-pad stack' },
        stats,
        h('div', { class: 'grid-2' },
          field('Scan resolution', segmented(DPI_OPTIONS, settings.dpi, (v) => { settings.dpi = v; }, { name: 'Resolution' }), 'Higher is slower but helps with tiny footnotes and subscripts.'),
          h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Language'), h('div', { class: 'input', style: { display: 'flex', alignItems: 'center' } }, 'English'), h('span', { class: 'field-hint' }, 'The OCR model is downloaded once and then works offline.')),
        ),
        nOcr ? toggle('Redo pages OCR’d by other apps', settings.redo, (v) => { settings.redo = v; updatePlan(); }, 'Replaces their invisible text with a fresh, column-aware layer (fixes selection jumping across columns). The page images are kept as they are.') : null,
        plan,
        startBtn,
      );
      startBtn.addEventListener('click', () => run(file, lib, kinds));
      work.replaceChildren(options);
      updatePlan();
    }

    async function run(file, lib, kinds) {
      aborted = false;
      const prog = progressBar();
      const log = h('div', { class: 'small muted' });
      const cancel = button('Cancel', { size: 'sm', icon: 'close', onClick: () => { aborted = true; cancel.disabled = true; prog.text('Cancelling…'); } });
      work.replaceChildren(h('div', { class: 'card card-pad stack' }, prog.el, h('div', { class: 'row' }, log, h('div', { class: 'grow' }), cancel)));
      const t0 = performance.now();
      try {
        const todo = kinds.map((k, i) => ({ k, i })).filter(({ k }) => k === 'scan' || (settings.redo && k === 'ocr')).map(({ i }) => i);
        prog.set(0.02, 'Loading OCR engine (first time can take a moment)…');
        pool = new OcrPool();
        await pool.init((s) => prog.text(s));
        if (aborted) throw new Error('cancelled');
        const fontInfo = await embedTextLayerFont(lib);
        const texts = new Array(kinds.length).fill(null);
        const colsPerPage = {};
        let done = 0;
        const mobile = isMobile();
        const maxPixels = mobile ? 7e6 : 14e6;

        // render the next page while others are being recognised
        let next = 0;
        const worker = async () => {
          while (next < todo.length && !aborted) {
            const i = todo[next++];
            const page = await file.pdf.getPage(i + 1);
            const scale = settings.dpi / 72;
            const { canvas, viewport, ratio } = await renderToCanvas(page, scale, { annotationMode: AnnotationMode.DISABLE, maxPixels });
            const blob = await canvasToBlob(canvas, 'image/png');
            canvas.width = canvas.height = 0;
            page.cleanup();
            if (aborted) return;
            const words = await pool.recognize(blob);
            const { lines, columns } = wordsToLines(words);
            const libPage = lib.getPage(i);
            if (kinds[i] === 'ocr') {
              const { bytes } = stripInvisibleText(pageContentBytes(libPage));
              setPageContentBytes(libPage, bytes);
            }
            writeInvisibleText(libPage, lines, viewportMapping(viewport, ratio), fontInfo);
            texts[i] = linesToText(lines);
            colsPerPage[i] = columns;
            done++;
            prog.set(0.05 + (0.88 * done) / todo.length, `Recognised page ${i + 1} (${done} of ${todo.length})`);
            log.textContent = `Page ${i + 1}: ${words.length} words, ${columns === 1 ? 'single column' : `${columns} columns detected`}`;
          }
        };
        await Promise.all(Array.from({ length: pool.size }, worker));
        if (aborted) throw new Error('cancelled');

        prog.set(0.95, 'Collecting text of the other pages…');
        for (let i = 0; i < kinds.length; i++) {
          if (texts[i] == null) {
            const page = await file.pdf.getPage(i + 1);
            texts[i] = await pageText(page);
            page.cleanup();
          }
        }
        prog.set(0.98, 'Saving PDF…');
        const out = await saveDoc(lib);
        prog.set(1, 'Done');
        const secs = Math.round((performance.now() - t0) / 1000);
        const twoCol = Object.values(colsPerPage).filter((c) => c > 1).length;
        const outName = `${baseName(file.name)}-searchable.pdf`;
        const fullText = texts.map((t, i) => `--- Page ${i + 1} ---\n${t.trim()}\n`).join('\n');
        work.replaceChildren(
          resultCard({
            title: 'Your PDF is now searchable',
            text: `${todo.length} page${todo.length === 1 ? '' : 's'} recognised in ${secs}s${twoCol ? ` · ${twoCol} multi-column page${twoCol === 1 ? '' : 's'} put in reading order` : ''} · ${formatBytes(out.length)}`,
            actions: [
              button('Download PDF', { variant: 'primary', icon: 'download', onClick: () => downloadBlob(out, outName) }),
              openInReaderButton(() => ({ bytes: out, name: outName })),
              button('Text (.txt)', { icon: 'file', onClick: () => downloadBlob(new Blob([fullText], { type: 'text/plain;charset=utf-8' }), `${baseName(file.name)}.txt`) }),
            ],
          }),
          callout('info', 'Tip: open the result in the Reader (or any PDF app) and try selecting text across a column — it now flows down the column instead of jumping across.'),
          h('div', { class: 'row' }, button('OCR another file', { icon: 'plus', onClick: () => input.reset() })),
        );
      } catch (e) {
        if (String(e?.message) === 'cancelled') {
          toast('OCR cancelled');
          showOptions(file, await loadPdfLib(file.bytes), kinds);
        } else {
          console.error(e);
          work.replaceChildren(callout('error', `OCR failed: ${errorText(e)}`), h('div', { class: 'row' }, button('Try again', { icon: 'rotateCw', onClick: () => analyze(file) })));
        }
      } finally {
        pool?.terminate();
        pool = null;
      }
    }

    return () => {
      aborted = true;
      pool?.terminate();
      closePdf(input.current?.pdf);
    };
  },
};

function stat(n, label) {
  return h('div', { class: 'stat' }, h('b', null, String(n)), h('span', null, label));
}
