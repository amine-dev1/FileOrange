import { API_BASE, apiUrl } from "./base";
import { ApiError, NETWORK, parseError } from "./http";
import { authHeaders, isHosted, ready, renew } from "./session";
import type { Capabilities, JobResponse, MeResponse, PdfDocumentResponse, PreviewResponse, ResultManifest } from "./types";

export { ApiError } from "./http";

/**
 * Everything the browser knows about the backend: same-origin paths under /api/v1. There is no secret in this code: in
 * development the dev proxy adds the engine's token; on a hosted server the browser holds a signed visitor session (session.ts).
 */
const BASE = API_BASE;

/** `fetch` with the session, waiting for it first, and renewing it once if the server says it is no good. */
async function authed(path: string, init: RequestInit = {}): Promise<Response> {
  await ready();
  const send = () => fetch(BASE + path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...authHeaders() } });
  let res = await send();
  if (res.status === 401 && isHosted()) {
    await renew();
    res = await send();
  }
  return res;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await authed(path, init);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    if (e instanceof ApiError) throw e;
    throw new ApiError("SERVICE_UNAVAILABLE", NETWORK);
  }
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

/** A form upload with progress. `fetch` can't report upload progress, XMLHttpRequest can. */
async function upload<T>(path: string, form: FormData, onProgress: (sent: number, total: number) => void, signal?: AbortSignal): Promise<T> {
  await ready();
  const attempt = () =>
    new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", BASE + path);
      for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
      xhr.responseType = "text";
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total);
      xhr.onerror = () => reject(new ApiError("SERVICE_UNAVAILABLE", NETWORK));
      xhr.onabort = () => reject(new DOMException("Cancelled", "AbortError"));
      xhr.onload = () => {
        let body: unknown = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* not JSON */
        }
        resolve({ status: xhr.status, body });
      };
      if (signal) {
        if (signal.aborted) return reject(new DOMException("Cancelled", "AbortError"));
        signal.addEventListener("abort", () => xhr.abort(), { once: true });
      }
      xhr.send(form);
    });
  let r = await attempt();
  if (r.status === 401 && isHosted()) {
    await renew();
    r = await attempt();
  }
  if (r.status >= 200 && r.status < 300 && r.body) return r.body as T;
  const err = (r.body as { error?: { code?: string; message?: string; request_id?: string } } | null)?.error;
  if (err?.message) throw new ApiError(err.code ?? "ERROR", err.message, r.status, err.request_id);
  if (r.status === 502 || r.status === 503 || r.status === 504) throw new ApiError("SERVICE_UNAVAILABLE", NETWORK, r.status);
  throw new ApiError("ERROR", `The service answered with an error (${r.status}).`, r.status);
}

export interface UploadFile {
  file: File;
  /** The name sent with the file. For folders this is the relative path, so the tree can be rebuilt. */
  name: string;
}

export const api = {
  health: () => fetch(apiUrl("/health")).then((r) => r.ok),
  /** What this visitor may do and has used today. */
  me: () => json<MeResponse>("/me"),

  /**
   * Save a result. A local engine is reached with a plain link (the dev proxy authenticates it). A hosted server can't be: a
   * link can't carry the session header, so the server signs a two-minute address for it first.
   */
  async download(id: string, index?: number) {
    let href = index == null ? `${BASE}/jobs/${encodeURIComponent(id)}/result` : `${BASE}/jobs/${encodeURIComponent(id)}/result/files/${index}`;
    if (isHosted()) {
      const link = await json<{ url: string }>(`/jobs/${encodeURIComponent(id)}/link`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(index == null ? {} : { index }) });
      href = apiUrl(link.url);
    }
    const a = document.createElement("a");
    a.href = href;
    a.download = "";
    document.body.append(a);
    a.click();
    a.remove();
  },
  capabilities: () => json<Capabilities>("/capabilities"),

  /** Ask whether a job could run, from names, sizes and first bytes alone, before anything is uploaded. */
  preview: (operation: string, options: unknown, files: { name: string; size: number; head_hex: string }[], signal?: AbortSignal) =>
    json<PreviewResponse>("/jobs/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation, options, files }), signal }),

  /** Start a job. The operation and options go first: the server checks them before it stores a single byte. */
  createJob(operation: string, options: unknown, files: UploadFile[], onProgress: (sent: number, total: number) => void, signal?: AbortSignal) {
    const form = new FormData();
    form.append("operation", operation);
    form.append("options", JSON.stringify(options ?? {}));
    for (const f of files) form.append("files", f.file, f.name);
    return upload<{ job_id: string; status: string }>("/jobs", form, onProgress, signal);
  },
  job: (id: string) => json<JobResponse>(`/jobs/${encodeURIComponent(id)}`),
  cancelJob: (id: string) => json<JobResponse>(`/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  manifest: (id: string) => json<ResultManifest>(`/jobs/${encodeURIComponent(id)}/result/files`),

  /** Plain links: the browser downloads them itself, so large results are streamed to disk, never held in memory. */
  resultUrl: (id: string) => `${BASE}/jobs/${encodeURIComponent(id)}/result`,
  resultFileUrl: (id: string, index: number) => `${BASE}/jobs/${encodeURIComponent(id)}/result/files/${index}`,

  openPdf(file: File, password: string | null, onProgress: (sent: number, total: number) => void, signal?: AbortSignal) {
    const form = new FormData();
    if (password) form.append("password", password);
    form.append("file", file, file.name);
    return upload<PdfDocumentResponse>("/pdf/documents", form, onProgress, signal);
  },
  closePdf: (id: string) => authed(`/pdf/documents/${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true }).then(() => undefined, () => undefined),
  /** One page as a PNG. Fetched (not linked) so a failure can be read and shown, and so the picture can be cached. */
  async pageImageBlob(id: string, page: number, width: number): Promise<Blob> {
    let res: Response;
    try {
      res = await authed(`/pdf/documents/${encodeURIComponent(id)}/pages/${page}/image?width=${width}`);
    } catch (e) {
      throw e instanceof ApiError ? e : new ApiError("SERVICE_UNAVAILABLE", NETWORK);
    }
    if (!res.ok) throw await parseError(res);
    return res.blob();
  },
  pageImageUrl: (id: string, page: number, width: number) => `${BASE}/pdf/documents/${encodeURIComponent(id)}/pages/${page}/image?width=${width}`,
};
