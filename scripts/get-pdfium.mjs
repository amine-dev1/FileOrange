// Fetches the PDFium library for this platform into src-tauri/resources/pdfium/.
//
//   npm run get-pdfium            download (skipped if already present and verified)
//   npm run get-pdfium -- --force download again
//
// PDFium is built by the pdfium-binaries project and republished unchanged inside the
// pypdfium2 wheels on PyPI. Two SHA-256 pins protect the download: the wheel as a whole, and
// the library inside it. Anything that doesn't match is deleted and the script fails; an
// unverified library is never installed. To move to a new PDFium, change the table below
// after checking the new hashes (PyPI shows each wheel's SHA-256).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../src-tauri/resources/pdfium/", import.meta.url));
const PYPDFIUM2 = "5.14.0";
const PINS = {
  "win32-x64": {
    url: "https://files.pythonhosted.org/packages/00/dc/ca7874924c9cfd701ad53f89529968523790e70473e0b71e834668316148/pypdfium2-5.14.0-py3-none-win_amd64.whl",
    wheelSha256: "149fd5c6397b8df8bf7911a93506eff0be874f877afe7ac936cf5d37d21a6a06",
    library: "pdfium.dll",
    librarySha256: "69f1e860f6742fbaafcc4db80e785eec9a4ee0da36ea6d1dc0867ea0f18baea6",
    licenseDir: "windows_x64",
  },
  "linux-x64": {
    url: "https://files.pythonhosted.org/packages/4f/a3/c9cc797fc8bdfb8f37b9b0f8b9d02a5fc196b2015f408d53624cab5b0519/pypdfium2-5.14.0-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl",
    wheelSha256: "11f281613fa22313d9c7ab89947665e84eccf8ebe40e1198a84a88352305648d",
    library: "libpdfium.so",
    librarySha256: "fd4de9f91f183476d04b1bc3fd17dacd95aba349c55d2c376512d95e082b441e",
    licenseDir: "linux_x64",
  },
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const fail = (msg) => {
  console.error(`get-pdfium: ${msg}`);
  process.exit(1);
};

/** Minimal reader for a standard .zip (a wheel): name -> bytes, deflate or stored entries only. */
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad zip directory");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.set(name, () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + csize);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) return inflateRawSync(raw);
      throw new Error(`unsupported zip method ${method} for ${name}`);
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const key = `${process.platform}-${process.arch}`;
const pin = PINS[key];
if (!pin) fail(`no pinned PDFium for ${key}. PDF viewing will be reported as unavailable on this platform.`);

const have = `${OUT}${pin.library}`;
if (!process.argv.includes("--force") && existsSync(have) && sha256(readFileSync(have)) === pin.librarySha256) {
  console.log(`get-pdfium: ${pin.library} is already in place and verified.`);
  process.exit(0);
}

console.log(`get-pdfium: downloading PDFium (pypdfium2 ${PYPDFIUM2}, ${key})…`);
const res = await fetch(pin.url).catch((e) => fail(`download failed: ${e.message}`));
if (!res.ok) fail(`download failed: HTTP ${res.status}`);
const wheel = Buffer.from(await res.arrayBuffer());
if (sha256(wheel) !== pin.wheelSha256) fail("the downloaded file does not match the pinned SHA-256. Nothing was installed.");

const zip = readZip(wheel);
const lib = zip.get(`pypdfium2_raw/${pin.library}`)?.();
if (!lib) fail(`${pin.library} is not in the wheel.`);
if (sha256(lib) !== pin.librarySha256) fail("the library inside the wheel does not match its pinned SHA-256. Nothing was installed.");

rmSync(OUT + "licenses", { recursive: true, force: true });
mkdirSync(OUT + "licenses", { recursive: true });
writeFileSync(have, lib);
let licences = 0;
for (const [name, get] of zip) {
  const m = new RegExp(`^pypdfium2-[^/]+\\.dist-info/licenses/data/${pin.licenseDir}/BUILD_LICENSES/([^/]+\\.txt)$`).exec(name);
  if (m) { writeFileSync(`${OUT}licenses/${m[1]}`, get()); licences++; }
}
if (licences === 0) fail("no licence files found in the wheel; refusing to install without them.");
const v = JSON.parse(zip.get("pypdfium2_raw/version.json")().toString());
writeFileSync(`${OUT}VERSION`, `PDFium ${v.major}.${v.minor}.${v.build} (pdfium-binaries, via pypdfium2 ${PYPDFIUM2})\n`);
console.log(`get-pdfium: installed ${pin.library}, ${licences} licence files, ${readdirSync(OUT).length} entries in ${OUT}`);
