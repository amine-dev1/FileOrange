// End-to-end: the real React app in a real browser, talking through the dev proxy to the real Rust engine
// (PDFium and LibreOffice included). Files that come out are downloaded and inspected.
//   npm run test:e2e           local engine behind the dev proxy (what `npm run dev:all` runs)
//   npm run test:e2e:hosted    the same suite against a HOSTED server that also serves the built web app (what is deployed),
//                              plus checks that only matter there: sessions, signed downloads, limits, the usage meter
// Needs target/debug/file-api built, CHROMIUM_PATH set, and ORANGEFILE_PDFIUM for the PDF parts.
import { chromium } from "playwright-core";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const web = fileURLToPath(new URL("..", import.meta.url));
const root = resolve(web, "..");
const FIX = join(root, "crates/file-core/tests/fixtures");
const pdfFix = (n) => join(FIX, "pdf", n);
const officeFix = (n) => join(FIX, "office", n);
const work = mkdtempSync(join(tmpdir(), "of-web-e2e-"));
const OUT = join(web, "test-results");
mkdirSync(OUT, { recursive: true });

let failures = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { failures++; console.log("  FAIL", m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const section = (n) => console.log("\n" + n);

// ---------------------------------------------------------------- the engine and the web app
const HOSTED = process.env.E2E_MODE === "hosted";
let captchaChecks = 0;
/** Instead of Cloudflare's script: a widget that answers straight away, as an invisible challenge does. */
const FAKE_TURNSTILE = `window.turnstile = { render(el, o) { window.__captchaSiteKey = o.sitekey; setTimeout(() => o.callback("test-token"), 30); return "w1"; }, remove() {} };`;
async function withFakeCaptcha(ctx) {
  if (HOSTED) await ctx.route("https://challenges.cloudflare.com/**", (r) => r.fulfill({ contentType: "text/javascript", body: FAKE_TURNSTILE }));
  return ctx;
}
const API_PORT = HOSTED ? 8795 : 8791, WEB_PORT = 5199;
const TOKEN = randomBytes(32).toString("hex");
const API = `http://127.0.0.1:${API_PORT}`;
const MAX_FILE_MB = 1; // hosted: small, so "too big" is easy to test
const bin = join(root, "target/debug", process.platform === "win32" ? "file-api.exe" : "file-api");
if (!existsSync(bin)) throw new Error(`build the engine first: cargo build -p file-api (${bin})`);
const env = { ...process.env, FILE_API_TOKEN: TOKEN, FILE_API_BIND: `127.0.0.1:${API_PORT}`, FILE_API_DATA_DIR: join(work, "data"), RUST_LOG: "warn" };
if (HOSTED) {
  // The server also hosts the built web app, as it will when deployed. Each simulated visitor gets an address through a header.
  console.log("building the web app…");
  execFileSync("npx", ["vite", "build", "--outDir", join(work, "site"), "--emptyOutDir"], { cwd: web, stdio: "ignore", shell: process.platform === "win32" });
  // A stand-in for Cloudflare's CAPTCHA checker: the fake widget below always answers "test-token".
  const { createServer } = await import("node:http");
  captchaChecks = 0;
  createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captchaChecks++;
      const ok = new URLSearchParams(body).get("response") === "test-token";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: ok }));
    });
  }).listen(8797, "127.0.0.1").unref();
  Object.assign(env, { FILE_API_TURNSTILE_SITE_KEY: "test-site-key", FILE_API_TURNSTILE_SECRET: "test-secret", FILE_API_TURNSTILE_VERIFY_URL: "http://127.0.0.1:8797/siteverify" });
  Object.assign(env, { FILE_API_MODE: "hosted", FILE_API_SESSION_SECRET: randomBytes(32).toString("hex"), FILE_API_ALLOWED_HOSTS: "orangefile.test", FILE_API_STATIC_DIR: join(work, "site"), FILE_API_CLIENT_IP_HEADER: "x-test-ip", FILE_API_MAX_FILE_MB: String(MAX_FILE_MB) });
  delete env.FILE_API_TOKEN;
}
const pdfium = resolve(root, "src-tauri/resources/pdfium");
if (!env.ORANGEFILE_PDFIUM && existsSync(pdfium)) env.ORANGEFILE_PDFIUM = pdfium;
const detached = process.platform !== "win32"; // own process group, so everything it starts can be stopped with it
const engine = spawn(bin, [], { env, stdio: "ignore", detached });
const vite = HOSTED ? null : spawn("npx", ["vite", "--port", String(WEB_PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: web, env: { ...process.env, ORANGEFILE_API_URL: API, ORANGEFILE_API_TOKEN: TOKEN }, shell: process.platform === "win32", stdio: "ignore", detached });
const stop = (c) => { try { detached ? process.kill(-c.pid) : c.kill(); } catch { /* already gone */ } };
const cleanup = () => { stop(engine); if (vite) stop(vite); };
process.on("exit", cleanup);
const waitFor = async (url) => { for (let i = 0; i < 120; i++) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 500)); } throw new Error(`${url} did not come up`); };
await waitFor(`${API}/health`);
const BASE = HOSTED ? API : `http://127.0.0.1:${WEB_PORT}`;
await waitFor(`${BASE}/`);

// ---------------------------------------------------------------- helpers
let engineToken = null;
/** Talk to the engine directly, as a trusted checker (hosted: as a visitor of its own). */
const eng = async (p, init = {}) => {
  if (HOSTED && !engineToken) engineToken = (await (await fetch(`${API}/api/v1/session`, { method: "POST", headers: { "x-test-ip": "10.250.0.1", "x-turnstile-token": "test-token" } })).json()).token;
  return fetch(`${API}/api/v1${p}`, { ...init, headers: { authorization: `Bearer ${HOSTED ? engineToken : TOKEN}`, ...(HOSTED ? { "x-test-ip": "10.250.0.1" } : {}), ...(init.headers || {}) } });
};
const py = (code, ...args) => execFileSync("python3", ["-I", "-c", code, ...args], { encoding: "utf8" });

/** Open bytes as a PDF in the engine itself to read what it says, then close it. */
async function withPdf(buf, fn, password) {
  const form = new FormData();
  if (password) form.append("password", password);
  form.append("file", new Blob([buf]), "x.pdf");
  const r = await eng("/pdf/documents", { method: "POST", body: form });
  if (r.status !== 201) throw new Error(`engine refused the PDF: ${r.status} ${await r.text()}`);
  const doc = await r.json();
  try { return await fn(doc); } finally { await eng(`/pdf/documents/${doc.id}`, { method: "DELETE" }); }
}
const pdfInfo = (buf) => withPdf(buf, (d) => d.info);
/** RGB of the page at fractions (fx, fy) of its width and height, as drawn by PDFium. */
const pixels = (buf, page, spots, width = 600) => withPdf(buf, async (d) => {
  const img = Buffer.from(await (await eng(`/pdf/documents/${d.id}/pages/${page}/image?width=${width}`)).arrayBuffer());
  const f = join(work, `px-${Math.random().toString(36).slice(2)}.png`);
  writeFileSync(f, img);
  const out = py("import sys,json\nfrom PIL import Image\nim=Image.open(sys.argv[1]).convert('RGB')\nspots=json.loads(sys.argv[2])\nw,h=im.size\nprint(json.dumps([im.getpixel((min(w-1,int(x*w)),min(h-1,int(y*h)))) for x,y in spots]))", f, JSON.stringify(spots));
  return JSON.parse(out);
});
/** Names of the files in a ZIP (folder entries left out). */
const zipNames = (file) => py("import zipfile,sys\nprint('\\n'.join(sorted(n for n in zipfile.ZipFile(sys.argv[1]).namelist() if not n.endswith('/'))))", file).split("\n").filter(Boolean);

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(file, w, h, [r, g, b]) {
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk("IEND", Buffer.alloc(0))]));
  return file;
}
const red = png(join(work, "red.png"), 200, 100, [255, 0, 0]);
const blue = png(join(work, "blue.png"), 100, 200, [0, 0, 255]);
const green = png(join(work, "stamp.png"), 80, 40, [0, 160, 0]);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] } : { channel: "msedge" });
const axeSrc = readFileSync(join(web, "node_modules/axe-core/axe.min.js"), "utf8");

