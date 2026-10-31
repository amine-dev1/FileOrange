# Putting OrangeFile on the internet (Fly.io)

This publishes the **web version**: one small server that runs the engine, serves the web app and handles HTTPS. Visitors need no account.
Nothing here touches the desktop app.

> **Status.** The server mode, the web app and the container layout were tested on Linux (see "What was and was not tested" at the end).
> The `Dockerfile` and `fly.toml` themselves have **not been run yet**: the machine they were written on had no running Docker.
> Expect to fix a typo or a package name on the first deploy, and send me the error text if you do.

## What you get

```
visitor ──HTTPS──▶ Fly.io proxy ──▶ one machine: file-api (hosted mode)
                                       ├─ serves the web app (web/dist)
                                       ├─ /api/v1  (signed sessions, limits)
                                       ├─ PDFium (in a sandboxed worker process)
                                       └─ LibreOffice (Word/Excel/PowerPoint → PDF)
```

* **No sign-up.** The first visit asks the server for a *session* (a signed token, valid 24 h, kept in the browser and renewed by the app).
  It is an identity for limits and for "this is your job", not a login. Clearing the browser data starts a new one.
* **Limits** (defaults): 100 MB per file, 300 MB per job, 20 files, one job running at a time per visitor, 600 MB uploaded per day per visitor,
  plus per-IP limits so that clearing the browser data does not give unlimited quota. Results are deleted 15 minutes after they are ready.
* **Privacy:** files exist only on the machine's disk, for at most 15 minutes after the result is ready. Logs contain request ids, paths and
  status codes, never file names or content.

## One-time setup (Windows PowerShell)

1. **Install the Fly command line tool**

   ```powershell
   iwr https://fly.io/install.ps1 -useb | iex
   ```

   Close and reopen PowerShell, then `fly auth signup` (or `fly auth login`). Fly asks for a payment card before it runs anything.
   Look at Fly's current pricing page first: this setup uses one always-on machine with 2 GB of memory, plus a little traffic.

2. **Choose an app name.** It becomes `https://<name>.fly.dev`. In `fly.toml` replace both `orangefile-CHANGE-ME` with your name
   (the `app = …` line and `FILE_API_ALLOWED_HOSTS`). Names are global, so pick something unusual.

3. **Create the app** (from the project folder; no Docker needed on your PC, Fly builds the image on its side):

   ```powershell
   fly apps create <your-name>
   ```

4. **Set the secret that signs sessions.** At least 32 characters, random, and keep it: if it changes, every visitor simply gets a new session.

   ```powershell
   $secret = ([guid]::NewGuid().ToString("N")) + ([guid]::NewGuid().ToString("N"))
   fly secrets set FILE_API_SESSION_SECRET=$secret
   ```

5. **Deploy**

   ```powershell
   fly deploy
   ```

   The first build takes a while (it compiles the engine and downloads PDFium and LibreOffice). Then `fly open`.

## The front end on Netlify

The Fly server also serves the web app itself, so `https://<name>.fly.dev` works on its own. To serve the front end from Netlify instead:

1. In Netlify: **Add new site → Import an existing project → GitHub →** your repository.
2. **Base directory:** `web`. Netlify then reads `web/netlify.toml` (build `npm run build`, publish `dist`, Node 22).
3. **Environment variables:** `VITE_API_ORIGIN` = `https://<name>.fly.dev` (no path, no trailing slash). The build stops with a clear message if it is missing.
4. Deploy. Note the site address, e.g. `https://<site>.netlify.app`.
5. Put that exact address in `FILE_API_ALLOWED_ORIGINS` in `fly.toml`, then `fly deploy` again. Without it the server refuses the site's requests.

The build writes Netlify's `_headers` (security policy that only allows calls to your Fly address) and `_redirects` (so links like `/convert` work).
Tested with `npm run test:e2e:split` (site and engine on different origins, real browser): sessions, uploads, signed downloads, PDF page pictures.

