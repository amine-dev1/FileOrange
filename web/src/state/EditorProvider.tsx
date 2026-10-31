import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "../lib/api";
import type { PdfDocumentResponse } from "../lib/types";
import { PageImages } from "../pages/editor/pageImages";
import * as P from "../pages/editor/plan";
import { useAnnotations, type AnnotationStore } from "../pages/editor/annotations/useAnnotations";

export type EditorState =
  | { status: "idle" }
  | { status: "opening"; name: string; percent: number }
  | { status: "password"; file: File; wrong: boolean }
  | { status: "ready"; doc: PdfDocumentResponse; file: File }
  | { status: "error"; name: string; code: string; message: string };

export type Zoom = { mode: "fit-width" } | { mode: "fit-page" } | { mode: "scale"; value: number };

/** Something the user must confirm because it would throw away their changes. */
export type Discard = { kind: "open"; file: File } | { kind: "close" } | null;

type SelectMode = "only" | "toggle" | "range";

interface Ctx {
  state: EditorState;
  /** Page pictures for the open document; null unless one is open. */
  images: PageImages | null;
  /** The pages the new PDF will contain, in order (see plan.ts). */
  plan: P.PlanPage[];
  /** There is something to save: the pages differ from the file, or annotations were added. */
  dirty: boolean;
  planDirty: boolean;
  annotationCount: number;
  annotations: AnnotationStore;
  /** Ids of the selected pages. Page operations act on these, or on the shown page when none are selected. */
  selected: number[];
  /** The page shown in the preview, as a position in the plan (from 1). */
  page: number;
  setPage: (n: number) => void;
  choose: (position: number, mode?: SelectMode) => void;
  selectAll: () => void;
  rotateSelected: (by: 90 | -90 | 180) => void;
  deleteSelected: () => void;
  moveSelected: (dir: -1 | 1) => void;
  moveBlock: (ids: number[], at: number) => void;
  resetPlan: () => void;
  zoom: Zoom;
  setZoom: (z: Zoom) => void;
  open: (file: File) => Promise<void>;
  unlock: (password: string) => Promise<void>;
  close: () => void;
  discard: Discard;
  resolveDiscard: (accept: boolean) => void;
  /** The password the open document was unlocked with, for saving a copy. Held in memory only. */
  passwordForSave: () => string | null;
}

const EditorContext = createContext<Ctx | null>(null);

