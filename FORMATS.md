# Supported formats and operations

This file is the human-readable twin of `GET /api/v1/capabilities`. The app's **Settings → Supported formats**
screen shows the same facts live; if the two ever disagree, the app is right.

Legend: **Implemented** = works in this build · **Planned** = not built, the UI shows it disabled with a reason.

## Implemented

| Operation | Reads | Writes | Engine |
|---|---|---|---|
| Compress | any files and folders | ZIP (Deflate) | ZIP (`zip` crate) |
| Extract | ZIP (including password-protected entries) | the files inside | ZIP (`zip` crate) |
| Convert images | JPG, PNG, WebP | JPG, PNG, WebP | Images (`image` crate + libwebp) |
| Merge PDFs | PDF (two or more, in order) | one PDF | PDF engine (PDFium worker) |
| Split PDF | PDF | several PDFs in a folder, by pages-per-file or ranges | PDF engine |
| Reorder / rotate / delete / extract pages (from the editor, via Save Copy / Extract) | PDF | one new PDF | PDF engine |
| Images to PDF | JPG, PNG, WebP (in the order given) | one PDF, one page per picture | PDF engine |
| PDF pages to images | PDF (one or more, all pages or a range) | PNG, JPG or WebP, one per page, in a `<name> (images)` folder | PDF engine |
| Annotate a PDF (from the editor, via Save Copy) | PDF, plus JPG/PNG/WebP for placed pictures | one new PDF with the annotations drawn into the pages | PDF engine |
| Word / Excel / PowerPoint / OpenDocument to PDF | DOCX, DOC, ODT, RTF, XLSX, XLS, ODS, PPTX, PPT, ODP | one PDF per document, same name | LibreOffice (headless, bundled in the Windows installer) |
| View PDF pages (editor, not a batch job) | PDF | page images on screen | PDF viewer (PDFium, separate worker process; available only if the library loads) |

### PDF page operations
The new PDF keeps how every page looks (text, images, vector graphics, annotations drawn on the page). Bookmarks, form-filling data and document properties
(title, author…) are **not** carried over, and the result is never password-protected. Rotation adds to a page's own rotation. Merge reads every page of
each input in the order given; Split names parts `<name> - pages 1-3.pdf` / `<name> - page 7.pdf` inside `<name> (split)`; a split can make at most 2000 files.
A PDF with passwords: one password per job, tried on every protected input. Originals are never modified and never overwritten, even with Replace.

### Images to PDF
Page size A4, US Letter, or "same size as the picture" (0.75 pt per pixel, so a 96 dpi picture prints at its natural size). On A4/Letter the picture
is scaled to fit inside the margin (0–50 mm) and centred, never stretched or cropped; orientation is automatic (landscape pictures get a landscape page),
portrait or landscape. JPEGs are embedded as they are (no recompression) unless they carry a rotation tag, in which case they are re-encoded upright.
Transparent PNG/WebP pixels are drawn over the white page. Pictures up to 40 megapixels.

### PDF pages to images
Resolution 36–600 dpi (a PDF page is 72 points per inch), PNG / JPG (quality 10–100) / WebP. Pages larger than 14 400 px per side or 64 megapixels at the
chosen dpi are saved a little smaller, and the job says so. Names are `<pdf name> - page 01.png` (zero-padded to the page count). At most 5000 pictures per job.
Colours are PDFium's RGB rendering; transparent areas of a page are white. Password-protected PDFs need the password; it is used for the job and never stored.

### Annotating
Highlight (multiply blend, so text stays readable), underline, strikethrough, sticky note, text box, pen, rectangle / ellipse / line / arrow (optionally filled),
pictures, and a drawn "visual signature". Annotations are **drawn into the page content** of the new copy (they are not PDF annotation objects), so they
show in every viewer but cannot be edited afterwards; keep the editor session open if you may want to change them. Limits: 5000 annotations, 200 000 pen
points, 5000 characters per text. **Text uses the built-in Helvetica**: Latin letters with accents and common punctuation only. Arabic, Hebrew, Chinese,
Japanese, Korean, emoji and other scripts cannot be drawn yet; the editor says so and refuses to save them instead of producing wrong text.
Highlights are rectangles you drag, not snapped to words. A visual signature is only a picture on the page: it is **not** a digital signature and does not make
the PDF signed. Editing a signed PDF invalidates its existing signatures (the editor warns).

