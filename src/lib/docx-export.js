// PDF → Word: column-aware text, paragraphs, headings and bold/italic.
import { Document, Packer, Paragraph, TextRun, HeadingLevel, PageBreak } from 'docx';
import { median } from './layout.js';

/**
 * A "line" here: { runs: [{ text, bold, italic, x0, x1 }], x0, x1, y0, y1, size, column, separator }
 * in top-down page coordinates (any unit, consistent per page), plus page height.
 */
export function buildParagraphs(pages, { skipHeaders = true } = {}) {
  const allSizes = [];
  for (const pg of pages) for (const l of pg.lines) {
    const n = l.runs.reduce((k, r) => k + r.text.length, 0);
    for (let i = 0; i < Math.min(n, 200); i += 10) allSizes.push(l.size);
  }
  const body = median(allSizes) || 10;
  const out = [];
  pages.forEach((pg, pi) => {
    const lines = pg.lines.filter((l) => l.runs.some((r) => r.text.trim()));
    // column extents
    const colRight = new Map();
    const colLeft = new Map();
    for (const l of lines) {
      const c = l.separator ? -1 : l.column ?? 0;
      colRight.set(c, Math.max(colRight.get(c) ?? -Infinity, l.x1));
      colLeft.set(c, Math.min(colLeft.get(c) ?? Infinity, l.x0));
    }
    const paras = [];
    let cur = null;
    let prev = null;
    for (const l of lines) {
      const text = l.runs.map((r) => r.text).join('').trim();
      if (skipHeaders && pg.height) {
        const top = l.y1 < pg.height * 0.07;
        const bottom = l.y0 > pg.height * 0.93;
        const words = text.split(/\s+/).length;
        if ((top || bottom) && words <= 14) continue;
        if (/^\d{1,4}$/.test(text) && (l.y0 > pg.height * 0.85 || l.y1 < pg.height * 0.15)) continue;
      }
      const ratio = l.size / body;
      const allBold = l.runs.every((r) => !r.text.trim() || r.bold);
      const c = l.separator ? -1 : l.column ?? 0;
      const width = (colRight.get(c) ?? l.x1) - (colLeft.get(c) ?? l.x0);
      let heading = 0;
      if (ratio >= 1.6) heading = 1;
      else if (ratio >= 1.3) heading = 2;
      else if (ratio >= 1.12 && text.length < 120) heading = 3;
      else if (allBold && text.length < 90 && /^([0-9IVX]+(\.[0-9]+)*[.)]?\s+)?[A-Z]/.test(text) && /[A-Za-z]{2}/.test(text) && l.x1 - l.x0 < width * 0.75 && !/[.,;:]$/.test(text)) heading = 3;
      if (heading) {
        // multi-line headings (e.g. a two-line title) stay together
        if (cur?.heading === heading && prev && l.y0 - prev.y1 < l.size * 0.9 && Math.abs(l.size - prev.size) < 0.1 * l.size) {
          appendRuns(cur, l.runs);
        } else {
          cur = { heading, runs: [] };
          appendRuns(cur, l.runs);
          paras.push(cur);
        }
        prev = l;
        continue;
      }
      let join = false;
      if (cur && !cur.heading && prev) {
        // the short last line of a full-width block (e.g. an abstract) belongs to it
        const sameCol = (prev.separator ? -1 : prev.column ?? 0) === c || (prev.separator && Math.abs(l.x0 - prev.x0) < l.size);
        const gap = l.y0 - prev.y1;
        const similar = Math.abs(l.size - prev.size) < 0.15 * Math.max(l.size, prev.size);
        const prevText = prev.runs.map((r) => r.text).join('').trim();
        const pc = prev.separator ? -1 : prev.column ?? 0;
        const prevShort = prev.x1 < (colRight.get(pc) ?? prev.x1) - 2.5 * prev.size;
        const indented = l.x0 > (colLeft.get(c) ?? l.x0) + 0.8 * l.size && prev.x0 <= (colLeft.get(c) ?? prev.x0) + 0.4 * l.size;
        const text0 = text.charAt(0);
        const endsSentence = /[.?!:]["”’)\]]?$/.test(prevText);
        const startsNew = /[A-Z0-9[(“"•\u2022-]/.test(text0);
        join = sameCol && similar && gap > -0.5 * l.size && gap < 0.75 * l.size && !(prevShort && (endsSentence || startsNew)) && !indented;
        // a paragraph that runs from the bottom of one column to the top of the next
        if (!join && c === pc + 1 && c > 0 && similar && !prevShort && !endsSentence && !indented && l.y0 < prev.y0) join = true;
      }
      if (join) appendRuns(cur, l.runs, true);
      else {
        cur = { heading: 0, runs: [] };
        appendRuns(cur, l.runs);
        paras.push(cur);
      }
      prev = l;
    }
    out.push({ page: pi, paras });
  });
  return out;
}

function appendRuns(para, runs, newLine = false) {
  const last = para.runs[para.runs.length - 1];
  if (newLine && last) {
    // de-hyphenate "exam-\nple" → "example"
    const firstText = runs.find((r) => r.text.trim())?.text.trimStart() || '';
    if (/[A-Za-z]-$/.test(last.text) && /^[a-z]/.test(firstText)) last.text = last.text.slice(0, -1);
    else if (!/\s$/.test(last.text)) last.text += ' ';
  }
  for (const r of runs) {
    const prevRun = para.runs[para.runs.length - 1];
    const text = para.runs.length === 0 ? r.text.trimStart() : r.text;
    if (prevRun && prevRun.bold === r.bold && prevRun.italic === r.italic) prevRun.text += text;
    else para.runs.push({ text, bold: r.bold, italic: r.italic });
  }
}

function paraText(p) {
  return p.runs.map((r) => r.text).join('').trim();
}

/** Join a paragraph that continues from the end of one page onto the next. */
function joinAcrossPages(pages) {
  for (let i = 1; i < pages.length; i++) {
    const prevPage = pages.slice(0, i).reverse().find((pg) => pg.paras.length);
    const last = prevPage?.paras[prevPage.paras.length - 1];
    const first = pages[i].paras[0];
    if (!last || !first || last.heading || first.heading) continue;
    if (/[.?!:]["”’)\]]?$/.test(paraText(last))) continue;
    appendRuns(last, first.runs, true);
    pages[i].paras.shift();
  }
  return pages;
}

export async function paragraphsToDocx(pages, { title, pageBreaks = false } = {}) {
  if (!pageBreaks) pages = joinAcrossPages(pages);
  const children = [];
  pages.forEach(({ paras }, i) => {
    if (i > 0 && pageBreaks) children.push(new Paragraph({ children: [new PageBreak()] }));
    for (const p of paras) {
      const runs = p.runs
        .map((r, k) => ({ ...r, text: k === p.runs.length - 1 ? r.text.trimEnd() : r.text }))
        .filter((r) => r.text)
        .map((r) => new TextRun({ text: r.text.replace(/\s+/g, ' '), bold: r.bold || undefined, italics: r.italic || undefined }));
      if (!runs.length) continue;
      children.push(new Paragraph({
        children: runs,
        heading: p.heading === 1 ? HeadingLevel.HEADING_1 : p.heading === 2 ? HeadingLevel.HEADING_2 : p.heading === 3 ? HeadingLevel.HEADING_3 : undefined,
        spacing: p.heading ? { before: 240, after: 120 } : { after: 160, line: 276 },
      }));
    }
  });
  const doc = new Document({
    creator: 'CutePDF',
    title: title || 'Document',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children }],
  });
  return Packer.toBlob(doc);
}
