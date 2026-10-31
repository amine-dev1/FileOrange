import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PageImages } from "../features/pdf/pageImages";
import * as P from "../features/pdf/plan";
import { basename } from "../lib/format";
import { AppError } from "../lib/tauri";
import type { PdfDocument } from "../lib/types";
import { pdfService } from "../services/pdfService";
import { useAnnotations, type AnnotationStore } from "../features/pdf/annotations/useAnnotations";

export type PdfState =
  | { status: "idle" }
  | { status: "opening"; name: string }
  | { status: "password"; path: string; name: string; wrong: boolean }
  | { status: "ready"; doc: PdfDocument; path: string }
  | { status: "error"; name: string; code: string; message: string };

export type Zoom = { mode: "fit-width" } | { mode: "fit-page" } | { mode: "scale"; value: number };

/** Something the user must confirm because it would throw away page changes. */
export type Discard = { kind: "open"; path: string } | { kind: "close" } | null;

type SelectMode = "only" | "toggle" | "range";

interface Ctx {
  state: PdfState;
  /** Page images for the open document; null unless one is open. */
  images: PageImages | null;
  /** The pages the new PDF will contain, in order (see features/pdf/plan.ts). */
  plan: P.PlanPage[];
  /** True when there is anything to save: the pages differ from the file, or annotations were added. */
  dirty: boolean;
  /** True when only the page plan differs from the file. */
  planDirty: boolean;
  /** Annotations on pages that are still in the plan. */
  annotationCount: number;
  /** The annotations being drawn on the open PDF. */
  annotations: AnnotationStore;
  /** Ids of the selected pages. Page operations act on these, or on the shown page when none are selected. */
  selected: number[];
  /** The page shown in the preview, as a position in the plan (from 1). */
  page: number;
  setPage: (n: number) => void;
  /** Click on a page: it becomes the shown page and the selection changes as `mode` says. */
  choose: (position: number, mode?: SelectMode) => void;
  selectAll: () => void;
  rotateSelected: (by: 90 | -90 | 180) => void;
  deleteSelected: () => void;
  moveSelected: (dir: -1 | 1) => void;
  /** Drag and drop: put these pages before position `at` (0..plan.length). */
  moveBlock: (ids: number[], at: number) => void;
  resetPlan: () => void;
  zoom: Zoom;
  setZoom: (z: Zoom) => void;
  open: (path: string) => Promise<void>;
  /** Try the password for the document that asked for one. */
  unlock: (password: string) => Promise<void>;
  close: () => void;
  discard: Discard;
  /** Answer the question in `discard`. */
  resolveDiscard: (accept: boolean) => void;
  /** The password the open document was unlocked with, for saving a copy. Held in memory only. */
  passwordForSave: () => string | null;
}

const PdfContext = createContext<Ctx | null>(null);

/** The PDF open in the editor and the page changes made to it. It lives here so it stays open while the user visits other screens. */
export function PdfProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PdfState>({ status: "idle" });
  const [images, setImages] = useState<PageImages | null>(null);
  const [plan, setPlan] = useState<P.PlanPage[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [page, setPageRaw] = useState(1);
  const [zoom, setZoom] = useState<Zoom>({ mode: "fit-width" });
  const [discard, setDiscard] = useState<Discard>(null);
  const attempt = useRef(0);
  const current = useRef<{ id: string; images: PageImages } | null>(null);
  /** The file waiting for a password. Kept here, not in state, so unlock() can stay a plain call. */
  const awaiting = useRef<string | null>(null);
  const password = useRef<string | null>(null);
  const anchor = useRef(1);

  const pageCount = state.status === "ready" ? state.doc.info.page_count : 0;
  const annotations = useAnnotations();
  const resetAnnotations = annotations.reset;
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
    void pdfService.close(cur.id).catch(() => undefined);
  }, []);

  const run = useCallback(
    async (path: string, pw?: string) => {
      const mine = ++attempt.current;
      awaiting.current = null;
      const name = basename(path);
      setState({ status: "opening", name });
      try {
        const doc = await pdfService.open(path, pw);
        if (mine !== attempt.current) {
          void pdfService.close(doc.id).catch(() => undefined); // superseded while opening
          return;
        }
        release();
        const imgs = new PageImages((p, w) => pdfService.pageImage(doc.id, p, w));
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
        setState({ status: "ready", doc, path });
      } catch (e) {
        if (mine !== attempt.current) return;
        const code = e instanceof AppError ? e.code : "INTERNAL_ERROR";
        const message = e instanceof Error ? e.message : "Something went wrong.";
        if (code === "PASSWORD_REQUIRED" || code === "WRONG_PASSWORD") {
          awaiting.current = path;
          setState({ status: "password", path, name, wrong: code === "WRONG_PASSWORD" });
        } else {
          setState({ status: "error", name, code, message });
        }
      }
    },
    [release, resetAnnotations],
  );

  const open = useCallback(
    async (path: string) => {
      if (dirtyRef.current) {
        setDiscard({ kind: "open", path });
        return;
      }
      await run(path);
    },
    [run],
  );

  const unlock = useCallback(
    async (pw: string) => {
      const path = awaiting.current;
      if (path) await run(path, pw);
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
      else void run(asked.path);
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
      // The preview follows the page it was showing.
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

  // Closing the app (or this provider) closes the document on the server too.
  useEffect(() => release, [release]);

  const passwordForSave = useCallback(() => password.current, []);

  const value = useMemo(
    () => ({ state, images, plan, dirty, planDirty, annotationCount, annotations, selected, page, setPage, choose, selectAll, rotateSelected, deleteSelected, moveSelected, moveBlock, resetPlan, zoom, setZoom, open, unlock, close, discard, resolveDiscard, passwordForSave }),
    [state, images, plan, dirty, planDirty, annotationCount, annotations, selected, page, setPage, choose, selectAll, rotateSelected, deleteSelected, moveSelected, moveBlock, resetPlan, zoom, open, unlock, close, discard, resolveDiscard, passwordForSave],
  );
  return <PdfContext.Provider value={value}>{children}</PdfContext.Provider>;
}

export function usePdf(): Ctx {
  const c = useContext(PdfContext);
  if (!c) throw new Error("usePdf outside PdfProvider");
  return c;
}
