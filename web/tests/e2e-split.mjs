// The deployment shape "site on Netlify, engine on Fly.io": the built site is served by a plain static server on one origin,
// the hosted engine runs on another, and nothing proxies between them. Checks that a browser really can use the engine across
// origins: the session, uploads with progress, signed downloads, page pictures, and the headers Netlify will apply.
//   npm run test:e2e:split      (needs target/debug/file-api, CHROMIUM_PATH, ORANGEFILE_PDFIUM like the other e2e suites)
import { chromium } from "playwright-core";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const web = fileURLToPath(new URL("..", import.meta.url));
const root = resolve(web, "..");
const work = mkdtempSync(join(tmpdir(), "of-split-e2e-"));
let failures = 0, checks = 0;
const ok = (c, m) => { checks++; if (!c) { failures++; console.log("  FAIL", m); } };

const API_PORT = 8796, SITE_PORT = 5198;
const API = `http://127.0.0.1:${API_PORT}`, SITE = `http://localhost:${SITE_PORT}`; // different host name => a different origin
const bin = join(root, "target/debug", process.platform === "win32" ? "file-api.exe" : "file-api");
if (!existsSync(bin)) throw new Error("build the engine first: cargo build -p file-api");

// the site, built for this engine
const dist = join(work, "site");
execFileSync("npx", ["vite", "build", "--outDir", dist, "--emptyOutDir"], { cwd: web, env: { ...process.env, VITE_API_ORIGIN: API }, stdio: "ignore", shell: process.platform === "win32" });
const headersFile = readFileSync(join(dist, "_headers"), "utf8");
const siteHeaders = Object.fromEntries(headersFile.split("\n").slice(1).map((l) => l.trim()).filter(Boolean).map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
const redirects = readFileSync(join(dist, "_redirects"), "utf8").trim();
ok(redirects.startsWith("/*") && redirects.endsWith("200"), "the single-page-app redirect is published");
ok(siteHeaders["content-security-policy"]?.includes(`connect-src 'self' ${API}`), "the site's policy allows the engine's address, and only that");

// a static host like Netlify: files, then the redirect rule, with the generated headers on everything
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const site = createServer((req, res) => {
  const path = new URL(req.url, SITE).pathname;
  let file = join(dist, path);
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) file = join(dist, "index.html");
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", ...siteHeaders });
  res.end(readFileSync(file));
}).listen(SITE_PORT, "127.0.0.1");

const env = { ...process.env, FILE_API_MODE: "hosted", FILE_API_BIND: `127.0.0.1:${API_PORT}`, FILE_API_DATA_DIR: join(work, "data"), FILE_API_SESSION_SECRET: randomBytes(32).toString("hex"), FILE_API_ALLOWED_HOSTS: "127.0.0.1", FILE_API_ALLOWED_ORIGINS: SITE, FILE_API_MAX_FILE_MB: "50", RUST_LOG: "warn" };
const pdfium = resolve(root, "src-tauri/resources/pdfium");
if (!env.ORANGEFILE_PDFIUM && existsSync(pdfium)) env.ORANGEFILE_PDFIUM = pdfium;
const detached = process.platform !== "win32";
const engine = spawn(bin, [], { env, stdio: "ignore", detached });
const cleanup = () => { try { detached ? process.kill(-engine.pid) : engine.kill(); } catch {} site.close(); };
process.on("exit", cleanup);
for (let i = 0; i < 120; i++) { try { if ((await fetch(`${API}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(file, w, h) {
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [255, 0, 0]).flat())]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  require_write(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))), chunk("IEND", Buffer.alloc(0))]));
  return file;
}
import { writeFileSync as require_write } from "node:fs";
const red = png(join(work, "red.png"), 200, 100);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] } : { channel: "msedge" });
const ctx = await browser.newContext({ acceptDownloads: true });
const page = await ctx.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
const toApi = [];
page.on("request", (r) => { if (r.url().startsWith(API)) toApi.push(r.url()); });

console.log("\nSite and engine on different origins");
const first = await page.goto(`${SITE}/convert`);
await page.waitForSelector("main");
ok(first.headers()["content-security-policy"]?.includes("script-src 'self'"), "the site carries its security headers");
await page.getByText("Up to 50 MB per file.").waitFor({ timeout: 20_000 });
ok(true, "the app found the engine, got a session and read its limits across origins");
ok(toApi.some((u) => u.endsWith("/api/v1/session")) && !toApi.some((u) => u.startsWith(SITE)), "requests go to the engine's address");
const stored = await page.evaluate(() => localStorage.getItem("orangefile.web.session.v1"));
ok(/^of1\./.test(stored ?? ""), "the session is kept in the browser");

// upload, run, download through a signed link on the engine's origin
await page.locator("input[type=file]").first().setInputFiles([red]);
await page.getByRole("radio", { name: "PNG", exact: true }).click();
await page.getByRole("button", { name: "Convert", exact: true }).click();
await page.getByRole("heading", { name: /All done|Finished with some problems/ }).waitFor({ timeout: 60_000 });
const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: /^Download/ }).first().click()]);
const f = join(work, "out-" + dl.suggestedFilename());
await dl.saveAs(f);
ok(readFileSync(f).subarray(0, 4).toString("hex") === "89504e47", `the download is a PNG (${dl.suggestedFilename()})`);
ok(dl.url().startsWith(`${API}/api/v1/dl/`), "and came from a signed link on the engine");
await page.getByLabel("Today's allowance").waitFor();
ok(true, "the usage meter reads /me across origins");

// the PDF editor: page pictures are fetched with the session and shown from blobs
if (env.ORANGEFILE_PDFIUM) {
  await page.goto(`${SITE}/pdf/editor`);
  await page.locator('input[type=file][aria-label="Choose a PDF to open"]').setInputFiles([join(root, "crates/file-core/tests/fixtures/pdf/three-pages.pdf")]);
  await page.waitForSelector('[data-position="3"]');
  await page.waitForFunction(() => document.querySelectorAll("[data-position] img").length === 3);
  ok(await page.locator('[aria-label="Page preview"] img').first().evaluate((i) => i.naturalWidth > 0), "PDF page pictures load across origins");
}

// the engine refuses a page from an origin it wasn't told about
const other = await browser.newPage();
await other.goto(`http://127.0.0.1:${SITE_PORT}/convert`);
await other.waitForSelector("main");
await other.waitForTimeout(1500);
ok(!(await other.getByText("Up to 50 MB per file.").isVisible().catch(() => false)), "an unlisted origin is not served by the engine");

ok(problems.filter((p) => !p.includes("127.0.0.1:" + SITE_PORT) && !/Failed to load resource|CORS|blocked|403/i.test(p)).length === 0, `no unexpected console errors: ${JSON.stringify(problems.slice(0, 3))}`);
await browser.close();
cleanup();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
