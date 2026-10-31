import { API_BASE } from "./base";
import { ApiError, NETWORK, parseError } from "./http";

/**
 * Who the browser is to the server. A local engine (development, the desktop app) answers 404 to `POST /session`: nothing
 * is needed, because whatever sits in front of it authenticates. A hosted server answers with a signed token, which is sent as
 * `Authorization: Bearer …` on every other request. There is no account: it is just a signed visitor id, kept in this browser.
 */
const KEY = "orangefile.web.session.v1";

let mode: "unknown" | "local" | "hosted" = "unknown";
let token: string | null = (() => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
})();
let starting: Promise<void> | null = null;
let timer: number | undefined;

function keep(t: string | null) {
  token = t;
  try {
    if (t) localStorage.setItem(KEY, t);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: the session simply won't survive a reload */
  }
}

async function request(): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/session`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} });
  } catch {
    throw new ApiError("SERVICE_UNAVAILABLE", NETWORK);
  }
  if (res.status === 404) {
    mode = "local";
    keep(null);
    return;
  }
  if (!res.ok) throw await parseError(res);
  const s = (await res.json()) as { token: string; expires_in: number };
  mode = "hosted";
  keep(s.token);
  // Extend it well before it runs out, keeping the same visitor.
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void renew().catch(() => undefined), Math.min(s.expires_in * 500, 6 * 3600 * 1000));
}

/** Resolves once the session is settled (started, or found to be unnecessary). Every API call waits for this. */
export function ready(): Promise<void> {
  starting ??= request().catch((e) => {
    starting = null; // try again next time
    throw e;
  });
  return starting;
}

/** Get a fresh token (sending the current one, so the visitor stays the same if it is still valid). */
export async function renew(): Promise<void> {
  starting = null;
  await ready();
}

export const isHosted = () => mode === "hosted";
export const authHeaders = (): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});
