// Copies the heavy runtime assets (pdf.js data, OCR engine + model, font) into
// public/vendor so they are served from our own origin. Nothing is fetched from
// a CDN at runtime, which keeps CutePDF private and lets it work offline.
import { cpSync, mkdirSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const out = join(root, 'public', 'vendor');

if (existsSync(out)) rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const copyDir = (from, to) => cpSync(join(nm, from), join(out, to), { recursive: true });
const copyFile = (from, to) => {
  mkdirSync(dirname(join(out, to)), { recursive: true });
  copyFileSync(join(nm, from), join(out, to));
};

// pdf.js support data
copyDir('pdfjs-dist/cmaps', 'pdfjs/cmaps');
copyDir('pdfjs-dist/standard_fonts', 'pdfjs/standard_fonts');
copyDir('pdfjs-dist/wasm', 'pdfjs/wasm');
copyDir('pdfjs-dist/iccs', 'pdfjs/iccs');

// Tesseract (OCR): worker, LSTM-only WebAssembly cores, English model
copyFile('tesseract.js/dist/worker.min.js', 'tesseract/worker.min.js');
for (const v of ['tesseract-core-lstm', 'tesseract-core-simd-lstm', 'tesseract-core-relaxedsimd-lstm']) {
  copyFile(`tesseract.js-core/${v}.wasm.js`, `tesseract/core/${v}.wasm.js`);
}
copyFile('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'tesseract/lang/eng.traineddata.gz');

// Unicode font used for the invisible OCR text layer
copyFile('dejavu-fonts-ttf/ttf/DejaVuSans.ttf', 'fonts/DejaVuSans.ttf');

console.log('vendor assets copied to public/vendor');
