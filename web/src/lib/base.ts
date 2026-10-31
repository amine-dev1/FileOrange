/**
 * Where the API lives. Empty (the default) means the same origin as the page: the dev proxy, the desktop-style engine, or a hosted
 * server that also serves this app. A site hosted separately from the engine (Netlify in front of Fly.io) is built with
 * `VITE_API_ORIGIN=https://your-app.fly.dev`; every request then goes there, and the server must list this site in
 * FILE_API_ALLOWED_ORIGINS. It is an address, not a secret.
 */
export const API_ORIGIN: string = ((import.meta.env.VITE_API_ORIGIN as string | undefined) ?? "").trim().replace(/\/+$/, "");

/** An absolute address for a server path such as `/api/v1/dl/...`. */
export const apiUrl = (path: string): string => API_ORIGIN + path;

export const API_BASE = apiUrl("/api/v1");
