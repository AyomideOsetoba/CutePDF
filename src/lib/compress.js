// In-browser PDF compression.
//
// Text, fonts and vector drawings are kept exactly as they are. The savings
// come from:
//   1. re-encoding embedded images (JPEG), downsampled to a target resolution
//      based on how large each image is actually drawn on the page,
//   2. dropping unused objects and storing the rest in compressed object streams,
//   3. optionally removing metadata / embedded page thumbnails.
import { PDFName, PDFDict, PDFArray, PDFRawStream, PDFRef, PDFStream, PDFNumber, decodePDFRawStream } from 'pdf-lib';
import { loadPdfLib, streamBytes } from './pdfdoc.js';
import { walkDo } from './contentstream.js';

export const PRESETS = {
  light: { dpi: 220, quality: 0.85, label: 'Light', hint: 'Best quality, smaller savings' },
  balanced: { dpi: 150, quality: 0.72, label: 'Recommended', hint: 'Great for reading and sharing' },
  strong: { dpi: 100, quality: 0.55, label: 'Strong', hint: 'Smallest file, for screens only' },
};

const N = (s) => PDFName.of(s);

function nameOf(obj) {
  return obj instanceof PDFName ? obj.decodeText?.() ?? obj.asString().slice(1) : null;
}

/** Collect, for every image XObject, the largest size (in points) it is drawn at. */
function measureImageUse(doc) {
  const ctx = doc.context;
  const use = new Map(); // refKey -> { w, h }
  const seenForms = new Set();
  const key = (ref) => `${ref.objectNumber} ${ref.generationNumber}`;

  const visit = (bytes, resources, ctm, depth) => {
    if (!bytes || depth > 8) return;
    const xobjects = resources?.lookupMaybe?.(N('XObject'), PDFDict);
    walkDo(bytes, ctm, (name, m) => {
      const ref = xobjects?.get(N(name));
      if (!(ref instanceof PDFRef)) return;
      const obj = ctx.lookup(ref);
      if (!(obj instanceof PDFStream)) return;
      const sub = nameOf(obj.dict.get(N('Subtype')));
      if (sub === 'Image') {
        const w = Math.hypot(m[0], m[1]);
        const hgt = Math.hypot(m[2], m[3]);
        const k = key(ref);
        const prev = use.get(k);
        use.set(k, { w: Math.max(prev?.w || 0, w), h: Math.max(prev?.h || 0, hgt) });
      } else if (sub === 'Form') {
        const fk = `${key(ref)}@${m.map((v) => v.toFixed(2)).join(',')}`;
        if (seenForms.has(fk)) return;
        seenForms.add(fk);
        const matrix = obj.dict.lookupMaybe(N('Matrix'), PDFArray);
        let fm = m;
        if (matrix && matrix.size() === 6) {
          const v = matrix.asArray().map((x) => (x instanceof PDFNumber ? x.asNumber() : 0));
          fm = [
            v[0] * m[0] + v[1] * m[2], v[0] * m[1] + v[1] * m[3],
            v[2] * m[0] + v[3] * m[2], v[2] * m[1] + v[3] * m[3],
            v[4] * m[0] + v[5] * m[2] + m[4], v[4] * m[1] + v[5] * m[3] + m[5],
          ];
        }
        let body = null;
        try {
          body = streamBytes(obj);
        } catch {
          return;
        }
        const res = obj.dict.lookupMaybe(N('Resources'), PDFDict) || resources;
        visit(body, res, fm, depth + 1);
      }
    });
  };

  for (const page of doc.getPages()) {
    let bytes = null;
    try {
      const contents = page.node.get(N('Contents'));
      const resolved = ctx.lookup(contents);
      const parts = [];
      if (resolved instanceof PDFArray) for (let i = 0; i < resolved.size(); i++) parts.push(streamBytes(ctx.lookup(resolved.get(i))));
      else if (resolved) parts.push(streamBytes(resolved));
      const total = parts.reduce((n, p) => n + p.length + 1, 0);
      bytes = new Uint8Array(total);
      let off = 0;
      for (const p of parts) {
        bytes.set(p, off);
        off += p.length + 1;
        bytes[off - 1] = 10;
      }
    } catch {
      continue;
    }
    const resources = ctx.lookup(page.node.getInheritableAttribute(N('Resources')));
    visit(bytes, resources instanceof PDFDict ? resources : null, [1, 0, 0, 1, 0, 0], 0);
  }
  return use;
}

function colorComponents(ctx, cs) {
  const obj = ctx.lookup(cs);
  const n = nameOf(obj);
  if (n === 'DeviceRGB' || n === 'CalRGB') return 3;
  if (n === 'DeviceGray' || n === 'CalGray') return 1;
  if (n === 'DeviceCMYK') return 4;
  if (obj instanceof PDFArray) {
    const kind = nameOf(obj.get(0));
    if (kind === 'ICCBased') {
      const stream = ctx.lookup(obj.get(1));
      const nn = stream?.dict?.lookupMaybe?.(N('N'), PDFNumber)?.asNumber();
      return nn || null;
    }
    if (kind === 'CalRGB') return 3;
    if (kind === 'CalGray') return 1;
  }
  return null; // Indexed, Separation, DeviceN, Lab… left alone
}