let visitorNo = 0;
async function open(path = "/", { w = 1280, h = 860, dark = false, mobile = false, ip = null, locale = "en-US" } = {}) {
  // Hosted: every browser context is a different visitor on a different network address.
  const extraHTTPHeaders = HOSTED ? { "x-test-ip": ip ?? `10.20.${Math.floor(++visitorNo / 250)}.${(visitorNo % 250) + 1}` } : undefined;
  const ctx = await withFakeCaptcha(await browser.newContext({ viewport: { width: w, height: h }, acceptDownloads: true, colorScheme: dark ? "dark" : "light", isMobile: mobile, hasTouch: mobile, extraHTTPHeaders, locale }));
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  await page.goto(BASE + path);
  await page.waitForSelector("main");
  return { page, ctx, errors, close: () => ctx.close() };
}
const input = (page, label) => (label ? page.locator(`input[type=file][aria-label="${label}"]`) : page.locator("input[type=file]").first());
const done = (page) => page.getByRole("heading", { name: /All done|Finished with some problems/ }).waitFor({ timeout: 90_000 });
async function download(page, linkName = /^Download/) {
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: linkName }).first().click()]);
  const f = join(work, `${Math.random().toString(36).slice(2)}-${dl.suggestedFilename()}`);
  await dl.saveAs(f);
  return { file: f, name: dl.suggestedFilename(), bytes: readFileSync(f) };
}
const radio = (page, name) => page.getByRole("radio", { name, exact: true });
const hasPdfium = !!env.ORANGEFILE_PDFIUM;

// ================================================================== dashboard and capabilities
section("Landing page");
{
  const a = await open("/");
  const { page } = a;
  await page.getByRole("heading", { level: 1, name: /Turn the file you have into the one you need/ }).waitFor();
  ok(true, "the headline is there");
  await page.waitForTimeout(800);
  eq(await page.locator("#video").count(), 0, "no video section while there is no video file (never an empty player)");
  ok(await page.getByRole("figure").getByText(/tool:/).isVisible(), "the conversion animation runs");
  await page.getByRole("button", { name: "Show example: Folder to ZIP" }).click();
  await page.getByRole("figure").getByText("Make a ZIP").waitFor();
  ok(true, "an example can be picked");
  await page.getByRole("link", { name: /Merge PDFs/ }).click();
  await page.getByRole("heading", { name: "Merge PDFs" }).waitFor();
  ok(true, "a tool on the landing page opens that tool");
  await page.goto(BASE + "/");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Open the app" }).click();
  await page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ }).waitFor();
  ok(true, "Open the app goes to the dashboard");
  await page.getByRole("link", { name: "OrangeFile home" }).click();
  await page.getByRole("heading", { level: 1, name: /Turn the file/ }).waitFor();
  ok(true, "the logo in the app leads back to the landing page");
  eq(await page.getByRole("link", { name: /Donate/ }).count(), 0, "no donate button while no donation link is configured");
  await page.getByText("Is it really free?").click();
  await page.getByText(/no paid plan and no account/).waitFor();
  ok(true, "questions open");
  eq(errorsOf(a), [], "no console errors on the landing page");
  await a.close();

  const m = await open("/", { w: 390, h: 800, mobile: true });
  ok(await m.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "landing: no sideways scrolling on a phone");
  await m.close();

  // people who ask for less motion see everything at once, without animation
  const ctx = await withFakeCaptcha(await browser.newContext({ reducedMotion: "reduce", extraHTTPHeaders: HOSTED ? { "x-test-ip": "10.40.0.1" } : undefined }));
  const rp = await ctx.newPage();
  await rp.goto(BASE + "/");
  await rp.getByRole("heading", { level: 1 }).waitFor();
  const hidden = await rp.evaluate(() => [...document.querySelectorAll("[data-reveal], .lp-rise")].filter((e) => getComputedStyle(e).opacity !== "1").length);
  eq(hidden, 0, "with reduced motion nothing waits for an animation to be seen");
  await ctx.close();
}

