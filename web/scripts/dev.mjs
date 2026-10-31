// One command to run the web app against the real engine:  npm run dev:all
//   1. starts the Rust API (crates/file-api) on 127.0.0.1:8787 with a fresh random token,
//   2. waits until it answers,
//   3. starts the Vite dev server, whose proxy adds that token to /api requests (the browser never sees it).
// It uses the PDFium and LibreOffice that `npm run get-pdfium` / `npm run get-libreoffice` put in src-tauri/resources, if present;
// a LibreOffice installed on the computer is found on its own.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const web = fileURLToPath(new URL("..", import.meta.url));
const root = resolve(web, "..");
const shell = process.platform === "win32";
const port = process.env.ORANGEFILE_API_PORT || "8787";
const token = randomBytes(32).toString("hex");
const dataDir = mkdtempSync(join(tmpdir(), "orangefile-web-"));

const env = { ...process.env, FILE_API_TOKEN: token, FILE_API_BIND: `127.0.0.1:${port}`, FILE_API_DATA_DIR: dataDir, RUST_LOG: process.env.RUST_LOG || "warn" };
const pdfium = resolve(root, "src-tauri/resources/pdfium");
const office = resolve(root, "src-tauri/resources/libreoffice");
if (existsSync(pdfium)) env.ORANGEFILE_PDFIUM ??= pdfium;
else console.warn("dev: no PDFium found. Run `npm run get-pdfium` in the project root, or PDF tools will be reported as unavailable.");
if (existsSync(office)) env.ORANGEFILE_LIBREOFFICE ??= office;

const children = [];
const posix = process.platform !== "win32";
/** Stop a child and everything it started (npx and cargo each start another process). */
const kill = (c) => {
  try {
    if (posix) process.kill(-c.pid);
    else spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    /* already gone */
  }
};
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const c of children) kill(c);
  process.exit(code);
};
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

console.log("dev: starting the engine (the first build of the Rust code takes a while)…");
const api = spawn("cargo", ["run", "-p", "file-api"], { cwd: root, env, shell, detached: posix, stdio: ["ignore", "inherit", "inherit"] });
children.push(api);
api.on("exit", (code) => {
  console.error(`dev: the engine stopped (${code}).`);
  stop(code ?? 1);
});

const up = async () => {
  for (let i = 0; i < 3600; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
};
if (!(await up())) {
  console.error("dev: the engine did not start in time.");
  stop(1);
}
console.log(`dev: engine ready on 127.0.0.1:${port}. Starting the web app…`);
const vite = spawn("npx", ["vite", "--host", "127.0.0.1"], { cwd: web, env: { ...env, ORANGEFILE_API_URL: `http://127.0.0.1:${port}`, ORANGEFILE_API_TOKEN: token }, shell, detached: posix, stdio: "inherit" });
children.push(vite);
vite.on("exit", (code) => stop(code ?? 0));
