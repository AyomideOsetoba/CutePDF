/**
 * Column-aware reading order.
 *
 * This is the piece that fixes the "two-column paper" problem: many PDF tools
 * (and many OCR pipelines) treat a page as one block of full-width lines, so a
 * selection that starts in the left column jumps straight across into the
 * right column. Here we
 *
 *   1. group words/text runs into line *fragments* (never bridging a large gap),
 *   2. find column gutters: vertical channels of white space between blocks of
 *      ordinary text lines,
 *   3. split any fragment that still bridges a gutter,
 *   4. treat lines that genuinely cross a gutter (titles, abstracts, wide
 *      captions) as separators, and
 *   5. read each band between separators column by column, top to bottom.
 *
 * Coordinates are top-down (y grows downwards), any unit.
 * A "box" is { x0, y0, x1, y1, text?, wc? } plus anything else the caller
 * wants to carry along (it is returned untouched).
 */

export function median(values) {
  if (!values.length) return 0;
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function wordCount(box) {
  if (typeof box.wc === 'number') return box.wc;
  const t = (box.text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

function makeFrag(boxes) {
  const f = { boxes, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, wc: 0 };
  for (const b of boxes) {
    if (b.x0 < f.x0) f.x0 = b.x0;
    if (b.y0 < f.y0) f.y0 = b.y0;
    if (b.x1 > f.x1) f.x1 = b.x1;
    if (b.y1 > f.y1) f.y1 = b.y1;
    f.wc += wordCount(b);
  }
  f.yc = (f.y0 + f.y1) / 2;
  return f;
}

const vOverlap = (a, b) => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);

/** Group boxes into horizontal line fragments, breaking at gaps wider than gapFactor * unit. */
export function buildFragments(boxes, { unit, gapFactor = 1.2 } = {}) {
  const h = unit || median(boxes.map((b) => b.y1 - b.y0)) || 1;
  const maxGap = gapFactor * h;
  const sorted = boxes.slice().sort((a, b) => a.x0 - b.x0 || a.y0 - b.y0);
  const open = [];
  for (const b of sorted) {
    const bh = Math.max(b.y1 - b.y0, 1e-6);
    let best = null;
    let bestScore = Infinity;
    for (const f of open) {
      const last = f.last;
      const gap = b.x0 - f.x1;
      if (gap > maxGap) continue;
      if (gap < -Math.max(0.5 * (b.x1 - b.x0), 0.5 * h)) continue;
      const lh = Math.max(last.y1 - last.y0, 1e-6);
      const ov = vOverlap(b, last);
      if (ov < 0.5 * Math.min(bh, lh)) continue;
      const score = Math.max(gap, 0) + Math.abs((b.y0 + b.y1) / 2 - (last.y0 + last.y1) / 2);
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    if (best) {
      best.boxes.push(b);
      best.last = b;
      if (b.x1 > best.x1) best.x1 = b.x1;
    } else {
      open.push({ boxes: [b], last: b, x1: b.x1 });
    }
  }
  return open.map((f) => makeFrag(f.boxes));
}

/**
 * Find column gutters among fragments.
 * Returns [{ start, end, cs, ce }] where [cs, ce] is the emptiest core of the gutter.
 */
export function findGutters(frags, { unit, minGutterFactor = 0.8 } = {}) {
  if (frags.length < 8) return [];
  const h = unit || median(frags.map((f) => f.y1 - f.y0)) || 1;
  let xs0 = Infinity;
  let xs1 = -Infinity;
  for (const f of frags) {
    if (f.x0 < xs0) xs0 = f.x0;
    if (f.x1 > xs1) xs1 = f.x1;
  }
  const W = xs1 - xs0;
  if (W <= 0) return [];
  // Ordinary column lines are narrower than ~55% of the text block; wide
  // lines (abstracts, full-width captions) are ignored when measuring.
  const narrow = frags.filter((f) => f.x1 - f.x0 < 0.55 * W);
  if (narrow.length < 6) return [];
  const binW = Math.max(W / 500, 1e-3);
  const nb = Math.ceil(W / binW) + 1;
  const cov = new Float64Array(nb);
  for (const f of narrow) {
    const a = Math.max(0, Math.floor((f.x0 - xs0) / binW));
    const b = Math.min(nb - 1, Math.ceil((f.x1 - xs0) / binW) - 1);
    const w = f.y1 - f.y0;
    for (let i = a; i <= b; i++) cov[i] += w;
  }
  const positive = [];
  for (const v of cov) if (v > 0) positive.push(v);
  const med = median(positive);
  const thr = 0.25 * med;
  const minW = minGutterFactor * h;

  const candidates = [];
  let i = 0;
  while (i < nb) {
    if (cov[i] > thr) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < nb && cov[j + 1] <= thr) j++;
    // only interior runs, i.e. with text on both sides
    if (i > 0 && j < nb - 1) {
      let mn = Infinity;
      for (let k = i; k <= j; k++) mn = Math.min(mn, cov[k]);
      const coreThr = mn + 0.05 * med;
      // widest sub-run at (near) minimum coverage
      let bs = i;
      let be = i - 1;
      let k = i;
      while (k <= j) {
        if (cov[k] > coreThr) {
          k++;
          continue;
        }
        let l = k;
        while (l + 1 <= j && cov[l + 1] <= coreThr) l++;
        if (l - k > be - bs) {
          bs = k;
          be = l;
        }
        k = l + 1;
      }
      const start = xs0 + i * binW;
      const end = xs0 + (j + 1) * binW;
      const cs = xs0 + bs * binW;
      const ce = xs0 + (be + 1) * binW;
      if (end - start >= minW && ce - cs >= 0.4 * minW) candidates.push({ start, end, cs, ce, cov: mn });
    }
    i = j + 1;
  }
  if (!candidates.length) return [];

  // Validate: each gutter needs real text columns on both sides that sit side by side.
  let gutters = candidates;
  for (let iter = 0; iter < 10; iter++) {
    const bad = new Set();
    gutters.forEach((g, idx) => {
      const leftBound = idx > 0 ? gutters[idx - 1].ce : -Infinity;
      const rightBound = idx < gutters.length - 1 ? gutters[idx + 1].cs : Infinity;
      const L = [];
      const R = [];
      for (const f of frags) {
        if (f.x1 <= g.ce && f.x0 >= leftBound - 1e-9 && f.x1 <= g.ce) {
          if (f.x0 < g.cs) L.push(f);
        } else if (f.x0 >= g.cs && f.x1 <= rightBound + 1e-9 && f.x1 > g.ce) {
          R.push(f);
        }
      }
      const textyL = L.filter((f) => f.wc >= 3);
      const textyR = R.filter((f) => f.wc >= 3);
      const ok =
        textyL.length >= 3 &&
        textyR.length >= 3 &&
        textyL.length >= 0.3 * L.length &&
        textyR.length >= 0.3 * R.length &&
        (() => {
          const ly0 = Math.min(...textyL.map((f) => f.y0));
          const ly1 = Math.max(...textyL.map((f) => f.y1));
          const ry0 = Math.min(...textyR.map((f) => f.y0));
          const ry1 = Math.max(...textyR.map((f) => f.y1));
          return Math.min(ly1, ry1) - Math.max(ly0, ry0) >= 3 * h;
        })();
      if (!ok) bad.add(idx);
    });
    if (!bad.size) break;
    // drop the worst offender (highest coverage) and re-validate the rest
    let worst = -1;
    for (const idx of bad) if (worst < 0 || gutters[idx].cov > gutters[worst].cov) worst = idx;
    gutters = gutters.filter((_, idx) => idx !== worst);
    if (!gutters.length) break;
  }
  return gutters;
}

/** Split fragments that bridge a gutter at an inter-box gap overlapping the gutter core. */
function splitAtGutters(frags, gutters) {
  if (!gutters.length) return frags;
  const out = [];
  for (const f of frags) {
    const crossing = gutters.filter((g) => f.x0 < g.cs && f.x1 > g.ce);
    if (!crossing.length || f.boxes.length < 2) {
      out.push(f);
      continue;
    }
    const boxes = f.boxes.slice().sort((a, b) => a.x0 - b.x0);
    let cur = [boxes[0]];
    let curX1 = boxes[0].x1;
    const pieces = [];
    for (let i = 1; i < boxes.length; i++) {
      const b = boxes[i];
      const gapStart = curX1;
      const gapEnd = b.x0;
      // only cut where the white space really is the gutter (a normal word
      // space that happens to fall inside the gutter, e.g. in a full-width
      // caption, must not split the line)
      const cut = crossing.some((g) => {
        const ov = Math.min(gapEnd, g.ce) - Math.max(gapStart, g.cs);
        return ov >= 0.6 * (g.ce - g.cs);
      });
      if (cut) {
        pieces.push(cur);
        cur = [b];
        curX1 = b.x1;
      } else {
        cur.push(b);
        if (b.x1 > curX1) curX1 = b.x1;
      }
    }
    pieces.push(cur);
    for (const p of pieces) out.push(makeFrag(p));
  }
  return out;
}

/** Sort fragments top-to-bottom, grouping fragments on the same visual row left-to-right. */
export function sortRows(frags) {
  const sorted = frags.slice().sort((a, b) => a.yc - b.yc || a.x0 - b.x0);
  const rows = [];
  for (const f of sorted) {
    const row = rows[rows.length - 1];
    if (row) {
      const h = Math.min(f.y1 - f.y0, row.y1 - row.y0);
      if (vOverlap(f, row) >= 0.5 * h && f.yc <= row.y1) {
        row.items.push(f);
        row.y0 = Math.min(row.y0, f.y0);
        row.y1 = Math.max(row.y1, f.y1);
        continue;
      }
    }
    rows.push({ items: [f], y0: f.y0, y1: f.y1 });
  }
  const out = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.x0 - b.x0);
    row.items.forEach((f, i) => {
      f.rowEnd = i === row.items.length - 1;
      out.push(f);
    });
  }
  return out;
}

