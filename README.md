# CutePDF

**🌐 Use it now: [ayomideosetoba.github.io/CutePDF](https://ayomideosetoba.github.io/CutePDF/)**

A private PDF toolkit for students and researchers: read and highlight papers, make scans searchable with column-aware OCR, compress, merge, split and convert PDFs — all on your own device.

Everything runs entirely in your browser and nothing is uploaded: files are opened by JavaScript in your tab, and the production build's Content-Security-Policy stops the page from contacting any server other than its own. CutePDF works on phones and desktops, and it can be installed as an app (PWA) that keeps working offline.

## Tools

| Tool | What it does |
|---|---|
| **Read & highlight** | Fast reader with highlight (6 colours), underline, strikethrough, sticky notes, pen and eraser. Also: undo/redo, search, outline, thumbnails, and night or sepia page colours. Annotations are saved as **standard PDF annotations** that Acrobat, Edge, Chrome, Preview and Zotero can show. Highlights and notes can be exported as Markdown. |
| **Make searchable (OCR)** | Adds an invisible, selectable text layer to scanned pages using Tesseract (WebAssembly). The layer is **column-aware**. It can also replace a broken text layer left by another OCR tool, keeping the original page images. |
| **Compress** | Re-encodes oversized images to a target resolution, based on how large each image is actually drawn on the page. Text, fonts and vectors are left alone. Unused objects are dropped and metadata can be removed. |
| **Merge** | Combine PDFs (and images), drag to reorder, and optionally pick page ranges per file. |
| **Split & extract** | Pick pages visually, split by ranges (`1-3, 4-10`), or split every N pages. Several outputs are downloaded as a ZIP. |
| **Organize** | Reorder, rotate and delete pages in a thumbnail grid. |
| **PDF → Word** | A `.docx` with headings, paragraphs, bold and italics, in true reading order (column-aware, joined across columns and pages). Scanned pages are OCR'd. |
| **Images → PDF** | JPG/PNG/WebP/HEIC photos into one PDF, with lossless rotation, EXIF orientation fixed, and camera capture on phones. |
| **PDF → images** | PNG or JPG at 72/150/300 DPI, as single files or a ZIP. |

## The two-column problem (and how CutePDF fixes it)

Many tools treat a page as one block of full-width lines. In a two-column paper, a selection that starts in the left column then jumps straight across into the right column, and copied text interleaves both columns. Badly OCR'd PDFs have the same problem built into their text layer.

`src/lib/layout.js` rebuilds the reading order:

1. Words or text runs are grouped into line fragments that never bridge a large gap.
2. **Column gutters** are found as vertical white-space channels between ordinary text lines. Wide lines (titles, abstracts, full-width captions) are ignored when measuring, so they don't hide the gutter.
3. Fragments that still bridge a gutter (common in OCR output) are split there.
4. Lines that really span the page act as separators. Each band between them is read column by column, top to bottom. This handles 1, 2 and 3 columns, full-width abstracts and mid-page figure captions.

This one engine is used by:

- **OCR**, to write the invisible text layer line by line in column order, with every word positioned and scaled onto its printed word. Any PDF viewer then selects down the column.
- **The Reader**, which reorders the existing text of digital PDFs whose internal order is broken. This can be toggled in the ⋯ menu.
- **PDF → Word** and the OCR `.txt` export.

## Privacy

- No uploads, accounts, analytics or third-party requests. The OCR engine, its English model, fonts and pdf.js data are all served from this site.
- Optional, browser-only storage: your unsaved annotation drafts and last-read page (IndexedDB), plus preferences (localStorage). Clear them any time with **Reader → ⋯ → Forget everything stored in this browser**. The PDFs themselves are never stored.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # layout engine unit tests
npm run build      # production build in dist/
npm run preview    # serve the production build
```

`npm run dev` and `npm run build` first run `scripts/copy-vendor.mjs`, which copies the pdf.js data, the Tesseract worker/WebAssembly/model and the DejaVu Sans font into `public/vendor/`. That folder is generated and git-ignored.

### Deploying to GitHub Pages

The repository includes `.github/workflows/deploy.yml`. One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**. After that, every push to `main` builds and publishes the site at `https://<user>.github.io/<repo>/`. The build uses relative paths, so it also works on any static host or a custom domain.

## Project layout

```
src/
  main.js              app shell, router, home page
  tools/               one module per tool (reader, ocr, compress, merge, …)
  lib/layout.js        column-aware reading order (the two-column fix)
  lib/textorder.js     applies it to existing PDF text (pdf.js)
  lib/ocr.js           Tesseract worker pool
  lib/textlayer-pdf.js writes the invisible OCR text layer with pdf-lib
  lib/contentstream.js tiny content-stream parser (strip old OCR text, measure images)
  lib/annotations.js   annotation model, import/export as real PDF annotations
  lib/compress.js      image re-encoding + object clean-up
  lib/docx-export.js   paragraphs/headings → .docx
tests/                 node:test unit tests for the layout engine
```

## Limitations

- OCR ships with English only. Text is recognised well; maths and tables are approximate.
- PDF → Word focuses on text. Figures, tables and equations are not reproduced exactly.
- Encrypted (permission-restricted) PDFs can be read, but can't be modified.
- Very large files are limited by your device's memory, especially on phones.

## Author

Created and maintained by **[Ayomide Osetoba](https://github.com/AyomideOsetoba)**.

## Credits

Built on [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0), [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT), [Tesseract.js](https://github.com/naptha/tesseract.js) (Apache-2.0), [docx](https://github.com/dolanmiu/docx) (MIT), [fflate](https://github.com/101arrowz/fflate) (MIT), [Lucide](https://lucide.dev) icons (ISC) and the [DejaVu](https://dejavu-fonts.github.io/) fonts (free license).

Licensed under the MIT License.
