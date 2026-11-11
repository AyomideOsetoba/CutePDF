// Annotation model + import from / export to real PDF annotations.
//
// Model (all coordinates in PDF user space, i.e. points, origin bottom-left):
//   { id, page, type: 'highlight'|'underline'|'strike'|'ink'|'note', color: '#rrggbb',
//     rects: [[x0,y0,x1,y1]], paths: [[[x,y],…]], width, at: [x,y], text, note,
//     created, modified, ref?: '12R' (imported from the file), dirty?: bool }
import { PDFName, PDFNumber, PDFHexString, PDFString, PDFArray, PDFDict, PDFRef } from 'pdf-lib';
import { AnnotationType } from './pdf.js';
import { loadPdfLib, refFromPdfjsId, saveDoc } from './pdfdoc.js';

export const PALETTE = [
  { name: 'Yellow', color: '#ffd84d' },
  { name: 'Green', color: '#7ee08a' },
  { name: 'Blue', color: '#7cc4ff' },
  { name: 'Pink', color: '#ff8fc8' },
  { name: 'Red', color: '#e5484d' },
  { name: 'Purple', color: '#7b5cff' },
];

export const uid = () => `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0xffd84d;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function rgbToHex(c) {
  if (!c || c.length < 3) return null;
  return `#${[c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

export function annotBounds(a) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (x, y) => {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  };
  if (a.rects) for (const r of a.rects) { add(r[0], r[1]); add(r[2], r[3]); }
  if (a.paths) for (const p of a.paths) for (const [x, y] of p) add(x, y);
  if (a.at) { add(a.at[0], a.at[1]); add(a.at[0] + NOTE_SIZE, a.at[1] - NOTE_SIZE); }
  const pad = a.type === 'ink' ? (a.width || 2) : 0;
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

export const NOTE_SIZE = 20;

// ------------------------------------------------------------------ import
const TYPE_MAP = {
  [AnnotationType.HIGHLIGHT]: 'highlight',
  [AnnotationType.UNDERLINE]: 'underline',
  [AnnotationType.SQUIGGLY]: 'underline',
  [AnnotationType.STRIKEOUT]: 'strike',
  [AnnotationType.INK]: 'ink',
  [AnnotationType.TEXT]: 'note',
};

/** Convert pdf.js annotation data of one page into our model (only types we can edit). */
export function importPageAnnotations(pdfjsAnnots, pageIndex) {
  const out = [];
  for (const d of pdfjsAnnots) {
    const type = TYPE_MAP[d.annotationType];
    if (!type || !d.id || d.isPopup) continue;
    const base = {
      id: uid(),
      ref: d.id,
      page: pageIndex,
      type,
      color: rgbToHex(d.color) || (type === 'highlight' ? '#ffd84d' : '#e5484d'),
      note: d.contentsObj?.str || '',
      text: '',
      created: Date.now(),
      modified: Date.now(),
    };
    if (type === 'ink') {
      const lists = d.inkLists || [];
      const paths = lists.map((l) => {
        const pts = [];
        if (Array.isArray(l) && l.length && typeof l[0] === 'object') for (const p of l) pts.push([p.x, p.y]);
        else for (let i = 0; i + 1 < l.length; i += 2) pts.push([l[i], l[i + 1]]);
        return pts;
      }).filter((p) => p.length);
      if (!paths.length) continue;
      out.push({ ...base, paths, width: d.borderStyle?.width || 1.5 });
    } else if (type === 'note') {
      const r = d.rect;
      out.push({ ...base, at: [r[0], r[3]] });
    } else {
      const q = d.quadPoints;
      const rects = [];
      if (q && q.length >= 8) {
        for (let i = 0; i + 7 < q.length; i += 8) {
          const xs = [q[i], q[i + 2], q[i + 4], q[i + 6]];
          const ys = [q[i + 1], q[i + 3], q[i + 5], q[i + 7]];
          rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
        }
      } else if (d.rect) rects.push([...d.rect]);
      if (!rects.length) continue;
      out.push({ ...base, rects });
    }
  }
  return out;
}

