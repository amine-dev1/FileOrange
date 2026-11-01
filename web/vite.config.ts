import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The browser app has no secrets: it calls the same-origin path /api/v1/... and something in front of the engine API
 * decides who may do that. In development that something is this dev-server proxy, which adds the engine's token
 * (never sent to the browser) and drops the Origin header the engine refuses from web pages.
 * In production it is a gateway (see ARCHITECTURE-WEB.md), which does real user authentication.
 */
/**
 * When the site is hosted apart from the engine (Netlify in front of Fly.io), VITE_API_ORIGIN is the engine's address. The headers that
 * go with the site must then allow the browser to call it, so they are written at build time, for Netlify's `_headers` file.
 */
function apiOriginFrom(env: Record<string, string>): string {
  const raw = (env.VITE_API_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`VITE_API_ORIGIN must be a web address such as https://your-app.fly.dev (got "${raw}")`);
  }
  if (u.origin !== raw) throw new Error(`VITE_API_ORIGIN must be only the address, without a path (use ${u.origin}, not ${raw})`);
  if (u.protocol !== "https:" && u.hostname !== "127.0.0.1" && u.hostname !== "localhost") throw new Error("VITE_API_ORIGIN must be https");
  return raw;
}

function siteHeaders(apiOrigin: string) {
  return {
    name: "orangefile-site-headers",
    apply: "build" as const,
    writeBundle(opts: { dir?: string }) {
      const dir = opts.dir ?? "dist";
      // Cloudflare Turnstile (only loaded when the server asks new visitors for a CAPTCHA) needs its script and frame.
      const cf = "https://challenges.cloudflare.com";
      const csp = ["default-src 'self'", `script-src 'self' ${cf}`, "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self'", `connect-src 'self'${apiOrigin ? " " + apiOrigin : ""}`, `frame-src ${cf}`, "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'"].join("; ");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "_headers"), `/*\n  Content-Security-Policy: ${csp}\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Referrer-Policy: no-referrer\n  Permissions-Policy: camera=(self), microphone=(), geolocation=()\n`);
    },
  };
}

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiOrigin = apiOriginFrom(env);
  // Netlify sets NETLIFY=true while it builds. A site built there without the engine's address would silently call itself.
  if (command === "build" && process.env.NETLIFY && !apiOrigin) throw new Error("Set VITE_API_ORIGIN in Netlify (Site configuration, Environment variables) to your Fly.io address, e.g. https://your-app.fly.dev");
  const target = env.ORANGEFILE_API_URL || "http://127.0.0.1:8787";
  const token = env.ORANGEFILE_API_TOKEN || "";
  return {
    plugins: [react(), tailwindcss(), siteHeaders(apiOrigin)],
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target,
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on("proxyReq", (req) => {
              req.removeHeader("origin");
              if (token) req.setHeader("authorization", `Bearer ${token}`);
            });
          },
        },
      },
    },
    // Fonts are always separate files: the security policy (font-src 'self') refuses fonts inlined as data: addresses.
    build: { target: "es2021", sourcemap: false, assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/i.test(file) ? false : undefined) },
  };
});
