# OrangeFile: how it all fits together

> **Status (v0.2).** Implemented: ZIP compress/extract, JPG/PNG/WebP conversion (lossy and lossless WebP), engine registry, capability reporting, preview endpoint, capability-driven UI, PDF screens that report themselves unavailable. **Planned, not built:** every PDF operation, Office, audio/video, more archive formats. See [FORMATS.md](FORMATS.md) for the exact list.

A Windows-first desktop app that compresses, converts and extracts files **entirely on the user's
computer**. This document explains the pieces, the tools used for each, and how one job travels
through them.

## 1. The big picture

```
┌────────────────────────── OrangeFile.exe (one process, one window) ──────────────────────────┐
│                                                                                               │
│  ① WEBVIEW (what the user sees)                                                               │
│     React + TypeScript UI  ── only talks to ──►  Tauri commands (invoke)                      │
│                                                        │                                      │
│  ② TAURI SHELL (src-tauri, Rust)                       ▼                                      │
│     commands.rs  ─► client.rs  (HTTP client, holds the secret token)                          │
│                                  │  http://127.0.0.1:<random port>  + Bearer token            │
│                                  ▼                                                            │
│  ③ FILE-API (crates/file-api, Rust + Axum + Tokio)    runs inside the same process            │
│     routes · auth · uploads · job store · cleanup                                             │
│                                  │  plain Rust function calls                                 │
│                                  ▼                                                            │
│  ④ FILE-CORE (crates/file-core, Rust, no web, no UI)                                          │
│     ZIP engine · image engine · safe-file rules · job runner                                  │
│                                  │                                                            │
└──────────────────────────────────┼────────────────────────────────────────────────────────────┘
                                   ▼
                          the user's files on disk
```

The important idea: **each layer only knows about the one directly below it.**
The UI never touches files or the network. The API never draws anything. The core never knows it is
being called over HTTP. That separation is why each layer can be tested on its own, and why the same
core could later be hosted on a server without rewriting it.

## 2. Tools and frameworks (and what each is for)

| Layer | Tool | What it does here |
|---|---|---|
| Desktop shell | **Tauri 2** | Makes the native window and installer, shows the web UI inside the OS WebView (WebView2 on Windows), lets the UI call Rust, opens native file/folder dialogs, delivers drag-and-drop paths. Much smaller than Electron because it uses the OS's browser engine. |
| Language (backend) | **Rust** | All file work. Memory-safe, fast, one self-contained binary. |
| UI | **React 18 + TypeScript** | Screens and state. TypeScript catches type mistakes before the app runs. |
| UI build | **Vite 6** | Dev server with instant reload; produces the optimised files Tauri embeds. |
| Icons / font | **lucide-react**, **Inter** (via `@fontsource-variable/inter`) | Consistent line icons; the typeface from your design. Both bundled, so no internet needed. |
| HTTP server | **Axum 0.8 + Tokio** | The local API: routing, multipart uploads, streaming downloads. Tokio is the async runtime that keeps many requests moving without blocking. |
| HTTP client | **reqwest** | The Tauri side's way of calling the API (streams uploads from disk, never loads whole files in memory). |
| ZIP | **`zip` crate** | Create / list / extract ZIP (Deflate, plus reading AES-encrypted entries). |
| Images | **`image` crate** | Decode JPG/PNG/WebP; encode JPG, PNG and lossless WebP; EXIF orientation, EXIF and ICC profiles. |
| Lossy WebP | **`webp` crate → libwebp (C, built in)** | The lossy WebP encoder. libwebp is compiled into the app (BSD-3-Clause; notice shipped in Third-party notices). Needs a C compiler at build time only. |
| Safe output | **`tempfile`** | Write to a hidden temp file, then atomically rename into place. |
| Auth | **`subtle`** | Constant-time token comparison (no timing leaks). |
| Tests | `cargo test`, **Playwright + axe-core** (`npm run test:ui`), **Xvfb + xdotool** (real app run) | Rust unit/integration tests; headless-browser UI checks and accessibility scan; a real launch of the desktop app under a virtual display. |
| Quality | **ESLint** (+ react-hooks rules), `tsc` | Lint and type-check the frontend. |

## 3. Folder map