// ------------------------------------------------------------------ export
const fmt = (n) => (Math.round(n * 100) / 100).toString();

function appearance(ctx, a, bbox) {
  const [r, g, b] = hexToRgb(a.color);
  const col = `${fmt(r)} ${fmt(g)} ${fmt(b)}`;
  let ops = '';
  const resources = {};
  if (a.type === 'highlight') {
    resources.ExtGState = { GS0: { Type: 'ExtGState', BM: 'Multiply', CA: 1, ca: 1 } };
    ops += `/GS0 gs ${col} rg\n`;
    for (const [x0, y0, x1, y1] of a.rects) ops += `${fmt(x0)} ${fmt(y0)} ${fmt(x1 - x0)} ${fmt(y1 - y0)} re f\n`;
  } else if (a.type === 'underline' || a.type === 'strike') {
    ops += `${col} RG\n`;
    for (const [x0, y0, x1, y1] of a.rects) {
      const hgt = y1 - y0;
      const w = Math.max(0.6, hgt / 14);
      const y = a.type === 'underline' ? y0 + hgt * 0.06 + w / 2 : y0 + hgt * 0.42;
      ops += `${fmt(w)} w ${fmt(x0)} ${fmt(y)} m ${fmt(x1)} ${fmt(y)} l S\n`;
    }
  } else if (a.type === 'ink') {
    ops += `${col} RG ${fmt(a.width || 2)} w 1 J 1 j\n`;
    for (const p of a.paths) {
      if (!p.length) continue;
      ops += `${fmt(p[0][0])} ${fmt(p[0][1])} m\n`;
      if (p.length === 1) ops += `${fmt(p[0][0] + 0.01)} ${fmt(p[0][1])} l\n`;
      for (let i = 1; i < p.length; i++) ops += `${fmt(p[i][0])} ${fmt(p[i][1])} l\n`;
      ops += 'S\n';
    }
  } else if (a.type === 'note') {
    const [x, y] = a.at;
    const s = NOTE_SIZE;
    ops += `${col} rg 0.35 0.3 0.1 RG 0.8 w\n${fmt(x + 0.5)} ${fmt(y - s + 0.5)} ${s - 1} ${s - 1} re B\n`;
    ops += `0.35 0.3 0.1 RG 1 w\n`;
    for (const k of [6, 10, 14]) ops += `${fmt(x + 4)} ${fmt(y - k)} m ${fmt(x + s - 4)} ${fmt(y - k)} l S\n`;
  }
  const stream = ctx.flateStream(ops, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: bbox,
    Resources: resources,
  });
  return ctx.register(stream);
}

function buildAnnotDict(ctx, a) {
  const bbox = annotBounds(a);
  const [x0, y0, x1, y1] = bbox;
  const subtype = { highlight: 'Highlight', underline: 'Underline', strike: 'StrikeOut', ink: 'Ink', note: 'Text' }[a.type];
  const dict = ctx.obj({
    Type: 'Annot',
    Subtype: subtype,
    Rect: [x0, y0, x1, y1].map((n) => Math.round(n * 100) / 100),
    C: hexToRgb(a.color).map((n) => Math.round(n * 1000) / 1000),
    F: 4,
  });
  dict.set(PDFName.of('NM'), PDFString.of(`cutepdf-${a.id}`));
  dict.set(PDFName.of('M'), PDFString.fromDate(new Date(a.modified || Date.now())));
  if (a.note) dict.set(PDFName.of('Contents'), PDFHexString.fromText(a.note));
  else if (a.text && a.type !== 'ink') dict.set(PDFName.of('Contents'), PDFHexString.fromText(a.text));
  if (a.rects && a.type !== 'ink' && a.type !== 'note') {
    const qp = [];
    for (const [rx0, ry0, rx1, ry1] of a.rects) qp.push(rx0, ry1, rx1, ry1, rx0, ry0, rx1, ry0);
    dict.set(PDFName.of('QuadPoints'), ctx.obj(qp.map((n) => Math.round(n * 100) / 100)));
  }
  if (a.type === 'ink') {
    dict.set(PDFName.of('InkList'), ctx.obj(a.paths.map((p) => p.flatMap(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]))));
    dict.set(PDFName.of('BS'), ctx.obj({ Type: 'Border', W: a.width || 2, S: 'S' }));
  }
  if (a.type === 'note') {
    dict.set(PDFName.of('Name'), PDFName.of('Comment'));
    dict.set(PDFName.of('Open'), ctx.obj(false));
  }
  if (a.type === 'highlight') dict.set(PDFName.of('CA'), PDFNumber.of(1));
  const ap = appearance(ctx, a, [x0, y0, x1, y1]);
  dict.set(PDFName.of('AP'), ctx.obj({ N: ap }));
  return dict;
}