function pngUnpredict(data, width, height, colors, predictor) {
  if (predictor < 10) return predictor === 1 ? data : null;
  const bpp = colors;
  const rowLen = width * colors;
  const out = new Uint8Array(rowLen * height);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = data[src++];
    const row = y * rowLen;
    const prev = row - rowLen;
    for (let x = 0; x < rowLen; x++) {
      const raw = data[src++] ?? 0;
      const a = x >= bpp ? out[row + x - bpp] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = x >= bpp && y > 0 ? out[prev + x - bpp] : 0;
      let v;
      switch (filter) {
        case 0: v = raw; break;
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: return null;
      }
      out[row + x] = v & 255;
    }
  }
  return out;
}

function makeCanvas(w, hgt) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, hgt);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hgt;
  return c;
}

async function canvasJpeg(canvas, quality) {
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: 'image/jpeg', quality })
    : await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/jpeg', quality));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Decode an image XObject into something drawable, or null when unsupported. */
async function decodeImage(ctx, stream) {
  const d = stream.dict;
  if (d.get(N('ImageMask'))?.toString() === 'true') return null;
  if (d.get(N('Mask'))) return null; // colour-key or stencil masks: leave alone
  if (d.get(N('Decode'))) return null;
  const width = d.lookupMaybe(N('Width'), PDFNumber)?.asNumber();
  const height = d.lookupMaybe(N('Height'), PDFNumber)?.asNumber();
  const bpc = d.lookupMaybe(N('BitsPerComponent'), PDFNumber)?.asNumber();
  if (!width || !height) return null;
  const comps = colorComponents(ctx, d.get(N('ColorSpace')));
  if (comps !== 1 && comps !== 3) return null;
  const fl = d.lookup(N('Filter'));
  const filters = fl instanceof PDFArray ? fl.asArray().map((x) => nameOf(ctx.lookup(x))) : fl ? [nameOf(fl)] : [];
  const f = { DCT: 'DCTDecode', Fl: 'FlateDecode' }[filters[filters.length - 1]] || filters[filters.length - 1];
  const pre = filters.slice(0, -1);
  // leading text/compression wrappers (e.g. [/ASCII85Decode /DCTDecode]) are unwrapped first
  if (pre.some((x) => !['ASCII85Decode', 'A85', 'ASCIIHexDecode', 'AHx', 'FlateDecode', 'Fl'].includes(x))) return null;
  if (!(stream instanceof PDFRawStream)) return null;
  if (f === 'DCTDecode') {
    let jpeg = stream.contents;
    if (pre.length) {
      const dict = d.clone(ctx);
      dict.set(N('Filter'), ctx.obj(pre));
      dict.delete(N('DecodeParms'));
      try {
        jpeg = decodePDFRawStream(PDFRawStream.of(dict, stream.contents)).decode();
      } catch {
        return null;
      }
    }
    try {
      const bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
      return { source: bmp, width: bmp.width, height: bmp.height, comps, kind: 'jpeg' };
    } catch {
      return null;
    }
  }
  if (f === 'FlateDecode' && bpc === 8) {
    let raw;
    try {
      raw = decodePDFRawStream(stream).decode();
    } catch {
      return null;
    }
    let parms = d.lookup(N('DecodeParms'));
    if (parms instanceof PDFArray) parms = parms.lookup(parms.size() - 1);
    const predictor = parms instanceof PDFDict ? parms.lookupMaybe(N('Predictor'), PDFNumber)?.asNumber() || 1 : 1;
    const pixels = predictor > 1 ? pngUnpredict(raw, width, height, comps, predictor) : raw;
    if (!pixels || pixels.length < width * height * comps) return null;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, j = 0; i < width * height; i++, j += comps) {
      const o = i * 4;
      if (comps === 1) {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = pixels[j];
      } else {
        rgba[o] = pixels[j];
        rgba[o + 1] = pixels[j + 1];
        rgba[o + 2] = pixels[j + 2];
      }
      rgba[o + 3] = 255;
    }
    const c = makeCanvas(width, height);
    c.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
    return { source: c, width, height, comps, kind: 'flate' };
  }
  return null;
}

/** Fraction of nearly-flat colours: line art / screenshots compress badly as JPEG. */
function looksLikeLineArt(canvas, w, hgt) {
  const sw = Math.min(64, w);
  const sh = Math.min(64, hgt);
  const c = makeCanvas(sw, sh);
  const g = c.getContext('2d');
  g.drawImage(canvas, 0, 0, sw, sh);
  const data = g.getImageData(0, 0, sw, sh).data;
  const counts = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const k = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return counts.size < 24;
}

