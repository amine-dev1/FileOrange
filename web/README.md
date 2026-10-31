# OrangeFile web

The browser version of OrangeFile: React 18, TypeScript, Vite and Tailwind CSS 4. It uses the same engine API as the desktop app
(`crates/file-api`, which wraps `crates/file-core`), so every tool, option and limit comes from the engine's capability report.

## Run it

From the project root, once: `npm install`, then `npm run get-pdfium` (PDF tools need the PDFium library).
Then, in this folder:

```
npm install
npm run dev:all
```

This starts the Rust engine on `127.0.0.1:8787` (the first Rust build takes a while) and the web app on <http://127.0.0.1:5173>.
Office conversion uses `src-tauri/resources/libreoffice` if you have run `npm run get-libreoffice`, otherwise a LibreOffice installed on the computer.

Already running the engine yourself? Set `ORANGEFILE_API_URL` and `ORANGEFILE_API_TOKEN` (see `.env.example`) and run `npm run dev`.

## Scripts

| Command | What |
|---|---|
| `npm run dev:all` | engine + web app together |
| `npm run build` | type-check and build to `dist/` |
| `npm run typecheck`, `npm run lint` | checks |
| `npm run test:unit` | pure logic (page plan, zoom, annotation model, names) |
| `npm run test:e2e` | real browser against the real engine; needs `cargo build -p file-api`, `CHROMIUM_PATH` (or Edge on Windows) and `ORANGEFILE_PDFIUM` |
| `npm run test:e2e:hosted` | the same, against a hosted-mode server (sessions, limits, signed downloads) |

## How it talks to the backend

The app calls same-origin `/api/v1/...` and holds **no secret in its code**. Two situations:

* **Development / desktop-style engine:** the Vite proxy (`vite.config.ts`) adds the engine's token and drops the `Origin` header. `POST /api/v1/session`
  answers 404 there, which is how the app knows it is in local mode. Do not expose this setup to the internet.
* **Hosted server** (`FILE_API_MODE=hosted`, see `../DEPLOY.md`): the app asks `POST /api/v1/session` for an anonymous signed session, keeps it in
  `localStorage`, sends it as a Bearer token on every call, renews it when it expires, and downloads through short-lived signed links.
  The server serves `dist/` itself.

`npm run test:e2e:hosted` runs the whole browser suite against a hosted server (1 MB file limit so that "too big" is easy to test).

## Languages (English, French)

Visible text goes through `t()` from `src/lib/i18n.ts`, with the English text as the key: `t("Convert images")`, or with values,
`t("Up to {size} per file.", { size })`. French lives in `src/lib/fr.ts`; anything missing there simply stays English. Text from the
server (option labels, notes, errors) goes through `t()` too, and messages with numbers or names in them are matched by `FR_PATTERNS`.
Shared components (`Card`, `Field`, `Segmented`, `Switch`, `Dialog`, `Callout`, page headers) translate their own labels.
The first visit follows the browser's language; the EN/FR switch is remembered in the browser.

## Layout

```
src/lib/        api client, files, capabilities, preview hook, page plan, zoom
src/state/      providers: capabilities, selection, jobs, editor, drop, theme
src/components/ UI kit (Tailwind), tool shell, run panel, file list
src/pages/      one file per tool; pages/editor/ is the PDF editor (lazy loaded)
tests/          unit tests and the end-to-end suite
```

The page plan, zoom maths, page-image cache and annotation model under `src/pages/editor/` are copies of the desktop app's
(`src/features/pdf/`). They are small and pure; if both apps keep growing, move them into a shared package.
