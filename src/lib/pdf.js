// pdf.js setup. We use the "legacy" build so CutePDF also runs on older phones
// and tablets. All support files are served from our own origin.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { promptPassword } from './ui.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
export const { AnnotationMode, AnnotationType, TextLayer, Util, OPS } = pdfjs;

const vendor = (p) => new URL(`vendor/pdfjs/${p}`, document.baseURI).href;

/**
 * Open a PDF with pdf.js. `bytes` is copied, because pdf.js transfers the
 * buffer to its worker and we usually still need the original.
 */
export async function openPdf(bytes, name = 'document.pdf', { fontExtraProperties = false } = {}) {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    cMapUrl: vendor('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: vendor('standard_fonts/'),
    wasmUrl: vendor('wasm/'),
    iccUrl: vendor('iccs/'),
    isEvalSupported: false,
    enableXfa: false,
    useSystemFonts: false,
    fontExtraProperties,
  });
  let cancelled = false;
  task.onPassword = async (update, reason) => {
    const pw = await promptPassword(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? `${name}” (wrong password, try again)“` : name);
    if (pw == null) {
      cancelled = true;
      task.destroy();
    } else update(pw);
  };
  try {
    return await task.promise;
  } catch (e) {
    if (cancelled) throw new Error('Password required to open this PDF.');
    if (e?.name === 'InvalidPDFException') throw new Error('This file does not look like a valid PDF.');
    throw e;
  }
}

/** Render a page into a new canvas at the given CSS scale (respecting devicePixelRatio if hiDpi). */
export async function renderToCanvas(page, scale, { hiDpi = false, annotationMode = AnnotationMode.ENABLE, background, maxPixels = 16e6 } = {}) {
  const viewport = page.getViewport({ scale });
  let ratio = hiDpi ? Math.min(window.devicePixelRatio || 1, 3) : 1;
  const px = viewport.width * viewport.height * ratio * ratio;
  if (px > maxPixels) ratio *= Math.sqrt(maxPixels / px);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
  canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = background || '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const task = page.render({
    canvasContext: ctx,
    canvas,
    viewport,
    transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null,
    annotationMode,
    background: background || 'rgb(255,255,255)',
  });
  await task.promise;
  return { canvas, viewport, ratio };
}

/** Small thumbnail canvas for page `n` (1-based). */
/**
 * Run thumbnail renders a couple at a time. Rendering even a tiny thumbnail
 * decodes the page's full-resolution scan, so doing 20 at once (as soon as a
 * page grid scrolls into view) would briefly need 20 × ~35 MB.
 */
const thumbJobs = [];
let thumbActive = 0;
export function queueThumb(fn) {
  return new Promise((resolve, reject) => {
    thumbJobs.push({ fn, resolve, reject });
    pumpThumbs();
  });
}
function pumpThumbs() {
  while (thumbActive < 2 && thumbJobs.length) {
    const { fn, resolve, reject } = thumbJobs.shift();
    thumbActive++;
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        thumbActive--;
        pumpThumbs();
      });
  }
}

export function renderThumb(pdf, n, maxSize = 220) {
  return queueThumb(() => renderThumbNow(pdf, n, maxSize));
}

async function renderThumbNow(pdf, n, maxSize) {
  const page = await pdf.getPage(n);
  const v = page.getViewport({ scale: 1 });
  const scale = Math.min(maxSize / v.width, maxSize / v.height) * Math.min(window.devicePixelRatio || 1, 2);
  const { canvas } = await renderToCanvas(page, scale, { annotationMode: AnnotationMode.DISABLE });
  page.cleanup();
  const img = await canvasToImage(canvas);
  img.style.aspectRatio = `${v.width} / ${v.height}`;
  return img;
}

/**
 * Turn a canvas into a small JPEG <img> and free the canvas. A thumbnail
 * canvas holds ~0.5 MB of raw pixels; the JPEG is ~20 KB, which matters on
 * phones when a document has hundreds of pages. Call releaseImage() when done.
 */
export async function canvasToImage(canvas, quality = 0.82) {
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  const img = new Image();
  img.decoding = 'async';
  img.alt = '';
  if (blob) {
    img.src = URL.createObjectURL(blob);
    img.dataset.blobUrl = img.src;
  }
  canvas.width = canvas.height = 0;
  return img;
}

export function releaseImage(img) {
  if (img?.dataset?.blobUrl) URL.revokeObjectURL(img.dataset.blobUrl);
}

/**
 * Text items of a page as layout boxes in viewport (top-down) coordinates at scale 1.
 * Each box keeps a reference to its source item index.
 */
export function textItemsToBoxes(textContent, viewport) {
  const boxes = [];
  textContent.items.forEach((item, index) => {
    if (item.str === undefined || item.str === '') return;
    const tx = Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    const angle = Math.atan2(tx[1], tx[0]);
    const w = (item.width || 0) * viewport.scale;
    let x0, x1, y0, y1;
    if (Math.abs(angle) < 0.05) {
      x0 = tx[4];
      x1 = tx[4] + w;
      y0 = tx[5] - fontHeight * 0.8;
      y1 = tx[5] + fontHeight * 0.2;
    } else {
      // rotated text: use its axis-aligned bounding box
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const pts = [
        [0, 0], [w, 0], [0, -fontHeight * 0.8], [w, -fontHeight * 0.8],
      ].map(([px, py]) => [tx[4] + px * cos - py * sin, tx[5] + px * sin + py * cos]);
      x0 = Math.min(...pts.map((p) => p[0]));
      x1 = Math.max(...pts.map((p) => p[0]));
      y0 = Math.min(...pts.map((p) => p[1]));
      y1 = Math.max(...pts.map((p) => p[1]));
    }
    if (x1 - x0 < 0.01) x1 = x0 + Math.max(fontHeight * 0.25 * item.str.length, 0.5);
    if (y1 - y0 < 0.01) y1 = y0 + 1;
    boxes.push({ x0, y0, x1, y1, text: item.str, index, fontHeight, rotated: Math.abs(angle) >= 0.05 });
  });
  return boxes;
}

export function countTextChars(textContent) {
  let n = 0;
  for (const it of textContent.items) if (it.str) n += it.str.replace(/\s+/g, '').length;
  return n;
}

export function isEncryptedError(e) {
  return /encrypt/i.test(String(e?.message || e));
}

/** Close a pdf.js document and free its worker (pdf.js 6: via the loading task). */
export function closePdf(pdf) {
  try {
    pdf?.loadingTask?.destroy();
  } catch {
    /* already closed */
  }
}