```
file-tool/
├── Cargo.toml                 Rust workspace: ties the 3 Rust crates together
├── crates/
│   ├── file-core/             ④ the engines (ZIP, images, safe output, job runner)
│   │   ├── src/engine/mod.rs    Engine trait, Registry, capability report types
│   │   ├── src/engine/zip.rs    ZIP engine: list / compress / extract, zip-bomb + traversal defences
│   │   ├── src/engine/image.rs  image engine: JPG/PNG/WebP, orientation, ICC/EXIF, lossy WebP
│   │   ├── src/formats.rs       format catalog + content-based detection (never by extension)
│   │   ├── src/fs_safe.rs       "never overwrite", temp-then-rename, safe path rules
│   │   ├── src/job.rs           job status, progress, cancel, background threads, concurrency gate
│   │   ├── src/request.rs       typed requests; validate / run / review dispatch through the registry
│   │   └── tests/               58 tests
│   └── file-api/              ③ Axum HTTP API
│       ├── src/routes.rs        the endpoints (create job, status, cancel, results)
│       ├── src/middleware.rs    request ids, Origin/Host checks, bearer-token auth
│       ├── src/jobs.rs          maps API job ids ↔ core jobs, retention/cleanup
│       ├── src/types.rs         the JSON shapes (shared with the desktop client)
│       └── tests/               27 tests over real HTTP
├── src-tauri/                 ② Tauri shell
│   ├── src/lib.rs               starts the API inside the app, wires everything, shuts down cleanly
│   ├── src/client.rs            HTTP client for the API
│   ├── src/commands.rs          the functions the UI may call
│   ├── tauri.conf.json          window (frameless, 1100×760), installer targets, CSP
│   └── capabilities/            exactly which powers the UI is allowed
└── src/                       ① React UI
    ├── lib/                     types, formatting, capability selectors, the one `invoke` wrapper
    ├── services/                typed wrappers: jobs + capabilities, dialogs, drag-drop, history, settings
    ├── app/                     state providers (capabilities, jobs + polling, selection, settings, toasts, drop)
    ├── components/              reusable pieces (shell, sidebar, drop zone, cards, table, dialog …)
    ├── features/                one folder per screen (dashboard, convert, pdf, compress, extract, jobs,
    │                            settings, formats, notices)
    ├── generated/notices.json   third-party licence list, produced by `npm run notices`
    tests/ui/                    browser UI tests (Playwright + axe) with a stand-in for the Rust side
    └── styles/tokens.css        every colour, radius and font in one place
```

## 4. Life of one job (Convert a PNG to JPG)

1. **Pick the file.** The user clicks *browse* (or drops a file). The UI asks Tauri for the native
   dialog and gets back a *path*. The UI then calls `inspect_paths` so Rust can report the name and
   size. The UI itself can never read a file; it has no filesystem permission at all.
2. **Preview.** As options change, the UI calls `review_job`. Rust runs a *dry run* in `file-core`
   and returns warnings ("JPEG doesn't support transparency"), name clashes, and blocking problems.
   Nothing is written.
3. **Start.** On *Convert*, `start_job` validates again in Rust, then in the background `client.rs`
   streams the file to `POST /api/v1/jobs` (multipart) with the secret token. The UI instantly gets a
   local *ticket id* and shows "Preparing your files…".
4. **API accepts.** Axum checks the token, the `Origin`/`Host` headers, size and file-count limits,
   sniffs the file's first bytes (is it really an image?), stores it in a private per-job folder under
   a sanitized name, and starts a `file-core` job. It returns `202 Accepted` + a job id.
5. **Core processes** on a worker thread (max 2 at once): decode → fix EXIF rotation → flatten
   transparency onto white → encode → write to a hidden temp file → atomically rename into the job's
   `outputs/`. Progress and cancellation are checked as it goes. Uploaded inputs are deleted the moment
   the job finishes.
6. **UI polls.** Every ~0.8 s the UI calls `get_job_status` → Tauri calls `GET /api/v1/jobs/{id}` →
   percent and state come back. (Polling is deliberately simple; SSE/WebSockets can come later.)
7. **Save.** When the API says *completed*, the UI calls `download_result`. Tauri downloads each result
   file, re-validates every path the server names, applies the user's rule (keep both / replace / skip)
   and moves it into the chosen folder using the same temp-then-rename routine. The original file is
   never touched.
8. **Show result.** "All done · 109 KB → 20.9 KB", plus *Show in folder* (`reveal_output`, which only
   accepts paths the app itself just wrote). The job is recorded in history.
9. **Cleanup.** Job folders are deleted after 10 minutes, on app exit, and any leftovers from a crash
   are wiped on next start.

## 4b. Engines and capabilities

Nothing in the UI or the API assumes what the app can do. Every capability comes from the
**engine registry** in `file-core`:

