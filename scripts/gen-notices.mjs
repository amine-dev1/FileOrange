// Collects what ships inside OrangeFile (Rust crates, npm packages, native libraries)
// into src/generated/notices.json, which the Third-party notices screen shows.
// Run with:  npm run notices
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const run = (cmd, args, extra = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, ...extra });
// On Windows npm is npm.cmd, which Node will not start directly: run npm's own script with node when we were started by npm,
// and otherwise go through the shell.
const npm = (args) =>
  process.env.npm_execpath?.endsWith(".js")
    ? run(process.execPath, [process.env.npm_execpath, ...args])
    : run("npm", args, { shell: process.platform === "win32" });

// ---- Rust: normal (shipped) dependencies of the desktop app, not dev or build tools
const meta = JSON.parse(run("cargo", ["metadata", "--format-version", "1", "--locked"]));
const byId = new Map(meta.packages.map((p) => [p.id, p]));
const members = new Set(meta.workspace_members);
const root = meta.packages.find((p) => p.name === "file-tool");
const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
const seen = new Set();
const queue = [root.id];
while (queue.length) {
  const id = queue.pop();
  if (seen.has(id)) continue;
  seen.add(id);
  for (const d of nodes.get(id)?.deps ?? []) {
    if (d.dep_kinds.some((k) => k.kind === null)) queue.push(d.pkg);
  }
}
const components = [...seen]
  .filter((id) => !members.has(id))
  .map((id) => byId.get(id))
  .map((p) => ({ name: p.name, version: p.version, license: p.license ?? "see source", source: "Rust crate", homepage: p.repository ?? p.homepage ?? null }));

// ---- npm: production dependencies only
const tree = JSON.parse(npm(["ls", "--omit=dev", "--all", "--json"]));
const npmSeen = new Map();
(function walk(deps) {
  for (const [name, info] of Object.entries(deps ?? {})) {
    if (!npmSeen.has(`${name}@${info.version}`)) {
      npmSeen.set(`${name}@${info.version}`, name);
      walk(info.dependencies);
    }
  }
})(tree.dependencies);
for (const [key, name] of npmSeen) {
  const pkgPath = join("node_modules", name, "package.json");
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const license = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? "see source");
  const homepage = typeof pkg.repository === "string" ? pkg.repository : (pkg.repository?.url ?? pkg.homepage ?? null);
  components.push({ name, version: key.slice(name.length + 1), license, source: "npm package", homepage });
}

// ---- native code compiled into the app (not visible to cargo metadata as a licence)
const texts = [];
const webp = meta.packages.find((p) => p.name === "libwebp-sys");
if (webp) {
  const file = join(dirname(webp.manifest_path), "vendor", "COPYING");
  components.push({ name: "libwebp (C library, built in via libwebp-sys)", version: "bundled with libwebp-sys " + webp.version, license: "BSD-3-Clause", source: "Native library", homepage: "https://chromium.googlesource.com/webm/libwebp" });
  texts.push({ name: "libwebp", license: "BSD-3-Clause", text: existsSync(file) ? readFileSync(file, "utf8").trim() : "License text not found at build time." });
}
// PDFium ships as a separate library (src-tauri/resources/pdfium, fetched by `npm run get-pdfium`).
// Its own licence files travel with it; they are quoted here when the library has been fetched.
{
  const dir = "src-tauri/resources/pdfium/";
  const ver = existsSync(dir + "VERSION") ? readFileSync(dir + "VERSION", "utf8").trim() : "not fetched yet";
  components.push({ name: "PDFium (PDF rendering library, separate DLL)", version: ver, license: "BSD-3-Clause AND Apache-2.0", source: "Native library", homepage: "https://pdfium.googlesource.com/pdfium/" });
  const licDir = dir + "licenses/";
  if (existsSync(licDir)) {
    for (const f of ["pdfium.txt", "pdfium-binaries.txt"]) {
      if (existsSync(licDir + f)) texts.push({ name: f === "pdfium.txt" ? "PDFium" : "pdfium-binaries (build of PDFium)", license: "see text", text: readFileSync(licDir + f, "utf8").trim() });
    }
    components.push({ name: "PDFium's own bundled libraries (FreeType, ICU, zlib, libpng, OpenJPEG, LittleCMS, AGG, Abseil, and others)", version: ver, license: "Each under its own licence, in the licenses folder next to the DLL", source: "Native library", homepage: null });
  }
}
// LibreOffice ships as a separate folder in the Windows installer (src-tauri/resources/libreoffice, fetched by
// `npm run get-libreoffice`), and is run as its own program. It is listed whether or not it has been fetched yet.
{
  const dir = "src-tauri/resources/libreoffice/";
  const ver = existsSync(dir + "VERSION") ? readFileSync(dir + "VERSION", "utf8").trim() : "not fetched yet (Windows installer builds only)";
  components.push({ name: "LibreOffice (converts Word, Excel and PowerPoint files to PDF; separate program)", version: ver, license: "MPL-2.0, together with the licences of the libraries it contains", source: "Bundled program", homepage: "https://www.libreoffice.org/" });
  const source = dir + "licenses/SOURCE.txt";
  texts.push({
    name: "LibreOffice",
    license: "MPL-2.0",
    text: existsSync(source)
      ? readFileSync(source, "utf8").trim()
      : "OrangeFile's Windows installer includes an unmodified LibreOffice from The Document Foundation. Source code: https://download.documentfoundation.org/libreoffice/src/ and https://git.libreoffice.org/core. LibreOffice is licensed under the Mozilla Public License 2.0 together with the licences of the libraries it contains; its full licence files are installed with it in the libreoffice/licenses folder.",
  });
}
components.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync("src/generated/notices.json", JSON.stringify({ components, texts }, null, 1) + "\n");
console.log(`${components.length} components, ${texts.length} bundled license text(s) -> src/generated/notices.json`);
