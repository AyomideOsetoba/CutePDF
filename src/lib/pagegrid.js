// Visual grid of page thumbnails (used by Split and Organize).
import { h, icon, iconButton, enableReorder } from './ui.js';
import { renderThumb, releaseImage } from './pdf.js';

/**
 * @param pdf       pdf.js document
 * @param options   { selectable, reorderable, rotatable, deletable, onChange(state) }
 * state: pages = [{ src: index, rotation: 0|90|180|270, deleted, selected }]
 */
export function pageGrid(pdf, { selectable = false, reorderable = false, rotatable = false, deletable = false, onChange } = {}) {
  const state = { pages: Array.from({ length: pdf.numPages }, (_, i) => ({ src: i, rotation: 0, deleted: false, selected: false })) };
  const grid = h('div', { class: 'page-grid' });
  const thumbs = new Map(); // src -> thumbnail <img>
  let lastClicked = null;

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const src = Number(e.target.dataset.src);
      if (thumbs.has(src)) continue;
      thumbs.set(src, null);
      renderThumb(pdf, src + 1, 200).then((c) => {
        thumbs.set(src, c);
        const box = grid.querySelector(`.page-tile[data-src="${src}"] .thumb`);
        if (box) {
          box.replaceChildren(c);
          applyRotation(box, state.pages.find((p) => p.src === src)?.rotation || 0);
        }
      }).catch(() => {});
    }
  }, { rootMargin: '400px 0px' });

  const applyRotation = (box, rot) => {
    const c = box.firstElementChild;
    if (c) c.style.transform = rot ? `rotate(${rot}deg)${rot % 180 ? ' scale(0.75)' : ''}` : '';
  };

  const emit = () => onChange?.(state);

  function render() {
    grid.replaceChildren(...state.pages.map((p, i) => tile(p, i)));
    for (const el of grid.children) {
      const src = Number(el.dataset.src);
      if (!thumbs.get(src)) io.observe(el);
    }
  }

  function tile(p, i) {
    const box = h('div', { class: 'thumb' });
    const c = thumbs.get(p.src);
    if (c) {
      box.append(c); // moves the image out of the old tile
      applyRotation(box, p.rotation);
    }
    const el = h('div', {
      class: `page-tile${p.selected ? ' selected' : ''}${p.deleted ? ' deleted' : ''}`,
      dataset: { src: String(p.src), index: String(i) },
      tabindex: '0',
      role: selectable ? 'checkbox' : undefined,
      'aria-checked': selectable ? String(p.selected) : undefined,
      'aria-label': `Page ${p.src + 1}`,
    },
    box,
    h('div', { class: 'pnum' }, `${p.src + 1}`),
    selectable ? h('div', { class: 'tile-check' }, icon('check', 14)) : null,
    rotatable || deletable ? h('div', { class: 'tile-actions' },
      rotatable ? iconButton('rotateCcw', 'Rotate left', (e) => { e.stopPropagation(); rotate(p, -90); }) : null,
      rotatable ? iconButton('rotateCw', 'Rotate right', (e) => { e.stopPropagation(); rotate(p, 90); }) : null,
      deletable ? iconButton(p.deleted ? 'undo' : 'trash', p.deleted ? 'Restore page' : 'Delete page', (e) => { e.stopPropagation(); p.deleted = !p.deleted; render(); emit(); }) : null,
    ) : null,
    );
    if (selectable) {
      const toggle = (shift) => {
        if (shift && lastClicked != null) {
          const a = Math.min(lastClicked, i);
          const b = Math.max(lastClicked, i);
          const val = !p.selected;
          for (let k = a; k <= b; k++) state.pages[k].selected = val;
        } else p.selected = !p.selected;
        lastClicked = i;
        render();
        emit();
      };
      el.addEventListener('click', (e) => toggle(e.shiftKey));
      el.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          toggle(e.shiftKey);
          grid.children[i]?.focus();
        }
      });
    }
    return el;
  }

  function rotate(p, d) {
    p.rotation = (((p.rotation + d) % 360) + 360) % 360;
    const box = grid.querySelector(`.page-tile[data-src="${p.src}"] .thumb`);
    if (box) applyRotation(box, p.rotation);
    emit();
  }

  let stopReorder = null;
  if (reorderable) {
    stopReorder = enableReorder(grid, '.page-tile', (order) => {
      state.pages = order.map((i) => state.pages[i]);
      render();
      emit();
    });
  }

  render();
  return {
    el: grid,
    state,
    render,
    setAll(fn) {
      state.pages.forEach(fn);
      render();
      emit();
    },
    destroy() {
      io.disconnect();
      for (const img of thumbs.values()) releaseImage(img);
      stopReorder?.();
    },
  };
}