/**
 * Main entry: returns fragments ("lines") in reading order.
 *   { lines: [{ boxes, x0, y0, x1, y1, rowEnd, column, separator }], columns, gutters }
 * Each line's boxes are sorted left-to-right.
 */
export function analyzeLayout(boxes, { unit, gapFactor = 1.2, minGutterFactor = 0.8 } = {}) {
  const usable = boxes.filter((b) => b.x1 > b.x0 && b.y1 > b.y0);
  if (!usable.length) return { lines: [], columns: 1, gutters: [] };
  const h = unit || median(usable.map((b) => b.y1 - b.y0)) || 1;
  let frags = buildFragments(usable, { unit: h, gapFactor });
  const gutters = findGutters(frags, { unit: h, minGutterFactor });
  frags = splitAtGutters(frags, gutters);
  for (const f of frags) f.boxes.sort((a, b) => a.x0 - b.x0);

  if (!gutters.length) {
    const lines = sortRows(frags);
    for (const l of lines) l.column = 0;
    return { lines, columns: 1, gutters };
  }

  const seps = [];
  const colFrags = [];
  for (const f of frags) {
    const crossing = gutters.some((g) => f.x0 < g.cs && f.x1 > g.ce);
    // things that sit entirely inside a gutter (e.g. a centred page number)
    const inside = gutters.some((g) => f.x0 >= g.cs && f.x1 <= g.ce);
    if (crossing || inside) {
      f.separator = true;
      seps.push(f);
    } else {
      f.column = gutters.filter((g) => f.x1 > g.ce).length;
      colFrags.push(f);
    }
  }
  seps.sort((a, b) => a.yc - b.yc);
  const nCols = gutters.length + 1;
  const bands = Array.from({ length: seps.length + 1 }, () => Array.from({ length: nCols }, () => []));
  for (const f of colFrags) {
    let k = 0;
    while (k < seps.length && seps[k].yc <= f.yc) k++;
    bands[k][f.column].push(f);
  }
  const lines = [];
  for (let k = 0; k <= seps.length; k++) {
    for (let c = 0; c < nCols; c++) lines.push(...sortRows(bands[k][c]));
    if (k < seps.length) {
      // consecutive separators on the same row (rare) keep left-to-right order
      seps[k].rowEnd = true;
      seps[k].column = -1;
      lines.push(seps[k]);
    }
  }
  return { lines, columns: nCols, gutters };
}