```
Registry ── Engine (trait) ──┬─ info()        id, name, version, Bundled | Installed | Unavailable{reason}, licence
                             ├─ operations()  id, inputs, outputs, exact conversion pairs (with notes), option specs
                             ├─ preflight()   validate an operation against file descriptions, no disk access
                             ├─ review()      dry run on real paths: conflicts, warnings, blockers
                             └─ run()         do the work (progress, cancellation, temp-then-rename)
```

* Conversions are **pairs** (`png → jpeg`), not one universal "convert". `check_pair` refuses
  anything an engine did not declare.
* File **content** decides the format (`formats::detect` reads magic bytes); extensions are only hints for the UI.
* An engine reporting `Unavailable` keeps its operations in the report (so the UI can show *why*),
  but `engine_for` refuses to run them (`engine_unavailable`).
* Options are data (`OptionSpec`: type, range, which output formats it applies to, and under which
  condition). The Convert screen draws its controls from them: quality shows for JPG and for *lossy*
  WebP only, background colour for JPG only, and so on.
* Versions come from `Cargo.lock` at build time (plus `WebPGetEncoderVersion()` for libwebp), so
  Settings shows the real ones.

**How the UI uses it:** `GET /api/v1/capabilities` (via the `get_capabilities` command) is loaded once
by `CapabilitiesProvider`. Selectors in `src/lib/capabilities.ts` answer "which outputs can *all* these
files reach?", "is this option relevant now?", "why is this tool off?". `CapabilityGate` shows a
workflow only when its operation is available. PDF screens use the same mechanism: their tools are
tied to operation ids (`pdf_merge`, `pdf_annotate`, …) and stay disabled, with a reason, until the
backend reports them, *and* the UI has a screen for them.

**Preview before upload:** `POST /api/v1/jobs/preview` takes file names, sizes and the first 32 bytes
(hex) and returns every problem at once (wrong content, impossible pair, unavailable engine, bad
option, size limits) plus the notes for exactly that conversion. The desktop client calls it before
uploading, so an impossible job is refused before any bytes are copied.

## 4c. The PDF engine (viewing)

PDFium is a large C++ parser for untrusted files, so it **never runs inside the app's process**.

```
PdfEditorPage ──pdf_open / pdf_page_image / pdf_close (Tauri)──▶ ApiClient ──HTTP──▶ file-api /pdf/documents
                                                                                         │ spawn_blocking
                                                                                         ▼
                                                            PdfHost (file-core): permits, timeout, memory cap
                                                                                         │ stdin: one JSON request (file, password, page, width)
                                                                                         ▼
                                                    worker process = this same exe re-run with `--pdf-worker`
                                                    loads pdfium.dll, does ONE thing, prints one JSON line, exits
```

* **Crash isolation.** A crash, hang or memory blow-up in PDFium ends only that worker. The host reports
  `PDF_WORKER_FAILED` for that one call (no internals in the message) and keeps working.
  Limits per call: 60 s timeout (killed), 2 GiB address space (`RLIMIT_AS` on Unix, a Job Object memory
  cap on Windows), at most 3 workers at once, replies capped at 8 MiB, page bitmaps capped at 4096 px wide,
  8192 tall and 24 megapixels, documents at 50 000 pages.
* **No shell, no secrets in arguments.** The worker is started with only the `--pdf-worker` flag. File path and
  password travel over its stdin, so they never appear in a process list, a log or the environment.
* **Documents** are uploaded once (`POST /api/v1/pdf/documents`, multipart: optional `password`, then `file`)
  into their own private folder and stay open until closed, until 8 others are opened after them (least recently
  used goes), until 30 idle minutes pass, or until the app exits. The password is held in memory only, to reopen the
  file for each render; the API never echoes it and never writes it to disk. Pages are numbered from 1 and rendered
  PNGs are cached per document (bounded). The source PDF is never modified.
* **Availability is real.** At first use the host test-loads PDFium in a worker. If the library is missing or
  can't start, the `pdf` engine reports `Unavailable{reason}`, `pdf_view` is listed as unavailable, and the UI
  switches the PDF editor off with that reason. Nothing is simulated.
* **`interactive` operations.** `pdf_view` is flagged `interactive` in the capability report: it is used through
  the editor, not as a batch job. `POST /jobs` and `/jobs/preview` refuse it.
* **What the engine reports** for an open file: page sizes (after the page's own rotation), PDF version, metadata,
  whether it is encrypted and, if so, the author's permission bits (read straight from PDFium's security handler,
  including AES-256 files), form presence, digital-signature count, and plain-language warnings built from those
  facts (signed → editing invalidates signatures; restricted → the author asked to restrict printing/copying/editing).
  Restrictions are shown, not enforced or bypassed.
