// Column-aware ordering for text that already exists in a PDF (born-digital papers).
import { analyzeLayout, median, linesToText } from './layout.js';
import { textItemsToBoxes } from './pdf.js';

const isBlank = (s) => !s || !s.trim();

export function layoutTextContent(textContent, viewport) {
  const all = textItemsToBoxes(textContent, viewport);
  // Whitespace-only items (pdf.js synthesises them for gaps) are left out of the
  // analysis: a single space item can span a whole column gutter.
  const boxes = all.filter((b) => !isBlank(b.text));
  const flat = boxes.filter((b) => !b.rotated);
  const unit = median(flat.map((b) => b.fontHeight)) || 10;
  const res = analyzeLayout(flat, { unit, gapFactor: 1.0, minGutterFactor: 0.8 });
  const rotated = boxes.filter((b) => b.rotated);
  return { ...res, rotated, boxes, unit };
}

/**
 * Re-order pdf.js text items so that the DOM text layer (and therefore
 * selection and copy) follows the columns. Returns the original object when
 * the page is single-column.
 */
export function columnOrderedTextContent(textContent, viewport) {
  const { lines, columns, rotated } = layoutTextContent(textContent, viewport);
  if (columns < 2) return { textContent, columns: 1 };
  const src = textContent.items;
  // whitespace items travel with the text item they follow in the file
  const trailing = new Map();
  let lastText = -1;
  const leading = [];
  src.forEach((it, i) => {
    if (it.str === undefined) return;
    if (isBlank(it.str)) {
      if (it.str === '') return; // pure EOL markers are regenerated below
      if (lastText < 0) leading.push(i);
      else trailing.get(lastText).push(i);
    } else {
      lastText = i;
      trailing.set(i, []);
    }
  });
  const items = leading.map((i) => ({ ...src[i], hasEOL: false }));
  const used = new Set();
  const push = (i) => {
    items.push({ ...src[i], hasEOL: false });
    used.add(i);
    for (const w of trailing.get(i) || []) {
      items.push({ ...src[w], hasEOL: false });
      used.add(w);
    }
  };
  for (const line of lines) {
    for (const b of line.boxes) push(b.index);
    if (items.length) items[items.length - 1].hasEOL = line.rowEnd !== false;
  }
  for (const b of rotated) if (!used.has(b.index)) push(b.index);
  return { textContent: { ...textContent, items }, columns };
}

/** Plain text of a page in reading order. */
export async function pageText(page) {
  const viewport = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const { lines, rotated } = layoutTextContent(tc, viewport);
  let text = linesToText(lines);
  if (rotated.length) text += `${rotated.map((b) => b.text).join(' ')}\n`;
  return text;
}
