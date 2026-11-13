import './styles/base.css';
import { h, icon, iconButton, dropzone, toast, isPdf, readFile } from './lib/ui.js';
import { TOOLS, toolById } from './tools/registry.js';
import { go } from './lib/handoff.js';
import { logoSvg } from './lib/logo.js';

const app = document.getElementById('app');

// ------------------------------------------------------------------ theme
const THEME_KEY = 'cutepdf.theme';
function getTheme() {
  try {
    return localStorage.getItem(THEME_KEY) || 'auto';
  } catch {
    return 'auto';
  }
}
function applyTheme(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* private mode */
  }
}
applyTheme(getTheme());
export function themeButton() {
  const order = ['auto', 'light', 'dark'];
  const names = { auto: 'Theme: follow system', light: 'Theme: light', dark: 'Theme: dark' };
  const icons = { auto: 'auto', light: 'sun', dark: 'moon' };
  const b = iconButton(icons[getTheme()], names[getTheme()], () => {
    const next = order[(order.indexOf(getTheme()) + 1) % order.length];
    applyTheme(next);
    b.replaceChildren(icon(icons[next], 19));
    b.title = names[next];
    b.setAttribute('aria-label', names[next]);
    toast(names[next]);
  });
  return b;
}

// ------------------------------------------------------------------ shell
function header() {
  return h('header', { class: 'app-header' },
    h('a', { class: 'brand', href: '#/' }, logoSvg('brand-logo'), h('span', null, 'Cute', h('b', null, 'PDF'))),
    h('div', { class: 'header-spacer' }),
    h('span', { class: 'privacy-pill', title: 'Your files are processed in this browser and never uploaded' }, icon('shield', 15), h('span', null, 'Files never leave your device')),
    themeButton(),
  );
}

function footer() {
  return h('footer', { class: 'app-footer' },
    h('p', null, 'CutePDF runs entirely in your browser — no uploads, no accounts, no tracking. Works offline after your first visit (OCR after its first use).'),
    h('p', null, 'Made by ', h('a', { href: 'https://github.com/AyomideOsetoba', target: '_blank', rel: 'noopener noreferrer' }, 'Ayomide Osetoba'),
      ' · ', h('a', { href: 'https://github.com/AyomideOsetoba/CutePDF', target: '_blank', rel: 'noopener noreferrer' }, 'Source code')),
  );
}

export function toolPage(tool, ...content) {
  return [
    header(),
    h('main', { class: 'page narrow' },
      h('a', { class: 'back-link', href: '#/' }, icon('back', 16), 'All tools'),
      h('div', { class: 'tool-head' },
        h('div', { class: 'tool-ic', style: { '--c': `var(--t${tool.color})`, '--cs': `var(--t${tool.color}s)` } }, icon(tool.icon, 26)),
        h('div', null, h('h1', null, tool.title), h('p', null, tool.desc)),
      ),
      ...content,
    ),
    footer(),
  ];
}

// ------------------------------------------------------------------ home
function home() {
  const toolCard = (t) =>
    h('a', { class: 'tool-card', href: `#/${t.id}` },
      h('div', { class: 'tool-ic', style: { '--c': `var(--t${t.color})`, '--cs': `var(--t${t.color}s)` } }, icon(t.icon, 22)),
      t.tag ? h('span', { class: 'tag' }, t.tag) : null,
      h('h3', null, t.title),
      h('p', null, t.desc),
    );
  const dz = dropzone({
    title: 'Open a PDF to read & highlight',
    hint: 'Drop it here or choose a file — it stays on this device',
    onFiles: async ([f]) => {
      if (!isPdf(f)) return toast('Please choose a PDF file', 'error');
      go('#/read', { bytes: await readFile(f), name: f.name });
    },
  });
  return [
    header(),
    h('main', { class: 'page' },
      h('section', { class: 'hero' },
        h('h1', null, 'PDF tools that ', h('em', null, 'respect your research')),
        h('p', { class: 'lead' }, 'Read and annotate papers, OCR scans with proper two-column order, compress, merge, split and convert — all inside your browser. Nothing is uploaded, ever.'),
        h('div', { class: 'hero-badges' },
          h('span', { class: 'badge' }, icon('shield', 15), '100% on-device'),
          h('span', { class: 'badge' }, icon('columns', 15), 'Two-column aware'),
          h('span', { class: 'badge' }, icon('offline', 15), 'Works offline'),
          h('span', { class: 'badge' }, icon('sparkles', 15), 'Free & no sign-up'),
        ),
        h('div', { class: 'hero-drop' }, dz),
      ),
      h('div', { class: 'section-title' }, h('h2', null, 'Tools')),
      h('div', { class: 'tool-grid' }, TOOLS.map(toolCard)),
      h('div', { class: 'section-title' }, h('h2', null, 'Why CutePDF')),
      h('div', { class: 'features' },
        feature('shield', 'Private by design', 'Files are opened with JavaScript in this tab. No server ever sees them, so it is safe for unpublished work and reviews.'),
        feature('columns', 'Fixes two-column papers', 'Our layout engine finds column gutters, so selecting, copying, OCR and Word export follow the real reading order.'),
        feature('highlight', 'Real PDF annotations', 'Highlights, notes and drawings are saved as standard PDF annotations — they show up in Acrobat, Edge, Zotero and more.'),
        feature('offline', 'Phone & desktop', 'Install it as an app from your browser menu. After your first visit every tool works without internet; OCR needs one online run to download its engine.'),
      ),
    ),
    footer(),
  ];
}
const feature = (ic, title, text) => h('div', { class: 'feature' }, h('h3', null, icon(ic, 18), title), h('p', null, text));

// ------------------------------------------------------------------ router
let cleanup = null;
let navToken = 0;

async function route() {
  const token = ++navToken;
  const id = (location.hash.replace(/^#\/?/, '').split(/[?/]/)[0] || '').trim();
  if (typeof cleanup === 'function') {
    try {
      cleanup();
    } catch (e) {
      console.error(e);
    }
  }
  cleanup = null;
  document.body.classList.remove('reader-mode');
  const tool = id ? toolById(id) : null;
  if (!tool) {
    app.replaceChildren(...home());
    document.title = 'CutePDF — private PDF tools for researchers';
    window.scrollTo(0, 0);
    return;
  }
  document.title = `${tool.title} · CutePDF`;
  app.replaceChildren(h('div', { class: 'boot' }, icon('spinner', 28, 'spin')));
  try {
    const mod = await tool.load();
    if (token !== navToken) return;
    window.scrollTo(0, 0);
    cleanup = await mod.default.mount(app, { tool, toolPage: (...c) => toolPage(tool, ...c) });
  } catch (e) {
    console.error(e);
    if (token !== navToken) return;
    app.replaceChildren(...toolPage(tool, h('div', { class: 'callout error' }, icon('warn', 18), h('div', null, 'This tool failed to load. If you are offline, open it once while online so it can be cached. ', h('br'), h('small', { class: 'muted' }, String(e?.message || e))))));
  }
}

window.addEventListener('hashchange', route);
route();

// Allow dropping a PDF anywhere on the home page
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  if (e.defaultPrevented) return;
  e.preventDefault();
});

// Offline support (production only)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true })).catch(() => {});
}
