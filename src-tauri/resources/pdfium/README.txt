This folder is bundled into the installer as "pdfium".

The PDFium library (pdfium.dll on Windows) is not kept in the repository. `npm run get-pdfium`
downloads it, checks it against pinned SHA-256 hashes and puts it here together with its
licence files. `npm run tauri build` does this for you. Without the library the app still
runs; PDF viewing is then reported as unavailable.