### Office documents to PDF
LibreOffice 24.8 runs without a window, in its own process with a time limit (5 minutes per document), a private profile with macros switched off, link updating off and no
network use by OrangeFile. The document is copied under a plain name into a private folder first; the original is never touched. The format is recognised by
**content** (ZIP part names, OLE compound-file streams, `{\rtf`), not by extension. Password-protected documents and damaged files fail with a message and don't stop the
other files. **The PDF is drawn by LibreOffice: fonts, spacing, page breaks, and some advanced features (SmartArt, some charts, tracked changes display, embedded
macros) can differ from Microsoft Office.** Fonts missing from the computer are substituted. The installer includes LibreOffice (about 350 MB larger); if it is absent
the app uses an installed LibreOffice and says so; if neither exists the tool is shown unavailable with the reason.

### PDF viewing
Detection is by content (`%PDF-` at the start of the file). Reads: any PDF PDFium can open, including password-protected
ones (the password is asked for and never stored) and author-restricted ones (restrictions are shown). Shows: page thumbnails,
a preview at 25–400 % or fitted to the window, page size, PDF version, title/author and other metadata, signature count,
form presence, and warnings. Limits: 50 000 pages; previews at most 4096 px wide, 8192 px tall and 24 megapixels (larger pages
are drawn at reduced detail and say so). Not supported: XFA forms, JavaScript, editing, saving. Nothing here changes the original file.

### Image conversion pairs

Every input can become every output (including the same format, which re-encodes).

| From \ To | JPG | PNG | WEBP |
|---|---|---|---|
| **JPG** | ✓ re-encode | ✓ larger file, no quality restored | ✓ |
| **PNG** | ✓ transparency flattened | ✓ re-encode | ✓ transparency kept |
| **WEBP** | ✓ transparency flattened | ✓ larger file | ✓ re-encode |

### Image options

| Option | Applies to | Notes |
|---|---|---|
| Quality (1–100, default 85) | JPG; WebP in lossy mode | Ignored for PNG and lossless WebP. The UI hides it there. |
| WebP mode: lossy / lossless (default lossy) | WebP | Lossless keeps every pixel; lossy makes smaller files. |
| Background for transparent areas (default `#FFFFFF`) | JPG | JPG cannot store transparency. The review names the colour that will be used. |
| Keep photo information (default off) | all | Keeps EXIF (camera, location). Off removes it. |

### What always happens

- **Orientation** is applied to the pixels, so no viewer rotates an image twice or not at all. If photo
  information is kept, its orientation tag is reset to "upright".
- **Colour profile (ICC)** is always kept when it matches the pixels (RGB or grey), because dropping it changes how
  colours look. A profile of the wrong colour space (for example CMYK on converted RGB pixels) is dropped.
- **Transparency** is kept for PNG and WebP. For JPG it is flattened onto the background colour.
- **A cut-off or damaged image fails with a clear message.** A truncated JPEG is detected by checking it reaches its end marker.
- **Content decides the format**, not the extension: a PNG named `.jpg` converts as a PNG; a text file named `.png` is refused.

### Limits

| Limit | Value |
|---|---|
| Image size | 32 768 px per side (16 383 for WebP, a format limit); decoding memory is capped |
| Archive | 200 000 entries; 20 GiB expanded by default (declared and actual bytes) |
| Per job (local API) | 500 files, 8 GiB per file, 16 GiB total, 2 jobs at once |
| Result retention | 15 minutes (10 in the desktop app), then deleted |

The live values are in the capability report (`limits`).

## Planned (not implemented)

| Area | Intended engine | State |
|---|---|---|
| PDF forms (fill, flatten), text-searchable highlights, non-Latin annotation text | to be evaluated | Planned |
| Existing-text editing, OCR | to be evaluated | Planned, only if an engine can do it reliably |
| PDF to Word/Excel, editing Office files | to be evaluated | Not planned |
| Audio and video | FFmpeg (optional) | Planned. Codecs will be listed from the actual build |
| 7Z, TAR, GZ, and other archives | 7-Zip (optional) | Planned. ZIP stays the baseline |
| RAR extraction | to be reviewed | Not planned until licensing is reviewed. No RAR creation |

## Adding an engine (for developers)

1. Create `crates/file-core/src/engine/<name>.rs` and implement `Engine` (`info`, `formats`, `operations`, `preflight`, `review`, `run`).
2. Declare exact pairs and option specs in `operations()`; never claim more than `run` can do.
3. Report `Availability::Unavailable { reason }` when a required binary is missing or unverified.
4. Register it in `Registry::bundled()` (or discover it at start-up for optional engines).
5. Add tests: capability report, unsupported pairs, unavailable engine, hostile and truncated input, cancellation, cleanup.
6. Add its operation id to the UI only after its screen exists (`IMPLEMENTED_PDF_WORKFLOWS` for PDF tasks). Until then it shows as "Coming soon".
7. Update this file and run `npm run notices`.