* **UI.** `PdfProvider` holds the open document so it survives visits to other screens. `PageImages` queues
  page-image requests (3 at a time, previews before thumbnails) and keeps object URLs until the document closes.
  Thumbnails are requested only when they scroll into view. The preview asks for a width matched to the screen
  (zoom × device pixel ratio, rounded so nearby sizes share one render) and never above the engine's reported limit.

### Changing PDFs: merge, split, reorder, rotate, delete, extract (step 5)

All of these are one operation underneath: **build a new PDF from a list of pages** taken from one or more source
files (`Request::Assemble` in the worker, `PdfHost::assemble`, `engine/pdf/ops.rs`). Sources are only read.

* Three job types on the existing job system, so they get preview, conflict policy (Keep both / Replace / Skip), progress,
  cancellation, history and cleanup for free: `pdf_merge` (inputs in the order sent), `pdf_split` (every N pages, or ranges like
  `1-3, 5, 7-`; parts go in a `<name> (split)` folder), and `pdf_pages` (the result is exactly the listed pages, each with an extra
  rotation of 0/90/180/270 on top of what the page already has). Reorder, rotate, delete and extract are all `pdf_pages`.
* The capability report lists `pdf_merge`, `pdf_split`, `pdf_reorder`, `pdf_rotate`, `pdf_delete_pages`, `pdf_extract_pages`
  (the last four `interactive`: used from the editor). `Engine::handles` lets one engine answer for `pdf_pages` without
  advertising it as a separate operation.
* Output is written by the worker to a temp file next to the destination and moved into place with `fs_safe::commit`, which
  refuses to overwrite a source file even under Replace. A failed, cancelled or timed-out job leaves no file and no empty folder.
  Cancelling stops the worker process. Assembling has its own, longer timeout (15 min) and the same 2 GiB memory cap.
* Consecutive pages from one file are copied in a single PDFium call so fonts and images are shared rather than stored per page.
* **What is not carried over:** bookmarks, document-level form data and document properties (title, author). The new file is
  not password-protected even if the source was. The review step says so before anything is written, and a test holds the
  properties claim to the truth.