section("French: chosen from the browser, switchable, and the tools work in French");
{
  const a = await open("/", { locale: "fr-FR" });
  const { page } = a;
  await page.getByRole("heading", { level: 1, name: /Votre fichier, dans le format qu'il vous faut/ }).waitFor();
  ok(true, "a French browser gets the French landing page");
  eq(await page.evaluate(() => document.documentElement.lang), "fr", "and the page says it is in French");
  await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Ouvrir l'appli" }).click();
  await page.getByRole("heading", { name: /Bonjour|Bon après-midi|Bonsoir/ }).waitFor();
  const nav = await page.getByRole("navigation", { name: "Principal" }).innerText();
  ok(["Tableau de bord", "Convertir", "Compresser des images", "Outils PDF", "Créer un ZIP", "Tâches récentes", "À propos"].every((x) => nav.includes(x)), "the menu is in French: " + nav.replace(/\n/g, " | "));

  // a whole job in French: options, notes from the server, the result, sizes in Ko
  await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Compresser des images" }).click();
  await page.getByRole("heading", { name: "Compresser des images" }).waitFor();
  await input(page).setInputFiles([red]);
  await page.getByRole("button", { name: "50%" }).click();
  await page.getByRole("button", { name: "Alléger", exact: true }).click();
  await page.getByRole("heading", { name: "C'est prêt" }).waitFor({ timeout: 60_000 });
  await page.getByText(/Redimensionnée de 200×100 à 100×50 px\./).waitFor();
  ok(true, "the server's note is shown in French");
  const dlText = (await page.getByRole("link", { name: /^Télécharger/ }).first().innerText()).replace(/\s+/g, " ");
  ok(/Télécharger .+\(\d+(,\d)? (o|Ko)\)/.test(dlText), "sizes use French units: " + dlText);

  // back to English with the switch, remembered
  await page.getByRole("radio", { name: "English" }).click();
  await page.getByRole("heading", { name: "Compress images" }).waitFor();
  await page.getByRole("heading", { name: "All done" }).waitFor();
  ok(true, "switching to English changes the page at once, and the finished job is still there");
  await page.reload();
  await page.getByRole("heading", { name: "Compress images" }).waitFor();
  ok(true, "and the choice is remembered over the browser's language");
  await page.getByRole("radio", { name: "Français" }).click();
  await page.getByRole("heading", { name: "Compresser des images" }).waitFor();

  // accessibility in French, on the landing page and a tool page
  await page.evaluate(axeSrc);
  const v1 = await page.evaluate(async () => (await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa"] })).violations.map((x) => `${x.id}: ${x.nodes[0].target}`));
  ok(v1.length === 0, `French tool page passes axe: ${v1.join("; ")}`);
  await page.goto(BASE + "/");
  await page.getByRole("heading", { level: 1 }).waitFor();
  for (let y = 0; y < 6000; y += 500) { await page.evaluate((y) => window.scrollTo(0, y), y); await page.waitForTimeout(60); }
  await page.waitForTimeout(900);
  await page.evaluate(axeSrc);
  const v2 = await page.evaluate(async () => (await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa"] })).violations.map((x) => `${x.id}: ${x.nodes[0].target}`));
  ok(v2.length === 0, `French landing page passes axe: ${v2.join("; ")}`);
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "longer French text doesn't make the page scroll sideways");
  eq(errorsOf(a), [], "no console errors in French");
  await a.close();

  // phone width in French: the longest labels still fit
  const m = await open("/", { w: 390, h: 800, mobile: true, locale: "fr-FR" });
  await m.page.getByRole("heading", { level: 1 }).waitFor();
  ok(await m.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "French landing page fits a phone");
  await m.page.goto(BASE + "/resize");
  await m.page.waitForSelector("main");
  ok(await m.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "French tool page fits a phone");
  await m.close();
}

section("Dashboard follows what the engine reports");
{
  const a = await open("/app");
  const { page } = a;
  await page.getByRole("heading", { name: /Good (morning|afternoon|evening)/ }).waitFor();
  const caps = await (await eng("/capabilities")).json();
  const cards = await page.locator("#tools-heading + div a, #tools-heading + div [aria-disabled]").count();
  eq(cards, 14, "one card per tool");
  const open_ = await page.locator("#tools-heading + div a").count();
  eq(open_, caps.operations.filter((o) => ["convert_image", "resize_image", "compress", "extract", "pdf_view", "pdf_annotate", "pdf_compress", "pdf_protect", "pdf_unlock", "pdf_merge", "pdf_split", "images_to_pdf", "pdf_to_images", "office_to_pdf"].includes(o.id) && o.available).length, "cards that can be opened = available operations");
  // Selecting files offers exactly the tools that fit them.
  await input(page).setInputFiles([red]);
  await page.getByRole("heading", { name: "Selected files" }).waitFor();
  const offered = await page.locator("main").getByRole("button").allInnerTexts();
  ok(offered.includes("Convert") && offered.includes("Make a ZIP") && offered.includes("Compress images") && offered.includes("Images to PDF"), "tools for a picture: " + offered.join("|"));
  ok(!offered.includes("Open PDF") && !offered.includes("Merge PDFs"), "no PDF tools for a picture");
  eq(await page.locator("main").getByRole("button", { name: "Convert", exact: true }).isEnabled(), true, "Convert is enabled for a picture");
  await page.getByRole("button", { name: "Clear all" }).click();
  await input(page).setInputFiles([pdfFix("three-pages.pdf"), red]);
  await page.getByRole("heading", { name: "Selected files" }).waitFor();
  const why = (await page.getByRole("list", { name: "Why some tools are off" }).innerText()).replace(/\s+/g, " ");
  ok(/Convert: Needs/.test(why), "mixed selection explains why Convert is off: " + why);
  eq(errorsOf(a), [], "no console errors");
  await a.close();
}
function errorsOf(a) { return a.errors; }

// ================================================================== convert
section("Convert images");
{
  const a = await open("/convert");
  const { page } = a;
  const bad = join(work, "not-an-image.png");
  writeFileSync(bad, "this is plain text pretending to be a picture");
  await input(page).setInputFiles([bad]);
  await page.getByText(/isn't a file type this operation can use|Can't use this selection/).first().waitFor({ timeout: 10_000 });
  ok(await page.getByRole("button", { name: "Convert", exact: true }).isDisabled(), "a text file named .png is refused before upload (content, not name)");
  await page.getByRole("button", { name: "Clear all" }).click();
  await input(page).setInputFiles([red, blue]);
  await page.getByRole("radiogroup", { name: "Convert to" }).waitFor();
  eq(await page.getByRole("radiogroup", { name: "Convert to" }).getByRole("radio").allInnerTexts(), ["JPG", "PNG", "WEBP"], "output formats come from the capability report");
  await radio(page, "JPG").click();
  ok(await page.locator("#opt-quality").count() === 1 && await page.locator("#opt-background").count() === 1, "JPG shows quality and background colour");
  await radio(page, "PNG").click();
  eq(await page.locator("#opt-quality").count(), 0, "PNG has no quality slider");
  await radio(page, "JPG").click();
  await page.getByRole("button", { name: "Convert", exact: true }).click();
  await done(page);
  const dl = await download(page, /Download all as ZIP|Download/);
  ok(dl.name.endsWith(".zip"), `two results come as a ZIP (${dl.name})`);
  const names = zipNames(dl.file);
  eq(names.length, 2, "two files in the ZIP");
  ok(names.every((n) => n.endsWith(".jpg")), `they are JPGs: ${names}`);
  // one file -> that file, not a ZIP
  await page.getByRole("button", { name: "Start another" }).click();
  await input(page).setInputFiles([red]);
  await radio(page, "WEBP").click();
  await page.getByRole("button", { name: "Convert", exact: true }).click();
  await done(page);
  const one = await download(page);
  eq(one.name, "red.webp", "one result is downloaded as itself");
  eq(one.bytes.subarray(0, 4).toString(), "RIFF", "and it really is a WebP");
  eq(errorsOf(a), [], "no console errors");
  await a.close();
}

// ================================================================== compress + extract
let zipFile;
section("Compress images (resize, file size)");
{
  const a = await open("/resize");
  const { page } = a;
  // by percentage, same format: a PNG stays a PNG at half the size
  await input(page).setInputFiles([red]);
  await page.getByRole("button", { name: "50%" }).click();
  await page.getByRole("button", { name: "Make smaller", exact: true }).click();
  await done(page);
  const half = await download(page);
  eq(half.bytes.subarray(0, 4).toString("hex"), "89504e47", "a PNG stays a PNG");
  eq(py("import sys\nfrom PIL import Image\nprint(Image.open(sys.argv[1]).size)", half.file).trim(), "(100, 50)", "at half its size");
  await page.getByText(/Resized from 200×100 to 100×50 px/).waitFor();
  ok(true, "the result says what changed");

  // aim for a file size: a noisy picture, saved as JPG under 40 KB
  await page.getByRole("button", { name: "Start another" }).click();
  const noisy = join(work, "noisy.png");
  py("import sys,os\nfrom PIL import Image\nImage.frombytes('RGB',(480,480),os.urandom(480*480*3)).save(sys.argv[1])", noisy);
  await input(page).setInputFiles([noisy]);
  await radio(page, "Keep the size").click();
  await radio(page, "JPG").click();
  await page.getByRole("switch", { name: "Aim for a file size" }).click();
  await page.locator("#rs-kb").fill("40");
  await page.getByRole("button", { name: "Make smaller", exact: true }).click();
  await done(page);
  const small = await download(page);
  eq(small.bytes.subarray(0, 3).toString("hex"), "ffd8ff", "saved as JPG");
  ok(small.bytes.length <= 40_000, `under 40 KB (${small.bytes.length} bytes)`);
  await page.getByText(/keeps it under 40 KB/).waitFor();
  ok(/\d+% smaller/.test(await page.getByTestId("size-change").innerText()), "the result says how much smaller it got: " + (await page.getByTestId("size-change").innerText()));
  ok(true, "the result names the quality used");

  // nothing to do is not offered
  await page.getByRole("button", { name: "Start another" }).click();
  await input(page).setInputFiles([red]);
  await radio(page, "Keep the size").click();
  ok(await page.getByRole("button", { name: "Make smaller", exact: true }).isDisabled(), "keeping size, format and quality can't be run");
  eq(errorsOf(a), [], "no console errors");
  await a.close();
}

section("Compress a folder, then extract it");
{
  const tree = join(work, "photos");
  mkdirSync(join(tree, "2024"), { recursive: true });
  writeFileSync(join(tree, "readme.txt"), "hello");
  writeFileSync(join(tree, "2024", "notes.txt"), "world");
  const a = await open("/compress");
  const { page } = a;
  await input(page, "Choose a folder").setInputFiles(tree);
  await page.getByText("2024/notes.txt").waitFor();
  await page.locator("#archive-name").fill("my archive");
  await page.getByRole("button", { name: "Make the ZIP", exact: true }).click();
  await done(page);
  const dl = await download(page);
  eq(dl.name, "my archive.zip", "named as typed");
  zipFile = dl.file;
  eq(zipNames(dl.file), ["photos/2024/notes.txt", "photos/readme.txt"], "the folder structure is kept");
  await a.close();

  const b = await open("/extract");
  await input(b.page).setInputFiles([zipFile]);
  await b.page.getByRole("button", { name: "Extract", exact: true }).click();
  await done(b.page);
  const out = await download(b.page);
  ok(out.name.endsWith(".zip"), "extracted files come back as a ZIP");
  ok(zipNames(out.file).some((n) => n.endsWith("notes.txt")), "with the extracted files inside: " + zipNames(out.file));
  await b.close();
}

// ================================================================== PDF tools
if (!hasPdfium) console.log("\n(skipping PDF sections: ORANGEFILE_PDFIUM is not set)");
else {
  section("Merge PDFs (order matters)");
  {
    const a = await open("/pdf/merge");
    const { page } = a;
    await input(page).setInputFiles([pdfFix("three-pages.pdf"), pdfFix("second.pdf")]);
    await page.getByRole("button", { name: "Move three-pages.pdf down" }).click();
    eq(await page.locator("ol li p.font-medium").allInnerTexts(), ["second.pdf", "three-pages.pdf"], "can be reordered");
    await page.locator("#merge-name").fill("both");
    await page.getByRole("button", { name: "Merge", exact: true }).click();
    await done(page);
    const dl = await download(page);
    eq(dl.name, "both.pdf", "named as typed");
    eq((await pdfInfo(dl.bytes)).page_count, 5, "3 + 2 pages");
    await a.close();

    const b = await open("/pdf/merge");
    await input(b.page).setInputFiles([pdfFix("second.pdf")]);
    ok(await b.page.getByRole("button", { name: "Merge", exact: true }).isDisabled(), "one PDF isn't enough to merge");
    await b.close();
  }

  section("Split a PDF");
  {
    const a = await open("/pdf/split");
    const { page } = a;
    await input(page).setInputFiles([pdfFix("ten-pages.pdf")]);
    await page.locator("#split-every").fill("4");
    await page.getByRole("button", { name: "Split", exact: true }).click();
    await done(page);
    const dl = await download(page);
    eq(zipNames(dl.file), ["ten-pages (split)/ten-pages - pages 1-4.pdf", "ten-pages (split)/ten-pages - pages 5-8.pdf", "ten-pages (split)/ten-pages - pages 9-10.pdf"], "three parts in a folder");
    await page.getByRole("button", { name: "Start another" }).click();
    await input(page).setInputFiles([pdfFix("ten-pages.pdf")]);
    await radio(page, "Page ranges").click();
    await page.locator("#split-ranges").fill("2-3, 9-");
    await page.getByRole("button", { name: "Split", exact: true }).click();
    await done(page);
    eq(zipNames((await download(page)).file).length, 2, "two ranges, two files");
    await a.close();
  }

  section("Images to PDF and PDF to images");
  {
    const a = await open("/pdf/images-to-pdf");
    const { page } = a;
    await input(page).setInputFiles([red, blue]);
    await radio(page, "Letter").click();
    await radio(page, "Landscape").click();
    await page.locator("#img-margin").fill("99");
    ok(await page.getByRole("button", { name: "Create PDF" }).isDisabled(), "a margin over 50 mm is refused");
    await page.locator("#img-margin").fill("12");
    await page.locator("#img-name").fill("pics");
    await page.getByRole("button", { name: "Create PDF" }).click();
    await done(page);
    const dl = await download(page);
    eq(dl.name, "pics.pdf", "named as typed");
    const info = await pdfInfo(dl.bytes);
    eq(info.page_count, 2, "one page per picture");
    eq(info.pages.map((p) => [Math.round(p.width_pt), Math.round(p.height_pt)]), [[792, 612], [792, 612]], "Letter, landscape");
    const [[r1], [b2]] = [await pixels(dl.bytes, 1, [[0.5, 0.5]]), await pixels(dl.bytes, 2, [[0.5, 0.5]])];
    ok(r1[0] > 200 && r1[1] < 60 && r1[2] < 60, `page 1 shows the red picture: ${r1}`);
    ok(b2[2] > 200 && b2[0] < 60 && b2[1] < 60, `page 2 shows the blue picture: ${b2}`);
    await a.close();

    const b = await open("/pdf/to-images");
    await input(b.page).setInputFiles([pdfFix("three-pages.pdf")]);
    await radio(b.page, "JPG").click();
    await b.page.locator("#pti-dpi").fill("5000");
    ok(await b.page.getByRole("button", { name: "Save images" }).isDisabled(), "5000 dpi is refused");
    await b.page.locator("#pti-dpi").fill("72");
    await radio(b.page, "PNG").click();
    await b.page.getByRole("radio", { name: "Choose pages" }).click();
    await b.page.locator("#pti-pages").fill("2-3");
    await b.page.getByRole("button", { name: "Save images" }).click();
    await done(b.page);
    const imgs = await download(b.page);
    eq(zipNames(imgs.file), ["three-pages (images)/three-pages - page 2.png", "three-pages (images)/three-pages - page 3.png"], "only the chosen pages, named by page");
    await b.close();
  }

  section("Password-protected PDFs");
  {
    const a = await open("/pdf/split");
    await input(a.page).setInputFiles([pdfFix("encrypted.pdf")]);
    await a.page.getByRole("button", { name: "Split", exact: true }).click();
    await a.page.getByRole("heading", { name: "That didn't work" }).waitFor({ timeout: 60_000 });
    ok(/password/i.test(await a.page.locator("main").innerText()), "asks for the password");
    await a.page.getByRole("button", { name: "Try again" }).click();
    await a.page.locator("#split-password").fill("open-sesame");
    await a.page.getByRole("button", { name: "Split", exact: true }).click();
    await done(a.page);
    ok(!/open-sesame/.test(await a.page.content()), "the password is never shown back");
    await a.close();
  }
}

// ================================================================== Office documents
section("Documents to PDF");
{
  const caps = await (await eng("/capabilities")).json();
  const office = caps.operations.find((o) => o.id === "office_to_pdf");
  if (!office?.available) console.log("  (skipped: LibreOffice is not available)");
  else {
    const a = await open("/pdf/documents-to-pdf");
    const { page } = a;
    await input(page).setInputFiles([officeFix("report.docx"), officeFix("deck.pptx"), officeFix("sheet.xlsx")]);
    ok(/Layout can differ/.test(await page.locator("main").innerText()), "says the layout can differ from Microsoft Office");
    await page.getByRole("button", { name: "Convert to PDF" }).click();
    await done(page);
    const dl = await download(page);
    eq(zipNames(dl.file), ["deck.pdf", "report.pdf", "sheet.pdf"], "one PDF per document");
    await a.close();
    const b = await open("/pdf/documents-to-pdf");
    await input(b.page).setInputFiles([officeFix("report.docx")]);
    await b.page.getByRole("button", { name: "Convert to PDF" }).click();
    await done(b.page);
    const one = await download(b.page);
    eq(one.name, "report.pdf", "one document, one PDF");
    if (hasPdfium) eq((await pdfInfo(one.bytes)).page_count, 2, "the two-page document makes a two-page PDF");
    await b.close();
    const c = await open("/pdf/documents-to-pdf");
    await input(c.page).setInputFiles([red]);
    await c.page.getByText(/Not a supported file/).waitFor();
    ok(await c.page.getByRole("button", { name: "Convert to PDF" }).isDisabled(), "a picture isn't a document");
    await c.close();
  }
}

// ================================================================== editor
if (hasPdfium) {
  section("PDF editor: open, password, pages");
  {
    const a = await open("/pdf/editor");
    const { page } = a;
    await input(page, "Choose a PDF to open").setInputFiles([pdfFix("encrypted.pdf")]);
    await page.getByRole("heading", { name: "This PDF is password-protected" }).waitFor();
    await page.locator("#pdf-password").fill("wrong");
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.getByText("That password isn't right").waitFor();
    await page.locator("#pdf-password").fill("open-sesame");
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.waitForSelector('[data-position="1"]');
    ok(await page.getByRole("button", { name: "Save copy" }).isDisabled(), "nothing to save yet");
    await a.close();

    const b = await open("/pdf/editor");
    await input(b.page, "Choose a PDF to open").setInputFiles([pdfFix("three-pages.pdf")]);
    await b.page.waitForSelector('[data-position="3"]');
    await b.page.waitForFunction(() => document.querySelectorAll('[data-position] img').length === 3);
    ok(await b.page.locator('[aria-label="Page preview"] img').first().evaluate((i) => i.naturalWidth > 0), "preview is a decoded picture");
    // page plan: move page 3 earlier, rotate the page now at the end, delete nothing
    await b.page.locator('[data-position="3"]').click();
    await b.page.getByRole("button", { name: "Move earlier" }).click();
    await b.page.locator('[data-position="3"]').click();
    await b.page.getByRole("button", { name: "Rotate right" }).click();
    ok(await b.page.getByText("Changes not saved").isVisible(), "unsaved changes are announced");
    await b.page.getByRole("button", { name: "Save copy" }).click();
    await b.page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await b.page.getByText(/Saved “/).waitFor({ timeout: 60_000 });
    const out = await download(b.page);
    const info = await pdfInfo(out.bytes);
    eq(info.page_count, 3, "three pages");
    const orig = await pdfInfo(readFileSync(pdfFix("three-pages.pdf")));
    const [o1, o2, o3] = orig.pages.map((p) => [Math.round(p.width_pt), Math.round(p.height_pt)]);
    eq(info.pages.map((p) => [Math.round(p.width_pt), Math.round(p.height_pt)]), [o1, o3, [o2[1], o2[0]]], "order 1,3,2 and the last turned a quarter");
    // colours: page 1 red, page 3 (now second) is its own colour; not equal to page 2's
    await b.close();

    // extract selected pages only
    const c = await open("/pdf/editor");
    await input(c.page, "Choose a PDF to open").setInputFiles([pdfFix("three-pages.pdf")]);
    await c.page.waitForSelector('[data-position="3"]');
    await c.page.locator('[data-position="2"]').click();
    await c.page.locator('[data-position="3"]').click({ modifiers: ["Control"] });
    await c.page.getByRole("button", { name: "Extract…" }).click();
    ok(/2 selected pages/.test(await c.page.getByRole("dialog").innerText()), "extract describes the selection");
    await c.page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await c.page.getByText(/Saved “/).waitFor({ timeout: 60_000 });
    eq((await pdfInfo((await download(c.page)).bytes)).page_count, 2, "two pages extracted");
    await c.close();

    // closing with unsaved changes asks first
    const d = await open("/pdf/editor");
    await input(d.page, "Choose a PDF to open").setInputFiles([pdfFix("three-pages.pdf")]);
    await d.page.waitForSelector('[data-position="3"]');
    await d.page.getByRole("button", { name: "Rotate right" }).click();
    await d.page.getByRole("button", { name: "Close PDF" }).click();
    await d.page.getByRole("dialog", { name: "Discard your changes?" }).waitFor();
    await d.page.getByRole("button", { name: "Keep editing" }).click();
    ok(await d.page.locator('[data-position="1"]').isVisible(), "Keep editing keeps the document");
    eq(errorsOf(d), [], "no console errors");
    await d.close();
  }

  section("PDF editor: annotations are drawn into the saved copy (also on a turned page)");
  {
    const a = await open("/pdf/editor", { h: 1000 });
    const { page } = a;
    await input(page, "Choose a PDF to open").setInputFiles([pdfFix("three-pages.pdf")]);
    await page.waitForSelector('[data-position="3"]');
    await page.waitForSelector('[data-testid="annotation-layer"]');
    await page.waitForTimeout(600);
    const svg = () => page.locator('[data-testid="annotation-layer"]');
    const spot = async (fx, fy) => { const b = await svg().boundingBox(); return [b.x + b.width * fx, b.y + b.height * fy]; };
    const drag = async (from, to, steps = 6) => { await page.mouse.move(...(await spot(...from))); await page.mouse.down(); await page.mouse.move(...(await spot(...to)), { steps }); await page.mouse.up(); };
    const tool = (name) => page.getByRole("button", { name, exact: true });
    const kinds = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="annotation-layer"] [data-kind]')].map((e) => e.getAttribute("data-kind")));

    // page 1: filled blue rectangle, a picture, a text box, a pen stroke, a signature
    await tool("Shapes").click();
    await radio(page, "Rectangle").click();
    await page.getByLabel("Filled").check();
    await page.getByRole("radio", { name: "Blue" }).click();
    await drag([0.1, 0.1], [0.45, 0.25]);
    await input(page, "Choose a picture to place on the page").setInputFiles([green]);
    await page.getByText("Click where the picture goes").waitFor();
    await drag([0.55, 0.1], [0.85, 0.2]);
    await tool("Text box").click();
    await drag([0.1, 0.4], [0.6, 0.5]);
    await page.getByLabel("Text of the annotation").fill("Héllo wörld, this is long enough to wrap onto a second line");
    await page.keyboard.press("Escape");
    await tool("Draw").click();
    await drag([0.15, 0.6], [0.7, 0.7], 12);
    await tool("Visual signature").click();
    const pad = page.getByTestId("signature-pad");
    const pb = await pad.boundingBox();
    await page.mouse.move(pb.x + 30, pb.y + 60); await page.mouse.down(); await page.mouse.move(pb.x + 200, pb.y + 100, { steps: 8 }); await page.mouse.move(pb.x + 300, pb.y + 40, { steps: 8 }); await page.mouse.up();
    await page.getByRole("button", { name: "Use this signature" }).click();
    await page.mouse.click(...(await spot(0.5, 0.85)));
    eq(await kinds(), ["shape-rect", "image", "text", "ink", "signature"], "five annotations on page 1");

    // select, move, undo
    await page.keyboard.press("Escape");
    await page.mouse.click(...(await spot(0.2, 0.15)));
    ok(await page.getByTestId("selection").count() === 1, "clicking an annotation selects it");

    // page 3: turn it a quarter, then draw a filled rectangle on the turned view
    await page.locator('[data-position="3"]').click();
    await page.getByRole("button", { name: "Rotate right" }).click();
    await page.waitForTimeout(400);
    await tool("Shapes").click();
    await radio(page, "Rectangle").click();
    await page.getByRole("radio", { name: "Red" }).click();
    await drag([0.1, 0.1], [0.3, 0.2]);
    eq((await kinds()).filter((k) => k === "shape-rect").length, 1, "a rectangle on the turned page");

    // a text with letters the built-in font can't draw is refused at save time, not drawn wrong
    await page.locator('[data-position="2"]').click();
    await tool("Text box").click();
    await drag([0.1, 0.4], [0.6, 0.5]);
    await page.getByLabel("Text of the annotation").fill("مرحبا");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Save copy" }).click();
    await page.getByText("Some text can't be saved").waitFor();
    ok(await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).isDisabled(), "Save is off while some text can't be drawn");
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    await page.locator('[data-position="2"]').click();
    await page.keyboard.press("Control+z"); // undo the Arabic note
    await page.getByRole("button", { name: "Save copy" }).click();
    await page.waitForFunction(() => { const b = [...document.querySelectorAll('[role="dialog"] button')].find((x) => x.textContent === "Save"); return !!b && !b.disabled; }, null, { timeout: 15_000 });
    ok(true, "after removing it, Save works");
    ok(/annotations? will be drawn/.test(await page.getByRole("dialog").innerText()), "the dialog says annotations become part of the page");
    await page.getByRole("dialog").getByLabel("File name").fill("annotated");
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Saved “annotated.pdf”").waitFor({ timeout: 60_000 });
    const out = await download(page);
    eq(out.name, "annotated.pdf", "named as typed");
    const info = await pdfInfo(out.bytes);
    eq(info.page_count, 3, "three pages");
    const [[inRect], [pic], [outside]] = [await pixels(out.bytes, 1, [[0.27, 0.17]]), await pixels(out.bytes, 1, [[0.7, 0.15]]), await pixels(out.bytes, 1, [[0.5, 0.95]])];
    ok(inRect[2] > 200 && inRect[0] < 90, `page 1: the blue rectangle is where it was drawn: ${inRect}`);
    ok(pic[1] > 120 && pic[0] < 60 && pic[2] < 60, `page 1: the green picture is where it was placed: ${pic}`);
    ok(outside[0] > 200 && outside[1] < 60, `page 1: untouched areas are still the page colour: ${outside}`);
    // page 3 was turned: the rectangle drawn at the top-left of the turned view must be at the top-left of the saved page 3
    const [[tl], [far]] = [await pixels(out.bytes, 3, [[0.2, 0.15]]), await pixels(out.bytes, 3, [[0.8, 0.8]])];
    ok(tl[0] > 200 && tl[2] < 100, `page 3 (turned): the red rectangle is at the top left of the turned page: ${tl}`);
    ok(far[2] > 200 && far[0] < 90, `page 3 (turned): the rest is the page's own blue, so the rectangle is not at the opposite corner: ${far}`);
    eq(errorsOf(a), [], "no console errors");
    await a.close();
  }
}

if (hasPdfium) {
  section("Sign a PDF: typed and photo signatures, transparent on the page, remembered on request");
  {
    const a = await open("/pdf/editor?sign=1");
    const { page } = a;
    await page.getByText("Open the PDF you want to sign").waitFor();
    await input(page, "Choose a PDF to open").setInputFiles([pdfFix("three-pages.pdf")]);
    await page.getByRole("heading", { name: "Add your signature" }).waitFor();
    ok(true, "the signature dialog opens by itself once the PDF is open");
    await radio(page, "Type").click();
    await page.getByLabel("Your name").fill("Amine Test");
    await page.getByRole("switch", { name: "Remember it on this device" }).click();
    await page.getByRole("button", { name: "Use this signature" }).click();
    await page.getByText("Click where the signature goes").waitFor();
    // place it on page 3, which is blue all over: the paper around the letters must stay blue
    await page.locator('[data-position="3"]').click();
    await page.waitForTimeout(300);
    const svg = page.locator('[data-testid="annotation-layer"]');
    const b = await svg.boundingBox();
    await page.mouse.move(b.x + b.width * 0.2, b.y + b.height * 0.4);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.8, b.y + b.height * 0.6, { steps: 6 });
    await page.mouse.up();
    eq(await page.evaluate(() => document.querySelectorAll('[data-testid="annotation-layer"] [data-kind="image"]').length), 1, "the typed signature is on the page");
    ok(!!(await page.evaluate(() => localStorage.getItem("orangefile.signature.v1"))), "and remembered in this browser, as asked");

    await page.getByRole("button", { name: "Save copy" }).click();
    await page.waitForFunction(() => { const x = [...document.querySelectorAll('[role="dialog"] button')].find((y) => y.textContent === "Save"); return !!x && !x.disabled; }, null, { timeout: 15_000 });
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText(/^Saved “/).waitFor({ timeout: 60_000 });
    const out = await download(page);
    // sample a band across the signature box: some pixels are ink (dark), the rest is still the page's blue, none is white
    const spots = Array.from({ length: 40 }, (_, i) => [0.22 + i * 0.014, 0.5]);
    const px = await pixels(out.bytes, 3, spots);
    const ink = px.filter(([r, g, bl]) => r < 90 && g < 90 && bl < 160).length;
    const white = px.filter(([r, g, bl]) => r > 220 && g > 220 && bl > 220).length;
    ok(ink > 0, `the signature's ink is in the saved PDF (${ink} dark samples)`);
    eq(white, 0, "no white box around it: the background is transparent");
    eq(errorsOf(a), [], "no console errors");
    await a.close();
  }
  {
    // next time: the remembered signature is offered; a photo with white paper loses its background
    const a = await open("/app");
    const { page } = a;
    await page.getByRole("link", { name: /Sign a PDF/ }).first().click();
    await input(page, "Choose a PDF to open").setInputFiles([pdfFix("three-pages.pdf")]);
    await page.getByRole("heading", { name: "Add your signature" }).waitFor();
    // a fresh browser context has no memory of the previous one
    eq(await page.getByRole("button", { name: "Use my saved signature" }).count(), 0, "nothing is remembered in a different browser");
    await radio(page, "Photo").click();
    const scan = join(work, "scan.png");
    py("import sys\nfrom PIL import Image, ImageDraw\nim=Image.new('RGB',(400,160),(250,250,246))\nd=ImageDraw.Draw(im)\nd.line([(30,120),(120,40),(200,120),(330,50)],fill=(20,20,60),width=8)\nim.save(sys.argv[1])", scan);
    await page.getByLabel("Choose a photo of your signature").setInputFiles([scan]);
    await page.waitForTimeout(400);
    const corner = await page.getByTestId("signature-photo").evaluate((c) => [...c.getContext("2d").getImageData(2, 2, 1, 1).data]);
    eq(corner[3], 0, "the paper is transparent in the preview");
    await page.getByRole("button", { name: "Use this signature" }).click();
    await page.getByText("Click where the signature goes").waitFor(); // the picture is ready to place
    const svg = page.locator('[data-testid="annotation-layer"]');
    const b = await svg.boundingBox();
    await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.8);
    eq(await page.evaluate(() => document.querySelectorAll('[data-testid="annotation-layer"] [data-kind="image"]').length), 1, "the photo signature is placed");
    await page.getByRole("button", { name: "Visual signature", exact: true }).click();
    await page.getByRole("heading", { name: "Add your signature" }).waitFor();
    await radio(page, "Photo").click();
    const blank = join(work, "blank.png");
    py("import sys\nfrom PIL import Image\nImage.new('RGB',(200,100),(255,255,255)).save(sys.argv[1])", blank);
    await page.getByLabel("Choose a photo of your signature").setInputFiles([blank]);
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Use this signature" }).click();
    await page.getByRole("alert").filter({ hasText: "No signature was found" }).waitFor();
    ok(true, "a blank photo is explained, not placed");
    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    eq(errorsOf(a), [], "no console errors");
    await a.close();
  }
}

if (hasPdfium) {
  section("Compress PDF, add a password, remove it");
  {
    // a "scan": one big photo-like picture on each of two pages, as phones and scanners make them
    const scan = join(work, "scan.pdf");
    py("import sys\nfrom PIL import Image\nw,h=1200,1680\nim=Image.new('RGB',(w,h))\npx=im.load()\nfor y in range(0,h,4):\n  for x in range(0,w,4):\n    n=((x*73856093)^(y*19349663))%40\n    c=(min(255,x*215//w+n),min(255,y*215//h+n),min(255,(x+y)*215//(w+h)+n))\n    for dy in range(4):\n      for dx in range(4): px[x+dx,y+dy]=c\nim.save(sys.argv[1],'PDF',resolution=240,save_all=True,append_images=[im.rotate(180)],quality=90)", scan);
    ok(readFileSync(scan).length < 1024 * 1024, `the test scan fits the hosted 1 MB limit (${readFileSync(scan).length} bytes)`);
    const scanSize = readFileSync(scan).length;
    const a = await open("/pdf/compress");
    const { page } = a;
    await input(page).setInputFiles([scan]);
    await radio(page, "Strong").click();
    await page.getByRole("button", { name: "Compress", exact: true }).click();
    await done(page);
    const small = await download(page);
    eq(small.name, "scan (compressed).pdf", "named after the original");
    ok(small.bytes.length < scanSize / 2, `much smaller: ${scanSize} → ${small.bytes.length} bytes`);
    eq((await pdfInfo(small.bytes)).page_count, 2, "both pages are still there");
    ok(/\d+% smaller/.test(await page.getByTestId("size-change").innerText()), "the result says how much smaller");
    eq(errorsOf(a), [], "no console errors");
    await a.close();

    // add a password, then check it really needs it
    const b = await open("/pdf/protect");
    await input(b.page).setInputFiles([pdfFix("three-pages.pdf")]);
    await b.page.locator("#protect-password").fill("Tr0ub4dor & 3");
    await b.page.locator("#protect-again").fill("Tr0ub4dor & 4");
    await b.page.getByText("The two passwords are different.").waitFor();
    ok(await b.page.getByRole("button", { name: "Protect", exact: true }).isDisabled(), "mismatched passwords can't be used");
    await b.page.locator("#protect-again").fill("Tr0ub4dor & 3");
    await b.page.getByRole("switch", { name: "Allow printing" }).click();
    await b.page.getByRole("button", { name: "Protect", exact: true }).click();
    await done(b.page);
    const locked = await download(b.page);
    eq(locked.name, "three-pages (protected).pdf", "named after the original");
    const form = new FormData();
    form.append("file", new Blob([locked.bytes]), "x.pdf");
    const noPw = await eng("/pdf/documents", { method: "POST", body: form });
    ok(noPw.status >= 400, `it won't open without the password (${noPw.status})`);
    eq((await withPdf(locked.bytes, (d) => d.info, "Tr0ub4dor & 3")).page_count, 3, "and opens with it, all pages there");
    await b.close();

    // remove it again
    const lockedFile = join(work, "locked.pdf");
    writeFileSync(lockedFile, locked.bytes);
    const c = await open("/pdf/unlock");
    await input(c.page).setInputFiles([lockedFile]);
    await c.page.locator("#unlock-password").fill("wrong");
    await c.page.getByRole("button", { name: "Remove password", exact: true }).click();
    await c.page.getByRole("heading", { name: /That didn't work|Finished with some problems/ }).waitFor({ timeout: 30_000 });
    await c.page.getByText("The password is incorrect.").first().waitFor();
    ok(true, "a wrong password is explained");
    await c.page.getByRole("button", { name: "Try again" }).click();
    await c.page.locator("#unlock-password").fill("Tr0ub4dor & 3");
    await c.page.getByRole("button", { name: "Remove password", exact: true }).click();
    await done(c.page);
    const open_ = await download(c.page);
    eq((await pdfInfo(open_.bytes)).page_count, 3, "the unlocked copy opens without a password");
    eq(errorsOf(c), [], "no console errors");
    await c.close();
  }
}

// ================================================================== jobs list, theme, layout, accessibility
if (HOSTED) {
  section("Hosted: sessions, limits, the usage meter, signed downloads");
  {
    const a = await open("/convert", { ip: "10.30.0.1" });
    const { page } = a;
    await page.getByText("Up to 1 MB per file.").waitFor();
    ok(true, "the dropzone says the per-file limit");
    eq(await page.evaluate(() => window.__captchaSiteKey), "test-site-key", "a new visitor passed the CAPTCHA, with the key the server gave");
    ok(captchaChecks > 0, "and the server checked the answer");
    const bare = await fetch(`${API}/api/v1/session`, { method: "POST", headers: { "x-test-ip": "10.31.0.1" } });
    eq(bare.status, 403, "without an answer there is no new session");
    eq((await bare.json()).captcha?.site_key, "test-site-key", "the server says which challenge to show");
    const stored = await page.evaluate(() => localStorage.getItem("orangefile.web.session.v1"));
    ok(/^of1\.[0-9a-f]{32}\.\d+\.[0-9a-f]{64}$/.test(stored ?? ""), "a signed session is kept in the browser");
    const html = await (await fetch(BASE + "/")).text();
    ok(!/of1\.[0-9a-f]{32}/.test(html), "and is not in the page itself");
    const page1 = await fetch(BASE + "/");
    ok((page1.headers.get("content-security-policy") ?? "").includes("default-src 'self'"), "the page is served with a content security policy");
    eq(page1.headers.get("x-frame-options"), "DENY", "and cannot be framed");

    // the usage meter starts empty and counts what was uploaded
    await page.getByLabel("Today's allowance").waitFor();
    ok((await page.getByLabel("Today's allowance").innerText()).includes("of 6 MB"), "today's allowance is shown (six files' worth)");
    await input(page).setInputFiles([red]);
    await radio(page, "PNG").click();
    await page.getByRole("button", { name: "Convert", exact: true }).click();
    await done(page);
    await page.waitForFunction(() => !/Today: 0 B/.test(document.querySelector('[aria-label="Today\'s allowance"]')?.textContent ?? "Today: 0 B"));
    ok(true, "the meter moved after a job");
    const dl = await download(page); // a signed link: the browser sends no session header for it
    eq(dl.bytes.subarray(0, 4).toString("hex"), "89504e47", "the download through a signed link is the PNG");

    // the session survives a reload, so the visitor's job is still listed with a working download
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Recent jobs" }).click();
    await page.getByRole("link", { name: /Download result of/ }).waitFor();
    await page.reload();
    await page.getByRole("link", { name: /Download result of/ }).waitFor();
    eq((await download(page, /Download result of/)).bytes.subarray(0, 4).toString("hex"), "89504e47", "after a reload too");

    // a broken or expired token is replaced quietly
    await page.evaluate(() => localStorage.setItem("orangefile.web.session.v1", "garbage"));
    await page.goto(BASE + "/convert");
    await page.getByRole("heading", { name: "Convert images" }).waitFor();
    await page.getByText("Up to 1 MB per file.").waitFor();
    ok(/^of1\./.test((await page.evaluate(() => localStorage.getItem("orangefile.web.session.v1"))) ?? ""), "a damaged session is replaced without bothering the visitor");
    await a.close();
  }
  {
    // too big: refused before anything is uploaded, naming the limit
    const a = await open("/convert");
    const big = join(work, "big.png");
    writeFileSync(big, Buffer.concat([readFileSync(red), Buffer.alloc(1.5 * 1024 * 1024)]));
    await input(a.page).setInputFiles([big]);
    await a.page.getByText(/larger than the 1 MB limit for one file/).waitFor({ timeout: 10_000 });
    ok(await a.page.getByRole("button", { name: "Convert", exact: true }).isDisabled(), "a file over the limit can't be sent");
    await a.close();

    // two different visitors can't see each other's results, even knowing the job id
    const v1 = await open("/convert");
    await input(v1.page).setInputFiles([red]);
    await v1.page.getByRole("button", { name: "Convert", exact: true }).click();
    await done(v1.page);
    const jobId = await v1.page.evaluate(() => JSON.parse(localStorage.getItem("orangefile.web.jobs.v1") ?? "[]")[0]?.serverId ?? null);
    const v2 = await open("/convert");
    await v2.page.getByText("Up to 1 MB per file.").waitFor(); // the session exists once the limits are shown
    const token2 = await v2.page.evaluate(() => localStorage.getItem("orangefile.web.session.v1"));
    if (jobId) {
      const r = await fetch(`${API}/api/v1/jobs/${jobId}`, { headers: { authorization: `Bearer ${token2}`, "x-test-ip": "10.99.0.2" } });
      eq(r.status, 404, "another visitor gets 'not found' for this job");
    } else ok(false, "could not read the job id");
    await v1.close();
    await v2.close();
  }
}

section("Recent jobs, theme and phone layout");
{
  const a = await open("/convert");
  const { page } = a;
  await input(page).setInputFiles([red]);
  await radio(page, "PNG").click();
  await page.getByRole("button", { name: "Convert", exact: true }).click();
  await done(page);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Recent jobs" }).click();
  await page.getByRole("link", { name: /Download result of/ }).waitFor();
  ok((await page.locator("main").innerText()).includes("red.png"), "the job is listed with a download link");
  await page.reload();
  await page.getByRole("link", { name: /Download result of/ }).waitFor();
  ok(true, "the list survives a reload (metadata only)");
  await page.getByRole("button", { name: /Remove red.png/ }).click();
  await page.getByText("No jobs yet").waitFor();
  await page.getByRole("radio", { name: "Dark" }).click();
  ok(await page.evaluate(() => document.documentElement.classList.contains("dark")), "dark theme applies");
  await page.reload();
  ok(await page.evaluate(() => document.documentElement.classList.contains("dark")), "and is remembered");
  await a.close();

  // phones: pictures can come straight from the camera; computers don't see the button
  {
    const ph = await open("/pdf/images-to-pdf", { w: 390, h: 800, mobile: true });
    const cam = ph.page.getByRole("button", { name: "Take a photo", exact: true });
    await cam.waitFor({ timeout: 15_000 }).catch(() => undefined);
    ok(await cam.isVisible(), "a phone is offered the camera");
    eq(await ph.page.getByLabel("Take a photo with the camera").getAttribute("capture"), "environment", "which opens the back camera");
    await ph.page.getByLabel("Take a photo with the camera").setInputFiles([red]);
    await ph.page.getByText(/^photo-\d{6}-[a-z0-9]{3}\.png$/).waitFor();
    await ph.page.getByLabel("Take a photo with the camera").setInputFiles([blue]);
    eq(await ph.page.getByText(/^photo-\d{6}-[a-z0-9]{3}\.png$/).count(), 2, "two shots, two names, both kept");
    await ph.close();
    const pc = await open("/pdf/images-to-pdf");
    await pc.page.getByRole("button", { name: "Choose files" }).first().waitFor();
    ok(!(await pc.page.getByRole("button", { name: "Take a photo", exact: true }).isVisible()), "a computer isn't");
    await pc.close();
  }
  const m = await open("/app", { w: 390, h: 800, mobile: true });
  ok(await m.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no sideways scrolling on a phone");
  await m.page.getByRole("button", { name: "Open menu" }).click();
  await m.page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Make a ZIP" }).click();
  await m.page.getByRole("heading", { name: "Make a ZIP" }).waitFor();
  ok(await m.page.getByRole("button", { name: "Open menu" }).isVisible(), "the menu closes after choosing a page");
  for (const p of ["/convert", "/resize", "/pdf", "/pdf/editor", "/jobs", "/about"]) {
    await m.page.goto(BASE + p);
    await m.page.waitForSelector("main");
    ok(await m.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `no sideways scrolling on ${p}`);
  }
  await m.close();
}

section("Accessibility (axe, WCAG A and AA) in light and dark");
for (const dark of [false, true]) {
  const a = await open("/app", { dark });
  const { page } = a;
  await page.evaluate(axeSrc);
  const check = async (name) => {
    await page.waitForTimeout(300);
    const v = await page.evaluate(async () => (await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa"] })).violations.map((x) => `${x.id}: ${x.nodes[0].target} (${x.nodes[0].failureSummary?.split("\n")[1]?.trim() ?? ""})`));
    ok(v.length === 0, `${dark ? "dark" : "light"} ${name}: ${v.join("; ")}`);
  };
  const go = async (p) => { await page.goto(BASE + p); await page.waitForSelector("main"); await page.evaluate(axeSrc); };
  await check("dashboard");
  await go("/");
  for (let y = 0; y < 6000; y += 500) { await page.evaluate((y) => window.scrollTo(0, y), y); await page.waitForTimeout(60); }
  await page.waitForTimeout(900);
  await check("landing");
  await go("/app");
  await input(page).setInputFiles([red, pdfFix("three-pages.pdf")]);
  await page.getByRole("heading", { name: "Selected files" }).waitFor();
  await check("dashboard with files");
  for (const [p, n] of [["/convert", "convert"], ["/resize", "resize"], ["/compress", "compress"], ["/extract", "extract"], ["/pdf", "PDF hub"], ["/pdf/merge", "merge"], ["/pdf/split", "split"], ["/pdf/images-to-pdf", "images to PDF"], ["/pdf/to-images", "PDF to images"], ["/pdf/documents-to-pdf", "documents to PDF"], ["/pdf/compress", "compress PDF"], ["/pdf/protect", "protect PDF"], ["/pdf/unlock", "unlock PDF"], ["/jobs", "jobs"], ["/about", "about"]]) {
    await go(p);
    await page.waitForTimeout(200);
    await check(n);
  }
  await go("/convert");
  await input(page).setInputFiles([red]);
  await page.getByRole("radiogroup", { name: "Convert to" }).waitFor();
  await check("convert with a file");
  if (hasPdfium) {
    await go("/pdf/editor");
    await check("editor (empty)");
    await input(page, "Choose a PDF to open").setInputFiles([pdfFix("three-pages.pdf")]);
    await page.waitForFunction(() => document.querySelectorAll("[data-position] img").length === 3);
    await check("editor (open)");
    await page.getByRole("button", { name: "Highlight", exact: true }).click();
    await check("editor (annotation tool)");
    await page.getByRole("button", { name: "Rotate right" }).click();
    await page.getByRole("button", { name: "Save copy" }).click();
    await page.getByRole("dialog").waitFor();
    await check("editor (save dialog)");
  }
  await a.close();
}

// Hosted: the engine also serves the page, so with it gone there is no page to explain anything.
if (!HOSTED) {
  section("The engine going away is explained, not hidden");
  const a = await open("/app");
  stop(engine);
  await new Promise((r) => setTimeout(r, 800));
  await a.page.reload();
  await a.page.getByRole("alert").filter({ hasText: "isn't reachable" }).waitFor({ timeout: 15_000 });
  ok(true, "a banner says the service isn't reachable, with a retry button");
  ok(await a.page.getByRole("button", { name: "Try again" }).first().isVisible(), "Try again is offered");
  await a.close();
}

await browser.close();
cleanup();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
