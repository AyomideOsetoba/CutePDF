// OCR with Tesseract (WebAssembly) — runs in Web Workers inside this tab.
// The engine and English model are served from our own origin (public/vendor).
import { createWorker } from 'tesseract.js';
import { analyzeLayout, median } from './layout.js';

const vendor = (p) => new URL(`vendor/tesseract/${p}`, document.baseURI).href;

export function suggestedWorkers() {
  const cores = navigator.hardwareConcurrency || 2;
  const mem = navigator.deviceMemory || 4;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (mobile || mem <= 2) return 1;
  return Math.max(1, Math.min(3, Math.floor(cores / 2), Math.floor(mem / 2)));
}

export class OcrPool {
  constructor(size = suggestedWorkers()) {
    this.size = size;
    this.workers = [];
    this.free = [];
    this.waiters = [];
  }

  async init(onStatus) {
    let loaded = 0;
    const make = async () => {
      const w = await createWorker('eng', 1, {
        workerPath: vendor('worker.min.js'),
        corePath: vendor('core/'),
        langPath: vendor('lang'),
        workerBlobURL: false,
        gzip: true,
        cacheMethod: 'none', // the service worker already caches the model
        logger: (m) => {
          if (m.status && /load/i.test(m.status)) onStatus?.(m.status, m.progress);
        },
      });
      await w.setParameters({
        tessedit_pageseg_mode: '3', // fully automatic page segmentation
        user_defined_dpi: '300',
        preserve_interword_spaces: '0',
      });
      loaded++;
      onStatus?.(`OCR engine ready (${loaded}/${this.size})`, 1);
      return w;
    };
    // first worker alone (downloads/compiles the engine once), the rest in parallel
    try {
      const first = await make();
      const rest = await Promise.all(Array.from({ length: this.size - 1 }, make));
      this.workers = [first, ...rest];
    } catch (e) {
      throw new Error(navigator.onLine
        ? `Could not start the OCR engine (${e?.message || e}).`
        : 'The OCR engine (about 8 MB) is downloaded the first time you use OCR. Connect to the internet once and run OCR; after that it also works offline.');
    }
    this.free = [...this.workers];
  }

  async acquire() {
    if (this.free.length) return this.free.pop();
    return new Promise((r) => this.waiters.push(r));
  }

  release(w) {
    const next = this.waiters.shift();
    if (next) next(w);
    else this.free.push(w);
  }

  /** OCR an image (canvas/Blob). Returns words in image pixel coordinates. */
  async recognize(image) {
    const w = await this.acquire();
    try {
      const { data } = await w.recognize(image, {}, { text: false, tsv: true });
      return parseTsv(data.tsv || '');
    } finally {
      this.release(w);
    }
  }

  async terminate() {
    await Promise.all(this.workers.map((w) => w.terminate().catch(() => {})));
    this.workers = [];
    this.free = [];
  }
}

/** Tesseract TSV → words. Level 5 rows are words. */
export function parseTsv(tsv) {
  const words = [];
  for (const line of tsv.split('\n')) {
    const c = line.split('\t');
    if (c.length < 12 || c[0] !== '5') continue;
    const text = c.slice(11).join('\t').trim();
    const conf = parseFloat(c[10]);
    if (!text || conf < 0) continue;
    const left = +c[6];
    const top = +c[7];
    const width = +c[8];
    const height = +c[9];
    if (!(width > 0 && height > 0)) continue;
    words.push({
      x0: left,
      y0: top,
      x1: left + width,
      y1: top + height,
      text,
      conf,
      block: +c[2],
      par: +c[3],
      line: +c[4],
    });
  }
  return words;
}

/**
 * Turn OCR words into reading-ordered lines (column-aware).
 * Low-confidence noise (specks recognised as punctuation) is dropped.
 */
export function wordsToLines(words) {
  const clean = words.filter((w) => !(w.conf < 25 && w.text.length <= 2 && /^[^\p{L}\p{N}]+$/u.test(w.text)));
  if (!clean.length) return { lines: [], columns: 1 };
  const unit = median(clean.map((w) => w.y1 - w.y0));
  const res = analyzeLayout(clean, { unit, gapFactor: 1.3, minGutterFactor: 0.9 });
  return res;
}