function garbageCollect(doc) {
  const ctx = doc.context;
  const reachable = new Set();
  const stack = [];
  const push = (o) => {
    if (o) stack.push(o);
  };
  push(ctx.trailerInfo.Root);
  push(ctx.trailerInfo.Info);
  push(ctx.trailerInfo.Encrypt);
  while (stack.length) {
    const o = stack.pop();
    if (o instanceof PDFRef) {
      const k = o.tag;
      if (reachable.has(k)) continue;
      reachable.add(k);
      push(ctx.lookup(o));
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) push(v);
    } else if (o instanceof PDFArray) {
      for (const v of o.asArray()) push(v);
    } else if (o instanceof PDFStream) {
      push(o.dict);
    }
  }
  let removed = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!reachable.has(ref.tag)) {
      ctx.delete(ref);
      removed++;
    }
  }
  return removed;
}

/**
 * @returns { bytes, stats: { images, recompressed, removedObjects } }
 */
export async function compressPdf(input, { dpi, quality, stripMetadata = false }, onProgress = () => {}) {
  const doc = await loadPdfLib(input);
  const ctx = doc.context;
  onProgress(0.03, 'Measuring images…');
  const use = measureImageUse(doc);
  const pageMax = Math.max(...doc.getPages().map((p) => Math.max(p.getWidth(), p.getHeight())), 842);

  const images = [];
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream && nameOf(obj.dict.get(N('Subtype'))) === 'Image') images.push([ref, obj]);
  }
  let recompressed = 0;
  let saved = 0;
  for (let i = 0; i < images.length; i++) {
    const [ref, stream] = images[i];
    onProgress(0.05 + (0.85 * i) / Math.max(1, images.length), `Optimising image ${i + 1} of ${images.length}…`);
    // let the UI breathe
    if (i % 3 === 0) await new Promise((r) => setTimeout(r, 0));
    const original = stream instanceof PDFRawStream ? stream.contents.length : 0;
    if (original < 12 * 1024) continue; // tiny images are not worth it
    let img;
    try {
      img = await decodeImage(ctx, stream);
    } catch {
      img = null;
    }
    if (!img) continue;
    const drawn = use.get(`${ref.objectNumber} ${ref.generationNumber}`);
    // target pixel size from the drawn size (or the page size when unknown)
    const wPt = drawn?.w || pageMax;
    const hPt = drawn?.h || pageMax;
    const maxW = Math.max(16, Math.ceil((wPt / 72) * dpi));
    const maxH = Math.max(16, Math.ceil((hPt / 72) * dpi));
    const scale = Math.min(1, maxW / img.width, maxH / img.height);
    const tw = Math.max(1, Math.round(img.width * scale));
    const th = Math.max(1, Math.round(img.height * scale));
    if (img.kind === 'flate' && scale > 0.9 && looksLikeLineArt(img.source, img.width, img.height)) {
      img.source.close?.();
      continue; // diagrams/screenshots stay lossless
    }
    const canvas = makeCanvas(tw, th);
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, tw, th);
    g.imageSmoothingQuality = 'high';
    g.drawImage(img.source, 0, 0, tw, th);
    img.source.close?.();
    if (img.source.width && img.kind === 'flate') {
      img.source.width = 0;
      img.source.height = 0;
    }
    const jpeg = await canvasJpeg(canvas, quality);
    if (jpeg.length < original * 0.9) {
      const dict = stream.dict.clone(ctx);
      dict.set(N('Filter'), N('DCTDecode'));
      dict.delete(N('DecodeParms'));
      dict.set(N('Width'), PDFNumber.of(tw));
      dict.set(N('Height'), PDFNumber.of(th));
      dict.set(N('BitsPerComponent'), PDFNumber.of(8));
      if (img.comps === 1 || colorComponents(ctx, dict.get(N('ColorSpace'))) !== 3) dict.set(N('ColorSpace'), N('DeviceRGB'));
      dict.delete(N('Length'));
      ctx.assign(ref, PDFRawStream.of(dict, jpeg));
      recompressed++;
      saved += original - jpeg.length;
    }
  }

  onProgress(0.92, 'Cleaning up…');
  if (stripMetadata) {
    doc.catalog.delete(N('Metadata'));
    doc.catalog.delete(N('PieceInfo'));
    for (const page of doc.getPages()) {
      page.node.delete(N('Thumb'));
      page.node.delete(N('PieceInfo'));
      page.node.delete(N('Metadata'));
    }
    try {
      doc.setTitle('');
      doc.setAuthor('');
      doc.setSubject('');
      doc.setKeywords([]);
      doc.setCreator('');
      doc.setProducer('');
    } catch {
      /* ignore */
    }
  }
  const removedObjects = garbageCollect(doc);
  onProgress(0.96, 'Saving…');
  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 200 });
  return { bytes, stats: { images: images.length, recompressed, saved, removedObjects } };
}