/** The PDF open in the editor and the changes made to it. It lives above the routes so it stays open while the user visits other screens. */
export function EditorProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<EditorState>({ status: "idle" });
  const [images, setImages] = useState<PageImages | null>(null);
  const [plan, setPlan] = useState<P.PlanPage[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [page, setPageRaw] = useState(1);
  const [zoom, setZoom] = useState<Zoom>({ mode: "fit-width" });
  const [discard, setDiscard] = useState<Discard>(null);
  const attempt = useRef(0);
  const current = useRef<{ id: string; images: PageImages } | null>(null);
  const awaiting = useRef<File | null>(null);
  const password = useRef<string | null>(null);
  const anchor = useRef(1);
  const annotations = useAnnotations();
  const resetAnnotations = annotations.reset;

  const pageCount = state.status === "ready" ? state.doc.info.page_count : 0;
  const planDirty = state.status === "ready" && !P.isIdentity(plan, pageCount);
  const annotationCount = useMemo(() => {
    const kept = new Set(plan.map((p) => p.src));
    return annotations.list.filter((a) => kept.has(a.page)).length;
  }, [annotations.list, plan]);
  const dirty = planDirty || annotationCount > 0;
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  const release = useCallback(() => {
    const cur = current.current;
    current.current = null;
    password.current = null;
    if (!cur) return;
    cur.images.dispose();
    void api.closePdf(cur.id);
  }, []);

  const run = useCallback(
    async (file: File, pw?: string) => {
      const mine = ++attempt.current;
      awaiting.current = null;
      setState({ status: "opening", name: file.name, percent: 0 });
      try {
        const doc = await api.openPdf(file, pw ?? null, (sent, total) => {
          if (mine === attempt.current) setState((s) => (s.status === "opening" ? { ...s, percent: total ? Math.round((sent / total) * 100) : 0 } : s));
        });
        if (mine !== attempt.current) {
          void api.closePdf(doc.id); // superseded while opening
          return;
        }
        release();
        const imgs = new PageImages((p, w) => api.pageImageBlob(doc.id, p, w));
        current.current = { id: doc.id, images: imgs };
        password.current = pw || null;
        const fresh = P.identity(doc.info.page_count);
        resetAnnotations();
        setImages(imgs);
        setPlan(fresh);
        setSelected([fresh[0].id]);
        anchor.current = 1;
        setPageRaw(1);
        setZoom({ mode: "fit-width" });
        setState({ status: "ready", doc, file });
      } catch (e) {
        if (mine !== attempt.current) return;
        const code = e instanceof ApiError ? e.code : "ERROR";
        const message = e instanceof Error ? e.message : "Something went wrong.";
        if (code === "PASSWORD_REQUIRED" || code === "WRONG_PASSWORD") {
          awaiting.current = file;
          setState({ status: "password", file, wrong: code === "WRONG_PASSWORD" });
        } else {
          setState({ status: "error", name: file.name, code, message });
        }
      }
    },
    [release, resetAnnotations],
  );

  const open = useCallback(
    async (file: File) => {
      if (dirtyRef.current) {
        setDiscard({ kind: "open", file });
        return;
      }
      await run(file);
    },
    [run],
  );

  const unlock = useCallback(
    async (pw: string) => {
      const file = awaiting.current;
      if (file) await run(file, pw);
    },
    [run],
  );

  const reallyClose = useCallback(() => {
    attempt.current++;
    awaiting.current = null;
    release();
    resetAnnotations();
    setImages(null);
    setPlan([]);
    setSelected([]);
    setState({ status: "idle" });
  }, [release, resetAnnotations]);

  const close = useCallback(() => {
    if (dirtyRef.current) setDiscard({ kind: "close" });
    else reallyClose();
  }, [reallyClose]);

  const resolveDiscard = useCallback(
    (accept: boolean) => {
      const asked = discard;
      setDiscard(null);
      if (!accept || !asked) return;
      if (asked.kind === "close") reallyClose();
      else void run(asked.file);
    },
    [discard, reallyClose, run],
  );

  const setPage = useCallback(
    (n: number) => {
      const target = Math.min(Math.max(1, Math.round(n)), Math.max(1, plan.length));
      setPageRaw(target);
      anchor.current = target;
      const entry = plan[target - 1];
      if (entry) setSelected([entry.id]);
    },
    [plan],
  );

  const choose = useCallback(
    (position: number, mode: SelectMode = "only") => {
      const entry = plan[position - 1];
      if (!entry) return;
      setPageRaw(position);
      if (mode === "only") {
        anchor.current = position;
        setSelected([entry.id]);
      } else if (mode === "toggle") {
        anchor.current = position;
        setSelected((s) => (s.includes(entry.id) ? s.filter((x) => x !== entry.id) : [...s, entry.id]));
      } else {
        const [a, b] = [Math.min(anchor.current, position), Math.max(anchor.current, position)];
        setSelected(plan.slice(a - 1, b).map((p) => p.id));
      }
    },
    [plan],
  );

  const selectAll = useCallback(() => setSelected(plan.map((p) => p.id)), [plan]);

  /** What an operation acts on: the selection, or the shown page when nothing is selected. */
  const targets = useCallback((): Set<number> => {
    const ids = selected.filter((id) => plan.some((p) => p.id === id));
    return new Set(ids.length > 0 ? ids : plan[page - 1] ? [plan[page - 1].id] : []);
  }, [selected, plan, page]);

  const rotateSelected = useCallback((by: 90 | -90 | 180) => setPlan((pl) => P.rotate(pl, targets(), by)), [targets]);

  const deleteSelected = useCallback(() => {
    const ids = targets();
    const next = P.remove(plan, ids);
    if (next === plan) return;
    const firstGone = plan.findIndex((p) => ids.has(p.id));
    const shown = Math.min(next.length, Math.max(1, firstGone + 1));
    setPlan(next);
    setPageRaw(shown);
    anchor.current = shown;
    setSelected([next[shown - 1].id]);
  }, [plan, targets]);

  const moveSelected = useCallback(
    (dir: -1 | 1) => {
      const shownId = plan[page - 1]?.id;
      const next = P.moveBy(plan, targets(), dir);
      setPlan(next);
      const at = next.findIndex((p) => p.id === shownId);
      if (at >= 0) setPageRaw(at + 1);
    },
    [plan, page, targets],
  );

  const moveBlock = useCallback(
    (ids: number[], at: number) => {
      const shownId = plan[page - 1]?.id;
      const next = P.moveBlock(plan, new Set(ids), at);
      setPlan(next);
      const pos = next.findIndex((p) => p.id === shownId);
      if (pos >= 0) setPageRaw(pos + 1);
    },
    [plan, page],
  );

  const resetPlan = useCallback(() => {
    if (state.status !== "ready") return;
    const fresh = P.identity(state.doc.info.page_count);
    setPlan(fresh);
    setSelected([fresh[0].id]);
    anchor.current = 1;
    setPageRaw(1);
  }, [state]);

  // Closing the tab closes the document on the server too, and an unsaved edit asks first.
  useEffect(() => {
    const hide = () => {
      if (current.current) void api.closePdf(current.current.id);
    };
    const ask = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener("beforeunload", ask);
    return () => {
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("beforeunload", ask);
    };
  }, []);

  const passwordForSave = useCallback(() => password.current, []);

  const value = useMemo(
    () => ({ state, images, plan, dirty, planDirty, annotationCount, annotations, selected, page, setPage, choose, selectAll, rotateSelected, deleteSelected, moveSelected, moveBlock, resetPlan, zoom, setZoom, open, unlock, close, discard, resolveDiscard, passwordForSave }),
    [state, images, plan, dirty, planDirty, annotationCount, annotations, selected, page, setPage, choose, selectAll, rotateSelected, deleteSelected, moveSelected, moveBlock, resetPlan, zoom, open, unlock, close, discard, resolveDiscard, passwordForSave],
  );
  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

export function useEditor(): Ctx {
  const c = useContext(EditorContext);
  if (!c) throw new Error("useEditor outside EditorProvider");
  return c;
}
