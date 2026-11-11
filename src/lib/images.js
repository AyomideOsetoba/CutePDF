// Image helpers: decoding, EXIF orientation, embedding into pdf-lib documents.
import { degrees } from 'pdf-lib';

/** Read the EXIF orientation of a JPEG (1 = normal). */
export function jpegOrientation(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return 1;
  let off = 2;
  while (off + 4 < v.byteLength) {
    const marker = v.getUint16(off);
    const size = v.getUint16(off + 2);
    if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) {
      const tiff = off + 10;
      const little = v.getUint16(tiff) === 0x4949;
      const ifd = tiff + v.getUint32(tiff + 4, little);
      const n = v.getUint16(ifd, little);
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 10 > v.byteLength) break;
        if (v.getUint16(e, little) === 0x0112) return v.getUint16(e + 8, little);
      }
      return 1;
    }
    if ((marker & 0xff00) !== 0xff00) break;
    off += 2 + size;
  }
  return 1;
}

export function sniffType(bytes, fallback = '') {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  return fallback;
}

export async function decodeToCanvas(blob, maxSide = Infinity, background = '#ffffff') {
  let bmp;
  try {
    bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    bmp = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('This image format is not supported by your browser'));
      };
      img.src = url;
    });
  }
  const w0 = bmp.width;
  const h0 = bmp.height;
  const s = Math.min(1, maxSide / Math.max(w0, h0));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w0 * s));
  canvas.height = Math.max(1, Math.round(h0 * s));
  const ctx = canvas.getContext('2d');
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return canvas;
}

const toBlob = (canvas, type, q) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Encoding failed'))), type, q));

/**
 * Embed an image file into a pdf-lib doc. Keeps the original JPEG/PNG bytes
 * whenever possible (lossless, small); other formats are converted.
 * Returns { image, width, height } in pixels (after EXIF orientation).
 */
export async function embedImageFile(doc, file, { maxSide = Infinity, quality = 0.9 } = {}) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffType(bytes, file.type);
  if (maxSide === Infinity) {
    if (type === 'image/jpeg' && jpegOrientation(bytes) === 1) {
      const image = await doc.embedJpg(bytes);
      return { image, width: image.width, height: image.height };
    }
    if (type === 'image/png') {
      try {
        const image = await doc.embedPng(bytes);
        return { image, width: image.width, height: image.height };
      } catch {
        /* exotic PNG (e.g. 16-bit interlaced): convert below */
      }
    }
  }
  const canvas = await decodeToCanvas(new Blob([bytes], { type: type || file.type }), maxSide);
  const blob = await toBlob(canvas, 'image/jpeg', quality);
  const image = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
  const out = { image, width: canvas.width, height: canvas.height };
  canvas.width = canvas.height = 0;
  return out;
}

export const PAGE_SIZES = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

/**
 * Add a page with the image. size: 'fit' | 'a4' | 'letter'; margin in points;
 * rotation: extra clockwise rotation in degrees (applied losslessly via /Rotate).
 */
export function addImagePage(doc, { image, width, height }, { size = 'fit', orientation = 'auto', margin = 0, rotation = 0, dpi = 150 } = {}) {
  const ptW = (width * 72) / dpi;
  const ptH = (height * 72) / dpi;
  const rotated = rotation % 180 !== 0;
  // dimensions of the image as it will be *seen*
  const seenW = rotated ? ptH : ptW;
  const seenH = rotated ? ptW : ptH;
  let pw;
  let ph;
  if (size === 'fit') {
    pw = seenW + 2 * margin;
    ph = seenH + 2 * margin;
  } else {
    [pw, ph] = PAGE_SIZES[size] || PAGE_SIZES.a4;
    const landscape = orientation === 'landscape' || (orientation === 'auto' && seenW > seenH);
    if (landscape) [pw, ph] = [ph, pw];
  }
  // Build the page in the image's own orientation, then rotate the page.
  const [bw, bh] = rotated ? [ph, pw] : [pw, ph];
  const page = doc.addPage([bw, bh]);
  const availW = bw - 2 * margin;
  const availH = bh - 2 * margin;
  const s = Math.min(availW / ptW, availH / ptH, size === 'fit' ? 1 : Infinity);
  const dw = ptW * s;
  const dh = ptH * s;
  page.drawImage(image, { x: (bw - dw) / 2, y: (bh - dh) / 2, width: dw, height: dh });
  if (rotation) page.setRotation(degrees(((rotation % 360) + 360) % 360));
  return page;
}
