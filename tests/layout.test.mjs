import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLayout, linesToText } from '../src/lib/layout.js';

// --- tiny synthetic page builder (units ~ points, y grows down) -------------
const LOREM = 'robots are embodied agents governed by physical laws so physics provides a natural domain specific inductive bias nevertheless a trade off remains although stronger priors can improve interpretability and generalization they may also constrain model expressiveness'.split(' ');

function wordsLine(tag, x0, x1, y, h = 8, { justify = true, n } = {}) {
  // fill [x0, x1] with words, each word text is `${tag}` + index so we can check order
  const out = [];
  let x = x0;
  let i = 0;
  const cw = 4.2; // char width
  const space = 2.6;
  while (true) {
    const w = LOREM[(i * 7 + tag.length) % LOREM.length];
    const ww = w.length * cw;
    if (x + ww > x1 || (n && i >= n)) break;
    out.push({ x0: x, x1: x + ww, y0: y, y1: y + h, text: `${tag}.${i}` });
    x += ww + space;
    i++;
  }
  if (justify && out.length > 1) {
    const slack = x1 - out[out.length - 1].x1;
    out.forEach((b, k) => {
      const d = (slack * k) / (out.length - 1);
      b.x0 += d;
      b.x1 += d;
    });
  }
  return out;
}

function order(lines) {
  return lines.map((l) => l.boxes[0].text.split('.')[0]);
}

test('two columns with title and full-width abstract read column by column', () => {
  const boxes = [];
  boxes.push(...wordsLine('T1', 150, 450, 40, 14, { justify: false, n: 5 }));
  boxes.push(...wordsLine('A1', 50, 550, 80));
  boxes.push(...wordsLine('A2', 50, 550, 92));
  boxes.push(...wordsLine('A3', 50, 550, 104));
  for (let r = 0; r < 30; r++) {
    boxes.push(...wordsLine(`L${r}`, 50, 290, 140 + r * 12));
    boxes.push(...wordsLine(`R${r}`, 308, 550, 140 + r * 12));
  }
  // shuffle to make sure we don't depend on input order
  boxes.sort(() => Math.random() - 0.5);
  const res = analyzeLayout(boxes);
  assert.equal(res.columns, 2);
  const o = order(res.lines);
  const expected = ['T1', 'A1', 'A2', 'A3', ...Array.from({ length: 30 }, (_, r) => `L${r}`), ...Array.from({ length: 30 }, (_, r) => `R${r}`)];
  assert.deepEqual(o, expected);
});

test('lines merged across a narrow gutter get split (OCR-style)', () => {
  // gutter only ~14 units wide, word heights 8 → gutter ≈ 1.75h
  const boxes = [];
  for (let r = 0; r < 25; r++) {
    boxes.push(...wordsLine(`L${r}`, 40, 290, 100 + r * 11));
    boxes.push(...wordsLine(`R${r}`, 304, 554, 100 + r * 11));
  }
  const res = analyzeLayout(boxes);
  assert.equal(res.columns, 2);
  const o = order(res.lines);
  assert.deepEqual(o.slice(0, 25), Array.from({ length: 25 }, (_, r) => `L${r}`));
  assert.deepEqual(o.slice(25), Array.from({ length: 25 }, (_, r) => `R${r}`));
});

test('coincident paragraph gaps in both columns do not break column order', () => {
  const boxes = [];
  let y = 60;
  for (let r = 0; r < 36; r++) {
    if (r === 12 || r === 24) y += 20; // same gap in both columns
    boxes.push(...wordsLine(`L${r}`, 50, 290, y));
    boxes.push(...wordsLine(`R${r}`, 310, 550, y));
    y += 12;
  }
  const o = order(analyzeLayout(boxes).lines);
  assert.deepEqual(o, [...Array.from({ length: 36 }, (_, r) => `L${r}`), ...Array.from({ length: 36 }, (_, r) => `R${r}`)]);
});

test('single column page stays top to bottom with no gutters', () => {
  const boxes = [];
  for (let r = 0; r < 40; r++) {
    const short = r % 7 === 6;
    boxes.push(...wordsLine(`S${r}`, 60, short ? 240 : 540, 60 + r * 12, 8, { justify: !short }));
  }
  const res = analyzeLayout(boxes);
  assert.equal(res.columns, 1);
  assert.deepEqual(order(res.lines), Array.from({ length: 40 }, (_, r) => `S${r}`));
});

test('single column with centred equations and right equation numbers is not split', () => {
  const boxes = [];
  let y = 60;
  for (let r = 0; r < 30; r++) {
    if (r % 5 === 4) {
      boxes.push({ x0: 250, x1: 330, y0: y, y1: y + 9, text: `E${r}.0` });
      boxes.push({ x0: 525, x1: 540, y0: y, y1: y + 8, text: `N${r}.0` });
    } else {
      boxes.push(...wordsLine(`S${r}`, 60, r % 5 === 3 ? 200 : 540, y));
    }
    y += 12;
  }
  const res = analyzeLayout(boxes);
  assert.equal(res.columns, 1);
  const o = order(res.lines);
  // equation then its number on the same row
  const i = o.indexOf('E4');
  assert.equal(o[i + 1], 'N4');
  assert.ok(o.indexOf('S3') < i && o.indexOf('S5') > i);
});

test('three columns', () => {
  const boxes = [];
  for (let r = 0; r < 20; r++) {
    boxes.push(...wordsLine(`A${r}`, 40, 200, 80 + r * 12));
    boxes.push(...wordsLine(`B${r}`, 218, 380, 80 + r * 12));
    boxes.push(...wordsLine(`C${r}`, 398, 560, 80 + r * 12));
  }
  const res = analyzeLayout(boxes);
  assert.equal(res.columns, 3);
  const o = order(res.lines);
  assert.deepEqual(o, ['A', 'B', 'C'].flatMap((c) => Array.from({ length: 20 }, (_, r) => `${c}${r}`)));
});

test('full-width figure caption in the middle separates bands', () => {
  const boxes = [];
  for (let r = 0; r < 10; r++) {
    boxes.push(...wordsLine(`L${r}`, 50, 290, 60 + r * 12));
    boxes.push(...wordsLine(`R${r}`, 310, 550, 60 + r * 12));
  }
  boxes.push(...wordsLine('CAP', 50, 550, 200));
  for (let r = 10; r < 20; r++) {
    boxes.push(...wordsLine(`L${r}`, 50, 290, 230 + r * 12));
    boxes.push(...wordsLine(`R${r}`, 310, 550, 230 + r * 12));
  }
  const o = order(analyzeLayout(boxes).lines);
  const range = (p, a, b) => Array.from({ length: b - a }, (_, i) => `${p}${a + i}`);
  assert.deepEqual(o, [...range('L', 0, 10), ...range('R', 0, 10), 'CAP', ...range('L', 10, 20), ...range('R', 10, 20)]);
});

test('linesToText joins words and rows', () => {
  const boxes = [
    { x0: 0, x1: 10, y0: 0, y1: 8, text: 'Hello' },
    { x0: 12, x1: 22, y0: 0, y1: 8, text: 'world' },
    { x0: 0, x1: 10, y0: 12, y1: 20, text: 'Next' },
  ];
  assert.equal(linesToText(analyzeLayout(boxes).lines), 'Hello world\nNext\n');
});