/** Convenience: plain text in reading order. */
export function linesToText(lines, getText = (b) => b.text) {
  let out = '';
  for (const l of lines) out += lineText(l, getText) + (l.rowEnd === false ? ' ' : '\n');
  return out;
}

/** Join the boxes of one line, inserting spaces only where there is a visible gap. */
export function lineText(line, getText = (b) => b.text) {
  let s = '';
  let prev = null;
  for (const b of line.boxes) {
    const t = getText(b) || '';
    if (prev) {
      const h = Math.min(prev.y1 - prev.y0, b.y1 - b.y0);
      const gap = b.x0 - prev.x1;
      if (!/\s$/.test(s) && !/^\s/.test(t) && gap > 0.15 * h) s += ' ';
    }
    s += t;
    prev = b;
  }
  return s.replace(/\s+/g, ' ').trim();
}

/** Join fragments that sit on the same visual row (rowEnd === false) into single lines. */
export function mergeRowFragments(lines) {
  const out = [];
  let cur = null;
  for (const l of lines) {
    if (!cur) cur = { ...l, boxes: [...l.boxes] };
    else {
      cur.boxes.push(...l.boxes);
      cur.x0 = Math.min(cur.x0, l.x0);
      cur.x1 = Math.max(cur.x1, l.x1);
      cur.y0 = Math.min(cur.y0, l.y0);
      cur.y1 = Math.max(cur.y1, l.y1);
    }
    if (l.rowEnd !== false) {
      cur.rowEnd = true;
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}