* Passwords for merge/split/`pdf_pages` are job options (one password, tried for every protected input), never stored or logged.
* **Editor UI.** The open document has a *page plan* (`features/pdf/plan.ts`, pure functions): order, per-page rotation, deletions.
  Changes are instant (rotation is a CSS turn of the engine's picture) and only become a file when the user presses Save Copy
  or Extract, which start a `pdf_pages` job. Unsaved changes are announced, can be reset, and closing/replacing the document asks
  first. Selection: click, Ctrl-click, Shift-click, Ctrl+A; Alt+Up/Down moves pages, Delete removes them. Drag-reordering uses
  pointer events, not HTML5 drag-and-drop, because the desktop shell takes over drag-and-drop for dropped files on Windows.
  Split and Merge from inside the editor use the file on disk, so they are disabled while changes are unsaved.
* Merge and Split have their own screens (`MergePage`, `SplitPage`); the dashboard offers them when PDFs are selected.

### Annotations, pictures ↔ PDF, Office to PDF (step 6)

* **Annotations** (`engine/pdf/annotate.rs` data + validation, `draw.rs` drawing, applied inside `worker::assemble`). `pdf_pages` gained an
  `annotations` list; the new copy is built from the chosen pages, then each annotation is drawn into its page *before* the extra rotation, so a page the
  user turned still gets its marks in the right place. Coordinates are points on the page **as the engine draws it** (after the page's own `/Rotate`),
  origin top-left; `draw::Frame` converts them to PDF page space (verified on all four rotations and a non-zero MediaBox origin). Pictures placed on
  pages are extra job inputs after the PDF; an annotation refers to them by index. Text is limited to Helvetica (Latin). The server rejects what it can't draw.
* **Editor UI** (`features/pdf/annotations/`): `model.ts` is pure (bounds, move/scale, hit-testing, text wrapping, wire conversion, undo history; unit tests in
  `tests/unit`), `useAnnotations.ts` holds the list + undo/redo inside `PdfProvider`, `AnnotationLayer.tsx` is an SVG laid over the page picture and turned with it
  (positions come from `getScreenCTM().inverse()`, so rotation costs nothing), `AnnotationBar.tsx` the colour/width/size controls, `SignatureDialog.tsx` the pad.
  The preview wraps text with canvas `measureText` in Helvetica metrics and the same line height and baseline as the backend; the wrapped text is what is sent.
  Picture files are read in Rust (`read_picture`, content-checked, 40 MB cap) and shown from a blob URL; the original path is what the job reads.
* **Images → PDF** (`ImagesToPdfOptions`, `worker::images_to_pdf`): layout computed in the worker; JPEG passthrough when upright 8-bit RGB/grey, otherwise decoded with
  the EXIF orientation applied. **PDF → images** (`Request::Export`, own larger caps than previews): PDFium renders, PNG is encoded in the worker, JPG/WebP are
  re-encoded by `engine/image.rs`. Both are ordinary jobs, with preview, conflicts, cancel and history.
* **Office → PDF** (`engine/office.rs`, engine id `office`, operation `office_to_pdf`). `OfficeHost` finds `soffice` (bundled folder first, then an installed
  LibreOffice), probes `--version` once, and runs one document at a time: private work folder beside the output, profile with macros/link updates off, argument
  list (no shell), own process group (Windows: Job Object) killed on cancel or timeout, result moved into place with `fs_safe::commit`. `Availability` is `Bundled`,
  `Installed` or `Unavailable{reason}`; the UI tells the user which. Detection is by content (`formats::detect_office_file`).
* New error `office_conversion_failed` (plain message, shown per file).

Not done yet: forms, text editing, OCR. Export stays disabled with the reason.

## 5. Why there is an HTTP API inside a desktop app

It gives a real, testable boundary (21 tests exercise it over actual HTTP) and keeps `file-core`
reusable: the same engine could be hosted on a server later without a rewrite. For now it runs in
"**local mode**" only, so no file ever leaves the computer.

The API **refuses to bind to anything but loopback** (`127.0.0.1`); hosted mode (HTTPS, user
accounts, quotas) is intentionally not implemented. Trade-off: files are copied into the API's job
folder (a localhost transfer), which costs some disk I/O for very large files.

### Endpoints
```
GET    /health                            status + version only (no auth)
GET    /api/v1/capabilities               engines, operations, pairs, options, formats, limits
POST   /api/v1/jobs/preview               JSON: operation, options, files[{name,size,head_hex}] → problems + notes, uploads nothing
POST   /api/v1/jobs                       multipart: operation (compress | extract | convert | pdf_merge | pdf_split | pdf_pages), options (JSON), files → 202 {job_id}
GET    /api/v1/jobs/{id}                  status, progress, per-file results
DELETE /api/v1/jobs/{id}                  cancel (409 if already finished)
POST   /api/v1/jobs/{id}/cancel           same as DELETE
GET    /api/v1/jobs/{id}/result           the single output file, or a ZIP bundle
GET    /api/v1/jobs/{id}/result/files     manifest (relative paths, sizes, folders)
GET    /api/v1/jobs/{id}/result/files/{n} one result file
POST   /api/v1/pdf/documents              multipart: [password], file → 201 {id, name, size, info}   (422 PASSWORD_REQUIRED / WRONG_PASSWORD / CORRUPT_PDF)
GET    /api/v1/pdf/documents/{id}         the same description again
GET    /api/v1/pdf/documents/{id}/pages/{n}/image?width=   page n (from 1) as image/png; width clamped to 16..4096 (404 PAGE_NOT_FOUND)
DELETE /api/v1/pdf/documents/{id}         close and delete everything held for it (204)
```
Errors are always `{"error": {"code", "message", "request_id"}}` with proper status codes
(400, 401, 403, 404, 409, 413, 415, 422, 429, 500). `415` covers `UNSUPPORTED_FORMAT` and `UNSUPPORTED_CONVERSION`; `422` covers `ENGINE_UNAVAILABLE`, `PASSWORD_REQUIRED`, `WRONG_PASSWORD` and `CORRUPT_PDF`. Errors never include server paths or stack traces.

### Commands the UI can call (Tauri)
`api_status`, `get_capabilities`, `inspect_paths`, `list_archive`, `review_job`, `start_job`, `get_job_status`,
`cancel_job`, `download_result`, `reveal_output`, `clear_history`, `pdf_open`, `pdf_page_image` (raw PNG bytes), `pdf_close`.

## 6. Security model in one page

- **Local only:** server bound to `127.0.0.1`, random port, fresh 244-bit token every launch, held only
  in Rust memory. The webview never sees the URL or token.
- **No browser access:** any request carrying an `Origin` header is refused (blocks web pages), and
  the `Host` must be a loopback name (blocks DNS-rebinding).
- **Narrow UI powers:** the webview may only call our own commands, open the file/folder *dialogs*,
  and drive the window buttons. No filesystem plugin, no shell, no network except the app itself.
- **Archive safety:** every ZIP entry name is validated *before anything is written*; `..`, absolute
  paths, drive letters, device names (`CON`, `NUL`…) are rejected; symlinks are never created;
  expansion is capped (declared *and* actual bytes) against zip bombs.
- **Never lose data:** originals are never overwritten (even with "Replace" the code refuses to replace
  a source file); output is written to a temp file and renamed only on success; cancel/failure leaves
  nothing half-written.
- **Privacy:** passwords never appear in logs, history or `Debug` output; history stores only names,
  sizes and results, is clearable and has a retention setting; uploaded inputs are deleted right after
  processing; logs record job ids and status, never file contents or tokens.

## 7. How the UI is built

- **State lives in providers** (`src/app`): `JobsProvider` starts jobs, polls them, downloads results
  and keeps history; `SelectionProvider` holds the files picked (shared between dashboard and
  workflows); `SettingsProvider`, `ToastProvider`, `DropProvider`, `NavProvider` do what they say.
- **Services are the only code that calls Rust** (`src/services`); components never call `invoke`.
- **One shared run flow** (`features/workflow`): dry-run review → conflict dialog if needed → start →
  progress → result. Compress, Convert and Extract each only supply their own form and request.
- **Design tokens** (`styles/tokens.css`) hold every colour/size. Brand orange `#F47B20` is used for
  fills and icons; darker `#B04C07` is used for small orange *text* so it meets contrast rules.
- **Accessibility:** keyboard-operable everywhere, visible focus rings, focus-trapped dialogs, labelled
  controls, live regions for progress/toasts, reduced-motion support; axe-core finds 0 WCAG A/AA issues
  on all six screens.

## 8. Running, testing, building

```bash
npm install
npm run tauri dev          # run the desktop app with hot reload  (needs Rust + WebView2 on Windows)
npm run tauri build        # produce the Windows installer (MSI / NSIS)

npm run get-libreoffice    # Windows: unpack the pinned LibreOffice into src-tauri/resources/libreoffice (needs the SHA-256 pinned first)
npm run build:installer    # get-pdfium + get-libreoffice + notices + tauri build: the full Windows installer
npm run test:unit          # annotation model tests (Node 22+)
npm run get-pdfium         # fetch PDFium for this platform (pinned SHA-256; `npm run tauri ...` does it automatically)
cargo test                 # core + API tests; no GUI libraries needed. PDF tests need PDFium, see below
npm run test:ui            # 188 browser checks incl. axe accessibility; set CHROMIUM_PATH (Windows falls back to Edge)
npm run notices            # regenerate the third-party licence list
npm run typecheck          # TypeScript
npm run lint               # ESLint
npm run build              # production frontend build
```
Linux needs `libwebkit2gtk-4.1-dev` etc. to build the shell; the `file-core`/`file-api` tests do not.

**PDF tests** load a real PDFium. Point `ORANGEFILE_PDFIUM` at the folder that holds it
(after `npm run get-pdfium` that is `src-tauri/resources/pdfium`; the variable is honoured in debug builds only).
Without it those tests print "skipped" and return; set `ORANGEFILE_REQUIRE_PDFIUM=1` to make that a failure
(use this in CI). The `src-tauri` client test additionally needs `cargo build -p file-core` first (it uses the
`of-pdf-worker` binary). Fixtures live in `crates/file-core/tests/fixtures/pdf` and are regenerated by
`tools/gen_pdf_fixtures.py` (reportlab + pypdf; not part of the build).

## 9. Status: implemented, available when an engine exists, planned

| Area | Status |
|---|---|
| ZIP compress / extract (incl. AES-encrypted entries, traversal and zip-bomb defences) | **Implemented** |
| JPG / PNG / WebP conversion; lossy **and** lossless WebP; transparency, EXIF orientation, ICC profiles, background colour for JPG | **Implemented** |
| Engine registry, capability report, preview endpoint, capability-driven UI, formats directory, third-party notices | **Implemented** |
| **PDF open, page thumbnails, large preview, zoom, page navigation, passwords, document details, warnings** (PDFium in a sandboxed worker) | **Implemented** (step 4). Available only while the bundled PDFium library loads; otherwise reported unavailable with a reason |
| **PDF merge, split, reorder, rotate, delete, extract** (PDFium page import in the sandboxed worker; Save Copy and Extract from the editor, Merge and Split screens) | **Implemented** (step 5). Same availability rule as viewing |
| **PDF annotations** (highlight, underline, strike, notes, text, pen, shapes, pictures, visual signature; move/resize/undo; Save Copy) | **Implemented** (step 6). Latin text only; flattened into the copy |
| **Images → PDF, PDF → images** | **Implemented** (step 6) |
| **Word / Excel / PowerPoint / OpenDocument → PDF** (LibreOffice headless) | **Implemented** (step 6), tested on Linux against LibreOffice 24.2. Bundled in the Windows installer by `npm run build:installer` once its hash is pinned; otherwise an installed LibreOffice is used |
| PDF forms, Export | **Planned.** Shown disabled until the backend reports them *and* a screen exists |
| Audio/video (FFmpeg), 7-Zip family | **Planned.** Optional engines, shown as unavailable until installed and verified |
| RAR | **Not planned** until licensing is reviewed. No RAR creation, ever |

Known limits today:
- Images are limited to 32 768 px per side (16 383 for WebP); a damaged or cut-off image is reported, never silently converted.
- History is kept by the UI in local storage; "Show in folder" works only for jobs from the current session.
- Empty folders are not preserved when compressing; uploads are files.
- Files are copied into the local API's job folder (a localhost transfer), which costs disk time for very large files.
- The installer is unsigned, there is no auto-update, and the app icon is a placeholder.
- The desktop client layer (`src-tauri`) is tested by Rust tests against a real in-process API (including the PDF calls) plus the UI suite with a stand-in bridge.
- **Windows is untested for step 6 as well:** the LibreOffice Job Object / process-group handling, `msiexec /a` unpacking in `get-libreoffice.mjs`, locating `libreoffice/program/soffice.exe` in the installed resource folder, and converting documents on Windows were written and type-checked but never run on Windows. The UI tests for the three new screens and the annotation editor are not written yet (only the model's unit tests and the existing suite).
- Annotation text can't use non-Latin scripts; highlights don't snap to words; annotations are flattened into the copy.
- **Windows is untested for PDF.** The Job Object memory cap, the worker re-launch from a GUI-subsystem exe and loading `pdfium.dll` from the installer's resource folder are written and type-checked for Windows but have only been run on Linux. Test them first on a Windows machine.
- PDF page images reach the webview as a raw binary IPC response; this works in the Linux WebKit run and is expected to work in WebView2 but is not yet confirmed there.
- Pages are drawn with PDFium's default font fallbacks; a PDF that relies on fonts not embedded in it can look different from Acrobat. XFA forms and JavaScript are not supported (PDFium is built without them).
- A truncated or partly damaged PDF may open with the pages PDFium can recover instead of being rejected.
- Everything was built and run on Linux. The frameless window and WebView2 rendering still need a pass on Windows
  (flip `decorations` to `true` in `tauri.conf.json` for the native title bar).

## 10. Packaging and licences

- libwebp (BSD-3-Clause) is compiled into the app; its licence text ships in **Settings → Third-party notices**,
  generated by `npm run notices` from `cargo metadata` and `npm ls` (re-run before every release).
- Five MPL-2.0 crates (`cssparser`, `cssparser-macros`, `selectors`, `dtoa-short`, `option-ext`, pulled in by Tauri) and the
  OFL-1.1 Inter font carry conditions: keep their notices, keep MPL source available. The installer must bundle their full texts.
- **PDFium** (BSD-3-Clause / Apache-2.0, plus its own bundled libraries: FreeType, ICU, zlib, libpng, OpenJPEG, LittleCMS…) ships as
  `pdfium.dll` in the installer's `pdfium` resource folder together with `licenses/*.txt` and a `VERSION` file. It is **not** in the
  repository. `scripts/get-pdfium.mjs` (run automatically before `npm run tauri …`) downloads the build published by
  pdfium-binaries inside the pypdfium2 wheel on PyPI and installs it only if both the wheel and the DLL inside it match pinned SHA-256
  values; otherwise it deletes nothing, installs nothing and fails. Pinned today: pypdfium2 5.14.0 (PDFium 156.0.8076), Windows x64 and
  Linux x64. Run `npm run notices` after fetching so the notices screen lists the exact version and quotes PDFium's licence texts.
  Changing PDFium means changing the pins after checking the new hashes.
- **LibreOffice** (MPL-2.0 plus the licences of the libraries inside it) ships in the Windows installer as the `libreoffice` resource folder
  (about 350 MB of installer, ~1 GB installed; this is the cost of "Word to PDF works with nothing else installed"). It is not in the repository.
  `npm run get-libreoffice` (run by `npm run build:installer`) downloads the official MSI named in `scripts/libreoffice-pin.json`, **refuses to unpack it unless its SHA-256
  equals the pin** (with no pin it refuses; `--trust-published-hash` is an explicit, loudly-warned first-time shortcut), unpacks it with `msiexec /a` (no installation),
  trims a few unused folders, checks that `soffice.exe --version` runs, and records licences plus a `SOURCE.txt` pointing at the source code (MPL). The pin must be filled in by
  a person who has compared the hash with libreoffice.org; the script cannot do that for you. LibreOffice stays a separate program (it is never linked into OrangeFile).
- When optional engines arrive (FFmpeg, 7-Zip): review each exact build's licence first, show
  name / size / source / licence before any download, verify a pinned checksum or signature, never install silently.


## 11. Planned: Global Drag Action Wheel (gated on a Windows feasibility probe)

**Status: not built.** A drag from Explorer + a global shortcut should show a radial wheel of quick actions without opening the main
window; dropping on an action starts a normal job. Whether Windows delivers an in-progress Explorer drag to a window that is shown *after*
the drag began cannot be tested on Linux, so Phase 0 is a separate probe (`prototypes/drag-wheel-probe`, see its `PHASE0.md`). The feature
is built only if the probe's answers are good. Findings so far, from reading the code: wry (Tauri's webview layer) registers a real OLE
`IDropTarget` on WebView2 and reads `CF_HDROP` paths at *enter*, not only at drop, so the wheel can know the file types before the drop;
`WebviewEvent::DragDrop` is available in Rust, so dropped paths need never come from the page.

Map of how it would fit (nothing here exists yet):
1. **Lifecycle (Rust, `src-tauri`).** `tray-icon` feature + tray menu (Open OrangeFile, Quick Actions, Settings, Exit). Close-to-tray via
   `CloseRequested` + `prevent_close` when "Keep running in background" is on. Exit reuses the existing `RunEvent::Exit` path (stops the API,
   deletes job folders) and additionally unregisters shortcuts and closes the overlay. Settings that must be known before the UI loads
   (background, autostart, shortcut, start minimized) move to a small Rust-owned `settings.json` in the app config dir; the UI edits them
   through commands. Autostart via `tauri-plugin-autostart`, opt-in, off by default, shown in Settings.
2. **Shortcut.** `tauri-plugin-global-shortcut` registering only the configured combination; registration errors are returned to Settings
   (conflict), never swallowed. Default Ctrl+Shift+Space.
3. **Overlay.** A second, pre-created hidden window (`quick-wheel`: transparent, undecorated, always on top, not focusable, not in the
   taskbar) with its own small React entry and its own capability file (no dialog, no fs). Shown near the cursor inside the monitor work area
   (physical pixels, per-monitor scale). Escape and "button released" are detected by polling key/button state only while visible.
4. **Actions from real capabilities.** A Rust command `quick_action_preview(drop_id)`: re-validates the paths held in Rust state (exists, not a
   symlink to elsewhere, file or folder, size), sniffs content with `formats::detect_file`, and builds the action list from
   `Registry::capabilities()` (same `OperationSpec`/pairs the Convert screen uses): images → "Convert to X" for each pair except the input
   format; ZIP → Extract here / Extract to a new folder; folder → Compress to ZIP; PDF → Open in editor, and Merge/Split only where the
   operation is available. Mixed multi-selection → only actions valid for every item; "Process each supported file" only for
   per-file-result operations (convert, extract). No actions → "No quick actions available for this item".
5. **Dispatch.** `quick_action_run(drop_id, action_id)` takes ids, never paths: Rust looks up the paths it stored from the OS drop event,
   builds the same `JobRequest` the screens build, calls the existing review (conflicts → compact confirmation with Keep both / Replace / Skip;
   a source is never replaced), then `start_job`. Progress and results reuse job ids, the history and `reveal_output`; a compact toast window
   shows them. Stable error codes added: `UNSUPPORTED_TYPE`, `ENGINE_UNAVAILABLE` (exists), `BLOCKED_PATH`, `OUTPUT_CONFLICT`, `INVALID_DRAG_PAYLOAD`.
6. **Optional "start quick actions immediately"** only for conversions, which never touch the original and always use Keep-both names.

## 12. The web version

`web/` is a browser version of the app (React + Tailwind) that uses the same engine API. See `web/README.md` for how to run it and `ARCHITECTURE-WEB.md` for how it works today and the backend recommended for hosting it (a proposal; not built).
