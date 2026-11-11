import '../styles/reader.css';
import { h, icon, iconButton, button, toast, dropzone, downloadBlob, isPdf, readFile, segmented, modal } from '../lib/ui.js';
import { openPdf, TextLayer, AnnotationMode, AnnotationType, closePdf, canvasToImage, releaseImage, queueThumb } from '../lib/pdf.js';
import { columnOrderedTextContent } from '../lib/textorder.js';
import { PALETTE, uid, importPageAnnotations, exportAnnotatedPdf, annotationsToMarkdown, annotBounds, NOTE_SIZE } from '../lib/annotations.js';
import { kvGet, kvSet, kvDelete, kvClear, lsGet, lsSet } from '../lib/store.js';
import { takePending } from '../lib/handoff.js';
import { errorText } from '../lib/toolkit.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const isTouch = () => matchMedia('(hover: none)').matches;
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;

const PREFS_KEY = 'cutepdf.reader';
const TOOL_LABELS = {
  select: 'Select text (V)',
  highlight: 'Highlight (H)',
  underline: 'Underline (U)',
  strike: 'Strikethrough (S)',
  note: 'Sticky note (N)',
  pen: 'Pen (P)',
  eraser: 'Eraser (E)',
};
const TOOL_ICONS = { select: 'select', highlight: 'highlight', underline: 'underline', strike: 'strike', note: 'note', pen: 'pen', eraser: 'eraser' };
const MARKUP_TOOLS = ['highlight', 'underline', 'strike', 'note', 'pen'];

export default {
  mount(root) {
    document.body.classList.add('reader-mode');
    const reader = new Reader(root);
    return () => reader.destroy();
  },
};

class Reader {
  constructor(root) {
    this.root = root;
    this.ac = new AbortController();
    const prefs = lsGet(PREFS_KEY, {});
    this.prefs = {
      colors: { highlight: '#ffd84d', underline: '#e5484d', strike: '#e5484d', note: '#ffd84d', pen: '#e5484d', ...(prefs.colors || {}) },
      penWidth: prefs.penWidth || 2,
      theme: prefs.theme || 'normal',
      columns: prefs.columns !== false,
      remember: prefs.remember !== false,
      side: prefs.side ?? !matchMedia('(max-width: 760px)').matches,
    };
    this.tool = 'select';
    this.thumbCache = new Map(); // page index -> small JPEG thumbnail
    this.annots = [];
    this.undoStack = [];
    this.redoStack = [];
    this.pages = [];
    this.importedIds = new Set();
    this.scale = 1;
    this.unsaved = false;
    this.buildShell();
    this.bindGlobal();
    const pending = takePending();
    if (pending) this.open(pending);
    else this.showEmpty();
  }

  savePrefs() {
    lsSet(PREFS_KEY, this.prefs);
  }

