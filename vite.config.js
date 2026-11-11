import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Strict Content-Security-Policy for the production build: the page may only
// talk to its own origin, so files can never be sent anywhere.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data:",
  "img-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

const cspPlugin = {
  name: 'cutepdf-csp',
  apply: 'build',
  transformIndexHtml(html) {
    return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
  },
};

export default defineConfig({
  // relative base: works on GitHub Pages (/CutePDF/), a custom domain, or locally
  base: './',
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 2500,
  },
  worker: { format: 'es' },
  plugins: [
    cspPlugin,
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: {
        name: 'CutePDF — private PDF tools',
        short_name: 'CutePDF',
        description: 'Read, highlight, OCR, compress, merge, split and convert PDFs entirely on your device.',
        theme_color: '#6d4aff',
        background_color: '#faf8fd',
        display: 'standalone',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        file_handlers: [{ action: './#/read', accept: { 'application/pdf': ['.pdf'] } }],
      },
      workbox: {
        // App shell is precached. Big engines (OCR model, fonts, pdf.js data)
        // are cached the first time they are used, so they also work offline.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        globIgnores: ['vendor/**'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/vendor/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'cutepdf-engines',
              expiration: { maxEntries: 400 },
            },
          },
        ],
      },
    }),
  ],
});
