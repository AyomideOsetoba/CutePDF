import {
  createElement,
  ArrowLeft, BookOpen, ScanText, Minimize2, Combine, Scissors, LayoutGrid, FileType, Images, Image as ImageIcon,
  Upload, Download, X, Check, ChevronLeft, ChevronRight, ChevronDown, ZoomIn, ZoomOut, Search, Highlighter, Underline,
  Strikethrough, PenLine, StickyNote, MousePointer2, Undo2, Redo2, Sidebar as PanelLeft, ListTree, MessageSquare, Trash2, Copy,
  FileDown, Sun, Moon, Monitor, ShieldCheck, WifiOff, Sparkle as Sparkles, RotateCw, RotateCcw, GripVertical, Plus, FileText,
  LoaderCircle, Info, TriangleExclamationPoint as TriangleAlert, Camera, Columns2, Eye, Settings2, Lock, MoreHorizontal, Maximize2, BookMarked,
  ArrowUp, Palette, Type, Eraser, ExternalLink, FolderOpen, SquareCheck, Square as SquareIcon, Layers2, ArrowUpDown,
} from 'lucide';

const ICONS = {
  back: ArrowLeft, read: BookOpen, ocr: ScanText, compress: Minimize2, merge: Combine, split: Scissors,
  organize: LayoutGrid, word: FileType, images: Images, image: ImageIcon, upload: Upload, download: Download,
  close: X, check: Check, left: ChevronLeft, right: ChevronRight, down: ChevronDown, zoomIn: ZoomIn, zoomOut: ZoomOut,
  search: Search, highlight: Highlighter, underline: Underline, strike: Strikethrough, pen: PenLine, note: StickyNote,
  select: MousePointer2, undo: Undo2, redo: Redo2, sidebar: PanelLeft, outline: ListTree, comment: MessageSquare,
  trash: Trash2, copy: Copy, save: FileDown, sun: Sun, moon: Moon, auto: Monitor, shield: ShieldCheck, offline: WifiOff,
  sparkles: Sparkles, rotateCw: RotateCw, rotateCcw: RotateCcw, grip: GripVertical, plus: Plus, file: FileText,
  spinner: LoaderCircle, info: Info, warn: TriangleAlert, camera: Camera, columns: Columns2, eye: Eye, settings: Settings2,
  lock: Lock, more: MoreHorizontal, fit: Maximize2, bookmarks: BookMarked, palette: Palette, type: Type,
  eraser: Eraser, external: ExternalLink, open: FolderOpen, checked: SquareCheck, unchecked: SquareIcon, layers: Layers2,
  sort: ArrowUpDown, up: ArrowUp,
};

export function icon(name, size = 20, cls = '') {
  const node = ICONS[name] || Info;
  const svg = createElement(node, { width: size, height: size, 'stroke-width': 2, 'aria-hidden': 'true' });
  svg.classList.add('icon');
  if (cls) svg.classList.add(...cls.split(' '));
  return svg;
}

/** Tiny hyperscript helper. */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v)) {
          if (sk.startsWith('--')) el.style.setProperty(sk, sv);
          else el.style[sk] = sv;
        }
      }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function button(label, { icon: ic, variant = 'secondary', size, onClick, title, type = 'button', disabled, cls = '' } = {}) {
  const b = h('button', {
    type,
    class: `btn btn-${variant}${size ? ` btn-${size}` : ''}${label ? '' : ' btn-icon'} ${cls}`.trim(),
    title: title || (typeof label === 'string' ? undefined : undefined),
    'aria-label': title || (typeof label === 'string' ? label : undefined),
    disabled,
    onClick,
  });
  if (ic) b.append(icon(ic, size === 'sm' ? 16 : 18));
  if (label) b.append(h('span', null, label));
  return b;
}

export function iconButton(ic, title, onClick, { cls = '', pressed } = {}) {
  const b = h('button', { type: 'button', class: `icon-btn ${cls}`.trim(), title, 'aria-label': title, onClick });
  if (pressed !== undefined) b.setAttribute('aria-pressed', String(!!pressed));
  b.append(icon(ic, 19));
  return b;
}

// ---------------------------------------------------------------- toasts
let toastHost;
export function toast(message, type = 'info', ms = 3800) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const t = h('div', { class: `toast toast-${type}` }, icon(type === 'error' ? 'warn' : type === 'success' ? 'check' : 'info', 18), h('span', null, message));
  toastHost.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

