// Puts a LibreOffice into src-tauri/resources/libreoffice/ so the installer ships with it.
// OrangeFile uses it (headless, in a locked-down process) to turn Word, Excel and PowerPoint files into PDFs.
//
//   npm run get-libreoffice                       download the pinned installer, verify, unpack
//   npm run get-libreoffice -- --file X.msi       use an installer you downloaded yourself
//   npm run get-libreoffice -- --from "C:\\Program Files\\LibreOffice"
//                                                 copy a LibreOffice you installed normally on this computer
//                                                 (use this if unpacking the installer fails on your machine)
//   npm run get-libreoffice -- --print-hash       download (or --file) and print its SHA-256, install nothing
//   npm run get-libreoffice -- --trust-published-hash
//                                                 first-time setup only: accept the .sha256 file published next
//                                                 to the installer. Weaker than a pin: see the warning it prints.
//   npm run get-libreoffice -- --force            unpack again even if a verified copy is already in place
//
// Safety rules, same spirit as get-pdfium:
//  * Nothing is unpacked unless the installer's SHA-256 equals the one pinned in scripts/libreoffice-pin.json.
//  * With no pin the script refuses (unless --trust-published-hash is given on purpose).
//  * Windows only: the installer is unpacked with `msiexec /a` (an administrative install into a folder;
//    nothing is installed on this computer). On other systems the script says so and does nothing, and the app
//    uses a LibreOffice installed on the computer instead.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const OUT = fileURLToPath(new URL("../src-tauri/resources/libreoffice/", import.meta.url));
const CACHE = fileURLToPath(new URL("./.cache/", import.meta.url));
const PIN_FILE = fileURLToPath(new URL("./libreoffice-pin.json", import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);

const fail = (msg) => {
  console.error(`get-libreoffice: ${msg}`);
  process.exit(1);
};
const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const pin = JSON.parse(readFileSync(PIN_FILE, "utf8"));
const pinned = (pin.sha256 ?? "").trim().toLowerCase();
if (pinned && !/^[0-9a-f]{64}$/.test(pinned)) fail(`scripts/libreoffice-pin.json: sha256 must be 64 hex digits.`);

/** Folders that are not needed to convert documents. Deliberately short: extend it only after testing a conversion without them. */
const TRIM = ["share/gallery", "share/template", "share/wizards", "help"];

if (process.platform !== "win32" && !flag("--print-hash")) {
  console.log("get-libreoffice: skipped. The bundled LibreOffice is for the Windows installer; on this system OrangeFile uses a LibreOffice that is installed on the computer (it is reported as “installed”).");
  process.exit(0);
}

const marker = join(OUT, "BUNDLED.json");
if (!flag("--force") && !flag("--print-hash") && !value("--from") && existsSync(marker) && existsSync(join(OUT, "program", "soffice.exe"))) {
  const have = JSON.parse(readFileSync(marker, "utf8"));
  if (have.installedCopy || (pinned && have.sha256 === pinned)) {
    console.log(`get-libreoffice: LibreOffice ${have.version} is already in place${have.installedCopy ? " (copied from an installed copy)" : " and verified"}.`);
    process.exit(0);
  }
}

async function obtain() {
  const given = value("--file");
  if (given) {
    if (!existsSync(given)) fail(`${given} does not exist.`);
    return resolve(given);
  }
  mkdirSync(CACHE, { recursive: true });
  const dest = join(CACHE, pin.url.split("/").pop());
  if (existsSync(dest) && pinned && sha256File(dest) === pinned) {
    console.log("get-libreoffice: using the installer already downloaded to scripts/.cache.");
    return dest;
  }
  console.log(`get-libreoffice: downloading ${pin.url}\n  (this is a large file, roughly 350 MB)`);
  const res = await fetch(pin.url).catch((e) => fail(`download failed: ${e.message}`));
  if (!res.ok || !res.body) fail(`download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  return dest;
}

const from = value("--from");
const msi = from ? undefined : await obtain();
const actual = from ? "an installed copy of LibreOffice (not hash-verified)" : sha256File(msi);

if (flag("--print-hash") && !from) {
  console.log(`${actual}  ${msi}\nPut this in scripts/libreoffice-pin.json as "sha256" after checking it against the value on The Document Foundation's download page.`);
  process.exit(0);
}

if (from) {
  if (!existsSync(join(resolve(from), "program", "soffice.exe"))) fail(`${from} has no program\\soffice.exe. Pass the folder LibreOffice is installed in, e.g. "C:\\Program Files\\LibreOffice".`);
  console.log(`get-libreoffice: copying the LibreOffice installed in ${resolve(from)}`);
} else if (pinned) {
  if (actual !== pinned) {
    if (!value("--file")) rmSync(msi, { force: true });
    fail(`the installer does not match the pinned SHA-256.\n  expected ${pinned}\n  got      ${actual}\nNothing was unpacked.`);
  }
} else if (flag("--trust-published-hash")) {
  const res = await fetch(`${pin.url}.sha256`).catch((e) => fail(`could not fetch the published hash: ${e.message}`));
  if (!res.ok) fail(`could not fetch the published hash: HTTP ${res.status}`);
  const published = ((await res.text()).trim().split(/\s+/)[0] ?? "").toLowerCase();
  if (published !== actual) fail(`the installer does not match the hash published next to it.\n  published ${published}\n  got       ${actual}\nNothing was unpacked.`);
  console.warn(
    "\nget-libreoffice: WARNING. This installer matched the hash published on the SAME server it came from.\n" +
      "That protects against a damaged download, not against a compromised server. Check the hash below against\n" +
      "The Document Foundation's website, then pin it so every future build is checked against a value you chose:\n" +
      `  "sha256": "${actual}"   (scripts/libreoffice-pin.json)\n`,
  );
} else {
  fail(
    "scripts/libreoffice-pin.json has no sha256, so nothing will be unpacked.\n" +
      "  1. Download the installer (or run: npm run get-libreoffice -- --print-hash).\n" +
      "  2. Compare its SHA-256 with the one on https://www.libreoffice.org/download/ (the “Checksum” link).\n" +
      '  3. Put it in scripts/libreoffice-pin.json as "sha256" and run this again.',
  );
}

// ---- unpack (administrative install: copies the files, installs nothing)
const work = mkdtempSync(join(tmpdir(), "orangefile-lo-"));
try {
  if (!from) {
    console.log("get-libreoffice: unpacking (this takes a minute)…");
    const r = spawnSync("msiexec", ["/a", resolve(msi), "/qn", `TARGETDIR=${work}`], { stdio: "inherit", windowsHide: true });
    if (r.status !== 0) fail(`msiexec failed with exit code ${r.status}. Install LibreOffice normally and run: npm run get-libreoffice -- --from "C:\\Program Files\\LibreOffice"`);
  }
  const root = (from ? [resolve(from)] : [join(work, "LibreOffice"), join(work, "Program Files", "LibreOffice"), work]).find((p) => existsSync(join(p, "program", "soffice.exe")));
  if (!root) fail("the unpacked installer has no program/soffice.exe.");

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  for (const part of ["program", "share", "presets"]) if (existsSync(join(root, part))) cpSync(join(root, part), join(OUT, part), { recursive: true });
  for (const t of TRIM) rmSync(join(OUT, t), { recursive: true, force: true });

  // Licences and where the source is, which the MPL asks us to make clear.
  mkdirSync(join(OUT, "licenses"), { recursive: true });
  for (const dir of [root, join(root, "readmes")]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (/^(license|notice|readme)/i.test(f) && statSync(join(dir, f)).isFile()) cpSync(join(dir, f), join(OUT, "licenses", f));
  }
  writeFileSync(
    join(OUT, "licenses", "SOURCE.txt"),
    `This is an unmodified build of LibreOffice ${pin.version} from The Document Foundation.\n` +
      `Installer: ${pin.url}\nSHA-256: ${actual}\n` +
      "Source code: https://download.documentfoundation.org/libreoffice/src/ and https://git.libreoffice.org/core\n" +
      "LibreOffice is licensed under the Mozilla Public License 2.0 together with the licences of the libraries it contains.\n",
  );

  // It must start before we ship it.
  // soffice.com is the console launcher: it answers `--version` on the command line, soffice.exe (the window program) may not.
  const exe = existsSync(join(OUT, "program", "soffice.com")) ? join(OUT, "program", "soffice.com") : join(OUT, "program", "soffice.exe");
  const probe = spawnSync(exe, ["--headless", "--version"], { encoding: "utf8", timeout: 120_000, windowsHide: true });
  const version = (probe.stdout ?? "").split("\n").find((l) => /libreoffice/i.test(l))?.trim();
  if (!version) fail(`the unpacked LibreOffice did not start (${probe.error?.message ?? `exit ${probe.status}`}). It was not installed.`);

  writeFileSync(join(OUT, "VERSION"), `${version}\n`);
  writeFileSync(marker, JSON.stringify({ version, sha256: actual, url: pin.url, installedCopy: Boolean(from) }, null, 2) + "\n");
  console.log(`get-libreoffice: installed ${version} into ${OUT}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
