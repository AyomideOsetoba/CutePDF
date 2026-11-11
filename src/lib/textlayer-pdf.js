// Writes an invisible (render mode 3) text layer into a PDF page, one text
// line per OCR line fragment, in column-aware reading order. Every word is
// positioned and horizontally scaled to its exact box, so selection in any
// viewer (Acrobat, Edge, Chrome, Preview, pdf.js) hugs the words and follows
// the columns instead of running across the page.
import {
  beginText, endText, setFontAndSize, setTextRenderingMode, TextRenderingMode, setTextMatrix, setCharacterSqueeze,
  showText, pushGraphicsState, popGraphicsState,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

let fontBytes = null;
async function loadFontBytes() {
  if (!fontBytes) {
    fontBytes = fetch(new URL('vendor/fonts/DejaVuSans.ttf', document.baseURI)).then((r) => {
      if (!r.ok) throw new Error('Could not load the text-layer font');
      return r.arrayBuffer();
    });
  }
  return fontBytes;
}

export async function embedTextLayerFont(doc) {
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(await loadFontBytes(), { subset: true });
  // DejaVu Sans vertical metrics (units of em)
  const asc = 0.928;
  const desc = 0.236;
  return { font, asc, desc };
}

// Characters a viewer can't map are replaced rather than dropped silently
function sanitize(text) {
  return text.replace(/[\u0000-\u001f\u007f]/g, '').normalize('NFC');
}

/**
 * @param page    pdf-lib PDFPage
 * @param lines   reading-ordered lines from analyzeLayout(): { boxes:[{x0,y0,x1,y1,text}], rowEnd }
 * @param map     { toPdf(x, y) -> [X, Y], scale: points per image pixel, angle: text direction in degrees }
 * @param fontInfo result of embedTextLayerFont
 */
export function writeInvisibleText(page, lines, map, fontInfo) {
  const { font, asc, desc } = fontInfo;
  const key = page.node.newFontDictionary('CutePDFOcr', font.ref);
  const rad = ((map.angle || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];
  let lastSize = -1;
  let lastTz = -1;
  for (const line of lines) {
    const words = line.boxes.filter((w) => w.text && w.text.trim());
    if (!words.length) continue;
    // line box: use the word boxes (robust to stray tall symbols)
    const tops = words.map((w) => w.y0).sort((a, b) => a - b);
    const bottoms = words.map((w) => w.y1).sort((a, b) => a - b);
    const y0 = tops[Math.floor(tops.length * 0.2)];
    const y1 = bottoms[Math.ceil(bottoms.length * 0.8) - 1] ?? bottoms[bottoms.length - 1];
    const linePx = Math.max(y1 - y0, 2);
    const sizePx = linePx / (asc + desc);
    const size = Math.max(sizePx * map.scale, 0.5);
    const baselinePx = y0 + asc * sizePx;
    if (Math.abs(size - lastSize) > 0.01) {
      ops.push(setFontAndSize(key, round(size)));
      lastSize = size;
    }
    words.forEach((w, i) => {
      const last = i === words.length - 1;
      const text = sanitize(w.text) + (last ? '' : ' ');
      if (!text.trim()) return;
      const targetPx = last ? w.x1 - w.x0 : Math.max(words[i + 1].x0 - w.x0, w.x1 - w.x0);
      const natural = font.widthOfTextAtSize(text, size);
      let tz = natural > 0 ? ((targetPx * map.scale) / natural) * 100 : 100;
      tz = Math.min(Math.max(tz, 5), 2000);
      if (Math.abs(tz - lastTz) > 0.05) {
        ops.push(setCharacterSqueeze(round(tz)));
        lastTz = tz;
      }
      const [X, Y] = map.toPdf(w.x0, baselinePx);
      ops.push(setTextMatrix(round(cos), round(sin), round(-sin), round(cos), round(X), round(Y)));
      ops.push(showText(font.encodeText(text)));
    });
  }
  ops.push(endText(), popGraphicsState());
  page.pushOperators(...ops);
}

const round = (n) => Math.round(n * 1000) / 1000;

/**
 * Build the image-px → PDF user-space mapping for a page rendered by pdf.js
 * with `viewport` (any scale/rotation). `pdfPageView` is the pdf.js viewport.
 */
export function viewportMapping(viewport, pxPerViewportUnit = 1) {
  const toPdf = (x, y) => viewport.convertToPdfPoint(x / pxPerViewportUnit, y / pxPerViewportUnit);
  // direction of "rightwards on screen" in PDF user space (handles /Rotate)
  const [ax, ay] = toPdf(0, 0);
  const [bx, by] = toPdf(100, 0);
  return {
    toPdf,
    scale: 1 / (viewport.scale * pxPerViewportUnit),
    angle: (Math.atan2(by - ay, bx - ax) * 180) / Math.PI,
  };
}
