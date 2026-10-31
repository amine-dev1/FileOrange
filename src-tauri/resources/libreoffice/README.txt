This folder holds the LibreOffice that OrangeFile ships for Word/Excel/PowerPoint to PDF conversion.

It is filled by `npm run get:libreoffice` (see scripts/get-libreoffice.mjs), which downloads the official
Windows installer, checks it against the SHA-256 pinned in scripts/libreoffice-pin.json, and unpacks the
program files here. The release build (`npm run build:installer`) runs it for you.

Until then this folder is empty on purpose: OrangeFile falls back to a LibreOffice installed on the computer,
and the Office conversion screen says so.