## Deploying from GitHub (optional)

`.github/workflows/deploy-fly.yml` runs `fly deploy` by itself when server code changes on `main`, after the engine tests pass.
It does nothing until you give GitHub a Fly token:

1. In PowerShell: `fly tokens create deploy -a <name>` and copy the whole output (it starts with `FlyV1`).
2. On GitHub: your repository → **Settings → Secrets and variables → Actions → New repository secret**.
   Name: `FLY_API_TOKEN`, value: the token. Save.

Changes to the web app alone don't redeploy Fly (Netlify handles those). To deploy by hand from GitHub: **Actions → Deploy to Fly.io → Run workflow**.

## Checking it works

* `https://<name>.fly.dev/health` shows `{"status":"ok",…}`.
* The site opens, **Convert images** works with a small picture, and the **About** page lists the engines: PDF tools and Documents to PDF should be "available".
  If Documents to PDF says unavailable, run `fly logs` and `fly ssh console -C "soffice --version"`.
* `fly logs` shows one line per request.

## Settings

| Setting | Where | Meaning |
|---|---|---|
| `FILE_API_SESSION_SECRET` | `fly secrets set` | Required, 32+ characters. Signs sessions and download links. |
| `FILE_API_ALLOWED_HOSTS` | `fly.toml` | Every public host name, comma-separated. Add your own domain here when you attach one (`fly certs add yourdomain.com`). Other host names are refused (protects against DNS rebinding). |
| `FILE_API_MAX_FILE_MB` | `fly.toml` | Largest file. Other limits scale from it: 3× per job, 6× per day. |
| `FILE_API_CLIENT_IP_HEADER` | the image | `fly-client-ip`: where Fly puts the visitor's address. Without it, all visitors would look like one IP. **Only correct behind Fly's proxy.** |
| `FILE_API_ALLOWED_ORIGINS` | optional | Another website allowed to call the API from a browser. Normally empty: the web app is served by the same server. |

## Things to know

* **One machine on purpose.** Sessions are stateless (they survive restarts), but job results, open PDFs and the quota counters live in that
  machine. After a restart or deploy, in-flight jobs are lost and the daily counters reset. Do not add a second machine yet: a visitor could land
  on one that does not know their job. (A shared store is Phase 2 in `ARCHITECTURE-WEB.md`.)
* **Memory.** A big PDF render or an Office file can use a lot. If `fly logs` shows the machine being killed for memory, raise `memory` in `fly.toml`.
* **Abuse.** There is no CAPTCHA yet. The per-session and per-IP limits stop casual abuse, not a determined one. Watch the first weeks of `fly logs`
  and tell me what you see before promoting the site.
* **Office files are the riskiest input.** They are parsed by LibreOffice in a throw-away profile with macros off, as a non-root user, inside
  Fly's per-machine virtual machine. That is reasonable for a beta; it is not the hardening a paid service would need (see the security checklist).
* **Updating:** change the code, `fly deploy`. **Stopping everything:** `fly apps destroy <name>`.

## What was and was not tested

Tested (Linux, in this project's test suites):

* The hosted server mode: signed sessions, other visitors' job ids returning "not found", per-session and per-IP limits, signed download links,
  host and origin checks, static serving with the content security policy. 13 dedicated Rust tests.
* The web app against that server in a real browser, with the real engine: the whole suite (124 checks) including limits, the usage meter,
  downloads through signed links, recovering from a damaged session, and accessibility checks in light and dark. The desktop-style local mode
  still passes its own 114 checks.
* The release binary built from the same file layout the `Dockerfile` uses, started with PDFium next to it, and answering `/health`, issuing
  a session, reporting PDFium as available, and serving the web app with its headers.

**Not tested:** building the Docker image; `fly deploy`; LibreOffice from the Debian packages named in the `Dockerfile`
(`libreoffice-*-nogui`; the Office tests ran against another LibreOffice 24.2 install); behaviour behind Fly's real proxy; load; Supabase (not used yet).
