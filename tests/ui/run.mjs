// UI tests: the real React app in a real browser, with the Rust side replaced by tests/ui/mock.js.
// Run:  npm run test:ui     (set CHROMIUM_PATH to a Chrome/Chromium binary; on Windows it falls back to Edge)
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const mock = readFileSync(new URL("./mock.js", import.meta.url), "utf8");
const axeSrc = readFileSync(new URL("../../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const realCaps = JSON.parse(readFileSync(new URL("./fixtures/capabilities.json", import.meta.url), "utf8"));
const capsPdfOff = JSON.parse(readFileSync(new URL("./fixtures/capabilities-pdf-unavailable.json", import.meta.url), "utf8"));
// A build that has no PDF engine at all (what older versions reported).
const capsNoPdf = (() => { const c = JSON.parse(JSON.stringify(realCaps)); c.engines = c.engines.filter((e) => e.id !== "pdf" && e.id !== "office"); c.operations = c.operations.filter((o) => !o.id.startsWith("pdf_") && !o.id.endsWith("_to_pdf")); return c; })();
// LibreOffice not found (the Office engine's own wording when nothing is bundled or installed).
const capsOfficeOff = (() => { const c = JSON.parse(JSON.stringify(realCaps)); const reason = "LibreOffice (used to convert Word, Excel and PowerPoint files) was not found."; c.engines.find((e) => e.id === "office").availability = { status: "unavailable", reason }; const op = c.operations.find((o) => o.id === "office_to_pdf"); op.available = false; op.unavailable_reason = reason; return c; })();
const OUT = new URL("./out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const URL_ = "http://localhost:1420/";

let failures = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { failures++; console.log("  FAIL", msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const section = (n) => console.log("\n" + n);

// ---- start the dev server
const vite = spawn("npx", ["vite", "--port", "1420", "--strictPort"], { cwd: root.pathname, shell: process.platform === "win32", stdio: "ignore" });
for (let i = 0; i < 60; i++) { try { if ((await fetch(URL_)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] } : { channel: "msedge" });

const clone = (o) => JSON.parse(JSON.stringify(o));
const at = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };
const HISTORY = (() => {
  const base = { sessionId: "old", detail: null, inputNames: [], outputBytes: null, outputDir: "/x", outputs: ["/x/o"], percent: 100, finishedAt: Date.now(), error: null, results: [], filesSaved: 1, filesSkipped: 0 };
  return [
    { ...base, id: "a", kind: "compress", title: "photo-set.zip", inputBytes: 248e6, outputBytes: 62e6, status: "completed", createdAt: at(0, 5) },
    { ...base, id: "b", kind: "convert", detail: "PNG → JPG", title: "IMG_0916.PNG", inputBytes: 3.2e6, outputBytes: 4.1e6, status: "completed", createdAt: at(0, 3) },
    { ...base, id: "c", kind: "convert", detail: "WEBP → PNG", title: "logo.webp", inputBytes: 320e3, status: "failed", error: { code: "CORRUPT_IMAGE", message: "This image is damaged or incomplete." }, createdAt: at(0, 1) },
  ];
})();

async function open({ caps = realCaps, history = HISTORY, w = 1269, h = 794, capsError = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1.25 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.addInitScript(mock);
  await page.addInitScript(([c, hist, err]) => { window.__MOCK.caps = c; window.__MOCK.capsError = err; if (hist && !localStorage.getItem("orangefile.history.v1")) localStorage.setItem("orangefile.history.v1", JSON.stringify(hist)); }, [caps, history, capsError]);
  await page.goto(URL_);
  await page.waitForSelector(".shell");
  const api = {
    page, errors, ctx,
    nav: (name) => page.locator(".sidebar").getByRole("button", { name, exact: true }).click(),
    drop: (paths) => page.evaluate((p) => window.__dropFiles(p), paths),
    shot: (name) => page.screenshot({ path: `${OUT}${name}.png` }),
    texts: (sel) => page.locator(sel).allInnerTexts().then((a) => a.map((t) => t.replace(/\s+/g, " ").trim())),
    close: () => ctx.close(),
  };
  return api;
}

const PICS = "/home/amine/Pictures/";
try {
  // ------------------------------------------------------------------ dashboard
  section("Dashboard matches the design");
  {
    const a = await open();
    const { page } = a;
    await page.waitForSelector(".jobtable");
    eq(await a.texts(".sidebar .nav-item"), ["Dashboard", "Convert", "PDF Tools", "Compress", "Extract", "Recent Jobs", "Settings"], "sidebar order");
    ok(/^Good (morning|afternoon|evening), Amine$/.test((await page.locator("h1").innerText()).trim()), "greeting");
    eq((await page.locator("h1 + p").innerText()).trim(), "Manage and transform your files in one place.", "subtitle");
    eq((await page.locator(".dropzone__hint").innerText()).trim(), "Choose a file to see available tools.", "drop zone hint");
    ok(await page.locator(".dropzone__link", { hasText: "browse" }).count() === 1, "browse link");
    eq((await page.locator(".section-title").innerText()).trim(), "Quick actions", "section title");
    eq(await a.texts(".op-card__title"), ["Convert files", "Edit PDF", "Compress files", "Extract archive"], "quick action titles");
    eq(await a.texts(".op-card__tag"), [], "no card is tagged: every engine is reported as available");
    const desc = await a.texts(".op-card__desc");
    eq(desc[1], "Preview, merge, split, annotate, reorder and rotate PDF files.", "the PDF card names only what the backend reports");
    eq(desc[0], "Change between JPG, PNG and WEBP images.", "convert description comes from capabilities");
    eq(desc[3], "Open ZIP archives.", "extract description comes from capabilities");
    eq(await a.texts(".jobtable thead th").then((t) => t.map((x) => x.toLowerCase()).filter((x) => x && x !== "actions")), ["file name", "operation", "status", "date"], "jobs table columns (no Size)");
    const dates = await a.texts(".jobtable tbody td:nth-child(4)");
    ok(dates.every((d) => /^(Today|Yesterday), \d{2}:\d{2}$/.test(d)), `24-hour dates: ${dates}`);
    eq(await a.texts(".jobtable tbody td:nth-child(3) .badge").then((b) => b.map((x) => x.split(" ")[0])), ["Completed", "Completed", "Failed"], "statuses are the seeded real records");
    await a.shot("dashboard");
    ok(a.errors.length === 0, "no console errors: " + a.errors);
    await a.close();
  }

  section("Dashboard: empty history");
  {
    const a = await open({ history: [] });
    await a.page.waitForSelector("text=No jobs yet");
    ok(true, "empty state shown");
    await a.close();
  }

  section("Dashboard: the Edit PDF card follows the PDF engine's state");
  {
    const none = await open({ caps: capsNoPdf });
    eq(await none.texts(".op-card__tag"), ["Coming later"], "no PDF operation in the report");
    ok((await none.texts(".op-card__desc"))[1].includes("Merge, split, reorder"), "planned wording only while nothing exists");
    await none.close();
    const off = await open({ caps: capsPdfOff });
    eq(await off.texts(".op-card__tag"), ["Unavailable"], "engine present but broken");
    ok((await off.texts(".op-card__desc"))[1].includes("missing from this installation"), "its own reason is shown");
    await off.close();
  }

  section("Dashboard: tools offered for the selected files come from capabilities");
  {
    const a = await open();
    const { page } = a;
    await a.drop(["/home/amine/Documents/invoice.pdf", PICS + "holiday.png"]);
    await page.waitForSelector(".filelist");
    const btn = (n) => page.locator(".dash-actions").getByRole("button", { name: n, exact: true });
    ok(await btn("Convert").isDisabled(), "Convert is off when a PDF is mixed in");
    ok(await btn("Extract").isDisabled(), "Extract is off for non-archives");
    ok(await btn("Compress").isEnabled(), "Compress takes any file");
    const why = (await page.locator(".dash-why").innerText()).replace(/\s+/g, " ");
    ok(/Convert: Needs JPG, PNG, WEBP files only/.test(why), "reason names the supported formats: " + why);
    ok(await btn("Open PDF").isDisabled() && await btn("Merge PDFs").isDisabled() && await btn("Split PDF").isDisabled(), "PDF tools are listed once a PDF is chosen, and off for this mixed selection");
    ok(/Open PDF: Choose one PDF to open it/.test(why), "reason for Open PDF: " + why);
    await page.getByRole("button", { name: "Remove invoice.pdf" }).click();
    ok(await btn("Convert").isEnabled(), "Convert turns on for images only");
    eq(await page.locator(".dash-actions").getByRole("button", { name: "Open PDF", exact: true }).count(), 0, "PDF tools are not listed for an image");
    await a.close();
    const none = await open({ caps: capsNoPdf });
    await none.drop([PICS + "holiday.png"]);
    await none.page.waitForSelector(".filelist");
    eq(await none.texts(".dash-actions button"), ["Convert", "Compress", "Extract"], "a build without PDF support doesn't mention it");
    await none.close();
  }

  // ------------------------------------------------------------------ convert
  section("Convert: formats and options follow the backend's option specs");
  {
    const a = await open();
    const { page } = a;
    await a.nav("Convert");
    await page.waitForSelector(".dropzone");
    await a.drop([PICS + "holiday.png", PICS + "logo.webp"]);
    await page.waitForSelector("text=Convert to");
    eq(await a.texts('[aria-label="Output format"] [role=radio]'), ["JPG", "PNG", "WEBP"], "output formats from capability pairs");
    const radio = (n) => page.getByRole("radio", { name: n, exact: true });
    const visible = async () => ({ quality: await page.locator("#opt-quality").count(), mode: await page.getByRole("radiogroup", { name: "WebP mode" }).count(), bg: await page.locator("#opt-background").count(), meta: await page.locator("#opt-keep_metadata").count() });
    await radio("JPG").click();
    eq(await visible(), { quality: 1, mode: 0, bg: 1, meta: 1 }, "JPG: quality + background colour, no WebP mode");
    await radio("PNG").click();
    eq(await visible(), { quality: 0, mode: 0, bg: 0, meta: 1 }, "PNG: no quality, no background");
    await radio("WEBP").click();
    eq(await visible(), { quality: 1, mode: 1, bg: 0, meta: 1 }, "WebP lossy: quality + mode");
    await page.getByRole("radio", { name: "Lossless (exact)" }).click();
    eq(await visible(), { quality: 0, mode: 1, bg: 0, meta: 1 }, "WebP lossless hides quality");
    await page.getByRole("radio", { name: "Lossy (smaller)" }).click();
    await radio("JPG").click();
    await page.waitForSelector("text=Good to know");
    await a.shot("convert-jpg");
    await page.locator(".action-bar").getByRole("button", { name: "Convert", exact: true }).click();
    await page.waitForSelector("text=Preparing your files");
    const req = await page.evaluate(() => window.__MOCK.lastRequest.operation);
    eq([req.type, req.format, req.quality, req.background, req.keep_metadata], ["convert_image", "jpeg", 85, "#FFFFFF", false], "request carries the applicable options");
    ok(!("webp_mode" in req), "inapplicable option is not sent");
    await page.waitForSelector("text=All done", { timeout: 15000 });
    await a.close();
  }

  section("Convert: an unavailable engine is explained, not offered");
  {
    const caps = clone(realCaps);
    caps.engines.find((e) => e.id === "image").availability = { status: "unavailable", reason: "The image engine failed its self-check." };
    caps.operations.find((o) => o.id === "convert_image").available = false;
    caps.operations.find((o) => o.id === "convert_image").unavailable_reason = "The image engine failed its self-check.";
    const a = await open({ caps });
    await a.nav("Convert");
    await a.page.waitForSelector("text=isn't available right now");
    ok((await a.page.locator("body").innerText()).includes("failed its self-check"), "reason is shown");
    eq(await a.page.getByRole("button", { name: "Convert", exact: true }).count(), 1, "only the sidebar item exists; no Convert action");
    await a.drop([PICS + "holiday.png"]);
    await a.nav("Dashboard");
    await a.page.waitForSelector(".dash-actions");
    ok(await a.page.locator(".dash-actions").getByRole("button", { name: "Convert", exact: true }).isDisabled(), "dashboard Convert disabled");
    ok((await a.page.locator(".dash-why").innerText()).includes("failed its self-check"), "dashboard says why");
    await a.close();
  }

  section("Convert: the capability report failing to load is handled");
  {
    const a = await open({ capsError: true });
    await a.nav("Convert");
    await a.page.waitForSelector("text=Couldn't load the list of supported operations");
    ok(await a.page.getByRole("button", { name: "Try again" }).count() === 1, "retry offered");
    await a.close();
  }

  // ------------------------------------------------------------------ PDF
  const DOCS = "/home/amine/Documents/";
  const pdfPage = async (a, n) => { await a.page.waitForFunction((n) => document.querySelector(".pdf-preview img")?.alt.startsWith(`Page ${n} of`), n); };
  const pageNo = (a) => a.page.getByLabel("Page number").inputValue();
  const zoomText = (a) => a.page.locator(".editor__zoom").innerText().then((t) => Number.parseInt(t, 10));
  // The n-th job request the app has handed to the backend (waits for it to arrive).
  const sentRequest = async (page, n) => { await page.waitForFunction((n) => (window.__MOCK.requests?.length ?? 0) >= n, n); return page.evaluate((n) => window.__MOCK.requests[n - 1], n); };
  const openViaDialog = async (a, path) => { await a.page.evaluate((p) => (window.__MOCK.nextDialog = p), path); await a.page.locator(".page-header__actions").getByRole("button", { name: "Open PDF" }).click(); };

  section("PDF Tools: nothing is offered that the backend cannot do");
  {
    const a = await open();
    const { page } = a;
    await a.nav("PDF Tools");
    await page.waitForSelector(".pdf-grid");
    const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    ok(body.includes("Merge, split, reorder, rotate, delete and extract pages, annotate, and convert between PDFs, pictures and Office documents work now"), "says what exists");
    ok(!body.includes("PDF tools are not available yet"), "no 'missing engine' notice");
    const cards = await page.locator(".pdf-grid .op-card").all();
    eq(cards.length, 10, "editor card + 9 tasks");
    const disabled = await Promise.all(cards.map((c) => c.getAttribute("aria-disabled")));
    eq(disabled, Array(10).fill(null), "every task has a screen and an engine, so every card is open");
    eq(await a.texts(".pdf-grid .op-card__tag"), [], "nothing is labelled as coming later");
    await cards[1].click();
    eq((await page.locator("h1").innerText()).trim(), "Merge PDFs", "Merge opens its own screen");
    await a.nav("PDF Tools"); await page.locator(".pdf-grid .op-card", { hasText: "Split PDF" }).click();
    eq((await page.locator("h1").innerText()).trim(), "Split PDF", "Split opens its own screen");
    await a.nav("PDF Tools"); await page.locator(".pdf-grid .op-card", { hasText: "Reorder pages" }).click();
    eq((await page.locator("h1").innerText()).trim(), "PDF Editor", "page tasks open the editor");
    await a.nav("PDF Tools"); await page.locator(".pdf-grid .op-card", { hasText: "Images to PDF" }).click();
    eq((await page.locator("h1").innerText()).trim(), "Images to PDF", "Images to PDF opens its own screen");
    await a.nav("PDF Tools"); await page.locator(".pdf-grid .op-card", { hasText: "PDF pages to images" }).click();
    eq((await page.locator("h1").innerText()).trim(), "PDF to images", "PDF to images opens its own screen");
    await a.nav("PDF Tools"); await page.locator(".pdf-grid .op-card", { hasText: "Documents to PDF" }).click();
    eq((await page.locator("h1").innerText()).trim(), "Documents to PDF", "Documents to PDF opens its own screen");
    await a.shot("pdf-tools");
    await a.close();

    const none = await open({ caps: capsNoPdf });
    await none.nav("PDF Tools");
    await none.page.waitForSelector(".pdf-grid");
    ok((await none.page.locator("body").innerText()).includes("PDF tools are not available yet"), "explains the missing engine");
    ok((await none.texts(".pdf-grid .op-card__tag"))[0] === "Coming later", "editor card is tagged");
    await none.close();

    const off = await open({ caps: capsPdfOff });
    await off.nav("PDF Tools");
    await off.page.waitForSelector(".pdf-grid");
    const t = (await off.page.locator("body").innerText()).replace(/\s+/g, " ");
    ok(t.includes("The PDF engine is not available right now") && t.includes("missing from this installation"), "explains why: " + t.slice(0, 300));
    await off.close();
  }

  section("PDF Editor with no usable engine: everything is off and says why");
  for (const [label, caps, reasonText] of [["missing", capsNoPdf, "not part of this version"], ["unavailable", capsPdfOff, "missing from this installation"]]) {
    const a = await open({ caps });
    const { page } = a;
    await a.nav("PDF Tools");
    await page.getByRole("button", { name: /Open PDF Editor/ }).click();
    await page.waitForSelector(".editor");
    ok(await page.locator(".editor__thumbs").count() === 1 && await page.locator(".editor__center").count() === 1 && await page.locator(".editor__tools").count() === 1, `${label}: thumbnails, preview and tools panels`);
    ok(await page.getByRole("button", { name: "Save Copy" }).isDisabled(), `${label}: Save Copy disabled`);
    const openBtn = page.locator(".page-header__actions").getByRole("button", { name: "Open PDF" });
    ok(await openBtn.isDisabled(), `${label}: Open PDF disabled`);
    ok(((await openBtn.getAttribute("title")) ?? "").includes(reasonText), `${label}: tooltip gives the reason`);
    const tools = await page.locator(".tool").all();
    ok(tools.length >= 18, `tool buttons present (${tools.length})`);
    ok((await Promise.all(tools.map((t) => t.getAttribute("aria-disabled")))).every((v) => v === "true"), `${label}: every tool disabled`);
    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    for (const phrase of ["never changed", "digital signatures invalid", "not a verified digital signature", "permanent part of the page", "No PDF open", reasonText]) ok(text.includes(phrase), `${label}: says: ${phrase}`);
    ok(!/OCR|edit existing text/i.test(text), "no OCR or existing-text editing offered");
    await a.drop([DOCS + "report.pdf"]);
    await page.waitForTimeout(150);
    eq(await page.evaluate(() => window.__MOCK.pdfOpenCalls.length), 0, `${label}: a dropped PDF is not opened (nothing to open it with)`);
    if (label === "missing") await a.shot("pdf-editor-off");
    await a.close();
  }

  section("PDF Editor: open, look at pages, move around, zoom, close");
  {
    const a = await open();
    const { page } = a;
    await a.nav("PDF Tools");
    await page.getByRole("button", { name: /Open PDF Editor/ }).click();
    ok((await page.locator("body").innerText()).includes("Choose Open PDF, or drop a PDF onto this window."), "empty state invites opening a file");
    ok(await page.getByRole("button", { name: "Export" }).isDisabled() && await page.getByRole("button", { name: "Save Copy" }).isDisabled(), "nothing to save yet");
    ok(((await page.getByRole("button", { name: "Save Copy" }).getAttribute("title")) ?? "").includes("Open a PDF first"), "and it says why");

    await openViaDialog(a, DOCS + "report.pdf");
    await page.waitForSelector(".pdf-preview img");
    await pdfPage(a, 1);
    eq(await page.locator(".thumb").count(), 3, "one thumbnail per page");
    eq(await pageNo(a), "1", "page 1 shown");
    ok((await page.locator(".editor__page-count").innerText()).includes("of 3"), "of 3");
    eq(await page.locator(".thumb[aria-current=page]").getAttribute("aria-label"), "Page 1", "current thumbnail marked");
    const details = (await page.locator(".doc-details").innerText()).replace(/\s+/g, " ");
    for (const t of ["report.pdf", "Quarterly report", "A. Writer", "1.7", "482 KB", "Created"]) ok(details.includes(t), `details show ${t}: ${details}`);
    ok(!/Protection|Digital signatures|Form fields/.test(details), "details omit what the file doesn't have");
    ok(await page.getByRole("button", { name: "Previous page" }).getAttribute("aria-disabled") === "true", "Previous is off on page 1");
    await page.waitForFunction(() => document.querySelectorAll(".thumb__frame img").length === 3);
    ok(await page.locator(".thumb__frame img").evaluateAll((imgs) => imgs.every((i) => i.naturalWidth > 0)), "thumbnails are real, decoded images");
    await page.waitForFunction(() => (document.querySelector(".pdf-preview img")?.naturalWidth ?? 0) > 0);
    const first = await page.locator(".pdf-preview img").evaluate((i) => ({ w: i.naturalWidth, shown: i.getBoundingClientRect().width }));
    ok(first.w >= first.shown * 1.2, `preview is drawn at screen resolution: ${JSON.stringify(first)}`);
    await a.shot("pdf-editor-open");

    await page.getByRole("button", { name: "Next page" }).click();
    await pdfPage(a, 2);
    eq(await pageNo(a), "2", "Next goes to page 2");
    const shape = await page.locator(".pdf-preview img").evaluate((i) => i.naturalWidth > i.naturalHeight);
    ok(shape, "page 2 is landscape, as its size says");
    eq(await page.locator(".thumb[aria-current=page]").getAttribute("aria-label"), "Page 2", "thumbnail follows");
    await page.locator(".thumb[aria-label='Page 3']").click();
    await pdfPage(a, 3);
    ok(await page.getByRole("button", { name: "Next page" }).getAttribute("aria-disabled") === "true", "Next is off on the last page");
    const input = page.getByLabel("Page number");
    await input.fill("1"); await input.press("Enter");
    await pdfPage(a, 1);
    await input.fill("99"); await input.press("Enter");
    await pdfPage(a, 3);
    eq(await pageNo(a), "3", "typing a page past the end goes to the last page");

    // zoom
    await page.getByRole("button", { name: "Fit whole page" }).click();
    const fitPage = await zoomText(a);
    await page.getByRole("button", { name: "Fit page width" }).click();
    const fitWidth = await zoomText(a);
    ok(fitWidth >= fitPage, `fit-width (${fitWidth}%) is at least fit-page (${fitPage}%)`);
    await page.getByRole("button", { name: "Zoom in" }).click();
    const zin = await zoomText(a);
    ok(zin > fitWidth, `zoom in raises it: ${fitWidth} -> ${zin}`);
    ok([25, 50, 75, 100, 125, 150, 200, 300, 400].includes(zin), `lands on a standard step (${zin})`);
    await page.waitForFunction((z) => { const i = document.querySelector(".pdf-preview img"); return i && i.naturalWidth > 0; }, zin);
    for (let i = 0; i < 12; i++) await page.getByRole("button", { name: "Zoom in" }).click();
    eq(await zoomText(a), 400, "zoom stops at 400%");
    ok(await page.getByRole("button", { name: "Zoom in" }).getAttribute("aria-disabled") !== "true", "button stays focusable");
    const big = await page.locator(".pdf-preview").evaluate((e) => ({ scrolls: e.scrollWidth > e.clientWidth, sw: e.scrollWidth }));
    ok(big.scrolls, "a zoomed page scrolls inside the preview instead of overflowing the window");
    const maxAsked = await page.evaluate(() => Math.max(...window.__MOCK.pageCalls.map((c) => c.width)));
    ok(maxAsked <= 4096, `never asks for more than the engine's limit (${maxAsked})`);
    for (let i = 0; i < 12; i++) await page.getByRole("button", { name: "Zoom out" }).click();
    eq(await zoomText(a), 25, "zoom stops at 25%");
    await page.getByRole("button", { name: "Fit page width" }).click();

    // keyboard
    await page.locator(".pdf-preview").focus();
    await page.keyboard.press("Home"); await pdfPage(a, 1);
    await page.keyboard.press("PageDown"); await pdfPage(a, 2);
    await page.keyboard.press("End"); await pdfPage(a, 3);
    await page.keyboard.press("PageUp"); await pdfPage(a, 2);
    await page.locator(".thumb[aria-current=page]").focus();
    await page.keyboard.press("ArrowDown"); await pdfPage(a, 3);
    ok(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Page 3"), "focus follows the arrow keys in the thumbnail list");
    await page.keyboard.press("ArrowUp"); await pdfPage(a, 2);

    // leaving and coming back keeps the document
    await a.nav("Dashboard"); await a.nav("PDF Tools");
    await page.getByRole("button", { name: /Open PDF Editor/ }).click();
    await page.waitForSelector(".pdf-preview img");
    eq(await pageNo(a), "2", "the open document survives a visit to another screen");

    // closing deletes it on the server side too
    const id = await page.evaluate(() => window.__MOCK.opened.at?.(-1) ?? window.__MOCK.opened[window.__MOCK.opened.length - 1]);
    await page.getByRole("button", { name: "Close PDF" }).click();
    await page.waitForSelector(".editor__empty h2");
    eq(await page.locator(".editor__empty h2").innerText(), "No PDF open", "back to the empty state");
    ok(await page.evaluate((i) => window.__MOCK.closed.includes(i), id), "the document was closed in the backend");
    eq(await page.locator(".thumb").count(), 0, "thumbnails are gone");
    await a.close();
  }

  section("PDF Editor: thumbnails are drawn only when they come into view");
  {
    const a = await open({ h: 700 });
    const { page } = a;
    await a.nav("PDF Tools");
    await page.getByRole("button", { name: /Open PDF Editor/ }).click();
    await openViaDialog(a, DOCS + "long.pdf");
    await page.waitForSelector(".pdf-preview img");
    await page.waitForTimeout(400);
    const thumbsAsked = () => page.evaluate(() => new Set(window.__MOCK.pageCalls.filter((c) => c.width < 480).map((c) => c.page)).size);
    const early = await thumbsAsked();
    ok(early >= 2 && early < 30, `only the visible thumbnails were requested (${early} of 60)`);
    await page.locator(".editor__thumb-list").evaluate((e) => { e.scrollTop = e.scrollHeight; });
    await page.waitForTimeout(500);
    const later = await thumbsAsked();
    ok(later > early && later < 60, `scrolling requests more, still not all (${later})`);
    ok(await page.evaluate(() => window.__MOCK.pageCalls.filter((c) => c.width < 480).every((c) => c.width === 256)), "thumbnails share one size so each is rendered once");
    await a.close();
  }

  section("PDF Editor: passwords");
  {
    const a = await open();
    const { page } = a;
    await a.nav("PDF Tools");
    await page.getByRole("button", { name: /Open PDF Editor/ }).click();
    await openViaDialog(a, DOCS + "locked.pdf");
    await page.waitForSelector(".pdf-password");
    ok((await page.locator(".pdf-password").innerText()).includes("locked.pdf"), "names the file");
    const pw = page.getByLabel("Password");
    eq(await pw.getAttribute("type"), "password", "the field hides what is typed");
    ok(await page.getByRole("button", { name: "Open", exact: true }).isDisabled(), "Open waits for a password");
    await pw.fill("not-it");
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.waitForSelector("#pdf-password-error");
    ok(((await page.locator("#pdf-password-error").innerText()) ?? "").includes("isn't right"), "wrong password is explained");
    eq(await page.getByLabel("Password").inputValue(), "", "the field is cleared after sending");
    await a.shot("pdf-password");
    await page.getByLabel("Password").fill("open-sesame");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".pdf-preview img");
    eq(await page.locator(".pdf-password").count(), 0, "prompt closes on success");
    ok(((await page.locator(".doc-details").innerText()).replace(/\s+/g, " ")).includes("Password-protected"), "details say it is protected");
    const where = await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]) + document.body.innerHTML);
    ok(!where.includes("open-sesame") && !where.includes("not-it"), "the password is nowhere in the page or its storage");
    await a.close();

    const b = await open();
    await b.nav("PDF Tools");
    await b.page.getByRole("button", { name: /Open PDF Editor/ }).click();
    await openViaDialog(b, DOCS + "locked.pdf");
    await b.page.waitForSelector(".pdf-password");
    await b.page.getByRole("button", { name: "Cancel" }).click();
    eq(await b.page.locator(".editor__empty h2").innerText(), "No PDF open", "Cancel returns to the empty state");
    await b.close();
  }

  section("PDF Editor: problems are shown plainly");
  {
    const a = await open();
    const { page } = a;
    await a.nav("PDF Tools");
    await page.getByRole("button", { name: /Open PDF Editor/ }).click();
    await openViaDialog(a, DOCS + "broken.pdf");
    await page.waitForSelector(".callout--error");
    const t = (await page.locator(".callout--error").innerText()).replace(/\s+/g, " ");
    ok(t.includes("“broken.pdf” couldn't be opened") && t.includes("damaged"), t);

    await openViaDialog(a, DOCS + "signed.pdf");
    await page.waitForSelector(".pdf-preview img");
    eq(await page.locator(".callout--error").count(), 0, "the earlier error is gone");
    const w = (await page.locator(".callout--warning").first().innerText()).replace(/\s+/g, " ");
    ok(w.includes("2 digital signatures") && w.includes("invalidate") && w.includes("restrict"), "signature and restriction warnings: " + w);
    ok((await page.locator("body").innerText()).includes("This PDF has form fields"), "forms are acknowledged, not offered");
    ok(((await page.locator(".doc-details").innerText()).replace(/\s+/g, " ")).includes("restrict printing, copying, editing"), "details list the restrictions");

    // a page that fails to draw can be retried; the rest of the document stays usable
    await openViaDialog(a, DOCS + "report.pdf");
    await page.waitForSelector(".pdf-preview img");
    await page.evaluate(() => (window.__MOCK.failPages = [2]));
    await page.getByRole("button", { name: "Next page" }).click();
    await page.waitForSelector(".pdf-preview__error");
    ok((await page.locator(".pdf-preview__error").innerText()).includes("Page 2 couldn't be drawn"), "per-page error");
    await page.evaluate(() => (window.__MOCK.failPages = []));
    // The page may also redraw by itself if the layout settles meanwhile (new width); either way it must recover.
    await page.getByRole("button", { name: "Try again" }).click({ timeout: 2000 }).catch(() => undefined);
    await pdfPage(a, 2);
    await page.waitForFunction(() => !document.querySelector(".pdf-preview__error"));
    eq(await page.locator(".pdf-preview__error").count(), 0, "retry works");
    await page.getByRole("button", { name: "Next page" }).click();
    await pdfPage(a, 3);
    await a.close();
  }

  section("PDF Editor: dropping, the dashboard, and switching documents");
  {
    const a = await open();
    const { page } = a;
    await a.nav("PDF Tools");
    await page.getByRole("button", { name: /Open PDF Editor/ }).click();
    await page.waitForTimeout(400); // the drop listener attaches asynchronously after navigation
    await a.drop([DOCS + "report.pdf"]);
    await page.waitForSelector(".pdf-preview img");
    ok((await page.locator(".page-header p").innerText()).includes("report.pdf"), "a dropped PDF opens");
    await a.drop([DOCS + "report.pdf", DOCS + "invoice.pdf"]);
    await page.waitForSelector(".toast");
    ok((await page.locator(".toast").first().innerText()).includes("Only one PDF"), "several dropped files: tells the user");

    // opening another file while one is open closes the first
    const before = await page.evaluate(() => window.__MOCK.opened.length);
    const closedBefore = await page.evaluate(() => window.__MOCK.closed.length);
    await openViaDialog(a, DOCS + "invoice.pdf");
    await page.waitForFunction((n) => window.__MOCK.opened.length > n, before);
    await page.waitForFunction((n) => window.__MOCK.closed.length > n, closedBefore);
    ok(true, "the previous document is closed when another opens");

    // a slow open that is overtaken must not replace the newer document
    await openViaDialog(a, DOCS + "slow.pdf");
    await page.waitForTimeout(150); // let the dialog answer before the next choice replaces it
    await openViaDialog(a, DOCS + "report.pdf");
    await page.waitForTimeout(1200);
    ok((await page.locator(".page-header p").innerText()).includes("report.pdf"), "the newest request wins");
    const stale = await page.evaluate(() => { const m = window.__MOCK; const slowId = m.opened[m.opened.length - 1]; return m.closed.includes(slowId); });
    ok(stale, "the document that was overtaken is closed again, not leaked");
    await a.close();

    const b = await open();
    await b.drop([DOCS + "invoice.pdf"]);
    await b.page.waitForSelector(".filelist");
    await b.page.locator(".dash-actions").getByRole("button", { name: "Open PDF", exact: true }).click();
    await b.page.waitForSelector(".pdf-preview img");
    eq((await b.page.locator("h1").innerText()).trim(), "PDF Editor", "Open PDF on the dashboard goes to the editor");
    ok((await b.page.locator(".page-header p").innerText()).includes("invoice.pdf"), "with the chosen file open");
    await b.close();
  }

  section("PDF Editor: page changes are a plan until a copy is saved");
  {
    const a = await open();
    const { page } = a;
    await a.nav("PDF Tools");
    await page.getByRole("button", { name: /Open PDF Editor/ }).click();
    await openViaDialog(a, DOCS + "report.pdf");
    await page.waitForSelector(".pdf-preview img");
    const thumb = (n) => page.locator(`.thumb[data-position="${n}"]`);
    const was = async (n) => (await thumb(n).getAttribute("aria-description")) ?? "";
    const pressed = () => page.locator(".thumb").evaluateAll((els) => els.map((e) => e.getAttribute("aria-pressed") === "true"));
    const tool = (name) => page.locator(".tool", { hasText: name });
    const off = async (name) => (await tool(name).getAttribute("aria-disabled")) === "true";
    ok(await page.locator(".dirty-bar").count() === 0, "no unsaved-changes bar at first");
    ok(await page.getByRole("button", { name: "Save Copy" }).isDisabled(), "Save Copy waits for a change");
    ok(await off("Merge") === false && await off("Split") === false && await off("Rotate left") === false, "page tools are on once a PDF is open");
    ok(await off("Duplicate") && await off("Insert pages"), "tools without an operation stay off");
    await a.shot("pdf-editor-tools");

    // rotate
    await thumb(2).click();
    await page.getByRole("button", { name: "Rotate right" }).or(page.locator(".tool", { hasText: "Rotate right" })).first().click();
    ok((await thumb(2).innerText()).includes("↻90°"), "the thumbnail says it is turned");
    await page.waitForSelector(".dirty-bar");
    ok((await page.locator(".dirty-bar").innerText()).includes("not saved"), "unsaved changes are announced");
    ok(await page.getByRole("button", { name: "Save Copy" }).isEnabled(), "Save Copy is on");
    const shape = await page.locator(".pdf-preview__page").evaluate((e) => { const [w, h] = getComputedStyle(e).aspectRatio.split("/").map(Number); return w / h; });
    ok(shape < 1, `landscape page 2 turned 90 degrees is shown portrait (${shape})`);
    ok((await page.locator(".pdf-preview img").getAttribute("style")).includes("rotate(90deg)"), "and its picture is turned");
    ok(await off("Split") && await off("Merge"), "Split and Merge are off while changes are unsaved (they use the file on disk)");
    ok(((await tool("Split").getAttribute("title")) ?? "").includes("Save a copy first"), "and say why");
    await tool("Rotate left").click(); await tool("Rotate left").click();
    ok((await thumb(2).innerText()).includes("↻270°"), "turns add up");
    await tool("Rotate right").click();
    ok(!(await thumb(2).innerText()).includes("↻"), "a full turn is no turn");
    ok(await page.locator(".dirty-bar").count() === 0 && await page.getByRole("button", { name: "Save Copy" }).isDisabled(), "back to the original: no longer a change");

    // move
    await thumb(1).click();
    await tool("Move later").click();
    eq([await was(1), await was(2), await was(3)], ["Originally page 2", "Originally page 1", ""], "Move later swaps the page with the next");
    eq(await pageNo(a), "2", "the preview follows the page that moved");
    await tool("Move earlier").click(); await tool("Move earlier").click();
    eq([await was(1), await was(2), await was(3)], ["", "", ""], "moving it back restores the original order");
    ok(await page.locator(".dirty-bar").count() === 0, "which is no longer a change");

    // select several, delete
    await thumb(1).click(); await thumb(3).click({ modifiers: ["Control"] });
    eq(await pressed(), [true, false, true], "Ctrl-click adds to the selection");
    await thumb(1).click(); await thumb(3).click({ modifiers: ["Shift"] });
    eq(await pressed(), [true, true, true], "Shift-click selects a range");
    ok(await off("Delete"), "can't delete every page");
    ok(((await tool("Delete").getAttribute("title")) ?? "").includes("at least one page"), "and says why");
    await thumb(2).click();
    await tool("Delete").click();
    eq(await page.locator(".thumb").count(), 2, "the page is gone from the plan");
    eq([await was(1), await was(2)], ["", "Originally page 3"], "the others keep their place");
    ok((await page.locator(".dirty-bar").innerText()).includes("2 pages") && (await page.locator(".dirty-bar").innerText()).includes("original has 3"), "the bar says what will be saved");
    ok((await page.locator(".editor__page-count").innerText()).includes("of 2"), "page count follows the plan");
    await page.getByRole("button", { name: "Reset pages" }).click();
    eq(await page.locator(".thumb").count(), 3, "Reset brings the pages back");
    ok(await page.locator(".dirty-bar").count() === 0, "and clears the bar");

    // keyboard
    await thumb(1).focus();
    await page.keyboard.press("Alt+ArrowDown");
    eq(await was(2), "Originally page 1", "Alt+Down moves the page later");
    eq(await was(1), "Originally page 2", "...and the next one takes its place");
    await page.keyboard.press("Delete");
    eq(await page.locator(".thumb").count(), 2, "Delete removes the selected page");
    await page.keyboard.press("Control+a");  // focus stayed in the list after the delete
    eq(await pressed(), [true, true], "Ctrl+A selects all");
    await page.getByRole("button", { name: "Reset pages" }).click();

    // drag
    const box = async (n) => (await thumb(n).boundingBox());
    const b1 = await box(1), b3 = await box(3);
    await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2);
    await page.mouse.down();
    await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2 + 30, { steps: 4 });
    await page.mouse.move(b3.x + b3.width / 2, b3.y + b3.height - 4, { steps: 8 });
    ok(await page.locator(".drop-before, .drop-after").count() === 1, "a drop marker shows where the page will go");
    await page.mouse.up();
    eq([await was(1), await was(2), await was(3)], ["Originally page 2", "Originally page 3", "Originally page 1"], "dragging page 1 to the end moves it there");
    eq(await pageNo(a), "3", "the preview follows");
    await page.getByRole("button", { name: "Reset pages" }).click();
    // a plain click after all that is still just a click
    await thumb(2).click();
    eq(await pageNo(a), "2", "clicking still selects");
    await a.close();
  }

  section("PDF Editor: saving a copy starts a normal job with exactly the plan");
  {
    const a = await open();
    const { page } = a;
    await page.evaluate(() => (window.__MOCK.processSeconds = 1));
    await a.nav("PDF Tools");
    await page.getByRole("button", { name: /Open PDF Editor/ }).click();
    await openViaDialog(a, DOCS + "report.pdf");
    await page.waitForSelector(".pdf-preview img");
    const thumb = (n) => page.locator(`.thumb[data-position="${n}"]`);
    const tool = (name) => page.locator(".tool", { hasText: name });

    await thumb(3).click(); await tool("Move earlier").click();     // 1, 3, 2
    await thumb(1).click(); await tool("Rotate left").click();      // page 1 turned 270
    await thumb(3).click(); await tool("Delete").click();           // drop original page 2 -> 1, 3
    await page.getByRole("button", { name: "Save Copy" }).click();
    await page.waitForSelector(".dialog");
    const dlg = (await page.locator(".dialog").innerText()).replace(/\s+/g, " ");
    ok(dlg.includes("Save a copy") && dlg.includes("2 pages") && dlg.includes("Your original is not changed"), dlg);
    eq(await page.getByLabel("File name").inputValue(), "report (edited)", "default name");
    await page.waitForSelector(".dialog .callout--warning");
    ok((await page.locator(".dialog").innerText()).includes("bookmarks"), "the dialog carries the review's warning about what isn't carried over");
    await page.getByLabel("File name").fill("final cut");
    await page.locator(".dialog").getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForSelector(".save-status");
    const req = await sentRequest(page, 1);
    eq(req.operation, { type: "pdf_pages", pages: [{ page: 1, rotate: 270 }, { page: 3, rotate: 0 }], output_name: "final cut", password: null }, "the job is exactly the plan");
    eq(req.inputs, [DOCS + "report.pdf"], "it reads the original");
    eq(req.output_dir, "/home/amine/Documents", "and saves next to it by default");
    await page.waitForSelector(".save-status--completed", { timeout: 20000 });
    ok((await page.locator(".save-status").innerText()).includes("Saved “final cut.pdf”"), await page.locator(".save-status").innerText());
    await page.getByRole("button", { name: "Dismiss" }).click();
    eq(await page.locator(".save-status").count(), 0, "dismissed");
    await a.nav("Recent Jobs");
    ok((await a.texts(".jobtable tbody tr")).some((t) => t.includes("final cut.pdf") && t.includes("Edit PDF")), "the job is in Recent Jobs");
    await a.nav("PDF Tools"); await page.getByRole("button", { name: /Open PDF Editor/ }).click();

    // Extract: only the selected pages, in plan order
    await page.getByRole("button", { name: "Reset pages" }).click();
    await thumb(2).click(); await thumb(3).click({ modifiers: ["Control"] });
    await tool("Extract").click();
    await page.waitForSelector(".dialog");
    ok((await page.locator(".dialog").innerText()).includes("2 selected pages"), "extract describes the selection");
    eq(await page.getByLabel("File name").inputValue(), "report (extract)", "default extract name");
    await page.locator(".dialog").getByRole("button", { name: "Save", exact: true }).click();
    eq((await sentRequest(page, 2)).operation.pages, [{ page: 2, rotate: 0 }, { page: 3, rotate: 0 }], "extract sends only those pages");
    ok(await page.locator(".dirty-bar").count() === 0, "extracting doesn't count as a change to the open document");
    await a.close();

    // a password-protected file: saved with the password it was opened with (kept in memory only)
    const b = await open();
    await b.page.evaluate(() => (window.__MOCK.processSeconds = 1));
    await b.nav("PDF Tools");
    await b.page.getByRole("button", { name: /Open PDF Editor/ }).click();
    await openViaDialog(b, DOCS + "locked.pdf");
    await b.page.waitForSelector(".pdf-password");
    await b.page.getByLabel("Password").fill("open-sesame"); await b.page.keyboard.press("Enter");
    await b.page.waitForSelector(".pdf-preview img");
    await b.page.locator(".tool", { hasText: "Rotate right" }).click();
    await b.page.getByRole("button", { name: "Save Copy" }).click();
    await b.page.waitForSelector(".dialog");
    const pwNote = (await b.page.locator(".dialog").innerText());
    await b.page.locator(".dialog").getByRole("button", { name: "Save", exact: true }).click();
    await b.page.waitForSelector(".save-status");
    const r2 = await sentRequest(b.page, 1);
    eq(r2.operation.password, "open-sesame", "the password is sent with the job");
    const dom = await b.page.evaluate(() => document.body.innerHTML + JSON.stringify([localStorage, sessionStorage]));
    ok(!dom.includes("open-sesame") && !pwNote.includes("open-sesame"), "and appears nowhere on screen or in storage");
    await b.close();
  }

  section("PDF Editor: unsaved changes are protected");
  {
    const a = await open();
    const { page } = a;
    await a.nav("PDF Tools");
    await page.getByRole("button", { name: /Open PDF Editor/ }).click();
    await openViaDialog(a, DOCS + "report.pdf");
    await page.waitForSelector(".pdf-preview img");
    await page.locator(".tool", { hasText: "Rotate right" }).click();
    await page.getByRole("button", { name: "Close PDF" }).click();
    await page.waitForSelector(".dialog");
    ok((await page.locator(".dialog").innerText()).includes("Discard your changes?"), "asks before closing");
    await page.getByRole("button", { name: "Keep editing" }).click();
    ok(await page.locator(".pdf-preview img").count() === 1 && await page.locator(".dirty-bar").count() === 1, "Keep editing changes nothing");
    await openViaDialog(a, DOCS + "invoice.pdf");
    await page.waitForSelector(".dialog");
    ok((await page.locator(".dialog").innerText()).includes("Opening another PDF"), "asks before opening another");
    await page.keyboard.press("Escape");
    ok((await page.locator(".page-header p").innerText()).includes("report.pdf"), "Escape keeps the current document");
    await page.waitForTimeout(300);
    await a.drop([DOCS + "invoice.pdf"]);
    await page.waitForSelector(".dialog");
    await page.getByRole("button", { name: "Discard changes" }).click();
    await page.waitForFunction(() => document.querySelector(".page-header p")?.textContent.includes("invoice.pdf"));
    ok(await page.locator(".dirty-bar").count() === 0, "after discarding, the new document starts clean");
    await a.close();
  }

  section("Merge PDFs");
  {
    const a = await open();
    const { page } = a;
    await page.evaluate(() => (window.__MOCK.processSeconds = 1));
    await a.drop([DOCS + "invoice.pdf", DOCS + "report.pdf"]);
    await page.waitForSelector(".filelist");
    await page.locator(".dash-actions").getByRole("button", { name: "Merge PDFs", exact: true }).click();
    eq((await page.locator("h1").innerText()).trim(), "Merge PDFs", "the dashboard tool opens Merge");
    ok(await page.locator(".sidebar .nav-item--active, .sidebar [aria-current=page]").first().innerText().then((t) => t.includes("PDF Tools")), "PDF Tools stays highlighted");
    const names = () => page.locator(".ordered .filelist__name").allInnerTexts();
    eq(await names(), ["invoice.pdf", "report.pdf"], "both files, in the order added");
    ok(await page.getByRole("button", { name: "Move invoice.pdf up" }).isDisabled() && await page.getByRole("button", { name: "Move report.pdf down" }).isDisabled(), "the ends can't move past the ends");
    await page.getByRole("button", { name: "Move report.pdf up" }).click();
    eq(await names(), ["report.pdf", "invoice.pdf"], "reordering");
    await page.waitForSelector(".callout--warning");
    ok((await page.locator(".callout--warning").innerText()).includes("bookmarks"), "warns what isn't carried over");
    await page.getByLabel("File name").fill("both together");
    await a.shot("pdf-merge");
    await page.getByRole("button", { name: "Merge", exact: true }).click();
    const req = await sentRequest(page, 1);
    eq(req.inputs, [DOCS + "report.pdf", DOCS + "invoice.pdf"], "inputs are sent in the chosen order");
    eq(req.operation, { type: "pdf_merge", output_name: "both together", password: null }, "options");
    await page.waitForSelector(".run h2");
    await page.waitForFunction(() => document.querySelector(".run h2")?.textContent === "All done", null, { timeout: 20000 });
    ok((await page.locator(".run").innerText()).includes("saved"), "result shown");
    await page.getByRole("button", { name: "Start another" }).click();
    await a.close();

    // only one PDF: not enough
    const b = await open();
    await b.drop([DOCS + "report.pdf"]);
    await b.page.waitForSelector(".filelist");
    await b.nav("PDF Tools"); await b.page.locator(".pdf-grid .op-card", { hasText: "Merge PDFs" }).click();
    ok(await b.page.getByRole("button", { name: "Merge", exact: true }).isDisabled(), "one PDF can't be merged");
    ok((await b.page.locator("body").innerText()).includes("Add at least one more PDF"), "and it says so");
    await b.drop([PICS + "holiday.png"]);
    await b.page.waitForSelector(".filelist__row--problem");
    ok((await b.page.locator(".filelist__row--problem").innerText()).includes("Not a supported file"), "a non-PDF is flagged");
    await b.close();
  }

  section("Split PDF");
  {
    const a = await open();
    const { page } = a;
    await page.evaluate(() => (window.__MOCK.processSeconds = 1));
    await a.drop([DOCS + "long.pdf"]);
    await page.waitForSelector(".filelist");
    await page.locator(".dash-actions").getByRole("button", { name: "Split PDF", exact: true }).click();
    eq((await page.locator("h1").innerText()).trim(), "Split PDF", "the dashboard tool opens Split");
    const split = page.getByRole("button", { name: "Split", exact: true });
    await page.getByLabel("Pages in each new PDF").fill("3");
    await page.waitForSelector(".callout--warning");
    ok((await page.locator("body").innerText()).includes("This will make 4 new PDFs"), "the dry run says how many files come out");
    await split.click();
    eq((await sentRequest(page, 1)).operation, { type: "pdf_split", mode: "every", every: 3, password: null }, "every-N request");
    await page.waitForFunction(() => document.querySelector(".run h2")?.textContent === "All done", null, { timeout: 20000 });
    await page.getByRole("button", { name: "Start another" }).click();
    await a.drop([DOCS + "long.pdf"]);
    await page.waitForSelector(".filelist");
    await page.getByRole("radio", { name: "Page ranges" }).click();
    ok(await split.isDisabled(), "ranges mode waits for ranges");
    await page.getByLabel("Page ranges").fill("1-2, 5-");
    await split.click();
    eq((await sentRequest(page, 2)).operation, { type: "pdf_split", mode: "ranges", ranges: "1-2, 5-", password: null }, "ranges request");
    await page.waitForFunction(() => document.querySelector(".run h2")?.textContent === "All done", null, { timeout: 20000 });
    await a.close();

    const b = await open();
    await b.drop([DOCS + "long.pdf", DOCS + "report.pdf"]);
    await b.page.waitForSelector(".filelist");
    await b.nav("PDF Tools"); await b.page.locator(".pdf-grid .op-card", { hasText: "Split PDF" }).click();
    ok((await b.page.locator(".filelist__row--problem").innerText()).includes("one PDF at a time"), "a second file is flagged");
    ok(await b.page.getByRole("button", { name: "Split", exact: true }).isDisabled(), "and Split waits");
    await b.close();
  }

  // ------------------------------------------------------------------ step 6: pictures, PDF pages as pictures, Office documents
  const finishJob = async (page) => { await page.waitForSelector(".run h2:has-text('All done')", { timeout: 20000 }); };
  const heading = (page) => page.locator("h1").innerText().then((t) => t.trim());
  const goTask = async (a, card) => { await a.nav("PDF Tools"); await a.page.locator(".pdf-grid .op-card", { hasText: card }).click(); };

  section("Images to PDF");
  {
    const a = await open();
    const { page } = a;
    await page.evaluate(() => (window.__MOCK.processSeconds = 1));
    await a.drop([PICS + "holiday.png", PICS + "portrait.jpg"]);
    await page.waitForSelector(".filelist");
    await goTask(a, "Images to PDF");
    await page.waitForSelector(".ordered");
    eq(await a.texts(".ordered .filelist__name"), ["holiday.png", "portrait.jpg"], "pictures keep the order they were added in");
    ok((await page.locator(".filelist__head").innerText()).includes("2 pictures"), "counted as pictures");
    await page.getByRole("button", { name: "Move holiday.png down" }).click();
    eq(await a.texts(".ordered .filelist__name"), ["portrait.jpg", "holiday.png"], "can be reordered");
    ok(await page.getByRole("radio", { name: "A4", exact: true }).getAttribute("aria-checked") === "true", "A4 is the default page");
    ok(await page.getByRole("radiogroup", { name: "Orientation" }).count() === 1 && await page.locator("#img-margin").count() === 1, "orientation and margin apply to A4");
    await page.getByRole("radio", { name: "Same size as picture" }).click();
    ok(await page.getByRole("radiogroup", { name: "Orientation" }).count() === 0 && await page.locator("#img-margin").count() === 0, "they disappear when the page takes the picture's size");
    await page.getByRole("radio", { name: "Letter", exact: true }).click();
    await page.locator("#img-margin").fill("99");
    ok(await page.getByRole("button", { name: "Create PDF" }).isDisabled(), "a margin over 50 mm is refused");
    await page.locator("#img-margin").fill("12");
    await page.getByRole("radio", { name: "Landscape" }).click();
    await page.locator("#img-name").fill("trip");
    await page.getByRole("button", { name: "Create PDF" }).click();
    const req = await sentRequest(page, 1);
    eq(req.operation, { type: "images_to_pdf", paper: "letter", orientation: "landscape", margin_mm: 12, output_name: "trip" }, "the job carries the page layout");
    eq(req.inputs, [PICS + "portrait.jpg", PICS + "holiday.png"], "in the chosen order");
    await finishJob(page);
    await a.nav("Recent Jobs");
    ok((await a.texts(".jobtable tbody tr")).some((t) => t.includes("trip.pdf") && t.includes("Images to PDF")), "listed in Recent Jobs as Images to PDF");

    await goTask(a, "Images to PDF");
    await page.getByRole("button", { name: "Start another" }).click();
    await a.drop([DOCS + "invoice.pdf"]);
    await page.waitForSelector(".ordered .filelist__row--problem");
    ok(await page.getByRole("button", { name: "Create PDF" }).isDisabled(), "a PDF can't be put on a page");
    await a.shot("images-to-pdf");
    await a.close();

    const off = await open({ caps: capsNoPdf });
    await off.nav("PDF Tools");
    ok(await off.page.locator(".pdf-grid .op-card", { hasText: "Images to PDF" }).count() === 1, "the card is listed");
    eq(await off.page.locator(".pdf-grid .op-card", { hasText: "Images to PDF" }).getAttribute("aria-disabled"), "true", "and disabled without the PDF engine");
    await off.close();
  }

  section("PDF to images");
  {
    const a = await open();
    const { page } = a;
    await page.evaluate(() => (window.__MOCK.processSeconds = 1));
    await a.drop([DOCS + "report.pdf", DOCS + "invoice.pdf"]);
    await page.waitForSelector(".filelist");
    await goTask(a, "PDF pages to images");
    await page.waitForSelector("#pti-dpi");
    eq(await a.texts('[aria-label="Image format"] [role=radio]'), ["PNG", "JPG", "WEBP"], "formats come from the capability report");
    eq(await page.locator("#pti-dpi").inputValue(), "150", "150 dpi by default");
    eq(await page.locator("#pti-quality").count(), 0, "PNG has no quality setting");
    await page.getByRole("radio", { name: "JPG", exact: true }).click();
    eq(await page.locator("#pti-quality").count(), 1, "JPG does");
    await page.getByRole("radio", { name: /300/ }).click();
    eq(await page.locator("#pti-dpi").inputValue(), "300", "presets fill the box");
    await page.locator("#pti-dpi").fill("5000");
    ok(await page.getByRole("button", { name: "Save images" }).isDisabled(), "5000 dpi is refused");
    ok((await page.locator("body").innerText()).includes("Resolution must be between 36 and 600"), "and says why");
    await page.locator("#pti-dpi").fill("300");
    await page.getByRole("radio", { name: "Choose pages" }).click();
    ok(await page.getByRole("button", { name: "Save images" }).isDisabled(), "choosing pages needs a range");
    await page.locator("#pti-pages").fill("1-2");
    await page.getByRole("button", { name: "Save images" }).click();
    const req = await sentRequest(page, 1);
    eq(req.operation, { type: "pdf_to_images", format: "jpeg", dpi: 300, pages: "1-2", quality: 90, password: null }, "the job carries the settings");
    eq(req.inputs, [DOCS + "report.pdf", DOCS + "invoice.pdf"], "for every PDF");
    await finishJob(page);
    await a.nav("Recent Jobs");
    ok((await a.texts(".jobtable tbody tr")).some((t) => t.includes("PDF to images (JPG, 300 dpi)")), "Recent Jobs says what was made");
    await a.close();
  }

  section("Documents to PDF");
  {
    const a = await open();
    const { page } = a;
    await page.evaluate(() => (window.__MOCK.processSeconds = 1));
    await a.drop([DOCS + "proposal.docx", DOCS + "budget.xlsx", DOCS + "slides.pptx"]);
    await page.waitForSelector(".filelist");
    const tools = await a.texts(".dash-actions button");
    ok(tools.includes("Convert to PDF"), "the dashboard offers Convert to PDF for documents: " + tools);
    ok(await page.locator(".dash-actions").getByRole("button", { name: "Convert to PDF" }).isEnabled(), "and it is enabled");
    eq(await page.locator(".dash-actions").getByRole("button", { name: "Open PDF" }).count(), 0, "no PDF tools for documents");
    await page.locator(".dash-actions").getByRole("button", { name: "Convert to PDF" }).click();
    await page.waitForSelector(".filelist");
    eq(await heading(page), "Documents to PDF", "opens its screen");
    ok((await page.locator("body").innerText()).includes("Layout can differ from Microsoft Office"), "says the layout can differ");
    ok(!(await page.locator("body").innerText()).includes("Using the LibreOffice installed"), "a bundled LibreOffice needs no note");
    await page.getByRole("button", { name: "Convert to PDF" }).click();
    const req = await sentRequest(page, 1);
    eq(req.operation, { type: "office_to_pdf" }, "no options");
    eq(req.inputs.length, 3, "three documents");
    await finishJob(page);
    await a.close();

    const b = await open();
    await b.drop([DOCS + "proposal.docx", PICS + "holiday.png"]);
    await b.page.waitForSelector(".filelist");
    const mixed = b.page.locator(".dash-actions").getByRole("button", { name: "Convert to PDF" });
    ok(await mixed.isDisabled(), "a picture among the documents turns Convert to PDF off");
    ok(((await mixed.getAttribute("title")) ?? "").includes("Word, Excel, PowerPoint or OpenDocument files only"), "and says why");
    await b.page.getByRole("button", { name: "Remove holiday.png" }).click();
    ok(await mixed.isEnabled(), "removing the picture turns it back on");
    await b.close();

    const inst = await open({ caps: capsPdfOff });
    await inst.drop([DOCS + "legacy.doc"]);
    await inst.page.waitForSelector(".filelist");
    await inst.page.locator(".dash-actions").getByRole("button", { name: "Convert to PDF" }).click();
    await inst.page.waitForSelector(".filelist");
    ok((await inst.page.locator("body").innerText()).includes("Using the LibreOffice installed on this computer"), "an installed (not bundled) LibreOffice is said out loud");
    await inst.close();

    const off = await open({ caps: capsOfficeOff });
    await off.drop([DOCS + "proposal.docx"]);
    await off.page.waitForSelector(".filelist");
    const btn = off.page.locator(".dash-actions").getByRole("button", { name: "Convert to PDF" });
    ok(await btn.isDisabled(), "disabled without LibreOffice");
    ok(((await btn.getAttribute("title")) ?? "").includes("LibreOffice"), "with the reason");
    await off.nav("PDF Tools");
    const card = off.page.locator(".pdf-grid .op-card", { hasText: "Documents to PDF" });
    eq(await card.getAttribute("aria-disabled"), "true", "its card is off");
    ok((await card.innerText()).includes("LibreOffice"), "and names the reason");
    await off.close();
  }

  // ------------------------------------------------------------------ directory, notices, settings
  section("Supported formats directory");
  {
    const a = await open();
    const { page } = a;
    await a.nav("Settings");
    await page.getByRole("button", { name: "Supported formats" }).click();
    await page.waitForSelector(".matrix");
    eq(await page.locator(".matrix").first().locator("[aria-label=supported]").count(), 9, "3 x 3 image conversion matrix");
    eq(await page.locator(".matrix").count(), 2, "images, and PDF pages to images");
    eq(await page.locator(".plain-table").first().locator("tbody tr").count(), 4, "four engines listed");
    const txt = await page.locator("body").innerText();
    ok(/libwebp 1\.3\.1/.test(txt) && /zip crate 2\.6\.1/.test(txt), "real engine versions shown");
    ok(txt.includes("Largest WebP image") && txt.includes("16,383"), "limits shown");
    await page.locator("summary", { hasText: "What changes in each conversion" }).first().click();
    ok((await page.locator(".notes").first().innerText()).includes("Transparent areas are filled"), "conversion notes shown");
    await a.shot("formats");
    await a.close();
  }

  section("Third-party notices");
  {
    const a = await open();
    const { page } = a;
    await a.nav("Settings");
    await page.getByRole("button", { name: "Third-party notices" }).click();
    await page.waitForSelector(".notices-scroll");
    ok(await page.locator(".notices-scroll tbody tr").count() > 100, "component list is populated");
    await page.getByLabel("Search components").fill("libwebp");
    ok(await page.locator(".notices-scroll tbody tr").count() >= 1, "search works");
    await page.locator("summary", { hasText: "libwebp" }).first().click();
    ok((await page.getByLabel("libwebp license text").innerText()).includes("Redistribution and use in source and binary forms"), "libwebp license text shown");
    ok((await page.locator("body").innerText()).includes("MPL-2.0"), "MPL/OFL conditions called out");
    await a.close();
  }

  section("Settings shows real engines and service status");
  {
    const a = await open();
    await a.nav("Settings");
    await a.page.waitForSelector(".engine-list");
    eq(await a.texts(".engine-list li strong"), ["ZIP archives", "Images (JPG, PNG, WEBP)", "PDF tools (PDFium)", "Office documents (LibreOffice)"], "engines from capabilities");
    ok((await a.page.locator(".engine-list").innerText()).includes("Built in"), "availability shown");
    ok((await a.page.locator("body").innerText()).includes("Running on this computer"), "service status shown");
    await a.close();
  }

  // ------------------------------------------------------------------ other workflows keep working
  section("Compress: folder + file, conflicts, cancel");
  {
    const a = await open();
    const { page } = a;
    await a.nav("Compress");
    await a.drop(["/home/amine/Documents/photo-set", "/home/amine/Documents/invoice.pdf"]);
    await page.waitForSelector(".filelist");
    await page.evaluate(() => (window.__MOCK.conflicts = ["photo-set.zip"]));
    await page.getByLabel("Archive name").fill("photo-set");
    await page.waitForSelector("text=with the same name already exist");
    await page.locator(".action-bar").getByRole("button", { name: "Compress" }).click();
    await page.waitForSelector("role=dialog");
    ok(await page.evaluate(() => !!document.activeElement.closest(".dialog")), "dialog takes focus");
    await page.keyboard.press("Escape");
    ok(await page.locator("role=dialog").count() === 0, "Esc closes the dialog");
    await page.locator(".action-bar").getByRole("button", { name: "Compress" }).click();
    await page.getByText("Skip files that already exist").click();
    await page.getByRole("dialog").getByRole("button", { name: "Compress" }).click();
    await page.waitForSelector("text=Compressing…", { timeout: 6000 });
    eq(await page.evaluate(() => window.__MOCK.lastRequest.conflict), "skip", "chosen conflict policy reaches the request");
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.waitForSelector("text=Job cancelled");
    await a.close();
  }

  section("Convert: failure shows a plain message and keeps the files");
  {
    const a = await open();
    const { page } = a;
    await a.nav("Convert");
    await a.drop([PICS + "portrait.jpg"]);
    await page.evaluate(() => { window.__MOCK.fail = { code: "CORRUPT_IMAGE", message: "This image is damaged or incomplete." }; window.__MOCK.processSeconds = 1; });
    await page.waitForSelector(".filelist");
    await page.locator(".action-bar").getByRole("button", { name: "Convert", exact: true }).click();
    await page.waitForSelector("text=That didn't work", { timeout: 10000 });
    await page.getByRole("button", { name: "Back to options" }).click();
    eq(await page.locator(".filelist__row").count(), 1, "files kept");
    await a.close();
  }

  section("Extract: password, unsafe and wrong-type gating");
  {
    const a = await open();
    const { page } = a;
    await a.nav("Extract");
    const btn = page.locator(".action-bar").getByRole("button", { name: "Extract" });
    await a.drop(["/home/amine/Downloads/secret.zip"]);
    await page.waitForSelector("text=Password protected");
    ok(await btn.isDisabled(), "needs the password first");
    await page.getByLabel("Password").fill("hunter2");
    await page.waitForTimeout(500);
    ok(await btn.isEnabled(), "enabled with a password");
    await page.getByRole("button", { name: "Clear all" }).click();
    await a.drop(["/home/amine/Downloads/evil.zip"]);
    await page.waitForSelector("text=This archive isn't safe to extract");
    ok(await btn.isDisabled(), "unsafe archive blocked");
    await page.getByRole("button", { name: "Clear all" }).click();
    await a.drop([PICS + "holiday.png"]);
    await page.waitForSelector("text=Not a supported file (ZIP)");
    ok(await btn.isDisabled(), "wrong type blocked, with the supported format named");
    await a.close();
  }

  section("Recent Jobs: filters, search, menu");
  {
    const a = await open();
    const { page } = a;
    await a.nav("Recent Jobs");
    await page.waitForSelector(".jobtable");
    ok((await a.texts(".jobtable thead th")).map((x) => x.toLowerCase()).includes("size"), "full history shows Size");
    await page.getByRole("button", { name: /^Failed/ }).click();
    eq(await page.locator(".jobtable tbody tr").count(), 1, "status filter");
    await page.getByRole("button", { name: /^All/ }).click();
    await page.getByLabel("Search jobs").fill("photo");
    eq(await page.locator(".jobtable tbody tr").count(), 1, "search");
    await page.getByLabel("Search jobs").fill("");
    await page.getByRole("button", { name: "Actions for logo.webp" }).click();
    ok(await page.getByRole("menuitem", { name: "Show in folder" }).getAttribute("aria-disabled") === "true", "no result to show for a failed job");
    await a.close();
  }

  // ------------------------------------------------------------------ accessibility + layout
  section("Accessibility (axe, WCAG A/AA) on every screen");
  {
    const a = await open();
    const { page } = a;
    await page.evaluate(axeSrc);
    const screens = [["Dashboard"], ["Convert"], ["PDF Tools"], ["Compress"], ["Extract"], ["Recent Jobs"], ["Settings"]];
    const check = async (name) => {
      await page.waitForTimeout(250);
      const v = await page.evaluate(async () => (await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa"] })).violations.map((x) => `${x.id}: ${x.nodes[0].target}`));
      ok(v.length === 0, `${name}: ${v.join("; ")}`);
    };
    for (const [n] of screens) { await a.nav(n); await check(n); }
    await page.getByRole("button", { name: /Open PDF Editor/ }).count();
    await a.nav("PDF Tools"); await page.getByRole("button", { name: /Open PDF Editor/ }).click(); await check("PDF Editor (empty)");
    await openViaDialog(a, DOCS + "locked.pdf"); await page.waitForSelector(".pdf-password"); await check("PDF Editor (password)");
    await page.getByLabel("Password").fill("open-sesame"); await page.keyboard.press("Enter"); await page.waitForSelector(".pdf-preview img"); await page.waitForFunction(() => document.querySelectorAll(".thumb__frame img").length === 2); await check("PDF Editor (open)");
    await openViaDialog(a, DOCS + "signed.pdf"); await page.waitForSelector(".callout--warning"); await check("PDF Editor (warnings)");
    await openViaDialog(a, DOCS + "report.pdf"); await page.waitForSelector(".pdf-preview img");
    await page.locator(".tool", { hasText: "Rotate right" }).click(); await page.waitForSelector(".dirty-bar"); await page.waitForFunction(() => document.querySelectorAll(".thumb__frame img").length === 3); await check("PDF Editor (page changes)");
    await page.getByRole("button", { name: "Save Copy" }).click(); await page.waitForSelector(".dialog .callout--warning"); await check("PDF Editor (save dialog)");
    await page.keyboard.press("Escape");
    await a.nav("Dashboard"); await page.waitForTimeout(300);
    await a.drop([DOCS + "invoice.pdf", DOCS + "long.pdf"]); await page.waitForSelector(".filelist");
    await a.nav("PDF Tools"); await page.locator(".pdf-grid .op-card", { hasText: "Merge PDFs" }).click(); await page.waitForSelector(".ordered"); await check("Merge PDFs");
    await a.nav("PDF Tools"); await page.locator(".pdf-grid .op-card", { hasText: "Split PDF" }).click(); await page.waitForSelector("#split-every"); await check("Split PDF");
    await a.nav("Settings"); await page.getByRole("button", { name: "Supported formats" }).click(); await check("Supported formats");
    await a.nav("Settings"); await page.getByRole("button", { name: "Third-party notices" }).click(); await check("Third-party notices");
    await a.close();
  }

  section("Layout at the 900 x 600 minimum window");
  {
    const a = await open({ w: 900, h: 600 });
    const { page } = a;
    const overflow = () => page.evaluate(() => { const s = document.querySelector(".shell__scroll"); return s.scrollWidth > s.clientWidth + 1; });
    for (const n of ["Dashboard", "Convert", "PDF Tools", "Compress", "Extract", "Recent Jobs", "Settings"]) {
      await a.nav(n); await page.waitForTimeout(150);
      ok(!(await overflow()), `no horizontal overflow on ${n}`);
    }
    await a.nav("PDF Tools"); await page.getByRole("button", { name: /Open PDF Editor/ }).click(); await page.waitForSelector(".editor");
    ok(!(await overflow()), "no horizontal overflow in the PDF editor");
    await openViaDialog(a, DOCS + "report.pdf"); await page.waitForSelector(".pdf-preview img"); await page.waitForTimeout(300);
    ok(!(await overflow()), "no horizontal overflow with a PDF open");
    const fits = await page.evaluate(() => { const p = document.querySelector(".pdf-preview").getBoundingClientRect(); const i = document.querySelector(".pdf-preview img").getBoundingClientRect(); return i.right <= p.right + 1 && i.left >= p.left - 1; });
    ok(fits, "fit-width keeps the page inside the preview at the minimum window");
    await a.shot("pdf-editor-900");
    await a.nav("Dashboard"); await a.shot("dashboard-900");
    await a.close();
  }
} finally {
  await browser.close();
  vite.kill();
}
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