  // ================================================================ shell
  buildShell() {
    const on = (el, ev, fn, opts) => el.addEventListener(ev, fn, { signal: this.ac.signal, ...opts });
    this.on = on;

    this.titleEl = h('div', { class: 'r-title' }, h('span', null, 'Reader'));
    this.pageInput = h('input', { class: 'r-pageinput', inputmode: 'numeric', 'aria-label': 'Page number', value: '–' });
    this.pageTotal = h('span', null, '/ –');
    on(this.pageInput, 'change', () => {
      const n = parseInt(this.pageInput.value, 10);
      if (n >= 1 && n <= this.pages.length) this.goToPage(n - 1);
      else this.updatePageIndicator(true);
    });
    on(this.pageInput, 'focus', () => this.pageInput.select());
    this.zoomLabel = h('button', { class: 'r-zoomlabel', title: 'Fit to width', onClick: () => this.fitWidth() }, '100%');
    this.saveBtn = button('Save', { variant: 'primary', icon: 'download', size: 'sm', cls: 'r-save', onClick: () => this.save() });
    this.saveBtn.title = 'Download the PDF with your highlights and notes (Ctrl+S)';
    this.searchBtn = iconButton('search', 'Search (Ctrl+F)', () => this.toggleSearch(true));
    this.moreBtn = iconButton('more', 'More options', (e) => this.showMenu(e.currentTarget));
    this.sideBtn = iconButton('sidebar', 'Pages, outline & notes', () => this.toggleSide());
    for (const b of [this.saveBtn, this.searchBtn, this.sideBtn]) b.classList.add('r-doc-only');

    const top = h('div', { class: 'r-top' },
      iconButton('back', 'Back to all tools', () => { location.hash = '#/'; }),
      this.sideBtn,
      this.titleEl,
      h('div', { class: 'r-pagenav r-doc-only' }, this.pageInput, this.pageTotal),
      h('div', { class: 'r-sep r-hide-sm r-doc-only' }),
      h('div', { class: 'r-zoom r-hide-sm r-doc-only' },
        iconButton('zoomOut', 'Zoom out (Ctrl −)', () => this.zoomBy(1 / 1.2)),
        this.zoomLabel,
        iconButton('zoomIn', 'Zoom in (Ctrl +)', () => this.zoomBy(1.2)),
      ),
      h('div', { class: 'r-sep r-hide-sm r-doc-only' }),
      this.searchBtn,
      this.saveBtn,
      this.moreBtn,
    );

    // search bar
    this.searchInput = h('input', { class: 'input', type: 'search', placeholder: 'Find in document…', 'aria-label': 'Find in document' });
    this.searchCount = h('span', { class: 'count' }, '');
    this.searchBar = h('div', { class: 'r-search hidden' },
      this.searchInput,
      iconButton('left', 'Previous match (Shift+Enter)', () => this.stepSearch(-1)),
      iconButton('right', 'Next match (Enter)', () => this.stepSearch(1)),
      this.searchCount,
      h('div', { class: 'grow' }),
      iconButton('close', 'Close search', () => this.toggleSearch(false)),
    );
    let st;
    on(this.searchInput, 'input', () => {
      clearTimeout(st);
      st = setTimeout(() => this.runSearch(this.searchInput.value), 250);
    });
    on(this.searchInput, 'keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.stepSearch(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') this.toggleSearch(false);
    });

    // sidebar
    this.tabBtns = {};
    const tab = (id, ic, label) => {
      const b = h('button', { role: 'tab', 'aria-selected': 'false', onClick: () => this.showTab(id) }, icon(ic, 16), label);
      this.tabBtns[id] = b;
      return b;
    };
    this.panel = h('div', { class: 'r-panel' });
    this.side = h('aside', { class: 'r-side', 'aria-label': 'Sidebar' },
      h('div', { class: 'r-tabs', role: 'tablist' }, tab('pages', 'organize', 'Pages'), tab('outline', 'outline', 'Outline'), tab('notes', 'comment', 'Notes')),
      this.panel,
    );
    this.scrim = h('div', { class: 'r-scrim', onClick: () => this.toggleSide(false) });

    // viewer
    this.pagesEl = h('div', { class: 'r-pages' });
    this.viewer = h('div', { class: 'r-viewer', tabindex: '0' }, this.pagesEl);
    this.body = h('div', { class: 'r-body' }, this.side, this.scrim, this.viewer);

    // tools
    this.toolBtns = {};
    const tools = ['select', 'highlight', 'underline', 'strike', 'note', 'pen', 'eraser'].map((t) => {
      const b = iconButton(TOOL_ICONS[t], TOOL_LABELS[t], () => this.setTool(t === this.tool && t !== 'select' ? 'select' : t), { pressed: t === 'select' });
      this.toolBtns[t] = b;
      return b;
    });
    this.swatch = h('button', { class: 'r-swatch', title: 'Colour', 'aria-label': 'Colour', onClick: (e) => this.showPalette(e.currentTarget) }, h('i'));
    this.widthBox = h('div', { class: 'r-width hidden' }, [1, 2, 4].map((w) =>
      h('button', { title: `Pen width ${w}`, dataset: { w: String(w) }, 'aria-pressed': String(this.prefs.penWidth === w), onClick: () => { this.prefs.penWidth = w; this.savePrefs(); this.updateToolbar(); } }, h('i', { style: { height: `${w + 1}px` } }))));
    this.undoBtn = iconButton('undo', 'Undo (Ctrl+Z)', () => this.undo());
    this.redoBtn = iconButton('redo', 'Redo (Ctrl+Shift+Z)', () => this.redo());
    this.toolsEl = h('div', { class: 'r-tools', role: 'toolbar', 'aria-label': 'Annotation tools' },
      tools, h('div', { class: 'r-sep' }), this.swatch, this.widthBox, h('div', { class: 'r-sep' }), this.undoBtn, this.redoBtn);

    this.el = h('div', { class: 'reader' }, top, this.searchBar, this.body, this.toolsEl);
    this.root.replaceChildren(this.el);
    this.applyTheme();
    this.toggleSide(this.prefs.side, false);
    this.showTab('pages');
    this.updateToolbar();
  }

  showEmpty() {
    this.el.classList.add('empty');
    this.titleEl.replaceChildren(h('span', null, 'Reader'));
    this.toolsEl.classList.add('hidden');
    const dz = dropzone({
      title: 'Open a PDF to read',
      hint: 'Highlight, comment and draw — your file stays on this device',
      onFiles: async ([f]) => {
        if (!isPdf(f)) return toast('Please choose a PDF file', 'error');
        this.open({ bytes: await readFile(f), name: f.name });
      },
    });
    this.empty = h('div', { class: 'r-empty-state' }, h('div', null, dz));
    this.viewer.append(this.empty);
  }

  // ================================================================ open
  async open({ bytes, name }) {
    this.closeDoc();
    this.empty?.remove();
    this.empty = null;
    const loading = h('div', { class: 'r-loading' }, h('div', null, icon('spinner', 20, 'spin'), `Opening ${name}…`));
    this.viewer.append(loading);
    try {
      const pdf = await openPdf(bytes, name);
      this.pdf = pdf;
      this.bytes = bytes;
      this.name = name;
      this.fp = pdf.fingerprints?.[0] || `${name}:${bytes.length}`;
      this.titleEl.replaceChildren(h('span', { title: name }, name));
      document.title = `${name} · CutePDF`;
      this.pageTotal.textContent = `/ ${pdf.numPages}`;

      // page geometry
      const vps = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1).then((p) => p.getViewport({ scale: 1 }))));
      this.pages = vps.map((vp1, index) => ({ index, vp1 }));

      // annotations already in the file become editable
      await this.importAll();
      // restore a draft from this browser if it belongs to this exact file state
      const sig = [...this.importedIds].sort().join(',');
      this.sig = sig;
      const draft = this.prefs.remember ? await kvGet(`doc:${this.fp}`) : null;
      let startPage = 0;
      if (draft && draft.sig === sig) {
        if (Array.isArray(draft.annots) && draft.dirty) {
          this.annots = draft.annots;
          this.markUnsaved(true);
          toast('Restored your unsaved annotations from last time', 'success');
        }
        startPage = clamp(draft.page || 0, 0, this.pages.length - 1);
      }

      this.buildPages();
      this.fitWidth();
      this.toolsEl.classList.remove('hidden');
      this.el.classList.remove('empty');
      this.observePages();
      if (startPage > 0) {
        requestAnimationFrame(() => this.goToPage(startPage, { smooth: false }));
        toast(`Resumed at page ${startPage + 1}`);
      }
      this.updatePageIndicator(true);
      this.refreshSide();
      this.viewer.focus({ preventScroll: true });
    } catch (e) {
      console.error(e);
      toast(errorText(e), 'error', 6000);
      this.showEmpty();
    } finally {
      loading.remove();
    }
  }

  async importAll() {
    this.importedIds = new Set();
    const storage = this.pdf.annotationStorage;
    const imported = [];
    await Promise.all(this.pages.map(async (p) => {
      const page = await this.pdf.getPage(p.index + 1);
      let data = [];
      try {
        data = await page.getAnnotations({ intent: 'display' });
      } catch {
        /* broken annotations: ignore */
      }
      const list = importPageAnnotations(data, p.index);
      for (const a of list) {
        this.importedIds.add(a.ref);
        storage.setValue(a.ref, { noView: true });
      }
      imported.push(...list);
      p.links = data.filter((d) => d.annotationType === AnnotationType.LINK && Array.isArray(d.rect) && (d.url || d.dest || d.unsafeUrl));
    }));
    imported.sort((a, b) => a.page - b.page);
    this.annots.push(...imported);
  }

  closeDoc() {
    this.io?.disconnect();
    this.thumbIO?.disconnect();
    for (const img of this.thumbCache.values()) releaseImage(img);
    this.thumbCache.clear();
    for (const p of this.pages) p.renderTask?.cancel();
    this.textLayers?.clear();
    closePdf(this.pdf);
    this.pdf = null;
    this.pages = [];
    this.annots = [];
    this.undoStack = [];
    this.redoStack = [];
    this.search = null;
    this.selectedId = null;
    this.hidePop();
    this.pagesEl.replaceChildren();
    this.markUnsaved(false);
  }

  destroy() {
    this.saveDraft(true);
    this.ac.abort();
    this.closeDoc();
    this.hidePop();
    this.menu?.remove();
    document.body.classList.remove('reader-mode');
    window.removeEventListener('beforeunload', this.beforeUnload);
  }

  // ================================================================ pages
  buildPages() {
    this.pagesEl.replaceChildren();
    for (const p of this.pages) {
      p.el = h('div', { class: 'r-page', dataset: { index: String(p.index) } }, h('div', { class: 'r-ph' }, String(p.index + 1)));
      p.svg = svg('svg', { class: 'r-annots', viewBox: `0 0 ${p.vp1.width} ${p.vp1.height}`, preserveAspectRatio: 'none' });
      p.hits = h('div', { class: 'r-hits' });
      p.draw = h('div', { class: 'r-draw' });
      p.el.append(p.svg, p.hits, p.draw);
      this.bindDraw(p);
      this.pagesEl.append(p.el);
      this.drawAnnots(p);
    }
  }

  applyScale() {
    this.pagesEl.style.setProperty('--scale-factor', String(this.scale));
    for (const p of this.pages) {
      p.el.style.width = `${Math.floor(p.vp1.width * this.scale)}px`;
      p.el.style.height = `${Math.floor(p.vp1.height * this.scale)}px`;
    }
    this.zoomLabel.textContent = `${Math.round(this.scale * 100)}%`;
  }

  observePages() {
    this.io?.disconnect();
    this.visible = new Set();
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const p = this.pages[Number(e.target.dataset.index)];
        if (!p) continue;
        if (e.isIntersecting) this.visible.add(p);
        else this.visible.delete(p);
      }
      this.scheduleRender();
    }, { root: this.viewer, rootMargin: '60% 0px' });
    for (const p of this.pages) this.io.observe(p.el);
  }

  scheduleRender() {
    if (this.renderQueued || !this.pdf) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      if (!this.pdf) return;
      const cur = this.currentPageIndex();
      const vis = [...this.visible].sort((a, b) => Math.abs(a.index - cur) - Math.abs(b.index - cur));
      for (const p of vis) {
        if (p.renderedScale !== this.scale && !p.rendering) this.renderPage(p);
        if (!p.textLayer && !p.textBuilding) this.buildTextLayer(p);
      }
      // free memory of pages far away: their canvas, pdf.js' decoded images
      // and (a bit further out) their invisible text layer
      const keep = new Set(vis);
      for (const p of this.pages) {
        if (keep.has(p)) continue;
        if (p.canvas) this.unrenderPage(p);
        if (p.textLayer && Math.abs(p.index - cur) > 4) this.dropTextLayer(p);
      }
    });
  }

  async renderPage(p) {
    p.rendering = true;
    const scale = this.scale;
    try {
      const page = await this.pdf.getPage(p.index + 1);
      const viewport = page.getViewport({ scale });
      let ratio = Math.min(window.devicePixelRatio || 1, 2.5);
      const maxPx = isTouch() ? 9e6 : 16e6;
      if (viewport.width * viewport.height * ratio * ratio > maxPx) ratio = Math.sqrt(maxPx / (viewport.width * viewport.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      const ctx = canvas.getContext('2d', { alpha: false });
      p.renderTask?.cancel();
      p.renderTask = page.render({
        canvasContext: ctx,
        canvas,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null,
        annotationMode: this.importedIds.size ? AnnotationMode.ENABLE_STORAGE : AnnotationMode.ENABLE,
      });
      await p.renderTask.promise;
      if (!this.pdf || scale !== this.scale) {
        canvas.width = canvas.height = 0;
        return;
      }
      if (p.canvas) {
        p.canvas.replaceWith(canvas);
        p.canvas.width = p.canvas.height = 0;
      } else {
        p.el.querySelector('.r-ph')?.remove();
        p.el.prepend(canvas);
      }
      p.canvas = canvas;
      p.renderedScale = scale;
      if (!p.linksEl) this.buildLinks(p);
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException') console.error(e);
    } finally {
      p.rendering = false;
      if (this.pdf && p.renderedScale !== this.scale && this.visible?.has(p)) this.scheduleRender();
    }
  }

  unrenderPage(p) {
    if (!p.canvas) return;
    p.renderTask?.cancel();
    p.canvas.width = p.canvas.height = 0;
    p.canvas.remove();
    p.canvas = null;
    p.renderedScale = null;
    if (!p.el.querySelector('.r-ph')) p.el.prepend(h('div', { class: 'r-ph' }, String(p.index + 1)));
    // pdf.js keeps decoded images (tens of MB per scanned page) until told otherwise
    const pdf = this.pdf;
    pdf?.getPage(p.index + 1).then((page) => {
      if (this.pdf === pdf && !p.rendering) page.cleanup();
    }).catch(() => {});
  }

  dropTextLayer(p) {
    const sel = window.getSelection();
    if (sel?.rangeCount && sel.getRangeAt(0).intersectsNode(p.textLayer)) return;
    this.textLayers?.delete(p.textLayer);
    p.textLayer.remove();
    p.textLayer = null;
    p.textDivs = null; // the extracted text itself stays cached for search
  }

  async getText(p) {
    if (!p.textPromise) {
      p.textPromise = (async () => {
        const page = await this.pdf.getPage(p.index + 1);
        const tc = await page.getTextContent();
        if (this.prefs.columns) {
          const res = columnOrderedTextContent(tc, p.vp1);
          p.columns = res.columns;
          return res.textContent;
        }
        p.columns = 1;
        return tc;
      })();
    }
    return p.textPromise;
  }

  async buildTextLayer(p) {
    p.textBuilding = true;
    try {
      const tc = await this.getText(p);
      if (!this.pdf || p.textLayer) return;
      const div = h('div', { class: 'textLayer' });
      const tl = new TextLayer({ textContentSource: tc, container: div, viewport: p.vp1 });
      await tl.render();
      const end = h('div', { class: 'endOfContent' });
      div.append(end);
      this.registerTextLayer(div, end);
      p.textLayer = div;
      p.textDivs = tl.textDivs;
      p.el.insertBefore(div, p.linksEl || p.draw);
      if (p.search?.length) this.drawSearchHits(p);
    } catch (e) {
      console.error(e);
    } finally {
      p.textBuilding = false;
    }
  }

  rebuildTextLayers() {
    for (const p of this.pages) {
      if (p.textLayer) {
        this.textLayers?.delete(p.textLayer);
        p.textLayer.remove();
      }
      p.textLayer = null;
      p.textPromise = null;
      p.textDivs = null;
      p.searchText = null;
      p.search = null;
      p.hits.replaceChildren();
    }
    this.search = null;
    this.searchCount.textContent = '';
    this.scheduleRender();
  }

  buildLinks(p) {
    p.linksEl = h('div', { class: 'r-links' });
    for (const l of p.links || []) {
      const [x0, y0, x1, y1] = this.rectToView(p, l.rect);
      const url = l.url || l.unsafeUrl;
      const a = h('a', {
        style: { left: `${(x0 / p.vp1.width) * 100}%`, top: `${(y0 / p.vp1.height) * 100}%`, width: `${((x1 - x0) / p.vp1.width) * 100}%`, height: `${((y1 - y0) / p.vp1.height) * 100}%` },
        title: url || 'Go to destination',
      });
      if (url) {
        if (!/^(https?|mailto):/i.test(url)) continue;
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      } else {
        a.href = '#';
        a.addEventListener('click', (e) => {
          e.preventDefault();
          this.goToDest(l.dest);
        });
      }
      p.linksEl.append(a);
    }
    p.el.insertBefore(p.linksEl, p.draw);
  }

  // ================================================================ geometry
  toPdf(p, vx, vy) {
    return p.vp1.convertToPdfPoint(vx, vy);
  }

  toView(p, x, y) {
    return p.vp1.convertToViewportPoint(x, y);
  }

  rectToView(p, r) {
    const [ax, ay] = this.toView(p, r[0], r[1]);
    const [bx, by] = this.toView(p, r[2], r[3]);
    return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
  }

  /** client (screen) coords → page-local viewport(scale 1) coords */
  clientToPage(p, cx, cy) {
    const r = p.el.getBoundingClientRect();
    return [((cx - r.left) / r.width) * p.vp1.width, ((cy - r.top) / r.height) * p.vp1.height];
  }

  pageAtClient(cx, cy) {
    for (const p of this.pages) {
      const r = p.el.getBoundingClientRect();
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return p;
    }
    return null;
  }

  // ================================================================ annotations drawing
  drawAnnots(p) {
    const s = p.svg;
    s.replaceChildren();
    for (const a of this.annots) {
      if (a.page !== p.index) continue;
      const g = svg('g', { 'data-id': a.id });
      if (a.type === 'highlight') {
        g.setAttribute('class', 'hl');
        for (const r of a.rects) {
          const [x0, y0, x1, y1] = this.rectToView(p, r);
          g.append(svg('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: a.color, rx: 1 }));
        }
      } else if (a.type === 'underline' || a.type === 'strike') {
        for (const r of a.rects) {
          const [x0, y0, x1, y1] = this.rectToView(p, r);
          const hgt = y1 - y0;
          const w = Math.max(0.6, hgt / 14);
          const y = a.type === 'underline' ? y1 - hgt * 0.06 - w / 2 : y0 + hgt * 0.58;
          g.append(svg('line', { x1: x0, x2: x1, y1: y, y2: y, stroke: a.color, 'stroke-width': w }));
        }
      } else if (a.type === 'ink') {
        for (const path of a.paths) {
          const pts = path.map(([x, y]) => this.toView(p, x, y));
          g.append(svg('path', { d: smoothPath(pts), fill: 'none', stroke: a.color, 'stroke-width': a.width || 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
        }
      } else if (a.type === 'note') {
        const [x, y] = this.toView(p, a.at[0], a.at[1]);
        const sz = NOTE_SIZE;
        g.append(
          svg('rect', { x: x + 0.5, y: y + 0.5, width: sz - 1, height: sz - 1, rx: 4, fill: a.color, stroke: '#5a4b1a', 'stroke-width': 0.8 }),
          ...[6, 10, 14].map((k) => svg('line', { x1: x + 4, x2: x + sz - 4, y1: y + k, y2: y + k, stroke: '#5a4b1a', 'stroke-width': 1 })),
        );
      }
      s.append(g);
      if (a.id === this.selectedId) {
        const [x0, y0, x1, y1] = this.rectToView(p, annotBounds(a));
        s.append(svg('rect', { class: 'sel', x: x0 - 2, y: y0 - 2, width: x1 - x0 + 4, height: y1 - y0 + 4, rx: 3 }));
      }
    }
  }

  redraw(pageIndexes) {
    const set = pageIndexes ? new Set(pageIndexes) : null;
    for (const p of this.pages) if (!set || set.has(p.index)) this.drawAnnots(p);
    if (this.tab === 'notes' && !this.el.classList.contains('side-closed')) this.renderNotesPanel();
  }

  hitTest(p, vx, vy) {
    const list = this.annots.filter((a) => a.page === p.index);
    for (let i = list.length - 1; i >= 0; i--) {
      const a = list[i];
      if (a.type === 'ink') {
        for (const path of a.paths) {
          const pts = path.map(([x, y]) => this.toView(p, x, y));
          for (let k = 0; k < pts.length; k++) {
            const d = k === 0 ? Math.hypot(pts[0][0] - vx, pts[0][1] - vy) : distToSeg(vx, vy, pts[k - 1], pts[k]);
            if (d <= (a.width || 2) / 2 + 5 / this.scale) return a;
          }
        }
      } else {
        const rects = a.type === 'note' ? [annotBounds(a)] : a.rects;
        for (const r of rects) {
          const [x0, y0, x1, y1] = this.rectToView(p, r);
          const pad = 2 / this.scale;
          if (vx >= x0 - pad && vx <= x1 + pad && vy >= y0 - pad && vy <= y1 + pad) return a;
        }
      }
    }
    return null;
  }

  // ================================================================ annotation state
  snapshot() {
    return JSON.stringify(this.annots);
  }

  commit(before, pagesTouched) {
    this.undoStack.push(before);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.markUnsaved(true);
    this.redraw(pagesTouched);
    this.updateToolbar();
    this.saveDraft();
  }

  addAnnot(a) {
    const before = this.snapshot();
    a.id ||= uid();
    a.created = a.modified = Date.now();
    this.annots.push(a);
    this.commit(before, [a.page]);
    return a;
  }

  updateAnnot(id, patch, { history = true } = {}) {
    const a = this.annots.find((x) => x.id === id);
    if (!a) return;
    const before = this.snapshot();
    Object.assign(a, patch, { modified: Date.now() });
    if (a.ref) a.dirty = true;
    if (history) this.commit(before, [a.page]);
    else {
      this.markUnsaved(true);
      this.redraw([a.page]);
      this.saveDraft();
    }
  }

  deleteAnnot(id) {
    const a = this.annots.find((x) => x.id === id);
    if (!a) return;
    const before = this.snapshot();
    this.annots = this.annots.filter((x) => x.id !== id);
    if (this.selectedId === id) this.selectedId = null;
    this.commit(before, [a.page]);
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.snapshot());
    this.annots = JSON.parse(this.undoStack.pop());
    this.selectedId = null;
    this.hidePop();
    this.afterHistory();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.snapshot());
    this.annots = JSON.parse(this.redoStack.pop());
    this.selectedId = null;
    this.hidePop();
    this.afterHistory();
  }

  afterHistory() {
    this.markUnsaved(true);
    this.redraw();
    this.updateToolbar();
    this.saveDraft();
  }

  markUnsaved(v) {
    this.unsaved = v;
    this.saveBtn?.classList.toggle('unsaved', v);
    this.titleEl.querySelector('.r-dot')?.remove();
    if (v) this.titleEl.prepend(h('i', { class: 'r-dot', title: 'Annotations not yet saved into the PDF' }));
  }

  saveDraft(immediate = false) {
    clearTimeout(this.draftTimer);
    const run = () => {
      if (!this.pdf || !this.prefs.remember) return;
      kvSet(`doc:${this.fp}`, {
        name: this.name,
        sig: this.sig,
        annots: this.unsaved ? this.annots : null,
        dirty: this.unsaved,
        page: this.currentPageIndex(),
        updated: Date.now(),
      });
    };
    if (immediate) run();
    else this.draftTimer = setTimeout(run, 700);
  }

  // ================================================================ tools
  setTool(t) {
    this.tool = t;
    this.hidePop();
    if (t !== 'select' && !['highlight', 'underline', 'strike'].includes(t)) window.getSelection()?.removeAllRanges();
    this.el.classList.toggle('mode-pen', t === 'pen');
    this.el.classList.toggle('mode-eraser', t === 'eraser');
    this.el.classList.toggle('mode-note', t === 'note');
    if ((t === 'pen' || t === 'eraser') && isTouch() && !this.penHintShown) {
      this.penHintShown = true;
      toast('Drawing mode: switch back to the cursor to scroll');
    }
    // a selection made before picking a markup tool is applied right away
    if (['highlight', 'underline', 'strike'].includes(t) && this.selectionInfo()) this.annotateSelection(t, this.prefs.colors[t]);
    this.updateToolbar();
  }

  colorTool() {
    return MARKUP_TOOLS.includes(this.tool) ? this.tool : 'highlight';
  }

  updateToolbar() {
    for (const [t, b] of Object.entries(this.toolBtns)) b.setAttribute('aria-pressed', String(t === this.tool));
    this.swatch.style.setProperty('--c', this.prefs.colors[this.colorTool()]);
    this.swatch.classList.toggle('hidden', this.tool === 'select' || this.tool === 'eraser');
    this.widthBox.classList.toggle('hidden', this.tool !== 'pen');
    for (const b of this.widthBox.children) b.setAttribute('aria-pressed', String(Number(b.dataset.w) === this.prefs.penWidth));
    this.undoBtn.disabled = !this.undoStack.length;
    this.redoBtn.disabled = !this.redoStack.length;
  }

  showPalette(anchor) {
    const t = this.colorTool();
    const pop = this.makePop();
    pop.append(this.dots(this.prefs.colors[t], (c) => {
      this.prefs.colors[t] = c;
      this.savePrefs();
      this.updateToolbar();
      this.hidePop();
    }));
    this.placePop(pop, anchor.getBoundingClientRect(), 'above');
  }

  dots(current, onPick) {
    return h('div', { class: 'r-dots' }, PALETTE.map((p) =>
      h('button', { title: p.name, 'aria-label': p.name, 'aria-pressed': String(p.color === current), dataset: { c: p.color }, style: { '--c': p.color }, onClick: () => onPick(p.color) }, h('i'))));
  }

  // ================================================================ selection → annotations
  selectionInfo() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    if (!this.pagesEl.contains(range.commonAncestorContainer)) return null;
    const parts = [];
    for (const p of this.pages) {
      if (!p.textLayer || !range.intersectsNode(p.textLayer)) continue;
      const sub = document.createRange();
      if (p.textLayer.contains(range.startContainer)) sub.setStart(range.startContainer, range.startOffset);
      else sub.setStart(p.textLayer, 0);
      if (p.textLayer.contains(range.endContainer)) sub.setEnd(range.endContainer, range.endOffset);
      else sub.setEnd(p.textLayer, p.textLayer.childNodes.length);
      const rects = this.rangeRects(p, sub);
      const text = sub.toString().replace(/\s+/g, ' ').trim();
      if (rects.length && text) parts.push({ p, rects, text });
    }
    return parts.length ? { parts, range } : null;
  }

  /** Client rects of a range on a page → merged line rects in PDF space. */
  rangeRects(p, range) {
    const pr = p.el.getBoundingClientRect();
    const k = p.vp1.width / pr.width;
    const raw = [];
    for (const r of range.getClientRects()) {
      if (r.width < 0.5 || r.height < 0.5) continue;
      if (r.width > pr.width * 0.9 && r.height > pr.height * 0.3) continue; // endOfContent filler
      raw.push([(r.left - pr.left) * k, (r.top - pr.top) * k, (r.right - pr.left) * k, (r.bottom - pr.top) * k]);
    }
    raw.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const lines = [];
    for (const r of raw) {
      const hgt = r[3] - r[1];
      const line = lines.find((l) => {
        const ov = Math.min(l[3], r[3]) - Math.max(l[1], r[1]);
        return ov > 0.5 * Math.min(hgt, l[3] - l[1]) && r[0] <= l[2] + hgt * 1.2 && r[2] >= l[0] - hgt * 1.2;
      });
      if (line) {
        line[0] = Math.min(line[0], r[0]);
        line[1] = Math.min(line[1], r[1]);
        line[2] = Math.max(line[2], r[2]);
        line[3] = Math.max(line[3], r[3]);
      } else lines.push([...r]);
    }
    return lines.map(([x0, y0, x1, y1]) => {
      const [ax, ay] = this.toPdf(p, x0, y0);
      const [bx, by] = this.toPdf(p, x1, y1);
      return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
    });
  }

  annotateSelection(type, color, { openNote = false } = {}) {
    const info = this.selectionInfo();
    if (!info) return null;
    const before = this.snapshot();
    const created = [];
    for (const part of info.parts) {
      const a = { id: uid(), page: part.p.index, type, color, rects: part.rects, text: part.text, note: '', created: Date.now(), modified: Date.now() };
      this.annots.push(a);
      created.push(a);
    }
    window.getSelection().removeAllRanges();
    this.commit(before, created.map((a) => a.page));
    if (openNote && created[0]) this.selectAnnot(created[0], { edit: true });
    return created;
  }

  onSelectionDone() {
    const info = this.selectionInfo();
    if (!info) return;
    if (['highlight', 'underline', 'strike'].includes(this.tool)) {
      this.annotateSelection(this.tool, this.prefs.colors[this.tool]);
      return;
    }
    if (this.tool !== 'select') return;
    const rects = [...info.range.getClientRects()].filter((r) => r.width > 0 && r.height > 0 && r.width < window.innerWidth * 0.9);
    if (!rects.length) return;
    const box = rects.reduce((acc, r) => ({ left: Math.min(acc.left, r.left), top: Math.min(acc.top, r.top), right: Math.max(acc.right, r.right), bottom: Math.max(acc.bottom, r.bottom) }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    const pop = this.makePop();
    pop.append(h('div', { class: 'row' },
      this.dots(null, (c) => {
        this.prefs.colors.highlight = c;
        this.savePrefs();
        this.updateToolbar();
        this.annotateSelection('highlight', c);
        this.hidePop();
      }),
      h('div', { class: 'r-sep' }),
      iconButton('underline', 'Underline', () => { this.annotateSelection('underline', this.prefs.colors.underline); this.hidePop(); }),
      iconButton('strike', 'Strikethrough', () => { this.annotateSelection('strike', this.prefs.colors.strike); this.hidePop(); }),
      iconButton('comment', 'Highlight & comment', () => { this.hidePop(); this.annotateSelection('highlight', this.prefs.colors.highlight, { openNote: true }); }),
      iconButton('copy', 'Copy text', async () => {
        const text = info.parts.map((x) => x.text).join(' ');
        try {
          await navigator.clipboard.writeText(text);
          toast('Copied');
        } catch {
          document.execCommand('copy');
        }
        this.hidePop();
      }),
    ));
    this.placePop(pop, box, isTouch() ? 'below' : 'above');
  }

  selectAnnot(a, { edit = false } = {}) {
    this.selectedId = a.id;
    this.redraw([a.page]);
    const p = this.pages[a.page];
    const [x0, y0, x1, y1] = this.rectToView(p, annotBounds(a));
    const pr = p.el.getBoundingClientRect();
    const k = pr.width / p.vp1.width;
    const box = { left: pr.left + x0 * k, top: pr.top + y0 * k, right: pr.left + x1 * k, bottom: pr.top + y1 * k };
    const pop = this.makePop(() => {
      if (this.selectedId === a.id) {
        this.selectedId = null;
        this.redraw([a.page]);
      }
    });
    const ta = h('textarea', { class: 'input', placeholder: a.type === 'note' ? 'Write a note…' : 'Add a comment…' });
    ta.value = a.note || '';
    let noteTimer;
    let noteBefore = null;
    ta.addEventListener('input', () => {
      noteBefore ??= this.snapshot();
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => this.updateAnnot(a.id, { note: ta.value }, { history: false }), 250);
    });
    ta.addEventListener('blur', () => {
      clearTimeout(noteTimer);
      if (noteBefore) {
        this.updateAnnot(a.id, { note: ta.value }, { history: false });
        this.undoStack.push(noteBefore);
        this.redoStack = [];
        noteBefore = null;
        this.updateToolbar();
      }
    });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.hidePop();
    });
    const editBox = h('div', { class: edit || a.note || a.type === 'note' ? '' : 'hidden' }, ta);
    pop.append(
      a.text ? h('div', { class: 'pop-quote' }, `“${a.text}”`) : null,
      h('div', { class: 'row' },
        this.dots(a.color, (c) => {
          this.updateAnnot(a.id, { color: c });
          pop.querySelectorAll('.r-dots button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.c === c)));
        }),
        h('div', { class: 'r-sep' }),
        a.type !== 'note' ? iconButton('comment', 'Comment', () => { editBox.classList.remove('hidden'); ta.focus(); }) : null,
        a.text ? iconButton('copy', 'Copy text', async () => {
          try {
            await navigator.clipboard.writeText(a.text);
            toast('Copied');
          } catch { /* ignore */ }
        }) : null,
        iconButton('trash', 'Delete (Del)', () => { this.hidePop(); this.deleteAnnot(a.id); }),
      ),
      editBox,
    );
    this.placePop(pop, box, 'below');
    if (edit || a.type === 'note') setTimeout(() => ta.focus({ preventScroll: true }), 30);
  }

  makePop(onClose) {
    this.hidePop();
    const pop = h('div', { class: 'r-pop', role: 'dialog' });
    pop.addEventListener('pointerdown', (e) => e.stopPropagation());
    pop.addEventListener('mousedown', (e) => {
      if (!e.target.closest('textarea')) e.preventDefault(); // keep the text selection alive
    });
    this.pop = pop;
    this.popClose = onClose;
    document.body.append(pop);
    return pop;
  }

  placePop(pop, box, pref = 'above') {
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const cx = (box.left + box.right) / 2;
    const left = clamp(cx - pw / 2, 8, window.innerWidth - pw - 8);
    let top = pref === 'above' ? box.top - ph - 10 : box.bottom + 10;
    if (top < 64) top = box.bottom + 10;
    if (top + ph > window.innerHeight - 8) top = Math.max(64, box.top - ph - 10);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  hidePop() {
    if (this.pop) {
      if (this.pop.contains(document.activeElement)) document.activeElement.blur();
      this.pop.remove();
      this.pop = null;
      const c = this.popClose;
      this.popClose = null;
      c?.();
    }
  }

  // ================================================================ pen & eraser
  bindDraw(p) {
    let stroke = null;
    let erased = null;
    const pt = (e) => this.clientToPage(p, e.clientX, e.clientY);
    p.draw.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      e.preventDefault();
      p.draw.setPointerCapture(e.pointerId);
      this.hidePop();
      if (this.tool === 'pen') {
        stroke = { pts: [pt(e)], el: svg('path', { fill: 'none', stroke: this.prefs.colors.pen, 'stroke-width': this.prefs.penWidth, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }) };
        p.svg.append(stroke.el);
      } else if (this.tool === 'eraser') {
        erased = { before: this.snapshot(), count: 0 };
        this.eraseAt(p, ...pt(e), erased);
      }
    });
    p.draw.addEventListener('pointermove', (e) => {
      if (stroke) {
        const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
        for (const ev of evs.length ? evs : [e]) {
          const q = pt(ev);
          const last = stroke.pts[stroke.pts.length - 1];
          if (Math.hypot(q[0] - last[0], q[1] - last[1]) > 0.6 / this.scale) stroke.pts.push(q);
        }
        stroke.el.setAttribute('d', smoothPath(stroke.pts));
      } else if (erased) this.eraseAt(p, ...pt(e), erased);
    });
    const end = () => {
      if (stroke) {
        const pts = simplify(stroke.pts, 0.35);
        stroke.el.remove();
        stroke = null;
        if (pts.length) {
          this.addAnnot({ page: p.index, type: 'ink', color: this.prefs.colors.pen, width: this.prefs.penWidth, paths: [pts.map(([x, y]) => this.toPdf(p, x, y))] });
        }
      }
      if (erased) {
        if (erased.count) this.commit(erased.before, null);
        erased = null;
      }
    };
    p.draw.addEventListener('pointerup', end);
    p.draw.addEventListener('pointercancel', end);
  }

  eraseAt(p, vx, vy, state) {
    const a = this.hitTest(p, vx, vy);
    if (a) {
      this.annots = this.annots.filter((x) => x.id !== a.id);
      state.count++;
      this.drawAnnots(p);
    }
  }

  // ================================================================ input handling
  bindGlobal() {
    const on = this.on;
    let down = null;
    on(this.viewer, 'pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, type: e.pointerType };
      if (!e.target.closest('.r-pop')) this.hidePop();
    });
    on(this.viewer, 'pointerup', (e) => {
      if (!down || !this.pdf) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5;
      const wasTouch = down.type === 'touch';
      down = null;
      if (this.tool === 'pen' || this.tool === 'eraser') return;
      if (e.target.closest('.r-links a')) return;
      const sel = window.getSelection();
      const hasSel = sel && !sel.isCollapsed && sel.rangeCount && this.pagesEl.contains(sel.anchorNode);
      if (hasSel && !wasTouch) {
        setTimeout(() => this.onSelectionDone(), 0);
        return;
      }
      if (moved || hasSel) return;
      const p = this.pageAtClient(e.clientX, e.clientY);
      if (!p) return;
      const [vx, vy] = this.clientToPage(p, e.clientX, e.clientY);
      if (this.tool === 'note') {
        const [x, y] = this.toPdf(p, vx - NOTE_SIZE / 2, vy - NOTE_SIZE / 2);
        const a = this.addAnnot({ page: p.index, type: 'note', color: this.prefs.colors.note, at: [x, y], note: '', text: '' });
        this.setTool('select');
        this.selectAnnot(a, { edit: true });
        return;
      }
      const hit = this.hitTest(p, vx, vy);
      if (hit) this.selectAnnot(hit);
      else if (this.selectedId) {
        const old = this.annots.find((a) => a.id === this.selectedId);
        this.selectedId = null;
        if (old) this.redraw([old.page]);
      }
    });

    // touch selection: act once the selection has settled
    let selTimer;
    on(document, 'selectionchange', () => {
      this.updateSelecting();
      if (!isTouch()) return;
      clearTimeout(selTimer);
      selTimer = setTimeout(() => {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && this.pagesEl.contains(sel.anchorNode)) this.onSelectionDone();
      }, 500);
    });

    let scrollTimer;
    on(this.viewer, 'scroll', () => {
      this.updatePageIndicator();
      if (this.pop && !this.pop.contains(document.activeElement)) this.hidePop();
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => this.saveDraft(), 1000);
    }, { passive: true });

    let resizeTimer;
    on(window, 'resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (this.fitMode && this.pdf) this.fitWidth();
      }, 150);
    });

    // ctrl + wheel / trackpad pinch
    on(this.viewer, 'wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      this.zoomBy(Math.exp(-e.deltaY * 0.0025), { x: e.clientX, y: e.clientY });
    }, { passive: false });

    // touch pinch zoom
    let pinch = null;
    on(this.viewer, 'touchstart', (e) => {
      if (e.touches.length === 2 && this.pdf) {
        const [a, b] = e.touches;
        pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2, f: 1 };
        const vr = this.viewer.getBoundingClientRect();
        this.pagesEl.style.transformOrigin = `${pinch.cx - vr.left + this.viewer.scrollLeft}px ${pinch.cy - vr.top + this.viewer.scrollTop}px`;
      }
    }, { passive: true });
    on(this.viewer, 'touchmove', (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const [a, b] = e.touches;
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      pinch.f = clamp(d / pinch.d, MIN_SCALE / this.scale, MAX_SCALE / this.scale);
      this.pagesEl.style.transform = `scale(${pinch.f})`;
    }, { passive: false });
    const endPinch = () => {
      if (!pinch) return;
      const { f, cx, cy } = pinch;
      pinch = null;
      this.pagesEl.style.transform = '';
      if (Math.abs(f - 1) > 0.02) this.zoomBy(f, { x: cx, y: cy });
    };
    on(this.viewer, 'touchend', (e) => { if (e.touches.length < 2) endPinch(); });
    on(this.viewer, 'touchcancel', endPinch);

    on(document, 'keydown', (e) => this.onKey(e));
    on(document, 'copy', (e) => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !this.pagesEl.contains(sel.anchorNode)) return;
      e.clipboardData.setData('text/plain', sel.toString().replace(/\u0000/g, ''));
      e.preventDefault();
    });

    this.beforeUnload = (e) => {
      if (this.unsaved && !this.prefs.remember) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', this.beforeUnload);
  }

  // Port of pdf.js' selection helper: keeps drag-selection smooth across
  // absolutely positioned text spans.
  registerTextLayer(div, end) {
    this.textLayers ??= new Map();
    this.textLayers.set(div, end);
    div.addEventListener('mousedown', () => div.classList.add('selecting'));
    if (this.selBound) return;
    this.selBound = true;
    this.selReset = (endDiv, layer) => {
      layer.append(endDiv);
      endDiv.style.width = '';
      endDiv.style.height = '';
      endDiv.style.userSelect = '';
      layer.classList.remove('selecting');
    };
    this.on(document, 'pointerdown', () => { this.pointerIsDown = true; });
    this.on(document, 'pointerup', () => {
      this.pointerIsDown = false;
      this.textLayers.forEach(this.selReset);
    });
    this.on(window, 'blur', () => {
      this.pointerIsDown = false;
      this.textLayers.forEach(this.selReset);
    });
  }

  updateSelecting() {
    if (!this.textLayers?.size) return;
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) {
      this.textLayers.forEach(this.selReset);
      return;
    }
    const range = sel.getRangeAt(0);
    if (range.collapsed && !this.pointerIsDown) return;
    for (const [layer, endDiv] of this.textLayers) {
      if (range.intersectsNode(layer)) layer.classList.add('selecting');
      else this.selReset(endDiv, layer);
    }
    // older Chromium / WebKit: move the end-of-content element next to the
    // selection focus so dragging into empty space doesn't grab the whole page
    const chromium = /\bChrome\/(\d+)\b/.exec(navigator.userAgent)?.[1];
    const modern = CSS.supports('-moz-user-select', 'none') || (chromium && parseInt(chromium, 10) >= 148);
    if (modern) return;
    let anchor = range.endContainer;
    if (anchor.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
    if (range.endOffset === 0 && anchor.previousSibling) anchor = anchor.previousSibling;
    const layer = anchor.parentElement?.closest('.textLayer');
    const endDiv = layer && this.textLayers.get(layer);
    if (endDiv && anchor.parentElement === layer) {
      endDiv.style.width = layer.style.width;
      endDiv.style.height = layer.style.height;
      endDiv.style.userSelect = 'text';
      layer.insertBefore(endDiv, anchor.nextSibling);
    }
  }

  onKey(e) {
    if (!this.pdf) return;
    const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'f') {
      e.preventDefault();
      this.toggleSearch(true);
      return;
    }
    if (mod && key === 's') {
      e.preventDefault();
      this.save();
      return;
    }
    if (typing) return;
    if (mod && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && key === 'y') {
      e.preventDefault();
      this.redo();
      return;
    }
    if (mod && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      this.zoomBy(1.2);
      return;
    }
    if (mod && e.key === '-') {
      e.preventDefault();
      this.zoomBy(1 / 1.2);
      return;
    }
    if (mod && e.key === '0') {
      e.preventDefault();
      this.fitWidth();
      return;
    }
    if (mod || e.altKey) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedId) {
      e.preventDefault();
      const id = this.selectedId;
      this.hidePop();
      this.deleteAnnot(id);
      return;
    }
    if (e.key === 'Escape') {
      this.hidePop();
      if (this.tool !== 'select') this.setTool('select');
      return;
    }
    const map = { v: 'select', h: 'highlight', u: 'underline', s: 'strike', n: 'note', p: 'pen', e: 'eraser' };
    const t = map[key];
    if (t) {
      this.setTool(t === this.tool ? 'select' : t);
      return;
    }
    if (e.key === 'PageDown' || e.key === 'PageUp' || e.key === ' ') {
      e.preventDefault();
      const dir = e.key === 'PageUp' || (e.key === ' ' && e.shiftKey) ? -1 : 1;
      this.viewer.scrollBy({ top: dir * this.viewer.clientHeight * 0.9, behavior: 'smooth' });
    }
  }

  // ================================================================ zoom & navigation
  fitWidth() {
    if (!this.pages.length) return;
    const avail = this.viewer.clientWidth - (window.innerWidth <= 760 ? 12 : 48);
    const maxW = Math.max(...this.pages.map((p) => p.vp1.width));
    this.setScale(clamp(Math.min(avail, 1000) / maxW, MIN_SCALE, MAX_SCALE));
    this.fitMode = true;
  }

  zoomBy(f, anchor) {
    this.setScale(clamp(this.scale * f, MIN_SCALE, MAX_SCALE), anchor);
    this.fitMode = false;
  }

  setScale(s, anchor) {
    if (!this.pages.length) return;
    const v = this.viewer;
    const vr = v.getBoundingClientRect();
    const ax = anchor ? anchor.x - vr.left : v.clientWidth / 2;
    const ay = anchor ? anchor.y - vr.top : 0;
    const old = this.scale;
    const contentX = (v.scrollLeft + ax) / old;
    const contentY = (v.scrollTop + ay) / old;
    this.scale = s;
    this.applyScale();
    v.scrollLeft = contentX * s - ax;
    v.scrollTop = contentY * s - ay;
    this.hidePop();
    clearTimeout(this.zoomTimer);
    this.zoomTimer = setTimeout(() => {
      for (const p of this.pages) if (p.search?.length && p.textLayer) this.drawSearchHits(p);
      this.scheduleRender();
    }, 120);
  }

  currentPageIndex() {
    if (!this.pages.length || !this.pages[0].el) return 0;
    const mid = this.viewer.scrollTop + this.viewer.clientHeight * 0.35;
    let lo = 0;
    let hi = this.pages.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (this.pages[m].el.offsetTop <= mid) lo = m;
      else hi = m - 1;
    }
    return lo;
  }

  updatePageIndicator(force) {
    const i = this.currentPageIndex();
    if (force || i !== this.curPage) {
      this.curPage = i;
      if (document.activeElement !== this.pageInput) this.pageInput.value = String(i + 1);
      if (this.tab === 'pages') this.highlightThumb(i);
    }
  }

  goToPage(i, { smooth = true, offsetY = 0 } = {}) {
    const p = this.pages[i];
    if (!p) return;
    this.viewer.scrollTo({ top: p.el.offsetTop - 12 + offsetY, behavior: smooth ? 'smooth' : 'auto' });
    if (window.innerWidth <= 760) this.toggleSide(false, false);
  }

  async goToDest(dest) {
    try {
      const explicit = typeof dest === 'string' ? await this.pdf.getDestination(dest) : dest;
      if (!Array.isArray(explicit)) return;
      const [ref] = explicit;
      const index = typeof ref === 'object' && ref ? await this.pdf.getPageIndex(ref) : Number(ref);
      const p = this.pages[index];
      if (!p) return;
      let offsetY = 0;
      const kind = explicit[1]?.name;
      const yArg = kind === 'XYZ' ? explicit[3] : kind === 'FitH' || kind === 'FitBH' ? explicit[2] : null;
      if (yArg != null) {
        const [, vy] = this.toView(p, kind === 'XYZ' ? explicit[2] || 0 : 0, yArg);
        offsetY = Math.max(0, vy * this.scale - 10);
      }
      this.goToPage(index, { offsetY });
    } catch (e) {
      console.warn('Bad destination', e);
    }
  }

  // ================================================================ sidebar
  toggleSide(force, save = true) {
    const open = force ?? this.el.classList.contains('side-closed');
    this.el.classList.toggle('side-closed', !open);
    this.sideBtn.setAttribute('aria-pressed', String(open));
    if (save) {
      this.prefs.side = open;
      this.savePrefs();
    }
    if (open) this.refreshSide();
    if (this.fitMode && this.pdf && window.innerWidth > 760) setTimeout(() => this.fitWidth(), 220);
  }

  showTab(id) {
    this.tab = id;
    for (const [k, b] of Object.entries(this.tabBtns)) b.setAttribute('aria-selected', String(k === id));
    this.refreshSide();
  }

  refreshSide() {
    if (this.el.classList.contains('side-closed')) return;
    if (!this.pdf) {
      this.panel.replaceChildren(h('div', { class: 'r-empty' }, 'Open a PDF to see its pages.'));
      return;
    }
    if (this.tab === 'pages') this.renderThumbs();
    else if (this.tab === 'outline') this.renderOutline();
    else this.renderNotesPanel();
  }

  renderThumbs() {
    this.thumbIO?.disconnect();
    const list = h('div', { class: 'r-thumbs' });
    this.thumbEls = [];
    this.thumbIO = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target;
        this.thumbIO.unobserve(el);
        const i = Number(el.dataset.index);
        const cached = this.thumbCache.get(i);
        if (cached) {
          el.querySelector('.tbox').replaceChildren(cached);
          continue;
        }
        const pdf = this.pdf;
        queueThumb(async () => {
          if (this.pdf !== pdf) return null;
          const page = await pdf.getPage(i + 1);
          const vp = page.getViewport({ scale: (150 / page.getViewport({ scale: 1 }).width) * Math.min(devicePixelRatio || 1, 2) });
          const c = document.createElement('canvas');
          c.width = Math.floor(vp.width);
          c.height = Math.floor(vp.height);
          await page.render({ canvasContext: c.getContext('2d'), canvas: c, viewport: vp, annotationMode: AnnotationMode.DISABLE }).promise;
          if (!this.visible?.has(this.pages[i])) page.cleanup();
          return canvasToImage(c);
        }).then((img) => {
          if (!img) return;
          if (this.pdf !== pdf) return releaseImage(img);
          this.thumbCache.set(i, img);
          el.querySelector('.tbox').replaceChildren(img);
        }).catch(() => {});
      }
    }, { root: this.panel, rootMargin: '300px 0px' });
    for (const p of this.pages) {
      const el = h('div', { class: 'r-thumb', dataset: { index: String(p.index) }, onClick: () => this.goToPage(p.index) },
        h('div', { class: 'tbox', style: { aspectRatio: `${p.vp1.width} / ${p.vp1.height}` } }),
        h('span', null, String(p.index + 1)));
      this.thumbEls.push(el);
      list.append(el);
      this.thumbIO.observe(el);
    }
    this.panel.replaceChildren(list);
    this.highlightThumb(this.currentPageIndex(), true);
  }

  highlightThumb(i, scroll) {
    if (!this.thumbEls || this.el.classList.contains('side-closed')) return;
    this.thumbEls.forEach((el, k) => el.classList.toggle('current', k === i));
    const el = this.thumbEls[i];
    if (el && (scroll || this.tab === 'pages')) {
      const pr = this.panel.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      if (er.top < pr.top || er.bottom > pr.bottom) el.scrollIntoView({ block: 'center' });
    }
  }

  async renderOutline() {
    this.panel.replaceChildren(h('div', { class: 'r-empty' }, icon('spinner', 18, 'spin')));
    let outline = null;
    try {
      outline = await this.pdf.getOutline();
    } catch {
      /* none */
    }
    if (this.tab !== 'outline') return;
    if (!outline?.length) {
      this.panel.replaceChildren(h('div', { class: 'r-empty' }, 'This PDF has no outline (bookmarks).'));
      return;
    }
    const build = (items) => h('ul', null, items.map((it) => h('li', null,
      h('a', { onClick: () => { if (it.dest) this.goToDest(it.dest); else if (it.url) window.open(it.url, '_blank', 'noopener'); } }, it.title || 'Untitled'),
      it.items?.length ? build(it.items) : null)));
    const tree = build(outline);
    tree.classList.add('r-outline');
    this.panel.replaceChildren(tree);
  }

  renderNotesPanel() {
    const list = [...this.annots].sort((a, b) => a.page - b.page || annotBounds(b)[3] - annotBounds(a)[3]);
    if (!list.length) {
      this.panel.replaceChildren(h('div', { class: 'r-empty' }, 'No highlights or notes yet.', h('br'), h('br'), 'Select text and pick a colour, or use the tools at the bottom.'));
      return;
    }
    const actions = h('div', { class: 'r-notes-actions' },
      button('Export Markdown', { size: 'sm', icon: 'download', onClick: () => this.exportMarkdown() }),
      button('Copy', { size: 'sm', icon: 'copy', onClick: () => this.copyMarkdown() }),
    );
    const typeName = { highlight: 'Highlight', underline: 'Underline', strike: 'Strike', ink: 'Drawing', note: 'Note' };
    this.panel.replaceChildren(actions, ...list.map((a) => h('div', {
      class: 'r-note-item',
      onClick: () => {
        const p = this.pages[a.page];
        const [, y0] = this.rectToView(p, annotBounds(a));
        this.goToPage(a.page, { offsetY: Math.max(0, y0 * this.scale - 120) });
        setTimeout(() => this.selectAnnot(a), 500);
      },
    },
    h('div', { class: 'sw', style: { background: a.color } }),
    h('div', { class: 'body' },
      h('div', { class: 'meta' }, `${typeName[a.type]} · p. ${a.page + 1}`),
      a.text ? h('div', { class: 'quote' }, a.text) : null,
      a.note ? h('div', { class: 'comment' }, a.note) : null,
    ))));
  }

  markdown() {
    return annotationsToMarkdown(this.annots, this.name.replace(/\.pdf$/i, ''));
  }

  exportMarkdown() {
    if (!this.annots.length) return toast('No highlights yet');
    downloadBlob(new Blob([this.markdown()], { type: 'text/markdown;charset=utf-8' }), `${this.name.replace(/\.pdf$/i, '')}-notes.md`);
  }

  async copyMarkdown() {
    if (!this.annots.length) return toast('No highlights yet');
    try {
      await navigator.clipboard.writeText(this.markdown());
      toast('Highlights copied as Markdown', 'success');
    } catch {
      toast('Copy failed — use Export instead', 'error');
    }
  }

  // ================================================================ search
  toggleSearch(open) {
    if (!this.pdf) return;
    this.searchBar.classList.toggle('hidden', !open);
    if (open) {
      this.searchInput.focus();
      this.searchInput.select();
      if (this.searchInput.value) this.runSearch(this.searchInput.value);
    } else {
      this.searchToken = (this.searchToken || 0) + 1;
      this.search = null;
      for (const p of this.pages) {
        p.search = null;
        p.hits.replaceChildren();
      }
      this.searchCount.textContent = '';
      this.viewer.focus({ preventScroll: true });
    }
  }

  async runSearch(q) {
    const token = (this.searchToken = (this.searchToken || 0) + 1);
    for (const p of this.pages) {
      p.search = null;
      p.hits.replaceChildren();
    }
    q = q.trim();
    if (!q) {
      this.search = null;
      this.searchCount.textContent = '';
      return;
    }
    const pattern = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'gi');
    const matches = [];
    this.search = { q, matches, index: -1 };
    this.searchCount.textContent = 'Searching…';
    const cur = this.currentPageIndex();
    for (const p of this.pages) {
      const tc = await this.getText(p);
      if (token !== this.searchToken) return;
      if (!p.searchText) {
        let s = '';
        p.itemOffsets = [];
        for (const it of tc.items) {
          p.itemOffsets.push(s.length);
          s += it.str || '';
          if (it.hasEOL) s += '\n';
        }
        p.searchText = s;
      }
      pattern.lastIndex = 0;
      let m;
      const pageMatches = [];
      while ((m = pattern.exec(p.searchText))) {
        pageMatches.push({ page: p.index, start: m.index, end: m.index + m[0].length });
        if (m[0].length === 0) pattern.lastIndex++;
      }
      p.search = pageMatches;
      matches.push(...pageMatches);
      if (p.textLayer) this.drawSearchHits(p);
      if (p.index % 20 === 19) this.searchCount.textContent = `${matches.length} found…`;
    }
    if (token !== this.searchToken) return;
    if (!matches.length) {
      this.searchCount.textContent = 'No matches';
      return;
    }
    const first = matches.findIndex((mm) => mm.page >= cur);
    this.search.index = (first >= 0 ? first : 0) - 1;
    this.stepSearch(1);
  }

  stepSearch(dir) {
    const s = this.search;
    if (!s?.matches.length) return;
    s.index = (s.index + dir + s.matches.length) % s.matches.length;
    const m = s.matches[s.index];
    this.searchCount.textContent = `${s.index + 1} of ${s.matches.length}`;
    const p = this.pages[m.page];
    for (const q of this.pages) if (q.search?.length && q.textLayer) this.drawSearchHits(q);
    const scrollToHit = () => {
      const el = p.hits.querySelector('.current');
      if (el) el.scrollIntoView({ block: 'center', inline: 'nearest' });
    };
    if (p.textLayer) scrollToHit();
    else {
      this.goToPage(m.page, { smooth: false });
      let tries = 0;
      const wait = () => {
        if (p.textLayer) {
          this.drawSearchHits(p);
          scrollToHit();
        } else if (tries++ < 60) setTimeout(wait, 80);
      };
      setTimeout(wait, 80);
    }
  }

  drawSearchHits(p) {
    p.hits.replaceChildren();
    if (!p.search?.length || !p.textDivs) return;
    const pr = p.el.getBoundingClientRect();
    const cur = this.search?.matches[this.search.index];
    for (const m of p.search) {
      const range = this.offsetsToRange(p, m.start, m.end);
      if (!range) continue;
      for (const r of range.getClientRects()) {
        if (r.width < 0.5 || r.height < 0.5) continue;
        p.hits.append(h('div', {
          class: cur && cur.page === m.page && cur.start === m.start ? 'current' : '',
          style: { left: `${((r.left - pr.left) / pr.width) * 100}%`, top: `${((r.top - pr.top) / pr.height) * 100}%`, width: `${(r.width / pr.width) * 100}%`, height: `${(r.height / pr.height) * 100}%` },
        }));
      }
    }
  }

  offsetsToRange(p, start, end) {
    const offs = p.itemOffsets;
    const locate = (pos, isEnd) => {
      let lo = 0;
      let hi = offs.length - 1;
      const target = isEnd ? pos - 1 : pos;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (offs[mid] <= target) lo = mid;
        else hi = mid - 1;
      }
      let k = lo;
      while (k >= 0 && k < offs.length && !p.textDivs[k]?.firstChild) k += isEnd ? -1 : 1;
      if (k < 0 || k >= offs.length) return null;
      const node = p.textDivs[k].firstChild;
      return [node, clamp(pos - offs[k], 0, node.length)];
    };
    const a = locate(start, false);
    const b = locate(end, true);
    if (!a || !b) return null;
    const range = document.createRange();
    try {
      range.setStart(a[0], a[1]);
      range.setEnd(b[0], b[1]);
    } catch {
      return null;
    }
    return range;
  }

  // ================================================================ menu
  showMenu(anchor) {
    if (this.menu) {
      this.closeMenu?.();
      return;
    }
    const outside = (e) => {
      if (!this.menu?.contains(e.target) && !anchor.contains(e.target)) close();
    };
    const close = () => {
      this.menu?.remove();
      this.menu = null;
      document.removeEventListener('pointerdown', outside, true);
    };
    this.closeMenu = close;
    const item = (ic, label, fn) => h('button', { role: 'menuitem', onClick: () => { close(); fn(); } }, icon(ic, 18), label);
    const fileInput = h('input', { type: 'file', accept: 'application/pdf,.pdf', hidden: true });
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files?.[0];
      if (f) this.open({ bytes: await readFile(f), name: f.name });
    });
    document.body.append(fileInput);
    const menu = h('div', { class: 'r-menu', role: 'menu' },
      item('open', 'Open another PDF…', () => { fileInput.click(); setTimeout(() => fileInput.remove(), 60000); }),
      this.pdf ? item('download', 'Download PDF with annotations', () => this.save()) : null,
      this.pdf && navigator.canShare ? item('external', 'Share / save to Files…', () => this.save({ share: true })) : null,
      this.pdf ? item('comment', 'Export highlights (Markdown)', () => this.exportMarkdown()) : null,
      this.pdf ? h('div', { class: 'r-show-sm' },
        h('hr'),
        item('zoomIn', 'Zoom in', () => this.zoomBy(1.25)),
        item('zoomOut', 'Zoom out', () => this.zoomBy(0.8)),
        item('fit', 'Fit width', () => this.fitWidth()),
      ) : null,
      h('hr'),
      h('div', { class: 'menu-label' }, 'Page colours'),
      segmented([{ value: 'normal', label: 'Normal' }, { value: 'sepia', label: 'Sepia' }, { value: 'night', label: 'Night' }], this.prefs.theme, (v) => {
        this.prefs.theme = v;
        this.savePrefs();
        this.applyTheme();
      }),
      h('div', { class: 'menu-label' }, 'Text selection'),
      item(this.prefs.columns ? 'checked' : 'unchecked', 'Column-aware order (two-column papers)', () => {
        this.prefs.columns = !this.prefs.columns;
        this.savePrefs();
        if (this.pdf) this.rebuildTextLayers();
        toast(this.prefs.columns ? 'Selection follows the columns' : 'Selection follows the file’s own order');
      }),
      h('div', { class: 'menu-label' }, 'Privacy'),
      item(this.prefs.remember ? 'checked' : 'unchecked', 'Remember annotations & last page here', () => {
        this.prefs.remember = !this.prefs.remember;
        this.savePrefs();
        if (!this.prefs.remember && this.fp) kvDelete(`doc:${this.fp}`);
        toast(this.prefs.remember ? 'Drafts are kept in this browser only' : 'Nothing will be remembered');
      }),
      item('trash', 'Forget everything stored in this browser', () => {
        modal({
          title: 'Clear stored data?',
          body: h('p', { class: 'muted' }, 'This removes the drafts, last-read pages and preferences that CutePDF keeps in this browser. Your PDF files are not affected.'),
          actions: [{ label: 'Cancel' }, { label: 'Clear', variant: 'primary', icon: 'trash', onClick: () => { kvClear(); try { localStorage.clear(); } catch { /* ignore */ } toast('Cleared', 'success'); } }],
        });
      }),
      h('hr'),
      item('info', 'Keyboard shortcuts', () => this.showShortcuts()),
    );
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.left = `${clamp(r.right - menu.offsetWidth, 8, window.innerWidth - menu.offsetWidth - 8)}px`;
    this.menu = menu;
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  }

  showShortcuts() {
    const rows = [
      ['V · H · U · S', 'Select · Highlight · Underline · Strike'],
      ['N · P · E', 'Note · Pen · Eraser'],
      ['Ctrl F', 'Find'], ['Ctrl S', 'Download with annotations'], ['Ctrl Z / Ctrl Shift Z', 'Undo / Redo'],
      ['Ctrl + / − / 0', 'Zoom in / out / fit'], ['Del', 'Delete selected annotation'], ['Esc', 'Back to select'],
    ];
    modal({ title: 'Keyboard shortcuts', body: h('div', { class: 'stack', style: { gap: '8px' } }, rows.map(([k, d]) => h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('span', { class: 'kbd' }, k), h('span', { class: 'muted small' }, d)))) });
  }

  applyTheme() {
    this.el.classList.remove('theme-normal', 'theme-sepia', 'theme-night');
    this.el.classList.add(`theme-${this.prefs.theme}`);
  }

  // ================================================================ save
  async save({ share = false } = {}) {
    if (!this.pdf) return;
    const btn = this.saveBtn;
    btn.disabled = true;
    try {
      let bytes = this.bytes;
      const touched = this.annots.some((a) => !a.ref || a.dirty) || [...this.importedIds].some((id) => !this.annots.some((a) => a.ref === id));
      if (touched) bytes = await exportAnnotatedPdf(this.bytes, this.annots, this.importedIds);
      const name = /\.pdf$/i.test(this.name) ? this.name : `${this.name}.pdf`;
      let shared = false;
      if (share && navigator.canShare) {
        const file = new File([bytes], name, { type: 'application/pdf' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: name });
          shared = true;
        }
      }
      if (!shared) downloadBlob(bytes, name);
      this.markUnsaved(false);
      this.saveDraft(true);
      if (touched) toast('Saved — your highlights and notes are inside the PDF', 'success');
    } catch (e) {
      if (e?.name === 'AbortError') return;
      console.error(e);
      toast(errorText(e), 'error', 7000);
    } finally {
      btn.disabled = false;
    }
  }
}

// ------------------------------------------------------------------ helpers
function distToSeg(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? clamp(((px - ax) * dx + (py - ay) * dy) / len, 0, 1) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function smoothPath(pts) {
  if (!pts.length) return '';
  const f = (n) => n.toFixed(2);
  if (pts.length < 3) return `M${f(pts[0][0])} ${f(pts[0][1])}${pts.length === 1 ? ' l0.01 0' : ` L${f(pts[1][0])} ${f(pts[1][1])}`}`;
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q${f(pts[i][0])} ${f(pts[i][1])} ${f(mx)} ${f(my)}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${f(last[0])} ${f(last[1])}`;
}

// Ramer–Douglas–Peucker line simplification
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  let maxD = 0;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSeg(pts[i][0], pts[i][1], pts[0], pts[pts.length - 1]);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD > eps) {
    const a = simplify(pts.slice(0, idx + 1), eps);
    const b = simplify(pts.slice(idx), eps);
    return [...a.slice(0, -1), ...b];
  }
  return [pts[0], pts[pts.length - 1]];
}