// ---------------------------------------------------------------- modal
export function modal({ title, body, actions = [], onClose, wide }) {
  const close = () => {
    overlay.classList.remove('show');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => overlay.remove(), 200);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  const dialog = h('div', { class: `modal${wide ? ' modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', null, title), iconButton('close', 'Close', close)),
    h('div', { class: 'modal-body' }, body),
    actions.length ? h('div', { class: 'modal-actions' }, actions.map((a) => button(a.label, { variant: a.variant || 'secondary', icon: a.icon, onClick: () => { if (a.onClick?.() !== false) close(); } }))) : null,
  );
  const overlay = h('div', { class: 'modal-overlay', onClick: (e) => { if (e.target === overlay) close(); } }, dialog);
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  requestAnimationFrame(() => overlay.classList.add('show'));
  const focusable = dialog.querySelector('input, textarea, select, .btn-primary');
  setTimeout(() => focusable?.focus(), 50);
  return { close, dialog };
}

export function promptPassword(fileName) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'password', class: 'input', placeholder: 'Password', autocomplete: 'off' });
    let done = false;
    const m = modal({
      title: 'Password required',
      body: [h('p', { class: 'muted' }, `“${fileName}” is password-protected. The password is only used here in your browser.`), input],
      actions: [
        { label: 'Cancel', onClick: () => { done = true; resolve(null); } },
        { label: 'Unlock', variant: 'primary', icon: 'lock', onClick: () => { done = true; resolve(input.value); } },
      ],
      onClose: () => { if (!done) resolve(null); },
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { done = true; resolve(input.value); m.close(); }
    });
  });
}

// ---------------------------------------------------------------- dropzone
export function dropzone({ accept = 'application/pdf,.pdf', multiple = false, title, hint, onFiles, camera = false }) {
  const input = h('input', { type: 'file', accept, multiple, hidden: true });
  input.addEventListener('change', () => {
    if (input.files?.length) onFiles([...input.files]);
    input.value = '';
  });
  const cam = camera ? h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true }) : null;
  cam?.addEventListener('change', () => {
    if (cam.files?.length) onFiles([...cam.files]);
    cam.value = '';
  });
  const zone = h('div', { class: 'dropzone', tabindex: '0', role: 'button', 'aria-label': title },
    h('div', { class: 'dz-icon' }, icon('upload', 28)),
    h('div', { class: 'dz-title' }, title || (multiple ? 'Drop files here' : 'Drop a file here')),
    h('div', { class: 'dz-hint' }, hint || 'or click to choose — files stay on this device'),
    h('div', { class: 'dz-actions' },
      button(multiple ? 'Choose files' : 'Choose file', { variant: 'primary', icon: 'open', onClick: (e) => { e.stopPropagation(); input.click(); } }),
      cam ? button('Take photo', { icon: 'camera', cls: 'only-touch', onClick: (e) => { e.stopPropagation(); cam.click(); } }) : null,
    ),
    input, cam,
  );
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
  });
  zone.open = () => input.click();
  return zone;
}

// ---------------------------------------------------------------- progress
export function progressBar() {
  const bar = h('div', { class: 'progress-bar' });
  const label = h('div', { class: 'progress-label' }, 'Starting…');
  const pct = h('div', { class: 'progress-pct' }, '');
  const el = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' },
    h('div', { class: 'progress-top' }, label, pct),
    h('div', { class: 'progress-track' }, bar),
  );
  return {
    el,
    set(fraction, text) {
      const p = Math.max(0, Math.min(1, fraction));
      bar.style.width = `${(p * 100).toFixed(1)}%`;
      pct.textContent = `${Math.round(p * 100)}%`;
      el.setAttribute('aria-valuenow', String(Math.round(p * 100)));
      if (text) label.textContent = text;
    },
    text(t) { label.textContent = t; },
  };
}

// ---------------------------------------------------------------- misc
export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function baseName(name) {
  return (name || 'document').replace(/\.[^.]+$/, '');
}

export function downloadBlob(data, filename, type = 'application/pdf') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 30000);
}

/** Parse "1-3, 5, 8-" into sorted unique zero-based indices. */
export function parsePageRanges(text, total) {
  const out = new Set();
  for (const part of String(text).split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
    if (m) {
      const a = m[1] ? parseInt(m[1], 10) : 1;
      const b = m[2] ? parseInt(m[2], 10) : total;
      if (!a || !b) throw new Error(`Invalid range “${part}”`);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= total) out.add(i - 1);
    } else if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10);
      if (n >= 1 && n <= total) out.add(n - 1);
      else throw new Error(`Page ${n} does not exist (document has ${total})`);
    } else {
      throw new Error(`Could not understand “${part}”`);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Groups like "1-3,5" -> [[0,1,2],[4]] keeping each comma-separated group separate (for split). */
export function parseRangeGroups(text, total) {
  return String(text)
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((g) => parsePageRanges(g, total));
}

export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
export const idle = () => new Promise((r) => setTimeout(r, 0));

export function readFile(file) {
  return file.arrayBuffer().then((b) => new Uint8Array(b));
}

export function isPdf(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

/** Simple segmented control */
export function segmented(options, value, onChange, { name } = {}) {
  const wrap = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': name });
  const render = () => {
    wrap.replaceChildren(
      ...options.map((o) =>
        h('button', {
          type: 'button',
          role: 'radio',
          'aria-checked': String(o.value === value),
          class: o.value === value ? 'active' : '',
          onClick: () => {
            value = o.value;
            render();
            onChange(value);
          },
        }, o.label),
      ),
    );
  };
  render();
  return wrap;
}

export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'field-hint' }, hint) : null);
}

export function select(options, value, onChange) {
  const s = h('select', { class: 'input', onChange: () => onChange(s.value) }, options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
  return s;
}

export function toggle(label, checked, onChange, hint) {
  const input = h('input', { type: 'checkbox', checked, onChange: () => onChange(input.checked) });
  return h('label', { class: 'toggle' }, input, h('span', { class: 'toggle-track' }, h('span', { class: 'toggle-thumb' })), h('span', { class: 'toggle-text' }, h('span', null, label), hint ? h('small', null, hint) : null));
}

/** Pointer-based drag-to-reorder for a container whose children carry data-index. */
export function enableReorder(container, itemSelector, onReorder, handleSelector) {
  let dragEl = null;
  let placeholder = null;
  let startY = 0;
  let startX = 0;
  let offX = 0;
  let offY = 0;
  let pointerId = null;
  let started = false;

  container.addEventListener('pointerdown', (e) => {
    const handle = handleSelector ? e.target.closest(handleSelector) : e.target.closest(itemSelector);
    if (!handle || e.target.closest('button:not(.drag-handle), input, select, a')) return;
    const item = handle.closest(itemSelector);
    if (!item || !container.contains(item)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragEl = item;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    started = false;
  });
  const onMove = (e) => {
    if (!dragEl || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!started) {
      if (Math.hypot(dx, dy) < 6) return;
      // touch: only start when dragging a handle (otherwise allow scrolling)
      if (e.pointerType === 'touch' && !e.target.closest?.(handleSelector || itemSelector)) return;
      started = true;
      const r = dragEl.getBoundingClientRect();
      offX = startX - r.left;
      offY = startY - r.top;
      placeholder = dragEl.cloneNode(false);
      placeholder.className = `${dragEl.className} drag-placeholder`;
      placeholder.style.width = `${r.width}px`;
      placeholder.style.height = `${r.height}px`;
      dragEl.after(placeholder);
      dragEl.classList.add('dragging');
      Object.assign(dragEl.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, zIndex: 1000, pointerEvents: 'none' });
      container.classList.add('is-sorting');
    }
    e.preventDefault();
    dragEl.style.left = `${e.clientX - offX}px`;
    dragEl.style.top = `${e.clientY - offY}px`;
    const items = [...container.querySelectorAll(`${itemSelector}:not(.dragging):not(.drag-placeholder)`)];
    let target = null;
    let before = true;
    for (const it of items) {
      const r = it.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        target = it;
        const horizontal = r.width < container.clientWidth * 0.8;
        before = horizontal ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2;
        break;
      }
    }
    if (target) {
      if (before) target.before(placeholder);
      else target.after(placeholder);
    }
  };
  const onUp = (e) => {
    if (!dragEl || e.pointerId !== pointerId) return;
    if (started) {
      placeholder.replaceWith(dragEl);
      dragEl.classList.remove('dragging');
      dragEl.removeAttribute('style');
      container.classList.remove('is-sorting');
      const order = [...container.querySelectorAll(itemSelector)].map((el) => Number(el.dataset.index));
      onReorder(order);
    }
    dragEl = null;
    placeholder = null;
    started = false;
  };
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
  return () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };
}