const refKey = (ref) => `${ref.objectNumber} ${ref.generationNumber}`;

/**
 * Write annotations into the original PDF bytes and return new bytes.
 * Imported annotations that were not touched stay exactly as they were.
 */
export async function exportAnnotatedPdf(originalBytes, annots, importedIds) {
  const doc = await loadPdfLib(originalBytes);
  const ctx = doc.context;
  const pages = doc.getPages();
  const keepUntouched = new Set();
  for (const a of annots) if (a.ref && !a.dirty) keepUntouched.add(a.ref);
  // imported annotations that were edited or deleted get removed and (if edited) rewritten
  const remove = new Set();
  for (const id of importedIds) {
    if (keepUntouched.has(id)) continue;
    const ref = refFromPdfjsId(id);
    if (ref) remove.add(refKey(ref));
  }
  if (remove.size) {
    for (const page of pages) {
      const annotsArr = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
      if (!annotsArr) continue;
      const kept = [];
      for (let i = 0; i < annotsArr.size(); i++) {
        const item = annotsArr.get(i);
        if (item instanceof PDFRef && remove.has(refKey(item))) {
          const d = ctx.lookup(item);
          const popup = d instanceof PDFDict ? d.get(PDFName.of('Popup')) : null;
          if (popup instanceof PDFRef) remove.add(refKey(popup));
          continue;
        }
        kept.push(item);
      }
      // second pass removes popups discovered above
      const final = kept.filter((item) => !(item instanceof PDFRef && remove.has(refKey(item))));
      page.node.set(PDFName.of('Annots'), ctx.obj(final));
    }
  }
  for (const a of annots) {
    if (a.ref && !a.dirty) continue;
    const page = pages[a.page];
    if (!page) continue;
    const ref = ctx.register(buildAnnotDict(ctx, a));
    page.node.addAnnot(ref);
  }
  return saveDoc(doc);
}

/** Markdown summary of highlights and notes, grouped by page. */
export function annotationsToMarkdown(annots, title) {
  const byPage = new Map();
  for (const a of annots) {
    if (!byPage.has(a.page)) byPage.set(a.page, []);
    byPage.get(a.page).push(a);
  }
  let md = `# ${title}\n\n`;
  for (const p of [...byPage.keys()].sort((x, y) => x - y)) {
    md += `## Page ${p + 1}\n\n`;
    const list = byPage.get(p).sort((x, y) => annotBounds(y)[3] - annotBounds(x)[3]);
    for (const a of list) {
      if (a.text) md += `> ${a.text.replace(/\s+/g, ' ').trim()}\n\n`;
      if (a.note) md += `${a.type === 'note' ? '📝 ' : '**Note:** '}${a.note.trim()}\n\n`;
      if (!a.text && !a.note) md += `_${a.type === 'ink' ? 'Drawing' : a.type}_\n\n`;
    }
  }
  return md;
}
