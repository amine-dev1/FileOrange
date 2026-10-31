# Building the Windows installer (with LibreOffice inside)

One-time setup, then one command.

## 1. Pin the LibreOffice installer (once)

OrangeFile refuses to bundle a LibreOffice it cannot verify. You choose the exact file by pinning its SHA-256.

1. Open `scripts/libreoffice-pin.json`. It names LibreOffice **24.8.4** (`version`, `url`). Check the URL works in a browser; if it does not,
   pick the Windows x64 `.msi` you want from https://www.libreoffice.org/download/ (or the archive) and put its address in `url`.
2. Download it yourself, then run:  
   `npm run get-libreoffice -- --print-hash --file C:\path\to\LibreOffice_24.8.4.2_Win_x86-64.msi`
3. Compare the printed SHA-256 with the "Checksum" on libreoffice.org for that file. If they match, paste it into `"sha256"` in `scripts/libreoffice-pin.json`.

(Shortcut for a first try only: `npm run get-libreoffice -- --trust-published-hash` accepts the `.sha256` published beside the installer on the same server.
It prints a warning because that only catches a damaged download. Pin the hash afterwards.)

## 2. Build

```
npm install
npm run build:installer
```

This fetches PDFium (pinned), unpacks LibreOffice (pinned, checked, started once to prove it runs), regenerates the third-party notices and runs `tauri build`.
The installer is in `src-tauri\target\release\bundle\`. Expect it to be roughly 350 MB larger than before, and about 1 GB installed.
You need roughly 5 GB of free disk space and should keep the project out of OneDrive.

## 3. Check it on a clean Windows machine

* Settings -> Supported formats: engine "Office documents (LibreOffice)" should say **bundled**.
* Convert a .docx, .xlsx and .pptx to PDF; open the results.
* Disconnect the network, convert again (nothing should need the internet).
* PDF Tools -> Open PDF Editor: add a highlight, a text box, a pen stroke, a picture and a signature, Save Copy, open the copy in another viewer.
* Cancel a large Office conversion mid-way: no `soffice.exe` should stay in Task Manager.

If a step fails, please send the message shown in the app and, for the installer, the output of `npm run build:installer`.
