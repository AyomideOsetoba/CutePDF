// Minimal PDF content-stream tokenizer, enough to
//  - find invisible (OCR) text blocks and remove them, and
//  - follow the current transformation matrix to see how big images are drawn.

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;

const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const dec = new TextDecoder('latin1');

function decodeName(buf, a, b) {
  let s = dec.decode(buf.subarray(a, b));
  if (s.includes('#')) s = s.replace(/#([0-9a-fA-F]{2})/g, (_, hx) => String.fromCharCode(parseInt(hx, 16)));
  return s;
}

/**
 * Iterate operations: { op, operands, start, end } where start/end are byte offsets
 * covering the operands and the operator. Inline images are reported as op 'BI' covering BI…EI.
 */
export function* parseOps(buf) {
  const n = buf.length;
  let i = 0;
  let operands = [];
  let opStart = -1;
  let depth = 0;
  while (i < n) {
    const c = buf[i];
    if (WS[c]) {
      i++;
      continue;
    }
    if (c === 0x25) {
      while (i < n && buf[i] !== 10 && buf[i] !== 13) i++;
      continue;
    }
    const tokStart = i;
    if (opStart < 0) opStart = tokStart;
    if (c === 0x2f) {
      i++;
      while (i < n && !WS[buf[i]] && !DELIM[buf[i]]) i++;
      operands.push({ t: 'name', v: decodeName(buf, tokStart + 1, i) });
      continue;
    }
    if (c === 0x28) {
      let d = 1;
      i++;
      while (i < n && d > 0) {
        const x = buf[i];
        if (x === 0x5c) {
          i += 2;
          continue;
        }
        if (x === 0x28) d++;
        else if (x === 0x29) d--;
        i++;
      }
      operands.push({ t: 'str' });
      continue;
    }
    if (c === 0x3c) {
      if (buf[i + 1] === 0x3c) {
        i += 2;
        depth++;
        operands.push({ t: 'dict<' });
        continue;
      }
      i++;
      while (i < n && buf[i] !== 0x3e) i++;
      i++;
      operands.push({ t: 'str' });
      continue;
    }
    if (c === 0x3e) {
      i += buf[i + 1] === 0x3e ? 2 : 1;
      depth = Math.max(0, depth - 1);
      operands.push({ t: '>dict' });
      continue;
    }
    if (c === 0x5b) {
      i++;
      depth++;
      operands.push({ t: '[' });
      continue;
    }
    if (c === 0x5d) {
      i++;
      depth = Math.max(0, depth - 1);
      operands.push({ t: ']' });
      continue;
    }
    if (c === 0x7b || c === 0x7d || c === 0x29) {
      i++;
      continue;
    }
    // regular token
    while (i < n && !WS[buf[i]] && !DELIM[buf[i]]) i++;
    const word = dec.decode(buf.subarray(tokStart, i));
    if (NUM_RE.test(word)) {
      operands.push({ t: 'num', v: parseFloat(word) });
      continue;
    }
    if (word === 'true' || word === 'false' || word === 'null' || depth > 0) {
      operands.push({ t: 'kw', v: word });
      continue;
    }
    if (word === 'BI') {
      // inline image: skip to EI
      const idx = findInlineImageEnd(buf, i);
      const end = idx < 0 ? n : idx;
      yield { op: 'BI', operands: [], start: opStart, end };
      i = end;
      operands = [];
      opStart = -1;
      continue;
    }
    yield { op: word, operands, start: opStart, end: i };
    operands = [];
    opStart = -1;
  }
}

function findInlineImageEnd(buf, from) {
  const n = buf.length;
  // find " ID" + single whitespace
  let i = from;
  while (i < n - 2) {
    if (buf[i] === 0x49 && buf[i + 1] === 0x44 && WS[buf[i - 1]] && (WS[buf[i + 2]] || i + 2 === n)) break;
    i++;
  }
  i += 3;
  while (i < n - 1) {
    if (buf[i] === 0x45 && buf[i + 1] === 0x49 && WS[buf[i - 1]] && (i + 2 >= n || WS[buf[i + 2]] || DELIM[buf[i + 2]])) {
      return i + 2;
    }
    i++;
  }
  return -1;
}

const SHOW_OPS = new Set(['Tj', 'TJ', "'", '"']);
const DROP_IN_TEXT = new Set(['BT', 'ET', 'Td', 'TD', 'Tm', 'T*', 'Tj', 'TJ', "'", '"']);

/** Count text-showing operations that are visible vs invisible (Tr 3). */
export function countTextOps(buf) {
  let tr = 0;
  const stack = [];
  let visible = 0;
  let invisible = 0;
  for (const o of parseOps(buf)) {
    if (o.op === 'q') stack.push(tr);
    else if (o.op === 'Q') tr = stack.length ? stack.pop() : 0;
    else if (o.op === 'Tr') tr = o.operands[0]?.v ?? 0;
    else if (SHOW_OPS.has(o.op)) {
      if (tr === 3) invisible++;
      else visible++;
    }
  }
  return { visible, invisible };
}

/**
 * Remove text objects (BT…ET) whose text is drawn invisibly (render mode 3),
 * keeping any state-setting operators they contain so later content is unaffected.
 * Returns { bytes, removed }.
 */
export function stripInvisibleText(buf) {
  let tr = 0;
  const stack = [];
  const cuts = []; // { start, end, keep: string }
  let block = null;
  for (const o of parseOps(buf)) {
    if (o.op === 'q') stack.push(tr);
    else if (o.op === 'Q') tr = stack.length ? stack.pop() : 0;
    else if (o.op === 'Tr') tr = o.operands[0]?.v ?? 0;

    if (o.op === 'BT') {
      block = { start: o.start, shows: 0, visible: 0, keep: [] };
      continue;
    }
    if (!block) continue;
    if (SHOW_OPS.has(o.op)) {
      block.shows++;
      if (tr !== 3) block.visible++;
    }
    if (o.op === 'ET') {
      if (block.shows > 0 && block.visible === 0) {
        cuts.push({ start: block.start, end: o.end, keep: block.keep.join('\n') });
      }
      block = null;
      continue;
    }
    if (!DROP_IN_TEXT.has(o.op)) block.keep.push(dec.decode(buf.subarray(o.start, o.end)));
  }
  if (!cuts.length) return { bytes: buf, removed: 0 };
  const enc = new TextEncoder();
  const parts = [];
  let pos = 0;
  for (const c of cuts) {
    parts.push(buf.subarray(pos, c.start));
    if (c.keep) parts.push(latin1Bytes(`\n${c.keep}\n`));
    else parts.push(enc.encode('\n'));
    pos = c.end;
  }
  parts.push(buf.subarray(pos));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return { bytes: out, removed: cuts.length };
}

function latin1Bytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

/**
 * Walk a content stream and report every XObject drawn with `Do`, with the CTM at that point.
 * onDo(name, ctm) may return a promise-free value; forms are handled by the caller.
 */
export function walkDo(buf, baseCtm, onDo) {
  let ctm = baseCtm.slice();
  const stack = [];
  for (const o of parseOps(buf)) {
    switch (o.op) {
      case 'q':
        stack.push(ctm);
        break;
      case 'Q':
        ctm = stack.length ? stack.pop() : baseCtm.slice();
        break;
      case 'cm': {
        const v = o.operands.filter((x) => x.t === 'num').map((x) => x.v);
        if (v.length === 6) ctm = mul(v, ctm);
        break;
      }
      case 'Do': {
        const name = o.operands.find((x) => x.t === 'name')?.v;
        if (name) onDo(name, ctm);
        break;
      }
      default:
    }
  }
}
