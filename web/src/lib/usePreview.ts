import { useEffect, useState } from "react";
import { api } from "./api";
import { headHex, uploadName, type FileItem } from "./files";
import type { PreviewResponse } from "./types";

export interface Preview {
  loading: boolean;
  errors: PreviewResponse["errors"];
  warnings: string[];
  /** The service itself couldn't be asked. */
  failure: string | null;
  ok: boolean;
}

const IDLE: Preview = { loading: false, errors: [], warnings: [], failure: null, ok: true };
const heads = new WeakMap<File, Promise<string>>();
const headOf = (f: File) => {
  let p = heads.get(f);
  if (!p) heads.set(f, (p = headHex(f)));
  return p;
};

/**
 * Ask the server, before anything is uploaded, whether this job could run: wrong file type, a bad option, a missing
 * engine, too many or too large files. Only names, sizes and the first bytes of each file are sent.
 */
export function usePreview(operation: string | null, options: unknown, items: FileItem[], enabled = true): Preview {
  const [result, setResult] = useState<{ key: string; value: Preview } | null>(null);
  const key = enabled && operation && items.length > 0 ? JSON.stringify([operation, options, items.map((i) => [i.id, uploadName(i), i.size])]) : null;

  useEffect(() => {
    if (!key || !operation) return;
    const ctl = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const files = await Promise.all(items.map(async (i) => ({ name: uploadName(i), size: i.size, head_hex: await headOf(i.file) })));
        const r = await api.preview(operation, options, files, ctl.signal);
        setResult({ key, value: { loading: false, errors: r.errors, warnings: r.warnings, failure: null, ok: r.ok } });
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setResult({ key, value: { loading: false, errors: [], warnings: [], failure: e instanceof Error ? e.message : "Couldn't check these files.", ok: false } });
      }
    }, 300);
    return () => {
      ctl.abort();
      window.clearTimeout(timer);
    };
    // `items` and `options` are captured by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!key) return IDLE;
  if (!result || result.key !== key) return { ...IDLE, loading: true, ok: false };
  return result.value;
}
