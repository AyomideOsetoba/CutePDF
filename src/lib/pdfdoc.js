// pdf-lib helpers (writing/modifying PDFs).
import { PDFDocument, PDFName, PDFArray, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib';

export async function loadPdfLib(bytes, opts = {}) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false, ...opts });
  } catch (e) {
    if (/encrypt/i.test(String(e?.message))) {
      const err = new Error('This PDF is encrypted (protected by its publisher or a password), so it can be read but not modified here.');
      err.encrypted = true;
      throw err;
    }
    throw new Error(`Could not read this PDF: ${e?.message || e}`);
  }
}

export function streamBytes(stream) {
  if (!stream) return new Uint8Array(0);
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  if (typeof stream.getUnencodedContents === 'function') return stream.getUnencodedContents();
  return stream.getContents();
}

/** Decoded, concatenated content stream bytes of a pdf-lib page. */
export function pageContentBytes(page) {
  const ctx = page.doc.context;
  const contents = page.node.get(PDFName.of('Contents'));
  const resolved = ctx.lookup(contents);
  const streams = [];
  if (resolved instanceof PDFArray) {
    for (let i = 0; i < resolved.size(); i++) streams.push(ctx.lookup(resolved.get(i)));
  } else if (resolved) {
    streams.push(resolved);
  }
  const parts = streams.map((s) => streamBytes(s));
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
    out[off++] = 10;
  }
  return out;
}

/** Replace a page's content with the given (unencoded) bytes, Flate-compressed. */
export function setPageContentBytes(page, bytes) {
  const ctx = page.doc.context;
  const stream = ctx.flateStream(bytes);
  const ref = ctx.register(stream);
  page.node.set(PDFName.of('Contents'), ctx.obj([ref]));
}

export function refFromPdfjsId(id) {
  // pdf.js annotation ids look like "12R" or "12R3" (num R gen)
  const m = /^(\d+)R(\d*)$/.exec(String(id || ''));
  if (!m) return null;
  return PDFRef.of(parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 0);
}

export async function saveDoc(doc) {
  return doc.save({ useObjectStreams: true, addDefaultPage: false });
}
