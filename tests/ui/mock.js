// TEST HARNESS ONLY: stands in for the Rust side so the real React UI can be exercised in a browser.
// Capabilities come from tests/ui/fixtures/capabilities.json, captured from the real Axum API.
(() => {
  const M = (window.__MOCK = window.__MOCK || {});
  window.isTauri = true;
  const callbacks = {}; let cbId = 1; const listeners = {};
  const FS = {
    "/home/amine/Pictures/logo.webp": { name: "logo.webp", size: 320000 },
    "/home/amine/Pictures/holiday.png": { name: "holiday.png", size: 3200000 },
    "/home/amine/Pictures/portrait.jpg": { name: "portrait.jpg", size: 2450000 },
    "/home/amine/Documents/invoice.pdf": { name: "invoice.pdf", size: 210000, pdf: { pages: 3 } },
    "/home/amine/Documents/report.pdf": { name: "report.pdf", size: 482000, pdf: { pages: 3, title: "Quarterly report", author: "A. Writer", sizes: [[595, 842], [842, 595], [595, 842]] } },
    "/home/amine/Documents/slow.pdf": { name: "slow.pdf", size: 1000, pdf: { pages: 2, delay: 700 } },
    "/home/amine/Documents/long.pdf": { name: "long.pdf", size: 9400000, pdf: { pages: 60 } },
    "/home/amine/Documents/locked.pdf": { name: "locked.pdf", size: 52000, pdf: { pages: 2, locked: "open-sesame", encrypted: true } },
    "/home/amine/Documents/signed.pdf": { name: "signed.pdf", size: 77000, pdf: { pages: 1, signatures: 2, form: true, restricted: true, encrypted: true } },
    "/home/amine/Documents/broken.pdf": { name: "broken.pdf", size: 900, pdf: { broken: true } },
    "/home/amine/Documents/proposal.docx": { name: "proposal.docx", size: 88000 },
    "/home/amine/Documents/budget.xlsx": { name: "budget.xlsx", size: 41000 },
    "/home/amine/Documents/slides.pptx": { name: "slides.pptx", size: 1250000 },
    "/home/amine/Documents/legacy.doc": { name: "legacy.doc", size: 54000 },
    "/home/amine/Pictures/stamp.png": { name: "stamp.png", size: 5200 },
    "/home/amine/Documents/photo-set": { name: "photo-set", size: 248000000, is_dir: true, file_count: 112 },
    "/home/amine/Downloads/backup.zip": { name: "backup.zip", size: 18400000 },
    "/home/amine/Downloads/secret.zip": { name: "secret.zip", size: 90000, pw: true },
    "/home/amine/Downloads/evil.zip": { name: "evil.zip", size: 1200, unsafe: true },
  };
  const tickets = {}; let n = 0; let docN = 0; const docs = {};
  M.opened = []; M.closed = []; M.pageCalls = []; M.pdfOpenCalls = [];
  // A real PNG for a page, drawn in the browser: a coloured sheet with the page number and the width asked for.
  const drawPage = async (doc, page, width) => {
    const [pw, ph] = doc.sizes[(page - 1) % doc.sizes.length];
    const w = Math.round(width), h = Math.max(1, Math.round((width * ph) / pw));
    const c = new OffscreenCanvas(w, h); const g = c.getContext("2d");
    g.fillStyle = ["#fff7ef", "#eef6ff", "#f1fbf3"][(page - 1) % 3]; g.fillRect(0, 0, w, h);
    g.fillStyle = "#1c1e22"; g.font = `bold ${Math.round(w / 8)}px sans-serif`; g.fillText(`Page ${page}`, w / 10, h / 6);
    g.font = `${Math.round(w / 20)}px sans-serif`; g.fillText(`${w} px wide`, w / 10, h / 4);
    return (await c.convertToBlob({ type: "image/png" })).arrayBuffer();
  };
  const err = (code, message) => { throw { code, message }; };
  const handlers = {
    "plugin:event|listen": (a) => { (listeners[a.event] ||= []).push(a.handler); return a.handler; },
    "plugin:event|unlisten": () => null,
    "plugin:window|is_decorated": () => false,
    "plugin:window|is_maximized": () => false,
    "plugin:app|version": () => "0.1.0",
    "plugin:dialog|open": () => M.nextDialog ?? [],
    get_capabilities: () => (M.capsError ? err("SERVICE_UNAVAILABLE", "The processing service isn't responding.") : M.caps),
    api_status: () => (M.down ? err("SERVICE_UNAVAILABLE", "down") : { connected: true, version: "0.1.0" }),
    inspect_paths: ({ paths }) => paths.map((p) => {
      const f = FS[p]; if (!f) err("NOT_FOUND", `“${p.split("/").pop()}” couldn't be found. It may have been moved or deleted.`);
      return { path: p, name: f.name, is_dir: !!f.is_dir, size: f.size, file_count: f.file_count ?? 1 };
    }),
    list_archive: ({ path }) => {
      const f = FS[path];
      if (f.name === "broken.zip") err("CORRUPT_ARCHIVE", "This archive is damaged or isn't a valid ZIP file.");
      return { entries: [], file_count: f.unsafe ? 2 : 24, total_uncompressed: f.size * 3, total_compressed: f.size, needs_password: !!f.pw, unsafe_entries: f.unsafe ? 1 : 0, suspicious_ratio: false };
    },
    review_job: ({ request }) => {
      const op = request.operation; const warnings = [];
      if (op.type === "convert_image" && op.format === "jpeg") warnings.push(`JPEG doesn't support transparency. Transparent areas will be filled with ${(op.background ?? "#FFFFFF").toUpperCase()}.`, "JPEG is a lossy format: each save reduces image quality slightly.");
      if (op.type === "convert_image" && op.format === "webp") warnings.push(op.webp_mode === "lossless" ? "Lossless WebP keeps every pixel exactly, so files are larger than lossy WebP or JPG." : `Lossy WebP reduces quality slightly (quality ${op.quality ?? 85}). Transparency is kept.`);
      if (op.type.startsWith("pdf_")) warnings.push("The new PDF keeps how every page looks. Document-level extras such as bookmarks, form-filling data and properties (title, author) are not carried over.");
      if (op.type === "pdf_split") warnings.push("This will make 4 new PDFs.");
      if (op.type === "pdf_pages" && op.annotations?.length) warnings.push(`${op.annotations.length} annotation(s) will be drawn into the pages. They become part of the page content and can't be edited afterwards.`);
      if (op.type === "pdf_to_images") warnings.push("This will make 6 pictures.");
      if (op.type === "office_to_pdf") warnings.push("The PDF is drawn by LibreOffice, so fonts, spacing and page breaks can differ from how Microsoft Office shows the document. Macros are never run.");
      const conflicts = M.conflicts ? M.conflicts.map((c) => request.output_dir + "/" + c) : [];
      return { conflicts, warnings, errors: [], needs_password: false, total_bytes: 1 };
    },
    start_job: ({ request }) => {
      if (M.startError) err("INVALID_REQUEST", M.startError);
      const id = "task_" + ++n; tickets[id] = { t0: Date.now(), request, cancelled: false }; M.lastRequest = request; (M.requests ||= []).push(request); return id;
    },
    get_job_status: ({ jobId }) => {
      const t = tickets[jobId]; if (!t) err("JOB_NOT_FOUND", "That job isn't available any more.");
      const el = (Date.now() - t.t0) / 1000; const total = 5000000;
      const base = { job_id: jobId, operation: "x" };
      const dur = M.processSeconds ?? 3;
      if (t.cancelled) return { ...base, phase: "cancelled", upload: { sent: 0, total }, job: null, error: null };
      if (el < 1) return { ...base, phase: "uploading", upload: { sent: Math.floor(total * el), total }, job: null, error: null };
      const p = Math.min(100, Math.floor(((el - 1) / dur) * 100));
      const mk = (status, extra = {}) => ({ job_id: "job_x", operation: "x", status, progress: { files_completed: 1, files_total: 3, percent: p, bytes_processed: 0, bytes_total: null }, current_file: null, results: [], error: null, message: null, ...extra });
      let job;
      if (p < 100) job = mk(p === 0 ? "queued" : "running");
      else if (M.fail) job = mk("failed", { error: { code: M.fail.code, message: M.fail.message }, results: [{ input: "x", outcome: "failed", output: null, error_code: M.fail.code, message: M.fail.message }] });
      else job = mk("completed", { results: M.results ?? [] });
      return { ...base, phase: "processing", upload: { sent: total, total }, job, error: null };
    },
    download_result: ({ jobId }) => { const t = tickets[jobId]; return { outputs: [t.request.output_dir + "/result"], files_saved: M.filesSaved ?? 3, files_skipped: 0, bytes_saved: M.bytesSaved ?? 1450000 }; },
    cancel_job: ({ jobId }) => { tickets[jobId].cancelled = true; return null; },
    reveal_output: () => (M.revealCalls = (M.revealCalls || 0) + 1, null),
    clear_history: () => null,
    pdf_open: async ({ path, password }) => {
      M.pdfOpenCalls.push({ path, hasPassword: !!password });
      const f = FS[path]; if (!f || !f.pdf) err("NOT_FOUND", `“${path.split("/").pop()}” couldn't be found. It may have been moved or deleted.`);
      const d = f.pdf;
      if (d.delay) await new Promise((r) => setTimeout(r, d.delay));
      if (M.pdfDown) err("ENGINE_UNAVAILABLE", "PDF tools (PDFium) isn't available: The PDF engine file (libpdfium.so) is missing from this installation. Reinstalling OrangeFile restores it.");
      if (d.broken) err("CORRUPT_PDF", "This PDF is damaged or isn't a valid PDF file.");
      if (d.locked) {
        if (!password) err("PASSWORD_REQUIRED", "This file is password-protected. Enter the password to open it.");
        if (password !== d.locked) err("WRONG_PASSWORD", "The password is incorrect.");
      }
      const sizes = d.sizes ?? [[595, 842]];
      const id = "doc_" + ++docN;
      docs[id] = { sizes: Array.from({ length: d.pages }, (_, i) => sizes[i % sizes.length]) };
      M.opened.push(id);
      const warnings = [];
      if (d.signatures) warnings.push(`This PDF has ${d.signatures} digital signatures. Editing it will invalidate them. OrangeFile can't create or verify digital signatures.`);
      if (d.restricted) warnings.push("The author of this PDF has asked to restrict printing, copying text, editing.");
      return {
        id, name: f.name, size: f.size,
        info: {
          page_count: d.pages, pages: docs[id].sizes.map(([w, h]) => ({ width_pt: w, height_pt: h })), version: "1.7",
          encrypted: !!d.encrypted, permissions: d.restricted ? { print: false, copy: false, modify: false, annotate: false, fill_forms: false, assemble: false } : null,
          has_form: !!d.form, signature_count: d.signatures ?? 0,
          metadata: { title: d.title ?? null, author: d.author ?? null, subject: null, keywords: null, creator: "Word", producer: null, created: d.title ? "D:20240102120000Z" : null, modified: null },
          warnings,
        },
      };
    },
    pdf_page_image: async ({ documentId, page, width }) => {
      const doc = docs[documentId]; if (!doc || M.closed.includes(documentId)) err("DOCUMENT_NOT_FOUND", "No such document. It may have been closed; open it again.");
      M.pageCalls.push({ documentId, page, width });
      if (M.failPages?.includes(page)) err("PDF_WORKER_FAILED", "The PDF engine stopped while reading this file. It may be damaged, or too complex to open safely.");
      await new Promise((r) => setTimeout(r, M.pageDelay ?? 20));
      return drawPage(doc, page, width);
    },
    // A small picture, as the Rust side would hand over the bytes of the chosen file.
    read_picture: async ({ path }) => {
      M.pictureReads = [...(M.pictureReads || []), path];
      if (M.pictureError) err("UNSUPPORTED_FORMAT", "Choose a JPG, PNG or WebP picture.");
      const c = new OffscreenCanvas(80, 40); const g = c.getContext("2d");
      g.fillStyle = "#2e7d32"; g.fillRect(0, 0, 80, 40); g.fillStyle = "#fff"; g.fillRect(10, 10, 20, 20);
      return (await c.convertToBlob({ type: "image/png" })).arrayBuffer();
    },
    pdf_close: ({ documentId }) => (M.closed.push(documentId), null),
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback(cb) { const id = cbId++; callbacks[id] = cb; return id; },
    unregisterCallback(id) { delete callbacks[id]; },
    convertFileSrc: (p) => p,
    invoke: async (cmd, args) => { await new Promise((r) => setTimeout(r, 15)); const h = handlers[cmd]; if (!h) { console.warn("unhandled", cmd); return null; } return h(args || {}); },
  };
  window.__emit = (event, payload) => (listeners[event] || []).forEach((id) => callbacks[id] && callbacks[id]({ event, id, payload }));
  window.__dropFiles = (paths) => window.__emit("tauri://drag-drop", { paths, position: { x: 400, y: 300 } });
  window.__hover = () => window.__emit("tauri://drag-over", { position: { x: 400, y: 300 } });
  window.__seedHistory = (arr) => localStorage.setItem("orangefile.history.v1", JSON.stringify(arr));
})();
