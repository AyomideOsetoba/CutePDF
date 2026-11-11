import { h, button, toggle, downloadBlob, baseName, formatBytes, progressBar } from '../lib/ui.js';
import { singlePdfInput, resultCard, callout, errorText, canvasToBlob, isMobile } from '../lib/toolkit.js';
import { renderToCanvas, AnnotationMode, countTextChars, closePdf, openPdf } from '../lib/pdf.js';
import { layoutTextContent } from '../lib/textorder.js';
import { median, mergeRowFragments } from '../lib/layout.js';
import { OcrPool, wordsToLines } from '../lib/ocr.js';
import { buildParagraphs, paragraphsToDocx } from '../lib/docx-export.js';

export default {
  mount(root, { toolPage }) {
    const inputBox = h('div');
    const work = h('div', { class: 'stack' });
    root.replaceChildren(...toolPage(h('div', { class: 'stack' }, inputBox, work)));
    let pool = null;
    let cancelled = false;

    const input = singlePdfInput(inputBox, {
      title: 'Drop a PDF to convert to Word',
      onReset: () => work.replaceChildren(),
      onReady: (file) => setup(file),
    });

    function setup(file) {
      const s = { ocr: true, pageBreaks: false, skipHeaders: true };
      const result = h('div');
      const runBtn = button('Convert to Word', { variant: 'primary', size: 'lg', icon: 'word', cls: 'btn-block' });
      runBtn.addEventListener('click', () => run(file, s, result, runBtn));
      work.replaceChildren(
        h('div', { class: 'card card-pad stack' },
          toggle('Recognise scanned pages (OCR)', s.ocr, (v) => { s.ocr = v; }, 'Pages without real text are read with OCR, column-aware.'),
          toggle('Skip running headers & page numbers', s.skipHeaders, (v) => { s.skipHeaders = v; }),
          toggle('Start each PDF page on a new Word page', s.pageBreaks, (v) => { s.pageBreaks = v; }),
          callout('info', 'You get editable text with headings, paragraphs, bold and italics — in the right order even for two-column papers. Figures, tables and equations are not reproduced exactly.'),
          runBtn,
        ),
        result,
      );
    }

    async function run(file, s, result, runBtn) {
      runBtn.disabled = true;
      cancelled = false;
      const prog = progressBar();
      result.replaceChildren(h('div', { class: 'card card-pad' }, prog.el));
      let pdf = null;
      try {
        // re-open with font names so bold / italic can be detected
        pdf = await openPdf(file.bytes, file.name, { fontExtraProperties: true });
        const n = pdf.numPages;
        const pages = [];
        let ocrPages = 0;
        for (let i = 1; i <= n && !cancelled; i++) {
          prog.set((0.9 * (i - 1)) / n, `Reading page ${i} of ${n}…`);
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale: 1 });
          const tc = await page.getTextContent();
          if (countTextChars(tc) >= 25) {
            // font styles (bold / italic) become available after parsing the page
            try {
              await page.getOperatorList();
            } catch {
              /* styles are optional */
            }
            const fontInfo = (name) => {
              try {
                return page.commonObjs.has(name) ? page.commonObjs.get(name) : null;
              } catch {
                return null;
              }
            };
            const lines = mergeRowFragments(layoutTextContent(tc, viewport).lines);
            pages.push({
              height: viewport.height,
              lines: lines.map((l) => ({
                runs: spacedRuns(l.boxes, (b) => {
                  const f = fontInfo(tc.items[b.index].fontName);
                  const nm = `${f?.name || ''} ${f?.fallbackName || ''}`;
                  return { bold: !!(f?.bold || f?.black || /bold|black|heavy|semibold/i.test(nm)), italic: !!(f?.italic || /italic|oblique/i.test(nm)) };
                }),
                x0: l.x0, x1: l.x1, y0: l.y0, y1: l.y1,
                size: median(l.boxes.map((b) => b.fontHeight)),
                column: l.column, separator: l.separator,
              })),
            });
          } else if (s.ocr) {
            if (!pool) {
              prog.text('Loading OCR engine…');
              pool = new OcrPool(1);
              await pool.init((t) => prog.text(t));
            }
            prog.text(`Recognising scanned page ${i}…`);
            const { canvas, ratio } = await renderToCanvas(page, (isMobile() ? 250 : 300) / 72, { annotationMode: AnnotationMode.DISABLE, maxPixels: isMobile() ? 7e6 : 14e6 });
            const blob = await canvasToBlob(canvas);
            const scale = (isMobile() ? 250 : 300) / 72 * ratio;
            const pageH = canvas.height;
            canvas.width = canvas.height = 0;
            const words = await pool.recognize(blob);
            const lines = mergeRowFragments(wordsToLines(words).lines);
            ocrPages++;
            pages.push({
              height: pageH,
              lines: lines.map((l) => ({
                runs: spacedRuns(l.boxes, () => ({ bold: false, italic: false })),
                x0: l.x0, x1: l.x1, y0: l.y0, y1: l.y1,
                size: (l.y1 - l.y0) * 0.85,
                column: l.column, separator: l.separator,
                scale,
              })),
            });
          } else {
            pages.push({ height: viewport.height, lines: [] });
          }
          page.cleanup();
        }
        if (cancelled) return;
        prog.set(0.93, 'Building paragraphs…');
        const paras = buildParagraphs(pages, { skipHeaders: s.skipHeaders });
        prog.set(0.96, 'Writing .docx…');
        const blob = await paragraphsToDocx(paras, { title: baseName(file.name), pageBreaks: s.pageBreaks });
        prog.set(1, 'Done');
        const words = paras.reduce((k, p) => k + p.paras.reduce((m, q) => m + q.runs.map((r) => r.text).join('').split(/\s+/).filter(Boolean).length, 0), 0);
        const name = `${baseName(file.name)}.docx`;
        result.replaceChildren(resultCard({
          title: 'Word document ready',
          text: `${n} page${n === 1 ? '' : 's'} · ~${words.toLocaleString()} words${ocrPages ? ` · ${ocrPages} scanned page${ocrPages === 1 ? '' : 's'} recognised` : ''} · ${formatBytes(blob.size)}`,
          actions: [button('Download .docx', { variant: 'primary', icon: 'download', onClick: () => downloadBlob(blob, name) })],
        }));
        result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (e) {
        console.error(e);
        result.replaceChildren(callout('error', errorText(e)));
      } finally {
        closePdf(pdf);
        runBtn.disabled = false;
        await pool?.terminate();
        pool = null;
      }
    }

    return () => {
      cancelled = true;
      pool?.terminate();
      closePdf(input.current?.pdf);
    };
  },
};

/** Line boxes → styled runs with spaces only where there is a visible gap. */
function spacedRuns(boxes, styleOf) {
  const runs = [];
  let prev = null;
  for (const b of boxes) {
    let t = b.text || '';
    if (prev) {
      const hgt = Math.min(prev.y1 - prev.y0, b.y1 - b.y0);
      const last = runs[runs.length - 1];
      if (!/\s$/.test(last.text) && !/^\s/.test(t) && b.x0 - prev.x1 > 0.15 * hgt) t = ` ${t}`;
    }
    const st = styleOf(b);
    runs.push({ text: t.replace(/\s+/g, ' '), ...st, x0: b.x0, x1: b.x1 });
    prev = b;
  }
  return runs;
}
